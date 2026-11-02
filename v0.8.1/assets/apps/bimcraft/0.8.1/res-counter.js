/* SPDX-License-Identifier: Apache-2.0 */
/**
 * res-counter.js — countertops that follow the cabinets (0.5 part 4, RC.4). No DOM: bin/test-bimcraft.mjs --res.
 *
 *   counterCabinets(w, storey) → [{ id, name, poly (plan, the back on the wall), top, front: [[a, b]…] }]
 *        library items placed on that level whose source attributes say CC-COUNTER-READY (the residential set's base,
 *        sink and corner cabinets): their footprints from the placement, the item's width / depth (and CC-FOOTPRINT "L
 *        <leg mm>" for an L-shaped corner cabinet), turned and moved into the level's plan axes
 *   counterRuns(cabinets, { overhang }) → [{ poly, holes, area, perimeter, cabinets: [ids], top }]   each run = the union of
 *        its cabinets' footprints, the front edges pushed out by the overhang (model-rooms.js planLoops of the pieces)
 *   readCountertops(w) · placeCountertop({ level, seed, overhang, thickness }) → op · changeCountertop(guid, ch) → op ·
 *   fitCountertop(guid) → op · removeCountertops([guid]) → op · syncCountertops(w, storey) (res-follow.js)
 *   countertopState(w, c) → { run, key, stale }
 *
 * A countertop remembers a point inside its run (Seed) and is made again from whatever run holds that point: the
 * Countertop tool on a run that has one fits it again, Properties has "Fit to the cabinets", and every building-tool change
 * on the level fits them all. Placing or removing a cabinet marks a countertop out of date on the plan (stale) until then.
 * Written as IfcFurniture (IFC4 .USERDEFINED., ObjectType "Countertop"; IFC2X3 IfcFurnishingElement) contained in the
 * level: the run's outline extruded from the cabinets' top by the thickness; CadCraft_Countertop (Level, SeedX/Y,
 * Overhang, Thickness, Cabinets, ShapeKey), CadCraft_CountertopQuantities (Area, Perimeter, FrontEdge).
 */
import { ModelWriter, round } from './model-write.js';
import { readLevels } from './model-levels.js';
import { planLoops, loopAt, labelPoint, area as loopArea, perim } from './model-rooms.js';
import { ids, val, inv4, apply4 } from './ifc-util.js';
import { t as tr } from './i18n.js';

export const COUNTER_PSET = 'CadCraft_Countertop';
const IN = 25.4;
export const COUNTER_DEFAULTS = { overhang: 1 * IN, thickness: 1.5 * IN };

