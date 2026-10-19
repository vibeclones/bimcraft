/* SPDX-License-Identifier: Apache-2.0 */
/**
 * mep-ui.js — pipes, ducts and valves on the plan (0.6 DF.29, session `bim-draw`), through model-ui.js `extend()`:
 *   Pipe   [data-mtool="pipe"]   click the centre line's corners at the height in the bar (snapping like walls, and to other
 *                                runs' ends and lines); double-click or Enter ends it. A new height typed while drawing (Enter)
 *                                makes a riser at the last point. Options: system, material, class, size, height, slope
 *                                ([data-mep-sys|mat|cls|size|z|slope]); sanitary and storm start at the plumbing code minimum.
 *   Duct   [data-mtool="duct"]   the same with system, shape, width, height, elevation, and airflow + friction rate with Size it
 *                                (equal friction, the HVAC add-on's sizing) ([data-mep-dsys|shape|w|h|dz|flow|rate|sizeit]).
 *   Valve  [data-mtool="valve"]  click on a pipe: gate, ball, globe or check ([data-mep-valve]).
 * Ending a run on another run's line makes a tee; on its end, an elbow or a reducer (mep-model.js makes the fittings).
 * Plans: pipes under 150 mm as one line, larger pipes and ducts as two, in their system's colour; rises and drops marked;
 * size and system labels; a drain's fall. Runs show on every level their height range reaches (the plan's view range).
 * Properties edit a run; Delete removes it. Schedules: pipes, ducts, fittings and valves. The TakeoffCraft hand-off (res-ui.js
 * makeTakeoff) gets them through `takeoffExtra`. Test hook: window.bimcraftMep = { state, api }.
 */
import { readRuns, placeRun, changeRun, removeRuns, addValve, removeValve, mepLayout, sectionOf, runVertices, runDefaults, drainMinimum, along, runLength,
  PIPE_SYSTEMS, DUCT_SYSTEMS, VALVE_KINDS, DUCT_SHAPES, systemLabel, pipeForFlow, ductForFlow, ductLoss, runSchedules } from './mep-model.js';
import { MATERIALS, CLASSES, DEFAULT_CLASS, sizesFor, pipeSize } from './mep/tables.js';
import { ModelWriter } from './model-write.js';
import { fmtLen, parseLen } from './model-units.js';
import { el } from './ui-util.js';

const IN = 25.4;
const SINGLE_UNDER = 150;   // pipes narrower than this draw as one line

