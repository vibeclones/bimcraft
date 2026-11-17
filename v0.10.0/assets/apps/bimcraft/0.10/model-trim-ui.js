/* SPDX-License-Identifier: Apache-2.0 */
/**
 * model-trim-ui.js — the Modify tools on the plan (0.6 DF.17, session `bim-draw`), through model-ui.js `extend()`:
 *   Trim / extend  [data-mtool="trim"]    click the wall to trim or extend to (the edge), then each wall to change: one undo step
 *                                         each; the edge stays chosen until Esc or another tool
 *   Corner         [data-mtool="corner"]  click two walls: both run to where their centre lines meet (one undo step)
 * A wall that crosses the edge keeps the part clicked. The preview shows the wall where it would go, joined to the others;
 * a refusal (parallel, the edge not reached, a door in the way, too short) is said on the plan before anything changes.
 * The maths and the op are model-trim.js. Test hook: window.bimcraftTrim = { state, wallAt }.
 */
import { trimPlan, cornerPlan, reshapeWalls, cutsOpening } from './model-trim.js';
import { wallOutlines } from './model-walls.js';
import { fmtLen } from './model-units.js';

// 0.6: the model bar's tool group grew (Modify, Scan): it wraps rather than running past a narrow window's edge
const CSS = 'html:not(.cc-compact) .bc-mb-tools { flex-wrap: wrap; max-width: 100%; }';   // compact phones keep their one sideways line (app-phone.js)

