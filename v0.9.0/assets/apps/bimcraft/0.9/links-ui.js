/* SPDX-License-Identifier: Apache-2.0 */
/**
 * links-ui.js — linked models on screen (0.6 DF.21, session `bim-draw`): the Links section `[data-links-sec]` of the left
 * panel, loading and placing each link (another IFC shown by reference beside the model you edit, through bimcraft.js's
 * federation entries flagged `link`), reloading it when its file changes, unloading it, and its cut on the plan for the Draw
 * tools to snap to. The links themselves (document references + placements) are model-links.js, written into the model
 * you edit (one undo step each).
 *
 *   const L = mountLinks(modelUi, { root, fed, fileHost, status })
 *     fed = { add(file, { link }) → entry | null, remove(entry), models(), host(), setMatrix(entry, M), viewer(), refresh() }
 *   L.modelChanged()   the model you edit was opened or reloaded: its links read again (and loaded ones kept)
 * Per link row `[data-link=<id>]`: `[data-link-load]` (Load… / Reload), `[data-link-unload]`, `[data-link-place]` (file | map |
 * points), `[data-link-remove]`; `[data-link-add]` links another model. Test hook: window.bimcraftLinks = { state, api }.
 */
import { readLinks, addLink, changeLink, removeLink, mapMatrix, pairsMatrix, I4 } from './model-links.js';
import { readGeoref } from './ifc-geo.js';
import { lengthUnitMm, mul4, inv4, apply4 } from './ifc-util.js';
import { viewerToPlan, planCut } from './model-plan.js';
import { ModelWriter } from './model-write.js';
import { el } from './ui-util.js';

const POLL_MS = 4000;
const YUP = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1], S = (k) => [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1];

