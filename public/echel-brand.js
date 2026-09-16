/* Public branding only. Authentication, orders and gateway code stay in their pages. */
(() => {
  'use strict';
  const defaults = { brandName:'Echel', tagline:'Smart printing. Simply connected.', logoUrl:'/img/echel-logo.jpeg' };
  const safeUrl = (v, local=false) => {
    if (!v) return '';
    if (local && /^\/(?!\/)/.test(v)) return v;
    try { const u=new URL(v); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : ''; } catch (_) { return ''; }
  };
  const digits = v => { const n=String(v||'').replace(/\D/g,''); return n.length===10?'91'+n:n; };
  let cfg = defaults;
  let tenant = null;
  let pending = false;
  window.echelConfig = defaults;
  window.echelSupport = () => digits(tenant ? tenant.supportPhone : cfg.whatsapp || cfg.supportPhone);
  window.echelSupportEmail = () => (tenant ? tenant.supportEmail : cfg.supportEmail) || '';
  window.echelSetTenant = value => { tenant=value; apply(cfg); };
  const brandMarkup = (node, c) => {
    const name=c.brandName||'Echel', logo=safeUrl(c.logoUrl,true)||defaults.logoUrl;
    if (node.dataset.brandSignature === name+'|'+logo) return;
    node.replaceChildren();
    const img=document.createElement('img');img.src=logo;img.alt='';img.width=42;img.height=42;
    img.onerror=()=>{img.onerror=null;img.src=defaults.logoUrl;};
    const word=document.createElement('span');word.textContent=name;
    const small=document.createElement('small');small.textContent='PRINT CONNECT';word.append(small);
    node.append(img,word);node.classList.add('echel-brand');node.dataset.brandSignature=name+'|'+logo;
  };
  function apply(c) {
    cfg={...defaults,...c};window.echelConfig=cfg;
    const effective=tenant?{...cfg,...tenant}:cfg;
    document.querySelectorAll('[data-echel-brand]').forEach(el=>brandMarkup(el,effective));
    document.querySelectorAll('[data-echel-logo]').forEach(el=>{el.src=safeUrl(effective.logoUrl,true)||defaults.logoUrl;});
    document.querySelectorAll('[data-echel-name]').forEach(el=>{el.textContent=effective.brandName||'Echel';});
    document.querySelectorAll('[data-echel-tagline]').forEach(el=>{el.textContent=effective.tagline||defaults.tagline;});
    const stats=document.querySelector('.hero-stats');if(stats)stats.hidden=cfg.showStats===false;
    const phone=effective.supportPhone||'',wa=window.echelSupport(),email=window.echelSupportEmail();
    const links={ email:email?['mailto:'+email,email]:null, phone:phone?['tel:'+phone,phone]:null,
      whatsapp:wa?['https://wa.me/'+wa,'WhatsApp']:null };
    for(const [key,label] of Object.entries({instagram:'Instagram',facebook:'Facebook',youtube:'YouTube',linkedin:'LinkedIn',twitter:'X',telegram:'Telegram',mapsUrl:'Get directions'})) {
      const u=safeUrl(effective[key]);links[key]=u?[u,label]:null;
    }
    document.querySelectorAll('[data-echel-contact]').forEach(el=>{
      const entry=links[el.dataset.echelContact];
      el.hidden=!entry;
      if (entry) {el.href=entry[0]; if(!el.dataset.echelKeepLabel)el.textContent=entry[1];el.removeAttribute('aria-disabled');}
      else {el.removeAttribute('href');el.setAttribute('aria-disabled','true');}
    });
    document.querySelectorAll('[data-echel-address]').forEach(el=>{el.textContent=effective.address||'';el.hidden=!effective.address;});
    document.querySelectorAll('[data-echel-hours]').forEach(el=>{el.textContent=effective.businessHours||'';el.hidden=!effective.businessHours;});
    const setText=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value||'Contact details coming soon';};
    setText('ctWaTxt',wa?'+'+wa:'');setText('ctTelTxt',phone);setText('ctMailTxt',email);
    document.querySelectorAll('[data-echel-support-button]').forEach(el=>{el.disabled=!wa;el.title=wa?'Contact support':'Support contact has not been added yet';});
    const video=safeUrl(effective.setupVideoUrl);
    let embed='';
    if(video){const u=new URL(video);const id=u.hostname==='youtu.be'?u.pathname.slice(1):u.searchParams.get('v')||u.pathname.split('/').pop();if(/^[\w-]{11}$/.test(id))embed='https://www.youtube-nocookie.com/embed/'+id+'?rel=0';}
    document.querySelectorAll('[data-echel-video]').forEach(el=>{if(embed&&el.getAttribute('src')!==embed)el.src=embed;el.hidden=!embed;const wrap=el.closest('.guide-video-sec,.gv-mini-frame');if(wrap)wrap.hidden=!embed;});
    document.dispatchEvent(new CustomEvent('echel:branding',{detail:effective}));
  }
  async function refresh() {
    if(pending)return;pending=true;
    try {const r=await fetch('/api/homepage-config',{cache:'no-store'});if(r.ok)apply(await r.json());}catch(_){/* Keep the last known public settings during a network outage. */}
    finally{pending=false;}
  }
  function init() {
    document.querySelectorAll('#brandWrap, nav>.logo, .topbar>.brand, .login-brand, .echel-login-story>.brand').forEach(el=>el.setAttribute('data-echel-brand',''));
    const foot=document.createElement('footer');foot.className='echel-contact-footer';foot.setAttribute('aria-label','Echel contact information');
    foot.innerHTML='<strong><span data-echel-name>Echel</span> · <span data-echel-tagline>Smart printing. Simply connected.</span></strong>'+['email','phone','whatsapp','instagram','facebook','youtube','linkedin','twitter','telegram','mapsUrl'].map(k=>'<a data-echel-contact="'+k+'" hidden rel="noopener noreferrer"></a>').join('')+'<address data-echel-address hidden></address><span data-echel-hours hidden></span>';
    if(!document.body.classList.contains('echel-resume'))document.body.append(foot);
    apply(defaults);refresh();
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
    window.addEventListener('focus',refresh);
    setInterval(()=>{if(!document.hidden)refresh();},60000);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
