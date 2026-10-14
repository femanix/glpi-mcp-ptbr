/**
 * Teste de fumaça ao vivo contra uma instância real do GLPI.
 *
 * Uso:
 *   npm run smoke              # verificações somente de leitura
 *   npm run smoke -- --write   # também roda o ciclo de escrita (cria chamado de teste -> exclusão lógica)
 *
 * Lê GLPI_URL / GLPI_APP_TOKEN / GLPI_USER_TOKEN (ou GLPI_USERNAME+GLPI_PASSWORD)
 * do ambiente, usando como alternativa um arquivo .env na raiz do repositório.
 */

import { readFileSync } from 'node:fs';
import { GlpiClient } from '../src/glpi-client.js';
import { GlpiError } from '../src/http.js';

// --- carregador de .env mínimo (sem dependência) --------------------------
try {
  const envFile = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  // sem arquivo .env — usa o ambiente
}

const WRITE = process.argv.includes('--write');

const url = process.env.GLPI_URL;
if (!url) {
  console.error('GLPI_URL missing (env or .env)');
  process.exit(1);
}

const client = new GlpiClient({
  url,
  appToken: process.env.GLPI_APP_TOKEN,
  userToken: process.env.GLPI_USER_TOKEN,
  username: process.env.GLPI_USERNAME,
  password: process.env.GLPI_PASSWORD,
  timeoutMs: process.env.GLPI_TIMEOUT_MS ? parseInt(process.env.GLPI_TIMEOUT_MS, 10) : 15000,
});

