/* Everything a visitor, a shop owner or a link preview shows must be Echel.
   The product started as a copy of another brand; its pictures, file names
   and colours are checked here so none of them can come back unnoticed. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const pub = path.join(root, 'public');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const SHARE_IMAGE = 'https://echel.in/img/echel-share.png';

// Fingerprints of the previous brand's pictures (share image, icons, poster, logo).
const OLD_BRAND_IMAGES = new Set([
  '7ae067f7001784760cb9a9b5074f19245f727e819b6b8b5f49c59797fd99f49e',
  'e6f13dcf003e0a9cda7b81fa5930cfc9ee3a68747f180d7a0f66b08a2d2c1f01',
  'fba338aca2fba8a98f6a64d1b29d5ad1c5b72f5b1aa87909f0c4c390999b6467',
  '7871ed994d0c049f0e70744554dad0b852807c0e4ef08d65f8e62edac13dcf4b',
  '05f449261a1d976318cbb4af70ee2b72a309291b45fe55d612af1730ec0721b0',
  '95d70fb130b668a8892d21c9f800fe2be0b543997aa4a88835dabe0170c2fb26',
]);

function pngSize(file) {
  const b = fs.readFileSync(path.join(pub, file));
  assert.equal(b.toString('latin1', 1, 4), 'PNG', file + ' must be a PNG');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function meta(html, key) {
  const m = html.match(new RegExp('<meta\\s+(?:property|name)="' + key.replace(/:/g, '\\:') + '"\\s+content="([^"]*)"', 'i'));
  return m && m[1];
}

test('link previews show the Echel share image on every page people share', () => {
  assert.deepEqual(pngSize('img/echel-share.png'), [1200, 630]);
  const shared = ['index.html', 'register.html', 'customer.html', 'agent.html', 'resume.html', 'admin.html'];
  for (const file of fs.readdirSync(pub).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(pub, file), 'utf8');
    if (shared.includes(file)) {
      for (const key of ['og:title', 'og:description', 'og:image', 'twitter:card'])
        assert.ok(meta(html, key), file + ' needs ' + key);
      assert.equal(meta(html, 'og:site_name'), 'Echel', file);
    }
    for (const key of ['og:image', 'og:image:secure_url', 'twitter:image'])
      if (meta(html, key) !== null) assert.equal(meta(html, key), SHARE_IMAGE, file + ' ' + key);
    if (meta(html, 'og:locale') !== null) assert.equal(meta(html, 'og:locale'), 'en_IN', file);
  }
});

test('share image, icons and poster are Echel pictures, not the old brand', () => {
  for (const file of ['img/echel-share.png', 'og-image.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'poster.jpg', 'favicon.ico']) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(pub, file))).digest('hex');
    assert.ok(!OLD_BRAND_IMAGES.has(hash), file + ' is still the old brand picture');
  }
  assert.equal(fs.existsSync(path.join(pub, 'qr-logo.png')), false, 'the old brand logo must be gone');
  assert.deepEqual(pngSize('apple-touch-icon.png'), [180, 180]);
  assert.deepEqual(pngSize('icon-192.png'), [192, 192]);
  assert.deepEqual(pngSize('icon-512.png'), [512, 512]);
  const ico = fs.readFileSync(path.join(pub, 'favicon.ico'));
  assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0], 'favicon.ico must be an icon file');
  const manifest = JSON.parse(read('public/site.webmanifest'));
  assert.deepEqual(manifest.icons.map(i => i.src).sort(), ['/icon-192.png', '/icon-512.png']);
});

test('no old brand name reaches a visitor, a shop owner or the shop computer', () => {
  const files = ['server.js', 'print_agent.py', 'agent_panel.py', 'agent_panel.html'];
  const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).forEach(d => {
    const rel = dir + '/' + d.name;
    if (d.isDirectory()) walk(rel);
    else if (/\.(html|js|css|txt|xml|json|webmanifest|svg)$/.test(d.name)) files.push(rel);
  });
  walk('public');
  for (const file of files) {
    const hit = read(file).match(/qr[ _-]?se[ _-]?print|qr-logo/i);
    assert.equal(hit, null, file + ' still names the old brand: ' + (hit && hit[0]));
  }
});

// Relative luminance (0 = black, 1 = white) of a CSS background in a rule.
function background(css, selector) {
  const start = css.indexOf(selector + '{');
  assert.ok(start >= 0, 'rule not found: ' + selector);
  const body = css.slice(start + selector.length + 1, css.indexOf('}', start));
  let value = (body.match(/background(?:-color)?:\s*([^;!}]+)/) || [])[1];
  assert.ok(value, selector + ' has no background');
  const v = value.trim().match(/^var\((--[\w-]+)\)$/);
  if (v) value = (css.match(new RegExp(v[1] + ':\\s*([^;]+)')) || [])[1];
  const hex = String(value).trim().match(/^#([0-9a-f]{6})$/i);
  assert.ok(hex, selector + ' background must be a plain colour, got ' + value);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test('the owner workspace and the desktop panel wear the light Echel colours', () => {
  const owner = read('public/echel-owner.css');
  assert.ok(background(owner, '.owner-masthead') > 0.85, 'owner masthead must be light');
  const panel = read('agent_panel.html');
  assert.ok(background(panel, '.rail') > 0.85, 'desktop panel sidebar must be light');
  // Olive and forest greens came from a design that did not match the logo.
  for (const [name, css] of [['echel-owner.css', owner], ['agent_panel.html', panel]])
    assert.doesNotMatch(css, /#(354b36|222a28|e9ede3|33432e|283f30)\b/i, name + ' uses an off-brand green');
});

/* The design this product grew out of was violet. Naming the shades one by one
   never held — a slightly different violet always slipped back in. So every
   colour that ships is measured on the colour wheel instead, and purple simply
   has no place in a brand made of red, black, white and silver. */
test('no page ships a purple', () => {
  const instagram = '#8a3ab9';        // Instagram's own gradient, on its icon
  const wheel = (r, g, b) => {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return null;
    const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: Math.round(h * 60), s: Math.round(s * 100) };
  };
  const purple = v => v && v.h >= 235 && v.h <= 310 && v.s >= 25;
  const files = [...fs.readdirSync(pub).filter(f => /\.(html|css|js)$/.test(f)).map(f => 'public/' + f), 'agent_panel.html'];
  const found = [];
  for (const file of files) {
    const text = read(file);
    for (const hex of text.match(/#[0-9a-fA-F]{6}\b/g) || []) {
      if (hex.toLowerCase() === instagram) continue;
      if (purple(wheel(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16))))
        found.push(file + ' ' + hex);
    }
    for (const colour of text.match(/rgba?\([^)]*\)/g) || []) {
      const n = colour.match(/[\d.]+/g) || [];
      if (n.length >= 3 && purple(wheel(+n[0], +n[1], +n[2]))) found.push(file + ' ' + colour.replace(/\s+/g, ''));
    }
  }
  assert.deepEqual([...new Set(found)], [], 'these colours are purple');
});

test('downloads from the owner workspace carry the Echel name', () => {
  const admin = read('public/admin.html');
  assert.match(admin, /download = 'Echel-Poster\.png'/);
  assert.match(admin, /download = 'Echel-Setup-Guide\.txt'/);
});
