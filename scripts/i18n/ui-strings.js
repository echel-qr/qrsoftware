'use strict';
/*
 * Collects every English string that the website can show to a user, so each
 * one can get a Manipuri translation.
 *
 * What counts as a UI string:
 *   - text and translatable attributes (placeholder, title, aria-label, alt)
 *     in the <body> of the public pages
 *   - JavaScript strings in those pages and in public/*.js that are written into
 *     the page, shown in a dialog, or passed to a toast; strings that contain HTML
 *     are parsed and only their text/attributes are taken
 *   - template literals and '+' concatenations become patterns in which every
 *     dynamic part is written as %s (public/i18n.js matches %s against any text)
 *   - user-facing messages in server.js (error / message / note ... properties)
 *
 * The keys are normalised exactly the way public/i18n.js looks them up:
 * whitespace collapsed and trimmed.
 *
 * Usage:
 *   node scripts/i18n/ui-strings.js            summary
 *   node scripts/i18n/ui-strings.js --json     every string with its sources
 *   node scripts/i18n/ui-strings.js --missing  strings without a Manipuri translation
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const acorn = require('acorn');
const parse5 = require('parse5');

const SLOT = '\u0001';
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'textarea', 'code', 'pre', 'template', 'svg']);
// public/*.js files that are not UI code.
const SKIP_JS = /^(i18n.*|echel-animation|echel-english|echel-mayek)\.js$/;
// Words that are never translated (brands, units, file types).
const KEEP = /^(use strict|Mtei|GET|POST|PUT|PATCH|DELETE|Echel|WhatsApp|Razorpay|Cashfree|UPI|QR|PDF|JPG|JPEG|PNG|HEIC|A[0-6]|B&W|B&amp;W|Google|Justdial|Instagram|Facebook|YouTube|LinkedIn|Telegram|X|Twitter|Brevo|SMTP|OTP|ID|PC|IP|DPI|GST|INR|OK|Windows|SumatraPDF|Cloudinary|Render|Supabase|GitHub|CamScanner|AnyDesk|Aadhaar|PAN|DL|Demo|Starter|Pro|Premium|Echel Agent|Print Agent|Shop ID|UTM|URL|API|SEO|CSV|JSON|v\d.*)$/i;

function normWs(s) { return String(s).replace(/\s+/g, ' ').trim(); }

// Is this piece of text something a person reads? (not code, CSS, a URL ...)
function isProse(text, inHtml) {
  const t = normWs(text.split(SLOT).join(' '));
  if (!t) return false;
  const letters = t.match(/[A-Za-z]{2,}/g);
  if (!letters) return false;
  if (/^(https?:|mailto:|tel:|data:|\/\/|\/api\/|\.\/|\/[a-z])/i.test(t)) return false;
  if (/^[#.][\w-]+([ >.#:\[][\w-]*)*$/.test(t)) return false;              // selectors
  if (/^[\w.-]+\/[\w.+-]+$/.test(t)) return false;                         // mime types, paths
  if (/^[a-z-]+\s*:\s*[^;]+;?(\s*[a-z-]+\s*:\s*[^;]+;?)*$/i.test(t) && /;|px|#[0-9a-f]{3}|rgba?\(/i.test(t)) return false; // CSS
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|WITH)\b/.test(t)) return false;
  if (/^[\w$.]+\([^()]*\);?$/.test(t)) return false;                         // function calls
  if (/^[A-Za-z][\w%]*(_[\w%•]*)+:?$/.test(t)) return false;            // ids and error codes: page_%s_%s, WRONG_SHOP:
  if (/^[A-Za-z]\w*(_\w*)+$/.test(t.replace(/\s+/g, ''))) return false;    // the same, with slots in them
  if (/^(repeat|minmax|calc|var|clamp|translate[XYZ]?|rgba?|hsla?|url)\(/i.test(t)) return false;  // CSS values
  // A CSS selector: starts like one and has no two plain words in a row.
  if (/^[#.[][\w-]/.test(t) && !/[A-Za-z]{2,} [A-Za-z]{2,}/.test(t)) return false;
  if (/^[?&][\w-]+=/.test(t)) return false;                                // query strings
  if (/^\(?\s*(prefers-[\w-]+|hover|pointer|any-hover|min-width|max-width|orientation)\b/.test(t)) return false; // media queries
  if (/^-?\d+(\.\d+)?(%|px|em|rem)?( -?\d+(\.\d+)?(%|px|em|rem)?){1,3}$/.test(t)) return false;           // margins, rootMargin
  if (/^(LINK|SCRIPT|STYLE|META|DIV|SPAN|IMG|INPUT|BUTTON|SELECT|OPTION|TEXTAREA|FORM|IFRAME|SVG|CANVAS|VIDEO|AUDIO|BODY|HEAD|HTML)$/.test(t)) return false; // tag names
  // "plan%sList" is an id built at runtime, not a sentence: without its slots
  // it is still one word, while real text keeps its spaces.
  const noSlots = normWs(text.split(SLOT).join(''));
  if (/^[\w$.-]+$/.test(noSlots) && noSlots !== t &&
      !/^[A-Z][a-z]/.test(noSlots) && !/^[A-Z]{2,}[a-z]*$/.test(noSlots)) return false;
  if (/^[\w$.]+\s*=\s*['"]/.test(t) || /\blocation\.href\b/.test(t)) return false;  // a line of code
  // A lone lower-case word in JavaScript is usually a key or an id; in page
  // text ("Earn <em>lifetime</em>") it is a word someone reads.
  if (!inHtml && /^[\w$.-]+$/.test(t) && !/^[A-Z][a-z]/.test(t) && !/^[A-Z]{2,}[a-z]*$/.test(t)) return false; // identifiers/keys
  if (/^[\d\s%s.,:;+\-–—×x/()₹$€@!?*·|'"«»<>=_&]+$/.test(t.replace(/%s/g, ''))) return false;
  if (KEEP.test(t)) return false;
  return true;
}

function keyOf(text) {
  return normWs(String(text).split(SLOT).join('%s'))
    .replace(/(%s\s*)+%s/g, '%s');                       // adjacent slots collapse
}

// An element marked data-i18n-sentence is looked up by its whole text, the way
// the browser's textContent reads it, so a sentence split by <b>/<em> keeps its
// word order in Manipuri.
function sentenceOf(node) {
  let s = '';
  (function read(n) {
    if (n.nodeName === '#text') { s += n.value; return; }
    for (const c of n.childNodes || []) read(c);
  })(node);
  return normWs(s);
}
function isSentence(node) {
  return (node.attrs || []).some(a => a.name === 'data-i18n-sentence');
}

// ---------------------------------------------------------------- HTML text
function htmlPieces(html, out, where) {
  const frag = parse5.parseFragment(html);
  (function visit(node, skip) {
    if (node.nodeName === '#text') {
      if (!skip && isProse(node.value, true)) out(keyOf(node.value), where);
      return;
    }
    const tag = node.tagName;
    const noI18n = (node.attrs || []).some(a => a.name === 'data-no-i18n');
    if (!skip && !noI18n && isSentence(node)) {
      const whole = sentenceOf(node);
      if (isProse(whole, true)) out(keyOf(whole), where);
      return;
    }
    const skipHere = skip || SKIP_TAGS.has(tag) || noI18n;
    if (!skipHere) {
      for (const a of node.attrs || []) {
        if (ATTRS.includes(a.name) && isProse(a.value)) out(keyOf(a.value), where);
        if (/^on[a-z]+$/.test(a.name)) jsPieces(a.value, out, where, true);
      }
    }
    const kids = tag === 'template' && node.content ? node.content.childNodes : node.childNodes;
    for (const c of kids || []) visit(c, skipHere);
  })(frag, false);
}

// ---------------------------------------------------------------- JavaScript
// Literal/template/concatenation -> text with SLOT for every dynamic part.
function flatten(node) {
  if (!node) return SLOT;
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : SLOT;
  if (node.type === 'TemplateLiteral') {
    let s = '';
    node.quasis.forEach((q, i) => {
      s += q.value.cooked == null ? q.value.raw : q.value.cooked;
      if (i < node.expressions.length) s += SLOT;
    });
    return s;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') return flatten(node.left) + flatten(node.right);
  return SLOT;
}
function hasText(node) {
  if (!node) return false;
  if (node.type === 'Literal') return typeof node.value === 'string';
  if (node.type === 'TemplateLiteral') return node.quasis.some(q => (q.value.cooked || '').trim());
  if (node.type === 'BinaryExpression' && node.operator === '+') return hasText(node.left) || hasText(node.right);
  return false;
}

// The resume PDF is drawn with jsPDF, whose fonts have no Meitei Mayek glyphs;
// a printed CV also stays in English on purpose, so its text is not collected.
const NON_UI_CALLS = /^(console\.\w+|\w+\.(text|setFont|setFontSize|setFontType|setTextColor|setDrawColor|setFillColor|addPage|addImage|splitTextToSize|getTextWidth|setLineWidth|rect|roundedRect|circle|save)|document\.(getElementById|querySelector|querySelectorAll|createElement|getElementsBy\w+)|\w+\.(querySelector|querySelectorAll|closest|matches|getAttribute|setAttribute|removeAttribute|hasAttribute|addEventListener|removeEventListener|dispatchEvent|getItem|setItem|removeItem|test|match|matchAll|replace|replaceAll|split|indexOf|lastIndexOf|includes|startsWith|endsWith|padStart|padEnd|toLocaleString|toLocaleDateString|toLocaleTimeString|join|getContext|toDataURL|toBlob|postMessage|open|send|setRequestHeader|getResponseHeader|append|set|get|has|delete|log|warn|error|info|debug)|classList\.\w+|fetch|require|RegExp|Date|Number|parseInt|parseFloat|encodeURIComponent|decodeURIComponent|atob|btoa|JSON\.\w+|new \w+|track|trackEvent|gtag|fbq|Worker|importScripts|setTimeout|setInterval)$/;

function calleeName(c) {
  if (!c) return '';
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression') {
    const prop = c.computed ? '' : (c.property.name || '');
    const obj = c.object.type === 'Identifier' ? c.object.name
      : c.object.type === 'MemberExpression' ? (c.object.property.name || 'x') : 'x';
    return obj + '.' + prop;
  }
  return '';
}

// Text that a person types into the document itself — a résumé objective, a
// sample letter — is content, not interface: it is printed exactly as it was
// entered and is never translated. Marking its declaration keeps it out of the
// dictionary:
//
//   /* i18n-ignore: résumé content, printed as the customer typed it */
//   const OBJECTIVES = { ... };
const IGNORE = /i18n-ignore/;