/** A slope as people write it: imperial rise per foot ('1/4"/ft'), metric per cent. */
export function fmtSlope(s, units) {
  if (!(s > 0)) return '0';
  if (units === 'mm') return (Math.round(s * 1000) / 10) + ' %';
  const inPerFt = s * 12, den = [2, 4, 8, 16, 32].find((d) => Math.abs(inPerFt * d - Math.round(inPerFt * d)) < 1e-6);
  return (den ? (Math.round(inPerFt * den) / den === Math.floor(inPerFt) ? String(Math.floor(inPerFt)) : (Math.floor(inPerFt) ? Math.floor(inPerFt) + '-' : '') + Math.round((inPerFt % 1) * den) + '/' + den) : inPerFt.toFixed(3)) + '"/ft';   // i18n-ignore: unit mark
}
/** '1/4', '1/4"/ft', '0.25 in/ft', '2%', '2 %', '1:50', '0.02' → rise per run, or NaN. */
export function parseSlope(text) {
  const s = String(text || '').trim().toLowerCase().replace(',', '.');
  if (s === '' || s === '0') return 0;
  let m = /^([\d.]+)\s*%$/.exec(s); if (m) return Number(m[1]) / 100;
  m = /^1\s*:\s*([\d.]+)$/.exec(s); if (m) return 1 / Number(m[1]);
  m = /^(?:(\d+)[-\s])?(\d+)\/(\d+)\s*(?:"|in)?\s*(?:\/\s*(?:ft|'))?$/.exec(s); if (m) return ((Number(m[1]) || 0) + Number(m[2]) / Number(m[3])) / 12;
  m = /^([\d.]+)\s*(?:"|in)\s*(?:\/\s*(?:ft|'))?$/.exec(s); if (m) return Number(m[1]) / 12;
  m = /^([\d.]+)$/.exec(s); if (m) { const v = Number(m[1]); return v < 0.2 ? v : NaN; }
  return NaN;
}

export function mountMep(modelUi) {
  const R = {
    runs: [], lay: new Map(),   // storey → mepLayout result (per refresh)
    pts: [], hover: null, snapRun: null, valveHover: null,
    pipe: { ...runDefaults('pipe', 'cw'), z: 2438.4, slopeAuto: true },
    duct: { ...runDefaults('duct', 'supply'), z: 2600, flow: 0, rate: 0 },
    valve: 'gate',
  };
  let A = null;
  const t = (...a) => A.t(...a);
  const W = () => new ModelWriter(A.ed().W, A.ed().api, A.ed().mid);
  const L = (mm) => fmtLen(mm, A.units());
  const levelGuid = () => A.S.data.levels.find((l) => l.id === A.S.level)?.guid;
  const hint = (key) => { const h = A.root.querySelector('[data-model-hint]'); if (h) h.textContent = t(key); };
  const opts = () => (A.S.tool === 'duct' ? R.duct : R.pipe);
  const kindNow = () => (A.S.tool === 'duct' ? 'duct' : 'pipe');
  const imperial = () => A.units() !== 'mm';
  const sizeLabel = (sec) => (sec.kind === 'pipe' && !imperial() && sec.p?.dn ? 'DN' + sec.p.dn : sec.kind === 'duct' && imperial() ? (sec.round ? Math.round(sec.w / IN) + '"Ø' : Math.round(sec.w / IN) + '×' + Math.round(sec.h / IN)) : sec.label);   // i18n-ignore: size marks
  const elevOf = (storey) => A.S.data.levels.find((l) => l.id === storey)?.elevation ?? 0;

  function read() {
    R.runs = []; R.lay = new Map();
    if (!A.ed()) return;
    try {
      R.runs = readRuns(W()).map((r) => ({ ...r, sec: sectionOf(r), verts: runVertices(r) }));
      for (const st of new Set(R.runs.map((r) => r.storey))) R.lay.set(st, mepLayout(R.runs.filter((r) => r.storey === st)));
    } catch (e) { console.error(e); R.runs = []; R.lay = new Map(); }
  }
  const partsOf = (r) => R.lay.get(r.storey)?.runs.get(r.guid)?.parts || [];
  /** The run whose plan line passes within tol of p (same kind), with where along it. */
  function runNear(p, kind, tol) {
    let best = null;
    for (const r of R.runs) {
      if (kind && r.kind !== kind) continue;
      if (!visible(r)) continue;
      const a = along(r, p);
      if (a && a.d <= Math.max(tol, (r.sec?.w || 0) / 2) && (!best || a.d < best.a.d)) best = { r, a };
    }
    return best;
  }
  /** Height (above THIS level) of a run at a point along it. */
  const zAt = (r, a) => {
    const V = r.verts; let s = a.s;
    for (let i = 0; i + 1 < V.length; i++) { const Lg = Math.hypot(V[i + 1][0] - V[i][0], V[i + 1][1] - V[i][1], V[i + 1][2] - V[i][2]); if (s <= Lg || i === V.length - 2) { const u = Lg ? Math.min(1, s / Lg) : 0; return V[i][2] + (V[i + 1][2] - V[i][2]) * u + elevOf(r.storey) - elevOf(A.S.level); } s -= Lg; }
    return V[0][2];
  };
  /** Snap: the Wall tool's snapping, then another run's corner or line (its height comes too). */
  function at(p, e) {
    const last = R.pts.length ? R.pts[R.pts.length - 1] : null;
    const s = A.snapFrom(p, e, last);
    R.snapRun = null;
    const tol = A.pv().pxToMm(12);
    // a run's corner or end
    for (const r of R.runs) {
      if (r.kind !== kindNow() || !visible(r)) continue;
      for (const v of r.verts) if (Math.hypot(v[0] - p[0], v[1] - p[1]) <= tol) { R.snapRun = { r, z: v[2] + elevOf(r.storey) - elevOf(A.S.level), kind: 'end' }; return [v[0], v[1]]; }
    }
    if (s.kind === 'end' || s.kind === 'grid') return s.p;
    const n = runNear(p, kindNow(), tol);
    if (n) { R.snapRun = { r: n.r, z: zAt(n.r, n.a), kind: 'mid' }; return [n.a.at[0], n.a.at[1]]; }
    return s.p;
  }
  function addPoint(q) {
    const o = opts();
    if (R.snapRun) {
      const z = R.snapRun.z;
      if (!R.pts.length) { o.z = z; R.pts.push([q[0], q[1], z]); bindRows(); return; }
      // landing on a run at another height: a vertical leg down (or up) onto it
      const lastZ = R.pts[R.pts.length - 1][2];
      if (Math.abs(lastZ - z) > 1) R.pts.push([q[0], q[1], lastZ]);
      R.pts.push([q[0], q[1], z]);
      finish();
      return;
    }
    R.pts.push([q[0], q[1], o.z]);
  }
  function finish() {
    const pts = R.pts.slice();
    R.pts = [];
    hint(A.S.tool === 'duct' ? 'mep.hint.duct' : 'mep.hint.pipe');
    if (pts.length < 2) return;
    const kind = kindNow(), o = opts();
    const spec = kind === 'pipe'
      ? { storey: levelGuid(), kind, system: o.system, mat: o.mat, cls: o.cls, size: o.size, slope: o.slope, points: pts }
      : { storey: levelGuid(), kind, system: o.system, shape: o.shape, w: o.w, h: o.shape === 'round' ? o.w : o.h, flow: o.flow || 0, points: pts };
    A.commit(placeRun(spec), { label: t(kind === 'duct' ? 'mep.run.duct' : 'mep.run.pipe'), verb: t('model.verb.drew') });
  }

  // ---- what a level shows ----
  /** A run shows on this level when its height range meets the plan's view range (from the level up to its top). */
  function rangeHere() {
    const vr = A.viewRange?.() || {}, me = A.level(), above = A.levelAbove();
    const base = elevOf(A.S.level), top = vr.top > 0 ? vr.top : (above ? above.elevation - base : me?.height || 3000);
    return { lo: base + (vr.bottom || 0) - 1, hi: base + top + 1, hidden: vr.hiddenClasses || new Set() };
  }
  function visible(r) {
    if (!r.sec || !r.verts.length) return false;
    const g = rangeHere();
    if ([...g.hidden].some((c) => c.toLowerCase() === (r.kind === 'pipe' ? 'ifcpipesegment' : 'ifcductsegment'))) return false;
    const e = elevOf(r.storey), zs = r.verts.map((v) => v[2] + e);
    return Math.max(...zs) >= g.lo && Math.min(...zs) <= g.hi;
  }
  /** A part's centre line as plan points (bends sampled). */
  function centre(p) {
    if (p.kind === 'bend') {
      const n = 12, out = [];
      for (let i = 0; i <= n; i++) { const a = p.th * i / n, c = Math.cos(a), s = Math.sin(a); out.push([p.center[0] + (-p.n[0] * c + p.d1[0] * s) * p.R, p.center[1] + (-p.n[1] * c + p.d1[1] * s) * p.R, p.center[2] + (-p.n[2] * c + p.d1[2] * s) * p.R]); }
      return out;
    }
    if (p.kind === 'tee') return [[p.at[0] - p.d[0] * p.m, p.at[1] - p.d[1] * p.m, p.at[2]], [p.at[0] + p.d[0] * p.m, p.at[1] + p.d[1] * p.m, p.at[2]]];
    return [p.a, p.b];
  }
  const planLen = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; };
  /** Two lines either side of a plan polyline, half widths h0 → h1 along it; the closed outline too. */
  function sides(pts, h0, h1 = h0) {
    const P = pts.filter((q, i) => !i || Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) > 0.01);
    if (P.length < 2) return null;
    const tot = planLen(P);
    let run = 0;
    const left = [], right = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l;
      if (i) run += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
      const h = h0 + (h1 - h0) * (tot ? run / tot : 0);
      left.push([P[i][0] + nx * h, P[i][1] + ny * h]); right.push([P[i][0] - nx * h, P[i][1] - ny * h]);
    }
    return { left, right, poly: [...left, ...right.slice().reverse()] };
  }
  const segs = (pts) => pts.slice(1).map((q, i) => [pts[i][0], pts[i][1], q[0], q[1]]);
  function scene(sc) {
    const k = A.kb();
    for (const r of R.runs) {
      if (!visible(r)) continue;
      const parts = partsOf(r), sec = r.sec;
      const single = sec.kind === 'pipe' && sec.od < SINGLE_UNDER;
      const half = (s) => (s.kind === 'pipe' ? s.od / 2 : s.w / 2);
      const color = (r.kind === 'pipe' ? PIPE_SYSTEMS[r.system] : DUCT_SYSTEMS[r.system])?.token || '--ink';
      let longest = null;
      const g = rangeHere(), e0 = elevOf(r.storey);
      parts.forEach((p, i) => {
        const id = r.parts[i];
        if (id === undefined) return;
        const key = k + id, C = centre(p), pl = planLen(C);
        // only the parts this level's range reaches (a riser's upper legs belong to the level above)
        const zs = C.map((q) => q[2] + e0), z0 = Math.min(...zs), z1 = Math.max(...zs);
        if (z1 < g.lo || z0 > g.hi) return;
        const sym = { key, lines: [], thin: [], dashed: [], arcs: [], color };
        if (pl < 1) {
          // a riser: the section seen end-on, and a mark which way it goes
          const c = C[0], hw = Math.max(half(sec), 40);
          if (sec.round) sym.arcs.push({ c: [c[0], c[1]], r: hw, a0: 0, a1: Math.PI * 2 });
          else { const hh = sec.h / 2, ww = sec.w / 2; sym.lines.push([c[0] - ww, c[1] - hh, c[0] + ww, c[1] - hh], [c[0] + ww, c[1] - hh, c[0] + ww, c[1] + hh], [c[0] + ww, c[1] + hh, c[0] - ww, c[1] + hh], [c[0] - ww, c[1] + hh, c[0] - ww, c[1] - hh]); }
          sym.thin.push([c[0] - hw, c[1] - hw, c[0] + hw, c[1] + hw]);
          sym.box = [c[0] - hw, c[1] - hw, c[0] + hw, c[1] + hw];
          // UP when it leaves this level upward, DN when it goes down out of it; inside the level, the way it runs
          const up = z1 > g.hi ? true : z0 < g.lo ? false : (p.kind === 'segment' ? p.b[2] - p.a[2] : 0) > 0;
          (sc.rooms ||= []).push({ key, label: [t(up ? 'mep.rise.up' : 'mep.rise.down')], at: [c[0] + hw * 1.6, c[1] + hw * 1.6] });
          sc.symbols.push(sym);
          return;
        }
        if (p.kind === 'valve') {
          const a = p.a, b = p.b, n = [-p.d[1], p.d[0]], nl = Math.hypot(n[0], n[1]) || 1, hw = Math.max(half(sec) * 1.4, 60), ux = n[0] / nl * hw, uy = n[1] / nl * hw;
          sym.lines.push([a[0] + ux, a[1] + uy, b[0] - ux, b[1] - uy], [a[0] - ux, a[1] - uy, b[0] + ux, b[1] + uy], [a[0] + ux, a[1] + uy, a[0] - ux, a[1] - uy], [b[0] + ux, b[1] + uy, b[0] - ux, b[1] - uy]);
          const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          if (p.valve.kind === 'ball') sym.arcs.push({ c: m, r: hw * 0.35, a0: 0, a1: Math.PI * 2 });
          if (p.valve.kind === 'globe') sym.arcs.push({ c: m, r: hw * 0.25, a0: 0, a1: Math.PI * 2 });
          if (p.valve.kind === 'check') sym.thin.push([m[0] - p.d[0] * hw, m[1] - p.d[1] * hw, m[0] + p.d[0] * hw, m[1] + p.d[1] * hw]);
          sym.poly = [[a[0] + ux, a[1] + uy], [b[0] + ux, b[1] + uy], [b[0] - ux, b[1] - uy], [a[0] - ux, a[1] - uy]];
          sc.symbols.push(sym);
          return;
        }
        const extra = [];
        if (p.kind === 'tee') extra.push([[p.at[0], p.at[1], p.at[2]], [p.at[0] + p.bd[0] * p.mb, p.at[1] + p.bd[1] * p.mb, p.at[2]]]);
        if (single) {
          sym.lines.push(...segs(C), ...extra.flatMap(segs));
          if (p.kind === 'reducer') { const m = [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2], n = [-p.d[1], p.d[0]], s = 40; sym.thin.push([p.a[0] + n[0] * s, p.a[1] + n[1] * s, m[0], m[1]], [p.a[0] - n[0] * s, p.a[1] - n[1] * s, m[0], m[1]]); }
          if (p.kind === 'tee' || p.kind === 'bend') for (const q of [C[0], C[C.length - 1]]) sym.thin.push(...tick(q, C));
          sym.poly = C.map((q) => [q[0], q[1]]);
        } else {
          const h0 = p.kind === 'reducer' ? half(p.from) : half(sec), h1 = p.kind === 'reducer' ? half(p.to) : h0;
          const S = sides(C, h0, h1);
          if (!S) return;
          sym.lines.push(...segs(S.left), ...segs(S.right));
          if (p.kind !== 'segment') sym.thin.push([S.left[0][0], S.left[0][1], S.right[0][0], S.right[0][1]], [S.left.at(-1)[0], S.left.at(-1)[1], S.right.at(-1)[0], S.right.at(-1)[1]]);
          for (const e of extra) { const S2 = sides(e, half(p.branchSec)); if (S2) sym.lines.push(...segs(S2.left), ...segs(S2.right), [S2.left.at(-1)[0], S2.left.at(-1)[1], S2.right.at(-1)[0], S2.right.at(-1)[1]]); }
          sym.poly = S.poly;
        }
        sc.symbols.push(sym);
        if (p.kind === 'segment' && (!longest || pl > longest.l)) longest = { l: pl, p, key };
      });
      // the run's label: size and system, and a drain's fall
      if (longest && longest.l > 300) {
        const p = longest.p, m = [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2], n = [-p.d[1], p.d[0]], nl = Math.hypot(n[0], n[1]) || 1, off = Math.max(half(sec), 40) + A.pv().pxToMm(10);
        const lines = [sizeLabel(sec) + ' ' + t('mep.abbr.' + r.system)];
        if (r.slope > 0) lines.push(t('mep.fall', { slope: fmtSlope(r.slope, A.units()) }));
        (sc.rooms ||= []).push({ key: longest.key, label: lines, at: [m[0] + n[0] / nl * off, m[1] + n[1] / nl * off] });
        // the fall's arrow along the flow
        if (r.slope > 0) { const s = Math.min(600, longest.l / 4), d = [p.d[0], p.d[1]], dl = Math.hypot(d[0], d[1]) || 1, ux = d[0] / dl, uy = d[1] / dl, q = [m[0] - n[0] / nl * off, m[1] - n[1] / nl * off];
          sc.symbols.push({ key: longest.key, lines: [], thin: [[q[0] - ux * s / 2, q[1] - uy * s / 2, q[0] + ux * s / 2, q[1] + uy * s / 2], [q[0] + ux * s / 2, q[1] + uy * s / 2, q[0] + ux * s / 4 - uy * s / 8, q[1] + uy * s / 4 + ux * s / 8], [q[0] + ux * s / 2, q[1] + uy * s / 2, q[0] + ux * s / 4 + uy * s / 8, q[1] + uy * s / 4 - ux * s / 8]], color }); }
      }
    }
  }
  /** A fitting's end marks on a single-line pipe (a short line across). */
  function tick(q, C) {
    const i = q === C[0] ? 0 : C.length - 1, j = i ? i - 1 : 1;
    const dx = C[i][0] - C[j][0], dy = C[i][1] - C[j][1], l = Math.hypot(dx, dy) || 1, s = 45;
    return [[q[0] - dy / l * s, q[1] + dx / l * s, q[0] + dy / l * s, q[1] - dx / l * s]];
  }

  // ---- option rows ----
  const fill = (sel, list, value) => { if (!sel) return; const have = [...sel.options].map((o) => o.value).join('|'); if (have !== list.map((x) => x[0]).join('|')) sel.replaceChildren(...list.map(([v, l]) => el('option', { value: v }, l))); if (document.activeElement !== sel) sel.value = value; };
  const sysList = (kind) => Object.keys(kind === 'pipe' ? PIPE_SYSTEMS : DUCT_SYSTEMS).map((k) => [k, systemLabel(kind, k)]);
  const pipeSizes = (o) => sizesFor(o.mat, o.cls).map((s) => [s, imperial() ? s + '"' : 'DN' + (pipeSize(o.mat, o.cls, s)?.dn ?? s)]);   // i18n-ignore: size marks
  function bindRows() {
    const root = A.root, q = (s) => root.querySelector(s);
    const P = R.pipe, D = R.duct;
    if (q('[data-mep-sys]') && !q('[data-mep-sys]').dataset.bound) {
      q('[data-mep-sys]').dataset.bound = '1';
      const len = (sel, fn) => { const i = q(sel); i?.addEventListener('change', () => { const mm = parseLen(i.value, A.units()); if (Number.isFinite(mm)) fn(mm); else A.host.status(t('model.err.length'), true); bindRows(); A.drawOverlay(); }); i?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); i.dispatchEvent(new Event('change')); } }); };
      q('[data-mep-sys]').addEventListener('change', (e) => { const d = runDefaults('pipe', e.target.value); Object.assign(P, { system: d.system, mat: d.mat, cls: d.cls, size: d.size }); if (P.slopeAuto) P.slope = d.slope; bindRows(); });
      q('[data-mep-mat]')?.addEventListener('change', (e) => { P.mat = e.target.value; P.cls = DEFAULT_CLASS[P.mat]; const s = sizesFor(P.mat, P.cls); if (!s.includes(P.size)) P.size = s[Math.min(s.length - 1, Math.floor(s.length / 3))]; autoSlope(); bindRows(); });
      q('[data-mep-cls]')?.addEventListener('change', (e) => { P.cls = e.target.value; const s = sizesFor(P.mat, P.cls); if (!s.includes(P.size)) P.size = s[0]; bindRows(); });
      q('[data-mep-size]')?.addEventListener('change', (e) => { P.size = e.target.value; autoSlope(); bindRows(); });
      // a new height while drawing: a riser at the last point
      const riser = (o, mm) => { if (R.pts.length && Math.abs(R.pts[R.pts.length - 1][2] - mm) > 1) { const l = R.pts[R.pts.length - 1]; R.pts.push([l[0], l[1], mm]); } o.z = mm; };
      len('[data-mep-z]', (mm) => riser(P, mm));
      q('[data-mep-slope]')?.addEventListener('change', (e) => { const v = parseSlope(e.target.value); if (Number.isFinite(v) && v >= 0 && v < 0.2) { P.slope = v; P.slopeAuto = false; } else A.host.status(t('mep.err.slope'), true); bindRows(); });
      q('[data-mep-dsys]')?.addEventListener('change', (e) => { D.system = e.target.value; });
      q('[data-mep-shape]')?.addEventListener('change', (e) => { D.shape = e.target.value; if (D.shape === 'oval' && !(D.w > D.h)) D.w = D.h * 2; bindRows(); });
      len('[data-mep-w]', (mm) => { if (mm >= 50) D.w = mm; });
      len('[data-mep-h]', (mm) => { if (mm >= 50) D.h = mm; });
      len('[data-mep-dz]', (mm) => riser(D, mm));
      const num = (sel, fn) => q(sel)?.addEventListener('change', (e) => { const v = Number(String(e.target.value).replace(',', '.')); if (Number.isFinite(v) && v >= 0) fn(v); else A.host.status(t('mep.err.number'), true); bindRows(); });
      num('[data-mep-flow]', (v) => { D.flow = v; });
      num('[data-mep-rate]', (v) => { D.rate = v; });
      q('[data-mep-sizeit]')?.addEventListener('click', () => sizeDuct());
      q('[data-mep-valve]')?.addEventListener('change', (e) => { R.valve = e.target.value; });
    }
    fill(q('[data-mep-sys]'), sysList('pipe'), P.system);
    fill(q('[data-mep-mat]'), MATERIALS.map((m) => [m, t('mep.mat.' + m)]), P.mat);
    fill(q('[data-mep-cls]'), CLASSES[P.mat].map((c) => [c, t('mep.cls.' + P.mat, { c })]), P.cls);
    fill(q('[data-mep-size]'), pipeSizes(P), P.size);
    fill(q('[data-mep-dsys]'), sysList('duct'), D.system);
    fill(q('[data-mep-shape]'), DUCT_SHAPES.map((s) => [s, t('mep.shape.' + s)]), D.shape);
    fill(q('[data-mep-valve]'), Object.keys(VALVE_KINDS).map((k) => [k, t('mep.valve.' + k)]), R.valve);
    const set = (sel, v) => { const i = q(sel); if (i && document.activeElement !== i) i.value = v; };
    set('[data-mep-z]', L(P.z)); set('[data-mep-slope]', fmtSlope(P.slope, A.units()));
    set('[data-mep-w]', L(D.w)); set('[data-mep-h]', L(D.h)); set('[data-mep-dz]', L(D.z));
    set('[data-mep-flow]', D.flow ? String(D.flow) : ''); set('[data-mep-rate]', D.rate ? String(D.rate) : '');
    const hRow = q('[data-mep-h]'); if (hRow) hRow.closest('label').hidden = D.shape === 'round';
    const fu = q('[data-mep-flowunit]'); if (fu) fu.textContent = t(imperial() ? 'mep.unit.cfm' : 'mep.unit.ls');
    const ru = q('[data-mep-rateunit]'); if (ru) ru.textContent = t(imperial() ? 'mep.unit.inwg' : 'mep.unit.pam');
  }
  function autoSlope() { const P = R.pipe; if (P.slopeAuto) P.slope = runDefaults('pipe', P.system, P.size).slope ? drainMinimum(P) || 0 : 0; }
  function sizeDuct() {
    const D = R.duct;
    const rate = D.rate || (imperial() ? 0.08 : 0.8);
    const s = ductForFlow({ q: D.flow, rate, shape: D.shape, h: D.shape === 'round' ? null : D.h, u: imperial() ? 'in' : 'mm' });
    if (!s) { A.host.status(t('mep.err.sizeit'), true); return; }
    D.w = s.w; if (D.shape !== 'round') D.h = s.h; D.rate = rate;
    A.host.status(t('mep.sized', { size: D.shape === 'round' ? L(s.w) : L(s.w) + ' × ' + L(s.h), v: s.v.toFixed(imperial() ? 0 : 1) + ' ' + t(imperial() ? 'mep.unit.fpm' : 'mep.unit.ms') }) + (s.note === 'aspect' ? ' ' + t('mep.aspect') : ''));
    bindRows();
  }

  // ---- picking, Properties, Delete ----
  const runOfKey = (key) => { const k = A.kb(); return R.runs.find((r) => r.parts.some((p) => k + p === key)) || null; };
  const partKeys = (guid) => () => { read(); const r = R.runs.find((x) => x.guid === guid); return r ? r.parts.map((p) => A.kb() + p) : []; };
  function props(items, kit) {
    if (items.length !== 1) return null;
    const r = R.runs.find((x) => x.guid === items[0].guid);
    if (!r) return null;
    const meta = { label: t(r.kind === 'duct' ? 'mep.run.duct' : 'mep.run.pipe'), verb: t('model.verb.changed'), reselect: partKeys(r.guid) };
    const run = (ch) => A.commit(changeRun(r.guid, ch), meta);
    kit.field(t('mep.system'), kit.select(sysList(r.kind), r.system, 'data-mp-mepsys', (v) => run(r.kind === 'pipe' ? { system: v, slope: r.slope || (PIPE_SYSTEMS[v]?.drain ? drainMinimum({ ...r, system: v }) || 0 : 0) } : { system: v })));
    if (r.kind === 'pipe') {
      kit.field(t('mep.material'), kit.select(MATERIALS.map((m) => [m, t('mep.mat.' + m)]), r.mat, 'data-mp-mepmat', (v) => { const c = DEFAULT_CLASS[v], s = sizesFor(v, c); run({ mat: v, cls: c, size: s.includes(r.size) ? r.size : s[0] }); }));
      kit.field(t('mep.class'), kit.select(CLASSES[r.mat].map((c) => [c, t('mep.cls.' + r.mat, { c })]), r.cls, 'data-mp-mepcls', (v) => { const s = sizesFor(r.mat, v); run({ cls: v, size: s.includes(r.size) ? r.size : s[0] }); }));
      kit.field(t('mep.size'), kit.select(pipeSizes(r), r.size, 'data-mp-mepsize', (v) => run({ size: v })));
      const sl = el('input', { type: 'text', className: 'bc-input bc-num', value: fmtSlope(r.slope, A.units()), 'data-mp-mepslope': '', size: 8 });
      sl.addEventListener('change', () => { const v = parseSlope(sl.value); if (Number.isFinite(v) && v >= 0 && v < 0.2) run({ slope: v }); else { A.host.status(t('mep.err.slope'), true); sl.value = fmtSlope(r.slope, A.units()); } });
      kit.field(t('mep.slope'), sl);
      const min = drainMinimum(r);
      if (min !== null) kit.rows.push(el('dt', {}, ''), el('dd', { className: r.slope + 1e-9 < min ? 'bc-input-err' : 'bc-muted', 'data-mp-mepmin': '' }, t(r.slope + 1e-9 < min ? 'mep.slope.under' : 'mep.slope.min', { min: fmtSlope(min, A.units()) })));
    } else {
      kit.field(t('mep.shape'), kit.select(DUCT_SHAPES.map((s) => [s, t('mep.shape.' + s)]), r.shape, 'data-mp-mepshape', (v) => run({ shape: v, h: v === 'round' ? r.w : (v === 'oval' && !(r.w > r.h) ? r.w / 2 : r.h) })));
      kit.field(t(r.shape === 'round' ? 'mep.diameter' : 'mep.width'), kit.lenInput(r.w, 'data-mp-mepw', (mm) => run({ w: mm, ...(r.shape === 'round' ? { h: mm } : {}) }), { min: 50 }));
      if (r.shape !== 'round') kit.field(t('mep.height'), kit.lenInput(r.h, 'data-mp-meph', (mm) => run({ h: mm }), { min: 50 }));
      const fl = el('input', { type: 'text', className: 'bc-input bc-num', value: r.flow ? String(r.flow) : '', 'data-mp-mepflow': '', size: 7 });
      fl.addEventListener('change', () => { const v = Number(fl.value.replace(',', '.')); if (Number.isFinite(v) && v >= 0) run({ flow: v }); else { A.host.status(t('mep.err.number'), true); fl.value = r.flow ? String(r.flow) : ''; } });
      kit.field(t('mep.flow', { unit: t(imperial() ? 'mep.unit.cfm' : 'mep.unit.ls') }), fl);
      const loss = ductLoss(r, imperial() ? 'in' : 'mm');
      if (loss) kit.rows.push(el('dt', {}, t('mep.loss')), el('dd', { 'data-mp-meploss': '' }, t('mep.losstext', { v: loss.V.toFixed(imperial() ? 0 : 1) + ' ' + t(imperial() ? 'mep.unit.fpm' : 'mep.unit.ms'), rate: loss.rate.toFixed(imperial() ? 3 : 2) + ' ' + t(imperial() ? 'mep.unit.inwg' : 'mep.unit.pam') })));
    }
    // height: the whole run up or down (its first point's height)
    const z0 = r.points[0][2];
    kit.field(t('mep.z'), kit.lenInput(z0, 'data-mp-mepz', (mm) => run({ points: r.points.map((q) => [q[0], q[1], q[2] + (mm - z0)]) }), { any: true }));
    kit.rows.push(el('dt', {}, t('mep.length')), el('dd', { 'data-mp-meplen': '' }, L(runLength(r)) + ' · ' + t('mep.parts', { n: r.parts.length })));
    if (r.kind === 'pipe' && r.flow >= 0) {
      const fb = el('input', { type: 'text', className: 'bc-input bc-num', value: r.flow ? String(r.flow) : '', 'data-mp-mepgpm': '', size: 6 });
      const go = kit.button(t('mep.sizeit'), 'data-mp-mepsizeit', () => {
        const q = Number(fb.value.replace(',', '.'));
        const v = PIPE_SYSTEMS[r.system]?.drain ? null : pipeForFlow(r.mat, r.cls, q, imperial() ? (r.system === 'hw' || r.system === 'hwr' ? 5 : 8) : (r.system === 'hw' || r.system === 'hwr' ? 1.5 : 2.4), imperial() ? 'in' : 'mm');
        if (!v) { A.host.status(t(PIPE_SYSTEMS[r.system]?.drain ? 'mep.err.drainsize' : 'mep.err.sizeit'), true); return; }
        A.host.status(t('mep.pipesized', { size: imperial() ? v.size + '"' : 'DN' + (pipeSize(r.mat, r.cls, v.size)?.dn ?? v.size), v: v.v.toFixed(1) + ' ' + t(imperial() ? 'mep.unit.fps' : 'mep.unit.ms') }));   // i18n-ignore: size mark
        run({ size: v.size, flow: q });
      });
      kit.field(t('mep.flow', { unit: t(imperial() ? 'mep.unit.gpm' : 'mep.unit.ls') }), fb, go);
    }
    r.valves.forEach((v, i) => kit.field(t('mep.valve.at', { kind: t('mep.valve.' + v.kind), at: L(v.s) }), kit.button(t('mep.valve.del'), 'data-mp-mepdelvalve', () => A.commit(removeValve(r.guid, i), meta))));
    return { title: t(r.kind === 'duct' ? 'mep.run.duct' : 'mep.run.pipe') + ' ' + sizeLabel(r.sec) + ' ' + systemLabel(r.kind, r.system) };
  }

  // ---- schedules ----
  function schedules() {
    if (!A.S.on || !A.ed() || !R.runs.length) return {};
    const S = runSchedules(W()), sys = (k, s) => systemLabel(k, s);
    const len = (mm) => L(mm), area = (mm2) => imperial() ? (Math.round(mm2 / 92903.04 * 10) / 10) + ' ' + t('mep.unit.sf') : (Math.round(mm2 / 1e5) / 10) + ' m²';   // i18n-ignore: unit
    const pipes = S.pipes.sort((a, b) => (a.system + a.mat + a.cls).localeCompare(b.system + b.mat + b.cls) || (a.od - b.od));
    const ducts = S.ducts.sort((a, b) => a.system.localeCompare(b.system) || (b.w * b.h - a.w * a.h));
    const fits = S.fittings.sort((a, b) => (a.kind + a.system + a.what).localeCompare(b.kind + b.system + b.what));
    R.sched = { pipes, ducts, mepfit: fits };
    return {
      pipes: { head: [t('mep.system'), t('mep.material'), t('mep.size'), t('mep.length'), t('mep.pieces')], rows: pipes.map((x) => [sys('pipe', x.system), t('mep.cls.' + x.mat, { c: x.cls }), imperial() ? x.size + '"' : 'DN' + (x.p?.dn ?? x.size), len(x.length), String(x.n)]), total: ['', '', '', len(pipes.reduce((s, x) => s + x.length, 0)), String(pipes.reduce((s, x) => s + x.n, 0))] },   // i18n-ignore: size mark
      ducts: { head: [t('mep.system'), t('mep.shape'), t('mep.size'), t('mep.length'), t('mep.surface')], rows: ducts.map((x) => [sys('duct', x.system), t('mep.shape.' + x.shape), sizeLabel({ kind: 'duct', round: x.shape === 'round', w: x.w, h: x.h, label: x.label }), len(x.length), area(x.area)]), total: ['', '', '', len(ducts.reduce((s, x) => s + x.length, 0)), area(ducts.reduce((s, x) => s + x.area, 0))] },
      mepfit: { head: [t('mep.system'), t('mep.fitting'), t('mep.size'), t('mep.count')], rows: fits.map((x) => [sys(x.kind, x.system), x.valve ? t('mep.valve.' + x.what) : t('mep.fit.' + x.what + (x.kind === 'duct' && x.what === 'reducer' ? '.duct' : '')) + (x.angle ? ' ' + Math.round(x.angle) + '°' : ''), x.size, String(x.n)]), total: ['', '', '', String(fits.reduce((s, x) => s + x.n, 0))] },
    };
  }
  function scheduleKeys(kind, i) {
    const row = R.sched?.[kind]?.[i];
    return row ? row.ids.map((id) => A.kb() + id) : [];
  }

  // ---- the TakeoffCraft hand-off (res-ui.js makeTakeoff asks): pipe and duct by size as runs, fittings and valves counted ----
  function takeoffExtra(input) {
    if (!R.runs.length) return;
    const FT = 304.8;
    // modelQuantities' levels are named, not keyed: found by their title, else added with the level's plan
    const level = (id) => {
      let lv = input.levels.find((x) => x.storeyId === id);
      if (lv) return lv;
      const meta = A.S.data.levels.find((l) => l.id === id);
      lv = input.levels.find((x) => x.title === t('res.sh.plan', { level: meta?.name || '' }));
      if (!lv) { lv = { title: t('res.sh.plan', { level: meta?.name || '' }), scene: A.sceneFor(id), runs: [], areas: [], counts: [] }; input.levels.push(lv); }
      lv.storeyId = id;
      return lv;
    };
    const def = (key, v) => { if (!input.items[key]) input.items[key] = v; return key; };
    for (const r of R.runs) {
      const parts = partsOf(r), lv = level(r.storey), sec = r.sec;
      parts.forEach((p) => {
        if (p.kind === 'segment') {
          const pl = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]);
          if (pl < 1) return;   // risers: a run on a plan cannot measure them
          const key = r.kind === 'pipe' ? def(['pipe', r.system, r.mat, r.cls, r.size, r.slope ? 's' : ''].join(':'), { name: t('mep.to.pipe', { size: sizeLabel(sec), mat: t('mep.cls.' + r.mat, { c: r.cls }), sys: systemLabel('pipe', r.system) }), type: 'linear', ...(r.slope > 0 ? { slope: 'rake', pitch: Math.atan(r.slope) * 180 / Math.PI } : {}) })
            : def(['duct', r.system, sec.shape, Math.round(sec.w), Math.round(sec.h)].join(':'), { name: t('mep.to.duct', { size: sizeLabel(sec), shape: t('mep.shape.' + sec.shape), sys: systemLabel('duct', r.system) }), type: 'linear', heightFt: (sec.round ? Math.PI * sec.w : sec.shape === 'oval' ? Math.PI * sec.h + 2 * (sec.w - sec.h) : 2 * (sec.w + sec.h)) / FT });
          lv.runs.push({ item: key, pts: [[p.a[0], p.a[1]], [p.b[0], p.b[1]]] });
        } else {
          const where = p.kind === 'bend' ? p.p0 : p.kind === 'tee' ? p.at : p.a;
          const what = p.kind === 'valve' ? t('mep.valve.' + p.valve.kind) : t('mep.fit.' + p.kind + (r.kind === 'duct' && p.kind === 'reducer' ? '.duct' : ''));
          const sizeText = p.kind === 'reducer' ? sizeLabel(p.from) + ' × ' + sizeLabel(p.to) : p.kind === 'tee' ? sizeLabel(sec) + ' × ' + sizeLabel(p.branchSec) : sizeLabel(sec);
          const key = def(['fit', r.kind, r.system, p.kind, p.valve?.kind || '', sizeText, p.kind === 'bend' ? Math.round(p.th * 180 / Math.PI) : ''].join(':'), { name: what + ' ' + sizeText + (p.kind === 'bend' ? ' ' + Math.round(p.th * 180 / Math.PI) + '°' : '') + ', ' + systemLabel(r.kind, r.system), type: 'count' });
          lv.counts.push({ item: key, at: [where[0], where[1]] });
        }
      });
    }
  }

  A = modelUi.extend({
    tools: ['pipe', 'duct', 'valve'],
    hint: (name) => 'mep.hint.' + name,
    typed: () => false,
    classes: /^Ifc(PipeSegment|PipeFitting|DuctSegment|DuctFitting|Valve|FlowSegment|FlowFitting|FlowController)$/,
    move(p, e) {
      if (A.S.tool === 'valve') { const n = runNear(p, 'pipe', A.pv().pxToMm(12)); R.valveHover = n ? { r: n.r, a: n.a } : null; return; }
      R.hover = at(p, e);
    },
    click(p, e) {
      if (A.S.tool === 'valve') {
        const n = runNear(p, 'pipe', A.pv().pxToMm(12));
        if (!n) { A.host.status(t('mep.err.nopipe'), true); return; }
        A.commit(addValve(n.r.guid, n.a.s, R.valve), { label: t('mep.valve.' + R.valve), verb: t('model.verb.placed'), reselect: partKeys(n.r.guid) });
        return;
      }
      const q = at(p, e);
      if (R.pts.length && Math.hypot(q[0] - R.pts.at(-1)[0], q[1] - R.pts.at(-1)[1]) < 1 && !R.snapRun) return;
      addPoint(q);
      if (R.pts.length) hint(A.S.tool === 'duct' ? 'mep.hint.duct2' : 'mep.hint.pipe2');
    },
    dbl() { if (A.S.tool !== 'valve') finish(); },
    key(e) {
      if (A.S.tool === 'valve') return false;
      if (e.key === 'Enter' && R.pts.length) { finish(); return true; }
      if (e.key === 'Backspace' && R.pts.length) { R.pts.pop(); return true; }
      return false;
    },
    escape() { if (R.pts.length) { R.pts = []; hint('mep.hint.' + A.S.tool); return true; } return false; },
    toolChanged(name) { R.pts = []; R.hover = null; R.valveHover = null; bindRows(); if (['pipe', 'duct', 'valve'].includes(name)) { const m = A.root.querySelector('[data-res-tools]'); if (m?.open) m.open = false; } },
    refresh() { read(); bindRows(); },
    ownKeys(set, k) { for (const r of R.runs) for (const p of r.parts) set.add(k + p); },
    snapCtx(ctx) { ctx.points = [...(ctx.points || []), ...R.runs.filter((r) => visible(r)).flatMap((r) => [r.verts[0], r.verts[r.verts.length - 1]].map((v) => [v[0], v[1]]))]; },
    scene,
    overlay(o) {
      if (A.S.tool === 'valve') {
        if (R.valveHover) { const q = R.valveHover.a.at; o.snap = { p: [q[0], q[1]], kind: 'mid' }; o.hud = { p: [q[0], q[1]], text: t('mep.valve.' + R.valve) + '\n' + L(R.valveHover.a.s) }; }
        return;
      }
      if (!['pipe', 'duct'].includes(A.S.tool)) return;
      if (R.hover) o.snap = { p: R.hover, kind: R.snapRun ? (R.snapRun.kind === 'end' ? 'end' : 'mid') : 'free' };
      if (R.pts.length) {
        const pts = R.hover ? [...R.pts.map((q) => [q[0], q[1]]), R.hover] : R.pts.map((q) => [q[0], q[1]]);
        for (let i = 0; i + 1 < pts.length; i++) o.lines.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]);
        for (const q of R.pts) o.points.push([q[0], q[1]]);
        if (R.hover) { const l = R.pts.at(-1); o.hud = { p: R.hover, text: L(Math.hypot(R.hover[0] - l[0], R.hover[1] - l[1])) + '\n' + t('mep.hud.z', { z: L(R.snapRun ? R.snapRun.z : opts().z) }) }; }
      } else if (R.hover) o.hud = { p: R.hover, text: t('mep.hud.start', { z: L(R.snapRun ? R.snapRun.z : opts().z) }) };
    },
    pick(key) { const r = runOfKey(key); return r ? { kind: 'mep', guid: r.guid, label: t(r.kind === 'duct' ? 'mep.run.duct' : 'mep.run.pipe') } : null; },
    props,
    remove(items) { return removeRuns([...new Set(items.map((x) => x.guid))]); },
    schedules,
    scheduleKeys,
    takeoffExtra,
  });
  // the Schedules panel gets pipes, ducts and fittings
  const schedSel = A.root.querySelector('[data-msched-kind]');
  if (schedSel && !schedSel.querySelector('option[value="pipes"]')) schedSel.append(el('option', { value: 'pipes' }, t('model.sch.pipes')), el('option', { value: 'ducts' }, t('model.sch.ducts')), el('option', { value: 'mepfit' }, t('model.sch.mepfit')));
  if (typeof window !== 'undefined') window.bimcraftMep = { state: R, api: A };   // for tests
  return { state: R };
}
