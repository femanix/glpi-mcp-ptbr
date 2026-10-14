/**
 * Camada HTTP unificada para a API REST do GLPI.
 *
 * - Ponto de entrada único `request()` usado por todas as chamadas de domínio.
 * - Reautenticação automática em 401 (session_token expirado).
 * - Erros estruturados com status HTTP, código/mensagem de erro do GLPI e corpo completo.
 * - Retry opcional com backoff exponencial em 5xx.
 */

export interface GlpiHttpConfig {
  url: string;
  appToken?: string;
  userToken?: string;
  username?: string;
  password?: string;
  /** Máximo de tentativas de retry em 5xx (padrão 2). */
  maxRetries?: number;
  /** Backoff inicial em ms (padrão 300). */
  retryBaseDelayMs?: number;
  /** Timeout da requisição em ms (padrão 15000). */
  timeoutMs?: number;
}

export interface GlpiRawError {
  status: number;
  glpiCode?: string;
  glpiMessage?: string;
  body: string;
  url: string;
  method: string;
}

export class GlpiError extends Error {
  readonly status: number;
  readonly glpiCode?: string;
  readonly glpiMessage?: string;
  readonly body: string;
  readonly url: string;
  readonly method: string;

  constructor(raw: GlpiRawError) {
    const detail = raw.glpiCode
      ? `${raw.glpiCode}${raw.glpiMessage ? ': ' + raw.glpiMessage : ''}`
      : raw.body.slice(0, 200);
    super(`GLPI ${raw.method} ${raw.url} -> ${raw.status} (${detail})`);
    this.name = 'GlpiError';
    this.status = raw.status;
    this.glpiCode = raw.glpiCode;
    this.glpiMessage = raw.glpiMessage;
    this.body = raw.body;
    this.url = raw.url;
    this.method = raw.method;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Parâmetros de query, anexados à URL. */
  query?: URLSearchParams | Record<string, string | number | boolean | undefined>;
  /** Corpo JSON, enviado como `Content-Type: application/json`. */
  json?: unknown;
  /** Corpo multipart (upload de arquivos). O Content-Type é definido pelo fetch, com o boundary. */
  form?: FormData;
  /** Pula a abertura/reautenticação automática de sessão (uso interno em initSession/killSession). */
  noSession?: boolean;
  /** Sobrescreve o cabeçalho de autenticação (usado por initSession). */
  authHeader?: string;
  /** Captura os cabeçalhos da resposta no resultado. */
  withHeaders?: boolean;
}

export interface RequestResult<T> {
  data: T;
  headers: Headers;
  status: number;
}

/** Log de depuração no stderr (o stdout é reservado ao transporte stdio do MCP). */
function debugLog(message: string): void {
  if (process.env.GLPI_DEBUG) {
    console.error(`[glpi-http] ${new Date().toISOString()} ${message}`);
  }
}

export class GlpiHttp {
  readonly config: GlpiHttpConfig;
  private sessionToken: string | null = null;

  constructor(config: GlpiHttpConfig) {
    this.config = {
      maxRetries: 2,
      retryBaseDelayMs: 300,
      timeoutMs: 15000,
      ...config,
      url: config.url.replace(/\/$/, ''),
    };
  }

  get session(): string | null {
    return this.sessionToken;
  }

  async initSession(): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.appToken) headers['App-Token'] = this.config.appToken;

    if (this.config.userToken) {
      headers['Authorization'] = `user_token ${this.config.userToken}`;
    } else if (this.config.username && this.config.password) {
      const credentials = Buffer.from(
        `${this.config.username}:${this.config.password}`
      ).toString('base64');
      headers['Authorization'] = `Basic ${credentials}`;
    } else {
      throw new Error(
        'No authentication method provided. Set userToken or username/password.'
      );
    }

    const url = `${this.config.url}/apirest.php/initSession`;
    const response = await this.fetchWithTimeout(url, { method: 'GET', headers });

    if (!response.ok) {
      throw await this.buildError(response, 'GET', url);
    }

