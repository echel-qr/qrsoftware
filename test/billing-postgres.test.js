const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
let PGlite;
try { ({PGlite}=require('@electric-sql/pglite')); }
catch(error) { if(error.code!=='MODULE_NOT_FOUND')throw error; ({PGlite}=require('../.test-runtime/node_modules/@electric-sql/pglite')); }
const billing=require('../billing');
const source=fs.readFileSync(require.resolve('../server'),'utf8');
// Execute the actual application UPDATE statements against an isolated PostgreSQL engine.
function statement(name){
  const start=source.indexOf('async function '+name+'(');
  const text=source.slice(start);const sql=text.match(/pool\.query\(\s*(`[^`]+`)/)[1];
  return vm.runInNewContext(sql,billing);
}
test('calendar billing, tier preservation and duplicate payment protection in PostgreSQL',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`CREATE TABLE shops(id text PRIMARY KEY,plan_type text,billing_cycle text,setup_paid boolean DEFAULT false,setup_payment_id text,qr_code text,paid_until timestamptz,renewal_order_id text,renewal_amount integer DEFAULT 0,renewal_months integer DEFAULT 0); BEGIN;`);
    for(const [cycle,months] of Object.entries(billing.CYCLES)){
      await db.query('INSERT INTO shops(id,plan_type,billing_cycle) VALUES($1,$2,$3)',[cycle,'premium',cycle]);
      assert.equal((await db.query(statement('activateShop'),['pay','qr',cycle])).rows.length,1);
      const row=(await db.query('SELECT plan_type,paid_until, paid_until=NOW()+make_interval(months=>$2) AS correct FROM shops WHERE id=$1',[cycle,months])).rows[0];
      assert.equal(row.plan_type,'premium');
      if(months)assert.equal(row.correct,true);else assert.equal(row.paid_until,null);
      assert.equal((await db.query(statement('activateShop'),['duplicate','qr',cycle])).rows.length,0);
    }
    await db.query("INSERT INTO shops(id,plan_type) VALUES('legacy','monthly')");
    await db.query(statement('activateShop'),['pay','qr','legacy']);
    assert.equal((await db.query("SELECT paid_until=NOW()+interval '1 month' AS correct FROM shops WHERE id='legacy'")).rows[0].correct,true);
    await db.query("UPDATE shops SET renewal_order_id='order1',renewal_months=3,renewal_amount=900 WHERE id='quarterly'");
    assert.equal((await db.query(statement('extendShop'),['quarterly','order1'])).rows.length,1);
    assert.equal((await db.query("SELECT paid_until=NOW()+interval '6 months' AS correct FROM shops WHERE id='quarterly'")).rows[0].correct,true);
    assert.equal((await db.query(statement('extendShop'),['quarterly','order1'])).rows.length,0);
    await db.query("UPDATE shops SET paid_until=NOW()-interval '1 month',renewal_order_id='order2',renewal_months=12 WHERE id='monthly'");
    await db.query(statement('extendShop'),['monthly','order2']);
    assert.equal((await db.query("SELECT paid_until=NOW()+interval '12 months' AS correct FROM shops WHERE id='monthly'")).rows[0].correct,true);
    await db.query("UPDATE shops SET renewal_order_id='invalid',renewal_months=12 WHERE id='lifetime'");
    assert.equal((await db.query(statement('extendShop'),['lifetime','invalid'])).rows.length,0);
    await db.exec('ROLLBACK');
  }finally{await db.close();}
});
