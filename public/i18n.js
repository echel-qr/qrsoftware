/* ═══════════════════════════════════════════════════════════════
   i18n.js — the website's language engine.

   The HTML and JavaScript source is written in ENGLISH. English needs no
   dictionary: when English is selected the page is left exactly as written.

   Manipuri (Meitei Mayek) comes from /i18n/mni-mtei.js, a dictionary of
   { "English text": "Manipuri text" } built from i18n/manipuri.json.
   It is downloaded only when a visitor chooses Manipuri, so English
   visitors never pay for it.

   How translation works:
     - every text node and the placeholder / title / aria-label / alt
       attributes are looked up by their English text (whitespace collapsed)
     - a MutationObserver translates content that scripts add later
     - alert(), confirm() and prompt() are wrapped, because dialogs are not
       part of the DOM
     - keys may contain %s (any text) or %d (a number) for text that is
       built at runtime, e.g. "%s files loaded" matches "3 files loaded"
     - anything without a translation stays in English
     - an element marked data-i18n-sentence is translated as one sentence,
       for text split by <b>/<em> ("Earn <em>lifetime</em> by …")
     - elements marked data-no-i18n are never touched
     - switching back to English restores the original text

   Superadmin → Languages can override any entry without a deploy; those
   rows come from /api/i18n/dict and are merged on top of the bundled file.
   ═══════════════════════════════════════════════════════════════ */
