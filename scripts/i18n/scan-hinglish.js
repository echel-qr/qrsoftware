#!/usr/bin/env node
'use strict';
/*
 * scan-hinglish.js — reads the whole repository and reports any text that is
 * not English.
 *
 * The product is English-only at the source; other languages come from the
 * translation dictionaries (i18n/manipuri.json -> public/i18n/mni-mtei.js).
 * This scan is what keeps that true, and test/no-hinglish.test.js fails the
 * build when it finds something.
 *
 *   npm run i18n:scan          the report
 *   node scripts/i18n/scan-hinglish.js --files public/admin.html
 *
 * What is read in each file:
 *   .js            comments and text inside strings / template literals
 *   .html          page text, translatable attributes, comments, inline <script>
 *   .css           comments
 *   everything else (.py, .md, .txt, .yml, .json)  every line
 *
 * Identifiers, URLs, class names and the like are not read at all, so the
 * report is about text a person can see, not about code.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const acorn = require('acorn');
const parse5 = require('parse5');
const { isHinglish, hits, strongList } = require('./hinglish');

const ROOT = path.join(__dirname, '..', '..');

// Files whose content is not English on purpose, plus everything that is not text.
const SKIP_DIRS = new Set(['node_modules', '.git', 'downloads', 'fonts', 'uploads']);
const SKIP_FILES = new Set([
  'package-lock.json',
  path.join('i18n', 'manipuri.json'),            // the Manipuri translations themselves
  path.join('scripts', 'i18n', 'hinglish.js'),   // the word list this scan is built on
]);
const SKIP_RE = [
  /^public[\\/]i18n[\\/]/,                       // generated dictionaries
  /\.(png|jpe?g|webp|gif|ico|svg|mp3|mp4|ttf|otf|woff2?|exe|zip|pdf|db|sqlite)$/i,
];

function repoFiles() {
  try {
    // --others --exclude-standard adds files that are not committed yet.
    // Without them a brand new page could ship with text nobody scanned.
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch (e) {
    const out = [];
    (function walk(dir) {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const rel = path.relative(ROOT, full);
        if (SKIP_DIRS.has(name)) continue;
        if (fs.statSync(full).isDirectory()) walk(full);
        else out.push(rel.split(path.sep).join('/'));
      }
    })(ROOT);
    return out;
  }
}

function skipped(file) {
  const rel = file.split('/').join(path.sep);
  if (SKIP_FILES.has(rel)) return true;
  if (rel.split(path.sep).some(p => SKIP_DIRS.has(p))) return true;
  return SKIP_RE.some(re => re.test(rel));
}

function lineOf(src, offset) {
  let n = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

function parseJs(code) {
  const comments = [];
  const opts = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true,
                 allowAwaitOutsideFunction: true, onComment: comments };
  let ast;
  try { ast = acorn.parse(code, Object.assign({}, opts, { sourceType: 'script' })); }
  catch (e) { comments.length = 0; ast = acorn.parse(code, Object.assign({}, opts, { sourceType: 'module' })); }
  return { ast, comments };
}

function walkAst(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range') continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walkAst(c, visit); }
    else if (v && typeof v.type === 'string') walkAst(v, visit);
  }
}

// Text a person can read, from a piece of JavaScript.
function jsPieces(code, base, push) {
  let parsed;
  try { parsed = parseJs(code); }
  catch (e) { return; }                      // a parse error is the syntax check's job
  for (const c of parsed.comments) push(c.start + base, code.slice(c.start, c.end));
  walkAst(parsed.ast, node => {
    if (node.type === 'Literal' && typeof node.value === 'string') push(node.start + base, node.value);
    else if (node.type === 'TemplateLiteral') {
      for (const q of node.quasis) push(q.start + base, q.value.cooked || q.value.raw || '');
    }
    else if (node.type === 'Identifier') name(node.start + base, node.name);
  });
}

// Names are English too: a variable called `kul` or a CSS class called
// `kaam-list` is as much Hinglish as a sentence. A name is split into its words
// (camelCase, snake_case, kebab-case) and only the unmistakable Hindi words
// count, so short English names are never flagged by accident.
const STRONG = new Set(strongList);
let name = () => {};
function nameWords(id) {
  return String(id)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .map(w => w.toLowerCase())
    .filter(Boolean);
}

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'code', 'pre']);
const TEXT_ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt', 'value', 'label', 'content', 'data-tip']);
const JS_TYPE = /^(?:|text\/javascript|application\/javascript|module)$/i;

function htmlPieces(src, push) {
  const doc = parse5.parse(src, { sourceCodeLocationInfo: true });
  (function visit(node, inRaw) {
    const tag = node.tagName || node.nodeName;
    const loc = node.sourceCodeLocation;
    if (node.nodeName === '#comment' && loc) { push(loc.startOffset, src.slice(loc.startOffset, loc.endOffset)); return; }
    if (node.nodeName === '#text') { if (!inRaw && loc) push(loc.startOffset, node.value); return; }
    if (node.attrs && loc && loc.attrs) {
      for (const a of node.attrs) {
        const al = loc.attrs[a.name];
        if (!al) continue;
        if (/^on[a-z]+$/i.test(a.name)) jsPieces(a.value, al.startOffset, push);
        else if (TEXT_ATTRS.has(a.name)) push(al.startOffset, a.value);
        else if (/^(id|class|name|for|data-[\w-]+)$/.test(a.name)) {
          for (const v of a.value.split(/\s+/)) name(al.startOffset, v);
        }
      }
    }
    if (tag === 'script' && node.childNodes && node.childNodes[0] && node.childNodes[0].sourceCodeLocation) {
      const type = (node.attrs || []).find(a => a.name === 'type');
      const t = node.childNodes[0].sourceCodeLocation;
      if (!type || JS_TYPE.test(type.value)) jsPieces(src.slice(t.startOffset, t.endOffset), t.startOffset, push);
      return;
    }
    if (tag === 'style' && node.childNodes && node.childNodes[0] && node.childNodes[0].sourceCodeLocation) {
      const t = node.childNodes[0].sourceCodeLocation;
      cssPieces(src.slice(t.startOffset, t.endOffset), t.startOffset, push);
      return;
    }
    const raw = inRaw || RAW_TEXT.has(tag);
    const kids = node.nodeName === 'template' && node.content ? node.content.childNodes : node.childNodes;
    if (kids) for (const c of kids) visit(c, raw);
  })(doc, false);
}

function cssPieces(css, base, push) {
  const re = /\/\*[\s\S]*?\*\//g;
  let m;
  while ((m = re.exec(css))) push(base + m.index, m[0]);
}

function linePieces(src, push) {
  let pos = 0;
  for (const line of src.split('\n')) {
    if (line.trim()) push(pos, line);
    pos += line.length + 1;
  }
}

// A test that checks Hinglish never reaches the user has to name the words it
// is looking for. Such a line says so with the marker below and is left alone.
const ALLOW = 'hinglish-sample';

function scanFile(file, src) {
  const found = [];
  const lines = src.split('\n');
  name = (offset, id) => {
    const bad = nameWords(id).filter(w => STRONG.has(w));
    if (!bad.length) return;
    const line = lineOf(src, offset);
    if (lines[line - 1].includes(ALLOW)) return;
    if (found.some(f => f.line === line && f.text === 'name: ' + id)) return;
    found.push({ file, line, text: 'name: ' + id, words: bad });
  };
  const push = (offset, text) => {
    if (!text || !/[A-Za-zऀ-ॿ]/.test(text)) return;
    if (!isHinglish(text)) return;
    if (lines[lineOf(src, offset) - 1].includes(ALLOW)) return;
    found.push({ file, line: lineOf(src, offset), text: String(text).replace(/\s+/g, ' ').trim().slice(0, 160), words: hits(text) });
  };
  const ext = path.extname(file).toLowerCase();
  if (ext === '.js') jsPieces(src, 0, push);
  else if (ext === '.html' || ext === '.htm') htmlPieces(src, push);
  else if (ext === '.css') cssPieces(src, 0, push);
  else linePieces(src, push);
  return found;
}

function scanRepo(files) {
  const list = (files && files.length ? files : repoFiles()).filter(f => !skipped(f));
  const found = [];
  for (const f of list) {
    const full = path.join(ROOT, f);
    let src;
    try { src = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
    if (src.indexOf(' ') !== -1) continue;             // not a text file
    for (const row of scanFile(f, src)) found.push(row);
  }
  return found;
}

module.exports = { scanRepo, scanFile, isHinglish };

if (require.main === module) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--files');
  const found = scanRepo(at >= 0 ? args[at + 1].split(',') : null);
  for (const f of found) console.log(`${f.file}:${f.line}  [${f.words.join(' ')}]  ${f.text}`);
  console.log(found.length ? `\n${found.length} pieces of text are not English.` : 'Everything is English.');
  process.exitCode = found.length ? 1 : 0;
}
