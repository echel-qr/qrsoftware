/* ═══════════════════════════════════════════════════════════════
   i18n-extra.js — WO strings jo dictionary me chhoot gayi thi.

   Kyun chahiye: English chun-ne par bhi kai jagah Hinglish dikh raha
   tha — khaas kar customer wale page par aur server ke error message
   me. Wajah do thi:
     1) String dictionary me thi hi nahi.
     2) String runtime par banti thi ("3 files load ho gayi") isliye
        exact match kabhi milta hi nahi tha.

   Doosri wajah ke liye i18n.js me "%d" wala number-aware lookup add
   kiya gaya hai — yahan bas "%d" wali key likh do, number apne aap
   sahi jagah bhar jaata hai.

   i18n.js ke BAAD load hona chahiye.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  var EXTRA = {

    /* ─────────── PLAN CARDS — Starter / Pro / Premium ─────────── */
    'Lifetime — ek baar pay, koi renewal nahi':
      'Lifetime — pay once, no renewal ever',
    'Ek baar pay — Lifetime, koi renewal nahi':
      'Pay once — Lifetime, no renewal ever',
    'Lifetime — aaj ka bhi, aane wala bhi':
      'Lifetime — what exists today, and whatever comes next',
    'Lifetime — Advance Feature already unlocked':
      'Lifetime — Advance Feature already unlocked',
    'Try karke dekho — bina paisa diye':
      'Try it out — without paying anything',

    /* Price wale vaakya — %d se, taaki Superadmin price badle to bhi chale */
    'Advance Feature isme nahi hai — baad me ₹%d me alag se unlock kar sakte ho':
      'Advance Feature is not included — you can unlock it later for ₹%d',
    'Aaj ke saare advance features. Aage koi naya advance feature aaya to ₹%d me alag se':
      'Every advance feature that exists today. Any new one that comes later costs ₹%d separately',
    'Aaj ke saare advance features. Aage naya advance feature aaya to ₹%d me alag se':
      'Every advance feature that exists today. Any new one that comes later costs ₹%d separately',

    'Aaj ke bhi, kal ke bhi. Jo bhi naya advance feature banega, apne aap mil jayega — dobara paisa nahi.':
      'Today\'s features and tomorrow\'s. Every new advance feature reaches you automatically — you never pay again.',
    'Jo bhi naya advance feature banega, apne aap mil jayega — dobara paisa nahi':
      'Every new advance feature reaches you automatically — you never pay again',

    '✅ Starter ka sab kuch': '✅ Everything in Starter',
    '✅ Pro ka sab kuch': '✅ Everything in Pro',
    '✅ Aane wale SAARE advance feature — FREE': '✅ ALL upcoming advance features — FREE',
    '✅ Kabhi dobara koi payment nahi': '✅ Never pay again',
    '✅ 24 Ghante · 10 Print': '✅ 24 Hours · 10 Prints',
    '✅ Advance Feature — UNLOCKED': '✅ Advance Feature — UNLOCKED',

    /* ─────────── ADVANCE FEATURE TAB (shop panel) ─────────── */
    'Ek dukaan se full-service dukaan — photo, resume, bade print, sab':
      'From an ordinary shop to a full-service one — photos, resumes, large prints, everything',
    'Ek baar · Lifetime · Koi renewal nahi':
      'One time · Lifetime · No renewal',
    'Turant unlock · Payment fail ho to paisa nahi katta — dobara try kar lena':
      'Unlocks instantly · If the payment fails nothing is charged — just try again',
    'Ye saare option ek hi unlock me aate hain. Unlock ke baad har feature ko apne hisaab se on/off kar sakte ho, aur har ek ka apna rate set kar sakte ho.':
      'All of these come in a single unlock. After unlocking you can switch each feature on or off as you like, and set your own rate for each one.',

    /* Default feature descriptions (Superadmin inhe badal sakta hai —
       badalne par uska apna text dikhega, translation nahi) */
    'Customer photo bhejta hai — 4, 6, 8 ya 10 ki sheet khud ban kar photo printer se nikalti hai, cutting lines ke saath. Layout aur printer routing sab automatic.':
      'The customer sends a photo — a sheet of 4, 6, 8 or 10 builds itself and comes out of the photo printer with cutting lines. Layout and printer routing are fully automatic.',
    'Customer QR se hi 6 design me resume banata hai aur form khud bharta hai. Aap sirf print dete ho — naya kaam, bina kuch seekhe.':
      'The customer builds a resume in one of 6 designs straight from the QR and fills the form themselves. You only hand over the print — new business, nothing new to learn.',
    'Naksha, project chart, banner. Har bade size ka apna printer aur apna rate set kar sakte ho — A3 printer hai to ye kaam aapke paas hi rahega.':
      'Maps, project charts, banners. Each large size gets its own printer and its own rate — if you have an A3 printer, this work stays with you.',
    'Notes, question paper, syllabus — customer 2/4/6/8/9/12/16 pages ek hi A4 par chhapwa sakta hai. Student season me sabse zyada chalne wala option.':
      'Notes, question papers, syllabus — the customer can print 2/4/6/8/9/12/16 pages on a single A4. The busiest option during student season.',
    'Double-side print ka alag rate rakho. Auto-duplex printer nahi hai to manual mode — system khud bolta hai "page palto".':
      'Charge a separate rate for double-sided printing. No auto-duplex printer? Manual mode — the system itself says "flip the page".',
    '4×6 Passport Photos': '4×6 Passport Photos',
    'Mini Print — ek sheet par 16 pages tak': 'Mini Print — up to 16 pages on one sheet',
    'A3 / A2 / A1 — Bade Size': 'A3 / A2 / A1 — Large Sizes',
    'Duplex — Dono Side Print': 'Duplex — Both-Side Printing',

    /* ─────────── ADMIN — Advance Feature (naye strings) ─────────── */
    'saare': 'all',
    '4×6 Photo · Resume · A3/A2/A1 · Duplex · Mini Print':
      '4×6 Photo · Resume · A3/A2/A1 · Duplex · Mini Print',
    'Notes, question paper, syllabus — customer 2/4/6/8/9/12/16 pages ek hi A4 par chhapwa sakta hai.':
      'Notes, question papers, syllabus — the customer can print 2/4/6/8/9/12/16 pages on a single A4.',
    '16 page ka kaam 1 page ke kagaz me.': '16 pages of work on 1 sheet of paper.',
    'Student season me sabse zyada chalne wala option.':
      'The most-used option during student season.',

    /* ─────────── ADMIN — Big Size (A3/A2/A1) pricing ─────────── */
    '📐 BIG SIZE PRICING — A3 / A2 / A1 (₹ per page)':
      '📐 BIG SIZE PRICING — A3 / A2 / A1 (₹ per page)',
    'Bade kagaz ki lagat alag hoti hai — yahan har size ka apna rate set karo.':
      'Large paper costs more — set a separate rate for each size here.',
    'Khaali chhodo ya 0 daalo': 'Leave blank or enter 0',
    'to us size par aapka normal B&W / Color rate hi lagega.':
      'and that size will use your normal B&W / Color rate.',
    'A3 — ⚫ B&W (₹/page)': 'A3 — ⚫ B&W (₹/page)',
    'A3 — 🌈 Color (₹/page)': 'A3 — 🌈 Color (₹/page)',
    'A2 — ⚫ B&W (₹/page)': 'A2 — ⚫ B&W (₹/page)',
    'A2 — 🌈 Color (₹/page)': 'A2 — 🌈 Color (₹/page)',
    'A1 — ⚫ B&W (₹/page)': 'A1 — ⚫ B&W (₹/page)',
    'A1 — 🌈 Color (₹/page)': 'A1 — 🌈 Color (₹/page)',
    'ℹ️ Abhi koi big-size rate set nahi — A3/A2/A1 par bhi normal A4 wala rate hi lagega.':
      'ℹ️ No big-size rate set yet — A3/A2/A1 will also use your normal A4 rate.',
    '✅ Apna rate lag raha hai:': '✅ Your own rate is applied:',
    'par normal rate': 'use the normal rate',

    /* ─────────── HOMEPAGE — instant demo ─────────── */
    'Details bharo — Shop ID aur password turant isi screen par mil jayenge':
      'Fill in your details — your Shop ID and password appear right on this screen',
    '🔒 Secure form · No payment · No card': '🔒 Secure form · No payment · No card',
    'WhatsApp number (10 digit)': 'WhatsApp number (10 digits)',
    'Demo Shuru Karo — Free ›': 'Start Free Demo ›',
    'Shop ID aur password turant screen par milega · Koi payment nahi':
      'Shop ID and password appear instantly on screen · No payment',
    '⏳ Demo ban raha hai...': '⏳ Creating your demo...',
    'Demo Account Active Hai': 'Your Demo Account Is Active',
    'Aapki shop ban gayi. Neeche wali details': 'Your shop is created. Save the details below',
    'abhi note kar lo': 'right now',
    'Valid': 'Valid',
    'Free prints': 'Free prints',
    'Charge': 'Charge',
    'Shop ID': 'Shop ID',
    'Password': 'Password',
    'Copy': 'Copy',
    'Ye screen': 'This screen',
    'dobara nahi khulegi': 'will not open again',
    'Screenshot le lo ya Copy dabao. Password aapka mobile number hi hai — baad me dashboard se badal sakte ho.':
      'Take a screenshot or tap Copy. Your password is your mobile number — you can change it later from the dashboard.',
    'Aapki shop ka QR — customer isi ko scan karega':
      'Your shop QR — this is what customers scan',
    'Login karo': 'Log in',
    '— upar wali Shop ID aur password se': '— with the Shop ID and password above',
    'Print Agent download': 'Download the Print Agent',
    'karke shop ke PC me install karo': 'and install it on your shop PC',
    'Shop ID daalo': 'Enter the Shop ID',
    'agent me — printer apne aap detect ho jayega':
      'in the agent — your printer is detected automatically',
    'QR scan karke': 'Scan the QR',
    'phone se ek test print bhejo 🎉': 'and send a test print from your phone 🎉',
    '🎬 Poora setup 2 minute me — dekh lo': '🎬 See the full setup in 2 minutes',
    '🔊 Sound': '🔊 Sound',
    '🔑 Ab Login Karo ›': '🔑 Log In Now ›',
    '🔒 Encrypted connection': '🔒 Encrypted connection',
    '🚫 No payment taken': '🚫 No payment taken',
    '🗑️ Files auto-delete': '🗑️ Files auto-delete',
    'Request Mil Gayi': 'Request Received',
    'Aapki demo request humare paas aa gayi hai.': 'We have received your demo request.',
    '⏱️ Thodi der me activate': '⏱️ Activating shortly',
    '🎬 Tab tak setup dekh lo — 2 minute': '🎬 Meanwhile, watch the 2-minute setup',

    /* ─────────── Phone validation messages ─────────── */
    'Sahi 10-digit mobile number daalo.': 'Please enter a valid 10-digit mobile number.',
    'Mobile number 6, 7, 8 ya 9 se shuru hota hai — dobara check karo.':
      'Mobile numbers start with 6, 7, 8 or 9 — please check again.',
    'Ye test number hai — apna asli WhatsApp number daalo.':
      'That is a test number — please enter your real WhatsApp number.',
    'Ye number asli nahi lag raha — apna WhatsApp number daalo.':
      'That number does not look real — please enter your WhatsApp number.',
    '✅ Number theek hai — Shop ID isi par bhi bhej denge':
      '✅ Number looks good — we will send the Shop ID here too',
    'Apna naam daalo': 'Enter your name',
    'Shop ka naam daalo': 'Enter your shop name',

    /* ─────────── SUPERADMIN — activation mode ─────────── */
    '⚡ Activation Mode': '⚡ Activation Mode',
    '⚡ Instant — apne aap activate': '⚡ Instant — activates automatically',
    'Form submit karte hi Shop ID aur password': 'As soon as the form is submitted, the Shop ID and password',
    'usi screen par': 'appear on that screen',
    'mil jaate hain. Aapko kuch nahi karna.': ' — you do not have to do anything.',
    '🔒 Manual — aapki approval ke baad': '🔒 Manual — after your approval',
    '🔒 Manual Approval Karo': '🔒 Switch to Manual Approval',
    '⚡ Instant Karo': '⚡ Switch to Instant',
    'Har request neeche': 'Every request lands below in',
    'me aayegi. Accept karne par hi demo banega, phir WhatsApp se ID bhejni hogi.':
      '. The demo is created only when you Accept, then you send the ID on WhatsApp.',
    'Ye list sirf': 'This list only fills up in',
    'Manual Approval': 'Manual Approval',
    'mode me bharti hai.': ' mode.',

    /* ─────────── CUSTOMER PAGE — upload / editor ─────────── */
    'Sab theek hai / Edit karna hai': 'All good / Want to edit',
    'pehle file upload karo': 'please upload a file first',
    'File padhi ja rahi hai…': 'Reading file…',
    'File padhi nahi ja saki': 'Could not read the file',
    'File load nahi hui': 'File did not load',
    'Preview ban raha hai…': 'Building preview…',
    'Preview nahi ban paya — dobara try karo': 'Preview failed — please try again',
    '⏳ Sheets ban rahi hain…': '⏳ Preparing sheets…',
    '⏳ Document load ho raha hai...': '⏳ Loading document...',
    'ho gaya': 'done',
    '). JPG ya PNG photo try karo.': '). Try a JPG or PNG photo.',
    '🗑️ Document hata diya': '🗑️ Document removed',
    'Aap sirf': 'You only pay for',
    'sheet</b> ka paisa denge': 'sheet</b>',
    '— abhi ke rate se <b>₹': '— at the current rate <b>₹',

    /* Number-wale toast — %d se number apne aap bhar jaata hai */
    '✅ %d files load ho gayi!': '✅ %d files loaded!',
    '✅ %d pages load ho gaye!': '✅ %d pages loaded!',
    '✅ %d pages isi canvas par add ho gaye': '✅ %d pages added to this canvas',
    '⏳ Page %d / %d load ho raha hai...': '⏳ Loading page %d of %d...',
    '⚠️ Page %d load nahi hui, baaki pages continue ho rahe hain...':
      '⚠️ Page %d failed to load, continuing with the rest...',
    '⏳ File %d/%d:': '⏳ File %d/%d:',

    /* ─────────── RESUME ─────────── */
    '⚠️ Preview nahi ban paya, par resume theek hai — print kar sakte ho':
      '⚠️ Preview failed, but your resume is fine — you can still print it',
    'Developed by Rupesh Kumar Mahato | QR Se Resume Banao':
      'Developed by Rupesh Kumar Mahato | Build your resume with QR',

    /* ─────────── SERVER ERRORS — login / session ─────────── */
    'Login zaroori hai': 'Login required',
    'Session expire ho gaya, dobara login karo': 'Session expired, please log in again',
    'ID ya password galat hai': 'Incorrect ID or password',
    'Purana password galat hai': 'Old password is incorrect',
    'Naya password kam se kam 6 akshar ka ho': 'New password must be at least 6 characters',
    'Bahut zyada galat koshish. %d minute baad try karo.':
      'Too many failed attempts. Please try again in %d minutes.',
    'Ye whitelabel token nahi hai': 'This is not a white-label token',
    'Account nahi mila': 'Account not found',
    'Account paused hai': 'Account is paused',
    'Aapka account abhi paused hai': 'Your account is currently paused',
    'Aapka account abhi paused hai. Admin se baat kariye.':
      'Your account is currently paused. Please contact the admin.',

    /* ─────────── SERVER ERRORS — shop / demo ─────────── */
    'Shop nahi mila': 'Shop not found',
    'Shop ka naam zaroori hai': 'Shop name is required',
    'Shop pehle se active hai': 'Shop is already active',
    'Sahi 10-digit mobile number daalo': 'Enter a valid 10-digit mobile number',
    'Sahi 10 digit mobile number daalo': 'Enter a valid 10-digit mobile number',
    'Demo abhi band hai — thodi der baad try karo ya seedha register karo':
      'Demo is closed right now — try again shortly or register directly',
    'Is number par demo pehle liya ja chuka hai. Pasand aaya tha? Ab register karo 🙂':
      'A demo has already been taken on this number. Liked it? Register now 🙂',
    'Is number par demo pehle liya ja chuka hai. Ab register karo 🙂':
      'A demo has already been taken on this number. Please register now 🙂',
    'Is number par demo pehle se hai': 'This number already has a demo',
    'Aaj ke liye demo limit ho gayi — kal try karo ya abhi register karo':
      'Today’s demo limit is reached — try tomorrow or register now',
    'Is network se %d demo ho chuke hain. %d minute baad try karo, ya seedha register kar lo.':
      '%d demos have already been created from this network. Try again in %d minutes, or register directly.',
    'Login password = aapka mobile number': 'Login password = your mobile number',

    /* ─────────── SERVER ERRORS — advance / module ─────────── */
    'Advance feature unlock nahi hai': 'Advance feature is not unlocked',
    'Advanced already unlocked hai': 'Advanced is already unlocked',
    'Galat module': 'Invalid module',

    /* ─────────── SERVER ERRORS — agent ─────────── */
    'Aap agent nahi ho': 'You are not an agent',
    'Agent nahi mila': 'Agent not found',
    'Aapka agent account abhi paused hai': 'Your agent account is currently paused',
    'Agent banne ke liye pehle plan lena zaroori hai. Demo account agent nahi ban sakta.':
      'You must purchase a plan before becoming an agent. Demo accounts cannot become agents.',
    'Sahi UPI ID daalo (jaise name@bank)': 'Enter a valid UPI ID (e.g. name@bank)',
    'Agent token galat hai': 'Invalid agent token',
    'Agent purana hai — naya print agent install karo':
      'Your agent is outdated — please install the latest print agent',

    /* ─────────── SERVER ERRORS — withdrawal ─────────── */
    'Withdrawal ke liye kam se kam ₹500 chahiye (abhi ₹%d)':
      'A minimum of ₹500 is required to withdraw (currently ₹%d)',
    'Ek withdrawal request pehle se pending hai': 'A withdrawal request is already pending',
    'Pending withdrawal nahi mili': 'No pending withdrawal found',

    /* ─────────── SERVER ERRORS — payment / gateway ─────────── */
    'Payment reference/ID daalo (Razorpay dashboard se)':
      'Enter the payment reference/ID (from your Razorpay dashboard)',
    'Payment reference daalo (cash ho to "CASH" likh do)':
      'Enter the payment reference (write "CASH" if paid in cash)',
    'Payment gateway configure nahi hai.': 'Payment gateway is not configured.',
    'Payment verification failed': 'Payment verification failed',
    'Order create nahi hua': 'Could not create the order',
    'Order create nahi hua:': 'Could not create the order:',
    'Order match nahi hua': 'Order did not match',
    'Key ID aur Secret dono daalo': 'Enter both the Key ID and the Secret',
    'Key ID rzp_ se shuru honi chahiye': 'Key ID must start with rzp_',
    'Secret key bhi daalo': 'Please enter the secret key as well',
    'App ID bhi daalo': 'Please enter the App ID as well',
    'Gateway razorpay ya cashfree hi ho sakta hai': 'Gateway must be either razorpay or cashfree',
    'Pehle Razorpay keys save karo': 'Save your Razorpay keys first',
    'Pehle Cashfree keys save karo': 'Save your Cashfree keys first',
    'Pehle apna Razorpay ya Cashfree set karo — warna shop payment nahi kar payegi':
      'Set up your Razorpay or Cashfree first — otherwise the shop cannot take payments',
    'Sahi price daalo': 'Enter a valid price',
    'Monthly price number me daalo': 'Enter the monthly price as a number',
    'Monthly price bahut zyada hai': 'Monthly price is too high',
    'Valid base price daalo': 'Enter a valid base price',

    /* ─────────── SERVER ERRORS — white label ─────────── */
    'White label nahi mila': 'White label not found',
    'Registration nahi mila': 'Registration not found',
    'License already paid hai': 'The license is already paid',
    'License payment abhi complete nahi hua': 'License payment is not complete yet',
    'Slug kam se kam 3 akshar ka ho (sirf a-z, 0-9, dash)':
      'Slug must be at least 3 characters (only a-z, 0-9, dash)',
    'Ye slug reserved hai, dusra chuno': 'This slug is reserved, please choose another',
    'Ye slug already liya jaa chuka hai': 'This slug is already taken',
    'Sahi support email daalo': 'Enter a valid support email',
    'Sahi 10 digit support number daalo': 'Enter a valid 10-digit support number',
    'Instagram link https:// se shuru hona chahiye': 'The Instagram link must start with https://',
    'YouTube link https:// se shuru hona chahiye': 'The YouTube link must start with https://',
    'Facebook link https:// se shuru hona chahiye': 'The Facebook link must start with https://',

    /* ─────────── SERVER ERRORS — upload / logo ─────────── */
    'Koi file nahi': 'No file provided',
    'Koi file nahi mili': 'No file found',
    'Sirf PNG file chalegi (transparent background wali)':
      'Only PNG files are allowed (with a transparent background)',
    'Sirf PNG ya JPG file chalegi': 'Only PNG or JPG files are allowed',
    'PNG transparent background wali honi chahiye (abhi solid background hai)':
      'The PNG must have a transparent background (this one has a solid background)',
    'Logo %d KB se chhota hona chahiye (abhi %d KB hai)':
      'The logo must be smaller than %d KB (it is currently %d KB)',
    'Cloudinary configured nahi': 'Cloudinary is not configured',
    'Cloudinary keys set nahi hain': 'Cloudinary keys are not set',
    'Cloudinary configured nahi hai — Render environment variables check karo (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)':
      'Cloudinary is not configured — check your Render environment variables (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)',

    /* ─────────── SERVER ERRORS — misc ─────────── */
    'Ye shop aapki nahi hai': 'This shop does not belong to you',
    'Shop ya order match nahi hua': 'The shop or order did not match',
    'Shop ka setup abhi incomplete hai. Shop owner ko setup fee complete karna hoga.':
      'This shop’s setup is still incomplete. The shop owner needs to complete the setup fee.',
    'Ye shop kisi aur ke PC se jud chuki hai': 'This shop is already linked to another PC',
    'fix nahi hua': 'not fixed',
    'abhi saaf karo': 'clean up now',

    /* ─────────── HOMEPAGE — short bits ─────────── */
    '— har shop par ₹100': '— ₹100 for every shop',
    'Har shop onboard karne par flat ₹100 commission':
      'A flat ₹100 commission for every shop you onboard',
    'Cyber cafe / print shop free register karo': 'Register your cyber cafe / print shop free',
    'Apne brand se resell karo': 'Resell it under your own brand',
    'Cyber cafe aur print shop ke liye QR-based automatic print software. Customer QR scan karke file bhejta hai, payment karta hai, print automatic nikalta hai.':
      'QR-based automatic printing software for cyber cafes and print shops. The customer scans the QR, sends a file, pays, and the print comes out automatically.'
  };

  /* ── alert / confirm ko apne aap translate karo ──
     Ye DOM nahi hote, isliye MutationObserver inhe kabhi nahi pakadta —
     English chunne par bhi inme Hinglish hi dikhta tha (khaas kar server
     ke error message). Yahan ek baar wrap kar dene se HAR call site
     apne aap theek ho jaati hai, kisi file me haath lagaye bina.

     Multi-line message (jaise confirm ke andar \n) ki har line alag
     translate hoti hai — poora block dictionary me na ho tab bhi jitna
     mil jaye utna English ho jaata hai. */
  function wrapDialogs() {
    if (window.__qspDialogsWrapped) return;
    var T = (window.QSPi18n && window.QSPi18n.t) || function (s) { return s; };
    function tr(msg) {
      if (msg == null) return msg;
      return String(msg).split('\n').map(function (line) {
        var m = line.match(/^(\s*)([\s\S]*?)(\s*)$/);
        return m ? m[1] + T(m[2]) + m[3] : T(line);
      }).join('\n');
    }
    ['alert', 'confirm', 'prompt'].forEach(function (fn) {
      var orig = window[fn];
      if (typeof orig !== 'function') return;
      window[fn] = function (msg) {
        var args = Array.prototype.slice.call(arguments);
        args[0] = tr(msg);
        return orig.apply(window, args);
      };
    });
    window.__qspDialogsWrapped = true;
  }
  /* ── AB KI BAAR JODA GAYA ── website audit me jo English me
     chhoot gaya tha (pricing plans, demo form, white-label,
     aur customer page ka naya PDF-password dialog). */
  var EXTRA2 = {
    "Ruko…": "Please wait…",
    "⏳ Demo ban raha hai...": "⏳ Creating the demo...",
    "⏳ Register ho raha hai...": "⏳ Registering...",
    "✓ Copied": "✓ Copied",
    "❌ Galat password —": "❌ Wrong password —",
    "🗑️ Document hata diya": "🗑️ Document removed",
    "⚠️ Password enter karo": "⚠️ Enter the password",
    "⚠️ Photo nahi mili": "⚠️ Photo not found",
    "📌 Photo sheet pehle se sahi fit hai": "📌 The photo sheet already fits correctly",
    "\"📋 Logs Dekho\"": "\"📋 View Logs\"",
    "Customer ko sirf QR scan karna hai, document upload karna hai, payment complete karni hai — aur print automatically start ho jata hai. Na pendrive ki zarurat, na WhatsApp par file bhejne ka jhanjhat, na manual file handling.": "The customer only has to scan the QR code, upload the document and complete the payment — and the print starts automatically. No pen drive, no sending files over WhatsApp, no manual file handling.",
    "Haan, dobara upload karna padega. Hamari policy hai ki koi file store nahi ki jaati — chahe print ho ya cancel. Ye aap khud verify kar sakte ho: System Tray me Echel icon par right-click karke": "Yes, you will have to upload it again. Our policy is that no file is stored — whether it prints or gets cancelled. You can check this yourself: right-click the Echel icon in the System Tray and open",
    "Hamara vision hai ki Echel India ka sabse trusted Smart Printing Platform bane — jahan har print shop bina expensive infrastructure ke smart aur automated printing service de sake.": "Our vision is for Echel to become India's most trusted Smart Printing Platform — where every print shop can offer smart, automated printing without expensive infrastructure.",
    "Hum believe karte hain ki technology ka asli purpose logon ka kaam easy banana hai. Isi soch ke saath Echel develop kiya gaya hai, taaki har print shop bina expensive hardware ya complicated setup ke ek modern self-service printing experience de sake.": "We believe the real purpose of technology is to make people's work easier. Echel was built with exactly that in mind, so that any print shop can offer a modern self-service printing experience without expensive hardware or a complicated setup.",
    "Hum lagatar naye features, better security, faster performance aur reliable technology par kaam kar rahe hain, taaki har business confidently digital printing ka future apna sake.": "We keep working on new features, better security, faster performance and reliable technology, so that every business can confidently adopt the future of digital printing.",
    "Net Jaye To Bhi Safe": "Safe Even If The Internet Drops",
    "Paise dene se pehle free demo se poora software try karo. Payment ke baad refund nahi milta. Par install nahi kar pa rahe to tension mat lo — WhatsApp ya AnyDesk se hum khud setup karke denge, jab tak chalu na ho jaye.": "Try the complete software with the free demo before you pay anything. There is no refund after payment. But if you cannot install it, don't worry — we will set it up for you over WhatsApp or AnyDesk, and stay with it until it is running.",
    "Echel ek software hai jo aapki dukaan ke printer ko customer ke phone se jodta hai. Ye niyam batate hain ki account, plan, referral aur payment kaise chalte hain, aur kya karna mana hai.": "Echel is software that connects your shop's printer to your customer's phone. These terms explain how accounts, plans, referrals and payments work, and what is not allowed.",
    "Echel sirf software deta hai — printer, paper, ink aur dukaan shop owner ki apni hai. Customer jo file bhejta hai uski zimmedari customer ki. Kamai ke jo example website par dikhte hain wo sirf samajhne ke liye hain, guarantee nahi.": "Echel provides only the software — the printer, paper, ink and shop belong to the shop owner. Whatever file a customer sends is that customer's responsibility. The earning examples shown on the website are only for illustration, not a guarantee.",
    "Setup ya software use karte waqt koi problem aaye to support kisi third-party team se nahi milta — seedha WhatsApp par personally diya jata hai, taaki har user bina confusion ke Echel ka poora fayda le sake.": "If you hit a problem during setup or while using the software, support does not come from some third-party team — it is given personally over WhatsApp, so every user can get the full benefit of Echel without confusion.",
    "aur": "and",
    "dikhayega ki payment complete karne ke baad Shop ID milne se lekar pehla test print nikalne tak kya-kya karna hai. Har step ko order me follow karo — kahin atko to sabse neeche Support section me contact ka tarika bhi diya hai.": "shows everything you need to do, from getting your Shop ID after payment to taking your first test print. Follow the steps in order — and if you get stuck, the Support section at the bottom has the contact details.",
    "ek modern Smart Printing Platform hai jo Cyber Cafes, Print Shops, CSC Centers aur Digital Service Businesses ke liye specially design kiya gaya hai. Hamara mission simple hai — printing ko fast, automated aur hassle-free banana.": "is a modern Smart Printing Platform built specially for cyber cafes, print shops, CSC centres and digital service businesses. Our mission is simple — to make printing fast, automated and hassle-free.",
    "— server par kuch nahi bachta. Shop owner apne admin panel ke logs me dekh sakta hai ki job print hua aur file hat gayi. Card ya UPI PIN hum kabhi store nahi karte, wo Razorpay ke paas jata hai.": "— nothing is left on the server. The shop owner can see in the admin panel logs that the job printed and the file was removed. We never store card details or UPI PINs; those go to Razorpay.",
    "karo.": "it.",
    "+ ₹299/saal maintenance, domain renewal & server cost": "+ ₹299/year maintenance, domain renewal & server cost",
    "Aaj ke bhi, kal ke bhi. Jo bhi naya advance feature banega, apne aap mil jayega — dobara paisa nahi.": "Today's and tomorrow's. Any new advance feature reaches you automatically — no paying again.",
    "Aaj ke saare advance features. Aage koi naya advance feature aaya to ₹49 me alag se": "All of today's advance features. Any new advance feature later costs ₹49 separately",
    "Aaj ke saare advance features. Aage naya advance feature aaya to ₹49 me alag se": "All of today's advance features. Any new advance feature later costs ₹49 separately",
    "Advance Feature isme nahi hai — baad me ₹199 me alag se unlock kar sakte ho": "Advance Features are not included — you can unlock them later for ₹199",
    "Demo Shuru Karo — Free ›": "Start the Demo — Free ›",
    "Details bharo — Shop ID aur password turant isi screen par mil jayenge": "Fill in the details — your Shop ID and password appear right here, instantly",
    "Ek baar pay — Lifetime, koi renewal nahi": "Pay once — Lifetime, no renewal",
    "Jo bhi naya advance feature banega, apne aap mil jayega — dobara paisa nahi": "Any new advance feature reaches you automatically — no paying again",
    "Kholne ke liye password daalo": "Enter the password to open it",
    "Lifetime — Advance Feature already unlocked": "Lifetime — Advance Features already unlocked",
    "Lifetime — aaj ka bhi, aane wala bhi": "Lifetime — today's and everything to come",
    "Lifetime — ek baar pay, koi renewal nahi": "Lifetime — pay once, no renewal",
    "PDF ka password": "PDF password",
    "Password dikhao": "Show password",
    "Password sirf aapke phone me use hota hai — kahin save ya send nahi hota": "The password is used only on your phone — never saved or sent anywhere",
    "Register Karo — Agla Step: ₹899 ›": "Register — Next step: ₹899 ›",
    "Shop ID aur password turant screen par milega · Koi payment nahi": "Shop ID and password appear on screen instantly · No payment",
    "WhatsApp number (10 digit)": "WhatsApp number (10 digits)",
    "Ye PDF Password Se Locked Hai": "This PDF is Password Protected",
    "dabao.": "press it.",
    "generate karo.": "generate it.",
    "✅ 24 Ghante · 10 Print": "✅ 24 Hours · 10 Prints",
    "✅ Aane wale SAARE advance feature — FREE": "✅ ALL future advance features — FREE",
    "✅ Advance Feature — UNLOCKED": "✅ Advance Features — UNLOCKED",
    "✅ Kabhi dobara koi payment nahi": "✅ Never any payment again",
    "✅ Pro ka sab kuch": "✅ Everything in Pro",
    "✅ Starter ka sab kuch": "✅ Everything in Starter",
    "🔒 Password PDF": "🔒 Password-protected PDF",
    "🔒 Secure form · No payment · No card": "🔒 Secure form · No payment · No card",
    "🔓 PDF Kholo": "🔓 Open PDF"
  };
  for (var k2 in EXTRA2) if (Object.prototype.hasOwnProperty.call(EXTRA2, k2)) EXTRA[k2] = EXTRA2[k2];

  /* EXTRA3 — teen line English me bhi Hinglish reh gayi thi. */
  var EXTRA3 = {
    "Shop Nahi Mila": "Shop Not Found",
    "aapka@email.com": "you@email.com",
    "Document ka photo — scan jaisa saaf page": "Photo of a document — a clean, scan-like page"
  };
  for (var k3 in EXTRA3) if (Object.prototype.hasOwnProperty.call(EXTRA3, k3)) EXTRA[k3] = EXTRA3[k3];




  /* EXTRA4 — Disclaimer page ke FAQ. Ye HTML me nahi, panel ke
     config se aate hain, isliye pehle chhoot gaye the. */
  var EXTRA4 = {
    "Do tarike: counter par cash, ya online payment (Razorpay/PhonePe) jo seedha aapke account me jata hai. Hum beech me nahi aate — koi commission nahi, unlimited prints.": "Two ways: cash at the counter, or online payment (Razorpay/PhonePe) that goes straight into your own account. We do not sit in between — no commission, unlimited prints.",
    "Free demo se shuru karo. Phir Rs 399/month ka monthly plan ya Rs 999 one-time lifetime plan — ek baar do, hamesha chalao. Koi hidden charge nahi, koi per-print commission nahi.": "Start with the free demo. After that it is a ₹399/month monthly plan or a ₹999 one-time lifetime plan — pay once, run it forever. No hidden charges, no per-print commission.",
    "Har Windows printer ke saath — HP, Canon, Epson, Brother, sab. B&W aur Color ke liye alag printer set kar sakte ho. Advance me 4x6 photo printer, A3 bada printer aur duplex (dono side) printing bhi support hai.": "With every Windows printer — HP, Canon, Epson, Brother, all of them. You can set separate printers for B&W and Colour. The advanced features also support a 4x6 photo printer, a larger A3 printer and duplex (both-side) printing.",
    "Shop par laga QR code scan karo, file select karo (PDF, photo — ek saath kai files), edit karo (crop, rotate, brightness), payment karo (online ya counter cash) — print automatic nikal jata hai. Poora kaam customer ke phone se, 1 minute me.": "Scan the QR code displayed at the shop, select your files (PDF, photo — several at once), edit them (crop, rotate, brightness), pay (online or cash at the counter) — the print comes out automatically. All of it from the customer's phone, in about a minute.",
    "WhatsApp me aapka personal number public ho jata hai, chat me files kho jaati hain, aur hisaab manually rakhna padta hai. Echel me number private rehta hai, har print ka payment record automatic banta hai, aur customer ki file print ke 90 minute baad khud delete ho jaati hai.": "On WhatsApp your personal number becomes public, files get lost in the chat, and the accounts have to be kept by hand. With Echel your number stays private, every print gets a payment record automatically, and the customer's file deletes itself 90 minutes after printing.",
    "Echel cyber cafe aur print shop ke liye ek automatic print software hai. Aap apni shop ka QR code lagate ho — customer apne phone se scan karke file upload karta hai, payment karta hai, aur print aapke printer se automatic nikal jata hai. Na WhatsApp pe file mangni padti hai, na pendrive, na email.": "Echel is automatic print software for cyber cafes and print shops. You put up your shop's QR code — the customer scans it on their phone, uploads the file, pays, and the print comes out of your printer automatically. No asking for files on WhatsApp, no pen drive, no email."
  };
  for (var kf in EXTRA4) if (Object.prototype.hasOwnProperty.call(EXTRA4, kf)) EXTRA[kf] = EXTRA4[kf];

  function install() {
    if (window.QSPi18n && typeof window.QSPi18n.addDict === 'function') {
      window.QSPi18n.addDict(EXTRA);
      wrapDialogs();
    } else {
      // i18n.js abhi load nahi hua — dict me pehle se daal do,
      // wo start hote hi ise utha lega.
      window.QSP_EN_DICT = window.QSP_EN_DICT || {};
      for (var k in EXTRA) if (EXTRA.hasOwnProperty(k)) window.QSP_EN_DICT[k] = EXTRA[k];
    }
  }
  install();
  // defer/async ke order ke liye — agar i18n baad me aaya to dobara laga do
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  }
})();
