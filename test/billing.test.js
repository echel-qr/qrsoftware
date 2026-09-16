const test=require('node:test'),assert=require('node:assert/strict');
const {CYCLES,billingCycle,subscriptionActive,validatePlanPrices}=require('../billing');
test('legacy lifetime and monthly accounts retain their duration',()=>{
  assert.equal(billingCycle({plan_type:'premium'}),'lifetime');
  assert.equal(billingCycle({plan_type:'monthly'}),'monthly');
  assert.equal(subscriptionActive({plan_type:'monthly',paid_until:'2026-01-01'},Date.parse('2026-02-01')),false);
});
test('every term expires independently of its feature tier',()=>{
  for(const billing_cycle of ['monthly','quarterly','yearly']){
    assert.equal(subscriptionActive({plan_type:'premium',billing_cycle,paid_until:'2027-01-01'},Date.parse('2026-01-01')),true);
    assert.equal(subscriptionActive({plan_type:'pro',billing_cycle,paid_until:'2026-01-01'},Date.parse('2026-01-01')),false);
    assert.equal(subscriptionActive({plan_type:'starter',billing_cycle}),false);
  }
  assert.equal(subscriptionActive({billing_cycle:'lifetime'}),true);
  assert.deepEqual(Object.values(CYCLES),[1,3,12,0]);
});
test('prices and cycle validate before writes; missing cycle preserves old configuration',()=>{
  const defs={pro:{feeKey:'fee',actualKey:'actual'}};
  assert.deepEqual(validatePlanPrices({pro:{fee:899,actual:999,billingCycle:'quarterly'}},defs),[['fee','899'],['actual','999'],['plan_pro_cycle','quarterly']]);
  assert.equal(validatePlanPrices({pro:{fee:899}},defs).length,2);
  for(const bad of [{fee:'899oops'},{fee:1.4},{fee:5,actual:4},{fee:1,billingCycle:'weekly'}])assert.throws(()=>validatePlanPrices({pro:bad},defs));
});
