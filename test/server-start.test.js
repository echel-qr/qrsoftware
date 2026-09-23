const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { createRequire } = require('node:module');
const { PGlite } = require('@electric-sql/pglite');
const express = require('express');
test('complete backend boots on an empty PostgreSQL database and serves authenticated configuration', { timeout: 90000 }, async () => {
  const db = new PGlite(), root = path.resolve(__dirname, '..'), app = express();
  const localRequire = createRequire(path.join(root, 'server.js'));
  const env = { NODE_ENV: 'test', PORT: '0', BASE_URL: 'http://127.0.0.1', DATABASE_URL: 'postgresql://localhost/echel_test', JWT_SECRET: 'local-fixture-secret-not-for-production', SUPER_ADMIN_ID: 'fixture-admin', SUPER_ADMIN_PASSWORD: 'local-test-password', CAPTCHA_OFF: '1' };
  let server, readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const originalListen = app.listen.bind(app);
  app.listen = (port, callback) => { server = originalListen(0, '127.0.0.1', () => { callback(); readyResolve(); }); return server; };
  class Pool {
    on() {}
    query(sql, params) { return params ? db.query(sql, params) : db.exec(sql).then(r => r.at(-1)); }
    // A route that needs a transaction takes a client out of the pool. This
    // engine is one connection, so the client is the pool itself.
    connect() { return Promise.resolve({ query: this.query.bind(this), release() {} }); }
    end() { return Promise.resolve(); }
  }
  const deployment = localRequire('./deployment');
  const fixtureRequire = name => {
    if (name === 'pg') return { Pool, types: { setTypeParser() {} } };
    if (name === 'express') return Object.assign(() => app, express);
    if (name === 'dotenv') return { config() {} };
    if (name === './deployment') return { ...deployment, deploymentConfig: () => deployment.deploymentConfig(env), databaseOptions: () => deployment.databaseOptions(env) };
    return localRequire(name);
  };
  const context = vm.createContext({ require: fixtureRequire, __dirname: root, __filename: path.join(root, 'server.js'), console, Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setInterval: () => ({ unref() {} }), clearInterval() {}, process: { env, version: process.version, platform: process.platform, uptime: () => 1, exit: code => readyReject(new Error('Backend startup exited: ' + code)) } });
  try {
    vm.runInContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), context);
    await ready;
    const base = 'http://127.0.0.1:' + server.address().port;
    let response = await fetch(base + '/healthz'); assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
    response = await fetch(base + '/api/homepage-config'); assert.equal((await response.json()).brandName, 'Echel');
    response = await fetch(base + '/api/superadmin/overview'); assert.equal(response.status, 401);
    response = await fetch(base + '/api/superadmin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminId: env.SUPER_ADMIN_ID, password: env.SUPER_ADMIN_PASSWORD }) });
    assert.equal(response.status, 200); const { token } = await response.json(); assert.ok(token);
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    response = await fetch(base + '/api/superadmin/overview', { headers }); assert.equal(response.status, 200, await response.text());
    response = await fetch(base + '/api/superadmin/homepage-config', { method: 'PUT', headers, body: JSON.stringify({ supportPhone: '7011482679', tagline: 'A tested Echel workspace' }) });
    assert.equal(response.status, 200);
    response = await fetch(base + '/api/homepage-config'); assert.equal((await response.json()).tagline, 'A tested Echel workspace');
    response = await fetch(base + '/api/superadmin/migrate-db', { method: 'POST', headers, body: '{}' }); assert.equal(response.status, 404);
    // The White Label programme: the partner page, the partner's dashboard and
    // the endpoints behind them all have to answer for a partner to exist.
    response = await fetch(base + '/whitelabel');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /White Label/);
    response = await fetch(base + '/wl-admin');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Partner sign in/);
    response = await fetch(base + '/partner', { redirect: 'manual' });
    assert.equal(response.status, 301);
    assert.equal(response.headers.get('location'), '/whitelabel');
    response = await fetch(base + '/api/whitelabel/license-fee');
    assert.equal(response.status, 200);
    assert.equal(typeof (await response.json()).licenseFee, 'number');
    // No partner in the address means the site keeps its own identity.
    response = await fetch(base + '/api/whitelabel/branding');
    assert.deepEqual(await response.json(), { isWhitelabel: false });
    // A registration that is not paid for yet.
    response = await fetch(base + '/api/whitelabel/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brand_name: 'ABC Print Solutions', slug: 'abcprint', owner_name: 'Test Partner', phone: '9000000000', email: 'partner@example.com' }) });
    const registered = await response.json();
    assert.equal(response.status, 200, JSON.stringify(registered));
    assert.match(registered.wlId, /^WL_[0-9A-F]{8}$/);
    // An unpaid partner does not brand anything yet.
    response = await fetch(base + '/api/whitelabel/branding?wl=abcprint');
    assert.deepEqual(await response.json(), { isWhitelabel: false });
    // The slug is taken, and reserved words are refused.
    response = await fetch(base + '/api/whitelabel/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brand_name: 'Another Brand', slug: 'abcprint', owner_name: 'Someone', phone: '9000000001', email: 'other@example.com' }) });
    assert.equal(response.status, 400);
    response = await fetch(base + '/api/whitelabel/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brand_name: 'Another Brand', slug: 'admin', owner_name: 'Someone', phone: '9000000001', email: 'other@example.com' }) });
    assert.equal(response.status, 400);
    response = await fetch(base + '/api/superadmin/whitelabels', { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).whitelabels.length, 1);
    // Superadmin -> Languages. The panel lists every line the website can say,
    // stores only what really differs from the shipped translation, and the
    // public dictionary hands that correction to the page.
    const shipped = JSON.parse(fs.readFileSync(path.join(root, 'i18n', 'manipuri.json'), 'utf8'));
    const sample = Object.keys(shipped)[0];
    response = await fetch(base + '/api/superadmin/translations?lang=mni-mtei', { headers });
    let list = await response.json();
    assert.equal(response.status, 200);
    assert.equal(list.bundled, Object.keys(shipped).length);
    assert.equal(list.rows.length, Object.keys(shipped).length, 'every shipped line is listed, not only the corrections');
    let row = list.rows.find(r => r.source === sample);
    assert.deepEqual([row.base, row.text, row.edited], [shipped[sample], shipped[sample], false]);
    // A correction — sent with sloppy whitespace, as a copy off the page would be.
    response = await fetch(base + '/api/superadmin/translations', { method: 'PUT', headers, body: JSON.stringify({ lang: 'mni-mtei', items: [{ source: '  ' + sample.replace(/ /g, '  ') + '\n', text: 'ꯆꯨꯝꯃꯤ' }] }) });
    assert.deepEqual(await response.json(), { success: true, saved: 1, removed: 0 });
    response = await fetch(base + '/api/i18n/dict?lang=mni-mtei');
    assert.equal((await response.json()).dict[sample], 'ꯆꯨꯝꯃꯤ', 'the correction reaches the website');
    response = await fetch(base + '/api/superadmin/translations?lang=mni-mtei', { headers });
    row = (await response.json()).rows.find(r => r.source === sample);
    assert.deepEqual([row.base, row.text, row.edited], [shipped[sample], 'ꯆꯨꯝꯃꯤ', true]);
    // Typed back to the shipped translation the correction is dropped, so the
    // table never grows into a second copy of the dictionary.
    response = await fetch(base + '/api/superadmin/translations', { method: 'PUT', headers, body: JSON.stringify({ lang: 'mni-mtei', items: [{ source: sample, text: shipped[sample] }] }) });
    assert.deepEqual(await response.json(), { success: true, saved: 0, removed: 1 });
    response = await fetch(base + '/api/i18n/dict?lang=mni-mtei');
    assert.equal((await response.json()).dict[sample], undefined);
    // The White Label licence price is the super admin's to set.
    response = await fetch(base + '/api/superadmin/setup-fee', { headers });
    let fees = await response.json();
    assert.equal(typeof fees.wlLicenseFee, 'number');
    assert.equal(typeof fees.wlBasePriceEffective, 'number');
    response = await fetch(base + '/api/superadmin/setup-fee', { method: 'PUT', headers, body: JSON.stringify({ wlLicenseFee: 14999, wlLicenseActual: 29999, wlBasePrice: 1499 }) });
    assert.equal(response.status, 200, await response.text());
    response = await fetch(base + '/api/superadmin/setup-fee', { headers });
    fees = await response.json();
    assert.deepEqual([fees.wlLicenseFee, fees.wlLicenseActual, fees.wlBasePrice], [14999, 29999, 1499]);
    // And a partner's page shows exactly that.
    response = await fetch(base + '/api/whitelabel/license-fee');
    assert.deepEqual(await response.json(), { licenseFee: 14999, licenseActual: 29999, basePrice: 1499 });
    // The struck-out price may not be below the real one, and the partner's
    // floor may not undercut the plan it sells.
    response = await fetch(base + '/api/superadmin/setup-fee', { method: 'PUT', headers, body: JSON.stringify({ wlLicenseFee: 14999, wlLicenseActual: 500 }) });
    assert.equal(response.status, 400);
    response = await fetch(base + '/api/superadmin/setup-fee', { method: 'PUT', headers, body: JSON.stringify({ wlBasePrice: 1 }) });
    assert.equal(response.status, 400);

    // Automatic blocking is a switch, and off it only suggests.
    response = await fetch(base + '/api/superadmin/security-events', { headers });
    let sec = await response.json();
    assert.equal(response.status, 200, JSON.stringify(sec));
    assert.equal(sec.autoBlock, true);
    assert.deepEqual(sec.suggestions, []);
    response = await fetch(base + '/api/superadmin/auto-block', { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) });
    assert.deepEqual(await response.json(), { success: true, enabled: false });
    response = await fetch(base + '/api/superadmin/security-events', { headers });
    assert.equal((await response.json()).autoBlock, false);
    response = await fetch(base + '/api/superadmin/auto-block', { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) });
    assert.deepEqual(await response.json(), { success: true, enabled: true });

    // A demo the super admin removed reads as removed, not as a broken link.
    response = await fetch(base + '/api/shop/DEMO_NOTHERE');
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'This demo account has been deleted.', demoDeleted: true });
    response = await fetch(base + '/api/shop/SHOP_NOTHERE');
    assert.equal(response.status, 404);
    assert.equal((await response.json()).demoDeleted, false, 'a normal Shop ID is not a deleted demo');

    // Website maintenance: the notice covers the site, never the super admin.
    response = await fetch(base + '/api/superadmin/maintenance', { headers });
    assert.equal((await response.json()).enabled, false);
    response = await fetch(base + '/api/superadmin/maintenance', { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) });
    assert.deepEqual(await response.json(), { success: true, enabled: true });
    response = await fetch(base + '/', { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /We will be back shortly/);
    response = await fetch(base + '/admin', { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 503, 'a direct link to the shop sign-in is covered too');
    response = await fetch(base + '/api/shop/SHOP_NOTHERE');
    assert.equal(response.status, 503);
    assert.equal((await response.json()).maintenance, true);
    // These three have to keep answering.
    response = await fetch(base + '/superadmin', { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 200, 'the super admin must never be locked out');
    response = await fetch(base + '/healthz');
    assert.equal(response.status, 200, 'the host watches this one');
    response = await fetch(base + '/api/agent/version');
    assert.equal(response.status, 200, 'a shop mid-print keeps its jobs');
    response = await fetch(base + '/api/superadmin/maintenance', { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) });
    assert.deepEqual(await response.json(), { success: true, enabled: false });
    response = await fetch(base + '/', { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 200, 'and the site comes straight back');

    // Moving to another host: the report says what is needed, the backup holds
    // every row, and restoring that file puts them all back.
    response = await fetch(base + '/api/superadmin/migration/report', { headers });
    const report = await response.json();
    assert.equal(response.status, 200);
    assert.equal(report.server.baseUrl, env.BASE_URL);
    assert.equal(typeof report.database.totalRows, 'number');
    assert.ok(report.settings.some(x => x.name === 'JWT_SECRET' && x.set && x.copyFromOldHost));
    assert.ok(report.settings.every(x => !('value' in x)), 'a setting value must never leave the server');
    assert.deepEqual(report.missing, ['BASE_URL', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'].filter(n => !env[n]));
    response = await fetch(base + '/api/superadmin/backup', { headers });
    const backup = await response.json();
    assert.equal(response.status, 200);
    assert.equal(backup.from, env.BASE_URL);
    assert.ok(Array.isArray(backup.tables.shops));
    const savedTranslations = backup.tables.translations.length;
    // A dry run writes nothing and says what it found.
    response = await fetch(base + '/api/superadmin/migration/import', { method: 'POST', headers, body: JSON.stringify({ dryRun: true, dump: backup }) });
    const dry = await response.json();
    assert.equal(response.status, 200);
    assert.equal(dry.dryRun, true);
    assert.ok(dry.plan.some(t => t.table === 'whitelabels' && t.rows === 1));
    // Without the confirmation nothing happens.
    response = await fetch(base + '/api/superadmin/migration/import', { method: 'POST', headers, body: JSON.stringify({ dump: backup }) });
    assert.equal(response.status, 400);
    // Change the data, then restore the file and watch it come back.
    await db.query("DELETE FROM whitelabels");
    await db.query("INSERT INTO translations (lang, source, text, updated_at) VALUES ('mni-mtei','A line that was never there','x',NOW())");
    response = await fetch(base + '/api/superadmin/migration/import', { method: 'POST', headers, body: JSON.stringify({ confirm: 'RESTORE', mode: 'replace', dump: backup }) });
    const restored = await response.json();
    assert.equal(response.status, 200, JSON.stringify(restored));
    assert.equal(restored.written.whitelabels, 1);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM whitelabels')).rows[0].n, 1);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM translations')).rows[0].n, savedTranslations);
    // Rows numbered by the database carry on after the highest id restored.
    await db.query("INSERT INTO reviews (name, stars, text) VALUES ('After restore', 5, 'still works')");
    response = await fetch(base + '/about'); assert.equal(response.status, 200); assert.match(await response.text(), /Echel/);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await db.close();
  }
});
