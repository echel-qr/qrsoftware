const { CYCLES, billingCycle, subscriptionActive, validatePlanPrices, validatePricingUpdate, MONTHS_SQL, CYCLE_SQL } = require('./billing');
require('dotenv').config();
const { deploymentConfig, databaseOptions, UPLOAD_PREFIX, BRAND_PREFIX, isJobAsset, protectAppTables, APP_TABLES } = require('./deployment');
const migration = require('./migration');
const deployment = deploymentConfig();
const express = require('express');
const cors = require('cors');
const { Pool, types: pgTypes } = require('pg');

// ⚠️ IMPORTANT: price columns are now NUMERIC(10,2) (for decimal rates).
// node-postgres returns NUMERIC as a STRING by default (so precision is not
// lost). Because of that, every calculation and comparison involving a price
// silently went wrong — shops started showing as "offline" in superadmin
// and errors appeared after printing. A parser here turns NUMERIC back into a
// number, so the rest of the code keeps working exactly as before.
pgTypes.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));   // NUMERIC / DECIMAL

// ⚠️ IMPORTANT: demos ending before their time — this was the real cause.
//
// All our TIMESTAMP columns are "without time zone" and the database
// timezone is UTC. But node-postgres reads such a column in the SERVER
// PROCESS's local timezone. If the Render/PC TZ is IST, it treats
// "2026-08-15 07:50" as IST = 02:20 UTC — i.e. 5.5 HOURS EARLIER
// than the real time. Demo, agent online/offline, stuck jobs — all of
// them go wrong because of this.
//
// The parser here declares that the value is UTC. The DB timezone really
// is UTC, so this is 100% correct — and whatever the server TZ is, the
// calculation never breaks.
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

// ── WHICH PRINT JOBS ARE "COUNTED" ──
// Only payment_status='paid' used to be checked. That meant a job that was
// cancelled, abandoned or failed on the printer was still added to the shop
// owner's earnings and print count.
// Now those three statuses are excluded — from both earnings and count.
// (It sits at the very top so every query below can use it.)
const JOB_NOT_COUNTED = "('cancelled','abandoned','failed')";
const JOB_COUNTS = `payment_status='paid' AND COALESCE(status,'') NOT IN ${JOB_NOT_COUNTED}`;

const { BRAND_DEFAULTS, validateBranding, withBrandDefaults } = require('./site-branding');
const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = deployment.baseUrl;

// ── White-label homepage settings ──
// The monthly plan minimum — a partner cannot set a price below this.
const WL_MIN_MONTHLY = 399;

// A price can be a decimal too (2.5, 1.5) — round to 2 decimals.
// If it is invalid/negative, return null so the old price stays.
// ── BIG SIZE (A3/A2/A1) PRICING ──────────────────────────────
// When the customer picks large paper, the per-page rate is different.
// If the owner has not set it (0/blank), the normal B&W/Color rate
// applies — so billing for old shops stays exactly the same.
const BIG_SIZE_PRICE_COLS = {
  a3: ['price_a3_bw', 'price_a3_color'],
  a2: ['price_a2_bw', 'price_a2_color'],
  a1: ['price_a1_bw', 'price_a1_color']
};
const BIG_SIZE_PRICE_SELECT =
  's.price_a3_bw, s.price_a3_color, s.price_a2_bw, s.price_a2_color, s.price_a1_bw, s.price_a1_color';

/** The big-size rate for the row's paper size + colour mode. 0 when not set. */
function bigSizeRate(row, paperSize, colorMode) {
  if (!row) return 0;
  const cols = BIG_SIZE_PRICE_COLS[String(paperSize || '').toLowerCase()];
  if (!cols) return 0;
  const v = parseFloat(row[colorMode === 'color' ? cols[1] : cols[0]]);
  return (!isNaN(v) && v > 0) ? v : 0;
}
/** Money always to 2 decimals — floating-point dust gets rejected by the gateway. */
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function parsePrice(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  if (isNaN(n) || n < 0 || n > 100000) return null;
  return Math.round(n * 100) / 100;
}
// The homepage buttons/sections a partner can turn on or off.
const WL_HP_BUTTON_KEYS = ['contact','partner','agent','features','setupGuide',
                           'pricing','reviews','faq','demo','register','shopLogin'];

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLD_API_KEY = process.env.CLOUDINARY_API_KEY || '';
const CLD_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';

// (Global RAZORPAY_KEY_ID/SECRET removed — each shop now stores its own gateway credentials)

// In production JWT_SECRET must always come from an environment variable.
// If it is not set, a random secret is generated at runtime (valid only while
// this process keeps running — a restart logs everyone out).
// This is far safer than a hardcoded secret.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// ═══════════════════════════════════════════════════════════════════
//  SECURITY
// ═══════════════════════════════════════════════════════════════════

// ── PASSWORD ──
// This used to be plain SHA-256 (no salt). SHA-256 is so fast that an ordinary
// GPU tries tens of millions of hashes per second — after a DB leak a 4-character
// password would crack within a minute. Now Node's BUILT-IN scrypt is
// used: every password gets its own salt, and it is deliberately slow.
// No new npm package is needed (crypto is already part of Node).
const PASSWORD_MAX = 200;            // never accept a longer password than this
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

// timingSafeEqual throws when the lengths differ — hence the wrapper
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Both OLD (sha256) and NEW (scrypt) hashes work — that is why the
// migration does not break anyone's login.
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

// The login succeeded and the hash is still old — quietly convert it to scrypt.
// The user notices nothing; gradually everyone migrates.
async function upgradeHashIfLegacy(table, idCol, idVal, storedHash, plainPassword) {
  try {
    if (!isLegacyHash(storedHash)) return;
    const fresh = await hashPassword(plainPassword);
    await pool.query(`UPDATE ${table} SET password_hash=$1 WHERE ${idCol}=$2`, [fresh, idVal]);
    console.log(`Password hash upgraded to scrypt: ${table}/${idVal}`);
  } catch (e) { console.error('hash upgrade fail:', e.message); }
}

// ── LOGIN RATE LIMIT ──
// Without this anyone could try unlimited passwords on a Shop ID.
// It is in-memory (only one instance runs on Render) — no package.
const loginHits = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 8;

setInterval(() => {                    // remove old entries (so memory does not leak)
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
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} minutes.` });
  }
  next();
}

// Reset the counter after a successful login — so the real user is not affected
function clearLoginHits(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket.remoteAddress || 'unknown';
  loginHits.delete(ip + '|' + String(req.body?.shopId || req.body?.slug || req.body?.username || '').toLowerCase());
}

if (!process.env.JWT_SECRET) {
  console.warn('⚠️  The JWT_SECRET environment variable is not set! A random secret was generated — everyone will be logged out when Render restarts. Add JWT_SECRET in Render.');
}

// The platform owner's Razorpay keys for collecting the Setup Fee.
// These are SEPARATE from the per-shop gateway keys — they are only for the registration fee.
const SETUP_FEE_AMOUNT = parseInt(process.env.SETUP_FEE_AMOUNT || '499');
const SETUP_ACTUAL_PRICE = parseInt(process.env.SETUP_ACTUAL_PRICE || '999');
const OWNER_RAZORPAY_KEY_ID = process.env.OWNER_RAZORPAY_KEY_ID || '';
const OWNER_RAZORPAY_KEY_SECRET = process.env.OWNER_RAZORPAY_KEY_SECRET || '';

// Super Admin login (the platform owner's own panel — to see all shops)
const SUPER_ADMIN_ID = process.env.SUPER_ADMIN_ID || '';
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || '';

if (!OWNER_RAZORPAY_KEY_ID || !OWNER_RAZORPAY_KEY_SECRET) {
  console.warn('⚠️  OWNER_RAZORPAY_KEY_ID/SECRET is not set — Setup Fee payments will not work until it is added in Render.');
}
if (!SUPER_ADMIN_ID || !SUPER_ADMIN_PASSWORD) {
  console.warn('⚠️  SUPER_ADMIN_ID/PASSWORD is not set — Super Admin login will not work until it is added in Render.');
}

const pool = new Pool(databaseOptions());

// ══════════════════════════════════════════════════════════════
//  THE REAL CRASH BUG — this was why the server went down three times on 31 Aug
//
//  The node-postgres rule: if an IDLE client inside the Pool (one not busy
//  with a query) gets an error on its socket (for example when the Supabase
//  pooler recycles it, or the connection resets midway —
//  ECONNABORTED), the Pool does not handle that error itself; it only
//  emits an 'error' EVENT.
//
//  This Pool used to have NO listener. When Node's EventEmitter finds no
//  listener for an 'error' event, it THROWS it directly — which becomes an
//  uncaught exception and crashes the WHOLE process. That produced the
//  "throw er; // Unhandled 'error' event" crash, all three times.
//
//  The fix is simple: attach a listener. An idle connection being reset is
//  perfectly normal (network blip, pooler recycle) — just LOG it and move
//  on. pg removes the dead client from the pool itself and creates a new one
//  for the next query; nothing else needs to be done.
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════
//  EGRESS OPTIMIZATION — keeping polling away from Supabase
//
//  Agent  →  Render  →  Supabase
//                       ↑ Supabase egress is charged ONLY here.
//
//  The agent talking to Render is free. Money is spent when Render
//  asks Supabase. So the goal is NOT that the agent polls less —
//  the goal is that Render does not go to Supabase on every poll.
// ══════════════════════════════════════════════════════════════════════

/** Shops that have a job waiting to be printed. */
const shopsWithWork = new Set();

/** Demos that have already expired — do not even let them reach the DB. */
const expiredDemoShops = new Set();

/**
 * Cache of a shop's basic info — { demo, demoExpiresAt, at }.
 * demo_expires_at is a TIMESTAMP, so the expiry can be checked in memory;
 * there is no need to ask the DB again and again for it.
 */
const shopInfoCache = new Map();
const SHOP_INFO_TTL_MS = 10 * 60 * 1000;

/** agent_last_seen — collect it in memory and write it to the DB in batches. */
const pendingHeartbeats = new Map();   // shopId -> { at, version, label }
const HEARTBEAT_FLUSH_MS = 2 * 60 * 1000;
const WORK_SWEEP_MS      = 20 * 1000;

// ══════════════════════════════════════════════════════════════════════
//  LONG POLLING — waiting on an open line
//  jobWaiters: shopId -> Set of waiting requests. As soon as a job is ready,
//  markShopHasWork() wakes them up immediately.
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
/** true = a job arrived | false = timed out or the line dropped */
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
/** As soon as a job is ready, put it in the registry — the next poll picks it up at once. */
function markShopHasWork(shopId) {
  if (!shopId) return;
  shopsWithWork.add(String(shopId));
  wakeJobWaiters(shopId);   // wake the waiting requests IMMEDIATELY
}

/**
 * SAFETY SWEEP — ONE query every 20 sec (a single one for all shops).
 * It reconciles the registry with the DB so no job is ever missed,
 * whichever path made it 'paid', or if the server restarted,
 * or if more than one instance is running.
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
    // Replace the whole list — anything not here is already done
    shopsWithWork.clear();
    fresh.forEach(id => shopsWithWork.add(id));
    // If the sweep found new work, wake the waiting requests too
    fresh.forEach(id => wakeJobWaiters(id));
  } catch (e) {
    // If the sweep fails, do not touch the registry. Carrying on with the old list
    // is safe: at worst it costs one extra query; no job gets
    // stuck.
    console.error('Work sweep failed (continuing with the old list):', e.message);
  }
}

/** Write the collected heartbeats to the DB in one go. */
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
 * Token cache for verifyAgent. This middleware ran on EVERY poll and
 * ran `SELECT agent_token FROM shops` every time — 72 agents x every
 * 5-12 sec. The token changes only rarely (on disconnect), and on
 * disconnect we clear the cache ourselves — so this is safe.
 */
const agentTokenCache = new Map();   // shopId -> { token, at, missing? }
const AGENT_TOKEN_TTL_MS = 5 * 60 * 1000;

// The "shop does not exist" answer is cached too — otherwise the agent of a
// deleted demo shop (which keeps polling forever) reached the DB every time.
// On 2026-09-08 that was 79% of all database traffic, and 99% of those
// answers were empty.
//
// A missing shop almost always stays missing, so 10 minutes is plenty —
// and if some unusual case ever happens, the system corrects itself.
// invalidateAgentToken() clears the cache on disconnect anyway.
const AGENT_MISS_TTL_MS = 10 * 60 * 1000;

// An upper bound on the Map. If someone sprayed random shopIds, each new id
// would create an entry and memory would quietly keep growing. A Map keeps
// insertion order, so the oldest entry is evicted first.
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

/** The shop's demo info — from the cache, otherwise once from the DB. */
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

// Fill the registry once when the server starts, then keep it running
setTimeout(sweepShopsWithWork, 3000);
setInterval(sweepShopsWithWork, WORK_SWEEP_MS);
setInterval(flushHeartbeats, HEARTBEAT_FLUSH_MS);

pool.on('error', (err) => {
  console.error('DB pool idle-client error (the server will NOT crash):', err.message);
});

app.use(cors());
app.disable('x-powered-by');

// ── ETag disabled on dynamic responses ──
// Express hashes every res.json() and adds an ETag. Poll data can change
// every time, so the agent never gets a 304 anyway —
// the hashing CPU and ~35 B/response are both wasted. NO effect on static files:
// express.static creates its own ETag (etag:true in its options).
app.set('etag', false); // remove Express's "X-Powered-By: Express" header — less tech-stack fingerprinting
// verify: stash the raw body — the Razorpay webhook signature is an HMAC over
// the RAW body, not the parsed JSON
// Security headers — no need for the helmet package; these headers are enough
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // ── Do not send browser-only headers on the API ──
  // CSP, X-Frame-Options and Permissions-Policy only matter when a
  // BROWSER renders HTML. They are useless on JSON API responses — especially
  // for the print agent, which is Python and never even reads them.
  //
  // That was ~900 bytes PER RESPONSE (the CSP alone was 868 B). At 1.1 million
  // requests/day that came to ~1 GB/day, for no benefit at all.
  //
  // nosniff and HSTS are still sent — they matter for the API too.
  if (req.path.startsWith('/api/')) {
    if (req.headers['x-forwarded-proto'] === 'https')
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    return next();
  }

  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // ⚠️ camera=() means "camera for NOBODY" — not even this site
  // itself. This header ranks ABOVE the browser's site setting, so even when
  // Chrome showed Camera as "Ask first", getUserMedia immediately returned
  // NotAllowedError and the permission popup could never appear.
  // The same in a fresh browser (Brave) — because the block was never in the browser.
  // Before the Smart Scanner no camera was needed, so this was fine then.
  // Now camera=(self) is needed: permission for our own site only, never for any
  // iframe/third party. Microphone and location stay completely off as before.
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(self)');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  // CSP — the site still uses a lot of inline <script>/onclick/style (the whole
  // codebase is built on this pattern), so 'unsafe-inline' has to stay,
  // otherwise everything breaks. It still gives a real benefit: if an attacker
  // ever injects <script src="..."> or an <iframe> into the HTML, it can only
  // load from these listed domains — everything else (such as evil.com) is blocked.
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

// JSON body 50mb -> 2mb. File uploads go through MULTER (which has its own
// separate 50mb limit) — so uploads are unaffected. Previously anyone could
// keep sending a 50mb JSON and fill Render's 512MB of RAM.
// A whole database arrives on the restore route, so it is read first with a
// limit of its own. Every other request keeps the small one below.
app.post('/api/superadmin/migration/import', express.json({ limit: '256mb' }));
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
// HTML pages are ALWAYS fresh — without this, Chrome on phones shows old HTML
// from the cache for hours (the real reason behind "it is not fixed" after every push).
// Only pages (extension-less routes + .html) — images/assets stay cached.
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (!p.startsWith('/api/') && (p.endsWith('.html') || !p.slice(1).includes('.'))) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
  next();
});
// ══════════════════════════════════════════════════════════════
// BANDWIDTH — this was the biggest cost
//
// 1) gzip/brotli: HTML drops from ~182 KB to ~30 KB (6x less).
//    One visitor used to cost 182 KB, now ~30 KB.
// 2) Cache headers: returning visitors do not need the file sent
//    again — the server only sends "304 Not Modified" (0 bytes).
// ══════════════════════════════════════════════════════════════
app.use(compression({
  level: 6,                       // balance between speed and size
  threshold: 1024,                // compressing anything smaller than 1 KB is pointless
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

app.use((req,res,next)=>{
  if (require('./echel-edition').retiredRoute(req.path)) return res.status(404).json({error:'Page not found'});
  next();
});

/*
 * WEBSITE MAINTENANCE — Superadmin → 🚧 Website Maintenance.
 *
 * Turned on, every page shows a short notice instead of the site, whether a
 * visitor typed the address or followed a link. Three things stay open on
 * purpose:
 *
 *   • /superadmin and its API — otherwise the switch could never be turned
 *     back off from anywhere;
 *   • /healthz — the host watches it, and a failing check restarts the server;
 *   • the desktop agents — a shop mid-print should not lose the job it is
 *     already holding. Nothing new can arrive anyway, because the customer
 *     page is behind the notice.
 *
 * The value is cached for a minute: this runs on every single request.
 */
let _maintenanceOn = false, _maintenanceAt = 0;
async function maintenanceMode() {
  if (Date.now() - _maintenanceAt < 60000) return _maintenanceOn;
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='maintenance_mode'");
    _maintenanceOn = r.rows.length ? r.rows[0].value === '1' : false;
  } catch (e) { /* on a database hiccup keep whatever we had */ }
  _maintenanceAt = Date.now();
  return _maintenanceOn;
}
function setMaintenanceCache(on) { _maintenanceOn = !!on; _maintenanceAt = Date.now(); }

// What stays reachable while the notice is up.
function maintenanceAllows(path) {
  return /^\/superadmin(?:\.html)?\/?$/i.test(path)
    || path.startsWith('/api/superadmin/')
    || path === '/healthz'
    || path === '/api/captcha'
    || path.startsWith('/api/i18n')
    || path.startsWith('/api/agent/')
    || path.startsWith('/api/jobs/')
    || path.startsWith('/i18n/')
    || path.startsWith('/fonts/')
    || path.startsWith('/img/')
    || /\.(css|js|png|jpe?g|gif|ico|svg|webmanifest|woff2?|ttf|mp3)$/i.test(path);
}

app.use((req, res, next) => {
  if (maintenanceAllows(req.path)) return next();
  maintenanceMode().then(on => {
    if (!on) return next();
    res.set('Cache-Control', 'no-store');
    // A browser asking for a page gets the notice; anything else gets an
    // answer it can actually read.
    if (String(req.headers.accept || '').includes('text/html'))
      return res.status(503).sendFile(path.join(__dirname, 'public', 'maintenance.html'));
    res.status(503).json({ error: 'Echel is being updated right now. Please try again in a little while.', maintenance: true });
  }).catch(() => next());
});
app.use(express.static('public', {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (/\.(js|css)$/i.test(filePath)) {
      // ⚠️ This used to be 7 days (max-age=604800), and that comment said
      // "if it changes, the etag will tell" — that is WRONG.
      // Within a plain max-age the browser DOES NOT ASK the server at all; it serves
      // straight from its cache. An etag only helps when a request is actually made.
      // Result: even after deploying new JS, returning customers got the OLD file
      // for 7 days — the new code never ran.
      // Now it asks every time; if the file has not changed the server sends 304
      // (0 bytes), and if it has, the new one arrives immediately.
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    } else if (/\.(png|jpg|jpeg|svg|ico|woff2?)$/i.test(filePath)) {
      // Images/fonts change only rarely — a 7-day cache is fine for them
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else if (/\.html$/i.test(filePath)) {
      // HTML — check every time, but send 304 (0 bytes) if unchanged
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  }
}));

// ─── Canonical host redirect ───
// Old customers' QR codes / bookmarks / links shared on WhatsApp still point to
// the onrender.com address or www. Send them to the canonical domain — path,
// query string, everything as-is. Until the PRIMARY_HOST env is set, the redirect
// stays off (to avoid getting stuck on staging/local).
const PRIMARY_HOST = process.env.PRIMARY_HOST || '';
if (PRIMARY_HOST) {
  app.use((req, res, next) => {
    // NEVER redirect API calls — on a 301 the POST body is dropped
    // (clients turn POST into GET) and every agent in the field
    // starts getting 404s (printer list, complete/failed reports, all of them).
    if (req.path.startsWith('/api/')) return next();
    const host = (req.headers.host || '').toLowerCase().split(':')[0];
    // www.echel.in, onrender.com — everything goes to the canonical host (SEO: a single
    // domain ranks, no duplicate content)
    // Do NOT redirect a white-label subdomain (abc.echel.in) —
    // otherwise the reseller's brand gets thrown onto the main site as soon as it opens.
    // www and the other hosts (onrender.com etc.) redirect as before.
    const isWlSubdomain = PRIMARY_HOST && host.endsWith('.' + PRIMARY_HOST) && host !== 'www.' + PRIMARY_HOST;
    if (host && host !== PRIMARY_HOST && !isWlSubdomain && host !== 'localhost' && host !== '127.0.0.1') {
      return res.redirect(301, 'https://' + PRIMARY_HOST + req.originalUrl);
    }
    next();
  });
}

// ═══════════════════════════════════════════════
// ANTI-ABUSE / SECURITY LAYER
// Goal: no bot should be able to hammer the Demo Creation or Upload endpoint in a
// loop and burn Cloudinary uploads and Render bandwidth.
// The most important rule: all these checks run BEFORE the EXPENSIVE work (PDF
// processing, the Cloudinary call) — never after.
//
// A genuine customer must never be blocked. Therefore:
//   - the limits are generous and can be changed through env
//   - an IP alone is not treated as an identity (mobile networks share one IP)
//   - a block is always TEMPORARY, never a permanent ban
const SEC = {
  demoIpMax:      parseInt(process.env.DEMO_RATE_LIMIT      || '3', 10),
  demoWindowMin:  parseInt(process.env.DEMO_RATE_WINDOW     || '15', 10),
  // How many demos per IP in 24 hours. Mobile users are often behind carrier NAT
  // (one public IP, thousands of people) — there this limit would stop everyone.
  // So it can now be changed through env, without touching the code.
  demoDailyPerIp: parseInt(process.env.DEMO_DAILY_PER_IP    || '2', 10),
  // Only after this many hits (successful + failed) is it treated as spam and
  // temporarily blocked. An honest user retries 3-4 times — this is far above that.
  demoAbuseHits:  parseInt(process.env.DEMO_ABUSE_HITS      || '40', 10),
  uploadsPerDemo: parseInt(process.env.MAX_UPLOADS_PER_DEMO || '10', 10),
  uploadsPerMin:  parseInt(process.env.MAX_UPLOADS_PER_MINUTE || '12', 10),
  burstMin:       parseInt(process.env.MIN_UPLOAD_GAP_MS    || '1500', 10),
  burstStrikes:   parseInt(process.env.BURST_STRIKES        || '5', 10),
  blockMin:       parseInt(process.env.ABUSE_BLOCK_DURATION || '15', 10),
  // ── CUSTOMER (the person who scans the QR) ──
  // These are completely separate from the SHOP limits. One bad customer must not
  // shut down the whole shop — so a block applies only to that customer,
  // never to the shop.
  //
  // The count is generous: one person may print 3-4 different files, which is
  // normal. More than 6 within 5 minutes = someone is playing around.
  custJobsMax:    parseInt(process.env.CUST_JOBS_MAX     || '6', 10),
  custWindowMin:  parseInt(process.env.CUST_WINDOW_MIN   || '5', 10),
  // The device id comes from localStorage — in incognito a new one is created
  // every time. So there is also a broader IP-based net, but a VERY generous one:
  // on a cyber cafe's WiFi all customers share the same IP.
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
// Written to the DB so the superadmin can see it, but best-effort:
// if logging fails, the request never fails.
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
// Only one instance runs on Render, so in-memory is enough and the DB
// is not hit on every request. When moving to multiple instances, move
// these to Redis/Upstash — the logic stays the same.
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

// ── PERMANENT BLOCKLIST ──
// The abuseBlocks below last 15 minutes and are wiped on restart.
// This one is different: it lives in the DB, the superadmin sets it, and it
// stays until it is removed.
//
// It applies only to creating a NEW SHOP and requesting a DEMO — not to the whole site.
// The reason is written at the top of the file (CGNAT).
//
// A 60-second cache avoids going to the DB every time. Adding/removing a
// block clears the cache immediately, so the superadmin never has to wait.
let _ipBanCache = { at: 0, set: new Set() };
const IP_BAN_TTL_MS = 60 * 1000;

async function bannedIps() {
  if (Date.now() - _ipBanCache.at < IP_BAN_TTL_MS) return _ipBanCache.set;
  try {
    const r = await pool.query('SELECT ip FROM blocked_ips');
    _ipBanCache = { at: Date.now(), set: new Set(r.rows.map(x => x.ip)) };
  } catch (e) {
    // If the DB is unavailable, keep using the old cache — do not shut down registration.
    console.warn('Could not read blocked_ips:', e.message);
    _ipBanCache.at = Date.now();
  }
  return _ipBanCache.set;
}

function clearIpBanCache() { _ipBanCache = { at: 0, set: _ipBanCache.set }; }

// The permanent customer block — the same approach as the IP block above.
let _custBanCache = { at: 0, set: new Set() };

async function bannedCustomers() {
  if (Date.now() - _custBanCache.at < IP_BAN_TTL_MS) return _custBanCache.set;
  try {
    const r = await pool.query('SELECT cid FROM blocked_customers');
    _custBanCache = { at: Date.now(), set: new Set(r.rows.map(x => x.cid)) };
  } catch (e) {
    // If the DB is unavailable, keep using the old cache — do not stop printing.
    console.warn('Could not read blocked_customers:', e.message);
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
 * The upload failed because of a SERVER error — give that shop its burst strike back.
 *
 * This is exactly what happened on 9 Sept: the amount was a decimal and the column
 * INTEGER, so every upload returned 500. The customer kept retrying
 * (what else could they do), and the burst detector took it for "abuse" and
 * blocked the WHOLE SHOP.
 *
 * In other words the shop was punished for our own mistake — 15 minutes closed.
 * Now our mistake refunds the strike, and `last` is zeroed too so the next
 * attempt is not counted as "too soon".
 *
 * Note: this LOWERS the count; it does not lift a block. It does not need to —
 * if the shop were already blocked, the request would never get this far
 * (the block is checked at the very start). So a real flood is still caught
 * by the per-minute and quota limits.
 */
function pardonUploadFailure(shopId) {
  const e = uploadHits.get(shopId);
  if (!e) return;
  if (e.strikes > 0) e.strikes--;
  e.last = 0;
  uploadHits.set(shopId, e);
}

/*
 * AUTOMATIC BLOCKING — a switch the super admin owns.
 *
 * On (the default) the server blocks an abusive shop or device by itself.
 * Off, it blocks nothing and instead writes down what it would have blocked,
 * so a person decides. The limits themselves do not change either way: an
 * upload that goes over them is still refused, it just does not lead to a
 * block that lasts.
 *
 * The value is cached for a minute — this is read on the upload path, and a
 * database round trip per upload would be paid on every print.
 */
let _autoBlockOn = true, _autoBlockAt = 0;
async function autoBlockEnabled() {
  if (Date.now() - _autoBlockAt < 60000) return _autoBlockOn;
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='auto_block_enabled'");
    _autoBlockOn = r.rows.length ? r.rows[0].value !== '0' : true;
  } catch (e) { /* on a database hiccup keep whatever we had */ }
  _autoBlockAt = Date.now();
  return _autoBlockOn;
}
function autoBlockEnabledNow() { return _autoBlockOn; }
function setAutoBlockCache(on) { _autoBlockOn = !!on; _autoBlockAt = Date.now(); }

/** What the server would have blocked while automatic blocking is off. */
const blockSuggestions = new Map();
const SUGGESTION_TTL_MS = 24 * 3600 * 1000;
function suggestBlock(key, reason) {
  const now = Date.now();
  const prev = blockSuggestions.get(key);
  blockSuggestions.set(key, {
    times: (prev && now - prev.lastAt < SUGGESTION_TTL_MS ? prev.times : 0) + 1,
    reason, lastAt: now
  });
  // A handful of keys is all this is for; drop the oldest rather than grow.
  if (blockSuggestions.size > 200) {
    const oldest = [...blockSuggestions.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
    if (oldest) blockSuggestions.delete(oldest[0]);
  }
  console.warn(`SECURITY SUGGESTION | ${key} | ${reason} (automatic blocking is off)`);
}

/** Temporary block — escalating, never permanent. */
function blockFor(key, minutes, reason) {
  if (!autoBlockEnabledNow()) return suggestBlock(key, reason);
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

/** Demo creation: DEMO_RATE_LIMIT per DEMO_RATE_WINDOW minutes from one IP. */
function demoRateLimit(req, res, next) {
  const ip = clientIp(req);
  // The permanent blocklist applies to demos too. It is async, hence a small wrapper —
  // the rest of the checks run as before.
  isIpBanned(ip).then(banned => {
    if (!banned) return _demoRateLimitRest(req, res, next, ip);
    logSecurityEvent({ ip, endpoint: req.path, method: req.method,
                       action: 'DEMO_REQUEST', reason: 'IP_BANNED',
                       userAgent: req.headers['user-agent'] });
    res.status(403).json({ error: 'Demos are disabled from this connection. Please contact support.' });
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

  // ── A temporary block only for heavy spam ──
  // This used to block based on the count (every success + failure), and the
  // count kept rising even after the block — so the more a user retried, the
  // longer the block became. Now total hits are counted separately and the limit
  // is so high that an honest user (3-4 retries) never reaches it.
  e.hits++;
  if (e.hits > SEC.demoAbuseHits) {
    blockFor('ip:' + ip, SEC.blockMin, 'demo endpoint spam');
    logSecurityEvent({ ip, endpoint: req.path, method: req.method, action: 'DEMO_REQUEST',
                       reason: 'ABUSE_HITS', uploadCount: e.hits,
                       userAgent: req.headers['user-agent'] });
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  // ── The real limit: how many demos were CREATED, not attempts ──
  // This was the biggest bug. The count went up on every POST — even when the request
  // failed validation, the phone was already registered, or the captcha failed.
  // So someone who filled in the form wrongly 3 times got blocked for 15 minutes
  // without a single demo being created. Now the count goes up only when a demo
  // is really created — the handler calls req.countDemoRequest() on success.
  if (e.count >= SEC.demoIpMax) {
    const wait = Math.max(1, Math.ceil((e.resetAt - now) / 60000));
    logSecurityEvent({ ip, endpoint: req.path, method: req.method, action: 'DEMO_REQUEST',
                       reason: 'IP_RATE_LIMIT', uploadCount: e.count,
                       userAgent: req.headers['user-agent'] });
    return res.status(429).json({
      error: `This network has already used ${SEC.demoIpMax} demos. Try again in ${wait} minutes, or register directly.`
    });
  }

  req.countDemoRequest = function () {
    const cur = demoIpHits.get(ip);
    if (cur) cur.count++;
  };
  next();
}

/** Cloudflare Turnstile — enforced only when the secret is set. */
async function verifyTurnstile(token, ip) {
  if (!SEC.turnstileSecret) return { ok: true, skipped: true };   // not configured
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
    // If Cloudflare is down, do not block genuine users — fail open;
    // all the other layers (rate limit, quota, burst) still apply.
    console.warn('Turnstile verify failed (fail-open):', e.message);
    return { ok: true, degraded: true };
  }
}

// ═══════════════════════════════════════════════════════════════════
//  OUR OWN CAPTCHA  — no third party (neither Google nor Cloudflare)
// ═══════════════════════════════════════════════════════════════════
//
// HOW IT WORKS (no table is created, no memory fills up):
//
//   1. The browser requests /api/captcha
//   2. The server picks 5 characters, draws them as a distorted SVG,
//      and returns a TOKEN:   nonce . expiry . HMAC(nonce|expiry|answer)
//   3. The browser shows the image; the user types the answer
//   4. The token + answer come back with the login. The server rebuilds the
//      HMAC from that answer and compares.
//
// The answer is never sent, so it never needs to be stored anywhere —
// neither in the DB nor in memory. Whether the server restarts or two instances
// are running, it works in both places.
//
// To stop one captcha from being used twice, a small used-nonce list is kept
// in memory (it cleans itself up).
//
// TWO WAYS TO TURN IT OFF (neither needs a deploy):
//   Render env var :  CAPTCHA_OFF=1          <- immediate, no DB needed
//   DB             :  UPDATE system_settings SET value='0' WHERE key='captcha_enabled';
//
// THE TRUTH: this stops scripts/bots. A human sitting down to solve it will not
// be stopped — so loginLimiter (the rate limit) remains the real protection,
// and the captcha is one more layer on top of it.

const CAPTCHA_TTL_MS = 3 * 60 * 1000;          // 3 minute me expire
const CAPTCHA_LEN    = 5;
// I, l, 1, O, 0 were removed — they look alike on screen and it is the
// genuine user who makes the mistake.
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

// Whether the captcha is enabled. If the DB fails, FALSE — otherwise a DB
// problem would lock everyone out of login.
async function captchaEnabled() {
  if (process.env.CAPTCHA_OFF === '1') return false;
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='captcha_enabled'");
    return !r.rows.length || r.rows[0].value !== '0';
  } catch (e) {
    console.warn('captchaEnabled check failed (skipping):', e.message);
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
  // wavy lines — they trip up OCR
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
  // each character in its own place, at its own angle, in its own size
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
    // Sent as a data URI and placed in an <img> — so there is no way
    // for any markup to be injected into the page.
    image: 'data:image/svg+xml;base64,' + Buffer.from(captchaSvg(ans), 'utf8').toString('base64')
  };
}

function verifyCaptchaToken(token, answer) {
  if (!token || !answer) return { ok: false, why: 'Fill in the captcha' };
  const p = String(token).split('.');
  if (p.length !== 3) return { ok: false, why: 'The captcha is invalid — get a new one' };
  const nonce = p[0], exp = parseInt(p[1], 10), sig = p[2];
  if (!exp || Date.now() > exp) return { ok: false, why: 'The captcha has expired — get a new one' };

  const want = captchaSign(nonce, exp, answer);
  const a = Buffer.from(sig), b = Buffer.from(want);
  // timingSafeEqual throws when the lengths differ — check that first
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return { ok: false, why: 'Wrong captcha' };

  // Each captcha works only once
  if (_captchaUsed.has(nonce)) return { ok: false, why: 'This captcha has already been used — get a new one' };
  _captchaUsed.set(nonce, exp);
  return { ok: true };
}

// At the start of every login route: `if (!(await captchaGuard(req, res))) return;`
// `captcha: true` is sent so the page immediately requests a new captcha.
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

// A new captcha. Creating one needs neither the DB nor the disk — only CPU, so
// it does not need to be rate-limited.
app.get('/api/captcha', async (req, res) => {
  try {
    if (!(await captchaEnabled())) return res.json({ enabled: false });
    const c = makeCaptcha();
    res.set('Cache-Control', 'no-store');
    res.json({ enabled: true, token: c.token, image: c.image });
  } catch (e) {
    // If the captcha cannot be generated, do not block login
    console.error('Failed to generate the captcha:', e.message);
    res.json({ enabled: false });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  LANGUAGES / TRANSLATIONS
// ═══════════════════════════════════════════════════════════════════
//
// The `translations` table already existed (lang, source, text) — but its API
// routes did NOT EXIST ANYWHERE. Because of that:
//
//   • Superadmin's "🌐 Languages" tab requested /api/i18n, got the 404
//     HTML page, and `.json()` choked on `<` —
//     showing "Unexpected token '<'" on screen.
//
//   • The public i18n.js requests /api/i18n/dict. It handles a 404
//     silently (it checks r.ok), so the website did NOT
//     BREAK — but no translation made in the panel ever
//     reached the website.
//
// The language list must match the public i18n.js's own LANGS EXACTLY,
// otherwise the panel would show one language while the website runs another.
//
// English is the SOURCE language: every page is written in English, so it has
// no dictionary and nothing is stored for it. The `translations` table holds
// only the corrections an admin makes to the other languages; they are merged
// on top of the bundled public/i18n/<lang>.js file.
const I18N_LANGS = { en: 'English', 'mni-mtei': 'Manipuri (Meitei Mayek)' };
// Do not look up `I18N_LANGS[lang]` directly on an object — names like
// 'constructor' come back truthy and slip past the validation.
function isKnownLang(l) {
  return Object.prototype.hasOwnProperty.call(I18N_LANGS, l);
}

// Which languages are available (Superadmin's dropdown is filled from this)
app.get('/api/i18n', (req, res) => {
  res.json({ langs: I18N_LANGS, source: 'en' });
});

// The product's own translation — the file the website ships with.
// Superadmin's corrections are stored in `translations` and applied on top of
// it, so the panel has to show both: every English line the website can say,
// the translation it ships with, and the correction when one was made.
const BUNDLED_DICTS = { 'mni-mtei': path.join(__dirname, 'i18n', 'manipuri.json') };
const _bundledCache = {};
function bundledDict(lang) {
  const file = BUNDLED_DICTS[lang];
  if (!file) return {};
  try {
    const at = fs.statSync(file).mtimeMs;
    const hit = _bundledCache[lang];
    if (hit && hit.at === at) return hit.dict;
    const dict = JSON.parse(fs.readFileSync(file, 'utf8'));
    _bundledCache[lang] = { at, dict };
    return dict;
  } catch (e) {
    console.error('Bundled dictionary could not be read:', e.message);
    return (_bundledCache[lang] && _bundledCache[lang].dict) || {};
  }
}

// A line is looked up by the text as the page shows it, with runs of spaces and
// line breaks collapsed (public/i18n.js does the same). Pasted text therefore
// still finds its line even when it carries a stray newline or double space.
function normSource(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// The dictionary for public pages. i18n.js merges it ON TOP OF the
// bundled dictionary.
app.get('/api/i18n/dict', async (req, res) => {
  try {
    const lang = String(req.query.lang || '').slice(0, 8);
    // English needs no dictionary — the website's own text is already English.
    if (!lang || lang === 'en' || !isKnownLang(lang)) return res.json({ lang, dict: {} });
    const r = await pool.query('SELECT source, text FROM translations WHERE lang=$1', [lang]);
    const dict = {};
    r.rows.forEach(x => { if (x.text) dict[x.source] = x.text; });
    // A correction made in the panel reaches the website within a minute.
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ lang, dict });
  } catch (e) {
    // Never return a 500 here — the website page depends on this
    console.error('i18n dict error:', e.message);
    res.json({ dict: {} });
  }
});

// Superadmin: every line of one language — the translation the website ships
// with, plus the correction when one was made. Listing only the corrections
// meant an empty page on the first visit and the English text had to be typed
// out by hand, which only matches when it is typed exactly right.
app.get('/api/superadmin/translations', verifySuperAdmin, async (req, res) => {
  try {
    const lang = String(req.query.lang || 'mni-mtei').slice(0, 8);
    if (!isKnownLang(lang)) return res.status(400).json({ error: 'Unknown language' });
    const base = bundledDict(lang);
    const r = await pool.query('SELECT source, text FROM translations WHERE lang=$1', [lang]);
    const edits = new Map();
    r.rows.forEach(x => { edits.set(x.source, x.text); });
    const rows = [];
    Object.keys(base).forEach(src => {
      const edited = edits.has(src);
      rows.push({ source: src, base: base[src], text: edited ? edits.get(src) : base[src], edited });
    });
    // Corrections for text that is built at runtime have no bundled line.
    edits.forEach((text, src) => {
      if (!Object.prototype.hasOwnProperty.call(base, src))
        rows.push({ source: src, base: '', text, edited: true });
    });
    const c = await pool.query('SELECT lang, COUNT(*)::int AS n FROM translations GROUP BY lang');
    const counts = {};
    c.rows.forEach(x => { counts[x.lang] = x.n; });
    res.json({ lang, rows, counts, langs: I18N_LANGS, bundled: Object.keys(base).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Superadmin: save the lines that were changed. A line typed back to the
// translation the website ships with — or emptied — is stored no more, so the
// table holds corrections only and never a copy of the whole dictionary.
app.put('/api/superadmin/translations', verifySuperAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const lang = String(b.lang || '').slice(0, 8);
    // English is the source language, so there is nothing to save into it.
    if (!isKnownLang(lang) || lang === 'en')
      return res.status(400).json({ error: 'Choose the language to translate into (Manipuri / Meitei Mayek)' });

    const items = Array.isArray(b.items) ? b.items.slice(0, 5000) : [];
    const base = bundledDict(lang);
    let saved = 0, removed = 0;
    for (const it of items) {
      const src = normSource(it && it.source);
      const txt = String((it && it.text) || '').trim();
      if (!src) continue;
      if (!txt || txt === base[src]) {
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

/** How often the demo upload quota count is refreshed — 1 hour. */
const QUOTA_WINDOW_MS = 60 * 60 * 1000;

/**
 * Upload quota + burst detection, per demo/shop.
 * This is a CIRCUIT BREAKER: once it trips, both PDF processing and
 * Cloudinary stop.
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
  // `total` used to NEVER reset. Hitting the quota caused a 15-min
  // block, and when the block ended `total` was still above the limit on the
  // next upload — so it was IMMEDIATELY blocked again. The shop stayed stuck
  // forever (this happened to a real customer: 3 prints, 16 blocks).
  if (!e.totalResetAt || now > e.totalResetAt) {
    e.total = 0;
    e.totalResetAt = now + QUOTA_WINDOW_MS;
  }

  // Burst: uploads in quick succession with very short gaps
  if (e.last && (now - e.last) < SEC.burstMin) {
    e.strikes++;
    if (e.strikes >= SEC.burstStrikes) {
      uploadHits.set(shopId, e);
      blockFor(key, SEC.blockMin, 'upload burst');
      return { ok: false, reason: 'UPLOAD_BURST',
               error: 'Uploads are coming in too fast. Please wait a moment and try again.' };
    }
  } else if (e.strikes > 0 && (now - e.last) > 10000) {
    e.strikes--;                       // if it stayed calm, forgive the strike
  }

  e.count++; e.last = now; e.total++;
  uploadHits.set(shopId, e);

  if (e.count > SEC.uploadsPerMin) {
    blockFor(key, SEC.blockMin, 'uploads per minute exceeded');
    return { ok: false, reason: 'UPLOAD_RATE',
             error: 'Too many uploads in a short time. Please try again in a few minutes.' };
  }
  // A total upload quota for demos too (separate from the print limit — these are attempts)
  // Note: this is not the PRINT limit, it counts upload ATTEMPTS. For one print
  // a customer often makes 2-3 attempts — changing the file, picking pages,
  // refreshing. The multiplier used to be 3, so a 10-print demo ran out after
  // only 30 attempts. Now it is 8 (with a rolling 1-hour window).
  if (isDemo && e.total > SEC.uploadsPerDemo * 8) {
    blockFor(key, SEC.blockMin, 'demo upload quota exceeded');
    return { ok: false, reason: 'DEMO_UPLOAD_QUOTA',
             error: `Too many upload attempts. Try again in ${SEC.blockMin} minutes.` };
  }
  return { ok: true, count: e.count, total: e.total };
}

/**
 * GLOBAL EMERGENCY BRAKE — if the upload rate across the whole server suddenly
 * goes above the threshold (some loop / bug / attack), new uploads are
 * temporarily disabled. The threshold is deliberately generous so it
 * never trips on a normal busy day.
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
// UPLOAD GUARDRAILS — all limits in one place, configurable through env
// ═══════════════════════════════════════════════
const MAX_UPLOAD_MB        = parseInt(process.env.MAX_UPLOAD_MB || '20', 10);
const MAX_UPLOAD_BYTES     = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_PDF_PAGES        = parseInt(process.env.MAX_PDF_PAGES || '20', 10);
// How many SHEETS per job — pages x copies.
//
// The 20-page limit already existed, but copies had no cap: the page
// allowed choosing up to 50 and the server accepted it. That meant 20 x 50 = 1000
// sheets from a single QR scan. Now the total count is capped, so 1 copy of
// 20 pages, 4 copies of 5 pages and 20 copies of 1 page are all fine.
const MAX_JOB_SHEETS       = parseInt(process.env.MAX_JOB_SHEETS || '20', 10);
const DUP_UPLOAD_LIMIT     = parseInt(process.env.DUP_UPLOAD_LIMIT || '5', 10);
const DUP_UPLOAD_WINDOW_MIN= parseInt(process.env.DUP_UPLOAD_WINDOW_MIN || '60', 10);
// How long a job may stay stuck in 'printing' before it is failed + deleted
const STUCK_JOB_TIMEOUT_SEC = parseInt(process.env.STUCK_JOB_TIMEOUT_SEC || '120', 10);
// If a job is stuck in 'printing' for more than this many seconds, hand it to the agent AGAIN.
// The sweeper deletes at 120s — keeping this at 45s allows 2-3 re-handouts
// in between.
const ORPHAN_RECLAIM_SEC    = parseInt(process.env.ORPHAN_RECLAIM_SEC || '45', 10);
// 0 = fail immediately (per the spec). 1 = retry once. If shops with slow
// printers complain, set this to 1.
const STUCK_JOB_RETRIES     = parseInt(process.env.STUCK_JOB_RETRIES || '0', 10);

const LIMIT_MSG = {
  size:  `File too large. Maximum ${MAX_UPLOAD_MB} MB is allowed.`,
  pages: `Maximum ${MAX_PDF_PAGES} page PDF is allowed.`,
  dup:   `You cannot upload the same file again and again. Please try after some time.`,
  sheets: `At most ${MAX_JOB_SHEETS} sheets can be printed at once. `
        + `Reduce the copies, or have the rest printed at the counter.`
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

// When a Multer limit is exceeded, Express returns a default 500 — the customer
// does not understand it. Return a clear message + the correct status code.
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

// Does the PNG have transparency? Read the IHDR color type (offset 25):
//  type 4 = grayscale+alpha, 6 = RGBA -> there is an alpha channel.
//  type 3 (palette) can also be transparent if it has a tRNS chunk.
// Is it a JPEG? (magic bytes FF D8 FF ... and FF D9 at the end)
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
      // palette PNG: look for the tRNS chunk
      const s = buf.toString('latin1');
      return s.includes('tRNS');
    }
    return false;
  } catch(e) { return false; }
}

async function uploadImageToCloudinary(fileBuffer, mimeType) {
  if (!CLOUD_NAME || !CLD_API_KEY || !CLD_API_SECRET) return Promise.reject(new Error('Cloudinary is not configured'));
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
 * Absolutely no infinite retry loop: at most MAX_CLOUDINARY_RETRIES attempts,
 * exponential backoff, then a final failure. A bug or a network flap cannot
 * burn Cloudinary/Render bandwidth for hours.
 */
async function uploadToCloudinaryWithRetry(fileBuffer, fileType) {
  const max = Math.max(1, Math.min(5, SEC.cldMaxRetries));
  let lastErr = null;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await uploadToCloudinary(fileBuffer, fileType);
    } catch (err) {
      lastErr = err;
      // 4xx = our mistake (bad signature/file) — retrying will not fix it
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
    return Promise.reject(new Error('Cloudinary is not configured — check the Render environment variables (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)'));
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

// What is ACTUALLY stored on Cloudinary — listed through the Admin API.
// Orphan files from the DB's point of view (with no job row) only show up here.
let _sweepTick = 0;

// A file on Cloudinary can be one of 3 "resource types":
//   raw   -> PDF / DOC (what we upload)
//   image -> JPG / PNG (customer photo, passport photo, canvas editor output)
//   video -> almost never, but included for safety
// Only `raw` used to be listed, so the superadmin panel always showed 0
// while files were sitting on Cloudinary. Now all three types are checked.
// Errors are no longer hidden — otherwise even an auth failure showed "0 files".
async function listCloudinaryFilesOfType(resourceType, nextCursor = '', prefix = UPLOAD_PREFIX) {
  if (prefix !== UPLOAD_PREFIX) throw new Error('Only Echel print uploads may be listed.');
  return new Promise((resolve) => {
    if (!CLOUD_NAME || !CLD_API_KEY || !CLD_API_SECRET) {
      return resolve({ resources: [], error: 'Cloudinary keys are not set' });
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

// All files of all three types in one list (with pages)
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

// Keep the old name working (other code uses it)
async function listCloudinaryFiles(nextCursor = '') {
  return listCloudinaryFilesOfType('raw', nextCursor, UPLOAD_PREFIX);
}


// resourceType is required: if you try to delete an image file as 'raw',
// Cloudinary says "not found" and the file stays where it is.
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
  // ── FIRST OF ALL: create every table ──
  //
  // The SQL below is not in order: some ALTERs come BEFORE their table
  // is CREATED (for example the whitelabels ALTER at 3000 and its
  // CREATE at 24000). This was never caught on Supabase because the
  // table already existed there. On a completely empty DB that ALTER throws —
  // and pool.query() runs multiple statements in ONE transaction,
  // so the WHOLE block rolls back. That is exactly what happened live today:
  // 14 tables were never created and 68 shop columns went missing.
  //
  // So CREATE runs first, on its own — every ALTER then finds its table,
  // whatever the order. The old CREATEs below are unchanged;
  // they use IF NOT EXISTS, so running them again breaks nothing.
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

  // ── THEN: create every column ──
  //
  // For the same reason: some "ALTER COLUMN ... TYPE" statements come BEFORE
  // their column is CREATED (price_color_duplex's TYPE at 18659,
  // its ADD at 19642). On an empty DB that throws and
  // the whole block rolls back.
  //
  // Only ADD happens here — type changes and indexes stay in their places
  // below, and now they always find their column.
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
      -- Customer Language: the shop owner chooses the language for their customers.
      -- Empty = nothing chosen = customers see English.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS default_lang VARCHAR(16) DEFAULT '';

      -- WhatsApp To Print: people who registered interest on the homepage.
      -- Only a mobile number — nothing else is asked.
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
      -- The partner's own domain (such as https://sharmadigital.in). When set,
      -- this link goes into the emails of their shops — our domain is not shown.
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
      -- Prevents the same file from being uploaded again and again. The hash comes
      -- from the client (SHA-256). Rows outside the rolling window are removed
      -- automatically, so the table stays small.
      CREATE TABLE IF NOT EXISTS upload_fingerprints (
        shop_id    VARCHAR(50)  NOT NULL,
        file_hash  VARCHAR(64)  NOT NULL,
        hits       INTEGER      NOT NULL DEFAULT 1,
        first_seen TIMESTAMP    NOT NULL DEFAULT NOW(),
        last_seen  TIMESTAMP    NOT NULL DEFAULT NOW(),
        PRIMARY KEY (shop_id, file_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_upload_fp_last_seen ON upload_fingerprints(last_seen);
      -- A record of every block/abuse event. The superadmin uses it to see
      -- who was blocked, when and why. Rows older than 7 days are removed automatically.
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
      -- The shop owner's email — the payment confirmation email goes here
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS email VARCHAR(160) DEFAULT '';
      -- PhonePe is no longer supported. The columns are kept ON PURPOSE: deleted
      -- data cannot be brought back. The code no longer uses them anywhere.
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
      -- The agent's own secret. NULL = an old agent (it keeps working).
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_token VARCHAR(64);
      -- Which PC it is bound to (for display only — the real lock is agent_token)
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_machine VARCHAR(120);
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_bound_at TIMESTAMP;
      -- ── Decimal price support (rates like ₹2.50 / ₹1.50) ──
      -- INTEGER cannot hold 2.5, so these become NUMERIC(10,2).
      ALTER TABLE shops ALTER COLUMN price_bw            TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_color         TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_bw_duplex     TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_color_duplex  TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_4x6_4         TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_4x6_6         TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_4x6_10        TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_resume_color  TYPE NUMERIC(10,2);
      ALTER TABLE shops ALTER COLUMN price_resume_bw     TYPE NUMERIC(10,2);
      -- The same applies to print_jobs.amount. All the rates above
      -- had become NUMERIC, but the column where the rate lands after being
      -- MULTIPLIED was still INTEGER.
      --
      -- Result: for a shop whose rate was not a whole rupee (such as ₹1.5),
      -- Postgres threw an error on every upload —
      --     invalid input syntax for type integer: "10.5"
      -- — and the customer only saw "Upload failed (500)".
      ALTER TABLE print_jobs ALTER COLUMN amount TYPE NUMERIC(10,2);
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_color_duplex INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS printer_name_4x6 VARCHAR(300) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS printer_name_a3 VARCHAR(300) DEFAULT '';
      -- ---- DUPLEX: its own printer + per-mode on/off ----
      -- In many shops only ONE printer can do duplex (or only the B&W
      -- one). Duplex used to always go to the B&W/Color printer
      -- and customers saw it in both modes -- so on a printer without duplex
      -- the order arrived and got stuck.
      -- The default is TRUE, so the behaviour of old shops does not change at all.
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
      -- Which advance features this shop has bought (a list of feature ids).
      -- advanced_unlocked still exists (old code uses it),
      -- but this column is the real source of truth. The list of Premium shops is not
      -- checked — they get the full catalog.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS owned_features TEXT[] DEFAULT '{}';
      -- Agents now sell two plans (Pro + Premium). agent_price is for Pro;
      -- Premium has its own, otherwise an agent would sell Premium at the
      -- Pro rate.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS agent_premium_price INTEGER DEFAULT 0;
      -- For the ₹49 single-feature order. At verify time we do not trust the
      -- featureId sent by the client — whatever was requested when the order
      -- was created is read from here.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS feature_order_id  VARCHAR(64) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS feature_order_fid VARCHAR(40) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS advanced_order_id VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_4 INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_6 INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_10 INTEGER DEFAULT 0;
      -- The 8-photo sheet rate. This column is DELIBERATELY created directly as NUMERIC
      -- — placing it in the ALTER COLUMN TYPE group above would, on a new
      -- DB, run that line before the column exists and the whole migration
      -- block would roll back.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_8 NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_4x6_12 NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_scan_active BOOLEAN DEFAULT true;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS page_slabs TEXT DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_resume_color INTEGER DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_resume_bw INTEGER DEFAULT 0;
      -- ── BIG SIZE (A3 / A2 / A1) has its own per-page rate ──
      -- 0 / blank = the old behaviour (the normal B&W/Color rate applies),
      -- so nothing changes for old shops.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a3_bw    NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a3_color NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a2_bw    NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a2_color NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a1_bw    NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS price_a1_color NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS shop_notice VARCHAR(200) DEFAULT '';
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS advanced_active BOOLEAN DEFAULT true;
      -- 4 separate modules inside Advance. Each has its own switch, so the
      -- owner shows customers only the features that work in their shop.
      -- Default true = old shops behave exactly as before.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_legal_active  BOOLEAN DEFAULT true;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_resume_active BOOLEAN DEFAULT true;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_4x6_active    BOOLEAN DEFAULT true;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_a3_active     BOOLEAN DEFAULT true;
      -- Mini Print: 2/4/6/8/9/12/16 pages on one A4 sheet (saves paper)
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS adv_mini_active   BOOLEAN DEFAULT true;
      -- Give old demo accounts the advanced features too. Only for demos —
      -- the paywall for paid shops stays exactly as it was.
      UPDATE shops SET advanced_unlocked = true
       WHERE demo = true AND advanced_unlocked = false;
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS shop_logo VARCHAR(400) DEFAULT '';
      -- ── PhonePe was removed ── online payment for shops that used PhonePe
      -- no longer works, so they are switched to counter cash.
      -- As soon as the owner adds Razorpay/Cashfree in their panel, online payment is back.
      -- Running it again does nothing — after the first run no row matches.
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
      -- Old rows keep the status 'approved' (DEFAULT), so demos that were
      -- already created are not affected.
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
      -- The IP of whoever created the shop. It used to not be saved anywhere,
      -- so "which IP created it" could never be answered.
      ALTER TABLE shops ADD COLUMN IF NOT EXISTS created_ip VARCHAR(60) DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_shops_created_ip ON shops(created_ip);
      -- The permanent blocklist. The abuseBlocks Map lasts only 15 minutes and
      -- is wiped on every restart — for a repeat offender that is
      -- not enough.
      CREATE TABLE IF NOT EXISTS blocked_ips (
        ip         VARCHAR(60) PRIMARY KEY,
        reason     VARCHAR(200) DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
      -- Which CUSTOMER submitted the job. It used to not be saved anywhere,
      -- so "this person keeps doing it" or "this person's job keeps
      -- being denied" — neither question could be answered.
      -- It stays empty on old jobs; it fills in from now on.
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS customer_id VARCHAR(48) DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_jobs_customer ON print_jobs(customer_id);
      -- The PERMANENT customer block. The abuseBlocks above last 15 minutes
      -- and are wiped on restart — for a repeat offender that is
      -- not enough. This one stays until the superadmin removes it.
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

      -- ══ PLATFORM PAYMENTS — every rupee that reached OUR account ══
      -- There used to be only the shops.setup_paid flag; advanced unlocks (₹199) and
      -- renewals were never recorded at all — so nothing showed up in
      -- superadmin. Now every payment gets a row.
      --   kind: 'setup' | 'advanced' | 'renewal' | 'wl_license'
      -- payment_id has a UNIQUE index → even if webhook + verify + reconcile
      -- all fire, only one row is created (no double counting).
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
      -- source = the English source text written in the HTML (this is the "key").
      -- One row per language. When one is missing, the source text shows —
      -- so an incomplete translation breaks nothing.
      CREATE TABLE IF NOT EXISTS translations (
        id SERIAL PRIMARY KEY,
        lang VARCHAR(8) NOT NULL,
        source TEXT NOT NULL,
        text TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tr_lang_src ON translations(lang, md5(source));
      CREATE INDEX IF NOT EXISTS idx_tr_lang ON translations(lang);

      -- ══ REVIEWS — customer reviews shown on the homepage ══
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

      -- ══ WHITE LABEL — a reseller sells under their own brand ══
      -- The reseller uses their own Razorpay, so the setup fee of their shops goes
      -- STRAIGHT to their account (it does not come to us).
      -- We only receive a one-time license fee.
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
      -- The real demo-creation and paid-conversion data already lives in the
      -- 'shops' table; this table only captures the TOP of the funnel, which
      -- is not recorded anywhere else.
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
      -- A shop can submit its own review, but it shows on the homepage only when
      -- the superadmin approves it. Old reviews (added by the superadmin
      -- directly) stay live automatically through DEFAULT 'approved'.
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS status VARCHAR(12) DEFAULT 'approved';
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS shop_id VARCHAR(50) DEFAULT '';
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS state VARCHAR(80) DEFAULT '';
      ALTER TABLE reviews ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT false;
      CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);
      -- 'ref' holds the agent's referral code. Where the visitor came from
      -- (google/facebook/instagram) needs a separate column.
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

    // GRANDFATHER MIGRATION: old shops created BEFORE the setup-fee feature
    // still have setup_paid = false (the default), but they never saw an option
    // to pay a setup fee. Locking them out would be unfair, so they are
    // auto-activated once. This runs only once — it activates only the shops
    // whose qr_code was already generated (by the old flow);
    // future registrations will never match this condition.
    await pool.query(`
      UPDATE shops SET setup_paid = true
      WHERE setup_paid = false AND qr_code IS NOT NULL AND qr_code != '' AND setup_payment_id = ''
    `);

    // Seed the default setup fee (offer + actual price) if the database does not have it yet
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

    // Seed the agent version — if it is not set yet. This version number
    // must be raised every time new print_agent.py code is released, so that
    // Auto-Update triggers on every customer's PC.
    await pool.query(`
      INSERT INTO system_settings (key, value)
      VALUES ('agent_version', '1')
      ON CONFLICT (key) DO NOTHING
    `);
    // ── Display version label (2.0, 2.1, 2.2 ... 2.10, then 3.0) ──
    // 'agent_version' is an INTERNAL counter that only goes up (29, 30, 31...).
    // Old agents (v27/v28/v29) compare this integer to auto-update —
    // so never turn it into "2.0", otherwise all of those agents would
    // stop taking updates forever.
    // The version customers see is this label.
    await pool.query(`
      INSERT INTO system_settings (key, value)
      VALUES ('agent_version_label', '')
      ON CONFLICT (key) DO NOTHING
    `);
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('demo_enabled','1') ON CONFLICT DO NOTHING");
    // Demo lifetime — 1440 minutes = 24 hours.
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('demo_minutes','1440') ON CONFLICT DO NOTHING");
    // Old DBs still hold 120 (2 hours) here. Change it only while it is still
    // that old default — if the superadmin deliberately set another value,
    // touching it would be wrong.
    await pool.query("UPDATE system_settings SET value='1440' WHERE key='demo_minutes' AND value='120'");
    // How many free prints a demo gets (spec: 10)
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('demo_print_limit','10') ON CONFLICT DO NOTHING");
    // '1' = the demo is created instantly (the old behaviour). '0' = the superadmin approves it.
    // Demos are INSTANT now — the Shop ID + password arrive as soon as the form
    // is submitted. The superadmin can switch 'Manual approval' back on if needed
    // (from the Demo Control card).
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('demo_auto_approve','1') ON CONFLICT DO NOTHING");
    // Default prices of the new plans (Starter / Pro / Premium). ON CONFLICT
    // DO NOTHING — so if the superadmin changed them, a restart does not
    // reset them to the defaults.
    await pool.query(`INSERT INTO system_settings (key,value) VALUES
      ('plan_starter_fee','599'), ('plan_starter_actual','2999'),
      ('plan_pro_fee','899'),     ('plan_pro_actual','2999'),
      ('plan_premium_fee','999'), ('plan_premium_actual','2999'),
      -- Default price of a new (non-core) advance feature
      ('addon_feature_fee','49')
      ON CONFLICT DO NOTHING`);
    // One-time flip: existing installs have this key set to '0'.
    // Set it to '1' ONCE, then never touch it again — otherwise the
    // superadmin's manual mode would be wiped on every restart.
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
    // Agent Base Price (0 = not set yet — until then the agent floor = the public
    // Offer Price). Monthly/Advanced Actual Price 0 also means the strikethrough stays
    // hidden until the superadmin explicitly enters one.
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('agent_base_price','0') ON CONFLICT DO NOTHING");
    // White Label — the license fee (one-time) and the reseller's minimum shop price
    // New-shop EMAIL alert. The superadmin sets up SMTP only once;
    // partners do not set anything up — they only enter their email.
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('smtp_host','smtp.gmail.com') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('smtp_port','587') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('smtp_user','') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('smtp_pass','') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('notify_email','') ON CONFLICT DO NOTHING");
    // Whether an alert is sent when a demo is created too. Default ON.
    // To turn it off: UPDATE system_settings SET value='0' WHERE key='demo_alert';
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('demo_alert','1') ON CONFLICT DO NOTHING");
    // Our own captcha on login. Default ON.
    // Off: UPDATE system_settings SET value='0' WHERE key='captcha_enabled';
    // Or the CAPTCHA_OFF=1 env var on Render (immediate, without touching the DB).
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('captcha_enabled','1') ON CONFLICT DO NOTHING");
    // Brevo HTTPS API — hosts like Render block SMTP ports,
    // so this is the default (port 443 is never blocked).
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('brevo_api_key','') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('brevo_sender','') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('wl_license_fee','25000') ON CONFLICT DO NOTHING");
    // The license's "struck-through" price — 0 = not shown at all
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('wl_license_actual','0') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('wl_base_price','0') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('monthly_actual_price','0') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('advanced_actual_price','0') ON CONFLICT DO NOTHING");
    // Festival Offer — a banner + countdown next to the homepage One-Time price.
    // OFF by default; the superadmin turns it ON from the Setup Fee page with a name/date/time.
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('auto_block_enabled','1') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('maintenance_mode','0') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('festival_offer_enabled','0') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('festival_offer_name','') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('festival_offer_end','') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO system_settings (key,value) VALUES ('homepage_config', $1) ON CONFLICT DO NOTHING", [JSON.stringify(BRAND_DEFAULTS)]);

    // Repair broken demo logins (a bcrypt hash was stored by mistake; login
    // expects sha256). Idempotent — only demo shops with $2 (bcrypt) hashes.
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

// Festival Offer — a banner + countdown timer shown on the homepage next to
// the One-Time price. endAt is an ISO datetime string (such as
// "2026-08-15T23:59"); the front end runs the countdown from it.
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

// ── 7-day earnings breakdown (paid only) ──
// Owner: set/clear the notice shown to customers
// Owner: switch advance features on/off (unlocked shops only)
// Owner: upload their shop logo (shown on the customer QR page)
app.post('/api/shop/upload-logo', verifyToken, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    // PNG ONLY (for a transparent background) — JPG/WEBP are not allowed
    if (req.file.mimetype !== 'image/png' || !isPng(req.file.buffer))
      return res.status(400).json({ error: 'Only PNG files are accepted (with a transparent background)' });
    // Max 50 KB
    if (req.file.size > 50 * 1024)
      return res.status(400).json({ error: `The logo must be smaller than 50 KB (it is ${Math.round(req.file.size/1024)} KB now)` });
    // Transparency check — the PNG must have an alpha channel
    if (!pngHasAlpha(req.file.buffer))
      return res.status(400).json({ error: 'The PNG must have a transparent background (it has a solid background now)' });
    const url = await uploadImageToCloudinary(req.file.buffer, req.file.mimetype);
    await pool.query('UPDATE shops SET shop_logo=$1 WHERE id=$2', [url, req.shopId]);
    res.json({ success: true, logoUrl: url });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Owner: remove the logo
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
      return res.status(403).json({ error: 'The Advance Feature is not unlocked' });
    const active = req.body.active === true;
    await pool.query('UPDATE shops SET advanced_active=$1 WHERE id=$2', [active, req.shopId]);
    res.json({ success: true, active });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// The 4 Advance modules — each switched on/off separately.
// The column name comes from a whitelist, so there is no room for SQL injection.
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
    if (!col) return res.status(400).json({ error: 'Invalid module' });
    const chk = await pool.query('SELECT advanced_unlocked FROM shops WHERE id=$1', [req.shopId]);
    if (!chk.rows.length || !chk.rows[0].advanced_unlocked)
      return res.status(403).json({ error: 'The Advance Feature is not unlocked' });
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
    // Busy hours (last 30 days, IST = UTC+5:30)
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
    if (!me.rows.length) return res.status(404).json({ error: 'Shop not found' });
    const earnings = (me.rows[0].referral_earnings || 0) + (me.rows[0].agent_earnings || 0);
    const canRefer = me.rows[0].setup_paid && !me.rows[0].demo; // only paid AND non-demo shops can refer — otherwise a demo user would earn ₹50 for free

    // Withdrawn total (done + pending — subtract both from the balance to prevent a double withdrawal)
    const wd = await pool.query(
      "SELECT COALESCE(SUM(amount),0) as used FROM withdrawals WHERE shop_id=$1 AND status IN ('pending','done')",
      [req.shopId]);
    const used = parseInt(wd.rows[0].used) || 0;
    const available = earnings - used;

    // Referred shops list — name, number, paid status
    const refs = await pool.query(
      // Shops the agent onboarded personally are NOT here — they are accounted for
      // separately in the Agent tab (the ₹200 commission one), otherwise the same shop
      // would appear in both places and cause confusion
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
// AGENT APIs — inside the shop login (verifyToken)
// ══════════════════════════════════════════════════════════════

// My agent status + stats
app.get('/api/agent/status', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id,name,is_agent,agent_code,agent_upi,agent_price,agent_blocked,
              agent_earnings,agent_joined_at,setup_paid,demo
       FROM shops WHERE id=$1`, [req.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    const s = r.rows[0];
    const base = await getAgentBasePrice();  // the agent's own floor, not the public price
    // ---- AN AGENT HAS TWO PLANS: Pro and Premium ----
    // The superadmin sets a separate floor for each (on the Setup Fee page:
    // "PRO - AGENT FLOOR" and "PREMIUM - AGENT FLOOR"). The ref-link
    // registration flow already supports both, but this status API returned
    // only the Pro floor -- so the agent's dashboard always showed
    // just ONE option. Now both are sent.
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
      // the price/markup concept is gone — everyone sells at the same rate
      price: base, base_price: base, max_price: 0, can_set_price: false,
      // New: the list of both plans + the Premium floor. The old fields above
      // are unchanged, so no old panel will break.
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

// Become an agent — paid (non-demo) shop owners only
app.post('/api/agent/join', verifyToken, async (req, res) => {
  try {
    const r = await pool.query('SELECT setup_paid,demo,is_agent,agent_code FROM shops WHERE id=$1', [req.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    const s = r.rows[0];
    if (s.demo || !s.setup_paid)
      return res.status(403).json({ error: 'You must buy a plan before becoming an agent. A demo account cannot become an agent.' });
    if (s.is_agent) return res.json({ success: true, agent_code: s.agent_code, already: true });

    const code = s.agent_code || await genAgentCode();
    await pool.query(
      'UPDATE shops SET is_agent=true, agent_code=$2, agent_joined_at=NOW() WHERE id=$1',
      [req.shopId, code]);
    res.json({ success: true, agent_code: code, link: `${BASE_URL}/?ref=${code}` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Save the UPI ID — the commission is paid to it
app.put('/api/agent/upi', verifyToken, async (req, res) => {
  try {
    const upi = String(req.body.upi_id || '').trim();
    if (!/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(upi))
      return res.status(400).json({ error: 'Enter a valid UPI ID (such as name@bank)' });
    const r = await pool.query('SELECT is_agent FROM shops WHERE id=$1', [req.shopId]);
    if (!r.rows.length || !r.rows[0].is_agent) return res.status(403).json({ error: 'You are not an agent' });
    await pool.query('UPDATE shops SET agent_upi=$2 WHERE id=$1', [req.shopId, upi]);
    res.json({ success: true, upi_id: upi });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── AGENTS CAN NO LONGER SET THEIR OWN PRICE ──
// Old system: the agent set a price above the base and earned the markup.
// New system: one price for everyone — a flat ₹100 commission. The endpoint returns 410
// (removing the route would cause a JS error in the old panel, so it is kept).
app.put('/api/agent/price', verifyToken, async (req, res) => {
  return res.status(410).json({
    error: 'Agents can no longer set their own price. Every shop earns a flat ₹' +
           AGENT_COMMISSION + ' commission.'
  });
});

// The shops I have onboarded
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

// The full earnings record (payout history)
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

// An agent onboards someone's shop personally — generates the Shop ID + password
app.post('/api/agent/onboard', verifyToken, async (req, res) => {
  try {
    const me = await pool.query(
      'SELECT is_agent, agent_blocked, demo FROM shops WHERE id=$1', [req.shopId]);
    // A demo account can SEE everything but cannot onboard a shop.
    // The frontend has a gate too — this is the second layer, so nobody can
    // get through by calling the API directly.
    if (me.rows.length && me.rows[0].demo) {
      return res.status(403).json({
        error: 'To use this feature you must be a paid shop owner',
        needPlan: true
      });
    }
    if (!me.rows.length || !me.rows[0].is_agent) return res.status(403).json({ error: 'You are not an agent' });
    if (me.rows[0].agent_blocked) return res.status(403).json({ error: 'Your agent account is currently paused' });

    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim();
    const address = String(req.body.address || '').trim();
    if (!name) return res.status(400).json({ error: 'The shop name is required' });
    if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });

    // ---- WHICH PLAN ----
    // Only Pro and Premium are sold through the agent channel (not Starter) --
    // exactly the same rule as for ref-link registration.
    // This endpoint used to not ask for a plan at all: every shop became
    // 'onetime' and the price came from the PUBLIC setup fee, not the agent's
    // floor. That is why the superadmin set two floors but the agent saw only
    // one option on the onboarding form.
    let agPlan = normalizePlan(req.body.plan);
    if (!PLANS_BY_CHANNEL.agent.includes(agPlan)) agPlan = 'pro';

    // Each plan has its own agent floor -- and ONLY that applies.
    //
    // The agent's own markup is GONE (PUT /api/agent/price now returns 410,
    // and the status says can_set_price:false). But the rows of old shops still
    // carry `agent_price` -- 1799 for Mahato Net Cafe. This used to be
    // `agent_price > floor ? agent_price : floor`, so the form showed
    // Rs 799 and the shop was created at Rs 1799.
    // Now whatever the superadmin set is what applies.
    const agFloor = agPlan === 'premium'
      ? await getAgentPremiumBasePrice()
      : await getAgentBasePrice();
    const base = agFloor;
    const sold = agFloor;
    const agCycle=(await getPlanPricing())[agPlan].billingCycle;

    // The remaining details — the same as a normal registration
    const printerModel = String(req.body.printer_model || '').trim().slice(0,120);
    const priceBw    = parsePrice(req.body.price_bw);
    const priceColor = parsePrice(req.body.price_color);
    const modes = ['counter_only','both','online_only'];
    const payMode = modes.includes(req.body.payment_mode) ? req.body.payment_mode : 'counter_only';
    // Online payment needs the shop owner's own keys — they add them later
    // in Payment Setup themselves, so an agent can only set counter_only
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
    // The highest-earning agent at the TOP. Below them the shops they
    // onboarded (those go into the same 'shops' array).
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
        markup: 0,                       // the markup concept is gone
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
    if (!r.rows.length) return res.status(404).json({ error: 'Agent not found' });
    res.json({ success: true, blocked: r.rows[0].agent_blocked });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Withdrawal request — min ₹500, UPI required
app.post('/api/shop/withdraw', verifyToken, async (req, res) => {
  try {
    const { upi_id } = req.body;
    if (!upi_id || !/^[\w.\-]+@[\w.\-]+$/.test(upi_id.trim()))
      return res.status(400).json({ error: 'Enter a valid UPI ID (such as name@bank)' });

    const me = await pool.query('SELECT referral_earnings, agent_earnings FROM shops WHERE id=$1', [req.shopId]);
    // Referral (₹50) + Agent commission — both in the same wallet
    const earnings = (me.rows[0]?.referral_earnings || 0) + (me.rows[0]?.agent_earnings || 0);
    const wd = await pool.query(
      "SELECT COALESCE(SUM(amount),0) as used FROM withdrawals WHERE shop_id=$1 AND status IN ('pending','done')",
      [req.shopId]);
    const available = earnings - (parseInt(wd.rows[0].used) || 0);

    if (available < 500) return res.status(400).json({ error: `A withdrawal needs at least ₹500 (you have ₹${available})` });

    // Is there already a pending request?
    const pend = await pool.query("SELECT id FROM withdrawals WHERE shop_id=$1 AND status='pending'", [req.shopId]);
    if (pend.rows.length) return res.status(400).json({ error: 'A withdrawal request is already pending' });

    await pool.query('INSERT INTO withdrawals (shop_id, amount, upi_id) VALUES ($1,$2,$3)',
      [req.shopId, available, upi_id.trim()]);
    res.json({ success: true, amount: available });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════ WITHDRAWALS (superadmin side) ══════════════
// ── MANUAL ACTIVATE — when the payment shows in Razorpay but was not matched
// on the website (browser closed, order_id not stored during a DB outage,
// etc.). It uses activateShop — QR, referral reward, everything the same. ──
app.post('/api/superadmin/shop/:shopId/activate', verifySuperAdmin, async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const ref = String((req.body && req.body.payment_ref) || '').trim().slice(0, 60);
    if (!ref) return res.status(400).json({ error: 'Enter the payment reference/ID (from the Razorpay dashboard)' });
    const chk = await pool.query('SELECT id, setup_paid FROM shops WHERE id=$1', [shopId]);
    if (!chk.rows.length) return res.status(404).json({ error: 'Shop not found' });
    if (chk.rows[0].setup_paid) return res.status(400).json({ error: 'The shop is already active' });
    const { qrUrl } = await activateShop(shopId, 'MANUAL_' + ref);
    console.log(`Manual activation: ${shopId} | ref: ${ref}`);
    res.json({ success: true, qrUrl });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Password reset (superadmin) — for a changed number / forgotten password ──
// Support: +30 days for a monthly shop (cash/offline payment case)
app.post('/api/superadmin/shop/:shopId/extend', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE shops SET paid_until = GREATEST(NOW(), COALESCE(paid_until, NOW())) + make_interval(months=>(${MONTHS_SQL}))
       WHERE id=$1 AND (${MONTHS_SQL})>0 RETURNING paid_until`, [req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    console.log(`Superadmin extend +30d: ${req.params.shopId} -> ${r.rows[0].paid_until}`);
    res.json({ success: true, paid_until: r.rows[0].paid_until });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Support: unlock the Advance Feature for any shop for FREE (without payment)
app.post('/api/superadmin/shop/:shopId/unlock-advanced', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE shops SET advanced_unlocked=true WHERE id=$1 RETURNING id, name",
      [req.params.shopId]);
    // A manual unlock grants the core pack too — otherwise a shop unlocked by the
    // superadmin would have empty per-feature ownership.
    {
      const catalog = await getAdvanceFeatures();
      await grantFeatures(req.params.shopId, coreFeatureIds(catalog));
    }
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    console.log(`Superadmin FREE advanced unlock: ${req.params.shopId}`);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Support: give any shop ONE add-on feature for free, or take it back.
// unlock-advanced grants the whole core pack; this is for a single feature
// (such as Smart Scanner) — so it can be given without charging ₹49.
app.post('/api/superadmin/shop/:shopId/feature', verifySuperAdmin, async (req, res) => {
  try {
    const featureId = String(req.body.featureId || '').trim().toLowerCase();
    const grant = req.body.grant !== false;      // default = de do
    if (!featureId) return res.status(400).json({ error: 'featureId is required' });

    const catalog = await getAdvanceFeatures();
    if (!catalog.some(f => f.id === featureId))
      return res.status(404).json({ error: 'This feature is not in the catalog' });

    const sh = await pool.query(
      'SELECT id, name, plan_type FROM shops WHERE id=$1', [req.params.shopId]);
    if (!sh.rows.length) return res.status(404).json({ error: 'Shop not found' });

    // Premium is derived from the plan, not from owned_features —
    // changing the list there has no effect at all. Refuse clearly,
    // otherwise the superadmin would think it worked.
    if (sh.rows[0].plan_type === 'premium') {
      return res.status(400).json({
        error: grant
          ? 'A Premium shop already gets this for free — nothing needs to be done'
          : 'A feature cannot be removed from Premium — change the plan first'
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
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    console.log(`Password reset by superadmin: ${req.params.shopId}`);
    res.json({ success: true, tempPassword: temp });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Change a shop owner's mobile number, when the owner asks for it.
// The Shop ID is what signs an owner in, so nothing about their login moves.
// The demo record keeps the OLD number on purpose: it is what stops one
// number from taking a second free demo, and a new number must not reopen that.
app.post('/api/superadmin/shop/:shopId/phone', verifySuperAdmin, async (req, res) => {
  try {
    // "+91 98765 43210" and "098765-43210" are the same number as 9876543210.
    const phone = String((req.body && req.body.phone) || '')
      .replace(/\D/g, '').replace(/^(?:91|0)(?=\d{10}$)/, '');
    if (!/^\d{10}$/.test(phone))
      return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
    const cur = await pool.query('SELECT phone FROM shops WHERE id=$1', [req.params.shopId]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Shop not found' });
    const oldPhone = cur.rows[0].phone || '';
    if (oldPhone === phone) return res.status(400).json({ error: "That is already this shop's number" });
    await pool.query('UPDATE shops SET phone=$1 WHERE id=$2', [phone, req.params.shopId]);
    // Another shop on the same number is not wrong in itself — one owner can
    // run two shops — but the super admin should see it before closing the request.
    const other = await pool.query(
      'SELECT id, name FROM shops WHERE phone=$1 AND id<>$2 ORDER BY created_at LIMIT 5', [phone, req.params.shopId]);
    console.log(`Mobile number changed by superadmin: ${req.params.shopId} | ${oldPhone || '-'} -> ${phone}`);
    res.json({ success: true, oldPhone, phone, sharedWith: other.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Demo accounts list — for monitoring + manual deletion ──
// Cloudinary status — how many files are sitting there right now (the truth, from Cloudinary, not the DB)
// Echel starts from its own database; cross-project copying is unavailable.
// ══════════════ BACKUP DOWNLOAD ══════════════
// The Supabase free plan has no automatic backups. This button returns the whole DB as one
// JSON file — press it once a week and keep it on your phone/PC.
app.get('/api/superadmin/backup', verifySuperAdmin, async (req, res) => {
  try {
    const dump = {
      version: migration.DUMP_VERSION,
      taken_at: new Date().toISOString(),
      from: BASE_URL,
      tables: {}
    };
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

// Row counts — to verify a migration
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

// ══════════════ MIGRATION ══════════════
// Echel is an ordinary Node + PostgreSQL application, so it runs on any host
// that offers both — a Hostinger VPS, another cloud, or a machine of your own.
// Moving it has three steps and Superadmin → Database has a button for each:
//
//   1. this report          what the new host still needs
//   2. Download backup      every row of every table, in one file
//   3. Restore from a file  that file into the new server's empty database
//
// Uploaded documents are not in the file. They stay in Cloudinary and serve
// from the new host the moment the same Cloudinary keys are set there.
// MIGRATION.md walks through the whole thing.
app.get('/api/superadmin/migration/report', verifySuperAdmin, async (req, res) => {
  try {
    const tables = {};
    let totalRows = 0;
    for (const table of APP_TABLES) {
      try {
        const r = await pool.query(`SELECT COUNT(*)::int AS n FROM "${table}"`);
        tables[table] = r.rows[0].n;
        totalRows += r.rows[0].n;
      } catch (e) { tables[table] = -1; }     // -1 = this table is not here
    }
    let host = '', name = '';
    try {
      const u = new URL(process.env.DATABASE_URL || '');
      host = u.hostname; name = u.pathname.replace(/^\//, '');
    } catch (e) { /* no database address configured */ }
    res.json({
      server: {
        baseUrl: BASE_URL,
        node: process.version,
        platform: process.platform,
        uptimeSeconds: Math.round(process.uptime())
      },
      database: { host, name, tables, totalRows },
      storage: { cloudName: process.env.CLOUDINARY_CLOUD_NAME || '' },
      // Names and explanations only — a value is never read or sent.
      settings: migration.envReport(process.env),
      missing: migration.missingRequired(process.env)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Write a backup file into THIS server's database.
// `dryRun` reports what would happen and writes nothing.
app.post('/api/superadmin/migration/import', verifySuperAdmin, async (req, res) => {
  const body = req.body || {};
  const dryRun = body.dryRun === true;
  if (!dryRun && body.confirm !== 'RESTORE')
    return res.status(400).json({ error: 'Type RESTORE to confirm.' });

  let plan;
  const columnsByTable = {};
  try {
    for (const table of APP_TABLES) {
      const r = await pool.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',
        ['public', table]);
      columnsByTable[table] = new Set(r.rows.map(x => x.column_name));
    }
    plan = migration.planRestore(body.dump, columnsByTable);
  } catch (e) { return res.status(400).json({ error: e.message }); }

  let shopsHere = 0;
  try {
    shopsHere = (await pool.query('SELECT COUNT(*)::int AS n FROM shops')).rows[0].n;
  } catch (e) { /* a brand new database has no shops table filled in yet */ }

  if (dryRun) return res.json({ dryRun: true, shopsHere, ...plan });

  // A database that already holds shops is somebody's live service. Replacing
  // it is only ever right when it was asked for in so many words.
  if (shopsHere > 0 && body.mode !== 'replace')
    return res.status(409).json({
      error: `This database already holds ${shopsHere} shops, and a restore would replace them. Send mode "replace" if that is really what you want.`,
      shopsHere
    });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of plan.plan) await client.query(`DELETE FROM "${item.table}"`);
    const written = {};
    for (const item of plan.plan) {
      const rows = req.body.dump.tables[item.table];
      if (!item.columns.length || !rows.length) { written[item.table] = 0; continue; }
      let n = 0;
      for (let i = 0; i < rows.length; i += 200) {
        const { text, values } = migration.insertBatch(item.table, item.columns, rows.slice(i, i + 200));
        n += (await client.query(text, values)).rowCount || 0;
      }
      written[item.table] = n;
    }
    // A table that numbers its own rows has to carry on after the highest id
    // restored, or the very next insert collides with a row we just wrote.
    // Asking about a column a table does not have is an error, not a null, so
    // the tables without an id (system_settings) are stepped over.
    for (const item of plan.plan) {
      if (!columnsByTable[item.table].has('id')) continue;
      const seq = await client.query("SELECT pg_get_serial_sequence($1,'id') AS s", [item.table]);
      if (seq.rows[0] && seq.rows[0].s)
        await client.query('SELECT setval($1, COALESCE((SELECT MAX(id) FROM "' + item.table + '"),0)+1, false)', [seq.rows[0].s]);
    }
    await client.query('COMMIT');
    console.log(`Migration restore: ${Object.values(written).reduce((a, b) => a + b, 0)} rows written`);
    res.json({ success: true, written, skippedTables: plan.skippedTables, takenAt: plan.takenAt, from: plan.from });
  } catch (err) {
    // One failure and nothing is written — the database is left as it was.
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error('Migration restore failed:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
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
      errors,                       // if not empty, show it in the panel
      files: mapped.slice(0, 20)
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Manual sweep — the "clean up now" button
// Body options (all optional):
//   min_kb    : delete files larger than this many KB (e.g. 40)
//   min_age   : delete files older than this many minutes (default 90)
//   any_size  : send true to delete all old files regardless of size
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

      // Rule: if a size rule was given, use it; otherwise the age rule
      const matches = (minKb !== null && !isNaN(minKb))
        ? kb > minKb
        : ageMin >= minAge;
      if (!matches) { skippedRule++; continue; }

      // Never touch a file that is about to be printed
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
      return res.status(400).json({ error: 'Minutes must be between 15 and ' + DEMO_MAX_MINUTES + ' (365 days)' });
    // The print limit is optional — if it is not sent, the old value stays as it is.
    let printLimit = null;
    if (req.body.printLimit !== undefined && req.body.printLimit !== null && req.body.printLimit !== '') {
      printLimit = parseInt(req.body.printLimit);
      if (isNaN(printLimit) || printLimit < 1 || printLimit > DEMO_MAX_PRINTS)
        return res.status(400).json({ error: 'The print limit must be between 1 and ' + DEMO_MAX_PRINTS });
    }
    await pool.query("UPDATE system_settings SET value=$1 WHERE key='demo_enabled'", [enabled]);
    await pool.query("UPDATE system_settings SET value=$1 WHERE key='demo_minutes'", [String(mins)]);
    if (printLimit !== null) {
      await pool.query(
        `INSERT INTO system_settings (key, value) VALUES ('demo_print_limit', $1)
         ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`, [String(printLimit)]);
    }
    // if instant was not sent at all, the old setting stays as it is
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
    if (!r.rows.length) return res.status(404).json({ error: 'Pending withdrawal not found' });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════ FREE DEMO (24 hours, 10 prints) ══════════════════
// Anti-abuse: (1) one phone = one demo PERMANENTLY, (2) one IP = 2/day,
// (3) one MACHINE = one demo permanently (the agent sends its MachineGuid).
// The upper bound of the demo settings — the superadmin can set anything below this.
// 365 days / 100,000 prints is practically "as much as you like".
const DEMO_MAX_MINUTES = 365 * 24 * 60;   // 525600
const DEMO_MAX_PRINTS  = 100000;

async function getDemoConfig() {
  try {
    const r = await pool.query(
      "SELECT key,value FROM system_settings WHERE key IN ('demo_enabled','demo_minutes','demo_print_limit','demo_auto_approve')");
    const m = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
    // The superadmin can set as much as they like — just not less than 15 min
    // and not more than DEMO_MAX_MINUTES (1 year), so that a typo never opens a
    // demo forever.
    const mins = Math.max(15, Math.min(DEMO_MAX_MINUTES, parseInt(m.demo_minutes) || 1440));
    return {
      enabled: (m.demo_enabled || '1') === '1',
      minutes: mins,
      printLimit: Math.max(1, Math.min(DEMO_MAX_PRINTS, parseInt(m.demo_print_limit) || 10)),
      // instant = the demo is created as soon as the form is submitted (default).
      // false = the old flow: it is created only after the superadmin accepts it.
      autoApprove: (m.demo_auto_approve || '1') === '1',
      instant:     (m.demo_auto_approve || '1') === '1'
    };
  } catch (e) { return { enabled: true, minutes: 1440, printLimit: 10, autoApprove: true, instant: true }; }
}

/**
 * Create a demo shop. Both the post-approval path (superadmin) and the legacy
 * auto-approve use this function — the logic is not duplicated in two places.
 * The timer starts HERE, not at registration time.
 */
async function createDemoShop(d) {
  const cfg = await getDemoConfig();
  const shopId = 'DEMO_' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const passwordHash = await hashPassword(d.phone);
  const shopName = (d.shopName || d.name || 'Demo Shop').slice(0, 180);

  await pool.query(
    // advanced_unlocked=true — all advanced features stay open in a demo.
    // Showing half the software and then asking for money backfires.
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

  // Send the alert - but do not wait for it. Even if the email gets stuck or
  // fails, demo creation must not stop. alertNewShop is called the same way
  // and keeps its own try/catch inside.
  alertNewDemo(shopId, d.how);

  return { shopId, qrUrl, qrCode, minutes: cfg.minutes, printLimit: cfg.printLimit };
}

/**
 * Which plans are available for an upgrade — they come from the server,
 * not hardcoded in the frontend. These are shown when the demo limit is hit.
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
 * Has the demo shop exceeded its free print limit?
 * Called before every paid-print path.
 */
async function checkDemoAllowance(shopId) {
  const r = await pool.query('SELECT demo, demo_expires_at FROM shops WHERE id=$1', [shopId]);
  if (!r.rows.length || !r.rows[0].demo) return { ok: true, demo: false };

  const cfg = await getDemoConfig();
  if (isDemoExpired(r.rows[0])) {
    return { ok: false, demo: true, reason: 'expired', used: null, limit: cfg.printLimit,
             error: 'Your demo has ended. Please upgrade to continue printing.' };
  }
  // Demo print limit — cancelled/abandoned/failed jobs do not count towards the limit,
  // otherwise a customer's failed job used to eat the demo user's quota.
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
// REAL MOBILE NUMBER CHECK
// To avoid filling in the form, people entered things like 9999999999 /
// 1234567890 and the demo was wasted. This validator only looks at
// patterns — no paid API, no OTP.
// This is the SERVER's final decision; the homepage runs the same rules again
// only to give instant feedback.
// ══════════════════════════════════════════════════════════════
const FAKE_MOBILE_LIST = new Set([
  '9999999999','8888888888','7777777777','6666666666','1111111111','0000000000',
  '1234567890','9876543210','9123456789','9987654321','1234512345','9999900000',
  '9000000000','8000000000','7000000000','6000000000','9090909090','9080706050',
  '9999988888','9876512345','8765432109','7654321098','9998887776','9876543211',
  '9999999998','9999999990','9111111111','8123456789','7123456789','6123456789'
]);

/** Strip +91 / 0 / spaces to get a clean 10 digits. '' when invalid. */
function normIndianMobile(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('091')) d = d.slice(3);
  else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0'))  d = d.slice(1);
  return d.length === 10 ? d : '';
}

/**
 * A straight sequence such as 1234567890 / 9876543210 / 6789012345?
 * A modulo-10 step is used so the 9->0 wrap is caught too.
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

/** A repeated block such as 1212121212 / 1234512345 / 1111111111? */
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

/** The longest run of a single digit (9000000001 -> 8). */
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
  // TRAI: mobile series start only with 6/7/8/9
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
  // 9988776655 / 1122334455 — every pair is a single digit
  if (/^(\d)\1(\d)\2(\d)\3(\d)\4(\d)\5$/.test(d))
    return bad('That number looks made up. Please enter your real WhatsApp number.');

  return { ok: true, phone: d, error: '' };
}
/**
 * The same check, in the register page's wording.
 * validateIndianMobile makes the decision; only the message changes here.
 */
function registerPhoneCheck(raw) {
  const v = validateIndianMobile(raw);
  if (v.ok) return v;
  const d = normIndianMobile(raw);
  const bad = msg => ({ ok: false, phone: '', error: msg });
  if (!d) return bad('Enter a valid 10-digit mobile number.');
  if (!/^[6-9]/.test(d))
    return bad('Mobile numbers start with 6, 7, 8 or 9 — please check again.');
  if (FAKE_MOBILE_LIST.has(d))
    return bad('That is a test number — please enter your real WhatsApp number.');
  return bad('That number does not look real — please enter your WhatsApp number.');
}

function isDemoExpired(shop) {
  return shop && shop.demo && shop.demo_expires_at &&
         new Date(shop.demo_expires_at).getTime() < Date.now();
}

// ═══════════════════════════════════════════════
// DEMO REQUEST → SUPERADMIN APPROVAL → ACTIVATION
// The public form no longer creates the shop directly. First a 'pending' request
// is created; only when the superadmin accepts it is the demo shop created and the
// 24-hour timer started.
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

    // Bot challenge — enforced only when TURNSTILE_SECRET_KEY is set.
    // If it is not set, skip it, so nothing breaks for now.
    const ts = await verifyTurnstile(b.turnstileToken, clientIp(req));
    if (!ts.ok) {
      await logSecurityEvent({ ip: clientIp(req), endpoint: '/api/demo/request', method: 'POST',
        action: 'DEMO_REQUEST', reason: 'CAPTCHA_FAILED:' + (ts.reason || ''),
        userAgent: req.headers['user-agent'] });
      return res.status(403).json({ error: 'Verification failed. Please refresh the page and try again.' });
    }

    // Layer 1: one phone = one demo (both pending and approved count)
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

    // Layer 2: at most DEMO_DAILY_PER_IP requests / day from one IP (default 2).
    // This counts only demos that were CREATED (DB rows), not attempts — so
    // filling in the form incorrectly does not use up this limit.
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
      if (e.code === '23505') {   // race: another request got there first
        return res.status(400).json({ error: 'A demo request for this number already exists.' });
      }
      throw e;
    }

    // The demo really was created — NOW increase the IP count. This way none of the
    // rejections above (validation, duplicate phone, captcha) consume the quota.
    if (typeof req.countDemoRequest === 'function') req.countDemoRequest();

    // ── INSTANT ACTIVATION (default) ──
    // The shop is created as soon as the form is submitted, and the Shop ID + password
    // appear on the same screen. Manual approval applies only when the
    // superadmin turned this off from Demo Control.
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
// The maintenance switch, and what it currently says.
app.get('/api/superadmin/maintenance', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT value, updated_at FROM system_settings WHERE key='maintenance_mode'");
    res.json({ enabled: r.rows.length ? r.rows[0].value === '1' : false,
               updatedAt: r.rows.length ? r.rows[0].updated_at : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/superadmin/maintenance', verifySuperAdmin, async (req, res) => {
  try {
    const on = !!(req.body && (req.body.enabled === true || req.body.enabled === '1' || req.body.enabled === 1));
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('maintenance_mode', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [on ? '1' : '0']);
    setMaintenanceCache(on);
    console.log('Website maintenance is now ' + (on ? 'ON' : 'OFF'));
    res.json({ success: true, enabled: on });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Turn automatic blocking on or off. Off, the server only suggests.
app.put('/api/superadmin/auto-block', verifySuperAdmin, async (req, res) => {
  try {
    const on = !(req.body && (req.body.enabled === false || req.body.enabled === '0' || req.body.enabled === 0));
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('auto_block_enabled', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [on ? '1' : '0']);
    setAutoBlockCache(on);
    // Turning it back on should not punish anyone for what happened while it
    // was off, so the suggestions are cleared with the switch.
    if (on) blockSuggestions.clear();
    console.log('Automatic blocking is now ' + (on ? 'ON' : 'OFF'));
    res.json({ success: true, enabled: on });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/security-events', verifySuperAdmin, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 50));
    const r = await pool.query(
      `SELECT id, created_at, ip, shop_id, endpoint, method, action, reason, upload_count, file_size
         FROM security_events ORDER BY created_at DESC LIMIT $1`, [limit]);

    // An ISO string rather than a Date object: every PostgreSQL driver reads it.
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const stats = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(DISTINCT ip)::int AS ips,
              COUNT(*) FILTER (WHERE reason LIKE 'IP_RATE_LIMIT%')::int  AS rate_limited,
              COUNT(*) FILTER (WHERE reason LIKE 'UPLOAD_BURST%')::int   AS bursts,
              COUNT(*) FILTER (WHERE reason LIKE 'CAPTCHA_FAILED%')::int AS captcha_fails
         FROM security_events WHERE created_at > $1`, [since]);

    // Who is blocked right now (in-memory)
    const now = Date.now();
    const active = [];
    for (const [k, until] of abuseBlocks) {
      if (until > now) active.push({ key: k, minutesLeft: Math.ceil((until - now) / 60000) });
    }
    const autoOn = await autoBlockEnabled();
    const suggestions = [];
    for (const [key, v] of blockSuggestions) {
      if (now - v.lastAt < SUGGESTION_TTL_MS)
        suggestions.push({ key, reason: v.reason, times: v.times, minutesAgo: Math.round((now - v.lastAt) / 60000) });
    }
    suggestions.sort((a, b) => b.times - a.times);
    res.json({
      events: r.rows,
      last24h: stats.rows[0],
      autoBlock: autoOn,
      suggestions,
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

// ── Permanent IP blocklist: view / add / remove ──
// Together with recent registrations, so the superadmin can see which
// IP keeps creating shops without paying.
app.get('/api/superadmin/ip-bans', verifySuperAdmin, async (req, res) => {
  try {
    const bans = await pool.query(
      'SELECT ip, reason, created_at FROM blocked_ips ORDER BY created_at DESC');
    const regs = await pool.query(
      `SELECT id, name, created_ip, setup_paid, created_at
         FROM shops
        WHERE created_at > NOW() - INTERVAL '30 days'
        ORDER BY created_at DESC LIMIT 60`);
    // How many unpaid shops per IP — the highest at the top
    const worst = await pool.query(
      `SELECT created_ip AS ip,
              COUNT(*)::int AS total,
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
    if (!ip) return res.status(400).json({ error: 'Enter an IP' });
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
    if (!ip) return res.status(400).json({ error: 'Enter an IP' });
    const r = await pool.query('DELETE FROM blocked_ips WHERE ip=$1', [ip]);
    clearIpBanCache();
    console.log(`SECURITY: IP ban removed by superadmin | ${ip}`);
    res.json({ success: true, removed: r.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Permanent customer block: view / add / remove ──
//
// Also the customers who look suspicious — those who send the most jobs
// and those whose jobs are DENIED the most. The deny count matters
// because a shop owner repeatedly rejecting someone's job is the
// clearest sign that the person is causing trouble.
app.get('/api/superadmin/customer-bans', verifySuperAdmin, async (req, res) => {
  try {
    const bans = await pool.query(
      `SELECT c.cid, c.shop_id, c.reason, c.created_at,
              s.name AS shop_name
         FROM blocked_customers c
         LEFT JOIN shops s ON s.id = c.shop_id
        ORDER BY c.created_at DESC`);

    // The suspicious ones. A 30-day window — anything older is irrelevant.
    const worst = await pool.query(
      `SELECT j.customer_id                                        AS cid,
              COUNT(*)::int                                        AS total,
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
        ORDER BY denied DESC, total DESC
        LIMIT 25`);

    res.json({ bans: bans.rows, worst: worst.rows,
               jobsMax: SEC.custJobsMax, windowMin: SEC.custWindowMin,
               sheetMax: MAX_JOB_SHEETS });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/customer-ban', verifySuperAdmin, async (req, res) => {
  try {
    const cid = String(req.body.cid || '').trim().slice(0, 48);
    if (!cid) return res.status(400).json({ error: 'Enter a Customer ID' });
    const shopId = String(req.body.shopId || '').trim().slice(0, 50);
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    await pool.query(
      `INSERT INTO blocked_customers (cid, shop_id, reason) VALUES ($1,$2,$3)
       ON CONFLICT (cid) DO UPDATE SET reason = EXCLUDED.reason,
                                       shop_id = EXCLUDED.shop_id`,
      [cid, shopId, reason]);
    clearCustBanCache();

    // A block only stops FUTURE uploads. Jobs already in the queue
    // would keep coming out of the printer — and the superadmin would think
    // the block does not work. So remove them here as well.
    //
    // Paid jobs are NOT TOUCHED: their money has already arrived, and that is
    // the shop owner's decision (they can deny it from their panel).
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
      // Even if the jobs could not be cancelled, the ban is already in place
      console.warn('Could not cancel the jobs of the blocked customer:', e.message);
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
    if (!cid) return res.status(400).json({ error: 'Enter a Customer ID' });
    const r = await pool.query('DELETE FROM blocked_customers WHERE cid=$1', [cid]);
    // Also remove the automatic 15-minute block — otherwise the
    // superadmin thinks the customer was released while they are still blocked.
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

// A genuine customer blocked by mistake — the superadmin releases them immediately
// Pause one of the suggestions by hand, while automatic blocking is off.
// This is a deliberate decision by a person, so it goes straight into the same
// temporary pause the automatic system uses — and clears itself the same way.
app.post('/api/superadmin/security-block', verifySuperAdmin, async (req, res) => {
  try {
    let key = String((req.body && (req.body.key || req.body.shopId)) || '').trim().slice(0, 120);
    if (!key) return res.status(400).json({ error: 'Nothing was chosen to pause' });
    if (!key.includes(':')) key = 'shop:' + key;
    const minutes = Math.min(1440, Math.max(1, parseInt(req.body && req.body.minutes, 10) || SEC.blockMin));
    const until = Date.now() + minutes * 60 * 1000;
    abuseBlocks.set(key, Math.max(abuseBlocks.get(key) || 0, until));
    blockSuggestions.delete(key);
    console.log(`SECURITY: ${key} paused for ${minutes} min by the super admin`);
    res.json({ success: true, key, minutes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/security-unblock', verifySuperAdmin, async (req, res) => {
  try {
    // A Shop ID can also arrive as-is — "shop:" is added automatically,
    // so the superadmin does not have to remember the key format.
    let key = String(req.body.key || req.body.shopId || '').trim();
    if (key && !key.includes(':')) key = 'shop:' + key;

    if (!key) {                       // all clear
      const n = abuseBlocks.size;
      abuseBlocks.clear();
      // Clear the count too — otherwise right after the block is lifted the next upload
      // would block again (see the note below).
      uploadHits.clear();
      demoIpHits.clear();
      console.log(`SECURITY: all ${n} blocks + counters cleared by superadmin`);
      return res.json({ success: true, cleared: n });
    }
    const had = abuseBlocks.delete(key);

    // ── THE REAL FIX ──
    // A block lives in TWO places: in abuseBlocks as "blocked right now",
    // and in uploadHits as the count (total, strikes). Only the first used to be
    // removed — on the next upload the count was still above the limit and the shop
    // was IMMEDIATELY blocked again. The superadmin thought the button
    // did not work at all.
    //
    // (The same illness happened before — "3 prints, 16 blocks" — which was fixed
    //  with the rolling window, but the manual unblock path had been
    //  missed.)
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

// The homepage needs the Turnstile site key (a public key — not a secret)
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

    // WhatsApp message — the superadmin sends it in one click
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
// The row is deleted completely so the phone number becomes free again.
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
    if (!cfg.enabled) return res.status(403).json({ error: 'Demos are currently disabled — try again a little later or register directly' });
    // Demos are now created through superadmin approval. This old instant-create
    // endpoint only runs when demo_auto_approve='1' (for
    // rollback). Otherwise everything goes to /api/demo/request.
    if (!cfg.autoApprove) {
      return res.status(410).json({
        error: 'Demo now requires approval. Please submit the demo request form.',
        useEndpoint: '/api/demo/request'
      });
    }

    const name = String(req.body.name || '').trim().slice(0, 100);
    const phone = normPhone(req.body.phone);
    if (!name) return res.status(400).json({ error: 'Enter a name' });
    if (!phone) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });

    // Layer 1: permanent phone lock — check both demo_registrations AND shops.
    // (demo_registrations was left empty during the migration, so this is a double
    // safety — no duplicate demo shops will be created.)
    const dup = await pool.query('SELECT id FROM demo_registrations WHERE phone=$1', [phone]);
    const dupShop = await pool.query('SELECT id FROM shops WHERE phone=$1 AND demo=true', [phone]);
    if (dup.rows.length || dupShop.rows.length)
      return res.status(400).json({ error: 'A demo has already been used with this number. Did you like it? Register now 🙂' });

    // Layer 2: IP — at most 2 demos/day
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 60);
    const ipCount = await pool.query(
      "SELECT COUNT(*) FROM demo_registrations WHERE ip=$1 AND created_at > NOW() - INTERVAL '24 hours'", [ip]);
    if (parseInt(ipCount.rows[0].count) >= 2)
      return res.status(429).json({ error: 'The demo limit for today has been reached — try tomorrow or register now' });

    const shopId = 'DEMO_' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const passwordHash = await hashPassword(phone);
    await pool.query(
      // advanced_unlocked=true — all advanced features stay open in a demo.
      // The whole point of a demo is that the person sees the complete software;
      // showing half of it and then asking for money backfires.
      // For paid shops the paywall stays exactly as it is.
      `INSERT INTO shops (id, name, phone, price_bw, price_color, payment_mode, password_hash,
                          setup_paid, setup_amount, demo, demo_expires_at, advanced_unlocked)
       VALUES ($1,$2,$3,5,10,'counter_only',$4,true,0,true,NOW() + ($5 || ' minutes')::INTERVAL,true)`,
      [shopId, name + ' (Demo)', phone, passwordHash, String(cfg.minutes)]);
    // The unique index (uniq_demo_reg_phone) also stops races in the DB —
    // if two requests arrive together, the second one fails safely here.
    try {
      await pool.query('INSERT INTO demo_registrations (phone, ip, shop_id) VALUES ($1,$2,$3)', [phone, ip, shopId]);
    } catch (e) {
      if (e.code === '23505') { // unique_violation — the phone is already locked
        await pool.query('DELETE FROM shops WHERE id=$1', [shopId]); // roll back the shop that was just created
        return res.status(400).json({ error: 'A demo has already been used with this number. Register now 🙂' });
      }
      throw e;
    }

    const qrUrl = `${BASE_URL}/print/${shopId}`;
    const qrCode = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 });
    await pool.query('UPDATE shops SET qr_code=$1 WHERE id=$2', [qrCode, shopId]);

    // This old endpoint does not use createDemoShop() - it has its own
    // INSERT, so the alert has to be called separately here.
    alertNewDemo(shopId, 'legacy');

    console.log(`Demo created: ${shopId} | ${phone} | ip ${ip}`);
    res.json({ success: true, shopId, password: phone, qrUrl, qrCode,
               expiresInMinutes: cfg.minutes,
               note: 'Login password = your mobile number' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/printer-models', (req, res) => {
  res.json({ models: PRINTER_MODELS });
});

// ══════════════════════════════════════════════════════════════
//  ADVANCE FEATURE LIST  (the list shown on a shop's Advance tab)
//
//  This list used to be hardcoded in admin.html — every new advance feature
//  meant editing the HTML and deploying again, which is exactly why adding Mini
//  Print was missed. Now the list lives in the DB and changes
//  from Superadmin.
//
//  Shape: [{ icon, title, desc, isNew }]
//  desc may contain light HTML (<b>) — only the superadmin writes it.
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
//  FEATURE ENTITLEMENT — which shop has which advance feature
//
//  The `advanced_unlocked` boolean still exists (old code uses it),
//  but the real truth is in `owned_features` — a list of feature ids.
//
//  The Premium list is NOT CHECKED AT ALL: they get everything in the catalog,
//  today's and tomorrow's. That automatically keeps the promise of "all future
//  features free" — as soon as a new feature is added, every Premium shop
//  gets it, with no script to run.
// ══════════════════════════════════════════════════════════════

/** Every feature's `id` must be stable — ownership is tied to it. */
function normalizeFeature(f, i) {
  const id = String(f.id || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '')
             || ('feat' + i);
  return {
    id,
    icon:  String(f.icon  || '✨').slice(0, 8),
    title: String(f.title || '').slice(0, 90).trim(),
    desc:  String(f.desc  || '').slice(0, 600).trim(),
    // core = part of the base Advance pack (the ₹199 one / included with Pro-Premium).
    // core=false = a new feature added later, with its own price.
    core:  f.core !== false,
    price: Math.max(0, parseInt(f.price) || 0),
    isNew: !!f.isNew
  };
}

/** Base pack features — all of these come with ₹199 / with Pro-Premium. */
function coreFeatureIds(catalog) {
  return catalog.filter(f => f.core).map(f => f.id);
}

/** The price of a new (add-on) feature. 0 or unset = the global default. */
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
 * Which features the shop actually has.
 * For Premium, the whole catalog — even if owned_features is empty.
 */
function ownedFeatureIds(shop, catalog) {
  if (!shop) return [];
  if (shop.plan_type === 'premium') return catalog.map(f => f.id);
  // A demo gets the whole catalog — including ADD-ONs like the Smart Scanner.
  //
  // The other 5 modules ran on advanced_unlocked, so they showed in demos,
  // but the truth for add-ons lives in owned_features, which is empty for a demo
  // — so the scanner never showed in demos. The intent of the demo-creation
  // code already was this ("the whole point of a demo is that the person sees
  // the complete software"); the Scanner became an add-on later and this spot
  // was missed.
  //
  // Fixing it here means any future add-on shows in demos automatically —
  // no need to remember it every time.
  if (shop.demo) return catalog.map(f => f.id);
  const own = Array.isArray(shop.owned_features) ? shop.owned_features : [];
  // Old shops that paid ₹199 have an empty owned_features
  // but advanced_unlocked=true — they are treated as having the core pack.
  if (!own.length && shop.advanced_unlocked) return coreFeatureIds(catalog);
  return own;
}

function shopOwnsFeature(shop, featureId, catalog) {
  return ownedFeatureIds(shop, catalog).indexOf(featureId) !== -1;
}

/**
 * Grant the shop a feature. Nothing needs to be done for Premium —
 * theirs is derived from the plan.
 */
// ═══════════════════════════════════════════════════════════════
//  PAGE-RANGE SLAB PRICING
// ═══════════════════════════════════════════════════════════════
// A shop owner can set "from this many pages to this many = this many rupees".
// That price is the rate for EACH PAGE, NOT for the whole job:
//     4 sheets and the 2-5 range rate is 2    =>  4 x 2   = 8
//     8 sheets and the 6-10 range rate is 1.5 =>  8 x 1.5 = 12
// So the more sheets, the cheaper the per-page rate.
//
// COPIES count too: 3 copies of 3 pages = 9 sheets.
//
// If the job falls into no range (e.g. just 1 page), the old per-page calculation
// applies, so shops that have not set any slabs are not
// affected.
//
// Shape: { bw: [{from,to,price}, ...], color: [...] }  (up to 5 each)
function parseSlabs(raw) {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
    const clean = (arr) => (Array.isArray(arr) ? arr : [])
      .map(s => ({
        from:  parseInt(s.from, 10),
        to:    parseInt(s.to, 10),
        price: parseFloat(s.price)
      }))
      // Silently drop incomplete or reversed ranges — a half-filled row
      // would apply a wrong price; better to let the old rate apply
      .filter(s => s.from > 0 && s.to >= s.from && s.price >= 0 && isFinite(s.price))
      .slice(0, 5);
    return { bw: clean(o.bw), color: clean(o.color) };
  } catch (e) { return { bw: [], color: [] }; }
}

// Which rate for how many pages. If two ranges overlap, the SMALLEST
// (most specific) range wins - a range the owner deliberately kept
// narrow must take precedence over a wider one.
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
  // If no feature is left, switch the legacy flag off too — otherwise old code
  // would keep thinking that advance is unlocked.
  await pool.query(
    `UPDATE shops SET advanced_unlocked = false
      WHERE id = $1 AND COALESCE(array_length(owned_features,1),0) = 0
        AND plan_type <> 'premium'`, [shopId]);
}

const DEFAULT_ADVANCE_FEATURES = [
  { id: 'photo4x6', core: true, icon: '📷', title: '4×6 Passport Photos',
    desc: 'The customer sends a photo — a sheet of 4, 6, 8 or 10 builds itself and comes out of the photo printer with cutting lines. Layout and printer routing are fully automatic.' },
  { id: 'resume', core: true, icon: '📝', title: 'Resume Maker',
    desc: 'The customer builds a resume in one of 6 designs straight from the QR and fills the form themselves. You only hand over the print — new business, nothing new to learn.' },
  { id: 'bigsize', core: true, icon: '📐', title: 'A3 / A2 / A1 — Large Sizes',
    desc: 'Maps, project charts, banners. Each large size gets its own printer and its own rate — if you have an A3 printer, this work stays with you.' },
  { id: 'mini', core: true, icon: '🗒️', title: 'Mini Print — up to 16 pages on one sheet',
    desc: 'Notes, question papers, syllabus — the customer can print 2/4/6/8/9/12/16 pages on a single A4. The busiest option during student season.' },
  // The Smart Scanner is NOT part of the base pack (core: false) — it is an
  // add-on that came later. This means:
  //   • Premium (₹999)       → ownedFeatureIds() returns the whole catalog, free
  //   • Pro/Starter/old shops → ₹49 (system_settings.addon_feature_fee)
  //   • The superadmin can give it to anyone for free at any time
  // price: 0 is set so the global addon_feature_fee applies — the rate changes in
  // one place (₹49), not separately in every feature.
  { id: 'scan', core: false, price: 0, icon: '📸', title: 'Smart Scanner — Scan from a Photo',
    desc: 'The customer photographs a document and gets a clean, straight page like CamScanner — the background is removed automatically. Both the front and back can be scanned. Scanning without a scanner machine.' },
  { id: 'duplex', core: true, icon: '📄', title: 'Duplex — Both-Side Printing',
    desc: 'Charge a separate rate for double-sided printing. No auto-duplex printer? Manual mode — the system itself says "flip the page".' }
];

async function getAdvanceFeatures() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='advance_features'");
    if (!r.rows.length) return DEFAULT_ADVANCE_FEATURES.map((f, i) => normalizeFeature(f, i));
    const parsed = JSON.parse(r.rows[0].value);
    // If an empty array was saved, the default is better — otherwise
    // the shop would see a completely empty box.
    if (!Array.isArray(parsed) || !parsed.length)
      return DEFAULT_ADVANCE_FEATURES.map((f, i) => normalizeFeature(f, i));

    // ⚠️ Old saves did not have `id`, `core` and `price` at all — the PUT handler
    // dropped them (that has been fixed too, see below).
    // Filling in only the `id` was not enough: with `core` undefined,
    // normalizeFeature's `f.core !== false` made it TRUE,
    // so every feature became part of the base pack and no feature could
    // ever become an add-on (the ₹49 kind).
    //
    // Old entries are matched against the default catalog — first by id,
    // then by TITLE (reliable), and finally by index. Index alone is
    // dangerous: if the list order changed or a new feature was inserted in the
    // middle, ownership would move to the wrong feature.
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

// A shop's Advance tab reads this — public, no auth
// ══════════════════════════════════════════════════════════════
//  ADD-ON FEATURE UNLOCK (₹49) — one feature, one payment
//
//  For Starter/Pro shops. Premium never gets here — they receive every
//  new feature automatically, so they are stopped before an order
//  is even created.
// ══════════════════════════════════════════════════════════════
app.post('/api/admin/feature/create-order', verifyToken, async (req, res) => {
  try {
    if (!OWNER_RAZORPAY_KEY_ID || !OWNER_RAZORPAY_KEY_SECRET)
      return res.status(500).json({ error: 'The owner Razorpay account is not configured' });

    const featureId = String(req.body.featureId || '').trim();
    const catalog = await getAdvanceFeatures();
    const feature = catalog.find(f => f.id === featureId);
    if (!feature) return res.status(404).json({ error: 'This feature does not exist' });

    const sh = await pool.query(
      'SELECT plan_type, advanced_unlocked, owned_features FROM shops WHERE id=$1', [req.shopId]);
    if (!sh.rows.length) return res.status(404).json({ error: 'Shop not found' });
    const shop = sh.rows[0];

    if (shop.plan_type === 'premium')
      return res.status(400).json({ error: 'This is already included in Premium' });
    if (shopOwnsFeature(shop, featureId, catalog))
      return res.status(400).json({ error: 'You already have this feature' });
    // the core pack is sold as a whole (the ₹199 one), not one feature at a time
    if (feature.core)
      return res.status(400).json({ error: 'This is part of the Advance pack — unlock the whole pack' });

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
    if (!order || !order.id) return res.status(500).json({ error: 'Could not create the order' });

    // store the order id on the shop — verification matches against it
    await pool.query('UPDATE shops SET feature_order_id=$1, feature_order_fid=$2 WHERE id=$3',
      [order.id, featureId, req.shopId]);
    res.json({ orderId: order.id, amount: fee * 100, keyId: OWNER_RAZORPAY_KEY_ID,
               fee, featureTitle: feature.title });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// The Advance pack, unlocked by its order — for the webhook and the reconcile.
// Only the first caller wins (AND advanced_order_id=$2), so a payment is
// recorded once however many of them arrive, and the pack is granted exactly
// as the browser's verify grants it.
async function unlockAdvancedByOrder(shopId, orderId, paymentId, via) {
  const r = await pool.query(
    "UPDATE shops SET advanced_unlocked=true, advanced_order_id='' WHERE id=$1 AND advanced_order_id=$2 RETURNING id",
    [shopId, orderId]);
  if (!r.rows.length) return false;
  await grantFeatures(shopId, coreFeatureIds(await getAdvanceFeatures()));
  console.log('Advanced unlocked (' + via + '):', shopId);
  await recordPayment({
    kind: 'advanced', shopId,
    amount: await getAdvancedFee(),
    paymentId: paymentId || ('RECONCILE_' + orderId), orderId,
    note: via === 'webhook' ? 'Advanced printing unlock (webhook)' : 'Advanced printing unlock (reconcile)'
  });
  return true;
}

// Unlock the add-on by order id. It is called from TWO paths:
//   1. /api/admin/feature/verify — from the customer's browser, right after payment
//   2. The Razorpay webhook — if the browser was closed, the network dropped, or the
//      token expired
// RACE-SAFE: because of `AND feature_order_id = $2` only the FIRST one wins.
// When the second arrives, the row no longer matches and it is a silent no-op.
async function unlockFeatureByOrder(shopId, orderId, paymentId) {
  const claim = await pool.query(
    `UPDATE shops SET feature_order_id = ''
      WHERE id = $1 AND feature_order_id = $2
      RETURNING feature_order_fid`, [shopId, orderId]);
  if (!claim.rows.length) return null;          // already done

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
  } catch (e) { /* even if the record cannot be written, the unlock must not stop */ }

  log(`Feature unlocked: ${featureId} | shop ${shopId} | ₹${fee}`);
  return featureId;
}

app.post('/api/admin/feature/verify', verifyToken, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ error: 'The payment details are incomplete' });

    const expected = crypto.createHmac('sha256', OWNER_RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
    if (expected !== razorpay_signature)
      return res.status(400).json({ error: 'Payment could not be verified' });

    // Grant only the feature that was requested when the order was created — the
    // featureId sent by the client is not trusted.
    const featureId = await unlockFeatureByOrder(
      req.shopId, razorpay_order_id, razorpay_payment_id);

    if (!featureId) {
      // The webhook may already have done it — in that case the shop already has
      // the feature, and this is a SUCCESS, not an error.
      const sh = await pool.query(
        'SELECT plan_type, advanced_unlocked, owned_features FROM shops WHERE id=$1',
        [req.shopId]);
      const cat = await getAdvanceFeatures();
      const already = (cat || []).find(f =>
        sh.rows.length && shopOwnsFeature(sh.rows[0], f.id, cat) && !f.core);
      if (already) return res.json({ success: true, featureId: already.id });
      return res.status(400).json({ error: 'The order does not match' });
    }
    res.json({ success: true, featureId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// The shop needs the status of its features — which it has and which it can buy
app.get('/api/admin/features', verifyToken, async (req, res) => {
  try {
    const catalog = await getAdvanceFeatures();
    const sh = await pool.query(
      'SELECT plan_type, advanced_unlocked, owned_features FROM shops WHERE id=$1', [req.shopId]);
    if (!sh.rows.length) return res.status(404).json({ error: 'Shop not found' });
    const shop = sh.rows[0];
    const owned = ownedFeatureIds(shop, catalog);
    const addonFee = await getAddonFeeDefault();

    res.json({
      plan: shop.plan_type || 'starter',
      // Premium shops never need to buy anything
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
    if (!list) return res.status(400).json({ error: 'features must be a list' });
    if (list.length > 30) return res.status(400).json({ error: 'At most 30 features' });

    // ⚠️ This map used to save only icon/title/desc/isNew — `id`,
    // `core` and `price` were silently dropped. Result: as soon as the superadmin
    // pressed Save every ID was wiped (ownership fell back to the index)
    // and every feature became core:true — so the ₹49 add-on system
    // never worked at all. The panel showed a checkbox and a price box,
    // but Save threw them away.
    // normalizeFeature() builds the same shape that reading expects.
    const clean = list.map((f, i) => normalizeFeature(f, i)).filter(f => f.title);

    if (!clean.length) return res.status(400).json({ error: 'At least one feature needs a title' });

    // Ownership depends on the ID (this id goes into owned_features).
    // If two features shared an id, paying for one would unlock the other,
    // so the server blocks it too — the client check is not enough.
    const _ids = clean.map(f => f.id);
    const _dup = _ids.find((x, i) => _ids.indexOf(x) !== i);
    if (_dup) return res.status(400).json({ error: 'Two features have the same ID: ' + _dup });

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

// Setup-payment page: this shop's plan + amount (unpaid only — no info leak for paid shops)
app.get('/api/setup-status/:shopId', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, setup_paid, setup_amount, plan_type, billing_cycle FROM shops WHERE id=$1', [req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
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
Open the agent panel or the shop dashboard's Printer Setup tab.
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
// Agent = a paid shop owner who earns commission by onboarding other shops.
// Earnings = ₹200 fixed per shop + markup (the agent's price − the superadmin's base price)
// + a ₹300 bonus for every 10 shops. Payout is manual (UPI), via the withdrawals table.
// ══════════════════════════════════════════════════════════════
// ── AGENT PROGRAM (new, simple) ──
// A FLAT ₹100 per paid shop. That is all.
// Old system: ₹200 + the agent's own markup + a ₹300 bonus for every 10 shops.
// That was removed — agents can NO longer set their own price; everyone gets the
// same rate. The BONUS constants are 0 so that even if an old reference
// is left somewhere, no money gets added.
const AGENT_COMMISSION   = 100;   // per successful paid shop (flat)
const AGENT_PRICE_MAX    = 0;     // 0 = agents cannot set their own price
const AGENT_BONUS_EVERY  = 0;     // bonus band
const AGENT_BONUS_AMOUNT = 0;     // bonus band

// ══════════════════════════════════════════════════════════════
// WHITE LABEL — helpers
// A reseller sells shops under their own brand + their own Razorpay. The setup fee
// of their shops goes STRAIGHT to their Razorpay; we only receive a one-time
// license fee.
// ══════════════════════════════════════════════════════════════
async function getWlLicenseFee() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='wl_license_fee'");
    return Math.max(1, parseInt(r.rows[0]?.value) || 25000);
  } catch(e) { return 25000; }
}

// A reseller cannot set a shop price below this. 0/unset = the public Offer Price.
async function getWlLicenseActual() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='wl_license_actual'");
    return Math.max(0, parseInt(r.rows[0]?.value) || 0);
  } catch(e) { return 0; }
}

/**
 * The Premium floor for agents. The Pro floor is getAgentBasePrice().
 * If it is not set, Premium's own public price — so an agent does not
 * sell Premium at the Pro rate.
 */
async function getAgentPremiumBasePrice() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='agent_base_price_premium'");
    const v = parseInt(r.rows[0]?.value) || 0;
    if (v > 0) return v;
  } catch (e) {}
  return (await getPlanPricing()).premium.fee;
}

/** Which plan the channel floor applies to — that plan's public price. */
async function channelFloorPlan(channel) {
  const plans = await getPlanPricing();
  // the agent's cheapest plan is Pro, the white-label's is Starter
  return channel === 'wl' ? plans.starter.fee : plans.pro.fee;
}

async function getWlBasePrice() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='wl_base_price'");
    const v = parseInt(r.rows[0]?.value) || 0;
    if (v > 0) return v;
  } catch(e) {}
  // White-label sells only Starter — its floor is the Starter price.
  return (await getPlanPricing()).starter.fee;
}

// slug: only lowercase letters, numbers and dashes
function cleanSlug(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '').slice(0, 40);
}

// Find the reseller — from ?wl=slug, or from the subdomain (abc.echel.in)
async function resolveWhitelabel(req) {
  try {
    let slug = cleanSlug(req.query.wl || req.body?.wl || '');
    if (!slug) {
      const host = String(req.headers.host || '').toLowerCase().split(':')[0];
      const parts = host.split('.');
      // abc.echel.in -> abc  (skip www and the main domain)
      if (parts.length > 2 && parts[0] !== 'www') slug = cleanSlug(parts[0]);
    }
    if (!slug) return null;
    const r = await pool.query(
      'SELECT * FROM whitelabels WHERE slug=$1 AND paid=true AND blocked=false', [slug]);
    return r.rows[0] || null;
  } catch(e) { return null; }
}

/**
 * Which gateway the partner's money comes through — 'razorpay', 'cashfree', or
 * '' (meaning nothing is set).
 *
 * Every place used to check only razorpay_key_id/secret. The Cashfree
 * columns and the option in the partner's panel both existed, but the code
 * that collects money never read them.
 *
 * The selection rule: whatever the partner chose in the panel comes first. If that
 * gateway's key is not filled in, the other one is used — half-filled settings
 * must not stop sales.
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

// Verify the reseller's JWT
function verifyWhitelabel(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Login required' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    if (!d.wlId) return res.status(403).json({ error: 'This is not a white-label token' });
    req.wlId = d.wlId;
    next();
  } catch(e) { return res.status(401).json({ error: 'Your session has expired, please log in again' }); }
}

async function genAgentCode() {
  for (let i = 0; i < 40; i++) {
    const code = 'QRA-' + Math.floor(1000 + Math.random() * 9000);
    const c = await pool.query('SELECT 1 FROM shops WHERE agent_code=$1', [code]);
    if (!c.rows.length) return code;
  }
  return 'QRA-' + Date.now().toString().slice(-6);
}

// ref = an agent code (QRA-1234) or an old shop id (SHOP_XXXX) — both work
async function resolveRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const v = ref.trim().toUpperCase();
  if (!v) return null;
  const r = await pool.query(
    `SELECT id, name, is_agent, agent_blocked, agent_price, setup_paid, demo
     FROM shops WHERE (agent_code=$1 OR UPPER(id)=$1) LIMIT 1`, [v]);
  if (!r.rows.length) return null;
  const s = r.rows[0];
  if (!s.setup_paid || s.demo) return null;          // unpaid/demo shops cannot refer
  if (s.is_agent && s.agent_blocked) return null;    // a blocked agent's link is dead
  return s;
}

// The one-time setup price for a given ref (if the agent raised it, that one)
async function priceForRef(ref) {
  // NOTE: nothing calls this function right now. It used to contain the same
  // `agent_price > base` markup — the very bug that produced Rs 1799 on the ref
  // link. So that the bug does not return if someone uses it tomorrow, it was
  // removed here as well.
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
  'demo_login'    // a demo shop logged in to the dashboard
];

// Work out where the visitor came from using the referrer. Only the hostname is kept —
// not the full URL, so nobody's private page path is stored.
function refHostname(raw) {
  try {
    const v = String(raw || '').trim();
    if (!v) return '';
    const u = new URL(v.includes('://') ? v : 'https://' + v);
    return u.hostname.replace(/^www\./, '').slice(0, 160);
  } catch (e) { return ''; }
}

// Public, lightweight beacon — no auth (it is only an anonymous pageview/click).
// It never blocks or errors the page; the client fires and forgets it.
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
  } catch (err) { res.status(200).json({ success: false }); } // never show the client an error
});

// Superadmin: aggregated funnel data — daily breakdown + totals + source split

// ═══════════════════════════════════════════════════════════════════
//  ACTION CENTER — "what to look at today"
//  Instead of going through 19 tabs, one place: what is stuck, what is being
//  missed, which shops to message today. Everything is built from data that
//  already exists — no new tracking.
// ═══════════════════════════════════════════════════════════════════
app.get('/api/superadmin/action-center', verifySuperAdmin, async (req, res) => {
  try {
    const LIMIT = 25;

    // 1. Registered but did not pay — money lost outright.
    //    Anything older than 45 days is skipped; those are dead leads.
    const unpaid = await pool.query(`
      SELECT id, name, phone, email, created_at,
             EXTRACT(DAY FROM NOW() - created_at)::int AS days_ago
      FROM shops
      WHERE demo = false AND setup_paid = false
        AND created_at > NOW() - INTERVAL '45 days'
      ORDER BY created_at DESC LIMIT ${LIMIT}`);

    // 2. Demos about to expire — talk to them now and they may convert to paid
    const demoExpiring = await pool.query(`
      SELECT id, name, phone, email, demo_expires_at,
             GREATEST(0, CEIL(EXTRACT(EPOCH FROM (demo_expires_at - NOW()))/86400))::int AS days_left
      FROM shops
      WHERE demo = true AND demo_expires_at IS NOT NULL
        AND demo_expires_at > NOW() AND demo_expires_at < NOW() + INTERVAL '3 days'
      ORDER BY demo_expires_at ASC LIMIT ${LIMIT}`);

    // 2b. Demo ALREADY EXPIRED — these are the hottest leads: they used the
    //     product and now it has stopped. Worth following up for 30 days.
    const demoExpired = await pool.query(`
      SELECT id, name, phone, email, demo_expires_at,
             GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - demo_expires_at))/86400))::int AS days_ago
      FROM shops
      WHERE demo = true AND demo_expires_at IS NOT NULL
        AND demo_expires_at <= NOW()
        AND demo_expires_at > NOW() - INTERVAL '30 days'
      ORDER BY demo_expires_at DESC LIMIT ${LIMIT}`);

    // 3. Print agent offline — it used to run, but not for the last 24 hours.
    //    Shops that never installed it do not appear here; that is a separate
    //    problem (onboarding). Only broken setups show here.
    const agentOffline = await pool.query(`
      SELECT id, name, phone, agent_last_seen, agent_version, agent_version_label,
             agent_machine, (agent_token IS NOT NULL) AS agent_bound,
             FLOOR(EXTRACT(EPOCH FROM (NOW() - agent_last_seen))/3600)::int AS hours_ago
      FROM shops
      WHERE demo = false AND setup_paid = true AND paused = false
        AND agent_last_seen IS NOT NULL
        AND agent_last_seen < NOW() - INTERVAL '24 hours'
      ORDER BY agent_last_seen ASC LIMIT ${LIMIT}`);

    // 4. Silent shops — not a single print in 7 days. These are about to leave.
    //    New shops (less than 7 days old) are skipped; they are
    //    still being set up.
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

    // 5. Renewal — expiring within 5 days, or already expired.
    //    Without a reminder these quietly slip away.
    const renewals = await pool.query(`
      SELECT id, name, phone, email, paid_until, plan_type, billing_cycle,
             CEIL(EXTRACT(EPOCH FROM (paid_until - NOW()))/86400)::int AS days_left
      FROM shops
      WHERE demo = false AND paid_until IS NOT NULL
        AND paid_until < NOW() + INTERVAL '5 days'
        AND paid_until > NOW() - INTERVAL '30 days'
      ORDER BY paid_until ASC LIMIT ${LIMIT}`);

    // 6. Small counters — these do not need a full list
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
    // ── Range: short ranges (1h/12h/1d) are bucketed by hour,
    // the rest (7d/14d/30d/90d) by day — as before.
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
      // Keep the old ?days= param working too (backward compatible)
      const legacyDays = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
      rangeKey = [7,14,30,90].includes(legacyDays) ? legacyDays + 'd' : '30d';
    }
    const cfg = RANGE_MAP[rangeKey];
    const intervalStr = `${cfg.amount} ${cfg.unit}`;
    const isHourly = cfg.bucket === 'hour';
    const days = cfg.unit === 'days' ? cfg.amount : 0; // legacy field, for the frontend

    // Hourly buckets are shown in IST (readable); daily buckets stay
    // exactly as before (no behaviour change).
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

    // Where the visitor came from — utm_source if present (short aliases such as
    // 'ig'/'fb' are normalized to the full name), otherwise identified from the
    // referrer's hostname. Each visitor is counted only once (DISTINCT).
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

    // Which source brings the most real customers — not just traffic,
    // but who actually reaches demo and pay.
    const sourceQuality = await pool.query(
      `SELECT ${sourceSql} AS source,
              COUNT(DISTINCT NULLIF(visitor_id,'')) FILTER (WHERE event_type='pageview')::int   AS visitors,
              COUNT(DISTINCT NULLIF(visitor_id,'')) FILTER (WHERE event_type='demo_click')::int AS demo_clicks,
              COUNT(DISTINCT NULLIF(visitor_id,'')) FILTER (WHERE event_type='pay_click')::int  AS pay_clicks
       FROM analytics_events
       WHERE created_at > NOW() - $1::interval
       GROUP BY 1 ORDER BY visitors DESC`, [intervalStr]);

    // How much traffic comes by day and how much by night — IST 6AM-6PM counts as
    // "day". created_at is stored in UTC, so it is shifted by +5:30 to get the
    // IST hour.
    const dayNight = await pool.query(
      `SELECT
         CASE WHEN EXTRACT(HOUR FROM (created_at + INTERVAL '5 hours 30 minutes')) BETWEEN 6 AND 17
              THEN 'day' ELSE 'night' END AS period,
         COUNT(*)::int AS cnt,
         COUNT(DISTINCT NULLIF(visitor_id,''))::int AS uniq
       FROM analytics_events
       WHERE event_type='pageview' AND created_at > NOW() - $1::interval
       GROUP BY period`, [intervalStr]);

    // The money funnel — not from analytics_events, but from the real data in the shops table
    const payments = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE demo=false)::int                                  AS registered,
         COUNT(*) FILTER (WHERE demo=false AND setup_paid=true)::int              AS paid,
         COUNT(*) FILTER (WHERE demo=false AND setup_paid=false)::int             AS pending,
         COALESCE(SUM(setup_amount) FILTER (WHERE demo=false AND setup_paid=true),0)::int AS revenue
       FROM shops
       WHERE created_at > NOW() - $1::interval`, [intervalStr]);

    // The current state of the shops — this is all-time, not just the range
    const shopStats = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE demo=false AND setup_paid=true)::int   AS active,
         COUNT(*) FILTER (WHERE demo=false AND setup_paid=false)::int  AS unpaid,
         COUNT(*) FILTER (WHERE demo=true AND (demo_expires_at IS NULL OR demo_expires_at > NOW()))::int AS demo_live,
         COUNT(*) FILTER (WHERE demo=true AND demo_expires_at IS NOT NULL AND demo_expires_at <= NOW())::int AS demo_expired,
         COUNT(*)::int AS total
       FROM shops`);

    // Total overall income — ALL-TIME, just like "Active shops",
    // independent of the range filter. NOTE: this table records only each shop's
    // FIRST payment (setup_amount). Renewals after a monthly plan
    // are not logged separately yet, so for monthly shops this is not
    // their full lifetime revenue — only the
    // onboarding revenue. For one-time shops this is final.
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

// A reusable helper for creating Razorpay orders (the caller decides whose keys)
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

// The license price (shown by the registration page)
app.get('/api/whitelabel/license-fee', async (req, res) => {
  try {
    res.json({
      licenseFee: await getWlLicenseFee(),
      licenseActual: await getWlLicenseActual(),
      basePrice: await getWlBasePrice()
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Branding — the homepage/customer page take their brand from here
// (from ?wl=slug or the subdomain). If no WL is found, the default Echel.
app.get('/api/whitelabel/branding', async (req, res) => {
  try {
    const wl = await resolveWhitelabel(req);
    if (!wl) return res.json({ isWhitelabel: false });
    // The homepage's live counters — straight from the DB (not hardcoded)
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
    } catch (e) { /* if the count fails, the homepage must not break */ }

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

// Step 1 — the reseller registers (paid=false for now)
app.post('/api/whitelabel/register', async (req, res) => {
  try {
    const b = req.body || {};
    const brand = String(b.brand_name || '').trim().slice(0, 120);
    const owner = String(b.owner_name || '').trim().slice(0, 120);
    const phone = String(b.phone || '').trim();
    const email = String(b.email || '').trim().slice(0, 160);
    const slug  = cleanSlug(b.slug);

    if (brand.length < 2) return res.status(400).json({ error: 'Enter the brand name' });
    if (!owner) return res.status(400).json({ error: 'Enter your name' });
    if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
    if (slug.length < 3) return res.status(400).json({ error: 'The slug must be at least 3 characters (only a-z, 0-9, dash)' });

    const RESERVED = ['www','api','admin','superadmin','app','mail','shop','print','register','agent','wl','whitelabel'];
    if (RESERVED.includes(slug)) return res.status(400).json({ error: 'This slug is reserved, choose another' });

    const dup = await pool.query('SELECT id FROM whitelabels WHERE slug=$1', [slug]);
    if (dup.rows.length) return res.status(400).json({ error: 'This slug is already taken' });

    const wlId = 'WL_' + uuidv4().substring(0, 8).toUpperCase();
    const fee = await getWlLicenseFee();
    const base = await getWlBasePrice();
    // The password is random for now — it is shown to the reseller only after payment
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

// Step 2 — the license fee order (this money comes to OUR account)
app.post('/api/whitelabel/license/create', async (req, res) => {
  try {
    const wlId = String(req.body.wlId || '').trim();
    const r = await pool.query('SELECT id, paid, license_fee FROM whitelabels WHERE id=$1', [wlId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Registration not found' });
    if (r.rows[0].paid) return res.status(400).json({ error: 'The license is already paid' });

    if (!OWNER_RAZORPAY_KEY_ID || !OWNER_RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ error: 'The payment gateway is not configured.' });
    }

    const amount = r.rows[0].license_fee || await getWlLicenseFee();
    const order = await createRazorpayOrder(OWNER_RAZORPAY_KEY_ID, OWNER_RAZORPAY_KEY_SECRET, {
      amount: amount * 100, currency: 'INR',
      receipt: 'WL_' + wlId, notes: { wlId, type: 'whitelabel_license' }
    });
    if (!order.id) {
      const why = order?.error?.description || 'Razorpay rejected the order';
      console.error('WL license create — Razorpay:', JSON.stringify(order));
      return res.status(400).json({ error: 'Could not create the order: ' + why });
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
    if (!r.rows.length) return res.status(404).json({ error: 'The order does not match' });

    // Idempotent — if verify arrives again, do not create a new password
    if (r.rows[0].paid) return res.json({ success: true, alreadyPaid: true, wlId, slug: r.rows[0].slug });

    const password = Math.random().toString(36).slice(-4).toUpperCase() + Math.floor(1000 + Math.random() * 9000);
    await pool.query(
      `UPDATE whitelabels SET paid=true, paid_at=NOW(), password_hash=$2 WHERE id=$1`,
      [wlId, await hashPassword(password)]);

    // The license fee is OUR money (a shop's setup fee belongs to the reseller)
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
    // Captcha — when it is disabled, this line passes through silently
    if (!(await captchaGuard(req, res))) return;
    const wlId = String(req.body.wlId || '').trim().toUpperCase();
    const password = String(req.body.password || '');
    const r = await pool.query('SELECT id, brand_name, paid, blocked, password_hash FROM whitelabels WHERE id=$1', [wlId]);
    if (!r.rows.length) return res.status(401).json({ error: 'Wrong ID or password' });
    const wl = r.rows[0];
    if (!(await verifyPassword(password, wl.password_hash))) {
      return res.status(401).json({ error: 'Wrong ID or password' });
    }
    if (!wl.paid) return res.status(403).json({ error: 'The license payment is not complete yet' });
    if (wl.blocked) return res.status(403).json({ error: 'Your account is currently paused. Please contact the admin.' });

    clearLoginHits(req);
    await upgradeHashIfLegacy('whitelabels', 'id', wl.id, wl.password_hash, password);

    const token = jwt.sign({ wlId: wl.id }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token, brandName: wl.brand_name });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════ WHITE LABEL — the reseller's own panel ══════════════

app.get('/api/whitelabel/me', verifyWhitelabel, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM whitelabels WHERE id=$1', [req.wlId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Account not found' });
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

// Branding — powered by, logo, support contact, brand name
app.put('/api/whitelabel/branding', verifyWhitelabel, async (req, res) => {
  try {
    const b = req.body || {};
    const cut = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : null);
    const email = cut(b.support_email, 160);
    if (email && email !== '' && !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid support email' });
    }
    const phone = cut(b.support_phone, 20);
    if (phone && phone !== '' && !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ error: 'Enter a valid 10-digit support number' });
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
    if (!req.file) return res.status(400).json({ error: 'No file received' });

    const mt = req.file.mimetype;
    const isP = (mt === 'image/png')  && isPng(req.file.buffer);
    const isJ = (mt === 'image/jpeg' || mt === 'image/jpg') && isJpeg(req.file.buffer);
    if (!isP && !isJ) {
      return res.status(400).json({ error: 'Only PNG or JPG files are accepted' });
    }
    if (req.file.size > WL_LOGO_MAX_KB * 1024) {
      return res.status(400).json({
        error: `The logo must be smaller than ${WL_LOGO_MAX_KB} KB (it is ${Math.round(req.file.size / 1024)} KB now)`
      });
    }

    const url = await uploadImageToCloudinary(req.file.buffer, isP ? 'image/png' : 'image/jpeg');
    // logo_url is VARCHAR(400) — a Cloudinary URL fits comfortably
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

// Lets a shop owner link their agent again.
// When it is needed: a new PC / Windows was reinstalled / the token file was lost,
// or a wrong agent claimed the token. After the reset, whichever agent sends a
// token next becomes this shop's agent.
app.post('/api/shop/agent-token/reset', verifyToken, async (req, res) => {
  try {
    await pool.query('UPDATE shops SET agent_token=NULL WHERE id=$1', [req.shopId]);
    invalidateAgentToken(req.shopId);   // clear the cache — otherwise the disconnect has no effect
    console.log('[agent] token reset by owner: ' + req.shopId);
    res.json({ success: true,
      message: 'Agent unlinked. Start the print agent on the shop PC — it will link automatically.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Print agent token check ───────────────────────────────────────────
// PROBLEM: endpoints like /api/jobs/pending/:shopId worked without any auth.
// The Shop ID is public (it is printed in the QR link), so anyone could pull
// the URLs of the files uploaded by that shop's customers and steal the jobs.
//
// FIX (without breaking any shop): for a shop that has agent_token set, the token
// is MANDATORY. A shop without one (an old agent) keeps working as before —
// and as soon as a new agent sends a token for the first time, that token is
// locked to the shop. Once every shop has upgraded, set AGENT_TOKEN_REQUIRED=true
// and everything without a token gets blocked.
const AGENT_TOKEN_REQUIRED = String(process.env.AGENT_TOKEN_REQUIRED || '') === 'true';

function agentTokenFromReq(req) {
  const t = req.get('X-Agent-Token') || req.query.t || (req.body && req.body.agent_token) || '';
  return String(t).trim().slice(0, 64);
}

async function verifyAgent(req, res, next) {
  try {
    // The shopId is either in the URL (/api/jobs/pending/:shopId) or in the BODY
    // (/api/agent/verify-paid-shop, /api/agent/convert-to-paid).
    //
    // Only req.params used to be read, so both Demo -> Paid routes
    // ALWAYS returned 400 "shopId missing" -- the request never even reached
    // the endpoint. In other words the demo-to-paid flow never worked,
    // neither from the panel nor from the tray.
    //
    // Taking it from the body is just as safe: the same agent_token check
    // happens below, so without the right token no other shop's data is returned.
    let shopId = req.params.shopId
              || (req.body && (req.body.shopId || req.body.demoShopId));

    // convert-to-paid only sends a `ticket` (the Shop ID is inside it).
    // We sign the ticket ourselves, so taking the demoShopId from it is
    // safe -- and the real protection is the agent_token check below:
    // only someone holding that demo shop's agent token can convert it.
    if (!shopId && req.body && req.body.ticket) {
      try {
        const t = jwt.verify(String(req.body.ticket), JWT_SECRET);
        if (t && t.act === 'demo-convert') shopId = t.demoShopId;
      } catch (e) { /* invalid/expired ticket -- a 400 comes back below */ }
    }
    if (!shopId) return res.status(400).json({ error: 'shopId missing' });
    // So the endpoint can use it directly (req.params is not always present)
    req.agentShopId = shopId;
    // Token from the cache — this middleware runs on EVERY poll. The token
    // changes only rarely, and on disconnect we clear the cache
    // ourselves, so caching is safe.
    let _tc = agentTokenCache.get(shopId);
    const _ttl = (_tc && _tc.missing) ? AGENT_MISS_TTL_MS : AGENT_TOKEN_TTL_MS;
    if (!_tc || (Date.now() - _tc.at) >= _ttl) {
      const r = await pool.query('SELECT agent_token FROM shops WHERE id=$1', [shopId]);
      if (!r.rows.length) {
        // Not found — remembering that is the real saving. Without it every
        // subsequent poll from that shop went to the DB again.
        setAgentTokenCache(shopId, { token: null, missing: true, at: Date.now() });
        return res.status(404).json({ error: 'Shop not found' });
      }
      _tc = { token: r.rows[0].agent_token, at: Date.now() };
      setAgentTokenCache(shopId, _tc);
    }
    // The cache holds "not found" and the TTL has not run out yet — no need
    // to go to the DB at all.
    if (_tc.missing) return res.status(404).json({ error: 'Shop not found' });

    const stored = _tc.token;
    const sent   = agentTokenFromReq(req);

    if (stored) {
      // Timing-safe compare — makes guessing the token harder
      const a = Buffer.from(String(stored));
      const b = Buffer.from(sent.padEnd(a.length, '\0').slice(0, a.length));
      if (sent.length !== a.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(403).json({ error: 'Invalid agent token' });
      }
      return next();
    }

    // The token is not set yet
    if (sent && /^[A-Za-z0-9_-]{16,64}$/.test(sent)) {
      // The first agent that sends a token becomes this shop's agent
      await pool.query('UPDATE shops SET agent_token=$2 WHERE id=$1 AND agent_token IS NULL', [shopId, sent]);
      setAgentTokenCache(shopId, { token: sent, at: Date.now() });
      return next();
    }
    if (AGENT_TOKEN_REQUIRED) {
      return res.status(403).json({ error: 'The agent is outdated — install the new print agent' });
    }
    return next();   // legacy agent — let it run for now
  } catch (err) { return res.status(500).json({ error: err.message }); }
}

// ── Homepage customization (title, tagline, socials, buttons on/off, price) ──
app.put('/api/whitelabel/homepage', verifyWhitelabel, async (req, res) => {
  try {
    const b = req.body || {};
    const cut = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : null);
    // Links must be http(s) only — so nothing like javascript: gets in
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
    if (b.social_instagram && ig === null) return res.status(400).json({ error: 'The Instagram link must start with https://' });
    if (b.social_youtube   && yt === null) return res.status(400).json({ error: 'The YouTube link must start with https://' });
    if (b.social_facebook  && fb === null) return res.status(400).json({ error: 'The Facebook link must start with https://' });

    // The monthly plan price — it cannot be less than 399
    let monthly = null;
    if (b.monthly_price !== undefined && b.monthly_price !== null && b.monthly_price !== '') {
      monthly = parseInt(b.monthly_price, 10);
      if (isNaN(monthly)) return res.status(400).json({ error: 'Enter the monthly price as a number' });
      if (monthly < WL_MIN_MONTHLY) return res.status(400).json({ error: 'The monthly price cannot be less than ' + WL_MIN_MONTHLY });
      if (monthly > 100000) return res.status(400).json({ error: 'The monthly price is too high' });
    }

    // Buttons on/off — only allowed keys, only true/false
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

// ── Own Cashfree (the alternative to Razorpay) ──
app.put('/api/whitelabel/cashfree', verifyWhitelabel, async (req, res) => {
  try {
    const appId  = String(req.body.cashfree_app_id || '').trim().slice(0, 120);
    const secret = String(req.body.cashfree_secret_key || '').trim().slice(0, 200);
    if (appId && !secret) return res.status(400).json({ error: 'Enter the secret key as well' });
    if (secret && !appId) return res.status(400).json({ error: 'Enter the App ID as well' });
    await pool.query(
      'UPDATE whitelabels SET cashfree_app_id=$2, cashfree_secret_key=$3 WHERE id=$1',
      [req.wlId, appId, secret]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Which gateway to use (razorpay / cashfree) ──
app.put('/api/whitelabel/gateway', verifyWhitelabel, async (req, res) => {
  try {
    const g = String(req.body.gateway || '').trim().toLowerCase();
    if (g !== 'razorpay' && g !== 'cashfree') {
      return res.status(400).json({ error: 'The gateway can only be razorpay or cashfree' });
    }
    const me = await pool.query(
      'SELECT razorpay_key_id, cashfree_app_id FROM whitelabels WHERE id=$1', [req.wlId]);
    if (!me.rows.length) return res.status(404).json({ error: 'Account not found' });
    if (g === 'razorpay' && !me.rows[0].razorpay_key_id) {
      return res.status(400).json({ error: 'Save the Razorpay keys first' });
    }
    if (g === 'cashfree' && !me.rows[0].cashfree_app_id) {
      return res.status(400).json({ error: 'Save the Cashfree keys first' });
    }
    await pool.query('UPDATE whitelabels SET gateway=$2 WHERE id=$1', [req.wlId, g]);
    res.json({ success: true, gateway: g });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Demo account — now only the partner can create one from their login ──
app.post('/api/whitelabel/demo/create', verifyWhitelabel, async (req, res) => {
  try {
    const me = await pool.query('SELECT blocked FROM whitelabels WHERE id=$1', [req.wlId]);
    if (!me.rows.length) return res.status(404).json({ error: 'Account not found' });
    if (me.rows[0].blocked) return res.status(403).json({ error: 'Your account is currently paused' });

    const cfg = await getDemoConfig();
    const name = String(req.body.name || '').trim().slice(0, 100);
    const phone = normPhone(req.body.phone);
    if (!name)  return res.status(400).json({ error: 'Enter a name' });
    if (!phone) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });

    const dupShop = await pool.query('SELECT id FROM shops WHERE phone=$1 AND demo=true', [phone]);
    if (dupShop.rows.length) {
      return res.status(400).json({ error: 'A demo already exists for this number' });
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
               expiresInMinutes: minutes, note: 'Login password = the shop mobile number' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Own Razorpay — shops' setup fees come STRAIGHT here
app.put('/api/whitelabel/razorpay', verifyWhitelabel, async (req, res) => {
  try {
    const keyId = String(req.body.razorpay_key_id || '').trim().slice(0, 120);
    const secret = String(req.body.razorpay_key_secret || '').trim().slice(0, 200);
    if (!keyId || !secret) return res.status(400).json({ error: 'Enter both the Key ID and the Secret' });
    if (!/^rzp_/i.test(keyId)) return res.status(400).json({ error: 'The Key ID must start with rzp_' });
    await pool.query('UPDATE whitelabels SET razorpay_key_id=$2, razorpay_key_secret=$3 WHERE id=$1',
      [req.wlId, keyId, secret]);
    res.json({ success: true, razorpayReady: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// The shop registration price — not below the base
app.put('/api/whitelabel/price', verifyWhitelabel, async (req, res) => {
  try {
    const r = await pool.query('SELECT base_price, blocked FROM whitelabels WHERE id=$1', [req.wlId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Account not found' });
    if (r.rows[0].blocked) return res.status(403).json({ error: 'The account is paused' });

    const base = r.rows[0].base_price || await getWlBasePrice();
    const p = parseInt(req.body.price, 10);
    if (!Number.isInteger(p)) return res.status(400).json({ error: 'Enter a valid price' });
    if (p < base) return res.status(400).json({ error: `The price cannot be less than \u20b9${base}` });
    if (p > 9999) return res.status(400).json({ error: 'The price cannot be more than \u20b99999' });

    await pool.query('UPDATE whitelabels SET shop_price=$2 WHERE id=$1', [req.wlId, p]);
    res.json({ success: true, price: p, base });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Broadcast — shown only to THIS reseller's shops
app.put('/api/whitelabel/broadcast', verifyWhitelabel, async (req, res) => {
  try {
    const msg = String(req.body.message || '').slice(0, 1000);
    await pool.query('UPDATE whitelabels SET broadcast=$2 WHERE id=$1', [req.wlId, msg]);
    res.json({ success: true, message: msg });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// My shops
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
        // 'razorpay' | 'cashfree' | '' — the gateway a shop's setup fee goes
        // through. '' means shops cannot register under this partner yet.
        payMode: wlPayMode(w),
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

// A new password for a partner who has lost theirs, or whose licence was
// activated by the reconcile (the browser that would have shown it was
// closed). Shown once, to the super admin, who passes it on.
app.post('/api/superadmin/whitelabel/:id/reset-password', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, paid FROM whitelabels WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'White label not found' });
    if (!r.rows[0].paid) return res.status(400).json({ error: 'This partner has not paid the licence yet.' });
    const password = crypto.randomBytes(4).toString('hex').toUpperCase();
    await pool.query('UPDATE whitelabels SET password_hash=$2 WHERE id=$1', [req.params.id, await hashPassword(password)]);
    res.json({ success: true, password });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Block/unblock + this reseller's own base price
app.put('/api/superadmin/whitelabel/:id', verifySuperAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const chk = await pool.query('SELECT id, shop_price FROM whitelabels WHERE id=$1', [req.params.id]);
    if (!chk.rows.length) return res.status(404).json({ error: 'White label not found' });

    if (b.blocked !== undefined) {
      await pool.query('UPDATE whitelabels SET blocked=$2 WHERE id=$1', [req.params.id, !!b.blocked]);
    }
    if (b.base_price !== undefined && b.base_price !== '') {
      const bp = parseInt(b.base_price, 10);
      if (isNaN(bp) || bp < 0) return res.status(400).json({ error: 'Enter a valid base price' });
      await pool.query('UPDATE whitelabels SET base_price=$2 WHERE id=$1', [req.params.id, bp]);
      // If the reseller's price has fallen below the base, raise it as well
      if (chk.rows[0].shop_price < bp) {
        await pool.query('UPDATE whitelabels SET shop_price=$2 WHERE id=$1', [req.params.id, bp]);
      }
    }
    const out = await pool.query('SELECT blocked, base_price, shop_price FROM whitelabels WHERE id=$1', [req.params.id]);
    res.json({ success: true, ...out.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════ WHITE LABEL — control over their own shops ══════════
// MOST IMPORTANT: before every action, confirm that the shop belongs to THIS partner.
// Otherwise one partner could touch another's (or our) shops.
async function assertWlShop(wlId, shopId) {
  const r = await pool.query(
    'SELECT id, name, setup_paid, setup_amount, demo, whitelabel_id FROM shops WHERE id=$1', [shopId]);
  if (!r.rows.length) return { err: 'Shop not found' };
  if ((r.rows[0].whitelabel_id || '') !== wlId) return { err: 'This shop does not belong to you' };
  return { shop: r.rows[0] };
}

// The partner changes their password
app.put('/api/whitelabel/password', verifyWhitelabel, async (req, res) => {
  try {
    const oldPass = String(req.body.old_password || '');
    const newPass = String(req.body.new_password || '');
    if (newPass.length < 6) return res.status(400).json({ error: 'The new password must be at least 6 characters' });

    const r = await pool.query('SELECT password_hash FROM whitelabels WHERE id=$1', [req.wlId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Account not found' });
    if (!(await verifyPassword(oldPass, r.rows[0].password_hash))) {
      return res.status(401).json({ error: 'The old password is wrong' });
    }
    await pool.query('UPDATE whitelabels SET password_hash=$2 WHERE id=$1',
      [req.wlId, crypto.createHash('sha256').update(newPass).digest('hex')]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// The partner onboards a shop personally (Shop ID + password instantly)
app.post('/api/whitelabel/onboard', verifyWhitelabel, async (req, res) => {
  try {
    const me = await pool.query(
      `SELECT blocked, shop_price, base_price, razorpay_key_id, cashfree_app_id, gateway
         FROM whitelabels WHERE id=$1`, [req.wlId]);
    if (!me.rows.length) return res.status(404).json({ error: 'Account not found' });
    if (me.rows[0].blocked) return res.status(403).json({ error: 'Your account is currently paused' });
    // Razorpay OR Cashfree — one of them must be set
    if (!me.rows[0].razorpay_key_id && !me.rows[0].cashfree_app_id) {
      return res.status(400).json({ error: 'Set up your Razorpay or Cashfree first — otherwise the shop cannot pay' });
    }

    const name = String(req.body.name || '').trim().slice(0, 200);
    const phone = String(req.body.phone || '').trim();
    const address = String(req.body.address || '').trim().slice(0, 300);
    const printerModel = String(req.body.printer_model || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'The shop name is required' });
    if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });

    const wlBase = me.rows[0].base_price || await getWlBasePrice();
    const sold = (me.rows[0].shop_price && me.rows[0].shop_price > wlBase) ? me.rows[0].shop_price : wlBase;

    // parseInt turned ₹1.5 into 1 here as well (when creating a new shop)
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

// Shop password reset
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

// Manual activate — the partner collected cash (the money is theirs, and so is the risk)
app.post('/api/whitelabel/shop/:shopId/activate', verifyWhitelabel, async (req, res) => {
  try {
    const chk = await assertWlShop(req.wlId, req.params.shopId);
    if (chk.err) return res.status(403).json({ error: chk.err });
    if (chk.shop.setup_paid) return res.status(400).json({ error: 'The shop is already active' });
    const ref = String(req.body.payment_ref || '').trim().slice(0, 60);
    if (!ref) return res.status(400).json({ error: 'Enter a payment reference (for cash, write "CASH")' });
    const { qrUrl } = await activateShop(req.params.shopId, 'WLMANUAL_' + ref);
    console.log(`WL manual activation: ${req.params.shopId} by ${req.wlId} | ref: ${ref}`);
    res.json({ success: true, qrUrl });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Delete a pending shop — never a paid one
app.delete('/api/whitelabel/shop/:shopId', verifyWhitelabel, async (req, res) => {
  try {
    const chk = await assertWlShop(req.wlId, req.params.shopId);
    if (chk.err) return res.status(403).json({ error: chk.err });
    if (chk.shop.setup_paid) return res.status(403).json({ error: 'A paid shop cannot be deleted' });
    await pool.query('DELETE FROM print_jobs WHERE shop_id=$1', [req.params.shopId]);
    await pool.query('DELETE FROM shops WHERE id=$1', [req.params.shopId]);
    console.log(`WL ${req.wlId} deleted pending shop ${req.params.shopId}`);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// The shop PC's printer list + selection
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

// Analytics for the partner's own link
app.get('/api/whitelabel/analytics', verifyWhitelabel, async (req, res) => {
  try {
    // Like the superadmin analytics — short ranges hourly, long ones daily
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

    // Business summary — shops, prints, earnings
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
// Public — the homepage shows these
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

// A shop submits its review — it does not go live directly; the superadmin
// approves it first. One review per shop: submitting again updates the old one
// and sends it back to pending.
app.post('/api/shop/review', verifyToken, async (req, res) => {
  try {
    const name  = String(req.body.name  || '').trim().slice(0, 120);
    const state = String(req.body.state || '').trim().slice(0, 80);
    const text  = String(req.body.text  || '').trim().slice(0, 1200);
    let stars   = parseInt(req.body.stars, 10);
    if (!Number.isFinite(stars) || stars < 1 || stars > 5) stars = 5;

    if (!name)  return res.status(400).json({ error: 'Enter a name' });
    if (!state) return res.status(400).json({ error: 'Enter the state' });
    if (text.length < 10) return res.status(400).json({ error: 'Write a review of at least 10 characters' });

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
               message: 'Review sent. It will appear on the homepage once approved.' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Lets a shop see the review it submitted and its status
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
    if (!name) return res.status(400).json({ error: 'Enter a name' });
    if (!text) return res.status(400).json({ error: 'Write a review' });
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
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
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
    if (!r.rows.length) return res.status(404).json({ error: 'Review not found' });
    res.json({ success: true, review: r.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Approve — unchanged, or with edits. Only the fields that are sent
// change; the rest stay as they are.
app.post('/api/superadmin/reviews/:id/approve', verifySuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

    const cur = await pool.query('SELECT * FROM reviews WHERE id=$1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Review not found' });
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
    if (!name) return res.status(400).json({ error: 'The name cannot be empty' });
    if (!text) return res.status(400).json({ error: 'The review cannot be empty' });

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

// Send it back to pending (if it was approved by mistake)
app.post('/api/superadmin/reviews/:id/unapprove', verifySuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const r = await pool.query(
      "UPDATE reviews SET status='pending' WHERE id=$1 RETURNING *", [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Review not found' });
    res.json({ success: true, review: r.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/superadmin/reviews/:id', verifySuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    await pool.query('DELETE FROM reviews WHERE id=$1', [id]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// ALERTS — an EMAIL when a new shop arrives
//
// The superadmin sets up SMTP only ONCE (with a Gmail app password it takes
// 2 minutes — and it is free). After that:
//   normal shop      -> to the superadmin's email
//   white-label shop -> to that PARTNER's email
// The partner does not set up any SMTP — they just enter their email.
//
// Completely "fire and forget" — even if the email fails, registration or
// payment never stops.
// ══════════════════════════════════════════════════════════════
let _mailer = null, _mailerAt = 0;

async function getMailer() {
  // 5 min cache — no DB hit for every mail
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

// Brevo's HTTPS API — it does not get blocked the way SMTP does
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

// htmlOverride: for designed mails (such as the payment confirmation). Without it
// the old plain <pre> look stays — all the old alerts are unchanged.
async function sendEmailAlert(to, subject, body, fromName, htmlOverride) {
  try {
    if (!to) return { ok: false, why: 'the email is not set' };

    const html = htmlOverride ||
      ('<pre style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.7;white-space:pre-wrap;margin:0;">'
      + String(body).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>');

    // 1) Brevo (HTTPS) — this is what works on Render
    const bc = await pool.query(
      "SELECT key,value FROM system_settings WHERE key IN ('brevo_api_key','brevo_sender')");
    const bm = {}; bc.rows.forEach(r => { bm[r.key] = r.value; });
    if (bm.brevo_api_key && bm.brevo_sender) {
      const r = await sendViaBrevo(bm.brevo_api_key, bm.brevo_sender, fromName, to, subject, body, html);
      if (r.ok) return { ok: true, from: bm.brevo_sender, via: 'Brevo', messageId: r.messageId, response: r.response, accepted: [to], rejected: [] };
      return { ok: false, why: r.why, via: 'Brevo' };
    }

    // 2) SMTP — only when the host does not block it
    const t = await getMailer();
    if (!t) return { ok: false, why: 'Email is not set up — enter a Brevo API key (or SMTP)' };
    const info = await t.sendMail({
      from: `"${(fromName || 'Echel').replace(/"/g, '')}" <${t._fromAddr}>`,
      to, subject, text: body, html
    });
    // What SMTP replied — this is the real proof that the mail was accepted
    return {
      ok: true, via: 'SMTP',
      from: t._fromAddr,
      messageId: info && info.messageId,
      response: info && info.response,
      accepted: (info && info.accepted) || [],
      rejected: (info && info.rejected) || []
    };
  } catch (e) {
    _mailer = null;                     // a new transport will be created next time
    return { ok: false, why: e.message };
  }
}

// It works out on its own whom to send to:
// a white-label shop -> that PARTNER, otherwise us.
async function alertNewShop(shopId, kind) {
  try {
    const s = await pool.query(
      'SELECT id,name,phone,address,setup_amount,whitelabel_id,demo FROM shops WHERE id=$1', [shopId]);
    if (!s.rows.length) return;
    const shop = s.rows[0];
    if (shop.demo) return;   // no alerts for demos — there would be far too many

    let to = '', brand = 'Echel';
    if (shop.whitelabel_id) {
      const w = await pool.query(
        'SELECT brand_name, notify_email, email FROM whitelabels WHERE id=$1', [shop.whitelabel_id]);
      if (!w.rows.length) return;
      brand = w.rows[0].brand_name || brand;
      to = w.rows[0].notify_email || w.rows[0].email || '';   // if there is no alert email, the login one
    } else {
      const c = await pool.query("SELECT value FROM system_settings WHERE key='notify_email'");
      to = c.rows[0]?.value || '';
    }
    if (!to) return;   // not set — stay silent

    const head = kind === 'paid' ? '💰 PAYMENT RECEIVED' : '🆕 NEW SHOP REGISTERED';
    const body =
      `${head}\n\n` +
      `🏪 Shop     : ${shop.name || '-'}\n` +
      `📱 Mobile   : ${shop.phone || '-'}\n` +
      (shop.address ? `📍 Address  : ${shop.address}\n` : '') +
      `🆔 Shop ID  : ${shop.id}\n` +
      `💵 Amount   : ₹${shop.setup_amount || 0}\n\n` +
      (kind === 'paid'
        ? `✅ The shop is now active.`
        : `⏳ Payment is still pending — follow up.`) +
      `\n\n— ${brand}`;

    const subject = `${kind === 'paid' ? '💰 Payment received' : '🆕 New shop'}: ${shop.name || shop.id}`;
    const r = await sendEmailAlert(to, subject, body, brand);
    console.log(`Alert (${kind}) ${shopId} -> ${to}: ${r.ok ? 'sent' : 'FAIL ' + r.why}`);
  } catch (e) {
    console.error('alertNewShop error:', e.message);   // never throws
  }
}

// The demo shop's own EMAIL alert.
//
// No alert used to be sent for demos at all — alertNewShop() does
// `if (shop.demo) return;` at the very start. That was deliberate (many demos
// get created). But the demo is the real lead: the person is trying the software
// right now. So demos get their own separate alert with their own content — and
// alertNewShop was left untouched, so the paid-shop alert stays the same.
//
// To turn it off without changing any code:
//     UPDATE system_settings SET value='0' WHERE key='demo_alert';
//
// how: 'instant'  — created as soon as the form was submitted (the usual path)
//      'approved' — the superadmin approved the demo request
//      'legacy'   — the old /api/demo/create endpoint
async function alertNewDemo(shopId, how) {
  try {
    const g = await pool.query("SELECT value FROM system_settings WHERE key='demo_alert'");
    if (g.rows.length && g.rows[0].value === '0') return;   // disabled by the superadmin

    const s = await pool.query(
      `SELECT id,name,phone,email,address,printer_model,whitelabel_id,demo,demo_expires_at
         FROM shops WHERE id=$1`, [shopId]);
    if (!s.rows.length) return;
    const shop = s.rows[0];
    if (!shop.demo) return;              // not a demo at all — send nothing

    // Whom to send to — a white-label shop -> that PARTNER, otherwise us.
    // Exactly the same approach alertNewShop uses.
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
    if (!to) return;                     // not set — stay silent

    const cfg = await getDemoConfig();
    const hours = Math.max(1, Math.round(cfg.minutes / 60));
    const source = how === 'approved' ? 'Approved by the superadmin'
                 : how === 'legacy'   ? 'Old instant endpoint'
                 : 'Created instantly when the form was submitted';

    const body =
      `🎬 NEW DEMO ACCOUNT CREATED\n\n` +
      `🏪 Shop     : ${shop.name || '-'}\n` +
      `📱 Mobile   : ${shop.phone || '-'}\n` +
      (shop.email         ? `📧 Email    : ${shop.email}\n` : '') +
      (shop.address       ? `📍 Address  : ${shop.address}\n` : '') +
      (shop.printer_model ? `🖨 Printer  : ${shop.printer_model}\n` : '') +
      `🆔 Shop ID  : ${shop.id}\n` +
      `🔑 Password : ${shop.phone || '-'}  (mobile number)\n\n` +
      `⏳ Demo ends   : ${fmtIST(shop.demo_expires_at)}  (${hours} hours)\n` +
      `🖨 Free print  : ${cfg.printLimit}\n` +
      `📥 Created via : ${source}\n\n` +
      `This is a real lead — the person is trying the software right now.\n` +
      `Follow up before the demo ends.\n\n` +
      `— ${brand}`;

    const r = await sendEmailAlert(
      to, `🎬 New demo: ${shop.name || shop.id}`, body, brand);
    console.log(`Alert (demo/${how || 'instant'}) ${shopId} -> ${to}: ${r.ok ? 'sent' : 'FAIL ' + r.why}`);
  } catch (e) {
    console.error('alertNewDemo error:', e.message);   // never throws
  }
}

// ═══════════════════════════════════════════════════════════════════
//  PAYMENT CONFIRMATION EMAIL TO THE SHOP
//  Sent to the shop owner when the payment is confirmed (separate from your alert).
//  A white-label shop gets it with the PARTNER's brand and the PARTNER's support.
// ═══════════════════════════════════════════════════════════════════

// Render runs in UTC — so every date is forced into IST
function fmtIST(d) {
  if (!d) return '-';
  try {
    return new Date(d).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long',
      year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
    }).replace(/\u202f/g, ' ');   // some Node builds produce a narrow space
  } catch (e) { return String(d); }
}

// The same regex already used elsewhere in the server — so the behaviour stays consistent
function isValidEmail(e) {
  return /^\S+@\S+\.\S+$/.test(String(e || '').trim());
}

// The shop name comes from the customer — escaping it before it goes into HTML is ESSENTIAL
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

  // A receipt-like perforated line — this is the mail's signature look
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
        'Thank you, ' + esc(d.shopName) + ' &mdash; your shop is now active.</div>' +
      '<div style="font-family:' + sans + ';font-size:14.5px;line-height:1.65;color:' + muted + '">' +
        'We have received your payment. Your complete shop and payment details are below &mdash; please keep them safe.</div>' +
    '</td></tr>' +

    sectionTitle('Shop details') +
    '<tr><td style="padding:0 28px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
      row('Shop ID', esc(d.shopId), true, true) +
      row('Shop name', esc(d.shopName), false, false) +
      row('Registered on', esc(d.registeredAt), false, false) +
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

    sectionTitle('What to do next') +
    '<tr><td style="padding:2px 28px 0;font-family:' + sans + ';font-size:14.5px;line-height:1.75;color:' + ink + '">' +
      '<div style="padding:4px 0"><b>1.</b> Log in to the dashboard &mdash; with your Shop ID and password</div>' +
      '<div style="padding:4px 0"><b>2.</b> Download your QR code and put it up in your shop</div>' +
      '<div style="padding:4px 0"><b>3.</b> Install the Print Agent &mdash; after that prints come out automatically</div>' +
    '</td></tr>' +
    (d.dashboardUrl
      ? '<tr><td style="padding:20px 28px 4px">' +
          '<a href="' + esc(d.dashboardUrl) + '" style="display:inline-block;background:' + ink + ';color:#ffffff;' +
          'text-decoration:none;font-family:' + sans + ';font-size:15px;font-weight:600;padding:13px 26px;border-radius:6px">' +
          'Dashboard kholiye &rarr;</a></td></tr>'
      : '') +

    '<tr><td style="padding:22px 0 0"></td></tr>' + perf +

    sectionTitle('Need help?') +
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
        'This email was sent automatically by ' + esc(d.brand) + '.<br>' +
        'Did you not make this payment? Let us know immediately on the number above.' +
      '</div>' +
    '</td></tr>' +

  '</table>' +
'</td></tr></table>';
}

// Plain-text version — for old mail apps and the inbox preview line
function buildShopPaymentEmailText(d) {
  return 'PAYMENT RECEIVED — ' + d.brand + '\n' +
    '=================================\n\n' +
    'Thank you, ' + d.shopName + ' — your shop is now active.\n\n' +
    'SHOP DETAILS\n' +
    'Shop ID       : ' + d.shopId + '\n' +
    'Shop name     : ' + d.shopName + '\n' +
    'Registered on : ' + d.registeredAt + '\n\n' +
    'PAYMENT DETAILS\n' +
    'Plan          : ' + d.plan + '\n' +
    'Amount paid   : Rs ' + d.amount + '\n' +
    'Payment ID    : ' + d.paymentId + '\n' +
    'Paid on       : ' + d.paidAt + '\n' +
    (d.validTill ? 'Valid till    : ' + d.validTill + '\n' : '') + '\n' +
    'WHAT TO DO NEXT\n' +
    '1. Log in to the dashboard — with your Shop ID and password\n' +
    '2. Download your QR code and put it up in your shop\n' +
    '3. Install the Print Agent — prints come out automatically\n\n' +
    (d.dashboardUrl ? 'Dashboard: ' + d.dashboardUrl + '\n\n' : '') +
    'NEED HELP?\n' +
    (d.supportPhone ? 'WhatsApp : ' + d.supportPhone + '\n' : '') +
    (d.supportEmail ? 'Email    : ' + d.supportEmail + '\n' : '') + '\n' +
    '-- ' + d.brand + '\n' +
    'Did you not make this payment? Let us know immediately on the number above.';
}

// Reads all the data from the DB and sends the mail. Even on failure it never
// throws — activation must never be held up by this.
async function sendShopPaymentEmail(shopId) {
  try {
    const s = await pool.query(
      `SELECT id,name,email,created_at,setup_amount,setup_payment_id,
              plan_type,billing_cycle,paid_until,whitelabel_id,demo
       FROM shops WHERE id=$1`, [shopId]);
    if (!s.rows.length) return;
    const shop = s.rows[0];
    if (shop.demo) return;                 // no mail for demos
    if (!shop.email) {                     // an old shop — it has no email
      console.log(`Shop mail skipped ${shopId}: no email set`);
      return;
    }

    let brand = 'Echel', supportEmail = '', supportPhone = '', dashboardUrl = BASE_URL + '/admin';

    if (shop.whitelabel_id) {
      // ── WHITE LABEL ── the partner's brand and the partner's support. Our
      // name, number or any program must not appear anywhere in this mail.
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
      } catch (e) { /* if the config is broken, the mail goes out without support details */ }
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
      'Payment received — ' + data.shopName + ' is active',
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
      hasPass: !!m.smtp_pass,          // a password is never sent back
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
    // An empty password = keep the old one (so it does not have to be typed into the form again)
    if (b.pass) await set('smtp_pass', String(b.pass).trim());
    if (b.notifyEmail !== undefined) {
      const e = String(b.notifyEmail).trim();
      if (e && !/^\S+@\S+\.\S+$/.test(e)) return res.status(400).json({ error: 'Enter a valid email' });
      await set('notify_email', e);
    }
    if (b.brevoSender !== undefined) {
      const e = String(b.brevoSender).trim();
      if (e && !/^\S+@\S+\.\S+$/.test(e)) return res.status(400).json({ error: 'Enter a valid sender email' });
      await set('brevo_sender', e);
    }
    if (b.brevoKey) await set('brevo_api_key', String(b.brevoKey).trim());
    _mailer = null;   // settings changed — a new transport will be created
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/notify/test', verifySuperAdmin, async (req, res) => {
  try {
    const c = await pool.query("SELECT value FROM system_settings WHERE key='notify_email'");
    const to = c.rows[0]?.value || '';
    if (!to) return res.status(400).json({ error: 'Save the alert email first' });

    // If Brevo is set, send directly. Otherwise check the SMTP connection first.
    const bk = await pool.query("SELECT value FROM system_settings WHERE key='brevo_api_key'");
    const usingBrevo = !!(bk.rows[0]?.value);
    if (!usingBrevo) {
      const t = await getMailer();
      if (!t) return res.status(400).json({ error: 'Email is not set up — enter a Brevo API key (recommended) or fill in SMTP' });
      try {
        await t.verify();
      } catch (e) {
        _mailer = null;
        const hint = /timeout|ETIMEDOUT|ECONNREFUSED/i.test(e.message)
          ? ' — the hosting provider seems to block the SMTP port. Use a Brevo API key (the option above).'
          : '';
        return res.status(400).json({ error: 'SMTP connection failed: ' + e.message + hint });
      }
    }

    const r = await sendEmailAlert(to, '✅ Test — Echel alerts',
      'This is a test email.\n\nIf you received it, alerts are working.\nFrom now on you will get a message here whenever a new shop registers.\n\n— Echel');
    if (!r.ok) return res.status(400).json({ error: 'Could not send: ' + r.why });
    if (r.rejected && r.rejected.length) {
      return res.status(400).json({ error: 'Rejected by the server: ' + r.rejected.join(', ') });
    }
    console.log(`Test mail -> ${to} | ${r.response} | id=${r.messageId}`);
    res.json({
      success: true, to, from: r.from, via: r.via,
      accepted: r.accepted, messageId: r.messageId, response: r.response
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── White label partner: only their own email (no SMTP setup) ──
app.put('/api/whitelabel/notify', verifyWhitelabel, async (req, res) => {
  try {
    const e = String(req.body.notifyEmail || '').trim();
    if (e && !/^\S+@\S+\.\S+$/.test(e)) return res.status(400).json({ error: 'Enter a valid email' });
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
    if (!to) return res.status(400).json({ error: 'Save your email first' });
    const brand = row.brand_name || 'Partner';
    const r = await sendEmailAlert(to, `✅ Test — ${brand} alerts`,
      `This is a test email.\n\nIf you received it, alerts are working.\nFrom now on you will get a message here whenever a new shop registers through your link.\n\n— ${brand}`, brand);
    if (!r.ok) return res.status(400).json({ error: 'Could not send: ' + r.why });
    res.json({ success: true, to });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/setup-fee/current', async (req, res) => {
  try {
    const pricing = await getSetupPricing();

    // ── WHITE LABEL ──
    // A partner's site (subdomain or ?wl=slug) must show THEIR OWN price,
    // not ours. This used to be missed entirely, so the partner changed the price
    // but their URL still showed the old one.
    const wlHere = await resolveWhitelabel(req);
    if (wlHere) {
      const wlBase = wlHere.base_price || await getWlBasePrice();
      const wlPrice = (wlHere.shop_price && wlHere.shop_price > wlBase) ? wlHere.shop_price : wlBase;
      const fest0 = await getFestivalOffer();
      return res.json({
        ...pricing,
        // White-label sells only Starter. The partner sells the basic product at
        // their base price — Pro/Premium are for our own channel.
        // (The demo is offered separately on the homepage.)
        plans: { starter: { fee: wlPrice, actual: 0, advance: false } },
        amount: wlPrice,
        offerPrice: wlPrice,
        actualPrice: wlPrice,        // no "struck-through" price on the partner's site
        monthlyPrice: wlHere.monthly_price || pricing.monthlyPrice,
        advancedFee: await getAdvancedFee(),
        monthlyActualPrice: wlHere.monthly_price || await getMonthlyActualFee(),
        advancedActualPrice: await getAdvancedActualFee(),
        // The festival offer is ours — it does not apply to a partner's price
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
      // The new three plans — the homepage and register page read this
      plans: await getPlanPricing(),
      advancedFee: await getAdvancedFee(),
      monthlyActualPrice: await getMonthlyActualFee(),
      advancedActualPrice: await getAdvancedActualFee(),
      festivalOfferEnabled: festival.enabled,
      festivalOfferName: festival.name,
      festivalOfferEnd: festival.endAt
    };
    // ?ref=QRA-1234 — the agent's own price (one-time plan only).
    // The agent floor is now the AGENT BASE PRICE, not the public Offer Price —
    // even if the agent has set nothing, this (such as 699) is shown.
    if (req.query.ref) {
      const s = await resolveRef(req.query.ref);
      if (s && s.is_agent) {
        // Only the floor. The old `agent_price` (markup) no longer counts --
        // the column remained even after that feature was switched off
        // and was silently raising the customer's price.
        const agentBase = await getAgentBasePrice();
        out.offerPrice = agentBase;
        out.amount = agentBase;
        out.agentRef = req.query.ref;
        out.agentName = s.name;
        // Only Pro and Premium on an agent link. Starter is the cheapest —
        // there is no room for an agent commission on it, so it is not sold
        // through the agent channel.
        out.plans = filterPlansForChannel(out.plans, 'agent');
        // Both of the agent's plans have their own floor.
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

// Only this many UNPAID shops can be created from one IP in 24 hours.
// Paid shops are not counted, so genuine resellers are not blocked.
const UNPAID_PER_IP_DAY = parseInt(process.env.UNPAID_REG_PER_IP_DAY || '3', 10);

// After this many attempts from the same mobile number, a block for this long.
// An honest person makes a mistake once or twice, never more than three times.
const REG_PHONE_MAX = parseInt(process.env.REG_RETRY_PER_PHONE || '3', 10);
const REG_PHONE_WINDOW_MS = 15 * 60 * 1000;

app.post('/api/shop/register', async (req, res) => {
  try {
    // ── Guard 1: the permanent blocklist ──
    const _regIp = clientIp(req);
    if (await isIpBanned(_regIp)) {
      await logSecurityEvent({
        ip: _regIp, endpoint: req.path, method: req.method,
        userAgent: req.headers['user-agent'],
        action: 'SHOP_REGISTER', reason: 'IP_BANNED' });
      return res.status(403).json({
        error: 'Registration is disabled from this connection. Please contact support.' });
    }

    // ── Guard 2: how many unpaid shops per IP ──
    // This was the hole that let the same person keep creating shops.
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
          error: 'Several shops have already been created from this connection without payment. '
               + 'Complete their setup first, or contact support.' });
      }
    } catch (e) {
      // If an old DB has no created_at column, blocking registration would be wrong
      console.warn('unpaid-reg check skip:', e.message);
    }

    const {
      name, address, phone, printer_model, price_bw, price_color, payment_mode, password,
      payment_gateway, razorpay_key_id, razorpay_key_secret,
      cashfree_app_id, cashfree_secret_key, email, ref
    } = req.body;

    // Referral: came via ?ref=SHOP_XXX — valid only when that referrer
    // EXISTS and is PAID itself (an unpaid shop cannot refer),
    // and is not referring itself
    // ref = an agent code (QRA-1234) or an old shop id — both supported
    const refShop = await resolveRef(ref);
    const referredBy = refShop ? refShop.id : '';
    const onboardedBy = (refShop && refShop.is_agent) ? refShop.id : '';

    // ── Guard 3: captcha ──
    // The whole captcha system already existed and ran on login;
    // it just had not been added to registration. To turn it off, set
    // captcha_enabled = '0' in system_settings.
    if (!(await captchaGuard(req, res))) return;

    // ── Guard 4: a real mobile number ──
    // validateIndianMobile() already existed but applied ONLY to demos.
    // On registration the phone went into the DB unchecked — even 1111111111
    // got through. Now both paths go through the same check.
    const _ph = registerPhoneCheck(phone);
    if (!_ph.ok) return res.status(400).json({ error: _ph.error });

    // ── Guard 5: repeated attempts from the same number ──
    // Here we only CHECK whether it is already blocked. The COUNT goes up
    // below — right before the INSERT. Reason: if the count went up here,
    // even a small password typo would count as an "attempt",
    // and after three typos an honest person would be locked out for 15 minutes.
    // Now only a fully valid submission is counted.
    const _pk = 'reg:' + _ph.phone;
    const _pmin = isBlocked(_pk);
    if (_pmin) {
      await logSecurityEvent({ ip: _regIp, endpoint: req.path, method: req.method,
        userAgent: req.headers['user-agent'], action: 'SHOP_REGISTER',
        reason: 'PHONE_RETRY_BLOCKED' });
      return res.status(429).json({
        error: 'Too many attempts from this number. Try again in ' + _pmin
             + ' minutes.' });
    }

    if (!name || !name.trim()) return res.status(400).json({ error: 'The shop name is required' });
    if (!password || password.length < 4) return res.status(400).json({ error: 'The password must be at least 4 characters' });
    // Prices: empty keeps the usual Rs 5 / Rs 10; anything typed has to be a
    // real price. A negative or zero price went straight into the database.
    const regPriceBw = (price_bw === undefined || price_bw === null || price_bw === '') ? 5 : parsePrice(price_bw);
    const regPriceColor = (price_color === undefined || price_color === null || price_color === '') ? 10 : parsePrice(price_color);
    if (!(regPriceBw > 0)) return res.status(400).json({ error: 'Enter a B&W price above ₹0' });
    if (!(regPriceColor > 0)) return res.status(400).json({ error: 'Enter a Color price above ₹0' });
    if (password.length > PASSWORD_MAX) return res.status(400).json({ error: 'The password is too long' });

    // Email is now REQUIRED — the payment confirmation is sent to it
    const finalEmail = String(email || '').trim().toLowerCase();
    if (!finalEmail) return res.status(400).json({ error: 'An email is required — the payment receipt is sent to it' });
    if (!isValidEmail(finalEmail)) return res.status(400).json({ error: 'The email does not look valid — please check it again' });

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
        return res.status(400).json({ error: 'Online payment requires Razorpay or Cashfree details' });
      }
    }

    const shopId = 'SHOP_' + uuidv4().substring(0,8).toUpperCase();
    const passwordHash = await hashPassword(password);
    const currentSetupFee = await getSetupFeeAmount();
    // Plan: starter / pro / premium — all three LIFETIME.
    // The old 'monthly'/'onetime' no longer come with new registrations;
    // old shops keep running with their plan_type as before.
    let plan = normalizePlan(req.body.plan);
    const planPricing = await getPlanPricing();
    // If it came through an agent link, the floor = the AGENT BASE PRICE (set by
    // the superadmin, such as 699) — not the public Offer Price (599). If the agent
    // set something else (such as 799), that applies. This applies ONLY
    // to the one-time plan; monthly always uses the public rate.
    // Direct registration = the price of the chosen plan.
    // When it comes through an agent / white-label link, their own price wins
    // (it is overridden below) — their business model stays the same.
    let oneTimePrice = planPricing[plan].fee;
    let onetimeBaseForRecord = planPricing[plan].fee;
    if (onboardedBy) {
      // Only Pro and Premium are sold through the agent channel. Even if someone sends
      // ?plan=starter&ref=... directly, they will not get Starter —
      // that option is not shown on the page, so such a request is
      // deliberately crafted.
      if (!PLANS_BY_CHANNEL.agent.includes(plan)) plan = 'pro';
      const agentBase = await getAgentBasePrice();
      // The agent's own price is only the Pro floor. Premium keeps its own
      // (above) price — otherwise the agent would sell Premium cheaply.
      // Each plan has its own agent floor — and only that. The old
      // `agent_price` / `agent_premium_price` (markup) no longer count towards the price;
      // that feature has been switched off but the columns remained.
      if (plan === 'pro') {
        oneTimePrice = agentBase;
        onetimeBaseForRecord = agentBase;
      } else {
        // Premium has its own agent floor — separate from the Pro one.
        const premBase = await getAgentPremiumBasePrice();
        oneTimePrice = premBase;
        onetimeBaseForRecord = premBase;
      }
    }

    // ── WHITE LABEL ── when it came via ?wl=slug or a subdomain, the reseller's
    // price applies, and the setup fee goes STRAIGHT to their Razorpay.
    const wl = await resolveWhitelabel(req);
    let whitelabelId = '';
    if (wl) {
      // The reseller has not set up any gateway — the money would come to us by
      // mistake, so block the registration itself (with a clear
      // message). This used to check only Razorpay, so a partner using
      // Cashfree got stuck right here.
      if (!wlPayMode(wl)) {
        return res.status(503).json({ error: 'This partner has not completed their payment setup yet. Please try again a little later.' });
      }
      whitelabelId = wl.id;
      // White-label sells only Starter. The partner sells the basic product under
      // their own name — Pro/Premium are for our own channel.
      if (!PLANS_BY_CHANNEL.wl.includes(plan)) plan = 'starter';
      const wlBase = wl.base_price || await getWlBasePrice();
      oneTimePrice = (wl.shop_price && wl.shop_price > wlBase) ? wl.shop_price : wlBase;
      onetimeBaseForRecord = wlBase;
    }
    const firstPayment = oneTimePrice;
    const soldPrice = oneTimePrice;
    const basePrice  = onetimeBaseForRecord;

    // ── Guard 5 (second part): now increase the count ──
    // Only someone who filled in the form CORRECTLY gets this far. So this
    // counts "attempts", not "typos". After three, that number gets a
    // 15-minute block.
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
          error: 'Too many attempts from this number. Try again in ' + SEC.blockMin
               + ' minutes.' });
      }
    }

    // The shop is created, but setup_paid stays false by default.
    // The QR Code and the Print Agent are available only after the setup fee payment is confirmed.
    await pool.query(
      `INSERT INTO shops
        (id,name,address,phone,email,printer_model,price_bw,price_color,payment_mode,password_hash,
         payment_gateway,razorpay_key_id,razorpay_key_secret,cashfree_app_id,cashfree_secret_key,
         setup_paid,setup_amount,plan_type,referred_by,onboarded_by,base_price_at_signup,sold_price,whitelabel_id,
         created_ip,billing_cycle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,false,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [shopId, name, address, _ph.phone, finalEmail, printer_model, regPriceBw, regPriceColor, finalPaymentMode, passwordHash,
       finalGateway, razorpay_key_id||'', razorpay_key_secret||'', cashfree_app_id||'', cashfree_secret_key||'',
       firstPayment, plan, referredBy, onboardedBy, basePrice, soldPrice, whitelabelId,
       _regIp, planPricing[plan].billingCycle]
    );
    // Every new shop now carries its IP too — if such a question comes up again,
    // the answer is immediate.

    res.json({ success: true, shopId, setupFeeAmount: firstPayment, plan, billingCycle: planPricing[plan].billingCycle });
    // The alert comes later — the response has already been sent, so the customer does not have to wait
    alertNewShop(shopId, 'new');
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── SETUP FEE PAYMENT — the money goes to the platform owner's Razorpay account ───
app.post('/api/setup-fee/create', async (req, res) => {
  try {
    const { shopId } = req.body;
    if (!shopId) return res.status(400).json({ error: 'Shop ID required' });

    // the phone is needed too — a Cashfree order requires customer_phone
    const shopResult = await pool.query(
      'SELECT id, phone, setup_paid, setup_amount, whitelabel_id FROM shops WHERE id=$1', [shopId]);
    if (!shopResult.rows.length) return res.status(404).json({ error: 'Shop not found' });
    if (shopResult.rows[0].setup_paid) return res.status(400).json({ error: 'The setup fee is already paid' });

    // ── Whose account does the money go to? ──
    // Normal shop -> our Razorpay. A white-label shop -> the RESELLER's
    // Razorpay (their earnings go straight to them, not to us).
    let payKeyId = OWNER_RAZORPAY_KEY_ID, payKeySecret = OWNER_RAZORPAY_KEY_SECRET;
    const wlIdOfShop = shopResult.rows[0].whitelabel_id || '';

    // SAFETY: the request came from a partner's URL but the shop has no
    // whitelabel_id — meaning the context was lost at registration time.
    // In that case do NOT silently take the money into our account.
    // Return a clear error so the mistake gets caught and the money does not go to the wrong place.
    if (!wlIdOfShop) {
      const wlReq = await resolveWhitelabel(req);
      if (wlReq) {
        console.error(`SETUP FEE MISMATCH: shop ${shopId} has an empty whitelabel_id `
          + `but the request came from the URL of partner "${wlReq.slug}". Payment blocked.`);
        return res.status(409).json({
          error: 'This shop is not linked to its partner account. Please contact your partner.',
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
      if (!wrow) return res.status(503).json({ error: 'The payment setup of the partner is incomplete. Please contact them.' });
      if (wrow.blocked) return res.status(403).json({ error: 'This partner account is not active right now.' });

      const mode = wlPayMode(wrow);
      if (!mode) {
        return res.status(503).json({ error: 'The payment setup of the partner is incomplete. Please contact them.' });
      }

      // ── The partner uses Cashfree ──
      // The money goes straight to the partner's Cashfree account. Unlike Razorpay,
      // the browser brings no signature back here — after payment
      // Cashfree redirects back from its own page, and we ask the
      // server for the order status and activate the shop
      // (the same approach as the customer print payment).
      if (mode === 'cashfree') {
        const cfAmount = shopResult.rows[0].setup_amount || SETUP_FEE_AMOUNT;
        // Cashfree order_id: only A-Z 0-9 _ are allowed, up to 50 chars.
        // 4 random bytes at the end — Date.now() has millisecond
        // resolution, and Cashfree does not accept the same order_id twice. The customer
        // print payment uses the same approach.
        const cfOrderId = 'QSPS_' + String(shopId).replace(/[^A-Za-z0-9_]/g, '').slice(-16)
          + '_' + Date.now().toString(36).toUpperCase()
          + crypto.randomBytes(3).toString('hex').toUpperCase();

        // Send them back to the PARTNER's own domain, not ours —
        // otherwise the brand changes halfway and the shop owner thinks they
        // have landed on some other site.
        const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
        const host  = String(req.headers.host || '').split(',')[0].trim();
        const origin = host ? (proto + '://' + host) : BASE_URL;

        const cfPhone = String(shopResult.rows[0].phone || '').replace(/\D/g, '').slice(-10);
        const cfBody = JSON.stringify({
          order_id: cfOrderId,
          order_amount: Number(cfAmount),        // rupees, NOT paise
          order_currency: 'INR',
          customer_details: {
            customer_id: 'SHOP_' + String(shopId).slice(-12),
            // Cashfree requires a phone; if the shop has no number, use a
            // placeholder — it has no effect on the payment.
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
            error: 'Could not create the order with the Cashfree account of the partner — ask them to check their keys',
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
          amount: cfAmount,                      // rupees (the Razorpay one is in paise)
          shopId
        });
      }

      payKeyId = wrow.razorpay_key_id;
      payKeySecret = wrow.razorpay_key_secret;
    }

    if (!payKeyId || !payKeySecret) {
      console.error('Setup fee create error: Razorpay keys missing');
      return res.status(500).json({ error: 'The payment gateway is not configured.' });
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
      // Razorpay's real reason (wrong key, amount, etc.) comes here —
      // log it and send it to the frontend so it can be debugged.
      const rzpReason = razorpayOrder && razorpayOrder.error && razorpayOrder.error.description
        ? razorpayOrder.error.description
        : 'Razorpay rejected the order';
      console.error('Setup fee create error — Razorpay:', JSON.stringify(razorpayOrder));
      return res.status(400).json({ error: 'Could not create the setup fee order: ' + rzpReason, details: razorpayOrder });
    }

    await pool.query('UPDATE shops SET setup_order_id=$1 WHERE id=$2', [razorpayOrder.id, shopId]);

    res.json({
      success: true,
      gateway: 'razorpay',        // the page uses this to decide which checkout to open
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


// ── Confirm the setup of a shop returning from Cashfree ──
//
// With Razorpay the browser brings a signature, so /verify runs there.
// With Cashfree nothing like that comes back — so we ask Cashfree
// OURSELVES whether the order was paid. The customer print payment
// already works the same way.
//
// This route needs no login (like the customer status), but nobody can
// activate a shop for free through it: it counts as paid only when
// Cashfree itself says PAID, and that is asked with the PARTNER's own keys.
app.get('/api/setup-fee/cashfree-status/:shopId', async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const r = await pool.query(
      'SELECT id, setup_paid, qr_code, setup_order_id, whitelabel_id FROM shops WHERE id=$1',
      [shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    const shop = r.rows[0];

    // Already done (reloaded, or two tabs were open)
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

    // activateShop itself is race-safe (AND setup_paid=false), so even if two
    // polls arrive together the shop is not activated twice.
    const { qrCode } = await activateShop(shopId, shop.setup_order_id);
    console.log('[Cashfree] setup PAID (partner) shop=' + shopId + ' order=' + shop.setup_order_id);
    res.json({ success: true, status: 'PAID', qrCode });
  } catch (err) {
    console.error('Cashfree setup status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Shop activation (when the setup fee is confirmed) — the verify handler,
//    the webhook and reconciliation all use this ──
// Which plans a customer sees depends on the path they came through.
//   direct  — all three (Starter, Pro, Premium)
//   agent   — only Pro and Premium. The agent earns a commission,
//             so the cheapest plan, Starter, is not shown on their link.
//   wl      — only Starter. The partner sells the basic product under
//             their own name; the demo is offered separately on the homepage.
const PLANS_BY_CHANNEL = {
  direct: ['starter', 'pro', 'premium'],
  agent:  ['pro', 'premium'],
  wl:     ['starter']
};

/** Keep only the plans allowed for the channel and remove the rest. */
function filterPlansForChannel(plans, channel) {
  const allow = PLANS_BY_CHANNEL[channel] || PLANS_BY_CHANNEL.direct;
  const out = {};
  allow.forEach(k => { if (plans[k]) out[k] = plans[k]; });
  return out;
}

// ══════════════════════════════════════════════════════════════
//  PLANS — Starter / Pro / Premium (all three LIFETIME)
//
//  The old plans ('monthly', 'onetime') stay in the DB exactly as they
//  are — they were not touched. New registrations choose only one of
//  these three.
//
//    Starter — software + basic Echel. Advance separately (₹199).
//    Pro     — advance unlocked right away. Future new features cost extra.
//    Premium — advance + ALL upcoming advance features free.
//
//  NEW keys were created for the prices. The old keys (setup_fee_amount,
//  monthly_fee) were not touched — the agent, white-label and old
//  shop calculations depend on them.
// ══════════════════════════════════════════════════════════════
const PLAN_DEFS = {
  starter: { feeKey: 'plan_starter_fee', actualKey: 'plan_starter_actual',
             defFee: 599, defActual: 2999, advance: false },
  pro:     { feeKey: 'plan_pro_fee',     actualKey: 'plan_pro_actual',
             defFee: 899, defActual: 2999, advance: true  },
  premium: { feeKey: 'plan_premium_fee', actualKey: 'plan_premium_actual',
             defFee: 999, defActual: 2999, advance: true  }
};

/** Clean the plan from the body. For an old name, map to the closest one. */
function normalizePlan(p) {
  const v = String(p || '').toLowerCase().trim();
  if (PLAN_DEFS[v]) return v;
  // An old cached page or an old link. Neither 'onetime' nor 'monthly'
  // included advance — so Starter is the correct mapping.
  return 'starter';
}

/** With Pro and Premium, advance is unlocked together with the payment. */
function planIncludesAdvance(plan) {
  return !!(PLAN_DEFS[normalizePlan(plan)] || {}).advance;
}

/** Price + strikethrough of all three plans, in a single query. */
async function getPlanPricing() {
  const keys = [];
  Object.entries(PLAN_DEFS).forEach(([name,d]) => keys.push(d.feeKey, d.actualKey, 'plan_'+name+'_cycle'));
  const map = {};
  try {
    const r = await pool.query(
      `SELECT key, value FROM system_settings WHERE key = ANY($1)`, [keys]);
    // Prices are numbers, but the billing cycle is a word. Running parseInt()
    // over it too turned 'monthly' into NaN, and NaN reads as lifetime — so
    // whatever cycle Superadmin chose, the homepage said "one-time payment"
    // and every new shop was registered as lifetime, never to be renewed.
    r.rows.forEach(row => {
      map[row.key] = /_cycle$/.test(row.key) ? String(row.value || '') : parseInt(row.value);
    });
  } catch (e) { /* fall back to the default */ }

  const out = {};
  for (const [name, d] of Object.entries(PLAN_DEFS)) {
    const fee = (!isNaN(map[d.feeKey]) && map[d.feeKey] > 0) ? map[d.feeKey] : d.defFee;
    // actual 0 = hide the strikethrough
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

// Agent Base Price — a separate floor for agents. If it is 0/unset, the public Offer
// Price stays the floor (the old behaviour; nothing breaks). Only when the superadmin
// explicitly sets it does the agent's price start to differ from the
// homepage price.
async function getAgentBasePrice() {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='agent_base_price'");
    const v = parseInt(r.rows[0]?.value) || 0;
    if (v > 0) return v;
  } catch(e) {}
  // If it is not set, Pro's own price — that is the agent's cheapest plan.
  return (await getPlanPricing()).pro.fee;
}

// Is the shop's subscription alive? onetime = always; monthly = check paid_until
function isSubscriptionActive(shop) {
  return subscriptionActive(shop);
}

// Monthly renewal — RACE-SAFE: the renewal_order_id match + clear happen in one atomic
// UPDATE (webhook + verify + reconcile can all fire — only the
// first one wins, the rest are no-ops, never a double +30 days)
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
    // Renewals go into the ledger too — previously no record was created for them either
    try {
      await recordPayment({
        kind: 'renewal', shopId,
        amount: r.rows[0].renewal_amount || await getMonthlyFee(),
        paymentId, orderId, note: billingCycle(r.rows[0])+' subscription renewal'
      });
    } catch (e) { console.error('renewal ledger error:', e.message); }
    return r.rows[0].paid_until;
  }
  return null; // someone else already processed it
}

// ── PAYMENT LEDGER ──
// Every platform payment (setup / advanced / renewal / whitelabel license)
// is recorded here. Because of ON CONFLICT DO NOTHING, even if the webhook and
// verify both arrive only one row is created — never a double count.
// This function never throws: a ledger failure must not block the real work
// of the payment (activating the shop).
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

  // RACE-SAFE: the webhook, verify and reconcile can all arrive at the same time.
  // Because of `AND setup_paid=false` only the FIRST one wins; the rest are no-ops.
  // This is why the alert and the shop email are NEVER sent TWICE.
  const upd = await pool.query(
    `UPDATE shops SET setup_paid=true, setup_payment_id=$1, qr_code=$2,
       paid_until=CASE WHEN (${MONTHS_SQL})>0 THEN NOW()+make_interval(months=>(${MONTHS_SQL})) ELSE NULL END
     WHERE id=$3 AND setup_paid=false RETURNING id`,
    [paymentId, qrCode, shopId]
  );
  const firstTime = upd.rows.length > 0;

  if (firstTime) {
    // With Pro and Premium the Advance Feature unlocks together with the
    // payment — the shop owner does not pay ₹199 separately.
    // With Pro and Premium the core Advance pack unlocks together with the
    // payment. Premium does not need to be put into owned_features
    // (it is derived from the plan), but adding it does no harm
    // either — if the plan changes later, the record is kept.
    {
      const planRow = await pool.query('SELECT plan_type FROM shops WHERE id=$1', [shopId]);
      const pt = planRow.rows[0]?.plan_type;
      if (pt === 'pro' || pt === 'premium') {
        const catalog = await getAdvanceFeatures();
        await grantFeatures(shopId, coreFeatureIds(catalog));
      }
    }
    console.log(`Setup fee paid: ${shopId} | Payment: ${paymentId}`);

    // Record it in the ledger — this is what the superadmin sees.
    // The money of a white-label shop goes to the reseller's account,
    // not to us — so it is marked separately and not counted in our
    // revenue total.
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
        note: p.whitelabel_id ? 'white-label shop (money goes to the reseller)' : ''
      });
    } catch (e) { console.error('setup ledger error:', e.message); }

    // Alert to you (even if it fails, activation does not stop)
    alertNewShop(shopId, 'paid');
    // Payment confirmation email to the shop owner
    sendShopPaymentEmail(shopId);
  } else {
    console.log(`Setup fee: ${shopId} is already paid — alert/mail not sent again`);
  }

  // ── AGENT COMMISSION ── was this shop onboarded by an agent?
  // NEW RULE: a FLAT ₹100 for every paid shop. No markup (agents cannot
  // change their price), no 10-shop bonus. So the markup/bonus
  // columns are always 0 — the calculation for old rows stays exactly
  // the same; only from now on the flat rate applies.
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

  // ── REFER & EARN WAS REMOVED ──
  // The referrer used to get ₹50 here. Now there is only the Agent program
  // (flat ₹100). The referred_by / referral_earnings columns stay in the DB
  // so old data does not break, but no new reward is ever created.
  try {
    await pool.query('UPDATE shops SET referral_rewarded=true WHERE id=$1', [shopId]);
  } catch(e) { console.error('referral flag error:', e.message); }

  return { qrCode, qrUrl };
}

app.post('/api/setup-fee/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, shopId } = req.body;

    // The signature is verified with the same SECRET the order was created with —
    // a white-label shop's order is created with the reseller's keys.
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

    // Payment confirmed — now activate the shop and generate the QR
    const shopResult = await pool.query('SELECT id FROM shops WHERE id=$1 AND setup_order_id=$2', [shopId, razorpay_order_id]);
    if (!shopResult.rows.length) return res.status(404).json({ error: 'Shop or order does not match' });

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
      return res.status(500).json({ error: 'The owner Razorpay account is not configured' });
    const sh = await pool.query('SELECT advanced_unlocked FROM shops WHERE id=$1', [req.shopId]);
    if (!sh.rows.length) return res.status(404).json({ error: 'Shop not found' });
    if (sh.rows[0].advanced_unlocked) return res.status(400).json({ error: 'Advanced is already unlocked' });

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
    if (!order.id) return res.status(400).json({ error: 'Could not create the order' });
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
    // Atomic: order match + unlock together (double-fire safe)
    const r = await pool.query(
      "UPDATE shops SET advanced_unlocked=true, advanced_order_id='' WHERE id=$1 AND advanced_order_id=$2 RETURNING id",
      [req.shopId, razorpay_order_id]);
    if (!r.rows.length) {
      // The signature only proves that Razorpay saw SOME payment of ours — a
      // renewal, an add-on, another shop's unlock. The pack used to be granted
      // right here anyway, so any of those receipts opened it for free. Now
      // only this shop's own open unlock order does. The same order coming back
      // after the webhook or the reconcile already used it is simply done.
      const sh = await pool.query('SELECT advanced_unlocked FROM shops WHERE id=$1', [req.shopId]);
      if (sh.rows[0] && sh.rows[0].advanced_unlocked) return res.json({ success: true, unlocked: true });
      return res.status(400).json({ error: 'This payment does not belong to this unlock.' });
    }
    // Grant the core pack along with the legacy flag — the real truth now lives in
    // owned_features. Without it the Pro/Premium difference would not
    // apply and the ownership of new features would be unknown.
    {
      const catalog = await getAdvanceFeatures();
      await grantFeatures(req.shopId, coreFeatureIds(catalog));
    }
    {
      console.log('Advanced unlocked:', req.shopId, razorpay_payment_id);
      // PREVIOUSLY this money was not recorded anywhere — just a console.log.
      // That is why the ₹199 unlocks never showed up in superadmin.
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

// ─── MONTHLY RENEWAL — ₹99 via the owner's Razorpay to the platform owner ───
app.post('/api/admin/renew/create-order', verifyToken, async (req, res) => {
  try {
    if (!OWNER_RAZORPAY_KEY_ID || !OWNER_RAZORPAY_KEY_SECRET)
      return res.status(500).json({ error: 'The owner Razorpay account is not configured' });
    const sh = await pool.query('SELECT id, plan_type, billing_cycle, setup_amount FROM shops WHERE id=$1', [req.shopId]);
    if (!sh.rows.length) return res.status(404).json({ error: 'Shop not found' });
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
    if (!razorpayOrder.id) return res.status(400).json({ error: 'Could not create the renewal order' });

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
    // Captcha — when it is disabled, this line passes through silently
    if (!(await captchaGuard(req, res))) return;
    const { shopId, password } = req.body;
    if (!shopId || !password) return res.status(400).json({ error: 'Both Shop ID and password are required' });

    const r = await pool.query('SELECT * FROM shops WHERE id=$1', [shopId.trim().toUpperCase()]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop ID not found' });

    const shop = r.rows[0];


    if (!shop.password_hash) {
      return res.status(401).json({ error: 'This shop has no password set. Use Set Password first.' });
    }
    if (!(await verifyPassword(password, shop.password_hash))) {
      return res.status(401).json({ error: 'Wrong password' });
    }

    clearLoginHits(req);
    // If the hash is the old sha256, convert it to scrypt now — the user will not notice
    await upgradeHashIfLegacy('shops', 'id', shop.id, shop.password_hash, password);

    const token = jwt.sign({ shopId: shop.id }, JWT_SECRET, { expiresIn: '24h' });
    delete shop.password_hash;
    res.json({ success: true, token, shop });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Set/claim password — the REGISTERED MOBILE is now verified ──
// Previously anyone could set the password of any legacy Shop ID (which is public
// in the QR URL) and hijack the shop. Now: provide the shop's registered number,
// and only a match is accepted. The phone was removed from the public API (below), so
// an attacker cannot find it remotely. + an IP rate limit (brute force).
const _spAttempts = new Map();
// Per-shop reset attempts (so a targeted attack cannot rotate IPs)
const _spShopAttempts = new Map();
// Clear both maps every hour — otherwise memory keeps growing slowly
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
    if (rec.count >= 5) return res.status(429).json({ error: 'Too many attempts — try again in 1 hour' });
    rec.count++; _spAttempts.set(ip, rec);

    const { shopId, phone, newPassword } = req.body;

    // An IP limit alone was not enough: an attacker could keep changing IPs and
    // hammer the same shop. So there is a PER-SHOP limit too — no matter
    // how many IPs it comes from, no more than 5 per shop per hour.
    if (shopId) {
      const sKey = String(shopId).trim().toUpperCase();
      const sRec = _spShopAttempts.get(sKey) || { count: 0, reset: now + 3600e3 };
      if (now > sRec.reset) { sRec.count = 0; sRec.reset = now + 3600e3; }
      if (sRec.count >= 5) {
        return res.status(429).json({ error: 'Too many attempts on this shop — try again in 1 hour' });
      }
      sRec.count++; _spShopAttempts.set(sKey, sRec);
    }
    if (!shopId || !phone || !newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'Shop ID, registered mobile and a 4+ character password — all three are required' });
    }
    const r = await pool.query('SELECT id, phone, password_hash FROM shops WHERE id=$1', [shopId.trim().toUpperCase()]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop ID not found' });
    // Whether a password is set OR NOT — a registered phone match = reset allowed.
    // (When one was set it used to say contact the admin; now it is a self-serve reset.
    //  Security is the same: the phone is removed from the public API + an IP rate limit.)
    if (normPhone(phone) !== normPhone(r.rows[0].phone)) {
      return res.status(403).json({ error: 'The mobile number does not match — enter the number used at registration' });
    }
    const passwordHash = await hashPassword(newPassword);
    await pool.query('UPDATE shops SET password_hash=$1 WHERE id=$2', [passwordHash, shopId.trim().toUpperCase()]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Demo status — the agent asks once every 30 min (a light payload)
app.get('/api/shop/:shopId/demo-status', async (req, res) => {
  try {
    // secondsLeft is sent by the SERVER (counted in SQL). The client never has to
    // parse a date, so even if its PC/phone timezone is wrong
    // the countdown stays correct.
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
    if (!r.rows.length) {
      // A demo the super admin removed. Saying "not found" makes it look
      // broken; the customer should simply know the demo is gone.
      const wasDemo = /^DEMO_/i.test(String(req.params.shopId || ''));
      return res.status(404).json({
        error: wasDemo ? 'This demo account has been deleted.' : 'Shop not found',
        demoDeleted: wasDemo
      });
    }
    if (!r.rows[0].setup_paid) {
      return res.status(403).json({ error: 'The shop setup is not complete yet. The shop owner must complete the setup fee payment.' });
    }
    const shopInfo = r.rows[0];
    // For customers, advance is ON only when it was bought (unlocked) AND the owner kept it active
    const advOn = !!(shopInfo.advanced_unlocked && shopInfo.advanced_active !== false);
    shopInfo.advanced_unlocked = advOn;
    // Each module's effective status = advance ON and that module's switch ON.
    // The customer page builds its layout from these 4 flags.
    shopInfo.adv_mini_active   = advOn && shopInfo.adv_mini_active   !== false;
    shopInfo.adv_legal_active  = advOn && shopInfo.adv_legal_active  !== false;
    shopInfo.adv_resume_active = advOn && shopInfo.adv_resume_active !== false;
    shopInfo.adv_4x6_active    = advOn && shopInfo.adv_4x6_active    !== false;
    shopInfo.adv_a3_active     = advOn && shopInfo.adv_a3_active     !== false;

    // ── Smart Scanner ──
    // The other 5 modules run on `advanced_unlocked` + their own switch,
    // but the Scanner is an ADD-ON — its truth lives in `owned_features`.
    // So asking ownedFeatureIds() here is essential:
    //   • Premium                  → the whole catalog; the list is not even checked
    //   • An old ₹199 shop          → only the core pack, which has no scan → OFF
    //   • Paid ₹49 / granted by the superadmin → 'scan' in owned_features → ON
    // If advanced_active is OFF, everything is OFF — the same old rule.
    try {
      const _cat = await getAdvanceFeatures();
      // Two separate questions, and both answers must be yes:
      //   1. does the shop have it?  (bought, Premium, or granted by the superadmin)
      //   2. has the owner switched it on?  (a switch like the other 5 modules)
      shopInfo.adv_scan_active = advOn
        && shopOwnsFeature(shopInfo, 'scan', _cat)
        && shopInfo.adv_scan_active !== false;
    } catch (e) {
      // If the catalog cannot be read, the feature stays off — leaving it open would
      // give it for free to shops that never paid.
      shopInfo.adv_scan_active = false;
    }
    // Which feature it is does not concern the customer — send the flag, not the list
    delete shopInfo.owned_features;

    // For a white-label shop, the customer page shows the PARTNER's brand
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
    } catch(e) { /* if branding fails, the default stays */ }
    shopInfo.subscription_expired = !isSubscriptionActive(shopInfo);
    // A demo whose time is up. The customer used to learn this only after
    // choosing a file and trying to print.
    shopInfo.demo_expired = !!(shopInfo.demo && isDemoExpired(shopInfo));
    delete shopInfo.paid_until; // do not show the customer the exact date
    res.json(shopInfo);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Customer: thumbs up/down after printing (public, only once)
app.post('/api/jobs/:jobId/feedback', async (req, res) => {
  try {
    const v = req.body.up === true ? 1 : req.body.up === false ? -1 : 0;
    if (!v) return res.status(400).json({ error: 'up must be a boolean' });
    // Only a printed job, and only while feedback is still 0 (only once)
    const r = await pool.query(
      "UPDATE print_jobs SET feedback=$1 WHERE id=$2 AND status='printed' AND feedback=0 RETURNING id",
      [v, req.params.jobId]);
    res.json({ success: true, recorded: r.rows.length > 0 });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ⚠️ SECURITY: this endpoint used to be open WITHOUT LOGIN.
// The Shop ID is printed on the QR poster, so anyone could see any shop's
// total earnings, today's earnings and order count — a competitor could
// track a shop's earnings every day.
// Now login is required AND only your own shop's data is returned.
app.get('/api/shop/:shopId/stats', verifyToken, async (req, res) => {
  try {
    // You cannot get another shop's data by entering its ID (IDOR guard).
    // Only the shop in the token gets its figures.
    if (req.params.shopId !== req.shopId) {
      return res.status(403).json({ error: 'This shop does not belong to you' });
    }
    const today = new Date().toISOString().split('T')[0];
    // prev_* = yesterday's numbers. The dashboard uses them to show "+40% vs yesterday".
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

// The shop owner chooses the default language for their customers.
// An empty string = "nothing chosen" = customers see English.
// isKnownLang() uses hasOwnProperty, so names like 'constructor'
// cannot slip through here.
// ── WhatsApp To Print — register interest ──
// The homepage form sends only a 10-digit mobile number. It is stored
// safely here and the owner gets an email.
//
// A small in-memory cooldown keeps one IP from spamming repeatedly.
// It is cleared on server restart — that is fine; this is not security,
// it only guards against pressing the button twice by mistake.
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
    if (_waInterestSeen.size > 5000) _waInterestSeen.clear();   // so memory does not fill up

    const r = await pool.query(
      `INSERT INTO whatsapp_interest (phone) VALUES ($1)
       ON CONFLICT (phone) DO UPDATE SET hits = whatsapp_interest.hits + 1, last_at = NOW()
       RETURNING hits`, [phone]);
    const hits = r.rows.length ? r.rows[0].hits : 1;

    // Email — the same path the demo/new-shop alerts use.
    // Even if sending takes a while, the user does not have to wait.
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
          'Times  : ' + hits + (hits > 1 ? ' (registered before as well)' : '') + '\n' +
          'Total registered so far: ' + (total.rows[0]?.n ?? '?') + '\n\n' +
          'Came from the "WhatsApp To Print" section of the homepage.',
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
      return res.status(400).json({ error: 'This language is not available' });
    }
    // Only languages in I18N_LANGS are accepted (English and Manipuri); empty = English.
    await pool.query('UPDATE shops SET default_lang=$1 WHERE id=$2', [raw, req.shopId]);
    res.json({ ok: true, default_lang: raw });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/profile', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      // demo_expires_at used to be missing here — so the panel's demo
      // countdown was always empty (shop.demo_expires_at undefined).
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
    // The advanced-lock status FIRST — both the duplex and the 4x6/A3 blocks
    // use it (it used to be declared further down -> a TDZ crash on save)
    const unlockChk = await pool.query('SELECT advanced_unlocked FROM shops WHERE id=$1', [req.shopId]);
    const advUnlocked = unlockChk.rows.length && unlockChk.rows[0].advanced_unlocked;

    // ── Trying to CHANGE an advance-only setting? ──
    // These fields used to be SILENTLY skipped below. The owner pressed save,
    // the panel reloaded, and the duplex/printer value was gone —
    // they thought "saving does not work". So a clear error was
    // needed.
    //
    // ⚠️ But blocking on "the field is present" was WRONG. The panel sends the
    // WHOLE settings object on every save — including the current values of duplex
    // and the extra printers, even if the owner never touched them.
    // duplex_bw_enabled is a boolean with DB default `true` — so
    // every Starter shop always sends it. Result: a shop without Advance
    // could not even save its name, prices or payment keys.
    //
    // Now only what REALLY changes is blocked. A value that is already the same
    // is just an echo — it does no harm.
    //
    // The check runs BEFORE the UPDATE, on purpose: otherwise the name/prices would
    // be saved and the response would say error — the owner would have no idea
    // what was saved and what was not.
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
    // Copy-paste (especially on mobile) often leaves leading/trailing spaces or a newline —
    // Cashfree auth then fails silently for no visible
    // reason. So they are trimmed right here (except the __KEEP__ sentinel).
    const cashfree_app_id = typeof cashfreeAppIdRaw === 'string' ? cashfreeAppIdRaw.trim() : cashfreeAppIdRaw;
    const cashfree_secret_key = (typeof cashfreeSecretRaw === 'string' && cashfreeSecretRaw !== '__KEEP__')
      ? cashfreeSecretRaw.trim() : cashfreeSecretRaw;

    // Prices — not sent (or empty) keeps the old one; anything sent must be
    // above 0. Settings used to store any value, a zero included, and a zero
    // price made every online payment fail.
    const priceIn = v => (v === undefined || v === null || v === '') ? null : parsePrice(v);
    const priceBw = priceIn(price_bw), priceColor = priceIn(price_color);
    if (priceBw !== null ? !(priceBw > 0) : (price_bw !== undefined && price_bw !== null && price_bw !== ''))
      return res.status(400).json({ error: 'Enter a B&W price above ₹0' });
    if (priceColor !== null ? !(priceColor > 0) : (price_color !== undefined && price_color !== null && price_color !== ''))
      return res.status(400).json({ error: 'Enter a Color price above ₹0' });
    const printerIn = v => (typeof v === 'string') ? v.slice(0, 300) : null;

    // Email — old shops (that had no email) can fill it in here.
    // undefined = the field was not sent, so the old value stays as it is.
    let finalEmail;
    if (email !== undefined) {
      const e = String(email || '').trim().toLowerCase();
      if (e && !isValidEmail(e)) return res.status(400).json({ error: 'Enter a valid email' });
      finalEmail = e;
    }

    // ── PARTIAL UPDATE SUPPORT ──
    // The website sends the whole settings object, but the desktop panel sends only
    // the fields that changed (such as just the printer or just a price).
    // When payment_mode was missing, this used to assume 'both' and then
    // return "Online payment requires keys" — even though the
    // keys were already saved. Worse still: the 5 payment fields were UPDATEd
    // without COALESCE, so saving just the printer
    // WIPED the Razorpay keys.
    const curQ = await pool.query(
      `SELECT payment_mode, payment_gateway, razorpay_key_id, razorpay_key_secret,
              cashfree_app_id, cashfree_secret_key
         FROM shops WHERE id=$1`, [req.shopId]);
    const cur = curQ.rows[0] || {};

    // Does the request touch the payment settings at all?
    const touchingPayment =
      payment_mode !== undefined || payment_gateway !== undefined ||
      razorpay_key_id !== undefined || razorpay_key_secret !== undefined ||
      cashfree_app_id !== undefined || cashfree_secret_key !== undefined;

    const validPaymentModes = ['both', 'counter_only', 'online_only'];
    const finalPaymentMode = validPaymentModes.includes(payment_mode)
      ? payment_mode
      : (cur.payment_mode || 'both');          // not sent = keep the old value

    // For fields that were not sent, the old value is used
    const finalGatewayIn = payment_gateway !== undefined ? payment_gateway : (cur.payment_gateway || '');
    const finalRzpId     = razorpay_key_id  !== undefined ? razorpay_key_id  : (cur.razorpay_key_id || '');
    const finalCfId      = cashfree_app_id  !== undefined ? cashfree_app_id  : (cur.cashfree_app_id || '');

    const needsGateway = finalPaymentMode === 'both' || finalPaymentMode === 'online_only';

    // The __KEEP__ sentinel means "keep the old secret, do not change it"
    let finalRzpSecret = razorpay_key_secret;
    let finalCfSecret = cashfree_secret_key;
    if (razorpay_key_secret === '__KEEP__' || cashfree_secret_key === '__KEEP__') {
      const existing = await pool.query('SELECT razorpay_key_secret, cashfree_secret_key FROM shops WHERE id=$1', [req.shopId]);
      if (existing.rows.length) {
        if (razorpay_key_secret === '__KEEP__') finalRzpSecret = existing.rows[0].razorpay_key_secret;
        if (cashfree_secret_key === '__KEEP__') finalCfSecret = existing.rows[0].cashfree_secret_key;
      }
    }

    // Secret not sent = keep the old one (the panel sends only the printer)
    if (razorpay_key_secret === undefined) finalRzpSecret = cur.razorpay_key_secret || '';
    if (cashfree_secret_key === undefined) finalCfSecret = cur.cashfree_secret_key || '';

    // Check the gateway ONLY when the request changes the payment settings.
    // When only a printer/price is saved, this check must not run at all.
    if (touchingPayment && needsGateway) {
      const validRazorpay = finalGatewayIn === 'razorpay' && finalRzpId && finalRzpSecret;
      const validCashfree = finalGatewayIn === 'cashfree' && finalCfId && finalCfSecret;
      if (!validRazorpay && !validCashfree) {
        return res.status(400).json({ error: 'Online payment requires Razorpay or Cashfree details' });
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
      [name, address, phone, printer_model, priceBw, priceColor, finalPaymentMode,
       finalGateway, finalRzpId||'', finalRzpSecret||'', finalCfId||'', finalCfSecret||'',
       finalEmail === undefined ? null : finalEmail,
       printerIn(printer_name_bw), printerIn(printer_name_color),
       req.shopId]
    );

    const r = await pool.query('SELECT id,name,address,phone,email,printer_model,printer_name_bw,printer_name_color,price_bw,price_color,payment_mode,payment_gateway,razorpay_key_id,cashfree_app_id FROM shops WHERE id=$1', [req.shopId]);
    // Duplex mode separately (validated)
    if (advUnlocked && typeof req.body.duplex_mode === 'string' && ['','auto','manual'].includes(req.body.duplex_mode)) {
      await pool.query('UPDATE shops SET duplex_mode=$1 WHERE id=$2', [req.body.duplex_mode, req.shopId]);
    }
    if (advUnlocked) {
      if (typeof req.body.printer_name_4x6 === 'string')
        await pool.query('UPDATE shops SET printer_name_4x6=$1 WHERE id=$2', [req.body.printer_name_4x6.slice(0,300), req.shopId]);
      if (typeof req.body.printer_name_a3 === 'string')
        await pool.query('UPDATE shops SET printer_name_a3=$1 WHERE id=$2', [req.body.printer_name_a3.slice(0,300), req.shopId]);
      // Duplex's own printer. Empty = the old behaviour (the B&W/Color one).
      if (typeof req.body.printer_name_duplex === 'string')
        await pool.query('UPDATE shops SET printer_name_duplex=$1 WHERE id=$2', [req.body.printer_name_duplex.slice(0,300), req.shopId]);
      // In which modes duplex is enabled -- B&W and Color separately.
      // Field not sent = the old value stays as it is (safe for partial updates).
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
    // page_slabs cannot go through the price loop above — that passes every value
    // through parsePrice(), which expects a NUMBER. A slab is a JSON
    // TEXT, so there it silently became null and was dropped:
    // the owner pressed Save, nothing was saved, and after a reload
    // all the boxes were empty.
    if (req.body.page_slabs !== undefined) {
      let slabTxt = '';
      try {
        // Store it only after cleaning — garbage JSON would break the price calculation later
        const p = parseSlabs(req.body.page_slabs);
        slabTxt = (p.bw.length || p.color.length) ? JSON.stringify(p) : '';
      } catch (e) { slabTxt = ''; }
      await pool.query('UPDATE shops SET page_slabs=$1 WHERE id=$2', [slabTxt, req.shopId]);
    }

    // Duplex prices — stored only when a valid non-negative int arrives
    const pbwd = parsePrice(req.body.price_bw_duplex);
    const pcld = parsePrice(req.body.price_color_duplex);
    if (pbwd !== null) await pool.query('UPDATE shops SET price_bw_duplex=$1 WHERE id=$2', [pbwd, req.shopId]);
    if (pcld !== null) await pool.query('UPDATE shops SET price_color_duplex=$1 WHERE id=$2', [pcld, req.shopId]);

    // ==============================================================
    // SHOP OPEN/CLOSE + SUPPLY -- the Desktop Panel sends these here
    //
    // The website sends these two things to /api/shop/pause and /api/shop/supply-warning,
    // but the Desktop Panel (agent_panel.py) sends them together with the
    // SETTINGS. There was no handler for them here: the server returned
    // { success:true } but wrote NOTHING to the DB, and the
    // panel read the old value back on refresh -- so pressing the panel's
    // "Shop Open/Close" snapped straight back to where it was,
    // while the same action from the website worked fine.
    //
    // With this handler on the server, EVERY already-installed agent is fixed
    // immediately -- no shop needs a new .exe.
    if (req.body.paused !== undefined) {
      const isPaused = (req.body.paused === true || req.body.paused === 'true' ||
                        req.body.paused === 1 || req.body.paused === '1');
      await pool.query('UPDATE shops SET paused=$1 WHERE id=$2', [isPaused, req.shopId]);
    }
    if (req.body.supply_warning !== undefined) {
      // Accept both the panel's own vocabulary ('ok'|'ink'|'paper') and the DB's
      // (''|'low_ink'|'no_paper'). If an unknown value arrives, skip just this
      // field instead of failing the whole save.
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
      return res.status(400).json({ error: 'The new password must be at least 4 characters' });
    }
    const r = await pool.query('SELECT password_hash FROM shops WHERE id=$1', [req.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });


    if (!(await verifyPassword(currentPassword || '', r.rows[0].password_hash))) {
      return res.status(401).json({ error: 'The current password is wrong' });
    }

    const newHash = await hashPassword(newPassword);
    await pool.query('UPDATE shops SET password_hash=$1 WHERE id=$2', [newHash, req.shopId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── DESKTOP PANEL STATS ─────────────────────────────────────────
// The web dashboard calculates these numbers itself from /api/admin/jobs.
// To keep the desktop panel from re-implementing the same maths, the server
// provides a small summary — one query, a few bytes, no file.
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

/** All of the shop's data in one JSON file — the shop can download it itself. */
app.get('/api/admin/export-data', verifyToken, async (req, res) => {
  try {
    const id = req.shopId;
    const q = async (sql, p = [id]) => {
      try { return (await pool.query(sql, p)).rows; }
      catch (e) { return [{ _error: e.message }]; }   // if one table fails, the rest must not stop
    };

    const shopRows = await q('SELECT * FROM shops WHERE id=$1');
    const shop = shopRows[0] || {};
    // Secrets never go into the file
    for (const k of Object.keys(shop)) {
      const lk = k.toLowerCase();
      if (lk.endsWith('_secret') || lk.endsWith('secret_key') ||
          lk.endsWith('password_hash') || lk.endsWith('_token')) delete shop[k];
    }

    const data = {
      exportedAt: new Date().toISOString(),
      shopId: id,
      note: 'Echel — the complete data of your account. Please keep it safe.',
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
      `attachment; filename="Echel-${id}-${stamp}.json"`);
    res.send(JSON.stringify(data, null, 2));
    console.log(`Data export: ${id} (${jobs.length} jobs)`);
  } catch (err) {
    console.error('export-data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete the account PERMANENTLY. It cannot be restored.
 * Everything happens in one transaction — if it fails midway, nothing is deleted.
 */
app.delete('/api/admin/delete-account', verifyToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = req.shopId;

    // Typing "DELETE" is required — so an accidental click does nothing
    if (String((req.body && req.body.confirm) || '').trim().toUpperCase() !== 'DELETE') {
      return res.status(400).json({ error: 'Type DELETE to confirm' });
    }

    const shopRow = await client.query('SELECT id, name, phone FROM shops WHERE id=$1', [id]);
    if (!shopRow.rows.length) return res.status(404).json({ error: 'Shop not found' });
    const shop = shopRow.rows[0];

    // Remove the remaining Cloudinary files first — once the rows leave the DB there
    // is no way left to reach them.
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
    // The registration row is kept but its link to the shop is broken, so
    // that phone number can take a demo again.
    await client.query(
      "UPDATE demo_registrations SET shop_id=NULL WHERE shop_id=$1", [id]);
    const sh = await client.query('DELETE FROM shops WHERE id=$1', [id]);
    counts.shops = sh.rowCount;
    await client.query('COMMIT');

    // Remove the files only after the DB is clean
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
// DIRECT UPLOAD — Customer → Cloudinary (the file never touches Render)
//
// Old flow: Customer → Render → Cloudinary. For a 10 MB file Render had to
// receive 10 MB + send ~13 MB (base64 makes it 33% larger)
// = ~23 MB per file. Render's 5 GB was being burned on exactly this.
//
// New flow: Render only issues a signature (~200 bytes), the customer
// sends the file straight to Cloudinary, and then Render receives only the public_id
// (~300 bytes). ~99% of the bandwidth is saved.
//
// Security: an HMAC token goes along with the signature. On confirm the
// same token must match AND Cloudinary must confirm that the
// file really exists there — otherwise someone could send a fake public_id and
// create a job without a file.
// ══════════════════════════════════════════════════════════════
function uploadTokenFor(shopId, publicId) {
  return crypto.createHmac('sha256', JWT_SECRET)
    .update(`${shopId}|${publicId}`).digest('hex').slice(0, 32);
}

// ─── UPLOAD VALIDATION HELPERS ──────────────────────────────────────
// IMPORTANT: all these checks run BEFORE the Cloudinary upload
// (at /api/upload/sign). Without a signature the browser cannot even touch
// Cloudinary — so a rejection costs 0 bandwidth.

function checkSizeLimit(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;      // unknown — skip
  return n > MAX_UPLOAD_BYTES ? LIMIT_MSG.size : null;
}

function checkPageLimit(pages, fileName) {
  const n = parseInt(pages, 10);
  if (!Number.isInteger(n) || n <= 0) return null;     // unknown — skip
  // The page limit applies only to multi-page documents. A single photo = 1 page and
  // must never be blocked.
  if (n > MAX_PDF_PAGES) return LIMIT_MSG.pages;
  return null;
}

/**
 * How many sheets a job produces — pages x copies.
 * The server counts it the same way everywhere (finalPages x effCopies), and
 * customer.html's getSlabPageCount() does exactly the same. All three must stay
 * identical, otherwise the customer sees one thing and gets another.
 */
function checkSheetLimit(pages, copies) {
  const p = parseInt(pages, 10), c = parseInt(copies, 10);
  if (!Number.isInteger(p) || p <= 0) return null;     // unknown — skip
  if (!Number.isInteger(c) || c <= 0) return null;
  return (p * c) > MAX_JOB_SHEETS ? LIMIT_MSG.sheets : null;
}

/**
 * Is the same customer sending prints again and again, very quickly?
 *
 * This is SEPARATE from the SHOP-level checkUploadAbuse(), and deliberately so:
 * that one blocks the shop. If it were used to stop customers, one bad actor
 * could shut down the whole shop — and that has happened
 * ("3 prints, 16 blocks"). Here the block applies ONLY to that customer;
 * the shop and the other customers keep working.
 *
 * Identified in two ways:
 *   cid — the device id stored in the browser. Reliable, but new in incognito.
 *   ip  — a broad net, so the limit is VERY generous. On a cyber cafe's WiFi
 *         all customers share one IP; a strict limit would stop
 *         honest people.
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

  // First check whether it is already blocked — increase the count only when
  // the person is really getting in.
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
 * The customer's complete gate — both guards in one place.
 *
 * At the start of every upload: `if (!(await customerGuard(req, res, shopId))) return;`
 *
 *   1. PERMANENT ban — set by the superadmin, stored in the DB, never lifts by itself
 *   2. too fast       — applied automatically, lifts by itself after 15 minutes
 *
 * In both cases the block applies ONLY to that customer. The shop keeps working.
 */
async function customerGuard(req, res, shopId) {
  const cid = customerId(req);
  const ip  = clientIp(req);

  if (await isCustomerBanned(cid)) {
    await logSecurityEvent({ ip, shopId, endpoint: req.path, method: req.method,
      action: 'PDF_UPLOAD', reason: 'CUSTOMER_BANNED',
      userAgent: req.headers['user-agent'] });
    res.status(403).json({
      error: 'Printing from this device has been disabled. Please talk to the shop owner.',
      customerBanned: true });
    return false;
  }

  const r = checkCustomerAbuse(shopId, cid, ip);
  if (!r.ok) {
    await logSecurityEvent({ ip, shopId, endpoint: req.path, method: req.method,
      action: 'PDF_UPLOAD', reason: r.reason,
      userAgent: req.headers['user-agent'] });
    res.status(429).json({
      error: 'You are sending prints too quickly. Try again in ' + r.mins
           + ' minutes.',
      customerBlocked: true });
    return false;
  }
  return true;
}

/** The customer's device id — from the header or the body, sanitized. */
function customerId(req) {
  const raw = req.headers['x-customer-id']
           || (req.body && (req.body.customerId || req.body.cid)) || '';
  return String(raw).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
}

const SHA256_RE = /^[a-f0-9]{64}$/i;

/**
 * Is the file really what its name claims? Do not trust the extension
 * alone — an attacker can name an .exe as .pdf.
 * The buffer is only available where the file passes through the server (fallback path).
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

/** The real page count inside the PDF — the number sent by the client is not trusted. */
function countPdfPages(buffer) {
  try {
    const txt = buffer.toString('latin1');
    let n = (txt.match(/\/Type\s*\/Page[^s]/g) || []).length;
    if (!n) {
      const counts = [...txt.matchAll(/\/Count\s+(\d+)/g)].map(m => parseInt(m[1], 10));
      if (counts.length) n = Math.max(...counts);
    }
    return n > 0 ? n : null;    // if it cannot be parsed, null — do not block
  } catch (e) { return null; }
}

/** Extension + magic bytes + (for a PDF) the real page count. */
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
 * Duplicate upload guard. The same file (same SHA-256) cannot be uploaded
 * to the same shop more than DUP_UPLOAD_LIMIT times within DUP_UPLOAD_WINDOW_MIN
 * minutes.
 * @param {boolean} commit  false = only check (at sign),
 *                          true  = increase the count (at confirm)
 */
async function checkDuplicateUpload(shopId, fileHash, commit) {
  if (!fileHash || !SHA256_RE.test(String(fileHash))) return null;  // no hash — skip
  const hash = String(fileHash).toLowerCase();
  try {
    // Treat a record outside the window as old and reset it
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
    // If the guard fails, do NOT block a genuine customer — just log it.
    console.warn('Duplicate-check skipped:', e.message);
    return null;
  }
}

app.post('/api/upload/sign', async (req, res) => {
  try {
    const shopId = String(req.body.shopId || '').trim();
    if (!shopId) return res.status(400).json({ error: 'Shop ID required' });
    if (!CLOUD_NAME || !CLD_API_KEY || !CLD_API_SECRET) {
      return res.status(500).json({ error: 'Cloudinary is not configured' });
    }
    const s = await pool.query('SELECT id FROM shops WHERE id=$1', [shopId]);
    if (!s.rows.length) return res.status(404).json({ error: 'Shop not found' });

    // ── GLOBAL EMERGENCY BRAKE ──
    // Has the upload rate across the whole server exploded (loop/bug/attack)? Temporarily
    // stop new uploads — no call goes to Cloudinary at all.
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

    // ── The CUSTOMER's own guard ──
    // checkUploadAbuse above looks at the SHOP. This one looks at the PERSON
    // who scans the QR and submits prints. The block applies only to them
    // — the shop and the other customers keep working.
    if (!(await customerGuard(req, res, shopId))) return;

    // If the demo shop's limit is already used up, do not even let the upload start —
    // stopping it up front is better than telling the customer "limit over" later.
    const allowDemo = await checkDemoAllowance(shopId);
    if (!allowDemo.ok) {
      return res.status(403).json({
        error: allowDemo.error, demoLimitReached: true,
        reason: allowDemo.reason, used: allowDemo.used, limit: allowDemo.limit,
        plans: await getUpgradePlans()
      });
    }

    // ── GUARDRAILS: BEFORE issuing the signature. If rejected, the browser
    //    never reaches Cloudinary = zero wasted bandwidth. ──
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

// Confirm with Cloudinary that the file really exists (and get its real URL)
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
          if (resp.statusCode !== 200) return reject(new Error(j?.error?.message || 'The file was not found on Cloudinary'));
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
    // On a raw upload Cloudinary appends the extension to the public_id
    // (qrprint_abc -> qrprint_abc.pdf). So two different values arrive:
    //   signedPublicId = what we signed (the token was built from it)
    //   publicId       = what Cloudinary returned (the lookup uses it)
    const publicId = String(b.publicId || '').trim();
    const signedPublicId = String(b.signedPublicId || b.publicId || '').trim();
    const token = String(b.uploadToken || '').trim();
    if (!shopId || !isJobAsset(publicId) || !isJobAsset(signedPublicId)) return res.status(400).json({ error: 'A valid shop and Echel upload are required.' });

    // 1) Token match — did we issue this public_id for this shop?
    if (token !== uploadTokenFor(shopId, signedPublicId)) {
      return res.status(403).json({ error: 'The upload token does not match' });
    }
    // 2) Cloudinary's public_id must be the one we signed
    //    (only an extension may be appended) — otherwise it could point to another file
    if (publicId !== signedPublicId && !publicId.startsWith(signedPublicId + '.')) {
      return res.status(403).json({ error: 'The public ID does not match' });
    }

    const shopResult = await pool.query('SELECT * FROM shops WHERE id=$1', [shopId]);
    if (!shopResult.rows.length) return res.status(404).json({ error: 'Shop not found' });
    // ── The CUSTOMER guard — MOST IMPORTANT HERE ──
    // The job is created on this route. The guard used to be only on /api/upload/sign and
    // /api/upload, and this path was left open — a person could still create
    // a job after being blocked. Now all three doors have the same
    // guard.
    if (!(await customerGuard(req, res, shopId))) return;

    const shop = shopResult.rows[0];

    // 3) The file URL.
    //    Security has already been handled: the HMAC token proves that WE
    //    issued this public_id for this shop, and the public_id prefix has also
    //    matched. So asking Cloudinary is NOT REQUIRED to build the URL —
    //    and that same Admin API call was returning 500.
    //
    //    Approach: take the URL from the client but validate it cryptographically; if it
    //    is missing, build it ourselves (the raw upload URL format is fixed). Verifying
    //    with Cloudinary is only "best effort" — even if it fails the job is created (if
    //    the file really does not exist, the agent download will reveal it and the job will fail).
    let fileUrl = String(b.secureUrl || '').trim();
    let cldInfo = null;
    const okHost = fileUrl.startsWith(`https://res.cloudinary.com/${CLOUD_NAME}/`);
    if (!fileUrl || !okHost || !fileUrl.includes(signedPublicId)) {
      // An old client or a wrong URL — build it ourselves (deterministic)
      fileUrl = `https://res.cloudinary.com/${CLOUD_NAME}/raw/upload/${publicId}`;
    }

    try {
      cldInfo = await cloudinaryResourceInfo(publicId);
      if (cldInfo && (cldInfo.secure_url || cldInfo.url)) fileUrl = cldInfo.secure_url || cldInfo.url;
    } catch (e) {
      console.warn(`Cloudinary verify skipped (${e.message}) — built the URL ourselves: ${publicId}`);
    }

    // ── GUARDRAILS (again, now with the real data) ──
    // The client can lie, so Cloudinary's actual byte count is
    // final. If a limit is exceeded, delete the file again.
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
    // Increase the duplicate counter only now that the upload really happened.
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
    console.log(`Direct upload confirmed: ${jobId} (${(cldInfo && cldInfo.bytes) || '?'} bytes, did not pass through Render)`);
    res.json({ success: true, jobId, fileName, fileType, amount,
      copies: numCopies, totalPages: numPages, colorMode });
  } catch(err) {
    console.error('Upload confirm error:', err.message);
    // The mistake was ours — the customer's retry must not get the shop blocked
    pardonUploadFailure(req.body && req.body.shopId);
    res.status(500).json({ error: err.message });
  }
});

// ── The old upload (fallback) — keeps things working if the direct upload fails ──
app.post('/api/upload', upload.single('file'), handleUploadErrors, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error:'No file uploaded' });
    const { shopId, copies, colorMode, totalPages } = req.body;
    if (!shopId) return res.status(400).json({ error:'Shop ID required' });

    const shopResult = await pool.query('SELECT * FROM shops WHERE id=$1', [shopId]);
    if (!shopResult.rows.length) return res.status(404).json({ error:'Shop not found' });
    const shop = shopResult.rows[0];

    // ── GUARDRAILS (fallback path) — BEFORE the Cloudinary upload ──
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

    // Is the file really a PDF/image? Magic bytes + real page count check —
    // here the file is on the server, so there is no need to trust the client.
    const fv = validateFileBuffer(req.file.buffer, req.file.originalname);
    if (!fv.ok) {
      await logSecurityEvent({ ip: clientIp(req), shopId, endpoint: '/api/upload', method: 'POST',
        action: 'PDF_UPLOAD', reason: 'FILE_VALIDATION:' + (fv.mismatch || fv.realPages || 'bad'),
        fileSize: req.file.size, userAgent: req.headers['user-agent'] });
      return res.status(415).json({ error: fv.error });
    }

    // multer already applied the size limit, but give an exact message here.
    const sizeErr = checkSizeLimit(req.file.size);
    if (sizeErr) return res.status(413).json({ error: sizeErr });

    if (!(await customerGuard(req, res, shopId))) return;

    const pageErr = checkPageLimit(totalPages, req.file.originalname);
    if (pageErr) return res.status(413).json({ error: pageErr });

    // On this path the file is on the server — build the hash right here; no
    // need to trust the client.
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
    // The mistake was ours — the customer's retry must not get the shop blocked
    pardonUploadFailure(req.body && req.body.shopId);
    res.status(500).json({ error: err.message });
  }
});

function parseSelectedPages(selectedPages, fallbackCount) {
  if (Array.isArray(selectedPages) && selectedPages.length) {
    const list = selectedPages.map(p => parseInt(p, 10)).filter(p => Number.isInteger(p) && p >= 1);
    if (list.length) return list;
  }
  return Array.from({length: Math.max(1, parseInt(fallbackCount, 10) || 1)}, (_, i) => i + 1);
}

/** A print that is paid already, or whose upload expired, cannot be priced again. */
function paidOrExpired(job) {
  if (job.payment_status === 'paid') return { status: 409, error: 'This print is already paid.' };
  if (job.status === 'abandoned') return { status: 410, error: 'This upload has expired. Please upload the file again.' };
  return null;
}

// ═══════════════════════════════════════════════════════════════════
//  CASHFREE HELPERS
// ═══════════════════════════════════════════════════════════════════

// LIVE only — no sandbox. For testing, the Cashfree dashboard's
// test keys will not work; live keys must be used.
const CASHFREE_HOST = 'api.cashfree.com';
const CASHFREE_API_VERSION = '2025-01-01';

// Never throws — always returns an object (the same pattern as sendViaBrevo)
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
          catch (e) { resolve({ message: 'Could not understand the Cashfree response (HTTP ' + resp.statusCode + ')' }); }
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
// The RAW body is required — a signature will NEVER match a JSON.parse'd object.
function verifyCashfreeWebhook(secretKey, timestamp, rawBody, signature) {
  try {
    if (!secretKey || !timestamp || !signature) return false;
    const expected = crypto.createHmac('sha256', secretKey)
      .update(String(timestamp) + String(rawBody)).digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    // timingSafeEqual requires equal lengths — otherwise it throws
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

// ─── ONLINE PAYMENT: every shop uses its own Razorpay/Cashfree keys ───
// (The money goes straight to the shop owner's account, not the platform owner's account)

app.post('/api/payment/online/create', async (req, res) => {
  try {
    const { jobId, colorMode, copies, selectedPages } = req.body;

    const jobCheck = await pool.query(
      `SELECT j.*, s.price_bw, s.price_color, s.price_bw_duplex, s.price_color_duplex, s.price_4x6_4, s.price_4x6_6, s.price_4x6_8, s.price_4x6_10, s.price_4x6_12, s.page_slabs, s.price_resume_color, s.price_resume_bw, ${BIG_SIZE_PRICE_SELECT}, s.payment_mode, s.payment_gateway, s.paused, s.plan_type, s.billing_cycle, s.paid_until,
              s.razorpay_key_id, s.razorpay_key_secret,
              s.cashfree_app_id, s.cashfree_secret_key
       FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1`, [jobId]
    );
    if (!jobCheck.rows.length) return res.status(404).json({ error:'Job not found' });
    if (jobCheck.rows[0].paused) return res.status(403).json({ error: '🏪 The shop is closed right now — try again later' });
    if (!isSubscriptionActive(jobCheck.rows[0])) return res.status(403).json({ error: '⏸️ The shop is inactive — the owner needs to renew the subscription' });

    const job = jobCheck.rows[0];
    const _closed = paidOrExpired(job);
    if (_closed) return res.status(_closed.status).json({ error: _closed.error });

    // Demo limit — BEFORE the payment STARTS. Stopping it at the webhook would be
    // wrong: the money would be debited and no print would come out.
    const allowOnline = await checkDemoAllowance(job.shop_id);
    if (!allowOnline.ok) {
      return res.status(403).json({
        error: allowOnline.error, demoLimitReached: true,
        reason: allowOnline.reason, used: allowOnline.used, limit: allowOnline.limit,
        plans: await getUpgradePlans()
      });
    }

    if (job.payment_mode === 'counter_only') {
      return res.status(400).json({ error: 'This shop accepts Counter payment only' });
    }
    if (!job.payment_gateway) {
      return res.status(400).json({ error: 'This shop has not set up online payment yet' });
    }

    const finalColorMode = (colorMode || job.color_mode) === 'color' ? 'color' : 'bw';
    // ── DUPLEX ── only when the shop has enabled it; with manual duplex
    // copies are forced to 1 (otherwise the owner would have to put up with a
    // front/back popup for every copy and the pages would get mixed up)
    let finalDuplex = false;
    let dupShop = await pool.query(
      'SELECT duplex_mode, duplex_bw_enabled, duplex_color_enabled FROM shops WHERE id=$1',
      [job.shop_id]);
    const shopDuplexMode = dupShop.rows.length ? (dupShop.rows[0].duplex_mode || '') : '';
    // The owner can keep duplex on for B&W only or Color only
    // (duplex is often on just one printer). If the column is NULL -- meaning
    // an old row the migration has not touched yet -- treat it as ON,
    // so the duplex of a working shop is not silently switched off.
    const dupRow    = dupShop.rows[0] || {};
    const dupBwOk   = dupRow.duplex_bw_enabled !== false;
    const dupClOk   = dupRow.duplex_color_enabled !== false;
    const dupModeOk = finalColorMode === 'color' ? dupClOk : dupBwOk;
    if (req.body.duplex === true && shopDuplexMode && dupModeOk) finalDuplex = true;
    // Copies: a whole number from 1 up (-5 used to make a negative bill).
    const finalCopies = Math.max(1, parseInt(copies, 10) || parseInt(job.copies, 10) || 1);
    // The bill is made from the SAME page list the agent prints from. It used
    // to come from a page count sent by the browser, so "1 page" could be
    // paid while every page of a 50-page file went to the printer.
    const finalSelectedPages = parseSelectedPages(selectedPages, job.total_pages);
    const finalPages = finalSelectedPages.length;
    // With manual duplex, copies are ALWAYS 1 — for the print and for the BILL (otherwise
    // the customer would pay for N copies and get 1 print)
    const effCopies = (finalDuplex && shopDuplexMode === 'manual') ? 1 : finalCopies;

    // The cap on total sheets. It lives here because the copies are known only HERE —
    // at upload time the customer has not chosen copies yet.
    const _sheetErr = checkSheetLimit(finalPages, effCopies);
    if (_sheetErr) return res.status(400).json({ error: _sheetErr, sheetLimit: true });
    // Duplex prices: if the owner has set them (>0), use them; otherwise the normal
    // rate applies (backwards compatible + setting 0 by accident is safe)
    const _dupBw     = finalDuplex && parseFloat(job.price_bw_duplex) > 0;
    const _dupColor  = finalDuplex && parseFloat(job.price_color_duplex) > 0;
    const _rateBw    = _dupBw    ? job.price_bw_duplex    : job.price_bw;
    const _rateColor = _dupColor ? job.price_color_duplex : job.price_color;
    const pricePerPage = finalColorMode === 'color' ? _rateColor : _rateBw;
    // Whether the duplex rate really applied - the slab does not override it
    const _dupRateUsed = finalColorMode === 'color' ? _dupColor : _dupBw;

    // -- PAGE-RANGE (SLAB) RATE --
    // The owner can set "from this many pages to this many = this much". That price is
    // the rate for EACH PAGE, not for the whole job:
    //     8 pages and the 6-10 range rate is 1.5  =>  8 x 1.5 = 12
    //
    // It used to be treated as a flat price for the whole job - which is why 4
    // pages and 8 pages produced the same bill. A customer caught exactly this:
    // "printing 8 costs Rs 50 and printing 4 also costs Rs 50."
    //
    // The owner's own special rates rank ABOVE the slab: the duplex rate is
    // checked right here, and Resume / 4x6 / A3 overwrite the amount in their own
    // branches below. customer.html's getPerPageRate() follows exactly the same
    // order - both calculations must stay identical, otherwise
    // the customer sees one amount and is charged another.
    let ratePerPage = pricePerPage;
    if (!_dupRateUsed) {
      // Count = how many SHEETS come out (pages x copies). 3 copies of
      // 3 pages = 9 sheets, so the 6-10 range applies. customer.html's
      // getSlabPageCount() computes exactly the same count.
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
      // 12 is placed at the VERY TOP. It used to have no branch at all,
      // so a 12-photo job fell into the last fallback (the 4-photo rate) —
      // the customer got 12 photos for the price of 4.
      const pRate = job.photo_count === 12 ? (parseFloat(job.price_4x6_12) || 0)
                 : job.photo_count === 10 ? (parseFloat(job.price_4x6_10) || 0)
                 : job.photo_count === 8 ? (parseFloat(job.price_4x6_8) || 0)
                 : job.photo_count === 6 ? (parseFloat(job.price_4x6_6) || 0)
                 : (parseFloat(job.price_4x6_4) || 0);
      if (pRate > 0) amount = pRate * effCopies;
    } else {
      // Big Size (A3/A2/A1) — the owner's own per-page rate, only when set.
      // Even with duplex the big-size rate wins: the large paper
      // is the real cost, and duplex is included in it.
      const bigRate = bigSizeRate(job, job.paper_size, finalColorMode);
      if (bigRate > 0) amount = bigRate * finalPages * effCopies;
    }
    amount = round2(amount);

    // Common job update (before the gateway)
    await pool.query(
      'UPDATE print_jobs SET color_mode=$1, copies=$2, total_pages=$3, selected_pages=$4, amount=$5, duplex=$6 WHERE id=$7',
      [finalColorMode, effCopies, finalPages, finalSelectedPages.join(','), amount, finalDuplex, jobId]
    );

    if (job.payment_gateway === 'razorpay') {
      if (!job.razorpay_key_id || !job.razorpay_key_secret) {
        return res.status(400).json({ error: 'The Razorpay keys of the shop are not set' });
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
        // Razorpay sends the real reason in `error.description`. The whole
        // object used to go into `details`, which the client concatenated into a
        // string — so the screen showed only "[object Object]"
        // and the shop owner never learned what was wrong
        // (usually: after regenerating the key, the old secret remained
        // saved → "Authentication failed").
        const rzErr = (razorpayOrder && razorpayOrder.error) || {};
        const why = rzErr.description || rzErr.reason || rzErr.code ||
                    'Razorpay did not create the order';
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
        return res.status(400).json({ error: 'The Cashfree keys of the shop are not set' });
      }

      // DEBUG log — the Render logs show that the create call happened and what was created
      console.log('[Cashfree] create attempt job=' + jobId + ' shop=' + job.shop_id + ' amount=' + amount + ' appid_len=' + String(job.cashfree_app_id).length);

      // ⚠️ THE MOST IMPORTANT DIFFERENCE: Razorpay takes PAISE (₹10 = 1000),
      // Cashfree takes RUPEES (₹10 = 10). Never multiply by 100 here —
      // otherwise the customer is charged 100 times the amount.
      // ⚠️ The Cashfree order_id must be GLOBALLY UNIQUE — sending the same id
      // again returns "order with same id is already present".
      // It used to be a fixed 'QSP_'+jobId, so when the customer pressed "Pay" AGAIN
      // (retry / page reload / abandon) the same id went out and Cashfree rejected
      // it (Razorpay has no such problem because there jobId is only the
      // receipt; Razorpay makes the order id unique itself). Now every attempt
      // gets a fresh unique id. The webhook and status both find the job by the STORED
      // payment_id (not by the order_id format), so nothing else needs to
      // change. Length ~31 chars (Cashfree limit 50), only A-Z 0-9 _.
      const cfOrderId = 'QSP_' + jobId + '_' + Date.now().toString(36).toUpperCase()
        + crypto.randomBytes(4).toString('hex').toUpperCase();
      // Cashfree absolutely requires customer_phone, but we never collect the customer's
      // number (scan the QR and print directly — no login).
      // Hence a placeholder. It has no effect on the payment.
      const customerPhone = '9999999999';

      const cfBody = JSON.stringify({
        order_id: cfOrderId,
        order_amount: Number(amount),          // rupees, NOT paise
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
          error: 'Could not create the Cashfree order — check the keys of the shop',
          details: (cfOrder && (cfOrder.message || cfOrder.type || cfOrder.code)) || 'unknown'
        });
      }

      console.log('[Cashfree] order OK job=' + jobId + ' cfid=' + cfOrderId + ' session=' + String(cfOrder.payment_session_id).slice(0, 22) + '...');

      // We save OUR order_id, not cf_order_id — the webhook and
      // status both find the job by it
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

// Razorpay verify — signature check from the frontend
app.post('/api/payment/razorpay/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, jobId } = req.body;

    const jobCheck = await pool.query(
      `SELECT j.razorpay_order_id, j.payment_status, j.amount,
              s.razorpay_key_id, s.razorpay_key_secret
         FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1`, [jobId]
    );
    if (!jobCheck.rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = jobCheck.rows[0];
    const keySecret = job.razorpay_key_secret;

    const expectedSignature = crypto
      .createHmac('sha256', keySecret || '')
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (!keySecret || expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    // The signature proves that Razorpay took the money — not WHICH print it
    // paid for. Every order of a shop is signed with the same secret, so the
    // receipt of a Rs 2 print could mark a Rs 500 print paid. The order has
    // to be this print's own. An older order of the same print (a second
    // checkout window) counts only when Razorpay says it is paid in full.
    if (razorpay_order_id !== job.razorpay_order_id) {
      let ok = false;
      try {
        const order = await razorpayOrderStatus(razorpay_order_id, job.razorpay_key_id, keySecret);
        ok = !!(order && order.receipt === jobId && order.status === 'paid'
                && Number(order.amount_paid) >= Math.round(Number(job.amount) * 100));
      } catch (e) { ok = false; }
      if (!ok) return res.status(400).json({ error: 'This payment does not belong to this print.' });
    }

    // Once only: the same receipt sent again cannot put a print back in the
    // queue.
    const upd = await pool.query(
      `UPDATE print_jobs SET payment_status='paid', payment_id=$1,
              status = CASE WHEN status='pending' THEN 'queued' ELSE status END
        WHERE id=$2 AND payment_status <> 'paid'
        RETURNING shop_id`,
      [razorpay_payment_id, jobId]
    );
    if (upd.rows.length) markShopHasWork(upd.rows[0].shop_id);

    console.log(`Razorpay payment verified: ${jobId} | ${razorpay_payment_id}`);
    res.json({ success: true });
  } catch(err) {
    console.error('Razorpay verify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cashfree webhook — Cashfree calls here when a payment happens.
// The signature is verified over the RAW body (the req.rawBody from line 62).
app.post('/api/payment/cashfree/webhook', async (req, res) => {
  try {
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    if (!rawBody) return res.status(400).json({ error: 'empty body' });

    let payload = {};
    try { payload = JSON.parse(rawBody); } catch (e) {
      return res.status(400).json({ error: 'bad json' });
    }

    const orderId = (payload.data && payload.data.order && payload.data.order.order_id) || '';
    if (!orderId) return res.json({ success: true });   // some other event — ignore

    // Multi-tenant: every shop has its own key. So first find the shop from the
    // order; only then do we have the secret to check the signature with.
    // The body is read only to extract the order_id — nothing is changed
    // before VERIFY.
    const jr = await pool.query(
      `SELECT j.id AS job_id, j.payment_status, s.cashfree_secret_key
       FROM print_jobs j JOIN shops s ON j.shop_id = s.id
       WHERE j.payment_id = $1`, [orderId]);
    if (!jr.rows.length) return res.json({ success: true });
    const job = jr.rows[0];

    // Replay guard: webhooks older than 5 minutes are rejected
    const wts = parseInt(req.headers['x-webhook-timestamp'], 10);
    if (!wts || Math.abs(Date.now() / 1000 - wts) > 300) {
      console.warn('Cashfree webhook: old/invalid timestamp |', orderId);
      return res.status(401).json({ error: 'stale timestamp' });
    }

    const sigOk = verifyCashfreeWebhook(
      job.cashfree_secret_key,
      req.headers['x-webhook-timestamp'],
      rawBody,
      req.headers['x-webhook-signature']
    );
    if (!sigOk) {
      console.warn('Cashfree webhook: signature mismatch |', orderId);
      return res.status(401).json({ error: 'bad signature' });
    }

    const payStatus = (payload.data && payload.data.payment && payload.data.payment.payment_status) || '';
    if (payStatus === 'SUCCESS') {
      // payment_id is not touched — it is our stable lookup key
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

// Status check after returning from Cashfree (for frontend polling).
// Whether the webhook arrives late or never, the customer does not get stuck.
app.get('/api/payment/cashfree/status/:jobId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT j.payment_id, j.payment_status, s.cashfree_app_id, s.cashfree_secret_key
       FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1`,
      [req.params.jobId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = r.rows[0];

    // If the webhook arrived first, the DB already says paid — report that directly
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
    const { jobId, colorMode, copies, selectedPages } = req.body;
    if (!jobId) return res.status(400).json({ error:'Job ID required' });

    const jobCheck = await pool.query(
      `SELECT j.*, s.price_bw, s.price_color, s.price_bw_duplex, s.price_color_duplex, s.price_4x6_4, s.price_4x6_6, s.price_4x6_8, s.price_4x6_10, s.price_4x6_12, s.page_slabs, s.price_resume_color, s.price_resume_bw, ${BIG_SIZE_PRICE_SELECT}, s.payment_mode, s.paused, s.plan_type, s.billing_cycle, s.paid_until FROM print_jobs j JOIN shops s ON j.shop_id=s.id WHERE j.id=$1`, [jobId]
    );
    if (!jobCheck.rows.length) return res.status(404).json({ error:'Job not found' });

    const job = jobCheck.rows[0];
    const _closed = paidOrExpired(job);
    if (_closed) return res.status(_closed.status).json({ error: _closed.error });
    if (job.paused) return res.status(403).json({ error: '🏪 The shop is closed right now — try again later' });
    if (!isSubscriptionActive(job)) return res.status(403).json({ error: '⏸️ The shop is inactive — the owner needs to renew the subscription' });

    // Demo guards: expiry + free-print cap (both from one helper)
    const allow = await checkDemoAllowance(job.shop_id);
    if (!allow.ok) {
      return res.status(403).json({
        error: allow.error, demoLimitReached: true,
        reason: allow.reason, used: allow.used, limit: allow.limit,
        plans: await getUpgradePlans()
      });
    }

    if (job.payment_mode === 'online_only') {
      return res.status(400).json({ error: 'This shop accepts Online payment only' });
    }

    const finalColorMode = (colorMode || job.color_mode) === 'color' ? 'color' : 'bw';
    // ── DUPLEX ── only when the shop has enabled it; with manual duplex
    // copies are forced to 1 (otherwise the owner would have to put up with a
    // front/back popup for every copy and the pages would get mixed up)
    let finalDuplex = false;
    let dupShop = await pool.query(
      'SELECT duplex_mode, duplex_bw_enabled, duplex_color_enabled FROM shops WHERE id=$1',
      [job.shop_id]);
    const shopDuplexMode = dupShop.rows.length ? (dupShop.rows[0].duplex_mode || '') : '';
    // The owner can keep duplex on for B&W only or Color only
    // (duplex is often on just one printer). If the column is NULL -- meaning
    // an old row the migration has not touched yet -- treat it as ON,
    // so the duplex of a working shop is not silently switched off.
    const dupRow    = dupShop.rows[0] || {};
    const dupBwOk   = dupRow.duplex_bw_enabled !== false;
    const dupClOk   = dupRow.duplex_color_enabled !== false;
    const dupModeOk = finalColorMode === 'color' ? dupClOk : dupBwOk;
    if (req.body.duplex === true && shopDuplexMode && dupModeOk) finalDuplex = true;
    // Copies: a whole number from 1 up (-5 used to make a negative bill).
    const finalCopies = Math.max(1, parseInt(copies, 10) || parseInt(job.copies, 10) || 1);
    // The bill is made from the SAME page list the agent prints from. It used
    // to come from a page count sent by the browser, so "1 page" could be
    // paid while every page of a 50-page file went to the printer.
    const finalSelectedPages = parseSelectedPages(selectedPages, job.total_pages);
    const finalPages = finalSelectedPages.length;
    // With manual duplex, copies are ALWAYS 1 — for the print and for the BILL (otherwise
    // the customer would pay for N copies and get 1 print)
    const effCopies = (finalDuplex && shopDuplexMode === 'manual') ? 1 : finalCopies;

    // The cap on total sheets. It lives here because the copies are known only HERE —
    // at upload time the customer has not chosen copies yet.
    const _sheetErr = checkSheetLimit(finalPages, effCopies);
    if (_sheetErr) return res.status(400).json({ error: _sheetErr, sheetLimit: true });
    // Duplex prices: if the owner has set them (>0), use them; otherwise the normal
    // rate applies (backwards compatible + setting 0 by accident is safe)
    const _dupBw     = finalDuplex && parseFloat(job.price_bw_duplex) > 0;
    const _dupColor  = finalDuplex && parseFloat(job.price_color_duplex) > 0;
    const _rateBw    = _dupBw    ? job.price_bw_duplex    : job.price_bw;
    const _rateColor = _dupColor ? job.price_color_duplex : job.price_color;
    const pricePerPage = finalColorMode === 'color' ? _rateColor : _rateBw;
    // Whether the duplex rate really applied - the slab does not override it
    const _dupRateUsed = finalColorMode === 'color' ? _dupColor : _dupBw;

    // -- PAGE-RANGE (SLAB) RATE --
    // The owner can set "from this many pages to this many = this much". That price is
    // the rate for EACH PAGE, not for the whole job:
    //     8 pages and the 6-10 range rate is 1.5  =>  8 x 1.5 = 12
    //
    // It used to be treated as a flat price for the whole job - which is why 4
    // pages and 8 pages produced the same bill. A customer caught exactly this:
    // "printing 8 costs Rs 50 and printing 4 also costs Rs 50."
    //
    // The owner's own special rates rank ABOVE the slab: the duplex rate is
    // checked right here, and Resume / 4x6 / A3 overwrite the amount in their own
    // branches below. customer.html's getPerPageRate() follows exactly the same
    // order - both calculations must stay identical, otherwise
    // the customer sees one amount and is charged another.
    let ratePerPage = pricePerPage;
    if (!_dupRateUsed) {
      // Count = how many SHEETS come out (pages x copies). 3 copies of
      // 3 pages = 9 sheets, so the 6-10 range applies. customer.html's
      // getSlabPageCount() computes exactly the same count.
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
      // 12 is placed at the VERY TOP. It used to have no branch at all,
      // so a 12-photo job fell into the last fallback (the 4-photo rate) —
      // the customer got 12 photos for the price of 4.
      const pRate = job.photo_count === 12 ? (parseFloat(job.price_4x6_12) || 0)
                 : job.photo_count === 10 ? (parseFloat(job.price_4x6_10) || 0)
                 : job.photo_count === 8 ? (parseFloat(job.price_4x6_8) || 0)
                 : job.photo_count === 6 ? (parseFloat(job.price_4x6_6) || 0)
                 : (parseFloat(job.price_4x6_4) || 0);
      if (pRate > 0) amount = pRate * effCopies;
    } else {
      // Big Size (A3/A2/A1) — the owner's own per-page rate, only when set.
      // Even with duplex the big-size rate wins: the large paper
      // is the real cost, and duplex is included in it.
      const bigRate = bigSizeRate(job, job.paper_size, finalColorMode);
      if (bigRate > 0) amount = bigRate * finalPages * effCopies;
    }
    amount = round2(amount);
    const txnId = 'COUNTER_' + uuidv4().substring(0,10).toUpperCase();

    await pool.query(
      'UPDATE print_jobs SET payment_status=$1, status=$2, payment_id=$3, color_mode=$4, copies=$5, total_pages=$6, selected_pages=$7, amount=$8, payment_method=$9, duplex=$10 WHERE id=$11',
      ['paid', 'queued', txnId, finalColorMode, effCopies, finalPages, finalSelectedPages.join(','), amount, 'counter', finalDuplex, jobId]
    );

    markShopHasWork(job.shop_id);   // the next poll picks it up immediately
    console.log(`Counter payment: ${jobId} | Rs.${amount} | Pages: ${finalSelectedPages.join(',')}`);
    res.json({ success:true, txnId, amount });
  } catch(err) {
    console.error('Counter payment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════
// AGENT AUTO-UPDATE — the Print Agent checks by itself whether there is a new version
// ═══════════════════════════════════════════════

// ─── VERSION LABEL HELPERS (2.0 → 2.1 → ... → 2.10 → 3.0) ───────────
// Series rule: the minor goes from 0 to 10; after 2.10 comes the next major (3.0).
// The internal integer counter is separate and only ever goes +1.
const VERSION_LABEL_RE = /^\d{1,3}\.\d{1,3}$/;

function parseVersionLabel(label) {
  // "2.10" → [2, 10].  null for invalid/empty input.
  if (typeof label !== 'string') return null;
  const s = label.trim().replace(/^[vV]\.?/, '');
  if (!VERSION_LABEL_RE.test(s)) return null;
  const [maj, min] = s.split('.').map(n => parseInt(n, 10));
  if (!Number.isInteger(maj) || !Number.isInteger(min)) return null;
  return [maj, min];
}

function compareVersionLabels(a, b) {
  // -1 / 0 / 1. Do NOT use a string compare: "2.9" would come out greater than "2.10".
  const pa = parseVersionLabel(a), pb = parseVersionLabel(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  return 0;
}

function nextVersionLabel(current) {
  // The first push is always 2.0 (the new scheme starts here, after V29).
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
  // "What's in the Update" — the super admin writes it at push time; shop owners
  // see it next to the download button. It can be empty (optional).
  const notes = map.agent_version_notes ? String(map.agent_version_notes.value || '').trim() : '';
  const updatedAt = (map.agent_version_label && map.agent_version_label.updated_at)
    || (map.agent_version && map.agent_version.updated_at) || null;
  return { version, label, notes, updatedAt, nextLabel: nextVersionLabel(label) };
}

app.get('/api/agent/version', async (req, res) => {
  try {
    const info = await getAgentVersionInfo();
    // `version` is for old agents (integer compare) — never
    // remove it. New agents read `versionLabel` for display.
    res.json({
      version: info.version,
      versionLabel: info.label,
      // If the label is not set yet, the agent keeps showing its own label.
      displayVersion: info.label || String(info.version),
      // The "What's in Update" in the shop owner's panel comes from this.
      // Old agents ignore this field — nothing breaks.
      notes: info.notes,
      notesUpdatedAt: info.updatedAt
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// The agent sends the list of printers installed on its system here (on every
// startup and every 30 min) — so the owner can pick the correct printer name from
// a dropdown in the dashboard instead of typing it manually (typo-proof).
app.post('/api/agent/printers/:shopId', verifyAgent, async (req, res) => {
  try {
    const { printers } = req.body;
    if (!Array.isArray(printers)) return res.status(400).json({ error: 'A printers array is required' });
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
      [`printers_${req.params.shopId}`, JSON.stringify(printers)]
    );
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// The dashboard fetches the agent's reported printer list from this endpoint
app.get('/api/admin/printers', verifyToken, async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key=$1", [`printers_${req.shopId}`]);
    const printers = r.rows.length ? JSON.parse(r.rows[0].value) : [];
    res.json({ printers });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// The agent downloads new code from this endpoint (the agent fills in the Shop ID/Server URL
// from its own current values; we only send the raw template)
app.get('/api/agent/download-latest', async (req, res) => {
  try {
    const agentCode = fs.readFileSync(path.join(__dirname, 'agent-template', 'print_agent.py'), 'utf8');
    res.setHeader('Content-Type', 'text/plain');
    res.send(agentCode);
  } catch(err) {
    res.status(500).json({ error: 'Could not load the agent code: ' + err.message });
  }
});

// For agents in .exe mode — the new installer .exe is sent directly (for a silent
// install; downloading .py code makes no sense in exe mode,
// because a compiled binary cannot be replaced with source)
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
    // Agent heartbeat — the dashboard's Online/Offline indicator runs on this.
    // The agent also sends its version (?v=), so the superadmin can see which
    // version runs on which shop.
    // Heartbeat + shop info in ONE query (they used to be two separate queries).
    // Every agent polls every 5 seconds — one query less means
    // hundreds of thousands fewer round-trips per day, and that much bandwidth saved.
    const _av = parseInt(req.query.v, 10);
    // New agents also send their display label (?vl=2.0). Old
    // agents do not — in that case leave the column untouched.
    const _avl = (typeof req.query.vl === 'string' && VERSION_LABEL_RE.test(req.query.vl.trim()))
      ? req.query.vl.trim() : null;

    const _shopId = req.params.shopId;

    // ── HEARTBEAT: no DB write, collect it in memory ──
    // An UPDATE used to run on every poll (72 agents x every 5-12 sec).
    // Now everything is written in one batch UPDATE every 2 min. The dashboard's
    // Online/Offline uses a 5-min window, so it makes no difference.
    pendingHeartbeats.set(_shopId, {
      at: Date.now(),
      version: (Number.isInteger(_av) && _av > 0 && _av < 100000) ? _av : null,
      label: _avl
    });

    // ── FAST PATH 1: an expired demo ──
    if (expiredDemoShops.has(_shopId)) {
      return res.json({ jobs: [], demo_expired: true });
    }

    // ── FAST PATH 2: this shop has no work at all ──
    // THIS IS THE BIGGEST SAVING — 99.97% of polls end here, without touching the DB.
    if (!shopsWithWork.has(_shopId)) {
      const info = await getShopInfoCached(_shopId);
      if (info && info.demo &&
          isDemoExpired({ demo: true, demo_expires_at: info.demoExpiresAt })) {
        expiredDemoShops.add(_shopId);
        return res.json({ jobs: [], demo_expired: true });
      }

      // ── LONG POLL ──
      // If the agent sends `?lp=30`, hold the line. An OLD agent does not send
      // it (its timeout is only 20 sec) — it gets an empty answer
      // immediately, exactly as before.
      const _lp = Math.min(LP_MAX_SEC, parseInt(req.query.lp, 10) || 0);
      if (_lp > 0) {
        const woke = await waitForWork(_shopId, _lp, req);
        if (!woke) return res.json({ jobs: [] });
      } else {
        return res.json({ jobs: [] });
      }
    }

    // ── From here on: there really is a job. Now the DB is needed. ──
    const shopRow = await pool.query(
      'SELECT demo, demo_expires_at FROM shops WHERE id = $1', [_shopId]);
    if (shopRow.rows.length && shopRow.rows[0].demo) {
      const sh = shopRow.rows[0];
      // Layer 3: one machine = one demo PERMANENTLY. The agent sends ?m=MachineGuid;
      // if this machine already has a record for ANY OTHER demo, this demo
      // expires immediately — a new number/IP will not help.
      const m = String(req.query.m || '').trim().slice(0, 90);
      if (m) {
        const mc = await pool.query('SELECT shop_id FROM demo_machines WHERE machine_id=$1', [m]);
        if (!mc.rows.length) {
          await pool.query('INSERT INTO demo_machines (machine_id, shop_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [m, req.params.shopId]);
        } else if (mc.rows[0].shop_id !== req.params.shopId) {
          await pool.query('UPDATE shops SET demo_expires_at=NOW() WHERE id=$1', [req.params.shopId]);
          console.log(`Demo machine-lock: ${req.params.shopId} expired (the machine was already used by ${mc.rows[0].shop_id})`);
          return res.json({ jobs: [], demo_expired: true });
        }
      }
      if (isDemoExpired({ demo: true, demo_expires_at: sh.demo_expires_at })) {
        expiredDemoShops.add(_shopId);   // the next poll will not even reach the DB
        return res.json({ jobs: [], demo_expired: true });
      }
    }

    // ATOMIC CLAIM: as soon as the job is handed out its status becomes 'printing'. Jobs
    // used to stay 'queued' after the fetch — while a large PDF was printing, the next
    // poll picked up the same job again and caused a DOUBLE PRINT, and there was no way
    // to detect the job of a crashed agent. With FOR UPDATE SKIP
    // LOCKED, even two parallel polls never claim one job twice.
    const r = await pool.query(
      `UPDATE print_jobs j SET status='printing', printing_at=NOW()
       FROM shops s
       WHERE j.id IN (
         SELECT j2.id FROM print_jobs j2 JOIN shops s2 ON j2.shop_id=s2.id
         WHERE j2.shop_id=$1 AND j2.payment_status='paid' AND s2.setup_paid=true
           AND (
                j2.status='queued'
                -- ORPHAN RECOVERY:
                -- The job is in 'printing' but nothing has happened for quite a while.
                -- This happens when the claim succeeded but the response never reached
                -- the agent (the socket died after idling,
                -- a timeout, or an agent restart). Such a job used to never be handed
                -- out again, and the file was deleted after 120s —
                -- the customer paid, but the print never came out.
                -- A shop has only one agent, so handing it out again is safe;
                -- the agent itself prevents a duplicate print.
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
// DIRECT CLOUDINARY DOWNLOAD — Render is NOT a PDF proxy
// ═══════════════════════════════════════════════
// Architecture (it already worked like this; now it is also authorized):
//
//   Customer → Cloudinary        (straight from the browser, /upload/sign)
//   Render   → metadata only     (job id, settings, status)
//   Agent    → Cloudinary        (the PDF directly, NOT through Render)
//
// PDF bytes never pass through Render. This endpoint only grants
// AUTHORIZATION: the agent asks "where is this job's file?", the server verifies
// the job's owner/paid/claimed status and returns the URL. The bytes go straight from
// Cloudinary to the shop PC.
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

    // Never hand out another shop's job
    if (j.shop_id !== shopId) {
      await logSecurityEvent({ ip: clientIp(req), shopId, endpoint: '/download-url', method: 'GET',
        action: 'FILE_ACCESS', reason: 'WRONG_SHOP:' + jobId, userAgent: req.headers['user-agent'] });
      return res.status(403).json({ error: 'This job does not belong to this shop' });
    }
    // Never a file without payment
    if (j.payment_status !== 'paid') {
      return res.status(403).json({ error: 'Job is not paid yet' });
    }
    // Only a claimed job ('printing') — a printed/failed job must not be downloaded again
    if (j.status !== 'printing') {
      return res.status(409).json({ error: `Job is not claimed (status: ${j.status})`, status: j.status });
    }
    if (j.file_deleted || !j.file_url) {
      return res.status(410).json({ error: 'File has already been deleted' });
    }

    res.json({
      jobId: j.id,
      downloadUrl: j.file_url,          // the direct Cloudinary URL
      fileType: j.file_type || 'pdf',
      expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SEC * 1000).toISOString()
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════
// DEMO → PAID SHOP CONVERSION
// ═══════════════════════════════════════════════
// This is purely BACKEND-controlled. A client cannot become paid just by
// swapping DEMO_xxx for SHOP_xxx — the server verifies everything
// and transfers the agent token itself.
//
// The most important security point: the Shop ID alone is NOT enough.
// The Shop ID is printed on the customer QR/poster — by looking at another shop's ID
// anyone could hijack that shop from their own PC. So the conversion
// also requires the PASSWORD of that paid shop (the same one the shop owner
// uses to log in to the dashboard).

/** Verify the paid Shop ID + password — nothing is changed yet. */
app.post('/api/agent/verify-paid-shop', verifyAgent, async (req, res) => {
  const ip = clientIp(req);
  try {
    const demoShopId = String(req.agentShopId || req.params.shopId
                              || req.body.demoShopId || '').trim();
    const paidShopId = String(req.body.paidShopId || '').trim().toUpperCase();
    const password   = String(req.body.password || '');

    if (!paidShopId) return res.status(400).json({ error: 'Please enter your paid Shop ID' });
    if (!password)   return res.status(400).json({ error: 'Please enter your shop password' });

    // Brute force guard — the Shop ID is public, so password guessing must be stopped
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
    // Password correct — reset the attempts
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

    // A short-lived ticket — the actual switch happens with it, so the
    // password does not have to be sent again and the switch call cannot be replayed.
    const ticket = jwt.sign(
      { demoShopId, paidShopId, act: 'demo-convert' }, JWT_SECRET, { expiresIn: '10m' });

    console.log(`Demo conversion verified: ${demoShopId} -> ${paidShopId} | ip ${ip}`);
    res.json({
      success: true, ticket,
      shopId: shop.id, shopName: shop.name,
      planType: shop.plan_type || 'monthly',
      alreadyLinked: !!shop.agent_token   // a PC is already bound to that shop
    });
  } catch(err) {
    console.error('verify-paid-shop error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// An escalating temporary block on password guessing (never a permanent ban)
const convertAttempts = new Map();
function _convertFail(ip, shopId, reason) {
  const n = (convertAttempts.get(ip) || 0) + 1;
  convertAttempts.set(ip, n);
  if (n >= 5) blockFor('convert:' + ip, SEC.blockMin, 'paid shop conversion brute force');
  logSecurityEvent({ ip, shopId, endpoint: '/api/agent/verify-paid-shop', method: 'POST',
                     action: 'DEMO_CONVERT', reason, uploadCount: n });
}

/** The actual switch, with the ticket. The agent token moves from the demo to the paid shop. */
app.post('/api/agent/convert-to-paid', verifyAgent, async (req, res) => {
  const client = await pool.connect();
  try {
    // This used to read `req.params.shopId` -- but this route has no :shopId
    // param at all, so it was ALWAYS empty and the check below
    // always failed ("Verification does not match this
    // installation"). verifyAgent now extracts the shopId and puts it in
    // req.agentShopId (from params / body / ticket -- whichever is present).
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

    // Move the agent token from the demo shop to the paid shop — this is what makes this PC
    // the authorized agent of the paid shop.
    const sentToken = agentTokenFromReq(req);
    if (sentToken && /^[A-Za-z0-9_-]{16,64}$/.test(sentToken)) {
      await client.query('UPDATE shops SET agent_token=$2 WHERE id=$1', [paidShopId, sentToken]);
      await client.query('UPDATE shops SET agent_token=NULL WHERE id=$1', [demoShopId]);
      invalidateAgentToken(demoShopId);   // clear the cache — otherwise the disconnect has no effect
    }

    // End the demo right now — that PC now runs the paid shop
    await client.query(
      "UPDATE shops SET demo_expires_at = NOW() WHERE id=$1 AND demo=true", [demoShopId]);

    // Cancel the demo's remaining queued jobs — otherwise old demo jobs
    // could come out on the new paid shop's printer
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
// SHOP ID CLAIM — one Shop ID on only ONE PC
// ═══════════════════════════════════════════════
// The agent used to call /api/shop/:id to verify the Shop ID.
// That is a PUBLIC endpoint (customers use it too) — it has no idea
// which PC is calling. So anyone could read a Shop ID from a QR poster,
// put it into their own PC, and get "verified".
//
// Job polling was already protected (wrong token = 403), but the user saw
// that error later in a confusing way. Now it is refused clearly right
// at the start.
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

    // Already bound to this PC — reinstalling/reopening is fine
    if (shop.agent_token && shop.agent_token === sent) {
      await pool.query(
        'UPDATE shops SET agent_machine=COALESCE(NULLIF($2,\'\'), agent_machine) WHERE id=$1',
        [shopId, machine]);
      return res.json({ success: true, shopId: shop.id, shopName: shop.name, rebound: false });
    }

    // Bound to ANOTHER PC — refuse
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

    // It is free — bind this PC
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

// The superadmin can remove any shop's PC — if a shop owner's computer
// suddenly breaks, they can call you and set up a new PC right away.
// Works for both demo and paid shops.
// ══════════════════════════════════════════════════════════════
//  UNBLOCK — remove an abuse block (no server restart needed)
//  Blocks live in in-memory Maps, not in the DB. There used to be ONLY ONE
//  way to remove one: a full Render restart — which also paused printing for
//  every other shop for a few seconds.
// ══════════════════════════════════════════════════════════════
app.post('/api/superadmin/shop/:shopId/unblock', verifySuperAdmin, async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const wasBlocked = isBlocked('shop:' + shopId);
    abuseBlocks.delete('shop:' + shopId);
    uploadHits.delete(shopId);          // the quota count goes to zero too
    console.log(`Unblocked by superadmin: ${shopId} (${wasBlocked} min were left)`);
    res.json({ success: true, shopId, wasBlockedMinutes: wasBlocked });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/shop/:shopId/agent-disconnect', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE shops SET agent_token=NULL, agent_machine=NULL, agent_bound_at=NULL
        WHERE id=$1 RETURNING id, name, agent_machine`, [req.params.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    invalidateAgentToken(req.params.shopId);   // clear the cache — otherwise the disconnect has no effect
    console.log(`Agent disconnected by SUPERADMIN: ${req.params.shopId} (${r.rows[0].name})`);
    res.json({ success: true, shopId: r.rows[0].id, wasOn: r.rows[0].agent_machine || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// A shop owner can remove their own PC (new computer, Windows reinstall)
app.post('/api/admin/agent/disconnect', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE shops SET agent_token=NULL, agent_machine=NULL, agent_bound_at=NULL
        WHERE id=$1 RETURNING id, agent_machine`, [req.shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });
    invalidateAgentToken(req.shopId);   // clear the cache — otherwise the disconnect has no effect
    console.log(`Agent disconnected by shop owner: ${req.shopId}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── DESKTOP PANEL SESSION ───────────────────────────────────────
// The desktop panel has to show the shop settings/pricing/payment. Instead of
// re-implementing that business logic, the agent exchanges its agent_token for a
// SHORT-LIVED admin session token and calls the same existing
// admin APIs that the website dashboard calls.
// Zero duplicated logic, zero new database.
app.post('/api/jobs/:shopId/panel-session', verifyAgent, async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const r = await pool.query('SELECT id, name, demo, demo_expires_at FROM shops WHERE id=$1', [shopId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Shop not found' });

    // 2 hours — the panel may stay open, but the token is not valid forever.
    const token = jwt.sign({ shopId, via: 'agent-panel' }, JWT_SECRET, { expiresIn: '2h' });
    res.json({
      token,
      expiresInSec: 7200,
      shopId,
      shopName: r.rows[0].name,
      // shop_type comes from the backend — the client must not decide just by looking
      // at the DEMO_ prefix (spec: backend is the source of truth)
      shopType: r.rows[0].demo ? 'demo' : 'paid',
      demoExpiresAt: r.rows[0].demo_expires_at
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// The agent reports "downloaded" — metadata only, no file.
// This lets the admin panel know whether the file reached the shop PC.
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
    // `installed` = whether an agent was ever bound to this shop. This is a stable
    // fact — it does not change when the PC is off or the network drops. The panel's chip
    // runs on it, so the owner does not see the status flipping every
    // 10 seconds. online/seconds_ago are unchanged (old code
    // and the agent both still read them).
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
    // Only an active job can become 'printed'. On a late/duplicate report
    // (the job is already printed/failed) quietly return success — the agent retries
    // and does not want an error. A late complete for a requeued ('queued') job
    // is GOOD — it means the print actually happened and will not happen again.
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
    // On deny/fail too the customer's file is cleaned from Cloudinary — otherwise orphan
    // files would keep piling up (both privacy + storage)
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

// ─── Print Agent Package Download after setup ───
// Works only for paid (setup_paid=true) shops
// ─── EASY INSTALLER (.exe) — for non-technical shop owners ───
// This delivers a single .exe with Python + SumatraPDF + the Agent all bundled.
// The Shop ID is sent next to the exe in a small config file (shop_config.txt),
// which the installer reads to configure print_agent itself.
app.get('/api/download/easy-installer/:shopId', async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const r = await pool.query('SELECT id, setup_paid FROM shops WHERE id=$1', [shopId]);
    if (!r.rows.length) return res.status(404).send('Shop not found');
    if (!r.rows[0].setup_paid) return res.status(403).send('Complete the setup fee payment first');

    const urlResult = await pool.query("SELECT value FROM system_settings WHERE key='easy_installer_url'");
    if (!urlResult.rows.length || !urlResult.rows[0].value) {
      return res.status(404).send('The Easy Installer is not available right now. Use the ZIP version (Python+INSTALL.bat) below, or try again a little later.');
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
    if (!r.rows[0].setup_paid) return res.status(403).send('Complete the setup fee payment first');

    const shopName = r.rows[0].name;

    // Read the print_agent.py template and fill in the Shop ID
    let agentCode = fs.readFileSync(path.join(__dirname, 'agent-template', 'print_agent.py'), 'utf8');
    agentCode = agentCode.replace('YOUR_SHOP_ID', shopId);
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

    // Add the QR code image too (a PNG built from base64)
    const qrResult = await pool.query('SELECT qr_code FROM shops WHERE id=$1', [shopId]);
    if (qrResult.rows.length && qrResult.rows[0].qr_code) {
      const base64Data = qrResult.rows[0].qr_code.replace(/^data:image\/png;base64,/, '');
      archive.append(Buffer.from(base64Data, 'base64'), { name: 'QR-Code.png' });
    }

    archive.finalize();
  } catch(err) {
    console.error('Download package error:', err.message);
    res.status(500).send('Error while building the package: ' + err.message);
  }
});



// ═══════════════════════════════════════════════
// SUPER ADMIN APIs — the platform owner's own panel, to see all shops
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
    // Captcha — when it is disabled, this line passes through silently
    if (!(await captchaGuard(req, res))) return;
    if (!SUPER_ADMIN_ID || !SUPER_ADMIN_PASSWORD) {
      return res.status(500).json({ error: 'Super Admin is not configured yet. Check the Render environment variables.' });
    }
    const { adminId, password } = req.body;
    if (adminId !== SUPER_ADMIN_ID || password !== SUPER_ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Wrong ID or password' });
    }
    const token = jwt.sign({ role: 'super_admin', adminId }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══ ADMIN BROADCAST (a message from the superadmin shown to all shops) ═══
// The superadmin writes a message and it appears on every shop's Overview.
// Reuses the system_settings (key/value) table — no new table.

// The shop panel fetches this (public, no token needed)
app.get('/api/admin-broadcast', async (req, res) => {
  try {
    // A white-label shop sees the RESELLER's message, not ours —
    // otherwise messages from two different brands would mix on one dashboard.
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

// The superadmin saves it here (send it empty to remove the message)
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

// ═══ QR REGENERATE (rebuild every shop's QR from the current BASE_URL) ═══
// Why: the old QR codes were made when BASE_URL was onrender.com — the old URL is
// encoded inside that image. This route rebuilds every shop's QR
// from the current BASE_URL. For shops whose QR is already correct (echel.in) the
// new QR comes out exactly the same — no harm. The old onrender
// ones get corrected.
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

// Superadmin -> shop agent notification (like the counter popup)
app.post('/api/superadmin/notify-shop', verifySuperAdmin, async (req, res) => {
  try {
    const { shop_id, message } = req.body || {};
    if (!shop_id) return res.status(400).json({ error: 'shop_id is required' });
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['notify_' + shop_id, message || 'Any Problem in Printing? Contact Admin']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// The agent picks this up with its poll, shows it and acknowledges it
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
    // The Overview now shows only shop counts — the money lives in Analytics;
    // keeping the same number in two places causes confusion.
    // NOTE: white-label shops are NOT OUR shops — they belong to the reseller
    // and their setup fee goes straight to the reseller's Razorpay.
    // They used to be counted as 'pending' (because setup_paid=false)
    // while the Shops list did not show them at all — which is why it showed
    // "Pending 5" while the list was empty.
    // Now the same rule applies everywhere: WL = separate, in its own tab.
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

    // Revenue: only the money that reached OUR account.
    // The setup fee of white-label shops belongs to the reseller — so it is not in the total.
    const earnings = await pool.query(`
      SELECT
        COALESCE(SUM(setup_amount) FILTER (WHERE setup_paid AND ${WL}), 0)::int as total_setup_revenue,
        COUNT(*) FILTER (WHERE setup_paid AND ${WL})::int as paid_shops
      FROM shops
    `);
    // Advanced unlock + renewal + WL license — now comes from the ledger
    const ledger = await pool.query(`
      SELECT kind, COALESCE(SUM(amount),0)::int AS amt, COUNT(*)::int AS cnt
      FROM platform_payments GROUP BY kind`);
    const byKind = {};
    ledger.rows.forEach(r => { byKind[r.kind] = { amount: r.amt, count: r.cnt }; });

    // Print volume = the money shop owners received from customers. That is NOT
    // OUR earnings — so it goes into a separate field, not the total.
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
    // whitelabel_id is now required — the UI needs to know which shop belongs to a
    // reseller (it goes to a separate tab, not Active).
    // With onboarded_by_name the agent's name shows right in the list, so
    // an agent's shop no longer has to be hidden (it used to be hidden — which
    // is why its payment never showed up in superadmin).
    const r = await pool.query(`
      SELECT s.id, s.name, s.address, s.phone, s.printer_model, s.price_bw, s.price_color,
             s.payment_mode, s.payment_gateway, s.setup_paid, s.setup_amount, s.created_at,
             s.demo, s.plan_type, s.billing_cycle, s.paid_until, s.advanced_unlocked, s.agent_last_seen,
             EXTRACT(EPOCH FROM (NOW() - s.agent_last_seen))::int AS agent_seconds_ago,
             s.agent_version, s.agent_version_label, s.onboarded_by,
             s.agent_machine, (s.agent_token IS NOT NULL) AS agent_bound,
             -- owned_features WAS NOT HERE - and superadmin.html's
             -- saShopHasScan() depends on it. Without it, it always
             -- read undefined, so EVERY non-premium shop
             -- showed "Scanner OFF" - even if it had paid 49 rupees.
             -- That is why there was no way to tell who had the Smart
             -- Scanner, and the "take back" button never appeared.
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
// Every payment that reached our account. There used to be only the setup fee flag
// and no record at all was created for advanced/renewal.
// Filter with ?kind=setup|advanced|renewal|wl_license, search with ?q=.
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

    // Totals: a white-label shop's setup fee is the reseller's money —
    // so "our" total is calculated without it.
    const tot = await pool.query(`
      SELECT
        COALESCE(SUM(amount),0)::int AS all_amount,
        COALESCE(SUM(amount) FILTER (WHERE NOT (kind='setup' AND whitelabel_id <> '')),0)::int AS our_amount,
        COUNT(*)::int AS cnt
      FROM platform_payments WHERE kind <> 'wl_license' AND COALESCE(whitelabel_id,'') = ''`);
    res.json({ payments: rows.rows, totals: tot.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Superadmin: WHITE-LABEL shops (a separate tab) ───
// These shops belong to resellers — they are not in our Active/Pending counts.
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
// Remove all expired demo accounts in one click.
// The protected shop (SHOP_ECB1AB8A) is never deleted.
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

// Remove all pending-payment shops (registered, no payment received) in one click.
// Demo and white-label shops are not touched.
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

// ─── Superadmin: any shop's (paid or demo) PC printer list + selection ───
// The agent sends its printer list every 30 min (system_settings.printers_<id>).
// The superadmin can view it here and save which printer is used
// for which job.
app.get('/api/superadmin/shop/:shopId/printers', verifySuperAdmin, async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const s = await pool.query(
      `SELECT id, name, demo, payment_mode, agent_last_seen,
              EXTRACT(EPOCH FROM (NOW() - agent_last_seen))::int AS agent_seconds_ago,
              printer_name_bw, printer_name_color, printer_name_4x6, printer_name_a3
       FROM shops WHERE id=$1`, [shopId]);
    if (!s.rows.length) return res.status(404).json({ error: 'Shop not found' });
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
// STRICT RULE: the superadmin can only set 'counter_only'. Online/Both
// must be set by the shop owner from their own login (because it requires their
// own Razorpay/Cashfree keys).
app.put('/api/superadmin/shop/:shopId/printers', verifySuperAdmin, async (req, res) => {
  try {
    const shopId = req.params.shopId;
    const b = req.body || {};
    const chk = await pool.query('SELECT id FROM shops WHERE id=$1', [shopId]);
    if (!chk.rows.length) return res.status(404).json({ error: 'Shop not found' });

    const clean = v => (typeof v === 'string' ? v.trim().slice(0, 300) : null);
    const bw = clean(b.printer_name_bw);
    const color = clean(b.printer_name_color);
    const p4x6 = clean(b.printer_name_4x6);
    const a3 = clean(b.printer_name_a3);

    let setPayment = false;
    if (b.payment_mode !== undefined && b.payment_mode !== null && b.payment_mode !== '') {
      if (b.payment_mode !== 'counter_only') {
        return res.status(403).json({
          error: 'The superadmin can only set "Payment at the counter". For Online/Both the shop owner must log in and add their own payment keys.'
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

// The owner's own first shop — it is never deleted, whatever the UI/API
// sends. Hardcoded server-side so nobody can bypass it.
const PROTECTED_SHOP_IDS = ['SHOP_ECB1AB8A'];

// ─── Shop delete — shops with a paid amount of 0 can be deleted ───
// Rule: any shop with setup_amount 0 (or null) can be deleted
// (pending + old ones whose amount was not captured). A shop that paid REAL money
// (setup_amount > 0) is protected. The owner's first shop is always safe.
app.delete('/api/superadmin/shop/:shopId', verifySuperAdmin, async (req, res) => {
  try {
    const shopId = req.params.shopId;
    if (PROTECTED_SHOP_IDS.includes(shopId)) {
      return res.status(403).json({ error: 'This shop is protected — it cannot be deleted' });
    }
    const chk = await pool.query('SELECT setup_paid, setup_amount FROM shops WHERE id=$1', [shopId]);
    if (!chk.rows.length) return res.status(404).json({ error: 'Shop not found' });
    // Deletable: PENDING (setup_paid=false — new or old) OR
    // legacy paid-₹0. setup_amount is stored at registration (before the
    // payment), so amount>0 is NOT proof of payment — setup_paid is.
    const deletable = !chk.rows[0].setup_paid || (chk.rows[0].setup_amount || 0) === 0;
    if (!deletable) {
      return res.status(403).json({ error: 'A paid/active shop cannot be deleted' });
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

// ─── Setup Fee / Offer Price Management — so the Super Admin can change them live ───
app.get('/api/superadmin/homepage-config', verifySuperAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM system_settings WHERE key='homepage_config'");
    res.json(withBrandDefaults(r.rows.length ? JSON.parse(r.rows[0].value) : {}));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/superadmin/homepage-config', verifySuperAdmin, async (req, res) => {
  try {
    // Sanitize: only known keys, arrays forced into string arrays
    const cur = await pool.query("SELECT value FROM system_settings WHERE key='homepage_config'");
    const cfg = cur.rows.length ? JSON.parse(cur.rows[0].value) : {};
    const b = req.body || {};
    let branding;
    try { branding = validateBranding(b); } catch (e) { return res.status(400).json({error:e.message}); }
    Object.assign(cfg, branding);
    for(const key of ['statShops','statPrints']) if(typeof b[key] === 'string') cfg[key] = b[key].slice(0,300);
    if (typeof b.showStats === 'boolean') cfg.showStats = b.showStats;
    // Review badge — Google and Justdial. Rating 0-5, count is just a number,
    // link must be http(s).
    //
    // Checking the link is essential: it goes straight into a homepage
    // href. If someone accidentally enters something like "javascript:" it would run
    // in the visitor's browser.
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

    // Official Partner list — the logo strip at the bottom of the homepage.
    // Each partner: { name, logo, url }. Only http(s) links are accepted, and the
    // logo is either a full link or a path within the site (/img/...).
    // Everything else is dropped — this goes straight onto the homepage.
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

    // The WhatsApp To Print price. waPriceActual = the one shown struck through,
    // waPrice = what is actually charged. Both empty = the homepage keeps showing
    // "Price revealing soon".
    for (const k of ['waPriceActual', 'waPrice']) {
      if (b[k] !== undefined && b[k] !== null) {
        cfg[k] = String(b[k]).replace(/\D/g, '').slice(0, 9);
      }
    }
    // All homepage buttons/text (data-cfg keys) — in one object
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
    // planMonthly/planOnetime are kept for the old homepage —
    // the new three cards read planStarter/planPro/planPremium.
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
    if (!req.file) return res.status(400).json({ error: 'No file' });
    if (!['image/png','image/jpeg','image/webp','image/svg+xml'].includes(req.file.mimetype))
      return res.status(400).json({ error: 'Only PNG/JPG/WEBP/SVG' });
    if (req.file.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'The logo must be smaller than 2MB' });
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
      // The Starter/Pro/Premium prices. These were missed before,
      // so after saving in superadmin the inputs showed empty on refresh
      // (the save was fine; they simply were not loaded).
      plans: await getPlanPricing(),
      advancedFee: await getAdvancedFee(),
      monthlyActualPrice: await getMonthlyActualFee(),
      advancedActualPrice: await getAdvancedActualFee(),
      agentBasePrice: await getAgentBasePrice(),
      agentPremiumBasePrice: await getAgentPremiumBasePrice(),
      agentBasePriceIsSet: (await pool.query("SELECT value FROM system_settings WHERE key='agent_base_price'")).rows[0]?.value > 0,
      // What a White Label partner pays us once, and the floor they may sell at.
      wlLicenseFee: await getWlLicenseFee(),
      wlLicenseActual: await getWlLicenseActual(),
      wlBasePrice: (await pool.query("SELECT value FROM system_settings WHERE key='wl_base_price'")).rows[0]?.value | 0,
      wlBasePriceEffective: await getWlBasePrice(),
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
      agentBasePrice:await getAgentBasePrice(),agentPremiumBasePrice:await getAgentPremiumBasePrice(),
      wlLicenseFee:await getWlLicenseFee(),wlLicenseActual:await getWlLicenseActual(),wlBasePrice:await getWlBasePrice()};
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

// ─── Agent Version Management — the Super Admin pushes a new update from here ───
// There are two numbers, each with its own job:
//   agent_version       (INT)  → the INTERNAL trigger. +1 on every push. Old
//                                agents (v27/v28/v29) compare this
//                                one. Never turn it into "2.0".
//   agent_version_label (TEXT) → what is SHOWN everywhere: 2.0, 2.1 ... 2.10, 3.0
app.get('/api/superadmin/agent-version', verifySuperAdmin, async (req, res) => {
  try {
    const info = await getAgentVersionInfo();
    res.json({
      version: info.version,          // internal counter (legacy field name)
      versionLabel: info.label,       // "2.0"
      displayVersion: info.label || String(info.version),
      nextLabel: info.nextLabel,      // the next suggested label
      notes: info.notes,              // "What's in the Update" box ka current text
      updatedAt: info.updatedAt
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/agent-version/bump', verifySuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const info = await getAgentVersionInfo();

    // Label: use the one from the body if present, otherwise the automatic next one (2.0 → 2.1 → ... → 2.10 → 3.0)
    const requested = (req.body && typeof req.body.label === 'string') ? req.body.label.trim() : '';
    const newLabel = requested || info.nextLabel;

    // "What's in the Update" — optional. If left empty, the "What's in Update" button
    // does not appear in the shop owner's panel at all (better than an empty popup).
    // A 2000-char cap so nobody pastes a whole changelog by mistake.
    const newNotes = (req.body && typeof req.body.notes === 'string')
      ? req.body.notes.trim().slice(0, 2000)
      : '';

    if (!parseVersionLabel(newLabel)) {
      return res.status(400).json({ error: 'Invalid version format. Use: 2.0, 2.1, 2.10, 3.0' });
    }
    // Never go backwards — otherwise every shop would keep showing "update available"
    // and never settle.
    if (info.label && compareVersionLabels(newLabel, info.label) <= 0) {
      return res.status(400).json({
        error: `Version ${newLabel} must be newer than the current ${info.label}. Suggested: ${info.nextLabel}`
      });
    }

    const newVersion = info.version + 1;   // the internal counter always +1

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
    // Always write the notes — sending them empty removes the notes of the old version.
    // Otherwise, after a new version is pushed, shop owners would keep seeing the text
    // of the previous update, which is wrong.
    await client.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('agent_version_notes', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [newNotes]
    );
    await client.query('COMMIT');

    console.log(`Agent version pushed → v${newLabel} (internal ${newVersion}) by super admin — all customer PCs will update within 1 hour`);
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

// ─── Easy Installer (.exe) URL Management — hosted externally ───
// To avoid the file-size limits of both GitHub and Render, when a new .exe is
// built it is uploaded manually and its URL is
// set/updated here. No code change/redeploy is needed.
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
      return res.status(400).json({ error: 'Enter a valid URL (it must start with https://)' });
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
// Even if the customer closes the browser right after paying, the payment
// is confirmed. NOTE: this is only for the webhooks of the OWNER (setup fee) Razorpay
// account — set the webhook URL + secret in the Razorpay dashboard and
// put the secret in the RAZORPAY_WEBHOOK_SECRET env.
// For the shop owners' own accounts the RECONCILIATION below runs
// (having them configure webhooks in their dashboards is not practical).
// ══════════════════════════════════════════════════════════════════
app.post('/api/webhook/razorpay', async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: 'The webhook secret is not configured' });
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
        // A renewal order? (if it does not match a setup)
        if (!sh.rows.length) {
          const rn = await pool.query('SELECT id FROM shops WHERE renewal_order_id=$1', [orderId]);
          if (rn.rows.length) {
            await extendShop(rn.rows[0].id, orderId, paymentId || 'WEBHOOK');
            return res.json({ status: 'ok' });
          }
          // ⚠️ This block used to not exist at all. The webhook looked at setup / renewal /
          // advanced but not at ADD-ON (₹49) orders —
          // so that payment had no safety net at all. If the browser was closed,
          // the network dropped, or the login token expired, the money
          // was debited and the feature was never unlocked.
          const ft = await pool.query(
            'SELECT id FROM shops WHERE feature_order_id=$1', [orderId]);
          if (ft.rows.length) {
            const fid = await unlockFeatureByOrder(ft.rows[0].id, orderId, paymentId || 'WEBHOOK');
            console.log('Feature unlocked (webhook):', ft.rows[0].id, fid);
            return res.json({ status: 'ok' });
          }

          const adv = await pool.query('SELECT id FROM shops WHERE advanced_order_id=$1', [orderId]);
          if (adv.rows.length) {
            await unlockAdvancedByOrder(adv.rows[0].id, orderId, paymentId || '', 'webhook');
            return res.json({ status: 'ok' });
          }
        }
        if (sh.rows.length && !sh.rows[0].setup_paid) {
          await activateShop(sh.rows[0].id, paymentId);
        }
        // 2) A customer print job? (if it came through the owner account)
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
    res.status(200).json({ received: true }); // on a 5xx Razorpay starts a retry storm
  }
});

// ══════════════════════════════════════════════════════════════════
// BACKGROUND JOBS (every 2 min)
// 1) STUCK-JOB CLEANUP: if the agent crashed in the middle of a print, the job
//    stayed stuck in 'printing' forever. After 10 min it goes back to 'queued',
//    and after 2 retries to 'failed' — a poison job (a corrupt PDF that crashes the
//    agent every time) can never create an infinite loop.
// 2) RAZORPAY RECONCILIATION: check pending payments directly with the Razorpay Orders
//    API — using the shop's own stored keys. Even if the customer closes
//    the browser, the payment is marked paid within 2 min,
//    without any webhook configuration.
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
// A job stuck in 'printing' for longer than STUCK_JOB_TIMEOUT_SEC (default 120s)
// = the shop PC/printer did not respond. Delete that file from Cloudinary,
// fail the job, and show a clear reason in the admin panel.
// ═══════════════════════════════════════════════
let sweepRunning = false;
async function sweepStuckJobs() {
  if (sweepRunning) return;          // overlap guard
  sweepRunning = true;
  try {
    // Optional retry (STUCK_JOB_RETRIES=1) — default 0 means fail immediately.
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
          // Even if the Cloudinary delete fails, the job stays failed —
          // the TTL cleanup will pick up the file later.
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

// Half of the timeout as the interval — so detection is never late.
setInterval(sweepStuckJobs, Math.max(15, Math.floor(STUCK_JOB_TIMEOUT_SEC / 4)) * 1000).unref();

let bgRunning = false;
async function backgroundMaintenance() {
  if (bgRunning) return; // overlap guard
  bgRunning = true;
  try {
    // 0) Security log retention — remove events older than 7 days
    try {
      const del = await pool.query(
        "DELETE FROM security_events WHERE created_at < NOW() - INTERVAL '7 days' RETURNING id");
      if (del.rows.length) console.log(`Security log cleanup: ${del.rows.length} old rows removed`);
    } catch (e) { console.warn('security log cleanup skipped:', e.message); }

    // 1) Stuck printing jobs — sweepStuckJobs() now runs in its own faster loop
    //    (every 30s), so the 120-second limit really is 120 seconds.
    //    This is just one extra safety pass.
    await sweepStuckJobs();

    // 2a) Reconcile customer job payments (with the shop's own keys)
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
          // Set the status to 'queued' together with payment_status — otherwise the agent
          // (which picks up queued+paid) would NEVER pick up this job and
          // the customer would pay without getting a print.
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
      } catch(e) { /* the next cycle will retry */ }
    }

    // 2b) Setup fee reconcile. A partner's shop pays into the PARTNER's own
    //     account (Razorpay or Cashfree), so its order can only be looked up
    //     with the partner's keys — with ours it was never found, and a partner
    //     shop that paid and closed the page stayed inactive for good.
    //     Every list below is taken in random order: "the first 10" were
    //     always the same 10 abandoned orders, and nothing behind them was
    //     ever checked.
    {
      const setups = await pool.query(
        `SELECT s.id, s.setup_order_id, s.whitelabel_id,
                w.razorpay_key_id AS wl_rzp_id, w.razorpay_key_secret AS wl_rzp_secret,
                w.cashfree_app_id AS wl_cf_id, w.cashfree_secret_key AS wl_cf_secret
           FROM shops s LEFT JOIN whitelabels w ON w.id = s.whitelabel_id
          WHERE s.setup_paid=false AND s.setup_order_id IS NOT NULL AND s.setup_order_id <> ''
          ORDER BY random() LIMIT 20`);
      for (const shop of setups.rows) {
        try {
          let paid = false;
          if (shop.whitelabel_id) {
            if (/^QSPS_/.test(shop.setup_order_id)) {
              // Our own Cashfree order id (see /api/setup-fee/create)
              if (shop.wl_cf_id && shop.wl_cf_secret) {
                const o = await cashfreeRequest('GET', '/pg/orders/' + encodeURIComponent(shop.setup_order_id),
                  shop.wl_cf_id, shop.wl_cf_secret, null);
                paid = !!(o && o.order_status === 'PAID');
              }
            } else if (shop.wl_rzp_id && shop.wl_rzp_secret) {
              const o = await razorpayOrderStatus(shop.setup_order_id, shop.wl_rzp_id, shop.wl_rzp_secret);
              paid = !!(o && o.status === 'paid');
            }
          } else if (OWNER_RAZORPAY_KEY_ID && OWNER_RAZORPAY_KEY_SECRET) {
            const o = await razorpayOrderStatus(shop.setup_order_id, OWNER_RAZORPAY_KEY_ID, OWNER_RAZORPAY_KEY_SECRET);
            paid = !!(o && o.status === 'paid');
          }
          if (paid) {
            await activateShop(shop.id, shop.setup_order_id);
            console.log('💰 Reconciled setup fee:', shop.id);
          }
        } catch(e) { /* next cycle */ }
      }
    }
    // 2b-ii) Renewal reconcile — the renewal order was created but the verify never arrived
    if (OWNER_RAZORPAY_KEY_ID && OWNER_RAZORPAY_KEY_SECRET) {
      const renews = await pool.query(
        `SELECT id, renewal_order_id FROM shops
         WHERE renewal_order_id IS NOT NULL AND renewal_order_id <> '' ORDER BY random() LIMIT 20`);
      for (const shop of renews.rows) {
        try {
          const order = await razorpayOrderStatus(shop.renewal_order_id, OWNER_RAZORPAY_KEY_ID, OWNER_RAZORPAY_KEY_SECRET);
          if (order && order.status === 'paid') {
            await extendShop(shop.id, shop.renewal_order_id, 'RECONCILE');
            console.log('💰 Reconciled renewal:', shop.id);
          }
        } catch(e) { /* next cycle */ }
      }
    }

    // 2b-iii) Advanced unlock reconcile
    if (OWNER_RAZORPAY_KEY_ID && OWNER_RAZORPAY_KEY_SECRET) {
      const advs = await pool.query(
        `SELECT id, advanced_order_id FROM shops WHERE advanced_order_id IS NOT NULL AND advanced_order_id <> '' ORDER BY random() LIMIT 20`);
      for (const shop of advs.rows) {
        try {
          const order = await razorpayOrderStatus(shop.advanced_order_id, OWNER_RAZORPAY_KEY_ID, OWNER_RAZORPAY_KEY_SECRET);
          if (order && order.status === 'paid') {
            await unlockAdvancedByOrder(shop.id, shop.advanced_order_id, '', 'reconcile');
          }
        } catch(e) {}
      }
    }

    // 2b-iv) Add-on (Rs 49) reconcile. Only the webhook covered these, and
    //        the webhook needs RAZORPAY_WEBHOOK_SECRET — without it a closed
    //        page after payment meant money taken and no feature.
    if (OWNER_RAZORPAY_KEY_ID && OWNER_RAZORPAY_KEY_SECRET) {
      const fts = await pool.query(
        `SELECT id, feature_order_id FROM shops WHERE feature_order_id IS NOT NULL AND feature_order_id <> '' ORDER BY random() LIMIT 20`);
      for (const shop of fts.rows) {
        try {
          const order = await razorpayOrderStatus(shop.feature_order_id, OWNER_RAZORPAY_KEY_ID, OWNER_RAZORPAY_KEY_SECRET);
          if (order && order.status === 'paid') {
            const fid = await unlockFeatureByOrder(shop.id, shop.feature_order_id, 'RECONCILE_' + shop.feature_order_id);
            if (fid) console.log('Feature unlocked (reconcile):', shop.id, fid);
          }
        } catch(e) {}
      }
    }

    // 2b-v) Partner licence reconcile. The partner's password is shown only
    //       by the browser's verify, so a licence paid in a page that was
    //       closed is activated here and the super admin sets the password
    //       (Superadmin -> White Label -> Reset password).
    if (OWNER_RAZORPAY_KEY_ID && OWNER_RAZORPAY_KEY_SECRET) {
      const lic = await pool.query(
        `SELECT id, license_order_id, brand_name, license_fee FROM whitelabels
          WHERE paid=false AND license_order_id IS NOT NULL AND license_order_id <> ''
          ORDER BY random() LIMIT 10`);
      for (const w of lic.rows) {
        try {
          const order = await razorpayOrderStatus(w.license_order_id, OWNER_RAZORPAY_KEY_ID, OWNER_RAZORPAY_KEY_SECRET);
          if (order && order.status === 'paid') {
            const up = await pool.query(
              'UPDATE whitelabels SET paid=true, paid_at=NOW() WHERE id=$1 AND paid=false RETURNING id', [w.id]);
            if (up.rows.length) {
              await recordPayment({
                kind: 'wl_license', whitelabelId: w.id, shopName: w.brand_name || '',
                amount: w.license_fee || 0,
                paymentId: 'RECONCILE_' + w.license_order_id, orderId: w.license_order_id,
                note: 'White-label license fee (reconcile)'
              });
              console.log('💰 Reconciled partner licence:', w.id);
            }
          }
        } catch(e) {}
      }
    }

    // 2c) ABANDONED uploads — the customer uploaded but did not complete
    // the payment. These files used to stay on Cloudinary FOREVER
    // (a storage leak + the customer's private file on a server). Now after 60 min
    // the file is deleted + the job is marked abandoned.
    const abandoned = await pool.query(
      `SELECT id, file_public_id FROM print_jobs
       WHERE status='pending' AND payment_status='pending'
         AND created_at < NOW() - INTERVAL '60 minutes'
       LIMIT 20`);
    for (const j of abandoned.rows) {
      if (j.file_public_id) await deleteFromCloudinary(j.file_public_id);
      await pool.query(
        "UPDATE print_jobs SET status='abandoned', file_deleted=true, failure_reason=$1 WHERE id=$2",
        ['The customer did not complete the payment', j.id]);
      console.log('🧹 Abandoned upload cleaned:', j.id);
    }

    // ══════════ SAFETY LAYER 1: VERIFY SWEEP ══════════
    // The job completed/failed/was abandoned but the file_deleted flag is false
    // (meaning the delete call failed silently — network, API error).
    // After 5 min, delete again. Cloudinary destroy is idempotent.
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
    // Every ~10 min: get the REAL list from Cloudinary. Any file older than 90 min
    // that does not belong to an ACTIVE job — delete it. This also catches
    // files that have no DB row at all (uploaded but the insert failed, or the row
    // was deleted) — a DB-based cleanup can never see them.
    _sweepTick++;
    if (_sweepTick % 5 === 0) {
      let cursor = '';
      let swept = 0;
      for (let page = 0; page < 5; page++) {   // max 500 files/cycle
        const { resources, next_cursor } = await listCloudinaryFiles(cursor);
        if (!resources.length) break;
        for (const r of resources) {
          const ageMin = (Date.now() - new Date(r.created_at).getTime()) / 60000;
          if (ageMin < 90) continue;   // a fresh file — someone may still be using it
          // Does it belong to an active job?
          const active = await pool.query(
            `SELECT 1 FROM print_jobs
             WHERE file_public_id=$1 AND status IN ('queued','printing')`, [r.public_id]);
          if (active.rows.length) continue;   // about to be printed — leave it
          await deleteFromCloudinary(r.public_id);
          await pool.query('UPDATE print_jobs SET file_deleted=true WHERE file_public_id=$1', [r.public_id]);
          swept++;
        }
        if (!next_cursor) break;
        cursor = next_cursor;
      }
      if (swept) console.log(`🧹 Cloudinary orphan sweep: ${swept} file(s) deleted`);
    }

    // 3) Clean up old demo shops (after 7 days) — keeps the DB free of junk
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
// The White Label programme: the partner page, and the partner's own dashboard.
app.get('/whitelabel', (req,res) => res.sendFile(path.join(__dirname,'public','whitelabel.html')));
app.get('/partner',    (req,res) => res.redirect(301, '/whitelabel'));
app.get('/wl-admin',   (req,res) => res.sendFile(path.join(__dirname,'public','wl-admin.html')));
app.get('/agent',     (req,res) => res.sendFile(path.join(__dirname,'public','agent.html')));
app.get('/dashboard', (req,res) => res.sendFile(path.join(__dirname,'public','dashboard.html')));
app.get('/admin', (req,res) => res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/superadmin', (req,res) => res.sendFile(path.join(__dirname,'public','superadmin.html')));
app.get('/print-success', (req,res) => res.sendFile(path.join(__dirname,'public','success.html')));

// ═══ SEO: REAL URLs for sub-pages (separate pages + sitelinks in Google) ═══
// index.html is always served, but each URL gets its own title/description/canonical
// injected — only then does Google treat them as separate pages.
// The frontend JS looks at the pathname and opens the matching section.
/* i18n-ignore: <title> and <meta> text for search engines — it is never shown
   inside the page, so it has no Manipuri entry. */
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
// The canonical must always use the real domain (BASE_URL defaults to onrender.com;
// putting that into the canonical would be wrong for SEO)
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
    // If index.html cannot be read, send the plain file (the site must never break)
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
// Old / alternate paths — 301 to the real URL (so link equity is not lost)
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

// Homepage social proof — REAL numbers, 5 min cache
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


/* i18n-ignore: robots.txt is read by crawlers, not by people. */
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

/* i18n-ignore: a plain-text file for security researchers, not page text. */
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

// The order matters: schema -> data -> THEN open the port.
// That way the agent never gets an empty DB.
app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'echel' });
  } catch (_) { res.status(503).json({ status: 'unavailable' }); }
});

initDB().then(() => {
  // Read the automatic-blocking switch once, so the upload path never has to
  // wait on the database to know whether it may block. A failure here is not
  // fatal: the switch simply stays at its safe default, which is on.
  autoBlockEnabled().catch(() => {});
  maintenanceMode().catch(() => {});
  app.listen(PORT, () => {
    console.log(`Echel - Port ${PORT}`);
    console.log(`${BASE_URL}`);
    console.log(`Cloudinary: ${CLOUD_NAME}`);
    console.log(`Payment: Per-shop gateway (Razorpay/Cashfree), Counter always available unless online_only`);
  });
}).catch(() => { process.exitCode = 1; pool.end().finally(() => process.exit(1)); });
