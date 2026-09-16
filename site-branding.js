'use strict';

const BRAND_DEFAULTS = Object.freeze({
  brandName: 'Echel', tagline: 'Smart printing. Simply connected.',
  logoUrl: '/img/echel-logo.jpeg', supportEmail: 'helpdesk@echel.co.in', supportPhone: '7011482679',
  whatsapp: '7011482679', address: '', businessHours: '', instagram: 'https://www.instagram.com/echel_computer', facebook: 'https://www.facebook.com/support.echel',
  youtube: 'https://www.youtube.com/@echel_computer', linkedin: '', twitter: '', telegram: '', mapsUrl: 'https://maps.app.goo.gl/AXpG8uf3CopYu68x5', setupVideoUrl: '',
  showStats: false, partners: []
});

const PLAN_FEATURE_DEFAULTS = Object.freeze({
  planDemo:['Demo print software','Personalised shop QR code','24 hours · 10 prints','Setup guide included'],
  planStarter:['Automatic print software','Personalised shop QR code','Unlimited prints','Connect 2 printers · B&W and colour','Setup assistance','WhatsApp support'],
  planPro:['Everything in Starter','Advanced printing · Duplex, 4×6 photos, A3 and resumes','Connect 5 printers','Payment gateway setup assistance','Technical support','Remote setup assistance'],
  planPremium:['Everything in Pro','Smart Scanner included','All future features included','Connect 5 printers','Priority support'],
  planDemoMtei:['ꯗꯦꯃꯣ ꯄ꯭ꯔꯤꯟꯠ ꯁꯣꯐꯠꯋꯦꯌꯔ','ꯁꯣꯞꯀꯤ QR ꯀꯣꯗ','ꯄꯨꯡ 24 · ꯄ꯭ꯔꯤꯟꯠ 10','ꯁꯦꯠꯑꯞ ꯂꯝꯖꯤꯡ ꯌꯥꯎꯔꯤ'],
  planStarterMtei:['ꯃꯊꯟꯇꯅꯥ ꯄ꯭ꯔꯤꯟꯠ ꯇꯧꯕꯒꯤ ꯁꯣꯐꯠꯋꯦꯌꯔ','ꯁꯣꯞꯀꯤ QR ꯀꯣꯗ','ꯑꯄꯅꯕꯥ ꯂꯩꯇꯅꯥ ꯄ꯭ꯔꯤꯟꯠ ꯇꯧꯕꯥ','ꯄ꯭ꯔꯤꯟꯇꯔ 2 ꯁꯝꯅꯕꯥ · ꯑꯃꯨꯕꯥ-ꯑꯉꯧꯕꯥ ꯑꯃꯁꯨꯪ ꯃꯆꯨ','ꯁꯦꯠꯑꯞꯀꯤ ꯃꯇꯦꯡ','WhatsApp ꯃꯇꯦꯡ'],
  planProMtei:['Starter ꯒꯤ ꯐꯤꯆꯔ ꯄꯨꯝꯅꯃꯛ','ꯑꯦꯗꯚꯥꯟꯁ ꯄ꯭ꯔꯤꯟꯠ · Duplex, 4×6, A3 ꯑꯃꯁꯨꯪ ꯔꯤꯖꯨꯃꯦ','ꯄ꯭ꯔꯤꯟꯇꯔ 5 ꯁꯝꯅꯕꯥ','ꯄꯦꯃꯦꯟꯠ ꯒꯦꯠꯋꯦ ꯁꯦꯠꯑꯞꯀꯤ ꯃꯇꯦꯡ','ꯇꯦꯛꯅꯤꯀꯦꯜ ꯃꯇꯦꯡ','ꯔꯤꯃꯣꯠ ꯁꯦꯠꯑꯞꯀꯤ ꯃꯇꯦꯡ'],
  planPremiumMtei:['Pro ꯒꯤ ꯐꯤꯆꯔ ꯄꯨꯝꯅꯃꯛ','Smart Scanner ꯌꯥꯎꯔꯤ','ꯃꯇꯨꯡꯗꯥ ꯂꯥꯛꯀꯗꯕꯥ ꯐꯤꯆꯔ ꯄꯨꯝꯅꯃꯛ ꯌꯥꯎꯔꯤ','ꯄ꯭ꯔꯤꯟꯇꯔ 5 ꯁꯝꯅꯕꯥ','ꯍꯥꯟꯅꯥ ꯃꯇꯦꯡ ꯄꯥꯡꯕꯥ']
});

function safeUrl(value, local = false) {
  if (!value) return '';
  if (local && /^\/(?!\/)[A-Za-z0-9/_ .%-]+$/.test(value)) return value;
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : '';
  } catch (_) { return ''; }
}

function validateBranding(body) {
  const out = {};
  for (const key of Object.keys(BRAND_DEFAULTS)) {
    if (!(key in body) || ['showStats', 'partners'].includes(key)) continue;
    if (typeof body[key] !== 'string') throw new Error(key + ' must be text');
    const value = body[key].trim();
    if (value.length > (key === 'address' ? 600 : 300)) throw new Error(key + ' is too long');
    out[key] = value;
  }
  if ('brandName' in out && !out.brandName) throw new Error('Brand name is required');
  if (out.supportEmail && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(out.supportEmail)) throw new Error('Enter a valid support email');
  for (const key of ['supportPhone', 'whatsapp']) {
    if (out[key] && !/^\+?[\d ()-]{7,24}$/.test(out[key])) throw new Error('Enter a valid ' + key + ' number');
  }
  const socials = { instagram: 'https://instagram.com/', facebook: 'https://facebook.com/', youtube: 'https://youtube.com/@', linkedin: 'https://linkedin.com/in/', twitter: 'https://x.com/', telegram: 'https://t.me/' };
  for (const [key, base] of Object.entries(socials)) {
    if (!out[key]) continue;
    let value = out[key];
    if (!/^https?:\/\//i.test(value)) {
      if (/:|^\/\//.test(value)) throw new Error(key + ' must use an https:// link');
      value = value.includes('.') ? 'https://' + value : base + value.replace(/^@/, '');
    }
    out[key] = safeUrl(value);
    if (!out[key]) throw new Error('Enter a valid ' + key + ' link');
  }
  for (const key of ['logoUrl', 'mapsUrl', 'setupVideoUrl']) {
    if (out[key] && !safeUrl(out[key], key === 'logoUrl')) throw new Error('Enter a valid ' + key + ' URL');
  }
  if (out.setupVideoUrl) {
    const u = new URL(out.setupVideoUrl);
    if (!['youtube.com', 'www.youtube.com', 'youtu.be', 'www.youtube-nocookie.com'].includes(u.hostname)) throw new Error('Setup video must be a YouTube link');
  }
  return out;
}

function withBrandDefaults(config = {}) {
  return { ...BRAND_DEFAULTS, ...PLAN_FEATURE_DEFAULTS, ...config, texts: {}, partners: [] };
}

module.exports = { BRAND_DEFAULTS, PLAN_FEATURE_DEFAULTS, safeUrl, validateBranding, withBrandDefaults };
