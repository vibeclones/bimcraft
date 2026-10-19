/* SPDX-License-Identifier: Apache-2.0 */
/**
 * mep-model.js — pipe and duct runs (0.6 DF.29, session `bim-draw`; the spike is docs/spikes/bimcraft-mep.md). No DOM:
 * bin/test-bimcraft.mjs --mep runs it in Node. Plan mm in the storey's own axes; z = the centre line's height above the level.
 *
 * A RUN is what a person draws: a centre line by clicks at a height, with one size, a material and class (pipes) or a shape
 * and size (ducts), and a system. It is an IfcElementAssembly (.USERDEFINED. "Pipe run" / "Duct run") contained in its
 * level, holding its definition in CadCraft_MepRun, and aggregating what is made from it — never edited by hand, made again
 * whenever any run of that level changes (as walls' joins are):
 *   - straight SEGMENTS: IfcPipeSegment / IfcDuctSegment .RIGIDSEGMENT. (IFC2X3 IfcFlowSegment), an extruded profile
 *     (pipes a ring of the table's OD and wall; ducts a circle, rectangle or flat oval), plus an 'Axis' line;
 *   - FITTINGS made by themselves: an ELBOW where the line turns (.BEND., a revolved profile; steel pipe at the ASME B16.9
 *     long radius, other pipe at one OD, round duct at 1.5 D, rectangular duct at one width — or one height for a turn up or
 *     down), a TEE where a run ends on another run's line (.JUNCTION.; the host is split there), a REDUCER / TRANSITION where
 *     two runs meet end to end at different sizes (.TRANSITION.; round = revolved, else a lofted faceted body), an elbow
 *     where two runs of one size meet end to end at an angle; IFC2X3 IfcFlowFitting;
 *   - VALVES placed on a pipe (IfcValve .ISOLATING. gate / ball, .REGULATING. globe, .CHECK. check; IFC2X3
 *     IfcFlowController): generic bodies sized from the pipe (no maker's dimensions: the help says so).
 * Every part has its ports (IfcDistributionPort, nested — IFC2X3: IfcRelConnectsPortToElement — SINK at its upstream
 * end, SOURCE at the others, PIPE / DUCT, the system's type) and touching ports are connected (IfcRelConnectsPorts). Parts
 * are assigned to their system: IfcDistributionSystem (IFC2X3 IfcSystem, ObjectType = the IFC4 name) found by
 * CadCraft_MepSystem.Key or made, serving the building (IfcRelServicesBuildings), dropped when nothing is left in it. Each
 * part has its type (IfcPipeSegmentType "Copper pipe, type L", IfcPipeFittingType "Elbow", …), material, a surface colour
 * per system, CadCraft_Pipe / CadCraft_Duct / CadCraft_MepFitting / CadCraft_Valve, and for segments Pset_PipeSegmentTypeCommon
 * (pipes) and Qto_PipeSegmentBaseQuantities / Qto_DuctSegmentBaseQuantities.
 * Slope (drains): a run falls by `slope` (rise per run) along its horizontal length from its first point; sanitary and
 * storm systems start at the International Plumbing Code minimum for the size (tables.js minDrainSlope).
 *
 *   PIPE_SYSTEMS, DUCT_SYSTEMS, VALVE_KINDS, RUN_PSET
 *   sectionOf(run) → { kind, round, od, wall, w, h, shape, label } | null      runVertices(run) → [[x, y, z]] (slope applied)
 *   mepLayout(runs) → { runs: Map(guid → { parts }), error? }   pure: what the runs make (parts with their ends)
 *   readRuns(w) · placeRun(spec) → op · changeRun(guid, ch) → op · removeRuns(guids) → op · addValve(guid, at, kind) → op
 *   regenMep(w, storey) · runSchedules(w) → { pipes, ducts, fittings } rows · pipeForFlow(mat, cls, q, vmax) · ductForFlow(…)
 *   Errors: mep.err.points, mep.err.size, mep.err.back (a run doubling back on itself), mep.err.short (a leg too short for its
 *   fittings), mep.err.valve, mep.err.none.
 */
import { op } from './model-ops.js';
import { ids, val } from './ifc-util.js';
import { round } from './model-write.js';
import { t as tr } from './i18n.js';
import { pipeSize, bendRadius, minDrainSlope, DEFAULT_CLASS, sizesFor } from './mep/tables.js';
import { sizeSection, sectionLoss } from './mep/sizing.js';

export const RUN_PSET = 'CadCraft_MepRun';
const SYS_PSET = 'CadCraft_MepSystem';
const IN = 25.4;
/** Pipe systems: the IFC4 system type, the plan colour (a page token), the surface colour in the file, the usual material. */
export const PIPE_SYSTEMS = {
  cw: { ifc: 'DOMESTICCOLDWATER', token: '--layer-blue', rgb: [0.10, 0.44, 0.76], mat: 'copper' },
  hw: { ifc: 'DOMESTICHOTWATER', token: '--layer-red', rgb: [0.88, 0.19, 0.19], mat: 'copper' },
  hwr: { ifc: 'DOMESTICHOTWATER', token: '--layer-orange', rgb: [0.94, 0.55, 0.0], mat: 'copper' },
  san: { ifc: 'SEWAGE', token: '--layer-ochre', rgb: [0.55, 0.35, 0.17], mat: 'pvc', drain: true },
  vent: { ifc: 'VENT', token: '--ink-2', rgb: [0.53, 0.56, 0.59], mat: 'pvc' },
  storm: { ifc: 'STORMWATER', token: '--layer-cyan', rgb: [0.05, 0.52, 0.60], mat: 'pvc', drain: true },
  chw: { ifc: 'CHILLEDWATER', token: '--layer-violet', rgb: [0.23, 0.36, 0.86], mat: 'steel' },
  hhw: { ifc: 'HEATING', token: '--layer-magenta', rgb: [0.76, 0.15, 0.36], mat: 'steel' },
  gas: { ifc: 'GAS', token: '--layer-ochre', rgb: [0.98, 0.69, 0.02], mat: 'steel' },
  fire: { ifc: 'FIREPROTECTION', token: '--layer-red', rgb: [0.85, 0.28, 0.06], mat: 'steel' },
};
export const DUCT_SYSTEMS = {
  supply: { ifc: 'AIRCONDITIONING', token: '--layer-blue', rgb: [0.11, 0.49, 0.84] },
  return: { ifc: 'VENTILATION', token: '--layer-green', rgb: [0.22, 0.70, 0.29] },
  exhaust: { ifc: 'EXHAUST', token: '--layer-orange', rgb: [0.96, 0.62, 0.0] },
  outside: { ifc: 'VENTILATION', token: '--layer-cyan', rgb: [0.08, 0.67, 0.75] },
};
export const VALVE_KINDS = { gate: 'ISOLATING', ball: 'ISOLATING', globe: 'REGULATING', check: 'CHECK' };
export const DUCT_SHAPES = ['round', 'rect', 'oval'];
const refuse = (key) => { throw Object.assign(new Error(key), { key }); };

// ---- vectors ----
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dist = (a, b) => len(sub(a, b));
/** A horizontal direction across a leg (its "width" side), carried over from a neighbour on a vertical leg. */
const across = (d, prev) => (Math.abs(d[2]) < 0.9 ? norm([-d[1], d[0], 0]) : prev || [1, 0, 0]);

