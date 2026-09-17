const { CYCLES, billingCycle, subscriptionActive, validatePlanPrices, validatePricingUpdate, MONTHS_SQL, CYCLE_SQL } = require('./billing');
require('dotenv').config();
const { deploymentConfig, databaseOptions, UPLOAD_PREFIX, BRAND_PREFIX, isJobAsset, protectAppTables, APP_TABLES } = require('./deployment');
const deployment = deploymentConfig();
const express = require('express');
const cors = require('cors');
const { Pool, types: pgTypes } = require('pg');

// ⚠️ ZAROORI: price columns ab NUMERIC(10,2) hain (decimal rate ke liye).
// node-postgres NUMERIC ko by-default STRING deta hai (precision na tootey
// isliye). Uske kaaran price se hone wala har calculation aur comparison
// silently galat ho gaya tha — superadmin me shops "offline" dikhne lagi
// aur print ke baad error aane laga. Yahan parser lagakar NUMERIC ko wapas
// number bana dete hain, taaki baaki poora code pehle jaisa hi chale.
pgTypes.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));   // NUMERIC / DECIMAL

// ⚠️ ZAROORI: demo ka time se pehle khatam ho jaana — asli wajah yahi thi.
//
// Hamare saare TIMESTAMP columns "without time zone" hain aur database ka
// timezone UTC hai. Par node-postgres aise column ko SERVER PROCESS ke
// local timezone me padhta hai. Agar Render/PC ka TZ IST ho, to
// "2026-08-15 07:50" ko wo IST maan leta hai = 02:20 UTC — yaani asli
// waqt se 5.5 GHANTE PEHLE. Demo, agent online/offline, stuck job — sab
// isi se galat ho jaate hain.
//
// Yahan parser lagakar bata dete hain ki ye value UTC hai. DB ka timezone
// UTC hi hai, isliye ye 100% sahi hai — aur server ka TZ kuch bhi ho,
// hisaab kabhi nahi bigdega.
pgTypes.setTypeParser(1114, (v) => (v === null ? null : new Date(v + 'Z')));   // TIMESTAMP without tz
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const archiver = require('archiver');
const nodemailer = require('nodemailer');
const compression = require('compression');

// ── KAUN SA PRINT JOB "GINTI" ME AAYEGA ──
// Pehle sirf payment_status='paid' dekha jaata tha. Uska matlab tha ki
// jo job cancel ho gaya, abandon ho gaya ya printer par fail ho gaya
// wo bhi shop owner ki earning aur print count me jud jaata tha.
// Ab wo teeno status ginti se bahar hain — earning aur count dono me.
// (Yahan sabse upar rakha hai taaki niche ki har query ise use kar sake.)
const JOB_NOT_COUNTED = "('cancelled','abandoned','failed')";
const JOB_COUNTS = `payment_status='paid' AND COALESCE(status,'') NOT IN ${JOB_NOT_COUNTED}`;

const { BRAND_DEFAULTS, validateBranding, withBrandDefaults } = require('./site-branding');
const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = deployment.baseUrl;

// ── White-label homepage settings ──
// Monthly plan ka minimum — partner isse neeche price nahi rakh sakta.
const WL_MIN_MONTHLY = 399;

// Price decimal me bhi ho sakta hai (2.5, 1.5) — 2 decimal tak round karo.
// Galat/negative aaye to null lautao taaki purana price waisa hi rahe.
// ── BIG SIZE (A3/A2/A1) PRICING ──────────────────────────────
// Customer bada kagaz chunta hai to per-page rate alag hota hai.
// Owner ne set nahi kiya (0/blank) to normal B&W/Color rate hi lagta
// hai — isliye purani shops ka billing bilkul waisa ka waisa rehta hai.
const BIG_SIZE_PRICE_COLS = {
  a3: ['price_a3_bw', 'price_a3_color'],
  a2: ['price_a2_bw', 'price_a2_color'],
  a1: ['price_a1_bw', 'price_a1_color']
};
const BIG_SIZE_PRICE_SELECT =
  's.price_a3_bw, s.price_a3_color, s.price_a2_bw, s.price_a2_color, s.price_a1_bw, s.price_a1_color';

/** row me se paper size + color mode ka big-size rate. Set na ho to 0. */
function bigSizeRate(row, paperSize, colorMode) {
  if (!row) return 0;
  const cols = BIG_SIZE_PRICE_COLS[String(paperSize || '').toLowerCase()];
  if (!cols) return 0;
  const v = parseFloat(row[colorMode === 'color' ? cols[1] : cols[0]]);
  return (!isNaN(v) && v > 0) ? v : 0;
}
/** Paisa hamesha 2 decimal — float dust gateway par reject ho jaati hai. */
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function parsePrice(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  if (isNaN(n) || n < 0 || n > 100000) return null;
  return Math.round(n * 100) / 100;
}
// Homepage ke jo button/section partner on-off kar sakta hai.
const WL_HP_BUTTON_KEYS = ['contact','partner','agent','features','setupGuide',
                           'pricing','reviews','faq','demo','register','shopLogin'];

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLD_API_KEY = process.env.CLOUDINARY_API_KEY || '';
const CLD_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';

// (Global RAZORPAY_KEY_ID/SECRET removed — each shop now stores its own gateway credentials)

// JWT_SECRET hamesha environment variable se aana chahiye production mein.
// Agar set nahi hai to random secret generate karte hain runtime pe (sirf is
// process ke chalte rehne tak valid — restart pe sab logged out ho jayenge).
// Yeh hardcoded secret se kahin zyada safe hai.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// ═══════════════════════════════════════════════════════════════════
//  SECURITY
// ═══════════════════════════════════════════════════════════════════

// ── PASSWORD ──
// Pehle plain SHA-256 tha (bina salt). SHA-256 itna tez hai ki ek normal
// GPU crore hash per second try karta hai — DB leak hone par 4-character
// password minute bhar me khul jaata. Ab Node ka BUILT-IN scrypt use
// karte hain: har password ka apna salt, aur jaan-bujh ke slow.
// Koi naya npm package nahi chahiye (crypto Node me pehle se hai).
const PASSWORD_MAX = 200;            // isse lamba password lena hi nahi
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };   // ~16MB, ~100ms per hash

function scryptDerive(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password).slice(0, PASSWORD_MAX), salt, 32, SCRYPT_PARAMS,
      (err, dk) => err ? reject(err) : resolve(dk));
  });
}

// Format: scrypt$<salt-base64>$<hash-base64>  (~76 char, column 200 me fit)
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scryptDerive(password, salt);
  return 'scrypt$' + salt.toString('base64') + '$' + dk.toString('base64');
}

// Length barabar na ho to timingSafeEqual throw karta hai — isliye wrapper
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// PURANE (sha256) aur NAYE (scrypt) dono hash chalte hain — isi wajah se
// migration me kisi ka login nahi tootega.
async function verifyPassword(password, stored) {
  try {
    if (!stored) return false;
    const s = String(stored);
    if (s.startsWith('scrypt$')) {
      const parts = s.split('$');
      if (parts.length !== 3) return false;
      const dk = await scryptDerive(password, Buffer.from(parts[1], 'base64'));
      return safeEq(dk.toString('base64'), parts[2]);
    }
    // Legacy: 64-char hex sha256
    const legacy = crypto.createHash('sha256')
      .update(String(password).slice(0, PASSWORD_MAX)).digest('hex');
    return safeEq(legacy, s);
  } catch (e) { return false; }
}

function isLegacyHash(stored) {
  return !!stored && !String(stored).startsWith('scrypt$');
}

// Login sahi hua aur hash abhi purana hai — chupchaap scrypt me badal do.
// User ko kuch pata nahi chalta; dheere-dheere sab migrate ho jaate hain.
async function upgradeHashIfLegacy(table, idCol, idVal, storedHash, plainPassword) {
  try {
    if (!isLegacyHash(storedHash)) return;
    const fresh = await hashPassword(plainPassword);
    await pool.query(`UPDATE ${table} SET password_hash=$1 WHERE ${idCol}=$2`, [fresh, idVal]);
    console.log(`Password hash upgraded to scrypt: ${table}/${idVal}`);
  } catch (e) { console.error('hash upgrade fail:', e.message); }
}

// ── LOGIN RATE LIMIT ──
// Bina iske koi bhi ek Shop ID par unlimited password try kar sakta hai.
// In-memory hai (Render par ek hi instance chalta hai) — koi package nahi.
const loginHits = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 8;

setInterval(() => {                    // purane entries hata do (memory leak na ho)
  const now = Date.now();
  for (const [k, v] of loginHits) if (now > v.resetAt) loginHits.delete(k);
}, 5 * 60 * 1000).unref();

function loginLimiter(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket.remoteAddress || 'unknown';
  const key = ip + '|' + String(req.body?.shopId || req.body?.slug || req.body?.username || '').toLowerCase();
  const now = Date.now();
  let e = loginHits.get(key);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + LOGIN_WINDOW_MS }; loginHits.set(key, e); }
  e.count++;
  if (e.count > LOGIN_MAX) {
    const mins = Math.ceil((e.resetAt - now) / 60000);
    return res.status(429).json({ error: `Bahut zyada galat koshish. ${mins} minute baad try karo.` });
  }
  next();
}

// Login sahi ho gaya to counter reset — asli user ko dikkat na ho
function clearLoginHits(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket.remoteAddress || 'unknown';
  loginHits.delete(ip + '|' + String(req.body?.shopId || req.body?.slug || req.body?.username || '').toLowerCase());
}

if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET environment variable set nahi hai! Random secret generate kiya gaya — Render restart hone par sab logged out ho jayenge. Render mein JWT_SECRET add karo.');
}

// Setup Fee collect karne ke liye system owner (Rupesh) ki Razorpay keys.
// Yeh per-shop gateway keys se ALAG hai — yeh sirf ₹499 registration fee ke liye hai.
const SETUP_FEE_AMOUNT = parseInt(process.env.SETUP_FEE_AMOUNT || '499');
const SETUP_ACTUAL_PRICE = parseInt(process.env.SETUP_ACTUAL_PRICE || '999');
const OWNER_RAZORPAY_KEY_ID = process.env.OWNER_RAZORPAY_KEY_ID || '';
const OWNER_RAZORPAY_KEY_SECRET = process.env.OWNER_RAZORPAY_KEY_SECRET || '';

// Super Admin login (Rupesh ka khud ka panel — sabhi shops dekhne ke liye)
const SUPER_ADMIN_ID = process.env.SUPER_ADMIN_ID || '';
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || '';

if (!OWNER_RAZORPAY_KEY_ID || !OWNER_RAZORPAY_KEY_SECRET) {
  console.warn('⚠️  OWNER_RAZORPAY_KEY_ID/SECRET set nahi hai — Setup Fee payment kaam nahi karega jab tak Render mein add na karo.');
}
if (!SUPER_ADMIN_ID || !SUPER_ADMIN_PASSWORD) {
  console.warn('⚠️  SUPER_ADMIN_ID/PASSWORD set nahi hai — Super Admin login kaam nahi karega jab tak Render mein add na karo.');
}

const pool = new Pool(databaseOptions());

// ══════════════════════════════════════════════════════════════
//  ASLI CRASH BUG — 31 Aug ko yahi teen baar server girne ki wajah thi
//
//  node-postgres ka rule: Pool ke andar koi IDLE client (jo abhi kisi
//  query me busy nahi) agar apni socket par error paaye (jaise Supabase
//  ka pooler use recycle kar de, ya beech me connection reset ho jaye —
//  ECONNABORTED), to Pool us error ko khud handle nahi karta, sirf
//  'error' EVENT emit karta hai.
//
//  Is Pool par pehle KOI listener nahi tha. Node ka EventEmitter jab
//  'error' event ke liye koi listener nahi paata, to use seedha THROW
//  kar deta hai — jo ek uncaught exception ban kar POORA process crash
//  kar deta hai. Isi se "throw er; // Unhandled 'error' event" wala
//  crash aata tha, teeno baar.
//
//  Fix seedha hai: listener laga do. Idle connection ka reset hona
//  bilkul normal hai (network blip, pooler recycle) — bas use LOG karo
//  aur aage badho. pg khud us mare hue client ko pool se nikaal kar
//  agli query ke liye naya bana leta hai; kuch aur karne ki zaroorat
//  nahi hai.
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════
//  EGRESS OPTIMIZATION — polling ko Supabase se door rakhna
//
//  Agent  →  Render  →  Supabase
//                       ↑ Supabase egress SIRF yahan se lagta hai.
//
//  Agent ka Render se baat karna free hai. Paisa tab lagta hai jab Render
//  Supabase se poochta hai. Isliye maqsad ye NAHI hai ki agent kam poll
//  kare — maqsad ye hai ki Render har poll par Supabase na jaye.
// ══════════════════════════════════════════════════════════════════════

/** Kis shop ka koi job print hone ka intezaar kar raha hai. */
const shopsWithWork = new Set();

/** Demo jo khatam ho chuke — inhe DB tak jaane hi nahi dena. */
const expiredDemoShops = new Set();

/**
 * Shop ki basic info ka cache — { demo, demoExpiresAt, at }.
 * demo_expires_at ek TIMESTAMP hai, isliye expiry memory me hi check ho
 * jaati hai; iske liye baar-baar DB poochne ki zaroorat nahi.
 */
const shopInfoCache = new Map();
const SHOP_INFO_TTL_MS = 10 * 60 * 1000;

/** agent_last_seen — memory me jama karo, DB me batch me likho. */
const pendingHeartbeats = new Map();   // shopId -> { at, version, label }
const HEARTBEAT_FLUSH_MS = 2 * 60 * 1000;
const WORK_SWEEP_MS      = 20 * 1000;

// ══════════════════════════════════════════════════════════════════════
//  LONG POLLING — khuli line par intezaar
//  jobWaiters: shopId -> Set of ruki hui request. Job ready hote hi
//  markShopHasWork() inhe turant jaga deta hai.
// ══════════════════════════════════════════════════════════════════════
const jobWaiters = new Map();
const LP_MAX_SEC     = 60;
const LP_MAX_WAITERS = 2000;

function wakeJobWaiters(shopId) {
  const key = String(shopId);
  const set = jobWaiters.get(key);
  if (!set || !set.size) return;
  jobWaiters.delete(key);
  set.forEach(function (w) { w.wake(); });
}
function totalWaiters() {
  let n = 0; jobWaiters.forEach(function (s) { n += s.size; }); return n;
}
/** true = job aa gaya | false = time khatam ya line kat gayi */
function waitForWork(shopId, sec, req) {
  return new Promise(function (resolve) {
    if (totalWaiters() >= LP_MAX_WAITERS) return resolve(false);
    const key = String(shopId);
    let done = false;
    function cleanup() {
      clearTimeout(timer);
      req.removeListener('close', onClose);
      const s = jobWaiters.get(key);
      if (s) { s.delete(entry); if (!s.size) jobWaiters.delete(key); }
    }
    function finish(v) { if (done) return; done = true; cleanup(); resolve(v); }
    const timer   = setTimeout(function () { finish(false); }, sec * 1000);
    const onClose = function () { finish(false); };
    const entry   = { wake: function () { finish(true); } };
    req.on('close', onClose);
    let set = jobWaiters.get(key);
    if (!set) { set = new Set(); jobWaiters.set(key, set); }
    set.add(entry);
  });
}
/** Job ready hote hi registry me daal do — agla poll turant utha lega. */
function markShopHasWork(shopId) {
  if (!shopId) return;
  shopsWithWork.add(String(shopId));
  wakeJobWaiters(shopId);   // ruki hui request ko TURANT jagao
}

/**
 * SAFETY SWEEP — har 20 sec me EK query (sabhi shops ke liye ek hi).
 * Ye registry ko DB se milaa deti hai, taaki koi bhi job chhoot na jaye
 * chahe wo kisi bhi raaste se 'paid' bana ho, ya server restart hua ho,
 * ya ek se zyada instance chal rahe hon.
 */
async function sweepShopsWithWork() {
  try {
    const r = await pool.query(
      `SELECT DISTINCT j.shop_id
         FROM print_jobs j JOIN shops s ON j.shop_id = s.id
        WHERE j.payment_status = 'paid'
          AND COALESCE(j.status,'') IN ('queued','printing')
          AND s.setup_paid = true`);
    const fresh = new Set(r.rows.map(x => String(x.shop_id)));
    // Poori list badal do — jo yahan nahi hai uska kaam khatam ho chuka hai
    shopsWithWork.clear();
    fresh.forEach(id => shopsWithWork.add(id));
    // Sweep se naya kaam mila to ruki hui requests bhi jagao
    fresh.forEach(id => wakeJobWaiters(id));
  } catch (e) {
    // Sweep fail ho to registry ko haath mat lagao. Purani list par chalte
    // rehna surakshit hai: zyada se zyada ek extra query lagegi, job
    // atkega nahi.
    console.error('Work sweep fail (purani list par chal rahe hain):', e.message);
  }
}

/** Jama kiye hue heartbeats ek saath DB me likho. */
async function flushHeartbeats() {
  if (!pendingHeartbeats.size) return;
  const batch = [...pendingHeartbeats.entries()];
  pendingHeartbeats.clear();
  try {
    const ids   = batch.map(([id]) => id);
    const times = batch.map(([, v]) => new Date(v.at).toISOString());
    const vers  = batch.map(([, v]) => (Number.isInteger(v.version) ? v.version : null));
    const labs  = batch.map(([, v]) => v.label || null);
    await pool.query(
      `UPDATE shops s SET
         agent_last_seen     = d.seen::timestamptz,
         agent_version       = COALESCE(d.ver::int, s.agent_version),
         agent_version_label = COALESCE(d.lab, s.agent_version_label)
       FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[])
            AS d(id, seen, ver, lab)
       WHERE s.id = d.id`,
      [ids, times, vers.map(v => v === null ? null : String(v)), labs]);
  } catch (e) {
    console.error('Heartbeat flush fail:', e.message);
  }
}

/**
 * verifyAgent ka token cache. Ye middleware HAR poll par chalta tha aur
 * har baar `SELECT agent_token FROM shops` karta tha — 72 agents x har
 * 5-12 sec. Token kabhi-kabhaar hi badalta hai (disconnect par), aur
 * disconnect ke waqt hum cache khud saaf karte hain — isliye surakshit hai.
 */
const agentTokenCache = new Map();   // shopId -> { token, at, missing? }
const AGENT_TOKEN_TTL_MS = 5 * 60 * 1000;

// "Shop hai hi nahi" wala jawab bhi cache hota hai — warna deleted demo
// shop ka agent (jo hamesha poll karta rehta hai) har baar DB tak pahunch
// jaata tha. 2026-09-08 par yahi kul database traffic ka 79% tha, aur
// usme se 99% jawab khaali aate the.
//
// Gayab shop lagbhag hamesha gayab hi rehta hai, isliye 10 minute kaafi
// hai — aur agar kabhi koi anokha maamla ho to system khud theek ho
// jaayega. Disconnect par invalidateAgentToken() cache saaf karta hi hai.
const AGENT_MISS_TTL_MS = 10 * 60 * 1000;

// Map par upar ki seema. Koi random shopId spray kare to har naya id ek
// entry banata aur memory chupchaap badhti rehti. Map insertion ka kram
// rakhta hai, isliye sabse purani entry pehle nikal jaati hai.
const AGENT_CACHE_MAX = 5000;

function setAgentTokenCache(shopId, entry) {
  if (agentTokenCache.size >= AGENT_CACHE_MAX && !agentTokenCache.has(shopId)) {
    const oldest = agentTokenCache.keys().next().value;
    if (oldest !== undefined) agentTokenCache.delete(oldest);
  }
  agentTokenCache.set(shopId, entry);
}

function invalidateAgentToken(shopId) {
  if (shopId) {
    agentTokenCache.delete(String(shopId));
    shopInfoCache.delete(String(shopId));
  }
}

/** Shop ki demo info — cache se, warna ek baar DB se. */
async function getShopInfoCached(shopId) {
  const hit = shopInfoCache.get(shopId);
  if (hit && (Date.now() - hit.at) < SHOP_INFO_TTL_MS) return hit;
  const r = await pool.query('SELECT demo, demo_expires_at FROM shops WHERE id=$1', [shopId]);
  if (!r.rows.length) return null;
  const info = {
    demo: r.rows[0].demo,
    demoExpiresAt: r.rows[0].demo_expires_at,
    at: Date.now()
  };
  shopInfoCache.set(shopId, info);
  return info;
}

// Server chalu hote hi ek baar registry bhar lo, phir chalti rehne do
setTimeout(sweepShopsWithWork, 3000);
setInterval(sweepShopsWithWork, WORK_SWEEP_MS);
setInterval(flushHeartbeats, HEARTBEAT_FLUSH_MS);

pool.on('error', (err) => {
  console.error('DB pool idle-client error (server crash NAHI hoga):', err.message);
});

app.use(cors());
app.disable('x-powered-by');

// ── Dynamic response par ETag band ──
// Express har res.json() ka hash bana kar ETag lagata hai. Poll ka data
// har baar badal sakta hai, isliye agent ko 304 kabhi milta hi nahi —
// hash ka CPU aur ~35 B/response dono bekaar. Static files par ASAR NAHI:
// express.static apna alag ETag banata hai (uske options me etag:true).
app.set('etag', false); // Express ka "X-Powered-By: Express" header hata do — tech-stack fingerprint kam
// verify: raw body stash — Razorpay webhook ka signature RAW body par
// HMAC hota hai, parsed JSON par nahi
// Security headers — helmet package ki zaroorat nahi, ye headers hi kaafi hain
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // ── API par browser-only headers mat bhejo ──
  // CSP, X-Frame-Options, Permissions-Policy sirf tab kaam karte hain jab
  // BROWSER HTML render kare. JSON API response par bekaar hain — khaas
  // kar print agent ke liye, jo Python hai aur inhe padhta tak nahi.
  //
  // Ye ~900 bytes PER RESPONSE the (akela CSP 868 B). 11 lakh request/din
  // par ~1 GB/din ja raha tha, bina kisi faayde ke.
  //
  // nosniff aur HSTS phir bhi bhejte hain — wo API par bhi matlab rakhte hain.
  if (req.path.startsWith('/api/')) {
    if (req.headers['x-forwarded-proto'] === 'https')
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    return next();
  }

  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // ⚠️ camera=() ka matlab hai "camera KISI ko nahi" — khud is site ko
  // bhi nahi. Ye header browser ki site-setting se UPAR hota hai, isliye
  // Chrome me Camera "Ask first" dikhne par bhi getUserMedia turant
  // NotAllowedError deti thi aur ijazat ka popup aa hi nahi sakta tha.
  // Naye browser (Brave) me bhi wahi — kyunki rok browser me thi hi nahi.
  // Smart Scanner se pehle camera ki zaroorat nahi thi, tab ye theek tha.
  // Ab camera=(self) chahiye: sirf apni site ko ijazat, koi bhi iframe/
  // third-party ko nahi. mic aur location pehle jaise poori tarah band.
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(self)');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  // CSP — site abhi inline <script>/onclick/style bahut use karta hai (poori
  // codebase isi pattern par bani hai), isliye 'unsafe-inline' rakhna padega
  // varna sab tootega. Fir bhi ye asli faayda deta hai: koi attacker agar
  // kabhi HTML me <script src="..."> ya <iframe> ghusa de, to sirf yahi
  // listed domains se load hoga — baaki sab (jaise evil.com) block ho jayega.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com https://cdnjs.cloudflare.com https://*.cashfree.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https://res.cloudinary.com https://*.razorpay.com https://*.cashfree.com",
    "connect-src 'self' https://*.cashfree.com",
    "frame-src https://checkout.razorpay.com https://api.razorpay.com https://*.cashfree.com https://www.youtube-nocookie.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://checkout.razorpay.com https://*.cashfree.com",
    "frame-ancestors 'self'"
  ].join('; '));
  if (req.headers['x-forwarded-proto'] === 'https')
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  next();
});

// JSON body 50mb -> 2mb. File upload MULTER se hota hai (uski apni 50mb limit
// alag hai) — isliye upload par koi asar nahi. Pehle koi bhi 50mb ka JSON
// baar-baar bhej ke Render ki 512MB RAM bhar sakta tha.
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
// HTML pages HAMESHA fresh — bina iske phone Chrome purani HTML ghanton
// tak cache se dikhata hai (har push ke baad "fix nahi hua" ka asli karan).
// Sirf pages (extension-less routes + .html) — images/assets cache rehte hain.
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (!p.startsWith('/api/') && (p.endsWith('.html') || !p.slice(1).includes('.'))) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
  next();
});
// ══════════════════════════════════════════════════════════════
// BANDWIDTH — sabse bada kharcha yahi tha
//
// 1) gzip/brotli: HTML ~182 KB se ~30 KB ho jaata hai (6x kam).
//    Ek visitor = 182 KB tha, ab ~30 KB.
// 2) Cache headers: dobara aane wale visitor ko file dobara nahi
//    bhejni padti — server sirf "304 Not Modified" bhejta hai (0 bytes).
// ══════════════════════════════════════════════════════════════
app.use(compression({
  level: 6,                       // speed aur size ka balance
  threshold: 1024,                // 1 KB se chhoti cheez compress karna faaltu hai
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

app.use((req,res,next)=>{
  if (require('./echel-edition').retiredRoute(req.path)) return res.status(404).json({error:'Page not found'});
  next();
});
app.use(express.static('public', {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (/\.(js|css)$/i.test(filePath)) {
      // ⚠️ Pehle yahan 7 din (max-age=604800) tha, aur us comment me likha
      // tha ki "badal jaye to etag se pata chal jaata hai" — wo GALAT hai.
      // Plain max-age ke andar browser server se POOCHTA HI NAHI, seedha
      // apni cache se deta hai. Etag tabhi kaam aata hai jab request jaaye.
      // Nateeja: naya JS deploy karne ke baad bhi purane customer ko 7 din
      // tak PURANI file milti thi — code chala hi nahi tha.
      // Ab har baar poochhega; file na badli ho to server 304 bhejta hai
      // (0 byte), badli ho to nayi turant mil jaati hai.
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    } else if (/\.(png|jpg|jpeg|svg|ico|woff2?)$/i.test(filePath)) {
      // Image/font kabhi-kabhaar hi badalte hain — inka 7 din cache theek hai
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else if (/\.html$/i.test(filePath)) {
      // HTML — har baar check karo par badla na ho to 304 (0 bytes)
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  }
}));

// ─── Canonical host redirect ───
// Purane customers ka QR / bookmark / WhatsApp me shared link
// qr-se-print.onrender.com pe hi hai. Unko naye domain par bhejo — path,
// query string, sab as-is. Jab tak PRIMARY_HOST env na set ho, redirect
// band (staging/local pe fasne se bachne ke liye).
const PRIMARY_HOST = process.env.PRIMARY_HOST || '';
if (PRIMARY_HOST) {
  app.use((req, res, next) => {
    // API calls ko KABHI redirect nahi — 301 par POST body gir jaati hai
    // (clients POST ko GET bana dete hain) aur field ke saare agents
    // 404 khane lagte hain (printer list, complete/failed reports sab).
    if (req.path.startsWith('/api/')) return next();
    const host = (req.headers.host || '').toLowerCase().split(':')[0];
    // www.echel.in, onrender.com — sab canonical par (SEO: ek hi domain
    // rank kare, duplicate content na bane)
    // White-label subdomain (abc.echel.in) ko redirect NAHI karna —
    // warna reseller ka brand khulte hi main site par phenk deta hai.
    // www aur baaki hosts (onrender.com waghairah) pehle jaise hi redirect.
    const isWlSubdomain = PRIMARY_HOST && host.endsWith('.' + PRIMARY_HOST) && host !== 'www.' + PRIMARY_HOST;
    if (host && host !== PRIMARY_HOST && !isWlSubdomain && host !== 'localhost' && host !== '127.0.0.1') {
      return res.redirect(301, 'https://' + PRIMARY_HOST + req.originalUrl);
    }
    next();
  });
}

// ═══════════════════════════════════════════════
// ANTI-ABUSE / SECURITY LAYER
// Maqsad: koi bot Demo Creation ya Upload endpoint ko loop me maar ke
// Cloudinary uploads aur Render bandwidth na jala sake.
// Sabse zaroori rule: ye saare checks EXPENSIVE kaam (PDF processing,
// Cloudinary call) se PEHLE chalte hain — baad me nahi.
//
// Genuine customer kabhi block nahi hona chahiye. Isliye:
//   - limits udaar (generous) hain aur env se badli ja sakti hain
//   - IP akela pehchaan nahi maana jaata (mobile network ek IP share karta hai)
//   - block hamesha TEMPORARY hai, permanent ban kabhi nahi
// ═══════════════════════════════════════════════
const SEC = {
  demoIpMax:      parseInt(process.env.DEMO_RATE_LIMIT      || '3', 10),
  demoWindowMin:  parseInt(process.env.DEMO_RATE_WINDOW     || '15', 10),
  // Ek IP se 24 ghante me kitne demo. Mobile users aksar carrier NAT ke
  // peeche hote hain (ek hi public IP, hazaron log) — wahan ye limit sabko
  // rok deti hai. Isliye ab env se badla ja sakta hai, code chhede bina.
  demoDailyPerIp: parseInt(process.env.DEMO_DAILY_PER_IP    || '2', 10),
  // Itni hits (safal + fail) ke baad hi spam maan kar temporary block.
  // Honest user 3-4 baar retry karta hai — ye usse bahut upar hai.
  demoAbuseHits:  parseInt(process.env.DEMO_ABUSE_HITS      || '40', 10),
  uploadsPerDemo: parseInt(process.env.MAX_UPLOADS_PER_DEMO || '10', 10),
  uploadsPerMin:  parseInt(process.env.MAX_UPLOADS_PER_MINUTE || '12', 10),
  burstMin:       parseInt(process.env.MIN_UPLOAD_GAP_MS    || '1500', 10),
  burstStrikes:   parseInt(process.env.BURST_STRIKES        || '5', 10),
  blockMin:       parseInt(process.env.ABUSE_BLOCK_DURATION || '15', 10),
  // ── CUSTOMER (jo QR scan karta hai) ──
  // Ye SHOP wali limit se bilkul alag hain. Ek badmash customer se poori
  // dukaan band nahi honi chahiye — isliye block sirf usi customer par
  // lagta hai, shop par kabhi nahi.
  //
  // Ginti udaar hai: ek aadmi 3-4 alag file print karwa sakta hai, wo
  // aam baat hai. 6 se upar 5 minute me = koi khel raha hai.
  custJobsMax:    parseInt(process.env.CUST_JOBS_MAX     || '6', 10),
  custWindowMin:  parseInt(process.env.CUST_WINDOW_MIN   || '5', 10),
  // Device id localStorage se aati hai — incognito me har baar nayi ban
  // jaati hai. Isliye IP ka bhi ek chaura jaal, par KHOOB udaar: cyber
  // cafe ki WiFi par sab customer ek hi IP par hote hain.
  custIpMax:      parseInt(process.env.CUST_IP_MAX       || '25', 10),
  cldMaxRetries:  parseInt(process.env.MAX_CLOUDINARY_RETRIES || '3', 10),
  globalPerMin:   parseInt(process.env.GLOBAL_UPLOADS_PER_MINUTE || '120', 10),
  turnstileSecret: process.env.TURNSTILE_SECRET_KEY || '',
  turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || ''
};

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket.remoteAddress || 'unknown';
}

// ── SECURITY EVENT LOG ────────────────────────────────────────────
// DB me likhte hain taaki superadmin dekh sake, par best-effort:
// log fail ho to request kabhi fail nahi hoti.
async function logSecurityEvent(ev) {
  const line = `SECURITY EVENT | ${ev.action} | ip=${ev.ip || '-'} | demo=${ev.shopId || '-'}`
             + ` | ${ev.endpoint || '-'} | reason=${ev.reason || '-'}`
             + (ev.uploadCount != null ? ` | uploads=${ev.uploadCount}` : '');
  console.warn(line);
  try {
    await pool.query(
      `INSERT INTO security_events (ip, shop_id, endpoint, method, user_agent, action, reason, upload_count, file_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [String(ev.ip || '').slice(0,60), String(ev.shopId || '').slice(0,50),
       String(ev.endpoint || '').slice(0,120), String(ev.method || '').slice(0,10),
       String(ev.userAgent || '').slice(0,250), String(ev.action || '').slice(0,40),
       String(ev.reason || '').slice(0,200),
       Number.isFinite(ev.uploadCount) ? ev.uploadCount : null,
       Number.isFinite(ev.fileSize) ? ev.fileSize : null]);
  } catch (e) {
    console.warn('security log write skipped:', e.message);
  }
}

// ── IN-MEMORY COUNTERS ────────────────────────────────────────────
// Render par ek hi instance chalta hai, isliye in-memory kaafi hai aur
// har request par DB hit nahi hoti. Multi-instance par shift karo to
// inhe Redis/Upstash me le jaana — logic wahi rahega.
const demoIpHits   = new Map();   // ip        -> {count, resetAt}
const uploadHits   = new Map();   // shopId    -> {count, resetAt, last, strikes}
const abuseBlocks  = new Map();   // key       -> unblockAt (epoch ms)
const regPhoneHits = new Map();   // phone     -> {count, resetAt}
const custHits     = new Map();   // shop|cid  -> {count, resetAt}
const custIpHits   = new Map();   // shop|ip   -> {count, resetAt}
let   globalWindow = { count: 0, resetAt: Date.now() + 60000, tripped: false };

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of demoIpHits)  if (now > v.resetAt) demoIpHits.delete(k);
  for (const [k, v] of uploadHits)  if (now > v.resetAt + 3600000) uploadHits.delete(k);
  for (const [k, t] of abuseBlocks) if (now > t) abuseBlocks.delete(k);
  for (const [k, v] of regPhoneHits) if (now > v.resetAt) regPhoneHits.delete(k);
  for (const [k, v] of custHits)     if (now > v.resetAt) custHits.delete(k);
  for (const [k, v] of custIpHits)   if (now > v.resetAt) custIpHits.delete(k);
}, 5 * 60 * 1000).unref();

// ── PAKKA BLOCKLIST ──
// Neeche wala abuseBlocks 15 minute ka hai aur restart par mit jaata hai.
// Ye alag hai: DB me rehta hai, superadmin lagata hai, aur tab tak rehta
// hai jab tak hataya na jaye.
//
// Sirf NAYI SHOP banane aur DEMO lene par lagta hai — poori site par nahi.
// Wajah file ke sar par likhi hai (CGNAT).
//
// DB par har baar na jaana pade isliye 60 second ka cache. Block lagane/
// hatane par cache turant saaf hota hai, to superadmin ko intezaar nahi.
let _ipBanCache = { at: 0, set: new Set() };
const IP_BAN_TTL_MS = 60 * 1000;

async function bannedIps() {
  if (Date.now() - _ipBanCache.at < IP_BAN_TTL_MS) return _ipBanCache.set;
  try {
    const r = await pool.query('SELECT ip FROM blocked_ips');
    _ipBanCache = { at: Date.now(), set: new Set(r.rows.map(x => x.ip)) };
  } catch (e) {
    // DB na mile to purana cache hi chalne do — register band nahi karna.
    console.warn('blocked_ips padhi nahi ja saki:', e.message);
    _ipBanCache.at = Date.now();
  }
  return _ipBanCache.set;
}

function clearIpBanCache() { _ipBanCache = { at: 0, set: _ipBanCache.set }; }

// Customer ka pakka block — wahi tarika jo IP ke liye upar hai.
let _custBanCache = { at: 0, set: new Set() };

async function bannedCustomers() {
  if (Date.now() - _custBanCache.at < IP_BAN_TTL_MS) return _custBanCache.set;
  try {
    const r = await pool.query('SELECT cid FROM blocked_customers');
    _custBanCache = { at: Date.now(), set: new Set(r.rows.map(x => x.cid)) };
  } catch (e) {
    // DB na mile to purana cache chalne do — printing band nahi karni.
    console.warn('blocked_customers padhi nahi ja saki:', e.message);
    _custBanCache.at = Date.now();
  }
  return _custBanCache.set;
}

function clearCustBanCache() { _custBanCache = { at: 0, set: _custBanCache.set }; }

async function isCustomerBanned(cid) {
  if (!cid) return false;
  return (await bannedCustomers()).has(cid);
}

async function isIpBanned(ip) {
  if (!ip) return false;
  return (await bannedIps()).has(ip);
}

/**
 * Upload SERVER ki galti se fail hua — us shop ka burst strike wapas.
 *
 * 9 Sept ko theek yahi hua tha: amount decimal tha aur column INTEGER,
 * isliye har upload 500 deta tha. Customer baar-baar try karta raha
 * (aur karta bhi kya), aur burst detector ne use "abuse" samajh kar
 * POORI DUKAAN block kar di.
 *
 * Yaani hamari apni galti ki saza dukaan ko mili — 15 minute band.
 * Ab hamari galti par strike wapas, aur `last` bhi sifar taaki agli
 * koshish "bahut jaldi aayi" me na gine.
 *
 * Dhyaan: ye ginti KAM karta hai, block hatata nahi. Zaroorat bhi nahi —
 * shop pehle se blocked hoti to request yahan tak pahunchti hi nahi
 * (block sabse shuru me dekha jaata hai). Isliye asli flood ab bhi
 * per-minute aur quota wali limit se pakda jaata hai.
 */
function pardonUploadFailure(shopId) {
  const e = uploadHits.get(shopId);
  if (!e) return;
  if (e.strikes > 0) e.strikes--;
  e.last = 0;
  uploadHits.set(shopId, e);
}

/** Temporary block — escalating, kabhi permanent nahi. */
function blockFor(key, minutes, reason) {
  const until = Date.now() + minutes * 60 * 1000;
  const prev = abuseBlocks.get(key) || 0;
  abuseBlocks.set(key, Math.max(prev, until));
  console.warn(`SECURITY BLOCK | ${key} | ${minutes} min | ${reason}`);
}
function isBlocked(key) {
  const until = abuseBlocks.get(key);
  if (!until) return 0;
  if (Date.now() > until) { abuseBlocks.delete(key); return 0; }
  return Math.ceil((until - Date.now()) / 60000);   // minutes remaining
}

/** Demo creation: ek IP se DEMO_RATE_LIMIT per DEMO_RATE_WINDOW minutes. */
function demoRateLimit(req, res, next) {
  const ip = clientIp(req);
  // Pakka blocklist demo par bhi. Async hai isliye ek chhota wrapper —
  // baaki jaanch pehle jaisi hi chalti hai.
  isIpBanned(ip).then(banned => {
    if (!banned) return _demoRateLimitRest(req, res, next, ip);
    logSecurityEvent({ ip, endpoint: req.path, method: req.method,
                       action: 'DEMO_REQUEST', reason: 'IP_BANNED',
                       userAgent: req.headers['user-agent'] });
    res.status(403).json({ error: 'Is connection se demo band hai. Support se baat kariye.' });
  }).catch(() => _demoRateLimitRest(req, res, next, ip));
}

function _demoRateLimitRest(req, res, next, ip) {
  const mins = isBlocked('ip:' + ip);
  if (mins) {
    logSecurityEvent({ ip, endpoint: req.path, method: req.method, action: 'DEMO_REQUEST',
                       reason: 'TEMP_BLOCKED', userAgent: req.headers['user-agent'] });
    return res.status(429).json({ error: `Too many requests. Please try again in ${mins} minute(s).` });
  }
  const now = Date.now();
  let e = demoIpHits.get(ip);
  if (!e || now > e.resetAt) {
    e = { count: 0, hits: 0, resetAt: now + SEC.demoWindowMin * 60000 };
    demoIpHits.set(ip, e);
  }

  // ── Sirf bhaari spam par hi temporary block ──
  // Pehle yahan count (safal + fail sab) ke hisaab se block lagta tha, aur
  // block lagne ke baad bhi count badhta rehta tha — matlab user jitni baar
  // retry karta, block utna hi lamba hota jaata. Ab total hits ki alag ginti
  // hai aur limit itni upar hai ki honest user (3-4 retry) kabhi na chhue.
  e.hits++;
  if (e.hits > SEC.demoAbuseHits) {
    blockFor('ip:' + ip, SEC.blockMin, 'demo endpoint spam');
    logSecurityEvent({ ip, endpoint: req.path, method: req.method, action: 'DEMO_REQUEST',
                       reason: 'ABUSE_HITS', uploadCount: e.hits,
                       userAgent: req.headers['user-agent'] });
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  // ── Asli limit: kitne demo BANE, koshishein nahi ──
  // Ye sabse bada bug tha. Ginti har POST par badhti thi — chahe request
  // validation me fail ho, phone pehle se registered ho, ya captcha fail ho.
  // Matlab form 3 baar galat bharne wala aadmi 15 minute ke liye block ho
  // jaata tha, bina ek bhi demo bane. Ab ginti tabhi badhti hai jab demo
  // sach me ban jaye — handler success par req.countDemoRequest() bulata hai.
  if (e.count >= SEC.demoIpMax) {
    const wait = Math.max(1, Math.ceil((e.resetAt - now) / 60000));
    logSecurityEvent({ ip, endpoint: req.path, method: req.method, action: 'DEMO_REQUEST',
                       reason: 'IP_RATE_LIMIT', uploadCount: e.count,
                       userAgent: req.headers['user-agent'] });
    return res.status(429).json({
      error: `Is network se ${SEC.demoIpMax} demo ho chuke hain. ${wait} minute baad try karo, ya seedha register kar lo.`
    });
  }

  req.countDemoRequest = function () {
    const cur = demoIpHits.get(ip);
    if (cur) cur.count++;
  };
  next();
}

/** Cloudflare Turnstile — sirf tab enforce hota hai jab secret set ho. */
async function verifyTurnstile(token, ip) {
  if (!SEC.turnstileSecret) return { ok: true, skipped: true };   // configure nahi hai
  if (!token) return { ok: false, reason: 'missing token' };
  try {
    const body = new URLSearchParams({ secret: SEC.turnstileSecret, response: token, remoteip: ip || '' }).toString();
    const out = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'challenges.cloudflare.com', path: '/turnstile/v0/siteverify', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
      }, (resp) => {
        let d = ''; resp.on('data', c => d += c);
        resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      });
      r.on('error', reject);
      r.setTimeout(8000, () => { r.destroy(); reject(new Error('turnstile timeout')); });
      r.write(body); r.end();
    });
    return { ok: !!out.success, reason: (out['error-codes'] || []).join(',') };
  } catch (e) {
    // Cloudflare down ho to genuine users ko block mat karo — fail-open,
    // baaki saari layers (rate limit, quota, burst) waise hi lagi hain.
    console.warn('Turnstile verify failed (fail-open):', e.message);
    return { ok: true, degraded: true };
  }
}

// ═══════════════════════════════════════════════════════════════════
//  APNA CAPTCHA  — koi third party nahi (na Google, na Cloudflare)
// ═══════════════════════════════════════════════════════════════════
//
// KAAM KAISE KARTA HAI (koi table nahi banti, koi memory nahi bharti):
//
//   1. Browser /api/captcha maangta hai
//   2. Server 5 akshar chunta hai, unka tedha-medha SVG banata hai,
//      aur ek TOKEN deta hai:   nonce . expiry . HMAC(nonce|expiry|jawab)
//   3. Browser image dikhata hai; user jawab type karta hai
//   4. Login ke saath token + jawab wapas aata hai. Server usi jawab se
//      HMAC dobara banata hai aur milata hai.
//
// Jawab kabhi bheja hi nahi jaata, isliye kahin store karne ki zaroorat
// nahi — na DB me, na memory me. Server restart ho ya do instance chal
// rahe hon, dono jagah kaam karta hai.
//
// Ek hi captcha do baar na chale, iske liye chhoti si used-nonce list
// memory me rakhi hai (khud saaf hoti rehti hai).
//
// BAND KARNE KE DO RAASTE (dono me koi deploy nahi):
//   Render env var :  CAPTCHA_OFF=1          <- turant, DB ki zaroorat nahi
//   DB             :  UPDATE system_settings SET value='0' WHERE key='captcha_enabled';
//
// SACH: ye script/bot ko rokta hai. Insaan baith kar solve kare to nahi
// rukega — isliye loginLimiter (rate limit) hi asli bachaav rehta hai,
// captcha uske upar ek aur parat hai.

const CAPTCHA_TTL_MS = 3 * 60 * 1000;          // 3 minute me expire
const CAPTCHA_LEN    = 5;
// I, l, 1, O, 0 hata diye — screen par ye ek jaise dikhte hain aur
// genuine user hi galti karta hai.
const CAPTCHA_CHARS  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const _captchaUsed = new Map();                 // nonce -> expiry
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of _captchaUsed) if (exp < now) _captchaUsed.delete(k);
}, 60 * 1000).unref();

function captchaSign(nonce, exp, answer) {
  return crypto.createHmac('sha256', JWT_SECRET + '|captcha|v1')
               .update(nonce + '|' + exp + '|' + String(answer).trim().toUpperCase())
               .digest('base64url');
}

// Captcha chalu hai ya nahi. DB na chale to FALSE — warna DB ki dikkat
// me sab log login se hi bahar ho jaate.
async function captchaEnabled() {
  if (process.env.CAPTCHA_OFF === '1') return false;
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='captcha_enabled'");
    return !r.rows.length || r.rows[0].value !== '0';
  } catch (e) {
    console.warn('captchaEnabled check fail (skip kar rahe hain):', e.message);
    return false;
  }
}

function captchaSvg(text) {
  const W = 160, H = 52;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const n = (v) => v.toFixed(1);
  let o = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H +
          '" viewBox="0 0 ' + W + ' ' + H + '">';
  o += '<rect width="' + W + '" height="' + H + '" fill="#f4f6fb"/>';
  // tedhi lakeeren — OCR ko atkati hain
  for (let i = 0; i < 5; i++) {
    o += '<path d="M' + n(rnd(-5, 15)) + ',' + n(rnd(0, H)) +
         ' Q' + n(rnd(45, 115)) + ',' + n(rnd(-8, H + 8)) +
         ' ' + n(rnd(145, W + 5)) + ',' + n(rnd(0, H)) +
         '" stroke="hsl(' + Math.floor(rnd(0, 360)) + ',55%,74%)" stroke-width="' +
         n(rnd(1, 2.2)) + '" fill="none"/>';
  }
  for (let i = 0; i < 34; i++) {
    o += '<circle cx="' + n(rnd(0, W)) + '" cy="' + n(rnd(0, H)) + '" r="' +
         n(rnd(0.6, 1.7)) + '" fill="hsl(' + Math.floor(rnd(0, 360)) + ',45%,72%)"/>';
  }
  // har akshar apni jagah, apne kone par, apne size me
  const step = W / (text.length + 1);
  for (let i = 0; i < text.length; i++) {
    const x = step * (i + 1) + rnd(-4, 4);
    const y = rnd(33, 41);
    o += '<text x="' + n(x) + '" y="' + n(y) + '" font-family="Georgia,Times,serif" font-size="' +
         n(rnd(25, 32)) + '" font-weight="700" fill="hsl(' + Math.floor(rnd(205, 285)) +
         ',65%,' + Math.floor(rnd(26, 40)) + '%)" transform="rotate(' + n(rnd(-28, 28)) +
         ' ' + n(x) + ' ' + n(y) + ')">' + text[i] + '</text>';
  }
  return o + '</svg>';
}

function makeCaptcha() {
  let ans = '';
  for (let i = 0; i < CAPTCHA_LEN; i++)
    ans += CAPTCHA_CHARS[crypto.randomInt(CAPTCHA_CHARS.length)];
  const nonce = crypto.randomBytes(9).toString('base64url');
  const exp = Date.now() + CAPTCHA_TTL_MS;
  return {
    token: nonce + '.' + exp + '.' + captchaSign(nonce, exp, ans),
    // data URI me bhejte hain aur <img> me lagta hai — page ke andar
    // koi markup inject hone ka sawaal hi nahi rehta.
    image: 'data:image/svg+xml;base64,' + Buffer.from(captchaSvg(ans), 'utf8').toString('base64')
  };
}

function verifyCaptchaToken(token, answer) {
  if (!token || !answer) return { ok: false, why: 'Captcha bharo' };
  const p = String(token).split('.');
  if (p.length !== 3) return { ok: false, why: 'Captcha galat hai — naya lo' };
  const nonce = p[0], exp = parseInt(p[1], 10), sig = p[2];
  if (!exp || Date.now() > exp) return { ok: false, why: 'Captcha expire ho gaya — naya lo' };

  const want = captchaSign(nonce, exp, answer);
  const a = Buffer.from(sig), b = Buffer.from(want);
  // Lambai alag ho to timingSafeEqual phenk deta hai — pehle wahi check
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return { ok: false, why: 'Captcha galat hai' };

  // Ek captcha sirf ek baar
  if (_captchaUsed.has(nonce)) return { ok: false, why: 'Ye captcha use ho chuka — naya lo' };
  _captchaUsed.set(nonce, exp);
  return { ok: true };
}

// Har login route ke shuru me: `if (!(await captchaGuard(req, res))) return;`
// `captcha: true` isliye bhejte hain taaki page turant naya captcha maang le.
async function captchaGuard(req, res) {
  if (!(await captchaEnabled())) return true;
  const b = req.body || {};
  const v = verifyCaptchaToken(b.captchaToken, b.captchaAnswer);
  if (!v.ok) {
    res.status(400).json({ error: v.why, captcha: true });
    return false;
  }
  return true;
}

// Naya captcha. Banane me na DB lagti hai na disk — sirf CPU, isliye
// ise rate-limit karne ki zaroorat nahi padti.
app.get('/api/captcha', async (req, res) => {
  try {
    if (!(await captchaEnabled())) return res.json({ enabled: false });
    const c = makeCaptcha();
    res.set('Cache-Control', 'no-store');
    res.json({ enabled: true, token: c.token, image: c.image });
  } catch (e) {
    // Captcha na ban paye to login band mat karo
    console.error('captcha banane me dikkat:', e.message);
    res.json({ enabled: false });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  LANGUAGES / TRANSLATIONS
// ═══════════════════════════════════════════════════════════════════
//
// `translations` table pehle se thi (lang, source, text) — par uske API
// route KAHIN THE HI NAHI. Isi wajah se:
//
//   • Superadmin ka "🌐 Languages" tab /api/i18n maangta tha, 404 ka
//     HTML page milta tha, aur `.json()` `<` par phat jaata tha —
//     screen par "Unexpected token '<'".
//
//   • Public i18n.js /api/i18n/dict maangta hai. Wo 404 ko chup-chaap
//     sambhal leta hai (r.ok check karta hai), isliye website TOOTI
//     NAHI — par panel se ki gayi koi bhi translation website tak
//     kabhi pahunchti hi nahi thi.
//
// Language list public i18n.js ke apne LANGS se HU-BA-HU milni chahiye,
// warna panel me dikhegi ek language aur website par chalegi doosri.
const I18N_LANGS = { en: 'English', 'mni-mtei': 'Manipuri (Meitei Mayek)' };
// Object me seedha `I18N_LANGS[lang]` mat dekhna — 'constructor' jaise
// naam bhi truthy aa jaate hain aur validation nikal jaata.
function isKnownLang(l) {
  return Object.prototype.hasOwnProperty.call(I18N_LANGS, l);
}

// Kaun si language available hai (superadmin ka dropdown isi se bharta hai)
app.get('/api/i18n', (req, res) => {
  res.json({ langs: I18N_LANGS, source: 'en' });
});

// Public pages ke liye dictionary. i18n.js ise bundled dictionary ke
// UPAR merge karta hai.
app.get('/api/i18n/dict', async (req, res) => {
  try {
    const lang = String(req.query.lang || '').slice(0, 8);
    if (!lang || lang === 'hin' || !isKnownLang(lang)) return res.json({ lang, dict: {} });
    const r = await pool.query('SELECT source, text FROM translations WHERE lang=$1', [lang]);
    const dict = {};
    r.rows.forEach(x => { if (x.text) dict[x.source] = x.text; });
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ lang, dict });
  } catch (e) {
    // Yahan kabhi 500 mat do — website ka page isi par tika hai
    console.error('i18n dict error:', e.message);
    res.json({ dict: {} });
  }
});

// Superadmin: ek language ki poori list + har language ki ginti
app.get('/api/superadmin/translations', verifySuperAdmin, async (req, res) => {
  try {
    const lang = String(req.query.lang || 'en').slice(0, 8);
    if (!isKnownLang(lang)) return res.status(400).json({ error: 'Ye language nahi hai' });
    const r = await pool.query(
      'SELECT id, source, text FROM translations WHERE lang=$1 ORDER BY updated_at DESC, id DESC',
      [lang]);
    const c = await pool.query('SELECT lang, COUNT(*)::int AS n FROM translations GROUP BY lang');
    const counts = {};
    c.rows.forEach(x => { counts[x.lang] = x.n; });
    res.json({ lang, rows: r.rows, counts, langs: I18N_LANGS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Superadmin: poori list ek saath save. Khaali text = us line ko hata do
// (missing hone par source hi dikhta hai, isliye kuch tootta nahi).
app.put('/api/superadmin/translations', verifySuperAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const lang = String(b.lang || '').slice(0, 8);
    if (!isKnownLang(lang) || lang === 'hin')
      return res.status(400).json({ error: 'Select English or Manipuri (Meitei Mayek)' });

    const items = Array.isArray(b.items) ? b.items.slice(0, 5000) : [];
    let saved = 0, removed = 0;
    for (const it of items) {
      const src = String((it && it.source) || '').trim();
      const txt = String((it && it.text) || '').trim();
      if (!src) continue;
      if (!txt) {
        const d = await pool.query(
          'DELETE FROM translations WHERE lang=$1 AND md5(source)=md5($2)', [lang, src]);
        removed += d.rowCount || 0;
        continue;
      }
      await pool.query(
        `INSERT INTO translations (lang, source, text, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (lang, md5(source))
         DO UPDATE SET text = EXCLUDED.text, updated_at = NOW()`,
        [lang, src, txt]);
      saved++;
    }
    console.log(`Translations save: ${lang} | ${saved} saved, ${removed} removed`);
    res.json({ success: true, saved, removed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Demo upload quota ki ginti kitni der me taazi ho — 1 ghanta. */
const QUOTA_WINDOW_MS = 60 * 60 * 1000;

/**
 * Upload quota + burst detection, per demo/shop.
 * Ye CIRCUIT BREAKER hai: trip hote hi PDF processing aur Cloudinary
 * dono ruk jaate hain.
 */
function checkUploadAbuse(shopId, isDemo) {
  const key = 'shop:' + shopId;
  const mins = isBlocked(key);
  if (mins) return { ok: false, reason: 'TEMP_BLOCKED',
                     error: `Too many uploads. Please try again in ${mins} minute(s).` };

  const now = Date.now();
  let e = uploadHits.get(shopId);
  if (!e || now > e.resetAt) {
    e = { count: 0, resetAt: now + 60000, last: 0, strikes: 0,
          total: e ? e.total : 0,
          totalResetAt: e ? e.totalResetAt : (now + QUOTA_WINDOW_MS) };
  }
  e.total = (e.total || 0);

  // ── ROLLING QUOTA WINDOW ──
  // Pehle `total` KABHI reset nahi hota tha. Quota chhoote hi 15 min ka
  // block lagta, aur block khatam hone par agle upload par `total` phir
  // bhi limit se upar hota — to TURANT dobara block. Yaani shop hamesha
  // ke liye atak jaati thi (asli customer par hua: 3 print, 16 block).
  if (!e.totalResetAt || now > e.totalResetAt) {
    e.total = 0;
    e.totalResetAt = now + QUOTA_WINDOW_MS;
  }

  // Burst: lagatar bahut kam gap me uploads
  if (e.last && (now - e.last) < SEC.burstMin) {
    e.strikes++;
    if (e.strikes >= SEC.burstStrikes) {
      uploadHits.set(shopId, e);
      blockFor(key, SEC.blockMin, 'upload burst');
      return { ok: false, reason: 'UPLOAD_BURST',
               error: 'Uploads are coming in too fast. Please wait a moment and try again.' };
    }
  } else if (e.strikes > 0 && (now - e.last) > 10000) {
    e.strikes--;                       // shaant raha to strike maaf
  }

  e.count++; e.last = now; e.total++;
  uploadHits.set(shopId, e);

  if (e.count > SEC.uploadsPerMin) {
    blockFor(key, SEC.blockMin, 'uploads per minute exceeded');
    return { ok: false, reason: 'UPLOAD_RATE',
             error: 'Too many uploads in a short time. Please try again in a few minutes.' };
  }
  // Demo par total upload quota bhi (print limit se alag — ye attempts hain)
  // Dhyan: ye PRINT limit nahi, upload ATTEMPTS ki ginti hai. Ek print me
  // customer aksar 2-3 attempt karta hai — file badalta, page chunta,
  // refresh karta. Pehle multiplier 3 tha, matlab 10-print wali demo sirf
  // 30 attempts me khatam. Ab 8 (rolling 1-ghanta window ke saath).
  if (isDemo && e.total > SEC.uploadsPerDemo * 8) {
    blockFor(key, SEC.blockMin, 'demo upload quota exceeded');
    return { ok: false, reason: 'DEMO_UPLOAD_QUOTA',
             error: `Bahut zyada upload koshish. ${SEC.blockMin} minute baad dobara try karo.` };
  }
  return { ok: true, count: e.count, total: e.total };
}

/**
 * GLOBAL EMERGENCY BRAKE — agar poore server par upload rate achanak
 * threshold se upar chala jaye (koi loop / bug / attack), naye uploads
 * temporarily band. Threshold jaan-boojh kar udaar rakha hai taaki
 * normal busy din par kabhi trip na ho.
 */
function globalBrake() {
  const now = Date.now();
  if (now > globalWindow.resetAt) {
    if (globalWindow.tripped) console.warn('GLOBAL BRAKE released');
    globalWindow = { count: 0, resetAt: now + 60000, tripped: false };
  }
  globalWindow.count++;
  if (globalWindow.count > SEC.globalPerMin) {
    if (!globalWindow.tripped) {
      globalWindow.tripped = true;
      console.error(`GLOBAL BRAKE TRIPPED — ${globalWindow.count} uploads in 1 minute (limit ${SEC.globalPerMin})`);
      logSecurityEvent({ action: 'GLOBAL_BRAKE', reason: `${globalWindow.count} uploads/min`,
                         endpoint: 'global', uploadCount: globalWindow.count });
    }
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════
// UPLOAD GUARDRAILS — sab limits ek jagah, env se configurable
// ═══════════════════════════════════════════════
const MAX_UPLOAD_MB        = parseInt(process.env.MAX_UPLOAD_MB || '20', 10);
const MAX_UPLOAD_BYTES     = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_PDF_PAGES        = parseInt(process.env.MAX_PDF_PAGES || '20', 10);
// Ek job me kitne KAGAZ — page x copies.
//
// 20 page ka limit pehle se tha, par copies par koi rok nahi thi: page
// 50 tak chun leta tha aur server maan leta tha. Yaani 20 x 50 = 1000
// kagaz ek hi QR scan se. Ab kul ginti par rok hai, isliye 20-page ki
// 1 copy, 5-page ki 4 copy, 1-page ki 20 copy — teeno theek hain.
const MAX_JOB_SHEETS       = parseInt(process.env.MAX_JOB_SHEETS || '20', 10);
const DUP_UPLOAD_LIMIT     = parseInt(process.env.DUP_UPLOAD_LIMIT || '5', 10);
const DUP_UPLOAD_WINDOW_MIN= parseInt(process.env.DUP_UPLOAD_WINDOW_MIN || '60', 10);
// Job kitni der 'printing' me atka rahe uske baad fail + delete
const STUCK_JOB_TIMEOUT_SEC = parseInt(process.env.STUCK_JOB_TIMEOUT_SEC || '120', 10);
// Job 'printing' me itne second se zyada atka to agent ko DOBARA de do.
// Sweeper 120s par delete karta hai — 45s rakhne se beech me 2-3 baar
// dobara dene ka mauka mil jaata hai.
const ORPHAN_RECLAIM_SEC    = parseInt(process.env.ORPHAN_RECLAIM_SEC || '45', 10);
// 0 = seedha fail (spec ke hisab se). 1 = ek baar dobara try. Slow printer
// wali shops complain karein to isko 1 kar dena.
const STUCK_JOB_RETRIES     = parseInt(process.env.STUCK_JOB_RETRIES || '0', 10);

const LIMIT_MSG = {
  size:  `File too large. Maximum ${MAX_UPLOAD_MB} MB is allowed.`,
  pages: `Maximum ${MAX_PDF_PAGES} page PDF is allowed.`,
  dup:   `You cannot upload the same file again and again. Please try after some time.`,
  sheets: `Ek baar me zyada se zyada ${MAX_JOB_SHEETS} kagaz print ho sakte hain. `
        + `Copies kam karo, ya baaki print counter par karwa lo.`
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf','.jpg','.jpeg','.png','.doc','.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.includes(ext) ? cb(null, true) : cb(new Error('File type not allowed'));
  }
});

// Multer ki limit toote to default Express 500 deta hai — customer ko
// samajh nahi aata. Saaf message + sahi status code do.
function handleUploadErrors(err, req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: LIMIT_MSG.size });
  }
  if (err && err.message === 'File type not allowed') {
    return res.status(415).json({ error: 'This file type is not supported. Please upload a PDF, image or Word file.' });
  }
  return next(err);
}

const PRINTER_MODELS = [
  '🔍 Auto Detect (System Installed Printer)',
  'Epson L120', 'Epson L130', 'Epson L210', 'Epson L220', 'Epson L360', 'Epson L361',
  'Epson L380', 'Epson L385', 'Epson L395', 'Epson L1110', 'Epson L1210', 'Epson L1250',
  'Epson L1255', 'Epson L1300', 'Epson L1350', 'Epson L1455', 'Epson L3100', 'Epson L3101',
  'Epson L3110', 'Epson L3115', 'Epson L3116', 'Epson L3150', 'Epson L3151', 'Epson L3152',
  'Epson L3156', 'Epson L3200', 'Epson L3210', 'Epson L3211', 'Epson L3215', 'Epson L3216',
  'Epson L3250', 'Epson L3251', 'Epson L3252', 'Epson L3255', 'Epson L3256', 'Epson L3260',
  'Epson L3550', 'Epson L3560', 'Epson L4150', 'Epson L4160', 'Epson L4260', 'Epson L5190',
  'Epson L5290', 'Epson L5390', 'Epson L5590', 'Epson L6160', 'Epson L6170', 'Epson L6190',
  'Epson L6270', 'Epson L6290', 'Epson L6460', 'Epson L6490', 'Epson L6570', 'Epson L6580',
  'Epson L8050', 'Epson L8160', 'Epson L8180', 'Epson L11050', 'Epson L14150', 'Epson L15150',
  'Epson L15160', 'Epson L15180', 'Epson L18050',
  'Epson M1100', 'Epson M1120', 'Epson M1140', 'Epson M1170', 'Epson M2120', 'Epson M2140',
  'Epson M2170', 'Epson WF-2810', 'Epson WF-2830', 'Epson WF-3825', 'Epson WF-C5390',
  'Canon PIXMA G1010', 'Canon PIXMA G1020', 'Canon PIXMA G1030', 'Canon PIXMA G2002',
  'Canon PIXMA G2010', 'Canon PIXMA G2012', 'Canon PIXMA G2020', 'Canon PIXMA G2070',
  'Canon PIXMA G3000', 'Canon PIXMA G3010', 'Canon PIXMA G3012', 'Canon PIXMA G3020',
  'Canon PIXMA G3060', 'Canon PIXMA G3070', 'Canon PIXMA G3770', 'Canon PIXMA G4010', 'Canon PIXMA G4020',
  'Canon PIXMA G4070', 'Canon PIXMA G5070', 'Canon PIXMA G6070', 'Canon PIXMA G7070',
  'Canon PIXMA TS207', 'Canon PIXMA TS307', 'Canon PIXMA TS3340', 'Canon PIXMA TS3475',
  'Canon PIXMA E477', 'Canon PIXMA E3370', 'Canon PIXMA E4270', 'Canon PIXMA MG2470',
  'Canon PIXMA MG3070',
  'Canon LBP2900', 'Canon LBP3300', 'Canon LBP6030', 'Canon LBP6230DW', 'Canon LBP226dw',
  'Canon imageCLASS MF3010', 'Canon imageCLASS MF237w', 'Canon imageCLASS MF244dw',
  'HP DeskJet 1112', 'HP DeskJet 2131', 'HP DeskJet 2332', 'HP DeskJet 2710',
  'HP DeskJet 2720', 'HP DeskJet 2776', 'HP DeskJet 2778', 'HP DeskJet 3635',
  'HP DeskJet 3776', 'HP DeskJet 3835', 'HP DeskJet 4178', 'HP DeskJet Ink Advantage 2135',
  'HP Smart Tank 515', 'HP Smart Tank 520', 'HP Smart Tank 580', 'HP Smart Tank 615',
  'HP Smart Tank 670', 'HP Smart Tank 750', 'HP Ink Tank 315', 'HP Ink Tank 319',
  'HP Ink Tank 415', 'HP Ink Tank 419', 'HP Ink Tank Wireless 416',
  'HP LaserJet 1018', 'HP LaserJet 1020', 'HP LaserJet 1022', 'HP LaserJet M1005',
  'HP LaserJet M1136', 'HP LaserJet P1108', 'HP LaserJet P1505', 'HP LaserJet Pro M15a',
  'HP LaserJet Pro M15w', 'HP LaserJet Pro M126nw', 'HP LaserJet Pro M404dn',
  'HP LaserJet Pro MFP M126nw', 'HP LaserJet Pro MFP M225dw',
  'Brother DCP-T220', 'Brother DCP-T225', 'Brother DCP-T226', 'Brother DCP-T310',
  'Brother DCP-T420W', 'Brother DCP-T426W', 'Brother DCP-T520W', 'Brother DCP-T710W',
  'Brother DCP-T820DW', 'Brother HL-1201', 'Brother HL-1221fn', 'Brother HL-L2321D',
  'Brother HL-L2361DN', 'Brother HL-L2375DW', 'Brother MFC-J2330DW', 'Brother MFC-T920DW',
  'Brother MFC-T4500DW',
  'Kyocera Ecosys P2040dn', 'Kyocera Ecosys P2235dn', 'Kyocera Ecosys M2040dn',
  'Kyocera Ecosys M2540dn', 'Kyocera FS-1020D',
  'Ricoh SP 210', 'Ricoh SP 311DN', 'Ricoh MP 2014',
  'Samsung ML-1640', 'Samsung Xpress M2020',
  'Other (Manually Type Below)'
];

// PNG signature check (magic bytes)
function isPng(buf) {
  return buf && buf.length > 8 &&
    buf[0]===0x89 && buf[1]===0x50 && buf[2]===0x4E && buf[3]===0x47 &&
    buf[4]===0x0D && buf[5]===0x0A && buf[6]===0x1A && buf[7]===0x0A;
}

// PNG me transparency hai? IHDR color type padho (offset 25):
//  type 4 = grayscale+alpha, 6 = RGBA -> alpha channel hai.
//  type 3 (palette) me tRNS chunk ho to bhi transparent ho sakta hai.
// JPEG hai? (magic bytes FF D8 FF ... aur end me FF D9)
function isJpeg(buf) {
  return buf && buf.length > 3 &&
    buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
}

function pngHasAlpha(buf) {
  try {
    if (!isPng(buf) || buf.length < 26) return false;
    const colorType = buf[25];   // IHDR: width(4)+height(4)+bitdepth(1)+colortype(1) => index 25
    if (colorType === 4 || colorType === 6) return true;   // alpha channel present
    if (colorType === 3) {
      // palette PNG: tRNS chunk dhundo
      const s = buf.toString('latin1');
      return s.includes('tRNS');
    }
    return false;
  } catch(e) { return false; }
}

async function uploadImageToCloudinary(fileBuffer, mimeType) {
  if (!CLOUD_NAME || !CLD_API_KEY || !CLD_API_SECRET) return Promise.reject(new Error('Cloudinary configured nahi'));
  return new Promise((resolve, reject) => {
    const timestamp = Math.round(Date.now() / 1000);
    const publicId = BRAND_PREFIX + uuidv4();
    const signStr = `public_id=${publicId}&timestamp=${timestamp}${CLD_API_SECRET}`;
    const signature = crypto.createHash('sha256').update(signStr).digest('hex');
    const dataUri = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
    const postData = new URLSearchParams({
      file: dataUri, api_key: CLD_API_KEY, timestamp: timestamp.toString(),
      public_id: publicId, signature, resource_type: 'image'
    }).toString();
    const req = https.request({
      hostname: 'api.cloudinary.com', path: `/v1_1/${CLOUD_NAME}/image/upload`, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
    }, (resp) => {
      let data = ''; resp.on('data', c => data += c);
      resp.on('end', () => { try { const j = JSON.parse(data); j.secure_url ? resolve(j.secure_url) : reject(new Error(j.error?.message || 'Upload fail')); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.write(postData); req.end();
  });
}

/**
 * Cloudinary upload with BOUNDED retry.
 * Infinite retry loop bilkul nahi: max MAX_CLOUDINARY_RETRIES attempts,
 * exponential backoff, phir final failure. Ek bug ya network flap ghanton
 * tak Cloudinary/Render bandwidth nahi jala sakta.
 */
async function uploadToCloudinaryWithRetry(fileBuffer, fileType) {
  const max = Math.max(1, Math.min(5, SEC.cldMaxRetries));
  let lastErr = null;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await uploadToCloudinary(fileBuffer, fileType);
    } catch (err) {
      lastErr = err;
      // 4xx = hamari galti (bad signature/file) — retry se theek nahi hoga
      if (/\b4\d\d\b/.test(err.message || '') || /Invalid|signature/i.test(err.message || '')) {
        console.warn(`Cloudinary upload attempt ${attempt}: permanent error, not retrying — ${err.message}`);
        break;
      }
      if (attempt < max) {
        const wait = Math.min(500 * Math.pow(2, attempt - 1), 4000);   // 500ms, 1s, 2s, 4s
        console.warn(`Cloudinary upload attempt ${attempt}/${max} failed (${err.message}) — retry in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  console.error(`Cloudinary upload FAILED after ${max} attempts — giving up`);
  throw lastErr || new Error('Cloudinary upload failed');
}

async function uploadToCloudinary(fileBuffer, fileType) {
  if (!CLOUD_NAME || !CLD_API_KEY || !CLD_API_SECRET) {
    return Promise.reject(new Error('Cloudinary configured nahi hai — Render environment variables check karo (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)'));
  }
  return new Promise((resolve, reject) => {
    const timestamp = Math.round(Date.now() / 1000);
    const publicId = UPLOAD_PREFIX + uuidv4();
    const signStr = `public_id=${publicId}&timestamp=${timestamp}${CLD_API_SECRET}`;
    const signature = crypto.createHash('sha256').update(signStr).digest('hex');
    const mimeType = fileType === 'pdf' ? 'application/pdf' :
                     ['jpg','jpeg'].includes(fileType) ? 'image/jpeg' :
                     fileType === 'png' ? 'image/png' : 'application/octet-stream';
    const dataUri = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
    const postData = new URLSearchParams({
      file: dataUri, api_key: CLD_API_KEY,
      timestamp: timestamp.toString(), public_id: publicId,
      signature, resource_type: 'raw'
    }).toString();
    const options = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUD_NAME}/raw/upload`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.secure_url) resolve({ url: result.secure_url, publicId: result.public_id });
          else reject(new Error('Cloudinary upload failed: ' + JSON.stringify(result)));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Cloudinary par ASLI me kya pada hai — Admin API se list.
// DB ki nazar se orphan files (jinka job row hi nahi) sirf isse dikhti hain.
let _sweepTick = 0;

// Cloudinary par file 3 alag "resource type" me ho sakti hai:
//   raw   -> PDF / DOC (jo hum upload karte hain)
//   image -> JPG / PNG (customer ki photo, passport photo, canvas editor output)
//   video -> almost never, par safety ke liye
// Pehle sirf `raw` list hota tha, isliye superadmin panel me hamesha 0 dikhta
// tha jabki Cloudinary me files padi rehti thi. Ab teeno type dekhte hain.
// Error ab chupaya nahi jaata — warna auth fail hone par bhi "0 files" dikhta hai.
async function listCloudinaryFilesOfType(resourceType, nextCursor = '', prefix = UPLOAD_PREFIX) {
  if (prefix !== UPLOAD_PREFIX) throw new Error('Only Echel print uploads may be listed.');
  return new Promise((resolve) => {
    if (!CLOUD_NAME || !CLD_API_KEY || !CLD_API_SECRET) {
      return resolve({ resources: [], error: 'Cloudinary keys set nahi hain' });
    }
    const auth = Buffer.from(`${CLD_API_KEY}:${CLD_API_SECRET}`).toString('base64');
    let path = `/v1_1/${CLOUD_NAME}/resources/${resourceType}?max_results=100`;
    if (prefix) path += `&prefix=${encodeURIComponent(prefix)}`;
    if (nextCursor) path += `&next_cursor=${encodeURIComponent(nextCursor)}`;
    const req = https.request({
      hostname: 'api.cloudinary.com', path, method: 'GET',
      headers: { Authorization: 'Basic ' + auth }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (res.statusCode >= 400) {
            return resolve({ resources: [], error: `${resourceType}: ${(j.error && j.error.message) || res.statusCode}` });
          }
          resolve({
            resources: (j.resources || []).map(r => ({ ...r, resource_type: r.resource_type || resourceType })),
            next_cursor: j.next_cursor || ''
          });
        } catch (e) { resolve({ resources: [], error: `${resourceType}: bad response` }); }
      });
    });
    req.on('error', (e) => resolve({ resources: [], error: `${resourceType}: ${e.message}` }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ resources: [], error: `${resourceType}: timeout` }); });
    req.end();
  });
}

// Teeno type ki saari files ek list me (pages ke saath)
async function listAllCloudinaryFiles(prefix = UPLOAD_PREFIX) {
  const out = [];
  const errors = [];
  for (const type of ['raw', 'image', 'video']) {
    let cursor = '';
    for (let page = 0; page < 20; page++) {
      const r = await listCloudinaryFilesOfType(type, cursor, prefix);
      if (r.error) { errors.push(r.error); break; }
      out.push(...r.resources);
      if (!r.next_cursor) break;
      cursor = r.next_cursor;
    }
  }
  return { files: out, errors };
}

// Purana naam chalta rahe (baaki code isko use karta hai)
async function listCloudinaryFiles(nextCursor = '') {
  return listCloudinaryFilesOfType('raw', nextCursor, UPLOAD_PREFIX);
}


// resourceType zaroori hai: image file ko 'raw' bolkar delete karne ki koshish
// karoge to Cloudinary "not found" bolta hai aur file wahin padi reh jaati hai.
async function deleteFromCloudinary(publicId, resourceType = 'raw') {
  if (!isJobAsset(publicId)) throw new Error('Refusing to delete an asset outside Echel print uploads.');
  return new Promise((resolve) => {
    const timestamp = Math.round(Date.now() / 1000);
    const signStr = `public_id=${publicId}&timestamp=${timestamp}${CLD_API_SECRET}`;
    const signature = crypto.createHash('sha256').update(signStr).digest('hex');
    const postData = new URLSearchParams({
      public_id: publicId, api_key: CLD_API_KEY,
      timestamp: timestamp.toString(), signature, resource_type: resourceType
    }).toString();
    const options = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUD_NAME}/${resourceType}/destroy`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { console.log(`Deleted: ${publicId}`); } catch(e) {} resolve(); });
    });
    req.on('error', () => resolve());
    req.write(postData);
    req.end();
  });
}

async function initDB() {
  try {
  // ── SABSE PEHLE: saari table bana lo ──
  //
  // Neeche ka SQL kram me nahi hai: kuch ALTER apni table BANNE SE
  // PEHLE aate hain (jaise whitelabels ka ALTER 3000 par, uska
  // CREATE 24000 par). Supabase par ye kabhi nahi pakda gaya kyunki
  // wahan table pehle se thi. Bilkul khaali DB par wo ALTER phenkta
  // hai — aur pool.query() me kai statement EK transaction me chalte
  // hain, isliye POORA block wapas chala jaata hai. Aaj live par
  // yahi hua: 14 table bani hi nahi aur shops ke 68 column gayab.
  //
  // Isliye sabse pehle sirf CREATE — har ALTER ko apni table mil
  // jaaye, kram chahe jo ho. Neeche ke purane CREATE waise hi hain;
  // IF NOT EXISTS hai, dobara chalne se kuch nahi bigadta.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
          id VARCHAR(50) PRIMARY KEY,
          name VARCHAR(200) NOT NULL,
          address TEXT, phone VARCHAR(20),
          printer_model VARCHAR(150),
          price_bw INTEGER DEFAULT 5,
          price_color INTEGER DEFAULT 10,
          payment_mode VARCHAR(20) DEFAULT 'both',
          password_hash VARCHAR(255),
          payment_gateway VARCHAR(20) DEFAULT '',
          razorpay_key_id VARCHAR(200) DEFAULT '',
          razorpay_key_secret VARCHAR(200) DEFAULT '',
          cashfree_app_id VARCHAR(200) DEFAULT '',
          cashfree_secret_key VARCHAR(300) DEFAULT '',
          email VARCHAR(160) DEFAULT '',
          phonepe_merchant_id VARCHAR(200) DEFAULT '',
          phonepe_salt_key VARCHAR(200) DEFAULT '',
          phonepe_salt_index VARCHAR(10) DEFAULT '1',
          setup_paid BOOLEAN DEFAULT false,
          setup_payment_id VARCHAR(200) DEFAULT '',
          setup_order_id VARCHAR(200) DEFAULT '',
          setup_amount INTEGER DEFAULT 0,
          qr_code TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        );
    CREATE TABLE IF NOT EXISTS system_settings (
          key VARCHAR(100) PRIMARY KEY,
          value TEXT,
          updated_at TIMESTAMP DEFAULT NOW()
        );
    CREATE TABLE IF NOT EXISTS print_jobs (
          id VARCHAR(50) PRIMARY KEY,
          shop_id VARCHAR(50),
          file_name VARCHAR(500),
          file_url TEXT,
          file_public_id VARCHAR(500),
          file_type VARCHAR(20),
          total_pages INTEGER DEFAULT 1,
          selected_pages TEXT DEFAULT '',
          copies INTEGER DEFAULT 1,
          color_mode VARCHAR(10) DEFAULT 'bw',
          amount INTEGER,
          status VARCHAR(20) DEFAULT 'pending',
          payment_status VARCHAR(20) DEFAULT 'pending',
          payment_method VARCHAR(20) DEFAULT 'counter',
          payment_id VARCHAR(200),
          razorpay_order_id VARCHAR(200),
          created_at TIMESTAMP DEFAULT NOW(),
          printed_at TIMESTAMP
        );
    CREATE TABLE IF NOT EXISTS whatsapp_interest (
          phone      VARCHAR(15) PRIMARY KEY,
          hits       INT DEFAULT 1,
          created_at TIMESTAMP DEFAULT NOW(),
          last_at    TIMESTAMP DEFAULT NOW()
        );
    CREATE TABLE IF NOT EXISTS upload_fingerprints (
          shop_id    VARCHAR(50)  NOT NULL,
          file_hash  VARCHAR(64)  NOT NULL,
          hits       INTEGER      NOT NULL DEFAULT 1,
          first_seen TIMESTAMP    NOT NULL DEFAULT NOW(),
          last_seen  TIMESTAMP    NOT NULL DEFAULT NOW(),
          PRIMARY KEY (shop_id, file_hash)
        );
    CREATE TABLE IF NOT EXISTS security_events (
          id           BIGSERIAL PRIMARY KEY,
          created_at   TIMESTAMP    NOT NULL DEFAULT NOW(),
          ip           VARCHAR(60)  DEFAULT '',
          shop_id      VARCHAR(50)  DEFAULT '',
          endpoint     VARCHAR(120) DEFAULT '',
          method       VARCHAR(10)  DEFAULT '',
          user_agent   VARCHAR(250) DEFAULT '',
          action       VARCHAR(40)  DEFAULT '',
          reason       VARCHAR(200) DEFAULT '',
          upload_count INTEGER,
          file_size    BIGINT
        );
    CREATE TABLE IF NOT EXISTS demo_registrations (
          id SERIAL PRIMARY KEY,
          phone VARCHAR(15) UNIQUE,
          ip VARCHAR(64),
          shop_id VARCHAR(50),
          created_at TIMESTAMP DEFAULT NOW()
        );
    CREATE TABLE IF NOT EXISTS demo_machines (
          machine_id VARCHAR(100) PRIMARY KEY,
          shop_id VARCHAR(50),
          created_at TIMESTAMP DEFAULT NOW()
        );
    CREATE TABLE IF NOT EXISTS blocked_ips (
          ip         VARCHAR(60) PRIMARY KEY,
          reason     VARCHAR(200) DEFAULT '',
          created_at TIMESTAMP DEFAULT NOW()
        );
    CREATE TABLE IF NOT EXISTS blocked_customers (
          cid        VARCHAR(48) PRIMARY KEY,
          shop_id    VARCHAR(50)  DEFAULT '',
          reason     VARCHAR(200) DEFAULT '',
          created_at TIMESTAMP DEFAULT NOW()
        );
    CREATE TABLE IF NOT EXISTS agent_commissions (
          id SERIAL PRIMARY KEY,
          agent_id VARCHAR(50),
          shop_id VARCHAR(50),
          shop_name VARCHAR(200),
          base_price INTEGER DEFAULT 0,
          sold_price INTEGER DEFAULT 0,
          markup INTEGER DEFAULT 0,
          commission INTEGER DEFAULT 0,
          bonus INTEGER DEFAULT 0,
          total INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW()
        );
    CREATE TABLE IF NOT EXISTS platform_payments (
          id SERIAL PRIMARY KEY,
          kind VARCHAR(20) NOT NULL,
          shop_id VARCHAR(50) DEFAULT '',
          shop_name VARCHAR(200) DEFAULT '',
          whitelabel_id VARCHAR(50) DEFAULT '',
          amount INTEGER DEFAULT 0,
          payment_id VARCHAR(200) DEFAULT '',
          order_id VARCHAR(200) DEFAULT '',
          gateway VARCHAR(20) DEFAULT 'razorpay',
          note VARCHAR(300) DEFAULT '',
          created_at TIMESTAMP DEFAULT NOW()
        );
    CREATE TABLE IF NOT EXISTS translations (
          id SERIAL PRIMARY KEY,
          lang VARCHAR(8) NOT NULL,
          source TEXT NOT NULL,
          text TEXT NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW()
        );
    CREATE TABLE IF NOT EXISTS reviews (
          id SERIAL PRIMARY KEY,
          name VARCHAR(120) NOT NULL,
          stars SMALLINT DEFAULT 5,
          text TEXT DEFAULT '',
          city VARCHAR(120) DEFAULT '',
          active BOOLEAN DEFAULT true,
          sort_order INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW()
        );
    CREATE TABLE IF NOT EXISTS whitelabels (
          id VARCHAR(50) PRIMARY KEY,
          slug VARCHAR(40) UNIQUE,
          brand_name VARCHAR(120) NOT NULL,
          owner_name VARCHAR(120) DEFAULT '',
          phone VARCHAR(20) DEFAULT '',
          email VARCHAR(160) DEFAULT '',
          password_hash VARCHAR(200) NOT NULL,
          logo_url VARCHAR(400) DEFAULT '',
          powered_by VARCHAR(160) DEFAULT '',
          support_email VARCHAR(160) DEFAULT '',
          support_phone VARCHAR(20) DEFAULT '',
          razorpay_key_id VARCHAR(120) DEFAULT '',
          razorpay_key_secret VARCHAR(200) DEFAULT '',
          shop_price INTEGER DEFAULT 0,
          base_price INTEGER DEFAULT 0,
          license_fee INTEGER DEFAULT 0,
          license_order_id VARCHAR(120) DEFAULT '',
          paid BOOLEAN DEFAULT false,
          blocked BOOLEAN DEFAULT false,
          broadcast TEXT DEFAULT '',
          license_expires_at TIMESTAMP,
          shop_credits INTEGER DEFAULT -1,
          created_at TIMESTAMP DEFAULT NOW(),
          paid_at TIMESTAMP
        );
    CREATE TABLE IF NOT EXISTS analytics_events (
          id SERIAL PRIMARY KEY,
          event_type VARCHAR(40) NOT NULL,
          path VARCHAR(200) DEFAULT '',
          ref VARCHAR(100) DEFAULT '',
          utm_source VARCHAR(100) DEFAULT '',
          visitor_id VARCHAR(64) DEFAULT '',
          wl VARCHAR(40) DEFAULT '',
          created_at TIMESTAMP DEFAULT NOW()
        );
    CREATE TABLE IF NOT EXISTS withdrawals (
          id SERIAL PRIMARY KEY,
          shop_id VARCHAR(50),
          amount INTEGER,
          upi_id VARCHAR(120),
          status VARCHAR(20) DEFAULT 'pending',
          requested_at TIMESTAMP DEFAULT NOW(),
          completed_at TIMESTAMP
        );
  `);

  // ── PHIR: saare column bana lo ──
  //
  // Isi wajah se: kuch "ALTER COLUMN ... TYPE" apne column ke
  // BANNE SE PEHLE aate hain (price_color_duplex ka TYPE 18659
  // par, uska ADD 19642 par). Khaali DB par wo phenkta hai aur
  // poora block wapas chala jaata hai.
  //
  // Yahan sirf ADD — TYPE badalna aur index neeche apni jagah
  // hi rehte hain, ab unhe apna column hamesha mil jaata hai.
  await pool.query(`
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(20) DEFAULT 'both';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_last_seen TIMESTAMP;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_version INT;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_version_label VARCHAR(20);
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS whitelabel_id VARCHAR(50) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS default_lang VARCHAR(16) DEFAULT '';
    ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS notify_email VARCHAR(160) DEFAULT '';
    ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS cashfree_app_id VARCHAR(120) DEFAULT '';
    ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS cashfree_secret_key VARCHAR(200) DEFAULT '';
    ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS gateway VARCHAR(20) DEFAULT 'razorpay';
    ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS hp_title VARCHAR(160) DEFAULT '';
    ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS hp_subtitle VARCHAR(200) DEFAULT '';
    ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS hp_tagline VARCHAR(200) DEFAULT '';
    ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS made_in VARCHAR(120) DEFAULT '';
    ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS social_instagram VARCHAR(300) DEFAULT '';
    ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS social_youtube VARCHAR(300) DEFAULT '';
    ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS social_facebook VARCHAR(300) DEFAULT '';
    ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS hp_buttons TEXT DEFAULT '';
    ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS monthly_price INTEGER DEFAULT 0;
    ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS site_url VARCHAR(200) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS is_agent BOOLEAN DEFAULT false;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_code VARCHAR(20);
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_upi VARCHAR(120) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_price INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_blocked BOOLEAN DEFAULT false;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_earnings INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_joined_at TIMESTAMP;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS onboarded_by VARCHAR(50) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS base_price_at_signup INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS sold_price INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_credited BOOLEAN DEFAULT false;
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printing_at TIMESTAMP;
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS payment_gateway VARCHAR(20) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS razorpay_key_id VARCHAR(200) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS razorpay_key_secret VARCHAR(200) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS cashfree_app_id VARCHAR(200) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS cashfree_secret_key VARCHAR(300) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS email VARCHAR(160) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS phonepe_merchant_id VARCHAR(200) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS phonepe_salt_key VARCHAR(200) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS phonepe_salt_index VARCHAR(10) DEFAULT '1';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS setup_paid BOOLEAN DEFAULT false;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS setup_payment_id VARCHAR(200) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS setup_order_id VARCHAR(200) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS setup_amount INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS printer_name_bw VARCHAR(300) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS printer_name_color VARCHAR(300) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS referred_by VARCHAR(50) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS referral_earnings INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS referral_rewarded BOOLEAN DEFAULT false;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS paused BOOLEAN DEFAULT false;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS supply_warning VARCHAR(30) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS demo BOOLEAN DEFAULT false;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS demo_expires_at TIMESTAMP;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS duplex_mode VARCHAR(10) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_bw_duplex INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_token VARCHAR(64);
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_machine VARCHAR(120);
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_bound_at TIMESTAMP;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_color_duplex INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS printer_name_4x6 VARCHAR(300) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS printer_name_a3 VARCHAR(300) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS printer_name_duplex VARCHAR(300) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS duplex_bw_enabled BOOLEAN DEFAULT true;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS duplex_color_enabled BOOLEAN DEFAULT true;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS plan_type VARCHAR(12) DEFAULT 'onetime';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS paid_until TIMESTAMP;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(12);
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS renewal_amount INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS renewal_months INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS renewal_order_id VARCHAR(200) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS advanced_unlocked BOOLEAN DEFAULT false;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS owned_features TEXT[] DEFAULT '{}';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_premium_price INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS feature_order_id  VARCHAR(64) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS feature_order_fid VARCHAR(40) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS advanced_order_id VARCHAR(200) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_4 INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_6 INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_10 INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_8 NUMERIC(10,2) DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_12 NUMERIC(10,2) DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_scan_active BOOLEAN DEFAULT true;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS page_slabs TEXT DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_resume_color INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_resume_bw INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a3_bw    NUMERIC(10,2) DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a3_color NUMERIC(10,2) DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a2_bw    NUMERIC(10,2) DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a2_color NUMERIC(10,2) DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a1_bw    NUMERIC(10,2) DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a1_color NUMERIC(10,2) DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS shop_notice VARCHAR(200) DEFAULT '';
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS advanced_active BOOLEAN DEFAULT true;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_legal_active  BOOLEAN DEFAULT true;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_resume_active BOOLEAN DEFAULT true;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_4x6_active    BOOLEAN DEFAULT true;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_a3_active     BOOLEAN DEFAULT true;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_mini_active   BOOLEAN DEFAULT true;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS shop_logo VARCHAR(400) DEFAULT '';
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS feedback SMALLINT DEFAULT 0;
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS duplex BOOLEAN DEFAULT false;
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS failure_reason VARCHAR(200) DEFAULT '';
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_deleted BOOLEAN DEFAULT false;
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS paper_size VARCHAR(12) DEFAULT 'a4';
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS orientation VARCHAR(12) DEFAULT 'portrait';
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS service VARCHAR(16) DEFAULT 'doc';
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS photo_count INTEGER DEFAULT 0;
    ALTER TABLE demo_registrations ADD COLUMN IF NOT EXISTS name          VARCHAR(120) DEFAULT '';
    ALTER TABLE demo_registrations ADD COLUMN IF NOT EXISTS email         VARCHAR(160) DEFAULT '';
    ALTER TABLE demo_registrations ADD COLUMN IF NOT EXISTS shop_name     VARCHAR(200) DEFAULT '';
    ALTER TABLE demo_registrations ADD COLUMN IF NOT EXISTS address       TEXT         DEFAULT '';
    ALTER TABLE demo_registrations ADD COLUMN IF NOT EXISTS printer_model VARCHAR(120) DEFAULT '';
    ALTER TABLE demo_registrations ADD COLUMN IF NOT EXISTS status        VARCHAR(20)  DEFAULT 'approved';
    ALTER TABLE demo_registrations ADD COLUMN IF NOT EXISTS reviewed_at   TIMESTAMP;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS created_ip VARCHAR(60) DEFAULT '';
    ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS customer_id VARCHAR(48) DEFAULT '';
    ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS wl VARCHAR(40) DEFAULT '';
    ALTER TABLE reviews ADD COLUMN IF NOT EXISTS status VARCHAR(12) DEFAULT 'approved';
    ALTER TABLE reviews ADD COLUMN IF NOT EXISTS shop_id VARCHAR(50) DEFAULT '';
    ALTER TABLE reviews ADD COLUMN IF NOT EXISTS state VARCHAR(80) DEFAULT '';
    ALTER TABLE reviews ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT false;
    ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS referrer VARCHAR(160) DEFAULT '';
  `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS shops (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        address TEXT, phone VARCHAR(20),
        printer_model VARCHAR(150),
        price_bw INTEGER DEFAULT 5,
        price_color INTEGER DEFAULT 10,
        payment_mode VARCHAR(20) DEFAULT 'both',
        password_hash VARCHAR(255),
        payment_gateway VARCHAR(20) DEFAULT '',
        razorpay_key_id VARCHAR(200) DEFAULT '',
        razorpay_key_secret VARCHAR(200) DEFAULT '',
        cashfree_app_id VARCHAR(200) DEFAULT '',
        cashfree_secret_key VARCHAR(300) DEFAULT '',
        email VARCHAR(160) DEFAULT '',
        phonepe_merchant_id VARCHAR(200) DEFAULT '',
        phonepe_salt_key VARCHAR(200) DEFAULT '',
        phonepe_salt_index VARCHAR(10) DEFAULT '1',
        setup_paid BOOLEAN DEFAULT false,
        setup_payment_id VARCHAR(200) DEFAULT '',
        setup_order_id VARCHAR(200) DEFAULT '',
        setup_amount INTEGER DEFAULT 0,
        qr_code TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS print_jobs (
        id VARCHAR(50) PRIMARY KEY,
        shop_id VARCHAR(50),
        file_name VARCHAR(500),
        file_url TEXT,
        file_public_id VARCHAR(500),
        file_type VARCHAR(20),
        total_pages INTEGER DEFAULT 1,
        selected_pages TEXT DEFAULT '',
        copies INTEGER DEFAULT 1,
        color_mode VARCHAR(10) DEFAULT 'bw',
        amount INTEGER,
        status VARCHAR(20) DEFAULT 'pending',
        payment_status VARCHAR(20) DEFAULT 'pending',
        payment_method VARCHAR(20) DEFAULT 'counter',
        payment_id VARCHAR(200),
        razorpay_order_id VARCHAR(200),
        created_at TIMESTAMP DEFAULT NOW(),
        printed_at TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(20) DEFAULT 'both';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_last_seen TIMESTAMP;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_version INT;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_version_label VARCHAR(20);
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS whitelabel_id VARCHAR(50) DEFAULT '';
      -- Customer Language: shop owner apne customer ke liye bhasha chunta hai.
      -- Khali = kuch nahi chuna = customer ko English dikhega.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS default_lang VARCHAR(16) DEFAULT '';

      -- WhatsApp To Print: homepage par jinhone interest register kiya.
      -- Sirf mobile number — aur kuch nahi maangte.
      CREATE TABLE IF NOT EXISTS whatsapp_interest (
        phone      VARCHAR(15) PRIMARY KEY,
        hits       INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW(),
        last_at    TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS notify_email VARCHAR(160) DEFAULT '';
      -- ── White-label: homepage customization + Cashfree support ──
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS cashfree_app_id VARCHAR(120) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS cashfree_secret_key VARCHAR(200) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS gateway VARCHAR(20) DEFAULT 'razorpay';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS hp_title VARCHAR(160) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS hp_subtitle VARCHAR(200) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS hp_tagline VARCHAR(200) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS made_in VARCHAR(120) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS social_instagram VARCHAR(300) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS social_youtube VARCHAR(300) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS social_facebook VARCHAR(300) DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS hp_buttons TEXT DEFAULT '';
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS monthly_price INTEGER DEFAULT 0;
      -- Partner ka apna domain (jaise https://sharmadigital.in). Set hai to
      -- uski shops ke mail me yahi link jaata hai — mera domain nahi dikhta.
      ALTER TABLE whitelabels ADD COLUMN IF NOT EXISTS site_url VARCHAR(200) DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_shops_wl ON shops(whitelabel_id);
      -- ══ AGENT PROGRAM ══
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS is_agent BOOLEAN DEFAULT false;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_code VARCHAR(20);
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_upi VARCHAR(120) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_price INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_blocked BOOLEAN DEFAULT false;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_earnings INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_joined_at TIMESTAMP;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS onboarded_by VARCHAR(50) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS base_price_at_signup INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS sold_price INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_credited BOOLEAN DEFAULT false;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_agent_code ON shops(agent_code) WHERE agent_code IS NOT NULL;
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printing_at TIMESTAMP;
      -- Ek hi file baar-baar upload hone se rokne ke liye. Hash client se
      -- aata hai (SHA-256). Rolling window ke bahar ke rows apne aap saaf
      -- ho jaate hain, isliye table chhota rehta hai.
      CREATE TABLE IF NOT EXISTS upload_fingerprints (
        shop_id    VARCHAR(50)  NOT NULL,
        file_hash  VARCHAR(64)  NOT NULL,
        hits       INTEGER      NOT NULL DEFAULT 1,
        first_seen TIMESTAMP    NOT NULL DEFAULT NOW(),
        last_seen  TIMESTAMP    NOT NULL DEFAULT NOW(),
        PRIMARY KEY (shop_id, file_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_upload_fp_last_seen ON upload_fingerprints(last_seen);
      -- Har block/abuse event ka record. Superadmin isi se dekhta hai ki
      -- kaun, kab, kyun block hua. 7 din se purane rows apne aap saaf.
      CREATE TABLE IF NOT EXISTS security_events (
        id           BIGSERIAL PRIMARY KEY,
        created_at   TIMESTAMP    NOT NULL DEFAULT NOW(),
        ip           VARCHAR(60)  DEFAULT '',
        shop_id      VARCHAR(50)  DEFAULT '',
        endpoint     VARCHAR(120) DEFAULT '',
        method       VARCHAR(10)  DEFAULT '',
        user_agent   VARCHAR(250) DEFAULT '',
        action       VARCHAR(40)  DEFAULT '',
        reason       VARCHAR(200) DEFAULT '',
        upload_count INTEGER,
        file_size    BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_sec_events_time ON security_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sec_events_ip   ON security_events(ip, created_at DESC);
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS payment_gateway VARCHAR(20) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS razorpay_key_id VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS razorpay_key_secret VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS cashfree_app_id VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS cashfree_secret_key VARCHAR(300) DEFAULT '';
      -- Shop owner ka email — payment confirmation mail isi par jaata hai
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS email VARCHAR(160) DEFAULT '';
      -- PhonePe ab support nahi hai. Columns JAAN-BUJH KAR rakhe hain: data
      -- delete karna wapas nahi aata. Code inhe ab kahin use nahi karta.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS phonepe_merchant_id VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS phonepe_salt_key VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS phonepe_salt_index VARCHAR(10) DEFAULT '1';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS setup_paid BOOLEAN DEFAULT false;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS setup_payment_id VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS setup_order_id VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS setup_amount INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS printer_name_bw VARCHAR(300) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS printer_name_color VARCHAR(300) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS referred_by VARCHAR(50) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS referral_earnings INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS referral_rewarded BOOLEAN DEFAULT false;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS paused BOOLEAN DEFAULT false;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS supply_warning VARCHAR(30) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS demo BOOLEAN DEFAULT false;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS demo_expires_at TIMESTAMP;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS duplex_mode VARCHAR(10) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_bw_duplex INTEGER DEFAULT 0;
      -- Agent ka apna secret. NULL = purana agent (chalta rahega).
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_token VARCHAR(64);
      -- Kaunse PC par juda hai (sirf dikhane ke liye — asli lock agent_token hai)
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_machine VARCHAR(120);
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_bound_at TIMESTAMP;
      -- ── Decimal price support (₹2.50 / ₹1.50 jaise rate) ──
      -- INTEGER me 2.5 nahi ban sakta, isliye NUMERIC(10,2) kar rahe hain.
      ALTER TABLE shops ALTER COLUMN price_bw            TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_color         TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_bw_duplex     TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_color_duplex  TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_4x6_4         TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_4x6_6         TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_4x6_10        TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_resume_color  TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_resume_bw     TYPE NUMERIC(10,2);
      -- Aur yahi cheez print_jobs.amount par bhi. Upar ke saare rate
      -- NUMERIC ho gaye the, par jahan wo rate GUNA hokar girta hai wo
      -- column INTEGER hi reh gaya tha.
      --
      -- Nateeja: jis shop ka rate poora rupya nahi tha (jaise ₹1.5),
      -- uske har upload par Postgres phenk deta tha —
      --     invalid input syntax for type integer: "10.5"
      -- — aur customer ko sirf "Upload fail (500)" dikhta tha.
      ALTER TABLE print_jobs ALTER COLUMN amount TYPE NUMERIC(10,2);
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_color_duplex INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS printer_name_4x6 VARCHAR(300) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS printer_name_a3 VARCHAR(300) DEFAULT '';
      -- ---- DUPLEX: apna printer + per-mode on/off ----
      -- Bahut shops me duplex sirf EK printer kar paata hai (ya sirf B&W
      -- wala). Pehle duplex hamesha B&W/Color wale printer par jaata tha
      -- aur customer ko dono mode par dikhta tha -- jis printer me duplex
      -- tha hi nahi, wahan order aakar phans jaata tha.
      -- Default TRUE hai, isliye purani shops ka behaviour bilkul nahi badalta.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS printer_name_duplex VARCHAR(300) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS duplex_bw_enabled BOOLEAN DEFAULT true;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS duplex_color_enabled BOOLEAN DEFAULT true;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS plan_type VARCHAR(12) DEFAULT 'onetime';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS paid_until TIMESTAMP;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(12);
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS renewal_amount INTEGER DEFAULT 0;
    ALTER TABLE shops ADD COLUMN IF NOT EXISTS renewal_months INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS renewal_order_id VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS advanced_unlocked BOOLEAN DEFAULT false;
      -- Kaun se advance feature is shop ne liye hain (feature id ki list).
      -- advanced_unlocked ab bhi rehta hai (purana code use karta hai),
      -- par asli sach yahi column hai. Premium walon ki list dekhi nahi
      -- jaati — unhe poora catalog milta hai.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS owned_features TEXT[] DEFAULT '{}';
      -- Agent ab do plan bechta hai (Pro + Premium). agent_price Pro ka
      -- hai; Premium ka apna alag, warna agent Premium Pro ke rate par
      -- bech deta.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_premium_price INTEGER DEFAULT 0;
      -- ₹49 wale single-feature order ke liye. Verify ke waqt client ke
      -- bheje featureId par bharosa nahi karte — order banate waqt jo
      -- maanga tha, yahin se padhte hain.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS feature_order_id  VARCHAR(64) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS feature_order_fid VARCHAR(40) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS advanced_order_id VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_4 INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_6 INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_10 INTEGER DEFAULT 0;
      -- 8-photo sheet ka rate. Ye column JAAN-BUJH KAR seedha NUMERIC me
      -- banaya hai — upar wale ALTER COLUMN TYPE group me daalte to naye
      -- DB par wo line column banne se pehle chalti aur poora migration
      -- block rollback ho jata.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_8 NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_12 NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_scan_active BOOLEAN DEFAULT true;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS page_slabs TEXT DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_resume_color INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_resume_bw INTEGER DEFAULT 0;
      -- ── BIG SIZE (A3 / A2 / A1) ka apna per-page rate ──
      -- 0 / blank = purana behaviour (normal B&W/Color rate hi lagega),
      -- isliye purani shops par kuch nahi badalta.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a3_bw    NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a3_color NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a2_bw    NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a2_color NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a1_bw    NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a1_color NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS shop_notice VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS advanced_active BOOLEAN DEFAULT true;
      -- Advance ke andar 4 alag-alag module. Har ek ka apna switch, taki
      -- owner sirf wahi feature customer ko dikhaye jo uski shop me chalta hai.
      -- Default true = purani shops ka behaviour bilkul waisa hi rehta hai.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_legal_active  BOOLEAN DEFAULT true;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_resume_active BOOLEAN DEFAULT true;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_4x6_active    BOOLEAN DEFAULT true;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_a3_active     BOOLEAN DEFAULT true;
      -- Mini Print: ek A4 sheet par 2/4/6/8/9/12/16 pages (kagaz bachta hai)
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_mini_active   BOOLEAN DEFAULT true;
      -- Purane demo accounts ko bhi advanced features de do. Sirf demo par —
      -- paid shops ka paywall bilkul waise ka waisa rehta hai.
      UPDATE shops SET advanced_unlocked = true
       WHERE demo = true AND advanced_unlocked = false;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS shop_logo VARCHAR(400) DEFAULT '';
      -- ── PhonePe hataya gaya ── jo shops PhonePe par thi unka online payment
      -- ab kaam nahi karega, isliye unhe counter-cash par daal rahe hain.
      -- Owner apne panel se Razorpay/Cashfree lagate hi online wapas chalu.
      -- Dobara chale to kuch nahi hota — pehli baar ke baad koi row match hi nahi karti.
      UPDATE shops SET payment_mode='counter_only', payment_gateway=''
        WHERE payment_gateway='phonepe';
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS feedback SMALLINT DEFAULT 0;
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS duplex BOOLEAN DEFAULT false;
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS failure_reason VARCHAR(200) DEFAULT '';
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_deleted BOOLEAN DEFAULT false;
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS paper_size VARCHAR(12) DEFAULT 'a4';
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS orientation VARCHAR(12) DEFAULT 'portrait';
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS service VARCHAR(16) DEFAULT 'doc';
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS photo_count INTEGER DEFAULT 0;
      CREATE TABLE IF NOT EXISTS demo_registrations (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(15) UNIQUE,
        ip VARCHAR(64),
        shop_id VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
      -- ── Demo approval workflow (Phase 3) ──
      -- Purane rows ka status 'approved' rahega (DEFAULT), isliye pehle se
      -- bane demos par koi asar nahi padta.
      ALTER TABLE demo_registrations ADD COLUMN IF NOT EXISTS name          VARCHAR(120) DEFAULT '';
      ALTER TABLE demo_registrations ADD COLUMN IF NOT EXISTS email         VARCHAR(160) DEFAULT '';
      ALTER TABLE demo_registrations ADD COLUMN IF NOT EXISTS shop_name     VARCHAR(200) DEFAULT '';
      ALTER TABLE demo_registrations ADD COLUMN IF NOT EXISTS address       TEXT         DEFAULT '';
      ALTER TABLE demo_registrations ADD COLUMN IF NOT EXISTS printer_model VARCHAR(120) DEFAULT '';
      ALTER TABLE demo_registrations ADD COLUMN IF NOT EXISTS status        VARCHAR(20)  DEFAULT 'approved';
      ALTER TABLE demo_registrations ADD COLUMN IF NOT EXISTS reviewed_at   TIMESTAMP;
      CREATE INDEX IF NOT EXISTS idx_demo_reg_status ON demo_registrations(status, created_at DESC);
      CREATE TABLE IF NOT EXISTS demo_machines (
        machine_id VARCHAR(100) PRIMARY KEY,
        shop_id VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
      -- Shop banane wale ka IP. Pehle ye kahin save hi nahi hota tha,
      -- isliye "kis IP ne banaya" ka jawab nikalna namumkin tha.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS created_ip VARCHAR(60) DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_shops_created_ip ON shops(created_ip);
      -- Pakka blocklist. abuseBlocks wala Map sirf 15 minute ka hai aur
      -- har restart par mit jaata hai — baar-baar wale bande ke liye wo
      -- kaafi nahi.
      CREATE TABLE IF NOT EXISTS blocked_ips (
        ip         VARCHAR(60) PRIMARY KEY,
        reason     VARCHAR(200) DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
      -- Job kis CUSTOMER ne bheji. Pehle ye kahin save hi nahi hota tha,
      -- isliye "ye banda baar-baar kar raha hai" ya "iska job baar-baar
      -- deny ho raha hai" — dono sawal ka jawab nikalna namumkin tha.
      -- Purani job me khali rahega; aage se bharta rahega.
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS customer_id VARCHAR(48) DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_jobs_customer ON print_jobs(customer_id);
      -- Customer ka PAKKA block. Upar wala abuseBlocks 15 minute ka hai
      -- aur restart par mit jaata hai — baar-baar wale bande ke liye wo
      -- kaafi nahi. Ye tab tak rehta hai jab tak superadmin na hataye.
      CREATE TABLE IF NOT EXISTS blocked_customers (
        cid        VARCHAR(48) PRIMARY KEY,
        shop_id    VARCHAR(50)  DEFAULT '',
        reason     VARCHAR(200) DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS agent_commissions (
        id SERIAL PRIMARY KEY,
        agent_id VARCHAR(50),
        shop_id VARCHAR(50),
        shop_name VARCHAR(200),
        base_price INTEGER DEFAULT 0,
        sold_price INTEGER DEFAULT 0,
        markup INTEGER DEFAULT 0,
        commission INTEGER DEFAULT 0,
        bonus INTEGER DEFAULT 0,
        total INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- ══ PLATFORM PAYMENTS — har wo paisa jo HUMARE account me aaya ══
      -- Pehle sirf shops.setup_paid flag tha; advanced unlock (₹199) aur
      -- renewal ka koi record hi nahi banta tha — isliye superadmin me
      -- kuch dikhta hi nahi tha. Ab har payment ki ek row banti hai.
      --   kind: 'setup' | 'advanced' | 'renewal' | 'wl_license'
      -- payment_id par UNIQUE index hai → webhook + verify + reconcile
      -- teeno fire ho jayen to bhi ek hi row banegi (double count nahi).
      CREATE TABLE IF NOT EXISTS platform_payments (
        id SERIAL PRIMARY KEY,
        kind VARCHAR(20) NOT NULL,
        shop_id VARCHAR(50) DEFAULT '',
        shop_name VARCHAR(200) DEFAULT '',
        whitelabel_id VARCHAR(50) DEFAULT '',
        amount INTEGER DEFAULT 0,
        payment_id VARCHAR(200) DEFAULT '',
        order_id VARCHAR(200) DEFAULT '',
        gateway VARCHAR(20) DEFAULT 'razorpay',
        note VARCHAR(300) DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pp_payid
        ON platform_payments(payment_id) WHERE payment_id <> '';
      CREATE INDEX IF NOT EXISTS idx_pp_kind    ON platform_payments(kind);
      CREATE INDEX IF NOT EXISTS idx_pp_shop    ON platform_payments(shop_id);
      CREATE INDEX IF NOT EXISTS idx_pp_created ON platform_payments(created_at DESC);

      -- ══ TRANSLATIONS ══
      -- source = Hinglish text jo HTML me likha hai (yahi "key" hai).
      -- Har language ke liye ek row. Missing ho to source hi dikhta hai —
      -- isliye adhoori translation se bhi kuch tootta nahi.
      CREATE TABLE IF NOT EXISTS translations (
        id SERIAL PRIMARY KEY,
        lang VARCHAR(8) NOT NULL,
        source TEXT NOT NULL,
        text TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tr_lang_src ON translations(lang, md5(source));
      CREATE INDEX IF NOT EXISTS idx_tr_lang ON translations(lang);

      -- ══ REVIEWS — homepage par dikhne wale customer reviews ══
      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        stars SMALLINT DEFAULT 5,
        text TEXT DEFAULT '',
        city VARCHAR(120) DEFAULT '',
        active BOOLEAN DEFAULT true,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- ══ WHITE LABEL — reseller apne brand se bechta hai ══
      -- Reseller apna Razorpay lagata hai, isliye uski shops ka setup fee
      -- SEEDHA usi ke account me jaata hai (hamare paas nahi aata).
      -- Hamein sirf ek baar ka license fee milta hai.
      CREATE TABLE IF NOT EXISTS whitelabels (
        id VARCHAR(50) PRIMARY KEY,
        slug VARCHAR(40) UNIQUE,
        brand_name VARCHAR(120) NOT NULL,
        owner_name VARCHAR(120) DEFAULT '',
        phone VARCHAR(20) DEFAULT '',
        email VARCHAR(160) DEFAULT '',
        password_hash VARCHAR(200) NOT NULL,
        logo_url VARCHAR(400) DEFAULT '',
        powered_by VARCHAR(160) DEFAULT '',
        support_email VARCHAR(160) DEFAULT '',
        support_phone VARCHAR(20) DEFAULT '',
        razorpay_key_id VARCHAR(120) DEFAULT '',
        razorpay_key_secret VARCHAR(200) DEFAULT '',
        shop_price INTEGER DEFAULT 0,
        base_price INTEGER DEFAULT 0,
        license_fee INTEGER DEFAULT 0,
        license_order_id VARCHAR(120) DEFAULT '',
        paid BOOLEAN DEFAULT false,
        blocked BOOLEAN DEFAULT false,
        broadcast TEXT DEFAULT '',
        license_expires_at TIMESTAMP,
        shop_credits INTEGER DEFAULT -1,
        created_at TIMESTAMP DEFAULT NOW(),
        paid_at TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_wl_slug ON whitelabels(slug);

      -- ══ ANALYTICS — homepage funnel (pageviews + CTA clicks) ══
      -- Demo-create aur paid-conversion ka asli data 'shops' table me
      -- pehle se hai; ye table sirf TOP-of-funnel capture karti hai jo
      -- kahin aur record nahi hoti.
      CREATE TABLE IF NOT EXISTS analytics_events (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(40) NOT NULL,
        path VARCHAR(200) DEFAULT '',
        ref VARCHAR(100) DEFAULT '',
        utm_source VARCHAR(100) DEFAULT '',
        visitor_id VARCHAR(64) DEFAULT '',
        wl VARCHAR(40) DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS wl VARCHAR(40) DEFAULT '';
      -- Shop khud review bhej sake, par homepage par tabhi dikhe jab
      -- superadmin approve kare. Purane reviews (jo superadmin ne khud
      -- daale the) DEFAULT 'approved' se apne aap live rehte hain.
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS status VARCHAR(12) DEFAULT 'approved';
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS shop_id VARCHAR(50) DEFAULT '';
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS state VARCHAR(80) DEFAULT '';
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT false;
      CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);
      -- 'ref' me agent ka referral code jaata hai. Visitor kahan se aaya
      -- (google/facebook/instagram) uske liye alag column chahiye.
      ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS referrer VARCHAR(160) DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_analytics_wl ON analytics_events(wl);
      CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics_events(event_type);

      CREATE TABLE IF NOT EXISTS withdrawals (
        id SERIAL PRIMARY KEY,
        shop_id VARCHAR(50),
        amount INTEGER,
        upi_id VARCHAR(120),
        status VARCHAR(20) DEFAULT 'pending',
        requested_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
      );
    `);

    // GRANDFATHER MIGRATION: Purani shops jo setup-fee feature se PEHLE bani thi,
    // unka setup_paid abhi false hai (default) lekin unhone kabhi setup fee dene
    // ka option dekha hi nahi tha. Unhe lock out karna unfair hoga, isliye
    // ek baar ke liye unhe auto-activate kar dete hain. Yeh column sirf ek baar
    // chalta hai — jin shops ka qr_code already generated hai (purana flow se)
    // unhi ko activate karta hai, future naye registrations is condition mein nahi aayenge.
    await pool.query(`
      UPDATE shops SET setup_paid = true
      WHERE setup_paid = false AND qr_code IS NOT NULL AND qr_code != '' AND setup_payment_id = ''
    `);

    // Default setup fee (offer + actual price) seed karo agar database mein abhi tak set nahi hai
    await pool.query(`
      INSERT INTO system_settings (key, value)
      VALUES ('setup_fee_amount', $1)
      ON CONFLICT (key) DO NOTHING
    `, [SETUP_FEE_AMOUNT.toString()]);

    await pool.query(`
      INSERT INTO system_settings (key, value)
      VALUES ('setup_actual_price', $1)
      ON CONFLICT (key) DO NOTHING
    `, [SETUP_ACTUAL_PRICE.toString()]);

    // Agent version seed karo — agar pehle se set nahi hai. Yeh version number
    // har baar badhana hoga jab print_agent.py ka naya code daalo, taaki
    // sab customers ke PC pe Auto-Update trigger ho jaye.
    await pool.query(`
      INSERT INTO system_settings (key, value)
      VALUES ('agent_version', '1')
      ON CONFLICT (key) DO NOTHING
    `);
    // ── Display version label (2.0, 2.1, 2.2 ... 2.10, then 3.0) ──
    // 'agent_version' ek INTERNAL counter hai jo sirf badhta hai (29, 30, 31...).
    // Purane agents (v27/v28/v29) isi integer ko compare karke auto-update
    // karte hain — isliye ise kabhi "2.0" mat banao, warna woh sab agents
    // hamesha ke liye update lena band kar denge.
    // Customer ko dikhne wala version yeh label hai.
    await pool.query(`
      INSERT INTO system_settings (key, value)
      VALUES ('agent_version_label', '')
      ON CONFLICT (key) DO NOTHING
    `);
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('demo_enabled','1') ON CONFLICT DO NOTHING");
    // Demo ki umar — 1440 minute = 24 ghante.
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('demo_minutes','1440') ON CONFLICT DO NOTHING");
    // Purane DB me ye 120 (2 ghante) pada hai. Sirf tab badlo jab abhi bhi
    // wahi purana default ho — agar superadmin ne jaan-bujh ke koi aur value
    // set ki hai to usse chhedna galat hoga.
    await pool.query("UPDATE system_settings SET value='1440' WHERE key='demo_minutes' AND value='120'");
    // Demo me kitne free print milenge (spec: 10)
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('demo_print_limit','10') ON CONFLICT DO NOTHING");
    // '1' = demo turant ban jaaye (purana behaviour). '0' = superadmin approve kare.
    // Demo ab INSTANT hai — form submit karte hi Shop ID + password mil
    // jaata hai. Superadmin chahe to 'Manual approval' wapas on kar sakta
    // hai (Demo Control card se).
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('demo_auto_approve','1') ON CONFLICT DO NOTHING");
    // Naye plan (Starter / Pro / Premium) ke default price. ON CONFLICT
    // DO NOTHING — matlab superadmin ne badal diya ho to restart par
    // wapas default nahi hoga.
    await pool.query(`INSERT INTO system_settings (key,value) VALUES
      ('plan_starter_fee','599'), ('plan_starter_actual','2999'),
      ('plan_pro_fee','899'),     ('plan_pro_actual','2999'),
      ('plan_premium_fee','999'), ('plan_premium_actual','2999'),
      -- Naye (non-core) advance feature ka default price
      ('addon_feature_fee','49')
      ON CONFLICT DO NOTHING`);
    // One-time flip: jo installs pehle se chal rahe hain unme ye key '0'
    // padi hai. Ise EK BAAR '1' karo, phir kabhi mat chhedo — warna
    // superadmin ka manual-mode har restart par ud jaata.
    {
      const flipped = await pool.query("SELECT 1 FROM system_settings WHERE key='demo_instant_migrated'");
      if (!flipped.rows.length) {
        await pool.query("UPDATE system_settings SET value='1' WHERE key='demo_auto_approve'");
        await pool.query("INSERT INTO system_settings (key,value) VALUES ('demo_instant_migrated','1') ON CONFLICT DO NOTHING");
        console.log('Demo activation switched to INSTANT (one-time migration)');
      }
    }
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('monthly_fee','399') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('advanced_fee','199') ON CONFLICT DO NOTHING");
    // Agent Base Price (0 = abhi tak set nahi — tab tak agent ka floor = public
    // Offer Price hi rahega). Monthly/Advanced Actual Price bhi 0 = strikethrough
    // hide rahega jab tak superadmin explicitly na daale.
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('agent_base_price','0') ON CONFLICT DO NOTHING");
    // White Label — license fee (ek baar) aur reseller ka minimum shop price
    // Naye shop ka EMAIL alert. SMTP sirf ek baar superadmin set karta hai;
    // partners ko kuch setup nahi karna — wo sirf apna email daalte hain.
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('smtp_host','smtp.gmail.com') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('smtp_port','587') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('smtp_user','') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('smtp_pass','') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('notify_email','') ON CONFLICT DO NOTHING");
    // Demo banne par bhi alert jaye ya nahi. Default ON.
    // Band karna ho to: UPDATE system_settings SET value='0' WHERE key='demo_alert';
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('demo_alert','1') ON CONFLICT DO NOTHING");
    // Login par apna captcha. Default ON.
    // Band: UPDATE system_settings SET value='0' WHERE key='captcha_enabled';
    // Ya Render me env var CAPTCHA_OFF=1 (turant, DB chhue bina).
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('captcha_enabled','1') ON CONFLICT DO NOTHING");
    // Brevo HTTPS API — Render jaise hosts SMTP ports block karte hain,
    // isliye default yahi hai (port 443 kabhi block nahi hota).
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('brevo_api_key','') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('brevo_sender','') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('wl_license_fee','25000') ON CONFLICT DO NOTHING");
    // License ka "kata hua" price — 0 = dikhega hi nahi
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('wl_license_actual','0') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('wl_base_price','0') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('monthly_actual_price','0') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('advanced_actual_price','0') ON CONFLICT DO NOTHING");
    // Festival Offer — homepage One-Time price ke saath banner + countdown.
    // OFF by default; superadmin Setup Fee page se ON karega naam/date/time ke saath.
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('festival_offer_enabled','0') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('festival_offer_name','') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('festival_offer_end','') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('homepage_config', $1) ON CONFLICT DO NOTHING", [JSON.stringify(BRAND_DEFAULTS)]);

    // Broken demo logins repair (bcrypt hash galti se gaya tha; login sha256
    // expect karta hai). Idempotent — sirf $2 (bcrypt) wale demo shops.
    const brokenDemos = await pool.query(
      "SELECT id, phone FROM shops WHERE demo=true AND password_hash LIKE '$2%'");
    for (const d of brokenDemos.rows) {
      const h = await hashPassword(d.phone || '');
      await pool.query('UPDATE shops SET password_hash=$1 WHERE id=$2', [h, d.id]);
      console.log('🔧 Demo login repaired:', d.id);
    }

    await protectAppTables(pool);
    console.log('Database ready!');
  } catch(err) { console.error('DB initialization failed:', err.message); throw err; }
}

async function getSetupFeeAmount() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='setup_fee_amount'");
    if (r.rows.length) return parseInt(r.rows[0].value);
  } catch(e) {}
  return SETUP_FEE_AMOUNT;
}

async function getSetupPricing() {
  try {
    const r = await pool.query("SELECT key, value FROM system_settings WHERE key IN ('setup_fee_amount','setup_actual_price')");
    const map = {};
    r.rows.forEach(row => { map[row.key] = row.key.endsWith('_cycle') ? row.value : parseInt(row.value); });
    return {
      offerPrice: map.setup_fee_amount ?? SETUP_FEE_AMOUNT,
      monthlyFee: await getMonthlyFee(),
      actualPrice: map.setup_actual_price ?? SETUP_ACTUAL_PRICE
    };
  } catch(e) {
    return { offerPrice: SETUP_FEE_AMOUNT, actualPrice: SETUP_ACTUAL_PRICE };
  }
}

// Festival Offer — banner + countdown timer jo One-Time price ke saath
// homepage par dikhta hai. endAt ek ISO datetime string hai (jaise
// "2026-08-15T23:59"); front-end isi se ulta countdown chalata hai.
async function getFestivalOffer() {
  try {
    const r = await pool.query(
      "SELECT key, value FROM system_settings WHERE key IN ('festival_offer_enabled','festival_offer_name','festival_offer_end')"
    );
    const map = {};
    r.rows.forEach(row => { map[row.key] = row.value; });
    return {
      enabled: map.festival_offer_enabled === '1',
      name: map.festival_offer_name || '',
      endAt: map.festival_offer_end || ''
    };
  } catch(e) {
    return { enabled: false, name: '', endAt: '' };
  }
}

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Login required' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.shopId = decoded.shopId;
    next();
  } catch(err) {
    return res.status(401).json({ error: 'Session expired, please login again' });
  }
}

// ══════════════ REFER & EARN (shop side) ══════════════
// Referral dashboard: earnings, withdrawable, referred shops list
// ── Shop pause/holiday toggle ──
app.post('/api/shop/pause', verifyToken, async (req, res) => {
  try {
    const paused = !!req.body.paused;
    await pool.query('UPDATE shops SET paused=$1 WHERE id=$2', [paused, req.shopId]);
    res.json({ success: true, paused });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Supply self-report: '' | 'low_ink' | 'no_paper' ──
app.post('/api/shop/supply-warning', verifyToken, async (req, res) => {
  try {
    const w = String(req.body.warning || '');
    if (!['', 'low_ink', 'no_paper'].includes(w))
      return res.status(400).json({ error: 'Invalid warning' });
    await pool.query('UPDATE shops SET supply_warning=$1 WHERE id=$2', [w, req.shopId]);
    res.json({ success: true, warning: w });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── 7-din earning breakdown (sirf paid) ──
// Owner: customer ko dikhne wala notice set/clear
// Owner: advance feature khud on/off (sirf unlocked shop)
// Owner: apni shop ka logo upload (customer QR page par dikhega)
app.post('/api/shop/upload-logo', verifyToken, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Koi file nahi' });
    // SIRF PNG (transparent background ke liye) — JPG/WEBP allowed nahi
    if (req.file.mimetype !== 'image/png' || !isPng(req.file.buffer))
      return res.status(400).json({ error: 'Sirf PNG file chalegi (transparent background wali)' });
    // Max 50 KB
    if (req.file.size > 50 * 1024)
      return res.status(400).json({ error: `Logo 50 KB se chhota hona chahiye (abhi ${Math.round(req.file.size/1024)} KB hai)` });
    // Transparency check — PNG me alpha channel hona chahiye
    if (!pngHasAlpha(req.file.buffer))
      return res.status(400).json({ error: 'PNG transparent background wali honi chahiye (abhi solid background hai)' });
    const url = await uploadImageToCloudinary(req.file.buffer, req.file.mimetype);
    await pool.query('UPDATE shops SET shop_logo=$1 WHERE id=$2', [url, req.shopId]);
    res.json({ success: true, logoUrl: url });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Owner: logo hatao
app.post('/api/shop/remove-logo', verifyToken, async (req, res) => {
  try {
    await pool.query("UPDATE shops SET shop_logo='' WHERE id=$1", [req.shopId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/advance-active', verifyToken, async (req, res) => {
  try {
    const chk = await pool.query('SELECT advanced_unlocked FROM shops WHERE id=$1', [req.shopId]);
    if (!chk.rows.length || !chk.rows[0].advanced_unlocked)
      return res.status(403).json({ error: 'Advance feature unlock nahi hai' });
    const active = req.body.active === true;
    await pool.query('UPDATE shops SET advanced_active=$1 WHERE id=$2', [active, req.shopId]);
    res.json({ success: true, active });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Advance ke 4 module — har ek alag on/off.
// Column name whitelist se aata hai, isliye SQL injection ka scope nahi.
const ADV_MODULE_COLS = {
  legal:  'adv_legal_active',
  resume: 'adv_resume_active',
  '4x6':  'adv_4x6_active',
  a3:     'adv_a3_active',
  mini:   'adv_mini_active',
  scan:   'adv_scan_active'
};

app.post('/api/shop/advance-module', verifyToken, async (req, res) => {
  try {
    const col = ADV_MODULE_COLS[String(req.body.module || '')];
    if (!col) return res.status(400).json({ error: 'Galat module' });
    const chk = await pool.query('SELECT advanced_unlocked FROM shops WHERE id=$1', [req.shopId]);
    if (!chk.rows.length || !chk.rows[0].advanced_unlocked)
      return res.status(403).json({ error: 'Advance feature unlock nahi hai' });
    const active = req.body.active === true;
    const r = await pool.query(
      `UPDATE shops SET ${col}=$1 WHERE id=$2
       RETURNING adv_legal_active, adv_resume_active, adv_4x6_active, adv_a3_active, adv_mini_active`,
      [active, req.shopId]);
    res.json({ success: true, modules: r.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/notice', verifyToken, async (req, res) => {
  try {
    const notice = typeof req.body.notice === 'string' ? req.body.notice.slice(0, 200) : '';
    await pool.query('UPDATE shops SET shop_notice=$1 WHERE id=$2', [notice, req.shopId]);
    res.json({ success: true, notice });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Owner: busy-time + feedback summary insights
app.get('/api/shop/insights', verifyToken, async (req, res) => {
  try {
    // Busy hours (last 30 din, IST = UTC+5:30)
    const hours = await pool.query(
      `SELECT EXTRACT(HOUR FROM created_at + INTERVAL '5 hours 30 minutes') as hr, COUNT(*) as n
       FROM print_jobs WHERE shop_id=$1 AND ${JOB_COUNTS} AND created_at > NOW() - INTERVAL '30 days'
       GROUP BY hr ORDER BY n DESC LIMIT 1`, [req.shopId]);
    // Feedback tally
    const fb = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN feedback=1 THEN 1 ELSE 0 END),0) as up,
              COALESCE(SUM(CASE WHEN feedback=-1 THEN 1 ELSE 0 END),0) as down
       FROM print_jobs WHERE shop_id=$1`, [req.shopId]);
    let peak = null;
    if (hours.rows.length) {
      const h = parseInt(hours.rows[0].hr);
      const ampm = h < 12 ? 'AM' : 'PM';
      const h12 = h % 12 === 0 ? 12 : h % 12;
      peak = `${h12} ${ampm} - ${(h12 % 12) + 1} ${h < 11 || h >= 23 ? ampm : (h+1 < 12 ? 'AM' : 'PM')}`;
    }
    res.json({ peakHour: peak, feedbackUp: parseInt(fb.rows[0].up), feedbackDown: parseInt(fb.rows[0].down) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/earnings-breakdown', verifyToken, async (req, res) => {
  try {
    const daily = await pool.query(
      `SELECT DATE(created_at) as day,
              COUNT(*) as orders,
              COALESCE(SUM(copies),0) as prints,
              COALESCE(SUM(amount),0) as earnings
       FROM print_jobs
       WHERE shop_id=$1 AND ${JOB_COUNTS} AND created_at > NOW() - INTERVAL '7 days'
       GROUP BY DATE(created_at) ORDER BY day DESC`, [req.shopId]);
    const weeks = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN amount ELSE 0 END),0) as this_week,
              COALESCE(SUM(CASE WHEN created_at <= NOW() - INTERVAL '7 days' AND created_at > NOW() - INTERVAL '14 days' THEN amount ELSE 0 END),0) as last_week
       FROM print_jobs WHERE shop_id=$1 AND ${JOB_COUNTS}`, [req.shopId]);
    res.json({ daily: daily.rows, this_week: weeks.rows[0].this_week, last_week: weeks.rows[0].last_week });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/referral', verifyToken, async (req, res) => {
  try {
    const me = await pool.query('SELECT referral_earnings, agent_earnings, setup_paid, demo FROM shops WHERE id=$1', [req.shopId]);
    if (!me.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    const earnings = (me.rows[0].referral_earnings || 0) + (me.rows[0].agent_earnings || 0);
    const canRefer = me.rows[0].setup_paid && !me.rows[0].demo; // paid AND non-demo hi refer kare — warna demo user free ₹50 kamata

    // Withdrawn total (done + pending — dono balance se ghatao taaki double-withdraw na ho)
    const wd = await pool.query(
      "SELECT COALESCE(SUM(amount),0) as used FROM withdrawals WHERE shop_id=$1 AND status IN ('pending','done')",
      [req.shopId]);
    const used = parseInt(wd.rows[0].used) || 0;
    const available = earnings - used;

    // Referred shops list — naam, number, paid status
    const refs = await pool.query(
      // Agent ne jo shops khud onboard ki hain wo yahan NAHI — unka hisaab
      // Agent tab me alag dikhta hai (₹200 commission wala), warna ek hi shop
      // dono jagah dikh kar confuse karti hai
      `SELECT name, phone, setup_paid, created_at FROM shops
       WHERE referred_by=$1 AND COALESCE(onboarded_by,'')='' ORDER BY created_at DESC`,
      [req.shopId]);

    // Withdrawal history
    const hist = await pool.query(
      `SELECT amount, upi_id, status, requested_at, completed_at FROM withdrawals WHERE shop_id=$1 ORDER BY requested_at DESC`,
      [req.shopId]);

    res.json({
      canRefer,
      earnings,
      available,
      referred: refs.rows.map(r => ({
        name: r.name, phone: r.phone,
        status: r.setup_paid ? 'paid' : 'pending',
        date: r.created_at
      })),
      withdrawals: hist.rows
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// AGENT APIs — shop login (verifyToken) ke andar
// ══════════════════════════════════════════════════════════════

// Mera agent status + stats
app.get('/api/agent/status', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id,name,is_agent,agent_code,agent_upi,agent_price,agent_blocked,
              agent_earnings,agent_joined_at,setup_paid,demo
       FROM shops WHERE id=$1`, [req.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    const s = r.rows[0];
    const base = await getAgentBasePrice();  // agent ka apna floor, public price nahi
    // ---- AGENT KE PAAS DO PLAN HAIN: Pro aur Premium ----
    // Superadmin dono ka alag floor set karta hai (Setup Fee page par
    // "PRO - AGENT FLOOR" aur "PREMIUM - AGENT FLOOR"). Ref-link wala
    // registration flow dono ko pehle se support karta hai, par ye status
    // API sirf Pro wala floor lautati thi -- isliye agent ke dashboard par
    // hamesha EK hi option dikhta tha. Ab dono jaate hain.
    const premiumBase = await getAgentPremiumBasePrice();
    const agentPlans = [
      { id: 'pro',     label: 'Pro',     price: base,
        advance: planIncludesAdvance('pro') },
      { id: 'premium', label: 'Premium', price: premiumBase,
        advance: planIncludesAdvance('premium') }
    ];

    let stats = { total: 0, paid: 0, pending: 0, demo: 0 };
    if (s.is_agent) {
      const c = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE setup_paid=true AND demo=false)::int AS paid,
                COUNT(*) FILTER (WHERE setup_paid=false AND demo=false)::int AS pending,
                COUNT(*) FILTER (WHERE demo=true)::int AS demo
         FROM shops WHERE onboarded_by=$1`, [req.shopId]);
      stats = c.rows[0];
    }
    const wd = await pool.query(
      "SELECT COALESCE(SUM(amount),0)::int AS used FROM withdrawals WHERE shop_id=$1 AND status IN ('pending','done')",
      [req.shopId]);

    res.json({
      is_agent: !!s.is_agent, agent_code: s.agent_code, upi: s.agent_upi || '',
      blocked: !!s.agent_blocked,
      // price/markup ka concept khatam — sab ek hi rate par bechte hain
      price: base, base_price: base, max_price: 0, can_set_price: false,
      // Naya: dono plan ki list + Premium ka floor. Upar wale purane field
      // waise ke waise hain, isliye koi purana panel nahi tootega.
      plans: agentPlans,
      premium_base_price: premiumBase,
      commission_per_shop: AGENT_COMMISSION,
      flat_commission: true,
      bonus_every: 0, bonus_amount: 0,
      earnings: s.agent_earnings || 0,
      withdrawn: wd.rows[0].used,
      available: Math.max(0, (s.agent_earnings || 0) - wd.rows[0].used),
      eligible: !!(s.setup_paid && !s.demo),
      joined_at: s.agent_joined_at, stats,
      link: s.agent_code ? `${BASE_URL}/?ref=${s.agent_code}` : null
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Agent bano — sirf paid (non-demo) shop owner
app.post('/api/agent/join', verifyToken, async (req, res) => {
  try {
    const r = await pool.query('SELECT setup_paid,demo,is_agent,agent_code FROM shops WHERE id=$1', [req.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    const s = r.rows[0];
    if (s.demo || !s.setup_paid)
      return res.status(403).json({ error: 'Agent banne ke liye pehle plan lena zaroori hai. Demo account agent nahi ban sakta.' });
    if (s.is_agent) return res.json({ success: true, agent_code: s.agent_code, already: true });

    const code = s.agent_code || await genAgentCode();
    await pool.query(
      'UPDATE shops SET is_agent=true, agent_code=$2, agent_joined_at=NOW() WHERE id=$1',
      [req.shopId, code]);
    res.json({ success: true, agent_code: code, link: `${BASE_URL}/?ref=${code}` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// UPI save — commission isi par aayega
app.put('/api/agent/upi', verifyToken, async (req, res) => {
  try {
    const upi = String(req.body.upi_id || '').trim();
    if (!/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(upi))
      return res.status(400).json({ error: 'Sahi UPI ID daalo (jaise name@bank)' });
    const r = await pool.query('SELECT is_agent FROM shops WHERE id=$1', [req.shopId]);
    if (!r.rows.length || !r.rows[0].is_agent) return res.status(403).json({ error: 'Aap agent nahi ho' });
    await pool.query('UPDATE shops SET agent_upi=$2 WHERE id=$1', [req.shopId, upi]);
    res.json({ success: true, upi_id: upi });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── AGENT APNA PRICE AB SET NAHI KAR SAKTA ──
// Purana system: agent base se upar apna price rakh kar markup kamata tha.
// Naya system: sabka price ek — commission flat ₹100. Endpoint 410 deta
// hai (route hata dene se purane panel par JS error aata, isliye rakha hai).
app.put('/api/agent/price', verifyToken, async (req, res) => {
  return res.status(410).json({
    error: 'Agent ab apna price set nahi kar sakta. Har shop par flat ₹' +
           AGENT_COMMISSION + ' commission milta hai.'
  });
});

// Meri onboard ki hui shops
app.get('/api/agent/shops', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.id, s.name, s.phone, s.address, s.created_at, s.setup_paid, s.demo, s.plan_type,
              s.base_price_at_signup, s.sold_price, s.setup_amount, s.agent_last_seen,
              EXTRACT(EPOCH FROM (NOW() - s.agent_last_seen))::int AS agent_seconds_ago,
              c.total AS earned, c.markup, c.commission, c.bonus
       FROM shops s
       LEFT JOIN agent_commissions c ON c.shop_id = s.id AND c.agent_id = $1
       WHERE s.onboarded_by=$1 ORDER BY s.created_at DESC`, [req.shopId]);
    res.json({ shops: r.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Kamai ka poora hisaab (payout history)
app.get('/api/agent/commissions', verifyToken, async (req, res) => {
  try {
    const c = await pool.query(
      'SELECT * FROM agent_commissions WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 200', [req.shopId]);
    const w = await pool.query(
      'SELECT amount, upi_id, status, requested_at, completed_at FROM withdrawals WHERE shop_id=$1 ORDER BY requested_at DESC LIMIT 50',
      [req.shopId]);
    res.json({ commissions: c.rows, payouts: w.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Agent khud kisi ki shop onboard kare — Shop ID + password generate
app.post('/api/agent/onboard', verifyToken, async (req, res) => {
  try {
    const me = await pool.query(
      'SELECT is_agent, agent_blocked, demo FROM shops WHERE id=$1', [req.shopId]);
    // Demo account sab kuch DEKH sakta hai, par shop onboard nahi kar sakta.
    // Frontend par bhi gate hai — ye doosri layer hai taaki koi seedha
    // API call karke bhi na nikal jaye.
    if (me.rows.length && me.rows[0].demo) {
      return res.status(403).json({
        error: 'To use this feature you must be a paid shop owner',
        needPlan: true
      });
    }
    if (!me.rows.length || !me.rows[0].is_agent) return res.status(403).json({ error: 'Aap agent nahi ho' });
    if (me.rows[0].agent_blocked) return res.status(403).json({ error: 'Aapka agent account abhi paused hai' });

    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim();
    const address = String(req.body.address || '').trim();
    if (!name) return res.status(400).json({ error: 'Shop ka naam zaroori hai' });
    if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Sahi 10 digit mobile number daalo' });

    // ---- KAUNSA PLAN ----
    // Agent ke channel par sirf Pro aur Premium bikte hain (Starter nahi) --
    // bilkul wahi niyam jo ref-link wale registration par lagta hai.
    // Pehle ye endpoint plan poochta hi nahi tha: har shop 'onetime' ban
    // jaati thi aur price PUBLIC setup fee se aata tha, agent ke floor se
    // nahi. Isliye superadmin do floor set karta tha par agent ko onboard
    // form par ek hi option dikhta tha.
    let agPlan = normalizePlan(req.body.plan);
    if (!PLANS_BY_CHANNEL.agent.includes(agPlan)) agPlan = 'pro';

    // Har plan ka apna agent floor -- aur bas WAHI.
    //
    // Agent ka apna markup KHATAM hai (PUT /api/agent/price ab 410 deta
    // hai, status me can_set_price:false). Par purani shops ki row me
    // `agent_price` abhi bhi pada hai -- Mahato Net Cafe me 1799. Pehle
    // yahan `agent_price > floor ? agent_price : floor` tha, isliye form
    // par Rs 799 dikhta tha aur shop Rs 1799 par ban jaati thi.
    // Ab jo superadmin ne set kiya, wahi lagta hai.
    const agFloor = agPlan === 'premium'
      ? await getAgentPremiumBasePrice()
      : await getAgentBasePrice();
    const base = agFloor;
    const sold = agFloor;
    const agCycle=(await getPlanPricing())[agPlan].billingCycle;

    // Baaki details — normal registration jaisi hi
    const printerModel = String(req.body.printer_model || '').trim().slice(0,120);
    const priceBw    = parsePrice(req.body.price_bw);
    const priceColor = parsePrice(req.body.price_color);
    const modes = ['counter_only','both','online_only'];
    const payMode = modes.includes(req.body.payment_mode) ? req.body.payment_mode : 'counter_only';
    // Online payment ke liye shop owner ki apni keys chahiye — wo baad me
    // Payment Setup se khud daalega, isliye agent sirf counter_only de sakta hai
    const finalMode = payMode === 'counter_only' ? 'counter_only' : 'counter_only';

    const shopId = 'SHOP_' + uuidv4().substring(0,8).toUpperCase();
    let password = String(req.body.password || '').trim();
    if (password.length < 4) {
      password = Math.random().toString(36).slice(-4).toUpperCase() + Math.floor(1000 + Math.random()*9000);
    }
    const passwordHash = await hashPassword(password);

    await pool.query(
      `INSERT INTO shops (id,name,address,phone,printer_model,price_bw,price_color,payment_mode,
         password_hash,setup_paid,setup_amount,plan_type,referred_by,onboarded_by,base_price_at_signup,sold_price,billing_cycle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$14,$11,$11,$12,$13,$15)`,
      [shopId, name, address, phone, printerModel,
       Number.isInteger(priceBw) && priceBw > 0 ? priceBw : 5,
       Number.isInteger(priceColor) && priceColor > 0 ? priceColor : 10,
       finalMode, passwordHash, sold, req.shopId, base, sold, agPlan, agCycle]);

    res.json({ success: true, shopId, password, amount: sold, plan: agPlan,
      pay_url: `${BASE_URL}/setup-payment/${shopId}` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════ SUPERADMIN: AGENTS ══════════════
app.get('/api/superadmin/agents', verifySuperAdmin, async (req, res) => {
  try {
    const base = await getAgentBasePrice();
    // Sabse zyada kamane wala agent SABSE UPAR. Uske neeche uski
    // onboard ki hui shops (wahi 'shops' array me jaati hain).
    const ags = await pool.query(
      `SELECT id,name,phone,agent_code,agent_upi,agent_price,agent_blocked,agent_earnings,agent_joined_at
       FROM shops WHERE is_agent=true
       ORDER BY COALESCE(agent_earnings,0) DESC, agent_joined_at DESC NULLS LAST`);
    const out = [];
    for (const a of ags.rows) {
      const sh = await pool.query(
        `SELECT s.id,s.name,s.phone,s.address,s.created_at,s.setup_paid,s.demo,s.plan_type,
                s.setup_amount,s.agent_last_seen,
                EXTRACT(EPOCH FROM (NOW() - s.agent_last_seen))::int AS agent_seconds_ago,s.paused,
                COALESCE(c.total,0) AS earned, c.created_at AS credited_at
         FROM shops s
         LEFT JOIN agent_commissions c ON c.shop_id=s.id AND c.agent_id=$1
         WHERE s.onboarded_by=$1 ORDER BY s.created_at DESC`, [a.id]);
      const wd = await pool.query(
        "SELECT COALESCE(SUM(amount),0)::int AS used FROM withdrawals WHERE shop_id=$1 AND status IN ('pending','done')",
        [a.id]);
      const paidShops = sh.rows.filter(s => s.setup_paid && !s.demo).length;
      out.push({
        ...a,
        base_price: base,
        markup: 0,                       // markup ka concept khatam
        shops_total: sh.rows.length,
        shops_paid:  paidShops,
        paid_out: wd.rows[0].used,
        pending_payout: Math.max(0, (a.agent_earnings || 0) - wd.rows[0].used),
        shops: sh.rows
      });
    }
    res.json({ agents: out, base_price: base, commission: AGENT_COMMISSION,
      flat_commission: true, max_price: 0, bonus_every: 0, bonus_amount: 0 });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/superadmin/agent/:shopId/block', verifySuperAdmin, async (req, res) => {
  try {
    const block = !!req.body.blocked;
    const r = await pool.query(
      'UPDATE shops SET agent_blocked=$2 WHERE id=$1 AND is_agent=true RETURNING id, agent_blocked',
      [req.params.shopId, block]);
    if (!r.rows.length) return res.status(404).json({ error: 'Agent nahi mila' });
    res.json({ success: true, blocked: r.rows[0].agent_blocked });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Withdrawal request — min ₹500, UPI zaroori
app.post('/api/shop/withdraw', verifyToken, async (req, res) => {
  try {
    const { upi_id } = req.body;
    if (!upi_id || !/^[\w.\-]+@[\w.\-]+$/.test(upi_id.trim()))
      return res.status(400).json({ error: 'Sahi UPI ID daalo (jaise name@bank)' });

    const me = await pool.query('SELECT referral_earnings, agent_earnings FROM shops WHERE id=$1', [req.shopId]);
    // Referral (₹50) + Agent commission — dono ek hi wallet me
    const earnings = (me.rows[0]?.referral_earnings || 0) + (me.rows[0]?.agent_earnings || 0);
    const wd = await pool.query(
      "SELECT COALESCE(SUM(amount),0) as used FROM withdrawals WHERE shop_id=$1 AND status IN ('pending','done')",
      [req.shopId]);
    const available = earnings - (parseInt(wd.rows[0].used) || 0);

    if (available < 500) return res.status(400).json({ error: `Withdrawal ke liye kam se kam ₹500 chahiye (abhi ₹${available})` });

    // Pending request already hai?
    const pend = await pool.query("SELECT id FROM withdrawals WHERE shop_id=$1 AND status='pending'", [req.shopId]);
    if (pend.rows.length) return res.status(400).json({ error: 'Ek withdrawal request pehle se pending hai' });

    await pool.query('INSERT INTO withdrawals (shop_id, amount, upi_id) VALUES ($1,$2,$3)',
      [req.shopId, available, upi_id.trim()]);
    res.json({ success: true, amount: available });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════ WITHDRAWALS (superadmin side) ══════════════
// ── MANUAL ACTIVATE — jab payment Razorpay me dikh raha ho par website
// par match nahi hua (browser band, DB outage me order_id store nahi hua,
// waghera). activateShop hi use hota hai — QR, referral reward sab same. ──
app.post('/api/superadmin/shop/:shopId/activate', verifySuperAdmin, async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const ref = String((req.body && req.body.payment_ref) || '').trim().slice(0, 60);
    if (!ref) return res.status(400).json({ error: 'Payment reference/ID daalo (Razorpay dashboard se)' });
    const chk = await pool.query('SELECT id, setup_paid FROM shops WHERE id=$1', [shopId]);
    if (!chk.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    if (chk.rows[0].setup_paid) return res.status(400).json({ error: 'Shop pehle se active hai' });
    const { qrUrl } = await activateShop(shopId, 'MANUAL_' + ref);
    console.log(`Manual activation: ${shopId} | ref: ${ref}`);
    res.json({ success: true, qrUrl });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Password reset (superadmin) — number badal gaya / bhool gaya cases ──
// Support: monthly shop ko +30 din (cash/offline payment case)
app.post('/api/superadmin/shop/:shopId/extend', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE shops SET paid_until = GREATEST(NOW(), COALESCE(paid_until, NOW())) + make_interval(months=>(${MONTHS_SQL}))
       WHERE id=$1 AND (${MONTHS_SQL})>0 RETURNING paid_until`, [req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    console.log(`Superadmin extend +30d: ${req.params.shopId} -> ${r.rows[0].paid_until}`);
    res.json({ success: true, paid_until: r.rows[0].paid_until });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Support: kisi bhi shop ko Advance Feature FREE unlock (bina payment)
app.post('/api/superadmin/shop/:shopId/unlock-advanced', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE shops SET advanced_unlocked=true WHERE id=$1 RETURNING id, name",
      [req.params.shopId]);
    // Manual unlock bhi core pack deta hai — warna superadmin se
    // khola gaya shop me feature-wise ownership khaali reh jaati.
    {
      const catalog = await getAdvanceFeatures();
      await grantFeatures(req.params.shopId, coreFeatureIds(catalog));
    }
    if (!r.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    console.log(`Superadmin FREE advanced unlock: ${req.params.shopId}`);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Support: kisi bhi shop ko EK add-on feature free do ya wapas lo.
// unlock-advanced poora core pack deta hai; ye single feature ke liye hai
// (jaise Smart Scanner) — taaki bina ₹49 liye bhi kisi ko diya ja sake.
app.post('/api/superadmin/shop/:shopId/feature', verifySuperAdmin, async (req, res) => {
  try {
    const featureId = String(req.body.featureId || '').trim().toLowerCase();
    const grant = req.body.grant !== false;      // default = de do
    if (!featureId) return res.status(400).json({ error: 'featureId chahiye' });

    const catalog = await getAdvanceFeatures();
    if (!catalog.some(f => f.id === featureId))
      return res.status(404).json({ error: 'Ye feature catalog me hai hi nahi' });

    const sh = await pool.query(
      'SELECT id, name, plan_type FROM shops WHERE id=$1', [req.params.shopId]);
    if (!sh.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });

    // Premium ka hisaab plan se nikalta hai, owned_features se nahi —
    // wahan list badalne ka koi asar hi nahi hota. Saaf mana kar do
    // warna superadmin ko lagega ki kaam ho gaya.
    if (sh.rows[0].plan_type === 'premium') {
      return res.status(400).json({
        error: grant
          ? 'Premium shop ko ye pehle se free milta hai — kuch karne ki zaroorat nahi'
          : 'Premium se feature hataya nahi ja sakta — pehle plan badlo'
      });
    }

    if (grant) await grantFeatures(req.params.shopId, [featureId]);
    else       await revokeFeatures(req.params.shopId, [featureId]);

    const after = await pool.query(
      'SELECT owned_features FROM shops WHERE id=$1', [req.params.shopId]);
    console.log(`Superadmin feature ${grant ? 'GRANT' : 'REVOKE'}: ${featureId} | shop ${req.params.shopId}`);
    res.json({ success: true, featureId, granted: grant,
               owned_features: after.rows[0]?.owned_features || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/shop/:shopId/reset-password', verifySuperAdmin, async (req, res) => {
  try {
    const temp = 'ECHEL' + crypto.randomBytes(3).toString('hex');
    const h = await hashPassword(temp);
    const r = await pool.query('UPDATE shops SET password_hash=$1 WHERE id=$2 RETURNING id', [h, req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    console.log(`Password reset by superadmin: ${req.params.shopId}`);
    res.json({ success: true, tempPassword: temp });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Demo accounts list — nazar rakhne + manual delete ke liye ──
// Cloudinary status — kitni file abhi padi hai (sach, DB se nahi, Cloudinary se)
// Echel starts from its own database; cross-project copying is unavailable.
// ══════════════ BACKUP DOWNLOAD ══════════════
// Supabase free me automatic backup nahi hota. Ye button poora DB ek JSON
// file me deta hai — hafte me ek baar dabao, apne phone/PC me rakh lo.
app.get('/api/superadmin/backup', verifySuperAdmin, async (req, res) => {
  try {
    const dump = { taken_at: new Date().toISOString(), tables: {} };
    for (const table of APP_TABLES) {
      try {
        const r = await pool.query(`SELECT * FROM ${table}`);
        dump.tables[table] = r.rows;
      } catch (e) { dump.tables[table] = { error: e.message }; }
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="echel-backup-${stamp}.json"`);
    res.send(JSON.stringify(dump, null, 2));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Row counts — migration verify karne ke liye
app.get('/api/superadmin/db-counts', verifySuperAdmin, async (req, res) => {
  try {
    const counts = {};
    for (const t of APP_TABLES) {
      try {
        const r = await pool.query(`SELECT COUNT(*) FROM ${t}`);
        counts[t] = parseInt(r.rows[0].count);
      } catch (e) { counts[t] = -1; }
    }
    res.json(counts);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/cloudinary-status', verifySuperAdmin, async (req, res) => {
  try {
    const { files, errors } = await listAllCloudinaryFiles();
    const now = Date.now();
    const mapped = files.map(r => ({
      public_id: r.public_id,
      resource_type: r.resource_type,
      bytes: r.bytes || 0,
      kb: Math.round((r.bytes || 0) / 1024),
      age_min: Math.round((now - new Date(r.created_at).getTime()) / 60000)
    })).sort((a, b) => b.bytes - a.bytes);

    const totalBytes = mapped.reduce((s, f) => s + f.bytes, 0);
    const byType = {};
    mapped.forEach(f => { byType[f.resource_type] = (byType[f.resource_type] || 0) + 1; });

    res.json({
      count: mapped.length,
      total_kb: Math.round(totalBytes / 1024),
      total_mb: Math.round(totalBytes / 1048576 * 10) / 10,
      stale: mapped.filter(f => f.age_min >= 90).length,
      over_40kb: mapped.filter(f => f.kb > 40).length,
      by_type: byType,
      errors,                       // khali na ho to panel me dikhao
      files: mapped.slice(0, 20)
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Manual sweep — "abhi saaf karo" button
// Body options (sab optional):
//   min_kb    : itne KB se badi file delete karo (jaise 40)
//   min_age   : itne minute purani file delete karo (default 90)
//   any_size  : true bhejo to size dekhe bina purani sab delete
app.post('/api/superadmin/cloudinary-sweep', verifySuperAdmin, async (req, res) => {
  try {
    if (req.body && req.body.min_kb !== undefined) return res.status(404).json({error:'Action unavailable'});
    const minKb  = req.body && req.body.min_kb  !== undefined ? parseInt(req.body.min_kb, 10)  : null;
    const minAge = req.body && req.body.min_age !== undefined ? parseInt(req.body.min_age, 10) : 90;

    const { files, errors } = await listAllCloudinaryFiles();
    let swept = 0, freedBytes = 0, skippedActive = 0, skippedRule = 0;
    const failed = [];

    for (const r of files) {
      const ageMin = (Date.now() - new Date(r.created_at).getTime()) / 60000;
      const kb = Math.round((r.bytes || 0) / 1024);

      // Rule: size wala rule diya ho to wahi, warna umar wala
      const matches = (minKb !== null && !isNaN(minKb))
        ? kb > minKb
        : ageMin >= minAge;
      if (!matches) { skippedRule++; continue; }

      // Jo file abhi print hone wali hai use kabhi mat chhedo
      const active = await pool.query(
        "SELECT 1 FROM print_jobs WHERE file_public_id=$1 AND status IN ('queued','printing')",
        [r.public_id]);
      if (active.rows.length) { skippedActive++; continue; }

      try {
        await deleteFromCloudinary(r.public_id, r.resource_type);
        await pool.query('UPDATE print_jobs SET file_deleted=true WHERE file_public_id=$1', [r.public_id]);
        swept++; freedBytes += (r.bytes || 0);
      } catch (e) {
        failed.push(r.public_id);
      }
    }

    console.log(`[cloudinary-sweep] deleted=${swept} freed=${Math.round(freedBytes/1024)}KB ` +
                `skipped(active=${skippedActive}, rule=${skippedRule}) failed=${failed.length}`);
    res.json({
      success: true, swept,
      freed_kb: Math.round(freedBytes / 1024),
      scanned: files.length,
      skipped_active: skippedActive,
      skipped_rule: skippedRule,
      failed: failed.length,
      errors
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/demo-config', verifySuperAdmin, async (req, res) => {
  res.json(await getDemoConfig());
});
app.put('/api/superadmin/demo-config', verifySuperAdmin, async (req, res) => {
  try {
    const enabled = req.body.enabled ? '1' : '0';
    let mins = parseInt(req.body.minutes);
    if (isNaN(mins) || mins < 15 || mins > DEMO_MAX_MINUTES)
      return res.status(400).json({ error: 'Minutes 15 se ' + DEMO_MAX_MINUTES + ' (365 din) ke beech ho' });
    // Print limit optional hai — na bheja ho to purani value waise ki waisi.
    let printLimit = null;
    if (req.body.printLimit !== undefined && req.body.printLimit !== null && req.body.printLimit !== '') {
      printLimit = parseInt(req.body.printLimit);
      if (isNaN(printLimit) || printLimit < 1 || printLimit > DEMO_MAX_PRINTS)
        return res.status(400).json({ error: 'Print limit 1 se ' + DEMO_MAX_PRINTS + ' ke beech ho' });
    }
    await pool.query("UPDATE system_settings SET value=$1 WHERE key='demo_enabled'", [enabled]);
    await pool.query("UPDATE system_settings SET value=$1 WHERE key='demo_minutes'", [String(mins)]);
    if (printLimit !== null) {
      await pool.query(
        `INSERT INTO system_settings (key, value) VALUES ('demo_print_limit', $1)
         ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`, [String(printLimit)]);
    }
    // instant bheja hi na ho to purani setting waise ki waisi rehti hai
    if (req.body.instant !== undefined) {
      await pool.query("UPDATE system_settings SET value=$1 WHERE key='demo_auto_approve'",
                       [req.body.instant ? '1' : '0']);
    }
    res.json({ success: true, ...(await getDemoConfig()) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/demos', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.id, s.name, s.phone, s.created_at, s.demo_expires_at, s.agent_last_seen,
              EXTRACT(EPOCH FROM (NOW() - s.agent_last_seen))::int AS agent_seconds_ago, s.agent_version, s.agent_version_label,
             s.agent_machine, (s.agent_token IS NOT NULL) AS agent_bound,
              (SELECT COUNT(*) FROM print_jobs j WHERE j.shop_id = s.id) as total_jobs,
              (SELECT COUNT(*) FROM print_jobs j WHERE j.shop_id = s.id
                 AND j.payment_status='paid'
                 AND COALESCE(j.status,'') NOT IN ('cancelled','abandoned','failed')) as prints
       FROM shops s WHERE s.demo = true
       ORDER BY s.created_at DESC`);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/withdrawals', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT w.id, w.shop_id, s.name, s.phone, w.amount, w.upi_id, w.status, w.requested_at, w.completed_at
       FROM withdrawals w LEFT JOIN shops s ON w.shop_id=s.id
       ORDER BY (w.status='pending') DESC, w.requested_at DESC`);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/withdrawals/:id/complete', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE withdrawals SET status='done', completed_at=NOW() WHERE id=$1 AND status='pending' RETURNING shop_id, amount",
      [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Pending withdrawal nahi mili' });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════ FREE DEMO (24 ghante, 10 print) ══════════════════
// Anti-abuse: (1) ek phone = ek demo PERMANENT, (2) ek IP = 2/din,
// (3) ek MACHINE = ek demo permanent (agent MachineGuid bhejta hai).
// Demo settings ki upar wali seema — superadmin isse neeche kuch bhi rakh
// sakta hai. 365 din / 1 lakh prints practically "jitna chahe" hi hai.
const DEMO_MAX_MINUTES = 365 * 24 * 60;   // 525600
const DEMO_MAX_PRINTS  = 100000;

async function getDemoConfig() {
  try {
    const r = await pool.query(
      "SELECT key,value FROM system_settings WHERE key IN ('demo_enabled','demo_minutes','demo_print_limit','demo_auto_approve')");
    const m = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
    // Superadmin jitna chahe utna set kar sakta hai — bas 15 min se kam nahi
    // aur DEMO_MAX_MINUTES (1 saal) se zyada nahi, taaki typo se koi demo
    // hamesha ke liye na khul jaaye.
    const mins = Math.max(15, Math.min(DEMO_MAX_MINUTES, parseInt(m.demo_minutes) || 1440));
    return {
      enabled: (m.demo_enabled || '1') === '1',
      minutes: mins,
      printLimit: Math.max(1, Math.min(DEMO_MAX_PRINTS, parseInt(m.demo_print_limit) || 10)),
      // instant = form submit karte hi demo ban jaata hai (default).
      // false = purana flow: pehle superadmin Accept kare tabhi bane.
      autoApprove: (m.demo_auto_approve || '1') === '1',
      instant:     (m.demo_auto_approve || '1') === '1'
    };
  } catch (e) { return { enabled: true, minutes: 1440, printLimit: 10, autoApprove: true, instant: true }; }
}

/**
 * Demo shop banao. Approval ke baad (superadmin) aur legacy auto-approve
 * dono yahi function use karte hain — do jagah logic duplicate nahi hoti.
 * Timer YAHIN se shuru hota hai, registration ke waqt se nahi.
 */
async function createDemoShop(d) {
  const cfg = await getDemoConfig();
  const shopId = 'DEMO_' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const passwordHash = await hashPassword(d.phone);
  const shopName = (d.shopName || d.name || 'Demo Shop').slice(0, 180);

  await pool.query(
    // advanced_unlocked=true — demo me saare advanced features khule rehte
    // hain. Aadha software dikha kar paise maangna ulta padta hai.
    `INSERT INTO shops (id, name, phone, email, address, printer_model,
                        price_bw, price_color, payment_mode, password_hash,
                        setup_paid, setup_amount, demo, demo_expires_at, advanced_unlocked)
     VALUES ($1,$2,$3,$4,$5,$6,5,10,'counter_only',$7,true,0,true,
             NOW() + ($8 || ' minutes')::INTERVAL, true)`,
    [shopId, shopName + ' (Demo)', d.phone, (d.email || '').slice(0,150),
     (d.address || '').slice(0,300), (d.printerModel || '').slice(0,100),
     passwordHash, String(cfg.minutes)]);

  const qrUrl = `${BASE_URL}/print/${shopId}`;
  const qrCode = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 });
  await pool.query('UPDATE shops SET qr_code=$1 WHERE id=$2', [qrCode, shopId]);

  // Alert bhejo - par uska intezaar mat karo. Email atak jaye ya fail
  // ho jaye to bhi demo banna ruk nahi sakta. alertNewShop bhi aise hi
  // bulaya jaata hai, aur andar apna try/catch rakhta hai.
  alertNewDemo(shopId, d.how);

  return { shopId, qrUrl, qrCode, minutes: cfg.minutes, printLimit: cfg.printLimit };
}

/**
 * Upgrade karne par kaun se plan available hain — server se aate hain,
 * frontend me hardcode nahi. Demo limit hit hone par yahi dikhaye jaate hain.
 */
async function getUpgradePlans() {
  try {
    const r = await pool.query(
      "SELECT key,value FROM system_settings WHERE key IN ('monthly_fee','lifetime_fee')");
    const m = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
    const monthly = parseInt(m.monthly_fee) || 399;
    const lifetime = parseInt(m.lifetime_fee) || 999;
    return [
      { id: 'monthly',  name: 'Monthly Plan',  price: monthly,  period: '/month',
        note: 'Unlimited prints, all advanced features' },
      { id: 'lifetime', name: 'Lifetime Plan', price: lifetime, period: 'one-time',
        note: 'Pay once, use forever — no renewal' }
    ];
  } catch (e) {
    return [{ id: 'monthly', name: 'Monthly Plan', price: 399, period: '/month', note: '' }];
  }
}

/**
 * Demo shop ne apni free print limit to nahi cross kar li?
 * Har paid-print path se pehle call hota hai.
 */
async function checkDemoAllowance(shopId) {
  const r = await pool.query('SELECT demo, demo_expires_at FROM shops WHERE id=$1', [shopId]);
  if (!r.rows.length || !r.rows[0].demo) return { ok: true, demo: false };

  const cfg = await getDemoConfig();
  if (isDemoExpired(r.rows[0])) {
    return { ok: false, demo: true, reason: 'expired', used: null, limit: cfg.printLimit,
             error: 'Your demo has ended. Please upgrade to continue printing.' };
  }
  // Demo print limit — cancel/abandon/fail hue job limit me nahi ginte,
  // warna customer ka job fail hone par demo user ka quota kat jaata tha.
  const c = await pool.query(
    `SELECT COUNT(*)::int AS n FROM print_jobs WHERE shop_id=$1 AND ${JOB_COUNTS}`, [shopId]);
  const used = c.rows[0].n;
  if (used >= cfg.printLimit) {
    return { ok: false, demo: true, reason: 'limit', used, limit: cfg.printLimit,
             error: `Free demo limit reached (${cfg.printLimit} prints). Please upgrade to continue printing.` };
  }
  return { ok: true, demo: true, used, limit: cfg.printLimit, remaining: cfg.printLimit - used };
}

function normPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

// ══════════════════════════════════════════════════════════════
// ASLI MOBILE NUMBER CHECK
// Log form bharne se bachne ke liye 9999999999 / 1234567890 jaisa
// kuch bhi daal dete the aur demo waste ho jaata tha. Ye validator
// sirf pattern dekhta hai — koi paid API nahi, koi OTP nahi.
// Ye SERVER ka final faisla hai; homepage par same rules dobara
// chalte hain sirf turant feedback dene ke liye.
// ══════════════════════════════════════════════════════════════
const FAKE_MOBILE_LIST = new Set([
  '9999999999','8888888888','7777777777','6666666666','1111111111','0000000000',
  '1234567890','9876543210','9123456789','9987654321','1234512345','9999900000',
  '9000000000','8000000000','7000000000','6000000000','9090909090','9080706050',
  '9999988888','9876512345','8765432109','7654321098','9998887776','9876543211',
  '9999999998','9999999990','9111111111','8123456789','7123456789','6123456789'
]);

/** +91 / 0 / spaces hata kar saaf 10 digit. Sahi na ho to ''. */
function normIndianMobile(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('091')) d = d.slice(3);
  else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0'))  d = d.slice(1);
  return d.length === 10 ? d : '';
}

/**
 * 1234567890 / 9876543210 / 6789012345 jaisa seedha sequence?
 * Modulo-10 step use karte hain taaki 9->0 ka wrap bhi pakda jaye.
 */
function _isRunSequence(d) {
  if (d.length < 4) return false;
  let asc = true, desc = true;
  for (let i = 1; i < d.length; i++) {
    const step = (Number(d[i]) - Number(d[i - 1]) + 10) % 10;
    if (step !== 1) asc = false;
    if (step !== 9) desc = false;   // -1 mod 10
  }
  return asc || desc;
}

/** 1212121212 / 1234512345 / 1111111111 jaisa dohraya hua block? */
function _isRepeatingBlock(d) {
  for (const size of [1, 2, 5]) {
    if (d.length % size !== 0) continue;
    const block = d.slice(0, size);
    let same = true;
    for (let i = size; i < d.length; i += size) {
      if (d.slice(i, i + size) !== block) { same = false; break; }
    }
    if (same) return true;
  }
  return false;
}

/** Sabse lamba ek hi digit ka run (9000000001 -> 8). */
function _longestRun(d) {
  let best = 1, run = 1;
  for (let i = 1; i < d.length; i++) {
    run = d[i] === d[i - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/**
 * Demo form ka phone check.
 * @returns {{ok:boolean, phone:string, error:string}}
 */
function validateIndianMobile(raw) {
  const d = normIndianMobile(raw);
  const bad = msg => ({ ok: false, phone: '', error: msg });

  if (!d) return bad('Please enter a valid 10-digit mobile number.');
  // TRAI: mobile series sirf 6/7/8/9 se shuru hoti hai
  if (!/^[6-9]/.test(d))
    return bad('Indian mobile numbers start with 6, 7, 8 or 9. Please check the number.');
  if (FAKE_MOBILE_LIST.has(d))
    return bad('That looks like a test number. Please enter your real WhatsApp number.');
  if (_isRepeatingBlock(d))
    return bad('That number looks made up. Please enter your real WhatsApp number.');
  if (_isRunSequence(d) || _isRunSequence(d.slice(1)))
    return bad('That number looks made up. Please enter your real WhatsApp number.');
  if (new Set(d.split('')).size <= 2)
    return bad('That number looks made up. Please enter your real WhatsApp number.');
  if (_longestRun(d) >= 7)
    return bad('That number looks made up. Please enter your real WhatsApp number.');
  // 9988776655 / 1122334455 — har jodi ek hi digit ki
  if (/^(\d)\1(\d)\2(\d)\3(\d)\4(\d)\5$/.test(d))
    return bad('That number looks made up. Please enter your real WhatsApp number.');

  return { ok: true, phone: d, error: '' };
}
/**
 * Wahi jaanch, par register page ki bhasha me.
 * Faisla validateIndianMobile ka; yahan sirf message badalta hai.
 */
function registerPhoneCheck(raw) {
  const v = validateIndianMobile(raw);
  if (v.ok) return v;
  const d = normIndianMobile(raw);
  const bad = msg => ({ ok: false, phone: '', error: msg });
  if (!d) return bad('Sahi 10-digit mobile number daalo.');
  if (!/^[6-9]/.test(d))
    return bad('Mobile number 6, 7, 8 ya 9 se shuru hota hai — dobara check karo.');
  if (FAKE_MOBILE_LIST.has(d))
    return bad('Ye test number hai — apna asli WhatsApp number daalo.');
  return bad('Ye number asli nahi lag raha — apna WhatsApp number daalo.');
}

function isDemoExpired(shop) {
  return shop && shop.demo && shop.demo_expires_at &&
         new Date(shop.demo_expires_at).getTime() < Date.now();
}

// ═══════════════════════════════════════════════
// DEMO REQUEST → SUPERADMIN APPROVAL → ACTIVATION
// Public form ab seedha shop nahi banata. Pehle 'pending' request banti
// hai; superadmin Accept kare tabhi demo shop create hoti hai aur 24 ghante
// ka timer shuru hota hai.
// ═══════════════════════════════════════════════
app.post('/api/demo/request', demoRateLimit, async (req, res) => {
  try {
    const cfg = await getDemoConfig();
    if (!cfg.enabled) {
      return res.status(403).json({ error: 'Demo is currently unavailable. Please register directly.' });
    }

    const b = req.body || {};
    const name    = String(b.name || '').trim().slice(0, 100);
    const phoneChk = validateIndianMobile(b.phone);
    const phone   = phoneChk.phone;
    const shopName= String(b.shopName || '').trim().slice(0, 180);
    const address = String(b.address || '').trim().slice(0, 300);
    const email   = String(b.email || '').trim().slice(0, 150);
    const printer = String(b.printerModel || '').trim().slice(0, 100);

    if (!name)      return res.status(400).json({ error: 'Please enter your name' });
    if (!phoneChk.ok) return res.status(400).json({ error: phoneChk.error });
    if (!shopName)  return res.status(400).json({ error: 'Please enter your shop name' });
    if (!address)   return res.status(400).json({ error: 'Please enter your shop address' });
    if (!printer)   return res.status(400).json({ error: 'Please select your printer' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }

    // Bot challenge — sirf tab enforce hota hai jab TURNSTILE_SECRET_KEY set ho.
    // Set na ho to skip, taaki abhi kuch na toote.
    const ts = await verifyTurnstile(b.turnstileToken, clientIp(req));
    if (!ts.ok) {
      await logSecurityEvent({ ip: clientIp(req), endpoint: '/api/demo/request', method: 'POST',
        action: 'DEMO_REQUEST', reason: 'CAPTCHA_FAILED:' + (ts.reason || ''),
        userAgent: req.headers['user-agent'] });
      return res.status(403).json({ error: 'Verification failed. Please refresh the page and try again.' });
    }

    // Layer 1: ek phone = ek demo (pending ya approved, dono count hote hain)
    const dup = await pool.query('SELECT status FROM demo_registrations WHERE phone=$1', [phone]);
    if (dup.rows.length) {
      return res.status(400).json({
        error: dup.rows[0].status === 'pending'
          ? 'A demo request for this number is already awaiting approval.'
          : 'A demo has already been taken on this number. Please register to continue.'
      });
    }
    const dupShop = await pool.query('SELECT id FROM shops WHERE phone=$1 AND demo=true', [phone]);
    if (dupShop.rows.length) {
      return res.status(400).json({ error: 'A demo has already been taken on this number. Please register to continue.' });
    }

    // Layer 2: ek IP se max DEMO_DAILY_PER_IP request / din (default 2).
    // Ye sirf BANE hue demo ginta hai (DB rows), koshishein nahi — isliye
    // form galat bharne se ye limit nahi katti.
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 60);
    const ipCount = await pool.query(
      "SELECT COUNT(*)::int AS n FROM demo_registrations WHERE ip=$1 AND created_at > NOW() - INTERVAL '24 hours'", [ip]);
    if (ipCount.rows[0].n >= SEC.demoDailyPerIp) {
      return res.status(429).json({ error: "Today's demo limit reached. Please try tomorrow or register now." });
    }

    let reg;
    try {
      reg = await pool.query(
        `INSERT INTO demo_registrations (phone, ip, name, email, shop_name, address, printer_model, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,
        [phone, ip, name, email, shopName, address, printer]);
    } catch (e) {
      if (e.code === '23505') {   // race: doosri request pehle aa gayi
        return res.status(400).json({ error: 'A demo request for this number already exists.' });
      }
      throw e;
    }

    // Demo sach me ban gaya — AB IP ki ginti badhao. Isse upar wale saare
    // rejections (validation, duplicate phone, captcha) quota nahi khaate.
    if (typeof req.countDemoRequest === 'function') req.countDemoRequest();

    // ── INSTANT ACTIVATION (default) ──
    // Form submit karte hi shop ban jaati hai aur Shop ID + password
    // wahin screen par aa jaate hain. Manual approval sirf tab jab
    // superadmin ne Demo Control se off kiya ho.
    if (cfg.instant) {
      const created = await createDemoShop({ name, phone, shopName, address, email, printerModel: printer });
      await pool.query(
        "UPDATE demo_registrations SET shop_id=$1, status='approved', reviewed_at=NOW() WHERE id=$2",
        [created.shopId, reg.rows[0].id]);
      console.log(`Demo INSTANT activated: ${created.shopId} | ${phone} | ip ${ip}`);
      return res.json({
        success: true, approved: true,
        shopId: created.shopId,
        password: phone,
        qrUrl: created.qrUrl,
        qrCode: created.qrCode,
        loginUrl: `${BASE_URL}/admin`,
        minutes: created.minutes,
        hours: Math.round(created.minutes / 60),
        printLimit: created.printLimit,
        expiresInMinutes: created.minutes
      });
    }

    console.log(`Demo REQUEST received: #${reg.rows[0].id} | ${name} | ${phone} | ${shopName} | ip ${ip}`);
    res.json({
      success: true, approved: false, requestId: reg.rows[0].id,
      message: 'Your demo request has been submitted. We will activate it shortly and send your Shop ID on WhatsApp.'
    });
  } catch(err) {
    console.error('Demo request error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── SUPERADMIN: security events + live block state ───
app.get('/api/superadmin/security-events', verifySuperAdmin, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 50));
    const r = await pool.query(
      `SELECT id, created_at, ip, shop_id, endpoint, method, action, reason, upload_count, file_size
         FROM security_events ORDER BY created_at DESC LIMIT $1`, [limit]);

    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const stats = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(DISTINCT ip)::int AS ips,
              COUNT(*) FILTER (WHERE reason LIKE 'IP_RATE_LIMIT%')::int  AS rate_limited,
              COUNT(*) FILTER (WHERE reason LIKE 'UPLOAD_BURST%')::int   AS bursts,
              COUNT(*) FILTER (WHERE reason LIKE 'CAPTCHA_FAILED%')::int AS captcha_fails
         FROM security_events WHERE created_at > $1`, [since]);

    // Abhi kaun block hai (in-memory)
    const now = Date.now();
    const active = [];
    for (const [k, until] of abuseBlocks) {
      if (until > now) active.push({ key: k, minutesLeft: Math.ceil((until - now) / 60000) });
    }
    res.json({
      events: r.rows,
      last24h: stats.rows[0],
      activeBlocks: active,
      globalBrake: { tripped: globalWindow.tripped, count: globalWindow.count, limit: SEC.globalPerMin },
      config: {
        demoIpMax: SEC.demoIpMax, demoWindowMin: SEC.demoWindowMin,
        uploadsPerMin: SEC.uploadsPerMin, blockMin: SEC.blockMin,
        turnstile: !!SEC.turnstileSecret
      }
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Pakka IP blocklist: dekho / lagao / hatao ──
// Sath me haal hi ke registration bhi, taaki superadmin dekh sake ki
// kaunsa IP baar-baar bina paise wali shop bana raha hai.
app.get('/api/superadmin/ip-bans', verifySuperAdmin, async (req, res) => {
  try {
    const bans = await pool.query(
      'SELECT ip, reason, created_at FROM blocked_ips ORDER BY created_at DESC');
    const regs = await pool.query(
      `SELECT id, name, created_ip, setup_paid, created_at
         FROM shops
        WHERE created_at > NOW() - INTERVAL '30 days'
        ORDER BY created_at DESC LIMIT 60`);
    // Kis IP se kitni unpaid shop — sabse upar sabse zyada
    const worst = await pool.query(
      `SELECT created_ip AS ip,
              COUNT(*)::int AS kul,
              COUNT(*) FILTER (WHERE setup_paid = false)::int AS unpaid
         FROM shops
        WHERE COALESCE(created_ip,'') <> ''
        GROUP BY created_ip
       HAVING COUNT(*) FILTER (WHERE setup_paid = false) > 1
        ORDER BY unpaid DESC LIMIT 20`);
    res.json({ bans: bans.rows, recent: regs.rows, worst: worst.rows,
               unpaidPerIpPerDay: UNPAID_PER_IP_DAY });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/ip-ban', verifySuperAdmin, async (req, res) => {
  try {
    const ip = String(req.body.ip || '').trim().slice(0, 60);
    if (!ip) return res.status(400).json({ error: 'IP daalo' });
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    await pool.query(
      `INSERT INTO blocked_ips (ip, reason) VALUES ($1,$2)
       ON CONFLICT (ip) DO UPDATE SET reason = EXCLUDED.reason`, [ip, reason]);
    clearIpBanCache();
    console.log(`SECURITY: IP permanently banned by superadmin | ${ip} | ${reason}`);
    res.json({ success: true, ip });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/ip-unban', verifySuperAdmin, async (req, res) => {
  try {
    const ip = String(req.body.ip || '').trim().slice(0, 60);
    if (!ip) return res.status(400).json({ error: 'IP daalo' });
    const r = await pool.query('DELETE FROM blocked_ips WHERE ip=$1', [ip]);
    clearIpBanCache();
    console.log(`SECURITY: IP ban removed by superadmin | ${ip}`);
    res.json({ success: true, removed: r.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Customer ka pakka block: dekho / lagao / hatao ──
//
// Sath me wo customer bhi jo shak ke daayre me hain — sabse zyada job
// bhejne wale aur jinke job sabse zyada DENY huye. Deny ki ginti isliye
// zaroori hai: shop owner baar-baar kisi ka job reject kar raha hai to
// wahi sabse saaf ishara hai ki banda pareshan kar raha hai.
app.get('/api/superadmin/customer-bans', verifySuperAdmin, async (req, res) => {
  try {
    const bans = await pool.query(
      `SELECT c.cid, c.shop_id, c.reason, c.created_at,
              s.name AS shop_name
         FROM blocked_customers c
         LEFT JOIN shops s ON s.id = c.shop_id
        ORDER BY c.created_at DESC`);

    // Shak ke daayre wale. 30 din ki khidki — usse purana matlab nahi.
    const worst = await pool.query(
      `SELECT j.customer_id                                        AS cid,
              COUNT(*)::int                                        AS kul,
              COUNT(*) FILTER (WHERE j.status = 'failed')::int     AS denied,
              COUNT(DISTINCT j.shop_id)::int                       AS shops,
              MAX(j.shop_id)                                       AS last_shop,
              MAX(j.created_at)                                    AS last_at
         FROM print_jobs j
        WHERE COALESCE(j.customer_id,'') <> ''
          AND j.created_at > NOW() - INTERVAL '30 days'
        GROUP BY j.customer_id
       HAVING COUNT(*) >= 5
           OR COUNT(*) FILTER (WHERE j.status = 'failed') >= 2
        ORDER BY denied DESC, kul DESC
        LIMIT 25`);

    res.json({ bans: bans.rows, worst: worst.rows,
               jobsMax: SEC.custJobsMax, windowMin: SEC.custWindowMin,
               sheetMax: MAX_JOB_SHEETS });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/customer-ban', verifySuperAdmin, async (req, res) => {
  try {
    const cid = String(req.body.cid || '').trim().slice(0, 48);
    if (!cid) return res.status(400).json({ error: 'Customer ID daalo' });
    const shopId = String(req.body.shopId || '').trim().slice(0, 50);
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    await pool.query(
      `INSERT INTO blocked_customers (cid, shop_id, reason) VALUES ($1,$2,$3)
       ON CONFLICT (cid) DO UPDATE SET reason = EXCLUDED.reason,
                                       shop_id = EXCLUDED.shop_id`,
      [cid, shopId, reason]);
    clearCustBanCache();

    // Block sirf AAGE ke upload rokta hai. Jo job pehle se line me lagi
    // hain wo printer se nikalti rehti — aur superadmin ko lagta hai
    // block kaam hi nahi kar raha. Isliye unhe bhi yahin hata do.
    //
    // Paise wali job ko HAATH NAHI LAGATE: uska paisa aa chuka hai, wo
    // shop owner ka faisla hai (wo apne panel se deny kar sakta hai).
    let cancelled = { rows: [] };
    try {
      cancelled = await pool.query(
        `UPDATE print_jobs
            SET status='cancelled', failure_reason='Customer blocked by admin'
          WHERE customer_id = $1
            AND status IN ('queued','pending')
            AND COALESCE(payment_status,'pending') <> 'paid'
          RETURNING id, file_public_id`, [cid]);
    } catch (e) {
      // Job cancel na ho paye to bhi ban to lag hi chuka hai
      console.warn('blocked customer ke job cancel nahi hue:', e.message);
    }
    for (const j of cancelled.rows) {
      if (j.file_public_id) {
        try { await deleteFromCloudinary(j.file_public_id); } catch (_) {}
      }
    }

    console.log(`SECURITY: customer permanently banned by superadmin | ${cid} | ${reason} `
              + `| queued job cancelled=${cancelled.rows.length}`);
    res.json({ success: true, cid, cancelledJobs: cancelled.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/customer-unban', verifySuperAdmin, async (req, res) => {
  try {
    const cid = String(req.body.cid || '').trim().slice(0, 48);
    if (!cid) return res.status(400).json({ error: 'Customer ID daalo' });
    const r = await pool.query('DELETE FROM blocked_customers WHERE cid=$1', [cid]);
    // 15-minute wala apne aap laga block bhi saath me hata do — warna
    // superadmin "chhod diya" samajhta hai aur banda phir bhi ruka rehta.
    let temp = 0;
    for (const k of [...abuseBlocks.keys()]) {
      if (k.startsWith('cust:') && k.includes(cid)) { abuseBlocks.delete(k); temp++; }
    }
    for (const m of [custHits, custIpHits]) {
      for (const k of [...m.keys()]) if (k.includes(cid)) m.delete(k);
    }
    clearCustBanCache();
    console.log(`SECURITY: customer ban removed by superadmin | ${cid} | temp=${temp}`);
    res.json({ success: true, removed: r.rowCount, tempCleared: temp });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Galti se block ho gaya genuine customer — superadmin turant chhoda de
app.post('/api/superadmin/security-unblock', verifySuperAdmin, async (req, res) => {
  try {
    // Shop ID seedha bhi aa sakti hai — "shop:" apne aap lag jayega,
    // taaki superadmin ko key ka roop yaad na rakhna pade.
    let key = String(req.body.key || req.body.shopId || '').trim();
    if (key && !key.includes(':')) key = 'shop:' + key;

    if (!key) {                       // sab clear
      const n = abuseBlocks.size;
      abuseBlocks.clear();
      // Ginti bhi saaf — warna block hatne ke turant baad agla upload
      // dobara block kar deta (neeche wali tippani dekho).
      uploadHits.clear();
      demoIpHits.clear();
      console.log(`SECURITY: all ${n} blocks + counters cleared by superadmin`);
      return res.json({ success: true, cleared: n });
    }
    const had = abuseBlocks.delete(key);

    // ── ASLI FIX ──
    // Block DO jagah baitha hota hai: abuseBlocks me "abhi block hai",
    // aur uploadHits me ginti (total, strikes). Pehle sirf pehla hatta
    // tha — agle upload par ginti abhi bhi limit ke upar hoti aur shop
    // TURANT dobara block ho jaati. Superadmin ko lagta ki button kaam
    // hi nahi kar raha.
    //
    // (Yahi bimari pehle bhi hui thi — "3 print, 16 block" — tab rolling
    //  window se theek ki gayi thi, par haath se unblock wala rasta
    //  chhoot gaya tha.)
    let counters = 0;
    if (key.startsWith('shop:')) {
      if (uploadHits.delete(key.slice(5))) counters++;
    } else if (key.startsWith('ip:')) {
      if (demoIpHits.delete(key.slice(3))) counters++;
    }
    console.log(`SECURITY: block cleared by superadmin | ${key} | found=${had} | counters=${counters}`);
    res.json({ success: true, cleared: had ? 1 : 0, countersCleared: counters, key });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Homepage ko Turnstile site key chahiye (public key — secret nahi)
app.get('/api/security/challenge', (req, res) => {
  res.json({ enabled: !!SEC.turnstileSecret, siteKey: SEC.turnstileSiteKey || '' });
});

// ─── SUPERADMIN: pending demo requests ───
app.get('/api/superadmin/demo-requests', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, phone, email, shop_name, address, printer_model, ip,
              shop_id, status, created_at, reviewed_at
         FROM demo_registrations
        WHERE status = 'pending'
        ORDER BY created_at DESC LIMIT 200`);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── SUPERADMIN: Accept ───
app.post('/api/superadmin/demo-requests/:id/approve', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM demo_registrations WHERE id=$1 AND status='pending'", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Pending request not found' });
    const d = r.rows[0];

    const created = await createDemoShop({
      name: d.name, phone: d.phone, shopName: d.shop_name,
      address: d.address, email: d.email, printerModel: d.printer_model,
      how: 'approved'
    });

    await pool.query(
      "UPDATE demo_registrations SET shop_id=$1, status='approved', reviewed_at=NOW() WHERE id=$2",
      [created.shopId, d.id]);

    // WhatsApp message — superadmin ek click me bhej de
    const hours = Math.round(created.minutes / 60);
    const waText =
      `Hello ${d.name}, your Echel demo account is activated for ${hours} Hours ` +
      `with a Limit of ${created.printLimit} Free prints.\n\n` +
      `Shop ID: ${created.shopId}\n` +
      `Password: ${d.phone} (your mobile number)\n\n` +
      `Login: ${BASE_URL}/admin\n` +
      `Download the Print Agent from your dashboard, install it on your PC and enter this Shop ID.`;

    console.log(`Demo APPROVED: ${created.shopId} | request #${d.id} | ${d.phone}`);
    res.json({
      success: true, shopId: created.shopId, password: d.phone,
      name: d.name, phone: d.phone, shopName: d.shop_name,
      hours, printLimit: created.printLimit,
      qrUrl: created.qrUrl,
      whatsappUrl: `https://wa.me/91${d.phone}?text=` + encodeURIComponent(waText),
      whatsappText: waText
    });
  } catch(err) {
    console.error('Demo approve error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── SUPERADMIN: Delete (reject) ───
// Row poori tarah delete hoti hai taaki phone number dobara free ho jaye.
app.delete('/api/superadmin/demo-requests/:id', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      "DELETE FROM demo_registrations WHERE id=$1 AND status='pending' RETURNING phone, name", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Pending request not found' });
    console.log(`Demo request DELETED: #${req.params.id} | ${r.rows[0].phone}`);
    res.json({ success: true, deleted: r.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/demo/create', async (req, res) => {
  try {
    const cfg = await getDemoConfig();
    if (!cfg.enabled) return res.status(403).json({ error: 'Demo abhi band hai — thodi der baad try karo ya seedha register karo' });
    // Ab demo superadmin approval se banta hai. Ye purana instant-create
    // endpoint sirf tab chalega jab demo_auto_approve='1' ho (rollback ke
    // liye). Warna sab /api/demo/request par jaayenge.
    if (!cfg.autoApprove) {
      return res.status(410).json({
        error: 'Demo now requires approval. Please submit the demo request form.',
        useEndpoint: '/api/demo/request'
      });
    }

    const name = String(req.body.name || '').trim().slice(0, 100);
    const phone = normPhone(req.body.phone);
    if (!name) return res.status(400).json({ error: 'Naam daalo' });
    if (!phone) return res.status(400).json({ error: 'Sahi 10-digit mobile number daalo' });

    // Layer 1: phone permanent lock — demo_registrations AUR shops dono check
    // karo. (Migration me demo_registrations khali reh gaya tha to ye double
    // safety hai — duplicate demo shops nahi banenge.)
    const dup = await pool.query('SELECT id FROM demo_registrations WHERE phone=$1', [phone]);
    const dupShop = await pool.query('SELECT id FROM shops WHERE phone=$1 AND demo=true', [phone]);
    if (dup.rows.length || dupShop.rows.length)
      return res.status(400).json({ error: 'Is number par demo pehle liya ja chuka hai. Pasand aaya tha? Ab register karo 🙂' });

    // Layer 2: IP — max 2 demo/din
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 60);
    const ipCount = await pool.query(
      "SELECT COUNT(*) FROM demo_registrations WHERE ip=$1 AND created_at > NOW() - INTERVAL '24 hours'", [ip]);
    if (parseInt(ipCount.rows[0].count) >= 2)
      return res.status(429).json({ error: 'Aaj ke liye demo limit ho gayi — kal try karo ya abhi register karo' });

    const shopId = 'DEMO_' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const passwordHash = await hashPassword(phone);
    await pool.query(
      // advanced_unlocked=true — demo me saare advanced features khule
      // rehte hain. Demo ka matlab hi hai ki banda poora software dekh
      // sake; aadha dikha kar paise maangna ulta pad jaata hai.
      // Paid shops par ye paywall waise ka waisa hai.
      `INSERT INTO shops (id, name, phone, price_bw, price_color, payment_mode, password_hash,
                          setup_paid, setup_amount, demo, demo_expires_at, advanced_unlocked)
       VALUES ($1,$2,$3,5,10,'counter_only',$4,true,0,true,NOW() + ($5 || ' minutes')::INTERVAL,true)`,
      [shopId, name + ' (Demo)', phone, passwordHash, String(cfg.minutes)]);
    // Unique index (uniq_demo_reg_phone) DB pe race ko bhi rok deta hai —
    // agar do request ek saath aaye to doosri yahan safely fail hogi.
    try {
      await pool.query('INSERT INTO demo_registrations (phone, ip, shop_id) VALUES ($1,$2,$3)', [phone, ip, shopId]);
    } catch (e) {
      if (e.code === '23505') { // unique_violation — phone pehle se locked
        await pool.query('DELETE FROM shops WHERE id=$1', [shopId]); // abhi bana shop rollback
        return res.status(400).json({ error: 'Is number par demo pehle liya ja chuka hai. Ab register karo 🙂' });
      }
      throw e;
    }

    const qrUrl = `${BASE_URL}/print/${shopId}`;
    const qrCode = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 });
    await pool.query('UPDATE shops SET qr_code=$1 WHERE id=$2', [qrCode, shopId]);

    // Ye purana endpoint createDemoShop() use nahi karta - iska apna
    // INSERT hai, isliye alert yahan alag se bulana padta hai.
    alertNewDemo(shopId, 'legacy');

    console.log(`Demo created: ${shopId} | ${phone} | ip ${ip}`);
    res.json({ success: true, shopId, password: phone, qrUrl, qrCode,
               expiresInMinutes: cfg.minutes,
               note: 'Login password = aapka mobile number' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/printer-models', (req, res) => {
  res.json({ models: PRINTER_MODELS });
});

// ══════════════════════════════════════════════════════════════
//  ADVANCE FEATURE LIST  (shop ke Advance tab par jo list dikhti hai)
//
//  Pehle ye list admin.html me hardcoded thi — naya advance feature
//  aane par HTML edit karke dobara deploy karna padta tha, aur Mini
//  Print add karna isi wajah se chhoot gaya tha. Ab list DB me hai
//  aur Superadmin se badalti hai.
//
//  Shape: [{ icon, title, desc, isNew }]
//  desc me halka HTML (<b>) allowed hai — likhne wala superadmin hi hai.
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
//  FEATURE ENTITLEMENT — kis shop ke paas kaun sa advance feature hai
//
//  `advanced_unlocked` boolean ab bhi hai (purana code use karta hai),
//  par asli sach `owned_features` me hai — feature id ki list.
//
//  Premium ki list DEKHI HI NAHI JAATI: unhe catalog me jo bhi hai, aaj
//  ka bhi aur kal ka bhi, sab milta hai. Isi se "aane wale saare feature
//  free" ka waada apne aap poora hota hai — naya feature add karte hi
//  sabhi Premium shops ko mil jaata hai, koi script chalane ki zaroorat
//  nahi.
// ══════════════════════════════════════════════════════════════

/** Har feature ka `id` stable hona chahiye — usi se ownership judi hai. */
function normalizeFeature(f, i) {
  const id = String(f.id || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '')
             || ('feat' + i);
  return {
    id,
    icon:  String(f.icon  || '✨').slice(0, 8),
    title: String(f.title || '').slice(0, 90).trim(),
    desc:  String(f.desc  || '').slice(0, 600).trim(),
    // core = base Advance pack ka hissa (₹199 wala / Pro-Premium me included).
    // core=false = baad me aaya naya feature, uska apna price lagta hai.
    core:  f.core !== false,
    price: Math.max(0, parseInt(f.price) || 0),
    isNew: !!f.isNew
  };
}

/** Base pack ke feature — ₹199 me / Pro-Premium ke saath ye sab milte hain. */
function coreFeatureIds(catalog) {
  return catalog.filter(f => f.core).map(f => f.id);
}

/** Naye (add-on) feature ka price. 0 ya set na ho to global default. */
async function addonFeaturePrice(feature) {
  if (feature && feature.price > 0) return feature.price;
  return await getAddonFeeDefault();
}

async function getAddonFeeDefault() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='addon_feature_fee'");
    return Math.max(1, parseInt(r.rows[0]?.value) || 49);
  } catch (e) { return 49; }
}

/**
 * Shop ke paas asal me kaun se feature hain.
 * Premium ke liye poora catalog — chahe owned_features khaali hi ho.
 */
function ownedFeatureIds(shop, catalog) {
  if (!shop) return [];
  if (shop.plan_type === 'premium') return catalog.map(f => f.id);
  // Demo ko poora catalog — Smart Scanner jaise ADD-ON bhi.
  //
  // Baaki 5 module advanced_unlocked se chalte the isliye demo me dikhte
  // the, par add-on ka sach owned_features me hai aur demo ka wo khaali
  // hota hai — isliye scanner demo me kabhi nahi dikha. Demo banane wale
  // code ki niyat pehle se yahi thi ("demo ka matlab hi hai ki banda
  // poora software dekh sake"); Scanner baad me add-on bana aur ye jagah
  // chhoot gayi.
  //
  // Yahan theek karne se aage koi bhi naya add-on demo me apne aap
  // dikhega — har baar yaad rakhne ki zaroorat nahi.
  if (shop.demo) return catalog.map(f => f.id);
  const own = Array.isArray(shop.owned_features) ? shop.owned_features : [];
  // Purani shops jinhone ₹199 diya tha unke paas owned_features khaali hai
  // par advanced_unlocked=true hai — unhe core pack maana jaata hai.
  if (!own.length && shop.advanced_unlocked) return coreFeatureIds(catalog);
  return own;
}

function shopOwnsFeature(shop, featureId, catalog) {
  return ownedFeatureIds(shop, catalog).indexOf(featureId) !== -1;
}

/**
 * Shop ko feature de do. Premium par kuch karne ki zaroorat nahi —
 * unka hisaab plan se hi nikalta hai.
 */
// ═══════════════════════════════════════════════════════════════
//  PAGE-RANGE SLAB PRICING
// ═══════════════════════════════════════════════════════════════
// Shop owner "itne se itne page tak = itna rupaya" set kar sakta hai.
// Wo daam HAR PAGE ka rate hai, poore job ka NAHI:
//     4 kagaz aur range 2-5 ka rate 2    =>  4 x 2   = 8
//     8 kagaz aur range 6-10 ka rate 1.5 =>  8 x 1.5 = 12
// Yaani jitne zyada kagaz, utna sasta per-page rate.
//
// Ginti me COPIES bhi judti hain: 3 page ki 3 copy = 9 kagaz.
//
// Job kisi range me na aaye (jaise sirf 1 page) to purana per-page hisaab
// hi chalta hai, isliye jin shops ne slab set nahi kiya unpar koi asar
// nahi padta.
//
// Shape: { bw: [{from,to,price}, ...], color: [...] }  (5-5 tak)
function parseSlabs(raw) {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
    const clean = (arr) => (Array.isArray(arr) ? arr : [])
      .map(s => ({
        from:  parseInt(s.from, 10),
        to:    parseInt(s.to, 10),
        price: parseFloat(s.price)
      }))
      // Adhoori ya ulti range chup-chaap girao — aadha bhara row
      // galat daam laga deta, isse behtar hai purana rate chale
      .filter(s => s.from > 0 && s.to >= s.from && s.price >= 0 && isFinite(s.price))
      .slice(0, 5);
    return { bw: clean(o.bw), color: clean(o.color) };
  } catch (e) { return { bw: [], color: [] }; }
}

// Kitne page par kaunsa rate. Do range overlap kar jayein to SABSE
// CHHOTI (sabse khaas) range jeetegi - owner ne jo range jaan-boojh kar
// tang rakhi hai wo badi wali se upar rehni chahiye.
function slabPriceFor(raw, colorMode, pages) {
  const slabs = parseSlabs(raw);
  const list = (colorMode === 'color' ? slabs.color : slabs.bw) || [];
  let best = null;
  for (const s of list) {
    if (pages >= s.from && pages <= s.to) {
      if (!best || (s.to - s.from) < (best.to - best.from)) best = s;
    }
  }
  return best ? best.price : null;
}

async function grantFeatures(shopId, ids) {
  if (!ids || !ids.length) return;
  await pool.query(
    `UPDATE shops
        SET owned_features = ARRAY(SELECT DISTINCT unnest(COALESCE(owned_features,'{}'::text[]) || $2::text[])),
            advanced_unlocked = true
      WHERE id = $1`,
    [shopId, ids]);
}

async function revokeFeatures(shopId, ids) {
  if (!ids || !ids.length) return;
  await pool.query(
    `UPDATE shops
        SET owned_features = ARRAY(SELECT x FROM unnest(COALESCE(owned_features,'{}'::text[])) x
                                    WHERE NOT (x = ANY($2::text[])))
      WHERE id = $1`,
    [shopId, ids]);
  // Ek bhi feature na bache to legacy flag bhi off — warna purana code
  // samajhta rahega ki advance khula hua hai.
  await pool.query(
    `UPDATE shops SET advanced_unlocked = false
      WHERE id = $1 AND COALESCE(array_length(owned_features,1),0) = 0
        AND plan_type <> 'premium'`, [shopId]);
}

const DEFAULT_ADVANCE_FEATURES = [
  { id: 'photo4x6', core: true, icon: '📷', title: '4×6 Passport Photos',
    desc: 'Customer photo bhejta hai — 4, 6, 8 ya 10 ki sheet khud ban kar photo printer se nikalti hai, cutting lines ke saath. Layout aur printer routing sab automatic.' },
  { id: 'resume', core: true, icon: '📝', title: 'Resume Maker',
    desc: 'Customer QR se hi 6 design me resume banata hai aur form khud bharta hai. Aap sirf print dete ho — naya kaam, bina kuch seekhe.' },
  { id: 'bigsize', core: true, icon: '📐', title: 'A3 / A2 / A1 — Bade Size',
    desc: 'Naksha, project chart, banner. Har bade size ka apna printer aur apna rate set kar sakte ho — A3 printer hai to ye kaam aapke paas hi rahega.' },
  { id: 'mini', core: true, icon: '🗒️', title: 'Mini Print — ek sheet par 16 pages tak',
    desc: 'Notes, question paper, syllabus — customer 2/4/6/8/9/12/16 pages ek hi A4 par chhapwa sakta hai. Student season me sabse zyada chalne wala option.' },
  // Smart Scanner base pack ka hissa NAHI hai (core: false) — ye baad me
  // aaya add-on hai. Iska matlab:
  //   • Premium (₹999)  → ownedFeatureIds() poora catalog deta hai, free
  //   • Pro/Starter/purane → ₹49 (system_settings.addon_feature_fee)
  //   • Superadmin jab chahe kisi ko bhi free de sakta hai
  // price: 0 rakha hai taaki global addon_feature_fee lagu ho — rate ek
  // jagah (₹49) se badle, har feature me alag se nahi.
  { id: 'scan', core: false, price: 0, icon: '📸', title: 'Smart Scanner — Photo se Scan',
    desc: 'Customer document ka photo kheenchta hai aur CamScanner jaisa saaf seedha page ban jaata hai — background apne aap hat jaata hai. Front aur back dono side scan ho sakti hain. Bina scanner machine ke scanning ka kaam.' },
  { id: 'duplex', core: true, icon: '📄', title: 'Duplex — Dono Side Print',
    desc: 'Double-side print ka alag rate rakho. Auto-duplex printer nahi hai to manual mode — system khud bolta hai "page palto".' }
];

async function getAdvanceFeatures() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='advance_features'");
    if (!r.rows.length) return DEFAULT_ADVANCE_FEATURES.map((f, i) => normalizeFeature(f, i));
    const parsed = JSON.parse(r.rows[0].value);
    // Khaali array save ho gaya ho to default hi behtar hai — warna
    // shop ko bilkul khaali box dikhega.
    if (!Array.isArray(parsed) || !parsed.length)
      return DEFAULT_ADVANCE_FEATURES.map((f, i) => normalizeFeature(f, i));

    // ⚠️ Purane save me `id`, `core` aur `price` the hi nahi — PUT handler
    // unhe pheink deta tha (ab wo bhi theek kar diya hai, neeche dekho).
    // Sirf `id` bharna kaafi nahi tha: `core` undefined rehne par
    // normalizeFeature ka `f.core !== false` use TRUE bana deta tha,
    // yaani har feature base pack ka hissa ban jaata aur koi bhi feature
    // add-on (₹49 wala) ban hi nahi sakta tha.
    //
    // Purani entry ko default catalog se milate hain — pehle id se,
    // phir TITLE se (bharosemand), aur aakhir me index se. Index akela
    // khatarnak hai: list ka kram badla ya beech me naya feature juda to
    // ownership galat feature par chali jaati.
    const byId    = {};
    const byTitle = {};
    DEFAULT_ADVANCE_FEATURES.forEach(d => {
      byId[d.id] = d;
      byTitle[String(d.title || '').trim().toLowerCase()] = d;
    });

    return parsed.map((f, i) => {
      const d = (f.id && byId[f.id])
             || byTitle[String(f.title || '').trim().toLowerCase()]
             || DEFAULT_ADVANCE_FEATURES[i] || {};
      return normalizeFeature({
        icon:  f.icon,  title: f.title,  desc: f.desc,  isNew: f.isNew,
        id:    f.id    !== undefined && f.id !== '' ? f.id    : d.id,
        core:  f.core  !== undefined ? f.core  : d.core,
        price: f.price !== undefined ? f.price : d.price
      }, i);
    });
  } catch (e) {
    return DEFAULT_ADVANCE_FEATURES.map((f, i) => normalizeFeature(f, i));
  }
}

// Shop ka Advance tab yahi padhta hai — public, koi auth nahi
// ══════════════════════════════════════════════════════════════
//  ADD-ON FEATURE UNLOCK (₹49) — ek feature, ek payment
//
//  Starter/Pro walon ke liye. Premium yahan aata hi nahi — unhe har
//  naya feature apne aap milta hai, isliye order banane se pehle hi
//  rok dete hain.
// ══════════════════════════════════════════════════════════════
app.post('/api/admin/feature/create-order', verifyToken, async (req, res) => {
  try {
    if (!OWNER_RAZORPAY_KEY_ID || !OWNER_RAZORPAY_KEY_SECRET)
      return res.status(500).json({ error: 'Owner Razorpay configured nahi' });

    const featureId = String(req.body.featureId || '').trim();
    const catalog = await getAdvanceFeatures();
    const feature = catalog.find(f => f.id === featureId);
    if (!feature) return res.status(404).json({ error: 'Ye feature exist nahi karta' });

    const sh = await pool.query(
      'SELECT plan_type, advanced_unlocked, owned_features FROM shops WHERE id=$1', [req.shopId]);
    if (!sh.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    const shop = sh.rows[0];

    if (shop.plan_type === 'premium')
      return res.status(400).json({ error: 'Premium me ye pehle se shaamil hai' });
    if (shopOwnsFeature(shop, featureId, catalog))
      return res.status(400).json({ error: 'Ye feature aapke paas pehle se hai' });
    // core pack alag se bikta hai (₹199 wala), ek-ek karke nahi
    if (feature.core)
      return res.status(400).json({ error: 'Ye Advance pack ka hissa hai — poora pack unlock karo' });

    const fee = await addonFeaturePrice(feature);
    const orderData = JSON.stringify({
      amount: fee * 100, currency: 'INR',
      receipt: 'ft_' + req.shopId.slice(-6) + '_' + Date.now().toString().slice(-6),
      notes: { shopId: req.shopId, kind: 'feature_unlock', featureId }
    });
    const auth = Buffer.from(`${OWNER_RAZORPAY_KEY_ID}:${OWNER_RAZORPAY_KEY_SECRET}`).toString('base64');
    const order = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'api.razorpay.com', path: '/v1/orders', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth,
                   'Content-Length': Buffer.byteLength(orderData) }
      }, resp => { let d=''; resp.on('data',c=>d+=c);
                   resp.on('end',()=>{ try{ resolve(JSON.parse(d)); }catch(e){ reject(e); } }); });
      r.on('error', reject); r.write(orderData); r.end();
    });
    if (!order || !order.id) return res.status(500).json({ error: 'Order nahi bana' });

    // order id shop par rakho — verify me isi se milaan hoga
    await pool.query('UPDATE shops SET feature_order_id=$1, feature_order_fid=$2 WHERE id=$3',
      [order.id, featureId, req.shopId]);
    res.json({ orderId: order.id, amount: fee * 100, keyId: OWNER_RAZORPAY_KEY_ID,
               fee, featureTitle: feature.title });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add-on ko order-id se unlock karo. Ise DO raste bulate hain:
//   1. /api/admin/feature/verify — customer ke browser se, payment ke turant baad
//   2. Razorpay webhook — agar browser band ho gaya, net kat gaya, ya token
//      expire ho gaya
// RACE-SAFE: `AND feature_order_id = $2` ki wajah se sirf PEHLA jeetega.
// Doosra aayega to row match nahi karegi aur chup-chaap no-op ho jayega.
async function unlockFeatureByOrder(shopId, orderId, paymentId) {
  const claim = await pool.query(
    `UPDATE shops SET feature_order_id = ''
      WHERE id = $1 AND feature_order_id = $2
      RETURNING feature_order_fid`, [shopId, orderId]);
  if (!claim.rows.length) return null;          // pehle hi ho chuka

  const featureId = claim.rows[0].feature_order_fid;
  if (!featureId) return null;

  await grantFeatures(shopId, [featureId]);
  await pool.query("UPDATE shops SET feature_order_fid='' WHERE id=$1", [shopId]);

  const catalog = await getAdvanceFeatures();
  const feature = catalog.find(f => f.id === featureId);
  const fee = await addonFeaturePrice(feature);
  try {
    await pool.query(
      `INSERT INTO platform_payments (shop_id, shop_name, amount, payment_id, order_id, gateway, kind)
       SELECT id, name, $2, $3, $4, 'razorpay', 'feature_unlock' FROM shops WHERE id=$1`,
      [shopId, fee, paymentId || '', orderId]);
  } catch (e) { /* record na bane to bhi unlock rukna nahi chahiye */ }

  log(`Feature unlocked: ${featureId} | shop ${shopId} | ₹${fee}`);
  return featureId;
}

app.post('/api/admin/feature/verify', verifyToken, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ error: 'Payment details adhoore hain' });

    const expected = crypto.createHmac('sha256', OWNER_RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
    if (expected !== razorpay_signature)
      return res.status(400).json({ error: 'Payment verify nahi hua' });

    // Sirf wahi feature do jo order banate waqt maanga tha — client ke
    // bheje hue featureId par bharosa nahi karte.
    const featureId = await unlockFeatureByOrder(
      req.shopId, razorpay_order_id, razorpay_payment_id);

    if (!featureId) {
      // Webhook pehle hi kar chuka ho sakta hai — aisa hai to shop ke paas
      // feature maujood hoga aur ye SUCCESS hai, error nahi.
      const sh = await pool.query(
        'SELECT plan_type, advanced_unlocked, owned_features FROM shops WHERE id=$1',
        [req.shopId]);
      const cat = await getAdvanceFeatures();
      const already = (cat || []).find(f =>
        sh.rows.length && shopOwnsFeature(sh.rows[0], f.id, cat) && !f.core);
      if (already) return res.json({ success: true, featureId: already.id });
      return res.status(400).json({ error: 'Order match nahi hua' });
    }
    res.json({ success: true, featureId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Shop ko apne feature ka status chahiye — kaun sa mila, kaun sa kharidna hai
app.get('/api/admin/features', verifyToken, async (req, res) => {
  try {
    const catalog = await getAdvanceFeatures();
    const sh = await pool.query(
      'SELECT plan_type, advanced_unlocked, owned_features FROM shops WHERE id=$1', [req.shopId]);
    if (!sh.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    const shop = sh.rows[0];
    const owned = ownedFeatureIds(shop, catalog);
    const addonFee = await getAddonFeeDefault();

    res.json({
      plan: shop.plan_type || 'starter',
      // Premium walon ko kabhi kuch kharidna nahi padta
      allIncluded: shop.plan_type === 'premium',
      addonFee,
      features: await Promise.all(catalog.map(async f => ({
        id: f.id, icon: f.icon, title: f.title, desc: f.desc,
        core: f.core, isNew: f.isNew,
        owned: owned.indexOf(f.id) !== -1,
        price: f.core ? 0 : await addonFeaturePrice(f)
      })))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/advance-features', async (req, res) => {
  res.json({ features: await getAdvanceFeatures() });
});

app.get('/api/superadmin/advance-features', verifySuperAdmin, async (req, res) => {
  res.json({ features: await getAdvanceFeatures(),
             defaults: DEFAULT_ADVANCE_FEATURES });
});

app.put('/api/superadmin/advance-features', verifySuperAdmin, async (req, res) => {
  try {
    const list = Array.isArray(req.body.features) ? req.body.features : null;
    if (!list) return res.status(400).json({ error: 'features ek list honi chahiye' });
    if (list.length > 30) return res.status(400).json({ error: 'Zyada se zyada 30 feature' });

    // ⚠️ Ye map pehle sirf icon/title/desc/isNew save karta tha — `id`,
    // `core` aur `price` chup-chaap gir jaate the. Nateeja: superadmin
    // Save dabaate hi saari ID mit jaati (ownership index par tik jaati)
    // aur har feature core:true ban jaata — yaani ₹49 wala add-on system
    // kabhi chala hi nahi. Panel me checkbox aur price ka box dikhta tha,
    // par Save unhe pheink deta tha.
    // normalizeFeature() wahi shape banata hai jo padhte waqt chahiye.
    const clean = list.map((f, i) => normalizeFeature(f, i)).filter(f => f.title);

    if (!clean.length) return res.status(400).json({ error: 'Kam se kam ek feature ka title chahiye' });

    // ID par ownership tiki hai (owned_features me yahi id jaati hai).
    // Do feature ki id ek ho gayi to ek ka paisa doosre ko khol dega,
    // isliye server par bhi rok — client ka check kaafi nahi.
    const _ids = clean.map(f => f.id);
    const _dup = _ids.find((x, i) => _ids.indexOf(x) !== i);
    if (_dup) return res.status(400).json({ error: 'Do feature ki ID ek jaisi hai: ' + _dup });

    await pool.query(
      `INSERT INTO system_settings (key,value) VALUES ('advance_features',$1)
       ON CONFLICT (key) DO UPDATE SET value=$1`, [JSON.stringify(clean)]);
    res.json({ success: true, features: clean });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/demo/config', async (req, res) => {
  const c = await getDemoConfig();
  res.json({ enabled: c.enabled, minutes: c.minutes,
             printLimit: c.printLimit, instant: c.instant });
});

// Setup-payment page: is shop ka plan + amount (sirf unpaid — paid par info leak nahi)
app.get('/api/setup-status/:shopId', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, setup_paid, setup_amount, plan_type, billing_cycle FROM shops WHERE id=$1', [req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    if (r.rows[0].setup_paid) return res.json({ paid: true });
    res.json({ paid: false, plan: r.rows[0].plan_type || 'onetime', billingCycle: billingCycle(r.rows[0]), amount: r.rows[0].setup_amount || 0 });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/setup-readme/:shopId', async (req, res) => {
  const shopId = (req.params.shopId || '').toUpperCase();
  const txt = `\uFEFFEchel — Setup Guide

Shop ID: ${shopId}

GET THE SOFTWARE
Open ${BASE_URL}/admin and sign in with your Shop ID and password.
Open QR & Downloads and download the latest Windows software.

CONNECT YOUR COMPUTER
Open the downloaded installer and follow its prompts.
Enter your Shop ID: ${shopId}
The print agent appears in the Windows system tray beside the clock.
Keep the agent running while the shop accepts print orders.

SELECT YOUR PRINTERS
Open the agent panel or the shop dashboard's Settings tab.
Select the installed black-and-white and colour printers, then save.
Configure duplex and dedicated photo or large-format printers if supported.
If a printer is missing, confirm that it is installed and working in Windows.

CHOOSE PAYMENT OPTIONS
Choose payment at the counter, online payment, or both.
For online payments, complete your payment provider's business verification
and enter the live credentials in Payment Setup. Follow the provider's
current instructions and use your own business details.

TRY YOUR FIRST PRINT
Download and display your shop QR code.
Scan it from a phone, upload a test document and select print options.
Complete the selected payment method and confirm that the correct printer,
paper size, colour and number of copies are used.

HELP
Setup guide: ${BASE_URL}/setup-guide
Support: ${BASE_URL}/contact
`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Echel-Setup-Guide.txt"`);
  res.send(txt);
});

// ══════════════════════════════════════════════════════════════
// AGENT PROGRAM — helpers
// Agent = paid shop owner jo doosri shops onboard karke commission kamata hai.
// Kamai = ₹200 fix per shop + markup (agent ka price − superadmin ka base price)
// + har 10 shop par ₹300 bonus. Payout manual (UPI), withdrawals table se.
// ══════════════════════════════════════════════════════════════
// ── AGENT PROGRAM (naya, simple) ──
// FLAT ₹100 per paid shop. Bas itna hi.
// Purana system: ₹200 + agent ka apna markup + har 10 shop par ₹300 bonus.
// Wo hata diya gaya — agent ab apna price set NAHI kar sakta, sabko ek
// hi rate milta hai. BONUS constants 0 hain taaki koi purana reference
// bacha ho to bhi paisa na jude.
const AGENT_COMMISSION   = 100;   // per successful paid shop (flat)
const AGENT_PRICE_MAX    = 0;     // 0 = agent apna price set nahi kar sakta
const AGENT_BONUS_EVERY  = 0;     // bonus band
const AGENT_BONUS_AMOUNT = 0;     // bonus band

// ══════════════════════════════════════════════════════════════
// WHITE LABEL — helpers
// Reseller apne brand + apne Razorpay se shops bechta hai. Uski shops ka
// setup fee SEEDHA uske Razorpay me jaata hai; hamare paas sirf ek baar
// ka license fee aata hai.
// ══════════════════════════════════════════════════════════════
async function getWlLicenseFee() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='wl_license_fee'");
    return Math.max(1, parseInt(r.rows[0]?.value) || 25000);
  } catch(e) { return 25000; }
}

// Reseller isse neeche shop price nahi rakh sakta. 0/unset = public Offer Price.
async function getWlLicenseActual() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='wl_license_actual'");
    return Math.max(0, parseInt(r.rows[0]?.value) || 0);
  } catch(e) { return 0; }
}

/**
 * Agent ke liye Premium ka floor. Pro ka floor getAgentBasePrice() hai.
 * Set na ho to Premium ka apna public price — taaki agent Premium ko
 * Pro ke rate par na bech de.
 */
async function getAgentPremiumBasePrice() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='agent_base_price_premium'");
    const v = parseInt(r.rows[0]?.value) || 0;
    if (v > 0) return v;
  } catch (e) {}
  return (await getPlanPricing()).premium.fee;
}

/** Channel ka floor kis plan par lagega — wahi plan ka public price. */
async function channelFloorPlan(channel) {
  const plans = await getPlanPricing();
  // agent ka sabse sasta plan Pro hai, wl ka Starter
  return channel === 'wl' ? plans.starter.fee : plans.pro.fee;
}

async function getWlBasePrice() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='wl_base_price'");
    const v = parseInt(r.rows[0]?.value) || 0;
    if (v > 0) return v;
  } catch(e) {}
  // White-label sirf Starter bechta hai — uska floor Starter ka price.
  return (await getPlanPricing()).starter.fee;
}

// slug: sirf chhote akshar, number aur dash
function cleanSlug(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '').slice(0, 40);
}

// Reseller dhoondo — ?wl=slug se, ya subdomain (abc.echel.in) se
async function resolveWhitelabel(req) {
  return null; // This client edition has one business identity.

  try {
    let slug = cleanSlug(req.query.wl || req.body?.wl || '');
    if (!slug) {
      const host = String(req.headers.host || '').toLowerCase().split(':')[0];
      const parts = host.split('.');
      // abc.echel.in -> abc  (www aur main domain chhod do)
      if (parts.length > 2 && parts[0] !== 'www') slug = cleanSlug(parts[0]);
    }
    if (!slug) return null;
    const r = await pool.query(
      'SELECT * FROM whitelabels WHERE slug=$1 AND paid=true AND blocked=false', [slug]);
    return r.rows[0] || null;
  } catch(e) { return null; }
}

/**
 * Partner ka paisa kis gateway se aayega — 'razorpay', 'cashfree', ya
 * '' (matlab kuch set hi nahi hai).
 *
 * Pehle har jagah sirf razorpay_key_id/secret dekha jaata tha. Cashfree
 * ke column aur partner ke panel ka option dono maujood the, par paisa
 * lene wala code unhe padhta hi nahi tha.
 *
 * Chunav ka niyam: partner ne panel me jo chuna hai wo pehle. Us gateway
 * ki key na bhari ho to doosri chal jaati hai — aadhi bhari settings me
 * bikri rukni nahi chahiye.
 */
function wlPayMode(wl) {
  if (!wl) return '';
  const hasRzp = !!(wl.razorpay_key_id && wl.razorpay_key_secret);
  const hasCf  = !!(wl.cashfree_app_id && wl.cashfree_secret_key);
  const want   = String(wl.gateway || 'razorpay').toLowerCase();
  if (want === 'cashfree' && hasCf) return 'cashfree';
  if (want === 'razorpay' && hasRzp) return 'razorpay';
  if (hasRzp) return 'razorpay';
  if (hasCf)  return 'cashfree';
  return '';
}

// Reseller ka JWT verify
function verifyWhitelabel(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Login zaroori hai' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    if (!d.wlId) return res.status(403).json({ error: 'Ye whitelabel token nahi hai' });
    req.wlId = d.wlId;
    next();
  } catch(e) { return res.status(401).json({ error: 'Session expire ho gaya, dobara login karo' }); }
}

async function genAgentCode() {
  for (let i = 0; i < 40; i++) {
    const code = 'QRA-' + Math.floor(1000 + Math.random() * 9000);
    const c = await pool.query('SELECT 1 FROM shops WHERE agent_code=$1', [code]);
    if (!c.rows.length) return code;
  }
  return 'QRA-' + Date.now().toString().slice(-6);
}

// ref = agent code (QRA-1234) ya purana shop id (SHOP_XXXX) — dono chalte hain
async function resolveRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const v = ref.trim().toUpperCase();
  if (!v) return null;
  const r = await pool.query(
    `SELECT id, name, is_agent, agent_blocked, agent_price, setup_paid, demo
     FROM shops WHERE (agent_code=$1 OR UPPER(id)=$1) LIMIT 1`, [v]);
  if (!r.rows.length) return null;
  const s = r.rows[0];
  if (!s.setup_paid || s.demo) return null;          // unpaid/demo refer nahi kar sakta
  if (s.is_agent && s.agent_blocked) return null;    // blocked agent ka link dead
  return s;
}

// Kisi ref ke hisaab se one-time setup price (agent ne badhaya ho to wahi)
async function priceForRef(ref) {
  // NOTE: is function ko abhi koi call nahi karta. Pehle isme bhi
  // `agent_price > base` wala markup tha — wahi bug jo ref link par
  // Rs 1799 kara raha tha. Agar kal koi ise use kare to wo bug dobara
  // na aa jaye, isliye yahan bhi hata diya.
  const base = await getSetupFeeAmount();
  const s = await resolveRef(ref);
  return { price: base, base, agent: s || null };
}

// ══════════════════════════════════════════════════════════════
// ANALYTICS — homepage funnel tracking (first-party, no external service)
// ══════════════════════════════════════════════════════════════
const ANALYTICS_EVENTS = [
  'pageview', 'demo_click', 'register_click', 'inquiry_click',
  'guide_click', 'agent_click',
  'pay_click',    // register form me "Pay & Activate" dabaya
  'demo_login'    // demo shop ne dashboard me login kiya
];

// Referrer se pata karo visitor kahan se aaya. Sirf hostname rakhte hain —
// poora URL nahi, taaki kisi ka private page path store na ho.
function refHostname(raw) {
  try {
    const v = String(raw || '').trim();
    if (!v) return '';
    const u = new URL(v.includes('://') ? v : 'https://' + v);
    return u.hostname.replace(/^www\./, '').slice(0, 160);
  } catch (e) { return ''; }
}

// Public, halka beacon — koi auth nahi (anonymous pageview/click hi hai).
// Kabhi bhi page ko block/error nahi karta, client se fire-and-forget.
app.post('/api/track', async (req, res) => {
  try {
    const b = req.body || {};
    const eventType = String(b.event_type || '').slice(0, 40);
    if (!ANALYTICS_EVENTS.includes(eventType)) return res.status(400).json({ error: 'invalid event' });
    await pool.query(
      `INSERT INTO analytics_events (event_type, path, ref, utm_source, visitor_id, wl, referrer)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        eventType,
        String(b.path || '').slice(0, 200),
        String(b.ref || '').slice(0, 100),
        String(b.utm_source || '').slice(0, 100),
        String(b.visitor_id || '').slice(0, 64),
        cleanSlug(b.wl || ''),
        refHostname(b.referrer)
      ]
    );
    res.json({ success: true });
  } catch (err) { res.status(200).json({ success: false }); } // kabhi bhi client ko error na dikhe
});

// Superadmin: aggregated funnel data — daily breakdown + totals + source split

// ═══════════════════════════════════════════════════════════════════
//  ACTION CENTER — "Aaj kya dekhna hai"
//  19 tab me ghoomne ke bajaye ek jagah: kya atka hai, kya chhoot raha
//  hai, kis shop ko aaj message karna hai. Sab kuch pehle se maujood
//  data se banta hai — koi naya tracking nahi.
// ═══════════════════════════════════════════════════════════════════
app.get('/api/superadmin/action-center', verifySuperAdmin, async (req, res) => {
  try {
    const LIMIT = 25;

    // 1. Register hua par paisa nahi diya — seedha khoya hua paisa.
    //    45 din se purane chhod dete hain, wo dead lead hain.
    const unpaid = await pool.query(`
      SELECT id, name, phone, email, created_at,
             EXTRACT(DAY FROM NOW() - created_at)::int AS days_ago
      FROM shops
      WHERE demo = false AND setup_paid = false
        AND created_at > NOW() - INTERVAL '45 days'
      ORDER BY created_at DESC LIMIT ${LIMIT}`);

    // 2. Demo khatam hone wale — abhi baat karoge to paid ban sakte hain
    const demoExpiring = await pool.query(`
      SELECT id, name, phone, email, demo_expires_at,
             GREATEST(0, CEIL(EXTRACT(EPOCH FROM (demo_expires_at - NOW()))/86400))::int AS days_left
      FROM shops
      WHERE demo = true AND demo_expires_at IS NOT NULL
        AND demo_expires_at > NOW() AND demo_expires_at < NOW() + INTERVAL '3 days'
      ORDER BY demo_expires_at ASC LIMIT ${LIMIT}`);

    // 2b. Demo khatam HO CHUKA — ye sabse garam lead hain, inhone product
    //     use kiya aur ab band ho gaya. 30 din tak follow-up worth hai.
    const demoExpired = await pool.query(`
      SELECT id, name, phone, email, demo_expires_at,
             GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - demo_expires_at))/86400))::int AS days_ago
      FROM shops
      WHERE demo = true AND demo_expires_at IS NOT NULL
        AND demo_expires_at <= NOW()
        AND demo_expires_at > NOW() - INTERVAL '30 days'
      ORDER BY demo_expires_at DESC LIMIT ${LIMIT}`);

    // 3. Print agent offline — pehle chal raha tha, ab 24 ghante se nahi.
    //    Jinhone kabhi install hi nahi kiya wo yahan nahi aate, wo alag
    //    problem hai (onboarding), yahan sirf toota hua setup dikhta hai.
    const agentOffline = await pool.query(`
      SELECT id, name, phone, agent_last_seen, agent_version, agent_version_label,
             agent_machine, (agent_token IS NOT NULL) AS agent_bound,
             FLOOR(EXTRACT(EPOCH FROM (NOW() - agent_last_seen))/3600)::int AS hours_ago
      FROM shops
      WHERE demo = false AND setup_paid = true AND paused = false
        AND agent_last_seen IS NOT NULL
        AND agent_last_seen < NOW() - INTERVAL '24 hours'
      ORDER BY agent_last_seen ASC LIMIT ${LIMIT}`);

    // 4. Chup shops — 7 din se ek bhi print nahi. Ye chhodne wali hain.
    //    Nayi shops (7 din se kam purani) ko chhod dete hain, unka
    //    abhi setup hi chal raha hota hai.
    const silent = await pool.query(`
      SELECT s.id, s.name, s.phone, s.created_at,
             MAX(p.created_at) AS last_print,
             CASE WHEN MAX(p.created_at) IS NULL THEN NULL
                  ELSE EXTRACT(DAY FROM NOW() - MAX(p.created_at))::int END AS days_silent
      FROM shops s
      LEFT JOIN print_jobs p ON p.shop_id = s.id
      WHERE s.demo = false AND s.setup_paid = true AND s.paused = false
        AND s.created_at < NOW() - INTERVAL '7 days'
      GROUP BY s.id, s.name, s.phone, s.created_at
      HAVING MAX(p.created_at) IS NULL OR MAX(p.created_at) < NOW() - INTERVAL '7 days'
      ORDER BY MAX(p.created_at) ASC NULLS FIRST LIMIT ${LIMIT}`);

    // 5. Renewal — 5 din me khatam, ya khatam ho chuka.
    //    Bina reminder ke ye chupchaap chhoot jaate hain.
    const renewals = await pool.query(`
      SELECT id, name, phone, email, paid_until, plan_type, billing_cycle,
             CEIL(EXTRACT(EPOCH FROM (paid_until - NOW()))/86400)::int AS days_left
      FROM shops
      WHERE demo = false AND paid_until IS NOT NULL
        AND paid_until < NOW() + INTERVAL '5 days'
        AND paid_until > NOW() - INTERVAL '30 days'
      ORDER BY paid_until ASC LIMIT ${LIMIT}`);

    // 6. Chhote counters — inke liye poori list ki zaroorat nahi
    const wd = await pool.query(
      `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount),0)::int AS amount
       FROM withdrawals WHERE status='pending'`);
    const rv = await pool.query(
      "SELECT COUNT(*)::int AS cnt FROM reviews WHERE status='pending'");

    res.json({
      unpaid: unpaid.rows,
      demoExpiring: demoExpiring.rows,
      demoExpired: demoExpired.rows,
      agentOffline: agentOffline.rows,
      silent: silent.rows,
      renewals: renewals.rows,
      withdrawals: wd.rows[0] || { cnt: 0, amount: 0 },
      reviewsPending: (rv.rows[0] || {}).cnt || 0
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/analytics', verifySuperAdmin, async (req, res) => {
  try {
    // ── Range: chhote ranges (1h/12h/1d) ghante-war bucket karte hain,
    // baaki (7d/14d/30d/90d) din-war — jaisa pehle se tha.
    const RANGE_MAP = {
      '1h':  { amount: 1,  unit: 'hours', bucket: 'hour' },
      '12h': { amount: 12, unit: 'hours', bucket: 'hour' },
      '1d':  { amount: 24, unit: 'hours', bucket: 'hour' },
      '7d':  { amount: 7,  unit: 'days',  bucket: 'day'  },
      '14d': { amount: 14, unit: 'days',  bucket: 'day'  },
      '30d': { amount: 30, unit: 'days',  bucket: 'day'  },
      '90d': { amount: 90, unit: 'days',  bucket: 'day'  }
    };
    let rangeKey = String(req.query.range || '');
    if (!RANGE_MAP[rangeKey]) {
      // Purana ?days= param bhi chalta rahe (backward compatible)
      const legacyDays = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
      rangeKey = [7,14,30,90].includes(legacyDays) ? legacyDays + 'd' : '30d';
    }
    const cfg = RANGE_MAP[rangeKey];
    const intervalStr = `${cfg.amount} ${cfg.unit}`;
    const isHourly = cfg.bucket === 'hour';
    const days = cfg.unit === 'days' ? cfg.amount : 0; // legacy field, frontend ke liye

    // Ghante-war bucket IST me dikhate hain (readable), din-war bucket
    // waisa hi rehta hai jaisa pehle tha (behaviour change nahi karna).
    const bucketExpr = isHourly
      ? `TO_CHAR(created_at + INTERVAL '5 hours 30 minutes', 'YYYY-MM-DD"T"HH24:00')`
      : `TO_CHAR(created_at, 'YYYY-MM-DD')`;

    const daily = await pool.query(
      `SELECT event_type, ${bucketExpr} AS day,
              COUNT(*)::int AS cnt, COUNT(DISTINCT NULLIF(visitor_id,''))::int AS uniq
       FROM analytics_events
       WHERE created_at > NOW() - $1::interval
       GROUP BY event_type, day ORDER BY day ASC`, [intervalStr]);

    const shopsDaily = await pool.query(
      `SELECT ${bucketExpr} AS day,
              COUNT(*) FILTER (WHERE demo=true)::int AS demo_created,
              COUNT(*) FILTER (WHERE demo=false AND setup_paid=true)::int AS paid_created
       FROM shops
       WHERE created_at > NOW() - $1::interval
       GROUP BY day ORDER BY day ASC`, [intervalStr]);

    const totals = await pool.query(
      `SELECT event_type, COUNT(*)::int AS cnt, COUNT(DISTINCT NULLIF(visitor_id,''))::int AS uniq
       FROM analytics_events WHERE created_at > NOW() - $1::interval
       GROUP BY event_type`, [intervalStr]);

    const bySource = await pool.query(
      `SELECT COALESCE(NULLIF(utm_source,''),'direct') AS source, COUNT(*)::int AS cnt
       FROM analytics_events
       WHERE event_type='pageview' AND created_at > NOW() - $1::interval
       GROUP BY source ORDER BY cnt DESC LIMIT 10`, [intervalStr]);

    // Visitor kahan se aaya — utm_source ho to wahi (chhote alias jaise
    // 'ig'/'fb' ko poore naam me normalize karte hain), warna referrer ke
    // hostname se pehchano. Ek hi visitor ko ek hi baar gino (DISTINCT).
    const sourceSql = `
      CASE
        WHEN LOWER(utm_source) IN ('ig','insta')      THEN 'instagram'
        WHEN LOWER(utm_source) IN ('fb','fbook')       THEN 'facebook'
        WHEN LOWER(utm_source) IN ('wa','whats')       THEN 'whatsapp'
        WHEN LOWER(utm_source) IN ('yt')                THEN 'youtube'
        WHEN LOWER(utm_source) IN ('tg')                THEN 'telegram'
        WHEN LOWER(utm_source) IN ('li')                THEN 'linkedin'
        WHEN LOWER(utm_source) IN ('tw','x')            THEN 'twitter'
        WHEN LOWER(utm_source) IN ('gg','g')            THEN 'google'
        WHEN utm_source <> ''                           THEN LOWER(utm_source)
        WHEN referrer ILIKE '%google.%'    THEN 'google'
        WHEN referrer ILIKE '%bing.%' OR referrer ILIKE '%duckduckgo%'
          OR referrer ILIKE '%yahoo.%'     THEN 'other-search'
        WHEN referrer ILIKE '%facebook%' OR referrer ILIKE '%fb.%'
          OR referrer ILIKE '%fb.watch%'   THEN 'facebook'
        WHEN referrer ILIKE '%instagram%'  THEN 'instagram'
        WHEN referrer ILIKE '%whatsapp%'   THEN 'whatsapp'
        WHEN referrer ILIKE '%youtube%' OR referrer ILIKE '%youtu.be%' THEN 'youtube'
        WHEN referrer ILIKE '%t.me%' OR referrer ILIKE '%telegram%'    THEN 'telegram'
        WHEN referrer ILIKE '%linkedin%'   THEN 'linkedin'
        WHEN referrer ILIKE '%twitter%' OR referrer ILIKE '%x.com%'    THEN 'twitter'
        WHEN referrer = ''                 THEN 'direct'
        ELSE 'other'
      END`;

    const sources = await pool.query(
      `SELECT ${sourceSql} AS source,
              COUNT(*)::int AS views,
              COUNT(DISTINCT NULLIF(visitor_id,''))::int AS visitors
       FROM analytics_events
       WHERE event_type='pageview' AND created_at > NOW() - $1::interval
       GROUP BY 1 ORDER BY visitors DESC, views DESC`, [intervalStr]);

    // Kaunsa source sabse zyada asli grahak laata hai — sirf traffic nahi,
    // demo aur pay tak kaun pahunchta hai wo bhi.
    const sourceQuality = await pool.query(
      `SELECT ${sourceSql} AS source,
              COUNT(DISTINCT NULLIF(visitor_id,'')) FILTER (WHERE event_type='pageview')::int   AS visitors,
              COUNT(DISTINCT NULLIF(visitor_id,'')) FILTER (WHERE event_type='demo_click')::int AS demo_clicks,
              COUNT(DISTINCT NULLIF(visitor_id,'')) FILTER (WHERE event_type='pay_click')::int  AS pay_clicks
       FROM analytics_events
       WHERE created_at > NOW() - $1::interval
       GROUP BY 1 ORDER BY visitors DESC`, [intervalStr]);

    // Din me kitna traffic, raat me kitna — IST 6AM-6PM ko "din" maante
    // hain. created_at UTC me store hota hai isliye +5:30 shift karke
    // IST ghanta nikalte hain.
    const dayNight = await pool.query(
      `SELECT
         CASE WHEN EXTRACT(HOUR FROM (created_at + INTERVAL '5 hours 30 minutes')) BETWEEN 6 AND 17
              THEN 'day' ELSE 'night' END AS period,
         COUNT(*)::int AS cnt,
         COUNT(DISTINCT NULLIF(visitor_id,''))::int AS uniq
       FROM analytics_events
       WHERE event_type='pageview' AND created_at > NOW() - $1::interval
       GROUP BY period`, [intervalStr]);

    // Paise ka funnel — ye analytics_events se nahi, shops table ke asli data se
    const payments = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE demo=false)::int                                  AS registered,
         COUNT(*) FILTER (WHERE demo=false AND setup_paid=true)::int              AS paid,
         COUNT(*) FILTER (WHERE demo=false AND setup_paid=false)::int             AS pending,
         COALESCE(SUM(setup_amount) FILTER (WHERE demo=false AND setup_paid=true),0)::int AS revenue
       FROM shops
       WHERE created_at > NOW() - $1::interval`, [intervalStr]);

    // Shops ki abhi ki halat — ye poore time ka hai, sirf range ka nahi
    const shopStats = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE demo=false AND setup_paid=true)::int   AS active,
         COUNT(*) FILTER (WHERE demo=false AND setup_paid=false)::int  AS unpaid,
         COUNT(*) FILTER (WHERE demo=true AND (demo_expires_at IS NULL OR demo_expires_at > NOW()))::int AS demo_live,
         COUNT(*) FILTER (WHERE demo=true AND demo_expires_at IS NOT NULL AND demo_expires_at <= NOW())::int AS demo_expired,
         COUNT(*)::int AS total
       FROM shops`);

    // Total overall income — "Active shops" jaisa hi POORE TIME ka hai,
    // range filter se independent. NOTE: is table me har shop ki sirf
    // PEHLI payment record hoti hai (setup_amount). Monthly plan ke
    // baad ke renewals abhi alag se log nahi hote, isliye monthly
    // shops ke liye ye unka poora lifetime revenue nahi — sirf
    // onboarding revenue hai. Onetime shops ke liye ye hi final hai.
    const revenueAllTime = await pool.query(
      `SELECT
         COALESCE(SUM(setup_amount) FILTER (WHERE demo=false AND setup_paid=true),0)::int AS total,
         COALESCE(SUM(setup_amount) FILTER (WHERE demo=false AND setup_paid=true AND plan_type='onetime'),0)::int AS onetime_total,
         COALESCE(SUM(setup_amount) FILTER (WHERE demo=false AND setup_paid=true AND plan_type='monthly'),0)::int AS monthly_first_total
       FROM shops`);

    res.json({
      daily: daily.rows,
      shopsDaily: shopsDaily.rows,
      totals: totals.rows,
      bySource: bySource.rows,
      sources: sources.rows,
      sourceQuality: sourceQuality.rows,
      dayNight: dayNight.rows,
      payments: payments.rows[0] || {},
      shopStats: shopStats.rows[0] || {},
      revenueAllTime: revenueAllTime.rows[0] || {},
      days,
      range: rangeKey,
      hourly: isHourly,
      rangeAmount: cfg.amount,
      rangeUnit: cfg.unit
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Razorpay order banane ka reusable helper (kiske keys se — wo caller decide kare)
function createRazorpayOrder(keyId, keySecret, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req2 = https.request({
      hostname: 'api.razorpay.com', path: '/v1/orders', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
        'Content-Length': Buffer.byteLength(body)
      }
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req2.on('error', reject);
    req2.write(body);
    req2.end();
  });
}

// ══════════════ WHITE LABEL — public ══════════════

// License ka price (registration page dikhata hai)
app.get('/api/whitelabel/license-fee', async (req, res) => {
  try {
    res.json({
      licenseFee: await getWlLicenseFee(),
      licenseActual: await getWlLicenseActual(),
      basePrice: await getWlBasePrice()
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Branding — homepage/customer page yahan se apna brand uthate hain
// (?wl=slug se ya subdomain se). Koi WL nahi mila to default Echel.
app.get('/api/whitelabel/branding', async (req, res) => {
  try {
    const wl = await resolveWhitelabel(req);
    if (!wl) return res.json({ isWhitelabel: false });
    // Homepage ke live counters — seedha DB se (hardcoded nahi)
    let stats = { shops: 0, prints: 0 };
    try {
      const c = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM shops
             WHERE whitelabel_id=$1 AND COALESCE(demo,false)=false) AS shops,
           (SELECT COUNT(*)::int FROM print_jobs j
             JOIN shops s ON s.id=j.shop_id
            WHERE s.whitelabel_id=$1) AS prints`, [wl.id]);
      stats = { shops: c.rows[0].shops || 0, prints: c.rows[0].prints || 0 };
    } catch (e) { /* count fail ho to homepage na toote */ }

    let buttons = {};
    try { buttons = wl.hp_buttons ? JSON.parse(wl.hp_buttons) : {}; } catch (e) { buttons = {}; }

    res.json({
      isWhitelabel: true,
      slug: wl.slug,
      brandName: wl.brand_name,
      logoUrl: wl.logo_url || '',
      poweredBy: wl.powered_by || wl.brand_name,
      supportEmail: wl.support_email || '',
      supportPhone: wl.support_phone || '',
      shopPrice: wl.shop_price || 0,
      monthlyPrice: wl.monthly_price || 0,
      hpTitle: wl.hp_title || '',
      hpSubtitle: wl.hp_subtitle || '',
      hpTagline: wl.hp_tagline || '',
      madeIn: wl.made_in || '',
      social: {
        instagram: wl.social_instagram || '',
        youtube:   wl.social_youtube || '',
        facebook:  wl.social_facebook || ''
      },
      buttons: buttons,
      stats: stats
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Step 1 — reseller register kare (abhi paid=false)
app.post('/api/whitelabel/register', async (req, res) => {
  try {
    const b = req.body || {};
    const brand = String(b.brand_name || '').trim().slice(0, 120);
    const owner = String(b.owner_name || '').trim().slice(0, 120);
    const phone = String(b.phone || '').trim();
    const email = String(b.email || '').trim().slice(0, 160);
    const slug  = cleanSlug(b.slug);

    if (brand.length < 2) return res.status(400).json({ error: 'Brand ka naam daalo' });
    if (!owner) return res.status(400).json({ error: 'Apna naam daalo' });
    if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Sahi 10 digit mobile number daalo' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Sahi email daalo' });
    if (slug.length < 3) return res.status(400).json({ error: 'Slug kam se kam 3 akshar ka ho (sirf a-z, 0-9, dash)' });

    const RESERVED = ['www','api','admin','superadmin','app','mail','shop','print','register','agent','wl','whitelabel'];
    if (RESERVED.includes(slug)) return res.status(400).json({ error: 'Ye slug reserved hai, dusra chuno' });

    const dup = await pool.query('SELECT id FROM whitelabels WHERE slug=$1', [slug]);
    if (dup.rows.length) return res.status(400).json({ error: 'Ye slug already liya jaa chuka hai' });

    const wlId = 'WL_' + uuidv4().substring(0, 8).toUpperCase();
    const fee = await getWlLicenseFee();
    const base = await getWlBasePrice();
    // Password abhi random — payment ke baad hi reseller ko dikhaya jaayega
    const tempPass = crypto.randomBytes(16).toString('hex');

    await pool.query(
      `INSERT INTO whitelabels (id, slug, brand_name, owner_name, phone, email, password_hash,
        powered_by, support_email, support_phone, license_fee, base_price, shop_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [wlId, slug, brand, owner, phone, email,
       await hashPassword(tempPass),
       brand, email, phone, fee, base]);

    res.json({ success: true, wlId, slug, licenseFee: fee });
  } catch(err) {
    console.error('WL register error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Step 2 — license fee ka order (ye paisa HAMARE account me aata hai)
app.post('/api/whitelabel/license/create', async (req, res) => {
  try {
    const wlId = String(req.body.wlId || '').trim();
    const r = await pool.query('SELECT id, paid, license_fee FROM whitelabels WHERE id=$1', [wlId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Registration nahi mila' });
    if (r.rows[0].paid) return res.status(400).json({ error: 'License already paid hai' });

    if (!OWNER_RAZORPAY_KEY_ID || !OWNER_RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ error: 'Payment gateway configure nahi hai.' });
    }

    const amount = r.rows[0].license_fee || await getWlLicenseFee();
    const order = await createRazorpayOrder(OWNER_RAZORPAY_KEY_ID, OWNER_RAZORPAY_KEY_SECRET, {
      amount: amount * 100, currency: 'INR',
      receipt: 'WL_' + wlId, notes: { wlId, type: 'whitelabel_license' }
    });
    if (!order.id) {
      const why = order?.error?.description || 'Razorpay ne order reject kiya';
      console.error('WL license create — Razorpay:', JSON.stringify(order));
      return res.status(400).json({ error: 'Order create nahi hua: ' + why });
    }
    await pool.query('UPDATE whitelabels SET license_order_id=$1 WHERE id=$2', [order.id, wlId]);
    res.json({ success: true, orderId: order.id, amount: amount * 100, keyId: OWNER_RAZORPAY_KEY_ID, wlId });
  } catch(err) {
    console.error('WL license create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Step 3 — payment verify -> account activate + login credentials
app.post('/api/whitelabel/license/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, wlId } = req.body;
    const expected = crypto.createHmac('sha256', OWNER_RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (expected !== razorpay_signature) return res.status(400).json({ error: 'Payment verification failed' });

    const r = await pool.query('SELECT id, slug, paid, brand_name, license_fee FROM whitelabels WHERE id=$1 AND license_order_id=$2',
      [wlId, razorpay_order_id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Order match nahi hua' });

    // Idempotent — dobara verify aaye to naya password mat banao
    if (r.rows[0].paid) return res.json({ success: true, alreadyPaid: true, wlId, slug: r.rows[0].slug });

    const password = Math.random().toString(36).slice(-4).toUpperCase() + Math.floor(1000 + Math.random() * 9000);
    await pool.query(
      `UPDATE whitelabels SET paid=true, paid_at=NOW(), password_hash=$2 WHERE id=$1`,
      [wlId, await hashPassword(password)]);

    // License fee HAMARA paisa hai (shop ka setup fee reseller ka hota hai)
    await recordPayment({
      kind: 'wl_license', whitelabelId: wlId,
      shopName: r.rows[0].brand_name || '',
      amount: r.rows[0].license_fee || 0,
      paymentId: razorpay_payment_id, orderId: razorpay_order_id,
      note: 'White-label license fee'
    });

    console.log(`White label activated: ${wlId} (${r.rows[0].slug})`);
    res.json({ success: true, wlId, slug: r.rows[0].slug, password,
      loginUrl: `${BASE_URL}/wl-admin` });
  } catch(err) {
    console.error('WL license verify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Reseller login
app.post('/api/whitelabel/login', loginLimiter, async (req, res) => {
  try {
    // Captcha — band ho to ye line chup-chaap nikal jaati hai
    if (!(await captchaGuard(req, res))) return;
    const wlId = String(req.body.wlId || '').trim().toUpperCase();
    const password = String(req.body.password || '');
    const r = await pool.query('SELECT id, brand_name, paid, blocked, password_hash FROM whitelabels WHERE id=$1', [wlId]);
    if (!r.rows.length) return res.status(401).json({ error: 'ID ya password galat hai' });
    const wl = r.rows[0];
    if (!(await verifyPassword(password, wl.password_hash))) {
      return res.status(401).json({ error: 'ID ya password galat hai' });
    }
    if (!wl.paid) return res.status(403).json({ error: 'License payment abhi complete nahi hua' });
    if (wl.blocked) return res.status(403).json({ error: 'Aapka account abhi paused hai. Admin se baat kariye.' });

    clearLoginHits(req);
    await upgradeHashIfLegacy('whitelabels', 'id', wl.id, wl.password_hash, password);

    const token = jwt.sign({ wlId: wl.id }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token, brandName: wl.brand_name });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════ WHITE LABEL — reseller ka apna panel ══════════════

app.get('/api/whitelabel/me', verifyWhitelabel, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM whitelabels WHERE id=$1', [req.wlId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Account nahi mila' });
    const wl = r.rows[0];

    const s = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE demo=false AND setup_paid=true)::int  AS paid,
              COUNT(*) FILTER (WHERE demo=false AND setup_paid=false)::int AS pending,
              COUNT(*) FILTER (WHERE demo=true)::int                       AS demo,
              COUNT(*)::int                                                AS total
       FROM shops WHERE whitelabel_id=$1`, [req.wlId]);

    const earned = await pool.query(
      `SELECT COALESCE(SUM(setup_amount),0)::int AS total
       FROM shops WHERE whitelabel_id=$1 AND setup_paid=true AND demo=false`, [req.wlId]);

    res.json({
      id: wl.id, slug: wl.slug, brandName: wl.brand_name, ownerName: wl.owner_name,
      phone: wl.phone, email: wl.email, logoUrl: wl.logo_url || '',
      poweredBy: wl.powered_by || '', supportEmail: wl.support_email || '',
      supportPhone: wl.support_phone || '', broadcast: wl.broadcast || '',
      shopPrice: wl.shop_price || 0, basePrice: wl.base_price || 0,
      razorpayKeyId: wl.razorpay_key_id || '',
      razorpayReady: !!(wl.razorpay_key_id && wl.razorpay_key_secret),
      cashfreeAppId: wl.cashfree_app_id || '',
      cashfreeReady: !!(wl.cashfree_app_id && wl.cashfree_secret_key),
      gateway: wl.gateway || 'razorpay',
      // Homepage customization
      hpTitle: wl.hp_title || '', hpSubtitle: wl.hp_subtitle || '',
      hpTagline: wl.hp_tagline || '', madeIn: wl.made_in || '',
      socialInstagram: wl.social_instagram || '',
      socialYoutube: wl.social_youtube || '',
      socialFacebook: wl.social_facebook || '',
      buttons: (function () { try { return wl.hp_buttons ? JSON.parse(wl.hp_buttons) : {}; } catch (e) { return {}; } })(),
      monthlyPrice: wl.monthly_price || 0,
      minMonthlyPrice: WL_MIN_MONTHLY,
      buttonKeys: WL_HP_BUTTON_KEYS,
      notifyEmail: wl.notify_email || '',
      blocked: !!wl.blocked, licenseFee: wl.license_fee || 0, paidAt: wl.paid_at,
      stats: s.rows[0], collected: earned.rows[0].total,
      shareLink: `${BASE_URL}/?wl=${wl.slug}`,
      subdomainLink: `https://${wl.slug}.${(BASE_URL || '').replace(/^https?:\/\//, '')}`
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Branding — powered by, logo, support contact, brand naam
app.put('/api/whitelabel/branding', verifyWhitelabel, async (req, res) => {
  try {
    const b = req.body || {};
    const cut = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : null);
    const email = cut(b.support_email, 160);
    if (email && email !== '' && !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Sahi support email daalo' });
    }
    const phone = cut(b.support_phone, 20);
    if (phone && phone !== '' && !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ error: 'Sahi 10 digit support number daalo' });
    }
    await pool.query(
      `UPDATE whitelabels SET
         brand_name    = COALESCE(NULLIF($2,''), brand_name),
         powered_by    = COALESCE($3, powered_by),
         logo_url      = COALESCE($4, logo_url),
         support_email = COALESCE($5, support_email),
         support_phone = COALESCE($6, support_phone)
       WHERE id=$1`,
      [req.wlId, cut(b.brand_name, 120) || '', cut(b.powered_by, 160), cut(b.logo_url, 400), email, phone]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Partner ka logo — file upload (PNG/JPG, max 40 KB) ──
const WL_LOGO_MAX_KB = 40;
app.post('/api/whitelabel/upload-logo', verifyWhitelabel, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Koi file nahi mili' });

    const mt = req.file.mimetype;
    const isP = (mt === 'image/png')  && isPng(req.file.buffer);
    const isJ = (mt === 'image/jpeg' || mt === 'image/jpg') && isJpeg(req.file.buffer);
    if (!isP && !isJ) {
      return res.status(400).json({ error: 'Sirf PNG ya JPG file chalegi' });
    }
    if (req.file.size > WL_LOGO_MAX_KB * 1024) {
      return res.status(400).json({
        error: `Logo ${WL_LOGO_MAX_KB} KB se chhota hona chahiye (abhi ${Math.round(req.file.size / 1024)} KB hai)`
      });
    }

    const url = await uploadImageToCloudinary(req.file.buffer, isP ? 'image/png' : 'image/jpeg');
    // logo_url VARCHAR(400) hai — Cloudinary URL isme aaram se aa jaata hai
    await pool.query('UPDATE whitelabels SET logo_url=$2 WHERE id=$1', [req.wlId, String(url).slice(0, 400)]);
    res.json({ success: true, logoUrl: url, sizeKb: Math.round(req.file.size / 1024) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/whitelabel/remove-logo', verifyWhitelabel, async (req, res) => {
  try {
    await pool.query("UPDATE whitelabels SET logo_url='' WHERE id=$1", [req.wlId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Shop owner apne agent ko dobara link kar sake.
// Zaroorat kab: PC badla / Windows reinstall hua / token file gum ho gayi,
// ya kisi galat agent ne token claim kar liya. Reset ke baad agli baar jo
// agent token bhejega wahi is shop ka agent ban jaayega.
app.post('/api/shop/agent-token/reset', verifyToken, async (req, res) => {
  try {
    await pool.query('UPDATE shops SET agent_token=NULL WHERE id=$1', [req.shopId]);
    invalidateAgentToken(req.shopId);   // cache saaf — warna disconnect ka asar nahi hoga
    console.log('[agent] token reset by owner: ' + req.shopId);
    res.json({ success: true,
      message: 'Agent unlinked. Start the print agent on the shop PC — it will link automatically.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Print agent ka token check ───────────────────────────────────────────
// PROBLEM: /api/jobs/pending/:shopId jaise endpoint bina kisi auth ke chalte the.
// Shop ID public hota hai (QR link me chhapa hota hai), matlab koi bhi us shop
// ke customers ki uploaded file ka URL nikaal sakta tha aur job churaa sakta tha.
//
// FIX (bina kisi shop ko toda): jis shop ka agent_token set hai, uske liye token
// LAZMI hai. Jiska set nahi (purana agent) wo pehle jaisa chalta rahega —
// aur jaise hi naya agent pehli baar token bhejta hai, wo token us shop par
// lock ho jaata hai. Sab shops upgrade ho jaayein to AGENT_TOKEN_REQUIRED=true
// kar do, phir bina token wale sab block ho jaayenge.
const AGENT_TOKEN_REQUIRED = String(process.env.AGENT_TOKEN_REQUIRED || '') === 'true';

function agentTokenFromReq(req) {
  const t = req.get('X-Agent-Token') || req.query.t || (req.body && req.body.agent_token) || '';
  return String(t).trim().slice(0, 64);
}

async function verifyAgent(req, res, next) {
  try {
    // shopId ya to URL me hota hai (/api/jobs/pending/:shopId) ya BODY me
    // (/api/agent/verify-paid-shop, /api/agent/convert-to-paid).
    //
    // Pehle sirf req.params padha jaata tha, isliye Demo -> Paid wale dono
    // route HAMESHA 400 "shopId missing" dete the -- request endpoint tak
    // pahunchti hi nahi thi. Yaani demo se paid banne ka flow kabhi chala
    // hi nahi, na panel se na tray se.
    //
    // Body se lena utna hi surakshit hai: neeche wahi agent_token check
    // hota hai, to bina sahi token ke kisi aur shop ka data nahi milta.
    let shopId = req.params.shopId
              || (req.body && (req.body.shopId || req.body.demoShopId));

    // convert-to-paid sirf `ticket` bhejta hai (Shop ID uske andar hai).
    // Ticket hum khud sign karte hain, isliye usme se demoShopId lena
    // surakshit hai -- aur asli suraksha to neeche ka agent_token check hai:
    // convert wahi kar sakta hai jiske paas us demo shop ka agent token ho.
    if (!shopId && req.body && req.body.ticket) {
      try {
        const t = jwt.verify(String(req.body.ticket), JWT_SECRET);
        if (t && t.act === 'demo-convert') shopId = t.demoShopId;
      } catch (e) { /* galat/expire ticket -- neeche 400 mil jayega */ }
    }
    if (!shopId) return res.status(400).json({ error: 'shopId missing' });
    // Endpoint ise seedha use kar sake (req.params hamesha nahi hota)
    req.agentShopId = shopId;
    // Token cache se — ye middleware HAR poll par chalta hai. Token
    // kabhi-kabhaar hi badalta hai, aur disconnect par hum cache khud
    // saaf karte hain, isliye cache karna surakshit hai.
    let _tc = agentTokenCache.get(shopId);
    const _ttl = (_tc && _tc.missing) ? AGENT_MISS_TTL_MS : AGENT_TOKEN_TTL_MS;
    if (!_tc || (Date.now() - _tc.at) >= _ttl) {
      const r = await pool.query('SELECT agent_token FROM shops WHERE id=$1', [shopId]);
      if (!r.rows.length) {
        // Nahi mila — yahi yaad rakhna asli bachat hai. Iske bina us
        // shop ka har agla poll dobara DB tak jaata tha.
        setAgentTokenCache(shopId, { token: null, missing: true, at: Date.now() });
        return res.status(404).json({ error: 'Shop not found' });
      }
      _tc = { token: r.rows[0].agent_token, at: Date.now() };
      setAgentTokenCache(shopId, _tc);
    }
    // Cache me "nahi mila" pada hai aur TTL abhi baaki hai — DB tak jaane
    // ki zaroorat hi nahi.
    if (_tc.missing) return res.status(404).json({ error: 'Shop not found' });

    const stored = _tc.token;
    const sent   = agentTokenFromReq(req);

    if (stored) {
      // Timing-safe compare — token guess karna aur mushkil
      const a = Buffer.from(String(stored));
      const b = Buffer.from(sent.padEnd(a.length, '\0').slice(0, a.length));
      if (sent.length !== a.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(403).json({ error: 'Agent token galat hai' });
      }
      return next();
    }

    // Token abhi set nahi hai
    if (sent && /^[A-Za-z0-9_-]{16,64}$/.test(sent)) {
      // Pehla agent jo token bhejta hai, wahi is shop ka agent ban jaata hai
      await pool.query('UPDATE shops SET agent_token=$2 WHERE id=$1 AND agent_token IS NULL', [shopId, sent]);
      setAgentTokenCache(shopId, { token: sent, at: Date.now() });
      return next();
    }
    if (AGENT_TOKEN_REQUIRED) {
      return res.status(403).json({ error: 'Agent purana hai — naya print agent install karo' });
    }
    return next();   // legacy agent — abhi chalne do
  } catch (err) { return res.status(500).json({ error: err.message }); }
}

// ── Homepage customization (title, tagline, socials, buttons on/off, price) ──
app.put('/api/whitelabel/homepage', verifyWhitelabel, async (req, res) => {
  try {
    const b = req.body || {};
    const cut = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : null);
    // Link sirf http(s) — javascript: jaisa kuch na ghuse
    const link = (v, n) => {
      const t = cut(v, n);
      if (t === null) return null;
      if (t === '') return '';
      if (!/^https?:\/\//i.test(t)) return null;
      return t;
    };
    const ig = link(b.social_instagram, 300);
    const yt = link(b.social_youtube, 300);
    const fb = link(b.social_facebook, 300);
    if (b.social_instagram && ig === null) return res.status(400).json({ error: 'Instagram link https:// se shuru hona chahiye' });
    if (b.social_youtube   && yt === null) return res.status(400).json({ error: 'YouTube link https:// se shuru hona chahiye' });
    if (b.social_facebook  && fb === null) return res.status(400).json({ error: 'Facebook link https:// se shuru hona chahiye' });

    // Monthly plan ka price — 399 se kam nahi ho sakta
    let monthly = null;
    if (b.monthly_price !== undefined && b.monthly_price !== null && b.monthly_price !== '') {
      monthly = parseInt(b.monthly_price, 10);
      if (isNaN(monthly)) return res.status(400).json({ error: 'Monthly price number me daalo' });
      if (monthly < WL_MIN_MONTHLY) return res.status(400).json({ error: 'Monthly price ' + WL_MIN_MONTHLY + ' se kam nahi ho sakta' });
      if (monthly > 100000) return res.status(400).json({ error: 'Monthly price bahut zyada hai' });
    }

    // Buttons on/off — sirf allowed keys, sirf true/false
    let btnJson = null;
    if (b.buttons && typeof b.buttons === 'object') {
      const clean = {};
      WL_HP_BUTTON_KEYS.forEach(function (k) {
        if (b.buttons[k] !== undefined) clean[k] = !!b.buttons[k];
      });
      btnJson = JSON.stringify(clean);
    }

    await pool.query(
      `UPDATE whitelabels SET
         hp_title          = COALESCE($2, hp_title),
         hp_subtitle       = COALESCE($3, hp_subtitle),
         hp_tagline        = COALESCE($4, hp_tagline),
         made_in           = COALESCE($5, made_in),
         social_instagram  = COALESCE($6, social_instagram),
         social_youtube    = COALESCE($7, social_youtube),
         social_facebook   = COALESCE($8, social_facebook),
         hp_buttons        = COALESCE($9, hp_buttons),
         monthly_price     = COALESCE($10, monthly_price)
       WHERE id=$1`,
      [req.wlId, cut(b.hp_title, 160), cut(b.hp_subtitle, 200), cut(b.hp_tagline, 200),
       cut(b.made_in, 120), ig, yt, fb, btnJson, monthly]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Apna Cashfree (Razorpay ka doosra option) ──
app.put('/api/whitelabel/cashfree', verifyWhitelabel, async (req, res) => {
  try {
    const appId  = String(req.body.cashfree_app_id || '').trim().slice(0, 120);
    const secret = String(req.body.cashfree_secret_key || '').trim().slice(0, 200);
    if (appId && !secret) return res.status(400).json({ error: 'Secret key bhi daalo' });
    if (secret && !appId) return res.status(400).json({ error: 'App ID bhi daalo' });
    await pool.query(
      'UPDATE whitelabels SET cashfree_app_id=$2, cashfree_secret_key=$3 WHERE id=$1',
      [req.wlId, appId, secret]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Kaunsa gateway use karna hai (razorpay / cashfree) ──
app.put('/api/whitelabel/gateway', verifyWhitelabel, async (req, res) => {
  try {
    const g = String(req.body.gateway || '').trim().toLowerCase();
    if (g !== 'razorpay' && g !== 'cashfree') {
      return res.status(400).json({ error: 'Gateway razorpay ya cashfree hi ho sakta hai' });
    }
    const me = await pool.query(
      'SELECT razorpay_key_id, cashfree_app_id FROM whitelabels WHERE id=$1', [req.wlId]);
    if (!me.rows.length) return res.status(404).json({ error: 'Account nahi mila' });
    if (g === 'razorpay' && !me.rows[0].razorpay_key_id) {
      return res.status(400).json({ error: 'Pehle Razorpay keys save karo' });
    }
    if (g === 'cashfree' && !me.rows[0].cashfree_app_id) {
      return res.status(400).json({ error: 'Pehle Cashfree keys save karo' });
    }
    await pool.query('UPDATE whitelabels SET gateway=$2 WHERE id=$1', [req.wlId, g]);
    res.json({ success: true, gateway: g });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Demo account — ab sirf partner apne login se bana sakta hai ──
app.post('/api/whitelabel/demo/create', verifyWhitelabel, async (req, res) => {
  try {
    const me = await pool.query('SELECT blocked FROM whitelabels WHERE id=$1', [req.wlId]);
    if (!me.rows.length) return res.status(404).json({ error: 'Account nahi mila' });
    if (me.rows[0].blocked) return res.status(403).json({ error: 'Aapka account abhi paused hai' });

    const cfg = await getDemoConfig();
    const name = String(req.body.name || '').trim().slice(0, 100);
    const phone = normPhone(req.body.phone);
    if (!name)  return res.status(400).json({ error: 'Naam daalo' });
    if (!phone) return res.status(400).json({ error: 'Sahi 10-digit mobile number daalo' });

    const dupShop = await pool.query('SELECT id FROM shops WHERE phone=$1 AND demo=true', [phone]);
    if (dupShop.rows.length) {
      return res.status(400).json({ error: 'Is number par demo pehle se hai' });
    }

    const minutes = Math.min(43200, Math.max(10, parseInt(req.body.minutes, 10) || cfg.minutes || 60));
    const shopId = 'DEMO_' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const passwordHash = await hashPassword(phone);
    await pool.query(
      `INSERT INTO shops (id, name, phone, price_bw, price_color, payment_mode, password_hash,
                          setup_paid, setup_amount, demo, demo_expires_at, advanced_unlocked, whitelabel_id)
       VALUES ($1,$2,$3,5,10,'counter_only',$4,true,0,true,NOW() + ($5 || ' minutes')::INTERVAL,true,$6)`,
      [shopId, name + ' (Demo)', phone, passwordHash, String(minutes), req.wlId]);

    const qrUrl = `${BASE_URL}/print/${shopId}`;
    const qrCode = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 });
    await pool.query('UPDATE shops SET qr_code=$1 WHERE id=$2', [qrCode, shopId]);

    console.log(`[WL demo] ${shopId} | wl=${req.wlId} | ${phone} | ${minutes}min`);
    res.json({ success: true, shopId, password: phone, qrUrl, qrCode,
               expiresInMinutes: minutes, note: 'Login password = shop ka mobile number' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Apna Razorpay — shops ka setup fee SEEDHA yahan aayega
app.put('/api/whitelabel/razorpay', verifyWhitelabel, async (req, res) => {
  try {
    const keyId = String(req.body.razorpay_key_id || '').trim().slice(0, 120);
    const secret = String(req.body.razorpay_key_secret || '').trim().slice(0, 200);
    if (!keyId || !secret) return res.status(400).json({ error: 'Key ID aur Secret dono daalo' });
    if (!/^rzp_/i.test(keyId)) return res.status(400).json({ error: 'Key ID rzp_ se shuru honi chahiye' });
    await pool.query('UPDATE whitelabels SET razorpay_key_id=$2, razorpay_key_secret=$3 WHERE id=$1',
      [req.wlId, keyId, secret]);
    res.json({ success: true, razorpayReady: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Shop registration ka price — base se neeche nahi
app.put('/api/whitelabel/price', verifyWhitelabel, async (req, res) => {
  try {
    const r = await pool.query('SELECT base_price, blocked FROM whitelabels WHERE id=$1', [req.wlId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Account nahi mila' });
    if (r.rows[0].blocked) return res.status(403).json({ error: 'Account paused hai' });

    const base = r.rows[0].base_price || await getWlBasePrice();
    const p = parseInt(req.body.price, 10);
    if (!Number.isInteger(p)) return res.status(400).json({ error: 'Sahi price daalo' });
    if (p < base) return res.status(400).json({ error: `Price \u20b9${base} se kam nahi ho sakta` });
    if (p > 9999) return res.status(400).json({ error: 'Price \u20b99999 se zyada nahi ho sakta' });

    await pool.query('UPDATE whitelabels SET shop_price=$2 WHERE id=$1', [req.wlId, p]);
    res.json({ success: true, price: p, base });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Broadcast — sirf ISKI shops ko dikhega
app.put('/api/whitelabel/broadcast', verifyWhitelabel, async (req, res) => {
  try {
    const msg = String(req.body.message || '').slice(0, 1000);
    await pool.query('UPDATE whitelabels SET broadcast=$2 WHERE id=$1', [req.wlId, msg]);
    res.json({ success: true, message: msg });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Meri shops
app.get('/api/whitelabel/shops', verifyWhitelabel, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, phone, address, created_at, setup_paid, demo, demo_expires_at,
              plan_type, setup_amount, agent_last_seen,
              EXTRACT(EPOCH FROM (NOW() - agent_last_seen))::int AS agent_seconds_ago, paused
       FROM shops WHERE whitelabel_id=$1 ORDER BY created_at DESC LIMIT 500`, [req.wlId]);
    res.json({ shops: r.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════ SUPERADMIN: WHITE LABELS ══════════════
app.get('/api/superadmin/whitelabels', verifySuperAdmin, async (req, res) => {
  try {
    const wls = await pool.query('SELECT * FROM whitelabels ORDER BY created_at DESC');
    const out = [];
    for (const w of wls.rows) {
      const s = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE demo=false AND setup_paid=true)::int  AS paid,
                COUNT(*) FILTER (WHERE demo=false AND setup_paid=false)::int AS pending,
                COUNT(*) FILTER (WHERE demo=true)::int                       AS demo,
                COUNT(*)::int                                                AS total,
                COALESCE(SUM(setup_amount) FILTER (WHERE setup_paid=true AND demo=false),0)::int AS collected
         FROM shops WHERE whitelabel_id=$1`, [w.id]);
      out.push({
        id: w.id, slug: w.slug, brandName: w.brand_name, ownerName: w.owner_name,
        phone: w.phone, email: w.email, paid: !!w.paid, blocked: !!w.blocked,
        licenseFee: w.license_fee || 0, basePrice: w.base_price || 0, shopPrice: w.shop_price || 0,
        razorpayReady: !!(w.razorpay_key_id && w.razorpay_key_secret),
        poweredBy: w.powered_by || '', createdAt: w.created_at, paidAt: w.paid_at,
        stats: s.rows[0]
      });
    }
    res.json({
      whitelabels: out,
      licenseFee: await getWlLicenseFee(),
      licenseActual: await getWlLicenseActual(),
      defaultBasePrice: await getWlBasePrice()
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Block/unblock + is reseller ka apna base price
app.put('/api/superadmin/whitelabel/:id', verifySuperAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const chk = await pool.query('SELECT id, shop_price FROM whitelabels WHERE id=$1', [req.params.id]);
    if (!chk.rows.length) return res.status(404).json({ error: 'White label nahi mila' });

    if (b.blocked !== undefined) {
      await pool.query('UPDATE whitelabels SET blocked=$2 WHERE id=$1', [req.params.id, !!b.blocked]);
    }
    if (b.base_price !== undefined && b.base_price !== '') {
      const bp = parseInt(b.base_price, 10);
      if (isNaN(bp) || bp < 0) return res.status(400).json({ error: 'Valid base price daalo' });
      await pool.query('UPDATE whitelabels SET base_price=$2 WHERE id=$1', [req.params.id, bp]);
      // Reseller ka price base se neeche reh gaya ho to usko bhi upar utha do
      if (chk.rows[0].shop_price < bp) {
        await pool.query('UPDATE whitelabels SET shop_price=$2 WHERE id=$1', [req.params.id, bp]);
      }
    }
    const out = await pool.query('SELECT blocked, base_price, shop_price FROM whitelabels WHERE id=$1', [req.params.id]);
    res.json({ success: true, ...out.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════ WHITE LABEL — apni shops par control ══════════
// SABSE ZAROORI: har action se pehle confirm karo ki shop ISI partner ki hai.
// Warna ek partner doosre ki (ya hamari) shops chhu sakta hai.
async function assertWlShop(wlId, shopId) {
  const r = await pool.query(
    'SELECT id, name, setup_paid, setup_amount, demo, whitelabel_id FROM shops WHERE id=$1', [shopId]);
  if (!r.rows.length) return { err: 'Shop nahi mila' };
  if ((r.rows[0].whitelabel_id || '') !== wlId) return { err: 'Ye shop aapki nahi hai' };
  return { shop: r.rows[0] };
}

// Partner apna password badle
app.put('/api/whitelabel/password', verifyWhitelabel, async (req, res) => {
  try {
    const oldPass = String(req.body.old_password || '');
    const newPass = String(req.body.new_password || '');
    if (newPass.length < 6) return res.status(400).json({ error: 'Naya password kam se kam 6 akshar ka ho' });

    const r = await pool.query('SELECT password_hash FROM whitelabels WHERE id=$1', [req.wlId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Account nahi mila' });
    if (!(await verifyPassword(oldPass, r.rows[0].password_hash))) {
      return res.status(401).json({ error: 'Purana password galat hai' });
    }
    await pool.query('UPDATE whitelabels SET password_hash=$2 WHERE id=$1',
      [req.wlId, crypto.createHash('sha256').update(newPass).digest('hex')]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Partner khud shop onboard kare (Shop ID + password turant)
app.post('/api/whitelabel/onboard', verifyWhitelabel, async (req, res) => {
  try {
    const me = await pool.query(
      `SELECT blocked, shop_price, base_price, razorpay_key_id, cashfree_app_id, gateway
         FROM whitelabels WHERE id=$1`, [req.wlId]);
    if (!me.rows.length) return res.status(404).json({ error: 'Account nahi mila' });
    if (me.rows[0].blocked) return res.status(403).json({ error: 'Aapka account abhi paused hai' });
    // Razorpay YA Cashfree — koi ek set hona chahiye
    if (!me.rows[0].razorpay_key_id && !me.rows[0].cashfree_app_id) {
      return res.status(400).json({ error: 'Pehle apna Razorpay ya Cashfree set karo — warna shop payment nahi kar payegi' });
    }

    const name = String(req.body.name || '').trim().slice(0, 200);
    const phone = String(req.body.phone || '').trim();
    const address = String(req.body.address || '').trim().slice(0, 300);
    const printerModel = String(req.body.printer_model || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'Shop ka naam zaroori hai' });
    if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Sahi 10 digit mobile number daalo' });

    const wlBase = me.rows[0].base_price || await getWlBasePrice();
    const sold = (me.rows[0].shop_price && me.rows[0].shop_price > wlBase) ? me.rows[0].shop_price : wlBase;

    // parseInt yahan bhi ₹1.5 ko 1 kar deta tha (naya shop banate waqt)
    const priceBw = parseFloat(req.body.price_bw);
    const priceColor = parseFloat(req.body.price_color);
    const shopId = 'SHOP_' + uuidv4().substring(0, 8).toUpperCase();
    let password = String(req.body.password || '').trim();
    if (password.length < 4) {
      password = Math.random().toString(36).slice(-4).toUpperCase() + Math.floor(1000 + Math.random() * 9000);
    }

    await pool.query(
      `INSERT INTO shops (id,name,address,phone,printer_model,price_bw,price_color,payment_mode,
         password_hash,setup_paid,setup_amount,plan_type,base_price_at_signup,sold_price,whitelabel_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'counter_only',$8,false,$9,'onetime',$10,$9,$11)`,
      [shopId, name, address, phone, printerModel,
       Number.isInteger(priceBw) && priceBw > 0 ? priceBw : 5,
       Number.isInteger(priceColor) && priceColor > 0 ? priceColor : 10,
       await hashPassword(password),
       sold, wlBase, req.wlId]);

    res.json({ success: true, shopId, password, amount: sold,
      pay_url: `${BASE_URL}/setup-payment/${shopId}` });
  } catch(err) {
    console.error('WL onboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Shop ka password reset
app.post('/api/whitelabel/shop/:shopId/reset-password', verifyWhitelabel, async (req, res) => {
  try {
    const chk = await assertWlShop(req.wlId, req.params.shopId);
    if (chk.err) return res.status(403).json({ error: chk.err });
    const temp = 'QSP' + crypto.randomBytes(3).toString('hex');
    await pool.query('UPDATE shops SET password_hash=$1 WHERE id=$2',
      [await hashPassword(temp), req.params.shopId]);
    console.log(`WL ${req.wlId} reset password for ${req.params.shopId}`);
    res.json({ success: true, tempPassword: temp });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Manual activate — partner ne cash le liya (paisa uska hai, risk bhi uska)
app.post('/api/whitelabel/shop/:shopId/activate', verifyWhitelabel, async (req, res) => {
  try {
    const chk = await assertWlShop(req.wlId, req.params.shopId);
    if (chk.err) return res.status(403).json({ error: chk.err });
    if (chk.shop.setup_paid) return res.status(400).json({ error: 'Shop pehle se active hai' });
    const ref = String(req.body.payment_ref || '').trim().slice(0, 60);
    if (!ref) return res.status(400).json({ error: 'Payment reference daalo (cash ho to "CASH" likh do)' });
    const { qrUrl } = await activateShop(req.params.shopId, 'WLMANUAL_' + ref);
    console.log(`WL manual activation: ${req.params.shopId} by ${req.wlId} | ref: ${ref}`);
    res.json({ success: true, qrUrl });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Pending shop delete — paid shop kabhi nahi
app.delete('/api/whitelabel/shop/:shopId', verifyWhitelabel, async (req, res) => {
  try {
    const chk = await assertWlShop(req.wlId, req.params.shopId);
    if (chk.err) return res.status(403).json({ error: chk.err });
    if (chk.shop.setup_paid) return res.status(403).json({ error: 'Paid shop delete nahi ho sakti' });
    await pool.query('DELETE FROM print_jobs WHERE shop_id=$1', [req.params.shopId]);
    await pool.query('DELETE FROM shops WHERE id=$1', [req.params.shopId]);
    console.log(`WL ${req.wlId} deleted pending shop ${req.params.shopId}`);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Shop ke PC ka printer list + selection
app.get('/api/whitelabel/shop/:shopId/printers', verifyWhitelabel, async (req, res) => {
  try {
    const chk = await assertWlShop(req.wlId, req.params.shopId);
    if (chk.err) return res.status(403).json({ error: chk.err });
    const s = await pool.query(
      `SELECT id, name, agent_last_seen,
              EXTRACT(EPOCH FROM (NOW() - agent_last_seen))::int AS agent_seconds_ago,
              printer_name_bw, printer_name_color,
              printer_name_4x6, printer_name_a3
       FROM shops WHERE id=$1`, [req.params.shopId]);
    const p = await pool.query('SELECT value, updated_at FROM system_settings WHERE key=$1',
      [`printers_${req.params.shopId}`]);
    let available = [];
    if (p.rows.length) { try { available = JSON.parse(p.rows[0].value) || []; } catch(e) { available = []; } }
    res.json({ shop: s.rows[0], available: Array.isArray(available) ? available : [],
      reported_at: p.rows.length ? p.rows[0].updated_at : null });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/whitelabel/shop/:shopId/printers', verifyWhitelabel, async (req, res) => {
  try {
    const chk = await assertWlShop(req.wlId, req.params.shopId);
    if (chk.err) return res.status(403).json({ error: chk.err });
    const clean = v => (typeof v === 'string' ? v.trim().slice(0, 300) : null);
    await pool.query(
      `UPDATE shops SET
         printer_name_bw    = COALESCE($2, printer_name_bw),
         printer_name_color = COALESCE($3, printer_name_color),
         printer_name_4x6   = COALESCE($4, printer_name_4x6),
         printer_name_a3    = COALESCE($5, printer_name_a3)
       WHERE id=$1`,
      [req.params.shopId, clean(req.body.printer_name_bw), clean(req.body.printer_name_color),
       clean(req.body.printer_name_4x6), clean(req.body.printer_name_a3)]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Partner ke apne link ka analytics
app.get('/api/whitelabel/analytics', verifyWhitelabel, async (req, res) => {
  try {
    // Superadmin wale analytics jaisa — chhote range ghante-war, bade din-war
    const RANGE_MAP = {
      '1h':  { amount: 1,  unit: 'hours', bucket: 'hour' },
      '12h': { amount: 12, unit: 'hours', bucket: 'hour' },
      '1d':  { amount: 24, unit: 'hours', bucket: 'hour' },
      '7d':  { amount: 7,  unit: 'days',  bucket: 'day'  },
      '14d': { amount: 14, unit: 'days',  bucket: 'day'  },
      '30d': { amount: 30, unit: 'days',  bucket: 'day'  },
      '90d': { amount: 90, unit: 'days',  bucket: 'day'  }
    };
    let rangeKey = String(req.query.range || '');
    if (!RANGE_MAP[rangeKey]) {
      const legacyDays = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
      rangeKey = [7, 14, 30, 90].includes(legacyDays) ? legacyDays + 'd' : '30d';
    }
    const cfg = RANGE_MAP[rangeKey];
    const intervalStr = `${cfg.amount} ${cfg.unit}`;
    const isHourly = cfg.bucket === 'hour';
    const days = cfg.unit === 'days' ? cfg.amount : 0;
    const bucketExpr = isHourly
      ? `TO_CHAR(created_at + INTERVAL '5 hours 30 minutes', 'YYYY-MM-DD"T"HH24:00')`
      : `TO_CHAR(created_at, 'YYYY-MM-DD')`;

    const me = await pool.query('SELECT slug FROM whitelabels WHERE id=$1', [req.wlId]);
    const slug = me.rows[0]?.slug || '';

    const totals = await pool.query(
      `SELECT event_type, COUNT(*)::int AS cnt, COUNT(DISTINCT NULLIF(visitor_id,''))::int AS uniq
       FROM analytics_events
       WHERE wl=$1 AND created_at > NOW() - ($2)::interval
       GROUP BY event_type`, [slug, intervalStr]);

    const daily = await pool.query(
      `SELECT ${bucketExpr} AS day, COUNT(*)::int AS cnt,
              COUNT(DISTINCT NULLIF(visitor_id,''))::int AS uniq
       FROM analytics_events
       WHERE wl=$1 AND event_type='pageview' AND created_at > NOW() - ($2)::interval
       GROUP BY 1 ORDER BY 1 ASC`, [slug, intervalStr]);

    const topPaths = await pool.query(
      `SELECT COALESCE(NULLIF(path,''),'/') AS path, COUNT(*)::int AS cnt
       FROM analytics_events
       WHERE wl=$1 AND event_type='pageview' AND created_at > NOW() - ($2)::interval
       GROUP BY 1 ORDER BY cnt DESC LIMIT 10`, [slug, intervalStr]);

    const topRefs = await pool.query(
      `SELECT COALESCE(NULLIF(ref,''),'direct') AS ref, COUNT(*)::int AS cnt
       FROM analytics_events
       WHERE wl=$1 AND event_type='pageview' AND created_at > NOW() - ($2)::interval
       GROUP BY 1 ORDER BY cnt DESC LIMIT 10`, [slug, intervalStr]);

    const topSources = await pool.query(
      `SELECT COALESCE(NULLIF(utm_source,''),'(none)') AS source, COUNT(*)::int AS cnt
       FROM analytics_events
       WHERE wl=$1 AND created_at > NOW() - ($2)::interval
       GROUP BY 1 ORDER BY cnt DESC LIMIT 10`, [slug, intervalStr]);

    const shopsDaily = await pool.query(
      `SELECT ${bucketExpr} AS day,
              COUNT(*) FILTER (WHERE setup_paid=true AND COALESCE(demo,false)=false)::int AS paid,
              COUNT(*) FILTER (WHERE COALESCE(demo,false)=true)::int                     AS demo
       FROM shops WHERE whitelabel_id=$1 AND created_at > NOW() - ($2)::interval
       GROUP BY 1 ORDER BY 1 ASC`, [req.wlId, intervalStr]);

    // Business summary — shops, prints, kamai
    const summary = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM shops
           WHERE whitelabel_id=$1 AND COALESCE(demo,false)=false) AS shops_total,
         (SELECT COUNT(*)::int FROM shops
           WHERE whitelabel_id=$1 AND COALESCE(demo,false)=false
             AND created_at > NOW() - ($2)::interval) AS shops_new,
         (SELECT COUNT(*)::int FROM shops
           WHERE whitelabel_id=$1 AND COALESCE(demo,false)=true) AS demo_total,
         (SELECT COALESCE(SUM(setup_amount),0)::int FROM shops
           WHERE whitelabel_id=$1 AND setup_paid=true AND COALESCE(demo,false)=false) AS earned_total,
         (SELECT COUNT(*)::int FROM print_jobs j JOIN shops s ON s.id=j.shop_id
           WHERE s.whitelabel_id=$1) AS prints_total,
         (SELECT COUNT(*)::int FROM print_jobs j JOIN shops s ON s.id=j.shop_id
           WHERE s.whitelabel_id=$1 AND j.created_at > NOW() - ($2)::interval) AS prints_range`,
      [req.wlId, intervalStr]);

    res.json({
      slug, range: rangeKey, days, bucket: cfg.bucket,
      totals: totals.rows, daily: daily.rows, shopsDaily: shopsDaily.rows,
      topPaths: topPaths.rows, topRefs: topRefs.rows, topSources: topSources.rows,
      summary: summary.rows[0]
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════ REVIEWS ══════════════
// Public — homepage in par dikhata hai
app.get('/api/reviews', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, stars, text,
              COALESCE(NULLIF(state,''), city) AS city
       FROM reviews
       WHERE active=true AND status='approved'
       ORDER BY sort_order ASC, created_at DESC LIMIT 50`);
    const avg = await pool.query(
      "SELECT COALESCE(AVG(stars),0)::numeric(3,1) AS avg, COUNT(*)::int AS total FROM reviews WHERE active=true AND status='approved'");
    res.json({ reviews: r.rows, average: parseFloat(avg.rows[0].avg) || 0, total: avg.rows[0].total });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Shop apna review bhejta hai — seedha live nahi hota, pehle superadmin
// approve karega. Ek shop ka ek hi review: dobara bhejne par purana update
// ho jaata hai aur wapas pending me chala jaata hai.
app.post('/api/shop/review', verifyToken, async (req, res) => {
  try {
    const name  = String(req.body.name  || '').trim().slice(0, 120);
    const state = String(req.body.state || '').trim().slice(0, 80);
    const text  = String(req.body.text  || '').trim().slice(0, 1200);
    let stars   = parseInt(req.body.stars, 10);
    if (!Number.isFinite(stars) || stars < 1 || stars > 5) stars = 5;

    if (!name)  return res.status(400).json({ error: 'Naam daalo' });
    if (!state) return res.status(400).json({ error: 'State daalo' });
    if (text.length < 10) return res.status(400).json({ error: 'Review kam se kam 10 character ka likho' });

    const existing = await pool.query('SELECT id FROM reviews WHERE shop_id=$1', [req.shopId]);

    let r;
    if (existing.rows.length) {
      r = await pool.query(
        `UPDATE reviews SET name=$1, state=$2, text=$3, stars=$4,
                status='pending', edited=false, created_at=NOW()
         WHERE shop_id=$5 RETURNING id, status`,
        [name, state, text, stars, req.shopId]);
    } else {
      r = await pool.query(
        `INSERT INTO reviews (name, stars, text, state, shop_id, status, active, sort_order)
         VALUES ($1,$2,$3,$4,$5,'pending',true,
                 COALESCE((SELECT MAX(sort_order)+1 FROM reviews),0))
         RETURNING id, status`,
        [name, stars, text, state, req.shopId]);
    }
    res.json({ success: true, review: r.rows[0],
               message: 'Review bhej diya. Approve hone par homepage par dikhega.' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Shop apna bheja hua review aur uski halat dekh sake
app.get('/api/shop/review', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, state, stars, text, status, edited, created_at
       FROM reviews WHERE shop_id=$1`, [req.shopId]);
    res.json({ review: r.rows[0] || null });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/reviews', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM reviews ORDER BY sort_order ASC, created_at DESC');
    res.json({ reviews: r.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/reviews', verifySuperAdmin, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 120);
    const text = String(req.body.text || '').trim().slice(0, 1000);
    const city = String(req.body.city || '').trim().slice(0, 120);
    let stars = parseInt(req.body.stars, 10);
    if (!name) return res.status(400).json({ error: 'Naam daalo' });
    if (!text) return res.status(400).json({ error: 'Review likho' });
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) stars = 5;
    const r = await pool.query(
      `INSERT INTO reviews (name, stars, text, city, sort_order)
       VALUES ($1,$2,$3,$4,COALESCE((SELECT MAX(sort_order)+1 FROM reviews),0)) RETURNING *`,
      [name, stars, text, city]);
    res.json({ success: true, review: r.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/superadmin/reviews/:id', verifySuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Galat id' });
    const b = req.body || {};
    let stars = parseInt(b.stars, 10);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) stars = null;
    const r = await pool.query(
      `UPDATE reviews SET
         name   = COALESCE(NULLIF($2,''), name),
         text   = COALESCE(NULLIF($3,''), text),
         city   = COALESCE($4, city),
         stars  = COALESCE($5, stars),
         active = COALESCE($6, active),
         sort_order = COALESCE($7, sort_order)
       WHERE id=$1 RETURNING *`,
      [id,
       typeof b.name === 'string' ? b.name.trim().slice(0,120) : '',
       typeof b.text === 'string' ? b.text.trim().slice(0,1000) : '',
       typeof b.city === 'string' ? b.city.trim().slice(0,120) : null,
       stars,
       typeof b.active === 'boolean' ? b.active : null,
       Number.isInteger(parseInt(b.sort_order,10)) ? parseInt(b.sort_order,10) : null]);
    if (!r.rows.length) return res.status(404).json({ error: 'Review nahi mila' });
    res.json({ success: true, review: r.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Approve — bina badle, ya edit ke saath. Jo fields bheje jaate hain
// sirf wahi badalte hain, baaki waise ke waise rehte hain.
app.post('/api/superadmin/reviews/:id/approve', verifySuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Galat id' });

    const cur = await pool.query('SELECT * FROM reviews WHERE id=$1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Review nahi mila' });
    const c = cur.rows[0];

    const has = k => Object.prototype.hasOwnProperty.call(req.body, k);
    const name  = has('name')  ? String(req.body.name  || '').trim().slice(0,120) : c.name;
    const state = has('state') ? String(req.body.state || '').trim().slice(0,80)  : c.state;
    const text  = has('text')  ? String(req.body.text  || '').trim().slice(0,1200): c.text;
    let stars = c.stars;
    if (has('stars')) {
      const v = parseInt(req.body.stars, 10);
      if (Number.isFinite(v) && v >= 1 && v <= 5) stars = v;
    }
    if (!name) return res.status(400).json({ error: 'Naam khaali nahi ho sakta' });
    if (!text) return res.status(400).json({ error: 'Review khaali nahi ho sakta' });

    const changed = (name !== c.name) || (state !== (c.state||'')) ||
                    (text !== c.text) || (stars !== c.stars);

    const r = await pool.query(
      `UPDATE reviews SET name=$1, state=$2, text=$3, stars=$4,
              status='approved', active=true, edited=$5
       WHERE id=$6 RETURNING *`,
      [name, state, text, stars, changed || c.edited, id]);
    res.json({ success: true, review: r.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Wapas pending me bhejo (galti se approve ho gaya to)
app.post('/api/superadmin/reviews/:id/unapprove', verifySuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Galat id' });
    const r = await pool.query(
      "UPDATE reviews SET status='pending' WHERE id=$1 RETURNING *", [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Review nahi mila' });
    res.json({ success: true, review: r.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/superadmin/reviews/:id', verifySuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Galat id' });
    await pool.query('DELETE FROM reviews WHERE id=$1', [id]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// ALERTS — naya shop aane par EMAIL
//
// SMTP sirf EK BAAR superadmin set karta hai (Gmail app password se
// 2 minute me ho jaata hai — free hai). Uske baad:
//   normal shop      -> superadmin ke email par
//   white-label shop -> us PARTNER ke email par
// Partner ko koi SMTP setup nahi karna — wo bas apna email daalta hai.
//
// Poori tarah "fire and forget" — email fail ho to bhi registration ya
// payment kabhi nahi rukega.
// ══════════════════════════════════════════════════════════════
let _mailer = null, _mailerAt = 0;

async function getMailer() {
  // 5 min cache — har mail par DB hit na ho
  if (_mailer && (Date.now() - _mailerAt) < 5 * 60 * 1000) return _mailer;
  const r = await pool.query(
    "SELECT key,value FROM system_settings WHERE key IN ('smtp_host','smtp_port','smtp_user','smtp_pass')");
  const m = {}; r.rows.forEach(x => { m[x.key] = x.value; });
  if (!m.smtp_host || !m.smtp_user || !m.smtp_pass) return null;
  const port = parseInt(m.smtp_port, 10) || 587;
  _mailer = nodemailer.createTransport({
    host: m.smtp_host, port,
    secure: port === 465,               // 465 = SSL, 587 = STARTTLS
    auth: { user: m.smtp_user, pass: m.smtp_pass }
  });
  _mailer._fromAddr = m.smtp_user;
  _mailerAt = Date.now();
  return _mailer;
}

// Brevo ka HTTPS API — SMTP ki tarah block nahi hota
function sendViaBrevo(apiKey, senderEmail, senderName, to, subject, text, html) {
  return new Promise((resolve) => {
    try {
      const payload = JSON.stringify({
        sender: { name: senderName || 'Echel', email: senderEmail },
        to: [{ email: to }],
        subject, textContent: text, htmlContent: html
      });
      const req = https.request({
        hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST',
        headers: {
          'api-key': apiKey,
          'content-type': 'application/json',
          'accept': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (resp) => {
        let d = '';
        resp.on('data', c => d += c);
        resp.on('end', () => {
          let j = {}; try { j = JSON.parse(d); } catch (e) {}
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            resolve({ ok: true, messageId: j.messageId || '', response: 'Brevo ' + resp.statusCode + ' OK' });
          } else {
            resolve({ ok: false, why: (j && (j.message || j.code)) || ('Brevo ' + resp.statusCode) });
          }
        });
      });
      req.on('error', e => resolve({ ok: false, why: e.message }));
      req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, why: 'Brevo timeout' }); });
      req.write(payload); req.end();
    } catch (e) { resolve({ ok: false, why: e.message }); }
  });
}

// htmlOverride: designed mail (jaise payment confirmation) ke liye. Na do to
// pehle jaisa hi <pre> wala plain look — purane saare alert waise ke waise.
async function sendEmailAlert(to, subject, body, fromName, htmlOverride) {
  try {
    if (!to) return { ok: false, why: 'email set nahi hai' };

    const html = htmlOverride ||
      ('<pre style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.7;white-space:pre-wrap;margin:0;">'
      + String(body).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>');

    // 1) Brevo (HTTPS) — Render par yahi chalta hai
    const bc = await pool.query(
      "SELECT key,value FROM system_settings WHERE key IN ('brevo_api_key','brevo_sender')");
    const bm = {}; bc.rows.forEach(r => { bm[r.key] = r.value; });
    if (bm.brevo_api_key && bm.brevo_sender) {
      const r = await sendViaBrevo(bm.brevo_api_key, bm.brevo_sender, fromName, to, subject, body, html);
      if (r.ok) return { ok: true, from: bm.brevo_sender, via: 'Brevo', messageId: r.messageId, response: r.response, accepted: [to], rejected: [] };
      return { ok: false, why: r.why, via: 'Brevo' };
    }

    // 2) SMTP — sirf tab jab host block na kare
    const t = await getMailer();
    if (!t) return { ok: false, why: 'Email setup nahi hai — Brevo API key daalo (ya SMTP)' };
    const info = await t.sendMail({
      from: `"${(fromName || 'Echel').replace(/"/g, '')}" <${t._fromAddr}>`,
      to, subject, text: body, html
    });
    // SMTP ne kya jawab diya — yahi asli proof hai ki mail accept hui
    return {
      ok: true, via: 'SMTP',
      from: t._fromAddr,
      messageId: info && info.messageId,
      response: info && info.response,
      accepted: (info && info.accepted) || [],
      rejected: (info && info.rejected) || []
    };
  } catch (e) {
    _mailer = null;                     // agli baar naya transport banega
    return { ok: false, why: e.message };
  }
}

// Kis ko bhejna hai wo khud dhoondh leta hai:
// white-label ki shop -> us PARTNER ko, warna hamein.
async function alertNewShop(shopId, kind) {
  try {
    const s = await pool.query(
      'SELECT id,name,phone,address,setup_amount,whitelabel_id,demo FROM shops WHERE id=$1', [shopId]);
    if (!s.rows.length) return;
    const shop = s.rows[0];
    if (shop.demo) return;   // demo par alert nahi — bahut zyada ho jaayenge

    let to = '', brand = 'Echel';
    if (shop.whitelabel_id) {
      const w = await pool.query(
        'SELECT brand_name, notify_email, email FROM whitelabels WHERE id=$1', [shop.whitelabel_id]);
      if (!w.rows.length) return;
      brand = w.rows[0].brand_name || brand;
      to = w.rows[0].notify_email || w.rows[0].email || '';   // alert email na ho to login wala
    } else {
      const c = await pool.query("SELECT value FROM system_settings WHERE key='notify_email'");
      to = c.rows[0]?.value || '';
    }
    if (!to) return;   // set nahi hai — chup rehna

    const head = kind === 'paid' ? '💰 PAYMENT AAYA' : '🆕 NAYI SHOP REGISTER HUI';
    const body =
      `${head}\n\n` +
      `🏪 Shop     : ${shop.name || '-'}\n` +
      `📱 Mobile   : ${shop.phone || '-'}\n` +
      (shop.address ? `📍 Address  : ${shop.address}\n` : '') +
      `🆔 Shop ID  : ${shop.id}\n` +
      `💵 Amount   : ₹${shop.setup_amount || 0}\n\n` +
      (kind === 'paid'
        ? `✅ Shop active ho gayi hai.`
        : `⏳ Payment abhi baaki hai — follow-up kar lena.`) +
      `\n\n— ${brand}`;

    const subject = `${kind === 'paid' ? '💰 Payment aaya' : '🆕 Nayi shop'}: ${shop.name || shop.id}`;
    const r = await sendEmailAlert(to, subject, body, brand);
    console.log(`Alert (${kind}) ${shopId} -> ${to}: ${r.ok ? 'sent' : 'FAIL ' + r.why}`);
  } catch (e) {
    console.error('alertNewShop error:', e.message);   // kabhi throw nahi karega
  }
}

// Demo shop ka apna EMAIL alert.
//
// Pehle demo par koi alert jaata hi NAHI tha — alertNewShop() shuru me hi
// `if (shop.demo) return;` kar deta hai. Wo jaan-boojh kar tha (demo bahut
// bante hain). Par demo hi asli lead hai: banda abhi software chala kar dekh
// raha hai. Isliye demo ka apna alag alert, apne matter ke saath — aur
// alertNewShop ko chhua nahi, taaki paid shop ka alert waisa hi rahe.
//
// Band karna ho to, koi code badle bina:
//     UPDATE system_settings SET value='0' WHERE key='demo_alert';
//
// how: 'instant'  — form bharte hi ban gaya (aam raasta)
//      'approved' — superadmin ne demo request approve ki
//      'legacy'   — purana /api/demo/create endpoint
async function alertNewDemo(shopId, how) {
  try {
    const g = await pool.query("SELECT value FROM system_settings WHERE key='demo_alert'");
    if (g.rows.length && g.rows[0].value === '0') return;   // superadmin ne band kiya

    const s = await pool.query(
      `SELECT id,name,phone,email,address,printer_model,whitelabel_id,demo,demo_expires_at
         FROM shops WHERE id=$1`, [shopId]);
    if (!s.rows.length) return;
    const shop = s.rows[0];
    if (!shop.demo) return;              // demo hai hi nahi — kuch mat bhejo

    // Kis ko bhejna hai — white-label ki shop -> us PARTNER ko, warna hamein.
    // Bilkul wahi tarika jo alertNewShop use karta hai.
    let to = '', brand = 'Echel';
    if (shop.whitelabel_id) {
      const w = await pool.query(
        'SELECT brand_name, notify_email, email FROM whitelabels WHERE id=$1', [shop.whitelabel_id]);
      if (!w.rows.length) return;
      brand = w.rows[0].brand_name || brand;
      to = w.rows[0].notify_email || w.rows[0].email || '';
    } else {
      const c = await pool.query("SELECT value FROM system_settings WHERE key='notify_email'");
      to = c.rows[0]?.value || '';
    }
    if (!to) return;                     // set nahi hai — chup rehna

    const cfg = await getDemoConfig();
    const hours = Math.max(1, Math.round(cfg.minutes / 60));
    const source = how === 'approved' ? 'Superadmin ne approve kiya'
                 : how === 'legacy'   ? 'Purana instant endpoint'
                 : 'Form bharte hi turant bana';

    const body =
      `🎬 NAYA DEMO ACCOUNT BANA\n\n` +
      `🏪 Shop     : ${shop.name || '-'}\n` +
      `📱 Mobile   : ${shop.phone || '-'}\n` +
      (shop.email         ? `📧 Email    : ${shop.email}\n` : '') +
      (shop.address       ? `📍 Address  : ${shop.address}\n` : '') +
      (shop.printer_model ? `🖨 Printer  : ${shop.printer_model}\n` : '') +
      `🆔 Shop ID  : ${shop.id}\n` +
      `🔑 Password : ${shop.phone || '-'}  (mobile number)\n\n` +
      `⏳ Demo khatam : ${fmtIST(shop.demo_expires_at)}  (${hours} ghante)\n` +
      `🖨 Free print  : ${cfg.printLimit}\n` +
      `📥 Kaise bana  : ${source}\n\n` +
      `Ye asli lead hai — banda abhi software chala kar dekh raha hai.\n` +
      `Demo khatam hone se pehle follow-up kar lena.\n\n` +
      `— ${brand}`;

    const r = await sendEmailAlert(
      to, `🎬 Naya demo: ${shop.name || shop.id}`, body, brand);
    console.log(`Alert (demo/${how || 'instant'}) ${shopId} -> ${to}: ${r.ok ? 'sent' : 'FAIL ' + r.why}`);
  } catch (e) {
    console.error('alertNewDemo error:', e.message);   // kabhi throw nahi karega
  }
}

// ═══════════════════════════════════════════════════════════════════
//  SHOP KO PAYMENT CONFIRMATION EMAIL
//  Payment confirm hone par shop owner ko jaata hai (aapke alert se alag).
//  White-label ki shop ko PARTNER ke brand aur PARTNER ke support se.
// ═══════════════════════════════════════════════════════════════════

// Render UTC me chalta hai — isliye har date zabardasti IST me
function fmtIST(d) {
  if (!d) return '-';
  try {
    return new Date(d).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long',
      year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
    }).replace(/\u202f/g, ' ');   // kuch Node build me narrow-space aata hai
  } catch (e) { return String(d); }
}

// Wahi regex jo baaki server me pehle se chal raha hai — behaviour ek jaisa rahe
function isValidEmail(e) {
  return /^\S+@\S+\.\S+$/.test(String(e || '').trim());
}

// Shop ka naam customer ka diya hua hai — HTML me daalne se pehle escape ZAROORI
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildShopPaymentEmailHtml(d) {
  const ink = '#12181F', paper = '#FFFFFF', rule = '#DDDFD8',
        muted = '#6B7280', green = '#1B7A4B', pageBg = '#ECEDE8',
        mono = "'DejaVu Sans Mono','Courier New',monospace",
        sans = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

  // Receipt jaisi perforated line — yahi is mail ki pehchaan hai
  const perf = '<tr><td style="padding:0 28px"><div style="border-top:2px dashed ' + rule +
    ';height:1px;line-height:1px;font-size:1px">&nbsp;</div></td></tr>';

  const row = (label, value, isMono, isBig) =>
    '<tr>' +
    '<td style="padding:9px 0;font-family:' + sans + ';font-size:13px;color:' + muted +
      ';white-space:nowrap;vertical-align:top">' + label + '</td>' +
    '<td style="padding:9px 0;text-align:right;font-family:' + (isMono ? mono : sans) +
      ';font-size:' + (isBig ? '19px' : '14px') + ';font-weight:' + (isBig ? '700' : '600') +
      ';color:' + ink + '">' + value + '</td>' +
    '</tr>';

  const sectionTitle = t =>
    '<tr><td style="padding:22px 28px 4px;font-family:' + sans + ';font-size:11px;font-weight:700;' +
    'letter-spacing:.11em;text-transform:uppercase;color:' + muted + '">' + t + '</td></tr>';

  const waDigits = String(d.supportPhone || '').replace(/[^0-9]/g, '').slice(-10);

  return '' +
'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + pageBg + ';margin:0;padding:22px 12px">' +
'<tr><td align="center">' +
  '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:' + paper + ';border-radius:10px;overflow:hidden;border:1px solid ' + rule + '">' +

    '<tr><td style="padding:26px 28px 20px;border-bottom:1px solid ' + rule + '">' +
      '<span style="font-family:' + sans + ';font-size:17px;font-weight:700;color:' + ink + '">' + esc(d.brand) + '</span>' +
    '</td></tr>' +

    '<tr><td style="padding:28px 28px 0">' +
      '<span style="display:inline-block;font-family:' + sans + ';font-size:11px;font-weight:700;letter-spacing:.11em;' +
        'text-transform:uppercase;color:' + green + ';border:2px solid ' + green + ';border-radius:4px;padding:5px 11px">Payment received</span>' +
      '<div style="font-family:' + sans + ';font-size:23px;font-weight:700;line-height:1.3;color:' + ink + ';margin:16px 0 8px">' +
        'Shukriya, ' + esc(d.shopName) + ' &mdash; aapki shop ab active hai.</div>' +
      '<div style="font-family:' + sans + ';font-size:14.5px;line-height:1.65;color:' + muted + '">' +
        'Payment mil gaya hai. Neeche aapki shop aur payment ki poori detail hai &mdash; ise sambhaal ke rakhiye.</div>' +
    '</td></tr>' +

    sectionTitle('Shop details') +
    '<tr><td style="padding:0 28px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
      row('Shop ID', esc(d.shopId), true, true) +
      row('Shop ka naam', esc(d.shopName), false, false) +
      row('Register hui', esc(d.registeredAt), false, false) +
    '</table></td></tr>' +

    '<tr><td style="padding:12px 0"></td></tr>' + perf +

    sectionTitle('Payment details') +
    '<tr><td style="padding:0 28px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
      row('Plan', esc(d.plan), false, false) +
      row('Amount paid', '&#8377;' + esc(d.amount), true, true) +
      row('Payment ID', esc(d.paymentId), true, false) +
      row('Paid on', esc(d.paidAt), false, false) +
      (d.validTill ? row('Valid till', esc(d.validTill), false, false) : '') +
    '</table></td></tr>' +

    '<tr><td style="padding:12px 0"></td></tr>' + perf +

    sectionTitle('Ab kya karein') +
    '<tr><td style="padding:2px 28px 0;font-family:' + sans + ';font-size:14.5px;line-height:1.75;color:' + ink + '">' +
      '<div style="padding:4px 0"><b>1.</b> Dashboard me login kariye &mdash; Shop ID aur apna password se</div>' +
      '<div style="padding:4px 0"><b>2.</b> Apna QR code download karke shop par lagaiye</div>' +
      '<div style="padding:4px 0"><b>3.</b> Print Agent install kariye &mdash; uske baad print automatic nikalega</div>' +
    '</td></tr>' +
    (d.dashboardUrl
      ? '<tr><td style="padding:20px 28px 4px">' +
          '<a href="' + esc(d.dashboardUrl) + '" style="display:inline-block;background:' + ink + ';color:#ffffff;' +
          'text-decoration:none;font-family:' + sans + ';font-size:15px;font-weight:600;padding:13px 26px;border-radius:6px">' +
          'Dashboard kholiye &rarr;</a></td></tr>'
      : '') +

    '<tr><td style="padding:22px 0 0"></td></tr>' + perf +

    sectionTitle('Madad chahiye') +
    '<tr><td style="padding:2px 28px 0"><table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
      (waDigits.length === 10
        ? '<td style="padding:6px 10px 6px 0"><a href="https://wa.me/91' + waDigits + '" ' +
          'style="display:inline-block;border:1.5px solid ' + ink + ';border-radius:6px;padding:10px 18px;font-family:' + sans +
          ';font-size:14px;font-weight:600;color:' + ink + ';text-decoration:none">WhatsApp ' + esc(d.supportPhone) + '</a></td>'
        : '') +
      (d.supportEmail
        ? '<td style="padding:6px 0"><a href="mailto:' + esc(d.supportEmail) + '" ' +
          'style="display:inline-block;border:1.5px solid ' + rule + ';border-radius:6px;padding:10px 18px;font-family:' + sans +
          ';font-size:14px;font-weight:600;color:' + ink + ';text-decoration:none">' + esc(d.supportEmail) + '</a></td>'
        : '') +
    '</tr></table></td></tr>' +

    '<tr><td style="padding:26px 28px 28px">' +
      '<div style="border-top:1px solid ' + rule + ';padding-top:16px;font-family:' + sans +
        ';font-size:12.5px;line-height:1.7;color:' + muted + '">' +
        'Ye mail ' + esc(d.brand) + ' ki taraf se automatic bheja gaya hai.<br>' +
        'Payment aapne nahi kiya? Turant upar wale number par batayiye.' +
      '</div>' +
    '</td></tr>' +

  '</table>' +
'</td></tr></table>';
}

// Plain-text version — purane mail apps aur inbox preview line ke liye
function buildShopPaymentEmailText(d) {
  return 'PAYMENT RECEIVED — ' + d.brand + '\n' +
    '=================================\n\n' +
    'Shukriya, ' + d.shopName + ' — aapki shop ab active hai.\n\n' +
    'SHOP DETAILS\n' +
    'Shop ID       : ' + d.shopId + '\n' +
    'Shop ka naam  : ' + d.shopName + '\n' +
    'Register hui  : ' + d.registeredAt + '\n\n' +
    'PAYMENT DETAILS\n' +
    'Plan          : ' + d.plan + '\n' +
    'Amount paid   : Rs ' + d.amount + '\n' +
    'Payment ID    : ' + d.paymentId + '\n' +
    'Paid on       : ' + d.paidAt + '\n' +
    (d.validTill ? 'Valid till    : ' + d.validTill + '\n' : '') + '\n' +
    'AB KYA KAREIN\n' +
    '1. Dashboard me login kariye — Shop ID aur apna password se\n' +
    '2. Apna QR code download karke shop par lagaiye\n' +
    '3. Print Agent install kariye — print automatic nikalega\n\n' +
    (d.dashboardUrl ? 'Dashboard: ' + d.dashboardUrl + '\n\n' : '') +
    'MADAD CHAHIYE\n' +
    (d.supportPhone ? 'WhatsApp : ' + d.supportPhone + '\n' : '') +
    (d.supportEmail ? 'Email    : ' + d.supportEmail + '\n' : '') + '\n' +
    '-- ' + d.brand + '\n' +
    'Payment aapne nahi kiya? Turant upar wale number par batayiye.';
}

// Saara data DB se uthata hai aur mail bhejta hai. Fail ho to bhi kabhi
// throw nahi karta — activation is se kabhi nahi rukna chahiye.
async function sendShopPaymentEmail(shopId) {
  try {
    const s = await pool.query(
      `SELECT id,name,email,created_at,setup_amount,setup_payment_id,
              plan_type,billing_cycle,paid_until,whitelabel_id,demo
       FROM shops WHERE id=$1`, [shopId]);
    if (!s.rows.length) return;
    const shop = s.rows[0];
    if (shop.demo) return;                 // demo par mail nahi
    if (!shop.email) {                     // purani shop — email hai hi nahi
      console.log(`Shop mail skip ${shopId}: email set nahi hai`);
      return;
    }

    let brand = 'Echel', supportEmail = '', supportPhone = '', dashboardUrl = BASE_URL + '/admin';

    if (shop.whitelabel_id) {
      // ── WHITE LABEL ── partner ka brand aur partner ka support. Mera
      // naam, number ya koi program is mail me kahin nahi jaana chahiye.
      const w = await pool.query(
        'SELECT brand_name, slug, support_email, support_phone, site_url FROM whitelabels WHERE id=$1',
        [shop.whitelabel_id]);
      if (!w.rows.length) return;
      const wl = w.rows[0];
      brand = wl.brand_name || 'Print Service';
      supportEmail = wl.support_email || '';
      supportPhone = wl.support_phone || '';
      dashboardUrl = wl.site_url ? (String(wl.site_url).replace(/\/+$/, '') + '/admin')
                                 : (BASE_URL + '/admin?wl=' + encodeURIComponent(wl.slug || ''));
    } else {
      const c = await pool.query("SELECT value FROM system_settings WHERE key='homepage_config'");
      try {
        const cfg = JSON.parse(c.rows[0]?.value || '{}');
        supportEmail = cfg.supportEmail || '';
        supportPhone = cfg.supportPhone || '';
      } catch (e) { /* config toota ho to support ke bina hi mail jaayegi */ }
    }

    const isMonthly = billingCycle(shop)!=='lifetime';
    const data = {
      brand,
      shopId: shop.id,
      shopName: shop.name || shop.id,
      registeredAt: fmtIST(shop.created_at),
      plan: billingCycle(shop)+' (Rs '+(shop.setup_amount||0)+')',
      amount: String(shop.setup_amount || 0),
      paymentId: shop.setup_payment_id || '-',
      paidAt: fmtIST(new Date()),
      validTill: isMonthly && shop.paid_until ? fmtIST(shop.paid_until).split(',')[0] : '',
      dashboardUrl, supportEmail, supportPhone
    };

    const r = await sendEmailAlert(
      shop.email,
      'Payment mil gaya — ' + data.shopName + ' active hai',
      buildShopPaymentEmailText(data),
      brand,
      buildShopPaymentEmailHtml(data)
    );
    console.log(`Shop mail ${shopId} -> ${shop.email}: ${r.ok ? 'sent' : 'FAIL ' + r.why}`);
  } catch (e) {
    console.error('sendShopPaymentEmail error:', e.message);
  }
}

// ── Superadmin: email alert settings ──
app.get('/api/superadmin/notify', verifySuperAdmin, async (req, res) => {
  try {
    const c = await pool.query(
      "SELECT key,value FROM system_settings WHERE key IN ('smtp_host','smtp_port','smtp_user','smtp_pass','notify_email','brevo_api_key','brevo_sender')");
    const m = {}; c.rows.forEach(r => { m[r.key] = r.value; });
    res.json({
      host: m.smtp_host || 'smtp.gmail.com',
      port: m.smtp_port || '587',
      user: m.smtp_user || '',
      hasPass: !!m.smtp_pass,          // password kabhi wapas nahi bhejte
      notifyEmail: m.notify_email || '',
      brevoSender: m.brevo_sender || '',
      hasBrevoKey: !!m.brevo_api_key
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/superadmin/notify', verifySuperAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const set = async (k, v) => {
      await pool.query(
        `INSERT INTO system_settings (key,value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value=$2`, [k, String(v || '').slice(0, 300)]);
    };
    if (b.host !== undefined) await set('smtp_host', String(b.host).trim());
    if (b.port !== undefined) await set('smtp_port', String(parseInt(b.port, 10) || 587));
    if (b.user !== undefined) await set('smtp_user', String(b.user).trim());
    // Password khaali bheja = purana rehne do (form me dobara type na karna pade)
    if (b.pass) await set('smtp_pass', String(b.pass).trim());
    if (b.notifyEmail !== undefined) {
      const e = String(b.notifyEmail).trim();
      if (e && !/^\S+@\S+\.\S+$/.test(e)) return res.status(400).json({ error: 'Sahi email daalo' });
      await set('notify_email', e);
    }
    if (b.brevoSender !== undefined) {
      const e = String(b.brevoSender).trim();
      if (e && !/^\S+@\S+\.\S+$/.test(e)) return res.status(400).json({ error: 'Sahi sender email daalo' });
      await set('brevo_sender', e);
    }
    if (b.brevoKey) await set('brevo_api_key', String(b.brevoKey).trim());
    _mailer = null;   // settings badli — naya transport banega
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/notify/test', verifySuperAdmin, async (req, res) => {
  try {
    const c = await pool.query("SELECT value FROM system_settings WHERE key='notify_email'");
    const to = c.rows[0]?.value || '';
    if (!to) return res.status(400).json({ error: 'Pehle alert email save karo' });

    // Brevo set hai to seedha bhejo. Warna SMTP ka connection pehle check karo.
    const bk = await pool.query("SELECT value FROM system_settings WHERE key='brevo_api_key'");
    const usingBrevo = !!(bk.rows[0]?.value);
    if (!usingBrevo) {
      const t = await getMailer();
      if (!t) return res.status(400).json({ error: 'Email setup nahi hai — Brevo API key daalo (recommended) ya SMTP bharo' });
      try {
        await t.verify();
      } catch (e) {
        _mailer = null;
        const hint = /timeout|ETIMEDOUT|ECONNREFUSED/i.test(e.message)
          ? ' — lagta hai hosting ne SMTP port block kiya hai. Brevo API key use karo (upar wala option).'
          : '';
        return res.status(400).json({ error: 'SMTP connect nahi hua: ' + e.message + hint });
      }
    }

    const r = await sendEmailAlert(to, '✅ Test — Echel alerts',
      'Ye ek test email hai.\n\nAgar ye mil gaya, matlab alerts chalu ho gaye hain.\nAb nayi shop register hone par aapko yahan message aayega.\n\n— Echel');
    if (!r.ok) return res.status(400).json({ error: 'Bheja nahi ja saka: ' + r.why });
    if (r.rejected && r.rejected.length) {
      return res.status(400).json({ error: 'Server ne reject kiya: ' + r.rejected.join(', ') });
    }
    console.log(`Test mail -> ${to} | ${r.response} | id=${r.messageId}`);
    res.json({
      success: true, to, from: r.from, via: r.via,
      accepted: r.accepted, messageId: r.messageId, response: r.response
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── White label partner: sirf apna email (koi SMTP setup nahi) ──
app.put('/api/whitelabel/notify', verifyWhitelabel, async (req, res) => {
  try {
    const e = String(req.body.notifyEmail || '').trim();
    if (e && !/^\S+@\S+\.\S+$/.test(e)) return res.status(400).json({ error: 'Sahi email daalo' });
    await pool.query('UPDATE whitelabels SET notify_email=$2 WHERE id=$1', [req.wlId, e]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/whitelabel/notify/test', verifyWhitelabel, async (req, res) => {
  try {
    const w = await pool.query(
      'SELECT brand_name, notify_email, email FROM whitelabels WHERE id=$1', [req.wlId]);
    const row = w.rows[0];
    const to = (row && (row.notify_email || row.email)) || '';
    if (!to) return res.status(400).json({ error: 'Pehle apna email save karo' });
    const brand = row.brand_name || 'Partner';
    const r = await sendEmailAlert(to, `✅ Test — ${brand} alerts`,
      `Ye ek test email hai.\n\nAgar ye mil gaya, matlab alerts chalu ho gaye hain.\nAb aapke link se nayi shop register hone par yahan message aayega.\n\n— ${brand}`, brand);
    if (!r.ok) return res.status(400).json({ error: 'Bheja nahi ja saka: ' + r.why });
    res.json({ success: true, to });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/setup-fee/current', async (req, res) => {
  try {
    const pricing = await getSetupPricing();

    // ── WHITE LABEL ──
    // Partner ke site (subdomain ya ?wl=slug) par uska APNA price dikhna
    // chahiye, hamara nahi. Pehle ye poori tarah chhoot gaya tha, isliye
    // partner price badalta tha par uske URL par purana hi dikhta tha.
    const wlHere = await resolveWhitelabel(req);
    if (wlHere) {
      const wlBase = wlHere.base_price || await getWlBasePrice();
      const wlPrice = (wlHere.shop_price && wlHere.shop_price > wlBase) ? wlHere.shop_price : wlBase;
      const fest0 = await getFestivalOffer();
      return res.json({
        ...pricing,
        // White-label par sirf Starter. Partner apne base price par
        // basic product bechta hai — Pro/Premium hamare apne channel
        // ke liye hain. (Demo homepage par alag se milta hai.)
        plans: { starter: { fee: wlPrice, actual: 0, advance: false } },
        amount: wlPrice,
        offerPrice: wlPrice,
        actualPrice: wlPrice,        // partner ke yahan koi "cut" price nahi
        monthlyPrice: wlHere.monthly_price || pricing.monthlyPrice,
        advancedFee: await getAdvancedFee(),
        monthlyActualPrice: wlHere.monthly_price || await getMonthlyActualFee(),
        advancedActualPrice: await getAdvancedActualFee(),
        // Festival offer hamara hai — partner ke price par lagu nahi hota
        festivalOfferEnabled: false,
        festivalOfferName: '',
        festivalOfferEnd: null,
        isWhitelabel: true,
        wlSlug: wlHere.slug,
        brandName: wlHere.brand_name
      });
    }

    const festival = await getFestivalOffer();
    const out = {
      amount: pricing.offerPrice, ...pricing,
      // Naye teen plan — homepage aur register page ise hi padhte hain
      plans: await getPlanPricing(),
      advancedFee: await getAdvancedFee(),
      monthlyActualPrice: await getMonthlyActualFee(),
      advancedActualPrice: await getAdvancedActualFee(),
      festivalOfferEnabled: festival.enabled,
      festivalOfferName: festival.name,
      festivalOfferEnd: festival.endAt
    };
    // ?ref=QRA-1234 — agent ka apna price (sirf one-time plan par).
    // Agent ka floor ab AGENT BASE PRICE hai, public Offer Price nahi —
    // agent ne kuch set na kiya ho tab bhi yahi (699 jaisa) dikhega.
    if (req.query.ref) {
      const s = await resolveRef(req.query.ref);
      if (s && s.is_agent) {
        // Sirf floor. Purana `agent_price` (markup) ab nahi ginta --
        // us feature ko band kiye jaane ke baad bhi wo column reh gaya
        // tha aur chup-chaap customer ka price badha raha tha.
        const agentBase = await getAgentBasePrice();
        out.offerPrice = agentBase;
        out.amount = agentBase;
        out.agentRef = req.query.ref;
        out.agentName = s.name;
        // Agent ke link par SIRF Pro aur Premium. Starter sabse sasta
        // hai — uspar agent ka commission nikalta hi nahi, isliye wo
        // agent channel me nahi bechte.
        out.plans = filterPlansForChannel(out.plans, 'agent');
        // Agent ke dono plan ka apna floor hai.
        if (out.plans.pro && agentBase > out.plans.pro.fee) {
          out.plans.pro = { ...out.plans.pro, fee: agentBase, actual: 0 };
        }
        const agentPremBase = await getAgentPremiumBasePrice();
        if (out.plans.premium && agentPremBase > out.plans.premium.fee) {
          out.plans.premium = { ...out.plans.premium, fee: agentPremBase, actual: 0 };
        }
      }
    }
    res.json(out);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/setup-fee/amount/:shopId', async (req, res) => {
  try {
    const r = await pool.query('SELECT setup_amount, setup_paid FROM shops WHERE id=$1', [req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    res.json({ amount: r.rows[0].setup_amount, paid: r.rows[0].setup_paid });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Ek IP se 24 ghante me itni hi BINA PAISE wali shop ban sakti hai.
// Paid shop is ginti me nahi aati, isliye asli reseller nahi rukta.
const UNPAID_PER_IP_DAY = parseInt(process.env.UNPAID_REG_PER_IP_DAY || '3', 10);

// Ek hi mobile number se itni koshish ke baad utni der ka block.
// Imandaar aadmi ek-do baar galti karta hai, teen se aage nahi jaata.
const REG_PHONE_MAX = parseInt(process.env.REG_RETRY_PER_PHONE || '3', 10);
const REG_PHONE_WINDOW_MS = 15 * 60 * 1000;

app.post('/api/shop/register', async (req, res) => {
  try {
    // ── Pehra 1: pakka blocklist ──
    const _regIp = clientIp(req);
    if (await isIpBanned(_regIp)) {
      await logSecurityEvent({
        ip: _regIp, endpoint: req.path, method: req.method,
        userAgent: req.headers['user-agent'],
        action: 'SHOP_REGISTER', reason: 'IP_BANNED' });
      return res.status(403).json({
        error: 'Is connection se registration band hai. Support se baat kariye.' });
    }

    // ── Pehra 2: ek IP se kitni unpaid shop ──
    // Yahi wo chhed tha jisse ek hi banda baar-baar shop banata raha.
    try {
      const _u = await pool.query(
        `SELECT COUNT(*)::int AS n FROM shops
          WHERE created_ip = $1 AND setup_paid = false
            AND created_at > NOW() - INTERVAL '24 hours'`, [_regIp]);
      if (_u.rows[0].n >= UNPAID_PER_IP_DAY) {
        await logSecurityEvent({
          ip: _regIp, endpoint: req.path, method: req.method,
          userAgent: req.headers['user-agent'],
          action: 'SHOP_REGISTER', reason: 'UNPAID_REG_LIMIT (' + _u.rows[0].n + ')' });
        return res.status(429).json({
          error: 'Is connection se pehle hi kai shop ban chuki hain jinka payment nahi hua. '
               + 'Pehle unka setup poora karo, ya support se baat karo.' });
      }
    } catch (e) {
      // created_at column purane DB me na ho to register rokna galat hoga
      console.warn('unpaid-reg check skip:', e.message);
    }

    const {
      name, address, phone, printer_model, price_bw, price_color, payment_mode, password,
      payment_gateway, razorpay_key_id, razorpay_key_secret,
      cashfree_app_id, cashfree_secret_key, email, ref
    } = req.body;

    // Referral: ?ref=SHOP_XXX se aaya — sirf tab valid jab wo referrer
    // EXIST kare aur khud PAID ho (unpaid shop refer nahi kar sakta),
    // aur khud ko refer na kare
    // ref = agent code (QRA-1234) ya purana shop id — dono support
    const refShop = await resolveRef(ref);
    const referredBy = refShop ? refShop.id : '';
    const onboardedBy = (refShop && refShop.is_agent) ? refShop.id : '';

    // ── Pehra 3: captcha ──
    // Poora captcha system pehle se maujood tha aur login par chalta tha;
    // register par lagana bas reh gaya tha. Band karna ho to
    // system_settings me captcha_enabled = '0'.
    if (!(await captchaGuard(req, res))) return;

    // ── Pehra 4: asli mobile number ──
    // validateIndianMobile() pehle se thi par SIRF demo par lagti thi.
    // Register par phone bina dekhe DB me chala jaata tha — 1111111111
    // bhi chal jaata. Ab dono raste ek hi jaanch se guzarte hain.
    const _ph = registerPhoneCheck(phone);
    if (!_ph.ok) return res.status(400).json({ error: _ph.error });

    // ── Pehra 5: ek hi number se baar-baar ──
    // Yahan sirf DEKHTE hain ki pehle se block to nahi. GINTI neeche
    // badhti hai — INSERT se theek pehle. Wajah: agar ginti yahin badha
    // dete to password ki ek chhoti si galti bhi ek "koshish" gin jaati,
    // aur teen typo ke baad imandaar aadmi 15 minute ke liye bahar.
    // Ab wahi ginta hai jo poori tarah sahi bhara gaya ho.
    const _pk = 'reg:' + _ph.phone;
    const _pmin = isBlocked(_pk);
    if (_pmin) {
      await logSecurityEvent({ ip: _regIp, endpoint: req.path, method: req.method,
        userAgent: req.headers['user-agent'], action: 'SHOP_REGISTER',
        reason: 'PHONE_RETRY_BLOCKED' });
      return res.status(429).json({
        error: 'Is number se abhi bahut koshish ho chuki hai. ' + _pmin
             + ' minute baad dobara try karo.' });
    }

    if (!name || !name.trim()) return res.status(400).json({ error: 'Shop ka naam zaroori hai' });
    if (!password || password.length < 4) return res.status(400).json({ error: 'Password kam se kam 4 character ka hona chahiye' });
    if (password.length > PASSWORD_MAX) return res.status(400).json({ error: 'Password bahut lamba hai' });

    // Email ab ZAROORI hai — payment confirmation isi par jaati hai
    const finalEmail = String(email || '').trim().toLowerCase();
    if (!finalEmail) return res.status(400).json({ error: 'Email zaroori hai — payment ki receipt isi par aayegi' });
    if (!isValidEmail(finalEmail)) return res.status(400).json({ error: 'Email sahi nahi lag raha — dobara check karo' });

    const validPaymentModes = ['both', 'counter_only', 'online_only'];
    const finalPaymentMode = validPaymentModes.includes(payment_mode) ? payment_mode : 'both';

    const needsGateway = finalPaymentMode === 'both' || finalPaymentMode === 'online_only';
    let finalGateway = '';
    if (needsGateway) {
      if (payment_gateway === 'razorpay' && razorpay_key_id && razorpay_key_secret) {
        finalGateway = 'razorpay';
      } else if (payment_gateway === 'cashfree' && cashfree_app_id && cashfree_secret_key) {
        finalGateway = 'cashfree';
      } else {
        return res.status(400).json({ error: 'Online payment ke liye Razorpay ya Cashfree ki details zaroori hain' });
      }
    }

    const shopId = 'SHOP_' + uuidv4().substring(0,8).toUpperCase();
    const passwordHash = await hashPassword(password);
    const currentSetupFee = await getSetupFeeAmount();
    // Plan: starter / pro / premium — teeno LIFETIME.
    // Purane 'monthly'/'onetime' ab naye registration me nahi aate;
    // purani shops apne plan_type ke saath waise hi chalti rehti hain.
    let plan = normalizePlan(req.body.plan);
    const planPricing = await getPlanPricing();
    // Agent ke link se aaya hai to floor = AGENT BASE PRICE (superadmin ne
    // set kiya hua, jaise 699) — public Offer Price (599) nahi. Agent ne
    // khud kuch aur set kiya ho (jaise 799) to wahi lagega. Ye SIRF
    // one-time plan par lagta hai; monthly hamesha public rate par.
    // Direct registration = chune hue plan ka price.
    // Agent / white-label ke link se aaye to unka apna price jeetta
    // hai (neeche override hota hai) — unka business model wahi rehta hai.
    let oneTimePrice = planPricing[plan].fee;
    let onetimeBaseForRecord = planPricing[plan].fee;
    if (onboardedBy) {
      // Agent channel me sirf Pro aur Premium bikte hain. Koi seedha
      // ?plan=starter&ref=... bhej de to bhi Starter nahi milega —
      // page par wo option dikhta hi nahi, isliye ye jaan-bujh kar
      // bheja gaya request hai.
      if (!PLANS_BY_CHANNEL.agent.includes(plan)) plan = 'pro';
      const agentBase = await getAgentBasePrice();
      // Agent ka apna price sirf Pro ka floor hai. Premium ka apna
      // (upar wala) price rehta hai — warna agent Premium sasta bech deta.
      // Dono plan ka apna agent floor — aur bas wahi. Purana
      // `agent_price` / `agent_premium_price` (markup) ab price me nahi
      // ginte; wo feature band ho chuka hai par column reh gaye the.
      if (plan === 'pro') {
        oneTimePrice = agentBase;
        onetimeBaseForRecord = agentBase;
      } else {
        // Premium ka apna agent-floor hai — Pro wale se alag.
        const premBase = await getAgentPremiumBasePrice();
        oneTimePrice = premBase;
        onetimeBaseForRecord = premBase;
      }
    }

    // ── WHITE LABEL ── ?wl=slug ya subdomain se aaya ho to reseller ka
    // price lagta hai, aur setup fee SEEDHA uske Razorpay me jaayega.
    const wl = await resolveWhitelabel(req);
    let whitelabelId = '';
    if (wl) {
      // Reseller ne apna koi bhi gateway nahi lagaya — paisa galti se
      // hamare paas aa jaata, isliye registration hi rok do (saaf message
      // ke saath). Pehle yahan sirf Razorpay dekha jaata tha, isliye
      // Cashfree wala partner yahin atak jaata tha.
      if (!wlPayMode(wl)) {
        return res.status(503).json({ error: 'Ye partner abhi payment setup complete nahi kiya hai. Thodi der baad try kariye.' });
      }
      whitelabelId = wl.id;
      // White-label par sirf Starter. Partner apne naam par basic
      // product bechta hai — Pro/Premium hamare apne channel ke liye.
      if (!PLANS_BY_CHANNEL.wl.includes(plan)) plan = 'starter';
      const wlBase = wl.base_price || await getWlBasePrice();
      oneTimePrice = (wl.shop_price && wl.shop_price > wlBase) ? wl.shop_price : wlBase;
      onetimeBaseForRecord = wlBase;
    }
    const firstPayment = oneTimePrice;
    const soldPrice = oneTimePrice;
    const basePrice  = onetimeBaseForRecord;

    // ── Pehra 5 (doosra hissa): ab ginti badhao ──
    // Yahan tak wahi pahunchta hai jisne form THEEK bhara ho. Isliye ye
    // ginti "koshish" ki hai, "typo" ki nahi. Teen ke baad us number par
    // 15 minute ka block.
    {
      const _now = Date.now();
      let _h = regPhoneHits.get(_ph.phone);
      if (!_h || _now > _h.resetAt) _h = { count: 0, resetAt: _now + REG_PHONE_WINDOW_MS };
      _h.count++;
      regPhoneHits.set(_ph.phone, _h);
      if (_h.count > REG_PHONE_MAX) {
        blockFor(_pk, SEC.blockMin, 'same phone register retry');
        await logSecurityEvent({ ip: _regIp, endpoint: req.path, method: req.method,
          userAgent: req.headers['user-agent'], action: 'SHOP_REGISTER',
          reason: 'PHONE_RETRY_LIMIT (' + _h.count + ')' });
        return res.status(429).json({
          error: 'Is number se abhi bahut koshish ho chuki hai. ' + SEC.blockMin
               + ' minute baad dobara try karo.' });
      }
    }

    // Shop create hoti hai lekin setup_paid=false rehta hai by default.
    // QR Code aur Print Agent sirf setup fee payment confirm hone ke baad milte hain.
    await pool.query(
      `INSERT INTO shops
        (id,name,address,phone,email,printer_model,price_bw,price_color,payment_mode,password_hash,
         payment_gateway,razorpay_key_id,razorpay_key_secret,cashfree_app_id,cashfree_secret_key,
         setup_paid,setup_amount,plan_type,referred_by,onboarded_by,base_price_at_signup,sold_price,whitelabel_id,
         created_ip,billing_cycle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,false,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [shopId, name, address, _ph.phone, finalEmail, printer_model, price_bw||5, price_color||10, finalPaymentMode, passwordHash,
       finalGateway, razorpay_key_id||'', razorpay_key_secret||'', cashfree_app_id||'', cashfree_secret_key||'',
       firstPayment, plan, referredBy, onboardedBy, basePrice, soldPrice, whitelabelId,
       _regIp, planPricing[plan].billingCycle]
    );
    // Ab har nayi shop ke saath uska IP bhi hai — aage aisa sawal aaya to
    // jawab turant milega.

    res.json({ success: true, shopId, setupFeeAmount: firstPayment, plan, billingCycle: planPricing[plan].billingCycle });
    // Alert baad me — response pehle ja chuka hai, isliye customer ko wait nahi karna padta
    alertNewShop(shopId, 'new');
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── SETUP FEE PAYMENT — Rupesh (system owner) ki Razorpay account mein paisa aata hai ───
app.post('/api/setup-fee/create', async (req, res) => {
  try {
    const { shopId } = req.body;
    if (!shopId) return res.status(400).json({ error: 'Shop ID required' });

    // phone bhi chahiye — Cashfree order me customer_phone lagta hai
    const shopResult = await pool.query(
      'SELECT id, phone, setup_paid, setup_amount, whitelabel_id FROM shops WHERE id=$1', [shopId]);
    if (!shopResult.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    if (shopResult.rows[0].setup_paid) return res.status(400).json({ error: 'Setup fee already paid hai' });

    // ── Paisa kiske account me? ──
    // Normal shop -> hamara Razorpay. White-label ki shop -> RESELLER ka
    // Razorpay (uski kamai seedha usi ke paas jaati hai, hamare paas nahi).
    let payKeyId = OWNER_RAZORPAY_KEY_ID, payKeySecret = OWNER_RAZORPAY_KEY_SECRET;
    const wlIdOfShop = shopResult.rows[0].whitelabel_id || '';

    // SAFETY: request kisi partner ke URL se aayi hai par shop par
    // whitelabel_id nahi hai — matlab registration ke waqt context kho
    // gaya tha. Aise me paisa CHUPCHAAP hamare account me nahi lena.
    // Saaf error do taaki galti pakdi jaye, paisa galat jagah na jaye.
    if (!wlIdOfShop) {
      const wlReq = await resolveWhitelabel(req);
      if (wlReq) {
        console.error(`SETUP FEE MISMATCH: shop ${shopId} par whitelabel_id khaali hai `
          + `par request partner "${wlReq.slug}" ke URL se aayi. Payment roka gaya.`);
        return res.status(409).json({
          error: 'Is shop ka partner account link nahi hua. Apne partner se sampark kariye.',
          code: 'WL_LINK_MISSING'
        });
      }
    }
    if (wlIdOfShop) {
      const w = await pool.query(
        `SELECT razorpay_key_id, razorpay_key_secret,
                cashfree_app_id, cashfree_secret_key, gateway, blocked
           FROM whitelabels WHERE id=$1`, [wlIdOfShop]);
      const wrow = w.rows[0];
      if (!wrow) return res.status(503).json({ error: 'Partner ka payment setup adhoora hai. Unse sampark kariye.' });
      if (wrow.blocked) return res.status(403).json({ error: 'Ye partner account abhi active nahi hai.' });

      const mode = wlPayMode(wrow);
      if (!mode) {
        return res.status(503).json({ error: 'Partner ka payment setup adhoora hai. Unse sampark kariye.' });
      }

      // ── Partner Cashfree par hai ──
      // Paisa seedha partner ke Cashfree account me jaata hai. Razorpay
      // ki tarah yahan browser koi signature wapas nahi laata — payment
      // ke baad Cashfree apne page se wapas bhej deta hai, aur hum
      // server se order ka status poochh kar shop activate karte hain
      // (wahi tareeka jo customer ke print payment me chal raha hai).
      if (mode === 'cashfree') {
        const cfAmount = shopResult.rows[0].setup_amount || SETUP_FEE_AMOUNT;
        // Cashfree ka order_id: sirf A-Z 0-9 _ chalte hain, 50 char tak.
        // Aakhir me 4 random byte — Date.now() ki resolution millisecond
        // hai, aur Cashfree do baar wahi order_id nahi leta. Customer
        // wale print payment me bhi yahi tareeka hai.
        const cfOrderId = 'QSPS_' + String(shopId).replace(/[^A-Za-z0-9_]/g, '').slice(-16)
          + '_' + Date.now().toString(36).toUpperCase()
          + crypto.randomBytes(3).toString('hex').toUpperCase();

        // Wapas PARTNER ke apne domain par bhejo, hamare par nahi —
        // warna beech raaste me brand badal jaata hai aur shop owner ko
        // lagta hai kisi aur site par pahunch gaya.
        const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
        const host  = String(req.headers.host || '').split(',')[0].trim();
        const origin = host ? (proto + '://' + host) : BASE_URL;

        const cfPhone = String(shopResult.rows[0].phone || '').replace(/\D/g, '').slice(-10);
        const cfBody = JSON.stringify({
          order_id: cfOrderId,
          order_amount: Number(cfAmount),        // rupees, paise NAHI
          order_currency: 'INR',
          customer_details: {
            customer_id: 'SHOP_' + String(shopId).slice(-12),
            // Cashfree phone maangta hi hai; shop ka number na ho to
            // placeholder — payment par iska koi asar nahi.
            customer_phone: cfPhone.length === 10 ? cfPhone : '9999999999'
          },
          order_meta: { return_url: origin + '/setup-payment/' + shopId + '?cf=1' },
          order_note: 'Echel setup fee'
        });

        const cfOrder = await cashfreeRequest('POST', '/pg/orders',
          wrow.cashfree_app_id, wrow.cashfree_secret_key, cfBody);

        if (!cfOrder || !cfOrder.payment_session_id) {
          console.error('[Cashfree] setup order FAILED shop=' + shopId
            + ' resp=' + JSON.stringify(cfOrder).slice(0, 400));
          return res.status(400).json({
            error: 'Partner ke Cashfree se order nahi bana — unse keys check karne ko kaho',
            details: (cfOrder && (cfOrder.message || cfOrder.type || cfOrder.code)) || 'unknown'
          });
        }

        await pool.query('UPDATE shops SET setup_order_id=$1 WHERE id=$2', [cfOrderId, shopId]);
        console.log('[Cashfree] setup order OK shop=' + shopId + ' order=' + cfOrderId);
        return res.json({
          success: true,
          gateway: 'cashfree',
          paymentSessionId: cfOrder.payment_session_id,
          orderId: cfOrderId,
          amount: cfAmount,                      // rupees (Razorpay wala paise me hai)
          shopId
        });
      }

      payKeyId = wrow.razorpay_key_id;
      payKeySecret = wrow.razorpay_key_secret;
    }

    if (!payKeyId || !payKeySecret) {
      console.error('Setup fee create error: Razorpay keys missing');
      return res.status(500).json({ error: 'Payment gateway configure nahi hai.' });
    }

    const amount = shopResult.rows[0].setup_amount || SETUP_FEE_AMOUNT;
    const amountInPaise = amount * 100;

    const orderData = JSON.stringify({
      amount: amountInPaise,
      currency: 'INR',
      receipt: 'SETUP_' + shopId,
      notes: { shopId, type: 'setup_fee' }
    });

    const authHeader = 'Basic ' + Buffer.from(`${payKeyId}:${payKeySecret}`).toString('base64');

    const razorpayOrder = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.razorpay.com',
        path: '/v1/orders',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'Content-Length': Buffer.byteLength(orderData)
        }
      };
      const r = https.request(options, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      });
      r.on('error', reject);
      r.write(orderData);
      r.end();
    });

    if (!razorpayOrder.id) {
      // Razorpay ka asli reason (galat key, amount, etc.) yahi aata hai —
      // isko log bhi karo aur frontend ko bhejo taaki debug ho sake.
      const rzpReason = razorpayOrder && razorpayOrder.error && razorpayOrder.error.description
        ? razorpayOrder.error.description
        : 'Razorpay ne order reject kiya';
      console.error('Setup fee create error — Razorpay:', JSON.stringify(razorpayOrder));
      return res.status(400).json({ error: 'Setup fee order create nahi hua: ' + rzpReason, details: razorpayOrder });
    }

    await pool.query('UPDATE shops SET setup_order_id=$1 WHERE id=$2', [razorpayOrder.id, shopId]);

    res.json({
      success: true,
      gateway: 'razorpay',        // page isse dekh kar tay karta hai kaun sa checkout kholna hai
      orderId: razorpayOrder.id,
      amount: amountInPaise,
      keyId: payKeyId,
      shopId
    });
  } catch(err) {
    console.error('Setup fee create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── Cashfree se wapas aayi shop ka setup confirm ──
//
// Razorpay me browser signature laata hai, isliye wahan /verify chalta
// hai. Cashfree me aisa kuch wapas nahi aata — isliye hum KHUD Cashfree
// se poochhte hain ki order paid hua ya nahi. Yahi tareeka customer ke
// print payment me pehle se chal raha hai.
//
// Ye route bina login ke hai (jaise customer wala status), par isse koi
// shop muft me activate nahi kar sakta: paid tabhi maanta hai jab
// Cashfree khud PAID kahe, aur wo bhi PARTNER ki apni keys se poochh kar.
app.get('/api/setup-fee/cashfree-status/:shopId', async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const r = await pool.query(
      'SELECT id, setup_paid, qr_code, setup_order_id, whitelabel_id FROM shops WHERE id=$1',
      [shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    const shop = r.rows[0];

    // Pehle hi ho chuka (dobara load, ya do tab khule the)
    if (shop.setup_paid) {
      return res.json({ success: true, status: 'PAID', qrCode: shop.qr_code || '' });
    }
    if (!shop.whitelabel_id || !shop.setup_order_id) {
      return res.json({ success: true, status: 'PENDING' });
    }

    const w = await pool.query(
      'SELECT cashfree_app_id, cashfree_secret_key FROM whitelabels WHERE id=$1',
      [shop.whitelabel_id]);
    const wl = w.rows[0];
    if (!wl || !wl.cashfree_app_id || !wl.cashfree_secret_key) {
      return res.json({ success: true, status: 'PENDING' });
    }

    const order = await cashfreeRequest(
      'GET', '/pg/orders/' + encodeURIComponent(shop.setup_order_id),
      wl.cashfree_app_id, wl.cashfree_secret_key, null);
    const status = (order && order.order_status) || 'PENDING';
    if (status !== 'PAID') return res.json({ success: true, status });

    // activateShop khud race-safe hai (AND setup_paid=false), isliye do
    // poll ek saath aa jayein to bhi shop do baar activate nahi hoti.
    const { qrCode } = await activateShop(shopId, shop.setup_order_id);
    console.log('[Cashfree] setup PAID (partner) shop=' + shopId + ' order=' + shop.setup_order_id);
    res.json({ success: true, status: 'PAID', qrCode });
  } catch (err) {
    console.error('Cashfree setup status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Shop activation (setup fee confirm hone par) — verify handler,
//    webhook aur reconciliation teeno yahi use karte hain ──
// Kis raaste se aaya customer kaun se plan dekhega.
//   direct  — teeno (Starter, Pro, Premium)
//   agent   — sirf Pro aur Premium. Agent ko commission milta hai,
//             isliye sabse sasta Starter uske link par nahi dikhta.
//   wl      — sirf Starter. Partner apne naam par basic product
//             bechta hai; Demo alag se homepage par hota hai.
const PLANS_BY_CHANNEL = {
  direct: ['starter', 'pro', 'premium'],
  agent:  ['pro', 'premium'],
  wl:     ['starter']
};

/** channel ke hisaab se sirf allowed plan chhod kar baaki hata do. */
function filterPlansForChannel(plans, channel) {
  const allow = PLANS_BY_CHANNEL[channel] || PLANS_BY_CHANNEL.direct;
  const out = {};
  allow.forEach(k => { if (plans[k]) out[k] = plans[k]; });
  return out;
}

// ══════════════════════════════════════════════════════════════
//  PLANS — Starter / Pro / Premium (teeno LIFETIME)
//
//  Purane plan ('monthly', 'onetime') DB me jaise hain waise hi rehte
//  hain — unko haath nahi lagaya. Naye registration sirf in teen me se
//  ek chunte hain.
//
//    Starter — software + basic Echel. Advance alag se (₹199).
//    Pro     — advance aaj hi unlock. Aage naya feature aaye to alag.
//    Premium — advance + aane wale SAARE advance feature free.
//
//  Price ke liye NAYE keys banaye hain. Purane keys (setup_fee_amount,
//  monthly_fee) chhede nahi — un par agent, white-label aur purani
//  shops ka hisaab tika hua hai.
// ══════════════════════════════════════════════════════════════
const PLAN_DEFS = {
  starter: { feeKey: 'plan_starter_fee', actualKey: 'plan_starter_actual',
             defFee: 599, defActual: 2999, advance: false },
  pro:     { feeKey: 'plan_pro_fee',     actualKey: 'plan_pro_actual',
             defFee: 899, defActual: 2999, advance: true  },
  premium: { feeKey: 'plan_premium_fee', actualKey: 'plan_premium_actual',
             defFee: 999, defActual: 2999, advance: true  }
};

/** Body se aaya plan saaf karo. Purana naam aaye to sabse kareeb wala. */
function normalizePlan(p) {
  const v = String(p || '').toLowerCase().trim();
  if (PLAN_DEFS[v]) return v;
  // Purana cached page ya purana link. 'onetime'/'monthly' dono me
  // advance shaamil NAHI tha — isliye Starter hi sahi mapping hai.
  return 'starter';
}

/** Pro aur Premium me advance payment ke saath hi unlock ho jaata hai. */
function planIncludesAdvance(plan) {
  return !!(PLAN_DEFS[normalizePlan(plan)] || {}).advance;
}

/** Teeno plan ka price + strikethrough, ek hi query me. */
async function getPlanPricing() {
  const keys = [];
  Object.entries(PLAN_DEFS).forEach(([name,d]) => keys.push(d.feeKey, d.actualKey, 'plan_'+name+'_cycle'));
  const map = {};
  try {
    const r = await pool.query(
      `SELECT key, value FROM system_settings WHERE key = ANY($1)`, [keys]);
    r.rows.forEach(row => { map[row.key] = parseInt(row.value); });
  } catch (e) { /* default par gir jao */ }

  const out = {};
  for (const [name, d] of Object.entries(PLAN_DEFS)) {
    const fee = (!isNaN(map[d.feeKey]) && map[d.feeKey] > 0) ? map[d.feeKey] : d.defFee;
    // actual 0 = strikethrough chhupa do
    const actualRaw = map[d.actualKey];
    const actual = (!isNaN(actualRaw)) ? Math.max(0, actualRaw) : d.defActual;
    out[name] = { fee, actual: actual > fee ? actual : 0, advance: d.advance, billingCycle: billingCycle({billing_cycle:map['plan_'+name+'_cycle']}) };
  }
  return out;
}

async function getAdvancedFee() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='advanced_fee'");
    return Math.max(1, parseInt(r.rows[0]?.value) || 199);
  } catch(e) { return 199; }
}

async function getMonthlyFee() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='monthly_fee'");
    return Math.max(1, parseInt(r.rows[0]?.value) || 99);
  } catch(e) { return 99; }
}

async function getMonthlyActualFee() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='monthly_actual_price'");
    return Math.max(0, parseInt(r.rows[0]?.value) || 0);
  } catch(e) { return 0; }
}

async function getAdvancedActualFee() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='advanced_actual_price'");
    return Math.max(0, parseInt(r.rows[0]?.value) || 0);
  } catch(e) { return 0; }
}

// Agent Base Price — agent ke liye alag floor. 0/unset ho to public Offer
// Price hi floor rehta hai (purana behaviour, kuch nahi tootega). Superadmin
// jab explicitly ise set karega tabhi agent ka price homepage ke price se
// alag dikhna shuru hoga.
async function getAgentBasePrice() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='agent_base_price'");
    const v = parseInt(r.rows[0]?.value) || 0;
    if (v > 0) return v;
  } catch(e) {}
  // Set na ho to Pro ka apna price — agent ka sabse sasta plan wahi hai.
  return (await getPlanPricing()).pro.fee;
}

// Shop ka subscription zinda hai? onetime = hamesha; monthly = paid_until check
function isSubscriptionActive(shop) {
  return subscriptionActive(shop);
}

// Monthly renewal — RACE-SAFE: renewal_order_id match + clear ek hi atomic
// UPDATE me (webhook + verify + reconcile teeno fire ho sakte hain — sirf
// pehla jeeta, baaki no-op, double +30din kabhi nahi)
async function extendShop(shopId, orderId, paymentId) {
  const r = await pool.query(
    `UPDATE shops SET
       paid_until = GREATEST(NOW(), COALESCE(paid_until, NOW())) + make_interval(months=>CASE WHEN renewal_months>0 THEN renewal_months ELSE (${MONTHS_SQL}) END),
       renewal_order_id = ''
     WHERE id=$1 AND renewal_order_id=$2 AND (${MONTHS_SQL})>0
     RETURNING paid_until,renewal_amount,plan_type,billing_cycle`,
    [shopId, orderId]);
  if (r.rows.length) {
    console.log(`Subscription renewed: ${shopId} | till ${r.rows[0].paid_until} | pay ${paymentId}`);
    // Renewal bhi ledger me — pehle iska bhi koi record nahi banta tha
    try {
      await recordPayment({
        kind: 'renewal', shopId,
        amount: r.rows[0].renewal_amount || await getMonthlyFee(),
        paymentId, orderId, note: billingCycle(r.rows[0])+' subscription renewal'
      });
    } catch (e) { console.error('renewal ledger error:', e.message); }
    return r.rows[0].paid_until;
  }
  return null; // koi aur pehle process kar chuka
}

// ── PAYMENT LEDGER ──
// Har platform payment (setup / advanced / renewal / whitelabel license)
// yahin se record hoti hai. ON CONFLICT DO NOTHING ki wajah se webhook aur
// verify dono aa jayen to bhi ek hi row banti hai — kabhi double count nahi.
// Ye function kabhi throw nahi karta: ledger fail hone se payment ka asli
// kaam (shop activate hona) nahi rukna chahiye.
async function recordPayment({ kind, shopId = '', shopName = '', whitelabelId = '',
                               amount = 0, paymentId = '', orderId = '',
                               gateway = 'razorpay', note = '' }) {
  try {
    if (!shopName && shopId) {
      const s = await pool.query('SELECT name FROM shops WHERE id=$1', [shopId]);
      shopName = s.rows[0]?.name || '';
    }
    const r = await pool.query(
      `INSERT INTO platform_payments
         (kind, shop_id, shop_name, whitelabel_id, amount, payment_id, order_id, gateway, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING RETURNING id`,
      [kind, shopId, shopName, whitelabelId, Math.max(0, parseInt(amount) || 0),
       paymentId || '', orderId || '', gateway, note]);
    if (r.rows.length) console.log(`Payment recorded: ${kind} ₹${amount} ${shopId} ${paymentId}`);
    return r.rows.length > 0;
  } catch (e) {
    console.error('recordPayment error:', e.message);
    return false;
  }
}

async function activateShop(shopId, paymentId) {
  const qrUrl = `${BASE_URL}/print/${shopId}`;
  const qrCode = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 });

  // RACE-SAFE: webhook, verify aur reconcile — teeno ek saath aa sakte hain.
  // `AND setup_paid=false` ki wajah se sirf PEHLA jeetega, baaki no-op.
  // Isi se alert aur shop ko email DO BAAR kabhi nahi jaayenge.
  const upd = await pool.query(
    `UPDATE shops SET setup_paid=true, setup_payment_id=$1, qr_code=$2,
       paid_until=CASE WHEN (${MONTHS_SQL})>0 THEN NOW()+make_interval(months=>(${MONTHS_SQL})) ELSE NULL END
     WHERE id=$3 AND setup_paid=false RETURNING id`,
    [paymentId, qrCode, shopId]
  );
  const firstTime = upd.rows.length > 0;

  if (firstTime) {
    // Pro aur Premium me Advance Feature payment ke saath hi khul jaata
    // hai — shop owner ko alag se ₹199 nahi dena padta.
    // Pro aur Premium me core Advance pack payment ke saath hi khul
    // jaata hai. Premium ko owned_features me daalne ki zaroorat nahi
    // (uska hisaab plan se nikalta hai) par daal dene se koi nuksan
    // bhi nahi — aage plan badle to record bacha rehta hai.
    {
      const planRow = await pool.query('SELECT plan_type FROM shops WHERE id=$1', [shopId]);
      const pt = planRow.rows[0]?.plan_type;
      if (pt === 'pro' || pt === 'premium') {
        const catalog = await getAdvanceFeatures();
        await grantFeatures(shopId, coreFeatureIds(catalog));
      }
    }
    console.log(`Setup fee paid: ${shopId} | Payment: ${paymentId}`);

    // Ledger me record karo — superadmin ko yahi dikhta hai.
    // White-label ki shop ka paisa reseller ke account me jaata hai,
    // hamare paas nahi — isliye wo alag mark hota hai aur hamare
    // revenue total me nahi ginta.
    try {
      const pinfo = await pool.query(
        'SELECT name, setup_amount, whitelabel_id, setup_order_id FROM shops WHERE id=$1', [shopId]);
      const p = pinfo.rows[0] || {};
      await recordPayment({
        kind: 'setup',
        shopId, shopName: p.name || '',
        whitelabelId: p.whitelabel_id || '',
        amount: p.setup_amount || 0,
        paymentId, orderId: p.setup_order_id || '',
        note: p.whitelabel_id ? 'white-label shop (paisa reseller ko)' : ''
      });
    } catch (e) { console.error('setup ledger error:', e.message); }

    // Aapko alert (fail ho to bhi activation nahi rukega)
    alertNewShop(shopId, 'paid');
    // Shop owner ko payment confirmation email
    sendShopPaymentEmail(shopId);
  } else {
    console.log(`Setup fee: ${shopId} pehle se paid hai — dobara alert/mail nahi bheja`);
  }

  // ── AGENT COMMISSION ── kya ye shop kisi agent ne onboard ki thi?
  // NAYA NIYAM: har paid shop par FLAT ₹100. Koi markup nahi (agent apna
  // price nahi badal sakta), koi 10-shop bonus nahi. Isliye markup/bonus
  // columns hamesha 0 jaate hain — purani rows ka hisab waise ka waisa
  // rehta hai, sirf aage se flat rate lagta hai.
  try {
    const ob = await pool.query(
      `SELECT name, onboarded_by, agent_credited, setup_amount
       FROM shops WHERE id=$1`, [shopId]);
    const s = ob.rows[0];
    if (s && s.onboarded_by && !s.agent_credited) {
      const ag = await pool.query(
        'SELECT id, is_agent, agent_blocked FROM shops WHERE id=$1', [s.onboarded_by]);
      if (ag.rows.length && ag.rows[0].is_agent && !ag.rows[0].agent_blocked) {
        const sold  = s.setup_amount || 0;
        const total = AGENT_COMMISSION;   // flat ₹100

        await pool.query(
          `INSERT INTO agent_commissions
             (agent_id, shop_id, shop_name, base_price, sold_price, markup, commission, bonus, total)
           VALUES ($1,$2,$3,$4,$5,0,$6,0,$7)`,
          [s.onboarded_by, shopId, s.name || '', sold, sold, AGENT_COMMISSION, total]);
        await pool.query(
          'UPDATE shops SET agent_earnings = COALESCE(agent_earnings,0) + $2 WHERE id=$1',
          [s.onboarded_by, total]);
        console.log(`Agent commission: flat ₹${total} -> ${s.onboarded_by} for ${shopId}`);
      }
      await pool.query('UPDATE shops SET agent_credited=true WHERE id=$1', [shopId]);
    }
  } catch(e) { console.error('Agent commission error:', e.message); }

  // ── REFER & EARN HATA DIYA GAYA ──
  // Pehle yahan referrer ko ₹50 milta tha. Ab sirf Agent program hai
  // (flat ₹100). referred_by / referral_earnings columns DB me rehte hain
  // taaki purana data na tootey, par naya reward kabhi nahi banta.
  try {
    await pool.query('UPDATE shops SET referral_rewarded=true WHERE id=$1', [shopId]);
  } catch(e) { console.error('referral flag error:', e.message); }

  return { qrCode, qrUrl };
}

app.post('/api/setup-fee/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, shopId } = req.body;

    // Signature usi SECRET se verify hoga jisse order bana tha —
    // white-label ki shop ka order reseller ke keys se banta hai.
    let vSecret = OWNER_RAZORPAY_KEY_SECRET;
    const wlq = await pool.query('SELECT whitelabel_id FROM shops WHERE id=$1', [shopId]);
    const wlIdV = wlq.rows[0]?.whitelabel_id || '';
    if (wlIdV) {
      const w = await pool.query('SELECT razorpay_key_secret FROM whitelabels WHERE id=$1', [wlIdV]);
      if (w.rows[0]?.razorpay_key_secret) vSecret = w.rows[0].razorpay_key_secret;
    }

    const expectedSignature = crypto
      .createHmac('sha256', vSecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    // Payment confirm — ab shop activate karo aur QR generate karo
    const shopResult = await pool.query('SELECT id FROM shops WHERE id=$1 AND setup_order_id=$2', [shopId, razorpay_order_id]);
    if (!shopResult.rows.length) return res.status(404).json({ error: 'Shop ya order match nahi hua' });

    const { qrCode, qrUrl } = await activateShop(shopId, razorpay_payment_id);
    res.json({ success: true, shopId, qrCode, qrUrl });
  } catch(err) {
    console.error('Setup fee verify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ADVANCED PRINTING UNLOCK — ₹199 one-time ───
app.post('/api/admin/advanced/create-order', verifyToken, async (req, res) => {
  try {
    if (!OWNER_RAZORPAY_KEY_ID || !OWNER_RAZORPAY_KEY_SECRET)
      return res.status(500).json({ error: 'Owner Razorpay configured nahi' });
    const sh = await pool.query('SELECT advanced_unlocked FROM shops WHERE id=$1', [req.shopId]);
    if (!sh.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    if (sh.rows[0].advanced_unlocked) return res.status(400).json({ error: 'Advanced already unlocked hai' });

    const fee = await getAdvancedFee();
    const orderData = JSON.stringify({
      amount: fee * 100, currency: 'INR',
      receipt: 'adv_' + req.shopId.slice(-8) + '_' + Date.now().toString().slice(-6),
      notes: { shopId: req.shopId, kind: 'advanced_unlock' }
    });
    const auth = Buffer.from(`${OWNER_RAZORPAY_KEY_ID}:${OWNER_RAZORPAY_KEY_SECRET}`).toString('base64');
    const order = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'api.razorpay.com', path: '/v1/orders', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth,
                   'Content-Length': Buffer.byteLength(orderData) }
      }, (resp) => { let d=''; resp.on('data',c=>d+=c); resp.on('end',()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}}); });
      r.on('error', reject); r.write(orderData); r.end();
    });
    if (!order.id) return res.status(400).json({ error: 'Order create nahi hua' });
    await pool.query('UPDATE shops SET advanced_order_id=$1 WHERE id=$2', [order.id, req.shopId]);
    res.json({ success: true, orderId: order.id, amount: fee * 100, keyId: OWNER_RAZORPAY_KEY_ID, fee });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/advanced/verify', verifyToken, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const expected = crypto.createHmac('sha256', OWNER_RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
    if (expected !== razorpay_signature) return res.status(400).json({ error: 'Verification failed' });
    // Atomic: order match + unlock ek saath (double-fire safe)
    const r = await pool.query(
      "UPDATE shops SET advanced_unlocked=true, advanced_order_id='' WHERE id=$1 AND advanced_order_id=$2 RETURNING id",
      [req.shopId, razorpay_order_id]);
    // Legacy flag ke saath core pack bhi de do — ab asli sach
    // owned_features me hai. Iske bina Pro/Premium ka farak lagu
    // nahi hota aur naye feature ki ownership pata nahi chalti.
    {
      const catalog = await getAdvanceFeatures();
      await grantFeatures(req.shopId, coreFeatureIds(catalog));
    }
    if (r.rows.length) {
      console.log('Advanced unlocked:', req.shopId, razorpay_payment_id);
      // PEHLE ye paisa kahin record hi nahi hota tha — sirf console.log.
      // Isliye superadmin me ₹199 wale unlock kabhi dikhte hi nahi the.
      await recordPayment({
        kind: 'advanced', shopId: req.shopId,
        amount: await getAdvancedFee(),
        paymentId: razorpay_payment_id, orderId: razorpay_order_id,
        note: 'Advanced printing unlock'
      });
    }
    res.json({ success: true, unlocked: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── MONTHLY RENEWAL — ₹99 owner ke Razorpay se Rupesh ko ───
app.post('/api/admin/renew/create-order', verifyToken, async (req, res) => {
  try {
    if (!OWNER_RAZORPAY_KEY_ID || !OWNER_RAZORPAY_KEY_SECRET)
      return res.status(500).json({ error: 'Owner Razorpay configured nahi' });
    const sh = await pool.query('SELECT id, plan_type, billing_cycle, setup_amount FROM shops WHERE id=$1', [req.shopId]);
    if (!sh.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    const cycle=billingCycle(sh.rows[0]);
    if (cycle === 'lifetime') return res.status(400).json({error:'Lifetime plans do not require renewal'});
    const months=CYCLES[cycle];
    const fee=sh.rows[0].plan_type==='monthly' ? await getMonthlyFee() : Number(sh.rows[0].setup_amount);
    if(!Number.isSafeInteger(fee)||fee<1)return res.status(409).json({error:'Renewal price is not configured. Contact support.'});
    const amountInPaise = fee * 100;
    const orderData = JSON.stringify({
      amount: amountInPaise, currency: 'INR',
      receipt: 'renew_' + req.shopId.slice(-8) + '_' + Date.now().toString().slice(-6),
      notes: { shopId: req.shopId, kind: 'renewal' }
    });
    const auth = Buffer.from(`${OWNER_RAZORPAY_KEY_ID}:${OWNER_RAZORPAY_KEY_SECRET}`).toString('base64');
    const razorpayOrder = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'api.razorpay.com', path: '/v1/orders', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth,
                   'Content-Length': Buffer.byteLength(orderData) }
      }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      });
      r.on('error', reject);
      r.write(orderData);
      r.end();
    });
    if (!razorpayOrder.id) return res.status(400).json({ error: 'Renewal order create nahi hua' });

    await pool.query('UPDATE shops SET renewal_order_id=$1,renewal_amount=$3,renewal_months=$4 WHERE id=$2', [razorpayOrder.id, req.shopId, fee, months]);
    res.json({ success: true, orderId: razorpayOrder.id, amount: amountInPaise, keyId: OWNER_RAZORPAY_KEY_ID, fee, billingCycle:cycle });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/renew/verify', verifyToken, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const expected = crypto.createHmac('sha256', OWNER_RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
    if (expected !== razorpay_signature)
      return res.status(400).json({ error: 'Payment verification failed' });
    const till = await extendShop(req.shopId, razorpay_order_id, razorpay_payment_id);
    res.json({ success: true, paid_until: till });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/login', loginLimiter, async (req, res) => {
  try {
    // Captcha — band ho to ye line chup-chaap nikal jaati hai
    if (!(await captchaGuard(req, res))) return;
    const { shopId, password } = req.body;
    if (!shopId || !password) return res.status(400).json({ error: 'Shop ID aur Password dono chahiye' });

    const r = await pool.query('SELECT * FROM shops WHERE id=$1', [shopId.trim().toUpperCase()]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop ID nahi mila' });

    const shop = r.rows[0];


    if (!shop.password_hash) {
      return res.status(401).json({ error: 'Is shop ka password set nahi hai. Pehle Set Password karo.' });
    }
    if (!(await verifyPassword(password, shop.password_hash))) {
      return res.status(401).json({ error: 'Password galat hai' });
    }

    clearLoginHits(req);
    // Purana sha256 hash hai to abhi scrypt me badal do — user ko pata nahi chalega
    await upgradeHashIfLegacy('shops', 'id', shop.id, shop.password_hash, password);

    const token = jwt.sign({ shopId: shop.id }, JWT_SECRET, { expiresIn: '24h' });
    delete shop.password_hash;
    res.json({ success: true, token, shop });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Set/claim password — ab REGISTERED MOBILE verify hota hai ──
// Pehle koi bhi kisi legacy Shop ID (jo QR URL me public hai) ka password
// set karke shop hijack kar sakta tha. Ab: shop ka registered number do,
// match hua tabhi. Phone public API se hata diya gaya hai (neeche), to
// attacker use remotely nahi jaan sakta. + IP rate-limit (brute force).
const _spAttempts = new Map();
// Shop-wise reset attempts (IP rotate karke targeted attack na ho)
const _spShopAttempts = new Map();
// Dono map ko har ghante saaf karo — warna memory dheere-dheere badhti rahegi
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of _spAttempts)     if (t > v.reset) _spAttempts.delete(k);
  for (const [k, v] of _spShopAttempts) if (t > v.reset) _spShopAttempts.delete(k);
}, 3600e3).unref();  // ip -> {count, reset}
app.post('/api/shop/set-password', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    const rec = _spAttempts.get(ip) || { count: 0, reset: now + 3600e3 };
    if (now > rec.reset) { rec.count = 0; rec.reset = now + 3600e3; }
    if (rec.count >= 5) return res.status(429).json({ error: 'Bahut zyada koshish — 1 ghante baad try karo' });
    rec.count++; _spAttempts.set(ip, rec);

    const { shopId, phone, newPassword } = req.body;

    // Sirf IP-limit kaafi nahi tha: attacker IP badal-badal kar ek hi shop par
    // baar-baar koshish kar sakta tha. Isliye SHOP-wise limit bhi — chahe
    // kitne bhi IP se aaye, ek shop par 1 ghante me 5 se zyada nahi.
    if (shopId) {
      const sKey = String(shopId).trim().toUpperCase();
      const sRec = _spShopAttempts.get(sKey) || { count: 0, reset: now + 3600e3 };
      if (now > sRec.reset) { sRec.count = 0; sRec.reset = now + 3600e3; }
      if (sRec.count >= 5) {
        return res.status(429).json({ error: 'Is shop par bahut zyada koshish — 1 ghante baad try karo' });
      }
      sRec.count++; _spShopAttempts.set(sKey, sRec);
    }
    if (!shopId || !phone || !newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'Shop ID, registered mobile aur 4+ character password — teeno chahiye' });
    }
    const r = await pool.query('SELECT id, phone, password_hash FROM shops WHERE id=$1', [shopId.trim().toUpperCase()]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop ID nahi mila' });
    // Password set HO YA NA HO — registered phone match = reset allowed.
    // (Pehle set-hone par admin-contact bolta tha; ab self-serve reset.
    //  Security wahi: phone public API se hata hua hai + IP rate-limit.)
    if (normPhone(phone) !== normPhone(r.rows[0].phone)) {
      return res.status(403).json({ error: 'Mobile number match nahi hua — wahi number daalo jo registration me diya tha' });
    }
    const passwordHash = await hashPassword(newPassword);
    await pool.query('UPDATE shops SET password_hash=$1 WHERE id=$2', [passwordHash, shopId.trim().toUpperCase()]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Demo status — agent 30 min me ek baar poochta hai (halka payload)
app.get('/api/shop/:shopId/demo-status', async (req, res) => {
  try {
    // secondsLeft SERVER se bhejte hain (SQL me gina hua). Client ko date
    // parse karni hi nahi padti, isliye uske PC/phone ka timezone galat ho
    // to bhi countdown sahi rehta hai.
    const r = await pool.query(
      `SELECT demo, demo_expires_at,
              GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (demo_expires_at - NOW()))))::bigint AS secs_left
         FROM shops WHERE id=$1`, [req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    const s = r.rows[0];
    const secsLeft = s.secs_left == null ? null : parseInt(s.secs_left, 10);
    const expired = !!(s.demo && s.demo_expires_at && secsLeft !== null && secsLeft <= 0);
    const out = { demo: !!s.demo, demo_expires_at: s.demo_expires_at, expired, secondsLeft: secsLeft };
    if (s.demo) {
      const a = await checkDemoAllowance(req.params.shopId);
      out.printsUsed = a.used;
      out.printLimit = a.limit;
      out.printsLeft = a.ok ? a.remaining : 0;
      out.limitReached = !a.ok && a.reason === 'limit';
      if (!a.ok) { out.upgradeMessage = a.error; out.plans = await getUpgradePlans(); }
    }
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/:shopId', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id,name,address,printer_model,price_bw,price_color,price_bw_duplex,price_color_duplex,payment_mode,payment_gateway,razorpay_key_id,qr_code,setup_paid,paused,supply_warning,demo,demo_expires_at,duplex_mode,duplex_bw_enabled,duplex_color_enabled,plan_type,billing_cycle,paid_until,advanced_unlocked,price_4x6_4,price_4x6_6,price_4x6_8,price_4x6_10,price_4x6_12,price_resume_color,price_resume_bw,price_a3_bw,price_a3_color,price_a2_bw,price_a2_color,price_a1_bw,price_a1_color,shop_notice,advanced_active,shop_logo,adv_legal_active,adv_resume_active,adv_4x6_active,adv_a3_active,adv_mini_active,adv_scan_active,page_slabs,plan_type,owned_features,default_lang FROM shops WHERE id=$1',
      [req.params.shopId]
    );
    if (!r.rows.length) return res.status(404).json({ error:'Shop not found' });
    if (!r.rows[0].setup_paid) {
      return res.status(403).json({ error: 'Shop ka setup abhi incomplete hai. Shop owner ko setup fee complete karna hoga.' });
    }
    const shopInfo = r.rows[0];
    // Customer ke liye advance tabhi ON jab kharida (unlocked) AUR owner ne active rakha
    const advOn = !!(shopInfo.advanced_unlocked && shopInfo.advanced_active !== false);
    shopInfo.advanced_unlocked = advOn;
    // Har module ka effective status = advance ON aur us module ka switch ON.
    // Customer page inhi 4 flags se apna layout banata hai.
    shopInfo.adv_mini_active   = advOn && shopInfo.adv_mini_active   !== false;
    shopInfo.adv_legal_active  = advOn && shopInfo.adv_legal_active  !== false;
    shopInfo.adv_resume_active = advOn && shopInfo.adv_resume_active !== false;
    shopInfo.adv_4x6_active    = advOn && shopInfo.adv_4x6_active    !== false;
    shopInfo.adv_a3_active     = advOn && shopInfo.adv_a3_active     !== false;

    // ── Smart Scanner ──
    // Baaki 5 module `advanced_unlocked` + apne switch se chalte hain,
    // par Scanner ADD-ON hai — uska sach `owned_features` me hai.
    // Isliye yahan ownedFeatureIds() se poochhna zaroori hai:
    //   • Premium        → poora catalog, list dekhi hi nahi jaati
    //   • Purani ₹199 shop → sirf core pack, scan usme nahi → OFF
    //   • ₹49 diya / superadmin ne diya → owned_features me 'scan' → ON
    // advanced_active OFF ho to sab kuch OFF — wahi purana niyam.
    try {
      const _cat = await getAdvanceFeatures();
      // Do alag sawaal, dono ka jawab haan hona chahiye:
      //   1. shop ke paas hai kya?  (kharida ya Premium ya superadmin ne diya)
      //   2. owner ne on rakha hai kya?  (baaki 5 module jaisa switch)
      shopInfo.adv_scan_active = advOn
        && shopOwnsFeature(shopInfo, 'scan', _cat)
        && shopInfo.adv_scan_active !== false;
    } catch (e) {
      // Catalog na mile to feature band — khula chhodne se un shops ko
      // free mil jaata jinhone paisa nahi diya.
      shopInfo.adv_scan_active = false;
    }
    // Kaun sa feature hai ye customer ka kaam nahi — flag bhej diya, list nahi
    delete shopInfo.owned_features;

    // White-label ki shop hai to customer page par PARTNER ka brand dikhega
    try {
      const wq = await pool.query('SELECT whitelabel_id FROM shops WHERE id=$1', [req.params.shopId]);
      const wlId = wq.rows[0]?.whitelabel_id || '';
      if (wlId) {
        const w = await pool.query(
          'SELECT brand_name, powered_by, support_email, support_phone, blocked FROM whitelabels WHERE id=$1', [wlId]);
        if (w.rows.length && !w.rows[0].blocked) {
          shopInfo.powered_by = w.rows[0].powered_by || w.rows[0].brand_name || '';
          shopInfo.wl_brand = w.rows[0].brand_name || '';
          shopInfo.wl_support_email = w.rows[0].support_email || '';
          shopInfo.wl_support_phone = w.rows[0].support_phone || '';
        }
      }
    } catch(e) { /* branding fail ho to default hi rahega */ }
    shopInfo.subscription_expired = !isSubscriptionActive(shopInfo);
    delete shopInfo.paid_until; // customer ko exact date nahi dikhani
    res.json(shopInfo);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Customer: print ke baad thumbs up/down (public, ek baar)
app.post('/api/jobs/:jobId/feedback', async (req, res) => {
  try {
    const v = req.body.up === true ? 1 : req.body.up === false ? -1 : 0;
    if (!v) return res.status(400).json({ error: 'up boolean chahiye' });
    // Sirf printed job, aur sirf jab feedback abhi 0 hai (ek baar)
    const r = await pool.query(
      "UPDATE print_jobs SET feedback=$1 WHERE id=$2 AND status='printed' AND feedback=0 RETURNING id",
      [v, req.params.jobId]);
    res.json({ success: true, recorded: r.rows.length > 0 });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ⚠️ SECURITY: ye endpoint pehle BINA LOGIN ke khula tha.
// Shop ID QR poster par chhapa hota hai, isliye koi bhi kisi bhi shop ki
// total earnings, aaj ki kamai aur order count dekh sakta tha — competitor
// roz dukaan ki kamai track kar sakta tha.
// Ab login zaroori hai AUR sirf apni hi shop ka data milta hai.
app.get('/api/shop/:shopId/stats', verifyToken, async (req, res) => {
  try {
    // Doosri shop ka ID daal kar uska data nahi le sakte (IDOR guard).
    // Token me jo shop hai, sirf usi ka hisaab milega.
    if (req.params.shopId !== req.shopId) {
      return res.status(403).json({ error: 'Ye shop aapki nahi hai' });
    }
    const today = new Date().toISOString().split('T')[0];
    // prev_* = kal ke number. Dashboard inse "+40% vs yesterday" dikhata hai.
    const r = await pool.query(`
      SELECT COUNT(*) as total_orders,
        COALESCE(SUM(amount),0) as total_earnings,
        COUNT(CASE WHEN DATE(created_at)=$1 THEN 1 END) as today_orders,
        COALESCE(SUM(CASE WHEN DATE(created_at)=$1 THEN amount ELSE 0 END),0) as today_earnings,
        COALESCE(SUM(CASE WHEN DATE(created_at)=$1 THEN copies ELSE 0 END),0) as today_prints,
        COALESCE(SUM(CASE WHEN DATE(created_at)=DATE($1)-1 THEN amount ELSE 0 END),0) as prev_earnings,
        COALESCE(SUM(CASE WHEN DATE(created_at)=DATE($1)-1 THEN copies ELSE 0 END),0) as prev_prints
      FROM print_jobs WHERE shop_id=$2 AND ${JOB_COUNTS}
    `, [today, req.params.shopId]);
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Shop owner apne customer ke liye default bhasha chunta hai.
// Khali string = "kuch nahi chuna" = customer ko English dikhega.
// isKnownLang() hasOwnProperty use karta hai, isliye 'constructor' jaise
// naam yahan se nikal nahi sakte.
// ── WhatsApp To Print — interest register ──
// Homepage ka form sirf 10-digit mobile number bhejta hai. Yahan use
// sambhal kar rakhte hain aur owner ko email kar dete hain.
//
// Ek IP se baar-baar spam na aaye, iske liye chhota sa memory cooldown.
// Server restart par khali ho jaata hai — chalega, ye koi security
// nahi, sirf galti se do baar dabane se bachne ke liye hai.
const _waInterestSeen = new Map();          // ip -> last time (ms)
const WA_INTEREST_GAP_MS = 30 * 1000;

app.post('/api/whatsapp-interest', async (req, res) => {
  try {
    const raw = String((req.body && req.body.phone) || '').replace(/\D/g, '');
    const phone = raw.length === 12 && raw.startsWith('91') ? raw.slice(2) : raw;
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number' });
    }

    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const now = Date.now();
    const last = _waInterestSeen.get(ip) || 0;
    if (ip && now - last < WA_INTEREST_GAP_MS) {
      return res.json({ success: true, already: true });   // chup-chaap OK
    }
    if (ip) _waInterestSeen.set(ip, now);
    if (_waInterestSeen.size > 5000) _waInterestSeen.clear();   // memory na bhare

    const r = await pool.query(
      `INSERT INTO whatsapp_interest (phone) VALUES ($1)
       ON CONFLICT (phone) DO UPDATE SET hits = whatsapp_interest.hits + 1, last_at = NOW()
       RETURNING hits`, [phone]);
    const hits = r.rows.length ? r.rows[0].hits : 1;

    // Email — wahi raasta jo demo/naya-shop alert use karta hai.
    // Bhejne me der ho to bhi user ko rukna nahi padta.
    (async () => {
      try {
        const c = await pool.query("SELECT value FROM system_settings WHERE key='notify_email'");
        const to = c.rows[0]?.value || '';
        if (!to) return;
        const total = await pool.query('SELECT COUNT(*)::int AS n FROM whatsapp_interest');
        await sendEmailAlert(
          to,
          '📱 WhatsApp To Print — new interest: ' + phone,
          'WHATSAPP TO PRINT — INTEREST REGISTERED\n\n' +
          'Mobile : ' + phone + '\n' +
          'Times  : ' + hits + (hits > 1 ? ' (isne pehle bhi register kiya tha)' : '') + '\n' +
          'Total registered so far: ' + (total.rows[0]?.n ?? '?') + '\n\n' +
          'Homepage ke "WhatsApp To Print" section se aaya hai.',
          'Echel'
        );
      } catch (e) {
        console.error('WhatsApp interest email fail:', e.message);
      }
    })();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/customer-language', verifyToken, async (req, res) => {
  try {
    const raw = String((req.body && req.body.default_lang) || '').trim();
    if (raw && !isKnownLang(raw)) {
      return res.status(400).json({ error: 'Ye bhasha available nahi hai' });
    }
    // 'hin' bhi theek hai — website ka asli text Hinglish hi hai.
    await pool.query('UPDATE shops SET default_lang=$1 WHERE id=$2', [raw, req.shopId]);
    res.json({ ok: true, default_lang: raw });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/profile', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      // demo_expires_at pehle yahan tha hi nahi — isliye panel ka demo
      // countdown hamesha khali rehta tha (shop.demo_expires_at undefined).
      `SELECT id,name,address,phone,demo,demo_expires_at,agent_machine,agent_bound_at,default_lang,
              (agent_token IS NOT NULL) AS agent_bound,
              GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (demo_expires_at - NOW()))))::bigint AS demo_seconds_left,
              plan_type,billing_cycle,paid_until,advanced_unlocked,advanced_active,
              adv_legal_active,adv_resume_active,adv_4x6_active,adv_a3_active,adv_mini_active,adv_scan_active,page_slabs,owned_features,shop_notice,shop_logo,price_4x6_4,price_4x6_6,price_4x6_8,price_4x6_10,price_4x6_12,price_resume_color,price_resume_bw,price_a3_bw,price_a3_color,price_a2_bw,price_a2_color,price_a1_bw,price_a1_color,printer_model,printer_name_bw,printer_name_color,printer_name_4x6,printer_name_a3,printer_name_duplex,duplex_bw_enabled,duplex_color_enabled,price_bw,price_color,price_bw_duplex,price_color_duplex,payment_mode,qr_code,created_at,paused,supply_warning,duplex_mode,
              email,payment_gateway,razorpay_key_id,cashfree_app_id,
              CASE WHEN razorpay_key_secret != '' THEN true ELSE false END as has_razorpay_secret,
              CASE WHEN cashfree_secret_key != '' THEN true ELSE false END as has_cashfree_secret
       FROM shops WHERE id=$1`, [req.shopId]
    );
    if (!r.rows.length) return res.status(404).json({ error:'Shop not found' });
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/settings', verifyToken, async (req, res) => {
  try {
    // Advanced-lock status SABSE PEHLE — duplex aur 4x6/A3 dono blocks
    // ise use karte hain (pehle neeche declare tha -> TDZ crash on save)
    const unlockChk = await pool.query('SELECT advanced_unlocked FROM shops WHERE id=$1', [req.shopId]);
    const advUnlocked = unlockChk.rows.length && unlockChk.rows[0].advanced_unlocked;

    // ── Advance-only setting BADALNE ki koshish? ──
    // Pehle in field ko neeche CHUPCHAAP chhod diya jaata tha. Owner save
    // dabata, panel reload hota, aur duplex/printer ki value gayab —
    // usse lagta tha "save hota hi nahi hai". Isliye saaf error dena zaroori
    // tha.
    //
    // ⚠️ Par "field aayi hai" par rokna GALAT tha. Panel har save par
    // POORA settings object bhejta hai — usme duplex aur extra printer ki
    // maujooda value bhi hoti hai, chahe owner ne unhe chhua bhi na ho.
    // duplex_bw_enabled to boolean hai aur DB me default `true` — yaani
    // har Starter shop hamesha bhejti hai. Nateeja: bina Advance wali shop
    // apna naam, daam, ya payment key tak save nahi kar paa rahi thi.
    //
    // Ab sirf wahi rokte hain jo SACH ME badal raha ho. Jo value pehle se
    // wahi hai wo bas gunj hai — usse kuch nahi bigadta.
    //
    // Jaanch UPDATE se PEHLE hai, jaan-boojh kar: warna naam/daam save ho
    // jaate aur jawab me error aata — owner ko samajh hi na aata ki kya
    // saved hai kya nahi.
    if (!advUnlocked) {
      const curAdv = await pool.query(
        `SELECT duplex_mode, printer_name_4x6, printer_name_a3, printer_name_duplex,
                duplex_bw_enabled, duplex_color_enabled
           FROM shops WHERE id=$1`, [req.shopId]);
      const cur0 = curAdv.rows[0] || {};
      const asText = function (v) { return String(v === null || v === undefined ? '' : v); };
      const asBool = function (v) { return v === true || v === 'true' || v === 1 || v === '1'; };
      const changed = [];
      ['duplex_mode', 'printer_name_4x6', 'printer_name_a3', 'printer_name_duplex']
        .forEach(function (k) {
          if (req.body[k] === undefined) return;
          if (asText(req.body[k]) !== asText(cur0[k])) changed.push(k);
        });
      ['duplex_bw_enabled', 'duplex_color_enabled'].forEach(function (k) {
        if (req.body[k] === undefined) return;
        if (asBool(req.body[k]) !== !!cur0[k]) changed.push(k);
      });
      if (changed.length) {
        console.log('Advance-only change blocked for shop ' + req.shopId + ': ' + changed.join(', '));
        return res.status(403).json({
          error: 'Duplex and extra printer settings need the Advance Feature. ' +
                 'Unlock Advance Feature first, then save these.'
        });
      }
    }

    const {
      name, address, phone, email, printer_model, printer_name_bw, printer_name_color, price_bw, price_color, payment_mode,
      payment_gateway, razorpay_key_id, razorpay_key_secret,
      cashfree_app_id: cashfreeAppIdRaw, cashfree_secret_key: cashfreeSecretRaw
    } = req.body;
    // Copy-paste (especially mobile) aksar leading/trailing space ya newline
    // chhod deta hai — Cashfree auth silently fail ho jaata hai bina kisi
    // wajah ke. Isliye yahin trim kar dete hain (__KEEP__ sentinel ko chhod ke).
    const cashfree_app_id = typeof cashfreeAppIdRaw === 'string' ? cashfreeAppIdRaw.trim() : cashfreeAppIdRaw;
    const cashfree_secret_key = (typeof cashfreeSecretRaw === 'string' && cashfreeSecretRaw !== '__KEEP__')
      ? cashfreeSecretRaw.trim() : cashfreeSecretRaw;

    // Email — purani shops (jinke paas email nahi tha) yahan se bhar sakti hain.
    // undefined = field bheji hi nahi, to purana waise ka waisa rehta hai.
    let finalEmail;
    if (email !== undefined) {
      const e = String(email || '').trim().toLowerCase();
      if (e && !isValidEmail(e)) return res.status(400).json({ error: 'Sahi email daalo' });
      finalEmail = e;
    }

    // ── PARTIAL UPDATE SUPPORT ──
    // Website poora settings object bhejti hai, par desktop panel sirf
    // wahi field bhejta hai jo badla ho (jaise sirf printer ya sirf price).
    // Pehle payment_mode na aane par ye 'both' maan leta tha aur phir
    // "Online payment ke liye keys zaroori hain" error de deta tha — jabki
    // keys pehle se save thi. Us se bhi bura: payment ke 5 field COALESCE
    // ke bina UPDATE ho rahe the, yaani sirf printer save karne par
    // Razorpay ki keys MIT jaati thi.
    const curQ = await pool.query(
      `SELECT payment_mode, payment_gateway, razorpay_key_id, razorpay_key_secret,
              cashfree_app_id, cashfree_secret_key
         FROM shops WHERE id=$1`, [req.shopId]);
    const cur = curQ.rows[0] || {};

    // Request payment settings ko chhu bhi rahi hai ya nahi?
    const touchingPayment =
      payment_mode !== undefined || payment_gateway !== undefined ||
      razorpay_key_id !== undefined || razorpay_key_secret !== undefined ||
      cashfree_app_id !== undefined || cashfree_secret_key !== undefined;

    const validPaymentModes = ['both', 'counter_only', 'online_only'];
    const finalPaymentMode = validPaymentModes.includes(payment_mode)
      ? payment_mode
      : (cur.payment_mode || 'both');          // bheji nahi = purani hi rahe

    // Jo field bheji hi nahi, uske liye purani value chalegi
    const finalGatewayIn = payment_gateway !== undefined ? payment_gateway : (cur.payment_gateway || '');
    const finalRzpId     = razorpay_key_id  !== undefined ? razorpay_key_id  : (cur.razorpay_key_id || '');
    const finalCfId      = cashfree_app_id  !== undefined ? cashfree_app_id  : (cur.cashfree_app_id || '');

    const needsGateway = finalPaymentMode === 'both' || finalPaymentMode === 'online_only';

    // __KEEP__ sentinel ka matlab hai "purana secret hi rakho, change nahi karna"
    let finalRzpSecret = razorpay_key_secret;
    let finalCfSecret = cashfree_secret_key;
    if (razorpay_key_secret === '__KEEP__' || cashfree_secret_key === '__KEEP__') {
      const existing = await pool.query('SELECT razorpay_key_secret, cashfree_secret_key FROM shops WHERE id=$1', [req.shopId]);
      if (existing.rows.length) {
        if (razorpay_key_secret === '__KEEP__') finalRzpSecret = existing.rows[0].razorpay_key_secret;
        if (cashfree_secret_key === '__KEEP__') finalCfSecret = existing.rows[0].cashfree_secret_key;
      }
    }

    // Secret bheja hi nahi = purana rakho (panel sirf printer bhejta hai)
    if (razorpay_key_secret === undefined) finalRzpSecret = cur.razorpay_key_secret || '';
    if (cashfree_secret_key === undefined) finalCfSecret = cur.cashfree_secret_key || '';

    // Gateway ki jaanch SIRF tab jab request payment settings badal rahi ho.
    // Sirf printer/price save karne par ye jaanch chalni hi nahi chahiye.
    if (touchingPayment && needsGateway) {
      const validRazorpay = finalGatewayIn === 'razorpay' && finalRzpId && finalRzpSecret;
      const validCashfree = finalGatewayIn === 'cashfree' && finalCfId && finalCfSecret;
      if (!validRazorpay && !validCashfree) {
        return res.status(400).json({ error: 'Online payment ke liye Razorpay ya Cashfree ki details zaroori hain' });
      }
    }

    const finalGateway = needsGateway ? finalGatewayIn : '';

    await pool.query(
      `UPDATE shops SET
        name=COALESCE($1,name),
        address=COALESCE($2,address),
        phone=COALESCE($3,phone),
        printer_model=COALESCE($4,printer_model),
        price_bw=COALESCE($5,price_bw),
        price_color=COALESCE($6,price_color),
        payment_mode=$7,
        payment_gateway=$8,
        razorpay_key_id=$9,
        razorpay_key_secret=$10,
        cashfree_app_id=$11,
        cashfree_secret_key=$12,
        email=COALESCE($13,email),
        printer_name_bw=COALESCE($14,printer_name_bw),
        printer_name_color=COALESCE($15,printer_name_color)
      WHERE id=$16`,
      [name, address, phone, printer_model, price_bw, price_color, finalPaymentMode,
       finalGateway, finalRzpId||'', finalRzpSecret||'', finalCfId||'', finalCfSecret||'',
       finalEmail === undefined ? null : finalEmail,
       printer_name_bw, printer_name_color,
       req.shopId]
    );

    const r = await pool.query('SELECT id,name,address,phone,email,printer_model,printer_name_bw,printer_name_color,price_bw,price_color,payment_mode,payment_gateway,razorpay_key_id,cashfree_app_id FROM shops WHERE id=$1', [req.shopId]);
    // Duplex mode alag se (validate karke)
    if (advUnlocked && typeof req.body.duplex_mode === 'string' && ['','auto','manual'].includes(req.body.duplex_mode)) {
      await pool.query('UPDATE shops SET duplex_mode=$1 WHERE id=$2', [req.body.duplex_mode, req.shopId]);
    }
    if (advUnlocked) {
      if (typeof req.body.printer_name_4x6 === 'string')
        await pool.query('UPDATE shops SET printer_name_4x6=$1 WHERE id=$2', [req.body.printer_name_4x6.slice(0,300), req.shopId]);
      if (typeof req.body.printer_name_a3 === 'string')
        await pool.query('UPDATE shops SET printer_name_a3=$1 WHERE id=$2', [req.body.printer_name_a3.slice(0,300), req.shopId]);
      // Duplex ka apna printer. Khaali = purana behaviour (B&W/Color wala hi).
      if (typeof req.body.printer_name_duplex === 'string')
        await pool.query('UPDATE shops SET printer_name_duplex=$1 WHERE id=$2', [req.body.printer_name_duplex.slice(0,300), req.shopId]);
      // Duplex kis mode par chalu hai -- B&W aur Color alag-alag.
      // Field bheji hi nahi = purani value waise ki waisi (partial update safe).
      for (const [dKey, dCol] of [['duplex_bw_enabled','duplex_bw_enabled'],
                                  ['duplex_color_enabled','duplex_color_enabled']]) {
        if (req.body[dKey] !== undefined) {
          const dOn = (req.body[dKey] === true || req.body[dKey] === 'true' ||
                       req.body[dKey] === 1 || req.body[dKey] === '1');
          await pool.query(`UPDATE shops SET ${dCol}=$1 WHERE id=$2`, [dOn, req.shopId]);
        }
      }
      // Advance pricing (4x6 sheet: 4/6/8/10-photo; resume: color/bw)
      for (const [key, col] of [['price_4x6_4','price_4x6_4'],['price_4x6_6','price_4x6_6'],
                                ['price_4x6_8','price_4x6_8'],['price_4x6_10','price_4x6_10'],
                                ['price_4x6_12','price_4x6_12'],
                                ['price_resume_color','price_resume_color'],['price_resume_bw','price_resume_bw'],
                                ['price_a3_bw','price_a3_bw'],['price_a3_color','price_a3_color'],
                                ['price_a2_bw','price_a2_bw'],['price_a2_color','price_a2_color'],
                                ['price_a1_bw','price_a1_bw'],['price_a1_color','price_a1_color']]) {
        const v = parsePrice(req.body[key]);
        if (v !== null) {
          await pool.query(`UPDATE shops SET ${col}=$1 WHERE id=$2`, [v, req.shopId]);
        }
      }
    }
    // page_slabs upar wale price loop me NAHI ja sakta — wo har value ko
    // parsePrice() se guzarta hai jo NUMBER chahta hai. Slab ek JSON
    // TEXT hai, isliye wahan wo null ban kar chup-chaap gir jaata tha:
    // owner Save dabata tha, kuch save hota hi nahi, aur reload par
    // saare box khaali dikhte the.
    if (req.body.page_slabs !== undefined) {
      let slabTxt = '';
      try {
        // Saaf karke hi rakho — kachra JSON aage price calc todta
        const p = parseSlabs(req.body.page_slabs);
        slabTxt = (p.bw.length || p.color.length) ? JSON.stringify(p) : '';
      } catch (e) { slabTxt = ''; }
      await pool.query('UPDATE shops SET page_slabs=$1 WHERE id=$2', [slabTxt, req.shopId]);
    }

    // Duplex prices — sirf tab store jab valid non-negative int mile
    const pbwd = parsePrice(req.body.price_bw_duplex);
    const pcld = parsePrice(req.body.price_color_duplex);
    if (pbwd !== null) await pool.query('UPDATE shops SET price_bw_duplex=$1 WHERE id=$2', [pbwd, req.shopId]);
    if (pcld !== null) await pool.query('UPDATE shops SET price_color_duplex=$1 WHERE id=$2', [pcld, req.shopId]);

    // ==============================================================
    // SHOP OPEN/CLOSE + SUPPLY -- Desktop Panel yahin bhejta hai
    //
    // Website ye do cheezein /api/shop/pause aur /api/shop/supply-warning
    // par bhejti hai, par Desktop Panel (agent_panel.py) inhe SETTINGS ke
    // saath bhejta hai. Yahan inka koi handler tha hi nahi: server
    // { success:true } lauta deta tha, DB me kuch likhta NAHI tha, aur
    // panel refresh par purani value wapas padh leta tha -- isliye panel
    // ka "Shop Open/Close" dabate hi wapas apni jagah chala jaata tha,
    // jabki website se wahi kaam theek chalta tha.
    //
    // Ye handler server par hone se HAR pehle se installed agent turant
    // theek ho jaata hai -- kisi shop ko naya .exe bhejne ki zaroorat nahi.
    if (req.body.paused !== undefined) {
      const isPaused = (req.body.paused === true || req.body.paused === 'true' ||
                        req.body.paused === 1 || req.body.paused === '1');
      await pool.query('UPDATE shops SET paused=$1 WHERE id=$2', [isPaused, req.shopId]);
    }
    if (req.body.supply_warning !== undefined) {
      // Panel ki apni bhasha ('ok'|'ink'|'paper') aur DB ki bhasha
      // (''|'low_ink'|'no_paper') -- dono accept karo. Koi anjaan value
      // aaye to poora save fail karne ke bajaye sirf isi field ko chhod do.
      const SUPPLY_MAP = { ok: '', '': '', ink: 'low_ink', low_ink: 'low_ink',
                           paper: 'no_paper', no_paper: 'no_paper' };
      const wNew = SUPPLY_MAP[String(req.body.supply_warning || '')];
      if (wNew !== undefined) {
        await pool.query('UPDATE shops SET supply_warning=$1 WHERE id=$2', [wNew, req.shopId]);
      }
    }
    res.json({ success: true, shop: r.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/change-password', verifyToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'Naya password kam se kam 4 character ka hona chahiye' });
    }
    const r = await pool.query('SELECT password_hash FROM shops WHERE id=$1', [req.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });


    if (!(await verifyPassword(currentPassword || '', r.rows[0].password_hash))) {
      return res.status(401).json({ error: 'Current password galat hai' });
    }

    const newHash = await hashPassword(newPassword);
    await pool.query('UPDATE shops SET password_hash=$1 WHERE id=$2', [newHash, req.shopId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── DESKTOP PANEL STATS ─────────────────────────────────────────
// Web dashboard ye numbers /api/admin/jobs se khud calculate karta hai.
// Desktop panel ko wahi maths dobara likhne se rokne ke liye server hi
// ek chhota summary de deta hai — ek query, kuch bytes, koi file nahi.
app.get('/api/admin/stats', verifyToken, async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN DATE(created_at)=CURRENT_DATE THEN copies ELSE 0 END),0)::int  AS today_prints,
         COALESCE(SUM(CASE WHEN DATE(created_at)=CURRENT_DATE THEN amount ELSE 0 END),0)::int  AS today_earnings,
         COALESCE(SUM(CASE WHEN DATE(created_at)=CURRENT_DATE - 1 THEN copies ELSE 0 END),0)::int AS prev_prints,
         COALESCE(SUM(CASE WHEN DATE(created_at)=CURRENT_DATE - 1 THEN amount ELSE 0 END),0)::int AS prev_earnings,
         COUNT(*)::int                                                                          AS total_orders,
         COALESCE(SUM(amount),0)::int                                                           AS total_earnings
       FROM print_jobs
       WHERE shop_id=$1 AND ${JOB_COUNTS}`, [req.shopId]);

    const recent = await pool.query(
      `SELECT id, status, created_at,
              EXTRACT(EPOCH FROM (NOW() - created_at))::int AS secs_ago
         FROM print_jobs WHERE shop_id=$1
        ORDER BY created_at DESC LIMIT 5`, [req.shopId]);

    const shop = await pool.query(
      'SELECT paused, supply_warning FROM shops WHERE id=$1', [req.shopId]);

    const ago = (sec) => {
      if (sec < 60) return 'just now';
      if (sec < 3600) return Math.floor(sec / 60) + ' mins ago';
      if (sec < 86400) return Math.floor(sec / 3600) + ' hours ago';
      return Math.floor(sec / 86400) + ' days ago';
    };

    const t = q.rows[0];
    res.json({
      todayPrints: t.today_prints, todayEarnings: t.today_earnings,
      prevPrints: t.prev_prints,   prevEarnings: t.prev_earnings,
      totalOrders: t.total_orders, totalEarnings: t.total_earnings,
      paused: !!(shop.rows[0] && shop.rows[0].paused),
      supply_warning: (shop.rows[0] && shop.rows[0].supply_warning) || 'ok',
      recent: recent.rows.map(r => ({ id: r.id, status: r.status, ago: ago(r.secs_ago) }))
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════
// ACCOUNT — DATA DOWNLOAD & DELETE
// ═══════════════════════════════════════════════

/** Shop ka saara data ek JSON file me — shop khud download kar sakta hai. */
app.get('/api/admin/export-data', verifyToken, async (req, res) => {
  try {
    const id = req.shopId;
    const q = async (sql, p = [id]) => {
      try { return (await pool.query(sql, p)).rows; }
      catch (e) { return [{ _error: e.message }]; }   // ek table fail ho to baaki na ruke
    };

    const shopRows = await q('SELECT * FROM shops WHERE id=$1');
    const shop = shopRows[0] || {};
    // Secrets kabhi file me nahi jaate
    for (const k of Object.keys(shop)) {
      const lk = k.toLowerCase();
      if (lk.endsWith('_secret') || lk.endsWith('secret_key') ||
          lk.endsWith('password_hash') || lk.endsWith('_token')) delete shop[k];
    }

    const data = {
      exportedAt: new Date().toISOString(),
      shopId: id,
      note: 'Echel — aapke account ka poora data. Ise sambhal kar rakhein.',
      shop,
      registration: await q('SELECT * FROM demo_registrations WHERE shop_id=$1'),
      printJobs:    await q(`SELECT id, file_name, file_type, total_pages, copies, color_mode,
                                    duplex, paper_size, amount, payment_status, payment_mode,
                                    status, failure_reason, created_at, printed_at
                               FROM print_jobs WHERE shop_id=$1 ORDER BY created_at DESC`),
      reviews:      await q('SELECT * FROM reviews WHERE shop_id=$1 ORDER BY created_at DESC'),
      withdrawals:  await q('SELECT * FROM withdrawals WHERE shop_id=$1 ORDER BY created_at DESC'),
      commissions:  await q('SELECT * FROM agent_commissions WHERE shop_id=$1 ORDER BY created_at DESC'),
      activityLogs: await q(`SELECT created_at, endpoint, method, action, reason, ip
                               FROM security_events WHERE shop_id=$1
                              ORDER BY created_at DESC LIMIT 2000`),
      machines:     await q('SELECT * FROM demo_machines WHERE shop_id=$1')
    };

    const jobs = Array.isArray(data.printJobs) ? data.printJobs : [];
    data.summary = {
      totalPrintJobs: jobs.length,
      totalEarned: jobs.filter(j => j.payment_status === 'paid')
                       .reduce((a, j) => a + (Number(j.amount) || 0), 0),
      accountCreated: shop.created_at || null
    };

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="QRSePrint-${id}-${stamp}.json"`);
    res.send(JSON.stringify(data, null, 2));
    console.log(`Data export: ${id} (${jobs.length} jobs)`);
  } catch (err) {
    console.error('export-data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Account HAMESHA ke liye delete. Wapas nahi aayega.
 * Sab kuch ek transaction me — beech me fail ho to kuch bhi delete nahi hota.
 */
app.delete('/api/admin/delete-account', verifyToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = req.shopId;

    // "DELETE" likhna zaroori — galti se click hone par kuch na ho
    if (String((req.body && req.body.confirm) || '').trim().toUpperCase() !== 'DELETE') {
      return res.status(400).json({ error: 'Confirm karne ke liye DELETE likhna zaroori hai' });
    }

    const shopRow = await client.query('SELECT id, name, phone FROM shops WHERE id=$1', [id]);
    if (!shopRow.rows.length) return res.status(404).json({ error: 'Shop not found' });
    const shop = shopRow.rows[0];

    // Cloudinary ki bachi hui files pehle hata do — DB se row jaane ke baad
    // in tak pahunchne ka koi rasta nahi bachega.
    const files = await client.query(
      `SELECT file_public_id FROM print_jobs
        WHERE shop_id=$1 AND file_public_id IS NOT NULL AND file_deleted=false`, [id]);

    await client.query('BEGIN');
    const counts = {};
    for (const tbl of ['print_jobs', 'reviews', 'withdrawals', 'agent_commissions',
                       'security_events', 'upload_fingerprints', 'demo_machines']) {
      const r = await client.query(`DELETE FROM ${tbl} WHERE shop_id=$1`, [id]);
      counts[tbl] = r.rowCount;
    }
    // Registration row rakhte hain par shop se link tod dete hain, taaki
    // wo phone number dobara demo le sake.
    await client.query(
      "UPDATE demo_registrations SET shop_id=NULL WHERE shop_id=$1", [id]);
    const sh = await client.query('DELETE FROM shops WHERE id=$1', [id]);
    counts.shops = sh.rowCount;
    await client.query('COMMIT');

    // DB saaf hone ke baad hi files hatao
    let filesDeleted = 0;
    for (const f of files.rows) {
      try { await deleteFromCloudinary(f.file_public_id); filesDeleted++; } catch (_) {}
    }

    console.log(`ACCOUNT DELETED: ${id} (${shop.name}, ${shop.phone}) | ` +
      Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ') +
      ` | cloudinary:${filesDeleted}`);
    res.json({ success: true, deleted: counts, filesDeleted });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('delete-account error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/admin/jobs', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id,file_name,amount,copies,color_mode,total_pages,selected_pages,duplex,status,payment_status,payment_method,failure_reason,file_deleted,created_at,printed_at FROM print_jobs WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.shopId]
    );
    res.json({ jobs: r.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// DIRECT UPLOAD — Customer → Cloudinary (Render ko file chhuti hi nahi)
//
// Purana flow: Customer → Render → Cloudinary. 10 MB file par Render ko
// 10 MB receive + ~13 MB bhejna padta tha (base64 33% bada kar deta hai)
// = ~23 MB per file. Render ka 5 GB isi me udd raha tha.
//
// Naya flow: Render sirf ek signature deta hai (~200 bytes), customer
// seedha Cloudinary ko file bhejta hai, phir Render ko sirf public_id
// aata hai (~300 bytes). Bandwidth ~99% bach jaata hai.
//
// Security: signature ke saath ek HMAC token bhi jaata hai. Confirm par
// wahi token match hona chahiye AUR Cloudinary se confirm hona chahiye ki
// file sach me wahan hai — warna koi jhoota public_id bhej kar bina file
// ke job bana sakta tha.
// ══════════════════════════════════════════════════════════════
function uploadTokenFor(shopId, publicId) {
  return crypto.createHmac('sha256', JWT_SECRET)
    .update(`${shopId}|${publicId}`).digest('hex').slice(0, 32);
}

// ─── UPLOAD VALIDATION HELPERS ──────────────────────────────────────
// IMPORTANT: ye saare checks Cloudinary upload se PEHLE chalte hain
// (/api/upload/sign par). Signature na mile to browser Cloudinary ko
// chhoo bhi nahi sakta — isliye reject hone par 0 bandwidth kharch hoti hai.

function checkSizeLimit(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;      // pata nahi — skip
  return n > MAX_UPLOAD_BYTES ? LIMIT_MSG.size : null;
}

function checkPageLimit(pages, fileName) {
  const n = parseInt(pages, 10);
  if (!Number.isInteger(n) || n <= 0) return null;     // pata nahi — skip
  // Page limit sirf multi-page documents par. Ek photo = 1 page, usko
  // kabhi block nahi karna.
  if (n > MAX_PDF_PAGES) return LIMIT_MSG.pages;
  return null;
}

/**
 * Ek job me kitne kagaz nikal rahe hain — page x copies.
 * Server har jagah yahi ginti karta hai (finalPages x effCopies), aur
 * customer.html ka getSlabPageCount() bhi bilkul yahi. Teeno ek jaise
 * rehne chahiye, warna customer ko dikhta kuch aur hai aur hota kuch aur.
 */
function checkSheetLimit(pages, copies) {
  const p = parseInt(pages, 10), c = parseInt(copies, 10);
  if (!Number.isInteger(p) || p <= 0) return null;     // pata nahi — skip
  if (!Number.isInteger(c) || c <= 0) return null;
  return (p * c) > MAX_JOB_SHEETS ? LIMIT_MSG.sheets : null;
}

/**
 * Ek hi customer baar-baar, jaldi-jaldi print de raha hai?
 *
 * SHOP wale checkUploadAbuse() se ALAG hai, aur jaan-boojh kar alag hai:
 * wo shop ko block karta hai. Agar customer ko rokne ke liye wahi use
 * karte to ek badmash poori dukaan band kara deta — aur wo ho chuka hai
 * ("3 print, 16 block"). Yahan block SIRF us customer par lagta hai;
 * dukaan aur baaki customer chalte rehte hain.
 *
 * Pehchaan do tarah se:
 *   cid — browser me rakhi device id. Pakki, par incognito me nayi.
 *   ip  — chaura jaal, isliye limit BAHUT udaar. Cyber cafe ki WiFi par
 *         saare customer ek hi IP par hote hain; sakht rakhte to
 *         imandaar log ruk jaate.
 */
function checkCustomerAbuse(shopId, cid, ip) {
  const now = Date.now();
  const windowMs = SEC.custWindowMin * 60 * 1000;

  const bump = (map, key, max) => {
    if (!key) return false;
    let e = map.get(key);
    if (!e || now > e.resetAt) e = { count: 0, resetAt: now + windowMs };
    e.count++;
    map.set(key, e);
    return e.count > max;
  };

  const cidKey = cid ? (shopId + '|' + cid) : '';
  const ipKey  = ip  ? (shopId + '|' + ip)  : '';

  // Pehle dekho ki pehle se block to nahi — ginti tabhi badhao jab
  // banda sach me andar aa raha ho.
  for (const k of [cidKey, ipKey]) {
    if (!k) continue;
    const mins = isBlocked('cust:' + k);
    if (mins) return { ok: false, reason: 'CUSTOMER_BLOCKED', mins };
  }

  const cidOver = bump(custHits, cidKey, SEC.custJobsMax);
  const ipOver  = bump(custIpHits, ipKey, SEC.custIpMax);

  if (cidOver || ipOver) {
    const key = cidOver ? cidKey : ipKey;
    blockFor('cust:' + key, SEC.blockMin, 'customer rapid print');
    return { ok: false, reason: cidOver ? 'CUSTOMER_RATE' : 'CUSTOMER_IP_RATE',
             mins: SEC.blockMin };
  }
  return { ok: true };
}

/**
 * Customer ka poora darwaza — dono pehre ek jagah.
 *
 * Har upload ke shuru me: `if (!(await customerGuard(req, res, shopId))) return;`
 *
 *   1. PAKKA ban  — superadmin ne lagaya, DB me hai, khud kabhi nahi hatta
 *   2. jaldi-jaldi — apne aap lagta hai, 15 minute me khud khul jaata hai
 *
 * Dono me block SIRF us customer par lagta hai. Shop chalti rehti hai.
 */
async function customerGuard(req, res, shopId) {
  const cid = customerId(req);
  const ip  = clientIp(req);

  if (await isCustomerBanned(cid)) {
    await logSecurityEvent({ ip, shopId, endpoint: req.path, method: req.method,
      action: 'PDF_UPLOAD', reason: 'CUSTOMER_BANNED',
      userAgent: req.headers['user-agent'] });
    res.status(403).json({
      error: 'Is device se print band kar diya gaya hai. Shop owner se baat kariye.',
      customerBanned: true });
    return false;
  }

  const r = checkCustomerAbuse(shopId, cid, ip);
  if (!r.ok) {
    await logSecurityEvent({ ip, shopId, endpoint: req.path, method: req.method,
      action: 'PDF_UPLOAD', reason: r.reason,
      userAgent: req.headers['user-agent'] });
    res.status(429).json({
      error: 'Bahut jaldi-jaldi print bhej rahe ho. ' + r.mins
           + ' minute baad dobara try karo.',
      customerBlocked: true });
    return false;
  }
  return true;
}

/** Customer ki device id — header se ya body se, saaf karke. */
function customerId(req) {
  const raw = req.headers['x-customer-id']
           || (req.body && (req.body.customerId || req.body.cid)) || '';
  return String(raw).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
}

const SHA256_RE = /^[a-f0-9]{64}$/i;

/**
 * File sach me wahi hai jo naam keh raha hai? Sirf extension par bharosa
 * mat karo — attacker .exe ko .pdf naam de sakta hai.
 * Buffer wahin milta hai jahan file server se guzarti hai (fallback path).
 */
function sniffFileType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  const b = buffer;
  if (b[0]===0x25 && b[1]===0x50 && b[2]===0x44 && b[3]===0x46) return 'pdf';   // %PDF
  if (b[0]===0xFF && b[1]===0xD8 && b[2]===0xFF)                 return 'jpg';
  if (b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47)  return 'png';
  if (b[0]===0x50 && b[1]===0x4B && (b[2]===0x03||b[2]===0x05))  return 'docx'; // zip = docx
  if (b[0]===0xD0 && b[1]===0xCF && b[2]===0x11 && b[3]===0xE0)  return 'doc';  // OLE2
  return null;
}

/** PDF ke andar asli page count — client ke bheje number par bharosa nahi. */
function countPdfPages(buffer) {
  try {
    const txt = buffer.toString('latin1');
    let n = (txt.match(/\/Type\s*\/Page[^s]/g) || []).length;
    if (!n) {
      const counts = [...txt.matchAll(/\/Count\s+(\d+)/g)].map(m => parseInt(m[1], 10));
      if (counts.length) n = Math.max(...counts);
    }
    return n > 0 ? n : null;    // parse na ho to null — block mat karo
  } catch (e) { return null; }
}

/** Extension + magic bytes + (PDF ho to) asli page count. */
function validateFileBuffer(buffer, originalName) {
  const ext = (path.extname(originalName || '').replace('.', '') || '').toLowerCase();
  const sniffed = sniffFileType(buffer);
  if (!sniffed) {
    return { ok: false, error: 'This file type is not supported. Please upload a PDF, image or Word file.' };
  }
  const family = { jpg:'img', jpeg:'img', png:'img', pdf:'pdf', doc:'doc', docx:'doc' };
  if (family[ext] && family[sniffed] && family[ext] !== family[sniffed]) {
    return { ok: false, error: 'The file contents do not match its extension.', mismatch: `${ext}!=${sniffed}` };
  }
  if (sniffed === 'pdf') {
    const pages = countPdfPages(buffer);
    if (pages && pages > MAX_PDF_PAGES) {
      return { ok: false, error: LIMIT_MSG.pages, realPages: pages };
    }
    return { ok: true, type: sniffed, pages };
  }
  return { ok: true, type: sniffed };
}

/**
 * Duplicate upload guard. Ek hi shop par ek hi file (same SHA-256)
 * DUP_UPLOAD_LIMIT baar se zyada DUP_UPLOAD_WINDOW_MIN minute me upload
 * nahi ho sakti.
 * @param {boolean} commit  false = sirf check karo (sign par),
 *                          true  = count badhao (confirm par)
 */
async function checkDuplicateUpload(shopId, fileHash, commit) {
  if (!fileHash || !SHA256_RE.test(String(fileHash))) return null;  // hash nahi — skip
  const hash = String(fileHash).toLowerCase();
  try {
    // Window ke bahar ka record purana maan kar reset kar do
    const r = await pool.query(
      `SELECT hits, last_seen,
              (last_seen < NOW() - ($3 || ' minutes')::interval) AS expired
         FROM upload_fingerprints WHERE shop_id=$1 AND file_hash=$2`,
      [shopId, hash, String(DUP_UPLOAD_WINDOW_MIN)]);

    const row = r.rows[0];
    const current = (!row || row.expired) ? 0 : row.hits;

    if (current >= DUP_UPLOAD_LIMIT) return LIMIT_MSG.dup;
    if (!commit) return null;

    await pool.query(
      `INSERT INTO upload_fingerprints (shop_id, file_hash, hits, first_seen, last_seen)
       VALUES ($1,$2,1,NOW(),NOW())
       ON CONFLICT (shop_id, file_hash) DO UPDATE
         SET hits = CASE WHEN upload_fingerprints.last_seen < NOW() - ($3 || ' minutes')::interval
                         THEN 1 ELSE upload_fingerprints.hits + 1 END,
             first_seen = CASE WHEN upload_fingerprints.last_seen < NOW() - ($3 || ' minutes')::interval
                         THEN NOW() ELSE upload_fingerprints.first_seen END,
             last_seen = NOW()`,
      [shopId, hash, String(DUP_UPLOAD_WINDOW_MIN)]);
    return null;
  } catch (e) {
    // Guard fail ho to genuine customer ko block MAT karo — sirf log karo.
    console.warn('Duplicate-check skipped:', e.message);
    return null;
  }
}

app.post('/api/upload/sign', async (req, res) => {
  try {
    const shopId = String(req.body.shopId || '').trim();
    if (!shopId) return res.status(400).json({ error: 'Shop ID required' });
    if (!CLOUD_NAME || !CLD_API_KEY || !CLD_API_SECRET) {
      return res.status(500).json({ error: 'Cloudinary configure nahi hai' });
    }
    const s = await pool.query('SELECT id FROM shops WHERE id=$1', [shopId]);
    if (!s.rows.length) return res.status(404).json({ error: 'Shop not found' });

    // ── GLOBAL EMERGENCY BRAKE ──
    // Poore server par upload rate phat gaya (loop/bug/attack)? Naye
    // uploads temporarily rok do — Cloudinary ko call hi nahi jaayegi.
    if (!globalBrake()) {
      return res.status(503).json({
        error: 'The service is very busy right now. Please try again in a minute.' });
    }

    // ── CIRCUIT BREAKER: per-shop burst + quota ──
    const shopRow0 = await pool.query('SELECT demo FROM shops WHERE id=$1', [shopId]);
    const abuse = checkUploadAbuse(shopId, !!(shopRow0.rows[0] && shopRow0.rows[0].demo));
    if (!abuse.ok) {
      await logSecurityEvent({ ip: clientIp(req), shopId, endpoint: '/api/upload/sign', method: 'POST',
        action: 'PDF_UPLOAD', reason: abuse.reason, uploadCount: abuse.total,
        fileSize: Number(req.body.fileSize), userAgent: req.headers['user-agent'] });
      return res.status(429).json({ error: abuse.error, blocked: true, reason: abuse.reason });
    }

    // ── CUSTOMER ka apna pehra ──
    // Upar wala checkUploadAbuse SHOP ko dekhta hai. Ye us AADMI ko dekhta
    // hai jo QR scan karke print de raha hai. Block sirf usi par lagta hai
    // — dukaan aur baaki customer chalte rehte hain.
    if (!(await customerGuard(req, res, shopId))) return;

    // Demo shop limit khatam ho chuki hai to upload shuru hi mat hone do —
    // customer ko baad me "limit over" dikhane se behtar hai pehle rok dena.
    const allowDemo = await checkDemoAllowance(shopId);
    if (!allowDemo.ok) {
      return res.status(403).json({
        error: allowDemo.error, demoLimitReached: true,
        reason: allowDemo.reason, used: allowDemo.used, limit: allowDemo.limit,
        plans: await getUpgradePlans()
      });
    }

    // ── GUARDRAILS: signature dene se PEHLE. Reject hua to browser
    //    Cloudinary tak pahunchta hi nahi = zero bandwidth waste. ──
    const sizeErr = checkSizeLimit(req.body.fileSize);
    if (sizeErr) return res.status(413).json({ error: sizeErr });

    const pageErr = checkPageLimit(req.body.totalPages, req.body.fileName);
    if (pageErr) return res.status(413).json({ error: pageErr });

    const dupErr = await checkDuplicateUpload(shopId, req.body.fileHash, false);
    if (dupErr) return res.status(429).json({ error: dupErr });

    const timestamp = Math.round(Date.now() / 1000);
    const publicId = UPLOAD_PREFIX + uuidv4();
    const signature = crypto.createHash('sha256')
      .update(`public_id=${publicId}&timestamp=${timestamp}${CLD_API_SECRET}`).digest('hex');

    res.json({
      success: true, cloudName: CLOUD_NAME, apiKey: CLD_API_KEY,
      timestamp, publicId, signature,
      uploadUrl: `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/raw/upload`,
      uploadToken: uploadTokenFor(shopId, publicId)
    });
  } catch(err) {
    console.error('Upload sign error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cloudinary se confirm karo ki file sach me wahan hai (aur uska asli URL lo)
function cloudinaryResourceInfo(publicId) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUD_NAME}/resources/raw/upload/${encodeURIComponent(publicId)}`,
      method: 'GET',
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${CLD_API_KEY}:${CLD_API_SECRET}`).toString('base64') }
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (resp.statusCode !== 200) return reject(new Error(j?.error?.message || 'File Cloudinary par nahi mili'));
          resolve(j);
        } catch(e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => { r.destroy(); reject(new Error('Cloudinary timeout')); });
    r.end();
  });
}

app.post('/api/upload/confirm', async (req, res) => {
  try {
    const b = req.body || {};
    const shopId = String(b.shopId || '').trim();
    // Cloudinary raw upload par public_id ke aage extension jod deta hai
    // (qrprint_abc -> qrprint_abc.pdf). Isliye do alag values aati hain:
    //   signedPublicId = jo humne sign kiya (token isi se bana)
    //   publicId       = jo Cloudinary ne wapas diya (lookup isi se hoga)
    const publicId = String(b.publicId || '').trim();
    const signedPublicId = String(b.signedPublicId || b.publicId || '').trim();
    const token = String(b.uploadToken || '').trim();
    if (!shopId || !isJobAsset(publicId) || !isJobAsset(signedPublicId)) return res.status(400).json({ error: 'A valid shop and Echel upload are required.' });

    // 1) Token match — ye public_id humne hi is shop ke liye issue kiya tha?
    if (token !== uploadTokenFor(shopId, signedPublicId)) {
      return res.status(403).json({ error: 'Upload token match nahi hua' });
    }
    // 2) Cloudinary ka public_id wahi hona chahiye jo humne sign kiya
    //    (bas extension juda ho sakta hai) — warna koi doosri file point kar sakta hai
    if (publicId !== signedPublicId && !publicId.startsWith(signedPublicId + '.')) {
      return res.status(403).json({ error: 'Public ID match nahi hua' });
    }

    const shopResult = await pool.query('SELECT * FROM shops WHERE id=$1', [shopId]);
    if (!shopResult.rows.length) return res.status(404).json({ error: 'Shop not found' });
    // ── CUSTOMER ka pehra — YAHAN SABSE ZAROORI ──
    // Job isi route par banti hai. Pehle guard sirf /api/upload/sign aur
    // /api/upload par tha, aur ye raasta khula pada tha — banda block
    // hone ke baad bhi job bana leta tha. Ab teeno darwazon par ek hi
    // pehra hai.
    if (!(await customerGuard(req, res, shopId))) return;

    const shop = shopResult.rows[0];

    // 3) File ka URL.
    //    Security pehle hi ho chuki hai: HMAC token proof hai ki ye public_id
    //    HUMNE isi shop ke liye issue kiya tha, aur public_id prefix bhi match
    //    kar chuka hai. Isliye URL banane ke liye Cloudinary se poochna
    //    ZAROORI nahi — aur wahi Admin API call 500 de raha tha.
    //
    //    Rasta: URL client se lo par crypto-validate karo; na mile to khud
    //    bana lo (raw upload ka URL format fixed hai). Cloudinary se verify
    //    sirf "best effort" — fail ho to bhi job banega (file sach me na hui
    //    to agent download par pata chal jayega aur job fail ho jayega).
    let fileUrl = String(b.secureUrl || '').trim();
    let cldInfo = null;
    const okHost = fileUrl.startsWith(`https://res.cloudinary.com/${CLOUD_NAME}/`);
    if (!fileUrl || !okHost || !fileUrl.includes(signedPublicId)) {
      // Purana client ho ya URL galat — khud bana lo (deterministic)
      fileUrl = `https://res.cloudinary.com/${CLOUD_NAME}/raw/upload/${publicId}`;
    }

    try {
      cldInfo = await cloudinaryResourceInfo(publicId);
      if (cldInfo && (cldInfo.secure_url || cldInfo.url)) fileUrl = cldInfo.secure_url || cldInfo.url;
    } catch (e) {
      console.warn(`Cloudinary verify skip (${e.message}) — URL khud bana liya: ${publicId}`);
    }

    // ── GUARDRAILS (dobara, ab asli data ke saath) ──
    // Client jhooth bol sakta hai, isliye Cloudinary ka actual bytes count
    // hi final hai. Limit toot gayi to file waapas delete kar do.
    const realBytes = cldInfo && Number(cldInfo.bytes);
    const sizeErr2 = checkSizeLimit(realBytes);
    if (sizeErr2) {
      try { await deleteFromCloudinary(publicId); } catch(_) {}
      console.warn(`Oversized upload rejected + deleted: ${publicId} (${realBytes} bytes)`);
      return res.status(413).json({ error: sizeErr2 });
    }
    const pageErr2 = checkPageLimit(b.totalPages, b.fileName);
    if (pageErr2) {
      try { await deleteFromCloudinary(publicId); } catch(_) {}
      return res.status(413).json({ error: pageErr2 });
    }
    // Ab jab upload sach me hua hai, tabhi duplicate counter badhao.
    const dupErr2 = await checkDuplicateUpload(shopId, b.fileHash, true);
    if (dupErr2) {
      try { await deleteFromCloudinary(publicId); } catch(_) {}
      return res.status(429).json({ error: dupErr2 });
    }

    const jobId = 'JOB_' + uuidv4().substring(0, 10).toUpperCase();
    const fileName = String(b.fileName || 'document.pdf').slice(0, 200);
    const fileType = (path.extname(fileName).replace('.', '').toLowerCase()) || 'pdf';
    const numCopies = parseInt(b.copies) || 1;
    const numPages = parseInt(b.totalPages) || 1;
    const colorMode = b.colorMode === 'color' ? 'color' : 'bw';
    const pricePerPage = colorMode === 'color' ? shop.price_color : shop.price_bw;
    const amount = round2(pricePerPage * numPages * numCopies);

    await pool.query(
      'INSERT INTO print_jobs (id,shop_id,file_name,file_url,file_public_id,file_type,total_pages,copies,color_mode,amount,paper_size,orientation,service,photo_count,customer_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [jobId, shopId, fileName, fileUrl, publicId, fileType, numPages, numCopies, colorMode, amount,
       ['4x6','a4','a5','letter','legal','a3','a2','a1'].includes(b.paperSize) ? b.paperSize : 'a4',
       ['portrait','landscape'].includes(b.orientation) ? b.orientation : 'portrait',
       ['doc','resume','photo4x6'].includes(b.service) ? b.service : 'doc',
       [4,6,8,10].includes(parseInt(b.photoCount)) ? parseInt(b.photoCount) : 0,
       customerId(req)]
    );
    console.log(`Direct upload confirmed: ${jobId} (${(cldInfo && cldInfo.bytes) || '?'} bytes, Render se nahi guzri)`);
    res.json({ success: true, jobId, fileName, fileType, amount,
      copies: numCopies, totalPages: numPages, colorMode });
  } catch(err) {
    console.error('Upload confirm error:', err.message);
    // Galti hamari thi — customer ki retry par dukaan block na ho
    pardonUploadFailure(req.body && req.body.shopId);
    res.status(500).json({ error: err.message });
  }
});

// ── Purana upload (fallback) — direct upload fail ho to isse kaam chalta rahe ──
app.post('/api/upload', upload.single('file'), handleUploadErrors, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error:'No file uploaded' });
    const { shopId, copies, colorMode, totalPages } = req.body;
    if (!shopId) return res.status(400).json({ error:'Shop ID required' });

    const shopResult = await pool.query('SELECT * FROM shops WHERE id=$1', [shopId]);
    if (!shopResult.rows.length) return res.status(404).json({ error:'Shop not found' });
    const shop = shopResult.rows[0];

    // ── GUARDRAILS (fallback path) — Cloudinary upload se PEHLE ──
    if (!globalBrake()) {
      return res.status(503).json({ error: 'The service is very busy right now. Please try again in a minute.' });
    }
    const abuseFb = checkUploadAbuse(shopId, !!shop.demo);
    if (!abuseFb.ok) {
      await logSecurityEvent({ ip: clientIp(req), shopId, endpoint: '/api/upload', method: 'POST',
        action: 'PDF_UPLOAD', reason: abuseFb.reason, uploadCount: abuseFb.total,
        fileSize: req.file.size, userAgent: req.headers['user-agent'] });
      return res.status(429).json({ error: abuseFb.error, blocked: true });
    }
    const allowFb = await checkDemoAllowance(shopId);
    if (!allowFb.ok) {
      return res.status(403).json({ error: allowFb.error, demoLimitReached: true,
        reason: allowFb.reason, used: allowFb.used, limit: allowFb.limit,
        plans: await getUpgradePlans() });
    }

    // File sach me PDF/image hai? Magic bytes + asli page count check —
    // yahan file server ke paas hai, isliye client par bharosa zaroori nahi.
    const fv = validateFileBuffer(req.file.buffer, req.file.originalname);
    if (!fv.ok) {
      await logSecurityEvent({ ip: clientIp(req), shopId, endpoint: '/api/upload', method: 'POST',
        action: 'PDF_UPLOAD', reason: 'FILE_VALIDATION:' + (fv.mismatch || fv.realPages || 'bad'),
        fileSize: req.file.size, userAgent: req.headers['user-agent'] });
      return res.status(415).json({ error: fv.error });
    }

    // multer ne size limit pehle hi laga di, par yahan exact message do.
    const sizeErr = checkSizeLimit(req.file.size);
    if (sizeErr) return res.status(413).json({ error: sizeErr });

    if (!(await customerGuard(req, res, shopId))) return;

    const pageErr = checkPageLimit(totalPages, req.file.originalname);
    if (pageErr) return res.status(413).json({ error: pageErr });

    // Is path par file server ke paas hai — hash yahi bana lo, client par
    // bharosa karne ki zaroorat nahi.
    const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const dupErr = await checkDuplicateUpload(shopId, fileHash, true);
    if (dupErr) return res.status(429).json({ error: dupErr });

    const jobId = 'JOB_' + uuidv4().substring(0,10).toUpperCase();
    const fileType = path.extname(req.file.originalname).replace('.','').toLowerCase();
    const numCopies = parseInt(copies)||1;
    const numPages = parseInt(totalPages)||1;
    const pricePerPage = colorMode === 'color' ? shop.price_color : shop.price_bw;
    const amount = round2(pricePerPage * numPages * numCopies);

    console.log(`Uploading: ${req.file.originalname} (${numPages} pages)`);
    const cloudResult = await uploadToCloudinaryWithRetry(req.file.buffer, fileType);
    console.log(`Cloudinary: ${cloudResult.url}`);

    await pool.query(
      'INSERT INTO print_jobs (id,shop_id,file_name,file_url,file_public_id,file_type,total_pages,copies,color_mode,amount,paper_size,orientation,service,photo_count,customer_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [jobId, shopId, req.file.originalname, cloudResult.url, cloudResult.publicId, fileType, numPages, numCopies, colorMode||'bw', amount,
       ['4x6','a4','a5','letter','legal','a3','a2','a1'].includes(req.body.paperSize) ? req.body.paperSize : 'a4',
       ['portrait','landscape'].includes(req.body.orientation) ? req.body.orientation : 'portrait',
       ['doc','resume','photo4x6'].includes(req.body.service) ? req.body.service : 'doc',
       [4,6,8,10].includes(parseInt(req.body.photoCount)) ? parseInt(req.body.photoCount) : 0,
       customerId(req)]
    );
    res.json({ success:true, jobId, fileName:req.file.originalname, fileType, amount, copies:numCopies, totalPages:numPages, colorMode:colorMode||'bw' });
  } catch(err) {
    console.error('Upload error:', err.message);
    // Galti hamari thi — customer ki retry par dukaan block na ho
    pardonUploadFailure(req.body && req.body.shopId);
    res.status(500).json({ error: err.message });
  }
});

function parseSelectedPages(selectedPages, fallbackCount) {
  if (Array.isArray(selectedPages) && selectedPages.length) {
    return selectedPages.map(p => parseInt(p)).filter(p => !isNaN(p));
  }
  return Array.from({length: fallbackCount}, (_, i) => i + 1);
}

// ═══════════════════════════════════════════════════════════════════
//  CASHFREE HELPERS
// ═══════════════════════════════════════════════════════════════════

// Sirf LIVE — sandbox nahi. Test karna ho to Cashfree dashboard ki
// test keys nahi chalengi, live keys hi lagani hongi.
const CASHFREE_HOST = 'api.cashfree.com';
const CASHFREE_API_VERSION = '2025-01-01';

// Kabhi throw nahi karta — hamesha object deta hai (sendViaBrevo jaisa hi pattern)
function cashfreeRequest(method, path, appId, secretKey, body) {
  return new Promise((resolve) => {
    try {
      const headers = {
        'x-api-version': CASHFREE_API_VERSION,
        'x-client-id': String(appId || '').trim(),
        'x-client-secret': String(secretKey || '').trim(),
        'accept': 'application/json'
      };
      if (body) {
        headers['content-type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      const r = https.request({ hostname: CASHFREE_HOST, path, method, headers }, (resp) => {
        let d = '';
        resp.on('data', c => d += c);
        resp.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch (e) { resolve({ message: 'Cashfree ka jawab samajh nahi aaya (HTTP ' + resp.statusCode + ')' }); }
        });
      });
      r.on('error', e => resolve({ message: e.message }));
      r.setTimeout(20000, () => { r.destroy(); resolve({ message: 'Cashfree timeout' }); });
      if (body) r.write(body);
      r.end();
    } catch (e) { resolve({ message: e.message }); }
  });
}

// Webhook signature: base64( HMAC-SHA256( secret, timestamp + rawBody ) )
// RAW body chahiye — JSON.parse kiya hua object se signature KABHI match nahi karega.
function verifyCashfreeWebhook(secretKey, timestamp, rawBody, signature) {
  try {
    if (!secretKey || !timestamp || !signature) return false;
    const expected = crypto.createHmac('sha256', secretKey)
      .update(String(timestamp) + String(rawBody)).digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    // timingSafeEqual barabar length maangta hai — warna throw kar deta hai
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

// ─── ONLINE PAYMENT: Har shop apni Razorpay/Cashfree keys use karta hai ───
// (Paisa seedha shop owner ke account mein jaata hai, system owner ke account mein nahi)

app.post('/api/payment/online/create', async (req, res) => {
  try {
    const { jobId, colorMode, copies, totalPages, selectedPages } = req.body;

    const jobCheck = await pool.query(
      `SELECT j.*, s.price_bw, s.price_color, s.price_bw_duplex, s.price_color_duplex, s.price_4x6_4, s.price_4x6_6, s.price_4x6_8, s.price_4x6_10, s.price_4x6_12, s.page_slabs, s.price_resume_color, s.price_resume_bw, ${BIG_SIZE_PRICE_SELECT}, s.payment_mode, s.payment_gateway, s.paused, s.plan_type, s.billing_cycle, s.paid_until,
              s.razorpay_key_id, s.razorpay_key_secret,
              s.cashfree_app_id, s.cashfree_secret_key
       FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1`, [jobId]
    );
    if (!jobCheck.rows.length) return res.status(404).json({ error:'Job not found' });
    if (jobCheck.rows[0].paused) return res.status(403).json({ error: '🏪 Shop abhi band hai — baad mein try karo' });
    if (!isSubscriptionActive(jobCheck.rows[0])) return res.status(403).json({ error: '⏸️ Shop inactive hai — owner ko subscription renew karni hai' });

    const job = jobCheck.rows[0];

    // Demo limit — payment SHURU hone se pehle. Webhook par rokna galat
    // hoga: paisa kat jaata aur print nahi milta.
    const allowOnline = await checkDemoAllowance(job.shop_id);
    if (!allowOnline.ok) {
      return res.status(403).json({
        error: allowOnline.error, demoLimitReached: true,
        reason: allowOnline.reason, used: allowOnline.used, limit: allowOnline.limit,
        plans: await getUpgradePlans()
      });
    }

    if (job.payment_mode === 'counter_only') {
      return res.status(400).json({ error: 'Yeh shop sirf Counter payment accept karta hai' });
    }
    if (!job.payment_gateway) {
      return res.status(400).json({ error: 'Is shop ne abhi online payment setup nahi kiya hai' });
    }

    const finalColorMode = colorMode || job.color_mode;
    // ── DUPLEX ── sirf tab jab shop ne enable kiya ho; manual duplex par
    // copies zabardasti 1 (warna owner ko har copy pe front/back popup
    // jhelna padta aur pages mix ho jate)
    let finalDuplex = false;
    let dupShop = await pool.query(
      'SELECT duplex_mode, duplex_bw_enabled, duplex_color_enabled FROM shops WHERE id=$1',
      [job.shop_id]);
    const shopDuplexMode = dupShop.rows.length ? (dupShop.rows[0].duplex_mode || '') : '';
    // Owner duplex ko sirf B&W ya sirf Color par chalu rakh sakta hai
    // (aksar duplex ek hi printer par hota hai). Column NULL ho -- yaani
    // purani row jise migration ne abhi chhua nahi -- to ON hi maano,
    // taaki kisi chalu shop ka duplex chup-chaap band na ho jaye.
    const dupRow    = dupShop.rows[0] || {};
    const dupBwOk   = dupRow.duplex_bw_enabled !== false;
    const dupClOk   = dupRow.duplex_color_enabled !== false;
    const dupModeOk = finalColorMode === 'color' ? dupClOk : dupBwOk;
    if (req.body.duplex === true && shopDuplexMode && dupModeOk) finalDuplex = true;
    const finalCopies = parseInt(copies) || job.copies;
    const finalPages = parseInt(totalPages) || job.total_pages;
    // Manual duplex par copies HAMESHA 1 — print bhi aur BILL bhi (warna
    // customer se N copies ka paisa, print 1 ka)
    const effCopies = (finalDuplex && shopDuplexMode === 'manual') ? 1 : finalCopies;
    const finalSelectedPages = parseSelectedPages(selectedPages, job.total_pages);

    // Kul kagaz ki rok. Yahan isliye ki copies ka pata YAHIN chalta hai —
    // upload ke waqt customer ne copies chuni hi nahi hoti.
    const _sheetErr = checkSheetLimit(finalPages, effCopies);
    if (_sheetErr) return res.status(400).json({ error: _sheetErr, sheetLimit: true });
    // Duplex prices: agar owner ne set kiye hain (>0) to use, warna normal
    // rate hi lagta hai (backwards-compat + accidentally 0 rakhna safe)
    const _dupBw     = finalDuplex && parseFloat(job.price_bw_duplex) > 0;
    const _dupColor  = finalDuplex && parseFloat(job.price_color_duplex) > 0;
    const _rateBw    = _dupBw    ? job.price_bw_duplex    : job.price_bw;
    const _rateColor = _dupColor ? job.price_color_duplex : job.price_color;
    const pricePerPage = finalColorMode === 'color' ? _rateColor : _rateBw;
    // Duplex ka apna rate sach me laga ya nahi - slab usse upar nahi jaata
    const _dupRateUsed = finalColorMode === 'color' ? _dupColor : _dupBw;

    // -- PAGE-RANGE (SLAB) RATE --
    // Owner "itne se itne page tak = itna" set kar sakta hai. Wo daam HAR
    // PAGE ka rate hai, poore job ka nahi:
    //     8 page aur range 6-10 ka rate 1.5  =>  8 x 1.5 = 12
    //
    // Pehle isay poore job ka flat daam maana jaata tha - isi wajah se 4
    // page aur 8 page dono ka ek hi bill banta tha. Customer ne yahi pakda:
    // "8 print karo to 50 rs. aur 4 print karo to 50 rs."
    //
    // Owner ke apne khaas rate slab se UPAR rehte hain: duplex ka rate
    // yahin dekh liya, aur Resume / 4x6 / A3 neeche apne branch me amount
    // overwrite kar dete hain. customer.html ke getPerPageRate() me bilkul
    // yahi tarteeb hai - dono ka hisaab ek jaisa rehna zaroori hai, warna
    // customer ko dikhta kuch aur hai aur katta kuch aur.
    let ratePerPage = pricePerPage;
    if (!_dupRateUsed) {
      // Ginti = kitne KAGAZ nikal rahe hain (page x copies). 3 page ki
      // 3 copy = 9 kagaz, isliye 6-10 wali range lagegi. customer.html
      // ke getSlabPageCount() me bilkul yahi ginti banti hai.
      const _slab = slabPriceFor(job.page_slabs, finalColorMode,
                                 finalPages * effCopies);
      if (_slab !== null && _slab >= 0) ratePerPage = _slab;
    }

    // -- ADVANCE SERVICE PRICING -- resume: owner ka resume rate (color/bw)
    // x copies; photo4x6: sheet rate (4/6/8/10 photo) x copies; rate 0 ho to
    // normal per-page pricing fallback
    let amount = ratePerPage * finalPages * effCopies;
    if (job.service === 'resume') {
      const rRate = finalColorMode === 'color' ? (parseFloat(job.price_resume_color) || 0) : (parseFloat(job.price_resume_bw) || 0);
      if (rRate > 0) amount = rRate * effCopies;
    } else if (job.service === 'photo4x6') {
      // 12 ko SABSE UPAR rakha hai. Pehle iska koi branch tha hi nahi,
      // isliye 12-photo job aakhri fallback (4-photo rate) me gir jaati —
      // customer ko 12 photo 4 ke daam me mil jaate.
      const pRate = job.photo_count === 12 ? (parseFloat(job.price_4x6_12) || 0)
                 : job.photo_count === 10 ? (parseFloat(job.price_4x6_10) || 0)
                 : job.photo_count === 8 ? (parseFloat(job.price_4x6_8) || 0)
                 : job.photo_count === 6 ? (parseFloat(job.price_4x6_6) || 0)
                 : (parseFloat(job.price_4x6_4) || 0);
      if (pRate > 0) amount = pRate * effCopies;
    } else {
      // Big Size (A3/A2/A1) — owner ka apna per-page rate, set ho tabhi.
      // Duplex ke saath bhi big-size rate hi jeetta hai: bada kagaz
      // hi asli lagat hai, duplex uske andar aata hai.
      const bigRate = bigSizeRate(job, job.paper_size, finalColorMode);
      if (bigRate > 0) amount = bigRate * finalPages * effCopies;
    }
    amount = round2(amount);

    // Common job update (gateway se pehle)
    await pool.query(
      'UPDATE print_jobs SET color_mode=$1, copies=$2, total_pages=$3, selected_pages=$4, amount=$5, duplex=$6 WHERE id=$7',
      [finalColorMode, effCopies, finalPages, finalSelectedPages.join(','), amount, finalDuplex, jobId]
    );

    if (job.payment_gateway === 'razorpay') {
      if (!job.razorpay_key_id || !job.razorpay_key_secret) {
        return res.status(400).json({ error: 'Shop ki Razorpay keys set nahi hain' });
      }
      const amountInPaise = Math.round(amount * 100);
      const orderData = JSON.stringify({
        amount: amountInPaise,
        currency: 'INR',
        receipt: jobId,
        notes: { jobId, colorMode: finalColorMode, copies: effCopies, pages: finalPages }
      });
      const authHeader = 'Basic ' + Buffer.from(`${job.razorpay_key_id}:${job.razorpay_key_secret}`).toString('base64');

      const razorpayOrder = await new Promise((resolve, reject) => {
        const options = {
          hostname: 'api.razorpay.com',
          path: '/v1/orders',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
            'Content-Length': Buffer.byteLength(orderData)
          }
        };
        const r = https.request(options, (resp) => {
          let data = '';
          resp.on('data', chunk => data += chunk);
          resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        });
        r.on('error', reject);
        r.write(orderData);
        r.end();
      });

      if (!razorpayOrder.id) {
        // Razorpay asli wajah `error.description` me bhejta hai. Pehle
        // poora object `details` me jaata tha, jise client string me
        // jodta tha — isliye screen par sirf "[object Object]" aata
        // tha aur shop owner ko pata hi nahi chalta ki kya galat hai
        // (aksar: key regenerate karne ke baad purana secret saved reh
        // jaana → "Authentication failed").
        const rzErr = (razorpayOrder && razorpayOrder.error) || {};
        const why = rzErr.description || rzErr.reason || rzErr.code ||
                    'Razorpay ne order nahi banaya';
        console.error('[razorpay/order]', job.shop_id, JSON.stringify(razorpayOrder).slice(0, 500));
        return res.status(400).json({ error: 'Razorpay: ' + why, details: String(why) });
      }

      await pool.query(
        'UPDATE print_jobs SET razorpay_order_id=$1, payment_method=$2 WHERE id=$3',
        [razorpayOrder.id, 'online', jobId]
      );

      return res.json({
        success: true,
        gateway: 'razorpay',
        orderId: razorpayOrder.id,
        amount: amountInPaise,
        keyId: job.razorpay_key_id,
        jobId
      });
    }

    if (job.payment_gateway === 'cashfree') {
      if (!job.cashfree_app_id || !job.cashfree_secret_key) {
        return res.status(400).json({ error: 'Shop ki Cashfree keys set nahi hain' });
      }

      // DEBUG log — Render logs me dikhega ki create call hua aur kya bana
      console.log('[Cashfree] create attempt job=' + jobId + ' shop=' + job.shop_id + ' amount=' + amount + ' appid_len=' + String(job.cashfree_app_id).length);

      // ⚠️ SABSE ZAROORI FARAK: Razorpay PAISE leta hai (₹10 = 1000),
      // Cashfree RUPEES leta hai (₹10 = 10). Yahan *100 kabhi mat karna —
      // warna customer se 100 guna paisa kat jaayega.
      // ⚠️ Cashfree order_id GLOBALLY UNIQUE hona chahiye — same id dobara
      // bhejne par "order with same id is already present" error aata hai.
      // Pehle 'QSP_'+jobId fixed tha, isliye customer ke DOBARA "Pay" dabane
      // (retry / page reload / abandon) par same id jaata aur Cashfree reject
      // kar deta tha (Razorpay me ye dikkat nahi kyunki wahan jobId sirf
      // receipt hai, order id Razorpay khud unique banata hai). Ab har attempt
      // ka fresh unique id. Webhook aur status dono STORED payment_id se job
      // dhoondhte hain (order_id format se nahi), isliye kuch aur badalne ki
      // zaroorat nahi. Length ~31 chars (Cashfree limit 50), sirf A-Z 0-9 _.
      const cfOrderId = 'QSP_' + jobId + '_' + Date.now().toString(36).toUpperCase()
        + crypto.randomBytes(4).toString('hex').toUpperCase();
      // Cashfree ko customer_phone chahiye hi chahiye, par hum customer ka
      // number lete hi nahi (QR scan karke seedha print — koi login nahi).
      // Isliye placeholder. Payment par iska koi asar nahi padta.
      const customerPhone = '9999999999';

      const cfBody = JSON.stringify({
        order_id: cfOrderId,
        order_amount: Number(amount),          // rupees, paise NAHI
        order_currency: 'INR',
        customer_details: {
          customer_id: 'CUST_' + jobId,
          customer_phone: customerPhone
        },
        order_meta: {
          return_url: `${BASE_URL}/print-success?jobId=${jobId}&gateway=cashfree`,
          notify_url: `${BASE_URL}/api/payment/cashfree/webhook`
        },
        order_note: 'Print job ' + jobId
      });

      const cfOrder = await cashfreeRequest('POST', '/pg/orders',
        job.cashfree_app_id, job.cashfree_secret_key, cfBody);

      if (!cfOrder || !cfOrder.payment_session_id) {
        console.error('[Cashfree] order FAILED job=' + jobId + ' resp=' + JSON.stringify(cfOrder).slice(0, 400));
        return res.status(400).json({
          error: 'Cashfree order nahi bana — shop ki keys check karo',
          details: (cfOrder && (cfOrder.message || cfOrder.type || cfOrder.code)) || 'unknown'
        });
      }

      console.log('[Cashfree] order OK job=' + jobId + ' cfid=' + cfOrderId + ' session=' + String(cfOrder.payment_session_id).slice(0, 22) + '...');

      // cf_order_id nahi, HAMARA order_id save karte hain — webhook aur
      // status dono isi se job dhoondhte hain
      await pool.query(
        'UPDATE print_jobs SET payment_id=$1, payment_method=$2 WHERE id=$3',
        [cfOrderId, 'online', jobId]
      );

      return res.json({
        success: true,
        gateway: 'cashfree',
        paymentSessionId: cfOrder.payment_session_id,
        orderId: cfOrderId,
        amount,
        jobId
      });
    }

    res.status(400).json({ error: 'Unknown payment gateway' });
  } catch(err) {
    console.error('Online payment create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Razorpay verify — frontend se signature check
app.post('/api/payment/razorpay/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, jobId } = req.body;

    const jobCheck = await pool.query(
      'SELECT s.razorpay_key_secret FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1', [jobId]
    );
    if (!jobCheck.rows.length) return res.status(404).json({ error: 'Job not found' });
    const keySecret = jobCheck.rows[0].razorpay_key_secret;

    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    await pool.query(
      'UPDATE print_jobs SET payment_status=$1, status=$2, payment_id=$3 WHERE id=$4',
      ['paid', 'queued', razorpay_payment_id, jobId]
    );

    console.log(`Razorpay payment verified: ${jobId} | ${razorpay_payment_id}`);
    res.json({ success: true });
  } catch(err) {
    console.error('Razorpay verify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cashfree webhook — payment hone par Cashfree yahan call karta hai.
// Signature RAW body par verify hoti hai (line 62 wala req.rawBody).
app.post('/api/payment/cashfree/webhook', async (req, res) => {
  try {
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    if (!rawBody) return res.status(400).json({ error: 'empty body' });

    let payload = {};
    try { payload = JSON.parse(rawBody); } catch (e) {
      return res.status(400).json({ error: 'bad json' });
    }

    const orderId = (payload.data && payload.data.order && payload.data.order.order_id) || '';
    if (!orderId) return res.json({ success: true });   // koi aur event — ignore

    // Multi-tenant: har shop ki apni key hai. Isliye pehle order se shop
    // dhoondho, tabhi uska secret milega jisse signature check hogi.
    // Body sirf order_id nikalne ke liye padhi hai — VERIFY se pehle kuch
    // bhi change nahi kiya jaata.
    const jr = await pool.query(
      `SELECT j.id AS job_id, j.payment_status, s.cashfree_secret_key
       FROM print_jobs j JOIN shops s ON j.shop_id = s.id
       WHERE j.payment_id = $1`, [orderId]);
    if (!jr.rows.length) return res.json({ success: true });
    const job = jr.rows[0];

    // Replay guard: 5 minute se purana webhook nahi lenge
    const wts = parseInt(req.headers['x-webhook-timestamp'], 10);
    if (!wts || Math.abs(Date.now() / 1000 - wts) > 300) {
      console.warn('Cashfree webhook: timestamp purana/galat |', orderId);
      return res.status(401).json({ error: 'stale timestamp' });
    }

    const sigOk = verifyCashfreeWebhook(
      job.cashfree_secret_key,
      req.headers['x-webhook-timestamp'],
      rawBody,
      req.headers['x-webhook-signature']
    );
    if (!sigOk) {
      console.warn('Cashfree webhook: signature match nahi hui |', orderId);
      return res.status(401).json({ error: 'bad signature' });
    }

    const payStatus = (payload.data && payload.data.payment && payload.data.payment.payment_status) || '';
    if (payStatus === 'SUCCESS') {
      // payment_id ko chhedte nahi — wahi hamara stable lookup key hai
      const upd = await pool.query(
        `UPDATE print_jobs SET payment_status='paid', status='queued'
         WHERE id=$1 AND payment_status <> 'paid' RETURNING id, shop_id`, [job.job_id]);
      if (upd.rows.length) {
        markShopHasWork(upd.rows[0].shop_id);
        console.log(`Cashfree payment success: ${orderId} | job ${job.job_id}`);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Cashfree webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cashfree se wapas aane ke baad status check (frontend polling ke liye).
// Webhook late aaye ya na aaye, isse customer atakta nahi.
app.get('/api/payment/cashfree/status/:jobId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT j.payment_id, j.payment_status, s.cashfree_app_id, s.cashfree_secret_key
       FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1`,
      [req.params.jobId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = r.rows[0];

    // Webhook pehle aa gaya to DB me already paid hai — seedha bata do
    if (job.payment_status === 'paid') {
      return res.json({ success: true, status: 'PAID' });
    }
    if (!job.payment_id || !job.cashfree_app_id || !job.cashfree_secret_key) {
      return res.json({ success: true, status: 'PENDING' });
    }

    const order = await cashfreeRequest('GET', '/pg/orders/' + encodeURIComponent(job.payment_id),
      job.cashfree_app_id, job.cashfree_secret_key, null);

    const status = (order && order.order_status) || 'PENDING';
    if (status === 'PAID') {
      const _u = await pool.query(
        `UPDATE print_jobs SET payment_status='paid', status='queued'
         WHERE id=$1 AND payment_status <> 'paid' RETURNING shop_id`, [req.params.jobId]);
      if (_u.rows.length) markShopHasWork(_u.rows[0].shop_id);
      console.log(`Cashfree status-check paid: ${job.payment_id}`);
    }
    res.json({ success: true, status });
  } catch (err) {
    console.error('Cashfree status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payment/counter', async (req, res) => {
  try {
    const { jobId, colorMode, copies, totalPages, selectedPages } = req.body;
    if (!jobId) return res.status(400).json({ error:'Job ID required' });

    const jobCheck = await pool.query(
      `SELECT j.*, s.price_bw, s.price_color, s.price_bw_duplex, s.price_color_duplex, s.price_4x6_4, s.price_4x6_6, s.price_4x6_8, s.price_4x6_10, s.price_4x6_12, s.page_slabs, s.price_resume_color, s.price_resume_bw, ${BIG_SIZE_PRICE_SELECT}, s.payment_mode, s.paused, s.plan_type, s.billing_cycle, s.paid_until FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1`, [jobId]
    );
    if (!jobCheck.rows.length) return res.status(404).json({ error:'Job not found' });

    const job = jobCheck.rows[0];
    if (job.paused) return res.status(403).json({ error: '🏪 Shop abhi band hai — baad mein try karo' });
    if (!isSubscriptionActive(job)) return res.status(403).json({ error: '⏸️ Shop inactive hai — owner ko subscription renew karni hai' });

    // Demo guards: expiry + free-print cap (dono ek hi helper se)
    const allow = await checkDemoAllowance(job.shop_id);
    if (!allow.ok) {
      return res.status(403).json({
        error: allow.error, demoLimitReached: true,
        reason: allow.reason, used: allow.used, limit: allow.limit,
        plans: await getUpgradePlans()
      });
    }

    if (job.payment_mode === 'online_only') {
      return res.status(400).json({ error: 'Yeh shop sirf Online payment accept karta hai' });
    }

    const finalColorMode = colorMode || job.color_mode;
    // ── DUPLEX ── sirf tab jab shop ne enable kiya ho; manual duplex par
    // copies zabardasti 1 (warna owner ko har copy pe front/back popup
    // jhelna padta aur pages mix ho jate)
    let finalDuplex = false;
    let dupShop = await pool.query(
      'SELECT duplex_mode, duplex_bw_enabled, duplex_color_enabled FROM shops WHERE id=$1',
      [job.shop_id]);
    const shopDuplexMode = dupShop.rows.length ? (dupShop.rows[0].duplex_mode || '') : '';
    // Owner duplex ko sirf B&W ya sirf Color par chalu rakh sakta hai
    // (aksar duplex ek hi printer par hota hai). Column NULL ho -- yaani
    // purani row jise migration ne abhi chhua nahi -- to ON hi maano,
    // taaki kisi chalu shop ka duplex chup-chaap band na ho jaye.
    const dupRow    = dupShop.rows[0] || {};
    const dupBwOk   = dupRow.duplex_bw_enabled !== false;
    const dupClOk   = dupRow.duplex_color_enabled !== false;
    const dupModeOk = finalColorMode === 'color' ? dupClOk : dupBwOk;
    if (req.body.duplex === true && shopDuplexMode && dupModeOk) finalDuplex = true;
    const finalCopies = parseInt(copies) || job.copies;
    const finalPages = parseInt(totalPages) || job.total_pages;
    // Manual duplex par copies HAMESHA 1 — print bhi aur BILL bhi (warna
    // customer se N copies ka paisa, print 1 ka)
    const effCopies = (finalDuplex && shopDuplexMode === 'manual') ? 1 : finalCopies;
    const finalSelectedPages = parseSelectedPages(selectedPages, job.total_pages);

    // Kul kagaz ki rok. Yahan isliye ki copies ka pata YAHIN chalta hai —
    // upload ke waqt customer ne copies chuni hi nahi hoti.
    const _sheetErr = checkSheetLimit(finalPages, effCopies);
    if (_sheetErr) return res.status(400).json({ error: _sheetErr, sheetLimit: true });
    // Duplex prices: agar owner ne set kiye hain (>0) to use, warna normal
    // rate hi lagta hai (backwards-compat + accidentally 0 rakhna safe)
    const _dupBw     = finalDuplex && parseFloat(job.price_bw_duplex) > 0;
    const _dupColor  = finalDuplex && parseFloat(job.price_color_duplex) > 0;
    const _rateBw    = _dupBw    ? job.price_bw_duplex    : job.price_bw;
    const _rateColor = _dupColor ? job.price_color_duplex : job.price_color;
    const pricePerPage = finalColorMode === 'color' ? _rateColor : _rateBw;
    // Duplex ka apna rate sach me laga ya nahi - slab usse upar nahi jaata
    const _dupRateUsed = finalColorMode === 'color' ? _dupColor : _dupBw;

    // -- PAGE-RANGE (SLAB) RATE --
    // Owner "itne se itne page tak = itna" set kar sakta hai. Wo daam HAR
    // PAGE ka rate hai, poore job ka nahi:
    //     8 page aur range 6-10 ka rate 1.5  =>  8 x 1.5 = 12
    //
    // Pehle isay poore job ka flat daam maana jaata tha - isi wajah se 4
    // page aur 8 page dono ka ek hi bill banta tha. Customer ne yahi pakda:
    // "8 print karo to 50 rs. aur 4 print karo to 50 rs."
    //
    // Owner ke apne khaas rate slab se UPAR rehte hain: duplex ka rate
    // yahin dekh liya, aur Resume / 4x6 / A3 neeche apne branch me amount
    // overwrite kar dete hain. customer.html ke getPerPageRate() me bilkul
    // yahi tarteeb hai - dono ka hisaab ek jaisa rehna zaroori hai, warna
    // customer ko dikhta kuch aur hai aur katta kuch aur.
    let ratePerPage = pricePerPage;
    if (!_dupRateUsed) {
      // Ginti = kitne KAGAZ nikal rahe hain (page x copies). 3 page ki
      // 3 copy = 9 kagaz, isliye 6-10 wali range lagegi. customer.html
      // ke getSlabPageCount() me bilkul yahi ginti banti hai.
      const _slab = slabPriceFor(job.page_slabs, finalColorMode,
                                 finalPages * effCopies);
      if (_slab !== null && _slab >= 0) ratePerPage = _slab;
    }

    // -- ADVANCE SERVICE PRICING -- resume: owner ka resume rate (color/bw)
    // x copies; photo4x6: sheet rate (4/6/8/10 photo) x copies; rate 0 ho to
    // normal per-page pricing fallback
    let amount = ratePerPage * finalPages * effCopies;
    if (job.service === 'resume') {
      const rRate = finalColorMode === 'color' ? (parseFloat(job.price_resume_color) || 0) : (parseFloat(job.price_resume_bw) || 0);
      if (rRate > 0) amount = rRate * effCopies;
    } else if (job.service === 'photo4x6') {
      // 12 ko SABSE UPAR rakha hai. Pehle iska koi branch tha hi nahi,
      // isliye 12-photo job aakhri fallback (4-photo rate) me gir jaati —
      // customer ko 12 photo 4 ke daam me mil jaate.
      const pRate = job.photo_count === 12 ? (parseFloat(job.price_4x6_12) || 0)
                 : job.photo_count === 10 ? (parseFloat(job.price_4x6_10) || 0)
                 : job.photo_count === 8 ? (parseFloat(job.price_4x6_8) || 0)
                 : job.photo_count === 6 ? (parseFloat(job.price_4x6_6) || 0)
                 : (parseFloat(job.price_4x6_4) || 0);
      if (pRate > 0) amount = pRate * effCopies;
    } else {
      // Big Size (A3/A2/A1) — owner ka apna per-page rate, set ho tabhi.
      // Duplex ke saath bhi big-size rate hi jeetta hai: bada kagaz
      // hi asli lagat hai, duplex uske andar aata hai.
      const bigRate = bigSizeRate(job, job.paper_size, finalColorMode);
      if (bigRate > 0) amount = bigRate * finalPages * effCopies;
    }
    amount = round2(amount);
    const txnId = 'COUNTER_' + uuidv4().substring(0,10).toUpperCase();

    await pool.query(
      'UPDATE print_jobs SET payment_status=$1, status=$2, payment_id=$3, color_mode=$4, copies=$5, total_pages=$6, selected_pages=$7, amount=$8, payment_method=$9, duplex=$10 WHERE id=$11',
      ['paid', 'queued', txnId, finalColorMode, effCopies, finalPages, finalSelectedPages.join(','), amount, 'counter', finalDuplex, jobId]
    );

    markShopHasWork(job.shop_id);   // agla poll turant utha lega
    console.log(`Counter payment: ${jobId} | Rs.${amount} | Pages: ${finalSelectedPages.join(',')}`);
    res.json({ success:true, txnId, amount });
  } catch(err) {
    console.error('Counter payment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════
// AGENT AUTO-UPDATE — Print Agent khud check karta hai naya version hai ya nahi
// ═══════════════════════════════════════════════

// ─── VERSION LABEL HELPERS (2.0 → 2.1 → ... → 2.10 → 3.0) ───────────
// Series rule: minor 0 se 10 tak jaata hai, 2.10 ke baad agla major (3.0).
// Internal integer counter isse alag hai aur sirf +1 hota rehta hai.
const VERSION_LABEL_RE = /^\d{1,3}\.\d{1,3}$/;

function parseVersionLabel(label) {
  // "2.10" → [2, 10].  Galat/khaali input par null.
  if (typeof label !== 'string') return null;
  const s = label.trim().replace(/^[vV]\.?/, '');
  if (!VERSION_LABEL_RE.test(s)) return null;
  const [maj, min] = s.split('.').map(n => parseInt(n, 10));
  if (!Number.isInteger(maj) || !Number.isInteger(min)) return null;
  return [maj, min];
}

function compareVersionLabels(a, b) {
  // -1 / 0 / 1. String compare use MAT karo: "2.9" > "2.10" aa jaata hai.
  const pa = parseVersionLabel(a), pb = parseVersionLabel(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  return 0;
}

function nextVersionLabel(current) {
  // Pehla push hamesha 2.0 hota hai (V29 ke baad naya scheme yahin se shuru).
  const p = parseVersionLabel(current);
  if (!p) return '2.0';
  const [maj, min] = p;
  return min >= 10 ? `${maj + 1}.0` : `${maj}.${min + 1}`;
}

async function getAgentVersionInfo() {
  const r = await pool.query(
    "SELECT key, value, updated_at FROM system_settings WHERE key IN ('agent_version','agent_version_label','agent_version_notes')"
  );
  const map = {};
  for (const row of r.rows) map[row.key] = row;
  const version = map.agent_version ? parseInt(map.agent_version.value, 10) || 1 : 1;
  const rawLabel = map.agent_version_label ? (map.agent_version_label.value || '') : '';
  const label = parseVersionLabel(rawLabel) ? rawLabel.trim() : '';
  // "What's in the Update" — super admin push ke waqt likhta hai, shop owner
  // ko download button ke paas dikhta hai. Khali ho sakta hai (optional).
  const notes = map.agent_version_notes ? String(map.agent_version_notes.value || '').trim() : '';
  const updatedAt = (map.agent_version_label && map.agent_version_label.updated_at)
    || (map.agent_version && map.agent_version.updated_at) || null;
  return { version, label, notes, updatedAt, nextLabel: nextVersionLabel(label) };
}

app.get('/api/agent/version', async (req, res) => {
  try {
    const info = await getAgentVersionInfo();
    // `version` purane agents ke liye hai (integer compare) — isko kabhi
    // hatana mat. `versionLabel` naye agents display ke liye padhte hain.
    res.json({
      version: info.version,
      versionLabel: info.label,
      // Agar label abhi set nahi hua to agent apna hi label dikhata rahega.
      displayVersion: info.label || String(info.version),
      // Shop owner ke panel me "What's in Update" isi se dikhta hai.
      // Purane agents is field ko ignore kar denge — kuch toota nahi.
      notes: info.notes,
      notesUpdatedAt: info.updatedAt
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Agent apni system pe installed printers ki list yahan bhejta hai (har
// startup pe aur har 30 min mein) — taaki dashboard mein owner ko dropdown
// se sahi printer naam dikh sakein, bina manually type kiye (typo-proof).
app.post('/api/agent/printers/:shopId', verifyAgent, async (req, res) => {
  try {
    const { printers } = req.body;
    if (!Array.isArray(printers)) return res.status(400).json({ error: 'printers array chahiye' });
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
      [`printers_${req.params.shopId}`, JSON.stringify(printers)]
    );
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Dashboard yeh endpoint se agent ki reported printer list fetch karta hai
app.get('/api/admin/printers', verifyToken, async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key=$1", [`printers_${req.shopId}`]);
    const printers = r.rows.length ? JSON.parse(r.rows[0].value) : [];
    res.json({ printers });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Agent yeh endpoint se naya code download karta hai (Shop ID/Server URL khud
// agent fill karega apni current values se, hum sirf raw template bhejte hain)
app.get('/api/agent/download-latest', async (req, res) => {
  try {
    const agentCode = fs.readFileSync(path.join(__dirname, 'agent-template', 'print_agent.py'), 'utf8');
    res.setHeader('Content-Type', 'text/plain');
    res.send(agentCode);
  } catch(err) {
    res.status(500).json({ error: 'Agent code load nahi hua: ' + err.message });
  }
});

// .exe mode agents ke liye — naya installer .exe seedha bhejte hain (silent
// install ke liye, .py code download karne ka koi matlab nahi exe mode mein
// kyunki compiled binary ko replace nahi kar sakte source se)
app.get('/api/agent/download-latest-exe', async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='easy_installer_url'");
    if (!r.rows.length || !r.rows[0].value) {
      return res.status(404).send('The latest installer is not available yet.');
    }
    res.redirect(r.rows[0].value);
  } catch(err) {
    res.status(500).send('Unable to load the installer: ' + err.message);
  }
});

app.get('/api/jobs/pending/:shopId', verifyAgent, async (req, res) => {
  try {
    // Agent heartbeat — dashboard ka Online/Offline indicator isi se chalta hai.
    // Agent apna version bhi bhejta hai (?v=), taaki superadmin dekh sake kis
    // shop par kaun sa version chal raha hai.
    // Heartbeat + shop info EK HI query me (pehle do alag queries thi).
    // Har agent har 5 second me poll karta hai — ek query kam matlab
    // roz lakhon round-trip kam, aur utna hi bandwidth bacha.
    const _av = parseInt(req.query.v, 10);
    // Naye agents apna display label bhi bhejte hain (?vl=2.0). Purane
    // agents yeh nahi bhejte — tab column ko chhed-chhaad se bachao.
    const _avl = (typeof req.query.vl === 'string' && VERSION_LABEL_RE.test(req.query.vl.trim()))
      ? req.query.vl.trim() : null;

    const _shopId = req.params.shopId;

    // ── HEARTBEAT: DB write nahi, memory me jama karo ──
    // Pehle har poll par ek UPDATE chalta tha (72 agents x har 5-12 sec).
    // Ab har 2 min me sabka ek saath batch UPDATE hota hai. Dashboard ka
    // Online/Offline 5 min ki window dekhta hai, isliye farak nahi padta.
    pendingHeartbeats.set(_shopId, {
      at: Date.now(),
      version: (Number.isInteger(_av) && _av > 0 && _av < 100000) ? _av : null,
      label: _avl
    });

    // ── FAST PATH 1: khatam ho chuka demo ──
    if (expiredDemoShops.has(_shopId)) {
      return res.json({ jobs: [], demo_expired: true });
    }

    // ── FAST PATH 2: is shop ka koi kaam hi nahi ──
    // YAHI SABSE BADI BACHAT HAI — 99.97% polls yahin khatam, DB chhue bina.
    if (!shopsWithWork.has(_shopId)) {
      const info = await getShopInfoCached(_shopId);
      if (info && info.demo &&
          isDemoExpired({ demo: true, demo_expires_at: info.demoExpiresAt })) {
        expiredDemoShops.add(_shopId);
        return res.json({ jobs: [], demo_expired: true });
      }

      // ── LONG POLL ──
      // Agent `?lp=30` bheje to line pakde rakho. PURANA agent ye nahi
      // bhejta (uska timeout sirf 20 sec hai) — use turant khaali jawab
      // milta hai, bilkul pehle jaisa.
      const _lp = Math.min(LP_MAX_SEC, parseInt(req.query.lp, 10) || 0);
      if (_lp > 0) {
        const woke = await waitForWork(_shopId, _lp, req);
        if (!woke) return res.json({ jobs: [] });
      } else {
        return res.json({ jobs: [] });
      }
    }

    // ── Yahan se aage: sach me koi job hai. Ab DB kaam ki hai. ──
    const shopRow = await pool.query(
      'SELECT demo, demo_expires_at FROM shops WHERE id = $1', [_shopId]);
    if (shopRow.rows.length && shopRow.rows[0].demo) {
      const sh = shopRow.rows[0];
      // Layer 3: ek machine = ek demo PERMANENT. Agent ?m=MachineGuid bhejta
      // hai; is machine par pehle KISI AUR demo ka record hai to yeh demo
      // turant expire — naya number/IP kuch kaam nahi aayega.
      const m = String(req.query.m || '').trim().slice(0, 90);
      if (m) {
        const mc = await pool.query('SELECT shop_id FROM demo_machines WHERE machine_id=$1', [m]);
        if (!mc.rows.length) {
          await pool.query('INSERT INTO demo_machines (machine_id, shop_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [m, req.params.shopId]);
        } else if (mc.rows[0].shop_id !== req.params.shopId) {
          await pool.query('UPDATE shops SET demo_expires_at=NOW() WHERE id=$1', [req.params.shopId]);
          console.log(`Demo machine-lock: ${req.params.shopId} expired (machine pehle ${mc.rows[0].shop_id} use kar chuki)`);
          return res.json({ jobs: [], demo_expired: true });
        }
      }
      if (isDemoExpired({ demo: true, demo_expires_at: sh.demo_expires_at })) {
        expiredDemoShops.add(_shopId);   // agla poll DB tak aayega hi nahi
        return res.json({ jobs: [], demo_expired: true });
      }
    }

    // ATOMIC CLAIM: job dete hi status 'printing' ho jata hai. Pehle jobs
    // 'queued' hi rehte the fetch ke baad — bade PDF ke print ke दौरान agla
    // poll wahi job dobara utha ke DOUBLE PRINT kar deta tha, aur crashed
    // agent ka job detect karne ka koi tarika nahi tha. FOR UPDATE SKIP
    // LOCKED se do parallel polls me bhi ek job do baar claim nahi hota.
    const r = await pool.query(
      `UPDATE print_jobs j SET status='printing', printing_at=NOW()
       FROM shops s
       WHERE j.id IN (
         SELECT j2.id FROM print_jobs j2 JOIN shops s2 ON j2.shop_id=s2.id
         WHERE j2.shop_id=$1 AND j2.payment_status='paid' AND s2.setup_paid=true
           AND (
                j2.status='queued'
                -- ORPHAN RECOVERY:
                -- Job 'printing' me hai par kaafi der se koi halchal nahi.
                -- Aisa tab hota hai jab claim to ho gaya par response agent
                -- tak pahuncha hi nahi (idle ke baad socket mar jaana,
                -- timeout, ya agent restart). Pehle aisa job kabhi dobara
                -- nahi milta tha aur 120s baad file delete ho jaati thi —
                -- customer ka paisa lag jaata, print kabhi nahi nikalta.
                -- Ek shop par ek hi agent hota hai, isliye dobara dena safe
                -- hai; agent apni taraf se duplicate print rok leta hai.
                OR (j2.status='printing'
                    AND j2.printing_at < NOW() - ($2 || ' seconds')::interval)
               )
         ORDER BY j2.created_at ASC LIMIT 5
         FOR UPDATE OF j2 SKIP LOCKED
       ) AND s.id=j.shop_id
       RETURNING j.id,j.file_name,j.file_url,j.file_public_id,j.file_type,j.copies,j.color_mode,
                 j.total_pages,j.selected_pages,j.amount,j.payment_method,j.created_at,j.duplex,
                 j.paper_size,j.orientation,
                 s.printer_name_bw,s.printer_name_color,s.printer_name_4x6,s.printer_name_a3,
                 s.printer_name_duplex,s.duplex_mode`,
      [req.params.shopId, String(ORPHAN_RECLAIM_SEC)]
    );
    if (r.rows.length) {
      const re = r.rows.filter(j => j.printing_at);
      if (re.length) console.log(`♻️ Re-delivering ${re.length} orphaned job(s) to ${req.params.shopId}`);
    }
    res.json({ jobs: r.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════
// DIRECT CLOUDINARY DOWNLOAD — Render PDF proxy NAHI hai
// ═══════════════════════════════════════════════
// Architecture (pehle se aisa hi hai, ab authorize bhi hota hai):
//
//   Customer → Cloudinary        (browser se seedha, /upload/sign)
//   Render   → sirf metadata     (job id, settings, status)
//   Agent    → Cloudinary        (PDF seedha, Render se hoke NAHI)
//
// PDF bytes kabhi Render se nahi guzarte. Ye endpoint sirf AUTHORIZATION
// deta hai: agent poochta hai "is job ki file kahan hai?", server job ka
// maalik/paid/claimed status verify karke URL deta hai. Bytes Cloudinary
// se seedha shop PC par jaate hain.
const DOWNLOAD_URL_TTL_SEC = parseInt(process.env.DOWNLOAD_URL_TTL_SEC || '900', 10);

app.get('/api/jobs/:shopId/:jobId/download-url', verifyAgent, async (req, res) => {
  try {
    const { shopId, jobId } = req.params;
    const r = await pool.query(
      `SELECT j.id, j.shop_id, j.status, j.payment_status, j.file_url, j.file_public_id,
              j.file_deleted, j.file_type, j.printing_at
         FROM print_jobs j WHERE j.id=$1`, [jobId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Job not found' });
    const j = r.rows[0];

    // Doosri shop ka job kabhi mat do
    if (j.shop_id !== shopId) {
      await logSecurityEvent({ ip: clientIp(req), shopId, endpoint: '/download-url', method: 'GET',
        action: 'FILE_ACCESS', reason: 'WRONG_SHOP:' + jobId, userAgent: req.headers['user-agent'] });
      return res.status(403).json({ error: 'This job does not belong to this shop' });
    }
    // Bina payment ke file kabhi nahi
    if (j.payment_status !== 'paid') {
      return res.status(403).json({ error: 'Job is not paid yet' });
    }
    // Sirf claimed job ('printing') — printed/failed job dobara download na ho
    if (j.status !== 'printing') {
      return res.status(409).json({ error: `Job is not claimed (status: ${j.status})`, status: j.status });
    }
    if (j.file_deleted || !j.file_url) {
      return res.status(410).json({ error: 'File has already been deleted' });
    }

    res.json({
      jobId: j.id,
      downloadUrl: j.file_url,          // Cloudinary ka seedha URL
      fileType: j.file_type || 'pdf',
      expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SEC * 1000).toISOString()
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════
// DEMO → PAID SHOP CONVERSION
// ═══════════════════════════════════════════════
// Ye purely BACKEND-controlled hai. Client sirf DEMO_xxx ko SHOP_xxx se
// badal kar apne aap paid nahi ban sakta — server har cheez verify karta
// hai aur agent ka token bhi wahi transfer karta hai.
//
// Sabse badi security baat: sirf Shop ID kaafi NAHI hai.
// Shop ID customer ke QR/poster par chhapa hota hai — dusre ki shop ka ID
// dekh kar koi bhi uski shop apne PC se hijack kar leta. Isliye conversion
// ke liye us paid shop ka PASSWORD bhi maangte hain (wahi jo shop owner
// dashboard login me use karta hai).

/** Paid Shop ID + password verify karo — abhi kuch badla nahi jaata. */
app.post('/api/agent/verify-paid-shop', verifyAgent, async (req, res) => {
  const ip = clientIp(req);
  try {
    const demoShopId = String(req.agentShopId || req.params.shopId
                              || req.body.demoShopId || '').trim();
    const paidShopId = String(req.body.paidShopId || '').trim().toUpperCase();
    const password   = String(req.body.password || '');

    if (!paidShopId) return res.status(400).json({ error: 'Please enter your paid Shop ID' });
    if (!password)   return res.status(400).json({ error: 'Please enter your shop password' });

    // Brute force guard — Shop ID public hai, password guessing rokna zaroori
    const blocked = isBlocked('convert:' + ip);
    if (blocked) {
      return res.status(429).json({ error: `Too many attempts. Please try again in ${blocked} minute(s).` });
    }

    const r = await pool.query(
      `SELECT id, name, phone, demo, demo_expires_at, setup_paid, password_hash,
              plan_type, billing_cycle, paid_until, agent_token
         FROM shops WHERE id=$1`, [paidShopId]);

    if (!r.rows.length) {
      _convertFail(ip, paidShopId, 'NOT_FOUND');
      return res.status(404).json({ error: 'This Shop ID was not found. Please check and try again.' });
    }
    const shop = r.rows[0];

    if (!shop.password_hash || !(await verifyPassword(password, shop.password_hash))) {
      _convertFail(ip, paidShopId, 'BAD_PASSWORD');
      return res.status(403).json({ error: 'Shop ID or password is incorrect.' });
    }
    // Password sahi — attempts reset
    convertAttempts.delete(ip);

    if (shop.demo) {
      return res.status(400).json({ error: 'That Shop ID is also a demo account. Enter your paid Shop ID.' });
    }
    if (!shop.setup_paid) {
      return res.status(403).json({ error: 'This shop is not activated yet. Please complete your registration first.' });
    }
    if (paidShopId === demoShopId) {
      return res.status(400).json({ error: 'This is already the shop you are using.' });
    }

    // Ek short-lived ticket — actual switch isi ke saath hoga, taaki
    // password dobara na bhejna pade aur switch call ko replay na kiya ja sake.
    const ticket = jwt.sign(
      { demoShopId, paidShopId, act: 'demo-convert' }, JWT_SECRET, { expiresIn: '10m' });

    console.log(`Demo conversion verified: ${demoShopId} -> ${paidShopId} | ip ${ip}`);
    res.json({
      success: true, ticket,
      shopId: shop.id, shopName: shop.name,
      planType: shop.plan_type || 'monthly',
      alreadyLinked: !!shop.agent_token   // us shop par pehle se koi PC juda hai
    });
  } catch(err) {
    console.error('verify-paid-shop error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Password guessing par escalating temporary block (permanent ban kabhi nahi)
const convertAttempts = new Map();
function _convertFail(ip, shopId, reason) {
  const n = (convertAttempts.get(ip) || 0) + 1;
  convertAttempts.set(ip, n);
  if (n >= 5) blockFor('convert:' + ip, SEC.blockMin, 'paid shop conversion brute force');
  logSecurityEvent({ ip, shopId, endpoint: '/api/agent/verify-paid-shop', method: 'POST',
                     action: 'DEMO_CONVERT', reason, uploadCount: n });
}

/** Ticket ke saath actual switch. Agent token demo se paid shop par move hota hai. */
app.post('/api/agent/convert-to-paid', verifyAgent, async (req, res) => {
  const client = await pool.connect();
  try {
    // Pehle yahan `req.params.shopId` tha -- par is route me koi :shopId
    // param hai hi nahi, to ye HAMESHA khaali aata tha aur neeche wala
    // check hamesha fail hota tha ("Verification does not match this
    // installation"). verifyAgent ab shopId nikaal kar req.agentShopId
    // me rakh deta hai (params / body / ticket -- jo mile).
    const demoShopId = String(req.agentShopId || req.params.shopId || '').trim();
    let payload;
    try {
      payload = jwt.verify(String(req.body.ticket || ''), JWT_SECRET);
    } catch (e) {
      return res.status(403).json({ error: 'Verification expired. Please verify your Shop ID again.' });
    }
    if (payload.act !== 'demo-convert' || payload.demoShopId !== demoShopId) {
      return res.status(403).json({ error: 'Verification does not match this installation.' });
    }
    const paidShopId = payload.paidShopId;

    await client.query('BEGIN');

    const paid = await client.query(
      'SELECT id, name, demo, setup_paid FROM shops WHERE id=$1 FOR UPDATE', [paidShopId]);
    if (!paid.rows.length || paid.rows[0].demo || !paid.rows[0].setup_paid) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This shop can no longer be linked. Please contact support.' });
    }

    // Agent token demo shop se hata kar paid shop par lagao — isi se ye PC
    // paid shop ka authorized agent ban jaata hai.
    const sentToken = agentTokenFromReq(req);
    if (sentToken && /^[A-Za-z0-9_-]{16,64}$/.test(sentToken)) {
      await client.query('UPDATE shops SET agent_token=$2 WHERE id=$1', [paidShopId, sentToken]);
      await client.query('UPDATE shops SET agent_token=NULL WHERE id=$1', [demoShopId]);
      invalidateAgentToken(demoShopId);   // cache saaf — warna disconnect ka asar nahi hoga
    }

    // Demo ko abhi khatam kar do — wo PC ab paid shop chala raha hai
    await client.query(
      "UPDATE shops SET demo_expires_at = NOW() WHERE id=$1 AND demo=true", [demoShopId]);

    // Demo ke bache hue queued jobs cancel — warna purane demo jobs
    // naye paid shop ke printer par nikal sakte hain
    const cancelled = await client.query(
      `UPDATE print_jobs SET status='cancelled',
              failure_reason='Demo converted to paid shop'
        WHERE shop_id=$1 AND status IN ('queued','printing') RETURNING id, file_public_id`,
      [demoShopId]);

    await client.query('COMMIT');

    for (const j of cancelled.rows) {
      if (j.file_public_id) {
        try { await deleteFromCloudinary(j.file_public_id); } catch(_) {}
      }
    }

    console.log(`Demo CONVERTED: ${demoShopId} -> ${paidShopId} | ${cancelled.rows.length} demo job(s) cancelled`);
    res.json({ success: true, shopId: paidShopId, shopName: paid.rows[0].name });
  } catch(err) {
    try { await client.query('ROLLBACK'); } catch(_) {}
    console.error('convert-to-paid error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════
// SHOP ID CLAIM — ek Shop ID sirf EK PC par
// ═══════════════════════════════════════════════
// Pehle agent Shop ID verify karne ke liye /api/shop/:id call karta tha.
// Wo PUBLIC endpoint hai (customer bhi use karta hai) — use pata hi nahi
// hota ki kaunsa PC hai. Isliye koi bhi QR poster se Shop ID padh kar
// apne PC me daal deta aur "verified" ho jaata.
//
// Job polling to pehle se protected thi (galat token = 403), par user ko
// wo error baad me ajeeb tarike se dikhta tha. Ab shuru me hi saaf mana
// kar dete hain.
app.post('/api/agent/claim/:shopId', async (req, res) => {
  try {
    const shopId = String(req.params.shopId || '').trim().toUpperCase();
    const sent = agentTokenFromReq(req);
    const machine = String((req.body && req.body.machine) || '').slice(0, 100);

    const r = await pool.query(
      'SELECT id, name, agent_token, agent_machine, agent_bound_at, demo, setup_paid FROM shops WHERE id=$1',
      [shopId]);
    if (!r.rows.length) {
      return res.status(404).json({ error: 'This Shop ID was not found on the server. Please check it.' });
    }
    const shop = r.rows[0];

    if (!sent || !/^[A-Za-z0-9_-]{16,64}$/.test(sent)) {
      return res.status(400).json({ error: 'Please install the latest Echel print agent.' });
    }

    // Pehle se isi PC par juda hai — dobara install/kholne par sab theek
    if (shop.agent_token && shop.agent_token === sent) {
      await pool.query(
        'UPDATE shops SET agent_machine=COALESCE(NULLIF($2,\'\'), agent_machine) WHERE id=$1',
        [shopId, machine]);
      return res.json({ success: true, shopId: shop.id, shopName: shop.name, rebound: false });
    }

    // Kisi DOOSRE PC par juda hua hai — mana kar do
    if (shop.agent_token && shop.agent_token !== sent) {
      await logSecurityEvent({
        ip: clientIp(req), shopId, endpoint: '/api/agent/claim', method: 'POST',
        action: 'SHOP_CLAIM', reason: 'ALREADY_BOUND',
        userAgent: req.headers['user-agent']
      });
      const on = shop.agent_machine ? ` (${shop.agent_machine})` : '';
      return res.status(409).json({
        error: `This Shop ID is already in use on another computer${on}. `
             + `Open Shop Login → Settings → "Disconnect Computer" to disconnect the previous computer, then try again.`,
        code: 'ALREADY_BOUND',
        boundMachine: shop.agent_machine || null,
        boundAt: shop.agent_bound_at || null
      });
    }

    // Khaali hai — ye PC bind ho jaye
    await pool.query(
      'UPDATE shops SET agent_token=$2, agent_machine=$3, agent_bound_at=NOW() WHERE id=$1 AND agent_token IS NULL',
      [shopId, sent, machine || null]);
    console.log(`Agent bound: ${shopId} -> ${machine || 'unknown PC'}`);
    res.json({ success: true, shopId: shop.id, shopName: shop.name, rebound: true });
  } catch (err) {
    console.error('agent claim error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Superadmin kisi bhi shop ka PC hata sakta hai — shop owner ka computer
// achanak kharab ho jaye to wo aapko call karke turant naya PC laga sake.
// Demo aur paid dono par chalta hai.
// ══════════════════════════════════════════════════════════════
//  UNBLOCK — abuse-block hata do (server restart ki zaroorat nahi)
//  Block in-memory Maps me rehta hai, DB me nahi. Pehle ise hatane ka
//  EK HI tarika tha: poora Render restart — jo baaki sab shops ka print
//  bhi kuch second rok deta tha.
// ══════════════════════════════════════════════════════════════
app.post('/api/superadmin/shop/:shopId/unblock', verifySuperAdmin, async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const wasBlocked = isBlocked('shop:' + shopId);
    abuseBlocks.delete('shop:' + shopId);
    uploadHits.delete(shopId);          // quota ginti bhi zero
    console.log(`Unblocked by superadmin: ${shopId} (pehle ${wasBlocked} min baaki the)`);
    res.json({ success: true, shopId, wasBlockedMinutes: wasBlocked });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/shop/:shopId/agent-disconnect', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE shops SET agent_token=NULL, agent_machine=NULL, agent_bound_at=NULL
        WHERE id=$1 RETURNING id, name, agent_machine`, [req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    invalidateAgentToken(req.params.shopId);   // cache saaf — warna disconnect ka asar nahi
    console.log(`Agent disconnected by SUPERADMIN: ${req.params.shopId} (${r.rows[0].name})`);
    res.json({ success: true, shopId: r.rows[0].id, wasOn: r.rows[0].agent_machine || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Shop owner apna PC hata sakta hai (naya computer, Windows reinstall)
app.post('/api/admin/agent/disconnect', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE shops SET agent_token=NULL, agent_machine=NULL, agent_bound_at=NULL
        WHERE id=$1 RETURNING id, agent_machine`, [req.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    invalidateAgentToken(req.shopId);   // cache saaf — warna disconnect ka asar nahi
    console.log(`Agent disconnected by shop owner: ${req.shopId}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── DESKTOP PANEL SESSION ───────────────────────────────────────
// Desktop panel ko shop settings/pricing/payment sab dikhane hain. Wahi
// business logic dobara likhne ke bajaye, agent apne agent_token ko ek
// SHORT-LIVED admin session token se exchange karta hai aur wahi existing
// admin APIs call karta hai jo website ka dashboard call karta hai.
// Zero duplicate logic, zero naya database.
app.post('/api/jobs/:shopId/panel-session', verifyAgent, async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const r = await pool.query('SELECT id, name, demo, demo_expires_at FROM shops WHERE id=$1', [shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });

    // 2 ghante — panel khula reh sakta hai, par token hamesha ke liye valid nahi.
    const token = jwt.sign({ shopId, via: 'agent-panel' }, JWT_SECRET, { expiresIn: '2h' });
    res.json({
      token,
      expiresInSec: 7200,
      shopId,
      shopName: r.rows[0].name,
      // shop_type backend se aata hai — client sirf DEMO_ prefix dekh kar
      // decide na kare (spec: backend is the source of truth)
      shopType: r.rows[0].demo ? 'demo' : 'paid',
      demoExpiresAt: r.rows[0].demo_expires_at
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Agent bolta hai "download ho gaya" — sirf metadata, koi file nahi.
// Isse admin panel me pata chalta hai ki file shop PC tak pahunchi ya nahi.
app.post('/api/jobs/:shopId/:jobId/downloaded', verifyAgent, async (req, res) => {
  try {
    const { shopId, jobId } = req.params;
    const ok = !!(req.body && req.body.ok);
    const bytes = parseInt(req.body && req.body.bytes, 10);
    if (!ok) {
      await pool.query(
        `UPDATE print_jobs SET failure_reason=$2 WHERE id=$1 AND shop_id=$3 AND status='printing'`,
        [jobId, String(req.body.error || 'Download failed').slice(0, 200), shopId]);
      console.warn(`Job download FAILED: ${jobId} | ${shopId} | ${req.body.error || ''}`);
    } else {
      console.log(`Job downloaded by agent: ${jobId} | ${shopId}` +
                  (Number.isFinite(bytes) ? ` | ${bytes} bytes` : ''));
    }
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Agent Online/Offline status (dashboard indicator) ──
app.get('/api/shop/:shopId/agent-status', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT agent_last_seen, agent_bound_at, agent_version FROM shops WHERE id=$1',
      [req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    const row = r.rows[0];
    const last = row.agent_last_seen;
    const secondsAgo = last ? Math.round((Date.now() - new Date(last).getTime()) / 1000) : null;
    // `installed` = agent kabhi bhi is shop se juda tha kya. Ye sthir cheez
    // hai — PC band ho ya net gaya ho, tab bhi badalti nahi. Panel ka chip
    // isi par chalta hai, taaki owner ko har 10 second par status badalta
    // hua na dikhe. online/seconds_ago waise ke waise hain (purana code
    // aur agent dono inhe abhi bhi padhte hain).
    const installed = !!(row.agent_bound_at || row.agent_version || last);
    res.json({
      installed,
      online: secondsAgo !== null && secondsAgo < 45,
      seconds_ago: secondsAgo,
      last_seen: last
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/complete/:jobId', async (req, res) => {
  try {
    // Sirf active job hi 'printed' ban sakta hai. Late/duplicate report par
    // (job pehle hi printed/failed) chupchaap success — agent retry karta
    // hai, use error nahi chahiye. Requeued ('queued') job ka late complete
    // aana ACHHA hai — matlab print asal me ho chuka tha, dubara nahi hoga.
    const result = await pool.query(
      `UPDATE print_jobs SET status=$1, printed_at=NOW()
       WHERE id=$2 AND status NOT IN ('printed','failed','abandoned')
       RETURNING file_public_id`,
      ['printed', req.params.jobId]
    );
    if (!result.rows.length) return res.json({ success: true, already: true });
    if (result.rows.length && result.rows[0].file_public_id) {
      await deleteFromCloudinary(result.rows[0].file_public_id);
      await pool.query('UPDATE print_jobs SET file_deleted=true WHERE id=$1', [req.params.jobId]);
    }
    console.log(`Printed + Deleted: ${req.params.jobId}`);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/failed/:jobId', async (req, res) => {
  try {
    const reason = (req.body && req.body.reason) || '';
    const result = await pool.query(
      `UPDATE print_jobs SET status=$1, failure_reason=$2
       WHERE id=$3 AND status NOT IN ('printed','abandoned')
       RETURNING file_public_id`,
      ['failed', reason.slice(0, 200), req.params.jobId]);
    if (!result.rows.length) return res.json({ success: true, already: true });
    // Deny/fail par bhi customer ki file Cloudinary se saaf — warna orphan
    // files jama hoti rehti (privacy + storage dono)
    if (result.rows.length && result.rows[0].file_public_id) {
      await deleteFromCloudinary(result.rows[0].file_public_id);
      await pool.query('UPDATE print_jobs SET file_deleted=true WHERE id=$1', [req.params.jobId]);
    }
    console.log(`Job failed/denied: ${req.params.jobId}${reason ? ' | ' + reason : ''}`);
    res.json({ success:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/jobs/status/:jobId', async (req, res) => {
  try {
    const r = await pool.query('SELECT id,status,payment_status,amount,payment_method,created_at,printed_at FROM print_jobs WHERE id=$1', [req.params.jobId]);
    if (!r.rows.length) return res.status(404).json({ error:'Not found' });
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── Setup ke baad Print Agent Package Download ───
// Sirf paid (setup_paid=true) shops ke liye kaam karta hai
// ─── EASY INSTALLER (.exe) — Non-technical shop owners ke liye ───
// Yeh single .exe deta hai jisme Python + SumatraPDF + Agent sab bundled hain.
// Shop ID ko exe ke saath ek chhoti config file (shop_config.txt) mein bhejte
// hain jise installer khud padh ke print_agent ko configure kar dega.
app.get('/api/download/easy-installer/:shopId', async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const r = await pool.query('SELECT id, setup_paid FROM shops WHERE id=$1', [shopId]);
    if (!r.rows.length) return res.status(404).send('Shop not found');
    if (!r.rows[0].setup_paid) return res.status(403).send('Setup fee pehle complete karo');

    const urlResult = await pool.query("SELECT value FROM system_settings WHERE key='easy_installer_url'");
    if (!urlResult.rows.length || !urlResult.rows[0].value) {
      return res.status(404).send('Easy Installer abhi available nahi hai. ZIP wala (Python+INSTALL.bat) version use karo neeche se, ya thodi der baad try karo.');
    }

    res.redirect(urlResult.rows[0].value);
  } catch(err) {
    res.status(500).send('Installer download error: ' + err.message);
  }
});

app.get('/api/download/agent-package/:shopId', async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const r = await pool.query('SELECT id, name, setup_paid FROM shops WHERE id=$1', [shopId]);
    if (!r.rows.length) return res.status(404).send('Shop not found');
    if (!r.rows[0].setup_paid) return res.status(403).send('Setup fee pehle complete karo');

    const shopName = r.rows[0].name;

    // print_agent.py template padhke us mein Shop ID fill karo
    let agentCode = fs.readFileSync(path.join(__dirname, 'agent-template', 'print_agent.py'), 'utf8');
    agentCode = agentCode.replace('AAPKA_SHOP_ID', shopId);
    agentCode = agentCode.replace(
      'SERVER_URL         = "https://echel.in"',
      `SERVER_URL         = "${BASE_URL}"`
    );

    const installBat = fs.readFileSync(path.join(__dirname, 'agent-template', 'INSTALL.bat'), 'utf8');

    const readme = `ECHEL — PRINT CONNECT

Shop: ${shopName}
Shop ID: ${shopId}

1. Display QR-Code.png at your shop counter.
2. Right-click INSTALL.bat and choose Run as Administrator.
3. Start RUN_AGENT.bat, then select your printers in the Echel panel.
4. Scan the QR code, upload a test document, complete payment and check the print.

Keep the computer and printer switched on while accepting print jobs.
Use the tray icon to open the panel or exit the agent.
Choose the startup option during installation to launch Echel automatically.
The agent checks for updates while it is running.

Dashboard: ${BASE_URL}/admin
Setup guide: ${BASE_URL}/setup-guide
Support: ${BASE_URL}/contact
`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Echel-Setup-${shopId}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    archive.append(agentCode, { name: 'print_agent.py' });
    archive.file(path.join(__dirname, 'agent-template', 'agent_panel.py'), { name: 'agent_panel.py' });
    archive.file(path.join(__dirname, 'agent-template', 'agent_panel.html'), { name: 'agent_panel.html' });
    archive.append(installBat, { name: 'INSTALL.bat' });
    archive.append(readme, { name: 'README.txt' });
    archive.append(JSON.stringify({ serverUrl: BASE_URL }), { name: 'echel-server.json' });

    // QR code image bhi add karo (base64 se PNG banake)
    const qrResult = await pool.query('SELECT qr_code FROM shops WHERE id=$1', [shopId]);
    if (qrResult.rows.length && qrResult.rows[0].qr_code) {
      const base64Data = qrResult.rows[0].qr_code.replace(/^data:image\/png;base64,/, '');
      archive.append(Buffer.from(base64Data, 'base64'), { name: 'QR-Code.png' });
    }

    archive.finalize();
  } catch(err) {
    console.error('Download package error:', err.message);
    res.status(500).send('Package banane mein error: ' + err.message);
  }
});



// ═══════════════════════════════════════════════
// SUPER ADMIN APIs — Rupesh ka khud ka panel, sab shops dekhne ke liye
// ═══════════════════════════════════════════════

function verifySuperAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Login required' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'super_admin') throw new Error('Not super admin');
    next();
  } catch(err) {
    return res.status(401).json({ error: 'Session expired, please login again' });
  }
}

app.post('/api/superadmin/login', loginLimiter, async (req, res) => {
  try {
    // Captcha — band ho to ye line chup-chaap nikal jaati hai
    if (!(await captchaGuard(req, res))) return;
    if (!SUPER_ADMIN_ID || !SUPER_ADMIN_PASSWORD) {
      return res.status(500).json({ error: 'Super Admin abhi configure nahi hua hai. Render environment variables check karo.' });
    }
    const { adminId, password } = req.body;
    if (adminId !== SUPER_ADMIN_ID || password !== SUPER_ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'ID ya Password galat hai' });
    }
    const token = jwt.sign({ role: 'super_admin', adminId }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══ ADMIN BROADCAST (superadmin → sabhi shops ko dikhne wala message) ═══
// Superadmin ek message likhta hai, wo har shop ke Overview par dikhta hai.
// system_settings (key/value) table reuse — koi nayi table nahi.

// Shop panel isse fetch karta hai (public, token nahi chahiye)
app.get('/api/admin-broadcast', async (req, res) => {
  try {
    // White-label ki shop ko RESELLER ka message dikhega, hamara nahi —
    // warna do alag brand ke message ek hi dashboard me mix ho jaate.
    const shopId = String(req.query.shopId || '').trim();
    if (shopId) {
      const s = await pool.query('SELECT whitelabel_id FROM shops WHERE id=$1', [shopId]);
      const wlId = s.rows[0]?.whitelabel_id || '';
      if (wlId) {
        const w = await pool.query('SELECT broadcast FROM whitelabels WHERE id=$1', [wlId]);
        return res.json({ message: w.rows[0]?.broadcast || '' });
      }
    }
    const r = await pool.query("SELECT value FROM system_settings WHERE key='admin_broadcast'");
    res.json({ message: r.rows.length ? r.rows[0].value : '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Superadmin isse save karta hai (khali bhejo to message hat jayega)
app.post('/api/superadmin/admin-broadcast', verifySuperAdmin, async (req, res) => {
  try {
    const message = (req.body && typeof req.body.message === 'string') ? req.body.message.trim().slice(0, 500) : '';
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('admin_broadcast', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [message]
    );
    res.json({ success: true, message });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══ QR REGENERATE (sabhi shops ke QR current BASE_URL se naye banao) ═══
// Kyun: purane QR tab bane the jab BASE_URL onrender.com tha — us image ke
// andar purana URL encode hai. Ye route har shop ka QR dobara banata hai
// current BASE_URL se. Jinke QR pehle se sahi (echel.in) hain, unka
// naya QR bilkul same banega — koi nuksaan nahi. Jinke purane onrender
// wale hain, wo sahi ho jayenge.
app.post('/api/superadmin/regenerate-qrs', verifySuperAdmin, async (req, res) => {
  try {
    const shops = await pool.query('SELECT id FROM shops');
    let done = 0, failed = 0;
    for (const row of shops.rows) {
      try {
        const qrUrl = `${BASE_URL}/print/${row.id}`;
        const qrCode = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 });
        await pool.query('UPDATE shops SET qr_code=$1 WHERE id=$2', [qrCode, row.id]);
        done++;
      } catch (e) {
        failed++;
        console.error(`QR regen fail for ${row.id}:`, e.message);
      }
    }
    res.json({ success: true, total: shops.rows.length, regenerated: done, failed, base_url: BASE_URL });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Superadmin -> shop agent notification (counter-popup jaisa)
app.post('/api/superadmin/notify-shop', verifySuperAdmin, async (req, res) => {
  try {
    const { shop_id, message } = req.body || {};
    if (!shop_id) return res.status(400).json({ error: 'shop_id chahiye' });
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['notify_' + shop_id, message || 'Any Problem in Printing? Contact Admin']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Agent isse poll ke saath uthata hai, dikha ke ack karta hai
app.get('/api/agent/notification/:shopId', async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key=$1", ['notify_' + req.params.shopId]);
    res.json({ message: r.rows.length ? r.rows[0].value : '' });
  } catch (err) { res.json({ message: '' }); }
});
app.post('/api/agent/notification-ack/:shopId', async (req, res) => {
  try {
    await pool.query("DELETE FROM system_settings WHERE key=$1", ['notify_' + req.params.shopId]);
    res.json({ success: true });
  } catch (err) { res.json({ success: false }); }
});

app.get('/api/superadmin/overview', verifySuperAdmin, async (req, res) => {
  try {
    // Overview ab sirf shop ki ginti dikhata hai — paisa Analytics me hai,
    // do jagah same number rakhne se confusion hota hai.
    // AHEM: white-label ki shops HAMARI shops nahi hain — wo reseller ki
    // hain aur unka setup fee seedha reseller ke Razorpay me jaata hai.
    // Pehle ye 'pending' me gin li jaati thi (setup_paid=false hone ki
    // wajah se) jabki Shops list unhe dikhati hi nahi thi — isliye
    // "Pending 5" dikhta tha par list khali rehti thi.
    // Ab har jagah ek hi niyam: WL = alag, apne tab me.
    const WL = `COALESCE(whitelabel_id,'') = ''`;
    const shopCount = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE ${WL})::int AS total,
        COUNT(*) FILTER (WHERE ${WL} AND demo = false AND setup_paid = true)::int  AS active,
        COUNT(*) FILTER (WHERE ${WL} AND demo = false AND setup_paid = false)::int AS pending,
        COUNT(*) FILTER (WHERE ${WL} AND demo = true
              AND (demo_expires_at IS NULL OR demo_expires_at > NOW()))::int AS demo_live,
        COUNT(*) FILTER (WHERE ${WL} AND demo = true
              AND demo_expires_at IS NOT NULL AND demo_expires_at <= NOW())::int AS demo_expired,
        COUNT(*) FILTER (WHERE ${WL} AND demo = false AND (${CYCLE_SQL}) <> 'lifetime')::int AS monthly,
        COUNT(*) FILTER (WHERE COALESCE(whitelabel_id,'') <> '')::int AS whitelabel_shops
      FROM shops`);

    // Revenue: sirf WO paisa jo HUMARE account me aaya.
    // White-label shops ka setup fee reseller ka hai — isliye total me nahi.
    const earnings = await pool.query(`
      SELECT
        COALESCE(SUM(setup_amount) FILTER (WHERE setup_paid AND ${WL}), 0)::int as total_setup_revenue,
        COUNT(*) FILTER (WHERE setup_paid AND ${WL})::int as paid_shops
      FROM shops
    `);
    // Advanced unlock + renewal + WL license — ab ledger se aata hai
    const ledger = await pool.query(`
      SELECT kind, COALESCE(SUM(amount),0)::int AS amt, COUNT(*)::int AS cnt
      FROM platform_payments GROUP BY kind`);
    const byKind = {};
    ledger.rows.forEach(r => { byKind[r.kind] = { amount: r.amt, count: r.cnt }; });

    // Print volume = shop owner ka customer se aaya paisa. Ye HUMARI
    // kamai nahi hai — isliye alag field me jaata hai, total me nahi.
    const printEarnings = await pool.query(
      `SELECT COALESCE(SUM(amount),0) as total FROM print_jobs WHERE ${JOB_COUNTS}`);

    res.json({
      total_shops:   shopCount.rows[0].total,
      active_shops:  shopCount.rows[0].active,
      pending_shops: shopCount.rows[0].pending,
      demo_shops:    shopCount.rows[0].demo_live,
      demo_expired:  shopCount.rows[0].demo_expired,
      monthly_shops: shopCount.rows[0].monthly,
      whitelabel_shops: shopCount.rows[0].whitelabel_shops,
      total_setup_revenue: earnings.rows[0].total_setup_revenue,
      advanced_revenue:  byKind.advanced?.amount   || 0,
      advanced_count:    byKind.advanced?.count    || 0,
      renewal_revenue:   byKind.renewal?.amount    || 0,
      renewal_count:     byKind.renewal?.count     || 0,
      license_revenue:   byKind.wl_license?.amount || 0,
      license_count:     byKind.wl_license?.count  || 0,
      total_print_volume: parseInt(printEarnings.rows[0].total)
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/shops', verifySuperAdmin, async (req, res) => {
  try {
    // whitelabel_id ab zaroori hai — UI ko pata hona chahiye kaun si shop
    // reseller ki hai (wo alag tab me jaati hai, Active me nahi).
    // onboarded_by_name se agent ka naam list me hi dikh jaata hai, taaki
    // agent wali shop ko chhupana na pade (pehle chhupti thi — isi wajah
    // se uska payment superadmin me kabhi dikhta hi nahi tha).
    const r = await pool.query(`
      SELECT s.id, s.name, s.address, s.phone, s.printer_model, s.price_bw, s.price_color,
             s.payment_mode, s.payment_gateway, s.setup_paid, s.setup_amount, s.created_at,
             s.demo, s.plan_type, s.billing_cycle, s.paid_until, s.advanced_unlocked, s.agent_last_seen,
             EXTRACT(EPOCH FROM (NOW() - s.agent_last_seen))::int AS agent_seconds_ago,
             s.agent_version, s.agent_version_label, s.onboarded_by,
             s.agent_machine, (s.agent_token IS NOT NULL) AS agent_bound,
             -- owned_features YAHAN NAHI THA - aur superadmin.html ka
             -- saShopHasScan() isi par tika hai. Iske bina wo hamesha
             -- undefined padhta tha, yaani HAR non-premium shop
             -- "Scanner OFF" dikhti thi - chahe usne 49 rupaye diye hon.
             -- Isi wajah se pata hi nahi chalta tha kiske paas Smart
             -- Scanner hai, aur "wapas lo" wala button kabhi aata hi nahi tha.
             COALESCE(s.owned_features,'{}'::text[]) AS owned_features,
             s.adv_scan_active,
             COALESCE(s.whitelabel_id,'') AS whitelabel_id,
             COALESCE(a.name,'')          AS onboarded_by_name,
             COALESCE(w.brand_name,'')    AS whitelabel_name
      FROM shops s
      LEFT JOIN shops a       ON a.id = s.onboarded_by
      LEFT JOIN whitelabels w ON w.id = s.whitelabel_id
      ORDER BY s.created_at DESC
    `);
    res.json({ shops: r.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── Superadmin: PAYMENTS LEDGER ───
// Har payment jo hamare account me aayi. Pehle sirf setup fee ka flag tha
// aur advanced/renewal ka koi record hi nahi banta tha.
// ?kind=setup|advanced|renewal|wl_license se filter, ?q= se search.
app.get('/api/superadmin/payments', verifySuperAdmin, async (req, res) => {
  try {
    const kind = String(req.query.kind || '').trim();
    const q    = String(req.query.q || '').trim();
    const lim  = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 300));
    const where = ["kind <> 'wl_license'", "COALESCE(whitelabel_id,'') = ''"];
    const args  = [];
    if (kind) { args.push(kind); where.push(`kind = $${args.length}`); }
    if (q) {
      args.push('%' + q + '%');
      where.push(`(shop_id ILIKE $${args.length} OR shop_name ILIKE $${args.length}
                   OR payment_id ILIKE $${args.length} OR order_id ILIKE $${args.length})`);
    }
    args.push(lim);
    const rows = await pool.query(
      `SELECT * FROM platform_payments
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_at DESC LIMIT $${args.length}`, args);

    // Totals: white-label shop ka setup fee reseller ka paisa hai —
    // isliye "hamara" total usko chhod kar banta hai.
    const tot = await pool.query(`
      SELECT
        COALESCE(SUM(amount),0)::int AS all_amount,
        COALESCE(SUM(amount) FILTER (WHERE NOT (kind='setup' AND whitelabel_id <> '')),0)::int AS our_amount,
        COUNT(*)::int AS cnt
      FROM platform_payments WHERE kind <> 'wl_license' AND COALESCE(whitelabel_id,'') = ''`);
    res.json({ payments: rows.rows, totals: tot.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Superadmin: WHITE-LABEL ki shops (alag tab) ───
// Ye shops reseller ki hain — hamare Active/Pending count me nahi aatin.
app.get('/api/superadmin/whitelabel-shops', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.id, s.name, s.address, s.phone, s.setup_paid, s.setup_amount,
             s.created_at, s.demo, s.plan_type, s.billing_cycle, s.paid_until, s.advanced_unlocked,
             s.agent_last_seen,
             EXTRACT(EPOCH FROM (NOW() - s.agent_last_seen))::int AS agent_seconds_ago,
             s.whitelabel_id, COALESCE(w.brand_name,'') AS whitelabel_name,
             COALESCE(w.slug,'') AS whitelabel_slug
      FROM shops s
      LEFT JOIN whitelabels w ON w.id = s.whitelabel_id
      WHERE COALESCE(s.whitelabel_id,'') <> ''
      ORDER BY s.created_at DESC`);
    res.json({ shops: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Superadmin: BULK CLEANUP ───
// Ek click me saare expired demo accounts hatao.
// Protected shop (SHOP_ECB1AB8A) kabhi delete nahi hoti.
app.post('/api/superadmin/bulk/delete-expired-demos', verifySuperAdmin, async (req, res) => {
  try {
    const find = await pool.query(
      `SELECT id FROM shops
       WHERE demo = true AND demo_expires_at IS NOT NULL AND demo_expires_at <= NOW()
         AND id <> 'SHOP_ECB1AB8A'`);
    const ids = find.rows.map(r => r.id);
    if (!ids.length) return res.json({ success: true, deleted: 0 });
    for (const tbl of ['print_jobs', 'reviews', 'withdrawals', 'agent_commissions', 'platform_payments']) {
      try { await pool.query(`DELETE FROM ${tbl} WHERE shop_id = ANY($1)`, [ids]); } catch (e) {}
    }
    const del = await pool.query('DELETE FROM shops WHERE id = ANY($1) RETURNING id', [ids]);
    console.log(`Bulk delete expired demos: ${del.rows.length}`);
    res.json({ success: true, deleted: del.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ek click me saare pending-payment (register hua, paisa nahi aaya) hatao.
// Demo aur white-label shops ko haath nahi lagate.
app.post('/api/superadmin/bulk/delete-pending', verifySuperAdmin, async (req, res) => {
  try {
    const find = await pool.query(
      `SELECT id FROM shops
       WHERE demo = false AND setup_paid = false
         AND COALESCE(whitelabel_id,'') = ''
         AND id <> 'SHOP_ECB1AB8A'`);
    const ids = find.rows.map(r => r.id);
    if (!ids.length) return res.json({ success: true, deleted: 0 });
    for (const tbl of ['print_jobs', 'reviews', 'withdrawals', 'agent_commissions', 'platform_payments']) {
      try { await pool.query(`DELETE FROM ${tbl} WHERE shop_id = ANY($1)`, [ids]); } catch (e) {}
    }
    const del = await pool.query('DELETE FROM shops WHERE id = ANY($1) RETURNING id', [ids]);
    console.log(`Bulk delete pending shops: ${del.rows.length}`);
    res.json({ success: true, deleted: del.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Superadmin: kisi bhi shop (paid ya demo) ka PC printer list + selection ───
// Agent har 30 min apni printer list bhejta hai (system_settings.printers_<id>).
// Superadmin yahan se dekh sakta hai aur kaun sa printer kis kaam ke liye
// use hoga wo save kar sakta hai.
app.get('/api/superadmin/shop/:shopId/printers', verifySuperAdmin, async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const s = await pool.query(
      `SELECT id, name, demo, payment_mode, agent_last_seen,
              EXTRACT(EPOCH FROM (NOW() - agent_last_seen))::int AS agent_seconds_ago,
              printer_name_bw, printer_name_color, printer_name_4x6, printer_name_a3
       FROM shops WHERE id=$1`, [shopId]);
    if (!s.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    const p = await pool.query(
      'SELECT value, updated_at FROM system_settings WHERE key=$1', [`printers_${shopId}`]);
    let available = [];
    if (p.rows.length) { try { available = JSON.parse(p.rows[0].value) || []; } catch (e) { available = []; } }
    res.json({
      shop: s.rows[0],
      available: Array.isArray(available) ? available : [],
      reported_at: p.rows.length ? p.rows[0].updated_at : null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Printer selection + payment mode save.
// SAKHT NIYAM: superadmin sirf 'counter_only' set kar sakta hai. Online/Both
// shop owner ko khud apne login se karna hoga (kyunki usme uski apni
// Razorpay/Cashfree keys chahiye hoti hain).
app.put('/api/superadmin/shop/:shopId/printers', verifySuperAdmin, async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const b = req.body || {};
    const chk = await pool.query('SELECT id FROM shops WHERE id=$1', [shopId]);
    if (!chk.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });

    const clean = v => (typeof v === 'string' ? v.trim().slice(0, 300) : null);
    const bw = clean(b.printer_name_bw);
    const color = clean(b.printer_name_color);
    const p4x6 = clean(b.printer_name_4x6);
    const a3 = clean(b.printer_name_a3);

    let setPayment = false;
    if (b.payment_mode !== undefined && b.payment_mode !== null && b.payment_mode !== '') {
      if (b.payment_mode !== 'counter_only') {
        return res.status(403).json({
          error: 'Superadmin sirf "Counter par payment" set kar sakta hai. Online/Both ke liye shop owner ko khud login karke apni payment keys daalni hongi.'
        });
      }
      setPayment = true;
    }

    await pool.query(
      `UPDATE shops SET
         printer_name_bw    = COALESCE($2, printer_name_bw),
         printer_name_color = COALESCE($3, printer_name_color),
         printer_name_4x6   = COALESCE($4, printer_name_4x6),
         printer_name_a3    = COALESCE($5, printer_name_a3),
         payment_mode       = CASE WHEN $6 THEN 'counter_only' ELSE payment_mode END
       WHERE id=$1`,
      [shopId, bw, color, p4x6, a3, setPayment]);

    const out = await pool.query(
      `SELECT payment_mode, printer_name_bw, printer_name_color, printer_name_4x6, printer_name_a3
       FROM shops WHERE id=$1`, [shopId]);
    res.json({ success: true, shop: out.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Owner ka apna pehla shop — kabhi delete nahi hoga, chahe UI/API se kuch
// bhi bheja jaye. Server-side hardcoded taaki koi bypass na kar sake.
const PROTECTED_SHOP_IDS = ['SHOP_ECB1AB8A'];

// ─── Shop delete — paid amount 0 wali shops delete ho sakti hain ───
// Rule: setup_amount 0 (ya null) wali koi bhi shop delete ho sakti hai
// (pending + purane jinme amount capture nahi hua tha). Jisne ASLI paisa
// diya (setup_amount > 0) wo protected. Owner ka pehla shop hamesha safe.
app.delete('/api/superadmin/shop/:shopId', verifySuperAdmin, async (req, res) => {
  try {
    const shopId = req.params.shopId;
    if (PROTECTED_SHOP_IDS.includes(shopId)) {
      return res.status(403).json({ error: 'Ye shop protected hai — delete nahi ho sakti' });
    }
    const chk = await pool.query('SELECT setup_paid, setup_amount FROM shops WHERE id=$1', [shopId]);
    if (!chk.rows.length) return res.status(404).json({ error: 'Shop nahi mila' });
    // Delete-able: PENDING (setup_paid=false — naye ho ya purane) YA
    // legacy paid-₹0. setup_amount register par hi store hota hai (payment
    // se pehle), isliye amount>0 hona payment ka saboot NAHI — setup_paid hai.
    const deletable = !chk.rows[0].setup_paid || (chk.rows[0].setup_amount || 0) === 0;
    if (!deletable) {
      return res.status(403).json({ error: 'Paid/Active shop delete nahi ho sakti' });
    }
    await pool.query('DELETE FROM print_jobs WHERE shop_id=$1', [shopId]);
    await pool.query("DELETE FROM shops WHERE id=$1 AND (setup_paid=false OR COALESCE(setup_amount,0)=0)", [shopId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/shop/:shopId/earnings', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT COUNT(*) as total_orders, COALESCE(SUM(amount),0) as total_earnings
      FROM print_jobs WHERE shop_id=$1 AND ${JOB_COUNTS}
    `, [req.params.shopId]);
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── Setup Fee / Offer Price Management — Super Admin live change kar sake ───
app.get('/api/superadmin/homepage-config', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='homepage_config'");
    res.json(withBrandDefaults(r.rows.length ? JSON.parse(r.rows[0].value) : {}));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/superadmin/homepage-config', verifySuperAdmin, async (req, res) => {
  try {
    // Sanitize: sirf known keys, arrays ko string-array me force
    const cur = await pool.query("SELECT value FROM system_settings WHERE key='homepage_config'");
    const cfg = cur.rows.length ? JSON.parse(cur.rows[0].value) : {};
    const b = req.body || {};
    let branding;
    try { branding = validateBranding(b); } catch (e) { return res.status(400).json({error:e.message}); }
    Object.assign(cfg, branding);
    for(const key of ['statShops','statPrints']) if(typeof b[key] === 'string') cfg[key] = b[key].slice(0,300);
    if (typeof b.showStats === 'boolean') cfg.showStats = b.showStats;
    // Review badge — Google aur Justdial. Rating 0-5, count sirf ginti,
    // link http(s) ka hi.
    //
    // Link ki jaanch zaroori hai: ye seedha homepage ke href me jaata
    // hai. Koi galti se "javascript:" jaisa kuch daal de to wo visitor
    // ke browser me chalega.
    [['gRating', 'gCount', 'gUrl'], ['jdRating', 'jdCount', 'jdUrl']].forEach(k => {
      const [kr, kc, ku] = k;
      if (b[kr] !== undefined) {
        const rv = parseFloat(b[kr]);
        cfg[kr] = (rv > 0 && rv <= 5) ? String(Math.round(rv * 10) / 10) : '';
      }
      if (b[kc] !== undefined) cfg[kc] = String(b[kc]).replace(/\D/g, '').slice(0, 7);
      if (typeof b[ku] === 'string') {
        const uv = b[ku].trim().slice(0, 300);
        cfg[ku] = /^https?:\/\//i.test(uv) ? uv : '';
      }
    });

    // Official Partner list — homepage ke neeche logo strip.
    // Har partner: { name, logo, url }. Link http(s) ka hi maanenge, aur
    // logo ya to poora link ho ya site ke andar ka raasta (/img/...).
    // Baaki sab chhod dete hain — ye seedha homepage par lagta hai.
    if (Array.isArray(b.partners)) {
      cfg.partners = b.partners
        .filter(p => p && typeof p === 'object')
        .map(p => ({
          name: String(p.name || '').trim().slice(0, 60),
          logo: String(p.logo || '').trim().slice(0, 300),
          url:  String(p.url  || '').trim().slice(0, 300)
        }))
        .filter(p => /^https?:\/\//i.test(p.url) &&
                     (/^https?:\/\//i.test(p.logo) || p.logo.charAt(0) === '/'))
        .slice(0, 12);
    }

    // WhatsApp To Print ka daam. waPriceActual = kaat kar dikhane wala,
    // waPrice = jo sach me lena hai. Dono khali = homepage par abhi
    // "Price revealing soon" hi dikhega.
    for (const k of ['waPriceActual', 'waPrice']) {
      if (b[k] !== undefined && b[k] !== null) {
        cfg[k] = String(b[k]).replace(/\D/g, '').slice(0, 9);
      }
    }
    // Homepage ke saare button/text (data-cfg keys) — ek hi object me
    if (b.texts && typeof b.texts === 'object' && !Array.isArray(b.texts)) {
      const t = {};
      let n = 0;
      for (const k of Object.keys(b.texts)) {
        if (n >= 550) break;
        if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) continue;
        const v = b.texts[k];
        if (typeof v !== 'string') continue;
        const s = v.slice(0, 800).trim();
        if (s) { t[k] = s; n++; }
      }
      cfg.texts = t;
    }
    // planMonthly/planOnetime purane homepage ke liye rakhe hain —
    // naye teen card planStarter/planPro/planPremium padhte hain.
    for (const k of ['planDemo','planMonthly','planOnetime',
                     'planStarter','planPro','planPremium','planDemoMtei','planStarterMtei','planProMtei','planPremiumMtei']) {
      if (Array.isArray(b[k])) cfg[k] = b[k].filter(x => typeof x === 'string').map(x => x.slice(0,120)).slice(0, 20);
    }
    if (Array.isArray(b.faqs)) {
      cfg.faqs = b.faqs
        .filter(f => f && typeof f.q === 'string' && typeof f.a === 'string' && f.q.trim())
        .map(f => ({ q: f.q.trim().slice(0,200), a: f.a.trim().slice(0,1000) }))
        .slice(0, 30);
    }
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('homepage_config',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(cfg)]);
    _hpCfgCache = { t: 0, data: null };  // cache bust
    res.json({ success: true, config: cfg });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/superadmin/upload-logo', verifySuperAdmin, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Koi file nahi' });
    if (!['image/png','image/jpeg','image/webp','image/svg+xml'].includes(req.file.mimetype))
      return res.status(400).json({ error: 'Sirf PNG/JPG/WEBP/SVG' });
    if (req.file.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'Logo 2MB se kam ho' });
    const url = await uploadImageToCloudinary(req.file.buffer, req.file.mimetype);
    const cur = await pool.query("SELECT value FROM system_settings WHERE key='homepage_config'");
    const cfg = cur.rows.length ? JSON.parse(cur.rows[0].value) : {};
    cfg.logoUrl = url;
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('homepage_config',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(cfg)]);
    _hpCfgCache = { t: 0, data: null };
    res.json({ success: true, logoUrl: url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/superadmin/setup-fee', verifySuperAdmin, async (req, res) => {
  try {
    const pricing = await getSetupPricing();
    res.json({
      offerPrice: pricing.offerPrice,
      actualPrice: pricing.actualPrice,
      monthlyFee: pricing.monthlyFee,
      // Starter/Pro/Premium ke price. Ye pehle chhoot gaye the,
      // isliye superadmin me save karne ke baad refresh par input
      // khaali dikhte the (save theek tha, load hi nahi ho raha tha).
      plans: await getPlanPricing(),
      advancedFee: await getAdvancedFee(),
      monthlyActualPrice: await getMonthlyActualFee(),
      advancedActualPrice: await getAdvancedActualFee(),
      agentBasePrice: await getAgentBasePrice(),
      agentPremiumBasePrice: await getAgentPremiumBasePrice(),
      agentBasePriceIsSet: (await pool.query("SELECT value FROM system_settings WHERE key='agent_base_price'")).rows[0]?.value > 0,
      defaultOfferPrice: SETUP_FEE_AMOUNT,
      defaultActualPrice: SETUP_ACTUAL_PRICE,
      ...(await (async () => {
        const f = await getFestivalOffer();
        return { festivalOfferEnabled: f.enabled, festivalOfferName: f.name, festivalOfferEnd: f.endAt };
      })())
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/superadmin/setup-fee', verifySuperAdmin, async (req,res)=>{
  try {
    const currentPlans=await getPlanPricing();
    const pricing=await getSetupPricing();
    const currentFees={offerPrice:pricing.offerPrice,actualPrice:pricing.actualPrice,monthlyFee:pricing.monthlyFee,
      advancedFee:await getAdvancedFee(),monthlyActualPrice:await getMonthlyActualFee(),advancedActualPrice:await getAdvancedActualFee(),
      agentBasePrice:await getAgentBasePrice(),agentPremiumBasePrice:await getAgentPremiumBasePrice()};
    let result;
    try {result=validatePricingUpdate(req.body||{},PLAN_DEFS,currentPlans,currentFees);}
    catch(e){return res.status(400).json({error:e.message});}
    if(result.changes.length)await pool.query(
      `INSERT INTO system_settings(key,value) SELECT * FROM UNNEST($1::text[],$2::text[])
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`,
      [result.changes.map(x=>x[0]),result.changes.map(x=>x[1])]);
    res.json({success:true,offerPrice:result.values.offerPrice,actualPrice:result.values.actualPrice});
  }catch(e){res.status(500).json({error:e.message});}
});

// ─── Agent Version Management — Super Admin yahan se naya update push karta hai ───
// Do numbers hain, dono ka kaam alag:
//   agent_version       (INT)  → INTERNAL trigger. Har push par +1. Purane
//                                agents (v27/v28/v29) isi ko compare karte
//                                hain. Ise kabhi "2.0" mat banao.
//   agent_version_label (TEXT) → Jo sab jagah DIKHTA hai: 2.0, 2.1 ... 2.10, 3.0
app.get('/api/superadmin/agent-version', verifySuperAdmin, async (req, res) => {
  try {
    const info = await getAgentVersionInfo();
    res.json({
      version: info.version,          // internal counter (legacy field name)
      versionLabel: info.label,       // "2.0"
      displayVersion: info.label || String(info.version),
      nextLabel: info.nextLabel,      // agla suggested label
      notes: info.notes,              // "What's in the Update" box ka current text
      updatedAt: info.updatedAt
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/agent-version/bump', verifySuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const info = await getAgentVersionInfo();

    // Label: body se aaya to use karo, warna auto next (2.0 → 2.1 → ... → 2.10 → 3.0)
    const requested = (req.body && typeof req.body.label === 'string') ? req.body.label.trim() : '';
    const newLabel = requested || info.nextLabel;

    // "What's in the Update" — optional. Khali chhoda to shop owner ke panel
    // me "What's in Update" button dikhega hi nahi (khali popup se accha hai).
    // 2000 char cap taaki koi galti se poora changelog paste na kar de.
    const newNotes = (req.body && typeof req.body.notes === 'string')
      ? req.body.notes.trim().slice(0, 2000)
      : '';

    if (!parseVersionLabel(newLabel)) {
      return res.status(400).json({ error: 'Version format galat hai. Aise likho: 2.0, 2.1, 2.10, 3.0' });
    }
    // Peeche mat jao — warna sab shops "update available" dikhate rahenge
    // aur kabhi settle nahi honge.
    if (info.label && compareVersionLabels(newLabel, info.label) <= 0) {
      return res.status(400).json({
        error: `Version ${newLabel} current ${info.label} se aage hona chahiye. Suggested: ${info.nextLabel}`
      });
    }

    const newVersion = info.version + 1;   // internal counter hamesha +1

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('agent_version', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [String(newVersion)]
    );
    await client.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('agent_version_label', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [newLabel]
    );
    // Notes hamesha likho — khali bhejne par purane version ke notes hat jaate
    // hain. Warna naya version push karne par shop owner ko pichhle update ka
    // text dikhta rehta, jo galat hai.
    await client.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('agent_version_notes', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [newNotes]
    );
    await client.query('COMMIT');

    console.log(`Agent version pushed → v${newLabel} (internal ${newVersion}) by super admin — sab customers ke PC 1 ghante mein update ho jayenge`);
    res.json({
      success: true,
      version: newVersion,
      versionLabel: newLabel,
      displayVersion: newLabel,
      notes: newNotes,
      nextLabel: nextVersionLabel(newLabel)
    });
  } catch(err) {
    try { await client.query('ROLLBACK'); } catch(_) {}
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── Easy Installer (.exe) URL Management — Cloudinary pe hosted ───
// GitHub/Render dono ki file-size limits avoid karne ke liye, naya .exe
// build hone par usko Cloudinary pe manually upload karke yahan se URL
// set/update kiya jaata hai. Code change/redeploy ki zaroorat nahi.
app.get('/api/superadmin/easy-installer-url', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT value, updated_at FROM system_settings WHERE key='easy_installer_url'");
    res.json({
      url: r.rows.length ? r.rows[0].value : '',
      updatedAt: r.rows.length ? r.rows[0].updated_at : null
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/superadmin/easy-installer-url', verifySuperAdmin, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !url.trim().startsWith('http')) {
      return res.status(400).json({ error: 'Valid URL daalo (https:// se shuru honi chahiye)' });
    }
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('easy_installer_url', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [url.trim()]
    );
    console.log(`Easy Installer URL updated by super admin: ${url.trim()}`);
    res.json({ success: true, url: url.trim() });
  } catch(err) { res.status(500).json({ error: err.message }); }
});



// ══════════════════════════════════════════════════════════════════
// RAZORPAY WEBHOOK — server-side payment confirmation
// Customer browser band kar de payment ke turant baad, tab bhi payment
// confirm hoti hai. NOTE: yeh sirf OWNER (setup fee) Razorpay account ke
// webhooks ke liye hai — Razorpay dashboard mein webhook URL + secret set
// karo, secret ko RAZORPAY_WEBHOOK_SECRET env mein daalo.
// Shop owners ke apne accounts ke liye niche wali RECONCILIATION chalti
// hai (unke dashboards mein webhook configure karwana practical nahi).
// ══════════════════════════════════════════════════════════════════
app.post('/api/webhook/razorpay', async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: 'Webhook secret configured nahi' });
    const signature = req.headers['x-razorpay-signature'];
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    if (signature !== expected) return res.status(400).json({ error: 'Invalid signature' });

    const event = req.body.event;
    if (event === 'payment.captured' || event === 'order.paid') {
      const payment = req.body.payload?.payment?.entity || {};
      const orderId = payment.order_id || req.body.payload?.order?.entity?.id;
      const paymentId = payment.id || '';
      if (orderId) {
        // 1) Setup fee?
        const sh = await pool.query(
          'SELECT id, setup_paid FROM shops WHERE setup_order_id=$1', [orderId]);
        // Renewal order? (setup match na ho to)
        if (!sh.rows.length) {
          const rn = await pool.query('SELECT id FROM shops WHERE renewal_order_id=$1', [orderId]);
          if (rn.rows.length) {
            await extendShop(rn.rows[0].id, orderId, paymentId || 'WEBHOOK');
            return res.json({ status: 'ok' });
          }
          // ⚠️ Ye block pehle tha hi nahi. Webhook setup / renewal /
          // advanced teeno dekhta tha par ADD-ON (₹49) ka order nahi —
          // yaani us payment ka koi safety net hi nahi tha. Browser band
          // ho jaye, net kat jaye, ya login token expire ho jaye to paisa
          // kat jaata tha aur feature kabhi unlock nahi hota.
          const ft = await pool.query(
            'SELECT id FROM shops WHERE feature_order_id=$1', [orderId]);
          if (ft.rows.length) {
            const fid = await unlockFeatureByOrder(ft.rows[0].id, orderId, paymentId || 'WEBHOOK');
            console.log('Feature unlocked (webhook):', ft.rows[0].id, fid);
            return res.json({ status: 'ok' });
          }

          const adv = await pool.query('SELECT id FROM shops WHERE advanced_order_id=$1', [orderId]);
          if (adv.rows.length) {
            await pool.query("UPDATE shops SET advanced_unlocked=true, advanced_order_id='' WHERE id=$1", [adv.rows[0].id]);
            console.log('Advanced unlocked (webhook):', adv.rows[0].id);
            await recordPayment({
              kind: 'advanced', shopId: adv.rows[0].id,
              amount: await getAdvancedFee(),
              paymentId: paymentId || '', orderId,
              note: 'Advanced printing unlock (webhook)'
            });
            return res.json({ status: 'ok' });
          }
        }
        if (sh.rows.length && !sh.rows[0].setup_paid) {
          await activateShop(sh.rows[0].id, paymentId);
        }
        // 2) Customer print job? (agar owner account se aaya ho)
        const _u = await pool.query(
          `UPDATE print_jobs SET payment_status='paid', payment_id=$1
           WHERE razorpay_order_id=$2 AND payment_status='pending'
           RETURNING shop_id`,
          [paymentId, orderId]);
        if (_u.rows.length) markShopHasWork(_u.rows[0].shop_id);
      }
    }
    res.json({ received: true });
  } catch(err) {
    console.error('Webhook error:', err.message);
    res.status(200).json({ received: true }); // 5xx par Razorpay retry-storm karta hai
  }
});

// ══════════════════════════════════════════════════════════════════
// BACKGROUND JOBS (har 2 min)
// 1) STUCK-JOB CLEANUP: agent print ke beech crash ho jaye to job
//    'printing' mein hamesha atka rehta tha. 10 min baad wapas 'queued',
//    2 retries ke baad 'failed' — poison job (corrupt PDF jo har baar
//    agent crash kare) infinite loop nahi banayega.
// 2) RAZORPAY RECONCILIATION: pending payments ko seedha Razorpay Orders
//    API se check karo — shop ki apni stored keys se. Customer browser
//    band kar de to bhi 2 min ke andar payment paid mark ho jati hai,
//    kisi webhook config ke bina.
// ══════════════════════════════════════════════════════════════════
async function razorpayOrderStatus(orderId, keyId, keySecret) {
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const resp = await fetch(`https://api.razorpay.com/v1/orders/${orderId}`, {
    headers: { 'Authorization': 'Basic ' + auth }
  });
  if (!resp.ok) return null;
  return resp.json();
}

// ═══════════════════════════════════════════════
// STUCK PRINT JOB SWEEPER
// Job 'printing' me STUCK_JOB_TIMEOUT_SEC (default 120s) se zyada atka
// raha = shop PC/printer ne respond nahi kiya. Us file ko Cloudinary se
// delete karke job fail kar do, aur admin panel me saaf reason dikhao.
// ═══════════════════════════════════════════════
let sweepRunning = false;
async function sweepStuckJobs() {
  if (sweepRunning) return;          // overlap guard
  sweepRunning = true;
  try {
    // Optional retry (STUCK_JOB_RETRIES=1) — default 0 yaani seedha fail.
    if (STUCK_JOB_RETRIES > 0) {
      const requeued = await pool.query(
        `UPDATE print_jobs SET status='queued', printing_at=NULL, retry_count=retry_count+1
          WHERE status='printing'
            AND printing_at < NOW() - ($1 || ' seconds')::interval
            AND retry_count < $2
          RETURNING id`,
        [String(STUCK_JOB_TIMEOUT_SEC), STUCK_JOB_RETRIES]);
      if (requeued.rows.length) {
        console.log('♻️ Requeued stuck jobs:', requeued.rows.map(r => r.id).join(','));
      }
    }

    const failed = await pool.query(
      `UPDATE print_jobs SET status='failed', failure_reason=$3
        WHERE status='printing'
          AND printing_at < NOW() - ($1 || ' seconds')::interval
          AND retry_count >= $2
        RETURNING id, shop_id, file_public_id`,
      [String(STUCK_JOB_TIMEOUT_SEC), STUCK_JOB_RETRIES,
       `Not printed within ${STUCK_JOB_TIMEOUT_SEC} seconds — file deleted. Please print again.`]);

    for (const fj of failed.rows) {
      if (fj.file_public_id) {
        try {
          await deleteFromCloudinary(fj.file_public_id);
          await pool.query('UPDATE print_jobs SET file_deleted=true WHERE id=$1', [fj.id]);
        } catch (e) {
          // Cloudinary delete fail ho to job phir bhi failed hi rahega —
          // TTL cleanup baad me file uthha lega.
          console.warn(`Cloudinary delete failed for ${fj.id}: ${e.message}`);
        }
      }
    }
    if (failed.rows.length) {
      console.log(`⏱️ Stuck jobs timed out after ${STUCK_JOB_TIMEOUT_SEC}s (file deleted):`,
        failed.rows.map(r => r.id).join(','));
    }
  } catch (err) {
    console.error('sweepStuckJobs error:', err.message);
  } finally {
    sweepRunning = false;
  }
}

// Timeout se aadha interval — taaki detection deri se na ho.
setInterval(sweepStuckJobs, Math.max(15, Math.floor(STUCK_JOB_TIMEOUT_SEC / 4)) * 1000).unref();

let bgRunning = false;
async function backgroundMaintenance() {
  if (bgRunning) return; // overlap guard
  bgRunning = true;
  try {
    // 0) Security log retention — 7 din se purane events hata do
    try {
      const del = await pool.query(
        "DELETE FROM security_events WHERE created_at < NOW() - INTERVAL '7 days' RETURNING id");
      if (del.rows.length) console.log(`Security log cleanup: ${del.rows.length} old rows removed`);
    } catch (e) { console.warn('security log cleanup skipped:', e.message); }

    // 1) Stuck printing jobs — ab sweepStuckJobs() alag tez loop me chalta
    //    hai (har 30s), taaki 120 second ki limit sach me 120 second rahe.
    //    Yahan sirf ek extra safety pass.
    await sweepStuckJobs();

    // 2a) Customer job payments reconcile (shop ki apni keys)
    const pending = await pool.query(
      `SELECT j.id, j.razorpay_order_id, s.razorpay_key_id, s.razorpay_key_secret
       FROM print_jobs j JOIN shops s ON j.shop_id=s.id
       WHERE j.payment_status='pending' AND j.razorpay_order_id IS NOT NULL
         AND j.razorpay_order_id <> '' AND s.razorpay_key_id <> ''
         AND j.created_at > NOW() - INTERVAL '45 minutes'
       LIMIT 20`);
    for (const job of pending.rows) {
      try {
        const order = await razorpayOrderStatus(job.razorpay_order_id, job.razorpay_key_id, job.razorpay_key_secret);
        if (order && order.status === 'paid') {
          // payment_status ke saath status bhi 'queued' karo — warna agent
          // (jo queued+paid uthata hai) is job ko KABHI nahi uthata aur
          // customer ka paisa kat ke bhi print nahi nikalta.
          const _u = await pool.query(
            `UPDATE print_jobs
             SET payment_status='paid',
                 status = CASE WHEN status='pending' THEN 'queued' ELSE status END
             WHERE id=$1 AND payment_status='pending'
             RETURNING shop_id`,
            [job.id]);
          if (_u.rows.length) markShopHasWork(_u.rows[0].shop_id);
          console.log('💰 Reconciled payment for job:', job.id);
        }
      } catch(e) { /* agla cycle try karega */ }
    }

    // 2b) Setup fee reconcile (owner keys)
    if (OWNER_RAZORPAY_KEY_ID && OWNER_RAZORPAY_KEY_SECRET) {
      const setups = await pool.query(
        `SELECT id, setup_order_id FROM shops
         WHERE setup_paid=false AND setup_order_id IS NOT NULL AND setup_order_id <> ''
         LIMIT 10`);
      for (const shop of setups.rows) {
        try {
          const order = await razorpayOrderStatus(shop.setup_order_id, OWNER_RAZORPAY_KEY_ID, OWNER_RAZORPAY_KEY_SECRET);
          if (order && order.status === 'paid') {
            await activateShop(shop.id, order.id);
            console.log('💰 Reconciled setup fee:', shop.id);
          }
        } catch(e) { /* agla cycle */ }
      }
    }
    // 2b-ii) Renewal reconcile — renewal order bana par verify nahi pahuncha
    if (OWNER_RAZORPAY_KEY_ID && OWNER_RAZORPAY_KEY_SECRET) {
      const renews = await pool.query(
        `SELECT id, renewal_order_id FROM shops
         WHERE renewal_order_id IS NOT NULL AND renewal_order_id <> '' LIMIT 10`);
      for (const shop of renews.rows) {
        try {
          const order = await razorpayOrderStatus(shop.renewal_order_id, OWNER_RAZORPAY_KEY_ID, OWNER_RAZORPAY_KEY_SECRET);
          if (order && order.status === 'paid') {
            await extendShop(shop.id, shop.renewal_order_id, 'RECONCILE');
            console.log('💰 Reconciled renewal:', shop.id);
          }
        } catch(e) { /* agla cycle */ }
      }
    }

    // 2b-iii) Advanced unlock reconcile
    if (OWNER_RAZORPAY_KEY_ID && OWNER_RAZORPAY_KEY_SECRET) {
      const advs = await pool.query(
        `SELECT id, advanced_order_id FROM shops WHERE advanced_order_id IS NOT NULL AND advanced_order_id <> '' LIMIT 10`);
      for (const shop of advs.rows) {
        try {
          const order = await razorpayOrderStatus(shop.advanced_order_id, OWNER_RAZORPAY_KEY_ID, OWNER_RAZORPAY_KEY_SECRET);
          if (order && order.status === 'paid') {
            await pool.query("UPDATE shops SET advanced_unlocked=true, advanced_order_id='' WHERE id=$1", [shop.id]);
            console.log('Advanced unlocked (reconcile):', shop.id);
            await recordPayment({
              kind: 'advanced', shopId: shop.id,
              amount: await getAdvancedFee(),
              orderId: shop.advanced_order_id,
              paymentId: 'RECONCILE_' + shop.advanced_order_id,
              note: 'Advanced printing unlock (reconcile)'
            });
          }
        } catch(e) {}
      }
    }

    // 2c) ABANDONED uploads — customer ne upload kiya par payment complete
    // nahi kiya. Pehle ye files Cloudinary par HAMESHA padi rehti thi
    // (storage leak + customer ki private file server par). Ab 60 min baad
    // file delete + job abandoned mark.
    const abandoned = await pool.query(
      `SELECT id, file_public_id FROM print_jobs
       WHERE status='pending' AND payment_status='pending'
         AND created_at < NOW() - INTERVAL '60 minutes'
       LIMIT 20`);
    for (const j of abandoned.rows) {
      if (j.file_public_id) await deleteFromCloudinary(j.file_public_id);
      await pool.query(
        "UPDATE print_jobs SET status='abandoned', file_deleted=true, failure_reason=$1 WHERE id=$2",
        ['Customer ne payment complete nahi kiya', j.id]);
      console.log('🧹 Abandoned upload cleaned:', j.id);
    }

    // ══════════ SAFETY LAYER 1: VERIFY SWEEP ══════════
    // Job complete/fail/abandon ho gayi par file_deleted flag false hai
    // (matlab delete call silently fail hua tha — network, API error).
    // 5 min baad dobara delete maaro. Cloudinary destroy idempotent hai.
    const unverified = await pool.query(
      `SELECT id, file_public_id FROM print_jobs
       WHERE status IN ('printed','failed','abandoned')
         AND file_deleted = false
         AND file_public_id IS NOT NULL AND file_public_id <> ''
         AND created_at < NOW() - INTERVAL '5 minutes'
       LIMIT 25`);
    for (const j of unverified.rows) {
      await deleteFromCloudinary(j.file_public_id);
      await pool.query('UPDATE print_jobs SET file_deleted=true WHERE id=$1', [j.id]);
      console.log('🔁 Retry-deleted leftover file:', j.id);
    }

    // ══════════ SAFETY LAYER 2: CLOUDINARY ORPHAN SWEEP ══════════
    // Har ~10 min: Cloudinary se ASLI list lo. Jo file 90+ min purani hai
    // aur kisi ACTIVE job ki nahi hai — uda do. Ye un files ko bhi pakadta
    // hai jinka DB me row hi nahi (upload hua par insert fail, ya row delete
    // ho gaya) — DB-based cleanup unhe kabhi nahi dekh sakta.
    _sweepTick++;
    if (_sweepTick % 5 === 0) {
      let cursor = '';
      let swept = 0;
      for (let page = 0; page < 5; page++) {   // max 500 files/cycle
        const { resources, next_cursor } = await listCloudinaryFiles(cursor);
        if (!resources.length) break;
        for (const r of resources) {
          const ageMin = (Date.now() - new Date(r.created_at).getTime()) / 60000;
          if (ageMin < 90) continue;   // fresh file — abhi koi use kar raha ho sakta hai
          // Active job to nahi hai iski?
          const active = await pool.query(
            `SELECT 1 FROM print_jobs
             WHERE file_public_id=$1 AND status IN ('queued','printing')`, [r.public_id]);
          if (active.rows.length) continue;   // print hone wali hai — chhod do
          await deleteFromCloudinary(r.public_id);
          await pool.query('UPDATE print_jobs SET file_deleted=true WHERE file_public_id=$1', [r.public_id]);
          swept++;
        }
        if (!next_cursor) break;
        cursor = next_cursor;
      }
      if (swept) console.log(`🧹 Cloudinary orphan sweep: ${swept} file(s) deleted`);
    }

    // 3) Purane demo shops saaf (7 din baad) — DB junk-free rahe
    const oldDemos = await pool.query(
      "SELECT id FROM shops WHERE demo=true AND demo_expires_at < NOW() - INTERVAL '7 days' LIMIT 20");
    for (const d of oldDemos.rows) {
      await pool.query('DELETE FROM print_jobs WHERE shop_id=$1', [d.id]);
      await pool.query('DELETE FROM shops WHERE id=$1', [d.id]);
      console.log('🧹 Old demo deleted:', d.id);
    }
  } catch(err) {
    console.error('Background maintenance error:', err.message);
  } finally {
    bgRunning = false;
  }
}
setInterval(backgroundMaintenance, 2 * 60 * 1000).unref();

app.get('/print/:shopId', (req,res) => res.sendFile(path.join(__dirname,'public','customer.html')));
app.get('/register',  (req,res) => res.sendFile(path.join(__dirname,'public','register.html')));
app.get('/agent',     (req,res) => res.sendFile(path.join(__dirname,'public','agent.html')));
app.get('/dashboard', (req,res) => res.sendFile(path.join(__dirname,'public','dashboard.html')));
app.get('/admin', (req,res) => res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/superadmin', (req,res) => res.sendFile(path.join(__dirname,'public','superadmin.html')));
app.get('/print-success', (req,res) => res.sendFile(path.join(__dirname,'public','success.html')));

// ═══ SEO: sub-pages ke ASLI URL (Google me alag page + sitelinks ke liye) ═══
// index.html hi serve hota hai, par har URL ka apna title/description/canonical
// inject karke bhejte hain — tabhi Google inhe alag page maanta hai.
// Frontend JS pathname dekh kar wahi section khol deta hai.
const SEO_PAGES = {
  '/features': {
    title: 'Features — Echel | Cyber Cafe Auto Print Software',
    desc: 'Explore Echel: QR uploads, online payments, automatic printing, passport photos, resumes and shop management.'
  },
  '/about': {
    title: 'About Us — Echel | Cyber Cafe Print Automation',
    desc: 'Meet Echel: connected printing for customers, print shops and cyber cafes.'
  },
  '/contact': {
    title: 'Contact Us — Echel | Support & Business Inquiry',
    desc: 'Contact Echel for support, demos, pricing and business enquiries.'
  },
  '/setup-guide': {
    title: 'How to Set Up — Echel',
    desc: 'Connect your shop, install the print agent, select your printers and configure payments with the Echel setup guide.'
  },
  '/terms': {
    title: 'Terms & Conditions — Echel',
    desc: 'Echel terms of service: accounts, payments and shop owner responsibilities.'
  },
  '/privacy': {
    title: 'Privacy Policy — Echel',
    desc: 'How Echel handles customer documents, data retention and file deletion.'
  },
  '/refund': {
    title: 'Refund & Cancellation Policy — Echel',
    desc: 'Echel refund and cancellation rules for print jobs, subscriptions and payments.'
  },
  '/disclaimer': {
    title: 'Declaration & FAQ — Echel',
    desc: 'Understand Echel services, shop responsibilities and frequently asked questions.'
  }
};

let _indexHtmlCache = null;
// Canonical hamesha asli domain ka hona chahiye (BASE_URL default onrender.com hai,
// use canonical me daalna SEO ke liye galat hoga)
const SITE_URL = deployment.siteUrl;
function loadIndexHtml() {
  if (_indexHtmlCache === null) {
    try {
      _indexHtmlCache = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    } catch (e) {
      console.error('index.html read fail:', e.message);
      _indexHtmlCache = '';
    }
  }
  return _indexHtmlCache;
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
Object.keys(SEO_PAGES).forEach(function (route) {
  app.get(route, function (req, res) {
    const meta = SEO_PAGES[route];
    let html = loadIndexHtml();
    // index.html padh nahi paaye to normal file bhej do (site kabhi na toote)
    if (!html) return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    const url = SITE_URL + route;
    const t = esc(meta.title), d = esc(meta.desc);
    html = html
      .replace(/<title>[\s\S]*?<\/title>/i, '<title>' + t + '</title>')
      .replace(/<meta name="description" content="[^"]*">/i,
               '<meta name="description" content="' + d + '">')
      .replace(/<link rel="canonical" href="[^"]*">/i,
               '<link rel="canonical" href="' + url + '">')
      .replace(/<meta property="og:url" content="[^"]*">/i,
               '<meta property="og:url" content="' + url + '">')
      .replace(/<meta property="og:title" content="[^"]*">/i,
               '<meta property="og:title" content="' + t + '">')
      .replace(/<meta property="og:description" content="[^"]*">/i,
               '<meta property="og:description" content="' + d + '">')
      .replace(/<meta name="twitter:title" content="[^"]*">/i,
               '<meta name="twitter:title" content="' + t + '">')
      .replace(/<meta name="twitter:description" content="[^"]*">/i,
               '<meta name="twitter:description" content="' + d + '">');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });
});
// Purane / alternate path — asli URL par 301 bhej do (link juice na tootey)
const SEO_ALIASES = { '/feature': '/features', '/guide': '/setup-guide', '/faq': '/disclaimer', '/declaration': '/disclaimer' };
Object.keys(SEO_ALIASES).forEach(function (from) {
  app.get(from, function (req, res) { res.redirect(301, SEO_ALIASES[from]); });
});

// ═══ SEO: robots.txt + sitemap.xml + private-page noindex ═══
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (p.startsWith('/admin') || p.startsWith('/superadmin') || p.startsWith('/dashboard')
      || p.startsWith('/success') || p.startsWith('/setup-payment') || p.startsWith('/print/')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
  next();
});

// Homepage social-proof — ASLI numbers, 5 min cache
let _statsCache = { t: 0, data: null };
let _hpCfgCache = { t: 0, data: null };
app.get('/api/homepage-config', async (req, res) => {
  try {
    if (Date.now() - _hpCfgCache.t < 60000 && _hpCfgCache.data) return res.json(_hpCfgCache.data);
    const r = await pool.query("SELECT value FROM system_settings WHERE key='homepage_config'");
    const cfg = withBrandDefaults(r.rows.length ? JSON.parse(r.rows[0].value) : {});
    _hpCfgCache = { t: Date.now(), data: cfg };
    res.json(cfg);
  } catch(e) { res.json(withBrandDefaults()); }
});

app.get('/api/public-stats', async (req, res) => {
  try {
    if (Date.now() - _statsCache.t < 300000 && _statsCache.data) return res.json(_statsCache.data);
    const shops = await pool.query("SELECT COUNT(*) FROM shops WHERE setup_paid=true AND (demo IS NULL OR demo=false)");
    const prints = await pool.query("SELECT COUNT(*) FROM print_jobs WHERE status='printed'");
    _statsCache = { t: Date.now(), data: {
      shops: parseInt(shops.rows[0].count) || 0,
      prints: parseInt(prints.rows[0].count) || 0
    }};
    res.json(_statsCache.data);
  } catch(e) { res.json({ shops: 0, prints: 0 }); }
});


app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin
Disallow: /superadmin
Disallow: /dashboard
Disallow: /wl-admin
Disallow: /print/
Disallow: /resume/
Disallow: /setup-payment/
Disallow: /print-success

Sitemap: ${SITE_URL}/sitemap.xml
`);
});

app.get('/.well-known/security.txt', (req, res) => {
  res.type('text/plain').send(`Contact: ${SITE_URL}/contact
Expires: 2027-08-04T00:00:00.000Z
Preferred-Languages: en, mni
Canonical: ${SITE_URL}/.well-known/security.txt
`);
});

app.get('/sitemap.xml', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    ['/', 'weekly', '1.0'],
    ['/features', 'monthly', '0.9'],
    ['/register', 'monthly', '0.9'],
    ['/setup-guide', 'monthly', '0.8'],
    ['/about', 'monthly', '0.7'],
    ['/contact', 'monthly', '0.7'],
    ['/agent', 'monthly', '0.7'],
    ['/terms', 'yearly', '0.3'],
    ['/privacy', 'yearly', '0.3'],
    ['/refund', 'yearly', '0.3'],
    ['/disclaimer', 'yearly', '0.3']
  ].map(u =>
    `  <url><loc>${SITE_URL}${u[0]}</loc><lastmod>${today}</lastmod>` +
    `<changefreq>${u[1]}</changefreq><priority>${u[2]}</priority></url>`
  ).join('\n');
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`
  );
});

app.get('/setup-payment/:shopId', (req,res) => res.sendFile(path.join(__dirname,'public','setup-payment.html')));
app.get('/resume/:shopId', (req,res) => res.sendFile(path.join(__dirname,'public','resume.html')));

// Kram maayne rakhta hai: schema -> data -> TAB port kholo.
// Isi se agent ko kabhi khaali DB nahi milta.
app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'echel' });
  } catch (_) { res.status(503).json({ status: 'unavailable' }); }
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Echel - Port ${PORT}`);
    console.log(`${BASE_URL}`);
    console.log(`Cloudinary: ${CLOUD_NAME}`);
    console.log(`Payment: Per-shop gateway (Razorpay/Cashfree), Counter always available unless online_only`);
  });
}).catch(() => { process.exitCode = 1; pool.end().finally(() => process.exit(1)); });
