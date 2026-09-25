/* Local, read-only design preview. Never connects to the production database. */
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const { withBrandDefaults }=require('../site-branding');
const { retiredRoute }=require('../echel-edition');
const previewPlans={starter:{fee:599,actual:2999,billingCycle:'lifetime'},pro:{fee:899,actual:2999,billingCycle:'lifetime'},premium:{fee:999,actual:2999,billingCycle:'lifetime'}};
const root=path.resolve(__dirname,'..');
const publicRoot=path.join(root,'public');
const homeRoutes=['/','/about','/contact','/features','/setup-guide','/terms','/privacy','/refund','/disclaimer'];
// The design preview can show the festival offer: open /?festival=1
let previewFestival=false;
// The design preview can show a renewing plan: open /?cycle=monthly
let previewCycle='';
const previewAdvance=[
  {id:'photo4x6',icon:'📷',title:'4×6 Passport Photos',desc:'A sheet of 4, 6, 8 or 10 builds itself and comes out with cutting lines.',isNew:false},
  {id:'resume',icon:'📝',title:'Resume Maker',desc:'The customer builds a resume in one of 6 designs straight from the QR.',isNew:false},
  {id:'bigsize',icon:'📐',title:'A3 / A2 / A1 — Large Sizes',desc:'Maps, project charts and banners, each on its own printer.',isNew:false}
];
const previewWl={id:'WL_1A2B3C4D',slug:'abcprint',brandName:'ABC Print Solutions',ownerName:'Preview Partner',phone:'9000000000',email:'partner@example.com',logoUrl:'',poweredBy:'ABC Print Solutions',supportEmail:'support@abcprint.example',supportPhone:'9000000000',broadcast:'',shopPrice:1299,basePrice:999,razorpayKeyId:'rzp_live_preview',razorpayReady:true,cashfreeAppId:'',cashfreeReady:false,gateway:'razorpay',hpTitle:'',hpSubtitle:'',hpTagline:'',madeIn:'Imphal, Manipur',socialInstagram:'',socialYoutube:'',socialFacebook:'',buttons:{},monthlyPrice:399,minMonthlyPrice:399,buttonKeys:['demo','pricing','agent'],notifyEmail:'partner@example.com',blocked:false,licenseFee:9999,paidAt:'2026-01-09T10:00:00.000Z',stats:{paid:9,pending:1,demo:2,total:12},collected:11691,shareLink:'https://abcprint.echel.in'};
const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpeg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.mp3':'audio/mpeg'};
http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  const send=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(retiredRoute(u.pathname))return send({error:'Page not found'},404);
  if(req.method!=='GET')return send({error:'Read-only design preview. Live accounts and payments are disabled.'},405);
  if(u.pathname.startsWith('/api/')){
    if(u.pathname==='/api/homepage-config'||u.pathname==='/api/superadmin/homepage-config')return send(withBrandDefaults());
    if(u.pathname==='/api/whitelabel/license-fee')return send({licenseFee:9999,licenseActual:24999,basePrice:999});
    if(u.pathname==='/api/whitelabel/me')return send(previewWl);
    if(u.pathname==='/api/whitelabel/shops')return send({shops:[{id:'SHOP_PRV001',name:'Sharma Cyber Cafe',phone:'9000000001',address:'Main Road',demo:false,setup_paid:true,setup_amount:1299,plan_type:'onetime',created_at:'2026-02-01T09:00:00.000Z'},{id:'SHOP_PRV002',name:'City Xerox Point',phone:'9000000002',address:'Bazar Lane',demo:false,setup_paid:false,setup_amount:1299,plan_type:'onetime',created_at:'2026-03-04T09:00:00.000Z'}]});
    if(u.pathname==='/api/whitelabel/analytics')return send({slug:'abcprint',days:30,daily:[],totals:{visits:240,shops:12,paid:9},top:[]});
    if(u.pathname==='/api/captcha')return send({enabled:false});
    if(u.pathname==='/api/superadmin/maintenance')return send({enabled:false,updatedAt:null});
    if(u.pathname==='/api/superadmin/security-events')return send({events:[
      {id:1,created_at:'2026-09-23T05:10:00.000Z',ip:'103.21.44.9',shop_id:'SHOP_PREVIEW',endpoint:'/api/upload',method:'POST',action:'PDF_UPLOAD',reason:'UPLOAD_BURST',upload_count:7},
      {id:2,created_at:'2026-09-23T04:02:00.000Z',ip:'49.37.12.5',shop_id:'',endpoint:'/api/demo/request',method:'POST',action:'DEMO_REQUEST',reason:'IP_RATE_LIMIT',upload_count:null}
    ],last24h:{total:2,ips:2,rate_limited:1,bursts:1,captcha_fails:0},autoBlock:false,
      suggestions:[{key:'shop:SHOP_PREVIEW',reason:'upload burst',times:3,minutesAgo:12}],
      activeBlocks:[],globalBrake:{tripped:false},config:{turnstile:false}});
    if(u.pathname==='/api/superadmin/ip-bans')return send({bans:[],worst:[],autoLimit:5,windowDays:1});
    if(u.pathname==='/api/superadmin/customer-bans')return send({bans:[],worst:[],autoHits:6});
    // The Advance Feature tab asks for this list the moment it opens.
    if(u.pathname==='/api/advance-features'||u.pathname==='/api/superadmin/advance-features')return send({features:previewAdvance});
    if(u.pathname==='/api/superadmin/migration/report')return send({server:{baseUrl:'http://localhost:3100',node:process.version,platform:process.platform,uptimeSeconds:120},database:{host:'db.example.internal',name:'echel',tables:{shops:12,print_jobs:340},totalRows:352},storage:{cloudName:'echel'},settings:require('../migration').envReport({DATABASE_URL:'postgresql://localhost/echel',JWT_SECRET:'x'.repeat(40),SUPER_ADMIN_ID:'admin',SUPER_ADMIN_PASSWORD:'secret',BASE_URL:'http://localhost:3100',CLOUDINARY_CLOUD_NAME:'echel',CLOUDINARY_API_KEY:'k',CLOUDINARY_API_SECRET:'s'}),missing:[]});
    if(u.pathname==='/api/superadmin/db-counts')return send({shops:12,print_jobs:340,translations:8});
    if(u.pathname==='/api/shop/SHOP_PREVIEW')return send({id:'SHOP_PREVIEW',name:'Preview Print Shop',setup_paid:true,active:true,price_bw:2,price_color:10,price_4x6_4:30,price_4x6_6:40,plan:'premium',advanced_enabled:true,payment_mode:'counter',online:true});
    if(u.pathname==='/api/whitelabel/branding')return send({isWhitelabel:false});
    if(u.pathname==='/api/captcha')return send({enabled:false});
    if(u.pathname==='/api/public-stats')return send({shops:0,prints:0});
    if(u.pathname==='/api/demo/config')return send({enabled:true,minutes:1440,printLimit:10});
    // ?festival=1 turns the offer on, so the banner and timer can be looked at.
    if(u.pathname==='/api/setup-fee/current'||u.pathname==='/api/superadmin/setup-fee'){
      const fest=u.searchParams.get('festival')==='1'||previewFestival;
      // /?cycle=monthly shows every plan as it looks when it renews.
      const plans=previewCycle?Object.fromEntries(Object.entries(previewPlans).map(([k,v])=>[k,{...v,billingCycle:previewCycle}])):previewPlans;
      return send({amount:999,offerPrice:999,actualPrice:2999,plans,monthlyFee:399,advancedFee:199,
        wlLicenseFee:9999,wlLicenseActual:24999,wlBasePrice:0,wlBasePriceEffective:599,
        festivalOfferEnabled:fest,festivalOfferName:fest?'Diwali Offer':'',
        festivalOfferEnd:fest?new Date(Date.now()+2*86400000+3600000).toISOString().slice(0,16):''});
    }
    if(u.pathname.startsWith('/api/setup-status/')||u.pathname.startsWith('/api/setup-fee/amount/'))return send({paid:false,amount:999,plan:'premium'});
    if(u.pathname==='/api/reviews')return send({reviews:[],average:0,total:0});
    if(u.pathname==='/api/i18n')return send({langs:{en:'English','mni-mtei':'ꯃꯤꯇꯩꯂꯣꯟ'},source:'en'});
    if(u.pathname==='/api/i18n/dict')return send({dict:{}});
    return send({error:'API requires the configured application server.'},503);
  }
  if(u.searchParams.get('festival')==='1')previewFestival=true;
  if(u.searchParams.has('cycle'))previewCycle=u.searchParams.get('cycle')||'';
  let name=homeRoutes.includes(u.pathname)?'index.html':u.pathname.slice(1);
  if(u.pathname==='/preview/superadmin')name='superadmin.html';
  if(u.pathname==='/whitelabel'||u.pathname==='/partner')name='whitelabel.html';
  if(u.pathname==='/wl-admin'||u.pathname==='/preview/partner')name='wl-admin.html';
  if(u.pathname==='/preview/owner')name='admin.html';
  if(u.pathname.startsWith('/print/'))name='customer.html';
  // The resume maker lives at /resume/<shop id> on the real server.
  if(u.pathname==='/resume'||u.pathname.startsWith('/resume/'))name='resume.html';
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
    // The partner dashboard normally needs a signed-in partner; here the panel is
    // simply opened against the sample partner above.
    if(u.pathname==='/preview/partner')preview='<script>document.addEventListener("DOMContentLoaded",()=>{TOKEN="preview";boot();setTimeout(()=>navTo(new URLSearchParams(location.search).get("sect")||"overview"),120);});</script>';
    data=Buffer.from(html.replace('</body>',banner+preview+'</body>'));
  }
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);
}).listen(3100,'127.0.0.1',()=>console.log('Echel read-only preview: http://localhost:3100'));
