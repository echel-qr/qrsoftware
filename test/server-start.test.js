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
  const context = vm.createContext({ require: fixtureRequire, __dirname: root, __filename: path.join(root, 'server.js'), console, Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setInterval: () => ({ unref() {} }), clearInterval() {}, process: { env, exit: code => readyReject(new Error('Backend startup exited: ' + code)) } });
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
    response = await fetch(base + '/about'); assert.equal(response.status, 200); assert.match(await response.text(), /Echel/);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await db.close();
  }
});
