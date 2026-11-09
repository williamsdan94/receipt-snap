/* Receipt Snap — the app itself.
   Screens: Home (list + search), Reading (progress), Review (edit before saving),
   Detail (one saved receipt), Export (CSV for CPABot).
   Everything stays on this phone: receipts live in the browser's own database
   (IndexedDB) and the text reader (Tesseract) runs on the phone from ./vendor/. */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var photoInput = document.getElementById('photo-input');
  var viewer = document.getElementById('viewer');
  var viewerImg = document.getElementById('viewer-img');

  // ---------- Small helpers ----------
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Makes text safe to put inside the page (so a receipt can't inject HTML).
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // 12.5 -> "$12.50", -1 -> "-$1.00", null -> ""
  function money(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
  }
  // "2026-11-09" -> "Nov 9, 2026" (done by hand so time zones can't shift the day)
  function niceDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    return MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1];
  }
  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  // Reads what Daniel typed in a money box: "$12.34", "12,34", "12" all work. Blank -> null.
  function readMoney(s) {
    s = String(s || '').trim();
    if (!s) return null;
    return window.ReceiptParse.toMoney(s.replace(/^\$/, ''));
  }
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function round2(n) { return Math.round(n * 100) / 100; }

  var toastTimer;
  function toast(text) {
    var t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  // ---------- Storage (IndexedDB, on this phone only) ----------
  // Two "tables": receipts (the text details) and photos (the compressed picture).
  var dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        var req = indexedDB.open('receipt-snap', 1);
        req.onupgradeneeded = function () {
          var d = req.result;
          if (!d.objectStoreNames.contains('receipts')) d.createObjectStore('receipts', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }
    return dbPromise;
  }
  function tx(stores, mode, work) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(stores, mode), result;
        t.oncomplete = function () { resolve(result); };
        t.onerror = t.onabort = function () { reject(t.error); };
        result = work(t);
        if (result && typeof result === 'object' && 'onsuccess' in result) {
          var r = result; r.onsuccess = function () { result = r.result; };
        }
      });
    });
  }
  function getAll() { return tx(['receipts'], 'readonly', function (t) { return t.objectStore('receipts').getAll(); }); }
  function getPhoto(id) {
    return tx(['photos'], 'readonly', function (t) { return t.objectStore('photos').get(id); })
      .then(function (row) { return row ? row.blob : null; });
  }
  function saveRecord(rec, photoBlob, photoChanged) {
    return tx(['receipts', 'photos'], 'readwrite', function (t) {
      t.objectStore('receipts').put(rec);
      if (photoChanged && photoBlob) t.objectStore('photos').put({ id: rec.id, blob: photoBlob });
    });
  }
  function deleteRecord(id) {
    return tx(['receipts', 'photos'], 'readwrite', function (t) {
      t.objectStore('receipts').delete(id);
      t.objectStore('photos').delete(id);
    });
  }

  // ---------- App state ----------
  var receipts = [];   // all saved receipts (without photos), newest first
  var view = 'home';
  var query = '';
  var draft = null;    // the receipt being reviewed/edited
  var currentId = null; // the receipt shown on the detail screen
  var objectUrls = []; // photo links to free up when we leave a screen

  function sortReceipts() {
    receipts.sort(function (a, b) {
      var da = a.date || (a.createdAt || '').slice(0, 10), dbb = b.date || (b.createdAt || '').slice(0, 10);
      if (da !== dbb) return da < dbb ? 1 : -1;
      return (a.createdAt || '') < (b.createdAt || '') ? 1 : -1;
    });
  }
  function photoUrl(blob) {
    var u = URL.createObjectURL(blob); objectUrls.push(u); return u;
  }
  function show(next) {
    objectUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    objectUrls = [];
    view = next;
    render();
    window.scrollTo(0, 0);
  }

  // ---------- Search ----------
  // Matches store, item names, the date (either "2026-11-09" or "Nov 9, 2026") and any amount.
  function haystack(r) {
    var parts = [r.store, r.date, niceDate(r.date)];
    [r.total, r.tax].forEach(function (n) { if (typeof n === 'number') parts.push(n.toFixed(2), money(n)); });
    (r.items || []).forEach(function (it) {
      parts.push(it.name);
      if (typeof it.price === 'number') parts.push(it.price.toFixed(2));
    });
    return parts.join(' \u0001 ').toLowerCase();
  }
  function matches(r, q) {
    var words = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    var h = haystack(r);
    return words.every(function (w) { return h.indexOf(w) !== -1; });
  }

  // ---------- Screens ----------
  function render() {
    if (view === 'home') return renderHome();
    if (view === 'reading') return renderReading();
    if (view === 'review') return renderReview();
    if (view === 'detail') return renderDetail();
    if (view === 'export') return renderExport();
  }

  function renderHome() {
    app.innerHTML =
      '<div class="topbar"><h1>Receipts</h1>' +
      '<button type="button" class="link" data-action="go-export">Export</button></div>' +
      (receipts.length ?
        '<div class="search-wrap"><input id="search" class="search" type="search" enterkeyhint="search" autocomplete="off" ' +
        'placeholder="Search store, item, date or amount" aria-label="Search receipts" value="' + esc(query) + '">' +
        '<button type="button" class="search-clear" data-action="clear-search" aria-label="Clear search"' + (query ? '' : ' hidden') + '>✕</button></div>' +
        '<div id="results"></div>'
        : '<p class="empty">No receipts yet. Tap Scan to add your first one.</p>') +
      '<div class="scanbar"><div class="scanbar-inner">' +
      '<p class="tip">Flatten it, good light, fill the frame</p>' +
      '<button type="button" class="btn-big" data-action="scan">📷 Scan receipt</button>' +
      '<button type="button" class="btn-small" data-action="manual">Type it in instead</button>' +
      '</div></div>';
    if (receipts.length) renderResults();
  }

  // Only the results redraw while typing, so the search box (and keyboard) stay put.
  function renderResults() {
    var box = document.getElementById('results');
    if (!box) return;
    var list = receipts.filter(function (r) { return matches(r, query); });
    if (!list.length) {
      box.innerHTML = '<p class="empty">No receipts match “' + esc(query) + '”.</p>';
      return;
    }
    box.innerHTML = (query ? '<p class="count">' + list.length + ' of ' + receipts.length + '</p>' : '') +
      '<ul class="list">' + list.map(function (r) {
        return '<li><button type="button" class="row-btn" data-action="open" data-id="' + esc(r.id) + '">' +
          '<span class="row-main"><span class="row-store">' + (esc(r.store) || 'No store name') + '</span>' +
          '<span class="row-date">' + (esc(niceDate(r.date)) || 'No date') + '</span></span>' +
          '<span class="money row-total">' + esc(money(r.total)) + '</span></button></li>';
      }).join('') + '</ul>';
  }

  function renderReading() {
    app.innerHTML =
      '<div class="reading" role="status" aria-live="polite">' +
      '<p>Reading receipt… (stays on your phone)</p>' +
      '<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="bar-fill" id="bar-fill"></div></div>' +
      '<p class="sub" id="reading-sub">Getting ready…</p>' +
      '<button type="button" class="btn-small" data-action="cancel-scan">Cancel</button>' +
      '</div>';
  }
  function setProgress(fraction, text) {
    var fill = document.getElementById('bar-fill');
    if (!fill) return;
    var pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    fill.style.width = pct + '%';
    fill.parentNode.setAttribute('aria-valuenow', pct);
    if (text) document.getElementById('reading-sub').textContent = text;
  }

  // Is this field worth a "Check this"? Scanned drafts: blank or unsure fields.
  // Typed-in drafts start blank on purpose, so they don't get flagged.
  function flagged(name) {
    if (!draft || !draft.scanned) return false;
    if (draft.low.indexOf(name) !== -1) return true;
    var v = draft[name];
    return v === null || v === undefined || String(v).trim() === '';
  }

  function fieldHtml(name, label, inputHtml) {
    return '<div class="field' + (flagged(name) ? ' flag' : '') + '" data-field="' + name + '">' +
      '<label for="f-' + name + '"><span>' + label + '</span><span class="check">Check this</span></label>' + inputHtml + '</div>';
  }

  function itemRowHtml(it, i) {
    var flag = draft.scanned && (it.low || !String(it.name).trim() || String(it.price).trim() === '');
    return '<div class="item" data-i="' + i + '">' +
      '<input class="inp name' + (flag ? ' flag' : '') + '" data-k="name" type="text" placeholder="Item" aria-label="Item ' + (i + 1) + ' name" value="' + esc(it.name) + '">' +
      '<input class="inp num price' + (flag ? ' flag' : '') + '" data-k="price" type="text" inputmode="decimal" placeholder="0.00" aria-label="Item ' + (i + 1) + ' price" value="' + esc(it.price) + '">' +
      '<button type="button" class="del" data-action="del-item" data-i="' + i + '" aria-label="Remove item ' + (i + 1) + '">✕</button></div>';
  }

  function renderReview() {
    var d = draft;
    app.innerHTML =
      '<div class="topbar"><button type="button" class="link" data-action="discard">' + (d.id ? 'Cancel' : 'Discard') + '</button>' +
      '<h2>' + (d.id ? 'Edit receipt' : 'Review') + '</h2>' +
      '<button type="button" class="link" data-action="retake">' + (d.photoBlob ? 'Retake' : 'Add photo') + '</button></div>' +
      '<div class="form">' +
      (d.photoBlob ? '<button type="button" class="thumb-btn" data-action="view-photo" aria-label="Show photo full size"><img id="thumb" alt="Receipt photo"></button>' : '') +
      (d.msg ? '<p class="msg">' + esc(d.msg) + '</p>' : '') +
      fieldHtml('store', 'Store', '<input id="f-store" class="inp" data-f="store" type="text" autocomplete="off" value="' + esc(d.store) + '">') +
      fieldHtml('date', 'Date', '<input id="f-date" class="inp" data-f="date" type="date" value="' + esc(d.date) + '">') +
      '<div><div class="group-label">Items</div><div class="items" id="items">' + d.items.map(itemRowHtml).join('') + '</div>' +
      '<button type="button" class="add" data-action="add-item">+ Add item</button></div>' +
      fieldHtml('tax', 'Tax', '<input id="f-tax" class="inp num" data-f="tax" type="text" inputmode="decimal" placeholder="0.00" value="' + esc(d.tax) + '">') +
      fieldHtml('total', 'Total', '<input id="f-total" class="inp num" data-f="total" type="text" inputmode="decimal" placeholder="0.00" value="' + esc(d.total) + '">') +
      '<p class="warn" id="mismatch" hidden></p>' +
      '</div>' +
      '<div class="footer"><div><button type="button" class="btn-big" data-action="save">Save</button></div></div>';
    if (d.photoBlob) document.getElementById('thumb').src = photoUrl(d.photoBlob);
    updateMismatch();
  }

  // Calm warning when items + tax don't add up to the total. Never blocks saving.
  function updateMismatch() {
    var el = document.getElementById('mismatch');
    if (!el || !draft) return;
    var total = readMoney(draft.total), tax = readMoney(draft.tax) || 0, sum = 0, any = false;
    draft.items.forEach(function (it) { var p = readMoney(it.price); if (p !== null) { sum += p; any = true; } });
    var calc = round2(sum + tax);
    if (total !== null && any && Math.abs(calc - total) >= 0.01) {
      el.textContent = 'Items + tax = ' + money(calc) + ', total says ' + money(total);
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  function renderDetail() {
    var r = receipts.filter(function (x) { return x.id === currentId; })[0];
    if (!r) return show('home');
    app.innerHTML =
      '<div class="topbar"><button type="button" class="link" data-action="home">Back</button><h2>Receipt</h2><span class="spacer"></span></div>' +
      '<div class="form">' +
      (r.hasPhoto ? '<button type="button" class="thumb-btn" data-action="view-photo" aria-label="Show photo full size"><img id="thumb" alt="Receipt photo"></button>' : '') +
      '<div class="ro"><span class="k">Store</span><span class="v">' + (esc(r.store) || '—') + '</span></div>' +
      '<div class="ro"><span class="k">Date</span><span class="v">' + (esc(niceDate(r.date)) || '—') + '</span></div>' +
      '<div><div class="group-label">Items</div><ul class="ro-items">' +
      ((r.items || []).length ? r.items.map(function (it) {
        return '<li><span>' + esc(it.name) + '</span><span class="money">' + esc(money(it.price)) + '</span></li>';
      }).join('') : '<li><span>No items</span></li>') + '</ul></div>' +
      '<div class="ro"><span class="k">Tax</span><span class="v money">' + (esc(money(r.tax)) || '—') + '</span></div>' +
      '<div class="ro"><span class="k">Total</span><span class="v money">' + (esc(money(r.total)) || '—') + '</span></div>' +
      '</div>' +
      '<div class="footer"><div><button type="button" class="btn-small btn-danger" data-action="delete">Delete</button>' +
      '<button type="button" class="btn-big" data-action="edit">Edit</button></div></div>';
    if (r.hasPhoto) {
      getPhoto(r.id).then(function (blob) {
        var img = document.getElementById('thumb');
        if (blob && img && view === 'detail' && currentId === r.id) img.src = photoUrl(blob);
      });
    }
  }

  function renderExport() {
    app.innerHTML =
      '<div class="topbar"><button type="button" class="link" data-action="home">Back</button><h2>Export</h2><span class="spacer"></span></div>' +
      '<div class="export">' +
      '<button type="button" class="btn-big" data-action="export-csv">Export CSV (for CPABot)</button>' +
      '<button type="button" class="btn-big" disabled>Back up everything</button>' +
      '<p class="soon">Coming later: a backup that includes the photos.</p>' +
      '<p class="note-line">Receipts live only on this phone. Export now and then as a backup.</p>' +
      '<p class="note-line">' + receipts.length + (receipts.length === 1 ? ' receipt' : ' receipts') + ' saved.</p>' +
      '</div>';
  }

  // ---------- Photo prep ----------
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not open that photo')); };
      img.src = url;
    });
  }
  // Draws the photo at "longSide" pixels on its longest edge. Photos are only made
  // bigger when "grow" is set (small photos read better a bit larger).
  function drawScaled(img, longSide, grow) {
    var w = img.naturalWidth, h = img.naturalHeight, s = longSide / Math.max(w, h);
    if (!grow) s = Math.min(1, s);
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  // Grayscale + contrast boost for faded receipts, in two steps:
  // 1) "Flatten the lighting": divide each pixel by the average brightness around it.
  //    Paper (and the table behind it) turns near-white, and faint ink stands out,
  //    even with a shadow across the photo.
  // 2) Stretch: the darkest 1% becomes black, the lightest 1% white.
  // 3) Darken the grays in between (faint ink becomes solid ink).
  function boostContrast(c) {
    var w = c.width, h = c.height, ctx = c.getContext('2d');
    var data = ctx.getImageData(0, 0, w, h), p = data.data, n = w * h, i, x, y;
    var g = new Float32Array(n);
    for (i = 0; i < n; i++) g[i] = (p[i * 4] * 299 + p[i * 4 + 1] * 587 + p[i * 4 + 2] * 114) / 1000;
    // Running totals make the "average around each pixel" fast.
    var W1 = w + 1, sum = new Float64Array(W1 * (h + 1));
    for (y = 0; y < h; y++) {
      var row = 0;
      for (x = 0; x < w; x++) { row += g[y * w + x]; sum[(y + 1) * W1 + x + 1] = sum[y * W1 + x + 1] + row; }
    }
    var r = Math.max(8, Math.round(Math.max(w, h) / 40)), out = new Float32Array(n);
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        var mean = (sum[y1 * W1 + x1] - sum[y0 * W1 + x1] - sum[y1 * W1 + x0] + sum[y0 * W1 + x0]) / ((y1 - y0) * (x1 - x0));
        var v = mean > 1 ? (g[y * w + x] / mean) * 255 : 255;
        out[y * w + x] = v > 255 ? 255 : v;
      }
    }
    var hist = new Array(256).fill(0);
    for (i = 0; i < n; i++) hist[out[i] | 0]++;
    var lo = 0, hi = 255, acc = 0;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc > n * 0.01) { lo = i; break; } }
    acc = 0;
    for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc > n * 0.01) { hi = i; break; } }
    if (hi - lo < 10) { lo = 0; hi = 255; } // blank photo: leave it alone
    var scale = 255 / (hi - lo);
    for (i = 0; i < n; i++) {
      var s = (out[i] - lo) * scale;
      s = s < 0 ? 0 : s > 255 ? 255 : s;
      // 3) Darken the in-between grays so faint ink reads as solid ink.
      s = 255 * Math.pow(s / 255, 2.5);
      p[i * 4] = p[i * 4 + 1] = p[i * 4 + 2] = s;
    }
    ctx.putImageData(data, 0, 0);
    return c;
  }
  function toJpeg(canvas, quality) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (b) { resolve(b); }, 'image/jpeg', quality);
    });
  }

  // ---------- Text reader (Tesseract, on this phone) ----------
  var lastText = '', workerPromise = null, worker = null, scanToken = 0, progressStage = '';
  function abs(path) { return new URL(path, document.baseURI).href; }
  function onTesseractLog(m) {
    if (!m || view !== 'reading') return;
    var p = typeof m.progress === 'number' ? m.progress : 0;
    if (m.status === 'recognizing text') setProgress(0.3 + 0.7 * p, 'Reading the text…');
    else setProgress(0.05 + 0.25 * p, 'Getting the reader ready (the first scan downloads about 7 MB, then it works offline)…');
  }
  function getWorker() {
    if (!workerPromise) {
      // All files come from ./vendor/ on this same site: no outside servers.
      workerPromise = window.Tesseract.createWorker('eng', 1, {
        workerPath: abs('vendor/worker.min.js'),
        corePath: abs('vendor/'),          // picks the SIMD version, or the plain one on older phones
        langPath: abs('vendor'),           // loads vendor/eng.traineddata.gz
        workerBlobURL: false,
        cacheMethod: 'none',               // the service worker already keeps an offline copy
        gzip: true,
        logger: onTesseractLog,
        errorHandler: function () {}
      }).then(function (w) {
        worker = w;
        return w.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '6', user_defined_dpi: '300' }).then(function () { return w; });
      });
      workerPromise.catch(function () { workerPromise = null; worker = null; });
    }
    return workerPromise;
  }
  function stopWorker() {
    if (worker) { try { worker.terminate(); } catch (e) { /* already stopped */ } }
    worker = null; workerPromise = null;
  }

  // Empty draft for typing a receipt in by hand.
  function blankDraft() {
    return { id: null, createdAt: null, store: '', date: todayIso(), items: [{ name: '', price: '' }], tax: '', total: '',
      low: [], scanned: false, photoBlob: null, photoChanged: false, msg: '' };
  }
  function fmtNum(n) { return typeof n === 'number' ? n.toFixed(2) : ''; }

  // The whole scan: shrink + clean up the photo, read it, guess the fields, open Review.
  // "keep" is the draft being retaken (so an edited receipt keeps its id).
  function scanFile(file, keep) {
    var token = ++scanToken;
    show('reading');
    setProgress(0.02, 'Getting the photo ready…');
    var photoBlob = null;
    loadImage(file).then(function (loaded) {
      var small = drawScaled(loaded.img, 1200);
      var ocrCanvas = boostContrast(drawScaled(loaded.img, 1600, true));
      URL.revokeObjectURL(loaded.url);
      return toJpeg(small, 0.7).then(function (b) { photoBlob = b; return ocrCanvas; });
    }).then(function (ocrCanvas) {
      if (token !== scanToken) return null;
      return getWorker().then(function (w) {
        if (token !== scanToken) return null;
        // First read treats the receipt as one block of text (copes with a slight tilt).
        return w.recognize(ocrCanvas).then(function (res) {
          var data = (res && res.data) || {};
          var first = window.ReceiptParse.parseReceipt(data.text || '', data.lines || []);
          if (token !== scanToken || strength(first) >= 4) return { data: data, parsed: first };
          // Weak result: read once more in "columns" mode and keep whichever found more.
          setProgress(0.3, 'Taking a second look…');
          return w.setParameters({ tessedit_pageseg_mode: '4' }).then(function () {
            return w.recognize(ocrCanvas);
          }).then(function (res2) {
            var d2 = (res2 && res2.data) || {};
            var second = window.ReceiptParse.parseReceipt(d2.text || '', d2.lines || []);
            return w.setParameters({ tessedit_pageseg_mode: '6' }).then(function () {
              return strength(second) > strength(first) ? { data: d2, parsed: second } : { data: data, parsed: first };
            });
          });
        });
      });
    }).then(function (res) {
      if (token !== scanToken || !res) return;
      lastText = res.data.text || '';
      var parsed = res.parsed;
      var found = parsed.store || parsed.total !== null || parsed.items.length;
      openScanned(keep, photoBlob, parsed, found ? '' : 'Couldn’t read much from this photo. Please type in the details, or tap Retake.');
    }).catch(function () {
      if (token !== scanToken) return;
      stopWorker();
      openScanned(keep, photoBlob, null, 'Couldn’t read this photo. Please type in the details, or tap Retake.');
    });
  }
  // How much did a read find? Total counts most, then date, tax and each item.
  function strength(p) {
    return (p.total !== null ? 3 : 0) + (p.date ? 1 : 0) + (p.tax !== null ? 1 : 0) + Math.min(p.items.length, 5);
  }
  function openScanned(keep, photoBlob, parsed, msg) {
    var d = blankDraft();
    if (keep) { d.id = keep.id; d.createdAt = keep.createdAt; }
    d.scanned = true;
    d.photoBlob = photoBlob; d.photoChanged = !!photoBlob;
    d.msg = msg;
    d.date = '';
    if (parsed) {
      d.store = parsed.store; d.date = parsed.date; d.tax = fmtNum(parsed.tax); d.total = fmtNum(parsed.total);
      d.low = parsed.low.slice();
      d.items = parsed.items.length ? parsed.items.map(function (it) { return { name: it.name, price: fmtNum(it.price), low: it.low }; })
        : [{ name: '', price: '' }];
    } else {
      d.low = ['store', 'date', 'tax', 'total'];
    }
    draft = d;
    show('review');
  }

  // ---------- Saving ----------
  function saveDraft() {
    var d = draft;
    var items = d.items.map(function (it) { return { name: String(it.name || '').trim(), price: readMoney(it.price) }; })
      .filter(function (it) { return it.name || it.price !== null; });
    var rec = {
      id: d.id || newId(),
      store: String(d.store || '').trim(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : '',
      items: items,
      tax: readMoney(d.tax),
      total: readMoney(d.total),
      hasPhoto: !!d.photoBlob || (d.id ? !!(receipts.filter(function (x) { return x.id === d.id; })[0] || {}).hasPhoto : false),
      createdAt: d.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    if (!rec.store && !items.length && rec.total === null && !d.photoBlob) { toast('Nothing to save yet'); return; }
    saveRecord(rec, d.photoBlob, d.photoChanged).then(function () {
      receipts = receipts.filter(function (x) { return x.id !== rec.id; });
      receipts.push(rec); sortReceipts();
      // Ask the phone to keep our data even when storage runs low (helps, not guaranteed).
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
      draft = null;
      if (d.id) { currentId = rec.id; show('detail'); } else show('home');
      toast('Saved');
    }).catch(function () { toast('Couldn’t save. Is the phone out of space?'); });
  }

  // ---------- CSV export ----------
  // Text cells: put a ' in front of anything a spreadsheet might run as a formula,
  // then wrap in quotes. Amounts are written as plain numbers (so -1.00 stays a number).
  function csvText(s) {
    s = String(s === null || s === undefined ? '' : s);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function csvNum(n) { return typeof n === 'number' && isFinite(n) ? n.toFixed(2) : ''; }
  function buildCsv(list) {
    var rows = ['date,store,item,item_price,tax,total,receipt_id'];
    list.forEach(function (r) {
      var items = (r.items && r.items.length) ? r.items : [{ name: '', price: null }];
      items.forEach(function (it) {
        rows.push([csvText(r.date), csvText(r.store), csvText(it.name), csvNum(it.price), csvNum(r.tax), csvNum(r.total), csvText(r.id)].join(','));
      });
    });
    return rows.join('\r\n') + '\r\n';
  }
  function exportCsv() {
    if (!receipts.length) { toast('No receipts to export yet'); return; }
    var name = 'receipts-' + todayIso() + '.csv';
    // The invisible \uFEFF mark at the start tells Excel the file is UTF-8, so names like "Café" show correctly.
    var text = '\uFEFF' + buildCsv(receipts);
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    // On iPhone, the Share sheet is the most reliable way to save or send a file from a Home Screen app.
    var file = null;
    try { file = new File([blob], name, { type: 'text/csv' }); } catch (e) { file = null; }
    if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Receipts CSV' }).then(function () {
        toast('CSV shared');
      }).catch(function (err) {
        // The user closed the Share sheet: do nothing. Any other problem: fall back to a normal download.
        if (!err || err.name !== 'AbortError') downloadBlob(blob, name);
      });
      return;
    }
    downloadBlob(blob, name);
  }
  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    toast('CSV ready');
  }

  // ---------- Taps ----------
  var retaking = null;
  app.addEventListener('click', function (e) {
    var b = e.target.closest('[data-action]');
    if (!b || b.disabled) return;
    var a = b.getAttribute('data-action');
    if (a === 'scan') { retaking = null; photoInput.click(); }
    else if (a === 'manual') { draft = blankDraft(); show('review'); }
    else if (a === 'retake') { retaking = draft; photoInput.click(); }
    else if (a === 'cancel-scan') { scanToken++; stopWorker(); show(draft ? 'review' : 'home'); }
    else if (a === 'go-export') show('export');
    else if (a === 'home') show('home');
    else if (a === 'export-csv') exportCsv();
    else if (a === 'clear-search') {
      query = ''; var s = document.getElementById('search'); s.value = ''; b.hidden = true; renderResults();
    }
    else if (a === 'open') { currentId = b.getAttribute('data-id'); show('detail'); }
    else if (a === 'discard') {
      var wasEdit = draft && draft.id; draft = null;
      if (wasEdit) show('detail'); else show('home');
    }
    else if (a === 'add-item') {
      draft.items.push({ name: '', price: '' });
      var box = document.getElementById('items');
      box.insertAdjacentHTML('beforeend', itemRowHtml(draft.items[draft.items.length - 1], draft.items.length - 1));
      box.lastChild.querySelector('.name').focus();
    }
    else if (a === 'del-item') {
      draft.items.splice(+b.getAttribute('data-i'), 1);
      document.getElementById('items').innerHTML = draft.items.map(itemRowHtml).join('');
      updateMismatch();
    }
    else if (a === 'save') saveDraft();
    else if (a === 'view-photo') {
      var img = document.getElementById('thumb');
      if (img && img.src) { viewerImg.src = img.src; viewer.hidden = false; }
    }
    else if (a === 'edit') {
      var r = receipts.filter(function (x) { return x.id === currentId; })[0];
      if (!r) return;
      getPhoto(r.id).then(function (blob) {
        draft = { id: r.id, createdAt: r.createdAt, store: r.store, date: r.date,
          items: (r.items || []).map(function (it) { return { name: it.name, price: fmtNum(it.price) }; }),
          tax: fmtNum(r.tax), total: fmtNum(r.total), low: [], scanned: false, photoBlob: blob, photoChanged: false, msg: '' };
        if (!draft.items.length) draft.items.push({ name: '', price: '' });
        show('review');
      });
    }
    else if (a === 'delete') {
      if (!window.confirm('Delete this receipt? This can’t be undone.')) return;
      deleteRecord(currentId).then(function () {
        receipts = receipts.filter(function (x) { return x.id !== currentId; });
        currentId = null; show('home'); toast('Deleted');
      });
    }
  });
  viewer.addEventListener('click', function () { viewer.hidden = true; viewerImg.removeAttribute('src'); });

  // Typing: keep the draft up to date without redrawing the screen (so the keyboard stays put).
  app.addEventListener('input', function (e) {
    var t = e.target;
    if (t.id === 'search') {
      query = t.value;
      var c = app.querySelector('.search-clear'); if (c) c.hidden = !query;
      renderResults();
      return;
    }
    if (!draft || view !== 'review') return;
    var f = t.getAttribute('data-f');
    if (f) {
      draft[f] = t.value;
      draft.low = draft.low.filter(function (x) { return x !== f; }); // he's checked it now
      var wrap = t.closest('.field');
      if (wrap) wrap.classList.toggle('flag', flagged(f));
    } else if (t.closest('.item')) {
      var row = t.closest('.item'), i = +row.getAttribute('data-i'), it = draft.items[i];
      if (it) {
        it[t.getAttribute('data-k')] = t.value; it.low = false;
        var still = draft.scanned && (!String(it.name).trim() || String(it.price).trim() === '');
        Array.prototype.forEach.call(row.querySelectorAll('.inp'), function (x) { x.classList.toggle('flag', still); });
      }
    }
    updateMismatch();
  });

  photoInput.addEventListener('change', function () {
    var file = photoInput.files && photoInput.files[0];
    photoInput.value = ''; // so picking the same photo again still works
    if (!file) return;
    var keep = retaking; retaking = null;
    scanFile(file, keep);
  });

  // ---------- Start ----------
  getAll().then(function (list) {
    receipts = list || []; sortReceipts(); render();
  }).catch(function () {
    app.innerHTML = '<p class="empty">This phone’s browser storage isn’t available (Private Browsing?). Receipts can’t be saved here.</p>';
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  // For the automated test only (read-only peek at the CSV builder).
  window.__receiptSnap = { buildCsv: buildCsv, csvText: csvText, lastText: function () { return lastText; } };
})();
