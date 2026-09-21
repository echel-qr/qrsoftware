const test = require('node:test'), assert = require('node:assert/strict');
const { scanRepo } = require('../scripts/i18n/scan-hinglish');

// The source of this product is English: pages, messages, logs, reports,
// e-mails, comments and identifiers. Other languages are added through the
// translation dictionaries (i18n/manipuri.json -> public/i18n/mni-mtei.js),
// never by writing another language into the source.
//
// If this test fails, the report below names the file, the line and the words
// that were recognised. Write that text in English and, if a visitor can see
// it, add its Manipuri translation to i18n/manipuri.json.
//
// A test that has to name Hinglish words on purpose (to prove they never reach
// the user) marks that line with the comment  hinglish-sample.
test('the source stays English', () => {
  const found = scanRepo();
  const report = found.slice(0, 40)
    .map(f => `  ${f.file}:${f.line}  [${f.words.join(' ')}]  ${f.text}`).join('\n');
  assert.equal(found.length, 0,
    `${found.length} pieces of text are not English:\n${report}` +
    (found.length > 40 ? `\n  ... and ${found.length - 40} more (npm run i18n:scan)` : ''));
});
