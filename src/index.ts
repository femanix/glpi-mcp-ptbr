#!/usr/bin/env node

/**
 * Servidor MCP para GLPI v3.0
 *
 * Principais mudanças em relação à v2:
 *   - Camada HTTP unificada com reautenticação automática, erros estruturados e retries.
 *   - As ferramentas de lista aceitam start/limit/fetch_all/forcedisplay/criteria/sort/order
 *     (retrocompatível: `limit` sozinho continua funcionando).
 *   - Novos `glpi_count` e `glpi_search_v2` (múltiplos critérios, forcedisplay).
 *   - `glpi_search_tickets` de alto nível com parâmetros amigáveis (status/atribuído/...).
 *   - `glpi_get_ticket_timeline` une acompanhamentos+tarefas+soluções+validações.
 *   - `glpi_tickets_stats_by` agrupa por status/categoria/técnico/entidade/mês.
 *   - Ferramentas de vínculo, validação, documento, SLA e satisfação.
 *   - Mapeamento de field-id via /listSearchOptions, resistente a diferenças entre versões do GLPI.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { z } from 'zod';
import { GlpiClient, GlpiConfig, ListOptions } from './glpi-client.js';
import { GlpiError } from './http.js';
import { SearchCriterion, SearchType, SearchLink } from './search.js';
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  assertItemtype,
  assertSecureUrl,
  envFlag,
  isReadTool,
  resolveUploadPath,
} from './security.js';

// ---------------------------------------------------------------------------
// Schemas de validação
// ---------------------------------------------------------------------------

const listArgsSchema = z.object({
  start: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
  range: z.string().optional(),
  sort: z.string().optional(),
  order: z.enum(['ASC', 'DESC']).optional(),
  expand_dropdowns: z.boolean().optional(),
  criteria: z.array(z.unknown()).optional(),
  fetch_all: z.boolean().optional(),
}).passthrough();

const ticketReadSchema = z.object({
  id: z.number().int().min(1),
  with_logs: z.boolean().optional(),
}).passthrough();

const ticketSearchSchema = z.object({
  status: z.number().optional(),
  assigned_user_id: z.number().optional(),
  assigned_group_id: z.number().optional(),
  requester_user_id: z.number().optional(),
  category_id: z.number().optional(),
  entity_id: z.number().optional(),
  priority: z.number().optional(),
  urgency: z.number().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  text_search: z.string().optional(),
  open_only: z.boolean().optional(),
  start: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const TICKET_STATUS: Record<number, string> = {
  1: 'Novo',
  2: 'Em atendimento (atribuído)',
  3: 'Em atendimento (planejado)',
  4: 'Pendente',
  5: 'Solucionado',
  6: 'Fechado',
};

const TICKET_URGENCY: Record<number, string> = {
  1: 'Muito baixa',
  2: 'Baixa',
  3: 'Média',
  4: 'Alta',
  5: 'Muito alta',
};

const PROBLEM_STATUS: Record<number, string> = {
  1: 'Novo', 2: 'Aceito', 3: 'Planejado', 4: 'Pendente', 5: 'Solucionado', 6: 'Fechado',
};

const CHANGE_STATUS: Record<number, string> = {
  1: 'Novo', 2: 'Avaliação', 3: 'Aprovação', 4: 'Aceito', 5: 'Pendente',
  6: 'Teste', 7: 'Qualificação', 8: 'Aplicado', 9: 'Revisão', 10: 'Fechado',
  11: 'Recusado', 12: 'Cancelado',
};

const VALIDATION_STATUS: Record<number, string> = {
  1: 'Aguardando', 2: 'Concedida', 3: 'Recusada',
};

// Ids de campo padrão das search options de Ticket (GLPI ≥ 9.5). São alternativas; o
// cache de SearchOptions é usado para resolver nomes amigáveis dinamicamente.
const TICKET_FIELDS = {
  id: 2,
  name: 1,
  status: 12,
  date: 15,
  date_mod: 19,
  solvedate: 17,
  closedate: 16,
  priority: 3,
  urgency: 10,
  impact: 11,
  category: 7,
  entity: 80,
  requester_user: 4,
  technician_user: 5,
  technician_group: 8,
  type: 14,
};

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

/** GLPI_READ_ONLY=1 esconde e bloqueia toda ferramenta que escreve no GLPI. */
const READ_ONLY = envFlag(process.env.GLPI_READ_ONLY);

/** glpi_upload_document só lê arquivos dentro de GLPI_UPLOAD_DIR (sem valor = desabilitado). */
const UPLOAD_POLICY = {
  dir: process.env.GLPI_UPLOAD_DIR || undefined,
  maxBytes: envInt('GLPI_MAX_UPLOAD_BYTES') ?? DEFAULT_MAX_UPLOAD_BYTES,
};

function itemtypeArg(args: Record<string, unknown>): string {
  try {
    return assertItemtype(args.itemtype);
  } catch (err) {
    throw new McpError(ErrorCode.InvalidParams, err instanceof Error ? err.message : String(err));
  }
}

function getConfig(): GlpiConfig {
  const url = process.env.GLPI_URL;
  if (!url) throw new Error('GLPI_URL environment variable is required');
  try {
    new URL(url);
  } catch {
    throw new Error(`GLPI_URL is not a valid URL: "${url}"`);
  }
  assertSecureUrl(url, envFlag(process.env.GLPI_ALLOW_INSECURE_HTTP));

  const userToken = process.env.GLPI_USER_TOKEN;
  const username = process.env.GLPI_USERNAME;
  const password = process.env.GLPI_PASSWORD;
  if (!userToken && !(username && password)) {
    throw new Error(
      'No authentication configured. Set GLPI_USER_TOKEN, or GLPI_USERNAME + GLPI_PASSWORD.'
    );
  }

  return {
    url,
    appToken: process.env.GLPI_APP_TOKEN,
    userToken,
    username,
    password,
    timeoutMs: envInt('GLPI_TIMEOUT_MS'),
    maxRetries: envInt('GLPI_MAX_RETRIES'),
  };
}

/**
 * Converte os argumentos comuns das ferramentas de lista em um ListOptions.
 *
 * Aceita (em ordem de precedência):
 *   - `range`: string "INÍCIO-FIM" repassada como está
 *   - `start` + `limit`: montados em um range
 *   - `limit` sozinho: range = "0-{limit-1}" (retrocompatível com a v2)
 */
function parseListArgs(args: Record<string, unknown> | undefined): ListOptions {
  const opts: ListOptions = {};
  if (!args) return { range: '0-49', expand_dropdowns: true };

  if (typeof args.range === 'string') {
    opts.range = args.range;
  } else if (args.start !== undefined || args.limit !== undefined) {
    const start = (args.start as number) ?? 0;
    const limit = (args.limit as number) ?? 50;
    opts.range = `${start}-${start + limit - 1}`;
  } else {
    opts.range = '0-49';
  }

  if (args.sort !== undefined) opts.sort = args.sort as number;
  if (args.order) opts.order = args.order as 'ASC' | 'DESC';
  if (args.is_deleted !== undefined) opts.is_deleted = args.is_deleted as boolean;
  if (args.include_deleted !== undefined) opts.is_deleted = args.include_deleted as boolean;
  // expand_dropdowns é true por padrão, para a saída ser legível.
  opts.expand_dropdowns =
    args.expand_dropdowns === false ? false : true;
  return opts;
}

interface CriteriaArg {
  field: number | string;
  searchtype: SearchType;
  value: string | number | boolean;
  link?: SearchLink;
}

async function resolveFieldOrThrow(
  client: GlpiClient,
  itemtype: string,
  field: number | string
): Promise<number> {
  const id = await client.searchOptions.resolveField(itemtype, field);
  if (id !== undefined) return id;
  throw new McpError(
    ErrorCode.InvalidParams,
    `campo "${field}" não encontrado em ${itemtype}. Use o id numérico, o uid (ex.: ${itemtype}.name) ` +
      `ou o nome exatamente como o GLPI mostra; glpi_list_search_options lista as opções.`
  );
}

