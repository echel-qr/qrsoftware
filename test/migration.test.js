const test = require('node:test'), assert = require('node:assert/strict');
const { envReport, missingRequired, readDump, planRestore, insertBatch, MIGRATION_ENV } = require('../migration');

test('the settings report names what the new host needs and never reads a value', () => {
  const env = { DATABASE_URL: 'postgresql://localhost/echel', JWT_SECRET: 'x'.repeat(40), BASE_URL: 'https://echel.in', SUPER_ADMIN_ID: 'admin', SUPER_ADMIN_PASSWORD: '  ' };
  const report = envReport(env);
  const find = name => report.find(r => r.name === name);
  assert.equal(find('DATABASE_URL').set, true);
  assert.equal(find('JWT_SECRET').set, true);
  // A setting that is only spaces is not set.
  assert.equal(find('SUPER_ADMIN_PASSWORD').set, false);
  assert.equal(find('CLOUDINARY_API_SECRET').set, false);
  // Every entry says what it is for, and no entry carries a value.
  for (const row of report) {
    assert.ok(row.what.length > 10, row.name + ' must explain itself');
    assert.deepEqual(Object.keys(row).sort(), ['copyFromOldHost', 'name', 'required', 'set', 'what']);
  }
  assert.deepEqual(missingRequired(env), ['SUPER_ADMIN_PASSWORD', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']);
  // The database address is the one setting that must NOT be carried across.
  assert.equal(MIGRATION_ENV.find(e => e.name === 'DATABASE_URL').copy, undefined);
  assert.equal(MIGRATION_ENV.find(e => e.name === 'JWT_SECRET').copy, true);
});

test('a backup file is described before anything is written', () => {
  const dump = { version: 2, taken_at: '2026-09-23T10:00:00.000Z', from: 'https://echel.in',
    tables: { shops: [{ id: 'SHOP_A' }, { id: 'SHOP_B' }], print_jobs: [], security_events: { error: 'permission denied' } } };
  const read = readDump(dump);
  assert.equal(read.totalRows, 2);
  assert.deepEqual(read.tables, ['shops', 'print_jobs']);
  assert.deepEqual(read.unreadable, ['security_events']);
  assert.equal(read.from, 'https://echel.in');
  // A file written before the manifest existed still restores.
  assert.equal(readDump({ tables: { shops: [] } }).version, 1);
  for (const bad of [null, 'text', [], {}, { tables: [] }, { tables: {} }])
    assert.throws(() => readDump(bad), /backup|empty/i);
});

test('a backup from an older build still fits this version of the tables', () => {
  const dump = { tables: {
    shops: [{ id: 'SHOP_A', name: 'Preview', removed_column: 'x' }],
    reviews: [{ id: 1, text: 'good' }],
    gone_table: [{ id: 1 }]
  } };
  const columns = {
    shops: new Set(['id', 'name', 'added_later']),
    reviews: new Set(['id', 'text']),
    print_jobs: new Set(['id'])
  };
  const plan = planRestore(dump, columns);
  const shops = plan.plan.find(p => p.table === 'shops');
  // A column this version dropped is left out; one it added keeps its default.
  assert.deepEqual(shops.columns.sort(), ['id', 'name']);
  assert.deepEqual(shops.columnsNotHere, ['removed_column']);
  // A table this version no longer has is reported, not silently ignored.
  assert.deepEqual(plan.skippedTables, ['gone_table']);
  assert.deepEqual(plan.plan.map(p => p.table), ['shops', 'reviews']);
});

test('rows are written in batches, with every value as a parameter', () => {
  const { text, values } = insertBatch('shops', ['id', 'name'], [{ id: 'A', name: "O'Brien" }, { id: 'B' }]);
  assert.equal(text, 'INSERT INTO "shops" ("id","name") VALUES ($1,$2),($3,$4) ON CONFLICT DO NOTHING');
  // A column missing from a row becomes NULL, and nothing is ever concatenated
  // into the statement — a shop name with a quote in it cannot break it.
  assert.deepEqual(values, ['A', "O'Brien", 'B', null]);
});