function jsPieces(code, out, where, isHandler) {
  let ast;
  const comments = [];
  const opts = { ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true,
                 allowHashBang: true, onComment: comments };
  try { ast = acorn.parse(code, Object.assign({ sourceType: 'script' }, opts)); }
  catch (e) {
    comments.length = 0;
    try { ast = acorn.parse(code, Object.assign({ sourceType: 'module' }, opts)); }
    catch (e2) { if (!isHandler) throw new Error(where + ': ' + e.message); return; }
  }
  // Each marker comment covers the declaration or statement right after it,
  // wherever it sits — top level or inside a function.
  const ignored = ignoredRanges(ast, comments);
  (function walk(node, parent, grand) {
    if (!node || typeof node.type !== 'string') return;
    if (ignored.some(r => node.start >= r[0] && node.end <= r[1])) return;
    const textish = (node.type === 'Literal' && typeof node.value === 'string') || node.type === 'TemplateLiteral' ||
      (node.type === 'BinaryExpression' && node.operator === '+');
    const inChain = parent && parent.type === 'BinaryExpression' && parent.operator === '+' && node.type !== 'CallExpression';
    if (textish && !inChain && hasText(node) && !nonUiContext(node, parent, grand)) {
      emitText(flatten(node), out, where);
      if (node.type !== 'Literal') {
        // Still walk into ${...} expressions: they may hold their own strings.
        const inner = node.type === 'TemplateLiteral' ? node.expressions : [node.left, node.right];
        for (const x of inner) walk(x, node, parent);
      }
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end') continue;
      const v = node[key];
      if (Array.isArray(v)) for (const c of v) { if (c && typeof c.type === 'string') walk(c, node, parent); }
      else if (v && typeof v.type === 'string') walk(v, node, parent);
    }
  })(ast, null, null);
}

