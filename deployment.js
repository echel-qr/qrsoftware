'use strict';

function deploymentConfig(env = process.env) {
  const baseUrl = (env.BASE_URL || env.RENDER_EXTERNAL_URL || 'http://localhost:' + (env.PORT || 3000)).replace(/\/+$/, '');
  const parsed = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('BASE_URL must be an HTTP(S) origin.');
  if (env.NODE_ENV === 'production') {
    for (const key of ['DATABASE_URL', 'JWT_SECRET', 'SUPER_ADMIN_ID', 'SUPER_ADMIN_PASSWORD']) {
      if (!env[key]) throw new Error('Missing required environment variable: ' + key);
    }
    if (env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters.');
  }
  return { baseUrl, siteUrl: (env.SITE_URL || baseUrl).replace(/\/+$/, '') };
}

function databaseOptions(env = process.env) {
  const url = new URL(env.DATABASE_URL || 'postgresql://localhost/echel');
  // pg's URL parser can override the explicit TLS configuration through sslmode.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return {
    connectionString: url.toString(),
    ssl: local && env.NODE_ENV !== 'production' ? false : {
      rejectUnauthorized: true,
      ...(env.DATABASE_SSL_CA ? { ca: env.DATABASE_SSL_CA.replace(/\\n/g, '\n') } : {})
    },
    max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000,
    application_name: 'echel'
  };
}

// Echel never lists or deletes the original business's Cloudinary objects.
const UPLOAD_PREFIX = 'echel/jobs/';
const BRAND_PREFIX = 'echel/branding/';
function isJobAsset(id) {
  return typeof id === 'string' && /^echel\/jobs\/[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9]+)?$/.test(id);
}
const APP_TABLES = ['shops', 'system_settings', 'print_jobs', 'whatsapp_interest', 'upload_fingerprints', 'security_events', 'demo_registrations', 'demo_machines', 'blocked_ips', 'blocked_customers', 'agent_commissions', 'platform_payments', 'translations', 'reviews', 'whitelabels', 'analytics_events', 'withdrawals'];
async function protectAppTables(db) {
  // Access goes through Express authentication. Supabase browser roles get no table access.
  for (const table of APP_TABLES) await db.query('ALTER TABLE public."' + table + '" ENABLE ROW LEVEL SECURITY');
  const roles = await db.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')");
  for (const { rolname } of roles.rows) {
    await db.query('REVOKE ALL ON TABLE ' + APP_TABLES.map(t => 'public."' + t + '"').join(',') + ' FROM "' + rolname + '"');
  }
}
module.exports = { deploymentConfig, databaseOptions, UPLOAD_PREFIX, BRAND_PREFIX, isJobAsset, APP_TABLES, protectAppTables };
