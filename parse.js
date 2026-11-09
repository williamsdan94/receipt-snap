/* Receipt Snap — turns the text read from a photo into store, date,
   items, subtotal, tax and total. It's a best guess: Daniel always checks
   the result on the review screen. It must never crash, even on gibberish. */
(function (root) {
  'use strict';

  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var LOW_CONF = 60; // lines the reader is less than 60% sure about get a "Check this" flag

  // A price at the very end of a line, like "4.99", "$4.99", "4,99", "4 .99", "-1.00",
  // optionally followed by a tax flag letter some stores print (e.g. "4.99 T").
  var END_PRICE = /(-?\s?\$?\s?-?\d{1,5}(?:,\d{3})*\s?[.,]\s?\d{2})\s*-?\s*[A-Za-z]{0,2}\s*$/;

  // Turns "$1,234.56", "4,99" or "4 .99" into a number with cents. Returns null if it can't.
  function toMoney(s) {
    if (s === null || s === undefined) return null;
    var t = String(s).replace(/[\s$]/g, '');
    var neg = /^-|-$/.test(t);
    t = t.replace(/-/g, '');
    var m = t.match(/^(\d{1,5}(?:,\d{3})*)[.,](\d{2})$/) || t.match(/^(\d{1,7})$/);
    if (!m) return null;
    var whole = m[1].replace(/,/g, '');
    var n = parseFloat(whole + '.' + (m[2] || '00'));
    if (!isFinite(n)) return null;
    n = Math.round(n * 100) / 100;
    return neg ? -n : n;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // Makes "YYYY-MM-DD" if the numbers are a real calendar date, otherwise ''.
  function isoDate(y, m, d) {
    y = +y; m = +m; d = +d;
    if (y < 100) y += 2000;
    if (!(y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    var dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return ''; // e.g. Feb 30
    return y + '-' + pad(m) + '-' + pad(d);
  }

  // Finds a date in one line of text. Handles 11/09/2026, 11-9-26, 2026-11-09, Nov 9, 2026, 9 Nov 2026.
  function findDate(line) {
    var s = String(line), m, r;
    m = s.match(/\b(20\d{2})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/);
    if (m && (r = isoDate(m[1], m[2], m[3]))) return r;
    m = s.match(/\b(\d{1,2})\s?[\/\-.]\s?(\d{1,2})\s?[\/\-.]\s?(\d{4}|\d{2})\b/);
    if (m && (r = isoDate(m[3], m[1], m[2]))) return r;
    m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/);
    if (m) { var i = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()); if (i >= 0 && (r = isoDate(m[3], i + 1, m[2]))) return r; }
    m = s.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(20\d{2})\b/);
    if (m) { var j = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()); if (j >= 0 && (r = isoDate(m[3], j + 1, m[1]))) return r; }
    return '';
  }

  // Words that mean "this line is about paying, not something you bought".
  var NOT_ITEM = /\b(change|cash|card|visa|master\s?card|amex|discover|debit|credit|tender|tendered|balance|payment|paid|approved|approval|auth|account|acct|ref|terminal|tip|gratuity|due|savings|you saved|points|rewards|member|items? sold|qty|quantity|thank|receipt|tel|phone)\b/i;
  var SUBTOTAL = /\bsub\s*-?\s*t[o0]ta[l1i]?\b|\bsubt[o0]t/i;
  var TAX = /\b(sales\s*)?ta[xk]\b|\bhst\b|\bgst\b|\bpst\b|\bvat\b/i;
  var TOTAL = /\bt[o0]ta[l1i]\b/i;

  // Common reader mix-ups inside a price at the end of a line: O->0, l/I/|/]->1.
  // Only touches the last word, and only if it already has a real digit and looks like "d.dd".
  function fixPriceTypos(s) {
    return s.replace(/([0-9OoIl|\]]{1,5}\s?[.,]\s?[0-9OoIl|\]]{2})(\s*[A-Za-z]?)$/, function (all, num, tail) {
      if (!/\d/.test(num)) return all;
      return num.replace(/[Oo]/g, '0').replace(/[Il|\]]/g, '1') + tail;
    });
  }

  // Cleans up a line: trims, squeezes spaces.
  function clean(s) { return fixPriceTypos(String(s || '').replace(/[\t ]+/g, ' ').replace(/^[\s|_~*#:.,'"`]+|[\s|_~*#=:'"`]+$/g, '').trim()); }

  // Picks the store name: the first line near the top with real letters that
  // isn't a date, phone number, address-ish number line, or "welcome".
  function findStore(lines) {
    for (var i = 0; i < Math.min(lines.length, 6); i++) {
      var t = lines[i].text.replace(/^welcome\s+to\s+/i, '');
      var letters = (t.match(/[A-Za-z]/g) || []).length;
      if (letters < 3) continue;
      if (letters / t.replace(/\s/g, '').length < 0.6) continue; // mostly symbols or digits
      if (findDate(t) || /^\d/.test(t) || /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(t)) continue;
      if (/^(receipt|welcome|thank)/i.test(t)) continue;
      return { value: t.slice(0, 60), conf: lines[i].conf };
    }
    return { value: '', conf: 0 };
  }

  // Main entry point. Accepts the raw text plus (optionally) Tesseract's lines,
  // each with its own confidence. Returns plain values plus a "low" list naming
  // the fields Daniel should double-check.
  function parseReceipt(text, ocrLines) {
    var out = { store: '', date: '', items: [], subtotal: null, tax: null, total: null, low: [] };
    try {
      var lines = [];
      if (ocrLines && ocrLines.length) {
        for (var k = 0; k < ocrLines.length; k++) {
          var ol = ocrLines[k] || {};
          String(ol.text || '').split(/\r?\n/).forEach(function (piece) {
            var c = clean(piece);
            if (c) lines.push({ text: c, conf: typeof ol.confidence === 'number' ? ol.confidence : 100 });
          });
        }
      } else {
        String(text || '').split(/\r?\n/).forEach(function (piece) {
          var c = clean(piece);
          if (c) lines.push({ text: c, conf: 100 });
        });
      }
      if (!lines.length) { out.low = ['store', 'date', 'total']; return out; }

      var store = findStore(lines);
      out.store = store.value;
      if (!store.value || store.conf < LOW_CONF) out.low.push('store');

      // Date: first line that has one.
      var dateConf = 0;
      for (var a = 0; a < lines.length; a++) {
        var d = findDate(lines[a].text);
        if (d) { out.date = d; dateConf = lines[a].conf; break; }
      }
      if (!out.date || dateConf < LOW_CONF) out.low.push('date');

      // Walk every line that ends in a price and sort it into a bucket.
      var totals = [], firstMoneyIdx = -1, stopIdx = lines.length, taxConf = 0, totalConf = 0;
      for (var b = 0; b < lines.length; b++) {
        var line = lines[b].text, m = line.match(END_PRICE);
        if (!m) continue;
        var amt = toMoney(m[1]);
        if (amt === null) continue;
        var label = clean(line.slice(0, m.index));
        if (SUBTOTAL.test(label)) {
          if (out.subtotal === null) out.subtotal = amt;
          stopIdx = Math.min(stopIdx, b);
        } else if (TAX.test(label)) {
          if (out.tax === null) { out.tax = amt; taxConf = lines[b].conf; }
          stopIdx = Math.min(stopIdx, b);
        } else if (TOTAL.test(label) && !/sav|items?|qty|disc/i.test(label)) {
          totals.push({ amt: amt, conf: lines[b].conf, strong: /grand|amount|due|^\W*t[o0]ta[l1i]\W*$/i.test(label) });
          stopIdx = Math.min(stopIdx, b);
        } else if (b < stopIdx && !NOT_ITEM.test(label) && (label.match(/[A-Za-z]/g) || []).length >= 2 && !findDate(line)) {
          if (firstMoneyIdx < 0) firstMoneyIdx = b;
          // Drop a long product code at the start (e.g. "012345678901 MILK").
          var name = label.replace(/^\d{5,}\s+/, '').replace(/\s+\d{5,}$/, '').replace(/\s*@\s*$/, '');
          out.items.push({ name: name.slice(0, 80), price: amt, low: lines[b].conf < LOW_CONF });
        }
      }

      // Total: prefer a plain "TOTAL" / "GRAND TOTAL" line; if several, take the biggest
      // (the real total is never smaller than the other "total" lines on a receipt).
      if (totals.length) {
        var pool = totals.filter(function (t) { return t.strong; });
        if (!pool.length) pool = totals;
        var best = pool[0];
        pool.forEach(function (t) { if (t.amt > best.amt) best = t; });
        out.total = best.amt; totalConf = best.conf;
      } else if (out.subtotal !== null && out.tax !== null) {
        out.total = Math.round((out.subtotal + out.tax) * 100) / 100; // worked out, so flag it
      }
      if (out.total === null || totalConf < LOW_CONF) out.low.push('total');
      if (out.tax === null || (out.tax !== null && taxConf < LOW_CONF)) out.low.push('tax');
      if (out.items.length > 60) out.items = out.items.slice(0, 60);
    } catch (e) {
      // Never let odd text break the app; Daniel can type it in.
      out.low = ['store', 'date', 'total', 'tax'];
    }
    return out;
  }

  var api = { parseReceipt: parseReceipt, toMoney: toMoney, findDate: findDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReceiptParse = api;
})(this);
