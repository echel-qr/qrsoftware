const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
test('language switching covers DOM updates, attributes, dialogs and round trips', async () => {
  const dom = new JSDOM('<!doctype html><body><select data-i18n-select></select><p id="copy">Home</p><input id="field" placeholder="Home"><span data-no-i18n title="Home">Home</span></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window, messages = [];
  w.ECHEL_OFFLINE = true;
  w.alert = text => messages.push(text);
  w.confirm = text => { messages.push(text); return true; };
  w.prompt = (text, value) => { messages.push(text); return value; };
  w.eval(fs.readFileSync(require.resolve('../public/i18n.js'), 'utf8'));
  w.QSPi18n.addDict({ Home: 'ꯌꯨꯝ', Contact: 'ꯄꯥꯎ ꯐꯥꯎꯅꯕ' }, 'mni-mtei');
  await tick(); w.QSPi18n.setLang('mni-mtei');
  assert.equal(w.document.getElementById('copy').textContent, 'ꯌꯨꯝ');
  assert.equal(w.document.getElementById('field').placeholder, 'ꯌꯨꯝ');
  w.document.getElementById('field').placeholder = 'Contact';
  w.document.getElementById('copy').textContent = 'Contact';
  await tick();
  assert.equal(w.document.getElementById('field').placeholder, 'ꯄꯥꯎ ꯐꯥꯎꯅꯕ');
  assert.equal(w.document.getElementById('copy').textContent, 'ꯄꯥꯎ ꯐꯥꯎꯅꯕ');
  w.alert('Home'); assert.equal(w.confirm('Contact'), true); assert.equal(w.prompt('Home', 'Shop Name'), 'Shop Name');
  assert.deepEqual(messages, ['ꯌꯨꯝ', 'ꯄꯥꯎ ꯐꯥꯎꯅꯕ', 'ꯌꯨꯝ']);
  assert.equal(w.document.querySelector('[data-no-i18n]').title, 'Home');
  w.QSPi18n.setLang('en');
  assert.equal(w.document.getElementById('copy').textContent, 'Contact');
  assert.equal(w.document.getElementById('field').placeholder, 'Contact');
  assert.deepEqual([...w.document.querySelector('select').options].map(o => o.value), ['en', 'mni-mtei']);
  dom.window.close();
});

test('a data-i18n-sentence element is translated whole and restored exactly', async () => {
  const dom = new JSDOM('<!doctype html><body><h1 id="s" data-i18n-sentence>Earn <em class="x">lifetime</em> by becoming an agent</h1><p id="f">Earn <b>more</b></p></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  w.ECHEL_OFFLINE = true;
  w.eval(fs.readFileSync(require.resolve('../public/i18n.js'), 'utf8'));
  w.QSPi18n.addDict({ 'Earn lifetime by becoming an agent': 'ꯑꯦꯖꯦꯟꯠ ꯑꯣꯏꯗꯨꯅꯥ ꯄꯨꯟꯁꯤ ꯆꯨꯞꯅꯥ ꯁꯦꯜ ꯐꯪꯎ', Earn: 'ꯁꯦꯜ ꯐꯪꯎ' }, 'mni-mtei');
  await tick(); w.QSPi18n.setLang('mni-mtei');
  const h = w.document.getElementById('s');
  assert.equal(h.textContent, 'ꯑꯦꯖꯦꯟꯠ ꯑꯣꯏꯗꯨꯅꯥ ꯄꯨꯟꯁꯤ ꯆꯨꯞꯅꯥ ꯁꯦꯜ ꯐꯪꯎ');
  // Unmarked text keeps the piece-by-piece behaviour.
  assert.equal(w.document.getElementById('f').innerHTML, 'ꯁꯦꯜ ꯐꯪꯎ <b>more</b>');
  // A script rewrites the sentence while Manipuri is on: it is looked up again.
  h.innerHTML = 'Earn <em>lifetime</em> by becoming an agent';
  await tick();
  assert.equal(h.textContent, 'ꯑꯦꯖꯦꯟꯠ ꯑꯣꯏꯗꯨꯅꯥ ꯄꯨꯟꯁꯤ ꯆꯨꯞꯅꯥ ꯁꯦꯜ ꯐꯪꯎ');
  w.QSPi18n.setLang('en');
  assert.equal(h.innerHTML, 'Earn <em>lifetime</em> by becoming an agent');
  assert.equal(w.document.getElementById('f').innerHTML, 'Earn <b>more</b>');
  dom.window.close();
});

test('a sentence with links keeps them, moved to the Manipuri word order', async () => {
  const dom = new JSDOM('<!doctype html><body><p id="s" data-i18n-sentence>To confirm, type <b data-no-i18n>DELETE</b> below. Or go to <a id="go" href="/settings">Settings</a>.</p></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  w.ECHEL_OFFLINE = true;
  w.eval(fs.readFileSync(require.resolve('../public/i18n.js'), 'utf8'));
  w.QSPi18n.addDict({
    'To confirm, type {1} below. Or go to {2}.': 'ꯆꯨꯝꯅꯥ ꯂꯧꯅꯕꯥ ꯃꯈꯥꯗꯥ {1} ꯏꯕꯤꯌꯨ꯫ ꯅꯠꯇ꯭ꯔꯒꯥ {2} ꯗꯥ ꯆꯠꯂꯨ꯫',
    Settings: 'ꯁꯦꯇꯤꯡ',
  }, 'mni-mtei');
  const link = w.document.getElementById('go');
  let clicks = 0;
  link.addEventListener('click', e => { e.preventDefault(); clicks++; });
  await tick(); w.QSPi18n.setLang('mni-mtei');
  const p = w.document.getElementById('s');
  assert.equal(p.textContent, 'ꯆꯨꯝꯅꯥ ꯂꯧꯅꯕꯥ ꯃꯈꯥꯗꯥ DELETE ꯏꯕꯤꯌꯨ꯫ ꯅꯠꯇ꯭ꯔꯒꯥ ꯁꯦꯇꯤꯡ ꯗꯥ ꯆꯠꯂꯨ꯫');
  // The same link element — its address and its click handler — is still there.
  assert.strictEqual(p.querySelector('a'), link);
  assert.equal(link.getAttribute('href'), '/settings');
  link.click(); assert.equal(clicks, 1);
  // A number inside the sentence changes while Manipuri is on.
  p.querySelector('b').textContent = 'DELETE';
  await tick();
  assert.equal(p.textContent, 'ꯆꯨꯝꯅꯥ ꯂꯧꯅꯕꯥ ꯃꯈꯥꯗꯥ DELETE ꯏꯕꯤꯌꯨ꯫ ꯅꯠꯇ꯭ꯔꯒꯥ ꯁꯦꯇꯤꯡ ꯗꯥ ꯆꯠꯂꯨ꯫');
  w.QSPi18n.setLang('en');
  assert.equal(p.innerHTML, 'To confirm, type <b data-no-i18n="">DELETE</b> below. Or go to <a id="go" href="/settings">Settings</a>.');
  dom.window.close();
});

test('a sentence entry that loses a link marker is not used', async () => {
  const dom = new JSDOM('<!doctype html><body><p id="s" data-i18n-sentence>Go to <a href="/x">Settings</a> now</p></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  w.ECHEL_OFFLINE = true;
  w.eval(fs.readFileSync(require.resolve('../public/i18n.js'), 'utf8'));
  w.QSPi18n.addDict({ 'Go to {1} now': 'ꯍꯧꯖꯤꯛ ꯆꯠꯂꯨ' }, 'mni-mtei');   // {1} forgotten
  await tick(); w.QSPi18n.setLang('mni-mtei');
  const p = w.document.getElementById('s');
  assert.ok(p.querySelector('a'), 'the link must never disappear');
  dom.window.close();
});
