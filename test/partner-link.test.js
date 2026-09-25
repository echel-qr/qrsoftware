const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = path.resolve(__dirname, '..');

// A partner's link is their own subdomain: abcprint.echel.in. The form, the
// "You are a partner" card and the partner's panel must all show it that way.

function reply(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

function open(file, url, answers, extra) {
  const html = fs.readFileSync(path.join(root, 'public', file), 'utf8')
    .replace(/<script\b[^>]*\bsrc=[^>]*><\/script>/gi, '');
  const calls = [];
  const dom = new JSDOM(html, {
    url, runScripts: 'dangerously', virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      window.fetch = (u, opts) => {
        const p = new URL(u, url).pathname;
        calls.push(p);
        return reply(p in answers ? answers[p] : {});
      };
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      if (extra) extra(window);
    }
  });
  return { dom, doc: dom.window.document, calls };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test('the partner form shows the link the way it will look: abcprint.echel.in', () => {
  const { dom, doc } = open('whitelabel.html', 'https://echel.in/whitelabel', {});
  const input = doc.getElementById('fSlug');
  assert.equal(input.nextElementSibling.textContent, '.echel.in', 'the ending sits after the name that is typed');
  dom.window.close();
});

test('after the payment the partner gets the link the server made, not the address of this page', async () => {
  const answers = {
    '/api/whitelabel/license-fee': { licenseFee: 9999 },
    '/api/whitelabel/register': { success: true, wlId: 'WL_1A2B3C4D', slug: 'abcprint' },
    '/api/whitelabel/license/create': { success: true, keyId: 'rzp_test', amount: 999900, orderId: 'order_1' },
    '/api/whitelabel/license/verify': { success: true, wlId: 'WL_1A2B3C4D', slug: 'abcprint', password: 'ABCD1234', link: 'https://abcprint.echel.in' }
  };
  // The page is opened on some other subdomain — that must not leak into the link.
  const { dom, doc } = open('whitelabel.html', 'https://hello.echel.in/whitelabel', answers, window => {
    window.Razorpay = class {
      constructor(options) { this.options = options; }
      open() { this.options.handler({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'sig' }); }
    };
  });
  const fill = (id, value) => { doc.getElementById(id).value = value; };
  fill('fBrand', 'ABC Print Solutions'); fill('fSlug', 'abcprint'); fill('fOwner', 'Test Partner');
  fill('fPhone', '9000000000'); fill('fEmail', 'partner@example.com');
  await dom.window.startPay();
  await settle();
  assert.equal(doc.getElementById('doneCard').style.display, 'block', doc.getElementById('errBox').textContent);
  assert.equal(doc.getElementById('cSlug').textContent, 'https://abcprint.echel.in');
  dom.window.close();
});

test('the partner panel shows the subdomain link, with no note about DNS any more', async () => {
  const me = {
    id: 'WL_1A2B3C4D', slug: 'abcprint', brandName: 'ABC Print Solutions', stats: {},
    shopPrice: 1499, basePrice: 999, shareLink: 'https://abcprint.echel.in'
  };
  const answers = {
    '/api/whitelabel/me': me,
    '/api/whitelabel/shops': { shops: [] },
    '/api/whitelabel/analytics': { slug: 'abcprint', totals: [], daily: [], shopsDaily: [] },
    '/api/captcha': { enabled: false }
  };
  const { dom, doc } = open('wl-admin.html', 'https://echel.in/wl-admin', answers, window => {
    window.localStorage.setItem('qrsp_wl_token', 'partner-token');
  });
  await settle();
  assert.equal(doc.getElementById('panel').style.display, 'block');
  assert.equal(doc.getElementById('shareLink').value, 'https://abcprint.echel.in');
  const card = doc.getElementById('shareLink').closest('.card');
  assert.doesNotMatch(card.textContent, /DNS/, 'the subdomain works now; the old "after DNS" note has to go');
  assert.equal(doc.getElementById('anSlug').textContent, 'abcprint.echel.in', 'Analytics names the link, not the bare slug');
  dom.window.close();
});