export function mountLinks(modelUi, o) {
  const R = { links: [], loaded: new Map(), picking: null, cut: null, cutKey: '' };   // loaded: id → { ent, hf, stamp, changed }
  let A = null, timer = 0;
  const t = (...a) => A.t(...a);
  const sec = o.root.querySelector('[data-links-sec]');
  const host = () => o.fed.host();
  const W = () => { const h = host(); return h ? new ModelWriter(h.editor.W, h.ifc.api, h.model.modelID) : null; };
  /** The model's file mm → the scene. */
  function F() {
    const h = host(), v = o.fed.viewer();
    const C = [...h.ifc.api.GetCoordinationMatrix(h.model.modelID)];
    return mul4(v.modelMatrix(h.mi), mul4(C, mul4(YUP, S(0.001))));   // mm in (Z up), the scene's metres out (Y up)
  }
  function read() {
    const w = W();
    R.links = w ? readLinks(w) : [];
    for (const id of [...R.loaded.keys()]) if (!R.links.some((l) => l.id === id) || !o.fed.models().includes(R.loaded.get(id).ent)) { stopOne(id); }
    render();
  }
  function stopOne(id) {
    const L = R.loaded.get(id);
    if (!L) return;
    if (o.fed.models().includes(L.ent)) o.fed.remove(L.ent);
    R.loaded.delete(id);
  }
  /** Where the link goes in the scene: its own viewer coordinates → its file mm → the model's file mm (m) → the scene. Made
   *  from the current coordination matrices of both (a model's changes after a reload; see bimcraft.js placementOf). */
  function place(id) {
    const L = R.loaded.get(id), link = R.links.find((x) => x.id === id);
    if (!L || !link) return;
    const Cl = [...L.ent.ifc.api.GetCoordinationMatrix(L.ent.model.modelID)];
    o.fed.setMatrix(L.ent, mul4(F(), mul4(link.m, inv4(mul4(Cl, mul4(YUP, S(0.001)))))));
    R.cutKey = '';
    if (A.S.on) A.refresh();   // the plan cuts the link again
  }
  async function load(link) {
    let hf;
    try { [hf] = await o.fileHost.openFile({ types: [{ description: 'IFC', extensions: ['.ifc'] }] }); } catch (e) { hf = null; }   // i18n-ignore: OS file type
    if (!hf) return;
    const file = await hf.file();
    stopOne(link.id);
    const ent = await o.fed.add(new File([file], hf.name, { lastModified: hf.lastModified || Date.now() }), { link: { id: link.id } });
    if (!ent) return;
    R.loaded.set(link.id, { ent, hf, stamp: hf.lastModified || file.lastModified || 0, changed: false });
    if (hf.name !== link.location) A.commit(changeLink(link.id, { location: hf.name }), { label: link.name, verb: t('model.verb.changed') });
    place(link.id);
    poll();
    render();
  }
  async function reload(id) {
    const L = R.loaded.get(id), link = R.links.find((x) => x.id === id);
    if (!L || !link) return;
    let file;
    try { file = await L.hf.file(); } catch (e) { file = null; }
    if (L.hf.handle && typeof L.hf.handle.getFile === 'function') { try { file = await L.hf.handle.getFile(); } catch (e) { /* the handle went: ask */ } }
    if (!file) { load(link); return; }
    stopOne(id);
    const ent = await o.fed.add(new File([file], L.hf.name, { lastModified: file.lastModified }), { link: { id } });
    if (!ent) return;
    R.loaded.set(id, { ent, hf: L.hf, stamp: file.lastModified || 0, changed: false });
    place(id);
    o.status(t('link.reloaded', { file: L.hf.name }), false, true);
    render();
  }
  /** Files changed on disk (a browser file handle, or the desktop's file): reloaded by themselves. */
  function poll() {
    if (timer) return;
    timer = setInterval(async () => {
      if (!R.loaded.size) { clearInterval(timer); timer = 0; return; }
      for (const [id, L] of R.loaded) {
        if (!L.hf.handle || typeof L.hf.handle.getFile !== 'function') continue;
        let f = null;
        try { f = await L.hf.handle.getFile(); } catch (e) { f = null; }
        if (f && f.lastModified > L.stamp) await reload(id);
      }
    }, POLL_MS);
  }
  async function setMode(link, mode) {
    if (mode === 'points') { startPoints(link); return; }
    let m = I4.slice();
    if (mode === 'map') {
      const L = R.loaded.get(link.id), h = host();
      if (!L) { o.status(t('link.load.first'), true); return; }
      m = mapMatrix(readGeoref(h.ifc.api, h.model.modelID), readGeoref(L.ent.ifc.api, L.ent.model.modelID), lengthUnitMm(h.ifc.api, h.model.modelID), lengthUnitMm(L.ent.ifc.api, L.ent.model.modelID));
      if (!m) { o.status(t('link.nomap'), true); render(); return; }
    }
    A.commit(changeLink(link.id, { mode, m }), { label: link.name, verb: t('model.verb.moved') });
  }
  /** Two pairs of points picked in the 3D view: a point of the link, then where it goes in the model; twice. */
  function startPoints(link) {
    const L = R.loaded.get(link.id), v = o.fed.viewer();
    if (!L || !v) { o.status(t('link.load.first'), true); return; }
    R.picking = { link, pairs: [], half: null };
    const step = () => o.status(t(R.picking.half ? 'link.pts.host' : R.picking.pairs.length ? 'link.pts.link2' : 'link.pts.link1'));
    step();
    v.measuring = {
      move: () => {},
      click: (x, y) => {
        const h = v.measureAt ? v.measureAt(x, y) : v.hitAt(x, y);
        const pt = h?.point, key = h?.key ?? h?.id ?? null;
        if (!pt) return;
        const Fi = inv4(F()), fileMm = apply4(Fi, pt[0], pt[1], pt[2]);
        const P = R.picking;
        if (!P.half) {
          const linkM = R.links.find((x) => x.id === P.link.id).m;   // the link's own coordinates of that point
          P.half = apply4(inv4(linkM), fileMm[0], fileMm[1], fileMm[2]);
        } else { P.pairs.push([P.half, fileMm]); P.half = null; }
        void key;
        if (P.pairs.length === 2) {
          v.measuring = null;
          const m = pairsMatrix(P.pairs);
          R.picking = null;
          A.commit(changeLink(P.link.id, { mode: 'points', m }), { label: P.link.name, verb: t('model.verb.moved') });
          o.status(t('link.pts.done', { file: P.link.name }), false, true);
          return;
        }
        step();
      },
    };
  }

  function render() {
    if (!sec) return;
    sec.hidden = !host();
    const list = sec.querySelector('[data-links]');
    if (!list) return;
    list.replaceChildren(...R.links.map((link) => {
      const L = R.loaded.get(link.id);
      const state = L ? t('link.state.loaded') : t('link.state.unloaded');
      const mode = el('select', { className: 'select-cc', 'data-link-place': link.id, 'aria-label': t('link.place') },
        ...['file', 'map', 'points'].map((m) => el('option', { value: m, selected: m === link.mode }, t('link.mode.' + m))));
      mode.addEventListener('change', () => setMode(link, mode.value));
      return el('li', { className: 'bc-link', 'data-link': link.id },
        el('div', { className: 'bc-model-row' }, el('span', { className: 'bc-model-name', title: link.location }, link.name), el('span', { className: 'bc-sub', 'data-link-state': '' }, state)),
        el('div', { className: 'bc-link-actions' },
          el('button', { type: 'button', className: 'btn-line btn-sm-cc', 'data-link-load': link.id, onClick: () => (L ? reload(link.id) : load(link)) }, t(L ? 'link.reload' : 'link.load')),
          L ? el('button', { type: 'button', className: 'btn-line btn-sm-cc', 'data-link-unload': link.id, onClick: () => { stopOne(link.id); render(); o.fed.refresh(); } }, t('link.unload')) : null,
          el('label', {}, el('span', { className: 'visually-hidden' }, t('link.place')), mode),
          el('button', { type: 'button', className: 'bc-forget', title: t('link.remove', { file: link.name }), 'aria-label': t('link.remove', { file: link.name }), 'data-link-remove': link.id,
            onClick: () => { stopOne(link.id); A.commit(removeLink(link.id), { label: link.name, verb: t('model.verb.deleted') }); } }, el('i', { className: 'bi bi-x', 'aria-hidden': 'true' }))));
    }));
  }
  /** Link another model: written into the model, then loaded. */
  async function addNew() {
    let hf;
    try { [hf] = await o.fileHost.openFile({ types: [{ description: 'IFC', extensions: ['.ifc'] }] }); } catch (e) { hf = null; }   // i18n-ignore: OS file type
    if (!hf) return;
    R.pendingFile = hf;
    A.commit(addLink({ name: hf.name, location: hf.path || hf.name, mode: 'file' }), { label: hf.name, verb: t('model.verb.added') });
  }

  // the plan: each loaded link cut at the level's cut height (thin lines), and snapped to
  function linkCut() {
    if (!A.S.on || !R.loaded.size) return null;
    const h = host(), v = o.fed.viewer(), ed = A.ed();
    if (!h || !v || !ed) return null;
    const w = ed.placer(), st = w.api.GetLine(w.mid, A.S.level, false);
    const Mw = st?.ObjectPlacement ? w.api.GetWorldTransformMatrix(w.mid, st.ObjectPlacement.value) : I4;
    const SW = Mw.slice(); SW[12] *= w.unitMm; SW[13] *= w.unitMm; SW[14] *= w.unitMm;
    const toPlan = mul4(viewerToPlan([...h.ifc.api.GetCoordinationMatrix(h.model.modelID)], SW), inv4(v.modelMatrix(h.mi)));
    const key = A.S.level + ':' + [...R.loaded.values()].map((L) => L.ent.mi + ':' + v.modelMatrix(L.ent.mi).map((x) => Math.round(x * 1e6)).join(',')).join('|');
    if (key === R.cutKey) return R.cut;
    const segs = [];
    for (const L of R.loaded.values()) {
      if (L.ent.visible === false) continue;
      const M = mul4(toPlan, v.modelMatrix(L.ent.mi));
      const storeys = new Set(L.ent.model.batches.map((b) => b.storey));
      for (const sid of storeys) {
        const c = planCut(L.ent.model, { M, storey: sid, cutZ: 1200, edges: false });
        for (const s of c.cut.values()) segs.push(...s);
      }
    }
    R.cutKey = key; R.cut = segs;
    return segs;
  }

  A = modelUi.extend({
    refresh() { read(); },
    scene(sc) { const segs = linkCut(); if (segs?.length) sc.below.push({ key: -2, segs }); },
    snapCtx(ctx) {
      const segs = linkCut();
      if (!segs?.length) return;
      const lines = [], pts = [];
      for (let i = 0; i + 3 < segs.length; i += 4) { lines.push({ a: [segs[i], segs[i + 1]], b: [segs[i + 2], segs[i + 3]] }); pts.push([segs[i], segs[i + 1]], [segs[i + 2], segs[i + 3]]); }
      ctx.lines = [...(ctx.lines || []), ...lines];
      ctx.points = [...(ctx.points || []), ...pts];
    },
  });
  sec?.querySelector('[data-link-add]')?.addEventListener('click', () => addNew());
  const api = {
    modelChanged() {
      read();
      // a link just added: load the file that was chosen for it
      if (R.pendingFile) {
        const hf = R.pendingFile; R.pendingFile = null;
        const link = R.links.find((l) => l.location === (hf.path || hf.name) && !R.loaded.has(l.id));
        if (link) (async () => {
          const file = await hf.file();
          const ent = await o.fed.add(new File([file], hf.name, { lastModified: hf.lastModified || Date.now() }), { link: { id: link.id } });
          if (!ent) return;
          R.loaded.set(link.id, { ent, hf, stamp: hf.lastModified || file.lastModified || 0, changed: false });
          place(link.id); poll(); render();
        })();
      }
      for (const id of R.loaded.keys()) place(id);   // a moved link (its placement changed): placed again
    },
    loaded: () => [...R.loaded.keys()],
  };
  if (typeof window !== 'undefined') window.bimcraftLinks = { state: R, api };   // for tests
  return api;
}