/** The section a run is drawn with (mm), or null when that size is not made. */
export function sectionOf(r) {
  if (r.kind === 'pipe') {
    const p = pipeSize(r.mat, r.cls, r.size);
    if (!p) return null;
    return { kind: 'pipe', round: true, shape: 'round', od: p.od * IN, wall: p.wall * IN, id: p.id * IN, nps: p.nps, w: p.od * IN, h: p.od * IN, R: bendRadius(p) * IN, label: p.size + '"', p };
  }
  const w = Number(r.w), h = r.shape === 'round' ? w : Number(r.h);
  if (!(w >= 50) || !(h >= 50) || !DUCT_SHAPES.includes(r.shape)) return null;
  if (r.shape === 'oval' && !(w > h)) return null;
  return { kind: 'duct', round: r.shape === 'round', shape: r.shape, od: r.shape === 'round' ? w : null, w, h, label: r.shape === 'round' ? 'Ø' + Math.round(w) : Math.round(w) + '×' + Math.round(h) };   // i18n-ignore: size marks
}
/** The bend's centre-line radius for a turn from d1 to d2 (mm). */
function bendR(sec, d1, d2) {
  if (sec.kind === 'pipe') return sec.R;
  if (sec.round) return 1.5 * sec.w;
  const m = cross(d1, d2);
  return Math.abs(norm(m)[2]) > 0.7 ? sec.w : sec.h;   // a turn in plan bends across the width; up or down across the height
}

/** The run's corners with its slope applied (it falls from its first point along its horizontal length). */
export function runVertices(r) {
  const out = [];
  let fall = 0;
  for (let i = 0; i < r.points.length; i++) {
    const q = r.points[i];
    if (i) { const p = r.points[i - 1]; fall += (r.slope || 0) * Math.hypot(q[0] - p[0], q[1] - p[1]); }
    out.push([q[0], q[1], (q[2] || 0) - fall]);
  }
  // corners on one spot count once
  return out.filter((q, i) => !i || dist(q, out[i - 1]) > 0.5);
}

/** A bend at corner P from direction d1 to d2 with radius R: its two tangent points, centre and angle. */
function bendAt(P, d1, d2, R) {
  const c = Math.max(-1, Math.min(1, dot(d1, d2))), th = Math.acos(c);
  const T = R * Math.tan(th / 2);
  const n = norm(sub(d2, mul(d1, c)));
  const p0 = sub(P, mul(d1, T)), p1 = add(P, mul(d2, T));
  return { p0, p1, center: add(p0, mul(n, R)), n, th, T, R, d1, d2 };
}

/**
 * What the runs of one level make. runs: [{ guid, kind, system, sec, verts, valves: [{ s (mm along the run), kind }] }]
 * → { runs: Map(guid → { parts: [part] }), error } where a part is
 *   { kind: 'segment', a, b, d, wd }  { kind: 'bend', p0, p1, center, n, th, R, d1, d2, wd }  { kind: 'tee', at, d, bd, m, mb, wd, branch }
 *   { kind: 'reducer', a, b, d, wd, from, to }  { kind: 'valve', a, b, d, wd, valve }
 * and every part has `ports`: [{ p, out (unit, outward), flow: 'SINK' | 'SOURCE' }].
 */
export function mepLayout(runs) {
  const R = runs.filter((r) => r.sec && r.verts.length >= 2);
  const out = new Map(R.map((r) => [r.guid, { parts: [] }]));
  const tolOf = (r) => Math.max(5, Math.min(r.sec.w, r.sec.h) * 0.3);
  const legs = (r) => r.verts.slice(1).map((b, i) => { const a = r.verts[i], L = dist(a, b); return { a, b, L, d: norm(sub(b, a)) }; });
  for (const r of R) { r.legs = legs(r); if (r.legs.some((l) => l.L < 1)) return { runs: out, error: 'mep.err.points' }; }
  // ---- where runs meet: end to end, or an end on another run's line (a tee) ----
  const endAt = (r, e) => (e === 0 ? r.verts[0] : r.verts[r.verts.length - 1]);
  const joins = [], tees = [];
  const used = new Set();
  for (const r of R) for (const e of [0, 1]) {
    const P = endAt(r, e), key = r.guid + ':' + e;
    if (used.has(key)) continue;
    let done = false;
    for (const o of R) {
      if (o === r || o.kind !== r.kind) continue;
      for (const f of [0, 1]) {
        if (used.has(o.guid + ':' + f)) continue;
        if (dist(P, endAt(o, f)) <= Math.max(tolOf(r), tolOf(o))) { joins.push({ a: { r, e }, b: { r: o, e: f } }); used.add(key); used.add(o.guid + ':' + f); done = true; break; }
      }
      if (done) break;
    }
    if (done) continue;
    for (const o of R) {
      if (o === r || o.kind !== r.kind) continue;
      for (let i = 0; i < o.legs.length; i++) {
        const l = o.legs[i], s = dot(sub(P, l.a), l.d);
        if (s <= 1 || s >= l.L - 1) continue;
        const foot = add(l.a, mul(l.d, s));
        if (dist(P, foot) <= Math.max(tolOf(r), o.sec.w / 2)) { tees.push({ host: o, leg: i, s, at: foot, branch: r, e }); used.add(key); done = true; break; }
      }
      if (done) break;
    }
  }
  // ---- trims: how much each leg loses at its start and end, and where it is split ----
  for (const r of R) { r.trim = r.legs.map(() => [0, 0]); r.cuts = r.legs.map(() => []); r.bends = []; r.endFit = [null, null]; }
  const fail = (k) => ({ runs: out, error: k });
  // elbows at a run's own corners
  for (const r of R) {
    let wd = across(r.legs[0].d, null);
    r.wds = r.legs.map((l) => (wd = across(l.d, wd)));
    for (let i = 1; i < r.verts.length - 1; i++) {
      const d1 = r.legs[i - 1].d, d2 = r.legs[i].d, c = dot(d1, d2);
      if (c > Math.cos(0.5 * Math.PI / 180)) continue;   // straight on: no fitting
      if (c < Math.cos(179 * Math.PI / 180)) return fail('mep.err.back');
      const b = bendAt(r.verts[i], d1, d2, bendR(r.sec, d1, d2));
      r.trim[i - 1][1] += b.T; r.trim[i][0] += b.T;
      r.bends.push({ i, b });
    }
  }
  // end to end: an elbow (one size, turning), a reducer (two sizes) or nothing (one size, straight on)
  const sameSize = (a, b) => a.shape === b.shape && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
  for (const j of joins) {
    // the fitting belongs to the run that ENDS at the joint and flows into the other one; else the first by GlobalId
    let A = j.a, B = j.b;
    if (!(A.e === 1 && B.e === 0) && ((B.e === 1 && A.e === 0) || B.r.guid < A.r.guid)) [A, B] = [B, A];
    const legA = A.e === 1 ? A.r.legs.length - 1 : 0, legB = B.e === 1 ? B.r.legs.length - 1 : 0;
    const dA = A.e === 1 ? A.r.legs[legA].d : mul(A.r.legs[legA].d, -1);   // into the joint
    const dB = B.e === 0 ? B.r.legs[legB].d : mul(B.r.legs[legB].d, -1);   // out of the joint
    const P = endAt(A.r, A.e);
    if (!sameSize(A.r.sec, B.r.sec)) {
      const big = Math.max(A.r.sec.w, A.r.sec.h, B.r.sec.w, B.r.sec.h);
      const Lr = A.r.kind === 'pipe' ? Math.max(38, big) : Math.max(150, Math.max(Math.abs(A.r.sec.w - B.r.sec.w), Math.abs(A.r.sec.h - B.r.sec.h)) / 2 / Math.tan(15 * Math.PI / 180));
      A.r.trim[legA][A.e === 1 ? 1 : 0] += Lr;
      A.r.endFit[A.e] = { kind: 'reducer', a: sub(P, mul(dA, Lr)), b: P, d: dA, from: A.r.sec, to: B.r.sec };
      continue;
    }
    if (dot(dA, dB) > Math.cos(0.5 * Math.PI / 180)) continue;
    if (dot(dA, dB) < Math.cos(179 * Math.PI / 180)) return fail('mep.err.back');
    const b = bendAt(P, dA, dB, bendR(A.r.sec, dA, dB));
    A.r.trim[legA][A.e === 1 ? 1 : 0] += b.T; B.r.trim[legB][B.e === 0 ? 0 : 1] += b.T;
    A.r.endFit[A.e] = { kind: 'bend', b };
  }
  // tees: the host is split round the joint, the branch stops short of it
  for (const t of tees) {
    const h = t.host.sec, b = t.branch.sec;
    const m = Math.max(25, 0.5 * Math.max(b.w, b.h) + 0.25 * Math.max(h.w, h.h)), mb = Math.max(25, 0.5 * Math.max(h.w, h.h) + 0.25 * Math.max(b.w, b.h));
    t.host.cuts[t.leg].push({ s: t.s, half: m, kind: 'tee', tee: t, m, mb });
    const legB = t.e === 1 ? t.branch.legs.length - 1 : 0;
    t.branch.trim[legB][t.e === 1 ? 1 : 0] += mb;
    t.bd = norm(sub(t.e === 1 ? t.branch.verts[t.branch.verts.length - 2] : t.branch.verts[1], t.at));   // from the joint out along the branch
  }
  // valves on pipes, by distance along the run
  for (const r of R) for (const v of r.valves || []) {
    if (r.kind !== 'pipe') return fail('mep.err.valve');
    let s = v.s, i = 0;
    while (i < r.legs.length && s > r.legs[i].L) { s -= r.legs[i].L; i++; }
    if (i >= r.legs.length) return fail('mep.err.valve');
    const Lv = Math.max(75, 2.5 * r.sec.od);
    r.cuts[i].push({ s, half: Lv / 2, kind: 'valve', valve: v });
  }
  // ---- the parts, in order along each run ----
  for (const r of R) {
    const parts = out.get(r.guid).parts;
    const push = (p) => parts.push(p);
    if (r.endFit[0]) push(endPart(r.endFit[0], r.wds[0], 0));
    for (let i = 0; i < r.legs.length; i++) {
      const l = r.legs[i], wd = r.wds[i];
      const bend = r.bends.find((x) => x.i === i);
      if (bend) push({ kind: 'bend', ...bend.b, wd: r.wds[i - 1] });
      // pieces between the trims and the cuts
      const cuts = r.cuts[i].slice().sort((a, b) => a.s - b.s);
      let s0 = r.trim[i][0];
      for (const c of cuts) {
        const s1 = c.s - c.half;
        if (s1 - s0 < 1) return fail('mep.err.short');
        push({ kind: 'segment', a: add(l.a, mul(l.d, s0)), b: add(l.a, mul(l.d, s1)), d: l.d, wd });
        const a = add(l.a, mul(l.d, c.s - c.half)), b = add(l.a, mul(l.d, c.s + c.half));
        if (c.kind === 'tee') push({ kind: 'tee', at: c.tee.at, d: l.d, bd: c.tee.bd, m: c.m, mb: c.mb, wd, branchGuid: c.tee.branch.guid, branchSec: c.tee.branch.sec, a, b });
        else push({ kind: 'valve', a, b, d: l.d, wd, valve: c.valve });
        s0 = c.s + c.half;
      }
      const s1 = l.L - r.trim[i][1];
      if (s1 - s0 < 1) return fail('mep.err.short');
      push({ kind: 'segment', a: add(l.a, mul(l.d, s0)), b: add(l.a, mul(l.d, s1)), d: l.d, wd });
    }
    if (r.endFit[1]) push(endPart(r.endFit[1], r.wds[r.wds.length - 1], 1));
    for (const p of parts) p.ports = portsOf(p);
  }
  return { runs: out };
}
function endPart(f, wd, e) {
  if (f.kind === 'bend') return { kind: 'bend', ...f.b, wd };
  // a reducer at the run's start points into the run: turn it round so it runs from the other run to this one
  return e === 1 ? { kind: 'reducer', a: f.a, b: f.b, d: f.d, wd, from: f.from, to: f.to } : { kind: 'reducer', a: f.b, b: f.a, d: mul(f.d, -1), wd, from: f.to, to: f.from };
}
function portsOf(p) {
  if (p.kind === 'segment' || p.kind === 'reducer' || p.kind === 'valve') return [{ p: p.a, out: mul(p.d, -1), flow: 'SINK' }, { p: p.b, out: p.d, flow: 'SOURCE' }];
  if (p.kind === 'bend') return [{ p: p.p0, out: mul(p.d1, -1), flow: 'SINK' }, { p: p.p1, out: p.d2, flow: 'SOURCE' }];
  return [{ p: sub(p.at, mul(p.d, p.m)), out: mul(p.d, -1), flow: 'SINK' }, { p: add(p.at, mul(p.d, p.m)), out: p.d, flow: 'SOURCE' }, { p: add(p.at, mul(p.bd, p.mb)), out: p.bd, flow: 'SOURCE' }];
}

