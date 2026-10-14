/**
 * Cache de SearchOptions + auxiliares.
 *
 * O GLPI expõe `/listSearchOptions/{itemtype}`, que devolve o catálogo de campos
 * pesquisáveis de um itemtype. Cada entrada é indexada por um field_id numérico
 * e traz metadados legíveis (name, table, datatype, available_searchtypes).
 *
 * O catálogo fica em cache por itemtype (TTL configurável, padrão 1h) para que:
 *   - as ferramentas de alto nível traduzam nomes amigáveis de parâmetro → field_id dos critérios
 *   - as respostas de list/search possam ser enriquecidas com rótulos de campo
 */

import { GlpiHttp } from './http.js';
import { assertItemtype } from './security.js';

export interface SearchOption {
  id: number;
  name: string;
  table?: string;
  field?: string;
  datatype?: string;
  uid?: string;
  available_searchtypes?: string[];
  /** Entrada bruta do GLPI, guardada para depuração / casos avançados. */
  raw: Record<string, unknown>;
}

export interface SearchOptionsCatalogue {
  itemtype: string;
  fetchedAt: number;
  byId: Map<number, SearchOption>;
  byUid: Map<string, SearchOption>;
  byName: Map<string, SearchOption>;
  /** Indexado pelo nome bruto da coluna SQL (independe do idioma). Opções da própria tabela vencem colisões. */
  byField: Map<string, SearchOption>;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hora

/** Chave sem distinção de caixa e acento: "titulo" casa com o rótulo pt-BR "Título". */
export function normalizeName(name: string): string {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export class SearchOptionsCache {
  private cache: Map<string, SearchOptionsCatalogue> = new Map();
  private ttlMs: number;

  constructor(private http: GlpiHttp, ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  async get(itemtype: string): Promise<SearchOptionsCatalogue> {
    assertItemtype(itemtype);
    const cached = this.cache.get(itemtype);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) return cached;

    const { data } = await this.http.request<Record<string, unknown>>(
      `listSearchOptions/${itemtype}`
    );

    const catalogue = this.parse(itemtype, data);
    this.cache.set(itemtype, catalogue);
    return catalogue;
  }

  /** Invalida o cache de um itemtype, ou de todos se não houver argumento. */
  invalidate(itemtype?: string) {
    if (itemtype) this.cache.delete(itemtype);
    else this.cache.clear();
  }

  /**
   * Resolve um nome amigável para um field_id.
   *
   * Ordem de busca (da mais precisa para a menos precisa):
   *   1. id numérico repassado como está
   *   2. uid explícito ("Ticket.status")
   *   3. uid canônico da própria tabela, montado como "{itemtype}.{ref}" — independe do idioma
   *   4. rótulo traduzido, ignorando caixa e acentos ("Título", "Status", ...)
   *   5. nome bruto da coluna SQL ("status") — alternativa que independe do idioma
   */
  async resolveField(itemtype: string, ref: string | number): Promise<number | undefined> {
    if (typeof ref === 'number') return ref;
    if (/^\d+$/.test(ref)) return parseInt(ref, 10);

    const cat = await this.get(itemtype);
    const direct =
      cat.byUid.get(ref) ??
      cat.byUid.get(`${itemtype}.${ref}`) ??
      cat.byName.get(normalizeName(ref)) ??
      cat.byField.get(ref.toLowerCase());
    return direct?.id;
  }

  private parse(itemtype: string, data: Record<string, unknown>): SearchOptionsCatalogue {
    const byId = new Map<number, SearchOption>();
    const byUid = new Map<string, SearchOption>();
    const byName = new Map<string, SearchOption>();
    const byField = new Map<string, SearchOption>();

    for (const [key, value] of Object.entries(data)) {
      const id = parseInt(key, 10);
      if (Number.isNaN(id)) continue; // ignora entradas de metadados como "common"
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;

      const option: SearchOption = {
        id,
        name: typeof entry.name === 'string' ? entry.name : String(id),
        table: typeof entry.table === 'string' ? entry.table : undefined,
        field: typeof entry.field === 'string' ? entry.field : undefined,
        datatype: typeof entry.datatype === 'string' ? entry.datatype : undefined,
        uid: typeof entry.uid === 'string' ? entry.uid : undefined,
        available_searchtypes: Array.isArray(entry.available_searchtypes)
          ? (entry.available_searchtypes as string[])
          : undefined,
        raw: entry,
      };

      byId.set(id, option);
      if (option.uid && !byUid.has(option.uid)) byUid.set(option.uid, option);
      if (option.name && !byName.has(normalizeName(option.name))) {
        byName.set(normalizeName(option.name), option);
      }
      // O mesmo nome de coluna pode aparecer em tabelas juntadas (ex.: "name" em
      // glpi_tickets E em glpi_users, para requerente/técnico). A opção cujo uid
      // é exatamente "{itemtype}.{field}" (tabela própria) sempre vence.
      if (option.field) {
        const fieldKey = option.field.toLowerCase();
        const isCanonical = option.uid === `${itemtype}.${option.field}`;
        if (isCanonical || !byField.has(fieldKey)) byField.set(fieldKey, option);
      }
    }

    return { itemtype, fetchedAt: Date.now(), byId, byUid, byName, byField };
  }
}
