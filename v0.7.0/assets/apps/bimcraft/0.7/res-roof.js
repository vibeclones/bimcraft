/* SPDX-License-Identifier: Apache-2.0 */
/**
 * res-roof.js — automatic roofs from the walls (0.5 part 4, RC.1): a pitch per wall (pitched / gable / none), shed and
 * hip presets, overhangs, the plate height, ridges / hips / valleys on any outline, fascia and soffit. No DOM:
 * bin/test-bimcraft.mjs --res runs it in Node. Plan millimetres; heights above the walls' level.
 *
 *   edgeWalls(outline, walls) → [guid | null]   the drawn wall under each edge of the building's outline
 *   edgeKinds(outline, walls, roof) → [{ kind: 'pitch'|'gable'|'none', pitch, overhang, wall }]   from the roof's settings
 *   roofGeometry(outline, kinds, { thickness, plate, fascia, fasciaT }) → { faces, eave, gables, lines, ridge, fascia,
 *     soffit, area, projected, top } | { error }
 *   heightAt(plan, p) → the underside's height over p (null outside)
 *   parseEdges(text) / formatEdges(map)   the roof's per-wall settings as stored (CadCraft_Roof.Edges)
 *   presetEdges(outline, walls, preset, at) → map   hip | gable-short | gable-long | shed (low side nearest `at`)
 *   writeRoofParts(w, r, ctx)   the IFC writer model-slabs.js calls: slabs per face, gable walls, fascia, soffit
 *
 * Every plane passes through the outer face of its wall at the plate height (z = plate there): pitch per wall changes
 * where hips and valleys fall, never the plate. A gable or "none" edge doesn't move (res-skeleton.js speed 0): a gable
 * gets a wall up to the roof and a rake overhang; "none" stops flush (a roof against a taller wall). The skeleton runs on
 * the eave line (outline pushed out by each edge's overhang, less the fascia board), each edge starting at the height
 * its plane has there, so eaves of different pitches drop to different heights, as framed.
 */
import { skeleton, faceZ, polyArea } from './res-skeleton.js';
import { ids, inv4, mul4, apply4 } from './ifc-util.js';
import { round } from './model-write.js';
import { labelPoint } from './model-rooms.js';
import { t as tr } from './i18n.js';

const D2R = Math.PI / 180;
const IN = 25.4;
export const ROOF_DEFAULTS = { pitch: Math.atan(6 / 12) / D2R, overhang: 12 * IN, rake: 12 * IN, thickness: 8 * IN, fascia: 9.25 * IN, fasciaT: 1.5 * IN, soffit: true, soffitT: 0.625 * IN };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];

// ---------------------------------------------------------------------------------------------------- edges and walls
export function edgeWalls(outline, walls) {
  return outline.map((a, i) => {
    const b = outline[(i + 1) % outline.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1) return null;
    const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let best = null;
    for (const w of walls) {
      const wl = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      if (wl < 1) continue;
      const wu = [(w.b[0] - w.a[0]) / wl, (w.b[1] - w.a[1]) / wl];
      if (Math.abs(cross(u, wu)) > 1e-4) continue;
      const d = Math.abs(cross(wu, sub(m, w.a)));
      if (Math.abs(d - w.t / 2) > 2) continue;
      const s = dot(wu, sub(m, w.a));
      if (s < -w.t || s > wl + w.t) continue;
      const score = Math.abs(d - w.t / 2) + Math.max(0, -s, s - wl);
      if (!best || score < best.score) best = { guid: w.guid, score };
    }
    return best ? best.guid : null;
  });
}
/** "guid=p:35:450;guid=g;guid=n" ↔ Map(key → { kind, pitch?, overhang? }) (a key is a wall's GlobalId, or "@i" for an edge
 *  with no drawn wall). */
