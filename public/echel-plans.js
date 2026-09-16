/* Shared public plan content. The server remains authoritative for charged prices. */
(() => {
  const names=['Demo','Starter','Pro','Premium'];
  let config=null,pricing=null;
  const tr=s=>window.QSPi18n?.t(s)||s;
  function render(){
    const manipuri=window.QSPi18n?.getLang()==='mni-mtei';
    names.forEach(name=>{
      const list=config?.['plan'+name+(manipuri?'Mtei':'')];
      const fallback=config?.['plan'+name];
      const lines=manipuri&&(!Array.isArray(list)||!list.length)?fallback:list;
      if(Array.isArray(lines))for(const id of ['plan'+name+'List','feat'+name]){
        const el=document.getElementById(id);if(!el)continue;
        const signature=JSON.stringify([lines,manipuri]);if(el.dataset.echelFeatures===signature)continue;
        el.replaceChildren();
        lines.forEach(line=>{const row=document.createElement(el.tagName==='UL'?'li':'div');row.textContent='✅ '+tr(line.replace(/^✅\s*/,''));el.append(row);});
        el.dataset.echelFeatures=signature;
      }
      const plan=pricing?.[name.toLowerCase()];if(!plan)return;
      const label={monthly:'Monthly · renew every month',quarterly:'Quarterly · renew every 3 months',yearly:'Yearly · renew every year',lifetime:'Lifetime · one-time payment'}[plan.billingCycle||'lifetime'];
      for(const selector of ['[data-echel-cycle="'+name.toLowerCase()+'"]','#plan'+name+' > .pd:not(.planFeat)']){
        const el=document.querySelector(selector);if(el)el.textContent=tr(label);
      }
    });
  }
  document.addEventListener('echel:branding',event=>{config=event.detail;render();});
  window.addEventListener('i18n:changed',render);
  const params=new URLSearchParams(location.search);const ref=params.get('ref');
  fetch('/api/setup-fee/current'+(ref?'?ref='+encodeURIComponent(ref):''))
    .then(r=>r.ok?r.json():null).then(data=>{if(data?.plans){pricing=data.plans;render();}}).catch(()=>{});
})();
