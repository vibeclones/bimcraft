// SPDX-License-Identifier: Apache-2.0
// "Between two programs" in BimCraft's left panel (0.6 DF.12 (c), session `bim-interop`): the property mapping files for
// the two programs a model travels between, and the round-trip report (what came back of a model that went out).
// DOM only; the work is prop-map.js and roundtrip.js. Shown while the Models section is (it follows its `hidden`).
import { el, num } from './ui-util.js';
import { t } from './i18n.js';
import { propertyIndex } from './ifc-props.js';
import { buildMap, revitSharedParams, revitIfcPsets, archicadMapCsv, withGuids } from './prop-map.js';
import { classificationIndex, roundTrip, roundTripCsv, keptShare } from './roundtrip.js';

/**
 * ctx: { after (element the section goes after), W (the IFC engine namespace), models() → [{mi, ifc, model, name}],
 * active() → the active entry, manifest() → an open bundle's manifest or null, download(name, data, type), status(msg, isError, fade) }
 * → { render(), report(sentMi, backMi) → the report (tests) }
 */
export function mountInterop(ctx) {
  const sec = el('section', { className: 'bc-sec', 'data-interop-sec': '', hidden: true });
  const det = el('details', { className: 'bc-find-details', 'data-interop-details': '' }, el('summary', { className: 'bc-h' }, t('interop.title')));
  const body = el('div', { 'data-interop': '' });
  det.append(body);
  sec.append(det);
  ctx.after.after(sec);
  new MutationObserver(() => { sec.hidden = ctx.after.hidden; render(); }).observe(ctx.after, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true });   // models added or removed
  sec.hidden = ctx.after.hidden;
  det.addEventListener('toggle', () => { if (det.open) render(); });
  const cache = new WeakMap();   // model → { ix, cls }
  let last = null;               // the last report, kept while its models are open

  const indexOf = (ent) => {
    let c = cache.get(ent.model);
    if (!c) cache.set(ent.model, (c = { ix: propertyIndex(ctx.W, ent.ifc.api, ent.model.modelID, ent.model), cls: classificationIndex(ent.ifc.api, ent.model.modelID) }));
    return c;
  };
  const base = (ent) => String(ent?.name || 'model').replace(/\.ifc$/i, '');

  async function mapping(kind) {
    const ent = ctx.active();
    if (!ent) return;
    const map = buildMap(indexOf(ent).ix, ctx.manifest());
    if (!map.rows.length) { ctx.status(t('interop.map.empty'), true); return; }
    const name = base(ent);
    if (kind === 'shared') ctx.download(t('interop.file.shared', { name }), await revitSharedParams(map), 'text/plain;charset=utf-8');
    else if (kind === 'psets') ctx.download(t('interop.file.psets', { name }), revitIfcPsets(map), 'text/plain;charset=utf-8');
    else if (kind === 'csv') ctx.download(t('interop.file.csv', { name }), archicadMapCsv(map, CSV_HEAD()), 'text/csv;charset=utf-8');
    else ctx.download(t('interop.file.json', { name }), JSON.stringify(await withGuids(map), null, 2), 'application/json');
    ctx.status(t('interop.map.done', { n: map.rows.length, count: num(map.rows.length) }), false, true);
  }
  const CSV_HEAD = () => ['interop.csv.pset', 'interop.csv.prop', 'interop.csv.type', 'interop.csv.acgroup', 'interop.csv.acname', 'interop.csv.revit', 'interop.csv.guid', 'interop.csv.classes', 'interop.csv.standard'].map((k) => t(k));

  function report(sentMi, backMi) {
    const list = ctx.models();
    const a = list.find((m) => m.mi === sentMi), b = list.find((m) => m.mi === backMi);
    if (!a || !b || a === b) return null;
    last = { a, b, r: roundTrip(indexOf(a), indexOf(b)) };
    render();
    const e = last.r.elements;
    ctx.status(t('interop.rt.done', { kept: num(e.kept), before: num(e.before) }), false, true);
    return last.r;
  }

  const row = (k, v) => [el('dt', {}, k), el('dd', {}, v)];
  const pct = (s) => { const p = keptShare(s); return p === null ? t('interop.rt.none') : t('interop.rt.pct', { pct: p }); };

  function reportBlock() {
    const { a, b, r } = last;
    const e = r.elements, c = r.classifications;
    const kept = { before: r.props.reduce((n, p) => n + p.before, 0), kept: r.props.reduce((n, p) => n + p.kept, 0) };
    const worst = r.props.filter((p) => p.lost || p.changed).sort((x, y) => (y.lost + y.changed) - (x.lost + x.changed)).slice(0, 12);
    return el('div', { className: 'bc-interop-report', 'data-interop-report': '' },
      el('p', { className: 'bc-muted' }, t('interop.rt.between', { a: a.name, b: b.name })),
      el('dl', { className: 'bc-dl' },
        row(t('interop.rt.elements'), t('interop.rt.elements.v', { kept: num(e.kept), before: num(e.before), lost: num(e.lost), added: num(e.added) })),
        e.classChanged ? row(t('interop.rt.classes'), num(e.classChanged)) : null,
        e.dupes ? row(t('interop.rt.dupes'), num(e.dupes)) : null,
        row(t('interop.rt.props'), pct(kept)),
        row(t('interop.rt.cls'), c.before ? t('interop.rt.cls.v', { kept: num(c.kept), before: num(c.before), changed: num(c.changed), lost: num(c.lost) }) : t('interop.rt.none'))),
      worst.length ? el('ul', { className: 'bc-bundle-list', 'data-interop-worst': '' }, worst.map((p) => el('li', {},
        el('span', {}, [p.group, p.label].filter(Boolean).join('.') || p.field),
        el('span', { className: 'bc-muted' }, t('interop.rt.prop.v', { kept: num(p.kept), changed: num(p.changed), lost: num(p.lost) }))))) : el('p', { className: 'bc-muted' }, t('interop.rt.allkept')),
      el('button', { type: 'button', className: 'btn-line btn-sm-cc', 'data-interop-csv': '', onClick: () => ctx.download(t('interop.file.rt', { name: base(a) }), roundTripCsv(r, ['interop.rt.csv.set', 'interop.rt.csv.prop', 'interop.rt.csv.before', 'interop.rt.csv.kept', 'interop.rt.csv.changed', 'interop.rt.csv.lost', 'interop.rt.csv.added'].map((k) => t(k))), 'text/csv;charset=utf-8') },
        el('i', { className: 'bi bi-download', 'aria-hidden': 'true' }), ' ', t('interop.rt.csv')));
  }

  function render() {
    if (!det.open) return;
    const list = ctx.models();
    if (last && !(list.includes(last.a) && list.includes(last.b))) last = null;
    const kids = [el('p', { className: 'bc-muted' }, t('interop.intro')),
      el('p', { className: 'bc-bundle-path' }, t('interop.map')),
      el('p', { className: 'bc-muted' }, t(ctx.manifest() ? 'interop.map.withbundle' : 'interop.map.hint')),
      el('div', { className: 'bc-find-row bc-interop-files' },
        el('button', { type: 'button', className: 'bc-linkbtn', 'data-interop-map': 'shared', title: t('interop.map.shared.title'), onClick: () => mapping('shared') }, t('interop.map.shared')),
        el('button', { type: 'button', className: 'bc-linkbtn', 'data-interop-map': 'psets', title: t('interop.map.psets.title'), onClick: () => mapping('psets') }, t('interop.map.psets')),
        el('button', { type: 'button', className: 'bc-linkbtn', 'data-interop-map': 'csv', title: t('interop.map.csv.title'), onClick: () => mapping('csv') }, t('interop.map.csv')),
        el('button', { type: 'button', className: 'bc-linkbtn', 'data-interop-map': 'json', title: t('interop.map.json.title'), onClick: () => mapping('json') }, t('interop.map.json'))),
      el('p', { className: 'bc-bundle-path' }, t('interop.rt'))];
    if (list.length < 2) kids.push(el('p', { className: 'bc-muted' }, t('interop.rt.need2')));
    else {
      const pick = (attr, sel) => el('select', { className: 'select-cc', [attr]: '', 'aria-label': t(attr === 'data-interop-sent' ? 'interop.rt.sent' : 'interop.rt.back') },
        list.map((m) => el('option', { value: String(m.mi), selected: m.mi === sel }, m.name)));
      const sent = pick('data-interop-sent', last ? last.a.mi : list[0].mi), back = pick('data-interop-back', last ? last.b.mi : list[list.length - 1].mi);
      kids.push(el('label', { className: 'bc-4d-grouplabel' }, el('span', {}, t('interop.rt.sent')), sent),
        el('label', { className: 'bc-4d-grouplabel' }, el('span', {}, t('interop.rt.back')), back),
        el('button', { type: 'button', className: 'btn-line btn-sm-cc', 'data-interop-run': '', onClick: () => { if (!report(Number(sent.value), Number(back.value))) ctx.status(t('interop.rt.same'), true); } }, t('interop.rt.run')));
      if (last) kids.push(reportBlock());
    }
    body.replaceChildren(...kids);
  }

  return { render, report, sec };
}
