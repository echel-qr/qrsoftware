const test = require('node:test'), assert = require('node:assert/strict');
const { deploymentConfig, databaseOptions, isJobAsset, partnerLink } = require('../deployment');
test('Render origin is used until a custom domain is configured', () => {
  assert.deepEqual(deploymentConfig({ RENDER_EXTERNAL_URL: 'https://echel-test.onrender.com/' }), { baseUrl: 'https://echel-test.onrender.com', siteUrl: 'https://echel-test.onrender.com' });
  assert.equal(deploymentConfig({ BASE_URL: 'https://echel.in', RENDER_EXTERNAL_URL: 'https://echel-test.onrender.com' }).baseUrl, 'https://echel.in');
  assert.throws(() => deploymentConfig({ NODE_ENV: 'production' }), /DATABASE_URL/);
});
test('database TLS cannot be disabled by connection URL parameters', () => {
  const opts = databaseOptions({ DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/postgres?sslmode=no-verify', DATABASE_SSL_CA: 'CERT\\nLINE' });
  assert.equal(opts.ssl.rejectUnauthorized, true);
  assert.equal(opts.ssl.ca, 'CERT\nLINE');
  assert.ok(!opts.connectionString.includes('sslmode'));
  assert.equal(databaseOptions({ DATABASE_URL: 'postgresql://localhost/echel' }).ssl, false);
});
test('cloud cleanup accepts only Echel print assets and protects branding', () => {
  assert.equal(isJobAsset('echel/jobs/abc-123.pdf'), true);
  for (const id of ['qrprint_original.pdf', 'echel/branding/logo', '../echel/jobs/x', 'echel/jobs/../../original', 'other/x', '', null]) assert.equal(isJobAsset(id), false);
});
test('a partner link is the partner\'s own subdomain once the site has a domain of its own', () => {
  assert.equal(partnerLink('https://echel.in', 'abcprint'), 'https://abcprint.echel.in');
  assert.equal(partnerLink('https://www.echel.in', 'abcprint'), 'https://abcprint.echel.in');
  assert.equal(partnerLink('http://echel.test:8080', 'abcprint'), 'http://abcprint.echel.test:8080');
  // A Render address, an IP or localhost cannot carry a wildcard; ?wl= opens the partner's site there.
  assert.equal(partnerLink('https://echel-print.onrender.com', 'abcprint'), 'https://echel-print.onrender.com/?wl=abcprint');
  assert.equal(partnerLink('http://127.0.0.1', 'abcprint'), 'http://127.0.0.1/?wl=abcprint');
  assert.equal(partnerLink('http://localhost:3100', 'abcprint'), 'http://localhost:3100/?wl=abcprint');
});
