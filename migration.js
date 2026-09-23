'use strict';
/*
 * migration.js — moving Echel to another host without losing anything.
 *
 * The service is an ordinary Node + PostgreSQL application, so it runs on any
 * host that offers both: a Hostinger VPS, another cloud, or a machine in the
 * shop's own office. Moving it is three steps, and Superadmin → Database has a
 * button for each one:
 *
 *   1. report   what this server runs on, and what the new one still needs
 *   2. backup   every row of every table in one file
 *   3. import   that file into the new server's database
 *
 * Uploaded documents are NOT in that file. They live in Cloudinary and keep
 * working from the new host the moment the same Cloudinary keys are set there.
 *
 * This file holds only the decisions — which settings must travel, which rows
 * fit which columns. server.js does the talking to the database, so the rules
 * can be tested on their own.
 */

/** Every setting the new host needs, in the order it should be filled in. */
const MIGRATION_ENV = [
  { name: 'DATABASE_URL', required: true,
    what: 'Where PostgreSQL is. The new host gets its own — this is the one setting that must NOT be copied.' },
  { name: 'JWT_SECRET', required: true, copy: true,
    what: 'Signs every sign-in. Copy it across or every shop and admin is signed out.' },
  { name: 'SUPER_ADMIN_ID', required: true, copy: true, what: 'The super admin sign-in name.' },
  { name: 'SUPER_ADMIN_PASSWORD', required: true, copy: true, what: 'The super admin password.' },
  { name: 'BASE_URL', required: true,
    what: 'The address visitors use, such as https://echel.in. It is in every QR code, so keep the domain and only move where it points.' },
  { name: 'CLOUDINARY_CLOUD_NAME', required: true, copy: true, what: 'Where uploaded documents are stored.' },
  { name: 'CLOUDINARY_API_KEY', required: true, copy: true, what: 'Reads and writes those documents.' },
  { name: 'CLOUDINARY_API_SECRET', required: true, copy: true, what: 'The secret half of that key.' },
  { name: 'OWNER_RAZORPAY_KEY_ID', required: false, copy: true, what: 'Collects the setup fee and the White Label licence fee.' },
  { name: 'OWNER_RAZORPAY_KEY_SECRET', required: false, copy: true, what: 'The secret half of that key.' },
  { name: 'RAZORPAY_WEBHOOK_SECRET', required: false, copy: true, what: 'Confirms a payment even when the browser closes early.' },
  { name: 'TURNSTILE_SITE_KEY', required: false, copy: true, what: 'The sign-up captcha.' },
  { name: 'TURNSTILE_SECRET_KEY', required: false, copy: true, what: 'The secret half of the captcha.' },
  { name: 'PRIMARY_HOST', required: false, what: 'Sends www and other names to the one real address.' },
  { name: 'SITE_URL', required: false, what: 'Only when the public address differs from BASE_URL.' },
  { name: 'PORT', required: false, what: 'The port the server listens on. A VPS usually puts Nginx in front of it.' },
  { name: 'NODE_ENV', required: false, what: 'Set it to production on the new host.' }
];

/** Which settings are present — names only. A value is never read or returned. */
function envReport(env) {
  return MIGRATION_ENV.map(item => ({
    name: item.name,
    what: item.what,
    required: !!item.required,
    copyFromOldHost: !!item.copy,
    set: typeof env[item.name] === 'string' && env[item.name].trim() !== ''
  }));
}

/** The settings that must be filled in before the new host can serve anyone. */
function missingRequired(env) {
  return envReport(env).filter(item => item.required && !item.set).map(item => item.name);
}

const DUMP_VERSION = 2;

/**
 * Describe a backup file without touching a database.
 * A file written before this version has no manifest; it is still valid, so
 * only `tables` is required.
 */
function readDump(dump) {
  if (!dump || typeof dump !== 'object' || Array.isArray(dump))
    throw new Error('This is not a backup file.');
  const tables = dump.tables;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables))
    throw new Error('The backup file has no tables in it.');
  const names = Object.keys(tables);
  if (!names.length) throw new Error('The backup file is empty.');
  const counts = {}, unreadable = [];
  for (const name of names) {
    const rows = tables[name];
    // A table the old server could not read was written as { error }.
    if (Array.isArray(rows)) counts[name] = rows.length;
    else unreadable.push(name);
  }
  return {
    version: dump.version || 1,
    takenAt: dump.taken_at || null,
    from: dump.from || null,
    tables: names.filter(n => Array.isArray(tables[n])),
    counts,
    unreadable,
    totalRows: Object.values(counts).reduce((sum, n) => sum + n, 0)
  };
}

/**
 * Match a backup against the tables this server actually has.
 *
 * `columnsByTable` is { table: Set(column) } read from the target database.
 * A column the backup has and this version dropped is left out, and a column
 * this version added keeps its default — so a backup taken from an older
 * build still restores.
 */
function planRestore(dump, columnsByTable) {
  const read = readDump(dump);
  const plan = [], skippedTables = [];
  for (const name of read.tables) {
    const columns = columnsByTable[name];
    if (!columns || !columns.size) { skippedTables.push(name); continue; }
    const rows = dump.tables[name];
    const used = new Set(), dropped = new Set();
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      for (const key of Object.keys(row)) (columns.has(key) ? used : dropped).add(key);
    }
    plan.push({
      table: name,
      rows: rows.length,
      columns: [...used],
      columnsNotHere: [...dropped]
    });
  }
  return { ...read, plan, skippedTables };
}

/** One INSERT for a batch of rows: the statement text and its values. */
function insertBatch(table, columns, rows) {
  const values = [];
  const tuples = rows.map(row => {
    const slots = columns.map(column => {
      values.push(row[column] === undefined ? null : row[column]);
      return '$' + values.length;
    });
    return '(' + slots.join(',') + ')';
  });
  const names = columns.map(c => '"' + c + '"').join(',');
  return {
    text: `INSERT INTO "${table}" (${names}) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`,
    values
  };
}

module.exports = {
  MIGRATION_ENV, envReport, missingRequired,
  DUMP_VERSION, readDump, planRestore, insertBatch
};