export function parseEdges(text) {
  const m = new Map();
  for (const part of String(text || '').split(';')) {
    const [k, v] = part.split('=');
    if (!k || !v) continue;
    const [c, p, o] = v.split(':');
    const kind = c === 'g' ? 'gable' : c === 'n' ? 'none' : c === 'p' ? 'pitch' : null;
    if (!kind) continue;
    const e = { kind };
    if (kind === 'pitch' && p !== undefined && p !== '' && Number.isFinite(Number(p))) e.pitch = Number(p);
    if (o !== undefined && o !== '' && Number.isFinite(Number(o))) e.overhang = Number(o);
    m.set(k.trim(), e);
  }
  return m;
}
export function formatEdges(map) {
  const out = [];
  for (const [k, e] of map) {
    if (!e || !e.kind) continue;
    const c = e.kind === 'gable' ? 'g' : e.kind === 'none' ? 'n' : 'p';
    const tail = [c === 'p' && Number.isFinite(e.pitch) ? round(e.pitch, 4) : '', Number.isFinite(e.overhang) ? round(e.overhang, 2) : ''];
    while (tail.length && tail[tail.length - 1] === '') tail.pop();
    out.push(k + '=' + [c, ...tail].join(':'));
  }
  return out.join(';');
}
const keyOf = (guids, i) => guids[i] || '@' + i;

/** Each outline edge's kind, pitch and overhang from the roof's settings (per-wall Edges, else the old Gables list). */
export function edgeKinds(outline, walls, roof) {
  const guids = edgeWalls(outline, walls);
  const map = roof.edges instanceof Map ? roof.edges : parseEdges(roof.edges);
  const gables = new Set(roof.gables || []);
  return outline.map((_, i) => {
    const e = map.get(keyOf(guids, i)) || (gables.has(i) && !map.size ? { kind: 'gable' } : { kind: 'pitch' });
    const pitch = e.kind === 'pitch' ? (Number.isFinite(e.pitch) ? e.pitch : roof.pitch) : null;
    const overhang = e.kind === 'none' ? 0 : Number.isFinite(e.overhang) ? e.overhang : e.kind === 'gable' ? (Number.isFinite(roof.rake) ? roof.rake : roof.overhang) : roof.overhang;
    return { kind: e.kind, pitch, overhang, wall: guids[i] };
  });
}

/** Per-wall settings for a preset over an outline: hip (all pitched), gables on the short / long sides (four-sided only),
 *  shed (the edge nearest `at` is the low eave, the rest gable). → Map | null (can't). */
export function presetEdges(outline, walls, preset, at = null) {
  const guids = edgeWalls(outline, walls), m = new Map(), n = outline.length;
  const len = outline.map((p, i) => Math.hypot(outline[(i + 1) % n][0] - p[0], outline[(i + 1) % n][1] - p[1]));
  if (preset === 'hip') return m;
  if (preset === 'gable-short' || preset === 'gable-long') {
    if (n !== 4) return null;
    const short = len[0] + len[2] <= len[1] + len[3] ? [0, 2] : [1, 3];
    for (const i of preset === 'gable-short' ? short : short.map((x) => x + 1)) m.set(keyOf(guids, i), { kind: 'gable' });
    return m;
  }
  if (preset === 'shed') {
    let low = 0;
    if (at) {
      let best = Infinity;
      outline.forEach((a, i) => { const b = outline[(i + 1) % n], d = segDist(at, a, b); if (d < best) { best = d; low = i; } });
    } else low = len.indexOf(Math.max(...len));
    for (let i = 0; i < n; i++) if (i !== low) m.set(keyOf(guids, i), { kind: 'gable' });
    return m;
  }
  return null;
}
export function segDist(p, a, b) {
  const d = sub(b, a), L2 = dot(d, d) || 1, t = Math.max(0, Math.min(1, dot(sub(p, a), d) / L2));
  return Math.hypot(p[0] - a[0] - d[0] * t, p[1] - a[1] - d[1] * t);
}

