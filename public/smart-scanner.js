/* ═══════════════════════════════════════════════════════════════════
   Echel — SMART SCANNER
   ═══════════════════════════════════════════════════════════════════

   Take a photo of a document and get a clean, scanner-like page.

   WHY THIS FILE IS SEPARATE:
   customer.html is 187 KB and everything runs inside it. Pushing the whole
   scanner into it could have broken something old. So all the work lives
   here — customer.html only gains three small things:
     1. <script src="/smart-scanner.js"></script>
     2. one entry in the service card list
     3. one flag in applyAdvancedGate()

   WHAT IT NEEDS FROM OUTSIDE (already present in customer.html):
     addPage(canvases, skipUIRender)   — creates a page
     showChoiceScreen()                — "everything is fine / I want to edit"
     toast(msg)                        — short message
     A4_DISPLAY_W / A4_DISPLAY_H       — editor canvas size

   OpenCV.js WAS DELIBERATELY NOT USED:
   its wasm is ~9 MB. The customer stands in the shop on mobile data —
   downloading 9 MB before a scan can start would make the feature feel
   broken. All the CV below is plain JS + canvas, a few KB in size.

   ALL PROCESSING HAPPENS ON THE PHONE. The original camera photo never goes
   to the server — only the finished clean page does, through the same old
   upload path.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── Settings ──────────────────────────────────────────────────────
  var DETECT_W      = 480;    // detection runs at this width (fast)
  var LIVE_W        = 200;    // even smaller for the live camera hint
  var OUT_LONG_EDGE = 2339;   // A4 @ ~200 DPI — enough for printing
  var CARD_LONG_EDGE = 1400;  // no point making a small card as large as A4
  var LIVE_EVERY_MS = 420;

  // Standard document shapes — ratio = long side / short side
  var SHAPES = [
    { name: 'A4 / A5',  r: 297 / 210 },   // 1.414
    { name: 'Letter',   r: 279 / 216 },   // 1.294
    { name: 'Legal',    r: 356 / 216 },   // 1.647
    { name: '4x6',      r: 6 / 4 },       // 1.500
    { name: 'ID card',  r: 85.6 / 54 }    // 1.585
  ];
  var SNAP_TOLERANCE = 0.06;   // within 6%, treat it as the standard shape

  // Quality limits — below these we ask to "take the photo again"
  var MIN_SHARPNESS = 55;      // Laplacian variance
  var MAX_GLARE     = 0.055;   // more than 5.5% of the area burnt out
  var MIN_BRIGHT    = 42;      // this dark means nothing will be visible
  // At least this much of the frame must be the document.
  // At 14%, ID cards / visiting cards were rejected — photographed while held
  // in the hand they fill only ~12% of the frame.
  // A smaller value does not let noise blobs in, because the side-balance
  // and corner-angle checks remove them anyway.
  var MIN_QUAD_AREA = 0.075;
  var MIN_CONFIDENCE = 0.45;

  // ── State ─────────────────────────────────────────────────────────
  var stream = null, video = null, liveTimer = null;
  var capturedPages = [];      // { canvas, shape }
  var source = 'cam';          // 'cam' = camera, 'file' = a file on the device
  var busy = false;

  // ═════════════════════════════════════════════════════════════════
  //  SMALL HELPERS
  // ═════════════════════════════════════════════════════════════════
  function el(id) { return document.getElementById(id); }

  function mkCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  // Let the UI breathe — called in the middle of big loops, otherwise
  // the phone screen freezes and even "Processing..." never shows.
  function breathe() {
    return new Promise(function (r) { setTimeout(r, 0); });
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // ═════════════════════════════════════════════════════════════════
  //  GRAY + INTEGRAL IMAGE
  //  With an integral image both the box blur and the local threshold become
  //  O(1) per pixel — the whole enhancement rests on this one trick.
  // ═════════════════════════════════════════════════════════════════
  function toGray(data, w, h) {
    var g = new Float32Array(w * h);
    for (var i = 0, p = 0; i < g.length; i++, p += 4) {
      // Luma — the eye sees green the most
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

  // average of the (x0,y0)-(x1,y1) box, both ends inclusive
  function boxMean(ii, w, x0, y0, x1, y1) {
    var W = w + 1;
    var a = ii[y0 * W + x0], b = ii[y0 * W + (x1 + 1)];
    var c = ii[(y1 + 1) * W + x0], d = ii[(y1 + 1) * W + (x1 + 1)];
    var n = (x1 - x0 + 1) * (y1 - y0 + 1);
    return (d - b - c + a) / n;
  }

  // ═════════════════════════════════════════════════════════════════
  //  QUALITY CHECK — spec sections 22/23/24
  // ═════════════════════════════════════════════════════════════════
  function sharpness(g, w, h) {
    // Variance of the Laplacian — a blurry photo has no edges,
    // so this number drops.
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

  // Glare matters ONLY inside the document. Light falling on the table does
  // not spoil the customer's work — it used to be measured over the whole frame,
  // so real glare was diluted into a small number and slipped through.
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
  //  Method: a document usually has a different brightness from the background.
  //    gray -> Otsu threshold -> largest connected blob -> convex hull
  //    -> the quadrilateral (quad) with the largest area within that hull
  //
  //  It gets weak in cases like "white paper on a white table" —
  //  then the confidence drops and we ask the customer for another photo
  //  (spec section 7). That is better than handing over a wrongly cut document.
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

  // Largest connected component — iterative flood fill (recursion
  // blows the stack on phones)
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
    // Only the blob boundary is needed — the first/last pixel of each row is enough
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

  // Area of four points — without building an array (shoelace).
  // polyArea() built a new array every time; this loop runs hundreds of
  // thousands of times, so that allocation was the most expensive part.
  function quadArea(a, b, c, d) {
    return Math.abs(
      a[0] * b[1] - b[0] * a[1] +
      b[0] * c[1] - c[0] * b[1] +
      c[0] * d[1] - d[0] * c[1] +
      d[0] * a[1] - a[0] * d[1]
    ) / 2;
  }

  // Pick the 4 hull points with the largest area.
  //
  // KEEPING IT FAST IS ESSENTIAL: the live camera hint runs this every ~400ms.
  // With 40 points this loop ran 91,000 times and a single detect took ~3
  // seconds — that is unusable on a phone. With 24 points it runs
  // 10,600 times (8.6x fewer), and the area is computed without building an array.
  // A document's corners fit comfortably within that many points.
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

  // put them in TL, TR, BR, BL order
  function orderCorners(q) {
    var cx = 0, cy = 0, i;
    for (i = 0; i < 4; i++) { cx += q[i][0]; cy += q[i][1]; }
    cx /= 4; cy /= 4;
    var withAngle = q.map(function (p) {
      return { p: p, a: Math.atan2(p[1] - cy, p[0] - cx) };
    }).sort(function (a, b) { return a.a - b.a; });
    // atan2's -PI starts at the top-left
    var pts = withAngle.map(function (o) { return o.p; });
    // make the top-left-most one the first
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

  // How "document-like" the quad is — 0 to 1
  function quadConfidence(q, w, h) {
    var area = polyArea(q) / (w * h);
    if (area < MIN_QUAD_AREA) return 0;

    // ── FULL FRAME = DETECTION FAILED ──
    // This is the most important check. The whole image is a perfect rectangle
    // with the largest area, so every other measure gave it a score of 1.00 —
    // and "detection failed" became the most "confident" answer.
    // A table/background blob produces exactly this shape.
    // A real document always leaves some space around its four sides.
    if (area > 0.90) return 0;
    var edgeTouch = 0;
    for (var t = 0; t < 4; t++) {
      if (q[t][0] < w * 0.02 || q[t][0] > w * 0.98) edgeTouch++;
      if (q[t][1] < h * 0.02 || q[t][1] > h * 0.98) edgeTouch++;
    }
    if (edgeTouch >= 6) return 0;      // almost every corner on the image edge
    // confidence starts dropping above 0.72
    var roomy = area > 0.72 ? Math.max(0, 1 - (area - 0.72) / 0.18) : 1;
    // Opposite sides should be roughly equal
    var top = dist(q[0], q[1]), bottom = dist(q[3], q[2]);
    var left = dist(q[0], q[3]), right = dist(q[1], q[2]);
    var hBal = Math.min(top, bottom) / Math.max(top, bottom);
    var vBal = Math.min(left, right) / Math.max(left, right);
    // Each corner should be roughly around 90° (not too skewed)
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
    // Document = the bright part. Both directions are tried — sometimes the paper
    // is darker than the background (a white table, not a black one).
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
    // Back to the scale of the original image
    var full = out.map(function (p) { return [p[0] / sc, p[1] / sc]; });
    return { quad: full, confidence: outConf, gray: g, w: w, h: h };
  }

  // ═════════════════════════════════════════════════════════════════
  //  PERSPECTIVE — compute the homography and straighten the image
  //  (not just a crop — real perspective correction, spec section 8)
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

  // Mapping from dst (the straight rectangle) to src (the skewed document) —
  // inverse mapping so every output pixel can be looked up in the source
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

    // Band by band — yield AFTER each band, not INSIDE it.
    // The `await` used to sit inside this loop and straightening a full A4
    // took 7.4 SECONDS: an await inside an async function makes V8 stop
    // optimising the whole loop. The real work now lives in a plain
    // function (warpBand), which V8 optimises fully.
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
        // Bilinear — nearest-neighbour makes text edges look broken
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
  //  One trick does three jobs: shadows disappear, lighting evens out,
  //  and the background becomes clean white —
  //     pixel ÷ (the background around it)
  //  The background comes from a large-radius box blur. Text is small,
  //  so it dissolves in the blur and survives; shadows are large and
  //  gradual, so they get cancelled out.
  // ═════════════════════════════════════════════════════════════════
  // Two very different things get scanned, and each needs its own treatment:
  //
  //  'paper' — plain paper, black writing on white. Local background
  //            normalization is right here: shadows go, the writing stands out.
  //
  //  'card'  — colourful cards like Aadhaar/PAN, with a photo, hologram and
  //            fine security patterns. The same normalization HARMS them:
  //            large single-colour areas go flat, noise pops out as stains,
  //            and the face photo gets washed out. So card mode only applies
  //            a light global contrast + white balance — no local
  //            normalization, no unsharp mask.
  async function enhance(canvas, mode) {
    if (mode === 'card') return enhanceCard(canvas);
    var w = canvas.width, h = canvas.height;
    var ctx = canvas.getContext('2d');
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;

    var g = toGray(d, w, h);
    var ii = integral(g, w, h);
    var R = Math.max(12, Math.round(Math.min(w, h) / 12));   // background radius

    // 1. Illumination + shadow + background — all at once
    var norm = new Float32Array(w * h);
    for (var yy = 0; yy < h; yy += 96) {
      normBand(ii, g, norm, w, h, R, yy, Math.min(h, yy + 96));
      await breathe();
    }

    // 2. How dark the writing is — this gives the contrast scale
    var lo = 255, hi = 0;
    for (var s = 0; s < norm.length; s += 7) {          // sampling is enough
      if (norm[s] < lo) lo = norm[s];
      if (norm[s] > hi) hi = norm[s];
    }
    var span = Math.max(40, hi - lo);

    // 3. Add the colour back. Apply to each channel the same correction the
    //    gray received — this keeps the colour of logos, stamps and signatures
    //    (spec section 36: do not overprocess).
    var out = ctx.createImageData(w, h);
    var oD = out.data;
    for (var p = 0, q = 0; p < norm.length; p++, q += 4) {
      var ratio = g[p] > 1 ? norm[p] / g[p] : 1;
      // halka contrast stretch
      var lift = clamp((norm[p] - lo) / span, 0, 1);
      var curved = lift * lift * (3 - 2 * lift);          // smoothstep — looks natural
      var mix = 0.65 + 0.35 * curved;
      for (var ch = 0; ch < 3; ch++) {
        oD[q + ch] = clamp(d[q + ch] * ratio * mix, 0, 255);
      }
      oD[q + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    await breathe();

    // 4. Light sharpen — crisp text edges, but no halo
    await unsharp(ctx, w, h, 0.45);
    return canvas;
  }

  // Light treatment for a colourful card: make white white (white balance)
  // and add a little contrast. Detail is left untouched.
  async function enhanceCard(canvas) {
    var w = canvas.width, h = canvas.height;
    var ctx = canvas.getContext('2d');
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;

    // The 97th percentile of each channel — this is treated as "white".
    // Taking the single brightest pixel lets one shiny spot ruin the whole
    // picture, hence the percentile.
    var hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    var n = 0;
    for (var p = 0; p < d.length; p += 16) {          // sampling is enough
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
    // Keep the gain under control so the colours are not distorted
    for (var k = 0; k < 3; k++) gain[k] = clamp(gain[k], 1, 1.35);

    await breathe();

    // A light S-curve — contrast rises a little but detail is not blown out
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
  //  OUTPUT SIZE — estimating the document's real shape
  // ═════════════════════════════════════════════════════════════════
  function outputSize(quad) {
    var top = dist(quad[0], quad[1]), bottom = dist(quad[3], quad[2]);
    var left = dist(quad[0], quad[3]), right = dist(quad[1], quad[2]);
    var wAvg = (top + bottom) / 2, hAvg = (left + right) / 2;
    var ratio = Math.max(wAvg, hAvg) / Math.max(1, Math.min(wAvg, hAvg));

    // If it is close to a standard shape, snap to it — otherwise every scan
    // comes out at a slightly different ratio and looks odd in print.
    //
    // NOTE: the CLOSEST shape is chosen, not the first match.
    // Legal (1.647) and ID card (1.585) are only 3.8% apart — with the earlier
    // method an ID card became "Legal" and grew as large as A4.
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
    // There is no point making a small document like a card as large as A4
    // (spec section 38) — the ratio stays the same, just with fewer pixels.
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
  /* i18n-ignore: the scanner's own stylesheet, not text a person reads. */
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
    // "Add Back Side" is deliberately kept light. It used to be green
    // (ssPri) and "continue" was faded — the eye went straight to the green,
    // so people kept going into the back side by mistake.
    // Now green is only on the button that moves forward.
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
      '<button id="ssClose" aria-label="Close">&times;</button></div>' +
    '<div id="ssStage">' +
      '<video id="ssVideo" playsinline muted autoplay></video>' +
      '<div id="ssGuide"></div>' +
      '<div id="ssHint">Place the document inside the frame</div>' +
      '<div id="ssPanel"></div>' +
    '</div>' +
    '<div id="ssBar"><button id="ssShot" aria-label="Take a photo"></button></div>';

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

    // The Files path. The input sits INSIDE the overlay so it lives and dies
    // with the overlay. Its value is cleared every time, otherwise choosing the
    // same file again fires no change event.
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
          '<p>One moment — cleaning up the document.</p>');
  }

  // Every error has one shape — the customer never sees technical details
  function problem(title, detail, retryLabel) {
    showBar(false);
    panel('<h3>' + title + '</h3><p>' + detail + '</p>' +
          '<div class="row">' +
          '<button class="ssBtn ssPri" id="ssRetry">' + (retryLabel || 'Retake photo') + '</button>' +
          '<button class="ssBtn ssSec" id="ssQuit">Close</button>' +
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
  // What the browser has decided about the camera.
  // 'denied'  = the customer already pressed "Block" — JS can NO LONGER
  //             bring the popup back; the settings are the only way
  // 'prompt'  = nothing decided yet — getUserMedia will show the popup
  // 'unknown' = the browser does not say (iOS Safari) — just try
  async function camPermState() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
      var st = await navigator.permissions.query({ name: 'camera' });
      return st && st.state ? st.state : 'unknown';
    } catch (e) { return 'unknown'; }
  }

  async function startCamera() {
    stopLive();

    // If it is already BLOCKED, getUserMedia rejects immediately and
    // no popup appears. Then "Try again" is useless —
    // the customer keeps pressing the same button. Show the direct way instead.
    if ((await camPermState()) === 'denied') { return camBlockedPanel(); }

    try {
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });

      // This call runs right after the CLICK, so the browser's
      // "Allow camera?" popup comes up by itself.
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
        // Some old phones refuse a request for 1920x1440 or the back camera
        // (nothing to do with permission). In that case ask once more
        // without any constraints — that usually works.
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
        // Two completely different situations share the same error name:
        //   • pressed "Block"          → permission is now 'denied'
        //   • swiped the popup away   → permission is still 'prompt'
        // In the second case asking again brings the popup back, so sending
        // the customer to the settings would be wrong.
        var st = await camPermState();
        if (st === 'denied') return camBlockedPanel();
        showBar(false);
        panel('<h3>Camera access is needed</h3>' +
              '<p>Tap the button below, and in the popup on your phone choose ' +
              '<b>Allow</b>. The photo is created only on your phone.</p>' +
              '<div class="row">' +
              '<button class="ssBtn ssPri" id="ssRetry">📷 Allow Camera</button>' +
              '<button class="ssBtn ssSec" id="ssQuit">Close</button></div>');
        el('ssRetry').onclick = startCamera;
        el('ssQuit').onclick = quit;
        return;
      }
      showBar(false);
      panel('<h3>Could not open the camera</h3>' +
            '<p>The camera may be in use by another app on this phone. ' +
            'Close that app and try again.</p>' +
            '<div class="row">' +
            '<button class="ssBtn ssPri" id="ssRetry">Please try again</button>' +
            '<button class="ssBtn ssSec" id="ssQuit">Close</button></div>');
      el('ssRetry').onclick = startCamera;
      el('ssQuit').onclick = quit;
    }
  }

  // The camera is BLOCKED. From here it is impossible to bring the browser's
  // popup back — that is a browser rule and no website can
  // do it. So do not falsely say "try again";
  // give exactly 3 steps and a reload button (after changing the setting
  // it has no effect without reloading the page).
  function camBlockedPanel() {
    showBar(false);
    panel('<h3>Camera is turned off</h3>' +
          '<p style="text-align:left;line-height:1.85;">' +
          'For this site the camera is already set to <b>Block</b>, so ' +
          'the permission popup will not appear on its own anymore. It takes 10 seconds:' +
          '<br><br>' +
          '<b>1.</b> In the address bar above, tap the ' +
          '<b>\uD83D\uDD12 / \u2139\uFE0F</b> icon just before the website name<br>' +
          '<b>2.</b> Choose <b>Permissions</b> \u2192 <b>Camera</b> \u2192 <b>Allow</b><br>' +
          '<b>3.</b> Tap <b>Reload Page</b> below' +
          '</p>' +
          '<div class="row">' +
          '<button class="ssBtn ssPri" id="ssReload">🔄 Reload Page</button>' +
          '<button class="ssBtn ssSec" id="ssQuit">Close</button></div>' +
          '<p style="font-size:12px;opacity:.75;margin-top:12px;">' +
          'If you would rather not allow the camera, no problem — tap "Close" and ' +
          'send the file with <b>Upload Document</b>.</p>');
    el('ssReload').onclick = function () { location.reload(); };
    el('ssQuit').onclick = quit;
  }

  // Live hint — every ~400ms a small frame is checked to tell whether
  // the document is visible. Small so the battery is not drained.
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
          ? '<span class="ok">✓ Document found</span>'
          : 'Place the document inside the frame';
      } catch (e) { /* if the live hint fails, no problem */ }
    }, LIVE_EVERY_MS);
  }
  function stopLive() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

  function stopCamera() {
    stopLive();
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (video) video.srcObject = null;
  }

  // ═════════════════════════════════════════════════════════════════
  //  CAPTURE + THE FULL PIPELINE
  // ═════════════════════════════════════════════════════════════════
  async function capture() {
    if (busy || !video || !video.videoWidth) return;
    busy = true;
    stopLive();

    // The original photo — never touched; everything works on a copy of it
    var original = mkCanvas(video.videoWidth, video.videoHeight);
    original.getContext('2d').drawImage(video, 0, 0);

    try {
      processing('Looking for the document…');
      await breathe();

      var det = detectQuad(original, DETECT_W);

      // ── Quality check ──
      var sharp = sharpness(det.gray, det.w, det.h);
      var bright = meanBrightness(det.gray);
      // det.quad is at the scale of the original photo — to measure glare, bring
      // it to the smaller detection scale
      var qs = null;
      if (det.quad) {
        var kx = det.w / original.width, ky = det.h / original.height;
        qs = det.quad.map(function (p) { return [p[0] * kx, p[1] * ky]; });
      }
      var glare = glareFraction(det.gray, det.w, det.h, qs);

      if (bright < MIN_BRIGHT) {
        return problem('Too dark',
          'Retake the photo in better light or near a window.');
      }
      if (sharp < MIN_SHARPNESS) {
        return problem('Photo is blurry',
          'Hold the phone steady and retake. You can also tap the document to focus.');
      }
      if (glare > MAX_GLARE) {
        return problem('There is glare from the light',
          'Some text may be hidden under the glare. Change the angle a little and retake.');
      }
      // ── LET THE CUSTOMER FIX THE CORNERS ──
      // This used to SILENTLY accept the detection result, and fail completely
      // when confidence was low. Both were wrong.
      //
      // The Otsu + largest-blob detector only works when the document stands out
      // clearly from the background. An Aadhaar held in the hand? The finger and
      // the card have the same brightness — the blob swallows the fingers and
      // the "document" becomes almost the whole frame. That is why some documents
      // came out straight and some skewed.
      //
      // CamScanner does not trust its own detection either — after the photo it
      // ALWAYS shows draggable corners. Detection is only an initial
      // guess. Now it is the same here: the corners always show; if detection
      // was right the customer just presses Apply, if it was wrong they drag
      // the corners into place in 2 seconds. It never fails.
      hidePanel();
      el('ssWrap').style.visibility = 'hidden';   // give the crop screen a clean area

      var initPts = det.quad && det.confidence >= MIN_CONFIDENCE
        ? det.quad.map(function (p) { return { x: p[0], y: p[1] }; })
        : null;                                    // null = the default 12% inside

      var keep = original;                         // so finally does not wipe this
      original = null;

      openCropOn(keep, initPts,
        function (warpedRaw) { onScanCropped(warpedRaw, keep); },
        function () {                              // cancel — back to the camera
          el('ssWrap').style.visibility = '';
          keep.width = keep.height = 0;
          startCamera();
        });
    } catch (e) {
      problem('Something went wrong', 'Please try once more.');
    } finally {
      busy = false;
      // The original is released here — no copy is kept
      if (original) original.width = original.height = 0;
    }
  }

  // After the corners are confirmed: bring it to the right size, then clean it.
  async function onScanCropped(warpedRaw, keep) {
    el('ssWrap').style.visibility = '';
    busy = true;
    try {
      processing('Cleaning up…');
      await breathe();

      // The customer set the corners — derive the shape and size from them
      var quad = [[0, 0], [warpedRaw.width, 0],
                  [warpedRaw.width, warpedRaw.height], [0, warpedRaw.height]];
      var size = outputSize(quad);

      // When a template is chosen, the size is not GUESSED — it is fixed.
      // The ID card ratio of 85.6:54 is exact, so even if detection is wrong
      // the card will not be stretched.
      var T = currentTpl();
      if (T.id === 'idcard') {
        size = { w: 1011, h: 638, shape: 'ID card' };          // 85.6x54mm @300dpi
      } else if (T.id === 'a4full' || T.id === 'half') {
        size = { w: size.w, h: size.h, shape: 'paper' };
      }

      // FRONT-BACK MATCH: give the second side the same size and mode as the first,
      // otherwise the two pages print at different sizes and do not match when
      // put together (that was the complaint).
      if (capturedPages.length && capturedPages[0].size) {
        size = capturedPages[0].size;
      }

      // If the customer held the phone in landscape, or dragged the crop corners in
      // a different order, the warp output comes out rotated by 90° — the card
      // looked skewed/sideways. Compare with the target orientation (an ID card is
      // always landscape) and rotate if needed.
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
      problem('Something went wrong', 'Please try once more.');
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
      '<h3>' + (n === 1 ? 'Front side done' : 'Back side done') + '</h3>' +
      '<img id="ssPrev" src="' + prev + '" alt="scan preview">' +
      '<p style="margin-top:16px">' +
        (n === 1
          ? 'If that\'s all, tap <b>Print</b>. To print the back side as well, add it below.'
          : 'If that\'s all, tap <b>Print</b>, or add one more page.') +
      '</p>' +
      // A machine cannot tell the correct orientation just by looking at the photo —
      // that would require reading the text. So there is a one-tap button: each tap
      // turns 90°. If it came out upside down, tap twice.
      '<div class="row" style="margin-bottom:6px">' +
        '<button class="ssBtn ssSec" id="ssRot">\uD83D\uDD04 Rotate (90°)</button>' +
      '</div>' +
      // A typical customer scans only one side and moves on — so that
      // button comes FIRST and is green. The back-side button sits below it in a
      // lighter colour with a "+", so the two look different.
      '<div class="row">' +
        '<button class="ssBtn ssPri" id="ssDone">✅ Done — Print</button>' +
      '</div>' +
      '<div class="row" style="margin-top:8px">' +
        '<button class="ssBtn ssAdd" id="ssMore">\u2795 ' +
          (n === 1 ? 'Add Back Side' : 'Add Another Page') + '</button>' +
      '</div>' +
      '<div id="ssCount">' + n + (n === 1 ? ' page' : ' pages') + ' ready</div>'
    );
    el('ssMore').onclick = function () {
      hidePanel();
      el('ssHint').textContent = capturedPages.length === 1
        ? 'Now place the back side inside the frame'
        : 'Place the next page inside the frame';
      if (source === 'file') pickFile(); else startCamera();
    };
    el('ssRot').onclick = rotateLastScan;
    el('ssDone').onclick = finish;
  }

  // Rotate the last scan by 90° and show the preview again.
  function rotateLastScan() {
    var p = capturedPages[capturedPages.length - 1];
    if (!p || !p.canvas) return;
    var s = p.canvas;
    var c = mkCanvas(s.height, s.width);          // the dimensions swap
    var x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.translate(c.width / 2, c.height / 2);
    x.rotate(Math.PI / 2);
    x.drawImage(s, -s.width / 2, -s.height / 2);
    p.canvas = c;
    if (p.size) p.size = { w: c.width, h: c.height, shape: p.size.shape };
    s.width = s.height = 0;                       // release the old canvas
    askBackSide();
  }

  // ═════════════════════════════════════════════════════════════════
  //  FINISH — hand the finished pages to the existing flow
  //
  //  Nothing new happens from here on: the same pages[], the same preview,
  //  the same paper/color/copies, the same payment, the same print job.
  //  The Print Agent cannot even tell that the file came from the scanner.
  // ═════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  //  ID CARD → ONE A4 PAGE, AT REAL SIZE
  // ═══════════════════════════════════════════════════════════════
  // Each scan used to become a separate page, and the card was STRETCHED to the
  // width of A4 on that page — so the Aadhaar printed as large as the whole page
  // and the front/back went onto two separate sheets.
  //
  // A real Aadhaar/PAN card is CR80: 85.6 x 54 mm. In a shop its photocopy
  // always comes out at this size, otherwise the ID is useless.
  // So the card is now placed inside the A4 at its REAL size,
  // with front and back on the same sheet — one above the other, equal size,
  // with a 10 mm gap between them (enough for cutting/folding).
  var CARD_W_MM = 85.6, CARD_H_MM = 54;      // CR80 — Aadhaar / PAN / DL
  var A4_W_MM = 210, A4_H_MM = 297;
  var SHEET_DPI = 300;
  var CARD_GAP_MM = 10;                      // between two cards

  // Always keep the card straight (landscape) — whether the customer held the phone
  // in portrait or landscape, both sides must look the same when printed.
  // Rotate by 90° if needed.
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

  // Make a box on the A4 and show the whole document inside it (contain
  // fit — nothing is cut, nothing is stretched). Centered in the box.
  function fitInBox(ctx, src, bx, by, bw, bh) {
    var r = Math.min(bw / src.width, bh / src.height);
    var w = src.width * r, h = src.height * r;
    ctx.drawImage(src, bx + (bw - w) / 2, by + (bh - h) / 2, w, h);
  }

  // The composed sheet is itself A4 — place it on the page 1:1, neither smaller nor
  // shifted. This way the card prints at its real size (85.6x54 mm).
  function fitSheetsToPage() {
    if (typeof pages === 'undefined' || !pages.length) return;
    for (var i = 0; i < pages.length; i++) {
      var it = pages[i] && pages[i].items && pages[i].items[0];
      if (!it) continue;
      it.x = 0; it.y = 0;
      it.w = A4_DISPLAY_W; it.h = A4_DISPLAY_H;
      it._ix = 0; it._iy = 0; it._iw = it.w; it._ih = it.h;
      it._baseW = it.w; it._baseH = it.h;
      it.locked = true;              // moving it would spoil the size
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

  // Certificate: each side on its own A4 page, filling it (10mm margin)
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

  // Admit card / marksheet: front in the top half, back in the bottom
  // half — on a single sheet. The screenshot layout.
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

    // The screenshot layout: both cards at the TOP, side by side, with a gap between.
    // With only one side: the same size, at the top, centered — this is what the customer asked for.
    var top = Math.round(20 * mm);
    var totalW = list.length * cw + (list.length - 1) * gap;
    var x = Math.round((W - totalW) / 2);
    for (var i = 0; i < list.length; i++) {
      drawUpright(ctx, list[i].canvas, x, top, cw, ch);
      x += cw + gap;
    }
    return sheet;
  }

  // A card or a full sheet of paper? A card needs its real size, a full sheet
  // needs to fill the page — each gets different treatment.
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
      // ── 1. Clear the leftover state of the old flow ──
      //
      // ORIGINAL_PDF is the most important. This used to happen:
      //   the customer uploads a PDF → presses "Back" (pages are cleared,
      //   ORIGINAL_PDF is not) → scans with the Smart Scanner → "Everything is fine"
      // Later the pdfUntouched() shortcut in buildOutputFile() took this as true
      // and the OLD PDF went to the shop instead of the SCAN. The customer
      // paid for the scan and something else was printed.
      //
      // Clear pages too — after returning from Mini Print its pages can remain
      // and the scan would be appended after them.
      if (typeof pages !== 'undefined' && pages.length) pages.length = 0;
      try { ORIGINAL_PDF = null; } catch (e) {}
      try { activePageIdx = 0; } catch (e) {}

      // ── 2. The scanner always uses A4 portrait ──
      // Both cards (Big Size and Smart Scanner) are on the same screen.
      // If the customer touched "Big Size Print" first, state.paperSize stayed 'a3'
      // and the scan printed on A3 — charging the customer more.
      try {
        state.paperSize = 'a4';
        state.orientation = 'portrait';
        var psel = document.getElementById('paperSizeSel');
        if (psel) psel.value = 'a4';
        if (typeof applyPaper === 'function') applyPaper();
      } catch (e) {}

      // ── 3. Build the page(s) ──
      // ID card (Aadhaar/PAN/DL): front+back on ONE A4, at real size.
      // A full sheet was scanned: as before, each scan gets its own page.
      var T = currentTpl();
      var composed = true;
      if (T.id === 'idcard' || (T.id === 'auto' && allCards(capturedPages))) {
        addPage([composeCardSheet(capturedPages)], true);        // one page, real card size
      } else if (T.id === 'half') {
        addPage([composeHalfSheet(capturedPages)], true);        // front on top, back below
      } else if (T.id === 'a4full') {
        composeA4Full(capturedPages).forEach(function (c) { addPage([c], true); });
      } else {
        composed = false;
        capturedPages.forEach(function (p) { addPage([p.canvas], true); });
      }

      // ⚠️ IMPORTANT: createItemFromCanvas() fits every document to 90% of the page
      // (maxWPercent 0.92, then the h > a4H*0.9 line brings it down to 0.9).
      // That is fine for normal documents — but our sheet is ITSELF A4 and already
      // has its margins built in. Placing it at 90% printed an 85.6 mm card at
      // 77 mm. That was the "it comes out small" problem.
      // Place the sheet on the full page and lock it.
      if (composed) fitSheetsToPage();

      stopCamera();
      el('ssWrap').classList.remove('on');

      // ── 4. Hide the upload screen ──
      // The scanner opens from a card inside secUpload, so that screen is
      // still open. showChoiceScreen() only hides secEditor —
      // not secUpload. Without this, the whole upload page (and all the service
      // cards) stayed visible below the choice card.
      if (typeof hide === 'function') {
        hide('secUpload'); hide('secMini');
        hide('secEditor'); hide('secPreviewStep');
      }
      if (typeof setStep === 'function') setStep(2);

      var n = capturedPages.length;
      capturedPages = [];

      if (typeof toast === 'function') {
        toast('📸 ' + n + (n === 1 ? ' page' : ' pages') + ' scanned');
      }
      // The same screen of the existing flow that appears after an upload
      if (typeof showChoiceScreen === 'function') showChoiceScreen();
    } catch (e) {
      problem('Could not prepare the page', 'Please try once more.');
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
  //  ENTRY POINT — the service card calls this
  // ═════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  //  A4 LAYOUT TEMPLATE
  // ═══════════════════════════════════════════════════════════════
  // Auto-identify sometimes gets the size wrong (a card held in the hand,
  // glare, a colourful background). If the customer says up front what is being
  // scanned, the size is not GUESSED — it is FIXED.
  //
  //  idcard — CR80 85.6x54mm, the real card size. One side goes in the middle,
  //           two sides go side by side at the top (the screenshot layout).
  //  a4full — fill the whole A4, small margin. Certificate, letter, deed.
  //  half   — half a page. Admit card / marksheet: front in the top half,
  //           back in the bottom half — both on a single sheet.
  //  auto   — as before, the system detects the size itself.
  var TEMPLATES = [
    { id: 'idcard', icon: '\uD83E\uDeaa', title: 'ID Card',
      sub: 'Aadhaar · PAN · Voter · DL — front & back on one page',
      hint: 'Place the card inside the frame' },
    { id: 'a4full', icon: '\uD83D\uDCDC', title: 'Certificate',
      sub: 'Full A4 document — marksheet, certificate, letter',
      hint: 'Place the whole page inside the frame' },
    { id: 'half',   icon: '\uD83C\uDFAB', title: 'Admit Card / Marksheet',
      sub: 'Half page — front on top, back below, on the same sheet',
      hint: 'Place the document inside the frame' },
    { id: 'auto',   icon: '\uD83E\uDD16', title: 'Auto',
      sub: 'Let the system detect the size',
      hint: 'Place the document inside the frame' }
  ];
  var tpl = TEMPLATES[3];                       // default = auto

  function currentTpl() { return tpl || TEMPLATES[3]; }

  // A small map of each layout — one glance shows better than words
  // what will print where on the paper. The A4 ratio (36x51) is kept
  // so what you see is what you get.
  function tplThumb(id) {
    var box = '<rect x="1.5" y="1.5" width="33" height="48" rx="2.5" ' +
              'fill="#fff" stroke="#c8cdd4" stroke-width="1.4"/>';
    var inner = '';
    if (id === 'idcard') {
      // both cards on top, side by side
      inner = '<rect x="4.5" y="6" width="12.6" height="8" rx="1" fill="#7c3aed"/>' +
              '<rect x="19" y="6" width="12.6" height="8" rx="1" fill="#a78bfa"/>';
    } else if (id === 'a4full') {
      // the whole page filled
      inner = '<rect x="5" y="5" width="26" height="41" rx="1.5" fill="#7c3aed"/>';
    } else if (id === 'half') {
      // top half + bottom half
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
    var html = '<h3>What are you scanning?</h3>' +
      '<p>Choosing the right one sets the size automatically — after cropping, ' +
      'the document locks straight into the layout.</p><div class="ssTpl">';
    for (var i = 0; i < TEMPLATES.length; i++) {
      var t = TEMPLATES[i];
      html += '<button class="ssTplBtn" data-i="' + i + '">' +
              tplThumb(t.id) +
              '<span class="ssTplTxt"><b>' + t.title + '</b><i>' + t.sub + '</i></span>' +
              '</button>';
    }
    html += '</div><div class="row">' +
            '<button class="ssBtn ssSec" id="ssTplQuit">Close</button></div>';
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
  //  WHERE THE PHOTO COMES FROM — the camera or a file on the device
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
          '<i>Take a photo now — fastest when the document is in front of you</i>' +
          '</span></button>'
      : '';
    panel('<h3>Where should the photo come from?</h3>' +
      '<p>Both give the same result — corner fixing and cleanup happen in both.</p>' +
      '<div class="ssTpl">' + cam +
        '<button class="ssTplBtn" id="ssSrcFile">' +
          '<span class="ssTplIco">\uD83D\uDCC1</span>' +
          '<span class="ssTplTxt"><b>Files</b>' +
          '<i>Choose a photo already on your phone or computer</i>' +
          '</span></button>' +
      '</div>' +
      (camAvailable() ? ''
        : '<p>The camera does not work in this browser, so only the Files option is available.</p>') +
      '<div class="row">' +
        '<button class="ssBtn ssSec" id="ssSrcBack">‹ Back</button>' +
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
      return fileProblem('File picker not found',
        'Refresh the page and try again.');
    }
    fi.click();
  }

  // problem()'s "Take the photo again" opens the camera — on the file path
  // that would lead to the wrong place. Hence its file-path counterpart.
  function fileProblem(title, detail) {
    showBar(false);
    panel('<h3>' + title + '</h3><p>' + detail + '</p>' +
          '<div class="row">' +
          '<button class="ssBtn ssPri" id="ssRetryF">Choose another file</button>' +
          '<button class="ssBtn ssSec" id="ssQuitF">Close</button>' +
          '</div>');
    el('ssRetryF').onclick = pickFile;
    el('ssQuitF').onclick = quit;
  }

  // The camera is limited to 1920x1440; a gallery photo can be up to 50MP.
  // On a photo that large, detection and warp eat up the phone's memory,
  // so the size is reduced before any work.
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
      // createImageBitmap is fast and fixes the EXIF rotation by itself.
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
      processing('Reading file…');
      await breathe();

      var img = null;
      try { img = await loadPickedImage(f); }
      catch (e) {
        return fileProblem('The browser could not open this photo',
          'HEIC photos often do not open. In Camera Settings, set the photo format to ' +
          '"JPEG / Most compatible" and take the photo again, or convert the photo to JPG ' +
          'and choose it.');
      }

      var iw = img.width || img.naturalWidth;
      var ih = img.height || img.naturalHeight;
      if (!iw || !ih) {
        return fileProblem('The photo came out empty',
          'Choose from the phone\'s Gallery instead of Google Photos or Drive.');
      }

      var k = Math.min(1, FILE_MAX / Math.max(iw, ih));
      var original = mkCanvas(Math.round(iw * k), Math.round(ih * k));
      var octx = original.getContext('2d');
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(img, 0, 0, original.width, original.height);
      if (img.close) { try { img.close(); } catch (e3) {} }

      processing('Looking for the document…');
      await breathe();

      // The lighting/blur/glare checks are DELIBERATELY not done here —
      // the reason is written at the top of the file.
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
        function () {                       // cancel — back to the chooser screen
          el('ssWrap').style.visibility = '';
          keep.width = keep.height = 0;
          askSource();
        });
    } catch (e4) {
      fileProblem('Something went wrong', 'Please try once more.');
    } finally {
      busy = false;
    }
  }

  function startSmartScanner() {
    // Camera permission is requested ONLY now, not when the page opens
    // (spec section 42)
    // The scanner used to refuse to open when there was no camera. Now there is
    // also the Files path, so blocking would be wrong — if the camera does not
    // work, askSource() will simply show only Files.
    mount();
    capturedPages = [];
    tpl = null;
    source = 'cam';
    el('ssWrap').classList.add('on');
    el('ssHint').textContent = 'Place the document inside the frame';
    // Ask for the layout first — the camera comes later. This way the size is
    // decided by the customer's answer, not by a guess.
    askTemplate();
  }

  window.startSmartScanner = startSmartScanner;

  // Only for the test page. __SS_TEST__ is never set in production,
  // so this never runs in a customer's browser.
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