function nonUiContext(node, parent, grand) {
  if (!parent) return false;
  if (parent.type === 'Property' && parent.key === node) return true;
  // { 'Authorization': 'Bearer ' + token, method: 'POST', ... } — request
  // settings, not text.
  if (parent.type === 'Property' && parent.value === node) {
    const key = parent.key && (parent.key.name || parent.key.value);
    if (/^(Authorization|Content-Type|Accept|method|mode|credentials|cache|redirect|referrerPolicy|body|id|className|href|src|type|name|responseType)$/.test(key)) return true;
  }
  // `...${on ? 'checked disabled' : ''}...` inside markup: attribute words.
  if (parent.type === 'ConditionalExpression' && node.type === 'Literal' &&
      /^(checked|disabled|selected|readonly|hidden|required)( (checked|disabled|selected|readonly|hidden|required))*$/.test(node.value)) return true;
  if (parent.type === 'MemberExpression' && parent.property === node) return true;
  if (parent.type === 'BinaryExpression' && /^(===|!==|==|!=|in|instanceof)$/.test(parent.operator)) return true;
  if (parent.type === 'SwitchCase') return true;
  if (parent.type === 'ImportDeclaration' || parent.type === 'ExportNamedDeclaration') return true;
  if (parent.type === 'CallExpression' || parent.type === 'NewExpression') {
    const name = (parent.type === 'NewExpression' ? 'new ' : '') + calleeName(parent.callee);
    if (NON_UI_CALLS.test(name)) {
      // setAttribute('title', 'Some text'): the value IS text for our ATTRS.
      if (/\.setAttribute$/.test(name) && parent.arguments[1] === node &&
          parent.arguments[0] && ATTRS.includes(parent.arguments[0].value)) return false;
      return true;
    }
  }
  if (parent.type === 'AssignmentExpression' && parent.left.type === 'MemberExpression') {
    const prop = parent.left.property && (parent.left.property.name || parent.left.property.value);
    if (/^(className|id|src|href|type|name|value|cssText|display|background|color|width|height|cursor|opacity|transform|transition|filter|fontSize|fontWeight|fontFamily|border|borderColor|margin|padding|position|zIndex|visibility|overflow|accept|download|rel|target|method|action|encoding|responseType|lang|dir)$/.test(prop)) return true;
    if (parent.left.object && parent.left.object.property && parent.left.object.property.name === 'style') return true;
  }
  if (parent.type === 'VariableDeclarator' && parent.id && /^(url|api|endpoint|key|storageKey|selector|sel|cls|css|style|mime|re|regex|path|file|fileName|filename|ext|id|slug)$/i.test(parent.id.name)) return true;
  return false;
}

