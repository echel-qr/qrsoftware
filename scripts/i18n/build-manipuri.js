#!/usr/bin/env node
/*
 * build-manipuri.js — builds the Manipuri dictionary the website loads.
 *
 *   source : i18n/manipuri.json        { "English text": "Manipuri text" }
 *   output : public/i18n/mni-mtei.js   the file /i18n.js downloads when a
 *                                      visitor picks ꯃꯤꯇꯩꯂꯣꯟ
 *
 * Run it after editing i18n/manipuri.json:
 *
 *   npm run i18n:build
 *
 * The English text is the key, because the website's own source is written in
 * English. So a new page needs no key names — its English text IS the key.
 *
 * Checks before writing:
 *   - the JSON parses and every value is a non-empty string
 *   - %s / %d placeholders match between the English and the Manipuri text,
 *     otherwise a name or a number would land in the wrong place
 *   - entries that are still pure English are reported (not an error: "PDF",
 *     "₹10", "GST" and such stay as they are)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC  = path.join(ROOT, 'i18n', 'manipuri.json');
const OUT  = path.join(ROOT, 'public', 'i18n', 'mni-mtei.js');

const MAYEK = /[\u{ABC0}-\u{ABFF}]/u;          // the Meitei Mayek block

function slots(s) { return (String(s).match(/%[sd]/g) || []).join(''); }

function build() {
  const raw = fs.readFileSync(SRC, 'utf8');
  let dict;
  try { dict = JSON.parse(raw); }
  catch (e) { throw new Error('i18n/manipuri.json is not valid JSON: ' + e.message); }

  const problems = [];
  const plain = [];
  const out = {};
  for (const [en, mni] of Object.entries(dict)) {
    if (typeof mni !== 'string' || !mni.trim()) { problems.push('empty translation: ' + JSON.stringify(en)); continue; }
    if (slots(en) !== slots(mni)) {
      problems.push('placeholders differ: ' + JSON.stringify(en) + ' -> ' + JSON.stringify(mni));
      continue;
    }
    if (!MAYEK.test(mni)) plain.push(en);
    out[en] = mni;
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    throw new Error(problems.length + ' entries in i18n/manipuri.json need fixing (see above).');
  }

  const keys = Object.keys(out).sort((a, b) => a.localeCompare(b, 'en'));
  const lines = keys.map(k => ' ' + JSON.stringify(k) + ': ' + JSON.stringify(out[k]) + ',');
  const file =
`/* Manipuri (Meiteilon) in Meitei Mayek — ꯃꯤꯇꯩꯂꯣꯟ
   GENERATED FILE — do not edit by hand.

   Source : i18n/manipuri.json
   Build  : npm run i18n:build   (scripts/i18n/build-manipuri.js)

   The key is the website's own English text; the value is the Manipuri text.
   /i18n.js downloads this file only when a visitor picks Manipuri, so English
   visitors never wait for it.

   To correct one line without a deploy: Superadmin -> Languages. Those edits
   live in the database and are applied on top of this file.

   ${keys.length} entries. */
(function (w) {
 var D = {
${lines.join('\n')}
 };
 if (w.QSPi18n && w.QSPi18n.addDict) w.QSPi18n.addDict(D, 'mni-mtei');
 else (w.QSP_PENDING_DICTS = w.QSP_PENDING_DICTS || []).push(['mni-mtei', D]);
})(window);
`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, file, 'utf8');
  return { count: keys.length, plain, bytes: Buffer.byteLength(file) };
}

module.exports = { build };

if (require.main === module) {
  const r = build();
  console.log(`public/i18n/mni-mtei.js written — ${r.count} entries, ${(r.bytes / 1024).toFixed(0)} KB.`);
  if (r.plain.length) {
    console.log(`${r.plain.length} entries are still plain English (fine for "PDF", "GST", prices and such):`);
    for (const p of r.plain.slice(0, 40)) console.log('   ' + JSON.stringify(p));
    if (r.plain.length > 40) console.log('   ... and ' + (r.plain.length - 40) + ' more');
  }
}