// ---- reading ----
const mmOf = (w, v) => (Number(v) || 0) * w.unitMm;
function aggKids(w, id) {
  for (const rid of ids(w.api, w.mid, 'IFCRELAGGREGATES')) { const r = w.api.GetLine(w.mid, rid, false); if (r.RelatingObject?.value === id) return (r.RelatedObjects || []).map((h) => h.value); }
  return [];
}
/** Points (and valves) from the file: untrusted JSON, checked. */
function readJson(s, fallback) { try { const v = JSON.parse(String(s || '')); return v ?? fallback; } catch (e) { return fallback; } }
const okPoints = (p) => Array.isArray(p) && p.length >= 2 && p.length <= 500 && p.every((q) => Array.isArray(q) && q.length >= 2 && q.slice(0, 3).every((x) => Number.isFinite(x) && Math.abs(x) < 1e8));
export function readRuns(w) {
  const out = [];
  let list = [];
  try { list = ids(w.api, w.mid, 'IFCELEMENTASSEMBLY'); } catch (e) { return out; }
  const so = w.storeyOf();
  for (const id of list) {
    const ps = w.readPset(id, RUN_PSET);
    if (!ps) continue;
    const points = readJson(ps.PointsMm, null);
    if (!okPoints(points)) continue;
    const valves = readJson(ps.Valves, []);
    const kind = ps.Kind === 'duct' ? 'duct' : 'pipe';
    out.push({
      id, guid: val(w.api.GetLine(w.mid, id, false).GlobalId), storey: so.get(id), kind, system: String(ps.System || (kind === 'pipe' ? 'cw' : 'supply')),
      points: points.map((q) => [q[0], q[1], q[2] || 0]), mat: String(ps.Material || ''), cls: String(ps.Class || ''), size: String(ps.Size || ''),
      shape: DUCT_SHAPES.includes(ps.Shape) ? ps.Shape : 'rect', w: mmOf(w, ps.Width), h: mmOf(w, ps.Height), slope: Number(ps.Slope) || 0, flow: Number(ps.Flow) || 0,
      valves: Array.isArray(valves) ? valves.filter((v) => v && Number.isFinite(v.s) && VALVE_KINDS[v.kind]).map((v) => ({ s: v.s, kind: v.kind })) : [],
      parts: aggKids(w, id),
    });
  }
  return out;
}