// --- estrutura de testes ----------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name} (${Date.now() - t0}ms)${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (err) {
    failed++;
    const msg =
      err instanceof GlpiError
        ? `HTTP ${err.status} ${err.glpiCode ?? ''} ${err.glpiMessage ?? err.body.slice(0, 200)}`
        : err instanceof Error
          ? err.message
          : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} (${Date.now() - t0}ms) — ${msg}`);
    return false;
  }
}

// --- principal --------------------------------------------------------------
async function main() {
  console.log(`\nSmoke test against ${url} ${WRITE ? '(read + write cycle)' : '(read-only)'}\n`);

  // ---- sessão ----
  console.log('Session:');
  const sessionOk = await check('initSession', async () => {
    await client.initSession();
  });
  if (!sessionOk) {
    console.error('\nCannot authenticate — aborting.');
    process.exit(1);
  }

  await check('getMyProfiles', async () => {
    const profiles = (await client.getMyProfiles()) as any;
    const list = profiles?.myprofiles ?? profiles;
    const n = Array.isArray(list) ? list.length : Object.keys(list ?? {}).length;
    return `${n} profile(s)`;
  });

  // ---- search options / resolução de campos ----
  console.log('\nSearchOptions cache:');
  await check('searchOptions.get(Ticket)', async () => {
    const cat = await client.searchOptions.get('Ticket');
    if (cat.byId.size < 10) throw new Error(`only ${cat.byId.size} options — suspicious`);
    return `${cat.byId.size} options`;
  });
  await check('resolveField(Ticket, "status") = 12', async () => {
    const id = await client.searchOptions.resolveField('Ticket', 'status');
    if (id === undefined) throw new Error('unresolved');
    return `field_id ${id}`;
  });

  // ---- leitura: chamados ----
  console.log('\nTickets (read):');
  await check('count(Ticket)', async () => {
    const n = await client.search.count('Ticket');
    return `${n} tickets total`;
  });

  let sampleTicketId: number | undefined;
  await check('getTickets(limit 5, DESC)', async () => {
    const tickets = (await client.getTickets({ range: '0-4', order: 'DESC' })) as any[];
    sampleTicketId = tickets[0]?.id;
    return `${tickets.length} rows, latest id=${sampleTicketId ?? 'n/a'}`;
  });

  await check('search Ticket (status<5, forcedisplay, limit 5)', async () => {
    const res = await client.search.search('Ticket', {
      criteria: [{ field: 12, searchtype: 'lessthan', value: 5 }],
      forcedisplay: [2, 1, 12],
      limit: 5,
    });
    if (res.data.length > 5) throw new Error(`limit 5 but got ${res.data.length} rows (range off-by-one?)`);
    return `totalcount=${res.totalcount}, page=${res.data.length}`;
  });

  await check('resolveField via glpi_count path (field "status" by name)', async () => {
    const fieldId = await client.searchOptions.resolveField('Ticket', 'status');
    if (fieldId === undefined) throw new Error('unresolved');
    const n = await client.search.count('Ticket', [
      { field: fieldId, searchtype: 'equals', value: 1 },
    ]);
    return `field_id=${fieldId}, ${n} new tickets`;
  });

  await check('getTicketStats()', async () => {
    const stats = (await client.getTicketStats()) as any;
    return `total=${stats.total ?? JSON.stringify(stats).slice(0, 80)}`;
  });

  if (sampleTicketId !== undefined) {
    await check(`getTicket(${sampleTicketId}) + expand_dropdowns`, async () => {
      const t = (await client.getTicket(sampleTicketId!)) as any;
      return `"${String(t.name).slice(0, 40)}" status=${t.status}`;
    });
    await check(`timeline parts of #${sampleTicketId}`, async () => {
      const [f, ta, s] = await Promise.all([
        client.getTicketFollowups(sampleTicketId!),
        client.getTicketTasks(sampleTicketId!),
        client.getTicketSolutions(sampleTicketId!),
      ]);
      return `${(f as any[]).length} followups, ${(ta as any[]).length} tasks, ${(s as any[]).length} solutions`;
    });
  }

  // ---- leitura: outros domínios ----
  console.log('\nOther domains (read):');
  await check('getUsers(active, limit 5)', async () => {
    const users = (await client.getUsers({ range: '0-4', is_active: true })) as any[];
    return `${users.length} rows`;
  });
  await check('getComputers(limit 5)', async () => {
    const c = (await client.getComputers({ range: '0-4' })) as any[];
    return `${c.length} rows`;
  });
  await check('getGroups(limit 5)', async () => {
    const g = (await client.getGroups({ range: '0-4' })) as any[];
    return `${g.length} rows`;
  });
  await check('getCategories(limit 5)', async () => {
    const cats = (await client.getCategories({ range: '0-4' })) as any[];
    return `${cats.length} rows`;
  });
  await check('getEntities()', async () => {
    const e = (await client.getEntities({ range: '0-4' })) as any[];
    return `${e.length} rows`;
  });

  // ---- ciclo de escrita ----
  if (WRITE) {
    console.log('\nWrite cycle (test ticket):');
    let testId: number | undefined;

    await check('createTicket [MCP-SMOKE]', async () => {
      const created = (await client.createTicket({
        name: `[MCP-SMOKE] test ${new Date().toISOString()}`,
        content: 'Automated smoke test from glpi-rj-mcp. Safe to delete.',
        urgency: 1,
      })) as any;
      testId = created?.id;
      if (!testId) throw new Error(`no id in response: ${JSON.stringify(created).slice(0, 200)}`);
      return `created #${testId}`;
    });

    if (testId) {
      await check('addTicketFollowup', async () => {
        await client.addTicketFollowup(testId!, 'Smoke-test followup.');
      });
      await check('updateTicket (rename)', async () => {
        await client.updateTicket(testId!, { name: `[MCP-SMOKE] renamed ${Date.now()}` } as any);
      });
      await check('followup visible in getTicketFollowups', async () => {
        const f = (await client.getTicketFollowups(testId!)) as any[];
        if (f.length < 1) throw new Error('followup not found');
        return `${f.length} followup(s)`;
      });
      await check('deleteTicket (soft)', async () => {
        await client.deleteTicket(testId!, false);
      });
      await check('ticket flagged is_deleted', async () => {
        const t = (await client.getTicket(testId!)) as any;
        if (!t.is_deleted) throw new Error(`is_deleted=${t.is_deleted}`);
        return `#${testId} in trash`;
      });
    }
  }

  // ---- encerramento ----
  console.log('\nTeardown:');
  await check('killSession', async () => {
    await client.killSession();
  });

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