function emitText(flat, out, where) {
  // Markup or entities: the browser parses it, so read it the same way.
  if (/<[a-zA-Z!\/]/.test(flat) || /&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(flat)) { htmlPieces(flat, out, where); return; }
  // Multi-line alert/confirm text: the engine looks up the whole message and
  // then each line on its own.
  const whole = keyOf(flat);
  if (isProse(flat)) out(whole, where);
  if (flat.includes('\n')) for (const line of flat.split('\n')) if (isProse(line)) out(keyOf(line), where);
}

// ---------------------------------------------------------------- server.js
const SERVER_PROPS = /^(error|message|note|why|hint|warning|reason|title|desc|label|sub)$/;
// The statements that follow an i18n-ignore comment, as [start, end] ranges.
function ignoredRanges(ast, comments) {
  const ranges = [];
  if (!comments.some(c => IGNORE.test(c.value))) return ranges;
  const statements = [];
  (function collect(node) {
    if (!node || typeof node.type !== 'string') return;
    if (/(Statement|Declaration|Property)$/.test(node.type)) statements.push(node);
    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end') continue;
      const v = node[key];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') collect(c); }
      else if (v && typeof v.type === 'string') collect(v);
    }
  })(ast);
  statements.sort((a, b) => a.start - b.start || b.end - a.end);
  for (const c of comments) {
    if (!IGNORE.test(c.value)) continue;
    const next = statements.find(s => s.start >= c.end);
    if (next) ranges.push([next.start, next.end]);
  }
  return ranges;
}

function serverPieces(code, out) {
  const comments = [];
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true,
                                  allowHashBang: true, onComment: comments });
  const ignored = ignoredRanges(ast, comments);
  (function walk(node, parent) {
    if (!node || typeof node.type !== 'string') return;
    if (ignored.some(r => node.start >= r[0] && node.end <= r[1])) return;
    if (node.type === 'Property' && !node.computed) {
      const k = node.key.name || node.key.value;
      if (SERVER_PROPS.test(k) && hasText(node.value)) {
        const flat = flatten(node.value);
        if (isProse(flat)) out(keyOf(flat), 'server.js');
      }
      // Conditional values: error: x ? 'A' : 'B'
      if (SERVER_PROPS.test(k) && node.value.type === 'ConditionalExpression') {
        for (const b of [node.value.consequent, node.value.alternate]) if (hasText(b)) { const f = flatten(b); if (isProse(f)) out(keyOf(f), 'server.js'); }
      }
    }
    if (node.type === 'CallExpression' && /\.send$/.test(calleeName(node.callee)) && node.arguments[0] && hasText(node.arguments[0])) {
      const f = flatten(node.arguments[0]);
      if (isProse(f) && !/</.test(f)) out(keyOf(f), 'server.js');
    }
    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end') continue;
      const v = node[key];
      if (Array.isArray(v)) for (const c of v) { if (c && typeof c.type === 'string') walk(c, node); }
      else if (v && typeof v.type === 'string') walk(v, node);
    }
  })(ast, null);
}

