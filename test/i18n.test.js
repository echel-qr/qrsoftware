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
