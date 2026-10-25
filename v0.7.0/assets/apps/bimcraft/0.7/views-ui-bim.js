/* SPDX-License-Identifier: Apache-2.0 */
/**
 * views-ui-bim.js — BimCraft's Views panel (0.5 RC.7, session `render`): save the 3D view's camera by name, go back to it,
 * play the views in order, and record a walkthrough while walking and play it back. Kept in the IFC (views-bim.js); each
 * save, rename, reorder or delete is one undo step. Imported on first use by bimcraft.js ("Views").
 *
 *   mountViews({ root, parent, viewer(), editor(), frameC(), stopWalk(), status(text, isError, fade), afterEdit() })
 *     → { open(), close(), isOpen(), refresh() }
 */
import { t } from "./i18n.js";
import { readViews, writeViewsOp, cleanName, viewAt, ease, MAX_WALK } from './views-bim.js';
import { toIfcPoint, toIfcDir, fromIfcPoint, fromIfcDir } from './bcf.js';

const CSS = `
.bc-views { position: absolute; left: .75rem; bottom: .75rem; z-index: 30; width: min(19rem, calc(100% - 1.5rem)); max-height: 70%;
  display: flex; flex-direction: column; color: var(--ink); background: var(--sheet-2); border: var(--pen-2, 1.5px) solid var(--ink); border-radius: var(--radius, 2px); }
.bc-views-head { display: flex; align-items: center; gap: .5rem; padding: .45rem .6rem; border-bottom: var(--pen-1, 1px) solid var(--line); }
.bc-views-head h2 { margin: 0; flex: 1; font-size: var(--fs-base, 1rem); }
.bc-views-body { overflow: auto; padding: .5rem .6rem; display: grid; gap: .5rem; font-size: var(--fs-sm, .875rem); }
.bc-views-save { display: flex; gap: .4rem; }
.bc-views-save input { flex: 1; min-width: 0; }
.bc-views ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .25rem; }
.bc-views li { display: flex; gap: .25rem; align-items: center; }
.bc-views li > .bc-views-go { flex: 1; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bc-views h3 { margin: .25rem 0 0; font-size: var(--fs-sm, .875rem); }
.bc-views-note { margin: 0; color: var(--ink-2); }
.bc-views .bc-ic { padding: .1rem .35rem; }
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
const icon = (cls) => el('i', { className: 'bi ' + cls, 'aria-hidden': 'true' });
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;   // i18n-ignore: a media query

export function mountViews(o) {
  if (!document.getElementById('bc-views-css')) { const s = el('style', { id: 'bc-views-css' }); s.textContent = CSS; document.head.append(s); }
  let panel = null, playing = null, recording = null;
  const state = () => { const ed = o.editor(); return ed ? readViews(ed.api, ed.mid) : { views: [], walks: [] }; };
  function save(next, label) {
    const ed = o.editor();
    if (!ed) return false;
    ed.modelChange(writeViewsOp(next), { label, verb: t('views.verb') });
    o.afterEdit();
    return true;
  }

  // ---- the camera ----
  function capture() {
    const v = o.viewer(), C = o.frameC(), cam = v.camera;
    let pos, dir;
    if (v.walk) { pos = v.walk.pos.toArray(); dir = v.walkForward(true).toArray(); }
    else { pos = cam.position.toArray(); const d = v.controls.target.clone().sub(cam.position); dir = d.lengthSq() > 1e-12 ? d.normalize().toArray() : [0, 0, -1]; }
    return { pos: toIfcPoint(C, pos), dir: toIfcDir(C, dir), fov: cam.fov };
  }
  function place(pos, dir, along, fov) {
    const v = o.viewer(), cam = v.camera;
    cam.position.set(pos[0], pos[1], pos[2]);
    if (fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
    v.controls.target.set(pos[0] + dir[0] * along, pos[1] + dir[1] * along, pos[2] + dir[2] * along);
    v.controls.update();
    v.render();
  }
  function stopPlaying() { if (playing) { playing.stop = true; playing = null; renderPanel(); } }
  /** Go to a saved view, moving there smoothly (ms 0 = at once). → a promise when there. */
  function goTo(view, ms = 900) {
    const v = o.viewer(), C = o.frameC();
    if (v.walk) o.stopWalk();
    const pos = fromIfcPoint(C, view.pos), dir = fromIfcDir(C, view.dir);
    const c = v.box.isEmpty() ? pos : v.box.getCenter(v.camera.position.clone()).toArray();
    const along = Math.max(1, (c[0] - pos[0]) * dir[0] + (c[1] - pos[1]) * dir[1] + (c[2] - pos[2]) * dir[2]);
    const p0 = v.camera.position.toArray(), t0 = v.controls.target.toArray(), f0 = v.camera.fov;
    const t1 = pos.map((x, k) => x + dir[k] * along);
    if (!ms || reduced()) { place(pos, dir, along, view.fov); return Promise.resolve(true); }
    const run = playing || { stop: false };
    return new Promise((res) => {
      const start = performance.now();
      const step = (now) => {
        if (run.stop) { res(false); return; }
        const f = ease(Math.min(1, (now - start) / ms));
        const P = p0.map((x, k) => x + (pos[k] - x) * f), T = t0.map((x, k) => x + (t1[k] - x) * f);
        v.camera.position.set(...P); v.camera.fov = f0 + (view.fov - f0) * f; v.camera.updateProjectionMatrix();
        v.controls.target.set(...T); v.controls.update(); v.render();
        if (f < 1) requestAnimationFrame(step); else res(true);
      };
      requestAnimationFrame(step);
    });
  }
  async function playViews() {
    const { views } = state();
    if (views.length < 2) { o.status(t('views.tour.few'), true); return; }
    playing = { stop: false };
    renderPanel();
    o.status(t('views.tour.playing'));
    for (const vw of views) {
      if (!playing || playing.stop) break;
      if (!(await goTo(vw, 1200))) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (playing) { playing = null; renderPanel(); o.status(t('views.tour.done'), false, true); }
  }
  function playWalk(walk) {
    const v = o.viewer(), C = o.frameC();
    if (v.walk) o.stopWalk();
    playing = { stop: false };
    renderPanel();
    v.controls.enabled = false;
    const start = performance.now(), end = walk.pts[walk.pts.length - 1].t;
    o.status(t('views.walk.playing', { name: walk.name }));
    const step = (now) => {
      const s = (now - start) / 1000;
      const at = viewAt(walk, s), pos = fromIfcPoint(C, at.pos), dir = fromIfcDir(C, at.dir);
      v.camera.position.set(...pos); v.camera.lookAt(pos[0] + dir[0], pos[1] + dir[1], pos[2] + dir[2]); v.render();
      if (playing && !playing.stop && s < end) { requestAnimationFrame(step); return; }
      v.controls.enabled = true;
      v.controls.target.set(pos[0] + dir[0] * 3, pos[1] + dir[1] * 3, pos[2] + dir[2] * 3); v.controls.update(); v.render();
      if (playing) { playing = null; renderPanel(); o.status(t('views.walk.done'), false, true); }
    };
    requestAnimationFrame(step);
  }
  function toggleRecord() {
    const v = o.viewer();
    if (recording) {
      clearInterval(recording.timer);
      const pts = recording.pts; recording = null;
      if (pts.length < 2) { o.status(t('views.walk.short'), true); renderPanel(); return; }
      const s = state(), name = t('views.walk.default', { n: s.walks.length + 1 });
      if (save({ views: s.views, walks: [...s.walks, { name, pts }] }, name)) o.status(t('views.walk.saved', { name, s: Math.round(pts[pts.length - 1].t) }), false, true);
      renderPanel();
      return;
    }
    if (!v.walk) { o.status(t('views.walk.first'), true); return; }
    const C = o.frameC(), t0 = performance.now();
    recording = { pts: [] };
    const sample = () => {
      if (!recording) return;
      if (!v.walk || recording.pts.length >= MAX_WALK) { toggleRecord(); return; }
      recording.pts.push({ t: (performance.now() - t0) / 1000, pos: toIfcPoint(C, v.walk.pos.toArray()), dir: toIfcDir(C, v.walkForward(true).toArray()) });
    };
    sample();
    recording.timer = setInterval(sample, 250);
    o.status(t('views.walk.recording'));
    renderPanel();
  }

  // ---- the panel ----
  function renderPanel() {
    if (!panel) return;
    const body = panel.querySelector('.bc-views-body');
    const { views, walks } = state();
    const nameIn = el('input', { type: 'text', className: 'bc-input', maxlength: '80', value: t('views.default', { n: views.length + 1 }), 'aria-label': t('views.name'), dataset: { viewName: '' } });
    const saveBtn = el('button', { type: 'button', className: 'btn-plot btn-sm-cc', dataset: { viewSave: '' } }, t('views.save'));
    const doSave = () => {
      const s = state(), name = cleanName(nameIn.value) || t('views.default', { n: s.views.length + 1 });
      const at = s.views.findIndex((x) => x.name === name), cam = { name, ...capture() };
      const list = s.views.slice(); if (at >= 0) list[at] = cam; else list.push(cam);
      if (save({ views: list, walks: s.walks }, name)) o.status(t(at >= 0 ? 'views.updated' : 'views.saved', { name }), false, true);
      renderPanel();
    };
    saveBtn.addEventListener('click', doSave);
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
    const move = (i, d) => { const s = state(), l = s.views.slice(), j = i + d; if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; save({ views: l, walks: s.walks }, l[j].name); renderPanel(); };
    const rename = (i) => {
      const li = body.querySelectorAll('[data-view-row]')[i], s = state(), inp = el('input', { type: 'text', className: 'bc-input', maxlength: '80', value: s.views[i].name, 'aria-label': t('views.name') });
      const done = (keep) => { const nm = cleanName(inp.value); if (keep && nm && nm !== s.views[i].name) { const l = s.views.slice(); l[i] = { ...l[i], name: nm }; save({ views: l, walks: s.walks }, nm); } renderPanel(); };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } });
      inp.addEventListener('blur', () => done(true));
      li.replaceChildren(inp); inp.focus(); inp.select();
    };
    const del = (i) => { const s = state(), l = s.views.slice(), [gone] = l.splice(i, 1); if (save({ views: l, walks: s.walks }, gone.name)) o.status(t('views.deleted', { name: gone.name }), false, true); renderPanel(); };
    const delWalk = (i) => { const s = state(), l = s.walks.slice(), [gone] = l.splice(i, 1); save({ views: s.views, walks: l }, gone.name); renderPanel(); };
    const ic = (cls, label, fn, data) => { const b = el('button', { type: 'button', className: 'btn-line btn-sm-cc bc-ic', title: label, 'aria-label': label, dataset: data || {} }, icon(cls)); b.addEventListener('click', fn); return b; };
    const list = el('ul', { dataset: { viewList: '' } }, views.map((vw, i) => {
      const go = el('button', { type: 'button', className: 'btn-line btn-sm-cc bc-views-go', dataset: { viewGo: String(i) } }, vw.name);
      go.addEventListener('click', () => { stopPlaying(); goTo(vw); o.status(t('views.shown', { name: vw.name }), false, true); });
      return el('li', { dataset: { viewRow: String(i) } }, go,
        ic('bi-arrow-up', t('views.up'), () => move(i, -1)), ic('bi-arrow-down', t('views.down'), () => move(i, 1)),
        ic('bi-pencil', t('views.rename'), () => rename(i)), ic('bi-trash', t('views.delete'), () => del(i), { viewDelete: String(i) }));
    }));
    const tour = el('button', { type: 'button', className: 'btn-line btn-sm-cc', dataset: { viewTour: '' }, disabled: views.length < 2 && !playing }, playing ? t('views.stop') : t('views.tour'));
    tour.addEventListener('click', () => { if (playing) stopPlaying(); else playViews(); });
    const rec = el('button', { type: 'button', className: (recording ? 'btn-plot' : 'btn-line') + ' btn-sm-cc', dataset: { walkRecord: '' }, 'aria-pressed': String(!!recording) }, recording ? t('views.walk.stop') : t('views.walk.record'));
    rec.addEventListener('click', toggleRecord);
    const wl = el('ul', { dataset: { walkList: '' } }, walks.map((w, i) => {
      const play = el('button', { type: 'button', className: 'btn-line btn-sm-cc bc-views-go', dataset: { walkPlay: String(i) } }, t('views.walk.item', { name: w.name, s: Math.round(w.pts[w.pts.length - 1].t) }));
      play.addEventListener('click', () => { stopPlaying(); playWalk(w); });
      return el('li', {}, play, ic('bi-trash', t('views.delete'), () => delWalk(i)));
    }));
    body.replaceChildren(
      el('div', { className: 'bc-views-save' }, nameIn, saveBtn),
      views.length ? list : el('p', { className: 'bc-views-note' }, t('views.none')),
      el('div', {}, tour),
      el('h3', {}, t('views.walk.h')),
      el('p', { className: 'bc-views-note' }, t('views.walk.hint')),
      el('div', {}, rec),
      walks.length ? wl : null);
  }

  const onKey = (e) => { if (e.key === 'Escape' && playing) { e.preventDefault(); stopPlaying(); } };
  const api = {
    isOpen: () => !!panel,
    refresh: () => renderPanel(),
    open() {
      if (panel) return;
      const close = el('button', { type: 'button', className: 'btn-line btn-sm-cc', dataset: { viewsClose: '' } }, t('paint.close'));
      close.addEventListener('click', () => api.close());
      panel = el('section', { className: 'bc-views', role: 'dialog', 'aria-labelledby': 'bc-views-h', dataset: { viewsPanel: '' } },
        el('div', { className: 'bc-views-head' }, el('h2', { id: 'bc-views-h' }, t('views.h')), close), el('div', { className: 'bc-views-body' }));
      (o.parent || o.root).append(panel);
      renderPanel();
      document.addEventListener('keydown', onKey, true);
      panel.querySelector('[data-view-name]')?.focus();
    },
    close() {
      if (!panel) return;
      stopPlaying();
      if (recording) toggleRecord();
      panel.remove(); panel = null;
      document.removeEventListener('keydown', onKey, true);
      o.onClose?.();
    },
  };
  return api;
}
