/* Echel owner workspace. Existing controls are moved, never copied: their IDs,
   event handlers and authenticated API behaviour remain the source of truth. */
(() => {
  'use strict';
  const init = () => {
    const panel = document.getElementById('adminPanel');
    if (!panel || panel.dataset.workspaceReady) return;
    panel.dataset.workspaceReady = '1';
    const side = document.getElementById('sideNav');
    const masthead = document.createElement('header');
    masthead.className = 'owner-masthead';
    const identity = document.createElement('div'); identity.className = 'owner-identity';
    identity.append(side.querySelector('.side-brand'), side.querySelector('.side-shop'));
    masthead.append(identity, side.querySelector('.side-foot'));
    panel.prepend(masthead);
    side.setAttribute('aria-label', 'Shop navigation');
    const nav = document.createElement('div'); nav.className = 'owner-navigation';
    const order = ['overview','orders','qr','settings','payment','custlang','advance','agent','support','account'];
    order.forEach(key => { const button = side.querySelector('[data-nav="'+key+'"]'); if (button) nav.append(button); });
    side.prepend(nav);
    // Retired features have no entry points in this client edition.
    side.querySelectorAll('[data-nav="review"],.side-help').forEach(el=>el.remove());
    side.querySelectorAll('.ico').forEach(el=>el.remove());
    const account = side.querySelector('[data-nav="account"]');
    account.style.marginTop = ''; account.classList.add('owner-account');
    const toggle = panel.querySelector('.hamburger');
    toggle.setAttribute('aria-label','Open navigation');
    toggle.setAttribute('aria-controls','sideNav');
    const close = document.createElement('button');
    close.type='button'; close.className='owner-close'; close.textContent='Close navigation';
    close.addEventListener('click',()=>{window.closeSide();toggle.focus();}); side.prepend(close);
    document.addEventListener('keydown', e => { if (e.key==='Escape' && side.classList.contains('open')) { window.closeSide(); toggle.focus(); } });
    new MutationObserver(()=>toggle.setAttribute('aria-expanded',String(side.classList.contains('open')))).observe(side,{attributes:true,attributeFilter:['class']});
    toggle.setAttribute('aria-expanded','false');
    const overview = panel.querySelector('[data-sect="overview"]');
    const stats = overview.querySelector('.stats'); stats.classList.add('owner-metrics');
    const shop = document.getElementById('pauseBtn').closest('.card'); shop.classList.add('owner-shop-control');
    const notice = document.getElementById('noticeInput').closest('.card'); notice.classList.add('owner-notice');
    const week = document.getElementById('bkRows').closest('.card'); week.classList.add('owner-week');
    const insights = document.getElementById('peakHour').closest('.stats'); insights.classList.add('owner-insights');
    const download = overview.querySelector('.dlCard'); download.classList.add('owner-software');
    const work = document.createElement('div'); work.className='owner-work-grid';
    const main = document.createElement('div'); main.className='owner-main-column';
    const rail = document.createElement('div'); rail.className='owner-rail';
    const quick = document.createElement('section'); quick.className='owner-quick';
    quick.innerHTML='<div class="owner-eyebrow">YOUR DAILY WORKSPACE</div><h2>A good day starts here.</h2><p>Orders, print settings and your shop. All in one place.</p><div class="owner-quick-links"><button type="button" data-owner-nav="orders"><span>View orders</span><span aria-hidden="true">↗</span></button><button type="button" data-owner-nav="qr"><span>Shop QR & downloads</span><span aria-hidden="true">↗</span></button><button type="button" data-owner-nav="settings"><span>Manage print settings</span><span aria-hidden="true">↗</span></button></div>';
    quick.querySelectorAll('[data-owner-nav]').forEach(button=>button.addEventListener('click',()=>window.navTo(button.dataset.ownerNav)));
    main.append(quick, week, insights); rail.append(shop, download, notice); work.append(main,rail);
    overview.prepend(stats,work);
    // Keep account notices before the daily workspace when the server shows them.
    ['agentBanner','adminBroadcastCard','demoUpgradeCard','demoSupportCard','subBanner'].reverse().forEach(id=>{const el=document.getElementById(id);if(el)overview.prepend(el);});
    const help = document.querySelector('#loginScreen .help-text a');
    help.setAttribute('role','button'); help.setAttribute('tabindex','0');
    help.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();window.showSetPassword();}});
    const password = document.getElementById('loginPassword');
    document.getElementById('ownerShowPassword').addEventListener('change',e=>{password.type=e.target.checked?'text':'password';});
    [document.getElementById('loginShopId'),password].forEach(el=>el.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();window.doLogin();}}));
    document.getElementById('loginErr').setAttribute('role','alert');
    document.getElementById('spErr').setAttribute('role','alert');
    // Names supplied by the shop and credentials must never be translated.
    document.getElementById('adminShopName').setAttribute('data-no-i18n','');
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
