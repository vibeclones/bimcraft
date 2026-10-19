/* SPDX-License-Identifier: Apache-2.0 */
/**
 * family-edit.js — what the family editor does to a recipe (0.6 DC.114, session bim-families_PART_2). No DOM:
 * bin/test-bimcraft.mjs --families runs it in Node; family-editor.js is its page.
 *
 * Every function takes a recipe (family-model.js format) and returns { ok, fam } with a changed copy, or { ok: false, error:
 * { key, fill } }; the recipe passed in is never changed. Nothing here writes IFC: the editor saves through family-ops.js
 * saveFamily (one undo step).
 *
 *   names(fam)                               the names an expression may use: parameters, then WallThickness / Face (hosted)
 *   usesOf(fam, key) → [where]               every field that names a parameter
 *   addParam(fam, { key, kind, value, label }) · removeParam(fam, key) (refused while used) · renameParam(fam, from, to)
 *       (every expression follows) · setParam(fam, key, { kind, value, formula, label })
 *   addSolid(fam, op) · removeSolid(fam, id) (its Booleans go too) · duplicateSolid(fam, id) · setSolid(fam, id, patch)
 *   addBoolean(fam, { op, a, b }) · removeBoolean(fam, id) · setBoolean(fam, id, patch) · operands(fam, exceptId) (free ones)
 *   points: pointsOf(s) · movePoint(fam, id, i, [u, v]) · insertPoint(fam, id, i, [u, v]) · removePoint(fam, id, i) ·
 *       setBulge(fam, id, i, b) · cycleArc(b) (straight → quarter arc left → quarter arc right → straight) · snap(v, step)
 *   handles: sizeHandles(fam, values, ctx) and solidHandles(fam, values, id, ctx) → [{ p, axis, label, target }] in the
 *       family's own mm (x, y, z up); dragHandle(fam, values, handle, to, ctx) → { ok, fam, values } — a literal field is set
 *       to the number; a field bound to parameters moves the input parameter it depends on (solved numerically through any
 *       formulas), so the size being previewed changes and the recipe keeps its formulas.
 */
import { parse, evaluate, renameIn, formatNumber, literal, NAME_RE, RESERVED } from './expr.js';
import { readFamily, evaluateFamily, inputParams, sizeValues, planBounds, CONTEXT_NAMES, PARAM_KINDS, SOLID_OPS, STYLES, LIMITS } from './family-model.js';

const err = (key, fill = {}) => ({ ok: false, error: { key, fill } });
const copy = (fam) => JSON.parse(JSON.stringify(fam));
const done = (fam) => ({ ok: true, fam });

export const names = (fam) => [...fam.params.map((p) => p.key), ...(fam.host === 'wall' ? CONTEXT_NAMES : [])];

/** Every expression field of a solid as [field label, getter, setter] (getter/setter on the raw recipe solid). */
function exprFields(s) {
  const out = [];
  const plain = (k) => out.push([k, () => s[k], (v) => { s[k] = v; }]);
  if (s.visible) plain('visible');
  if (s.op === 'box') for (const k of ['x0', 'y0', 'z0', 'x1', 'y1', 'z1']) plain(k);
  else if (s.op === 'extrude' || s.op === 'revolve') {
    plain('at');
    (s.profile || []).forEach((p, i) => { for (const j of [0, 1]) out.push(['profile ' + (i + 1), () => p[j], (v) => { p[j] = v; }]); });
    if (s.op === 'extrude') plain('depth');
    else { (s.axis || []).forEach((a, i) => out.push(['axis ' + (i + 1), () => s.axis[i], (v) => { s.axis[i] = v; }])); plain('angle'); }
  } else {
    (s.path || []).forEach((p, i) => { for (const j of [0, 1, 2]) out.push(['path ' + (i + 1), () => p[j], (v) => { p[j] = v; }]); });
    plain('radius');
  }
  return out;
}
const usesName = (src, key) => { const p = parse(String(src ?? '')); return p.ok && p.uses.includes(key); };

