/* SPDX-License-Identifier: Apache-2.0 */
/**
 * paint-ui-bim.js — BimCraft's Paint palette (0.5 RC.7, session `render`): the material library over the 3D view. While it
 * is open, a click on an element paints it (the whole element, or only the side clicked); a material clicked with
 * elements selected paints them all. Each paint is one undo step (IfcEditor.modelChange + paint-bim.js), then the model
 * reloads so the colour shows. Imported on first use by bimcraft.js ("Paint").
 *
 *   mountPaint({ root, viewer(), target(key) → {editor, id, C, P} | null, selection() → keys, nameOfKey(key),
 *                rebuild(key) → Promise, afterEdit(), status(text, isError), beforeOpen() }) → { open(), close(), isOpen() }
 */
import { t } from "./i18n.js";
import { MATERIALS, CATEGORIES, material } from './render/materials.js';
import { swatchPixels } from './render/three-mats.js';
import { paintOp, viewerToFileDir, faceAxis } from './paint-bim.js';

const CSS = `
.bc-paint { position: absolute; right: .75rem; bottom: .75rem; z-index: 30; width: min(19rem, calc(100% - 1.5rem)); max-height: calc(100% - 1.5rem);
  display: flex; flex-direction: column; color: var(--ink); background: var(--sheet-2); border: var(--pen-2, 1.5px) solid var(--ink); border-radius: var(--radius, 2px); }
.bc-paint-head { display: flex; align-items: center; gap: .5rem; padding: .45rem .6rem; border-bottom: var(--pen-1, 1px) solid var(--line); }
.bc-paint-head h2 { margin: 0; flex: 1; font-size: var(--fs-base, 1rem); }
.bc-paint-body { overflow: auto; padding: .5rem .6rem; display: grid; gap: .45rem; font-size: var(--fs-sm, .875rem); }
.bc-paint-cat { margin: .2rem 0 0; color: var(--ink-2); }
.bc-paint-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(1.9rem, 1fr)); gap: .3rem; }
.bc-paint-sw { aspect-ratio: 1; width: 100%; padding: 0; border: var(--pen-1, 1px) solid var(--line); border-radius: var(--radius, 2px); background-size: cover; background-position: center; cursor: pointer; }
.bc-paint-sw[aria-checked="true"] { outline: var(--pen-3, 2px) solid var(--action); outline-offset: 2px; }
.bc-paint-sw.is-off { background: repeating-linear-gradient(45deg, var(--sheet), var(--sheet) 4px, var(--line) 4px, var(--line) 5px); }
.bc-paint-how { display: flex; flex-wrap: wrap; gap: .3rem .9rem; }
.bc-paint-how label { display: flex; gap: .35rem; align-items: center; }
.bc-paint-note { margin: 0; color: var(--ink-2); }
`;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'className') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