// ---------------------------------------------------------------------------------------------------------- geometry
/**
 * The roof over `outline` (anticlockwise outer faces of the walls) with per-edge `kinds`. Heights: z = plate on the wall
 * lines; the underside of the roof. thickness = the roof's depth square to its faces; fascia = board height (0 = none),
 * fasciaT its thickness.
 */
export function roofGeometry(outline, kinds, { thickness = ROOF_DEFAULTS.thickness, plate = 0, fascia = ROOF_DEFAULTS.fascia, fasciaT = ROOF_DEFAULTS.fasciaT, soffit = true } = {}) {
  const n = outline.length;
  if (n < 3) return { error: 'model.err.roofshape' };
  for (const k of kinds) if (k.kind === 'pitch' && !(k.pitch > 1 && k.pitch < 80)) return { error: 'model.err.pitch' };
  if (!kinds.some((k) => k.kind === 'pitch')) return { error: 'res.err.nopitch' };
  const E = outline.map((a, i) => {
    const b = outline[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]), u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    return { a, b, L, u, n: [-u[1], u[0]] };
  });
  // the eave line the roof boards end on: each edge out by its overhang, less the fascia where there is one
  const board = (k) => (fascia > 0 && k.kind !== 'none' && k.overhang > fasciaT ? fasciaT : 0);
  const out = kinds.map((k) => Math.max(0, k.overhang - board(k)));
  const eave = offsetPoly(E, out);
  const specs = kinds.map((k, i) => {
    if (k.kind !== 'pitch') return { speed: 0, start: 0 };
    const s = Math.tan(k.pitch * D2R);
    return { speed: 1 / s, start: plate - out[i] * s };
  });
  if (!simple(eave)) return { error: 'res.err.overhang' };
  const sk = skeleton(eave, specs);
  if (sk.error) return { error: sk.error };
  if (!sk.faces.length) return { error: 'model.err.roofshape' };
  const faces = sk.faces.map((f) => ({ ...f, slope: 1 / f.speed, pitch: Math.atan(1 / f.speed) / D2R }));
  const plan = { kind: 'skeleton', faces, eave, kinds, plate, thickness, top: sk.top, lines: [], ridge: [], gables: [], fascia: [], soffit: [] };
  // lines: ridges (level), hips (the roof bends down across them), valleys (up), and the eave / rake edges
  for (const l of sk.lines) {
    const [fi, fj] = l.f;
    const A = faces.find((f) => f.edge === fi && onFace(f, l)), B = faces.find((f) => f.edge === fj && onFace(f, l));
    if (!A || !B) continue;
    let kind;
    if (Math.abs(l.a[2] - l.b[2]) < 0.5) kind = 'ridge';
    else {
      const mid = [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2];
      const cB = labelPoint(B.poly), toB = sub(cB, mid), d = Math.hypot(...toB) || 1;
      const q = [mid[0] + toB[0] / d * Math.min(50, d / 2), mid[1] + toB[1] / d * Math.min(50, d / 2)];
      kind = faceZ(A, q) > faceZ(B, q) ? 'hip' : 'valley';
    }
    plan.lines.push({ kind, a: l.a, b: l.b, len: Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1], l.b[2] - l.a[2]) });
    plan.ridge.push([l.a[0], l.a[1], l.b[0], l.b[1]]);
  }
  // gable ends: the wall line under each gable edge
  kinds.forEach((k, i) => { if (k.kind === 'gable') plan.gables.push({ edge: i, a: E[i].a, b: E[i].b }); });
  // fascia: every face edge lying on the eave line (level along an eave, sloped along a rake), outward by the board
  const eaveE = eave.map((a, i) => { const b = eave[(i + 1) % eave.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; return { a, b, L, u, n: [-u[1], u[0]] }; });
  for (const f of faces) for (let i = 0; i < f.poly.length; i++) {
    const p = f.poly[i], q = f.poly[(i + 1) % f.poly.length];
    for (let j = 0; j < eaveE.length; j++) {
      const e = eaveE[j];
      if (Math.abs(cross(e.u, sub(p, e.a))) > 0.5 || Math.abs(cross(e.u, sub(q, e.a))) > 0.5) continue;
      const sp = dot(e.u, sub(p, e.a)), sq = dot(e.u, sub(q, e.a));
      if (Math.min(sp, sq) < -0.5 || Math.max(sp, sq) > e.L + 0.5 || Math.abs(sq - sp) < 1) continue;
      const tv = thickness / Math.cos(f.pitch * D2R);
      const kind = Math.abs(faceZ(f, p) - faceZ(f, q)) < 0.5 ? 'eave' : 'rake';
      plan.fascia.push({ kind, edge: j, a: [p[0], p[1], faceZ(f, p) + tv], b: [q[0], q[1], faceZ(f, q) + tv], n: e.n, len: Math.hypot(q[0] - p[0], q[1] - p[1], faceZ(f, q) - faceZ(f, p)) });
      break;
    }
  }
  if (!(fascia > 0)) plan.fascia = plan.fascia.map((x) => ({ ...x, board: false }));
  // soffit: the strip from each pitched wall to the back of the fascia, level with the fascia's bottom (never above the
  // roof's underside at the eave)
  if (soffit) kinds.forEach((k, i) => {
    if (k.kind !== 'pitch' || out[i] < 5) return;
    const s = Math.tan(k.pitch * D2R), tv = thickness / Math.cos(k.pitch * D2R);
    const zEave = plate - out[i] * s;
    const z = Math.min(zEave, fascia > 0 ? zEave + tv - fascia : zEave);
    const poly = [E[i].a, E[i].b, eave[(i + 1) % n], eave[i]];
    if (Math.abs(polyArea(poly)) < 1e4) return;
    plan.soffit.push({ edge: i, poly, z });
  });
  plan.projected = Math.abs(polyArea(offsetPoly(E, kinds.map((k) => k.overhang))));
  plan.area = faces.reduce((s, f) => s + Math.abs(polyArea(f.poly)) / Math.cos(f.pitch * D2R), 0);
  const sum = (kind) => plan.lines.filter((l) => l.kind === kind).reduce((s, l) => s + l.len, 0);
  plan.lengths = { ridge: sum('ridge'), hip: sum('hip'), valley: sum('valley'), eave: plan.fascia.filter((x) => x.kind === 'eave').reduce((s, x) => s + x.len, 0), rake: plan.fascia.filter((x) => x.kind === 'rake').reduce((s, x) => s + x.len, 0) };
  return plan;
}
function onFace(f, l) {
  const near = (p) => f.poly.some((q, i) => { const r = f.poly[(i + 1) % f.poly.length]; return segDist(p, q, r) < 1; });
  return near(l.a) && near(l.b);
}
/** The polygon with each edge moved out by its own distance (consecutive lines meet), one point per corner. */
function offsetPoly(E, d) {
  const n = E.length, out = [];
  for (let i = 0; i < n; i++) {
    const f = E[(i + n - 1) % n], e = E[i];
    const p0 = [f.a[0] - f.n[0] * d[(i + n - 1) % n], f.a[1] - f.n[1] * d[(i + n - 1) % n]], p1 = [e.a[0] - e.n[0] * d[i], e.a[1] - e.n[1] * d[i]];
    const c = cross(f.u, e.u);
    // collinear neighbours: one point (with different overhangs the eave between them leans a little)
    if (Math.abs(c) < 1e-9) { out.push(p1); continue; }
    const tt = cross(sub(p1, p0), e.u) / c;
    out.push([p0[0] + f.u[0] * tt, p0[1] + f.u[1] * tt]);
  }
  return out;
}
function simple(P) {
  const n = P.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
    const a = P[i], b = P[(i + 1) % n], c = P[j], d = P[(j + 1) % n];
    const d1 = cross(sub(b, a), sub(c, a)), d2 = cross(sub(b, a), sub(d, a)), d3 = cross(sub(d, c), sub(a, c)), d4 = cross(sub(d, c), sub(b, c));
    if (((d1 > 1e-6 && d2 < -1e-6) || (d1 < -1e-6 && d2 > 1e-6)) && ((d3 > 1e-6 && d4 < -1e-6) || (d3 < -1e-6 && d4 > 1e-6))) return false;
  }
  return polyArea(P) > 0;
}