export function usesOf(fam, key) {
  const out = [];
  for (const p of fam.params) if (p.formula && usesName(p.formula, key)) out.push(p.key);
  for (const s of fam.solids) for (const [label, get] of exprFields(s)) if (usesName(get(), key)) out.push((s.name || s.id) + ' ' + label);
  return out;
}

// ======================================================================================================== parameters
const PARAM_RE = NAME_RE;
function keyProblem(fam, key, except = null) {
  if (typeof key !== 'string' || !PARAM_RE.test(key) || RESERVED.has(key) || CONTEXT_NAMES.includes(key)) return err('fam.err.param', { name: String(key ?? '').slice(0, 40) });
  if (fam.params.some((p) => p.key === key && p.key !== except)) return err('fam.err.param', { name: key });
  return null;
}
export function addParam(fam, { key, kind = 'length', value = 0, label = '' } = {}) {
  if (fam.params.length >= LIMITS.params) return err('fam.err.toomany', { what: 'params', n: LIMITS.params });
  const bad = keyProblem(fam, key);
  if (bad) return bad;
  const f = copy(fam);
  const v = Number(value);
  const q = { key, kind: PARAM_KINDS.includes(kind) ? kind : 'number', value: Number.isFinite(v) ? v : 0 };
  if (q.kind === 'yesno') q.value = q.value ? 1 : 0;
  if (label) q.label = String(label).slice(0, LIMITS.name);
  f.params.push(q);
  return done(f);
}
/** A free parameter name: "P1", "P2", … (or `base` + a number). */
export function freeParamKey(fam, base = 'P') {
  for (let i = 1; ; i++) { const k = base + i; if (!keyProblem(fam, k)) return k; }
}
export function removeParam(fam, key) {
  if (!fam.params.some((p) => p.key === key)) return err('fam.err.noparam', { name: key });
  if (fam.host === 'wall' && (key === 'Width' || key === 'Height')) return err('fam.err.needs', { name: key });
  const used = usesOf(fam, key);
  if (used.length) return err('fam.err.paramused', { name: key, where: used.slice(0, 3).join(', ') });
  const f = copy(fam);
  f.params = f.params.filter((p) => p.key !== key);
  return done(f);
}
export function renameParam(fam, from, to) {
  if (from === to) return done(copy(fam));
  if (!fam.params.some((p) => p.key === from)) return err('fam.err.noparam', { name: from });
  if (fam.host === 'wall' && (from === 'Width' || from === 'Height')) return err('fam.err.needs', { name: from });
  const bad = keyProblem(fam, to, from);
  if (bad) return bad;
  const f = copy(fam);
  for (const p of f.params) { if (p.key === from) p.key = to; if (p.formula) p.formula = renameIn(p.formula, from, to); }
  for (const s of f.solids) for (const [, get, set] of exprFields(s)) { const v = get(); if (typeof v === 'string') set(renameIn(v, from, to)); }
  if (Array.isArray(f.sizes)) for (const z of f.sizes) if (z.values && from in z.values) { z.values[to] = z.values[from]; delete z.values[from]; }
  return done(f);
}
export function setParam(fam, key, patch = {}) {
  const f = copy(fam), p = f.params.find((x) => x.key === key);
  if (!p) return err('fam.err.noparam', { name: key });
  if ('kind' in patch && PARAM_KINDS.includes(patch.kind)) { p.kind = patch.kind; if (p.kind === 'yesno') p.value = p.value ? 1 : 0; }
  if ('value' in patch) { const v = Number(patch.value); if (!Number.isFinite(v) || Math.abs(v) > LIMITS.value) return err('fam.err.value', { name: key }); p.value = p.kind === 'yesno' ? (v ? 1 : 0) : v; }
  if ('label' in patch) { const l = String(patch.label ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name); if (l) p.label = l; else delete p.label; }
  if ('formula' in patch) {
    const src = String(patch.formula ?? '').trim();
    if (!src) delete p.formula;
    else {
      if (fam.host === 'wall' && (key === 'Width' || key === 'Height')) return err('fam.err.needs', { name: key });
      const ps = parse(src, names(f).filter((n) => n !== key));
      if (!ps.ok) return err('fam.err.unknown', { where: key, why: ps.error });
      p.formula = src;
    }
  }
  const r = checked(f);
  if (r.ok && 'formula' in patch) {   // a formula that depends on itself is refused at once (other problems show in the preview)
    const ev = evaluateFamily(r.fam, {}, { wallThickness: 140 });
    if (!ev.ok && ev.error.key === 'fam.err.cycle') return { ok: false, error: ev.error, fam: f };
  }
  return r;
}
/** The copy, read back by the untrusted reader (so the editor never keeps a recipe the model would refuse). */
function checked(f) {
  const r = readFamily({ ...f, sizes: undefined });
  if (!r.ok) return { ok: false, error: r.errors[0], fam: f };
  return done(f);
}

