const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');

// Sidebar language <select> in the shop dashboard: the page has a global
// `input,select,textarea{... background:#fff !important}` rule. Unless the
// language select's own background AND text colour are set with the same
// priority, the box renders white-on-white and looks empty until it is opened.
// Which colours they are is the design's choice — that they win, and that they
// differ from each other, is what this test protects.
test('shop dashboard language dropdown stays readable under the global white select rule', () => {
  const root = path.join(__dirname, '..', 'public');
  const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8').replace(/\s+/g, ' ');
  assert.match(admin, /input,select,textarea\{[^}]*background:#fff !important/, 'global white select rule expected');

  const css = admin + ' ' + fs.readFileSync(path.join(root, 'echel-owner.css'), 'utf8').replace(/\s+/g, ' ');
  const rules = [...css.matchAll(/([^{}]*select\[data-i18n-select\][^{}]*)\{([^}]*)\}/g)];
  assert.ok(rules.length, 'no rule styles the language select');

  const colour = (body, prop) => {
    const m = body.match(new RegExp(prop + ' *: *([^;!]+) *!important'));
    return m ? m[1].trim().toLowerCase() : null;
  };
  // A rule counts when at least one of its selectors targets the select itself
  // (not only its <option> list, which the browser paints separately).
  const forSelect = list => list.split(',').some(sel => /select\[data-i18n-select\]\s*$/.test(sel));
  const winning = rules.find(r => forSelect(r[1]) &&
    (colour(r[2], 'background') || colour(r[2], 'background-color')) && colour(r[2], 'color'));
  assert.ok(winning, 'the language select needs a background and a text colour marked !important, or the global white rule hides it');
  const bg = colour(winning[2], 'background') || colour(winning[2], 'background-color');
  assert.notEqual(bg, colour(winning[2], 'color'), 'the text and the background must not be the same colour');
});
