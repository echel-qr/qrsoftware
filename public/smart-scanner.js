/* ═══════════════════════════════════════════════════════════════════
   QR Se Print — SMART SCANNER
   ═══════════════════════════════════════════════════════════════════

   Document ka photo kheencho, scanner jaisa saaf page nikal aata hai.

   YE FILE ALAG KYUN HAI:
   customer.html 187 KB ki hai aur usme sab kuch chal raha hai. Scanner ka
   poora code usme ghusane se purana kuch toot sakta tha. Isliye saara kaam
   yahan hai — customer.html me sirf teen chhoti cheezein judti hain:
     1. <script src="/smart-scanner.js"></script>
     2. service card ki list me ek entry
     3. applyAdvancedGate() me ek flag

   BAHAR SE KYA CHAHIYE (customer.html me pehle se maujood):
     addPage(canvases, skipUIRender)   — page banata hai
     showChoiceScreen()                — "sab theek hai / edit karna hai"
     toast(msg)                        — chhota message
     A4_DISPLAY_W / A4_DISPLAY_H       — editor ka canvas size

   OpenCV.js JAAN-BOOJH KAR NAHI LIYA:
   uska wasm ~9 MB ka hai. Customer dukaan par mobile data par khada hota
   hai — scan shuru karne se pehle 9 MB utarna feature ko toota hua bana
   deta. Neeche saara CV saade JS + canvas me hai, kuch KB ka.

   PROCESSING SAB PHONE PAR HOTI HAI. Original camera photo server par
   kabhi nahi jaati — sirf banaya hua saaf page jaata hai, wahi purane
   upload raaste se.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── Settings ──────────────────────────────────────────────────────
  var DETECT_W      = 480;    // detection isi chaudai par hoti hai (tez)
  var LIVE_W        = 200;    // camera par live hint ke liye aur bhi chhota
  var OUT_LONG_EDGE = 2339;   // A4 @ ~200 DPI — print ke liye kaafi
  var CARD_LONG_EDGE = 1400;  // chhote card ko A4 jitna bada banane ka matlab nahi
  var LIVE_EVERY_MS = 420;

  // Standard document shapes — ratio = lamba / chhota
  var SHAPES = [
    { name: 'A4 / A5',  r: 297 / 210 },   // 1.414
    { name: 'Letter',   r: 279 / 216 },   // 1.294
    { name: 'Legal',    r: 356 / 216 },   // 1.647
    { name: '4x6',      r: 6 / 4 },       // 1.500
    { name: 'ID card',  r: 85.6 / 54 }    // 1.585
  ];
  var SNAP_TOLERANCE = 0.06;   // 6% ke andar ho to standard shape maan lo

  // Quality ki hadd — inse neeche "dobara kheencho" bolte hain
  var MIN_SHARPNESS = 55;      // Laplacian variance
  var MAX_GLARE     = 0.055;   // 5.5% se zyada jala hua area
  var MIN_BRIGHT    = 42;      // itna andhera matlab kuch dikhega hi nahi
  // Frame ka kam se kam itna hissa document hona chahiye.
  // 14% rakha tha to ID card / visiting card reject ho jaate the — unhe
  // haath me pakad kar photo lo to wo frame ka ~12% hi bharte hain.
  // Chhota rakhne se shor (noise) ka blob nahi ghusta, kyunki bhujaa-santulan
  // aur kone ka kona-check usay waise bhi nikaal dete hain.
  var MIN_QUAD_AREA = 0.075;
  var MIN_CONFIDENCE = 0.45;

  // ── State ─────────────────────────────────────────────────────────
  var stream = null, video = null, liveTimer = null;
  var capturedPages = [];      // { canvas, shape }
  var source = 'cam';          // 'cam' = camera, 'file' = device ki file
  var busy = false;

  // ═════════════════════════════════════════════════════════════════
  //  CHHOTE HELPERS
  // ═════════════════════════════════════════════════════════════════
  function el(id) { return document.getElementById(id); }

  function mkCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  // UI ko saans lene do — bade loop ke beech me call karte hain, warna
  // phone par screen jam ho jaati hai aur "Processing..." bhi nahi dikhta.
  function breathe() {
    return new Promise(function (r) { setTimeout(r, 0); });
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // ═════════════════════════════════════════════════════════════════
  //  GRAY + INTEGRAL IMAGE
  //  Integral image se box-blur aur local threshold dono O(1) per pixel
  //  ho jaate hain — isi ek trick par poora enhancement tika hai.
  // ═════════════════════════════════════════════════════════════════
  function toGray(data, w, h) {
    var g = new Float32Array(w * h);
    for (var i = 0, p = 0; i < g.length; i++, p += 4) {
      // Luma — aankh green ko sabse zyada dekhti hai
      g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
    return g;
  }

  function integral(g, w, h) {
    var ii = new Float64Array((w + 1) * (h + 1));
    for (var y = 0; y < h; y++) {
      var rowSum = 0;
      for (var x = 0; x < w; x++) {
        rowSum += g[y * w + x];
        ii[(y + 1) * (w + 1) + (x + 1)] = ii[y * (w + 1) + (x + 1)] + rowSum;
      }
    }
    return ii;
  }

  // (x0,y0)-(x1,y1) box ka average, dono taraf shaamil
  function boxMean(ii, w, x0, y0, x1, y1) {
    var W = w + 1;
    var a = ii[y0 * W + x0], b = ii[y0 * W + (x1 + 1)];
    var c = ii[(y1 + 1) * W + x0], d = ii[(y1 + 1) * W + (x1 + 1)];
    var n = (x1 - x0 + 1) * (y1 - y0 + 1);
    return (d - b - c + a) / n;
  }

  // ═════════════════════════════════════════════════════════════════
  //  QUALITY CHECK — spec ke section 22/23/24
  // ═════════════════════════════════════════════════════════════════
  function sharpness(g, w, h) {
    // Laplacian ka variance — dhundhli photo me kinare hote hi nahi,
    // isliye ye number gir jaata hai.
    var sum = 0, sum2 = 0, n = 0;
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var i = y * w + x;
        var l = -4 * g[i] + g[i - 1] + g[i + 1] + g[i - w] + g[i + w];
        sum += l; sum2 += l * l; n++;
      }
    }
    var mean = sum / n;
    return sum2 / n - mean * mean;
  }

  // Chamak SIRF document ke andar maayne rakhti hai. Table par padi
  // roshni se customer ka kaam nahi bigadta — pehle poore frame par
  // naapte the, isliye asli glare bhi chhota number ban kar nikal jaati thi.
  function glareFraction(g, w, h, quad) {
    var x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
    if (quad) {
      x0 = h; y0 = w; x1 = 0; y1 = 0;
      for (var k = 0; k < 4; k++) {
        x0 = Math.min(x0, quad[k][0]); x1 = Math.max(x1, quad[k][0]);
        y0 = Math.min(y0, quad[k][1]); y1 = Math.max(y1, quad[k][1]);
      }
      x0 = clamp(Math.round(x0), 0, w - 1); x1 = clamp(Math.round(x1), 0, w - 1);
      y0 = clamp(Math.round(y0), 0, h - 1); y1 = clamp(Math.round(y1), 0, h - 1);
      if (x1 - x0 < 8 || y1 - y0 < 8) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }
    }
    var n = 0, tot = 0;
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) { if (g[y * w + x] > 248) n++; tot++; }
    }
    return tot ? n / tot : 0;
  }

  function meanBrightness(g) {
    var s = 0;
    for (var i = 0; i < g.length; i++) s += g[i];
    return s / g.length;
  }

  // ═════════════════════════════════════════════════════════════════
  //  DOCUMENT DETECTION
  //
  //  Tarika: document aksar background se alag chamak ka hota hai.
  //    gray -> Otsu threshold -> sabse bada connected blob -> convex hull
  //    -> us hull me sabse bade area wala chaturbhuj (quad)
  //
  //  "Safed kagaz safed table par" jaise case me ye kamzor pad jaata hai —
  //  tab confidence gir jaati hai aur hum customer se dobara photo maangte
  //  hain (spec section 7). Galat kata hua document dene se ye behtar hai.
  // ═════════════════════════════════════════════════════════════════
  function otsu(g) {
    var hist = new Float64Array(256), i;
    for (i = 0; i < g.length; i++) hist[clamp(g[i] | 0, 0, 255)]++;
    var total = g.length, sum = 0;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, best = 0, thr = 127;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = i; }
    }
    return thr;
  }

  // Sabse bada connected component — iterative flood fill (recursion se
  // phone par stack phat jaata hai)
  function largestBlob(bin, w, h) {
    var label = new Int32Array(w * h);
    var best = null, cur = 0;
    var stack = new Int32Array(w * h);
    for (var s = 0; s < w * h; s++) {
      if (!bin[s] || label[s]) continue;
      cur++;
      var top = 0, count = 0;
      var minX = w, minY = h, maxX = 0, maxY = 0;
      stack[top++] = s; label[s] = cur;
      while (top > 0) {
        var p = stack[--top];
        var px = p % w, py = (p / w) | 0;
        count++;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        if (px > 0     && bin[p - 1] && !label[p - 1]) { label[p - 1] = cur; stack[top++] = p - 1; }
        if (px < w - 1 && bin[p + 1] && !label[p + 1]) { label[p + 1] = cur; stack[top++] = p + 1; }
        if (py > 0     && bin[p - w] && !label[p - w]) { label[p - w] = cur; stack[top++] = p - w; }
        if (py < h - 1 && bin[p + w] && !label[p + w]) { label[p + w] = cur; stack[top++] = p + w; }
      }
      if (!best || count > best.count) {
        best = { label: cur, count: count, minX: minX, minY: minY, maxX: maxX, maxY: maxY };
      }
    }
    return best ? { label: label, blob: best } : null;
  }

  function hullPoints(label, id, w, h) {
    // Sirf blob ka boundary chahiye — har row ka pehla/aakhri pixel kaafi hai
    var pts = [];
    for (var y = 0; y < h; y++) {
      var first = -1, last = -1;
      for (var x = 0; x < w; x++) {
        if (label[y * w + x] === id) { if (first < 0) first = x; last = x; }
      }
      if (first >= 0) { pts.push([first, y]); if (last !== first) pts.push([last, y]); }
    }
    for (var x2 = 0; x2 < w; x2++) {
      var f = -1, l = -1;
      for (var y2 = 0; y2 < h; y2++) {
        if (label[y2 * w + x2] === id) { if (f < 0) f = y2; l = y2; }
      }
      if (f >= 0) { pts.push([x2, f]); if (l !== f) pts.push([x2, l]); }
    }
    return convexHull(pts);
  }

  function convexHull(pts) {
    if (pts.length < 4) return pts;
    pts = pts.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var cross = function (o, a, b) {
      return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    };
    var lower = [], i;
    for (i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    var upper = [];
    for (i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  function polyArea(p) {
    var a = 0;
    for (var i = 0, n = p.length; i < n; i++) {
      var j = (i + 1) % n;
      a += p[i][0] * p[j][1] - p[j][0] * p[i][1];
    }
    return Math.abs(a) / 2;
  }

  // Chaar point ka area — bina array banaye (shoelace).
  // polyArea() har baar ek naya array banata tha; ye loop lakhon baar
  // chalta hai, isliye wahan allocation sabse mehnga pad raha tha.
  function quadArea(a, b, c, d) {
    return Math.abs(
      a[0] * b[1] - b[0] * a[1] +
      b[0] * c[1] - c[0] * b[1] +
      c[0] * d[1] - d[0] * c[1] +
      d[0] * a[1] - a[0] * d[1]
    ) / 2;
  }

  // Hull me se 4 point chuno jinka area sabse bada ho.
  //
  // TEZ RAKHNA ZAROORI HAI: camera par live hint har ~400ms yahi chalata
  // hai. 40 point par ye loop 91,000 baar ghoomta tha aur ek detect ~3
  // second le raha tha — phone par ye bilkul nahi chalta. 24 point par
  // 10,600 baar (8.6 guna kam), aur area bina array banaye nikaalte hain.
  // Document ke kone itne point me aaram se aa jaate hain.
  function biggestQuad(hull) {
    if (hull.length < 4) return null;
    var h = hull, MAXP = 24;
    if (h.length > MAXP) {
      var step = h.length / MAXP, thin = [];
      for (var t = 0; t < MAXP; t++) thin.push(h[Math.floor(t * step)]);
      h = thin;
    }
    var n = h.length, bestA = 0;
    var bi = -1, bj = -1, bk = -1, bl = -1;
    for (var i = 0; i < n - 3; i++) {
      var pi = h[i];
      for (var j = i + 1; j < n - 2; j++) {
        var pj = h[j];
        for (var k = j + 1; k < n - 1; k++) {
          var pk = h[k];
          for (var l = k + 1; l < n; l++) {
            var a = quadArea(pi, pj, pk, h[l]);
            if (a > bestA) { bestA = a; bi = i; bj = j; bk = k; bl = l; }
          }
        }
      }
    }
    return bi < 0 ? null : [h[bi], h[bj], h[bk], h[bl]];
  }

  // TL, TR, BR, BL ke kram me lagao
  function orderCorners(q) {
    var cx = 0, cy = 0, i;
    for (i = 0; i < 4; i++) { cx += q[i][0]; cy += q[i][1]; }
    cx /= 4; cy /= 4;
    var withAngle = q.map(function (p) {
      return { p: p, a: Math.atan2(p[1] - cy, p[0] - cx) };
    }).sort(function (a, b) { return a.a - b.a; });
    // atan2 ka -PI upar-baayein se shuru hota hai
    var pts = withAngle.map(function (o) { return o.p; });
    // sabse upar-baayein wale ko pehla banao
    var startIdx = 0, bestScore = Infinity;
    for (i = 0; i < 4; i++) {
      var sc = pts[i][0] + pts[i][1];
      if (sc < bestScore) { bestScore = sc; startIdx = i; }
    }
    return [pts[startIdx], pts[(startIdx + 1) % 4], pts[(startIdx + 2) % 4], pts[(startIdx + 3) % 4]];
  }

  function dist(a, b) {
    var dx = a[0] - b[0], dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Quad kitna "document jaisa" hai — 0 se 1
  function quadConfidence(q, w, h) {
    var area = polyArea(q) / (w * h);
    if (area < MIN_QUAD_AREA) return 0;

    // ── POORA FRAME = DETECTION FAIL ──
    // Ye sabse zaroori check hai. Poori image ek perfect rectangle hai
    // jiska area sabse bada hota hai, isliye baaki har naap usse 1.00
    // score deta tha — aur "detection fail" hi sabse "confident" jawab
    // ban jaata tha. Table/background ka blob theek yahi shakl deta hai.
    // Asli document ke chaaron taraf thodi jagah bachti hai.
    if (area > 0.90) return 0;
    var edgeTouch = 0;
    for (var t = 0; t < 4; t++) {
      if (q[t][0] < w * 0.02 || q[t][0] > w * 0.98) edgeTouch++;
      if (q[t][1] < h * 0.02 || q[t][1] > h * 0.98) edgeTouch++;
    }
    if (edgeTouch >= 6) return 0;      // lagbhag har kona image ke kinare par
    // 0.72 se upar jaate hi bharosa ghatne lagta hai
    var roomy = area > 0.72 ? Math.max(0, 1 - (area - 0.72) / 0.18) : 1;
    // Aamne-saamne ki bhujaayein aas-paas barabar honi chahiye
    var top = dist(q[0], q[1]), bottom = dist(q[3], q[2]);
    var left = dist(q[0], q[3]), right = dist(q[1], q[2]);
    var hBal = Math.min(top, bottom) / Math.max(top, bottom);
    var vBal = Math.min(left, right) / Math.max(left, right);
    // Har kona thoda-bahut 90° ke aas-paas ho (bahut tirchha nahi)
    var cornerOk = 1;
    for (var i = 0; i < 4; i++) {
      var p0 = q[(i + 3) % 4], p1 = q[i], p2 = q[(i + 1) % 4];
      var v1x = p0[0] - p1[0], v1y = p0[1] - p1[1];
      var v2x = p2[0] - p1[0], v2y = p2[1] - p1[1];
      var cosA = (v1x * v2x + v1y * v2y) /
                 (Math.sqrt(v1x * v1x + v1y * v1y) * Math.sqrt(v2x * v2x + v2y * v2y) + 1e-6);
      cornerOk = Math.min(cornerOk, 1 - Math.abs(cosA));   // 90° par cos 0
    }
    var score = 0.45 * hBal + 0.45 * vBal + 0.30 * cornerOk +
                0.25 * Math.min(1, area / 0.5) - 0.25;
    return clamp(score * roomy, 0, 1);
  }

  function detectQuad(srcCanvas, targetW) {
    var sc = targetW / srcCanvas.width;
    var w = Math.max(60, Math.round(srcCanvas.width * sc));
    var h = Math.max(60, Math.round(srcCanvas.height * sc));
    var c = mkCanvas(w, h);
    var ctx = c.getContext('2d');
    ctx.drawImage(srcCanvas, 0, 0, w, h);
    var img = ctx.getImageData(0, 0, w, h);
    var g = toGray(img.data, w, h);

    var thr = otsu(g);
    // Document = ujla hissa. Dono taraf try karte hain — kabhi kagaz
    // background se gehra bhi hota hai (kaala table nahi, safed table).
    var out = null, outConf = 0;
    [true, false].forEach(function (bright) {
      var bin = new Uint8Array(w * h);
      for (var i = 0; i < g.length; i++) bin[i] = (bright ? g[i] > thr : g[i] < thr) ? 1 : 0;
      var res = largestBlob(bin, w, h);
      if (!res) return;
      var hull = hullPoints(res.label, res.blob.label, w, h);
      var quad = biggestQuad(hull);
      if (!quad) return;
      var oq = orderCorners(quad);
      var conf = quadConfidence(oq, w, h);
      if (conf > outConf) { outConf = conf; out = oq; }
    });

    if (!out) return { quad: null, confidence: 0, gray: g, w: w, h: h };
    // Wapas asli image ke paimane par
    var full = out.map(function (p) { return [p[0] / sc, p[1] / sc]; });
    return { quad: full, confidence: outConf, gray: g, w: w, h: h };
  }

  // ═════════════════════════════════════════════════════════════════
  //  PERSPECTIVE — homography nikaalo aur image ko seedha karo
  //  (sirf crop nahi — asli perspective correction, spec section 8)
  // ═════════════════════════════════════════════════════════════════
  function solve8(A, b) {
    // Gaussian elimination with partial pivoting
    var n = 8, i, j, k;
    for (i = 0; i < n; i++) {
      var piv = i;
      for (k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[piv][i])) piv = k;
      if (Math.abs(A[piv][i]) < 1e-9) return null;
      if (piv !== i) { var t = A[i]; A[i] = A[piv]; A[piv] = t; var tb = b[i]; b[i] = b[piv]; b[piv] = tb; }
      for (k = i + 1; k < n; k++) {
        var f = A[k][i] / A[i][i];
        for (j = i; j < n; j++) A[k][j] -= f * A[i][j];
        b[k] -= f * b[i];
      }
    }
    var x = new Float64Array(n);
    for (i = n - 1; i >= 0; i--) {
      var s = b[i];
      for (j = i + 1; j < n; j++) s -= A[i][j] * x[j];
      x[i] = s / A[i][i];
    }
    return x;
  }

  // dst (seedha rectangle) se src (tirchha document) ka mapping —
  // inverse mapping isliye ki har output pixel ko source me dhoondh sakein
  function homography(dst, src) {
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var X = dst[i][0], Y = dst[i][1], u = src[i][0], v = src[i][1];
      A.push([X, Y, 1, 0, 0, 0, -X * u, -Y * u]); b.push(u);
      A.push([0, 0, 0, X, Y, 1, -X * v, -Y * v]); b.push(v);
    }
    var s = solve8(A, b);
    if (!s) return null;
    return [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], 1];
  }

  async function warp(srcCanvas, quad, outW, outH) {
    var H = homography(
      [[0, 0], [outW - 1, 0], [outW - 1, outH - 1], [0, outH - 1]],
      quad
    );
    if (!H) return null;

    var sctx = srcCanvas.getContext('2d');
    var sImg = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
    var sD = sImg.data, sw = srcCanvas.width, sh = srcCanvas.height;

    var out = mkCanvas(outW, outH);
    var octx = out.getContext('2d');
    var oImg = octx.createImageData(outW, outH);
    var oD = oImg.data;

    // Band-band karke — har band ke BAAD saans, band ke ANDAR nahi.
    // Pehle `await` isi loop ke andar tha aur poori A4 ko seedha karne me
    // 7.4 SECOND lagte the: async function ke andar await hone se V8 pure
    // loop ko optimize karna chhod deta hai. Ab asli kaam ek saade
    // function me hai (warpBand), jise V8 poori tarah optimize karta hai.
    var BAND = 96;
    for (var yy = 0; yy < outH; yy += BAND) {
      warpBand(sD, sw, sh, oD, outW, H, yy, Math.min(outH, yy + BAND));
      await breathe();
    }
    octx.putImageData(oImg, 0, 0);
    return out;
  }

  function warpBand(sD, sw, sh, oD, outW, H, yFrom, yTo) {
    var h0 = H[0], h1 = H[1], h2 = H[2], h3 = H[3], h4 = H[4],
        h5 = H[5], h6 = H[6], h7 = H[7], h8 = H[8];
    var swm = sw - 1, shm = sh - 1;
    for (var y = yFrom; y < yTo; y++) {
      var o = (y * outW) * 4;
      for (var x = 0; x < outW; x++, o += 4) {
        var d = h6 * x + h7 * y + h8;
        var u = (h0 * x + h1 * y + h2) / d;
        var v = (h3 * x + h4 * y + h5) / d;
        if (u < 0 || v < 0 || u > swm || v > shm) {
          oD[o] = 255; oD[o + 1] = 255; oD[o + 2] = 255; oD[o + 3] = 255;
          continue;
        }
        // Bilinear — nearest lene par text ke kinare tootey hue dikhte hain
        var x0 = u | 0, y0 = v | 0;
        var x1 = x0 < swm ? x0 + 1 : x0;
        var y1 = y0 < shm ? y0 + 1 : y0;
        var fx = u - x0, fy = v - y0, gx = 1 - fx, gy = 1 - fy;
        var i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
        var i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        oD[o]     = (sD[i00]     * gx + sD[i10]     * fx) * gy + (sD[i01]     * gx + sD[i11]     * fx) * fy;
        oD[o + 1] = (sD[i00 + 1] * gx + sD[i10 + 1] * fx) * gy + (sD[i01 + 1] * gx + sD[i11 + 1] * fx) * fy;
        oD[o + 2] = (sD[i00 + 2] * gx + sD[i10 + 2] * fx) * gy + (sD[i01 + 2] * gx + sD[i11 + 2] * fx) * fy;
        oD[o + 3] = 255;
      }
    }
  }

  // ═════════════════════════════════════════════════════════════════
  //  ENHANCEMENT
  //  Ek hi trick se teen kaam: chhaya hatti hai, roshni barabar hoti hai,
  //  aur background saaf safed ho jaata hai —
  //     pixel ÷ (uske aas-paas ka background)
  //  Background bade radius ke box-blur se nikalta hai. Text chhota hota
  //  hai isliye blur me ghul jaata hai aur bach jaata hai; chhaya bada
  //  aur dheema hota hai isliye kat jaati hai.
  // ═════════════════════════════════════════════════════════════════
  // Do bilkul alag cheezein scan hoti hain, aur dono ka ilaaj alag hai:
  //
  //  'paper' — saada kagaz, kaala likha safed par. Yahan local background
  //            normalization sahi hai: chhaya hatti hai, likha ubharta hai.
  //
  //  'card'  — Aadhaar/PAN jaise rangeen card, jisme photo, hologram aur
  //            barik security pattern hote hain. Inpar wahi normalization
  //            NUKSAN karta hai: bade ek-rang wale hisse chapat ho jaate
  //            hain, noise daag ban kar ubhar aata hai, aur chehre wali
  //            photo dhul jaati hai. Isliye card mode me sirf halka global
  //            contrast + white balance — na local normalization, na unsharp.
  async function enhance(canvas, mode) {
    if (mode === 'card') return enhanceCard(canvas);
    var w = canvas.width, h = canvas.height;
    var ctx = canvas.getContext('2d');
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;

    var g = toGray(d, w, h);
    var ii = integral(g, w, h);
    var R = Math.max(12, Math.round(Math.min(w, h) / 12));   // background ka radius

    // 1. Illumination + shadow + background — sab ek saath
    var norm = new Float32Array(w * h);
    for (var yy = 0; yy < h; yy += 96) {
      normBand(ii, g, norm, w, h, R, yy, Math.min(h, yy + 96));
      await breathe();
    }

    // 2. Kitna gehra likha hua hai — isse contrast ka paimana milta hai
    var lo = 255, hi = 0;
    for (var s = 0; s < norm.length; s += 7) {          // sampling kaafi hai
      if (norm[s] < lo) lo = norm[s];
      if (norm[s] > hi) hi = norm[s];
    }
    var span = Math.max(40, hi - lo);

    // 3. Rang wapas jodo. Gray ka jitna sudhaar hua utna hi har channel par
    //    lagao — isse logo, stamp, signature ka rang bacha rehta hai
    //    (spec section 36: overprocess mat karo).
    var out = ctx.createImageData(w, h);
    var oD = out.data;
    for (var p = 0, q = 0; p < norm.length; p++, q += 4) {
      var ratio = g[p] > 1 ? norm[p] / g[p] : 1;
      // halka contrast stretch
      var lift = clamp((norm[p] - lo) / span, 0, 1);
      var curved = lift * lift * (3 - 2 * lift);          // smoothstep — natural lagta hai
      var mix = 0.65 + 0.35 * curved;
      for (var ch = 0; ch < 3; ch++) {
        oD[q + ch] = clamp(d[q + ch] * ratio * mix, 0, 255);
      }
      oD[q + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    await breathe();

    // 4. Halka sharpen — text ke kinare saaf, par halo nahi
    await unsharp(ctx, w, h, 0.45);
    return canvas;
  }

  // Rangeen card ke liye halka ilaaj: safed ko safed banao (white balance)
  // aur bas thoda contrast. Detail ko haath nahi lagate.
  async function enhanceCard(canvas) {
    var w = canvas.width, h = canvas.height;
    var ctx = canvas.getContext('2d');
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;

    // Har channel ka 97th percentile — yahi "safed" maana jaata hai.
    // Sabse ujla pixel lene se ek chamak wala daag poori tasveer bigaad
    // deta hai, isliye percentile.
    var hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    var n = 0;
    for (var p = 0; p < d.length; p += 16) {          // sampling kaafi hai
      hist[0][d[p]]++; hist[1][d[p + 1]]++; hist[2][d[p + 2]]++; n++;
    }
    var white = [255, 255, 255];
    for (var ch = 0; ch < 3; ch++) {
      var acc = 0, cut = n * 0.97;
      for (var v = 0; v < 256; v++) {
        acc += hist[ch][v];
        if (acc >= cut) { white[ch] = Math.max(60, v); break; }
      }
    }
    var gain = [255 / white[0], 255 / white[1], 255 / white[2]];
    // Rang na bigde isliye gain ko kaabu me rakho
    for (var k = 0; k < 3; k++) gain[k] = clamp(gain[k], 1, 1.35);

    await breathe();

    // Halka S-curve — contrast thoda badhta hai par detail nahi udti
    var lut = new Uint8Array(256);
    for (var i = 0; i < 256; i++) {
      var t = i / 255;
      var s = t + 0.14 * (t - 0.5) * (1 - Math.abs(t - 0.5) * 2);
      lut[i] = clamp(Math.round(s * 255), 0, 255);
    }
    for (var q = 0; q < d.length; q += 4) {
      d[q]     = lut[clamp(Math.round(d[q]     * gain[0]), 0, 255)];
      d[q + 1] = lut[clamp(Math.round(d[q + 1] * gain[1]), 0, 255)];
      d[q + 2] = lut[clamp(Math.round(d[q + 2] * gain[2]), 0, 255)];
      d[q + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    await breathe();
    return canvas;
  }

  function normBand(ii, g, norm, w, h, R, yFrom, yTo) {
    for (var y = yFrom; y < yTo; y++) {
      var y0 = y - R < 0 ? 0 : y - R;
      var y1 = y + R > h - 1 ? h - 1 : y + R;
      var row = y * w;
      for (var x = 0; x < w; x++) {
        var x0 = x - R < 0 ? 0 : x - R;
        var x1 = x + R > w - 1 ? w - 1 : x + R;
        var bg = boxMean(ii, w, x0, y0, x1, y1);
        var i = row + x;
        var v = bg > 1 ? (g[i] / bg) * 235 : g[i];
        norm[i] = v < 0 ? 0 : (v > 255 ? 255 : v);
      }
    }
  }

  function unsharpBand(ii, g, d, oD, w, h, amount, yFrom, yTo) {
    for (var y = yFrom; y < yTo; y++) {
      var y0 = y < 1 ? 0 : y - 1, y1 = y > h - 2 ? h - 1 : y + 1;
      var row = y * w;
      for (var x = 0; x < w; x++) {
        var x0 = x < 1 ? 0 : x - 1, x1 = x > w - 2 ? w - 1 : x + 1;
        var blur = boxMean(ii, w, x0, y0, x1, y1);
        var i = row + x, q = i * 4;
        var boost = (g[i] - blur) * amount;
        var r = d[q] + boost, gg = d[q + 1] + boost, b = d[q + 2] + boost;
        oD[q]     = r < 0 ? 0 : (r > 255 ? 255 : r);
        oD[q + 1] = gg < 0 ? 0 : (gg > 255 ? 255 : gg);
        oD[q + 2] = b < 0 ? 0 : (b > 255 ? 255 : b);
        oD[q + 3] = 255;
      }
    }
  }

  async function unsharp(ctx, w, h, amount) {
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;
    var g = toGray(d, w, h);
    var ii = integral(g, w, h);
    var out = ctx.createImageData(w, h);
    var oD = out.data;
    for (var yy = 0; yy < h; yy += 128) {
      unsharpBand(ii, g, d, oD, w, h, amount, yy, Math.min(h, yy + 128));
      await breathe();
    }
    ctx.putImageData(out, 0, 0);
  }

  // ═════════════════════════════════════════════════════════════════
  //  OUTPUT SIZE — document ki asli shape ka andaaza
  // ═════════════════════════════════════════════════════════════════
  function outputSize(quad) {
    var top = dist(quad[0], quad[1]), bottom = dist(quad[3], quad[2]);
    var left = dist(quad[0], quad[3]), right = dist(quad[1], quad[2]);
    var wAvg = (top + bottom) / 2, hAvg = (left + right) / 2;
    var ratio = Math.max(wAvg, hAvg) / Math.max(1, Math.min(wAvg, hAvg));

    // Standard shape ke kareeb ho to usi par set kar do — warna har scan
    // thoda-thoda alag anupaat me aata hai aur print par ajeeb lagta hai.
    //
    // DHYAAN: sabse KAREEBI shape chunni hai, pehli milne wali nahi.
    // Legal (1.647) aur ID card (1.585) sirf 3.8% door hain — pehle
    // wale tarike me ID card "Legal" ban kar A4 jitna bada ho jaata tha.
    var shape = null, bestErr = SNAP_TOLERANCE;
    for (var i = 0; i < SHAPES.length; i++) {
      var err = Math.abs(ratio - SHAPES[i].r) / SHAPES[i].r;
      if (err < bestErr) { bestErr = err; shape = SHAPES[i].name; }
    }
    if (shape) {
      for (var j = 0; j < SHAPES.length; j++) {
        if (SHAPES[j].name === shape) { ratio = SHAPES[j].r; break; }
      }
    }
    // Card jaisa chhota document A4 jitna bada banane ka koi matlab nahi
    // (spec section 38) — anupaat wahi rehta hai, bas pixel kam.
    var longEdge = (shape === 'ID card' || shape === '4x6') ? CARD_LONG_EDGE : OUT_LONG_EDGE;
    var portrait = hAvg >= wAvg;
    var L = longEdge, S = Math.round(longEdge / ratio);
    return portrait
      ? { w: S, h: L, shape: shape || 'custom' }
      : { w: L, h: S, shape: shape || 'custom' };
  }

  // ═════════════════════════════════════════════════════════════════
  //  UI
  // ═════════════════════════════════════════════════════════════════
  var CSS = [
    '.ssTpl{display:flex;flex-direction:column;gap:9px;margin:16px 0 4px;width:100%;}',
    '.ssTplBtn{display:flex;align-items:center;gap:12px;width:100%;text-align:left;',
    '  background:#1a1d23;border:1.5px solid #2b3038;border-radius:14px;',
    '  padding:13px 14px;cursor:pointer;font-family:inherit;color:#fff;}',
    '.ssTplBtn:active{background:#232830;}',
    '.ssTplIco{font-size:24px;line-height:1;flex:0 0 auto;}',
    '.ssTplThumb{flex:0 0 auto;line-height:0;display:block;}',
    '.ssTplThumb svg{display:block;border-radius:3px;}',
    '.ssTplTxt{display:flex;flex-direction:column;gap:3px;min-width:0;}',
    '.ssTplTxt b{font-size:14.5px;font-weight:800;}',
    '.ssTplTxt i{font-style:normal;font-size:11.5px;color:#9aa3ad;line-height:1.45;}',
    '#ssWrap{position:fixed;inset:0;z-index:99999;background:#0b0d10;display:none;',
      'flex-direction:column;font-family:inherit;color:#fff;}',
    '#ssWrap.on{display:flex;}',
    '#ssTop{padding:14px 16px;display:flex;align-items:center;gap:10px;',
      'background:#0b0d10;border-bottom:1px solid #1e242c;flex:none;}',
    '#ssTop b{font-size:15px;font-weight:700;letter-spacing:.2px;}',
    '#ssClose{margin-left:auto;background:none;border:0;color:#9aa5b1;font-size:26px;',
      'line-height:1;cursor:pointer;padding:0 4px;}',
    '#ssStage{flex:1;position:relative;overflow:hidden;background:#000;',
      'display:flex;align-items:center;justify-content:center;}',
    '#ssVideo{width:100%;height:100%;object-fit:cover;}',
    '#ssGuide{position:absolute;inset:8% 6%;border:2px dashed rgba(255,255,255,.55);',
      'border-radius:14px;pointer-events:none;transition:border-color .2s;}',
    '#ssGuide.lock{border-color:#22c55e;border-style:solid;',
      'box-shadow:0 0 0 9999px rgba(0,0,0,.28);}',
    '#ssHint{position:absolute;left:0;right:0;bottom:14px;text-align:center;',
      'font-size:14px;color:#e6eaf0;text-shadow:0 1px 3px rgba(0,0,0,.8);pointer-events:none;}',
    '#ssHint .ok{color:#4ade80;font-weight:700;}',
    '#ssBar{flex:none;padding:16px;display:flex;gap:12px;align-items:center;',
      'justify-content:center;background:#0b0d10;border-top:1px solid #1e242c;}',
    '.ssBtn{border:0;border-radius:12px;padding:14px 20px;font-size:15px;font-weight:700;',
      'cursor:pointer;font-family:inherit;}',
    '.ssPri{background:#16a34a;color:#fff;flex:1;max-width:280px;}',
    '.ssSec{background:#1b222b;color:#dbe3ec;}',
    // "Add Back Side" ko jaan-bujh ke halka rakha hai. Pehle wo hara
    // (ssPri) tha aur "aage badho" phika — aankh seedha hare par jaati
    // thi, isliye log galti se baar-baar back side me chale jaate the.
    // Ab hara sirf aage badhne wale par hai.
    '.ssAdd{background:transparent;color:#f0b429;border:1.5px solid #6b5320;}',
    '.ssAdd:active{background:#2a2413;}',
    '#ssShot{width:74px;height:74px;border-radius:50%;background:#fff;border:5px solid #2a323d;',
      'cursor:pointer;flex:none;}',
    '#ssShot:active{transform:scale(.94);}',
    '#ssPanel{position:absolute;inset:0;background:#0f1318;display:none;',
      'flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;}',
    '#ssPanel.on{display:flex;}',
    '#ssPanel h3{font-size:19px;margin:0 0 8px;font-weight:700;}',
    '#ssPanel p{font-size:14px;color:#9aa5b1;margin:0 0 20px;max-width:34ch;line-height:1.55;}',
    '#ssPrev{max-width:min(74vw,340px);max-height:44vh;border-radius:8px;',
      'background:#fff;box-shadow:0 10px 40px rgba(0,0,0,.55);}',
    '#ssSpin{width:44px;height:44px;border:4px solid #263040;border-top-color:#22c55e;',
      'border-radius:50%;animation:ssSpin 1s linear infinite;margin-bottom:18px;}',
    '@keyframes ssSpin{to{transform:rotate(360deg)}}',
    '#ssPanel .row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:18px;}',
    '#ssCount{font-size:12px;color:#6b7684;margin-top:14px;}',
    '@media (prefers-reduced-motion:reduce){#ssSpin{animation:none}}'
  ].join('');

  var HTML =
    '<div id="ssTop"><b>📸 Smart Scanner</b>' +
      '<button id="ssClose" aria-label="Band karo">&times;</button></div>' +
    '<div id="ssStage">' +
      '<video id="ssVideo" playsinline muted autoplay></video>' +
      '<div id="ssGuide"></div>' +
      '<div id="ssHint">Document ko frame ke andar rakho</div>' +
      '<div id="ssPanel"></div>' +
    '</div>' +
    '<div id="ssBar"><button id="ssShot" aria-label="Photo kheencho"></button></div>';

  function mount() {
    if (el('ssWrap')) return;
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    var wrap = document.createElement('div');
    wrap.id = 'ssWrap';
    wrap.innerHTML = HTML;
    document.body.appendChild(wrap);
    el('ssClose').onclick = quit;
    el('ssShot').onclick = capture;
    video = el('ssVideo');

    // Files wala rasta. Input overlay ke ANDAR rakha hai taaki overlay ke
    // saath hi jiye-mare. value har baar khali karte hain, warna wahi file
    // dobara chunne par change event aata hi nahi.
    var fi = document.createElement('input');
    fi.type = 'file';
    fi.accept = 'image/*';
    fi.id = 'ssFile';
    fi.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
    fi.onchange = function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (f) useFile(f);
    };
    wrap.appendChild(fi);
  }

  function panel(html) {
    var p = el('ssPanel');
    p.innerHTML = html;
    p.classList.add('on');
  }
  function hidePanel() { el('ssPanel').classList.remove('on'); }

  function showBar(on) { el('ssBar').style.display = on ? 'flex' : 'none'; }

  function processing(msg) {
    showBar(false);
    panel('<div id="ssSpin"></div><h3>' + msg + '</h3>' +
          '<p>Ek pal — document saaf kiya ja raha hai.</p>');
  }

  // Har error ka ek hi roop — customer ko technical baat kabhi nahi dikhti
  function problem(title, detail, retryLabel) {
    showBar(false);
    panel('<h3>' + title + '</h3><p>' + detail + '</p>' +
          '<div class="row">' +
          '<button class="ssBtn ssPri" id="ssRetry">' + (retryLabel || 'Dobara photo lo') + '</button>' +
          '<button class="ssBtn ssSec" id="ssQuit">Band karo</button>' +
          '</div>');
    el('ssRetry').onclick = function () {
      hidePanel();
      if (source === 'file') { showBar(false); pickFile(); return; }
      showBar(true); startCamera();
    };
    el('ssQuit').onclick = quit;
  }

  // ═════════════════════════════════════════════════════════════════
  //  CAMERA
  // ═════════════════════════════════════════════════════════════════
  // Browser ne camera ke baare me kya faisla kar rakha hai.
  // 'denied'  = customer pehle "Block" daba chuka hai — ab JS se popup
  //             LAAYA HI NAHI JA SAKTA, settings hi ek rasta hai
  // 'prompt'  = abhi kuch tay nahi — getUserMedia popup dikhayega
  // 'unknown' = browser batata hi nahi (iOS Safari) — seedha try karo
  async function camPermState() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
      var st = await navigator.permissions.query({ name: 'camera' });
      return st && st.state ? st.state : 'unknown';
    } catch (e) { return 'unknown'; }
  }

  async function startCamera() {
    stopLive();

    // Pehle se BLOCK hai to getUserMedia turant reject hoti hai aur
    // koi popup nahi aata. Aise me "Dobara koshish karo" bekaar hai —
    // customer wahi button dabata rehta hai. Seedha rasta batao.
    if ((await camPermState()) === 'denied') { return camBlockedPanel(); }

    try {
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });

      // Ye call CLICK ke turant baad chalti hai, isliye browser ka
      // "Allow camera?" popup apne aap saamne aata hai.
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width:  { ideal: 1920 },
            height: { ideal: 1440 }
          },
          audio: false
        });
      } catch (e1) {
        // Kuch purane phone 1920x1440 ya back-camera ki maang par hi
        // mana kar dete hain (ijazat se koi lena-dena nahi). Aise me
        // ek baar bina koi shart ke maang lo — zyadatar chal jaata hai.
        if (e1 && (e1.name === 'OverconstrainedError' ||
                   e1.name === 'NotFoundError' ||
                   e1.name === 'NotReadableError')) {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } else { throw e1; }
      }

      video.srcObject = stream;
      await video.play();
      hidePanel();
      showBar(true);
      startLive();
    } catch (e) {
      var name = (e && e.name) || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        // Do bilkul alag halat, dono ka error naam ek hi hai:
        //   • "Block" daba diya       → permission ab 'denied'
        //   • popup ko swipe kar diya → permission abhi bhi 'prompt'
        // Doosre case me dobara maangne par popup FIR aata hai, isliye
        // usme customer ko settings me bhejna galat hai.
        var st = await camPermState();
        if (st === 'denied') return camBlockedPanel();
        showBar(false);
        panel('<h3>Camera chahiye hoga</h3>' +
              '<p>Neeche wala button dabao aur phone par jo popup aaye usme ' +
              '<b>Allow</b> chun lo. Photo sirf aapke phone me banti hai.</p>' +
              '<div class="row">' +
              '<button class="ssBtn ssPri" id="ssRetry">\uD83D\uDCF7 Camera Allow Karo</button>' +
              '<button class="ssBtn ssSec" id="ssQuit">Band karo</button></div>');
        el('ssRetry').onclick = startCamera;
        el('ssQuit').onclick = quit;
        return;
      }
      showBar(false);
      panel('<h3>Camera nahi khul paya</h3>' +
            '<p>Is phone ka camera shayad kisi aur app me chal raha hai. ' +
            'Wo app band karke dobara koshish karo.</p>' +
            '<div class="row">' +
            '<button class="ssBtn ssPri" id="ssRetry">Dobara koshish karo</button>' +
            '<button class="ssBtn ssSec" id="ssQuit">Band karo</button></div>');
      el('ssRetry').onclick = startCamera;
      el('ssQuit').onclick = quit;
    }
  }

  // Camera BLOCK ho chuka hai. Yahan se browser ka popup dobara laana
  // mumkin nahi hai — ye browser ka niyam hai, koi bhi website ise
  // nahi laa sakti. Isliye jhooth mat bolo ki "dobara koshish karo";
  // theek-theek 3 step batao aur reload ka button do (setting badalne
  // ke baad page reload kiye bina asar nahi hota).
  function camBlockedPanel() {
    showBar(false);
    panel('<h3>Camera band kar rakha hai</h3>' +
          '<p style="text-align:left;line-height:1.85;">' +
          'Is site ke liye camera pehle <b>Block</b> ho chuka hai, isliye ' +
          'ijazat ka popup ab apne aap nahi aayega. 10 second ka kaam hai:' +
          '<br><br>' +
          '<b>1.</b> Upar address bar me, website ke naam se just pehle wale ' +
          '<b>\uD83D\uDD12 / \u2139\uFE0F</b> nishan par tap karo<br>' +
          '<b>2.</b> <b>Permissions</b> \u2192 <b>Camera</b> \u2192 <b>Allow</b> chuno<br>' +
          '<b>3.</b> Neeche <b>Page Reload Karo</b> dabao' +
          '</p>' +
          '<div class="row">' +
          '<button class="ssBtn ssPri" id="ssReload">\uD83D\uDD04 Page Reload Karo</button>' +
          '<button class="ssBtn ssSec" id="ssQuit">Band karo</button></div>' +
          '<p style="font-size:12px;opacity:.75;margin-top:12px;">' +
          'Camera na dena ho to koi baat nahi \u2014 "Band karo" dabao aur ' +
          '<b>Upload Document</b> se file bhej do.</p>');
    el('ssReload').onclick = function () { location.reload(); };
    el('ssQuit').onclick = quit;
  }

  // Live hint — har ~400ms ek chhota frame dekh kar batate hain ki
  // document dikh raha hai ya nahi. Chhota isliye ki battery na jale.
  function startLive() {
    stopLive();
    liveTimer = setInterval(function () {
      if (busy || !video || !video.videoWidth) return;
      try {
        var c = mkCanvas(LIVE_W, Math.round(LIVE_W * video.videoHeight / video.videoWidth));
        c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
        var r = detectQuad(c, LIVE_W);
        var ok = r.quad && r.confidence >= MIN_CONFIDENCE;
        el('ssGuide').classList.toggle('lock', !!ok);
        el('ssHint').innerHTML = ok
          ? '<span class="ok">✓ Document mil gaya</span>'
          : 'Document ko frame ke andar rakho';
      } catch (e) { /* live hint fail ho to koi baat nahi */ }
    }, LIVE_EVERY_MS);
  }
  function stopLive() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

  function stopCamera() {
    stopLive();
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (video) video.srcObject = null;
  }

  // ═════════════════════════════════════════════════════════════════
  //  CAPTURE + POORA PIPELINE
  // ═════════════════════════════════════════════════════════════════
  async function capture() {
    if (busy || !video || !video.videoWidth) return;
    busy = true;
    stopLive();

    // Original photo — ise haath nahi lagate, sab kuch iski copy par
    var original = mkCanvas(video.videoWidth, video.videoHeight);
    original.getContext('2d').drawImage(video, 0, 0);

    try {
      processing('Document dhoondh rahe hain…');
      await breathe();

      var det = detectQuad(original, DETECT_W);

      // ── Quality check ──
      var sharp = sharpness(det.gray, det.w, det.h);
      var bright = meanBrightness(det.gray);
      // det.quad asli photo ke paimane par hai — glare naapne ke liye use
      // detection wale chhote paimane par le aao
      var qs = null;
      if (det.quad) {
        var kx = det.w / original.width, ky = det.h / original.height;
        qs = det.quad.map(function (p) { return [p[0] * kx, p[1] * ky]; });
      }
      var glare = glareFraction(det.gray, det.w, det.h, qs);

      if (bright < MIN_BRIGHT) {
        return problem('Bahut andhera hai',
          'Thodi roshni me ya khidki ke paas dobara photo lo.');
      }
      if (sharp < MIN_SHARPNESS) {
        return problem('Photo dhundhli hai',
          'Phone ko sthir rakh kar dobara kheencho. Document par tap karke focus bhi kar sakte ho.');
      }
      if (glare > MAX_GLARE) {
        return problem('Roshni ki chamak aa rahi hai',
          'Kuch likha hua chamak ke neeche chhup sakta hai. Thoda kona badal kar dobara lo.');
      }
      // ── KONE KHUD THEEK KARO ──
      // Pehle yahan detection ka jawab CHUP-CHAAP maan liya jaata tha, aur
      // bharosa kam hone par poora fail. Dono galat the.
      //
      // Otsu + sabse-bade-blob wala detector tabhi chalta hai jab document
      // background se saaf alag ho. Haath me pakda Aadhaar? Ungli aur card
      // ki brightness ek jaisi — blob me ungliyan bhi aa jaati hain aur
      // "document" lagbhag poora frame ban jaata hai. Isiliye kuch document
      // seedhe hote the, kuch tirchhe.
      //
      // CamScanner bhi apne detection par bharosa nahi karta — wo photo ke
      // baad HAMESHA ghasitne wale kone dikhata hai. Detection sirf ek
      // shuruaati andaaza hai. Ab yahan bhi wahi: kone hamesha dikhenge,
      // detection theek nikla to customer seedha Apply dabayega, galat
      // nikla to 2 second me kheench kar theek kar dega. Fail kabhi nahi.
      hidePanel();
      el('ssWrap').style.visibility = 'hidden';   // crop screen ko saaf jagah do

      var initPts = det.quad && det.confidence >= MIN_CONFIDENCE
        ? det.quad.map(function (p) { return { x: p[0], y: p[1] }; })
        : null;                                    // null = 12% andar ka default

      var keep = original;                         // finally isko na mitaye
      original = null;

      openCropOn(keep, initPts,
        function (warpedRaw) { onScanCropped(warpedRaw, keep); },
        function () {                              // cancel — camera par wapas
          el('ssWrap').style.visibility = '';
          keep.width = keep.height = 0;
          startCamera();
        });
    } catch (e) {
      problem('Kuch gadbad ho gayi', 'Ek baar dobara koshish karo.');
    } finally {
      busy = false;
      // Original ko yahin chhod dete hain — koi copy nahi rakhi ja rahi
      if (original) original.width = original.height = 0;
    }
  }

  // Kone confirm hone ke baad: sahi naap par le jao, phir saaf karo.
  async function onScanCropped(warpedRaw, keep) {
    el('ssWrap').style.visibility = '';
    busy = true;
    try {
      processing('Saaf kiya ja raha hai…');
      await breathe();

      // Kone customer ne tay kiye — ab unhi se shape aur naap nikaalo
      var quad = [[0, 0], [warpedRaw.width, 0],
                  [warpedRaw.width, warpedRaw.height], [0, warpedRaw.height]];
      var size = outputSize(quad);

      // Template chuna hua ho to naap ANDAAZE se nahi lete — tay hai.
      // ID card ka anupaat 85.6:54 pakka hai, isliye detection galat bhi
      // ho to card khinchega nahi.
      var T = currentTpl();
      if (T.id === 'idcard') {
        size = { w: 1011, h: 638, shape: 'ID card' };          // 85.6x54mm @300dpi
      } else if (T.id === 'a4full' || T.id === 'half') {
        size = { w: size.w, h: size.h, shape: 'paper' };
      }

      // FRONT-BACK MATCH: doosri side ko pehli side ka hi naap aur mode do,
      // warna dono page alag-alag size ke chhapte hain aur jodne par match
      // nahi karte (yahi shikayat thi).
      if (capturedPages.length && capturedPages[0].size) {
        size = capturedPages[0].size;
      }

      // Customer ne phone landscape me pakda ho, ya crop ke kone alag kram
      // me kheenche hon, to warp ka output 90° ghuma hua aata hai — card
      // tirchha/side me dikhta tha. Target ka rukh (ID card hamesha
      // landscape) se mila kar zaroorat ho to ghuma do.
      var flat = mkCanvas(size.w, size.h);
      var fctx = flat.getContext('2d');
      fctx.imageSmoothingQuality = 'high';
      if ((warpedRaw.height > warpedRaw.width) !== (size.h > size.w)) {
        fctx.save();
        fctx.translate(size.w / 2, size.h / 2);
        fctx.rotate(Math.PI / 2);
        fctx.drawImage(warpedRaw, -size.h / 2, -size.w / 2, size.h, size.w);
        fctx.restore();
      } else {
        fctx.drawImage(warpedRaw, 0, 0, size.w, size.h);
      }

      var mode = (capturedPages.length && capturedPages[0].mode)
        ? capturedPages[0].mode
        : (T.id === 'idcard' ? 'card'
          : (T.id === 'a4full' || T.id === 'half') ? 'paper'
          : ((size.shape === 'ID card' || size.shape === '4x6') ? 'card' : 'paper'));

      await enhance(flat, mode);

      capturedPages.push({ canvas: flat, shape: size.shape, size: size, mode: mode });
      askBackSide();
    } catch (e) {
      problem('Kuch gadbad ho gayi', 'Ek baar dobara koshish karo.');
    } finally {
      busy = false;
      if (keep) keep.width = keep.height = 0;
      if (warpedRaw) warpedRaw.width = warpedRaw.height = 0;
    }
  }

  // ═════════════════════════════════════════════════════════════════
  //  BACK SIDE
  // ═════════════════════════════════════════════════════════════════
  function askBackSide() {
    stopCamera();
    showBar(false);
    var n = capturedPages.length;
    var prev = capturedPages[n - 1].canvas.toDataURL('image/jpeg', 0.72);
    panel(
      '<h3>' + (n === 1 ? 'Front side ho gaya' : 'Back side ho gaya') + '</h3>' +
      '<img id="ssPrev" src="' + prev + '" alt="scan preview">' +
      '<p style="margin-top:16px">' +
        (n === 1
          ? 'Bas itna hi ho to <b>Print Karo</b> dabao \u2014 peeche bhi chhapa ho to neeche se add kar lo.'
          : 'Bas itna hi ho to <b>Print Karo</b> dabao, ya ek aur page add kar lo.') +
      '</p>' +
      // Kaunsa rukh sahi hai, ye photo dekh kar machine nahi bata sakti —
      // uske liye likha padhna padta. Isliye ek tap ka button: har tap
      // 90°. Ulta aaya ho to do tap.
      '<div class="row" style="margin-bottom:6px">' +
        '<button class="ssBtn ssSec" id="ssRot">\uD83D\uDD04 Ghumao (90°)</button>' +
      '</div>' +
      // Aam customer sirf ek side scan karke aage badhta hai — isliye
      // wahi PEHLE aur wahi hara. Back side wala uske neeche, halke rang
      // me, "+" ke saath, taaki dono alag dikhein.
      '<div class="row">' +
        '<button class="ssBtn ssPri" id="ssDone">\u2705 Ho Gaya — Print Karo</button>' +
      '</div>' +
      '<div class="row" style="margin-top:8px">' +
        '<button class="ssBtn ssAdd" id="ssMore">\u2795 ' +
          (n === 1 ? 'Add Back Side' : 'Ek Aur Page Add Karo') + '</button>' +
      '</div>' +
      '<div id="ssCount">' + n + (n === 1 ? ' page' : ' pages') + ' taiyaar</div>'
    );
    el('ssMore').onclick = function () {
      hidePanel();
      el('ssHint').textContent = capturedPages.length === 1
        ? 'Ab back side frame ke andar rakho'
        : 'Agla page frame ke andar rakho';
      if (source === 'file') pickFile(); else startCamera();
    };
    el('ssRot').onclick = rotateLastScan;
    el('ssDone').onclick = finish;
  }

  // Aakhri scan ko 90° ghumao aur preview dobara dikhao.
  function rotateLastScan() {
    var p = capturedPages[capturedPages.length - 1];
    if (!p || !p.canvas) return;
    var s = p.canvas;
    var c = mkCanvas(s.height, s.width);          // naap ulta ho jaata hai
    var x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.translate(c.width / 2, c.height / 2);
    x.rotate(Math.PI / 2);
    x.drawImage(s, -s.width / 2, -s.height / 2);
    p.canvas = c;
    if (p.size) p.size = { w: c.width, h: c.height, shape: p.size.shape };
    s.width = s.height = 0;                       // purana canvas chhod do
    askBackSide();
  }

  // ═════════════════════════════════════════════════════════════════
  //  FINISH — banaye hue page purane flow ko de do
  //
  //  Yahan se aage kuch naya nahi hota: wahi pages[], wahi preview,
  //  wahi paper/color/copies, wahi payment, wahi print job.
  //  Print Agent ko pata bhi nahi chalta ki file scanner se aayi hai.
  // ═════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  //  ID CARD → EK A4 PAGE, ASLI NAAP ME
  // ═══════════════════════════════════════════════════════════════
  // Pehle har scan alag page banta tha aur us page par card ko A4 ki
  // chaudai tak KHEENCH diya jaata tha — isliye Aadhaar poore page jitna
  // bada chhapta tha aur front/back do alag kagaz par jaate the.
  //
  // Asli Aadhaar/PAN card CR80 hota hai: 85.6 x 54 mm. Dukaan me uski
  // photocopy hamesha isi naap me nikalti hai, warna ID kaam ki nahi
  // rehti. Isliye ab card ko A4 ke andar uske ASLI naap par rakha jaata
  // hai, aur front-back dono ek hi kagaz par — upar-neeche, barabar naap,
  // beech me 10 mm ka faasla (kaatne/mod ne ke liye kaafi).
  var CARD_W_MM = 85.6, CARD_H_MM = 54;      // CR80 — Aadhaar / PAN / DL
  var A4_W_MM = 210, A4_H_MM = 297;
  var SHEET_DPI = 300;
  var CARD_GAP_MM = 10;                      // do card ke beech

  // Card ko hamesha seedha (landscape) rakho — customer ne phone portrait
  // me pakda ho ya landscape me, chhapne par dono side ek jaisi dikhni
  // chahiye. Zaroorat pade to 90° ghuma kar rakh dete hain.
  function drawUpright(ctx, src, x, y, w, h) {
    var srcTall = src.height > src.width;
    var boxTall = h > w;
    if (srcTall === boxTall) { ctx.drawImage(src, x, y, w, h); return; }
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(src, -h / 2, -w / 2, h, w);
    ctx.restore();
  }

  // A4 par ek box banao aur us box me document ko poora dikhao (contain
  // fit — kuch katta nahi, khinchta nahi). Box ke beech me.
  function fitInBox(ctx, src, bx, by, bw, bh) {
    var r = Math.min(bw / src.width, bh / src.height);
    var w = src.width * r, h = src.height * r;
    ctx.drawImage(src, bx + (bw - w) / 2, by + (bh - h) / 2, w, h);
  }

  // Composed sheet A4 hi hai — usse page par 1:1 bithao, na chhota na hila
  // hua. Isse card asli naap (85.6x54 mm) me chhapta hai.
  function fitSheetsToPage() {
    if (typeof pages === 'undefined' || !pages.length) return;
    for (var i = 0; i < pages.length; i++) {
      var it = pages[i] && pages[i].items && pages[i].items[0];
      if (!it) continue;
      it.x = 0; it.y = 0;
      it.w = A4_DISPLAY_W; it.h = A4_DISPLAY_H;
      it._ix = 0; it._iy = 0; it._iw = it.w; it._ih = it.h;
      it._baseW = it.w; it._baseH = it.h;
      it.locked = true;              // hilane se naap bigadta hai
    }
  }

  function blankA4() {
    var mm = SHEET_DPI / 25.4;
    var W = Math.round(A4_W_MM * mm), H = Math.round(A4_H_MM * mm);
    var c = mkCanvas(W, H);
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    return { canvas: c, ctx: ctx, W: W, H: H, mm: mm };
  }

  // Certificate: har side apne A4 page par, poora bhar kar (10mm margin)
  function composeA4Full(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = blankA4();
      var m = Math.round(10 * s.mm);
      fitInBox(s.ctx, list[i].canvas, m, m, s.W - 2 * m, s.H - 2 * m);
      out.push(s.canvas);
    }
    return out;
  }

  // Admit card / marksheet: front upar wale aadhe me, back neeche wale
  // aadhe me — ek hi kagaz par. Screenshot wala layout.
  function composeHalfSheet(list) {
    var s = blankA4();
    var m = Math.round(12 * s.mm);
    var halfH = Math.round(s.H / 2);
    for (var i = 0; i < list.length && i < 2; i++) {
      fitInBox(s.ctx, list[i].canvas,
               m, i * halfH + m, s.W - 2 * m, halfH - 2 * m);
    }
    return s.canvas;
  }

  function composeCardSheet(list) {
    var mm = SHEET_DPI / 25.4;
    var W = Math.round(A4_W_MM * mm), H = Math.round(A4_H_MM * mm);
    var cw = Math.round(CARD_W_MM * mm), ch = Math.round(CARD_H_MM * mm);
    var gap = Math.round(CARD_GAP_MM * mm);

    var sheet = mkCanvas(W, H);
    var ctx = sheet.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);

    // Screenshot wala layout: dono card UPAR, aajubaju, beech me faasla.
    // Ek hi side ho to wahi naap, upar, beech me — customer ne yahi kaha.
    var top = Math.round(20 * mm);
    var totalW = list.length * cw + (list.length - 1) * gap;
    var x = Math.round((W - totalW) / 2);
    for (var i = 0; i < list.length; i++) {
      drawUpright(ctx, list[i].canvas, x, top, cw, ch);
      x += cw + gap;
    }
    return sheet;
  }

  // Card hai ya poora kagaz? Card wale ko asli naap chahiye, kagaz wale
  // ko poora page bharna chahiye — dono ka ilaaj alag hai.
  function allCards(list) {
    if (!list.length || list.length > 2) return false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].shape !== 'ID card') return false;
    }
    return true;
  }

  function finish() {
    if (!capturedPages.length) { quit(); return; }
    try {
      // ── 1. Purane flow ka bacha hua state saaf karo ──
      //
      // ORIGINAL_PDF sabse zaroori hai. Ye hota tha:
      //   customer PDF upload kare → "Wapas" dabaye (pages saaf hote hain,
      //   ORIGINAL_PDF nahi) → Smart Scanner se scan kare → "Sab Theek Hai"
      // Aage buildOutputFile() ka pdfUntouched() shortcut sach maan leta
      // tha aur shop ko SCAN ki jagah PURANI PDF chali jaati thi. Customer
      // scan ka paisa deta, print kuch aur nikalta.
      //
      // pages bhi saaf — Mini Print se wapas aane par uske page bache
      // reh sakte hain aur scan unke aage jud jaata.
      if (typeof pages !== 'undefined' && pages.length) pages.length = 0;
      try { ORIGINAL_PDF = null; } catch (e) {}
      try { activePageIdx = 0; } catch (e) {}

      // ── 2. Scanner hamesha A4 portrait par ──
      // Dono card (Big Size aur Smart Scanner) ek hi screen par hain.
      // Customer pehle "Big Size Print" chhoo le to state.paperSize 'a3'
      // reh jaata tha aur scan A3 par chhapta — customer se zyada paisa.
      try {
        state.paperSize = 'a4';
        state.orientation = 'portrait';
        var psel = document.getElementById('paperSizeSel');
        if (psel) psel.value = 'a4';
        if (typeof applyPaper === 'function') applyPaper();
      } catch (e) {}

      // ── 3. Page(s) banao ──
      // ID card (Aadhaar/PAN/DL): front+back EK hi A4 par, asli naap me.
      // Poora kagaz scan kiya ho: pehle jaisa, har scan ka apna page.
      var T = currentTpl();
      var composed = true;
      if (T.id === 'idcard' || (T.id === 'auto' && allCards(capturedPages))) {
        addPage([composeCardSheet(capturedPages)], true);        // ek page, asli card naap
      } else if (T.id === 'half') {
        addPage([composeHalfSheet(capturedPages)], true);        // front upar, back neeche
      } else if (T.id === 'a4full') {
        composeA4Full(capturedPages).forEach(function (c) { addPage([c], true); });
      } else {
        composed = false;
        capturedPages.forEach(function (p) { addPage([p.canvas], true); });
      }

      // ⚠️ ZAROORI: createItemFromCanvas() har document ko page ke 90% par
      // fit karta hai (maxWPercent 0.92, phir h > a4H*0.9 wali line usse 0.9
      // par le aati hai). Aam document ke liye theek hai — par hamari sheet
      // KHUD A4 hai aur usme margin pehle se bana hua hai. 90% par lagane se
      // 85.6 mm ka card 77 mm ka chhapta tha. Yahi "chhota aa raha hai" tha.
      // Sheet ko poore page par bitha do aur lock kar do.
      if (composed) fitSheetsToPage();

      stopCamera();
      el('ssWrap').classList.remove('on');

      // ── 4. Upload screen chhupao ──
      // Scanner secUpload ke andar wale card se khulta hai, isliye wo
      // screen abhi bhi khuli padi hai. showChoiceScreen() sirf secEditor
      // chhupata hai — secUpload ko nahi. Bina iske choice card ke neeche
      // poora upload page (aur saare service card) dikhta reh jaata tha.
      if (typeof hide === 'function') {
        hide('secUpload'); hide('secMini');
        hide('secEditor'); hide('secPreviewStep');
      }
      if (typeof setStep === 'function') setStep(2);

      var n = capturedPages.length;
      capturedPages = [];

      if (typeof toast === 'function') {
        toast('📸 ' + n + (n === 1 ? ' page' : ' pages') + ' scan ho gaye');
      }
      // Purane flow ka wahi screen jo upload ke baad aata hai
      if (typeof showChoiceScreen === 'function') showChoiceScreen();
    } catch (e) {
      problem('Page taiyaar nahi ho paya', 'Ek baar dobara koshish karo.');
    }
  }

  function quit() {
    stopCamera();
    capturedPages = [];
    source = 'cam';
    busy = false;
    var w = el('ssWrap');
    if (w) { w.classList.remove('on'); hidePanel(); }
  }

  // ═════════════════════════════════════════════════════════════════
  //  ENTRY POINT — service card isi ko bulata hai
  // ═════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  //  A4 LAYOUT TEMPLATE
  // ═══════════════════════════════════════════════════════════════
  // Auto-identify kabhi-kabhi galat naap deta hai (haath me pakda card,
  // chamak, rangeen background). Customer pehle hi bata de ki kya scan
  // kar raha hai, to naap ANDAAZE se nahi — TAY hokar aata hai.
  //
  //  idcard — CR80 85.6x54mm, asli card naap. Ek side ho to beech me,
  //           dono side hon to upar aajubaju (screenshot wala layout).
  //  a4full — poora A4 bharo, chhota margin. Certificate, letter, deed.
  //  half   — aadha page. Admit card / marksheet: front upar wale aadhe
  //           me, back neeche wale aadhe me — ek hi kagaz par dono.
  //  auto   — pehle jaisa, system khud naap pehchane.
  var TEMPLATES = [
    { id: 'idcard', icon: '\uD83E\uDeaa', title: 'ID Card',
      sub: 'Aadhaar · PAN · Voter · DL — front & back ek page par',
      hint: 'Card ko frame ke andar rakho' },
    { id: 'a4full', icon: '\uD83D\uDCDC', title: 'Certificate',
      sub: 'Poora A4 document — marksheet, certificate, letter',
      hint: 'Poora page frame ke andar rakho' },
    { id: 'half',   icon: '\uD83C\uDFAB', title: 'Admit Card / Marksheet',
      sub: 'Aadha page — front upar, back neeche, ek hi kagaz par',
      hint: 'Document ko frame ke andar rakho' },
    { id: 'auto',   icon: '\uD83E\uDD16', title: 'Auto',
      sub: 'System khud naap pehchane',
      hint: 'Document ko frame ke andar rakho' }
  ];
  var tpl = TEMPLATES[3];                       // default = auto

  function currentTpl() { return tpl || TEMPLATES[3]; }

  // Har layout ka chhota naksha — shabdon se zyada ek nazar me samajh
  // aata hai ki kagaz par kya kahan chhapega. A4 ka anupaat (36x51) hi
  // rakha hai taaki jo dikhe wahi mile.
  function tplThumb(id) {
    var box = '<rect x="1.5" y="1.5" width="33" height="48" rx="2.5" ' +
              'fill="#fff" stroke="#c8cdd4" stroke-width="1.4"/>';
    var inner = '';
    if (id === 'idcard') {
      // dono card upar, aajubaju
      inner = '<rect x="4.5" y="6" width="12.6" height="8" rx="1" fill="#7c3aed"/>' +
              '<rect x="19" y="6" width="12.6" height="8" rx="1" fill="#a78bfa"/>';
    } else if (id === 'a4full') {
      // poora page bhara hua
      inner = '<rect x="5" y="5" width="26" height="41" rx="1.5" fill="#7c3aed"/>';
    } else if (id === 'half') {
      // upar aadha + neeche aadha
      inner = '<rect x="4.5" y="4.5" width="27" height="19.5" rx="1.5" fill="#7c3aed"/>' +
              '<rect x="4.5" y="27" width="27" height="19.5" rx="1.5" fill="#a78bfa"/>';
    } else {
      inner = '<rect x="7" y="12" width="22" height="27" rx="1.5" fill="none" ' +
              'stroke="#7c3aed" stroke-width="1.6" stroke-dasharray="3 2.4"/>' +
              '<text x="18" y="30" font-size="11" font-weight="700" fill="#7c3aed" ' +
              'text-anchor="middle" font-family="sans-serif">?</text>';
    }
    return '<span class="ssTplThumb"><svg viewBox="0 0 36 51" width="36" height="51" ' +
           'aria-hidden="true">' + box + inner + '</svg></span>';
  }

  function askTemplate() {
    showBar(false);
    var html = '<h3>Kya scan kar rahe ho?</h3>' +
      '<p>Sahi chunne se naap apne aap theek baithta hai — crop ke baad ' +
      'document seedha layout me lock ho jayega.</p><div class="ssTpl">';
    for (var i = 0; i < TEMPLATES.length; i++) {
      var t = TEMPLATES[i];
      html += '<button class="ssTplBtn" data-i="' + i + '">' +
              tplThumb(t.id) +
              '<span class="ssTplTxt"><b>' + t.title + '</b><i>' + t.sub + '</i></span>' +
              '</button>';
    }
    html += '</div><div class="row">' +
            '<button class="ssBtn ssSec" id="ssTplQuit">Band karo</button></div>';
    panel(html);

    var btns = el('ssPanel').querySelectorAll('.ssTplBtn');
    for (var k = 0; k < btns.length; k++) {
      btns[k].onclick = function () {
        tpl = TEMPLATES[parseInt(this.getAttribute('data-i'), 10)];
        el('ssHint').textContent = tpl.hint;
        askSource();
      };
    }
    el('ssTplQuit').onclick = quit;
  }

  // ═════════════════════════════════════════════════════════════════
  //  PHOTO KAHAN SE — camera ya device ki file
  // ═════════════════════════════════════════════════════════════════
  function camAvailable() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
              window.isSecureContext);
  }

  function askSource() {
    showBar(false);
    var cam = camAvailable()
      ? '<button class="ssTplBtn" id="ssSrcCam">' +
          '<span class="ssTplIco">\uD83D\uDCF7</span>' +
          '<span class="ssTplTxt"><b>Camera</b>' +
          '<i>Abhi photo kheencho \u2014 document saamne ho to yahi tez hai</i>' +
          '</span></button>'
      : '';
    panel('<h3>Photo kahan se lein?</h3>' +
      '<p>Dono ka nateeja ek jaisa \u2014 kone theek karna aur safai dono me hoti hai.</p>' +
      '<div class="ssTpl">' + cam +
        '<button class="ssTplBtn" id="ssSrcFile">' +
          '<span class="ssTplIco">\uD83D\uDCC1</span>' +
          '<span class="ssTplTxt"><b>Files</b>' +
          '<i>Phone ya computer me pehle se rakhi photo chuno</i>' +
          '</span></button>' +
      '</div>' +
      (camAvailable() ? ''
        : '<p>Is browser me camera nahi chal raha, isliye sirf Files ka rasta khula hai.</p>') +
      '<div class="row">' +
        '<button class="ssBtn ssSec" id="ssSrcBack">\u2039 Peeche</button>' +
      '</div>');
    if (el('ssSrcCam')) {
      el('ssSrcCam').onclick = function () {
        source = 'cam'; hidePanel(); startCamera();
      };
    }
    el('ssSrcFile').onclick = function () { source = 'file'; pickFile(); };
    el('ssSrcBack').onclick = askTemplate;
  }

  function pickFile() {
    var fi = el('ssFile');
    if (!fi) {
      return fileProblem('File chunne ka box nahi mila',
        'Page ko refresh karke dobara koshish karo.');
    }
    fi.click();
  }

  // problem() ka "Dobara photo lo" camera kholta hai — file wale raste me
  // wo galat jagah le jaata. Isliye uska file wala jodidar.
  function fileProblem(title, detail) {
    showBar(false);
    panel('<h3>' + title + '</h3><p>' + detail + '</p>' +
          '<div class="row">' +
          '<button class="ssBtn ssPri" id="ssRetryF">Doosri file chuno</button>' +
          '<button class="ssBtn ssSec" id="ssQuitF">Band karo</button>' +
          '</div>');
    el('ssRetryF').onclick = pickFile;
    el('ssQuitF').onclick = quit;
  }

  // Camera 1920x1440 par bandha hua hai; gallery ki photo 50MP tak ho
  // sakti hai. Utni badi photo par detection aur warp phone ki memory kha
  // jaate hain, isliye kaam se pehle naap ghata dete hain.
  var FILE_MAX = 2600;

  function loadPickedImage(f) {
    return new Promise(function (res, rej) {
      function viaUrl() {
        var url = URL.createObjectURL(f);
        var im = new Image();
        im.onload = function () { URL.revokeObjectURL(url); res(im); };
        im.onerror = function () { URL.revokeObjectURL(url); rej(new Error('load')); };
        im.src = url;
      }
      // createImageBitmap tez hai aur EXIF ka ghumav khud theek karta hai.
      if (window.createImageBitmap) {
        var p;
        try { p = createImageBitmap(f, { imageOrientation: 'from-image' }); }
        catch (e) { p = null; }
        if (!p) { try { p = createImageBitmap(f); } catch (e2) { p = null; } }
        if (p) { p.then(res, viaUrl); return; }
      }
      viaUrl();
    });
  }

  async function useFile(f) {
    if (busy) return;
    busy = true;
    stopCamera();
    try {
      processing('File padhi ja rahi hai\u2026');
      await breathe();

      var img = null;
      try { img = await loadPickedImage(f); }
      catch (e) {
        return fileProblem('Ye photo browser khol nahi paaya',
          'HEIC photo aksar nahi khulti. Camera Settings me photo format ' +
          '"JPEG / Most compatible" karke dobara kheencho, ya photo ko JPG ' +
          'me badal kar chuno.');
      }

      var iw = img.width || img.naturalWidth;
      var ih = img.height || img.naturalHeight;
      if (!iw || !ih) {
        return fileProblem('Photo khaali mili',
          'Google Photos ya Drive ki jagah phone ki Gallery se chuno.');
      }

      var k = Math.min(1, FILE_MAX / Math.max(iw, ih));
      var original = mkCanvas(Math.round(iw * k), Math.round(ih * k));
      var octx = original.getContext('2d');
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(img, 0, 0, original.width, original.height);
      if (img.close) { try { img.close(); } catch (e3) {} }

      processing('Document dhoondh rahe hain\u2026');
      await breathe();

      // Roshni/dhundhlepan/chamak wali jaanch yahan JAAN-BOOJH kar nahi —
      // upar file ke sar par iski wajah likhi hai.
      var det = detectQuad(original, DETECT_W);
      var initPts = det.quad && det.confidence >= MIN_CONFIDENCE
        ? det.quad.map(function (p) { return { x: p[0], y: p[1] }; })
        : null;

      hidePanel();
      el('ssWrap').style.visibility = 'hidden';

      var keep = original;
      original = null;
      openCropOn(keep, initPts,
        function (warpedRaw) { onScanCropped(warpedRaw, keep); },
        function () {                       // cancel — chunne wali screen par wapas
          el('ssWrap').style.visibility = '';
          keep.width = keep.height = 0;
          askSource();
        });
    } catch (e4) {
      fileProblem('Kuch gadbad ho gayi', 'Ek baar dobara koshish karo.');
    } finally {
      busy = false;
    }
  }

  function startSmartScanner() {
    // Camera ki ijazat SIRF ab maangte hain, page khulte hi nahi
    // (spec section 42)
    // Pehle yahan camera na hone par scanner khulta hi nahi tha. Ab Files
    // ka rasta bhi hai, isliye rokna galat hoga — camera na chale to
    // askSource() sirf Files dikha dega.
    mount();
    capturedPages = [];
    tpl = null;
    source = 'cam';
    el('ssWrap').classList.add('on');
    el('ssHint').textContent = 'Document ko frame ke andar rakho';
    // Pehle layout poochho — camera baad me. Isse naap andaaze par nahi,
    // customer ke jawab par tay hota hai.
    askTemplate();
  }

  window.startSmartScanner = startSmartScanner;

  // Sirf test page ke liye. Production me __SS_TEST__ kabhi set nahi hota,
  // isliye customer ke browser me ye chalta hi nahi.
  if (window.__SS_TEST__) {
    window.__ss = {
      detectQuad: detectQuad, warp: warp, enhance: enhance,
      outputSize: outputSize, homography: homography,
      sharpness: sharpness, glareFraction: glareFraction,
      meanBrightness: meanBrightness, quadConfidence: quadConfidence,
      toGray: toGray, MIN_CONFIDENCE: MIN_CONFIDENCE
    };
  }
})();