// ======================================================================================================== solids
const SOLID_ID_RE = /^[a-z][a-z0-9_-]{0,23}$/;
function freeId(fam, prefix) {
  const have = new Set([...fam.solids.map((s) => s.id), ...(fam.booleans || []).map((b) => b.id)]);
  for (let i = 1; ; i++) if (!have.has(prefix + i)) return prefix + i;
}
/** Where a new solid starts: inside the family's size when it has Width / Depth / Height, else a 300 mm block. */
function frameOf(fam) {
  const has = (k) => fam.params.some((p) => p.key === k);
  const W = has('Width') ? 'Width' : '300', D = has('Depth') ? 'Depth' : fam.host === 'wall' ? 'WallThickness' : '300', H = has('Height') ? 'Height' : '300';
  return { W, D, H, hosted: fam.host === 'wall', centred: fam.host !== 'wall' };
}
export function addSolid(fam, op = 'box') {
  if (!SOLID_OPS.includes(op)) return err('fam.err.solid', { id: String(op) });
  if (fam.solids.length >= LIMITS.solids) return err('fam.err.toomany', { what: 'solids', n: LIMITS.solids });
  const f = copy(fam), id = freeId(f, 's'), F = frameOf(f);
  const half = (x) => `(${x} / 2)`;
  let s;
  if (op === 'box') s = F.hosted ? { id, op, x0: '0', y0: `(-${F.D} / 2)`, z0: '0', x1: F.W, y1: half(F.D), z1: F.H }
    : { id, op, x0: `(-${F.W} / 2)`, y0: '0', z0: '0', x1: half(F.W), y1: F.D, z1: F.H };
  else if (op === 'extrude') s = { id, op, plane: 'xy', at: '0', profile: [['0', '0'], ['200', '0'], ['200', '200'], ['0', '200']], depth: '100' };
  else if (op === 'revolve') s = { id, op, plane: 'xz', at: '0', profile: [['0', '0'], ['150', '0'], ['100', '300'], ['0', '300']], axis: ['0', '0', '0', '1'], angle: '360' };
  else s = { id, op, path: [['0', '0', '0'], ['0', '0', '300'], ['300', '0', '300']], radius: '15' };
  s.style = op === 'box' ? 'solid' : op === 'sweep' ? 'metal' : 'solid';
  f.solids.push(s);
  return { ...checked(f), id };
}
export function removeSolid(fam, id) {
  if (!fam.solids.some((s) => s.id === id)) return err('fam.err.solid', { id });
  if (fam.solids.length === 1) return err('fam.err.nosolids');
  const f = copy(fam);
  f.solids = f.solids.filter((s) => s.id !== id);
  // Booleans that used it, then those that used them
  const gone = new Set([id]);
  let more = true;
  while (more) {
    more = false;
    for (const b of f.booleans || []) if (!gone.has(b.id) && (gone.has(b.a) || gone.has(b.b))) { gone.add(b.id); more = true; }
  }
  f.booleans = (f.booleans || []).filter((b) => !gone.has(b.id));
  return checked(f);
}
export function duplicateSolid(fam, id) {
  const s = fam.solids.find((x) => x.id === id);
  if (!s) return err('fam.err.solid', { id });
  if (fam.solids.length >= LIMITS.solids) return err('fam.err.toomany', { what: 'solids', n: LIMITS.solids });
  const f = copy(fam), nid = freeId(f, 's');
  const c = { ...copy(s), id: nid };
  f.solids.splice(f.solids.findIndex((x) => x.id === id) + 1, 0, c);
  return { ...checked(f), id: nid };
}
/** Change a solid's fields: name, style, visible ('' = always), op-specific fields (numbers or expressions), plane, profile,
 *  path, axis. A field that does not read is refused, naming it. */
