const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {retiredRoute}=require('../echel-edition');
test('retired products and other language bundles are unavailable',()=>{
  for(const route of ['/whitelabel','/whitelabel.html','/wl-admin','/migrate','/partner','/api/whitelabel/branding','/api/superadmin/whitelabels','/api/superadmin/migrate-db','/i18n/bn.js','/i18n/ta.js'])assert.equal(retiredRoute(route),true,route);
  for(const route of ['/','/about','/setup-guide','/api/homepage-config','/i18n/mni-mtei.js'])assert.equal(retiredRoute(route),false,route);
});
test('each public page loads the language engine before its dictionaries',()=>{
  const root=path.join(__dirname,'../public');
  for(const file of fs.readdirSync(root).filter(f=>f.endsWith('.html'))){
    const html=fs.readFileSync(path.join(root,file),'utf8');
    const sources=[...html.matchAll(/<script\s+src="([^"]+)"[^>]*>/g)].map(m=>m[1]);
    const order=['/i18n.js','/i18n-extra.js','/i18n/mni-mtei.js','/echel-english.js','/echel-mayek.js'].map(s=>sources.indexOf(s));
    assert.ok(order[0]>=0&&order.every((n,i)=>!i||n>order[i-1]),file);
  }
});
