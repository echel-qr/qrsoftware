const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), http = require('node:http');
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
    // A plan's billing cycle has to come back as it was saved. It used to go
    // through parseInt(), which turned 'monthly' into NaN — and NaN reads as
    // lifetime, so the homepage always said "one-time payment" and every new
    // shop was registered as lifetime, never to renew.
    for (const cycle of ['monthly', 'quarterly', 'yearly', 'lifetime']) {
      response = await fetch(base + '/api/superadmin/setup-fee', { method: 'PUT', headers, body: JSON.stringify({ plans: { starter: { fee: 399, actual: 0, billingCycle: cycle }, pro: { fee: 899, actual: 0, billingCycle: 'yearly' } } }) });
      assert.equal(response.status, 200, await response.text());
      response = await fetch(base + '/api/setup-fee/current');
      const current = await response.json();
      assert.equal(current.plans.starter.billingCycle, cycle, 'the homepage reads back ' + cycle);
      assert.equal(current.plans.pro.billingCycle, 'yearly');
      response = await fetch(base + '/api/superadmin/setup-fee', { headers });
      assert.equal((await response.json()).plans.starter.billingCycle, cycle, 'and so does Superadmin after a reload');
    }
    // A shop that registers under a monthly plan is stored as monthly.
    response = await fetch(base + '/api/superadmin/setup-fee', { method: 'PUT', headers, body: JSON.stringify({ plans: { starter: { fee: 399, actual: 0, billingCycle: 'monthly' } } }) });
    assert.equal(response.status, 200);

    // The super admin changes a shop owner's mobile number when they ask.
    await db.query("INSERT INTO shops (id, name, phone, setup_paid, password_hash) VALUES ('SHOP_PHONE01','Phone Test','9000000001',true,'x'), ('SHOP_PHONE02','Second Shop','9811111111',true,'y')");
    response = await fetch(base + '/api/superadmin/shop/SHOP_PHONE01/phone', { method: 'POST', headers, body: JSON.stringify({ phone: '+91 98111-11111' }) });
    const changed = await response.json();
    assert.equal(response.status, 200, JSON.stringify(changed));
    // "+91 98111-11111" is the same number as 9811111111.
    assert.deepEqual([changed.oldPhone, changed.phone], ['9000000001', '9811111111']);
    // Another shop already on that number is pointed out, not refused.
    assert.deepEqual(changed.sharedWith.map(x => x.id), ['SHOP_PHONE02']);
    const after = (await db.query("SELECT phone, password_hash FROM shops WHERE id='SHOP_PHONE01'")).rows[0];
    assert.deepEqual([after.phone, after.password_hash], ['9811111111', 'x'], 'only the number moves — the login stays');
    for (const [body, status] of [[{ phone: '12345' }, 400], [{ phone: '98111 11111' }, 400], [{}, 400]])
      assert.equal((await fetch(base + '/api/superadmin/shop/SHOP_PHONE01/phone', { method: 'POST', headers, body: JSON.stringify(body) })).status, status, JSON.stringify(body));
    assert.equal((await fetch(base + '/api/superadmin/shop/SHOP_NOBODY/phone', { method: 'POST', headers, body: JSON.stringify({ phone: '9000000009' }) })).status, 404);
    assert.equal((await fetch(base + '/api/superadmin/shop/SHOP_PHONE01/phone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '9000000009' }) })).status, 401, 'only the super admin');

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

    // ── Money paths ────────────────────────────────────────────────────────
    // (The sandbox has no fetch, so nothing here can reach Razorpay.)
    const jwt = localRequire('jsonwebtoken');
    const nodeCrypto = require('node:crypto');
    const rzpSign = (secret, orderId, paymentId) => nodeCrypto.createHmac('sha256', secret).update(orderId + '|' + paymentId).digest('hex');
    const post = (url, body, extra) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(extra || {}) }, body: JSON.stringify(body) });
    await db.query(`INSERT INTO shops (id, name, phone, setup_paid, password_hash, payment_mode, payment_gateway, razorpay_key_id, razorpay_key_secret, price_bw, price_color)
                    VALUES ('SHOP_PAY01','Pay Test','9000000003',true,'x','both','razorpay','rzp_test_fixture','shop-fixture-secret',2,5)`);
    await db.query(`INSERT INTO print_jobs (id, shop_id, file_name, total_pages, copies, color_mode, amount, razorpay_order_id) VALUES
                    ('JOB_CHEAP','SHOP_PAY01','a.pdf',1,1,'bw',2,'order_cheap'),
                    ('JOB_BIG','SHOP_PAY01','b.pdf',50,1,'bw',100,'order_big'),
                    ('JOB_CTR','SHOP_PAY01','c.pdf',5,1,'bw',10,''),
                    ('JOB_CTR2','SHOP_PAY01','d.pdf',5,1,'bw',10,'')`);
    const cheapReceipt = { razorpay_order_id: 'order_cheap', razorpay_payment_id: 'pay_1', razorpay_signature: rzpSign('shop-fixture-secret', 'order_cheap', 'pay_1') };
    // The receipt of the Rs 2 print cannot pay for the Rs 100 one.
    response = await post('/api/payment/razorpay/verify', { ...cheapReceipt, jobId: 'JOB_BIG' });
    assert.equal(response.status, 400);
    assert.equal((await db.query("SELECT payment_status FROM print_jobs WHERE id='JOB_BIG'")).rows[0].payment_status, 'pending');
    // Its own receipt pays it — once.
    response = await post('/api/payment/razorpay/verify', { ...cheapReceipt, jobId: 'JOB_CHEAP' });
    assert.equal(response.status, 200, await response.text());
    let job = (await db.query("SELECT payment_status, status FROM print_jobs WHERE id='JOB_CHEAP'")).rows[0];
    assert.deepEqual([job.payment_status, job.status], ['paid', 'queued']);
    await db.query("UPDATE print_jobs SET status='printed' WHERE id='JOB_CHEAP'");
    response = await post('/api/payment/razorpay/verify', { ...cheapReceipt, jobId: 'JOB_CHEAP' });
    assert.equal(response.status, 200);
    assert.equal((await db.query("SELECT status FROM print_jobs WHERE id='JOB_CHEAP'")).rows[0].status, 'printed', 'the same receipt cannot queue a printed job again');
    response = await post('/api/payment/razorpay/verify', { razorpay_order_id: 'order_big', razorpay_payment_id: 'pay_2', razorpay_signature: 'f'.repeat(64), jobId: 'JOB_BIG' });
    assert.equal(response.status, 400, 'a forged signature');

    // The bill counts the pages that will print — not a number the browser sends.
    response = await post('/api/payment/counter', { jobId: 'JOB_CTR', totalPages: 1, selectedPages: [], copies: -5, colorMode: 'bw' });
    assert.equal(response.status, 200, await response.text());
    job = (await db.query("SELECT amount, copies, total_pages, selected_pages FROM print_jobs WHERE id='JOB_CTR'")).rows[0];
    assert.deepEqual([Number(job.amount), job.copies, job.total_pages, job.selected_pages], [10, 1, 5, '1,2,3,4,5']);
    response = await post('/api/payment/counter', { jobId: 'JOB_CTR2', totalPages: 1, selectedPages: [2, 4], copies: 2, colorMode: 'bw' });
    job = (await db.query("SELECT amount, total_pages, selected_pages FROM print_jobs WHERE id='JOB_CTR2'")).rows[0];
    assert.deepEqual([Number(job.amount), job.total_pages, job.selected_pages], [8, 2, '2,4'], '2 pages x 2 copies x Rs 2');
    // A paid print cannot be priced again, and an expired upload cannot be paid.
    assert.equal((await post('/api/payment/counter', { jobId: 'JOB_CTR', copies: 100 })).status, 409);
    await db.query("UPDATE print_jobs SET status='abandoned' WHERE id='JOB_BIG'");
    assert.equal((await post('/api/payment/counter', { jobId: 'JOB_BIG' })).status, 410);

    // The Advance pack opens only with its own unlock order.
    await db.query("INSERT INTO shops (id, name, phone, setup_paid, password_hash, advanced_order_id) VALUES ('SHOP_ADV01','Adv Test','9000000004',true,'x','order_adv')");
    const advAuth = { Authorization: 'Bearer ' + jwt.sign({ shopId: 'SHOP_ADV01' }, env.JWT_SECRET) };
    response = await post('/api/admin/advanced/verify', { razorpay_order_id: 'order_renewal', razorpay_payment_id: 'pay_r', razorpay_signature: rzpSign('', 'order_renewal', 'pay_r') }, advAuth);
    assert.equal(response.status, 400, 'a receipt for some other payment of ours');
    let adv = (await db.query("SELECT advanced_unlocked, owned_features FROM shops WHERE id='SHOP_ADV01'")).rows[0];
    assert.deepEqual([adv.advanced_unlocked, adv.owned_features.length], [false, 0], 'nothing was granted');
    response = await post('/api/admin/advanced/verify', { razorpay_order_id: 'order_adv', razorpay_payment_id: 'pay_a', razorpay_signature: rzpSign('', 'order_adv', 'pay_a') }, advAuth);
    assert.equal(response.status, 200, await response.text());
    adv = (await db.query("SELECT advanced_unlocked, owned_features FROM shops WHERE id='SHOP_ADV01'")).rows[0];
    assert.equal(adv.advanced_unlocked, true);
    assert.ok(adv.owned_features.length > 0, 'the pack is granted with it');

    // Prices must be real prices, at registration and in Settings.
    const payAuth = { Authorization: 'Bearer ' + jwt.sign({ shopId: 'SHOP_PAY01' }, env.JWT_SECRET) };
    const putSettings = body => fetch(base + '/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...payAuth }, body: JSON.stringify(body) });
    for (const bad of [0, -3, 'abc']) assert.equal((await putSettings({ price_bw: bad })).status, 400, 'price_bw ' + bad);
    assert.equal((await putSettings({ price_color: 0 })).status, 400);
    response = await putSettings({ price_bw: 3.5 });
    assert.equal(response.status, 200, await response.text());
    assert.equal(Number((await db.query("SELECT price_bw FROM shops WHERE id='SHOP_PAY01'")).rows[0].price_bw), 3.5);

    // Superadmin -> White Label: the partner's gateway, and a password reset
    // that only a paid partner can get.
    const partner = (await db.query('SELECT id FROM whitelabels LIMIT 1')).rows[0];
    response = await fetch(base + '/api/superadmin/whitelabels', { headers });
    assert.equal((await response.json()).whitelabels[0].payMode, '', 'no gateway yet');
    assert.equal((await fetch(base + '/api/superadmin/whitelabel/' + partner.id + '/reset-password', { method: 'POST', headers })).status, 400);
    await db.query('UPDATE whitelabels SET paid=true WHERE id=$1', [partner.id]);
    response = await fetch(base + '/api/superadmin/whitelabel/' + partner.id + '/reset-password', { method: 'POST', headers });
    const reset = await response.json();
    assert.equal(response.status, 200, JSON.stringify(reset));
    assert.match(reset.password, /^[0-9A-F]{8}$/);
    response = await post('/api/whitelabel/login', { wlId: partner.id, password: reset.password });
    assert.equal(response.status, 200, 'the partner signs in with it');
    const partnerAuth = { Authorization: 'Bearer ' + (await response.json()).token };
    assert.equal((await fetch(base + '/api/superadmin/whitelabel/' + partner.id + '/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' } })).status, 401, 'only the super admin');

    // The partner's link. This test site lives on an IP address, where no
    // subdomain can exist, so the link is the ?wl= one, and only that one.
    const me = await (await fetch(base + '/api/whitelabel/me', { headers: partnerAuth })).json();
    assert.equal(me.shareLink, 'http://127.0.0.1/?wl=abcprint');
    assert.equal(me.subdomainLink, undefined, 'no second link that cannot open');
    // The subdomain alone names the partner, so abcprint.echel.in opens their site.
    const byHost = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/whitelabel/branding', headers: { Host: 'abcprint.echel.in' } }, res => {
        let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve(JSON.parse(text)));
      }).on('error', reject);
    });
    assert.equal(byHost.isWhitelabel, true);
    assert.equal(byHost.brandName, 'ABC Print Solutions');
    // Paying the licence hands the new partner the same link.
    response = await post('/api/whitelabel/register', { brand_name: 'XYZ Prints', slug: 'xyzprint', owner_name: 'Second Partner', phone: '9000000002', email: 'xyz@example.com' });
    const second = await response.json();
    assert.equal(response.status, 200, JSON.stringify(second));
    await db.query("UPDATE whitelabels SET license_order_id='order_wl_licence' WHERE id=$1", [second.wlId]);
    const licence = { razorpay_order_id: 'order_wl_licence', razorpay_payment_id: 'pay_wl', razorpay_signature: rzpSign('', 'order_wl_licence', 'pay_wl'), wlId: second.wlId };
    response = await post('/api/whitelabel/license/verify', licence);
    const paidNow = await response.json();
    assert.equal(response.status, 200, JSON.stringify(paidNow));
    assert.equal(paidNow.link, 'http://127.0.0.1/?wl=xyzprint');
    response = await post('/api/whitelabel/license/verify', licence);
    assert.equal((await response.json()).link, paidNow.link, 'the same link when the payment is confirmed twice');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await db.close();
  }
});
