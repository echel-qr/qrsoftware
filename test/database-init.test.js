const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { PGlite } = require('@electric-sql/pglite');
const { APP_TABLES, protectAppTables } = require('../deployment');
const { BRAND_DEFAULTS } = require('../site-branding');
const source = fs.readFileSync(require.resolve('../server'), 'utf8');
const init = source.slice(source.indexOf('async function initDB()'), source.indexOf('async function getSetupFeeAmount()'));
test('fresh database boots, seeds Echel, blocks browser-role access and boots again', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
    const pool = { query: (sql, params) => params ? db.query(sql, params) : db.exec(sql).then(results => results.at(-1)) };
    const ctx = vm.createContext({ pool, protectAppTables, BRAND_DEFAULTS, SETUP_FEE_AMOUNT: 499, SETUP_ACTUAL_PRICE: 999, hashPassword: () => { throw new Error('A fresh DB must contain no legacy users.'); }, console });
    vm.runInContext(init, ctx);
    await ctx.initDB();
    const rows = (await db.query("SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'")).rows;
    assert.deepEqual(rows.map(r => r.tablename).sort(), [...APP_TABLES].sort());
    assert.ok(rows.every(r => r.rowsecurity));
    assert.equal((await db.query("SELECT value FROM system_settings WHERE key='homepage_config'")).rows[0].value, JSON.stringify(BRAND_DEFAULTS));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM shops')).rows[0].n, 0);
    await db.exec('SET ROLE anon');
    await assert.rejects(db.query('SELECT * FROM shops'), /permission denied/);
    await db.exec('RESET ROLE');
    await ctx.initDB();
  } finally { await db.close(); }
});
test('database initialization errors reject startup instead of serving a broken app', async () => {
  const ctx = vm.createContext({ pool: { query: async () => { throw new Error('database unavailable'); } }, console: { error() {} } });
  vm.runInContext(init, ctx);
  await assert.rejects(ctx.initDB(), /database unavailable/);
  assert.doesNotMatch(source.slice(source.lastIndexOf("app.get('/healthz'")), /autoMigrateIfEmpty/);
});
