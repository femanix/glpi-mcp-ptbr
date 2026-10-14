# glpi-rj-mcp — Servidor MCP para GLPI

Servidor [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) que
expõe o GLPI (gestão de serviços de TI) para assistentes de IA como o Claude.

Projeto em português do Brasil, com endurecimento de segurança para uso
interno. O histórico de mudanças está no [CHANGELOG.md](./CHANGELOG.md); o
restante deste README descreve o que o servidor expõe hoje.

Baseado no [mcp-glpi](https://github.com/GMS64260/mcp-glpi) de GMS64260,
licenciado sob MIT.

## O que tem na v3

- **Base sólida**: camada HTTP única com reautenticação automática em 401,
  erros estruturados e retry em 5xx.
- **Busca de verdade**: múltiplos critérios com `AND` / `OR` / `AND NOT` /
  `OR NOT`, `forcedisplay`, paginação, `fetch_all` e sonda de contagem.
- **Mapeamento dinâmico de campos**: `/listSearchOptions/{itemtype}` fica em
  cache, então a tradução `field_id` ↔ nome continua válida entre versões do
  GLPI.
- **Relatórios de alto nível**: `glpi_search_tickets` aceita parâmetros
  amigáveis e `glpi_tickets_stats_by` agrupa contagens por status, categoria,
  técnico, entidade ou mês.
- **Cobertura ITIL completa**: linha do tempo (acompanhamentos + tarefas +
  soluções + validações), pedido e aprovação de validações, vínculo entre
  chamados, anexos, satisfação e chamados com SLA vencido.
- **Chaves estrangeiras resolvidas por padrão**: as consultas de detalhe
  devolvem `users_id_tech: 42` *e* o nome resolvido, para o modelo não precisar
  adivinhar.

## Configuração

| Variável | Obrigatória | Descrição |
|---|---|---|
| `GLPI_URL` | sim | URL base da instância do GLPI |
| `GLPI_APP_TOKEN` | não | Token da aplicação (Configurar → Geral → API) |
| `GLPI_USER_TOKEN` | não\* | Token de API do usuário |
| `GLPI_USERNAME` | não\* | Login (quando não se usa o token de usuário) |
| `GLPI_PASSWORD` | não\* | Senha (quando não se usa o token de usuário) |
| `GLPI_TIMEOUT_MS` | não | Timeout das requisições HTTP em ms (padrão `15000`) |
| `GLPI_MAX_RETRIES` | não | Máximo de tentativas extras em 5xx / 429 / erro de rede (padrão `2`). Requisições POST não são repetidas em 5xx nem em erro de rede |
| `GLPI_DEBUG` | não | Qualquer valor ativa o log de retries e reautenticação no stderr |
| `GLPI_READ_ONLY` | não | `1` esconde e bloqueia toda ferramenta que escreve no GLPI (criar/atualizar/excluir/enviar arquivo) |
| `GLPI_UPLOAD_DIR` | não | Diretório de onde `glpi_upload_document` pode ler arquivos. **Sem valor = envio de arquivos desabilitado** |
| `GLPI_MAX_UPLOAD_BYTES` | não | Tamanho máximo de envio (padrão 25 MiB) |
| `GLPI_ALLOW_INSECURE_HTTP` | não | `1` aceita `GLPI_URL` com `http://` puro. Sem isso, só `https://` é aceito (loopback é sempre permitido) |

\* é obrigatório informar `GLPI_USER_TOKEN` **ou** `GLPI_USERNAME` +
`GLPI_PASSWORD`.

### Segurança

Texto de chamados e da base de conhecimento é escrito por outras pessoas e
chega ao modelo, então deve ser tratado como entrada não confiável (prompt
injection). Configuração recomendada:

- Use um usuário de serviço dedicado no GLPI, com perfil mínimo (sem permissão
  de purge e só com as entidades de que precisa).
- Defina `GLPI_READ_ONLY=1` quando o agente não precisar escrever.
- Deixe `GLPI_UPLOAD_DIR` vazio ou aponte para uma pasta sem nada sensível.
- Mantenha no cliente MCP a aprovação manual, a cada chamada, das ferramentas
  de escrita.

### Claude Desktop / Claude Code

O pacote não está publicado no npm: faça o build local e aponte para ele
(requer Node 18 ou superior). Não use `npx mcp-glpi`, que é outro pacote, sem as
proteções deste repositório.

```json
{
  "mcpServers": {
    "glpi": {
      "command": "node",
      "args": ["/caminho/para/glpi-mcp/dist/index.js"],
      "env": {
        "GLPI_URL": "https://glpi.example.com",
        "GLPI_APP_TOKEN": "...",
        "GLPI_USER_TOKEN": "...",
        "GLPI_READ_ONLY": "1"
      }
    }
  }
}
```

## Catálogo de ferramentas

### Chamados — leitura

| Ferramenta | Descrição |
|---|---|
| `glpi_list_tickets` | Lista com `start`/`limit`/`range`/`sort`/`order`/`status` |
| `glpi_get_ticket` | Detalhe + rótulos de status/urgência + contagem de itens vinculados |
| `glpi_get_ticket_timeline` | Acompanhamentos + tarefas + soluções + validações, em ordem cronológica |
| `glpi_search_tickets` | Busca de alto nível (status, atribuído, requerente, datas, ...) |
| `glpi_get_ticket_followups` | Acompanhamentos de um chamado |
| `glpi_get_ticket_tasks` | Tarefas |
| `glpi_get_ticket_solutions` | Soluções |
| `glpi_get_ticket_validations` | Validações (aprovações) |
| `glpi_get_ticket_documents` | Documentos vinculados |
| `glpi_get_ticket_satisfaction` | Resultado da pesquisa de satisfação |
| `glpi_list_overdue_tickets` | Chamados com prazo de SLA vencido |

### Chamados — escrita

| Ferramenta | Descrição |
|---|---|
| `glpi_create_ticket` | Cria um chamado |
| `glpi_update_ticket` | Atualiza campos |
| `glpi_delete_ticket` | ⚠️ Exclui (`force=true` elimina em definitivo) |
| `glpi_add_followup` | Adiciona um acompanhamento |
| `glpi_add_task` | Adiciona uma tarefa com controle de tempo |
| `glpi_add_solution` | Adiciona uma solução |
| `glpi_assign_ticket` | Atribui a um usuário OU a um grupo |
| `glpi_link_tickets` | Vincula (vínculo / duplicado / pai) |
| `glpi_add_ticket_validation` | Solicita uma validação |
| `glpi_set_validation_status` | Aprova (2) ou recusa (3) |
| `glpi_upload_document` | Envia um arquivo local (somente de `GLPI_UPLOAD_DIR`) como Documento; com `ticket_id`, anexa ao chamado na mesma chamada |
| `glpi_attach_document_to_ticket` | Vincula um documento já enviado a um chamado |

### Problemas e Mudanças

| Ferramenta | Descrição |
|---|---|
| `glpi_list_problems` / `glpi_get_problem` / `glpi_create_problem` / `glpi_update_problem` | Gestão de problemas |
| `glpi_list_changes` / `glpi_get_change` / `glpi_create_change` / `glpi_update_change` | Gestão de mudanças |

### Ativos

| Família | Observações |
|---|---|
| Computer, Software, NetworkEquipment, Printer, Monitor, Phone | `list_*` e `get_*`, mais criar/atualizar/excluir onde existir |

### Base de conhecimento, contratos, fornecedores, localizações, projetos, documentos

`glpi_list_*`, `glpi_get_*` e `glpi_create_*` onde a API do GLPI permite.
`glpi_search_knowbase` faz busca por texto livre no título (o id do campo é
resolvido dinamicamente, não é fixo no código).

### Usuários, grupos, categorias, entidades

`glpi_list_users` filtra usuários ativos pelo endpoint de busca (não por
`searchText`); `glpi_create_user`, `glpi_create_group` e
`glpi_add_user_to_group` cobrem o provisionamento.

### Estatísticas

| Ferramenta | Descrição |
|---|---|
| `glpi_get_ticket_stats` | Contagem por status (filtros opcionais de entidade e data) |
| `glpi_get_asset_stats` | Contagem total por tipo de ativo |
| `glpi_tickets_stats_by` | Agrupamento por `status` / `category` / `technician` / `entity` / `month`, com período opcional |

### Genéricas / introspecção

| Ferramenta | Descrição |
|---|---|
| `glpi_search_v2` | Busca com múltiplos critérios (`criteria[]`, `forcedisplay`, `fetch_all`, ...) |
| `glpi_count` | Sonda barata de totalcount com critérios |
| `glpi_list_search_options` | Catálogo de campos pesquisáveis de um itemtype |
| `glpi_get_session_info` | Perfil ativo + perfis disponíveis + entidades |
| `glpi_search` | **Obsoleta**: alias de critério único, mantido por compatibilidade |

### Recursos

`glpi://tickets/open`, `glpi://tickets/recent`, `glpi://problems/open`,
`glpi://changes/pending`, `glpi://computers`, `glpi://groups`,
`glpi://categories`, `glpi://stats/tickets`, `glpi://stats/assets`.

## Campos de busca em GLPI em português

Nos critérios de `glpi_search_v2` e `glpi_count`, o campo (`field`) pode ser:

1. o **id numérico** da search option;
2. o **uid** (ex.: `Ticket.status`, `Ticket.name`), que não depende do idioma e
   é a forma mais estável;
3. o **nome como o GLPI mostra** no idioma configurado (ex.: `Título`,
   `Categoria`). A comparação ignora maiúsculas e acentos, então `titulo`
   também funciona.

Nomes em inglês (como `Title`) **não** casam num GLPI em português, a não ser que o GLPI use a mesma palavra (ex.: `Status`). Um campo
que não é encontrado gera erro de parâmetro inválido em vez de ser ignorado.
Use `glpi_list_search_options` para ver o que está disponível. Os nomes vêm do
idioma do usuário dono do token de API.

## Referência

Os rótulos abaixo seguem os nomes do GLPI em português do Brasil.

### Status do chamado

| ID | Rótulo |
|---|---|
| 1 | Novo |
| 2 | Em atendimento (atribuído) |
| 3 | Em atendimento (planejado) |
| 4 | Pendente |
| 5 | Solucionado |
| 6 | Fechado |

### Status da validação

| ID | Rótulo |
|---|---|
| 1 | Aguardando |
| 2 | Concedida |
| 3 | Recusada |

### Urgência / impacto / prioridade

| ID | Rótulo |
|---|---|
| 1 | Muito baixa |
| 2 | Baixa |
| 3 | Média |
| 4 | Alta |
| 5 | Muito alta |

### Status do problema

| ID | Rótulo |
|---|---|
| 1 | Novo |
| 2 | Aceito |
| 3 | Planejado |
| 4 | Pendente |
| 5 | Solucionado |
| 6 | Fechado |

### Status da mudança

| ID | Rótulo |
|---|---|
| 1 | Novo |
| 2 | Avaliação |
| 3 | Aprovação |
| 4 | Aceito |
| 5 | Pendente |
| 6 | Teste |
| 7 | Qualificação |
| 8 | Aplicado |
| 9 | Revisão |
| 10 | Fechado |
| 11 | Recusado |
| 12 | Cancelado |

## Desenvolvimento

```bash
git clone https://github.com/femanix/glpi-rj-mcp.git
cd glpi-rj-mcp
npm install
npm run build
npm test          # node --test via tsx, fetch simulado
```

Para rodar localmente:

```bash
export GLPI_URL="https://glpi.example.com"
export GLPI_USER_TOKEN="..."
npm start
```

## Licença

MIT

## Links

- [Projeto GLPI](https://glpi-project.org/)
- [Documentação da API do GLPI](https://glpi-user-documentation.readthedocs.io/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [mcp-glpi (projeto em que este se baseia)](https://github.com/GMS64260/mcp-glpi)
