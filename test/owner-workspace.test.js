const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');

function workspace() {
  // Execute the layout adapter alone, without making authenticated API requests.
  const html = source.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/admin' });
  const calls = [];
  Object.assign(dom.window, { navTo: key => calls.push(key), closeSide: () => {
    dom.window.document.getElementById('sideNav').classList.remove('open');
  }, doLogin: () => calls.push('login'), showSetPassword: () => calls.push('reset') });
  const original = new Map([...dom.window.document.querySelectorAll('[id]')].map(el => [el.id, el]));
  dom.window.eval(fs.readFileSync(path.join(root, 'public/echel-owner.js'), 'utf8'));
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return { dom, doc: dom.window.document, original, calls };
}

test('owner redesign preserves the original form, status and data nodes', () => {
  const { dom, doc, original } = workspace();
  for (const id of ['loginShopId','loginPassword','loginBtn','capRow','setPasswordSection',
    'pauseBtn','noticeInput','adminShopName','todayPrints','todayEarn','totalOrders',
    'totalEarn','bkRows','dlInstallBtn','setName','adminQrImg','adminQrUrl']) {
    assert.strictEqual(doc.getElementById(id), original.get(id), id + ' must retain its event/data identity');
    assert.equal(doc.querySelectorAll('#'+id).length, 1, 'No duplicate ' + id);
  }
  assert.equal(doc.querySelector('.owner-metrics #todayPrints')?.id, 'todayPrints');
  assert.equal(doc.querySelector('.owner-rail #pauseBtn')?.id, 'pauseBtn');
  assert.equal(doc.querySelector('.owner-main-column #bkRows')?.id, 'bkRows');
  assert.equal(doc.querySelectorAll('.owner-navigation [data-nav="review"]').length, 0);
  // The Advance Feature is part of this edition: every shop reaches the tab,
  // whether it has unlocked the feature or not.
  assert.equal(doc.querySelectorAll('.owner-navigation [data-nav="advance"]').length, 1);
  assert.equal(doc.querySelectorAll('[data-sect="advance"]').length, 1);
  dom.window.close();
});

test('all five printers are chosen in the Printer Setup tab, and only there', () => {
  const { dom, doc } = workspace();
  const setup = doc.querySelector('[data-sect="printers"]');
  assert.ok(setup, 'the Printer Setup section exists');
  for (const id of ['setPrinterBW','setPrinterColor','setPrinter4x6','setPrinterA3','setPrinterDuplex']) {
    assert.equal(doc.querySelectorAll('#'+id).length, 1, 'No duplicate ' + id);
    assert.ok(setup.contains(doc.getElementById(id)), id + ' belongs to Printer Setup');
  }
  // Settings keeps the printer MODEL, Advance keeps duplex on/off and the rates.
  for (const sect of ['settings','advance']) {
    const left = doc.querySelectorAll('[data-sect="'+sect+'"] select[id^="setPrinter"]:not(#setPrinter)');
    assert.equal(left.length, 0, 'no printer choice left in ' + sect);
  }
  assert.ok(doc.querySelector('[data-sect="settings"] #setPrinter'), 'the printer model stays in Settings');
  assert.ok(doc.querySelector('[data-sect="advance"] #setDuplexMode'), 'duplex on/off stays in Advance');
  assert.ok(doc.querySelector('[data-sect="advance"] #setPriceA3Bw'), 'big-size rates stay in Advance');
  // The tab sits right after Settings.
  const tabs = [...doc.querySelectorAll('.owner-navigation [data-nav]')].map(b => b.dataset.nav);
  assert.equal(tabs[tabs.indexOf('settings') + 1], 'printers');
  dom.window.close();
});

test('printer lists are rebuilt, not doubled, every time the panel reloads', async () => {
  // Saving reloads the panel, which fills the five lists again.
  const fill = source.match(/async function loadColorPrinterDropdowns[\s\S]*?\n}\n/)[0];
  const { dom } = workspace();
  const w = dom.window;
  w.authToken = 'test';
  w.fetch = async () => ({ json: async () => ({ printers: ['HP LaserJet', 'Canon G2010'] }) });
  w.eval(fill);
  await w.loadColorPrinterDropdowns('HP LaserJet', '', '', 'Old A3', '');
  await w.loadColorPrinterDropdowns('HP LaserJet', '', '', 'Old A3', '');
  const values = id => [...w.document.getElementById(id).options].map(o => o.value);
  assert.deepEqual(values('setPrinterBW'), ['', 'HP LaserJet', 'Canon G2010']);
  assert.equal(w.document.getElementById('setPrinterBW').value, 'HP LaserJet');
  // A saved printer that is not connected right now still shows, once.
  assert.deepEqual(values('setPrinterA3'), ['', 'HP LaserJet', 'Canon G2010', 'Old A3']);
  // No list from the server: every saved printer still shows, so a save keeps it.
  w.fetch = async () => { throw new Error('offline'); };
  await w.loadColorPrinterDropdowns('HP LaserJet', 'Canon G2010', 'Photo One', 'Old A3', 'Duplex One');
  assert.equal(w.document.getElementById('setPrinter4x6').value, 'Photo One');
  assert.equal(w.document.getElementById('setPrinterDuplex').value, 'Duplex One');
  assert.deepEqual(values('setPrinterColor'), ['', 'Canon G2010']);
  dom.window.close();
});

test('quick actions, password visibility and keyboard sign-in work', () => {
  const { dom, doc, calls } = workspace();
  doc.querySelector('[data-owner-nav="orders"]').click();
  doc.querySelector('[data-owner-nav="qr"]').click();
  doc.querySelector('[data-owner-nav="settings"]').click();
  doc.getElementById('ownerShowPassword').click();
  assert.equal(doc.getElementById('loginPassword').type, 'text');
  doc.getElementById('ownerShowPassword').click();
  assert.equal(doc.getElementById('loginPassword').type, 'password');
  doc.getElementById('loginPassword').dispatchEvent(new dom.window.KeyboardEvent('keydown', {key:'Enter'}));
  doc.querySelector('#loginScreen .help-text a').dispatchEvent(new dom.window.KeyboardEvent('keydown', {key:'Enter'}));
  assert.deepEqual(calls, ['orders','qr','settings','login','reset']);
  dom.window.close();
});

test('mobile drawer closes from its control and Escape, returning keyboard focus', () => {
  const { dom, doc } = workspace();
  const side = doc.getElementById('sideNav');
  side.classList.add('open'); doc.querySelector('.owner-close').click();
  assert.equal(side.classList.contains('open'), false);
  assert.strictEqual(doc.activeElement, doc.querySelector('.hamburger'));
  side.classList.add('open'); doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key:'Escape'}));
  assert.equal(side.classList.contains('open'), false);
  dom.window.close();
});

test('all new login and workspace copy is present in the Manipuri dictionary', () => {
  const { dom, doc } = workspace();
  // One dictionary for the whole product: i18n/manipuri.json, which
  // npm run i18n:build turns into public/i18n/mni-mtei.js.
  const dict = JSON.parse(fs.readFileSync(path.join(root, 'i18n/manipuri.json'), 'utf8'));
  for (const container of doc.querySelectorAll('.owner-login-intro,.owner-form-heading,.owner-quick,.owner-register,.owner-password-option')) {
    const walker = doc.createTreeWalker(container, dom.window.NodeFilter.SHOW_TEXT);
    let node;
    while ((node=walker.nextNode())) {
      const text=node.textContent.trim();
      if (/[a-z]/i.test(text)) assert.ok(dict[text], 'Missing Manipuri: '+text);
    }
  }
  dom.window.close();
});
