const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');

// Sidebar language <select> in the shop dashboard: the page has a global
// `input,select,textarea{... background:#fff !important}` rule, and the
// language select paints its text white. Unless the select's own colours are
// also !important the box renders white-on-white and looks empty until opened.
test('shop dashboard language dropdown keeps its dark background under the global white select rule', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8').replace(/\s+/g, ' ');
  assert.match(css, /input,select,textarea\{[^}]*background:#fff !important/, 'global white select rule expected');
  const rule = css.match(/select\[data-i18n-select\]\{([^}]*)\}/);
  assert.ok(rule, 'select[data-i18n-select] rule missing');
  assert.match(rule[1], /background-color:#2a1c4d ?!important/, 'background must beat the global !important white');
  assert.match(rule[1], /color:#fff ?!important/, 'text colour must stay white with matching priority');
});