export function setSolid(fam, id, patch = {}) {
  const f = copy(fam), s = f.solids.find((x) => x.id === id);
  if (!s) return err('fam.err.solid', { id });
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'name') { const n = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 60); if (n) s.name = n; else delete s.name; continue; }
    if (k === 'style') { if (STYLES[v]) s.style = v; continue; }
    if (k === 'plane') { if (['xy', 'xz', 'yz'].includes(v)) s.plane = v; continue; }
    if (k === 'visible') { const src = String(v ?? '').trim(); if (!src) { delete s.visible; continue; } }
    if (['profile', 'path', 'axis'].includes(k)) { s[k] = copy(v); continue; }
    if (typeof v === 'number') { if (!Number.isFinite(v)) return err('fam.err.field', { id, field: k }); s[k] = formatNumber(v); continue; }
    const src = String(v ?? '').trim();
    if (!src) return err('fam.err.field', { id, field: k });
    const ps = parse(src, names(f));
    if (!ps.ok) return err('fam.err.unknown', { where: (s.name || id) + ' ' + k, why: ps.error });
    s[k] = src;
  }
  return checked(f);
}

// ======================================================================================================== Booleans
/** Solids and Booleans not yet used as an operand (what a new Boolean may take), in the recipe's order. */
export function operands(fam, exceptId = null) {
  const used = new Set();
  for (const b of fam.booleans || []) if (b.id !== exceptId) { used.add(b.a); used.add(b.b); }
  const before = exceptId ? (fam.booleans || []).slice(0, (fam.booleans || []).findIndex((b) => b.id === exceptId)).map((b) => b.id) : (fam.booleans || []).map((b) => b.id);
  return [...fam.solids.map((s) => s.id), ...before].filter((x) => !used.has(x));
}
export function addBoolean(fam, { op = 'difference', a, b } = {}) {
  if ((fam.booleans || []).length >= LIMITS.booleans) return err('fam.err.toomany', { what: 'booleans', n: LIMITS.booleans });
  const free = operands(fam);
  const A = a ?? free[0], B = b ?? free.find((x) => x !== A);
  if (!A || !B || A === B || !free.includes(A) || !free.includes(B)) return err('fam.err.nooperand');
  const f = copy(fam), id = freeId(f, 'b');
  f.booleans = [...(f.booleans || []), { id, op: op === 'union' ? 'union' : 'difference', a: A, b: B }];
  return { ...checked(f), id };
}
export function removeBoolean(fam, id) {
  if (!(fam.booleans || []).some((b) => b.id === id)) return err('fam.err.boolean', { id });
  // a Boolean another one takes as its operand goes with it (the other keeps nothing to cut)
  const f = copy(fam), gone = new Set([id]);
  let more = true;
  while (more) { more = false; for (const b of f.booleans) if (!gone.has(b.id) && (gone.has(b.a) || gone.has(b.b))) { gone.add(b.id); more = true; } }
  f.booleans = f.booleans.filter((b) => !gone.has(b.id));
  return checked(f);
}
export function setBoolean(fam, id, patch = {}) {
  const f = copy(fam), b = (f.booleans || []).find((x) => x.id === id);
  if (!b) return err('fam.err.boolean', { id });
  if (patch.op) b.op = patch.op === 'union' ? 'union' : 'difference';
  const free = new Set([...operands(fam, id)]);
  for (const k of ['a', 'b']) if (patch[k] !== undefined) { if (!free.has(patch[k]) && patch[k] !== b[k]) return err('fam.err.boolean', { id }); b[k] = patch[k]; }
  if (b.a === b.b) return err('fam.err.boolean', { id });
  return checked(f);
}