// ---------------------------------------------------------------- driver
function collectUiStrings() {
  const map = new Map();
  const out = (text, where) => {
    if (!text || text === '%s') return;
    if (!map.has(text)) map.set(text, new Set());
    map.get(text).add(where);
  };
  const pub = path.join(ROOT, 'public');
  for (const f of fs.readdirSync(pub).sort()) {
    const p = path.join(pub, f);
    if (f.endsWith('.html')) {
      const html = fs.readFileSync(p, 'utf8');
      const doc = parse5.parse(html);
      const body = doc.childNodes.find(n => n.tagName === 'html').childNodes.find(n => n.tagName === 'body');
      (function visit(node, skip) {
        if (node.nodeName === '#text') { if (!skip && isProse(node.value, true)) out(keyOf(node.value), f); return; }
        const tag = node.tagName;
        if (tag === 'script') {
          const type = (node.attrs || []).find(a => a.name === 'type');
          const src = (node.attrs || []).find(a => a.name === 'src');
          if (!src && (!type || /javascript|module/.test(type.value)) && node.childNodes[0]) jsPieces(node.childNodes[0].value, out, f);
          return;
        }
        const noI18n = (node.attrs || []).some(a => a.name === 'data-no-i18n');
        if (!skip && !noI18n && isSentence(node)) {
          const whole = sentenceOf(node);
          if (isProse(whole, true)) out(keyOf(whole), f);
          return;
        }
        const skipHere = skip || SKIP_TAGS.has(tag) || noI18n;
        for (const a of node.attrs || []) {
          if (!skipHere && ATTRS.includes(a.name) && isProse(a.value)) out(keyOf(a.value), f);
          if (/^on[a-z]+$/.test(a.name)) jsPieces(a.value, out, f, true);
        }
        const kids = tag === 'template' && node.content ? node.content.childNodes : node.childNodes;
        for (const c of kids || []) visit(c, skipHere);
      })(body, false);
      // Scripts in <head> can still write into the body.
      const head = doc.childNodes.find(n => n.tagName === 'html').childNodes.find(n => n.tagName === 'head');
      (function visitHead(node) {
        if (node.tagName === 'script' && node.childNodes && node.childNodes[0]) {
          const type = (node.attrs || []).find(a => a.name === 'type');
          const src = (node.attrs || []).find(a => a.name === 'src');
          if (!src && (!type || /javascript|module/.test(type.value))) jsPieces(node.childNodes[0].value, out, f);
        }
        for (const c of node.childNodes || []) visitHead(c);
      })(head);
    } else if (f.endsWith('.js') && !SKIP_JS.test(f)) {
      jsPieces(fs.readFileSync(p, 'utf8'), out, f);
    }
  }
  serverPieces(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), out);
  return [...map.entries()].map(([text, set]) => ({ text, sources: [...set].sort() }))
    .sort((a, b) => a.text.localeCompare(b.text));
}

module.exports = { collectUiStrings, isProse, keyOf, normWs };

if (require.main === module) {
  const items = collectUiStrings();
  const args = process.argv.slice(2);
  if (args.includes('--json')) { process.stdout.write(JSON.stringify(items, null, 1) + '\n'); return; }
  if (args.includes('--missing')) {
    const dictPath = path.join(ROOT, 'i18n', 'manipuri.json');
    const dict = fs.existsSync(dictPath) ? JSON.parse(fs.readFileSync(dictPath, 'utf8')) : {};
    const missing = items.filter(i => !Object.prototype.hasOwnProperty.call(dict, i.text));
    for (const m of missing) console.log(JSON.stringify(m.text) + '   <- ' + m.sources.join(', '));
    console.log(`${missing.length} of ${items.length} UI strings have no Manipuri translation.`);
    return;
  }
  const byFile = {};
  for (const i of items) for (const s of i.sources) byFile[s] = (byFile[s] || 0) + 1;
  for (const [f, n] of Object.entries(byFile).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(6), f);
  console.log(items.length + ' unique UI strings.');
}