/** Height of the roof's underside over p (mm above the walls' level), null outside it. */
export function heightAt(plan, p) {
  let best = null;
  for (const f of plan.faces) if (inPoly(p[0], p[1], f.poly)) { const z = faceZ(f, p); if (best === null || z > best) best = z; }
  return best;
}
function inPoly(x, y, p) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ------------------------------------------------------------------------------------------------------------ writing
/**
 * Make a roof's parts again: { slabs per face, gable walls, one fascia member, one soffit covering } aggregated by the
 * roof. r = model-slabs.js readDerived roof (+ edges, plate, rake, fascia, soffit); ctx = { levels, L (storeyLoops),
 * outline, wallsLv, top, shapeKey }. → { parts, plan } | null (the outline can't be roofed: the old parts stay).
 */
export function writeRoofParts(w, r, { wallsLv, L, outline, top }) {
  const kinds = edgeKinds(outline.poly, L.walls, r);
  const plate = Number.isFinite(r.plate) && r.plate > 0 ? r.plate : top;
  const fascia = Number.isFinite(r.fascia) ? r.fascia : ROOF_DEFAULTS.fascia;
  const plan = roofGeometry(outline.poly, kinds, { thickness: r.thickness, plate, fascia, fasciaT: ROOF_DEFAULTS.fasciaT, soffit: r.soffit !== false });
  if (plan.error) return null;
  const host = w.api.GetLine(w.mid, r.storey, false);
  const M = mul4(inv4(w.storeyWorld(r.storey)), w.storeyWorld(wallsLv.id));
  const P = (x, y, z) => apply4(M, x, y, z), D = (x, y, z) => { const a = apply4(M, x, y, z), o = apply4(M, 0, 0, 0); return [a[0] - o[0], a[1] - o[1], a[2] - o[2]]; };
  const X3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  if (r.parts.length) w.dropProduct(r.parts);
  const parts = [];
  const place = () => w.placeAt(host.ObjectPlacement.value, 0, 0, 0, 0);
  // faces: each in its own sloped plane, swept straight up so neighbours meet on the vertical plane of their ridge / hip
  const slabName = w.L(tr('model.roof.slab'));
  const roofing = w.surfaceStyle(tr('model.style.roofing'), [0.42, 0.33, 0.3], 0);
  for (const f of plan.faces) {
    const cos = Math.cos(f.pitch * D2R), sin = Math.sin(f.pitch * D2R);
    const o = [f.n[0] * f.c, f.n[1] * f.c];   // on the face's eave line, where z = f.start
    const o3 = P(o[0], o[1], f.start);
    const X = D(f.u[0], f.u[1], 0), Y = D(f.n[0] * cos, f.n[1] * cos, sin), Z = X3(X, Y);
    const prof = f.poly.map((p) => [(p[0] - o[0]) * f.u[0] + (p[1] - o[1]) * f.u[1], ((p[0] - o[0]) * f.n[0] + (p[1] - o[1]) * f.n[1]) / cos]);
    const sid = w.make('IFCSLAB', w.guid(), w.ownerHistory(), slabName, null, slabName, w.H(place()), null, null, 'ROOF');
    const solid = w.extrudeAt(w.profile(prof), w.axisFrame(o3, Z, X), r.thickness / cos, [0, sin, cos]);
    w.styleItem(solid, roofing);
    w.setShape(sid, [w.rep('body', 'Body', 'SweptSolid', [solid])]);
    w.upsertPset(sid, 'CadCraft_RoofFace', [['PitchDegrees', 'IFCREAL', round(f.pitch, 4)], ['Edge', 'IFCINTEGER', f.edge]]);
    parts.push(sid);
  }
  // gable ends: from the top of the wall below up to the roof's underside, as thick as that wall
  const gableName = w.L(tr('model.roof.gable'));
  for (const gb of plan.gables) {
    const a = gb.a, b = gb.b, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], n = [-u[1], u[0]];
    const wall = L.walls.find((x) => x.guid === kinds[gb.edge].wall) || nearestWall(L.walls, a, b);
    const base = wall ? wall.baseOffset + wall.height : top;
    const pts = [];
    for (let k = 0; k <= 64; k++) {
      const tt = k / 64, q = [a[0] + (b[0] - a[0]) * tt + n[0], a[1] + (b[1] - a[1]) * tt + n[1]];
      const z = heightAt(plan, q);
      if (z !== null && z > base + 1) pts.push([tt * len, z - base]);
    }
    if (pts.length < 2) continue;
    const prof0 = [[pts[0][0], 0], [pts[pts.length - 1][0], 0], ...pts.reverse()];
    const prof = prof0.filter((p, i) => i < 2 || i === prof0.length - 1 || Math.abs((prof0[i + 1][1] - p[1]) * (p[0] - prof0[i - 1][0]) - (p[1] - prof0[i - 1][1]) * (prof0[i + 1][0] - p[0])) > 1e-3);
    const th = wall ? wall.t : 6 * IN;
    const Xd = D(u[0], u[1], 0), Zd = D(n[0], n[1], 0), Yd = X3(Zd, Xd), flip = Yd[2] < 0;
    const gid = w.make('IFCWALL', w.guid(), w.ownerHistory(), gableName, null, gableName, w.H(place()), null, null, ...(w.v4 ? ['STANDARD'] : []));
    w.setShape(gid, [w.rep('body', 'Body', 'SweptSolid', [w.extrudeAt(w.profile(flip ? prof.map(([x, y]) => [x, -y]) : prof), w.axisFrame(P(a[0], a[1], base), Zd, Xd), th)])]);
    parts.push(gid);
  }
  // fascia: one member, a board per run (outward from the roof's edge, its top flush with the roof's top)
  const boards = plan.fascia.filter((x) => x.board !== false && fascia > 0);
  if (boards.length) {
    const trim = w.surfaceStyle(tr('res.style.trim'), [0.93, 0.92, 0.88], 0);
    const items = [];
    for (const fb of boards) {
      const L2 = Math.hypot(fb.b[0] - fb.a[0], fb.b[1] - fb.a[1]), u = [(fb.b[0] - fb.a[0]) / L2, (fb.b[1] - fb.a[1]) / L2];
      const out = [-fb.n[0], -fb.n[1]];   // outward
      const Xd = D(u[0], u[1], 0), Zd = D(out[0], out[1], 0), Yd = X3(Zd, Xd), flip = Yd[2] < 0;
      const prof = [[0, -fascia], [L2, fb.b[2] - fb.a[2] - fascia], [L2, fb.b[2] - fb.a[2]], [0, 0]];
      const solid = w.extrudeAt(w.profile(flip ? prof.map(([x, y]) => [x, -y]).reverse() : prof), w.axisFrame(P(fb.a[0], fb.a[1], fb.a[2]), Zd, Xd), ROOF_DEFAULTS.fasciaT);
      w.styleItem(solid, trim);
      items.push(solid);
    }
    const nm = w.L(tr('res.roof.fascia'));
    const mid = w.make('IFCMEMBER', w.guid(), w.ownerHistory(), nm, null, w.L('Fascia'), w.H(place()), null, null, ...(w.v4 ? ['USERDEFINED'] : []));   // i18n-ignore: IFC ObjectType
    w.setShape(mid, [w.rep('body', 'Body', 'SweptSolid', items)]);
    w.upsertQto(mid, 'Qto_MemberBaseQuantities', [['Length', 'length', boards.reduce((s, x) => s + x.len, 0)]]);
    w.upsertPset(mid, 'CadCraft_Fascia', [['Height', 'IFCPOSITIVELENGTHMEASURE', round(w.u(fascia))], ['Thickness', 'IFCPOSITIVELENGTHMEASURE', round(w.u(ROOF_DEFAULTS.fasciaT))], ['EaveLength', 'IFCLENGTHMEASURE', round(w.u(plan.lengths.eave))], ['RakeLength', 'IFCLENGTHMEASURE', round(w.u(plan.lengths.rake))]]);
    parts.push(mid);
  }
  // soffit: one covering, a level panel per eave
  if (plan.soffit.length) {
    const items = [];
    let area = 0;
    for (const s of plan.soffit) {
      // the panel in the walls' plan axes, placed through the walls' storey → the roof's storey
      items.push(w.extrudeAt(w.profile(s.poly), w.axisFrame(P(0, 0, s.z - ROOF_DEFAULTS.soffitT), D(0, 0, 1), D(1, 0, 0)), ROOF_DEFAULTS.soffitT));
      area += Math.abs(polyArea(s.poly));
    }
    const sty = w.surfaceStyle(tr('res.style.trim'), [0.93, 0.92, 0.88], 0);
    for (const it of items) w.styleItem(it, sty);
    const nm = w.L(tr('res.roof.soffit'));
    const cid = w.make('IFCCOVERING', w.guid(), w.ownerHistory(), nm, null, w.L('Soffit'), w.H(place()), null, null, 'CEILING');   // i18n-ignore: IFC ObjectType
    w.setShape(cid, [w.rep('body', 'Body', 'SweptSolid', items)]);
    w.upsertPset(cid, 'Pset_CoveringCommon', [['IsExternal', 'IFCBOOLEAN', true]]);
    w.upsertQto(cid, 'Qto_CoveringBaseQuantities', [['Width', 'length', ROOF_DEFAULTS.soffitT], ['GrossArea', 'area', area], ['NetArea', 'area', area]]);
    parts.push(cid);
  }
  // the roof aggregates its parts
  let rel = null;
  for (const rid of ids(w.api, w.mid, 'IFCRELAGGREGATES')) { const x = w.api.GetLine(w.mid, rid, false); if (x.RelatingObject?.value === r.id) { rel = rid; break; } }
  if (rel) { const x = w.touch(rel); x.RelatedObjects = parts.map((p) => w.H(p)); w.write(x); }
  else if (parts.length) w.make('IFCRELAGGREGATES', w.guid(), w.ownerHistory(), null, null, w.H(r.id), parts.map((p) => w.H(p)));
  w.upsertQto(r.id, 'Qto_RoofBaseQuantities', [['GrossArea', 'area', plan.area], ['NetArea', 'area', plan.area], ['ProjectedArea', 'area', plan.projected]]);
  const Lm = (k, v) => [k, 'IFCLENGTHMEASURE', round(w.u(v))];
  w.upsertPset(r.id, 'CadCraft_RoofLines', [Lm('RidgeLength', plan.lengths.ridge), Lm('HipLength', plan.lengths.hip), Lm('ValleyLength', plan.lengths.valley), Lm('EaveLength', plan.lengths.eave), Lm('RakeLength', plan.lengths.rake)]);
  if (w.v4) { const l = w.touch(r.id); l.PredefinedType = roofTypeOf(kinds); w.write(l); }
  return { parts, plan };
}
/** IfcRoofTypeEnum from the edges: one pitched side = shed, gables = gable, else hip. */
export function roofTypeOf(kinds) {
  const p = kinds.filter((k) => k.kind === 'pitch').length;
  if (p === 1) return 'SHED_ROOF';
  if (kinds.some((k) => k.kind === 'gable')) return 'GABLE_ROOF';
  return 'HIP_ROOF';
}
function nearestWall(walls, a, b) {
  const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return walls.map((x) => ({ x, d: segDist(m, x.a, x.b) })).sort((p, q) => p.d - q.d)[0]?.x || null;
}