// ---- writing ----
/** The run's definition into its CadCraft_MepRun (mm in the points; lengths in file units). */
function writeDef(w, id, r) {
  if (!okPoints(r.points)) refuse('mep.err.points');
  if (!sectionOf(r)) refuse('mep.err.size');
  const Lm = (k, v) => [k, 'IFCLENGTHMEASURE', round(w.u(v || 0))];
  w.upsertPset(id, RUN_PSET, [['Kind', 'IFCLABEL', r.kind], ['System', 'IFCLABEL', r.system], ['PointsMm', 'IFCTEXT', JSON.stringify(r.points.map((q) => q.map((x) => round(x, 3))))],
    ['Material', 'IFCLABEL', r.mat || ''], ['Class', 'IFCLABEL', r.cls || ''], ['Size', 'IFCLABEL', r.size || ''], ['Shape', 'IFCLABEL', r.kind === 'duct' ? r.shape : ''],
    Lm('Width', r.kind === 'duct' ? r.w : 0), Lm('Height', r.kind === 'duct' ? r.h : 0), ['Slope', 'IFCREAL', round(r.slope || 0, 9)], ['Flow', 'IFCREAL', round(r.flow || 0, 6)],
    ['Valves', 'IFCTEXT', JSON.stringify((r.valves || []).map((v) => ({ s: round(v.s, 3), kind: v.kind })))]]);
}
/** Plane angles in the file's own unit (radians unless the project says degrees). */
function angleUnit(w) {
  if (w._angleK !== undefined) return w._angleK;
  let k = 1;
  try { for (const id of ids(w.api, w.mid, 'IFCCONVERSIONBASEDUNIT')) { const u = w.api.GetLine(w.mid, id, false); if (String(val(u.UnitType)) === 'PLANEANGLEUNIT' && /deg/i.test(String(val(u.Name)))) k = 180 / Math.PI; } } catch (e) { /* radians */ }
  return (w._angleK = k);
}
const perp = (d) => (Math.abs(d[2]) < 0.9 ? norm(cross([0, 0, 1], d)) : [1, 0, 0]);

/** Profiles (mm) for a section, in a frame whose X is the width side. */
function profileFor(w, sec) {
  const ctr = () => w.make('IFCAXIS2PLACEMENT2D', w.H(w.point2(0, 0)), null);
  if (sec.kind === 'pipe') return w.make('IFCCIRCLEHOLLOWPROFILEDEF', 'AREA', w.L(sec.label), w.H(ctr()), round(w.u(sec.od / 2)), round(w.u(sec.wall)));
  if (sec.shape === 'round') return w.make('IFCCIRCLEPROFILEDEF', 'AREA', w.L(sec.label), w.H(ctr()), round(w.u(sec.w / 2)));
  if (sec.shape === 'rect') return w.make('IFCRECTANGLEPROFILEDEF', 'AREA', w.L(sec.label), w.H(ctr()), round(w.u(sec.w)), round(w.u(sec.h)));
  return w.profile(ovalOutline(sec.w, sec.h, 12), sec.label);
}
/** A flat oval's outline (w across, h high), semicircle ends of n pieces. */
function ovalOutline(W, H, n) {
  const r = H / 2, c = W / 2 - r, pts = [];
  for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + Math.PI * i / n; pts.push([c + r * Math.cos(a), r * Math.sin(a)]); }
  for (let i = 0; i <= n; i++) { const a = Math.PI / 2 + Math.PI * i / n; pts.push([-c + r * Math.cos(a), r * Math.sin(a)]); }
  return pts;
}
/** A section's outline as N points (mm, in the across / up plane), for lofting transitions. */
function outlinePts(sec, N = 24) {
  if (sec.round) { const r = sec.w / 2; return Array.from({ length: N }, (_, i) => [r * Math.cos(2 * Math.PI * i / N), r * Math.sin(2 * Math.PI * i / N)]); }
  const ring = sec.shape === 'oval' ? ovalOutline(sec.w, sec.h, 12) : [[sec.w / 2, -sec.h / 2], [sec.w / 2, sec.h / 2], [-sec.w / 2, sec.h / 2], [-sec.w / 2, -sec.h / 2]];
  // even spacing round the outline, starting at the right-hand middle as the round one does
  const P = [...ring, ring[0]], segL = P.slice(1).map((q, i) => Math.hypot(q[0] - P[i][0], q[1] - P[i][1])), tot = segL.reduce((a, b) => a + b, 0);
  const start = sec.shape === 'oval' ? 0 : 0.5 * segL[0];
  const at = (s) => { s = ((s % tot) + tot) % tot; for (let i = 0; i < segL.length; i++) { if (s <= segL[i]) { const u = s / segL[i]; return [P[i][0] + (P[i + 1][0] - P[i][0]) * u, P[i][1] + (P[i + 1][1] - P[i][1]) * u]; } s -= segL[i]; } return P[0]; };
  return Array.from({ length: N }, (_, i) => at(start + tot * i / N));
}
/** Body items of one part (mm, storey axes). */
function bodyOf(w, part, sec) {
  const frame = (o, d, wd) => w.axisFrame(o, d, wd);
  if (part.kind === 'segment') return { type: 'SweptSolid', items: [w.extrudeAt(profileFor(w, sec), frame(part.a, part.d, part.wd), dist(part.a, part.b))] };
  if (part.kind === 'bend') {
    // revolve the section about an axis R off to the side; X of the profile = the width side
    const Y = cross(part.d1, part.wd), loc = [dot(part.n, part.wd) * part.R, dot(part.n, Y) * part.R, 0], a = cross(part.d1, part.n), ax = [dot(a, part.wd), dot(a, Y), 0];
    const axis = w.make('IFCAXIS1PLACEMENT', w.H(w.point3(round(w.u(loc[0])), round(w.u(loc[1])), 0)), w.H(w.dir(round(ax[0], 12), round(ax[1], 12), 0)));
    return { type: 'SweptSolid', items: [w.make('IFCREVOLVEDAREASOLID', w.H(profileFor(w, sec)), w.H(frame(part.p0, part.d1, part.wd)), w.H(axis), round(part.th * angleUnit(w), 9))] };
  }
  if (part.kind === 'tee') {
    const bsec = part.branchSec;
    const run = w.extrudeAt(profileFor(w, sec), frame(sub(part.at, mul(part.d, part.m)), part.d, part.wd), 2 * part.m);
    const bwd = across(part.bd, part.wd);
    const br = w.extrudeAt(profileFor(w, bsec), frame(part.at, part.bd, bwd), part.mb);
    return { type: 'SweptSolid', items: [run, br] };
  }
  if (part.kind === 'reducer') {
    const L = dist(part.a, part.b);
    if (part.from.round && part.to.round) {
      // round: a ring (or disc) of the wall revolved about the centre line
      const r1 = part.from.w / 2, r2 = part.to.w / 2;
      const pts = sec.kind === 'pipe' ? [[0, r1 - part.from.wall], [0, r1], [L, r2], [L, r2 - part.to.wall]] : [[0, 0], [0, r1], [L, r2], [L, 0]];
      const pos = w.axisFrame(part.a, part.wd, part.d);   // profile X along the run, Z across: the axis is the profile's X
      const axis = w.make('IFCAXIS1PLACEMENT', w.H(w.point3(0, 0, 0)), w.H(w.dir(1, 0, 0)));
      return { type: 'SweptSolid', items: [w.make('IFCREVOLVEDAREASOLID', w.H(w.profile(pts)), w.H(pos), w.H(axis), round(2 * Math.PI * angleUnit(w), 9))] };
    }
    return { type: 'Brep', items: [loft(w, part, outlinePts(part.from), outlinePts(part.to))] };
  }
  // a valve: a body of two cones (bow tie) round the pipe, a stem and a handwheel (gate, globe) or a lever (ball)
  const L = dist(part.a, part.b), r = sec.od / 2 * 1.25, kind = part.valve.kind;
  const pos = w.axisFrame(part.a, part.wd, part.d);
  const axis = w.make('IFCAXIS1PLACEMENT', w.H(w.point3(0, 0, 0)), w.H(w.dir(1, 0, 0)));
  const prof = kind === 'ball' ? [[0, 0], [0, r * 0.8], [L * 0.2, r * 0.8], [L * 0.5, r * 1.15], [L * 0.8, r * 0.8], [L, r * 0.8], [L, 0]] : [[0, 0], [0, r], [L / 2, r * 0.35], [L, r], [L, 0]];
  const items = [w.make('IFCREVOLVEDAREASOLID', w.H(w.profile(prof)), w.H(pos), w.H(axis), round(2 * Math.PI * angleUnit(w), 9))];
  const mid = add(part.a, mul(part.d, L / 2)), up = Math.abs(part.d[2]) < 0.9 ? [0, 0, 1] : part.wd;
  if (kind !== 'check') {
    const ring = () => w.make('IFCCIRCLEPROFILEDEF', 'AREA', null, w.H(w.make('IFCAXIS2PLACEMENT2D', w.H(w.point2(0, 0)), null)), round(w.u(r * 0.15)));
    items.push(w.extrudeAt(ring(), w.axisFrame(mid, up, perp(up)), r * 1.6));
    if (kind === 'ball') items.push(w.extrudeAt(w.profile([[0, -r * 0.12], [L * 1.1, -r * 0.12], [L * 1.1, r * 0.12], [0, r * 0.12]]), w.axisFrame(add(mid, mul(up, r * 1.6)), up, part.d), r * 0.15));
    else {
      const wheel = w.make('IFCCIRCLEPROFILEDEF', 'AREA', null, w.H(w.make('IFCAXIS2PLACEMENT2D', w.H(w.point2(0, 0)), null)), round(w.u(r * 0.9)));
      items.push(w.extrudeAt(wheel, w.axisFrame(add(mid, mul(up, r * 1.6)), up, perp(up)), Math.max(6, r * 0.15)));
    }
  }
  return { type: 'SweptSolid', items };
}
/** A faceted body lofted between two outlines of N points each (a duct transition). */
function loft(w, part, A, B) {
  const Y = cross(part.d, part.wd), at = (o, q) => add(add(o, mul(part.wd, q[0])), mul(Y, q[1]));
  const pa = A.map((q) => at(part.a, q)), pb = B.map((q) => at(part.b, q)), N = pa.length;
  const P = (q) => w.H(w.point3(round(w.u(q[0])), round(w.u(q[1])), round(w.u(q[2]))));
  const face = (pts) => w.H(w.make('IFCFACE', [w.H(w.make('IFCFACEOUTERBOUND', w.H(w.make('IFCPOLYLOOP', pts.map(P))), w.T('IFCBOOLEAN', true)))]));
  const faces = [face(pa.slice().reverse()), face(pb)];
  for (let i = 0; i < N; i++) { const j = (i + 1) % N; faces.push(face([pa[i], pa[j], pb[j], pb[i]])); }
  return w.make('IFCFACETEDBREP', w.H(w.make('IFCCLOSEDSHELL', faces)));
}

