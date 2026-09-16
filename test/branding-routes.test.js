const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const branding=require('../site-branding');
const source=fs.readFileSync(require.resolve('../server.js'),'utf8');
function fixture(initial){
 let saved=initial?JSON.stringify(initial):null,writes=0;
 const routes={},guard=()=>{};
 const app={get:(route,...handlers)=>routes['GET '+route]=handlers,put:(route,...handlers)=>routes['PUT '+route]=handlers};
 const pool={query:async(sql,args)=>{
  if(sql.startsWith('SELECT'))return {rows:saved?[{value:saved}]:[]};
  assert.match(sql,/ON CONFLICT \(key\) DO UPDATE/);saved=args[0];writes++;return {rowCount:1};
 }};
 const ctx=vm.createContext({...branding,app,pool,verifySuperAdmin:guard,_hpCfgCache:{t:0,data:null}});
 const start=source.indexOf("app.get('/api/superadmin/homepage-config'");
 const end=source.indexOf("app.post('/api/superadmin/upload-logo'",start);
 vm.runInContext(source.slice(start,end),ctx);
 const pub=source.indexOf("app.get('/api/homepage-config'");
 vm.runInContext(source.slice(pub,source.indexOf("app.get('/api/public-stats'",pub)),ctx);
 return {guard,routes,get writes(){return writes;},get saved(){return JSON.parse(saved);},async call(method,route,body={}){
  const res={statusCode:200,status(n){this.statusCode=n;return this;},json(data){this.data=JSON.parse(JSON.stringify(data));return this;}};
  await routes[method+' '+route].at(-1)({body},res);return res;
 }};
}
test('both configuration management routes retain Superadmin authentication',()=>{
 const f=fixture();for(const method of ['GET','PUT'])assert.equal(f.routes[method+' /api/superadmin/homepage-config'][0],f.guard);
});
test('authenticated save round-trips all new settings through the public route',async()=>{
 const f=fixture({planStarter:['Keep existing print feature'],supportEmail:'old@example.com'});
 const data={brandName:'Echel Client',supportEmail:'support@example.com',supportPhone:'+91 9876543210',whatsapp:'+91 9123456780',address:'Test business address',linkedin:'https://linkedin.com/company/example',mapsUrl:'https://maps.google.com/?q=example',businessHours:'Mon–Sat, 9–6'};
 const save=await f.call('PUT','/api/superadmin/homepage-config',data);assert.equal(save.statusCode,200);assert.equal(save.data.success,true);
 const read=await f.call('GET','/api/homepage-config');for(const [k,v]of Object.entries(data))assert.equal(read.data[k],v);
 assert.deepEqual(read.data.planStarter,['Keep existing print feature']);
});
test('clearing settings invalidates the public cache and persists empty fields',async()=>{
 const f=fixture({supportEmail:'old@example.com',instagram:'https://instagram.com/old'});
 await f.call('GET','/api/homepage-config');await f.call('PUT','/api/superadmin/homepage-config',{supportEmail:'',instagram:''});
 const read=await f.call('GET','/api/homepage-config');assert.equal(read.data.supportEmail,'');assert.equal(read.data.instagram,'');
});
test('invalid branding fails without writing and empty databases can be configured',async()=>{
 const f=fixture();const bad=await f.call('PUT','/api/superadmin/homepage-config',{linkedin:'javascript:alert(1)'});assert.equal(bad.statusCode,400);assert.equal(f.writes,0);
 const good=await f.call('PUT','/api/superadmin/homepage-config',{brandName:'Echel'});assert.equal(good.data.success,true);assert.equal(f.saved.brandName,'Echel');
});
