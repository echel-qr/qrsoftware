(() => {
  const tabs=[...document.querySelectorAll('[data-ec-stage]')];
  const select=tab=>{
    tabs.forEach(item=>{
      const active=item===tab;item.setAttribute('aria-selected',String(active));item.tabIndex=active?0:-1;
      document.getElementById(item.getAttribute('aria-controls')).hidden=!active;
    });
  };
  tabs.forEach((tab,index)=>{
    tab.addEventListener('click',()=>select(tab));
    tab.addEventListener('keydown',event=>{
      let next;if(event.key==='ArrowRight'||event.key==='ArrowDown')next=(index+1)%tabs.length;
      if(event.key==='ArrowLeft'||event.key==='ArrowUp')next=(index+tabs.length-1)%tabs.length;
      if(event.key==='Home')next=0;if(event.key==='End')next=tabs.length-1;
      if(next!==undefined){event.preventDefault();select(tabs[next]);tabs[next].focus();}
    });
  });
  document.addEventListener('echel:branding',event=>{
    const video=document.querySelector('.ec-video-block');
    if(video)video.hidden=!event.detail.setupVideoUrl;
  });
  // The legacy route container overlays the homepage. Keep its background out
  // of keyboard navigation and the accessibility tree while a page is open.
  const routeVisibility=()=>{
    const active=document.querySelector('.legal-page.open');
    for(const node of document.body.children){
      if(['SCRIPT','STYLE','LINK'].includes(node.tagName)||node.querySelector('#langSel')||node.classList.contains('qsp-lang-sel'))continue;
      if(node.classList.contains('legal-page'))node.inert=!!active&&node!==active;
      else if(node.matches('main,header,.refer-strip,.ft,.footer,.echel-contact-footer'))node.inert=!!active;
    }
    if(active){
      const names={setupGuidePage:'How to Set Up',aboutPage:'About Us',disclaimerPage:'Declaration',featurePage:'Features',contactPage:'Contact Us'};
      if(names[active.id])document.title=names[active.id]+' | Echel';
    }
  };
  document.querySelectorAll('.legal-page').forEach(page=>new MutationObserver(routeVisibility).observe(page,{attributes:true,attributeFilter:['class']}));
  routeVisibility();
})();