const MAT_NAMES = { steel: 'mep.mat.steel', copper: 'mep.mat.copper', pvc: 'mep.mat.pvc', pex: 'mep.mat.pex' };
const sysOf = (r) => (r.kind === 'pipe' ? PIPE_SYSTEMS[r.system] : DUCT_SYSTEMS[r.system]) || (r.kind === 'pipe' ? PIPE_SYSTEMS.cw : DUCT_SYSTEMS.supply);
export const systemLabel = (kind, key) => tr('mep.sys.' + (kind === 'pipe' ? (PIPE_SYSTEMS[key] ? key : 'cw') : (DUCT_SYSTEMS[key] ? key : 'supply')));
function typeOf(w, cls, name, predefined) {
  w._mepTypes ??= new Map();
  const k = cls + '|' + name;
  let id = w._mepTypes.get(k);
  if (id && w.api.GetLine(w.mid, id, false)) return id;
  id = null;
  try { for (const x of ids(w.api, w.mid, cls)) if (val(w.api.GetLine(w.mid, x, false).Name) === name) { id = x; break; } } catch (e) { /* none yet */ }
  if (!id) id = w.make(cls, w.guid(), w.ownerHistory(), w.L(name), null, null, null, null, null, null, predefined);
  w._mepTypes.set(k, id);
  return id;
}
/** The system of a run's parts: found by its key, else made (serving the building). */
function systemFor(w, r) {
  const key = r.kind + ':' + r.system;
  w._mepSys ??= new Map();
  let id = w._mepSys.get(key);
  if (id && w.api.GetLine(w.mid, id, false)) return id;
  const cls = w.v4 ? 'IFCDISTRIBUTIONSYSTEM' : 'IFCSYSTEM';
  id = null;
  try { for (const x of ids(w.api, w.mid, cls)) if (w.readPset(x, SYS_PSET)?.Key === key) { id = x; break; } } catch (e) { /* none */ }
  if (!id) {
    const S = sysOf(r), name = w.L(systemLabel(r.kind, r.system));
    id = w.v4 ? w.make(cls, w.guid(), w.ownerHistory(), name, null, null, null, S.ifc) : w.make(cls, w.guid(), w.ownerHistory(), name, null, w.L(S.ifc));
    w.upsertPset(id, SYS_PSET, [['Key', 'IFCLABEL', key], ['Kind', 'IFCLABEL', r.kind], ['SystemType', 'IFCLABEL', S.ifc]]);
    const b = ids(w.api, w.mid, 'IFCBUILDING')[0];
    if (b) w.make('IFCRELSERVICESBUILDINGS', w.guid(), w.ownerHistory(), null, null, w.H(id), [w.H(b)]);
  }
  w._mepSys.set(key, id);
  return id;
}
function assign(w, sys, parts) {
  if (!parts.length) return;
  // IFC4 lets a system have several assignments: each write gets its own (Live: no two people write one line); IFC2X3 one
  if (!w.v4) for (const rid of ids(w.api, w.mid, 'IFCRELASSIGNSTOGROUP')) {
    const r = w.api.GetLine(w.mid, rid, false);
    if (r.RelatingGroup?.value === sys) { const l = w.touch(rid); l.RelatedObjects = [...(l.RelatedObjects || []), ...parts.map((p) => w.H(p))]; w.write(l); return; }
  }
  w.make('IFCRELASSIGNSTOGROUP', w.guid(), w.ownerHistory(), null, null, parts.map((p) => w.H(p)), null, w.H(sys));
}
/** Our systems nothing is assigned to any more: dropped. */
function dropEmptySystems(w) {
  const cls = w.v4 ? 'IFCDISTRIBUTIONSYSTEM' : 'IFCSYSTEM';
  const held = new Set();
  for (const rid of ids(w.api, w.mid, 'IFCRELASSIGNSTOGROUP')) { const g = w.api.GetLine(w.mid, rid, false).RelatingGroup?.value; if (g) held.add(g); }
  const gone = [];
  try { for (const x of ids(w.api, w.mid, cls)) if (!held.has(x) && w.readPset(x, SYS_PSET)) gone.push(x); } catch (e) { /* none */ }
  if (gone.length) w.dropProduct(gone);
  w._mepSys = null;
}
/** The ports of these parts (nested, or IFC2X3's port-to-element relations). */
function portsOfParts(w, parts) {
  const set = new Set(parts), out = [];
  for (const rid of ids(w.api, w.mid, 'IFCRELNESTS')) { const r = w.api.GetLine(w.mid, rid, false); if (set.has(r.RelatingObject?.value)) for (const h of r.RelatedObjects || []) out.push(h.value); }
  try { for (const rid of ids(w.api, w.mid, 'IFCRELCONNECTSPORTTOELEMENT')) { const r = w.api.GetLine(w.mid, rid, false); if (set.has(r.RelatedElement?.value)) out.push(r.RelatingPort.value); } } catch (e) { /* IFC4 files may have none */ }
  return out;
}

