/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cloud-slice-ui.js — drawing on a point cloud in the plan (0.6 DF.22, session `bim-draw`), through model-ui.js `extend()`:
 * while a cloud is open (cloud-ui.js, session `pointcloud`) and Draw is on, the plan shows the cloud's slice at the level's cut
 * height (1200 above the level, `thick` deep) as dots, and every Draw tool snaps to its points (snap kind 'cloud'). The model
 * bar's Scan menu `[data-scan-tools]` (shown with a cloud): Show the slice `[data-scan-slice]`, its thickness `[data-scan-thick]`,
 * Align its floor to this level `[data-scan-floor]`, Turn it square to the building `[data-scan-square]`, Reset the alignment
 * `[data-scan-reset]`. Aligning changes where the cloud sits in the scene (cloud-ui.js `pc.adjust`), not the IFC; it lasts while
 * the cloud is open. The maths is cloud-slice.js.
 *
 *   const s = mountCloudSlice(modelUi, { cloud: () => pc | null, viewer: () => viewer, entry: () => { C, P } | null })
 *   s.changed()      the cloud was opened, placed or removed: cut it again
 * Test hook: window.bimcraftScan = { state, api: s }.
 */
import { planMatrix, slicePoints, SliceGrid, squareAngle, floorZ, planAdjust, rotZ, moveZ } from './cloud-slice.js';
import { mul4 } from './ifc-util.js';
import { fmtLen, parseLen } from './model-units.js';

const CUT = 1200;

export function mountCloudSlice(modelUi, o) {
  let show = true, thick = 100;
  try { const v = JSON.parse(localStorage.getItem('bimcraft.scan') || '{}'); if (v.show === false) show = false; if (v.thick >= 10 && v.thick <= 2000) thick = v.thick; } catch (e) { /* defaults */ }
  const R = { key: '', slice: null, grid: null, note: '' };
  let A = null;
  const t = (...a) => A.t(...a);
  const save = () => { try { localStorage.setItem('bimcraft.scan', JSON.stringify({ show, thick })); } catch (e) { /* this tab */ } };
  const layerOf = () => { const pc = o.cloud(); const L = pc?.has?.() ? pc.layer?.() : null; return L?.cloud && L.points ? L : null; };
  const storeyMm = () => { const ed = A.ed(); if (!ed || !A.S.level) return null; try { return storeyWorld(ed); } catch (e) { return null; } };
  function storeyWorld(ed) {
    const w = ed.placer(), st = w.api.GetLine(w.mid, A.S.level, false);
    const M = st?.ObjectPlacement ? w.api.GetWorldTransformMatrix(w.mid, st.ObjectPlacement.value) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const s = M.slice(); s[12] *= w.unitMm; s[13] *= w.unitMm; s[14] *= w.unitMm;
    return s;
  }
  /** cloud positions → plan, and scene → plan (for an adjustment), for the shown level. */
  function matrices() {
    const L = layerOf(), ent = o.entry(), SW = storeyMm();
    if (!L || !ent || !SW) return null;
    L.points.updateMatrixWorld(true);
    const lm = [...L.points.matrixWorld.elements];   // what the view draws: the cloud's positions → the scene
    return { M: planMatrix(lm, ent.P, ent.C, SW), Mvp: planMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], ent.P, ent.C, SW), L };
  }
  /** Cut the slice again when anything it depends on moved. */
  function cut(force = false) {
    const L = layerOf();
    const menu = A.root.querySelector('[data-scan-tools]');
    if (menu) menu.hidden = !L;
    if (!L || !show || !A.S.on) { R.slice = null; R.grid = null; R.key = ''; return false; }
    const mx = matrices();
    if (!mx) return false;
    const cutZ = A.viewRange?.()?.cut ?? CUT;   // 0.6 DF.19: the slice follows the plan's own cut height
    const key = [A.S.level, L.cloud.n, thick, cutZ, ...mx.M.map((v) => Math.round(v * 1e6))].join(',');
    if (!force && key === R.key) return false;
    R.key = key;
    R.slice = slicePoints(L.cloud.pos, L.cloud.n, mx.M, { cutZ, thick });
    R.grid = new SliceGrid(R.slice.xy, R.slice.n, 200);
    return true;
  }
  function bindMenu() {
    const root = A.root;
    const b = root.querySelector('[data-scan-slice]');
    if (b && !b.dataset.bound) {
      b.dataset.bound = '1';
      b.addEventListener('click', () => { show = !show; save(); cut(true); A.refresh(); bindMenu(); });
      const th = root.querySelector('[data-scan-thick]');
      th?.addEventListener('change', () => { const mm = parseLen(th.value, A.units()); if (mm >= 10 && mm <= 2000) { thick = mm; save(); cut(true); A.refresh(); } else A.host.status(t('model.err.length'), true); bindMenu(); });
      root.querySelector('[data-scan-floor]')?.addEventListener('click', () => align('floor'));
      root.querySelector('[data-scan-square]')?.addEventListener('click', () => align('square'));
      root.querySelector('[data-scan-reset]')?.addEventListener('click', () => align('reset'));
    }
    if (b) b.setAttribute('aria-pressed', String(show));
    const th = root.querySelector('[data-scan-thick]'); if (th && document.activeElement !== th) th.value = fmtLen(thick, A.units());
  }
  /** Align the cloud: its floor to this level, its walls square to the building, or back as it was placed. */
  function align(what) {
    const pc = o.cloud(), mx = matrices();
    if (!pc || !mx) return;
    if (typeof pc.adjust !== 'function') { A.host.status(t('model.scan.needs'), true); return; }
    const cur = pc.adjust() || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    let A2;
    if (what === 'reset') { pc.adjust(null); api.changed(); A.host.status(t('model.scan.reset'), false, true); return; }
    if (what === 'floor') {
      const z = floorZ(mx.L.cloud.pos, mx.L.cloud.n, mx.M);
      if (z === null) return;
      A2 = moveZ(-z);
      pc.adjust(mul4(planAdjust(A2, mx.Mvp), cur));
      api.changed();
      A.host.status(t('model.scan.floored', { dz: fmtLen(-z, A.units()) }), false, true);
      return;
    }
    cut(true);
    const sq = R.slice?.n ? squareAngle(R.slice.xy, R.slice.n) : null;
    if (!sq || sq.strength < 0.2) { A.host.status(t('model.scan.nowalls'), true); return; }
    let cx = 0, cy = 0; for (let i = 0; i < R.slice.n; i++) { cx += R.slice.xy[i * 2]; cy += R.slice.xy[i * 2 + 1]; }
    A2 = rotZ(-sq.angle, [cx / R.slice.n, cy / R.slice.n]);
    pc.adjust(mul4(planAdjust(A2, mx.Mvp), cur));
    api.changed();
    A.host.status(t('model.scan.squared', { a: (Math.round(-sq.angle * 100) / 100).toString() }), false, true);
  }

  A = modelUi.extend({
    snapCtx(ctx) { if (R.grid) ctx.nearest = (p, tol) => R.grid.nearest(p[0], p[1], tol); },
    refresh() { cut(); bindMenu(); },
    scene(sc) { if (R.slice?.n) sc.cloud = { xy: R.slice.xy, n: R.slice.n }; },
  });
  const api = {
    changed() { cut(true); bindMenu(); if (A.S.on) A.refresh(); },
  };
  if (typeof window !== 'undefined') window.bimcraftScan = { state: R, api, get show() { return show; }, get thick() { return thick; } };   // for tests
  return api;
}