export function mountPaint(o) {
  if (!document.getElementById('bc-paint-css')) { const s = el('style', { id: 'bc-paint-css' }); s.textContent = CSS; document.head.append(s); }
  let panel = null, current = 'brick-red', busy = false;
  const swatches = [];
  const mark = () => { for (const s of swatches) s.el.setAttribute('aria-checked', String(s.id === current)); };
  const nameOf = (id) => (id ? t('render.mat.' + id) : t('paint.off'));

  async function paint(keys, axis, why) {
    if (busy || !keys.length) return;
    const tg = keys.map((k) => o.target(k));
    if (tg.some((x) => !x)) { o.status(t('paint.other'), true); return; }
    const ed = tg[0].editor;
    if (tg.some((x) => x.editor !== ed)) { o.status(t('paint.other'), true); return; }
    busy = true;
    try {
      const mat = current;
      ed.modelChange(paintOp({ ids: tg.map((x) => x.id), mat, axis }), { label: nameOf(mat), verb: t('paint.verb') });
      o.afterEdit();
      const what = keys.length === 1 ? o.nameOfKey(keys[0]) : t('paint.n', { n: keys.length });
      await o.rebuild(keys.length === 1 ? keys[0] : null);
      o.status(!mat ? t('paint.done.off', { what }) : axis ? t('paint.done.side', { what, mat: nameOf(mat) }) : t('paint.done', { what, mat: nameOf(mat) }), false, true);
      void why;
    } catch (e) { console.error(e); o.status(t('paint.failed', { why: e.message || e }), true); } finally { busy = false; }
  }

  function pickAndPaint(x, y) {
    const v = o.viewer(), hit = v?.measureAt(x, y);
    if (!hit || hit.key === undefined || hit.key === null) { o.status(t('paint.none')); return; }
    let axis = null;
    if (panel.querySelector('[data-paint-how="side"]').checked && hit.face?.normal) {
      const tg = o.target(hit.key);
      if (!tg) { o.status(t('paint.other'), true); return; }
      axis = faceAxis(tg.editor.api, tg.editor.mid, tg.id, viewerToFileDir(hit.face.normal, tg.C, tg.P));
    }
    paint([hit.key], axis, 'click');
  }

  function build() {
    const body = el('div', { className: 'bc-paint-body' });
    const how = el('div', { className: 'bc-paint-how', role: 'radiogroup', 'aria-label': t('paint.how') },
      el('label', {}, el('input', { type: 'radio', name: 'bc-paint-how', checked: true, dataset: { paintHow: 'whole' } }), t('paint.whole')),
      el('label', {}, el('input', { type: 'radio', name: 'bc-paint-how', dataset: { paintHow: 'side' } }), t('paint.side')));
    body.append(el('p', { className: 'bc-paint-note' }, t('paint.hint')), how);
    const sw = (id) => {
      const b = el('button', { type: 'button', role: 'radio', className: 'bc-paint-sw' + (id ? '' : ' is-off'), title: nameOf(id), 'aria-label': nameOf(id), 'aria-checked': 'false', dataset: { paintMat: id || 'none' } });
      if (id) b.style.background = material(id).color;
      b.addEventListener('click', () => {
        current = id; mark();
        const sel = o.selection();
        if (sel.length) paint(sel, null, 'selection');
        else o.status(t('paint.pick', { mat: nameOf(id) }));
      });
      swatches.push({ el: b, id });
      return b;
    };
    body.append(el('div', { className: 'bc-paint-row' }, sw(null)));
    const todo = [];
    for (const cat of CATEGORIES) {
      const list = MATERIALS.filter((m) => m.cat === cat);
      body.append(el('p', { className: 'bc-paint-cat' }, t('render.matcat.' + cat)), el('div', { className: 'bc-paint-row' }, list.map((m) => { const b = sw(m.id); if (m.tex) todo.push([b, m.id]); return b; })));
    }
    const close = el('button', { type: 'button', className: 'btn-line btn-sm-cc', dataset: { paintClose: '' } }, t('paint.close'));
    close.addEventListener('click', () => api.close());
    const p = el('section', { className: 'bc-paint', role: 'dialog', 'aria-labelledby': 'bc-paint-h', dataset: { paintPanel: '' } },
      el('div', { className: 'bc-paint-head' }, el('h2', { id: 'bc-paint-h' }, t('paint.h')), close), body);
    p.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close(); } });
    // the swatches' textures, drawn a few at a time when the page is idle
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 30));
    const draw = (dl) => {
      while (todo.length && (!dl || dl.timeRemaining() > 4)) {
        const [b, id] = todo.shift(), px = swatchPixels(id, 40);
        const c = document.createElement('canvas'); c.width = px.w; c.height = px.h;
        c.getContext('2d').putImageData(new ImageData(px.data, px.w, px.h), 0, 0);
        b.style.backgroundImage = 'url(' + c.toDataURL() + ')';
      }
      if (todo.length) idle(draw);
    };
    idle(draw);
    return p;
  }

  const onKey = (e) => { if (e.key === 'Escape' && panel && !e.defaultPrevented && !document.querySelector('dialog[open]')) { e.preventDefault(); api.close(); } };
  const api = {
    isOpen: () => !!panel,
    open() {
      if (panel) { panel.querySelector('.bc-paint-sw[aria-checked="true"]')?.focus(); return; }
      o.beforeOpen?.();
      panel = build();
      (o.parent || o.root).append(panel);
      mark();
      const v = o.viewer();
      if (v) v.measuring = { move: () => {}, click: (x, y) => pickAndPaint(x, y), paint: true };
      document.addEventListener('keydown', onKey);
      o.status(t('paint.pick', { mat: nameOf(current) }));
      panel.querySelector('.bc-paint-sw[aria-checked="true"]')?.focus();
    },
    close() {
      if (!panel) return;
      panel.remove(); panel = null;
      const v = o.viewer();
      if (v && v.measuring?.paint) v.measuring = null;
      document.removeEventListener('keydown', onKey);
      o.onClose?.();
    },
  };
  return api;
}