const PART_CLASS = {
  pipe: { segment: ['IFCPIPESEGMENT', 'RIGIDSEGMENT', 'IFCPIPESEGMENTTYPE'], bend: ['IFCPIPEFITTING', 'BEND', 'IFCPIPEFITTINGTYPE'], tee: ['IFCPIPEFITTING', 'JUNCTION', 'IFCPIPEFITTINGTYPE'], reducer: ['IFCPIPEFITTING', 'TRANSITION', 'IFCPIPEFITTINGTYPE'], valve: ['IFCVALVE', null, 'IFCVALVETYPE'] },
  duct: { segment: ['IFCDUCTSEGMENT', 'RIGIDSEGMENT', 'IFCDUCTSEGMENTTYPE'], bend: ['IFCDUCTFITTING', 'BEND', 'IFCDUCTFITTINGTYPE'], tee: ['IFCDUCTFITTING', 'JUNCTION', 'IFCDUCTFITTINGTYPE'], reducer: ['IFCDUCTFITTING', 'TRANSITION', 'IFCDUCTFITTINGTYPE'] },
};
const X3_CLASS = { segment: 'IFCFLOWSEGMENT', bend: 'IFCFLOWFITTING', tee: 'IFCFLOWFITTING', reducer: 'IFCFLOWFITTING', valve: 'IFCFLOWCONTROLLER' };

/** One part: the element, its shape, type, material, colour, sets and ports (returned for connecting). */
function writePart(w, r, sec, part, lp) {
  const [cls4, pre, tcls] = PART_CLASS[r.kind][part.kind];
  const predefined = part.kind === 'valve' ? VALVE_KINDS[part.valve.kind] : pre;
  const sysName = systemLabel(r.kind, r.system);
  const sizeText = part.kind === 'tee' && !sameSec(sec, part.branchSec) ? sec.label + ' × ' + part.branchSec.label : part.kind === 'reducer' ? part.from.label + ' × ' + part.to.label : sec.label;
  const what = part.kind === 'segment' ? tr(r.kind === 'pipe' ? 'mep.part.pipe' : 'mep.part.duct') : part.kind === 'valve' ? tr('mep.valve.' + part.valve.kind) : tr('mep.fit.' + part.kind + (r.kind === 'duct' && part.kind === 'reducer' ? '.duct' : ''));
  const name = w.L(what + ' ' + sizeText + ' ' + sysName);
  const place = w.H(w.placeAt(lp, 0, 0, 0, 0));
  const objType = part.kind === 'valve' ? w.L(tr('mep.valve.' + part.valve.kind)) : null;
  const id = w.v4 ? w.make(cls4, w.guid(), w.ownerHistory(), name, null, objType, place, null, null, predefined) : w.make(X3_CLASS[part.kind], w.guid(), w.ownerHistory(), name, null, objType || w.L(what), place, null, null);
  const body = bodyOf(w, part, sec);
  const reps = [w.rep('body', 'Body', body.type, body.items)];
  if (part.kind === 'segment') reps.push(w.rep('axis', 'Axis', 'Curve3D', [w.polyline3([part.a, part.b])]));
  w.setShape(id, reps);
  const S = sysOf(r), style = w.surfaceStyle('CadCraft MEP ' + r.kind + ' ' + r.system, S.rgb);
  for (const it of body.items) w.styleItem(it, style);
  // type: segments by material and class (or duct shape), fittings and valves by kind
  const tname = part.kind === 'segment' ? (r.kind === 'pipe' ? tr('mep.type.pipe', { cls: tr('mep.cls.' + (MAT_NAMES[r.mat] ? r.mat : 'steel'), { c: r.cls }) }) : tr('mep.type.duct.' + sec.shape)) : what;
  w.relateType(id, typeOf(w, tcls, tname, predefined));
  w.associateMaterial(id, w.material(r.kind === 'pipe' ? tr(MAT_NAMES[r.mat] || 'mep.mat.steel') : tr('mep.mat.galv')));
  const run = w.guidOf(r.id), Lm = (k, v) => [k, 'IFCLENGTHMEASURE', round(w.u(v))];
  if (part.kind === 'segment') {
    const L = dist(part.a, part.b);
    if (r.kind === 'pipe') {
      w.upsertPset(id, 'CadCraft_Pipe', [['Run', 'IFCLABEL', run], ['System', 'IFCLABEL', r.system], ['Material', 'IFCLABEL', r.mat], ['Class', 'IFCLABEL', r.cls], ['NominalSize', 'IFCLABEL', r.size], Lm('OuterDiameter', sec.od), Lm('WallThickness', sec.wall), ['Slope', 'IFCREAL', round(r.slope || 0, 9)], Lm('Length', L)]);
      w.upsertPset(id, 'Pset_PipeSegmentTypeCommon', [['NominalDiameter', 'IFCPOSITIVELENGTHMEASURE', round(w.u(sec.nps * IN))], ['InnerDiameter', 'IFCPOSITIVELENGTHMEASURE', round(w.u(sec.id))], ['OuterDiameter', 'IFCPOSITIVELENGTHMEASURE', round(w.u(sec.od))]]);
      w.upsertQto(id, 'Qto_PipeSegmentBaseQuantities', [['Length', 'length', L]]);
    } else {
      const per = sec.round ? Math.PI * sec.w : sec.shape === 'oval' ? Math.PI * sec.h + 2 * (sec.w - sec.h) : 2 * (sec.w + sec.h);
      w.upsertPset(id, 'CadCraft_Duct', [['Run', 'IFCLABEL', run], ['System', 'IFCLABEL', r.system], ['Shape', 'IFCLABEL', sec.shape], Lm('Width', sec.w), Lm('Height', sec.h), Lm('Length', L), ['Flow', 'IFCREAL', round(r.flow || 0, 6)]]);
      w.upsertQto(id, 'Qto_DuctSegmentBaseQuantities', [['Length', 'length', L], ['OuterSurfaceArea', 'area', per * L]]);
    }
  } else if (part.kind === 'valve') {
    w.upsertPset(id, 'CadCraft_Valve', [['Run', 'IFCLABEL', run], ['Kind', 'IFCLABEL', part.valve.kind], ['System', 'IFCLABEL', r.system], ['Size', 'IFCLABEL', sec.label], ['Generic', 'IFCBOOLEAN', true]]);
  } else {
    const angle = part.kind === 'bend' ? round(part.th * 180 / Math.PI, 3) : null;
    w.upsertPset(id, 'CadCraft_MepFitting', [['Run', 'IFCLABEL', run], ['Kind', 'IFCLABEL', part.kind], ['System', 'IFCLABEL', r.system], ['Size', 'IFCLABEL', sizeText], ['AngleDegrees', 'IFCREAL', angle], ['Generic', 'IFCBOOLEAN', true]]);
  }
  // ports
  const S2 = sysOf(r), myLp = w.api.GetLine(w.mid, id, false).ObjectPlacement.value, made = [];
  for (const pt of part.ports) {
    const plp = w.make('IFCLOCALPLACEMENT', w.H(myLp), w.H(w.axisFrame(pt.p, pt.out, perp(pt.out))));
    const pid = w.v4 ? w.make('IFCDISTRIBUTIONPORT', w.guid(), w.ownerHistory(), w.L(tr('mep.port')), null, null, w.H(plp), null, pt.flow, r.kind === 'pipe' ? 'PIPE' : 'DUCT', S2.ifc)
      : w.make('IFCDISTRIBUTIONPORT', w.guid(), w.ownerHistory(), w.L(tr('mep.port')), null, null, w.H(plp), null, pt.flow);
    if (!w.v4) w.make('IFCRELCONNECTSPORTTOELEMENT', w.guid(), w.ownerHistory(), null, null, w.H(pid), w.H(id));
    made.push({ id: pid, p: pt.p, part: id });
  }
  if (w.v4 && made.length) w.make('IFCRELNESTS', w.guid(), w.ownerHistory(), null, null, w.H(id), made.map((m) => w.H(m.id)));
  return { id, ports: made };
}
const sameSec = (a, b) => a.shape === b.shape && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;

