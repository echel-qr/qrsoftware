const test = require('node:test'), assert = require('node:assert/strict');
const { bootBackend } = require('./_boot-backend');

test('superadmin can set demo time beyond 24 hours and any demo print limit', { timeout: 90000 }, async () => {
  const { base, headers, close } = await bootBackend();
  try {
    const put = body => fetch(base + '/api/superadmin/demo-config', { method: 'PUT', headers, body: JSON.stringify(body) });
    // Read the body once: assert on status with the text, then parse it.
    const okJson = async (res) => { const text = await res.text(); assert.equal(res.status, 200, text); return JSON.parse(text); };

    // 7 days + 50 prints — previously capped at 1440 minutes and no way to set the limit.
    let r = await put({ enabled: true, minutes: 10080, printLimit: 50 });
    let d = await okJson(r);
    assert.equal(d.minutes, 10080); assert.equal(d.printLimit, 50);

    // Public config (homepage + agent read this) must report the same values.
    r = await fetch(base + '/api/demo/config'); d = await r.json();
    assert.equal(d.minutes, 10080); assert.equal(d.printLimit, 50);

    // Saving time alone keeps the print limit that was already set.
    r = await put({ enabled: true, minutes: 43200 }); d = await okJson(r);
    assert.equal(d.minutes, 43200); assert.equal(d.printLimit, 50);

    // Guard rails: too short, absurdly long, and a zero print limit are rejected.
    assert.equal((await put({ enabled: true, minutes: 10 })).status, 400);
    assert.equal((await put({ enabled: true, minutes: 525600 + 1 })).status, 400);
    assert.equal((await put({ enabled: true, minutes: 60, printLimit: 0 })).status, 400);
    assert.equal((await put({ enabled: true, minutes: 60, printLimit: 100001 })).status, 400);

    // A new demo shop picks up the configured window.
    await okJson(await put({ enabled: true, minutes: 4320, printLimit: 25 }));
    r = await fetch(base + '/api/demo/request', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test', phone: '9835271604', shopName: 'Demo Shop', address: 'Imphal', email: 'demo@example.com', printerModel: 'HP' }) });
    d = await okJson(r);
    assert.equal(d.approved, true); assert.equal(d.minutes, 4320); assert.equal(d.printLimit, 25);
  } finally { await close(); }
});