    const data = (await response.json()) as { session_token: string };
    this.sessionToken = data.session_token;
    return this.sessionToken;
  }

  async killSession(): Promise<void> {
    if (!this.sessionToken) return;
    try {
      await this.request('killSession', { noSession: false });
    } catch {
      // ignora
    }
    this.sessionToken = null;
  }

  private async ensureSession(): Promise<void> {
    if (!this.sessionToken) await this.initSession();
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    const timeoutMs = this.config.timeoutMs ?? 15000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeoutId);
      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
      }
      throw err;
    }
  }

  /**
   * Requisição unificada ao GLPI.
   * - `path` é anexado a `{baseUrl}/apirest.php/`. NÃO faça URL-encode antes.
   */
  async request<T = unknown>(
    path: string,
    options: RequestOptions = {}
  ): Promise<RequestResult<T>> {
    const method = options.method ?? 'GET';

    if (!options.noSession) await this.ensureSession();

    const headers: Record<string, string> = {};
    // Em multipart, o próprio fetch define o Content-Type (com o boundary).
    if (!options.form) headers['Content-Type'] = 'application/json';
    if (this.config.appToken) headers['App-Token'] = this.config.appToken;
    if (this.sessionToken && !options.authHeader) {
      headers['Session-Token'] = this.sessionToken;
    }
    if (options.authHeader) headers['Authorization'] = options.authHeader;

    const queryString = this.buildQuery(options.query);
    const fullUrl = `${this.config.url}/apirest.php/${path}${queryString ? '?' + queryString : ''}`;

    const init: RequestInit = { method, headers };
    if (options.form) init.body = options.form;
    else if (options.json !== undefined) init.body = JSON.stringify(options.json);

    // POST não é idempotente: repetir uma requisição que pode ter chegado ao GLPI
    // duplicaria chamados, acompanhamentos e envios de arquivo.
    const maxRetries = this.config.maxRetries ?? 2;
    const retryable = method !== 'POST';
    const baseDelay = this.config.retryBaseDelayMs ?? 300;
    let attempt = 0;
    let lastError: GlpiError | undefined;
    let reauthAttempted = false;

    while (attempt <= maxRetries) {
      let response: Response;
      try {
        response = await this.fetchWithTimeout(fullUrl, init);
      } catch (err) {
        // Erro de rede ou timeout -> retry com backoff.
        if (retryable && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt);
          debugLog(`${method} ${path} network error (${err instanceof Error ? err.message : err}), retry in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          attempt++;
          continue;
        }
        throw err;
      }

      if (response.ok) {
        const data = await this.parseBody<T>(response);
        return { data, headers: response.headers, status: response.status };
      }

      // 401 -> a sessão provavelmente expirou. Reautentica uma vez e repete uma vez.
      if (response.status === 401 && !reauthAttempted && !options.noSession) {
        reauthAttempted = true;
        this.sessionToken = null;
        debugLog(`${method} ${path} -> 401, re-authenticating`);
        await this.initSession();
        if (this.sessionToken) headers['Session-Token'] = this.sessionToken;
        continue;
      }

      // 429 -> respeita o cabeçalho Retry-After se existir; senão, backoff exponencial.
      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = retryAfter > 0 ? retryAfter * 1000 : baseDelay * Math.pow(2, attempt);
        debugLog(`${method} ${path} -> 429 rate-limited, retry in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        attempt++;
        continue;
      }

      // 5xx -> retry com backoff exponencial.
      if (response.status >= 500 && retryable && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        debugLog(`${method} ${path} -> ${response.status}, retry in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        attempt++;
        continue;
      }

      lastError = await this.buildError(response, method, fullUrl);
      throw lastError;
    }

    throw lastError ?? new Error('Unreachable');
  }

  private async parseBody<T>(response: Response): Promise<T> {
    const text = await response.text();
    if (!text) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  private async buildError(
    response: Response,
    method: string,
    url: string
  ): Promise<GlpiError> {
    const body = await response.text();
    let glpiCode: string | undefined;
    let glpiMessage: string | undefined;
    try {
      const parsed = JSON.parse(body);
      // O GLPI devolve erros como ["CODIGO_DO_ERRO", "mensagem"]
      if (Array.isArray(parsed) && parsed.length >= 1 && typeof parsed[0] === 'string') {
        glpiCode = parsed[0];
        glpiMessage = typeof parsed[1] === 'string' ? parsed[1] : undefined;
      }
    } catch {
      // o corpo não é JSON; deixa glpiCode/glpiMessage indefinidos
    }
    return new GlpiError({
      status: response.status,
      glpiCode,
      glpiMessage,
      body,
      url,
      method,
    });
  }

  private buildQuery(
    query: RequestOptions['query']
  ): string {
    if (!query) return '';
    if (query instanceof URLSearchParams) return query.toString();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.append(key, String(value));
    }
    return params.toString();
  }
}
