// Run only after the approved translation batch and review have completed.
// A missing catalogue entry aborts the build instead of publishing partial coverage.
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
const catalog = read('ui-catalog.json'), translations = read('manipuri-translations.json');
const dict = {}, missing = [], invalid = [];
const slots = s => (s.match(/%[sd]/g) || []).join(',');
for (const item of catalog) {
  const target = translations[item.text];
  if (!target) { missing.push(item.text); continue; }
  if (slots(item.text) !== slots(target)) { invalid.push(item.text); continue; }
  dict[item.text] = target;
  for (const source of item.sources) if (slots(source) === slots(target)) dict[source] = target;
}
if (missing.length || invalid.length) {
  console.error(`${missing.length} missing translations; ${invalid.length} invalid dynamic placeholders. Existing dictionary preserved.`);
  process.exit(1);
}
const { english } = read('ui-strings-raw.json');
for (const [source, value] of Object.entries(english)) if (dict[value] && slots(source) === slots(dict[value])) dict[source] = dict[value];
const output = '/* Echel website catalogue — English and Meitei Mayek. Generated at build time. */\nwindow.QSPi18n.addDict(' + JSON.stringify(dict).replace(/</g, '\\u003c') + ', "mni-mtei");\n';
fs.writeFileSync(path.join(root, 'public/echel-mayek.js'), output);
console.log(`Bundled ${catalog.length} catalogue phrases using ${Object.keys(dict).length} source keys.`);