// ------------------------------------------------------------------------------------------------------------ cabinets
export function counterCabinets(w, storey) {
  const out = [];
  const st = w.api.GetLine(w.mid, storey, false);
  if (!st?.ObjectPlacement) return out;
  const Mi = inv4(w.storeyWorld(storey));
  const so = w.storeyOf();
  for (const p of w.placements()) {
    if (so.get(p.id) !== storey) continue;
    const src = w.readPset(p.id, 'CadCraft_SourceAttributes') || {};
    if (String(src['CC-COUNTER-READY'] || '').toLowerCase() !== 'yes') continue;
    const eq = p.equipment || {};
    const wid = Number(eq.Width) * w.unitMm, dep = Number(eq.Depth) * w.unitMm, top = Number(eq.Height) * w.unitMm;
    if (!(wid > 0 && dep > 0 && top > 0)) continue;
    const r = p.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    const toPlan = (x, y) => { const X = p.x + x * c - y * s, Y = p.y + x * s + y * c; const q = apply4(Mi, X, Y, 0); return [q[0], q[1]]; };
    const leg = /^L\s+([\d.]+)/.exec(String(src['CC-FOOTPRINT'] || ''));
    let local, fronts;
    if (leg) {
      const L = Number(leg[1]), h = wid / 2;
      local = [[-h, -dep], [-h + L, -dep], [-h + L, -L], [h, -L], [h, 0], [-h, 0]];
      fronts = [[1, 2], [2, 3]];   // the two faces towards the room; the ends meet the next cabinets
    } else {
      local = [[-wid / 2, -dep], [wid / 2, -dep], [wid / 2, 0], [-wid / 2, 0]];
      fronts = [[0, 1]];
    }
    out.push({ id: p.id, name: p.name, top, local, poly: local.map(([x, y]) => toPlan(x, y)), fronts, toPlan });
  }
  return out;
}
/** Each cabinet's footprint with its front edges pushed out by `overhang` (in its own axes), then the union of them all. */
export function counterRuns(cabinets, { overhang = COUNTER_DEFAULTS.overhang } = {}) {
  const polys = cabinets.map((cb) => {
    const q = cb.local.map((p) => p.slice());
    // push each front edge out: move its two points by the overhang along the edge's outward normal (an L's inner corner,
    // on both fronts, moves along both: where the two pushed edges meet, as the edges are square)
    for (const [i, j] of cb.fronts) {
      const a = cb.local[i], b = cb.local[j], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const n = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L];   // right of a→b = outward for an anticlockwise footprint
      for (const k of [i, j]) { q[k][0] += n[0] * overhang; q[k][1] += n[1] * overhang; }
    }
    return q.map(([x, y]) => cb.toPlan(x, y));
  });
  if (!polys.length) return [];
  const L = planLoops(polys, { snap: 0.5 });
  return L.outlines.map((o) => {
    const inside = cabinets.filter((cb, i) => polys[i].some((p) => pointIn(p, o.poly)) || pointIn(centroidOf(polys[i]), o.poly));
    return { poly: o.poly, holes: [], area: Math.abs(o.area), perimeter: o.perimeter, cabinets: inside.map((cb) => cb.id), top: Math.max(...inside.map((cb) => cb.top), 0) };
  });
}
function centroidOf(p) { return [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length]; }
function pointIn(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  // on the boundary counts as inside (a footprint corner on the run's outline)
  if (!inside) for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[j], b = poly[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; if (Math.abs((b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0])) / d < 1 && Math.min(a[0], b[0]) - 1 <= pt[0] && pt[0] <= Math.max(a[0], b[0]) + 1 && Math.min(a[1], b[1]) - 1 <= pt[1] && pt[1] <= Math.max(a[1], b[1]) + 1) return true; }
  return inside;
}
function shapeKey(...parts) {
  const s = JSON.stringify(parts, (k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v));
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

// ------------------------------------------------------------------------------------------------------------ reading
export function readCountertops(w) {
  const out = [];
  const so = w.storeyOf();
  for (const cls of ['IFCFURNITURE', 'IFCFURNISHINGELEMENT']) {
    let list = [];
    try { list = ids(w.api, w.mid, cls); } catch (e) { continue; }
    for (const id of list) {
      const ps = w.readPset(id, COUNTER_PSET);
      if (!ps) continue;
      const l = w.api.GetLine(w.mid, id, false);
      out.push({ id, guid: val(l.GlobalId), storey: so.get(id) ?? null, seed: [Number(ps.SeedX) * w.unitMm, Number(ps.SeedY) * w.unitMm], overhang: Number(ps.Overhang) * w.unitMm, thickness: Number(ps.Thickness) * w.unitMm, key: ps.ShapeKey || '' });
    }
  }
  return out;
}
/** The run a countertop covers now, its shape key, and whether its stored shape is out of date. */
export function countertopState(w, c, cabinets = null) {
  const runs = counterRuns(cabinets || counterCabinets(w, c.storey), { overhang: c.overhang });
  const run = runs.find((r) => pointIn(c.seed, r.poly)) || null;
  const key = run ? shapeKey(run.poly, run.top, c.thickness) : '';
  return { run, key, stale: !!run && key !== c.key, gone: !run };
}

// ------------------------------------------------------------------------------------------------------------ writing
function writeCountertop(w, c, run) {
  const key = shapeKey(run.poly, run.top, c.thickness);
  const solid = w.extrude(w.profile(run.poly), run.top, c.thickness);
  w.styleItem(solid, w.surfaceStyle(tr('res.style.counter'), [0.86, 0.85, 0.8], 0));
  w.setShape(c.id, [w.rep('body', 'Body', 'SweptSolid', [solid])]);
  // the front edge (the overhang side) and the back edge (along walls) for the takeoff
  let front = 0;
  const cabs = counterCabinets(w, c.storey).filter((cb) => run.cabinets.includes(cb.id));
  for (const cb of cabs) for (const [i, j] of cb.fronts) front += Math.hypot(cb.local[j][0] - cb.local[i][0], cb.local[j][1] - cb.local[i][1]);
  w.upsertPset(c.id, 'CadCraft_CountertopQuantities', [['Area', 'IFCAREAMEASURE', round(run.area / 1e6, 6)], ['Perimeter', 'IFCLENGTHMEASURE', round(w.u(run.perimeter))], ['FrontEdge', 'IFCLENGTHMEASURE', round(w.u(front))]]);
  const sd = c.seed;
  w.upsertPset(c.id, COUNTER_PSET, [['SeedX', 'IFCLENGTHMEASURE', round(w.u(sd[0]))], ['SeedY', 'IFCLENGTHMEASURE', round(w.u(sd[1]))], ['ShapeKey', 'IFCIDENTIFIER', key], ['Cabinets', 'IFCINTEGER', run.cabinets.length]]);
  return true;
}
const op = (fn) => (ed) => new ModelWriter(ed.W, ed.api, ed.mid).run(fn);
const fail = (key) => { throw Object.assign(new Error(key), { key }); };

export function placeCountertop(spec) {
  const s = { ...COUNTER_DEFAULTS, ...spec };
  return op((w) => {
    if (!s.guid) s.guid = val(w.guid());
    const storey = w.byGuid(s.level);
    if (!storey) fail('model.err.nolevel');
    const runs = counterRuns(counterCabinets(w, storey), { overhang: s.overhang });
    const run = runs.find((r) => pointIn(s.seed, r.poly));
    if (!run) fail('res.err.nocabinet');
    const st = w.api.GetLine(w.mid, storey, false);
    const nm = w.L(tr('res.counter'));
    const cls = w.v4 ? 'IFCFURNITURE' : 'IFCFURNISHINGELEMENT';
    const id = w.make(cls, s.guid, w.ownerHistory(), nm, null, w.L('Countertop'), w.H(w.placeAt(st.ObjectPlacement.value, 0, 0, 0, 0)), null, null, ...(w.v4 ? ['USERDEFINED'] : []));   // i18n-ignore: IFC ObjectType
    w.noteGuid(s.guid, id);
    w.contain(id, storey);
    w.associateMaterial(id, w.material(tr('res.mat.counter')));
    w.upsertPset(id, COUNTER_PSET, [['Level', 'IFCIDENTIFIER', s.level], ['Overhang', 'IFCLENGTHMEASURE', round(w.u(s.overhang))], ['Thickness', 'IFCPOSITIVELENGTHMEASURE', round(w.u(s.thickness))]]);
    writeCountertop(w, { id, storey, seed: s.seed, overhang: s.overhang, thickness: s.thickness }, run);
    return { id, ids: [id], made: new Map([[s.guid, id]]) };
  });
}
export function changeCountertop(guid, ch) {
  return op((w) => {
    const c = readCountertops(w).find((x) => x.guid === guid);
    if (!c) fail('model.err.gone');
    const nx = { ...c };
    const rows = [];
    if (Number.isFinite(ch.overhang) && ch.overhang >= 0) { nx.overhang = ch.overhang; rows.push(['Overhang', 'IFCLENGTHMEASURE', round(w.u(ch.overhang))]); }
    if (ch.thickness > 0) { nx.thickness = ch.thickness; rows.push(['Thickness', 'IFCPOSITIVELENGTHMEASURE', round(w.u(ch.thickness))]); }
    const { run } = countertopState(w, nx);
    if (!run) fail('res.err.nocabinet');
    if (rows.length) w.upsertPset(c.id, COUNTER_PSET, rows);
    writeCountertop(w, nx, run);
    return { id: c.id, ids: [c.id] };
  });
}
export function fitCountertop(guid) { return changeCountertop(guid, {}); }
export function removeCountertops(guids) {
  return op((w) => {
    const list = readCountertops(w).filter((x) => guids.includes(x.guid));
    if (list.length) w.dropProduct(list.map((x) => x.id));
    return { id: null, ids: [] };
  });
}
/** Fit every countertop of a level whose cabinets changed (a run that is gone leaves its countertop as it was). */
export function syncCountertops(w, storey) {
  let n = 0;
  const all = readCountertops(w).filter((c) => c.storey === storey);
  if (!all.length) return 0;
  const cabinets = counterCabinets(w, storey);
  for (const c of all) { const s = countertopState(w, c, cabinets); if (s.stale) { writeCountertop(w, c, s.run); n++; } }
  return n;
}
export { labelPoint, loopArea, perim, loopAt, readLevels };