async function resolveCriteria(
  client: GlpiClient,
  itemtype: string,
  raw: CriteriaArg[]
): Promise<SearchCriterion[]> {
  return Promise.all(
    raw.map(async (c) => ({
      field: await resolveFieldOrThrow(client, itemtype, c.field),
      searchtype: c.searchtype,
      value: c.value,
      link: c.link,
    }))
  );
}

function text(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}

function formatTicketSummary(t: any) {
  return {
    id: t.id,
    name: t.name,
    status: TICKET_STATUS[t.status] ?? t.status,
    urgency: TICKET_URGENCY[t.urgency] ?? t.urgency,
    priority: TICKET_URGENCY[t.priority] ?? t.priority,
    date: t.date,
    date_mod: t.date_mod,
    entities_id: t.entities_id,
    itilcategories_id: t.itilcategories_id,
  };
}

// ---------------------------------------------------------------------------
// Configuração do servidor
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'mcp-glpi', version: '3.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

let client: GlpiClient;

// ---------------------------------------------------------------------------
// Registro das ferramentas
// ---------------------------------------------------------------------------

const LIST_TOOL_COMMON_PROPS = {
  start: { type: 'number', description: 'Deslocamento inicial (padrão 0)' },
  limit: { type: 'number', description: 'Máximo de linhas nesta chamada (padrão 50)' },
  range: { type: 'string', description: 'Intervalo explícito "INÍCIO-FIM"; sobrescreve start/limit' },
  sort: { type: 'number', description: 'Ordena pelo id do campo (id da search option)' },
  order: { type: 'string', enum: ['ASC', 'DESC'] },
  expand_dropdowns: { type: 'boolean', description: 'Resolve ids de chaves estrangeiras para rótulos (padrão true)' },
};

/** Tipos MIME de glpi_upload_document, indexados pela extensão do arquivo em minúsculas. */
const UPLOAD_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
};

const ASSET_PT: Record<string, { singular: string; plural: string }> = {
  computers: { singular: 'um computador', plural: 'computadores' },
  softwares: { singular: 'um software', plural: 'softwares' },
  network_equipments: { singular: 'um equipamento de rede', plural: 'equipamentos de rede' },
  printers: { singular: 'uma impressora', plural: 'impressoras' },
  monitors: { singular: 'um monitor', plural: 'monitores' },
  phones: { singular: 'um telefone', plural: 'telefones' },
};

// ---------------------------------------------------------------------------
// Anotações de segurança das ferramentas (MCP ToolAnnotations)
//
// Derivadas do nome da ferramenta, para que toda ferramenta atual e futura receba as dicas:
//   - list/get/search/count/stats  -> readOnlyHint
//   - delete                       -> destructiveHint (possível perda de dados)
//   - update/set/assign            -> destructiveHint (sobrescreve dados existentes)
//   - create/add/link/attach       -> escrita aditiva (não destrutiva, não idempotente)
// openWorldHint é false em todas: as ferramentas só alcançam o GLPI configurado.
// ---------------------------------------------------------------------------

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

function toolAnnotations(name: string): ToolAnnotations {
  if (/^glpi_(list_|get_|search|count$|tickets_stats)/.test(name)) {
    return { readOnlyHint: true, openWorldHint: false };
  }
  if (/^glpi_delete_/.test(name)) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  }
  if (/^glpi_(update_|set_|assign_)/.test(name)) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  }
  // create / add / link / attach: escritas aditivas. Repetir a chamada duplica dados.
  return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
}

