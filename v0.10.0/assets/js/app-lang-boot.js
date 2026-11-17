/* i18n-ignore-file — no words of its own: it swaps in the language files the edition ships.
 *
 * app-lang-boot.js — the language of a PACKED page (a browser edition, or an app inside the CadCraft Studio suite).
 * On the website the server reads the cc_lang cookie and renders the right language. A packed page is rendered once, in
 * English, so this classic script (loaded by devshell/render.php --edition only, right after the #cc-lang catalog and
 * before any module or the shell scripts read it) picks the language in the browser:
 *   1. the choice: cookie cc_lang, else Studio's localStorage "cadcraft.studio.lang", else Automatic (navigator.languages),
 *      matched against the languages the Settings list offers (same rules as Lang::match: exact, language alone, first
 *      with that language);
 *   2. when that is not English: the shell file (assets/lang/shell/<locale>.json, beside assets/js) and the app's own file
 *      (assets/apps/<slug>/<version>/lang/<locale>.json) are read (synchronously: this has to finish before the modules
 *      start) and laid over the catalog in #cc-lang; <html lang dir> follow;
 *   3. the markup PHP printed in English (menus, buttons, the Settings dialog) is translated in place, where a text node,
 *      title, aria-label, placeholder or alt says exactly it: by the key that printed it when the page lists them
 *      (#cc-lang-printed, Lang::record: fills filled, plurals chosen, strings several keys share handed out in print
 *      order), else any English string with no {fills} that only one translation matches (pages packed before 0.9);
 *   4. the Settings language list shows the real choice.
 * A file that cannot be read leaves the page in English. No network beyond the edition's own files.
 */
