const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
test('English-only Echel desktop keeps printer, connection and paid-shop bridge actions',async()=>{
  const html=fs.readFileSync(require.resolve('../agent_panel.html'),'utf8');
  const dom=new JSDOM(html,{url:'http://localhost/desktop-preview',runScripts:'outside-only'});
  const w=dom.window,calls=[];
  let state={ok:true,shopId:'SHOP_TEST',shopName:'Test shop',shopType:'demo',connection:'online',version:'2.8',printerBw:'Mono',printerColor:'Colour',printersKnown:true};
  w.pywebview={api:{
    get_state:async()=>state,get_printers:async()=>({ok:true,printers:['Mono','Colour']}),
    save_printers:async(bw,color)=>{calls.push(['save',bw,color]);state={...state,printerBw:bw,printerColor:color};return {ok:true};},
    open_url:async url=>{calls.push(['open',url]);return {ok:true};},
    verify_paid_shop:async(id,pw)=>{calls.push(['verify',id,pw]);return {ok:true,shopId:id,shopName:'Paid Shop',planType:'premium'};},
    convert_to_paid:async()=>{state={...state,shopType:'paid'};return {ok:true,shopId:'SHOP_PAID',shopName:'Paid Shop'};}
  }};
  try{
    for(const s of w.document.scripts) if(!s.src)w.eval(s.textContent);
    await w.boot();
    assert.equal(w.document.getElementById('vName').textContent,'Test shop');
    assert.equal(w.document.getElementById('selBw').value,'Mono');
    await w.doSave();assert.deepEqual(calls[0],['save','Mono','Colour']);
    assert.match(w.document.getElementById('toastMsg').textContent,/saved/);
    w.openSite({preventDefault(){}});assert.deepEqual(calls[1],['open','/']);
    w.go('upgrade');
    w.document.getElementById('upId').value='SHOP_PAID';w.document.getElementById('upPw').value='test-password';
    await w.upVerify();assert.match(w.document.getElementById('upBody').textContent,/Shop verified/);
    await w.upSwitch();assert.match(w.document.getElementById('upBody').textContent,/You’re connected/);
    assert.equal(w.document.querySelectorAll('[data-i18n-select],.qsp-lang-sel').length,0);
    assert.equal(w.QSPi18n,undefined);
    assert.doesNotMatch(w.document.body.textContent.replace(/var PANEL_EN[\s\S]*/,''), /[\uABC0-\uABFF\u0900-\u097F]/);
  }finally{dom.window.close();}
});
