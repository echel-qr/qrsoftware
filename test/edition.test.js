const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {retiredRoute}=require('../echel-edition');
test('retired products and other language bundles are unavailable',()=>{
  for(const route of ['/migrate','/migrate.html','/api/superadmin/migrate-db','/api/whatsapp-interest','/i18n/bn.js','/i18n/ta.js'])assert.equal(retiredRoute(route),true,route);
  // The White Label programme is part of this edition again: the partner page,
  // the partner's dashboard and every endpoint behind them have to answer.
  for(const route of ['/whitelabel','/whitelabel.html','/wl-admin','/partner','/api/whitelabel/branding','/api/whitelabel/license-fee','/api/superadmin/whitelabels'])assert.equal(retiredRoute(route),false,route);
  for(const route of ['/','/about','/setup-guide','/api/homepage-config','/i18n/mni-mtei.js'])assert.equal(retiredRoute(route),false,route);
});
test('every public page loads the language engine, and nothing else',()=>{
  const root=path.join(__dirname,'../public');
  const gone=['/i18n-extra.js','/echel-english.js','/echel-mayek.js','/i18n/mni-mtei.js'];
  for(const file of fs.readdirSync(root).filter(f=>f.endsWith('.html'))){
    const html=fs.readFileSync(path.join(root,file),'utf8');
    const sources=[...html.matchAll(/<script\s+src="([^"]+)"[^>]*>/g)].map(m=>m[1]);
    assert.ok(sources.includes('/i18n.js'),file+' must load /i18n.js');
    // The Manipuri dictionary is downloaded by the engine only when a visitor
    // picks Manipuri — a page that loads it directly would cost every English
    // visitor the download.
    for(const old of gone)assert.ok(!sources.includes(old),file+' must not load '+old);
  }
});
