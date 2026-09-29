const test = require('node:test'), assert = require('node:assert/strict');
const { bootBackend } = require('./_boot-backend');

// The superadmin can delete ANY shop — paid, demo, pending, expired, or one
// registered under a white-label partner — and a white-label partner itself.
test('superadmin deletes any kind of shop and any white-label partner', { timeout: 90000 }, async () => {
  const { base, db, headers, close } = await bootBackend();
  try {
    const shop = (id, cols) => db.query(
      `INSERT INTO shops (id, name, phone, setup_paid, setup_amount, demo, demo_expires_at, whitelabel_id)
       VALUES ($1, $2, '9000000000', $3, $4, $5, $6, $7)`,
      [id, 'Shop ' + id, !!cols.paid, cols.amount || 0, !!cols.demo, cols.expires || null, cols.wl || '']);
    const exists = async id => (await db.query('SELECT 1 FROM shops WHERE id=$1', [id])).rows.length === 1;
    const del = (id, body) => fetch(base + '/api/superadmin/shop/' + id, { method: 'DELETE', headers, body: JSON.stringify(body || {}) });

    await shop('SHOP_PAID0001', { paid: true, amount: 1299 });
    await shop('SHOP_PEND0001', { amount: 1299 });
    await shop('SHOP_DEMO0001', { demo: true, expires: new Date(Date.now() + 3600e3) });
    await shop('SHOP_EXPD0001', { demo: true, expires: new Date(Date.now() - 3600e3) });
    await shop('SHOP_WLSH0001', { paid: true, amount: 999, wl: 'WL_TEST0001' });
    await shop('SHOP_ECB1AB8A', { paid: true, amount: 1299 });

    // Rows that belong to the paid shop, and its payment in the ledger.
    await db.query(`INSERT INTO print_jobs (id, shop_id, file_name) VALUES ('JOB_1', 'SHOP_PAID0001', 'a.pdf')`);
    await db.query(`INSERT INTO reviews (name, shop_id) VALUES ('R', 'SHOP_PAID0001')`);
    await db.query(`INSERT INTO system_settings (key, value) VALUES ('printers_SHOP_PAID0001', '[]')`);
    await db.query(`INSERT INTO platform_payments (kind, shop_id, amount, payment_id) VALUES ('setup', 'SHOP_PAID0001', 1299, 'pay_1')`);

    // A paid shop is refused without the typed confirmation…
    let r = await del('SHOP_PAID0001');
    assert.equal(r.status, 400);
    assert.equal((await r.json()).needsConfirm, true);
    assert.ok(await exists('SHOP_PAID0001'));
    // …and deleted with it, together with its data. The payment ledger stays.
    r = await del('SHOP_PAID0001', { confirm: 'DELETE' });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await r.json()).deleted.shops, 1);
    assert.equal(await exists('SHOP_PAID0001'), false);
    assert.equal((await db.query(`SELECT 1 FROM print_jobs WHERE shop_id='SHOP_PAID0001'`)).rows.length, 0);
    assert.equal((await db.query(`SELECT 1 FROM reviews WHERE shop_id='SHOP_PAID0001'`)).rows.length, 0);
    assert.equal((await db.query(`SELECT 1 FROM system_settings WHERE key='printers_SHOP_PAID0001'`)).rows.length, 0);
    assert.equal((await db.query(`SELECT 1 FROM platform_payments WHERE shop_id='SHOP_PAID0001'`)).rows.length, 1);

    // Pending, running demo, expired demo: one click.
    for (const id of ['SHOP_PEND0001', 'SHOP_DEMO0001', 'SHOP_EXPD0001']) {
      r = await del(id);
      assert.equal(r.status, 200, id + ': ' + await r.clone().text());
      assert.equal(await exists(id), false, id);
    }

    // No shop ID is special — SHOP_ECB1AB8A (protected by another project) goes too.
    r = await del('SHOP_ECB1AB8A', { confirm: 'DELETE' });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(await exists('SHOP_ECB1AB8A'), false);
    assert.equal((await del('SHOP_NOPE0001', { confirm: 'DELETE' })).status, 404);

    // A white-label partner: needs the confirmation, then goes with all its shops.
    await db.query(`INSERT INTO whitelabels (id, slug, brand_name, password_hash) VALUES ('WL_TEST0001', 'testwl', 'Test WL', 'x')`);
    await shop('SHOP_WLSH0002', { amount: 999, wl: 'WL_TEST0001' });
    const delWl = body => fetch(base + '/api/superadmin/whitelabel/WL_TEST0001', { method: 'DELETE', headers, body: JSON.stringify(body || {}) });
    assert.equal((await delWl()).status, 400);
    r = await delWl({ confirm: 'DELETE' });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await r.json()).shopsDeleted, 2);
    assert.equal((await db.query(`SELECT 1 FROM whitelabels WHERE id='WL_TEST0001'`)).rows.length, 0);
    assert.equal(await exists('SHOP_WLSH0001'), false);
    assert.equal(await exists('SHOP_WLSH0002'), false);
    assert.equal((await delWl({ confirm: 'DELETE' })).status, 404);

    // Without the superadmin token nothing can be deleted.
    await shop('SHOP_LAST0001', {});
    r = await fetch(base + '/api/superadmin/shop/SHOP_LAST0001', { method: 'DELETE' });
    assert.equal(r.status, 401);
    assert.ok(await exists('SHOP_LAST0001'));
  } finally { await close(); }
});