(function (root) {
  'use strict';
  var COOKIE = 'cc_lang', LS_KEY = 'cadcraft.studio.lang', RTL = ['ar', 'arc', 'ckb', 'dv', 'fa', 'ha', 'he', 'khw', 'ks', 'ku', 'ps', 'sd', 'ug', 'ur', 'yi'];

  function normalise(tag) {
    var p = String(tag || '').trim().split(/[-_]/);
    var out = [p.shift().toLowerCase()];
    p.forEach(function (s) { out.push(s.length === 2 ? s.toUpperCase() : s.length === 4 ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s); });
    return out.join('-');
  }
  /** Lang::match: exact, else the language alone, else the first available with that language; null for none. */
  function match(want, available) {
    var w = normalise(want);
    if (!/^[a-z]{2,3}(-([A-Z]{2}|[0-9]{3}|[A-Z][a-z]{3}))?$/.test(w)) return null;
    if (available.indexOf(w) >= 0) return w;
    var lang = w.split('-')[0];
    if (available.indexOf(lang) >= 0) return lang;
    for (var i = 0; i < available.length; i++) if (available[i].split('-')[0] === lang) return available[i];
    return null;
  }
  /** The locale to show: the choice (cookie, then Studio's), else the browser's languages, else English. */
  function pick(choice, browser, available) {
    var list = choice ? [choice] : (browser || []);
    for (var i = 0; i < list.length; i++) { var m = match(list[i], available); if (m) return m; }
    return 'en';
  }
  /** Lang::chain: [locale, its language if offered, en]. */
  function chain(loc, available) {
    var c = [loc], lang = loc.split('-')[0];
    if (lang !== loc && available.indexOf(lang) >= 0) c.push(lang);
    if (c.indexOf('en') < 0) c.push('en');
    return c;
  }
  var api = { normalise: normalise, match: match, pick: pick, chain: chain };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root.document) return;
  root.ccLangBoot = api;

  var doc = root.document;
  function cookie() {
    var m = /(?:^|;\s*)cc_lang=([^;]*)/.exec(doc.cookie || '');
    try { return m ? decodeURIComponent(m[1]) : ''; } catch (e) { return ''; }
  }
  function stored() { try { return root.localStorage.getItem(LS_KEY) || ''; } catch (e) { return ''; } }

  var tag = doc.getElementById('cc-lang'), select = doc.getElementById('shell-lang');
  if (!tag || !select) return;                                   // a single-language app has no list: stays as it is
  var available = [];
  Array.prototype.forEach.call(select.options, function (o) { if (o.value && o.value !== 'en-XA') available.push(o.value); });
  var choice = cookie() || stored();
  var picked = choice ? match(choice, available) : null;
  select.value = picked || '';                                  // the real choice; Automatic when none (or one this build lacks)

  var loc = pick(choice, root.navigator && (root.navigator.languages && root.navigator.languages.length ? root.navigator.languages : [root.navigator.language]), available);
  var cat;
  try { cat = JSON.parse(tag.textContent || 'null'); } catch (e) { cat = null; }
  if (!cat || typeof cat.strings !== 'object' || loc === 'en' || loc === cat.locale) return;

  var script = doc.currentScript, base = script && script.src ? script.src : doc.baseURI;
  var shellDir = new URL('../lang/shell/', base).href;
  var edTag = doc.getElementById('cc-edition'), ed = {};
  try { ed = JSON.parse((edTag && edTag.textContent) || '{}'); } catch (e) { ed = {}; }
  if (!ed.app || !ed.version) return;
  var appDir = new URL('assets/apps/' + ed.app + '/' + ed.version + '/lang/', doc.baseURI).href;

  function readFile(url) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', url, false);                                 // synchronous on purpose: the modules read the catalog right after
      x.send(null);
      if (x.status && x.status !== 200) return {};
      var d = JSON.parse(x.responseText), out = {};
      Object.keys(d).forEach(function (k) {
        var v = d[k];
        if (k.charAt(0) === '@') return;
        if (typeof v === 'string' || (v && typeof v === 'object' && typeof v.other === 'string')) out[k] = v;
      });
      return out;
    } catch (e) { return {}; }
  }
  function merged(c) {                                           // Lang::merged: the first file in the chain that has a key wins
    var out = {};
    c.slice().reverse().forEach(function (l) {
      var s = readFile(shellDir + l + '.json'), a = readFile(appDir + l + '.json');
      Object.keys(s).forEach(function (k) { out[k] = s[k]; });
      Object.keys(a).forEach(function (k) { out[k] = a[k]; });
    });
    return out;
  }

  var ch = chain(loc, available);
  var strings = merged(ch);
  if (!Object.keys(strings).some(function (k) { return strings[k] !== undefined; })) return;   // nothing readable: English
  var en = merged(['en']);
  // The page's own catalog (without the keys only PHP prints) in the new language.
  var next = {};
  Object.keys(cat.strings).forEach(function (k) { next[k] = strings[k] !== undefined ? strings[k] : cat.strings[k]; });
  tag.textContent = JSON.stringify({ locale: loc, chain: ch, strings: next }).replace(/</g, '\\u003c').replace(/&/g, '\\u0026');
  doc.documentElement.lang = loc;
  doc.documentElement.dir = RTL.indexOf(loc.split('-')[0]) >= 0 ? 'rtl' : 'ltr';

  // The English the server printed → the new language, for plain strings only (no fills, not a plural table).
  var map = Object.create(null), clash = Object.create(null);
  Object.keys(en).forEach(function (k) {
    var e = en[k], t = strings[k];
    if (typeof e !== 'string' || typeof t !== 'string' || e === t || e.length < 2 || /[{}]/.test(e)) return;
    if (map[e] !== undefined && map[e] !== t) clash[e] = true;
    map[e] = t;
  });
  Object.keys(clash).forEach(function (e) { delete map[e]; });

  // Exact: the keys PHP printed (#cc-lang-printed, Lang::record), each with its fills. The English it printed → that key's
  // translation, so a string several keys share ("Open", "New") and text with fills ("About {app}") change too. When one
  // English string was printed by keys that translate differently, the walk hands them out in the order they were printed.
  function fill(text, vars) {
    return String(text).replace(/\{\{|\}\}|\{([A-Za-z_][A-Za-z0-9_]*)\}/g, function (m, name) {
      if (m === '{{') return '{';
      if (m === '}}') return '}';
      return vars && vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : m;
    });
  }
  function form(v, n, l) {
    if (typeof v === 'string') return v;
    if (!v || typeof v !== 'object') return null;
    if (n !== undefined && typeof v['=' + n] === 'string') return v['=' + n];
    var cat = 'other';
    try { if (n !== undefined && typeof Intl !== 'undefined' && Intl.PluralRules) cat = new Intl.PluralRules(l).select(Number(n)); } catch (e) { cat = 'other'; }
    return typeof v[cat] === 'string' ? v[cat] : (typeof v.other === 'string' ? v.other : null);
  }
  var exact = Object.create(null), used = Object.create(null);
  var pTag = doc.getElementById('cc-lang-printed'), printed = [];
  try { printed = JSON.parse((pTag && pTag.textContent) || '[]') || []; } catch (e) { printed = []; }
  printed.forEach(function (p) {
    if (!p || typeof p[0] !== 'string') return;
    var vars = p[1] || {}, eForm = form(en[p[0]], vars.n, 'en'), tForm = form(strings[p[0]], vars.n, loc);
    if (eForm === null) return;
    tForm = tForm === null ? eForm : tForm;
    // A fill that is markup ("Choose {open} or drop…" with <strong>Open</strong>) splits the sentence into text nodes: the
    // pieces between the fills are matched one by one, when the translation keeps the same fills in the same order.
    var markup = Object.keys(vars).some(function (k) { return /[<\uE000]/.test(String(vars[k])); });   // markup, or the \uE000n\uE001 stand-ins a $__lx helper fills later
    if (markup) {
      var FILL = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
      var names = function (s) { var o = [], m; FILL.lastIndex = 0; while ((m = FILL.exec(s))) o.push(m[1]); return o.join(','); };
      if (names(eForm) !== names(tForm)) return;
      var ep = eForm.split(/\{[A-Za-z_][A-Za-z0-9_]*\}/), tp = tForm.split(/\{[A-Za-z_][A-Za-z0-9_]*\}/);
      ep.forEach(function (piece, i) {
        var a = piece.trim(), b = (tp[i] || '').trim();
        if (a.length >= 2 && b) (exact[a] || (exact[a] = [])).push(b);
      });
      return;
    }
    var eo = fill(eForm, vars).trim(), to = fill(tForm, vars).trim();
    if (eo.length < 2) return;
    (exact[eo] || (exact[eo] = [])).push(to);
  });
  Object.keys(exact).forEach(function (e) {
    var q = exact[e];
    q.same = q.every(function (t) { return t === q[0]; });
  });
  function swap(s) {
    var q = exact[s];
    if (q) {
      if (q.same) return q[0] === s ? undefined : q[0];
      var i = used[s] || 0; used[s] = i + 1;
      var t = q[Math.min(i, q.length - 1)];
      return t === s ? undefined : t;
    }
    return map[s];
  }
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, PRE: 1, CODE: 1, NOSCRIPT: 1, SVG: 1 };
  function walk(node) {
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        var d = c.data, tr = d.trim(), to = tr ? swap(tr) : undefined;
        if (to !== undefined) c.data = d.replace(tr, to);
      } else if (c.nodeType === 1 && !SKIP[c.nodeName.toUpperCase()] && !c.hasAttribute('data-no-translate')) {
        ['title', 'aria-label', 'placeholder', 'alt'].forEach(function (a) {
          var v = c.getAttribute(a), tv = v ? swap(v.trim()) : undefined;
          if (tv !== undefined) c.setAttribute(a, tv);
        });
        walk(c);
      }
    }
  }
  var body = doc.body;
  if (body) {
    // The language list keeps each language's own name (it is not English text); everything else is walked.
    var opts = select.options, saved = [];
    for (var i = 0; i < opts.length; i++) saved.push(opts[i].textContent);
    walk(body);
    for (var j = 0; j < opts.length; j++) if (j > 0) opts[j].textContent = saved[j];
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