/** Every run of a level made again: the old parts and ports go, the layout is written, touching ports connected. */
export function regenMep(w, storey) {
  const runs = readRuns(w).filter((r) => r.storey === storey);
  if (!runs.length) { dropEmptySystems(w); return 0; }
  const L = mepLayout(runs.map((r) => ({ ...r, sec: sectionOf(r), verts: runVertices(r) })));
  if (L.error) refuse(L.error);
  // only runs whose parts come out differently are written again: the others keep their lines (Live: an edit to one run
  // never writes over what someone else drew, so their undo still works), and parts keep their ids
  const fpOf = (r) => fingerprint(r, L.runs.get(r.guid));
  const changed = runs.filter((r) => { const lay = L.runs.get(r.guid); return !lay || w.readPset(r.id, RUN_PSET)?.Layout !== fpOf(r) || r.parts.length !== lay.parts.length; });
  if (!changed.length) return 0;
  const oldParts = changed.flatMap((r) => r.parts);
  if (oldParts.length) w.dropProduct([...oldParts, ...portsOfParts(w, oldParts)]);
  const lp = w.api.GetLine(w.mid, storey, false).ObjectPlacement.value;
  const fresh = [], bySys = new Map();
  for (const r of changed) {
    const sec = sectionOf(r), lay = L.runs.get(r.guid);
    if (!sec || !lay) continue;
    const kids = [];
    let length = 0;
    for (const part of lay.parts) {
      const m = writePart(w, r, sec, part, lp);
      kids.push(m.id); fresh.push(...m.ports);
      if (part.kind === 'segment') length += dist(part.a, part.b);
    }
    if (kids.length) w.make('IFCRELAGGREGATES', w.guid(), w.ownerHistory(), null, null, w.H(r.id), kids.map((k) => w.H(k)));
    w.upsertQto(r.id, 'Qto_CadCraftMepRun', [['Length', 'length', length], ['Parts', 'count', kids.length]]);
    w.upsertPset(r.id, RUN_PSET, [['Layout', 'IFCLABEL', fpOf(r)]]);
    const sys = systemFor(w, r);
    if (!bySys.has(sys)) bySys.set(sys, []);
    bySys.get(sys).push(...kids);
  }
  for (const [sys, parts] of bySys) assign(w, sys, parts);
  // ports that touch, of different parts, are connected once: new ports with new ones, and with the kept runs' free ports
  const keptParts = runs.filter((r) => !changed.includes(r)).flatMap((r) => r.parts);
  const joined = connectedPorts(w);
  const kept = portsOfParts(w, keptParts).filter((id) => !joined.has(id)).map((id) => ({ id, p: portAt(w, id), part: portOwner(w, id) })).filter((q) => q.p);
  const all = [...fresh, ...kept];
  const grid = new Map(), cell = (p) => p.map((x) => Math.round(x)).join(',');
  for (const p of all) { const k = cell(p.p); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); }
  const done = new Set();
  for (const p of fresh) {
    if (done.has(p.id)) continue;
    const near = [];
    const [cx, cy, cz] = p.p.map((x) => Math.round(x));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) near.push(...(grid.get([cx + dx, cy + dy, cz + dz].join(',')) || []));
    const q = near.find((o) => o.part !== p.part && !done.has(o.id) && dist(o.p, p.p) < 0.6);
    if (!q) continue;
    w.make('IFCRELCONNECTSPORTS', w.guid(), w.ownerHistory(), null, null, w.H(p.id), w.H(q.id), null);
    done.add(p.id); done.add(q.id);
  }
  dropEmptySystems(w);
  return changed.length;
}
/** What a run's parts come out as (and what they are made of), as a short hash: unchanged = nothing to write. */
function fingerprint(r, lay) {
  const R3 = (q) => q.map((x) => Math.round(x * 10) / 10);
  const s = JSON.stringify([r.kind, r.system, r.mat, r.cls, r.size, r.shape, Math.round(r.w), Math.round(r.h), round(r.slope || 0, 9), r.flow || 0, r.valves,
    (lay?.parts || []).map((p) => [p.kind, ...(p.ports || []).map((q) => R3(q.p)), p.kind === 'tee' ? p.branchSec?.label : p.kind === 'reducer' ? [p.from.label, p.to.label] : p.valve?.kind || ''])]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'v1:' + h.toString(16).padStart(8, '0') + ':' + s.length;
}
/** Ports already connected (both ends still there). */
function connectedPorts(w) {
  const out = new Set();
  for (const rid of ids(w.api, w.mid, 'IFCRELCONNECTSPORTS')) { const r = w.api.GetLine(w.mid, rid, false); if (r.RelatingPort?.value && r.RelatedPort?.value) { out.add(r.RelatingPort.value); out.add(r.RelatedPort.value); } }
  return out;
}
/** A port's place in its storey's plan mm (its placement sits under its part's, which is the storey's own). */
function portAt(w, id) {
  try {
    const lp = w.api.GetLine(w.mid, w.api.GetLine(w.mid, id, false).ObjectPlacement.value, false);
    const ax = w.api.GetLine(w.mid, lp.RelativePlacement.value, false), pt = w.api.GetLine(w.mid, ax.Location.value, false);
    return (pt.Coordinates || []).map((c) => (Number(val(c)) || 0) * w.unitMm);
  } catch (e) { return null; }
}
function portOwner(w, id) {
  for (const rid of ids(w.api, w.mid, 'IFCRELNESTS')) { const r = w.api.GetLine(w.mid, rid, false); if ((r.RelatedObjects || []).some((h) => h.value === id)) return r.RelatingObject.value; }
  try { for (const rid of ids(w.api, w.mid, 'IFCRELCONNECTSPORTTOELEMENT')) { const r = w.api.GetLine(w.mid, rid, false); if (r.RelatingPort?.value === id) return r.RelatedElement.value; } } catch (e) { /* none */ }
  return null;
}

/** A run's defaults: material and class from the system, the drain slope from the plumbing code's table. */
export function runDefaults(kind, system, size) {
  if (kind === 'duct') return { kind, system: DUCT_SYSTEMS[system] ? system : 'supply', shape: 'rect', w: 300, h: 200, slope: 0 };
  const S = PIPE_SYSTEMS[system] || PIPE_SYSTEMS.cw, mat = S.mat, cls = DEFAULT_CLASS[mat];
  const sizes = sizesFor(mat, cls), sz = sizes.includes(size) ? size : (sizes.includes(S.drain ? '3' : '3/4') ? (S.drain ? '3' : '3/4') : sizes[0]);
  const p = pipeSize(mat, cls, sz);
  return { kind, system: PIPE_SYSTEMS[system] ? system : 'cw', mat, cls, size: sz, slope: S.drain && p ? minDrainSlope(p.nps) : 0 };
}
/** The smallest drain slope the plumbing code allows this run (null when it is not a drain). */
export function drainMinimum(r) {
  if (r.kind !== 'pipe' || !PIPE_SYSTEMS[r.system]?.drain) return null;
  const p = pipeSize(r.mat, r.cls, r.size);
  return p ? minDrainSlope(p.nps) : null;
}

export function placeRun(spec) {
  const s = { ...spec, points: spec.points.map((q) => [q[0], q[1], q[2] || 0]), valves: (spec.valves || []).slice() };
  return op((w) => {
    const storey = w.byGuid(s.storey);
    if (!storey) refuse('model.err.nolevel');
    const st = w.api.GetLine(w.mid, storey, false);
    const g = w.gid(s.guid); s.guid = g;
    const label = tr(s.kind === 'duct' ? 'mep.run.duct' : 'mep.run.pipe');
    const id = w.make('IFCELEMENTASSEMBLY', g, w.ownerHistory(), w.L(label + ' ' + (sectionOf(s)?.label || '') + ' ' + systemLabel(s.kind, s.system)), null, w.L(s.kind === 'duct' ? 'Duct run' : 'Pipe run'),   // i18n-ignore: IFC ObjectType
      w.H(w.placeAt(st.ObjectPlacement.value, 0, 0, 0, 0)), null, null, 'NOTDEFINED', 'USERDEFINED');
    w.noteGuid(g, id);
    // its own containment (a storey may have several): two people's new runs never write one line
    w.make('IFCRELCONTAINEDINSPATIALSTRUCTURE', w.guid(), w.ownerHistory(), null, null, [w.H(id)], w.H(storey));
    writeDef(w, id, s);
    regenMep(w, storey);
    const r = readRuns(w).find((x) => x.guid === g);
    return { id: r?.parts[0] ?? id, ids: r?.parts || [id], made: new Map([[g, id]]) };
  });
}
export function changeRun(guid, ch) {
  const c = { ...ch };
  if (c.points) c.points = c.points.map((q) => [q[0], q[1], q[2] || 0]);
  return op((w) => {
    const r = readRuns(w).find((x) => x.guid === guid);
    if (!r) refuse('mep.err.none');
    const next = { ...r, ...c };
    writeDef(w, r.id, next);
    // the label follows the size and system
    const line = w.touch(r.id); line.Name = w.L(tr(next.kind === 'duct' ? 'mep.run.duct' : 'mep.run.pipe') + ' ' + (sectionOf(next)?.label || '') + ' ' + systemLabel(next.kind, next.system)); w.write(line);
    regenMep(w, r.storey);
    const r2 = readRuns(w).find((x) => x.guid === guid);
    return { id: r2?.parts[0] ?? r.id, ids: r2?.parts || [] };
  });
}
export function removeRuns(guids) {
  return op((w) => {
    const rs = readRuns(w).filter((r) => guids.includes(r.guid));
    const storeys = new Set(rs.map((r) => r.storey));
    const parts = rs.flatMap((r) => r.parts);
    if (rs.length) w.dropProduct([...rs.map((r) => r.id), ...parts, ...portsOfParts(w, parts)]);
    for (const st of storeys) regenMep(w, st);
    return { id: null, ids: [] };
  });
}
/** A valve on a pipe run, `at` mm along it (from its first point). */
export function addValve(guid, at, kind) {
  return op((w) => {
    const r = readRuns(w).find((x) => x.guid === guid);
    if (!r) refuse('mep.err.none');
    if (r.kind !== 'pipe' || !VALVE_KINDS[kind]) refuse('mep.err.valve');
    writeDef(w, r.id, { ...r, valves: [...r.valves, { s: at, kind }].sort((a, b) => a.s - b.s) });
    regenMep(w, r.storey);
    return { id: null, ids: [] };
  });
}
export function removeValve(guid, index) {
  return op((w) => {
    const r = readRuns(w).find((x) => x.guid === guid);
    if (!r) refuse('mep.err.none');
    writeDef(w, r.id, { ...r, valves: r.valves.filter((_, i) => i !== index) });
    regenMep(w, r.storey);
    return { id: null, ids: [] };
  });
}

/** Where a plan point lies along a run (its nearest leg): { s (mm from the first point), d (mm off the line), at, leg }. */
export function along(r, p) {
  const V = runVertices(r);
  let best = null, s0 = 0;
  for (let i = 0; i + 1 < V.length; i++) {
    const a = V[i], b = V[i + 1], L = dist(a, b), d = norm(sub(b, a));
    const t = Math.max(0, Math.min(L, (p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]));
    const q = add(a, mul(d, t)), off = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (!best || off < best.d) best = { s: s0 + t, d: off, at: q, leg: i };
    s0 += L;
  }
  return best;
}
export const runLength = (r) => { const V = runVertices(r); let L = 0; for (let i = 1; i < V.length; i++) L += dist(V[i - 1], V[i]); return L; };

// ---- sizing helpers ----
const GPM = 3.785411784 / 60 / 1000;   // m³/s per US gallon a minute
/** The smallest pipe of a material and class whose flow velocity stays at or under vmax. q in gpm ('in') or L/s ('mm'),
 *  vmax in ft/s or m/s. → { size, v (typed units), id (mm) } or null. */
export function pipeForFlow(mat, cls, q, vmax, u = 'in') {
  const Q = q * (u === 'in' ? GPM : 0.001), Vm = vmax * (u === 'in' ? 0.3048 : 1);
  if (!(Q > 0) || !(Vm > 0)) return null;
  for (const size of sizesFor(mat, cls)) {
    const p = pipeSize(mat, cls, size);
    if (!p) continue;
    const D = p.id * 0.0254, V = Q / (Math.PI * D * D / 4);
    if (V <= Vm + 1e-12) return { size, v: V / (u === 'in' ? 0.3048 : 1), id: p.id * IN };
  }
  return null;
}
/** A duct sized by equal friction (the HVAC add-on's sizeSection), in mm: { w, h, v, rate, note } or null. q cfm ('in') or
 *  L/s ('mm'), rate in. w.g./100 ft or Pa/m; shape round | rect | oval with the fixed side h (mm). */
export function ductForFlow({ q, rate, shape, h, u = 'in' }) {
  const s = sizeSection({ q, rate, shape, h: h ? (u === 'in' ? h / IN : h) : null, u });
  if (!s) return null;
  const k = u === 'in' ? IN : 1;
  return { w: s.w * k, h: s.h * k, v: s.V, rate: s.rate, note: s.note };
}
/** Friction rate and velocity of a duct run as drawn (typed units). */
export function ductLoss(r, u = 'in') {
  if (r.kind !== 'duct' || !(r.flow > 0)) return null;
  const k = u === 'in' ? IN : 1;
  return sectionLoss({ q: r.flow, shape: r.shape, w: r.w / k, h: (r.shape === 'round' ? r.w : r.h) / k, u });
}

/** Schedules from the parts as written: pipe and duct by size with their lengths, fittings and valves by kind and size. */
export function runSchedules(w) {
  const pipes = new Map(), ducts = new Map(), fits = new Map();
  const so = w.storeyOf();
  const bump = (m, k, row, by) => { if (!m.has(k)) m.set(k, { ...row, n: 0, length: 0, area: 0, ids: [] }); const x = m.get(k); x.n++; x.length += by.length || 0; x.area += by.area || 0; x.ids.push(by.id); };
  for (const r of readRuns(w)) {
    const sec = sectionOf(r);
    if (!sec) continue;
    for (const id of r.parts) {
      const ps = w.readPset(id, r.kind === 'pipe' ? 'CadCraft_Pipe' : 'CadCraft_Duct');
      if (ps) {
        const L = (Number(ps.Length) || 0) * w.unitMm;
        if (r.kind === 'pipe') bump(pipes, [r.system, r.mat, r.cls, r.size].join('|'), { system: r.system, mat: r.mat, cls: r.cls, size: r.size, label: sec.label, od: sec.od, p: sec.p }, { length: L, id });
        else { const per = sec.round ? Math.PI * sec.w : sec.shape === 'oval' ? Math.PI * sec.h + 2 * (sec.w - sec.h) : 2 * (sec.w + sec.h); bump(ducts, [r.system, sec.shape, sec.w, sec.h].join('|'), { system: r.system, shape: sec.shape, label: sec.label, w: sec.w, h: sec.h }, { length: L, area: per * L, id }); }
        continue;
      }
      const f = w.readPset(id, 'CadCraft_MepFitting') || w.readPset(id, 'CadCraft_Valve');
      if (!f) continue;
      const kind = String(f.Kind || '');
      bump(fits, [r.kind, r.system, kind, f.Size, f.AngleDegrees ?? ''].join('|'), { kind: r.kind, system: r.system, what: kind, valve: !!VALVE_KINDS[kind], size: String(f.Size || ''), angle: f.AngleDegrees ?? null, storey: so.get(id) }, { id });
    }
  }
  return { pipes: [...pipes.values()], ducts: [...ducts.values()], fittings: [...fits.values()] };
}
