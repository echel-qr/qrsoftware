/* Local, read-only design preview. Never connects to the production database. */
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const { withBrandDefaults }=require('../site-branding');
const { retiredRoute }=require('../echel-edition');
const previewPlans={starter:{fee:599,actual:2999,billingCycle:'lifetime'},pro:{fee:899,actual:2999,billingCycle:'lifetime'},premium:{fee:999,actual:2999,billingCycle:'lifetime'}};
const root=path.resolve(__dirname,'..');
const publicRoot=path.join(root,'public');
const homeRoutes=['/','/about','/contact','/features','/setup-guide','/partner','/terms','/privacy','/refund','/disclaimer'];
const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpeg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.mp3':'audio/mpeg'};
http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  const send=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(retiredRoute(u.pathname))return send({error:'Page not found'},404);
  if(req.method!=='GET')return send({error:'Read-only design preview. Live accounts and payments are disabled.'},405);
  if(u.pathname.startsWith('/api/')){
    if(u.pathname==='/api/homepage-config'||u.pathname==='/api/superadmin/homepage-config')return send(withBrandDefaults());
    if(u.pathname==='/api/shop/SHOP_PREVIEW')return send({id:'SHOP_PREVIEW',name:'Preview Print Shop',setup_paid:true,active:true,price_bw:2,price_color:10,price_4x6_4:30,price_4x6_6:40,plan:'premium',advanced_enabled:true,payment_mode:'counter',online:true});
    if(u.pathname==='/api/whitelabel/branding')return send({isWhitelabel:false});
    if(u.pathname==='/api/captcha')return send({enabled:false});
    if(u.pathname==='/api/public-stats')return send({shops:0,prints:0});
    if(u.pathname==='/api/demo/config')return send({enabled:true,minutes:1440,printLimit:10});
    if(u.pathname==='/api/setup-fee/current'||u.pathname==='/api/superadmin/setup-fee')return send({amount:999,offerPrice:999,actualPrice:2999,plans:previewPlans,monthlyFee:399,advancedFee:199});
    if(u.pathname.startsWith('/api/setup-status/')||u.pathname.startsWith('/api/setup-fee/amount/'))return send({paid:false,amount:999,plan:'premium'});
    if(u.pathname==='/api/reviews')return send({reviews:[],average:0,total:0});
    if(u.pathname==='/api/i18n')return send({langs:{en:'English','mni-mtei':'ꯃꯤꯇꯩꯂꯣꯟ'},source:'en'});
    if(u.pathname==='/api/i18n/dict')return send({dict:{}});
    return send({error:'API requires the configured application server.'},503);
  }
  let name=homeRoutes.includes(u.pathname)?'index.html':u.pathname.slice(1);
  if(u.pathname==='/preview/superadmin')name='superadmin.html';
  if(u.pathname==='/preview/owner')name='admin.html';
  if(u.pathname.startsWith('/print/'))name='customer.html';
  if(!path.extname(name))name+='.html';
  const file=u.pathname==='/desktop-preview'?path.join(root,'agent_panel.html'):path.resolve(publicRoot,name);
  if(!file.startsWith(publicRoot+path.sep)&&file!==path.join(root,'agent_panel.html'))return send({error:'Not found'},404);
  if(!fs.existsSync(file))return send({error:'Not found'},404);
  let data=fs.readFileSync(file);
  if(file.endsWith('.html')){
    let html=data.toString();
    const banner='<div style="position:fixed;bottom:10px;right:10px;z-index:99999;background:#25282c;color:#fff;padding:7px 12px;border-radius:6px;font:10px Segoe UI;pointer-events:none">LOCAL DESIGN PREVIEW · LIVE ACTIONS DISABLED</div>';
    let preview='';
    if(u.pathname==='/preview/superadmin')preview='<script>document.addEventListener("DOMContentLoaded",()=>{document.getElementById("loginScreen").classList.add("hidden");document.getElementById("panel").classList.remove("hidden");organizeSections();navTo("homepage");loadHomepageConfig();});</script>';
    if(u.pathname==='/preview/owner')preview='<script>document.addEventListener("DOMContentLoaded",()=>{document.getElementById("loginScreen").classList.add("hidden");document.getElementById("adminPanel").classList.remove("hidden");navTo(new URLSearchParams(location.search).get("sect")||"overview");});</script>';
    data=Buffer.from(html.replace('</body>',banner+preview+'</body>'));
  }
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);
}).listen(3100,'127.0.0.1',()=>console.log('Echel read-only preview: http://localhost:3100'));