function annotate<T extends { name: string }>(tool: T): T & { annotations: ToolAnnotations } {
  return { ...tool, annotations: toolAnnotations(tool.name) };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ============== LEITURA — CHAMADOS ==============
    {
      name: 'glpi_list_tickets',
      description: 'Lista chamados. Aceita start/limit/range/sort/order e filtro por status.',
      inputSchema: {
        type: 'object',
        properties: {
          ...LIST_TOOL_COMMON_PROPS,
          status: { type: 'number', description: '1=Novo 2=Atribuído 3=Planejado 4=Pendente 5=Solucionado 6=Fechado' },
        },
      },
    },
    {
      name: 'glpi_get_ticket',
      description: 'Obtém um chamado com rótulos de status/urgência e contagem dos itens vinculados.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          with_logs: { type: 'boolean' },
        },
        required: ['id'],
      },
    },
    {
      name: 'glpi_get_ticket_timeline',
      description: 'Linha do tempo cronológica completa de um chamado: acompanhamentos + tarefas + soluções + validações, ordenada por data.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
    },
    {
      name: 'glpi_search_tickets',
      description: 'Busca de chamados com parâmetros amigáveis. Use no lugar de glpi_search_v2 para chamados.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'number', description: '1..6 (veja a referência de status)' },
          assigned_user_id: { type: 'number' },
          assigned_group_id: { type: 'number' },
          requester_user_id: { type: 'number' },
          category_id: { type: 'number' },
          entity_id: { type: 'number' },
          priority: { type: 'number', description: '1=Muito baixa .. 5=Muito alta' },
          urgency: { type: 'number', description: '1..5' },
          date_from: { type: 'string', description: 'YYYY-MM-DD HH:MM:SS' },
          date_to: { type: 'string', description: 'YYYY-MM-DD HH:MM:SS' },
          text_search: { type: 'string', description: 'Texto livre no título' },
          open_only: { type: 'boolean', description: 'Somente status < 5' },
          start: { type: 'number' },
          limit: { type: 'number' },
          fetch_all: { type: 'boolean', description: 'Pagina até o totalcount; limitado por max_rows (padrão 1000).' },
          max_rows: { type: 'number' },
          order: { type: 'string', enum: ['ASC', 'DESC'] },
          sort: { type: 'number' },
        },
      },
    },
    {
      name: 'glpi_get_ticket_followups',
      description: 'Lista os acompanhamentos de um chamado.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'number' } }, required: ['ticket_id'] },
    },
    {
      name: 'glpi_get_ticket_tasks',
      description: 'Lista as tarefas de um chamado.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'number' } }, required: ['ticket_id'] },
    },
    {
      name: 'glpi_get_ticket_solutions',
      description: 'Lista as soluções de um chamado.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'number' } }, required: ['ticket_id'] },
    },
    {
      name: 'glpi_get_ticket_validations',
      description: 'Lista as validações (aprovações) de um chamado.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'number' } }, required: ['ticket_id'] },
    },
    {
      name: 'glpi_get_ticket_documents',
      description: 'Lista os documentos (anexos) de um chamado.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'number' } }, required: ['ticket_id'] },
    },

    // ============== ESCRITA — CHAMADOS ==============
    {
      name: 'glpi_create_ticket',
      description: 'Cria um novo chamado.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          content: { type: 'string' },
          urgency: { type: 'number' },
          impact: { type: 'number' },
          priority: { type: 'number' },
          type: { type: 'number', description: '1=Incidente, 2=Requisição' },
          category_id: { type: 'number' },
          entity_id: { type: 'number' },
          user_id_assign: { type: 'number' },
          group_id_assign: { type: 'number' },
          requester_user_id: { type: 'number' },
          requester_group_id: { type: 'number' },
          time_to_resolve: { type: 'string' },
        },
        required: ['name', 'content'],
      },
    },
    {
      name: 'glpi_update_ticket',
      description: 'Atualiza campos de um chamado.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: 'string' },
          content: { type: 'string' },
          status: { type: 'number' },
          urgency: { type: 'number' },
          priority: { type: 'number' },
          impact: { type: 'number' },
          itilcategories_id: { type: 'number' },
        },
        required: ['id'],
      },
    },
    {
      name: 'glpi_delete_ticket',
      description: '⚠️ DESTRUTIVO: exclui um chamado. force=true elimina em definitivo (irrecuperável).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' }, force: { type: 'boolean' } },
        required: ['id'],
      },
    },
    {
      name: 'glpi_add_followup',
      description: 'Adiciona um acompanhamento (comentário) a um chamado.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number' },
          content: { type: 'string' },
          is_private: { type: 'boolean' },
        },
        required: ['ticket_id', 'content'],
      },
    },
    {
      name: 'glpi_add_task',
      description: 'Adiciona uma tarefa (com controle de tempo) a um chamado.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number' },
          content: { type: 'string' },
          actiontime: { type: 'number' },
          is_private: { type: 'boolean' },
          state: { type: 'number', description: '0=Informação 1=A fazer 2=Feito' },
          users_id_tech: { type: 'number' },
          groups_id_tech: { type: 'number' },
        },
        required: ['ticket_id', 'content'],
      },
    },
    {
      name: 'glpi_add_solution',
      description: 'Adiciona uma solução a um chamado.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number' },
          content: { type: 'string' },
          solutiontypes_id: { type: 'number' },
        },
        required: ['ticket_id', 'content'],
      },
    },
    {
      name: 'glpi_assign_ticket',
      description: 'Atribui um chamado a um usuário OU a um grupo. type: 1=requerente, 2=atribuído, 3=observador.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number' },
          user_id: { type: 'number' },
          group_id: { type: 'number' },
          type: { type: 'number' },
        },
        required: ['ticket_id'],
      },
    },
    {
      name: 'glpi_link_tickets',
      description: 'Vincula dois chamados. link_type: 1=vínculo 2=duplicado 3=pai.',
      inputSchema: {
        type: 'object',
        properties: {
          parent_id: { type: 'number' },
          child_id: { type: 'number' },
          link_type: { type: 'number' },
        },
        required: ['parent_id', 'child_id'],
      },
    },
    {
      name: 'glpi_add_ticket_validation',
      description: 'Solicita uma validação (aprovação) em um chamado. O usuário escolhido recebe o pedido de aprovação.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number' },
          users_id_validate: { type: 'number', description: 'Usuário que deve validar' },
          comment_submission: { type: 'string' },
        },
        required: ['ticket_id', 'users_id_validate'],
      },
    },
    {
      name: 'glpi_set_validation_status',
      description: 'Aprova (2) ou recusa (3) uma TicketValidation existente. Comentário opcional.',
      inputSchema: {
        type: 'object',
        properties: {
          validation_id: { type: 'number' },
          status: { type: 'number', enum: [2, 3], description: '2=concedida, 3=recusada' },
          comment_validation: { type: 'string' },
        },
        required: ['validation_id', 'status'],
      },
    },
    {
      name: 'glpi_upload_document',
      description:
        'Envia um arquivo local (pelo caminho) como Documento do GLPI. Só aceita arquivos dentro de GLPI_UPLOAD_DIR; fica desabilitado quando a variável não está definida. Se ticket_id for informado, o documento também é anexado a esse chamado.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Caminho do arquivo na máquina que executa este servidor, dentro de GLPI_UPLOAD_DIR',
          },
          name: { type: 'string', description: 'Título do documento (padrão: nome do arquivo)' },
          ticket_id: {
            type: 'number',
            description: 'Se informado, anexa o documento enviado a este chamado',
          },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'glpi_attach_document_to_ticket',
      description: 'Vincula um documento existente (enviado separadamente) a um chamado via Document_Item.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number' },
          document_id: { type: 'number' },
        },
        required: ['ticket_id', 'document_id'],
      },
    },
    {
      name: 'glpi_get_ticket_satisfaction',
      description: 'Obtém os dados da pesquisa de satisfação (nota, comentário) de um chamado.',
      inputSchema: {
        type: 'object',
        properties: { ticket_id: { type: 'number' } },
        required: ['ticket_id'],
      },
    },
    {
      name: 'glpi_list_overdue_tickets',
      description: 'Lista chamados com prazo de solução do SLA (time_to_resolve) vencido e status < 5.',
      inputSchema: {
        type: 'object',
        properties: {
          entity_id: { type: 'number' },
          limit: { type: 'number' },
        },
      },
    },

    // ============== PROBLEMAS / MUDANÇAS ==============
    {
      name: 'glpi_list_problems',
      description: 'Lista problemas.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_problem',
      description: 'Obtém um problema com o rótulo de status.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_problem',
      description: 'Cria um problema.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, content: { type: 'string' },
          urgency: { type: 'number' }, impact: { type: 'number' }, priority: { type: 'number' },
          category_id: { type: 'number' },
        },
        required: ['name', 'content'],
      },
    },
    {
      name: 'glpi_update_problem',
      description: 'Atualiza um problema.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' }, name: { type: 'string' }, content: { type: 'string' },
          status: { type: 'number' }, urgency: { type: 'number' },
        },
        required: ['id'],
      },
    },
    {
      name: 'glpi_list_changes',
      description: 'Lista mudanças.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_change',
      description: 'Obtém uma mudança com o rótulo de status.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_change',
      description: 'Cria uma mudança.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, content: { type: 'string' },
          urgency: { type: 'number' }, impact: { type: 'number' }, priority: { type: 'number' },
          category_id: { type: 'number' },
        },
        required: ['name', 'content'],
      },
    },
    {
      name: 'glpi_update_change',
      description: 'Atualiza uma mudança.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' }, name: { type: 'string' }, content: { type: 'string' },
          status: { type: 'number' },
        },
        required: ['id'],
      },
    },

    // ============== ATIVOS ==============
    ...[
      'computers', 'softwares', 'network_equipments', 'printers', 'monitors', 'phones',
    ].flatMap((asset) => {
      const singular = asset.replace(/s$/, '');
      return [
        {
          name: `glpi_list_${asset}`,
          description: `Lista ${ASSET_PT[asset].plural}.`,
          inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
        },
        {
          name: `glpi_get_${singular}`,
          description: `Obtém ${ASSET_PT[asset].singular} pelo id.`,
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              with_softwares: { type: 'boolean' },
              with_networkports: { type: 'boolean' },
              with_connections: { type: 'boolean' },
              with_documents: { type: 'boolean' },
            },
            required: ['id'],
          },
        },
      ];
    }),
    {
      name: 'glpi_create_computer',
      description: 'Adiciona um computador ao inventário.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          serial: { type: 'string' }, otherserial: { type: 'string' },
          contact: { type: 'string' }, comment: { type: 'string' },
          locations_id: { type: 'number' }, states_id: { type: 'number' },
          computertypes_id: { type: 'number' }, manufacturers_id: { type: 'number' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_update_computer',
      description: 'Atualiza um computador.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' }, name: { type: 'string' }, serial: { type: 'string' },
          comment: { type: 'string' }, locations_id: { type: 'number' }, states_id: { type: 'number' },
        },
        required: ['id'],
      },
    },
    {
      name: 'glpi_delete_computer',
      description: '⚠️ DESTRUTIVO: exclui um computador. force=true elimina em definitivo.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' }, force: { type: 'boolean' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_software',
      description: 'Adiciona um software.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, comment: { type: 'string' },
          manufacturers_id: { type: 'number' }, softwarecategories_id: { type: 'number' },
        },
        required: ['name'],
      },
    },

    // ============== BASE DE CONHECIMENTO / CONTRATOS / FORNECEDORES / LOCALIZAÇÕES / PROJETOS ==============
    {
      name: 'glpi_list_knowbase',
      description: 'Lista artigos da base de conhecimento.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_knowbase_item',
      description: 'Obtém um artigo da base de conhecimento.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_search_knowbase',
      description: 'Busca artigos da base de conhecimento por texto livre no título (id do campo resolvido dinamicamente).',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
      },
    },
    {
      name: 'glpi_create_knowbase_item',
      description: 'Cria um artigo da base de conhecimento.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, answer: { type: 'string' },
          is_faq: { type: 'boolean' }, knowbaseitemcategories_id: { type: 'number' },
        },
        required: ['name', 'answer'],
      },
    },
    {
      name: 'glpi_list_contracts',
      description: 'Lista contratos.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_contract',
      description: 'Obtém um contrato.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_contract',
      description: 'Cria um contrato.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, num: { type: 'string' },
          begin_date: { type: 'string' }, duration: { type: 'number' },
          notice: { type: 'number' }, comment: { type: 'string' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_list_suppliers',
      description: 'Lista fornecedores.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_supplier',
      description: 'Obtém um fornecedor.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_supplier',
      description: 'Cria um fornecedor.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, address: { type: 'string' }, postcode: { type: 'string' },
          town: { type: 'string' }, country: { type: 'string' }, website: { type: 'string' },
          phonenumber: { type: 'string' }, email: { type: 'string' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_list_locations',
      description: 'Lista localizações.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_location',
      description: 'Obtém uma localização.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_location',
      description: 'Cria uma localização.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, address: { type: 'string' }, postcode: { type: 'string' },
          town: { type: 'string' }, building: { type: 'string' }, room: { type: 'string' },
          locations_id: { type: 'number' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_list_projects',
      description: 'Lista projetos.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_project',
      description: 'Obtém um projeto.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_project',
      description: 'Cria um projeto.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, code: { type: 'string' }, content: { type: 'string' },
          priority: { type: 'number' }, plan_start_date: { type: 'string' },
          plan_end_date: { type: 'string' }, users_id: { type: 'number' }, groups_id: { type: 'number' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_update_project',
      description: 'Atualiza um projeto (progresso, datas, conteúdo).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' }, name: { type: 'string' }, content: { type: 'string' },
          percent_done: { type: 'number' },
          real_start_date: { type: 'string' }, real_end_date: { type: 'string' },
        },
        required: ['id'],
      },
    },

    // ============== USUÁRIOS / GRUPOS / CATEGORIAS / ENTIDADES / DOCUMENTOS ==============
    {
      name: 'glpi_list_users',
      description: 'Lista usuários. active_only é true por padrão (usa critérios de busca, não searchText).',
      inputSchema: {
        type: 'object',
        properties: { ...LIST_TOOL_COMMON_PROPS, active_only: { type: 'boolean' } },
      },
    },
    {
      name: 'glpi_get_user',
      description: 'Obtém um usuário.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_search_user',
      description: 'Busca um usuário pelo login (operador "contains" no campo name).',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    {
      name: 'glpi_create_user',
      description: 'Cria um usuário.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, password: { type: 'string' },
          realname: { type: 'string' }, firstname: { type: 'string' },
          email: { type: 'string' }, phone: { type: 'string' }, profiles_id: { type: 'number' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_list_groups',
      description: 'Lista grupos.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_group',
      description: 'Obtém um grupo.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_create_group',
      description: 'Cria um grupo.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, comment: { type: 'string' },
          is_requester: { type: 'boolean' }, is_assign: { type: 'boolean' },
        },
        required: ['name'],
      },
    },
    {
      name: 'glpi_add_user_to_group',
      description: 'Adiciona um usuário a um grupo.',
      inputSchema: {
        type: 'object',
        properties: { user_id: { type: 'number' }, group_id: { type: 'number' }, is_manager: { type: 'boolean' } },
        required: ['user_id', 'group_id'],
      },
    },
    {
      name: 'glpi_list_categories',
      description: 'Lista categorias de chamado.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_list_entities',
      description: 'Lista entidades.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_entity',
      description: 'Obtém uma entidade.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    {
      name: 'glpi_list_documents',
      description: 'Lista documentos.',
      inputSchema: { type: 'object', properties: LIST_TOOL_COMMON_PROPS },
    },
    {
      name: 'glpi_get_document',
      description: 'Obtém um documento.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },

    // ============== ESTATÍSTICAS ==============
    {
      name: 'glpi_get_ticket_stats',
      description: 'Contagem de chamados por status. Filtros opcionais: entity, date_from, date_to.',
      inputSchema: {
        type: 'object',
        properties: {
          entity_id: { type: 'number' },
          date_from: { type: 'string', description: 'YYYY-MM-DD' },
          date_to: { type: 'string', description: 'YYYY-MM-DD' },
        },
      },
    },
    {
      name: 'glpi_get_asset_stats',
      description: 'Contagem total por tipo de ativo (Computer/Monitor/Printer/NetworkEquipment/Phone/Software).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'glpi_tickets_stats_by',
      description: 'Contagem de chamados por dimensão (status / category / technician / entity / month). Filtro de período opcional.',
      inputSchema: {
        type: 'object',
        properties: {
          dimension: {
            type: 'string',
            enum: ['status', 'category', 'technician', 'entity', 'month'],
          },
          date_from: { type: 'string' },
          date_to: { type: 'string' },
          entity_id: { type: 'number' },
        },
        required: ['dimension'],
      },
    },

    // ============== SESSÃO ==============
    {
      name: 'glpi_get_session_info',
      description: 'Perfil ativo + perfis disponíveis + entidades.',
      inputSchema: { type: 'object', properties: {} },
    },

    // ============== BUSCA GENÉRICA / CONTAGEM ==============
    {
      name: 'glpi_search_v2',
      description: 'Busca com múltiplos critérios. Use criteria[]: {field, searchtype, value, link}. Aceita forcedisplay, sort, order, start/limit, fetch_all.',
      inputSchema: {
        type: 'object',
        properties: {
          itemtype: { type: 'string' },
          criteria: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { description: 'field_id (número) OU nome amigável resolvido via listSearchOptions (prefira o uid, ex.: Ticket.status, ou o nome na língua do GLPI)' },
                searchtype: {
                  type: 'string',
                  enum: ['contains', 'notcontains', 'equals', 'notequals', 'lessthan', 'morethan', 'under', 'notunder', 'empty', 'notempty'],
                },
                value: {},
                link: { type: 'string', enum: ['AND', 'OR', 'AND NOT', 'OR NOT'] },
              },
              required: ['field', 'searchtype', 'value'],
            },
          },
          forcedisplay: { type: 'array', items: { type: 'number' } },
          start: { type: 'number' },
          limit: { type: 'number' },
          sort: { type: 'number' },
          order: { type: 'string', enum: ['ASC', 'DESC'] },
          fetch_all: { type: 'boolean' },
          max_rows: { type: 'number' },
          expand_dropdowns: { type: 'boolean' },
        },
        required: ['itemtype'],
      },
    },
    {
      name: 'glpi_count',
      description: 'Retorna o totalcount de um itemtype + critérios (sonda barata com range=0-0).',
      inputSchema: {
        type: 'object',
        properties: {
          itemtype: { type: 'string' },
          criteria: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: {},
                searchtype: { type: 'string' },
                value: {},
                link: { type: 'string' },
              },
              required: ['field', 'searchtype', 'value'],
            },
          },
        },
        required: ['itemtype'],
      },
    },
    {
      name: 'glpi_list_search_options',
      description: 'Descobre os campos pesquisáveis de um itemtype (retorna field_id → name/uid/datatype). Útil para montar critérios do glpi_search_v2.',
      inputSchema: {
        type: 'object',
        properties: { itemtype: { type: 'string' } },
        required: ['itemtype'],
      },
    },

    // ============== compatibilidade legada: mantém glpi_search (critério único) como alias obsoleto ==============
    {
      name: 'glpi_search',
      description: '[OBSOLETA — prefira glpi_search_v2] Busca com um único critério (mantida por compatibilidade).',
      inputSchema: {
        type: 'object',
        properties: {
          itemtype: { type: 'string' },
          field: { type: 'number' },
          searchtype: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['itemtype', 'field', 'searchtype', 'value'],
      },
    },
  ]
    .filter((tool) => !READ_ONLY || isReadTool(tool.name))
    .map(annotate),
}));

