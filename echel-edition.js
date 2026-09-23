'use strict';

// Retired client-edition routes return 404 before static files or legacy handlers run.
// Existing records remain intact; this module does not migrate or delete data.
function retiredRoute(path) {
  return /^\/migrate(?:\.html)?\/?$/i.test(path)
    || ['/api/whatsapp-interest', '/api/superadmin/migrate-db'].includes(path)
    || /^\/i18n\/(?:ta|te|kn|bn|mni|hin)\.js$/.test(path);
}

module.exports = { retiredRoute };
