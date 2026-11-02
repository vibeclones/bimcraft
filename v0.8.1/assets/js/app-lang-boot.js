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
 *   3. the markup PHP printed in English (menus, buttons, the Settings dialog) is translated in place: every English
 *      string with no {fills} that has a translation is swapped where a text node, title, aria-label, placeholder or
 *      alt says exactly it. Text with fills, and text two strings share with different translations, stays English;
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
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, PRE: 1, CODE: 1, NOSCRIPT: 1, SVG: 1 };
  function walk(node) {
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        var d = c.data, tr = d.trim();
        if (tr && map[tr] !== undefined) c.data = d.replace(tr, map[tr]);
      } else if (c.nodeType === 1 && !SKIP[c.nodeName.toUpperCase()] && !c.hasAttribute('data-no-translate')) {
        ['title', 'aria-label', 'placeholder', 'alt'].forEach(function (a) {
          var v = c.getAttribute(a);
          if (v && map[v.trim()] !== undefined) c.setAttribute(a, map[v.trim()]);
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