// ---------------------------------------------------------------------------
// Despacho das ferramentas
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: argsRaw } = request.params;
  const args = (argsRaw ?? {}) as Record<string, unknown>;

  try {
    if (READ_ONLY && !isReadTool(name)) {
      throw new McpError(ErrorCode.InvalidRequest, `${name} is disabled: server runs with GLPI_READ_ONLY`);
    }
    switch (name) {
      // ==== CHAMADOS — leitura ====
      case 'glpi_list_tickets': {
        const validated = listArgsSchema.parse(args);
        const opts = parseListArgs(validated);
        let tickets = await client.getTickets({ ...opts, order: opts.order ?? 'DESC' });
        if (typeof validated.status === 'number') {
          tickets = tickets.filter((t: any) => t.status === validated.status);
        }
        return text(tickets.map(formatTicketSummary));
      }

      case 'glpi_get_ticket': {
        const validated = ticketReadSchema.parse(args);
        const { id, with_logs } = validated;
        const [ticket, followups, tasks, solutions] = await Promise.all([
          client.getTicket(id, { with_logs }),
          client.getTicketFollowups(id),
          client.getTicketTasks(id),
          client.getTicketSolutions(id),
        ]);
        return text({
          ...ticket,
          status_label: TICKET_STATUS[(ticket as any).status],
          urgency_label: TICKET_URGENCY[(ticket as any).urgency],
          priority_label: TICKET_URGENCY[(ticket as any).priority],
          counts: {
            followups: followups.length,
            tasks: tasks.length,
            solutions: solutions.length,
          },
        });
      }

      case 'glpi_get_ticket_timeline': {
        const id = args.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'id required');
        const [followups, tasks, solutions, validations] = await Promise.all([
          client.getTicketFollowups(id),
          client.getTicketTasks(id),
          client.getTicketSolutions(id),
          client.getTicketValidations(id),
        ]);
        const timeline = [
          ...followups.map((f: any) => ({ kind: 'followup', date: f.date_creation ?? f.date, ...f })),
          ...tasks.map((t: any) => ({ kind: 'task', date: t.date_creation ?? t.date, ...t })),
          ...solutions.map((s: any) => ({ kind: 'solution', date: s.date_creation ?? s.date, ...s })),
          ...validations.map((v: any) => ({
            kind: 'validation',
            date: v.submission_date ?? v.date_creation ?? v.date,
            status_label: VALIDATION_STATUS[v.status] ?? v.status,
            ...v,
          })),
        ].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
        return text({ ticket_id: id, count: timeline.length, timeline });
      }

      case 'glpi_search_tickets': {
        ticketSearchSchema.parse(args);
        const criteria: SearchCriterion[] = [];
        const push = (c: SearchCriterion) => {
          if (criteria.length > 0 && !c.link) c.link = 'AND';
          criteria.push(c);
        };
        if (args.status !== undefined) push({ field: TICKET_FIELDS.status, searchtype: 'equals', value: args.status as number });
        if (args.assigned_user_id !== undefined) push({ field: TICKET_FIELDS.technician_user, searchtype: 'equals', value: args.assigned_user_id as number });
        if (args.assigned_group_id !== undefined) push({ field: TICKET_FIELDS.technician_group, searchtype: 'equals', value: args.assigned_group_id as number });
        if (args.requester_user_id !== undefined) push({ field: TICKET_FIELDS.requester_user, searchtype: 'equals', value: args.requester_user_id as number });
        if (args.category_id !== undefined) push({ field: TICKET_FIELDS.category, searchtype: 'equals', value: args.category_id as number });
        if (args.entity_id !== undefined) push({ field: TICKET_FIELDS.entity, searchtype: 'equals', value: args.entity_id as number });
        if (args.priority !== undefined) push({ field: TICKET_FIELDS.priority, searchtype: 'equals', value: args.priority as number });
        if (args.urgency !== undefined) push({ field: TICKET_FIELDS.urgency, searchtype: 'equals', value: args.urgency as number });
        if (args.date_from) push({ field: TICKET_FIELDS.date, searchtype: 'morethan', value: args.date_from as string });
        if (args.date_to) push({ field: TICKET_FIELDS.date, searchtype: 'lessthan', value: args.date_to as string });
        if (args.text_search) push({ field: TICKET_FIELDS.name, searchtype: 'contains', value: args.text_search as string });
        if (args.open_only) push({ field: TICKET_FIELDS.status, searchtype: 'lessthan', value: 5 });

        const result = await client.search.search('Ticket', {
          criteria,
          start: (args.start as number) ?? 0,
          limit: (args.limit as number) ?? 50,
          fetchAll: args.fetch_all as boolean,
          maxRows: args.max_rows as number,
          sort: args.sort as number,
          order: (args.order as 'ASC' | 'DESC') ?? 'DESC',
          expandDropdowns: true,
        });

        return text({
          totalcount: result.totalcount,
          count: result.count,
          data: result.data,
        });
      }

      case 'glpi_get_ticket_followups': {
        const id = args.ticket_id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketFollowups(id));
      }
      case 'glpi_get_ticket_tasks': {
        const id = args.ticket_id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketTasks(id));
      }
      case 'glpi_get_ticket_solutions': {
        const id = args.ticket_id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketSolutions(id));
      }
      case 'glpi_get_ticket_validations': {
        const id = args.ticket_id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketValidations(id));
      }
      case 'glpi_get_ticket_documents': {
        const id = args.ticket_id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketDocuments(id));
      }

      // ==== CHAMADOS — escrita ====
      case 'glpi_create_ticket': {
        const name = args.name as string;
        const content = args.content as string;
        if (!name || !content) throw new McpError(ErrorCode.InvalidParams, 'name and content required');
        const result = await client.createTicket({
          name,
          content,
          urgency: (args.urgency as number) ?? 3,
          impact: args.impact as number,
          priority: args.priority as number,
          type: (args.type as number) ?? 1,
          itilcategories_id: args.category_id as number,
          entities_id: args.entity_id as number,
          _users_id_assign: args.user_id_assign as number,
          _groups_id_assign: args.group_id_assign as number,
          _users_id_requester: args.requester_user_id as number,
          _groups_id_requester: args.requester_group_id as number,
          time_to_resolve: args.time_to_resolve as string,
        });
        return text({ success: true, ...result });
      }

      case 'glpi_update_ticket': {
        const id = args.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'id required');
        const updates: Record<string, unknown> = {};
        ['name', 'content', 'status', 'urgency', 'priority', 'impact', 'itilcategories_id'].forEach((k) => {
          if (args[k] !== undefined) updates[k] = args[k];
        });
        await client.updateTicket(id, updates as any);
        return text({ success: true, id });
      }

      case 'glpi_delete_ticket': {
        const id = args.id as number;
        if (!id) throw new McpError(ErrorCode.InvalidParams, 'id required');
        await client.deleteTicket(id, args.force as boolean);
        return text({ success: true, id, purged: !!args.force });
      }

      case 'glpi_add_followup': {
        const ticket_id = args.ticket_id as number;
        const content = args.content as string;
        if (!ticket_id || !content) throw new McpError(ErrorCode.InvalidParams, 'ticket_id and content required');
        const result = await client.addTicketFollowup(ticket_id, content, args.is_private as boolean);
        return text({ success: true, followup_id: result.id });
      }

      case 'glpi_add_task': {
        const ticket_id = args.ticket_id as number;
        const content = args.content as string;
        if (!ticket_id || !content) throw new McpError(ErrorCode.InvalidParams, 'ticket_id and content required');
        const result = await client.addTicketTask(ticket_id, content, {
          is_private: args.is_private as boolean,
          actiontime: args.actiontime as number,
          state: args.state as number,
          users_id_tech: args.users_id_tech as number,
          groups_id_tech: args.groups_id_tech as number,
        });
        return text({ success: true, task_id: result.id });
      }

      case 'glpi_add_solution': {
        const ticket_id = args.ticket_id as number;
        const content = args.content as string;
        if (!ticket_id || !content) throw new McpError(ErrorCode.InvalidParams, 'ticket_id and content required');
        const result = await client.addTicketSolution(ticket_id, content, args.solutiontypes_id as number);
        return text({ success: true, solution_id: result.id });
      }

      case 'glpi_assign_ticket': {
        const ticket_id = args.ticket_id as number;
        if (!ticket_id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        const user_id = args.user_id as number;
        const group_id = args.group_id as number;
        if (!user_id && !group_id) {
          throw new McpError(ErrorCode.InvalidParams, 'user_id or group_id required');
        }
        const result = await client.assignTicket(ticket_id, {
          users_id: user_id,
          groups_id: group_id,
          type: args.type as number,
        });
        return text({ success: true, assignment_id: result.id });
      }

      case 'glpi_link_tickets': {
        const parent_id = args.parent_id as number;
        const child_id = args.child_id as number;
        if (!parent_id || !child_id) throw new McpError(ErrorCode.InvalidParams, 'parent_id and child_id required');
        const result = await client.linkTickets(parent_id, child_id, (args.link_type as number) ?? 1);
        return text({ success: true, link_id: result.id });
      }

      case 'glpi_add_ticket_validation': {
        const ticket_id = args.ticket_id as number;
        const users_id_validate = args.users_id_validate as number;
        if (!ticket_id || !users_id_validate) {
          throw new McpError(ErrorCode.InvalidParams, 'ticket_id and users_id_validate required');
        }
        const result = await client.addTicketValidation(ticket_id, {
          users_id_validate,
          comment_submission: args.comment_submission as string,
        });
        return text({ success: true, validation_id: result.id });
      }

      case 'glpi_set_validation_status': {
        const validation_id = args.validation_id as number;
        const status = args.status as 2 | 3;
        if (!validation_id || (status !== 2 && status !== 3)) {
          throw new McpError(ErrorCode.InvalidParams, 'validation_id and status (2 or 3) required');
        }
        await client.setTicketValidationStatus(
          validation_id,
          status,
          args.comment_validation as string
        );
        return text({ success: true, validation_id, status_label: VALIDATION_STATUS[status] });
      }

      case 'glpi_upload_document': {
        const filePath = args.file_path as string;
        if (!filePath) throw new McpError(ErrorCode.InvalidParams, 'file_path required');
        let data: Uint8Array;
        try {
          data = await readFile(await resolveUploadPath(filePath, UPLOAD_POLICY));
        } catch (err) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `cannot upload "${filePath}": ${err instanceof Error ? err.message : err}`
          );
        }
        const filename = basename(filePath);
        const ticket_id = args.ticket_id as number | undefined;
        // Vincular pelo manifesto (itemtype/items_id) faz o GLPI criar o
        // Document_Item sozinho, o que também funciona para perfis restritos que
        // não podem fazer POST direto em Document_Item.
        const document = await client.uploadDocument({
          filename,
          data,
          name: args.name as string | undefined,
          mimeType: UPLOAD_MIME_TYPES[extname(filename).toLowerCase()],
          ...(ticket_id ? { itemtype: 'Ticket', items_id: ticket_id } : {}),
        });
        return text({ success: true, document_id: document.id, ...(ticket_id ? { ticket_id } : {}) });
      }

      case 'glpi_attach_document_to_ticket': {
        const ticket_id = args.ticket_id as number;
        const document_id = args.document_id as number;
        if (!ticket_id || !document_id) {
          throw new McpError(ErrorCode.InvalidParams, 'ticket_id and document_id required');
        }
        const result = await client.attachDocumentToTicket(ticket_id, document_id);
        return text({ success: true, link_id: result.id });
      }

      case 'glpi_get_ticket_satisfaction': {
        const ticket_id = args.ticket_id as number;
        if (!ticket_id) throw new McpError(ErrorCode.InvalidParams, 'ticket_id required');
        return text(await client.getTicketSatisfaction(ticket_id));
      }

      case 'glpi_list_overdue_tickets': {
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const criteria: SearchCriterion[] = [
          { field: TICKET_FIELDS.status, searchtype: 'lessthan', value: 5 },
          // o id da search option de time_to_resolve costuma ser 18; usa 18 como alternativa.
          { field: 18, searchtype: 'lessthan', value: now, link: 'AND' },
          { field: 18, searchtype: 'notempty', value: '', link: 'AND' },
        ];
        if (args.entity_id !== undefined) {
          criteria.push({ field: TICKET_FIELDS.entity, searchtype: 'equals', value: args.entity_id as number, link: 'AND' });
        }
        const result = await client.search.search('Ticket', {
          criteria,
          limit: (args.limit as number) ?? 50,
          expandDropdowns: true,
          order: 'ASC',
          sort: 18,
        });
        return text({
          totalcount: result.totalcount,
          count: result.count,
          data: result.data,
        });
      }

      // ==== PROBLEMAS / MUDANÇAS ====
      case 'glpi_list_problems': {
        const list = await client.getProblems({ ...parseListArgs(args), order: 'DESC' });
        return text(list.map((p: any) => ({
          id: p.id, name: p.name,
          status: PROBLEM_STATUS[p.status] ?? p.status,
          urgency: TICKET_URGENCY[p.urgency] ?? p.urgency,
          date: p.date,
        })));
      }
      case 'glpi_get_problem': {
        const id = args.id as number;
        const p = await client.getProblem(id);
        return text({
          ...p,
          status_label: PROBLEM_STATUS[(p as any).status],
          urgency_label: TICKET_URGENCY[(p as any).urgency],
        });
      }
      case 'glpi_create_problem': {
        const result = await client.createProblem({
          name: args.name as string,
          content: args.content as string,
          urgency: args.urgency as number,
          impact: args.impact as number,
          priority: args.priority as number,
          itilcategories_id: args.category_id as number,
        });
        return text({ success: true, ...result });
      }
      case 'glpi_update_problem': {
        const id = args.id as number;
        const updates: Record<string, unknown> = {};
        ['name', 'content', 'status', 'urgency'].forEach((k) => {
          if (args[k] !== undefined) updates[k] = args[k];
        });
        await client.updateProblem(id, updates as any);
        return text({ success: true, id });
      }

      case 'glpi_list_changes': {
        const list = await client.getChanges({ ...parseListArgs(args), order: 'DESC' });
        return text(list.map((c: any) => ({
          id: c.id, name: c.name,
          status: CHANGE_STATUS[c.status] ?? c.status,
          urgency: TICKET_URGENCY[c.urgency] ?? c.urgency,
          date: c.date,
        })));
      }
      case 'glpi_get_change': {
        const id = args.id as number;
        const c = await client.getChange(id);
        return text({
          ...c,
          status_label: CHANGE_STATUS[(c as any).status],
          urgency_label: TICKET_URGENCY[(c as any).urgency],
        });
      }
      case 'glpi_create_change': {
        const result = await client.createChange({
          name: args.name as string,
          content: args.content as string,
          urgency: args.urgency as number,
          impact: args.impact as number,
          priority: args.priority as number,
          itilcategories_id: args.category_id as number,
        });
        return text({ success: true, ...result });
      }
      case 'glpi_update_change': {
        const id = args.id as number;
        const updates: Record<string, unknown> = {};
        ['name', 'content', 'status'].forEach((k) => {
          if (args[k] !== undefined) updates[k] = args[k];
        });
        await client.updateChange(id, updates as any);
        return text({ success: true, id });
      }

      // ==== ATIVOS ====
      case 'glpi_list_computers':
        return text(await client.getComputers(parseListArgs(args)));
      case 'glpi_get_computer':
        return text(await client.getComputer(args.id as number, {
          with_softwares: args.with_softwares as boolean,
          with_connections: args.with_connections as boolean,
          with_networkports: args.with_networkports as boolean,
          with_documents: args.with_documents as boolean,
        }));
      case 'glpi_create_computer':
        return text({ success: true, ...(await client.createComputer(args)) });
      case 'glpi_update_computer': {
        const id = args.id as number;
        const updates = { ...args }; delete (updates as any).id;
        await client.updateComputer(id, updates as any);
        return text({ success: true, id });
      }
      case 'glpi_delete_computer':
        await client.deleteComputer(args.id as number, args.force as boolean);
        return text({ success: true, id: args.id, purged: !!args.force });

      case 'glpi_list_softwares':
        return text(await client.getSoftwares(parseListArgs(args)));
      case 'glpi_get_software':
        return text(await client.getSoftware(args.id as number));
      case 'glpi_create_software':
        return text({ success: true, ...(await client.createSoftware(args)) });

      case 'glpi_list_network_equipments':
        return text(await client.getNetworkEquipments(parseListArgs(args)));
      case 'glpi_get_network_equipment':
        return text(await client.getNetworkEquipment(args.id as number, {
          with_networkports: args.with_networkports as boolean,
        }));

      case 'glpi_list_printers':
        return text(await client.getPrinters(parseListArgs(args)));
      case 'glpi_get_printer':
        return text(await client.getPrinter(args.id as number));

      case 'glpi_list_monitors':
        return text(await client.getMonitors(parseListArgs(args)));
      case 'glpi_get_monitor':
        return text(await client.getMonitor(args.id as number));

      case 'glpi_list_phones':
        return text(await client.getPhones(parseListArgs(args)));
      case 'glpi_get_phone':
        return text(await client.getPhone(args.id as number));

      // ==== BASE DE CONHECIMENTO / CONTRATOS / FORNECEDORES / LOCALIZAÇÕES / PROJETOS ====
      case 'glpi_list_knowbase':
        return text(await client.getKnowbaseItems(parseListArgs(args)));
      case 'glpi_get_knowbase_item':
        return text(await client.getKnowbaseItem(args.id as number));
      case 'glpi_search_knowbase':
        return text(await client.searchKnowbase(args.query as string, (args.limit as number) ?? 50));
      case 'glpi_create_knowbase_item': {
        const result = await client.createKnowbaseItem({
          name: args.name as string,
          answer: args.answer as string,
          is_faq: args.is_faq ? 1 : 0,
          knowbaseitemcategories_id: args.knowbaseitemcategories_id as number,
        });
        return text({ success: true, ...result });
      }

      case 'glpi_list_contracts':
        return text(await client.getContracts(parseListArgs(args)));
      case 'glpi_get_contract':
        return text(await client.getContract(args.id as number));
      case 'glpi_create_contract':
        return text({ success: true, ...(await client.createContract(args)) });

      case 'glpi_list_suppliers':
        return text(await client.getSuppliers(parseListArgs(args)));
      case 'glpi_get_supplier':
        return text(await client.getSupplier(args.id as number));
      case 'glpi_create_supplier':
        return text({ success: true, ...(await client.createSupplier(args)) });

      case 'glpi_list_locations':
        return text(await client.getLocations(parseListArgs(args)));
      case 'glpi_get_location':
        return text(await client.getLocation(args.id as number));
      case 'glpi_create_location':
        return text({ success: true, ...(await client.createLocation(args)) });

      case 'glpi_list_projects':
        return text(await client.getProjects(parseListArgs(args)));
      case 'glpi_get_project':
        return text(await client.getProject(args.id as number));
      case 'glpi_create_project':
        return text({ success: true, ...(await client.createProject(args)) });
      case 'glpi_update_project': {
        const id = args.id as number;
        const updates: Record<string, unknown> = {};
        ['name', 'content', 'percent_done', 'real_start_date', 'real_end_date'].forEach((k) => {
          if (args[k] !== undefined) updates[k] = args[k];
        });
        await client.updateProject(id, updates as any);
        return text({ success: true, id });
      }

      // ==== USUÁRIOS / GRUPOS ====
      case 'glpi_list_users':
        return text(await client.getUsers({
          ...parseListArgs(args),
          is_active: args.active_only === false ? false : true,
        }));
      case 'glpi_get_user':
        return text(await client.getUser(args.id as number));
      case 'glpi_search_user':
        return text(await client.getUserByName(args.name as string));
      case 'glpi_create_user':
        return text({ success: true, ...(await client.createUser({
          name: args.name as string,
          password: args.password as string,
          realname: args.realname as string,
          firstname: args.firstname as string,
          email: args.email as string,
          phone: args.phone as string,
          profiles_id: args.profiles_id as number,
        })) });

      case 'glpi_list_groups':
        return text(await client.getGroups(parseListArgs(args)));
      case 'glpi_get_group':
        return text(await client.getGroup(args.id as number));
      case 'glpi_create_group':
        return text({ success: true, ...(await client.createGroup({
          name: args.name as string,
          comment: args.comment as string,
          is_requester: args.is_requester ? 1 : 0,
          is_assign: args.is_assign ? 1 : 0,
        })) });
      case 'glpi_add_user_to_group':
        return text({ success: true, ...(await client.addUserToGroup(
          args.user_id as number,
          args.group_id as number,
          args.is_manager as boolean
        )) });

      case 'glpi_list_categories':
        return text(await client.getCategories(parseListArgs(args)));
      case 'glpi_list_entities':
        return text(await client.getEntities(parseListArgs(args)));
      case 'glpi_get_entity':
        return text(await client.getEntity(args.id as number));
      case 'glpi_list_documents':
        return text(await client.getDocuments(parseListArgs(args)));
      case 'glpi_get_document':
        return text(await client.getDocument(args.id as number));

      // ==== ESTATÍSTICAS ====
      case 'glpi_get_ticket_stats': {
        const stats = await client.getTicketStats({
          entity_id: args.entity_id as number,
          date_from: args.date_from as string,
          date_to: args.date_to as string,
        });
        return text({
          ...stats,
          summary: `${stats.total} tickets — new:${stats.new} processing:${stats.processing} pending:${stats.pending} solved:${stats.solved} closed:${stats.closed}`,
        });
      }

      case 'glpi_get_asset_stats': {
        const stats = await client.getAssetStats();
        return text({ ...stats, total: stats.computers + stats.monitors + stats.printers + stats.networkEquipments + stats.phones });
      }

      case 'glpi_tickets_stats_by': {
        const dimension = args.dimension as 'status' | 'category' | 'technician' | 'entity' | 'month';
        const base: SearchCriterion[] = [];
        if (args.entity_id !== undefined) base.push({ field: TICKET_FIELDS.entity, searchtype: 'equals', value: args.entity_id as number });
        if (args.date_from) base.push({ field: TICKET_FIELDS.date, searchtype: 'morethan', value: args.date_from as string, link: 'AND' });
        if (args.date_to) base.push({ field: TICKET_FIELDS.date, searchtype: 'lessthan', value: args.date_to as string, link: 'AND' });

        const counts: Record<string, number> = {};

        if (dimension === 'status') {
          for (const [statusId, label] of Object.entries(TICKET_STATUS)) {
            const c: SearchCriterion[] = [
              { field: TICKET_FIELDS.status, searchtype: 'equals', value: Number(statusId) },
              ...base.map((b, i) => ({ ...b, link: 'AND' as const })),
            ];
            counts[label] = await client.search.count('Ticket', c);
          }
        } else if (dimension === 'category') {
          const cats = await client.getCategories({ range: '0-199' });
          for (const cat of cats as any[]) {
            const c: SearchCriterion[] = [
              { field: TICKET_FIELDS.category, searchtype: 'equals', value: cat.id },
              ...base.map((b) => ({ ...b, link: 'AND' as const })),
            ];
            const n = await client.search.count('Ticket', c);
            if (n > 0) counts[cat.completename ?? cat.name] = n;
          }
        } else if (dimension === 'technician') {
          const users = await client.getUsers({ range: '0-199', is_active: true });
          for (const u of users) {
            const c: SearchCriterion[] = [
              { field: TICKET_FIELDS.technician_user, searchtype: 'equals', value: u.id },
              ...base.map((b) => ({ ...b, link: 'AND' as const })),
            ];
            const n = await client.search.count('Ticket', c);
            if (n > 0) counts[`${u.firstname ?? ''} ${u.realname ?? ''} (${u.name})`.trim()] = n;
          }
        } else if (dimension === 'entity') {
          const entities = await client.getEntities({ range: '0-99' });
          for (const e of entities as any[]) {
            const c: SearchCriterion[] = [
              { field: TICKET_FIELDS.entity, searchtype: 'equals', value: e.id },
              ...base.map((b) => ({ ...b, link: 'AND' as const })),
            ];
            const n = await client.search.count('Ticket', c);
            if (n > 0) counts[e.completename ?? e.name] = n;
          }
        } else if (dimension === 'month') {
          // Calcula os intervalos mensais entre date_from e date_to (ou os últimos 6 meses).
          const to = args.date_to ? new Date(args.date_to as string) : new Date();
          const from = args.date_from ? new Date(args.date_from as string) : new Date(to.getFullYear(), to.getMonth() - 5, 1);
          const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
          while (cursor <= to) {
            const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
            const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
            const fmt = (d: Date) => d.toISOString().slice(0, 10) + ' 00:00:00';
            const monthCriteria: SearchCriterion[] = [
              { field: TICKET_FIELDS.date, searchtype: 'morethan', value: fmt(monthStart) },
              { field: TICKET_FIELDS.date, searchtype: 'lessthan', value: fmt(monthEnd), link: 'AND' },
            ];
            if (args.entity_id !== undefined) {
              monthCriteria.push({ field: TICKET_FIELDS.entity, searchtype: 'equals', value: args.entity_id as number, link: 'AND' });
            }
            const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
            counts[key] = await client.search.count('Ticket', monthCriteria);
            cursor.setMonth(cursor.getMonth() + 1);
          }
        } else {
          throw new McpError(ErrorCode.InvalidParams, `Unknown dimension: ${dimension}`);
        }

        return text({ dimension, counts, total: Object.values(counts).reduce((s, n) => s + n, 0) });
      }

      // ==== SESSÃO ====
      case 'glpi_get_session_info': {
        const [profile, profiles, entities] = await Promise.all([
          client.getActiveProfile(),
          client.getMyProfiles(),
          client.getMyEntities(),
        ]);
        return text({ active_profile: profile, available_profiles: profiles, entities });
      }

      // ==== BUSCA ====
      case 'glpi_search_v2': {
        const itemtype = itemtypeArg(args);
        const rawCriteria = (args.criteria as CriteriaArg[]) ?? [];
        const criteria = await resolveCriteria(client, itemtype, rawCriteria);
        const result = await client.search.search(itemtype, {
          criteria,
          forcedisplay: args.forcedisplay as number[],
          start: args.start as number,
          limit: args.limit as number,
          sort: args.sort as number,
          order: args.order as 'ASC' | 'DESC',
          fetchAll: args.fetch_all as boolean,
          maxRows: args.max_rows as number,
          expandDropdowns: args.expand_dropdowns !== false,
        });
        return text(result);
      }

      case 'glpi_count': {
        const itemtype = itemtypeArg(args);
        const rawCriteria = (args.criteria as CriteriaArg[]) ?? [];
        const criteria = await resolveCriteria(client, itemtype, rawCriteria);
        const totalcount = await client.search.count(itemtype, criteria);
        return text({ itemtype, totalcount });
      }

      case 'glpi_list_search_options': {
        const itemtype = itemtypeArg(args);
        const cat = await client.searchOptions.get(itemtype);
        const entries = Array.from(cat.byId.values()).map((o) => ({
          id: o.id, name: o.name, uid: o.uid, table: o.table,
          field: o.field, datatype: o.datatype,
          available_searchtypes: o.available_searchtypes,
        }));
        return text({ itemtype, count: entries.length, options: entries });
      }

      // legado
      case 'glpi_search': {
        const itemtype = args.itemtype === undefined ? '' : itemtypeArg(args);
        const field = args.field as number;
        const searchtype = args.searchtype as SearchType;
        const value = args.value as string;
        if (!itemtype || field === undefined || !searchtype || value === undefined) {
          throw new McpError(ErrorCode.InvalidParams, 'itemtype, field, searchtype, value required');
        }
        const result = await client.search.search(itemtype, {
          criteria: [{ field, searchtype, value }],
          expandDropdowns: true,
        });
        return text(result);
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for ${name}: ${issues}`);
    }
    if (error instanceof GlpiError) {
      const detail = error.glpiCode
        ? `${error.glpiCode}${error.glpiMessage ? ' — ' + error.glpiMessage : ''}`
        : error.message;
      throw new McpError(
        ErrorCode.InternalError,
        `GLPI API error on ${name} (HTTP ${error.status}): ${detail}`
      );
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

// ---------------------------------------------------------------------------
// Recursos
// ---------------------------------------------------------------------------

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: 'glpi://tickets/open', name: 'Chamados abertos', description: 'Chamados com status < 5', mimeType: 'application/json' },
    { uri: 'glpi://tickets/recent', name: 'Chamados recentes', description: 'Chamados mais recentes', mimeType: 'application/json' },
    { uri: 'glpi://problems/open', name: 'Problemas abertos', description: 'Problemas abertos', mimeType: 'application/json' },
    { uri: 'glpi://changes/pending', name: 'Mudanças pendentes', description: 'Mudanças pendentes', mimeType: 'application/json' },
    { uri: 'glpi://computers', name: 'Computadores', description: 'Computadores', mimeType: 'application/json' },
    { uri: 'glpi://groups', name: 'Grupos', description: 'Grupos', mimeType: 'application/json' },
    { uri: 'glpi://categories', name: 'Categorias', description: 'Categorias ITIL', mimeType: 'application/json' },
    { uri: 'glpi://stats/tickets', name: 'Estatísticas de chamados', description: 'Contagem de chamados', mimeType: 'application/json' },
    { uri: 'glpi://stats/assets', name: 'Estatísticas de ativos', description: 'Contagem de ativos', mimeType: 'application/json' },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  try {
    switch (uri) {
      case 'glpi://tickets/open': {
        const result = await client.search.search('Ticket', {
          criteria: [{ field: TICKET_FIELDS.status, searchtype: 'lessthan', value: 5 }],
          limit: 100,
          order: 'DESC',
          sort: TICKET_FIELDS.date_mod,
          expandDropdowns: true,
        });
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(result.data, null, 2) }] };
      }
      case 'glpi://tickets/recent': {
        const tickets = await client.getTickets({ range: '0-19', order: 'DESC', expand_dropdowns: true });
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(tickets, null, 2) }] };
      }
      case 'glpi://problems/open': {
        const problems = await client.getProblems({ range: '0-99' });
        const open = (problems as any[]).filter((p) => p.status < 5);
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(open, null, 2) }] };
      }
      case 'glpi://changes/pending': {
        const changes = await client.getChanges({ range: '0-99' });
        const pending = (changes as any[]).filter((c) => c.status < 8);
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(pending, null, 2) }] };
      }
      case 'glpi://computers':
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await client.getComputers({ range: '0-99', is_deleted: false }), null, 2) }] };
      case 'glpi://groups':
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await client.getGroups({ range: '0-99' }), null, 2) }] };
      case 'glpi://categories':
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await client.getCategories({ range: '0-99' }), null, 2) }] };
      case 'glpi://stats/tickets':
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await client.getTicketStats(), null, 2) }] };
      case 'glpi://stats/assets':
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await client.getAssetStats(), null, 2) }] };
      default:
        throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(
      ErrorCode.InternalError,
      `Error reading resource: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

async function main() {
  try {
    const config = getConfig();
    client = new GlpiClient(config);

    // Tenta abrir a sessão logo na partida, mas não encerra se o GLPI estiver
    // momentaneamente inacessível: a camada HTTP reautentica sob demanda na primeira requisição.
    try {
      await client.initSession();
      console.error('GLPI session initialized');
    } catch (error) {
      console.error(
        `Warning: could not reach GLPI at startup (${error instanceof Error ? error.message : error}). ` +
        'The session will be established on the first request.'
      );
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('MCP GLPI Server v3.0 running on stdio');

    const shutdown = async () => {
      try {
        await client.killSession();
      } catch (error) {
        console.error('Warning: killSession failed during shutdown:', error instanceof Error ? error.message : error);
      }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
