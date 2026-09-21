const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { collectUiStrings } = require('../scripts/i18n/ui-strings');
const { build } = require('../scripts/i18n/build-manipuri');

const ROOT = path.join(__dirname, '..');
const dict = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'manipuri.json'), 'utf8'));

// Every piece of text a visitor can read must also exist in Manipuri, so that
// switching the language never leaves half the page in English.
//
// When this fails, the missing lines are listed below. Add them to
// i18n/manipuri.json (npm run i18n:missing prints them with their page) and
// run npm run i18n:build.
test('every English string a visitor can see has a Manipuri translation', () => {
  const d = dict();
  const missing = collectUiStrings().filter(i => !Object.prototype.hasOwnProperty.call(d, i.text));
  const report = missing.slice(0, 30).map(m => `  ${JSON.stringify(m.text)}   <- ${m.sources.join(', ')}`).join('\n');
  assert.equal(missing.length, 0,
    `${missing.length} strings have no Manipuri translation:\n${report}` +
    (missing.length > 30 ? `\n  ... and ${missing.length - 30} more (npm run i18n:missing)` : ''));
});

// %s stands for any text and %d for a number. If a translation loses one, the
// name or the amount disappears from the sentence; if it gains one, a literal
// "%s" is shown to the visitor.
test('the translations keep their %s and %d placeholders', () => {
  const slots = s => (String(s).match(/%[sd]/g) || []).sort().join('');
  const wrong = Object.entries(dict()).filter(([en, mni]) => slots(en) !== slots(mni));
  assert.deepEqual(wrong, [], 'these translations do not match their English placeholders');
});

// public/i18n/mni-mtei.js is generated. If someone edits i18n/manipuri.json and
// forgets npm run i18n:build, the website would keep serving the old text.
test('public/i18n/mni-mtei.js is up to date with i18n/manipuri.json', () => {
  const file = path.join(ROOT, 'public', 'i18n', 'mni-mtei.js');
  const before = fs.readFileSync(file, 'utf8');
  build();
  const after = fs.readFileSync(file, 'utf8');
  if (before !== after) fs.writeFileSync(file, before, 'utf8');   // leave the tree as it was
  assert.equal(before, after, 'run: npm run i18n:build');
});