// ======================================================================================================== profiles and paths
/** The points the sketch edits: a profile's [u, v, bulge?] (extrude / revolve) or a path's [x, y, z] (sweep, x and y drawn). */
export const pointsOf = (s) => (s.op === 'sweep' ? s.path : s.profile) || [];
const ptsKey = (s) => (s.op === 'sweep' ? 'path' : 'profile');
export const snap = (v, step) => (step > 0 ? Math.round(v / step) * step : v);
/** Quarter arcs: bulge = tan(90° / 4). */
export const QUARTER = Math.tan(Math.PI / 8);
export function cycleArc(b) { const x = Number(b) || 0; return x === 0 ? round12(QUARTER) : x > 0 ? round12(-QUARTER) : 0; }
const round12 = (x) => Math.round(x * 1e12) / 1e12;

function editPoints(fam, id, fn) {
  const f = copy(fam), s = f.solids.find((x) => x.id === id);
  if (!s || s.op === 'box') return err('fam.err.solid', { id });
  const pts = pointsOf(s);
  const r = fn(pts, s);
  if (r) return r;
  s[ptsKey(s)] = pts;
  return checked(f);
}
/** A point moved to (u, v) (a path point keeps its z). A point bound to parameters is refused (change it in the table). */
export function movePoint(fam, id, i, [u, v]) {
  return editPoints(fam, id, (pts) => {
    const p = pts[i];
    if (!p) return err('fam.err.points', { id });
    if (literal(p[0]) === null || literal(p[1]) === null) return err('fam.err.bound');
    p[0] = formatNumber(u); p[1] = formatNumber(v);
    return null;
  });
}
/** A point put after point i (−1 = first). */
export function insertPoint(fam, id, i, [u, v]) {
  return editPoints(fam, id, (pts, s) => {
    if (pts.length >= LIMITS.points) return err('fam.err.toomany', { what: 'points', n: LIMITS.points });
    const p = s.op === 'sweep' ? [formatNumber(u), formatNumber(v), pts[Math.max(0, i)]?.[2] ?? '0'] : [formatNumber(u), formatNumber(v)];
    pts.splice(i + 1, 0, p);
    return null;
  });
}
export function removePoint(fam, id, i) {
  return editPoints(fam, id, (pts, s) => {
    if (!pts[i]) return err('fam.err.points', { id });
    if (pts.length <= (s.op === 'sweep' ? 2 : 3)) return err('fam.err.points', { id });
    pts.splice(i, 1);
    return null;
  });
}
/** The segment from point i to the next one: straight (0) or an arc (bulge = tan(angle / 4); + bulges to the left). */
export function setBulge(fam, id, i, b) {
  return editPoints(fam, id, (pts, s) => {
    if (s.op === 'sweep' || !pts[i]) return err('fam.err.points', { id });
    const x = round12(Number(b) || 0);
    if (Math.abs(x) > 10) return err('fam.err.points', { id });
    if (x) pts[i][2] = x; else pts[i].length = 2;
    return null;
  });
}

