// Boots the real server.js against an in-memory PGlite database, exactly like
// server-start.test.js does, and hands back { base, headers, close } for route
// tests. Superadmin is already logged in (headers carry the bearer token).
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { createRequire } = require('node:module');
const { PGlite } = require('@electric-sql/pglite');
const express = require('express');

async function bootBackend() {
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
  const close = async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await db.close();
  };
  try {
    vm.runInContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), context);
    await ready;
  } catch (e) { await close(); throw e; }
  const base = 'http://127.0.0.1:' + server.address().port;
  const login = await fetch(base + '/api/superadmin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminId: env.SUPER_ADMIN_ID, password: env.SUPER_ADMIN_PASSWORD }) });
  const { token } = await login.json();
  return { base, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, close };
}
module.exports = { bootBackend };