(function (w, d) {
  'use strict';

  var SRC_LANG  = 'en';            // the language the source is written in
  var STORE_KEY = 'qsp_lang';
  var ATTRS     = ['placeholder', 'title', 'aria-label', 'alt'];

  // Each language is listed in its own script, so people recognise it.
  var LANGS = { en: 'English', 'mni-mtei': 'ꯃꯤꯇꯩꯂꯣꯟ' };

  // Correct code for <html lang=""> (screen readers and search engines).
  var HTML_LANG = { en: 'en', 'mni-mtei': 'mni-Mtei' };

  var DICTS   = {};                 // lang -> { english: translation }
  var loading = {};                 // lang -> true while its file is loading

  var dict     = {};                // the dictionary currently applied
  var lang     = SRC_LANG;
  var origText = new WeakMap();     // text node -> original English string
  var origAttr = new WeakMap();     // element   -> { attr: original English }
  var observer = null;
  var touched  = false;             // has any translation been applied yet?

  function getSaved() {
    try {
      var v = localStorage.getItem(STORE_KEY);
      return LANGS[v] ? v : SRC_LANG;   // unknown/legacy value => English
    } catch (e) { return SRC_LANG; }
  }
  function saveLang(l) { try { localStorage.setItem(STORE_KEY, l); } catch (e) {} }

  // The language dropdown itself: every language stays written in its own
  // script ("English", "ꯃꯤꯇꯩꯂꯣꯟ"), otherwise nobody can find their language.
  function isLangSelect(el) {
    if (el.tagName !== 'SELECT') return false;
    return el.id === 'langSel' ||
           (el.hasAttribute && el.hasAttribute('data-i18n-select')) ||
           (' ' + (el.className || '') + ' ').indexOf(' qsp-lang-sel ') !== -1;
  }

  // Never translate inside these tags/attributes — code and URLs must stay intact.
  function skip(node) {
    var p = node.parentNode;
    while (p && p.nodeType === 1) {
      var t = p.tagName;
      if (t === 'SCRIPT' || t === 'STYLE' || t === 'TEXTAREA' || t === 'CODE' || t === 'PRE') return true;
      if (p.hasAttribute && p.hasAttribute('data-no-i18n')) return true;
      if (t === 'SELECT' && isLangSelect(p)) return true;
      p = p.parentNode;
    }
    return false;
  }

  // ── LOOKUP ──
  // 1. exact key
  // 2. the same key with whitespace collapsed (HTML paragraphs span lines)
  // 3. numeric templates: "%d files loaded"
  // 4. text templates:    "Could not load %s:"
  function normWs(s) { return s.replace(/\s+/g, ' ').trim(); }
  function normNum(s) { return s.replace(/\d+(?:[.,]\d+)?/g, '%d'); }
  function countSlots(s) { return (s.match(/%[sd]/g) || []).length; }
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  var flatIndex = null, numIndex = null, patIndex = null;

  function buildFlatIndex() {
    flatIndex = {};
    for (var k in dict) {
      if (!dict.hasOwnProperty(k)) continue;
      var f = normWs(k);
      if (f !== k && flatIndex[f] === undefined) flatIndex[f] = dict[k];
    }
  }

  function buildNumIndex() {
    numIndex = {};
    for (var k in dict) {
      if (!dict.hasOwnProperty(k) || k.indexOf('%d') === -1) continue;
      // Normalise both sides so the numbers and slots line up in order.
      var nk = normNum(k), nv = normNum(dict[k]);
      numIndex[nk] = (countSlots(nk) === countSlots(nv)) ? nv : dict[k];
    }
  }

  function buildPatIndex() {
    patIndex = [];
    var keys = [];
    for (var k in dict) {
      if (!dict.hasOwnProperty(k) || k.indexOf('%s') === -1) continue;
      keys.push(k);
    }
    // Longer (more specific) patterns first — otherwise a short pattern
    // matches first and swallows too much text.
    keys.sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i], val = dict[key];
      var order = key.match(/%[sd]/g) || [];
      // %s may also be empty — names/brands are sometimes blank.
      var src = esc(key)
        .replace(/%s/g, '([\\s\\S]*?)')
        .replace(/%d/g, '(\\d+(?:[.,]\\d+)?)');
      var vSlots = (val.match(/%[sd]/g) || []).length;
      try {
        patIndex.push({ re: new RegExp('^' + src + '$'), val: val, fill: (order.length === vSlots) });
      } catch (e) { /* a key that is not regex-safe is skipped */ }
    }
  }

  // Scanning every pattern on every mutation is expensive — remember answers.
  // The prefix keeps keys such as "__proto__" from breaking the object.
  var memo = null, memoN = 0;
  function resetIndexes() { numIndex = null; patIndex = null; flatIndex = null; memo = null; memoN = 0; }
  function memoGet(k) { return memo ? memo['\u0001' + k] : undefined; }
  function memoSet(k, v) {
    if (!memo || memoN > 4000) { memo = {}; memoN = 0; }   // bounded memory
    memo['\u0001' + k] = v; memoN++;
    return v;
  }

  // Never read dict[key] directly — text such as "constructor" would return
  // an Object prototype member. hasOwnProperty returns only our own keys.
  var owns = Object.prototype.hasOwnProperty;
  function ownGet(o, k) { return owns.call(o, k) ? o[k] : undefined; }

  function lookup(key) {
    var hit = ownGet(dict, key);
    if (hit) return hit;

    var cached = memoGet(key);
    if (cached !== undefined) return cached;

    var flat = normWs(key);
    if (flat !== key) {
      var fh = ownGet(dict, flat);
      if (fh) return memoSet(key, fh);
    }
    if (flatIndex === null) buildFlatIndex();
    var fi = ownGet(flatIndex, flat);
    if (fi) return memoSet(key, fi);

    if (numIndex === null) buildNumIndex();
    var norm = normNum(flat);
    if (norm !== flat) {
      var tpl = numIndex[norm];
      if (tpl) {
        var nums = flat.match(/\d+(?:[.,]\d+)?/g) || [];
        var i = 0;
        return memoSet(key, tpl.replace(/%d/g, function (whole) {
          return (i < nums.length) ? nums[i++] : whole;
        }));
      }
    }

    if (patIndex === null) buildPatIndex();
    if (patIndex.length && flat.length <= 2000) {
      for (var p = 0; p < patIndex.length; p++) {
        var m = flat.match(patIndex[p].re);
        if (!m) continue;
        var val = patIndex[p].val;
        if (!patIndex[p].fill) return memoSet(key, val);
        var j = 1;
        return memoSet(key, val.replace(/%[sd]/g, function (whole) {
          return (j < m.length) ? m[j++] : whole;
        }));
      }
    }
    return memoSet(key, null);
  }

  // ── WHOLE SENTENCES ──
  // "Earn <em>lifetime</em> by becoming an agent" is three text nodes. Each
  // piece translated on its own gives the wrong word order, because Manipuri
  // puts the verb last. An element marked data-i18n-sentence is therefore
  // looked up by its whole text, and — when a translation exists — its
  // content is replaced by that one sentence (the emphasis is dropped in
  // Manipuri only). Its original English nodes are kept and put back when the
  // visitor switches to English.
  var SENTENCE = '[data-i18n-sentence]';
  var origKids = new WeakMap();     // sentence element -> its original child nodes
  var ownText  = new WeakSet();     // text nodes the engine wrote for a sentence

  function sentenceKey(nodes) {
    var s = '';
    for (var i = 0; i < nodes.length; i++) s += nodes[i].textContent;
    return normWs(s);
  }

  function restoreSentence(el) {
    var kids = origKids.get(el);
    if (!kids) return;
    el.textContent = '';
    for (var i = 0; i < kids.length; i++) el.appendChild(kids[i]);
    origKids.delete(el);
  }

  function translateSentence(el) {
    if (skip({ parentNode: el })) return;
    var kids = origKids.get(el);
    // A script replaced the content since it was translated: start over.
    if (kids && !(el.childNodes.length === 1 && ownText.has(el.firstChild))) {
      origKids.delete(el);
      kids = null;
    }
    var english = kids || Array.prototype.slice.call(el.childNodes);
    var hit = lookup(sentenceKey(english));
    if (!hit) { restoreSentence(el); return; }
    if (!kids) origKids.set(el, english);
    var t = d.createTextNode(hit);
    ownText.add(t);
    el.textContent = '';
    el.appendChild(t);
  }

  function translateText(node) {
    if (ownText.has(node)) return;          // a whole sentence written by us
    if (skip(node)) return;
    var raw = origText.get(node);
    if (raw === undefined) {
      raw = node.nodeValue;
      if (!raw || !raw.trim()) return;
      origText.set(node, raw);
    }
    var key = raw.trim();
    if (!key) return;
    var hit = lookup(key);
    if (hit) {
      node.nodeValue = raw.replace(key, hit);    // keep the surrounding whitespace
    } else if (node.nodeValue !== raw) {
      node.nodeValue = raw;                       // back to the original
    }
  }

  function translateAttrs(el) {
    if (!el.getAttribute || skip({ parentNode: el })) return;
    var store = origAttr.get(el);
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      var cur = el.getAttribute(a);
      if (cur === null) continue;
      if (!store) { store = {}; origAttr.set(el, store); }
      if (store[a] === undefined) store[a] = cur;
      var key = (store[a] || '').trim();
      if (!key) continue;
      el.setAttribute(a, lookup(key) || store[a]);
    }
  }

  function walk(root) {
    if (!root) return;
    // Whole sentences first, so their pieces are not translated one by one.
    try {
      var sentences = [];
      if (root.nodeType === 1 && root.matches && root.matches(SENTENCE)) sentences.push(root);
      if (root.querySelectorAll) {
        var found = root.querySelectorAll(SENTENCE);
        for (var s = 0; s < found.length; s++) sentences.push(found[s]);
      }
      for (var k = 0; k < sentences.length; k++) translateSentence(sentences[k]);
    } catch (e) {}
    try {
      var tw = d.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
      var n, list = [];
      while ((n = tw.nextNode())) list.push(n);
      for (var i = 0; i < list.length; i++) translateText(list[i]);
    } catch (e) {}
    try {
      if (root.nodeType === 1) translateAttrs(root);
      var els = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (var j = 0; j < els.length; j++) translateAttrs(els[j]);
    } catch (e) {}
  }

  function sentenceOf(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentNode);
    return (el && el.closest) ? el.closest(SENTENCE) : null;
  }

  // Our own changes must not trigger the observer again — so it is paused.
  var observerOptions = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS };
  function withoutObserver(fn) {
    var was = observer;
    if (was) was.disconnect();
    try { fn(); } finally {
      if (was) was.observe(d.body, observerOptions);
    }
  }
  function applyAll() { withoutObserver(function () { walk(d.body); }); }

  function startObserver() {
    if (observer || !w.MutationObserver || !d.body) return;
    observer = new MutationObserver(function (muts) {
      withoutObserver(function () {
        try {
          for (var i = 0; i < muts.length; i++) {
            var m = muts[i];
            // A change inside a whole-sentence element: look the sentence up again.
            var host = (m.type !== 'attributes') && sentenceOf(m.target);
            if (host) { translateSentence(host); continue; }
            if (m.type === 'childList') {
              for (var j = 0; j < m.addedNodes.length; j++) {
                var nd = m.addedNodes[j];
                if (nd.nodeType === 3) translateText(nd);
                else if (nd.nodeType === 1) walk(nd);
              }
            } else if (m.type === 'attributes') {
              var values = origAttr.get(m.target);
              if (values) delete values[m.attributeName];
              translateAttrs(m.target);
            } else if (m.type === 'characterData') {
              var known = origText.get(m.target), now = m.target.nodeValue;
              if (known !== undefined) {
                var t = (known || '').trim();
                var tr = ownGet(dict, t);
                if (tr && now === (known || '').replace(t, tr)) continue;
              }
              origText.delete(m.target);
              translateText(m.target);
            }
          }
        } catch (e) {}
      });
    });
    observer.observe(d.body, observerOptions);
  }

  // ── FONTS ──
  // The site fonts (Plus Jakarta Sans, Inter, Space Grotesk, Syne) have no
  // Meitei Mayek glyphs and most devices do not ship a Meitei Mayek font, so
  // the web font is loaded when Manipuri is chosen — otherwise the text would
  // show as empty boxes. Latin text keeps its look.
  var SCRIPTS = {
    'mni-mtei': { range: 'U+ABC0-ABFF',
                  faces: ['Noto Sans Meetei Mayek', 'Nirmala UI'],
                  web: '/fonts/meitei.css',
                  webFamily: 'Noto Sans Meetei Mayek',
                  htmlLang: 'mni-Mtei' }
  };
  var SITE_FACES = ['Plus Jakarta Sans', 'Inter', 'Space Grotesk', 'Syne', 'Poppins'];

  var fontDone = {};
  function ensureFont(l) {
    var sc = SCRIPTS[l];
    if (!sc || fontDone[l]) return;
    fontDone[l] = true;
    try {
      var src = sc.faces.map(function (f) { return 'local("' + f + '")'; }).join(',');
      var css = '';
      for (var i = 0; i < SITE_FACES.length; i++) {
        css += '@font-face{font-family:"' + SITE_FACES[i] + '";' +
               'src:' + src + ';unicode-range:' + sc.range + ';font-display:swap;}';
      }
      if (sc.web) {
        var lk = d.createElement('link');
        lk.rel = 'stylesheet';
        lk.href = sc.web;
        lk.setAttribute('data-qsp-font-web', l);
        (d.head || d.documentElement).appendChild(lk);
        // A downloaded font is not reachable through local(), so the whole
        // page's font stack is switched for this language. Emoji come from
        // their own fonts, so those stay in the stack.
        css += 'html[lang="' + sc.htmlLang + '"] body,' +
               'html[lang="' + sc.htmlLang + '"] body *{' +
               'font-family:"' + sc.webFamily + '",' + SITE_FACES.map(function (f) {
                 return '"' + f + '"';
               }).join(',') + ',"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif' +
               '!important}';
      }
      var st = d.createElement('style');
      st.setAttribute('data-qsp-font', l);
      st.textContent = css;
      (d.head || d.documentElement).appendChild(st);
    } catch (e) {}
  }

  // ── Load a language's dictionary file (only the first time) ──
  function loadDict(l, done) {
    if (DICTS[l]) return done(true);
    if (loading[l]) {                       // someone else is already loading it
      var wait = setInterval(function () {
        if (DICTS[l]) { clearInterval(wait); done(true); }
        else if (!loading[l]) { clearInterval(wait); done(false); }
      }, 60);
      return;
    }
    loading[l] = true;
    try {
      var s = d.createElement('script');
      s.src = '/i18n/' + l + '.js';
      s.async = true;
      s.onload = function () { loading[l] = false; done(!!DICTS[l]); };
      s.onerror = function () { loading[l] = false; done(false); };
      (d.head || d.documentElement).appendChild(s);
    } catch (e) { loading[l] = false; done(false); }
  }

  function applyDict(l) {
    dict = (l === SRC_LANG) ? {} : (DICTS[l] || {});
    resetIndexes();
    if (l === SRC_LANG && !touched) return;   // nothing was ever translated
    touched = true;
    applyAll();
    startObserver();
  }

  function setLang(l) {
    if (!LANGS[l]) l = SRC_LANG;
    lang = l;
    saveLang(l);
    d.documentElement.setAttribute('lang', HTML_LANG[l] || 'en');
    ensureFont(l);

    var sels = d.querySelectorAll('select[data-i18n-select], #langSel, .qsp-lang-sel');
    for (var i = 0; i < sels.length; i++) sels[i].value = l;

    if (l === SRC_LANG || DICTS[l]) {
      applyDict(l);
    } else {
      // Keep showing the current text (English) until the file arrives.
      loadDict(l, function (okLoad) {
        if (lang !== l) return;             // the user switched again meanwhile
        if (okLoad) applyDict(l);
        else {
          try { if (w.console) w.console.warn('[i18n] could not load the ' + l + ' dictionary'); } catch (e) {}
          applyDict(SRC_LANG);
        }
      });
    }

    try { w.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang: l } })); } catch (e) {}
    loadServerDict(l);
    return l;
  }

  // Fill every language selector on the page with the available languages.
  function fillSelectors() {
    var sels = d.querySelectorAll('select[data-i18n-select], #langSel, .qsp-lang-sel');
    for (var i = 0; i < sels.length; i++) {
      var s = sels[i];
      if (s.getAttribute('data-i18n-ready')) continue;
      s.innerHTML = '';
      for (var k in LANGS) {
        if (!LANGS.hasOwnProperty(k)) continue;
        var o = d.createElement('option');
        o.value = k; o.textContent = LANGS[k];
        s.appendChild(o);
      }
      s.value = lang;
      s.setAttribute('data-i18n-ready', '1');
      s.addEventListener('change', function (e) { setLang(e.target.value); });
    }
    return sels.length;
  }

  // A page without a selector gets a small floating one.
  function ensureSelector() {
    if (d.querySelector('select[data-i18n-select], #langSel, .qsp-lang-sel')) return;
    var box = d.createElement('div');
    box.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:2147483000;opacity:.92;';
    var sel = d.createElement('select');
    sel.className = 'qsp-lang-sel';
    sel.setAttribute('aria-label', 'Language');
    sel.style.cssText = 'border:1.5px solid #d9d4cc;border-radius:10px;padding:6px 9px;font-size:12px;font-weight:700;background:#fff;color:#111;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.12);';
    box.appendChild(sel);
    (d.body || d.documentElement).appendChild(box);
  }

  // ── Database overrides (Superadmin → "🌐 Languages") ──
  // They are merged on top of the bundled dictionary so any string can be
  // corrected from the panel without a new deploy. If the request fails
  // (old server, no network) nothing breaks — the bundled file still works.
  var fetched = {};
  function loadServerDict(l) {
    if (w.ECHEL_OFFLINE || l === SRC_LANG || fetched[l] || !w.fetch) return;
    fetched[l] = true;
    try {
      w.fetch('/api/i18n/dict?lang=' + encodeURIComponent(l))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (res) {
          if (!res || !res.dict) return;
          var target = DICTS[l] || (DICTS[l] = {});
          var n = 0;
          for (var k in res.dict) if (res.dict.hasOwnProperty(k)) { target[k] = res.dict[k]; n++; }
          if (!n) return;
          resetIndexes();
          if (lang === l) applyDict(l);
        })
        .catch(function () {});
    } catch (e) {}
  }

  // A dictionary file that ran before the engine (a page that includes it
  // directly, or the offline desktop panel) leaves its entries in a queue.
  function drainPending() {
    var q = w.QSP_PENDING_DICTS;
    if (!q || !q.length) return;
    for (var i = 0; i < q.length; i++) {
      var l = q[i][0], obj = q[i][1];
      if (!LANGS[l] || l === SRC_LANG || !obj) continue;
      var target = DICTS[l] || (DICTS[l] = {});
      for (var k in obj) if (obj.hasOwnProperty(k)) target[k] = obj[k];
    }
    w.QSP_PENDING_DICTS = [];
    resetIndexes();
  }

  function init() {
    drainPending();
    lang = getSaved();
    // Manipuri text can also appear on an English page — Superadmin types the
    // Manipuri plan lines into a lang="mni-Mtei" box. Without the font those
    // boxes would show empty squares, so the font is loaded for them too.
    try { if (d.querySelector('[lang="mni-Mtei"]')) ensureFont('mni-mtei'); } catch (e) {}
    ensureSelector();
    fillSelectors();
    setLang(lang);
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', init);
  else init();

  // t() — for text that never enters the DOM (dialogs, server messages).
  function t(s) {
    if (!s) return s;
    var str = String(s);
    return lookup(str.trim()) || str;
  }

  // Multi-line text (WhatsApp message, dialog body) — the whole block first,
  // then each line on its own, so whatever lines are known get translated.
  function tLines(s) {
    if (s == null) return s;
    var full = lookup(String(s).trim());
    if (full) return full;
    return String(s).split('\n').map(function (line) {
      var m = line.match(/^(\s*)([\s\S]*?)(\s*)$/);
      return m ? m[1] + t(m[2]) + m[3] : t(line);
    }).join('\n');
  }

  w.QSPi18n = {
    setLang: setLang,
    getLang: function () { return lang; },
    langs: LANGS,
    refresh: applyAll,
    t: t,
    tLines: tLines,
    // addDict(obj, 'mni-mtei') adds entries to that language's dictionary.
    // /i18n/<lang>.js files call it when they load.
    addDict: function (obj, forLang) {
      if (!obj || !forLang || !LANGS[forLang] || forLang === SRC_LANG) return;
      var target = DICTS[forLang] || (DICTS[forLang] = {});
      for (var k in obj) if (obj.hasOwnProperty(k)) target[k] = obj[k];
      if (forLang === lang) applyDict(lang);
    },
    // Which dictionaries are in memory right now (for debugging)
    loaded: function () {
      var out = {};
      for (var k in DICTS) if (DICTS.hasOwnProperty(k)) out[k] = Object.keys(DICTS[k]).length;
      return out;
    }
  };
  // Short global aliases used by older code.
  w.T = t;
  w.TL = tLines;
  w.setLang = setLang;      // for old onchange="setLang(this.value)" handlers
  // Native dialogs are outside the DOM, so translate their messages here too.
  ['alert', 'confirm', 'prompt'].forEach(function (name) {
    var original = w[name];
    if (typeof original !== 'function') return;
    w[name] = function (message) {
      var args = Array.prototype.slice.call(arguments);
      args[0] = tLines(message);
      return original.apply(w, args);
    };
  });
})(window, document);