// ======================================================================================================== handles
/** The family's visible solids' bounds (x0, y0, z0, x1, y1, z1), or null. */
export function boundsOf(ev) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const s of ev.solids.values()) {
    if (!s.visible) continue;
    const z = solidZ(s), p = planBounds(s);
    if (!p) continue;
    b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[3] = Math.max(b[3], p[2]); b[4] = Math.max(b[4], p[3]);
    b[2] = Math.min(b[2], z[0]); b[5] = Math.max(b[5], z[1]);
  }
  return Number.isFinite(b[0]) ? b : null;
}
/** A solid's height range (z0, z1). */
function solidZ(s) {
  if (s.op === 'box') return [s.box[2], s.box[5]];
  if (s.op === 'sweep') { const zs = s.path.map((p) => p[2]); return [Math.min(...zs) - s.radius, Math.max(...zs) + s.radius]; }
  const vs = s.profile.map((p) => (s.plane === 'xy' ? s.at : p[1]));
  if (s.op === 'extrude' && s.plane === 'xy') return [s.at, s.at + s.depth];
  if (s.op === 'revolve' && s.plane === 'xy') { const r = Math.max(...s.profile.map((p) => Math.hypot(p[0], p[1]))); return [s.at - r, s.at + r]; }
  return [Math.min(...vs), Math.max(...vs)];
}
const AX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** Handles for the size: one per input length parameter that pushes a face of the family out, at the middle of that face
 *  (Width → +x, Depth → +y, Height → +z for a table; a door's Width at its right jamb, Height at its head). */
export function sizeHandles(fam, values, ctx = {}) {
  const ev = evaluateFamily(fam, values, ctx);
  if (!ev.ok) return [];
  const B = boundsOf(ev);
  if (!B) return [];
  const out = [], taken = new Set();
  const lens = inputParams(fam).filter((p) => p.kind === 'length');
  // the parameter that moves each face the most (a 10 mm nudge), named ones first
  const order = [...lens].sort((a, b) => rank(a.key) - rank(b.key));
  for (const p of order) {
    const v = sizeValues(fam, values), e2 = evaluateFamily(fam, { ...v, [p.key]: v[p.key] + 10 }, ctx);
    if (!e2.ok) continue;
    const B2 = boundsOf(e2);
    if (!B2) continue;
    let best = -1, bd = 0.5;
    for (let a = 0; a < 3; a++) { const d = B2[a + 3] - B[a + 3]; if (d > bd && !taken.has(a)) { bd = d; best = a; } }
    if (best < 0) continue;
    taken.add(best);
    const c = [(B[0] + B[3]) / 2, (B[1] + B[4]) / 2, (B[2] + B[5]) / 2];
    c[best] = B[best + 3];
    out.push({ p: c, axis: AX[best], label: p.label || p.key, target: { kind: 'size', key: p.key, axis: best } });
    if (taken.size === 3) break;
  }
  return out;
}
const rank = (k) => ({ Width: 0, Depth: 1, Height: 2 }[k] ?? 3);

/** Handles for one solid: a box's six faces; an extrusion's far end (its depth) and its start (at). */
export function solidHandles(fam, values, id, ctx = {}) {
  const ev = evaluateFamily(fam, values, ctx);
  if (!ev.ok) return [];
  const s = ev.solids.get(id), raw = fam.solids.find((x) => x.id === id);
  if (!s || !raw || !s.visible) return [];
  const out = [];
  if (s.op === 'box') {
    const b = s.box, c = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
    for (let a = 0; a < 3; a++) for (const hi of [0, 1]) {
      const p = c.slice(); p[a] = b[a + hi * 3];
      // the field that holds this face: x0 / x1 are sorted by the evaluator, so find the one whose value is here
      const k0 = 'xyz'[a] + '0', k1 = 'xyz'[a] + '1';
      const v0 = fieldValue(fam, values, ctx, raw[k0]);
      const field = Math.abs(v0 - b[a + hi * 3]) < 1e-6 ? k0 : k1;
      out.push({ p, axis: AX[a].map((x) => (hi ? x : -x)), label: (raw.name || id) + ' ' + field, target: { kind: 'field', id, field, axis: a } });
    }
  } else if (s.op === 'extrude') {
    const n = s.plane === 'xy' ? 2 : s.plane === 'xz' ? 1 : 0;
    const pb = planBounds(s), z = solidZ(s);
    const c = [(pb[0] + pb[2]) / 2, (pb[1] + pb[3]) / 2, (z[0] + z[1]) / 2];
    const end = c.slice(); end[n] = s.at + s.depth;
    const start = c.slice(); start[n] = s.at;
    out.push({ p: end, axis: AX[n], label: (raw.name || id) + ' depth', target: { kind: 'field', id, field: 'depth', axis: n, base: s.at } });
    out.push({ p: start, axis: AX[n].map((x) => -x), label: (raw.name || id) + ' at', target: { kind: 'field', id, field: 'at', axis: n } });
  }
  return out;
}
/** A field's value for these values (NaN when it does not evaluate). */
function fieldValue(fam, values, ctx, src) {
  const ev = evaluateFamily(fam, values, ctx);
  if (!ev.ok) return NaN;
  const p = parse(String(src ?? ''));
  if (!p.ok) return NaN;
  try { return evaluate(p.ast, ev.values); } catch (e) { return NaN; }
}
/** The input parameters a field depends on, through the formulas of driven ones. */
export function inputsOf(fam, src) {
  const p = parse(String(src ?? ''));
  if (!p.ok) return [];
  const inputs = new Set(inputParams(fam).map((q) => q.key)), out = new Set(), seen = new Set();
  const walk = (nm) => {
    if (seen.has(nm)) return; seen.add(nm);
    if (inputs.has(nm)) { out.add(nm); return; }
    const q = fam.params.find((x) => x.key === nm);
    if (q?.formula) { const r = parse(q.formula); if (r.ok) r.uses.forEach(walk); }
  };
  p.uses.forEach(walk);
  return [...out];
}
/** Solve g(x) = target for x near x0 (secant, then a bracket and bisection). */
export function solve1(g, x0, target) {
  const f = (x) => { const y = g(x); return Number.isFinite(y) ? y - target : NaN; };
  let a = x0, fa = f(a);
  if (Number.isFinite(fa) && Math.abs(fa) < 1e-7) return a;
  let b = x0 + Math.max(1, Math.abs(x0) * 0.01), fb = f(b);
  for (let k = 0; k < 40 && Number.isFinite(fa) && Number.isFinite(fb) && fb !== fa; k++) {
    const c = b - fb * (b - a) / (fb - fa), fc = f(c);
    if (Number.isFinite(fc) && Math.abs(fc) < 1e-7) return c;
    a = b; fa = fb; b = c; fb = fc;
  }
  const g0 = f(x0);
  for (let step = 1; step < 1e7; step *= 2) for (const s of [x0 + step, x0 - step]) {
    const gs = f(s);
    if (Number.isFinite(g0) && Number.isFinite(gs) && Math.sign(gs) !== Math.sign(g0)) {
      let lo = x0, hi = s, glo = g0;
      for (let k = 0; k < 200; k++) {
        const mid = (lo + hi) / 2, gm = f(mid);
        if (!Number.isFinite(gm)) break;
        if (Math.abs(gm) < 1e-7 || Math.abs(hi - lo) < 1e-9) return mid;
        if (Math.sign(gm) === Math.sign(glo)) { lo = mid; glo = gm; } else hi = mid;
      }
    }
  }
  return null;
}
/** Drag a handle so its face lands at `to` (mm along the handle's axis line: the coordinate on that axis). */
export function dragHandle(fam, values, h, to, ctx = {}) {
  const v = sizeValues(fam, values), T = h.target;
  // the parameter named for the handle's axis (Width for x, Depth for y, Height for z) when the field uses it, else the first
  const pick = (cands) => cands.find((k) => rank(k) === T.axis) || [...cands].sort((a, b) => rank(a) - rank(b))[0];
  if (T.kind === 'size') {
    const g = (x) => { const e = evaluateFamily(fam, { ...v, [T.key]: x }, ctx); const B = e.ok ? boundsOf(e) : null; return B ? B[T.axis + 3] : NaN; };
    const x = solve1(g, v[T.key], to);
    if (x === null || !(x > 0)) return err('fam.err.handle');
    return { ok: true, fam, values: { ...v, [T.key]: round3(x) } };
  }
  const raw = fam.solids.find((s) => s.id === T.id);
  if (!raw) return err('fam.err.solid', { id: T.id });
  const want = T.field === 'depth' ? to - (T.base ?? 0) : to;
  const src = raw[T.field];
  if (literal(src) !== null) {
    const r = setSolid(fam, T.id, { [T.field]: round3(want) });
    return r.ok ? { ok: true, fam: r.fam, values: v } : r;
  }
  const ins = inputsOf(fam, src);
  if (!ins.length) return err('fam.err.handle');
  const key = pick(ins);
  const g = (x) => fieldValue(fam, { ...v, [key]: x }, ctx, src);
  const x = solve1(g, v[key], want);
  if (x === null) return err('fam.err.handle');
  const p = inputParams(fam).find((q) => q.key === key);
  if (p.kind === 'length' && !(x > 0)) return err('fam.err.handle');
  return { ok: true, fam, values: { ...v, [key]: round3(x) } };
}
const round3 = (x) => Math.round(x * 1000) / 1000;
