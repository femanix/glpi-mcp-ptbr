/**
 * Tests for the security guards (src/security.ts) and POST no-retry.
 *
 * Run with: npm test
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { mkdtemp, writeFile, symlink, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertItemtype,
  assertSecureUrl,
  envFlag,
  isReadTool,
  resolveUploadPath,
} from '../src/security.js';
import { GlpiHttp } from '../src/http.js';
import { SearchOptionsCache } from '../src/search-options.js';

test('isReadTool separates reads from writes', () => {
  for (const n of ['glpi_list_tickets', 'glpi_get_ticket', 'glpi_search_v2', 'glpi_count', 'glpi_tickets_stats_by']) {
    assert.equal(isReadTool(n), true, n);
  }
  for (const n of ['glpi_delete_ticket', 'glpi_update_ticket', 'glpi_create_ticket', 'glpi_upload_document', 'glpi_set_validation_status']) {
    assert.equal(isReadTool(n), false, n);
  }
});

test('envFlag', () => {
  assert.equal(envFlag('1'), true);
  assert.equal(envFlag('TRUE'), true);
  assert.equal(envFlag('0'), false);
  assert.equal(envFlag(undefined), false);
});

test('assertItemtype accepts class names and rejects path/query tricks', () => {
  assert.equal(assertItemtype('Ticket'), 'Ticket');
  assert.equal(assertItemtype('PluginFieldsContainer'), 'PluginFieldsContainer');
  for (const bad of ['', '../User', 'Ticket/1', 'Ticket?x=1', 'Ticket#a', 'Ticket\\X', 'a.b', 1, undefined]) {
    assert.throws(() => assertItemtype(bad), /invalid itemtype/, String(bad));
  }
});

test('assertSecureUrl requires https except loopback', () => {
  assertSecureUrl('https://glpi.example.com');
  assertSecureUrl('http://localhost:8080');
  assertSecureUrl('http://127.0.0.1');
  assert.throws(() => assertSecureUrl('http://glpi.example.com'), /https/);
  assert.throws(() => assertSecureUrl('ftp://glpi.example.com'), /https/);
  assertSecureUrl('http://glpi.lan', true);
});

test('resolveUploadPath confines reads to the upload dir', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'glpi-up-')));
  const dir = join(base, 'allowed');
  await mkdir(dir);
  await writeFile(join(dir, 'a.txt'), 'hello');
  await writeFile(join(base, 'secret.txt'), 'secret');
  await symlink(join(base, 'secret.txt'), join(dir, 'link.txt'));
  const policy = { dir, maxBytes: 100 };

  assert.equal(await resolveUploadPath(join(dir, 'a.txt'), policy), join(dir, 'a.txt'));
  assert.equal(await resolveUploadPath('a.txt', policy), join(dir, 'a.txt'));
  await assert.rejects(resolveUploadPath(join(base, 'secret.txt'), policy), /outside/);
  await assert.rejects(resolveUploadPath('../secret.txt', policy), /outside/);
  await assert.rejects(resolveUploadPath(join(dir, 'link.txt'), policy), /outside/);
  await assert.rejects(resolveUploadPath(dir, policy), /outside|regular/);
  await assert.rejects(resolveUploadPath('a.txt', { dir, maxBytes: 2 }), /limit/);
  await assert.rejects(resolveUploadPath('a.txt', { maxBytes: 100 }), /disabled/);
});

test('POST is not retried on 5xx or network error', async () => {
  let posts = 0;
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    if (init?.method === 'POST') {
      posts++;
      return new Response('boom', { status: 503 });
    }
    return new Response('{}', { status: 200 });
  });
  const http = new GlpiHttp({ url: 'https://glpi.test', userToken: 'u', maxRetries: 3, retryBaseDelayMs: 1 });
  await assert.rejects(http.request('Ticket', { method: 'POST', json: { input: {} } }));
  assert.equal(posts, 1);
});

test('searchOptions.get refuses a malformed itemtype before any request', async () => {
  const fetchMock = mock.fn(async () => new Response('{}', { status: 200 }));
  // @ts-expect-error overriding global fetch
  global.fetch = fetchMock;
  const http = new GlpiHttp({ url: 'https://glpi.test', userToken: 'u' });
  const cache = new SearchOptionsCache(http);
  await assert.rejects(cache.get('../User'), /invalid itemtype/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('resolveField matches pt-BR labels ignoring case and accents', async () => {
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(async (url: string) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        common: 'Características',
        1: { name: 'Título', table: 'glpi_tickets', field: 'name', uid: 'Ticket.name' },
        12: { name: 'Status', table: 'glpi_tickets', field: 'status', uid: 'Ticket.status' },
        7: { name: 'Categoria', table: 'glpi_itilcategories', field: 'completename', uid: 'Ticket.ITILCategory.completename' },
      }),
      { status: 200 }
    );
  });
  const cache = new SearchOptionsCache(new GlpiHttp({ url: 'https://glpi.test', userToken: 'u' }));
  assert.equal(await cache.resolveField('Ticket', 'titulo'), 1);
  assert.equal(await cache.resolveField('Ticket', 'TÍTULO'), 1);
  assert.equal(await cache.resolveField('Ticket', 'Ticket.status'), 12);
  assert.equal(await cache.resolveField('Ticket', '7'), 7);
  assert.equal(await cache.resolveField('Ticket', 'inexistente'), undefined);
});
