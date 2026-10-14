/**
 * Busca, contagem e fetch_all de alto nível sobre o endpoint /search/{itemtype} do GLPI.
 *
 * Recursos:
 *   - Múltiplos critérios com operador link (AND / OR / AND NOT / OR NOT).
 *   - forcedisplay (escolhe as colunas devolvidas).
 *   - Lê totalcount + o cabeçalho Content-Range.
 *   - fetch_all: pagina até alcançar o totalcount, limitado por maxRows.
 *   - sort + order opcionais.
 */

import { GlpiHttp } from './http.js';
import { assertItemtype } from './security.js';

export type SearchType =
  | 'contains'
  | 'notcontains'
  | 'equals'
  | 'notequals'
  | 'lessthan'
  | 'morethan'
  | 'under'
  | 'notunder'
  | 'empty'
  | 'notempty';

export type SearchLink = 'AND' | 'OR' | 'AND NOT' | 'OR NOT';

export interface SearchCriterion {
  field: number;
  searchtype: SearchType;
  value: string | number | boolean;
  /** Operador de combinação com o critério anterior. Ignorado no primeiro. */
  link?: SearchLink;
}

export interface SearchOptions {
  criteria?: SearchCriterion[];
  /** Lista de field_id a devolver; se indefinida, o GLPI usa o padrão dele. */
  forcedisplay?: number[];
  /** Primeira linha (índice 0). */
  start?: number;
  /** Máximo de linhas desta chamada. */
  limit?: number;
  /** Ordena por field_id (id da search option). */
  sort?: number;
  order?: 'ASC' | 'DESC';
  /** Se true, pagina até alcançar o totalcount (ou atingir maxRows). */
  fetchAll?: boolean;
  /** Limite de segurança quando fetchAll=true (padrão 1000). */
  maxRows?: number;
  /** Passe `expand_dropdowns=true` para receber os rótulos resolvidos. */
  expandDropdowns?: boolean;
  /** Passe `giveItems=true` para receber os itens brutos. */
  giveItems?: boolean;
}

export interface SearchResponse<T = Record<string, unknown>> {
  itemtype: string;
  totalcount: number;
  count: number;
  start: number;
  data: T[];
  /** Valor bruto do cabeçalho Content-Range, se presente. */
  contentRange?: string;
}

const DEFAULT_PAGE = 100;
const DEFAULT_MAX_ROWS = 1000;

export class GlpiSearch {
  constructor(private http: GlpiHttp) {}

  /**
   * Executa uma busca (página única ou laço de fetch_all).
   */
  async search<T = Record<string, unknown>>(
    itemtype: string,
    options: SearchOptions = {}
  ): Promise<SearchResponse<T>> {
    if (options.fetchAll) return this.fetchAll<T>(itemtype, options);

    const start = options.start ?? 0;
    const limit = options.limit ?? DEFAULT_PAGE;
    // Os intervalos do GLPI são inclusivos: "0-4" devolve 5 linhas.
    return this.fetchPage<T>(itemtype, options, start, start + Math.max(1, limit) - 1);
  }

  /**
   * Devolve só o totalcount dos critérios dados. Sonda barata (range=0-0).
   */
  async count(
    itemtype: string,
    criteria: SearchCriterion[] = []
  ): Promise<number> {
    const res = await this.fetchPage(itemtype, { criteria }, 0, 0);
    return res.totalcount;
  }

  private async fetchPage<T>(
    itemtype: string,
    options: SearchOptions,
    start: number,
    end: number
  ): Promise<SearchResponse<T>> {
    assertItemtype(itemtype);
    const params = new URLSearchParams();

    (options.criteria ?? []).forEach((c, i) => {
      params.append(`criteria[${i}][field]`, String(c.field));
      params.append(`criteria[${i}][searchtype]`, c.searchtype);
      params.append(`criteria[${i}][value]`, String(c.value));
      if (i > 0 && c.link) params.append(`criteria[${i}][link]`, c.link);
    });

    (options.forcedisplay ?? []).forEach((id, i) => {
      params.append(`forcedisplay[${i}]`, String(id));
    });

    params.append('range', `${start}-${end}`);
    if (options.sort !== undefined) params.append('sort', String(options.sort));
    if (options.order) params.append('order', options.order);
    if (options.expandDropdowns) params.append('expand_dropdowns', 'true');
    if (options.giveItems) params.append('giveItems', 'true');

    const { data, headers } = await this.http.request<{
      totalcount?: number;
      count?: number;
      data?: T[];
    }>(`search/${itemtype}`, { query: params });

    const contentRange = headers.get('content-range') ?? undefined;
    let totalcount = data.totalcount ?? 0;
    if (!totalcount && contentRange) {
      // Formato: "início-fim/total"
      const match = contentRange.match(/\/(\d+)$/);
      if (match) totalcount = parseInt(match[1], 10);
    }

    return {
      itemtype,
      totalcount,
      count: data.count ?? (data.data?.length ?? 0),
      start,
      data: data.data ?? [],
      contentRange,
    };
  }

  private async fetchAll<T>(
    itemtype: string,
    options: SearchOptions
  ): Promise<SearchResponse<T>> {
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    const pageSize = options.limit ?? DEFAULT_PAGE;
    let cursor = options.start ?? 0;
    const collected: T[] = [];
    let totalcount = 0;
    let contentRange: string | undefined;

    while (collected.length < maxRows) {
      const remaining = maxRows - collected.length;
      const thisPage = Math.min(pageSize, remaining);
      const end = cursor + thisPage - 1;

      const page = await this.fetchPage<T>(itemtype, options, cursor, end);
      totalcount = page.totalcount;
      contentRange = page.contentRange;

      collected.push(...page.data);
      cursor += page.data.length;

      if (page.data.length === 0) break;
      if (totalcount && cursor >= totalcount) break;
    }

    return {
      itemtype,
      totalcount,
      count: collected.length,
      start: options.start ?? 0,
      data: collected,
      contentRange,
    };
  }
}
