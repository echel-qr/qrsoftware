'use strict';
const CYCLES = Object.freeze({monthly:1,quarterly:3,yearly:12,lifetime:0});
function billingCycle(shop = {}) {
  if (Object.hasOwn(CYCLES, shop.billing_cycle)) return shop.billing_cycle;
  return shop.plan_type === 'monthly' ? 'monthly' : 'lifetime';
}
function subscriptionActive(shop, now = Date.now()) {
  if (!shop) return false;
  return billingCycle(shop) === 'lifetime' || !!(shop.paid_until && new Date(shop.paid_until).getTime() > now);
}
function validatePlanPrices(plans, definitions) {
  const out=[];
  if(!plans || typeof plans!=='object' || Array.isArray(plans)) throw new Error('Enter valid plan prices');
  for(const [name,d] of Object.entries(definitions)) {
    const p=plans[name];if(!p)continue;
    const fee=Number(p.fee), actual=p.actual==null||p.actual===''?0:Number(p.actual);
    if(!Number.isSafeInteger(fee)||fee<1||fee>10000000)throw new Error(name+': enter a valid price');
    if(!Number.isSafeInteger(actual)||actual<0||actual>10000000||(actual>0&&actual<fee))throw new Error(name+': actual price must be zero or at least the offer price');
    if(p.billingCycle!==undefined&&!Object.hasOwn(CYCLES,p.billingCycle))throw new Error(name+': select Monthly, Quarterly, Yearly or Lifetime');
    out.push([d.feeKey,String(fee)],[d.actualKey,String(actual)]);
    if(p.billingCycle!==undefined)out.push(['plan_'+name+'_cycle',p.billingCycle]);
  }
  return out;
}
// Preserve legacy monthly subscriptions while keeping the tier (Pro/Premium) separate.
const CYCLE_SQL = "COALESCE(billing_cycle, CASE WHEN plan_type='monthly' THEN 'monthly' ELSE 'lifetime' END)";
const MONTHS_SQL = `CASE ${CYCLE_SQL} WHEN 'monthly' THEN 1 WHEN 'quarterly' THEN 3 WHEN 'yearly' THEN 12 ELSE 0 END`;
function validatePricingUpdate(body, definitions, currentPlans, currentFees) {
  const changes=body.plans?validatePlanPrices(body.plans,definitions):[];
  const integer=(value,label,min=0)=>{
    const n=Number(value);
    if(!Number.isSafeInteger(n)||n<min||n>10000000)throw new Error('Enter a valid '+label);
    return n;
  };
  const values={...currentFees};
  const mapping={offerPrice:'setup_fee_amount',actualPrice:'setup_actual_price',monthlyFee:'monthly_fee',advancedFee:'advanced_fee',monthlyActualPrice:'monthly_actual_price',advancedActualPrice:'advanced_actual_price',agentBasePrice:'agent_base_price',agentPremiumBasePrice:'agent_base_price_premium',wlLicenseFee:'wl_license_fee',wlLicenseActual:'wl_license_actual',wlBasePrice:'wl_base_price'};
  for(const [field,key] of Object.entries(mapping))if(body[field]!==undefined){
    // Hidden legacy monthly input can be empty; retain its configured amount.
    if(field==='monthlyFee'&&Number(body[field])===0)continue;
    const n=integer(body[field],field,field==='advancedFee'?1:0);
    values[field]=n;changes.push([key,String(n)]);
  }
  for(const [actual,fee] of [['actualPrice','offerPrice'],['monthlyActualPrice','monthlyFee'],['advancedActualPrice','advancedFee'],['wlLicenseActual','wlLicenseFee']]){
    if(values[actual]>0&&values[actual]<values[fee])throw new Error(actual+' must be zero or at least '+fee);
  }
  // A partner may not sell a shop below what the plan itself costs, or they
  // would be underselling us with our own software.
  if(values.wlBasePrice>0){
    const starter=body.plans?.starter?.fee;
    const floor=starter===undefined?currentPlans.starter.fee:Number(starter);
    if(values.wlBasePrice<floor)throw new Error('wlBasePrice must be zero or at least the starter price');
  }
  for(const [field,tier] of [['agentBasePrice','pro'],['agentPremiumBasePrice','premium']]){
    const proposed=body.plans?.[tier]?.fee;
    const floor=proposed===undefined?currentPlans[tier].fee:Number(proposed);
    if(values[field]>0&&values[field]<floor)throw new Error(field+' must be zero or at least the '+tier+' price');
  }
  if(body.festivalOfferEnabled!==undefined)changes.push(['festival_offer_enabled',body.festivalOfferEnabled===true||body.festivalOfferEnabled==='1'||body.festivalOfferEnabled===1?'1':'0']);
  if(body.festivalOfferName!==undefined)changes.push(['festival_offer_name',String(body.festivalOfferName).trim().slice(0,60)]);
  if(body.festivalOfferEnd!==undefined){
    const value=String(body.festivalOfferEnd).trim();
    if(value&&!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value))throw new Error('Enter a valid offer end date and time');
    changes.push(['festival_offer_end',value]);
  }
  return {changes,values};
}
module.exports={CYCLES,billingCycle,subscriptionActive,validatePlanPrices,validatePricingUpdate,CYCLE_SQL,MONTHS_SQL};
