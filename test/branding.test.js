const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBranding, withBrandDefaults, safeUrl } = require('../site-branding');

test('new deployments have Echel identity and no old contact data',()=>{
  const c=withBrandDefaults();assert.equal(c.brandName,'Echel');assert.equal(c.supportPhone,'7011482679');assert.equal(c.supportEmail,'helpdesk@echel.co.in');assert.deepEqual(c.partners,[]);
});
test('contact fields can be cleared; partial saves preserve other settings',()=>{
  const saved={...withBrandDefaults(),supportEmail:'help@example.com',whatsapp:'+91 9876543210',planStarter:['Auto print']};
  const next={...saved,...validateBranding({supportEmail:'',address:'New address'})};
  assert.equal(next.supportEmail,'');assert.equal(next.whatsapp,'+91 9876543210');assert.deepEqual(next.planStarter,['Auto print']);
});
test('links reject script protocols, credentials and malformed input',()=>{
  for(const key of ['logoUrl','mapsUrl','instagram','facebook','youtube','linkedin','twitter','telegram']) {
    assert.throws(()=>validateBranding({[key]:'javascript:alert(1)'}));
    assert.throws(()=>validateBranding({[key]:'https://name:password@example.com'}));
  }
  assert.equal(safeUrl('//evil.example/logo',true),'');
  assert.throws(()=>validateBranding({supportEmail:'a@example.com\r\nBcc:x@example.com'}));
});
test('social handles, local logos and YouTube links are accepted',()=>{
  const c=validateBranding({instagram:'@echel',youtube:'youtube.com/@echel',logoUrl:'/img/echel-logo.jpeg',setupVideoUrl:'https://youtu.be/abcdefghijk'});
  assert.equal(c.instagram,'https://instagram.com/echel');assert.equal(c.youtube,'https://youtube.com/@echel');assert.equal(c.logoUrl,'/img/echel-logo.jpeg');
  assert.throws(()=>validateBranding({setupVideoUrl:'https://example.com/video'}));
});
