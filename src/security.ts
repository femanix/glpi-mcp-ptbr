/**
 * Security guards shared by the MCP server and the HTTP layer.
 *
 * - GLPI_READ_ONLY: hide and block every tool that writes to GLPI.
 * - GLPI_UPLOAD_DIR: confine glpi_upload_document to one directory.
 * - Itemtype validation: itemtype ends up in the URL path.
 * - GLPI_URL must be https (http only for loopback hosts).
 */

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function envFlag(raw: string | undefined): boolean {
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Read-only mode
// ---------------------------------------------------------------------------

/** Tools that only read from GLPI. Everything else is treated as a write. */
export function isReadTool(name: string): boolean {
  return /^glpi_(list_|get_|search|count$|tickets_stats)/.test(name);
}

// ---------------------------------------------------------------------------
// Itemtype
// ---------------------------------------------------------------------------

// GLPI itemtypes are PHP class names (e.g. "Ticket", "PluginFieldsContainer").
// Anything with `/`, `?`, `#`, `.` or `\` would change the request path or query.
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

/** Reject plain http unless the host is loopback or GLPI_ALLOW_INSECURE_HTTP is set. */
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
// Upload path
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface UploadPolicy {
  /** Directory uploads are confined to. Undefined means uploads are disabled. */
  dir?: string;
  maxBytes: number;
}

/**
 * Resolve `filePath` inside the upload directory and return its real path.
 * Symlinks are followed before the containment check, so a link inside the
 * directory cannot point outside it.
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
