/**
 * Testes do GlpiSearch (montagem do range) e do SearchOptionsCache (resolução
 * de campos numa instância traduzida).
 *
 * Cobertura de regressão de dois bugs encontrados num GLPI 11 real (em francês):
 *   - search() passava `limit` como FIM do range: limit 5 -> "0-5" -> 6 linhas.
 *   - resolveField() só casava rótulos traduzidos ("Statut"), nunca o nome da
 *     coluna independente de idioma ("status") nem o uid canônico.
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { GlpiHttp } from '../src/http.js';
import { GlpiSearch } from '../src/search.js';
import { SearchOptionsCache } from '../src/search-options.js';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function installFetch(handler: FetchHandler) {
  // @ts-expect-error substitui o fetch global
  global.fetch = mock.fn(handler);
}

function authedHttp(): GlpiHttp {
  return new GlpiHttp({ url: 'https://glpi.test', userToken: 'u' });
}

test('search() builds an inclusive range: limit 5 -> range=0-4', async () => {
  let capturedRange = '';
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    capturedRange = new URL(url).searchParams.get('range') ?? '';
    return new Response(JSON.stringify({ totalcount: 100, count: 5, data: [1, 2, 3, 4, 5] }), { status: 200 });
  });

  const search = new GlpiSearch(authedHttp());
  await search.search('Ticket', { limit: 5 });
  assert.equal(capturedRange, '0-4');

  await search.search('Ticket', { start: 10, limit: 20 });
  assert.equal(capturedRange, '10-29');
});

test('count() probes with range=0-0 and returns totalcount', async () => {
  let capturedRange = '';
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    capturedRange = new URL(url).searchParams.get('range') ?? '';
    return new Response(JSON.stringify({ totalcount: 1803, count: 1, data: [{}] }), { status: 200 });
  });

  const search = new GlpiSearch(authedHttp());
  const n = await search.count('Ticket');
  assert.equal(n, 1803);
  assert.equal(capturedRange, '0-0');
});

// Catálogo no formato de uma instância real do GLPI 11 em francês (rótulos traduzidos,
// field/uid independentes de idioma, coluna "name" duplicada por tabelas juntadas).
const FRENCH_TICKET_OPTIONS = {
  '1': { name: 'Titre', table: 'glpi_tickets', field: 'name', uid: 'Ticket.name', datatype: 'itemlink' },
  '2': { name: 'ID', table: 'glpi_tickets', field: 'id', uid: 'Ticket.id', datatype: 'number' },
  '4': { name: 'Demandeur', table: 'glpi_users', field: 'name', uid: 'Ticket.Ticket_User.User.name', datatype: 'dropdown' },
  '12': { name: 'Statut', table: 'glpi_tickets', field: 'status', uid: 'Ticket.status', datatype: 'specific' },
  common: 'metadata entry to be skipped',
};

function installCatalogueFetch() {
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    assert.match(url, /listSearchOptions\/Ticket/);
    return new Response(JSON.stringify(FRENCH_TICKET_OPTIONS), { status: 200 });
  });
}

test('resolveField works on a localized (French) instance', async () => {
  installCatalogueFetch();
  const cache = new SearchOptionsCache(authedHttp());

  // Nome de coluna independente de idioma — o caso que falhava ao vivo.
  assert.equal(await cache.resolveField('Ticket', 'status'), 12);
  // O rótulo traduzido continua funcionando.
  assert.equal(await cache.resolveField('Ticket', 'Statut'), 12);
  // uid explícito.
  assert.equal(await cache.resolveField('Ticket', 'Ticket.status'), 12);
  // Número repassado como está.
  assert.equal(await cache.resolveField('Ticket', 12), 12);
  assert.equal(await cache.resolveField('Ticket', '12'), 12);
  // Desconhecido continua indefinido.
  assert.equal(await cache.resolveField('Ticket', 'does_not_exist'), undefined);
});

test('resolveField prefers the own-table option on column-name collisions', async () => {
  installCatalogueFetch();
  const cache = new SearchOptionsCache(authedHttp());

  // "name" existe em glpi_tickets (id 1, uid canônico Ticket.name) E em
  // glpi_users pelo join de requerente (id 4). A da própria tabela deve vencer.
  assert.equal(await cache.resolveField('Ticket', 'name'), 1);
});
