/**
 * Proteções compartilhadas pelo servidor MCP e pela camada HTTP.
 *
 * - GLPI_READ_ONLY: esconde e bloqueia toda ferramenta que escreve no GLPI.
 * - GLPI_UPLOAD_DIR: restringe glpi_upload_document a um único diretório.
 * - Validação de itemtype: o itemtype vai parar no caminho da URL.
 * - GLPI_URL precisa ser https (http só para hosts de loopback).
 */

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function envFlag(raw: string | undefined): boolean {
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Modo somente leitura
// ---------------------------------------------------------------------------

/** Ferramentas que só leem do GLPI. Todo o resto é tratado como escrita. */
export function isReadTool(name: string): boolean {
  return /^glpi_(list_|get_|search|count$|tickets_stats)/.test(name);
}

// ---------------------------------------------------------------------------
// Itemtype
// ---------------------------------------------------------------------------

// Itemtypes do GLPI são nomes de classe PHP (ex.: "Ticket", "PluginFieldsContainer").
// Qualquer coisa com `/`, `?`, `#`, `.` ou `\` mudaria o caminho ou a query da requisição.
const ITEMTYPE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function assertItemtype(itemtype: unknown): string {
  if (typeof itemtype !== 'string' || !ITEMTYPE_RE.test(itemtype)) {
    throw new Error(
      'invalid itemtype: only letters, digits and underscore are allowed (e.g. "Ticket")'
    );
  }
  return itemtype;
}

// ---------------------------------------------------------------------------
// GLPI_URL
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Rejeita http puro, a menos que o host seja loopback ou GLPI_ALLOW_INSECURE_HTTP esteja definido. */
export function assertSecureUrl(rawUrl: string, allowInsecure = false): void {
  const url = new URL(rawUrl);
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && (allowInsecure || LOOPBACK_HOSTS.has(url.hostname))) return;
  throw new Error(
    `GLPI_URL must use https:// (got "${url.protocol}//${url.host}"). ` +
      'Set GLPI_ALLOW_INSECURE_HTTP=1 to accept http on a trusted network.'
  );
}

// ---------------------------------------------------------------------------
// Caminho de upload
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface UploadPolicy {
  /** Diretório ao qual os uploads ficam restritos. Indefinido significa uploads desabilitados. */
  dir?: string;
  maxBytes: number;
}

/**
 * Resolve `filePath` dentro do diretório de upload e devolve o caminho real.
 * Symlinks são seguidos antes da checagem de contenção, então um link dentro do
 * diretório não pode apontar para fora dele.
 */
export async function resolveUploadPath(
  filePath: string,
  policy: UploadPolicy
): Promise<string> {
  if (!policy.dir) {
    throw new Error(
      'uploads are disabled: set GLPI_UPLOAD_DIR to the directory files may be uploaded from'
    );
  }
  const root = await realpath(resolve(policy.dir));
  const candidate = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  const real = await realpath(candidate);
  const rel = relative(root, real);
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error('file is outside GLPI_UPLOAD_DIR');
  }
  const info = await stat(real);
  if (!info.isFile()) throw new Error('not a regular file');
  if (info.size > policy.maxBytes) {
    throw new Error(`file is ${info.size} bytes, limit is ${policy.maxBytes} (GLPI_MAX_UPLOAD_BYTES)`);
  }
  return real;
}