export function mountTrim(modelUi) {
  if (typeof document !== 'undefined' && !document.getElementById('bc-mb-wrap-css')) { const st = document.createElement('style'); st.id = 'bc-mb-wrap-css'; st.textContent = CSS; document.head.append(st); }
  const R = { edge: null, first: null, hover: null, plan: null };   // edge: guid (trim); first: { guid, click } (corner)
  let A = null;
  const tools = ['trim', 'corner'];
  const t = (...a) => A.t(...a);
  const mine = () => tools.includes(A.S.tool);
  const wallOf = (guid) => A.wallsHere().find((w) => w.guid === guid) || null;
  /** The drawn wall under plan point p (within its thickness and 8 px), nearest first. */
  function wallAt(p) {
    const tol = A.pv().pxToMm(8);
    let best = null;
    for (const w of A.wallsHere()) {
      const u = [(w.b[0] - w.a[0]) / w.len, (w.b[1] - w.a[1]) / w.len];
      const s = (p[0] - w.a[0]) * u[0] + (p[1] - w.a[1]) * u[1], d = Math.abs((p[0] - w.a[0]) * -u[1] + (p[1] - w.a[1]) * u[0]);
      if (s < -tol || s > w.len + tol) continue;
      const sc = Math.max(0, d - w.t / 2);
      if (sc <= tol && (!best || sc < best.sc)) best = { sc, w };
    }
    return best?.w || null;
  }
  const hint = (key) => { const h = A.root.querySelector('[data-model-hint]'); if (h) h.textContent = t(key); };
  const hintNow = () => hint(A.S.tool === 'trim' ? (R.edge ? 'model.hint.trim2' : 'model.hint.trim') : (R.first ? 'model.hint.corner2' : 'model.hint.corner'));
  /** What a click at p would do now: { changes: [{ guid, a, b }], error } | null. */
  function planAt(p) {
    const w = wallAt(p);
    if (!w) return null;
    const ops = A.S.data?.openings || [];
    if (A.S.tool === 'trim') {
      const edge = R.edge && wallOf(R.edge);
      if (!edge) return null;
      if (w.guid === edge.guid) return { wall: w, error: 'model.err.trim.same' };
      const r = trimPlan(w, edge, p);
      if (r.error) return { wall: w, error: r.error };
      const cut = cutsOpening(w, r, ops);
      return cut ? { wall: w, error: cut } : { wall: w, changes: [{ guid: w.guid, a: r.a, b: r.b }] };
    }
    const first = R.first && wallOf(R.first.guid);
    if (!first) return null;
    if (w.guid === first.guid) return { wall: w, error: 'model.err.trim.same' };
    const r = cornerPlan(first, R.first.click, w, p);
    if (r.error) return { wall: w, error: r.error };
    const cut = cutsOpening(first, r[0], ops) || cutsOpening(w, r[1], ops);
    return cut ? { wall: w, error: cut } : { wall: w, changes: [{ guid: first.guid, a: r[0].a, b: r[0].b }, { guid: w.guid, a: r[1].a, b: r[1].b }] };
  }

  A = modelUi.extend({
    tools,
    hint: (name) => (name === 'trim' ? 'model.hint.trim' : 'model.hint.corner'),
    typed: () => false,
    move(p) { R.hover = p; R.plan = (R.edge || R.first) ? planAt(p) : null; },
    click(p) {
      if (A.S.tool === 'trim' && !R.edge) {
        const w = wallAt(p);
        if (!w) { A.host.status(t('model.err.trim.nowall'), true); return; }
        R.edge = w.guid; hintNow(); return;
      }
      if (A.S.tool === 'corner' && !R.first) {
        const w = wallAt(p);
        if (!w) { A.host.status(t('model.err.trim.nowall'), true); return; }
        R.first = { guid: w.guid, click: p }; hintNow(); return;
      }
      const pl = planAt(p);
      if (!pl) { A.host.status(t('model.err.trim.nowall'), true); return; }
      if (pl.error) { A.host.status(t(pl.error), true); return; }
      const corner = A.S.tool === 'corner';
      A.commit(reshapeWalls(pl.changes), { label: t(corner ? 'model.tool.corner' : 'model.tool.trim'), verb: t(corner ? 'model.verb.joined' : 'model.verb.trimmed'), select: [] });
      if (corner) R.first = null;   // a trim keeps its edge for the next wall
      R.plan = null;
      hintNow();
    },
    escape() {
      if (!mine() || !(R.edge || R.first)) return false;
      R.edge = null; R.first = null; R.plan = null; hintNow();
      return true;
    },
    toolChanged() { R.edge = null; R.first = null; R.plan = null; R.hover = null; const m = A.root.querySelector('[data-modify-tools]'); if (m?.open) m.open = false; },
    refresh() { if (R.edge && !wallOf(R.edge)) R.edge = null; if (R.first && !wallOf(R.first.guid)) R.first = null; },
    overlay(o) {
      if (!mine()) return;
      const outline = (g) => A.S.outlines?.get(g);
      const chosen = R.edge || R.first?.guid;
      if (chosen && outline(chosen)) { o.dashed.push(...ring(outline(chosen))); }
      if (!R.hover) return;
      if (!chosen) {
        const w = wallAt(R.hover);
        if (w && outline(w.guid)) { o.walls.push(outline(w.guid)); o.hud = { p: R.hover, text: t(A.S.tool === 'trim' ? 'model.hud.trim.edge' : 'model.hud.corner.first') }; }
        return;
      }
      const pl = R.plan;
      if (!pl) return;
      if (pl.error) { o.hud = { p: R.hover, text: t(pl.error) }; return; }
      // the walls where they would go, joined to the others
      const moved = new Map(pl.changes.map((c) => [c.guid, c]));
      const walls = A.wallsHere().map((w) => ({ key: w.guid, a: moved.get(w.guid)?.a || w.a, b: moved.get(w.guid)?.b || w.b, t: w.t }));
      const polys = wallOutlines(walls);
      for (const c of pl.changes) if (polys.get(c.guid)) o.walls.push(polys.get(c.guid));
      const c0 = pl.changes[pl.changes.length - 1];
      o.hud = { p: R.hover, text: fmtLen(Math.hypot(c0.b[0] - c0.a[0], c0.b[1] - c0.a[1]), A.units()) };
    },
  });
  /** A closed outline as dashed segments [x1, y1, x2, y2]. */
  function ring(poly) { return poly.map((q, i) => { const r = poly[(i + 1) % poly.length]; return [q[0], q[1], r[0], r[1]]; }); }
  if (typeof window !== 'undefined') window.bimcraftTrim = { state: R, wallAt };   // for tests
  return { state: R };
}
