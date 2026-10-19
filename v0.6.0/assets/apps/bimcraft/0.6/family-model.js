/* SPDX-License-Identifier: Apache-2.0 */
/**
 * family-model.js — families on top of IFC types (0.6 DC.114, session bim-families_PART_2; spike docs/spikes/bim-families_PART_2.md).
 * No DOM: bin/test-bimcraft.mjs --families runs it in Node.
 *
 * A family is BimCraft's idea; the file holds only plain IFC that other programs read as ordinary types:
 *   family  IfcGroup (ObjectType "Family") + IfcRelAssignsToGroup → its sizes' types; pset CadCraft_Family on the group
 *           (Key, Category, Version, Recipe = the recipe as JSON in one IfcText)
 *   size    one IfcDoorType / IfcWindowType / IfcFurnitureType / … (IFC2X3: IfcDoorStyle / IfcWindowStyle) per size, its
 *           RepresentationMaps = the size's solids; pset CadCraft_FamilySize in HasPropertySets (Family, Size, Values JSON)
 *   element IfcRelDefinesByType → its size's type
 * Geometry stays IFC's own (DC.115): box / extrusion → IfcExtrudedAreaSolid, revolve → IfcRevolvedAreaSolid, sweep →
 * IfcSweptDiskSolid, a cut or a join → IfcBooleanResult (wrapped in IfcCsgSolid, so the representation is 'SolidModel').
 *
 * The recipe ("cadcraft-family" version 1, read with readFamily as untrusted data):
 *   { format, version, key, name, kind: door | window | furniture | fixture | generic, host: wall | none, base (a starter door /
 *     window kind for hosted families: its plan symbol, hand and IFC operation), ifc: { class, predefined },
 *     params: [{ key, label?, kind: length | angle | number | yesno, value, formula? }],
 *     solids: [{ id, name?, op: box | extrude | revolve | sweep, style, visible?, …fields }], booleans: [{ id, op: difference |
 *     union, a, b }], sizes?: [{ name, values }] (files only), notes?, license? }
 *   Fields are numbers or expressions (expr.js, PartCraft's language): params by key; a hosted family also reads
 *   WallThickness (mm) and Face (1 | −1) from its wall. A param with a formula is driven. `visible` is an expression (a Yes /
 *   No parameter, or a comparison): 0 hides the solid. Coordinates in mm; a hosted family's axes are the opening's (x along
 *   the wall from the opening's start, y across from the wall's middle, z up from the sill); others' are the element's own.
 *   box { x0, y0, z0, x1, y1, z1 } · extrude { plane xy | xz | yz, at, profile [[u, v, bulge?]…], depth } (along +z, +y, +x) ·
 *   revolve { plane, at, profile, axis [u0, v0, u1, v1], angle (degrees) } · sweep { path [[x, y, z]…], radius }
 *
 *   readFamily(obj) → { ok, family, errors: [{ key, fill }] }
 *   evaluateFamily(fam, values, { wallThickness, face }) → { ok, values, solids: Map, roots } | { ok: false, error: { key, fill } }
 *   bodyItems(w, ev) → { items, type }                           IFC items (styled) for an evaluated family
 *   inputParams(fam) / sizeValues(fam, values) / sizeKey(fam, values) / defaultSizeName(fam, values)
 *   familyIndex(w) → { groups: Map key → { id, fam }, sizes: Map typeId → { family, name, values } , occ: Map typeId → [ids] }
 *   familyFor(w, key) → recipe (stored, else a starter) | null      storeFamily(w, fam) → group id (made or updated)
 *   sizeTypeFor(w, fam, values, { name, op }) → type id (found by its values, else made)
 *   writeSizeMaps(w, typeId, fam, values)                         the type's maps made again (the map lines stay)
 *   typePset(w, typeId, name) / setTypePset(w, typeId, name, rows)
 *   STYLES, FAMILY_PSET, SIZE_PSET, IFC_CLASSES, newFamilyKey(rand)
 */
import { parse, evaluate, ExprError, NAME_RE, RESERVED } from './expr.js';
import { starterRecipe } from './family-starters.js';
import { openingType } from './opening-types.js';
import { round } from './model-write.js';
import { ids, val, deleteLine } from './ifc-util.js';
import { t as tr } from './i18n.js';

export const FAMILY_FORMAT = 'cadcraft-family';
export const FAMILY_PSET = 'CadCraft_Family';
export const SIZE_PSET = 'CadCraft_FamilySize';
export const FAMILY_OBJECT_TYPE = 'Family';   // i18n-ignore: ObjectType written into the IFC file
export const NOMINAL_WALL = 140;   // mm: the frame depth a hosted family's type is drawn at (each element follows its own wall)
export const CONTEXT_NAMES = ['WallThickness', 'Face'];
export const KINDS = ['door', 'window', 'furniture', 'fixture', 'generic'];
export const PARAM_KINDS = ['length', 'angle', 'number', 'yesno'];
export const SOLID_OPS = ['box', 'extrude', 'revolve', 'sweep'];
export const PLANES = ['xy', 'xz', 'yz'];
/** Element classes a family may be (IFC4 names); hosted families are doors or windows. */
export const IFC_CLASSES = ['IfcDoor', 'IfcWindow', 'IfcFurniture', 'IfcFurnishingElement', 'IfcBuildingElementProxy', 'IfcSanitaryTerminal', 'IfcLightFixture'];
/** Colours; the door and window ones are model-openings.js's (same names, so a starter door is written as before). */
export const STYLES = {
  frame: { name: 'model.style.frame', rgb: [0.93, 0.92, 0.89], tr: 0 },
  leaf: { name: 'model.style.leaf', rgb: [0.72, 0.56, 0.38], tr: 0 },
  glass: { name: 'model.style.glass', rgb: [0.62, 0.79, 0.89], tr: 0.6 },
  garage: { name: 'model.style.garage', rgb: [0.86, 0.86, 0.84], tr: 0 },
  wood: { name: 'fam.style.wood', rgb: [0.78, 0.64, 0.45], tr: 0 },
  metal: { name: 'fam.style.metal', rgb: [0.62, 0.64, 0.67], tr: 0 },
  stone: { name: 'fam.style.stone', rgb: [0.82, 0.8, 0.76], tr: 0 },
  solid: { name: 'fam.style.solid', rgb: [0.8, 0.8, 0.8], tr: 0 },
};
export const LIMITS = { params: 60, solids: 200, booleans: 100, points: 400, expr: 300, sizes: 200, name: 80, notes: 2000, value: 1e7 };

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const ID_RE = /^[a-z][a-z0-9_-]{0,23}$/;
const CTRL = /[\u0000-\u001f\u007f]/g;
const cleanText = (s, max) => String(s ?? '').replace(CTRL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const err = (key, fill = {}) => ({ key, fill });
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

/** A new family's key: "fam-" + 8 letters / digits. */
export function newFamilyKey(rand = () => Math.random()) {
  let s = 'fam-';
  for (let i = 0; i < 8; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rand() * 36) % 36];
  return s;
}

// ======================================================================================================== reading a recipe
/** An expression field: a finite number, or text the parser takes (checked against the names later). */
function exprField(v) {
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= LIMITS.value ? String(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > LIMITS.expr) return null;
  return parse(s).ok ? s : null;
}

export function readFamily(obj) {
  const errors = [];
  const bad = (key, fill) => { errors.push(err(key, fill)); return null; };
  if (!isObj(obj)) return { ok: false, family: null, errors: [err('fam.err.notfamily')] };
  if (obj.format !== FAMILY_FORMAT) return { ok: false, family: null, errors: [err('fam.err.notfamily')] };
  if (obj.version !== 1) return { ok: false, family: null, errors: [err('fam.err.version', { v: String(obj.version).slice(0, 12) })] };
  const f = { format: FAMILY_FORMAT, version: 1 };
  f.key = typeof obj.key === 'string' && KEY_RE.test(obj.key) ? obj.key : bad('fam.err.key');
  f.name = cleanText(obj.name, LIMITS.name) || bad('fam.err.name');
  f.kind = KINDS.includes(obj.kind) ? obj.kind : 'generic';
  f.host = obj.host === 'wall' ? 'wall' : 'none';
  const ifc = isObj(obj.ifc) ? obj.ifc : {};
  f.ifc = { class: IFC_CLASSES.includes(ifc.class) ? ifc.class : 'IfcBuildingElementProxy' };
  if (typeof ifc.predefined === 'string' && /^[A-Z_]{1,40}$/.test(ifc.predefined)) f.ifc.predefined = ifc.predefined;
  f.base = '';
  if (f.host === 'wall') {
    const ot = openingType(obj.base);
    if (!ot || (f.kind !== 'door' && f.kind !== 'window') || ot.kind !== f.kind) bad('fam.err.base');
    else f.base = obj.base;
    f.ifc.class = f.kind === 'door' ? 'IfcDoor' : 'IfcWindow';
  } else if (f.ifc.class === 'IfcDoor' || f.ifc.class === 'IfcWindow') f.ifc.class = 'IfcBuildingElementProxy';
  if (obj.starter === true) f.starter = true;
  // parameters
  const params = Array.isArray(obj.params) ? obj.params.slice(0, LIMITS.params + 1) : [];
  if (params.length > LIMITS.params) bad('fam.err.toomany', { what: 'params', n: LIMITS.params });
  f.params = [];
  const seen = new Set(CONTEXT_NAMES);
  for (const p of params.slice(0, LIMITS.params)) {
    if (!isObj(p) || typeof p.key !== 'string' || !NAME_RE.test(p.key) || RESERVED.has(p.key) || seen.has(p.key)) { bad('fam.err.param', { name: String(p?.key ?? '').slice(0, 40) }); continue; }
    seen.add(p.key);
    const q = { key: p.key, kind: PARAM_KINDS.includes(p.kind) ? p.kind : 'number' };
    const v = Number(p.value);
    q.value = Number.isFinite(v) && Math.abs(v) <= LIMITS.value ? (q.kind === 'yesno' ? (v ? 1 : 0) : v) : 0;
    if (p.label !== undefined) { const l = cleanText(p.label, LIMITS.name); if (l) q.label = l; }
    if (p.formula !== undefined && p.formula !== null && p.formula !== '') {
      const fx = exprField(p.formula);
      if (fx === null) bad('fam.err.formula', { name: p.key }); else q.formula = fx;
    }
    f.params.push(q);
  }
  if (f.host === 'wall') for (const k of ['Width', 'Height']) {
    const p = f.params.find((x) => x.key === k);
    if (!p || p.kind !== 'length' || p.formula) bad('fam.err.needs', { name: k });
  }
  // solids
  const solids = Array.isArray(obj.solids) ? obj.solids : [];
  if (solids.length > LIMITS.solids) bad('fam.err.toomany', { what: 'solids', n: LIMITS.solids });
  f.solids = [];
  const idSeen = new Set();
  for (const s of solids.slice(0, LIMITS.solids)) {
    if (!isObj(s) || typeof s.id !== 'string' || !ID_RE.test(s.id) || idSeen.has(s.id) || !SOLID_OPS.includes(s.op)) { bad('fam.err.solid', { id: String(s?.id ?? '').slice(0, 24) }); continue; }
    idSeen.add(s.id);
    const q = { id: s.id, op: s.op, style: STYLES[s.style] ? s.style : 'solid' };
    const nm = cleanText(s.name, 60); if (nm) q.name = nm;
    if (s.visible !== undefined && s.visible !== null && s.visible !== '') { const v = exprField(s.visible); if (v === null) bad('fam.err.field', { id: s.id, field: 'visible' }); else q.visible = v; }
    const need = (k) => { const v = exprField(s[k]); if (v === null) bad('fam.err.field', { id: s.id, field: k }); return v; };
    const pts = (k, dim, min) => {
      const a = Array.isArray(s[k]) ? s[k] : null;
      if (!a || a.length < min || a.length > LIMITS.points) { bad('fam.err.points', { id: s.id }); return []; }
      return a.map((p) => {
        if (!Array.isArray(p) || p.length < dim) { bad('fam.err.points', { id: s.id }); return null; }
        const out = p.slice(0, dim).map((x) => exprField(x));
        if (out.some((x) => x === null)) { bad('fam.err.points', { id: s.id }); return null; }
        if (dim === 2 && p.length > 2) { const b = Number(p[2]); if (Number.isFinite(b) && Math.abs(b) <= 10 && b !== 0) out.push(round(b, 12)); }
        return out;
      }).filter(Boolean);
    };
    if (s.op === 'box') for (const k of ['x0', 'y0', 'z0', 'x1', 'y1', 'z1']) q[k] = need(k);
    else if (s.op === 'extrude' || s.op === 'revolve') {
      q.plane = PLANES.includes(s.plane) ? s.plane : 'xy';
      q.at = s.at === undefined ? '0' : need('at');
      q.profile = pts('profile', 2, 2);
      if (q.profile.length < 3 && !(q.profile.length === 2 && q.profile.some((p) => p[2]))) bad('fam.err.points', { id: s.id });   // two points close only with an arc
      if (s.op === 'extrude') q.depth = need('depth');
      else {
        const ax = Array.isArray(s.axis) && s.axis.length === 4 ? s.axis.map(exprField) : null;
        if (!ax || ax.some((x) => x === null)) bad('fam.err.field', { id: s.id, field: 'axis' }); else q.axis = ax;
        q.angle = need('angle');
      }
    } else { q.path = pts('path', 3, 2); q.radius = need('radius'); }
    f.solids.push(q);
  }
  // booleans
  const bools = Array.isArray(obj.booleans) ? obj.booleans : [];
  if (bools.length > LIMITS.booleans) bad('fam.err.toomany', { what: 'booleans', n: LIMITS.booleans });
  f.booleans = [];
  const used = new Set();
  for (const b of bools.slice(0, LIMITS.booleans)) {
    if (!isObj(b) || typeof b.id !== 'string' || !ID_RE.test(b.id) || idSeen.has(b.id) || !['difference', 'union'].includes(b.op)) { bad('fam.err.boolean', { id: String(b?.id ?? '').slice(0, 24) }); continue; }
    if (typeof b.a !== 'string' || typeof b.b !== 'string' || b.a === b.b || !idSeen.has(b.a) || !idSeen.has(b.b) || used.has(b.a) || used.has(b.b)) { bad('fam.err.boolean', { id: b.id }); continue; }
    idSeen.add(b.id); used.add(b.a); used.add(b.b);
    f.booleans.push({ id: b.id, op: b.op, a: b.a, b: b.b });
  }
  // a Boolean names only what came before it, so the tree has no cycle; one using a later Boolean is refused above (idSeen)
  if (!f.solids.length) bad('fam.err.nosolids');
  // sizes kept in a family file
  if (Array.isArray(obj.sizes)) {
    f.sizes = [];
    for (const z of obj.sizes.slice(0, LIMITS.sizes)) {
      if (!isObj(z) || !isObj(z.values)) continue;
      const values = {};
      for (const p of f.params) if (!p.formula && Number.isFinite(Number(z.values[p.key])) && Math.abs(Number(z.values[p.key])) <= LIMITS.value) values[p.key] = Number(z.values[p.key]);
      f.sizes.push({ name: cleanText(z.name, LIMITS.name) || defaultSizeName(f, values), values });
    }
  }
  if (obj.notes !== undefined) { const n = String(obj.notes ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, LIMITS.notes).trim(); if (n) f.notes = n; }
  if (isObj(obj.license)) {
    const id = cleanText(obj.license.id, 40), holder = cleanText(obj.license.holder, 120);
    if (id || holder) f.license = { ...(id ? { id } : {}), ...(holder ? { holder } : {}) };
  }
  // every expression names only known parameters
  if (!errors.length) {
    const names = [...f.params.map((p) => p.key), ...(f.host === 'wall' ? CONTEXT_NAMES : [])];
    const check = (src, where) => { const p = parse(src, names); if (!p.ok) errors.push(err('fam.err.unknown', { where, why: p.error })); };
    for (const p of f.params) if (p.formula) check(p.formula, p.key);
    for (const s of f.solids) for (const [k, v] of fieldsOf(s)) check(v, (s.name || s.id) + ' ' + k);
  }
  return { ok: errors.length === 0, family: errors.length ? null : f, errors };
}

/** Every expression of a solid as [field, text]. */
function fieldsOf(s) {
  const out = [];
  if (s.visible) out.push(['visible', s.visible]);
  if (s.op === 'box') for (const k of ['x0', 'y0', 'z0', 'x1', 'y1', 'z1']) out.push([k, s[k]]);
  else if (s.op === 'extrude' || s.op === 'revolve') {
    out.push(['at', s.at]);
    s.profile.forEach((p, i) => { out.push(['profile ' + (i + 1) + ' u', p[0]], ['profile ' + (i + 1) + ' v', p[1]]); });
    if (s.op === 'extrude') out.push(['depth', s.depth]); else { s.axis.forEach((a, i) => out.push(['axis ' + (i + 1), a])); out.push(['angle', s.angle]); }
  } else { s.path.forEach((p, i) => p.forEach((x, j) => out.push(['path ' + (i + 1) + ' ' + 'xyz'[j], x]))); out.push(['radius', s.radius]); }
  return out;
}

// ======================================================================================================== evaluating
export const inputParams = (fam) => fam.params.filter((p) => !p.formula);

/** The values a size keeps: every input parameter (no formula), from `values`, else its default. */
export function sizeValues(fam, values = {}) {
  const out = {};
  for (const p of inputParams(fam)) { const v = Number(values?.[p.key]); out[p.key] = Number.isFinite(v) ? (p.kind === 'yesno' ? (v ? 1 : 0) : v) : p.value; }
  return out;
}
/** What makes two sizes the same: their input values to 0.001. */
export function sizeKey(fam, values) {
  const v = sizeValues(fam, values);
  return Object.keys(v).sort().map((k) => k + '=' + round(v[k], 3)).join(';');
}
/** "915 × 2032" (mm, whole) for a family with Width and Height; else the first two lengths; else the family's name. */
export function defaultSizeName(fam, values, fmt = (mm) => String(Math.round(mm))) {
  const v = sizeValues(fam, values);
  const lens = inputParams(fam).filter((p) => p.kind === 'length').map((p) => p.key);
  const keys = ['Width', 'Height'].every((k) => k in v) ? ['Width', 'Height'] : lens.slice(0, 3);
  return keys.length ? keys.map((k) => fmt(v[k])).join(' × ') : fam.name;
}

export function evaluateFamily(fam, values = {}, ctx = {}) {
  const env = {};
  try {
    if (fam.host === 'wall') { env.WallThickness = Number.isFinite(ctx.wallThickness) && ctx.wallThickness > 0 ? ctx.wallThickness : NOMINAL_WALL; env.Face = ctx.face === -1 ? -1 : 1; }
    Object.assign(env, sizeValues(fam, values));
    // driven parameters in the order their inputs become known
    let pending = fam.params.filter((p) => p.formula);
    const names = [...fam.params.map((p) => p.key), ...Object.keys(env)];
    while (pending.length) {
      const next = [];
      for (const p of pending) {
        const ps = parse(p.formula, names);
        if (!ps.ok) return { ok: false, error: err('fam.err.expr', { where: p.key, why: ps.error }) };
        if (ps.uses.some((u) => !(u in env))) { next.push(p); continue; }
        env[p.key] = evaluate(ps.ast, env);
      }
      if (next.length === pending.length) return { ok: false, error: err('fam.err.cycle', { name: next[0].key }) };
      pending = next;
    }
  } catch (e) {
    if (e instanceof ExprError) return { ok: false, error: err('fam.err.expr', { where: '', why: e.message }) };
    throw e;
  }
  const num = (src, where) => {
    const p = parse(src);
    if (!p.ok) throw Object.assign(new ExprError(p.error), { where });
    try { return evaluate(p.ast, env); } catch (e) { if (e instanceof ExprError) e.where = where; throw e; }
  };
  const solids = new Map();
  try {
    for (const s of fam.solids) {
      const where = s.name || s.id;
      const visible = s.visible ? num(s.visible, where + ' visible') !== 0 : true;
      const e = { id: s.id, op: s.op, style: s.style, visible, name: s.name || '' };
      if (s.op === 'box') {
        const v = ['x0', 'y0', 'z0', 'x1', 'y1', 'z1'].map((k) => num(s[k], where + ' ' + k));
        e.box = [Math.min(v[0], v[3]), Math.min(v[1], v[4]), Math.min(v[2], v[5]), Math.max(v[0], v[3]), Math.max(v[1], v[4]), Math.max(v[2], v[5])];
        if (visible && (e.box[3] - e.box[0] < 0.01 || e.box[4] - e.box[1] < 0.01 || e.box[5] - e.box[2] < 0.01)) return { ok: false, error: err('fam.err.flat', { name: where }) };
      } else if (s.op === 'extrude' || s.op === 'revolve') {
        e.plane = s.plane; e.at = num(s.at, where + ' at');
        e.profile = s.profile.map((p, i) => [num(p[0], where + ' ' + (i + 1)), num(p[1], where + ' ' + (i + 1)), p[2] || 0]);
        if (visible && Math.abs(polyArea(e.profile)) < 1) return { ok: false, error: err('fam.err.flat', { name: where }) };
        if (s.op === 'extrude') {
          e.depth = num(s.depth, where + ' depth');
          if (e.depth < 0) { e.at += e.depth; e.depth = -e.depth; }
          if (visible && e.depth < 0.01) return { ok: false, error: err('fam.err.flat', { name: where }) };
        } else {
          e.axis = s.axis.map((a, i) => num(a, where + ' axis ' + (i + 1)));
          e.angle = num(s.angle, where + ' angle');
          if (visible && !(e.angle > 0.01 && e.angle <= 360)) return { ok: false, error: err('fam.err.angle', { name: where }) };
          if (visible && !oneSide(e.profile, e.axis)) return { ok: false, error: err('fam.err.axis', { name: where }) };
        }
      } else {
        e.path = s.path.map((p, i) => p.map((x) => num(x, where + ' ' + (i + 1))));
        e.radius = num(s.radius, where + ' radius');
        if (visible && !(e.radius > 0.01)) return { ok: false, error: err('fam.err.flat', { name: where }) };
        if (visible && e.path.some((p, i) => i && Math.hypot(p[0] - e.path[i - 1][0], p[1] - e.path[i - 1][1], p[2] - e.path[i - 1][2]) < 0.01)) return { ok: false, error: err('fam.err.flat', { name: where }) };
      }
      solids.set(s.id, e);
    }
  } catch (e) {
    if (e instanceof ExprError) return { ok: false, error: err('fam.err.expr', { where: e.where || '', why: e.message }) };
    throw e;
  }
  // the Boolean tree: a hidden first operand hides the result; a hidden second one leaves the first as it is
  const nodes = new Map();
  for (const [id, s] of solids) nodes.set(id, s.visible ? { kind: 'solid', id, style: s.style } : null);
  const operand = new Set();
  for (const b of fam.booleans || []) {
    operand.add(b.a); operand.add(b.b);
    const A = nodes.get(b.a), B = nodes.get(b.b);
    nodes.set(b.id, !A ? null : !B ? A : { kind: 'bool', id: b.id, op: b.op, a: A, b: B, style: A.style });
  }
  const roots = [];
  for (const id of [...solids.keys(), ...(fam.booleans || []).map((b) => b.id)]) if (!operand.has(id) && nodes.get(id)) roots.push(nodes.get(id));
  return { ok: true, values: env, solids, roots };
}

/** A profile's area with its arcs (each arc flattened to chords; enough to tell a real outline from a flat one). */
function polyArea(pts) {
  const flat = [];
  pts.forEach((p, i) => { flat.push(p); if (p[2]) flat.push(...arcPoints(p, pts[(i + 1) % pts.length], p[2])); });
  let a = 0;
  for (let i = 0; i < flat.length; i++) { const p = flat[i], q = flat[(i + 1) % flat.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
/** Every profile point on one side of the revolve axis (or on it). */
function oneSide(pts, ax) {
  const dx = ax[2] - ax[0], dy = ax[3] - ax[1], L = Math.hypot(dx, dy);
  if (L < 1e-6) return false;
  let pos = 0, negs = 0;
  for (const p of pts) { const s = (dx * (p[1] - ax[1]) - dy * (p[0] - ax[0])) / L; if (s > 0.01) pos++; else if (s < -0.01) negs++; }
  return !(pos && negs) && (pos || negs);
}

// ======================================================================================================== writing geometry
/** Plane frames: origin on the plane, local X = u, and how a profile's v maps to the frame's local Y (xz: Y = −z). */
function planeFrame(w, plane, at) {
  if (plane === 'xz') return { frame: w.axisFrame([0, at, 0], [0, 1, 0], [1, 0, 0]), flipV: true };
  if (plane === 'yz') return { frame: w.axisFrame([at, 0, 0], [1, 0, 0], [0, 1, 0]), flipV: false };
  return { frame: w.axisFrame([0, 0, at], [0, 0, 1], [1, 0, 0]), flipV: false };
}
/** A closed profile (mm; bulges = arcs): IFC4 IfcIndexedPolyCurve with IfcArcIndex segments, else an IfcPolyline. */
function profileCurve(w, pts, flipV) {
  const P = pts.map((p) => [p[0], flipV ? -p[1] : p[1], flipV ? -(p[2] || 0) : (p[2] || 0)]);
  const arcs = P.some((p) => p[2]);
  if (arcs && w.v4) {
    const list = [], segs = [];
    const add = (x, y) => { list.push([round(w.u(x)), round(w.u(y))]); return list.length; };
    const first = add(P[0][0], P[0][1]);
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], i0 = i === 0 ? first : list.length;
      if (!a[2]) { const i1 = (i + 1) % P.length === 0 ? first : add(b[0], b[1]); segs.push(w.T('IFCLINEINDEX', [i0, i1])); continue; }
      const m = arcMid(a, b, a[2]);
      const im = add(m[0], m[1]), i1 = (i + 1) % P.length === 0 ? first : add(b[0], b[1]);
      segs.push(w.T('IFCARCINDEX', [i0, im, i1]));
    }
    const pl = w.make('IFCCARTESIANPOINTLIST2D', list);
    return w.make('IFCINDEXEDPOLYCURVE', w.H(pl), segs, false);
  }
  // straight pieces; arcs as chords (IFC2X3 has no arc segments in a profile's polyline), 24 to a full turn
  const flat = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    flat.push([a[0], a[1]]);
    if (a[2]) for (const q of arcPoints(a, b, a[2])) flat.push(q);
  }
  return w.polyline2(flat, true);
}
/** The arc's middle point: the chord's middle pushed out by the sagitta (bulge = tan(θ / 4), + = counter-clockwise). */
export function arcMid(a, b, bulge) {
  const dx = b[0] - a[0], dy = b[1] - a[1], c = Math.hypot(dx, dy), s = bulge * c / 2;
  return [(a[0] + b[0]) / 2 + dy / c * s, (a[1] + b[1]) / 2 - dx / c * s];
}
/** Points strictly inside an arc from a to b (chords for a polyline). */
export function arcPoints(a, b, bulge) {
  const th = 4 * Math.atan(bulge), n = Math.max(2, Math.ceil(Math.abs(th) / (Math.PI / 12)));
  const m = arcMid(a, b, bulge);
  // the circle through a, m, b
  const ax = a[0], ay = a[1], bx = m[0], by = m[1], cx = b[0], cy = b[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return [];
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy), a0 = Math.atan2(ay - uy, ax - ux);
  const out = [];
  for (let i = 1; i < n; i++) { const t = a0 + th * i / n; out.push([ux + r * Math.cos(t), uy + r * Math.sin(t)]); }
  return out;
}

/** Plane angles in the file's own unit (radians unless the project says degrees), as mep-model.js reads them. */
function angleK(w) {
  if (w._angleK !== undefined) return w._angleK;
  let k = 1;
  try { for (const id of ids(w.api, w.mid, 'IFCCONVERSIONBASEDUNIT')) { const u = w.api.GetLine(w.mid, id, false); if (String(val(u.UnitType)) === 'PLANEANGLEUNIT' && /deg/i.test(String(val(u.Name)))) k = 180 / Math.PI; } } catch (e) { /* radians */ }
  return (w._angleK = k);
}

function solidItem(w, s) {
  if (s.op === 'box') return w.box(...s.box);
  if (s.op === 'extrude') {
    const { frame, flipV } = planeFrame(w, s.plane, s.at);
    const prof = w.make('IFCARBITRARYCLOSEDPROFILEDEF', 'AREA', null, w.H(profileCurve(w, s.profile, flipV)));
    return w.extrudeAt(prof, frame, s.depth);
  }
  if (s.op === 'revolve') {
    const { frame, flipV } = planeFrame(w, s.plane, s.at);
    const prof = w.make('IFCARBITRARYCLOSEDPROFILEDEF', 'AREA', null, w.H(profileCurve(w, s.profile, flipV)));
    const [u0, v0, u1, v1] = s.axis, f = flipV ? -1 : 1, L = Math.hypot(u1 - u0, v1 - v0);
    const axis = w.make('IFCAXIS1PLACEMENT', w.H(w.point3(round(w.u(u0)), round(w.u(f * v0)), 0)), w.H(w.dir(round((u1 - u0) / L, 12), round(f * (v1 - v0) / L, 12), 0)));
    return w.make('IFCREVOLVEDAREASOLID', w.H(prof), w.H(frame), w.H(axis), round(s.angle * Math.PI / 180 * angleK(w), 9));
  }
  const line = w.polyline3(s.path);
  return w.v4 ? w.make('IFCSWEPTDISKSOLID', w.H(line), round(w.u(s.radius)), null, null, null)
    : w.make('IFCSWEPTDISKSOLID', w.H(line), round(w.u(s.radius)), null, 0, s.path.length - 1);
}
function nodeItem(w, ev, n) {
  if (n.kind === 'solid') return solidItem(w, ev.solids.get(n.id));
  return w.make('IFCBOOLEANRESULT', n.op === 'union' ? 'UNION' : 'DIFFERENCE', w.H(nodeItem(w, ev, n.a)), w.H(nodeItem(w, ev, n.b)));
}
/** The evaluated family's top items, each styled; the representation type that fits them. */
export function bodyItems(w, ev) {
  const items = [];
  const csg = ev.roots.some((n) => n.kind === 'bool');
  const disk = [...ev.solids.values()].some((s) => s.visible && s.op === 'sweep');
  for (const n of ev.roots) {
    let id = nodeItem(w, ev, n);
    if (n.kind === 'bool') id = w.make('IFCCSGSOLID', w.H(id));
    const st = STYLES[n.style] || STYLES.solid;
    w.styleItem(id, w.surfaceStyle(tr(st.name), st.rgb, st.tr));
    items.push(id);
  }
  return { items, type: csg ? 'SolidModel' : disk ? 'AdvancedSweptSolid' : 'SweptSolid' };
}

// ======================================================================================================== families in a file
/** A type's own property set (HasPropertySets) as { prop: value }, or null. */
export function typePset(w, typeId, name) {
  const tl = w.api.GetLine(w.mid, typeId, false);
  for (const h of tl?.HasPropertySets || []) {
    const ps = w.api.GetLine(w.mid, h.value, false);
    if (val(ps?.Name) !== name) continue;
    const out = {};
    for (const p of ps.HasProperties || []) { const pl = w.api.GetLine(w.mid, p.value, false); if (pl?.Name) out[val(pl.Name)] = val(pl.NominalValue); }
    return out;
  }
  return null;
}
/** Replace (or add) a type's own property set. */
export function setTypePset(w, typeId, name, rows) {
  const tl = w.touch(typeId);
  const keep = [];
  for (const h of tl.HasPropertySets || []) {
    const ps = w.api.GetLine(w.mid, h.value, false);
    if (val(ps?.Name) === name) w.dropTree(h.value); else keep.push(h);
  }
  keep.push(w.H(w.pset(name, rows)));
  tl.HasPropertySets = keep;
  w.write(tl);
}
function parseJson(s) { try { return JSON.parse(String(s ?? '')); } catch (e) { return null; } }

/** Every family and size in the file (one pass; cached on the writer until something here changes it). */
export function familyIndex(w) {
  if (w._famIndex) return w._famIndex;
  const groups = new Map(), sizes = new Map(), occ = new Map(), assign = new Map();
  let gl = [];
  try { gl = ids(w.api, w.mid, 'IFCGROUP'); } catch (e) { gl = []; }
  for (const id of gl) {
    const ps = w.readPset(id, FAMILY_PSET);
    if (!ps || !ps.Key) continue;
    const r = readFamily(parseJson(ps.Recipe));
    groups.set(String(ps.Key), { id, fam: r.ok ? r.family : null, errors: r.errors, name: val(w.api.GetLine(w.mid, id, false).Name) || String(ps.Key) });
  }
  for (const rid of ids(w.api, w.mid, 'IFCRELASSIGNSTOGROUP')) {
    const r = w.api.GetLine(w.mid, rid, false);
    if (r?.RelatingGroup) assign.set(r.RelatingGroup.value, rid);
  }
  for (const rid of ids(w.api, w.mid, 'IFCRELDEFINESBYTYPE')) {
    const r = w.api.GetLine(w.mid, rid, false), tid = r?.RelatingType?.value;
    if (!tid) continue;
    if (!occ.has(tid)) occ.set(tid, []);
    for (const h of r.RelatedObjects || []) occ.get(tid).push(h.value);
  }
  for (const [key, g] of groups) {
    const rid = assign.get(g.id);
    g.assign = rid || null;
    const r = rid ? w.api.GetLine(w.mid, rid, false) : null;
    for (const h of r?.RelatedObjects || []) {
      const ps = typePset(w, h.value, SIZE_PSET);
      if (!ps || String(ps.Family) !== key) continue;
      sizes.set(h.value, { family: key, name: String(ps.Size || ''), values: parseJson(ps.Values) || {} });
    }
  }
  return (w._famIndex = { groups, sizes, occ });
}
const dropIndex = (w) => { w._famIndex = null; };

/** The recipe for a family key: the one stored in the file, else a starter's; null when neither. */
export function familyFor(w, key) {
  if (!key) return null;
  const g = familyIndex(w).groups.get(key);
  if (g?.fam) return g.fam;
  return starterRecipe(key);
}
/** The group of a family, made with its recipe when the file has none; the recipe updated when it has one. */
export function storeFamily(w, fam, { update = false } = {}) {
  const idx = familyIndex(w);
  const g = idx.groups.get(fam.key);
  const rows = [['Key', 'IFCIDENTIFIER', fam.key], ['Category', 'IFCLABEL', fam.kind], ['Version', 'IFCINTEGER', 1], ['Recipe', 'IFCTEXT', JSON.stringify(stripFile(fam))]];
  if (g) {
    if (update) {
      w.upsertPset(g.id, FAMILY_PSET, rows);
      const l = w.touch(g.id); l.Name = w.L(fam.name); w.write(l);
      g.fam = fam; g.name = fam.name;
    }
    return g.id;
  }
  const id = w.make('IFCGROUP', w.guid(), w.ownerHistory(), w.L(fam.name), null, w.L(FAMILY_OBJECT_TYPE));
  w.upsertPset(id, FAMILY_PSET, rows);
  idx.groups.set(fam.key, { id, fam, errors: [], name: fam.name, assign: null });
  return id;
}
/** The recipe as kept in the file: sizes live as types, so they are left out. */
function stripFile(fam) { const { sizes, ...rest } = fam; void sizes; return rest; }

/** The type for a size of a family: found by its values, else made (with its maps) and assigned to the family's group. */
export function sizeTypeFor(w, fam, values, { name = null, op = null } = {}) {
  const idx = familyIndex(w), key = sizeKey(fam, values);
  for (const [tid, s] of idx.sizes) if (s.family === fam.key && sizeKey(fam, s.values) === key && w.api.GetLine(w.mid, tid, false)) return tid;
  const gid = storeFamily(w, fam);
  const sv = sizeValues(fam, values), sname = name || defaultSizeName(fam, sv);
  const tid = makeType(w, fam, fam.name + ' ' + sname, op);
  setTypePset(w, tid, SIZE_PSET, sizeRows(w, fam, sname, sv));
  writeSizeMaps(w, tid, fam, sv);
  // the group's assignment: one relation per family, extended
  const g = idx.groups.get(fam.key);
  if (g.assign && w.api.GetLine(w.mid, g.assign, false)) {
    const l = w.touch(g.assign); l.RelatedObjects = [...(l.RelatedObjects || []), w.H(tid)]; w.write(l);
  } else g.assign = w.make('IFCRELASSIGNSTOGROUP', w.guid(), w.ownerHistory(), null, null, [w.H(tid)], null, w.H(gid));
  idx.sizes.set(tid, { family: fam.key, name: sname, values: sv });
  return tid;
}
/** A size type's CadCraft_FamilySize rows (values in mm, as the recipe's; the nominal wall in the file's units). */
export function sizeRows(w, fam, name, values) {
  return [['Family', 'IFCIDENTIFIER', fam.key], ['Size', 'IFCLABEL', name], ['Values', 'IFCTEXT', JSON.stringify(sizeValues(fam, values))],
    ...(fam.host === 'wall' ? [['NominalWallThickness', 'IFCPOSITIVELENGTHMEASURE', round(w.u(NOMINAL_WALL))]] : [])];
}

/** A type line of the family's class (IFC4 types; IFC2X3 door / window styles), no maps yet. */
function makeType(w, fam, name, op) {
  const base = openingType(fam.base);
  const head = [w.guid(), w.ownerHistory(), w.L(name), null, null, null, null, null];
  const cls = fam.ifc.class, pre = fam.ifc.predefined || 'NOTDEFINED';
  if (cls === 'IfcDoor') {
    const oper = op || base?.op?.[0] || 'NOTDEFINED';
    return w.v4 ? w.make('IFCDOORTYPE', ...head, w.L(fam.name), 'DOOR', oper, false, null) : w.make('IFCDOORSTYLE', ...head, oper, 'NOTDEFINED', false, false);
  }
  if (cls === 'IfcWindow') {
    const part = base?.part || 'NOTDEFINED';
    return w.v4 ? w.make('IFCWINDOWTYPE', ...head, w.L(fam.name), 'WINDOW', part, false, null) : w.make('IFCWINDOWSTYLE', ...head, 'NOTDEFINED', part, false, false);
  }
  if (cls === 'IfcFurniture') return w.v4 ? w.make('IFCFURNITURETYPE', ...head, w.L(fam.name), 'NOTDEFINED', pre) : w.make('IFCFURNITURETYPE', ...head, w.L(fam.name), 'NOTDEFINED');
  if (cls === 'IfcFurnishingElement') return w.make('IFCFURNISHINGELEMENTTYPE', ...head, w.L(fam.name));
  if (cls === 'IfcSanitaryTerminal') return w.make('IFCSANITARYTERMINALTYPE', ...head, w.L(fam.name), 'NOTDEFINED');
  if (cls === 'IfcLightFixture') return w.make('IFCLIGHTFIXTURETYPE', ...head, w.L(fam.name), 'NOTDEFINED');
  return w.make('IFCBUILDINGELEMENTPROXYTYPE', ...head, w.L(fam.name), 'NOTDEFINED');
}

/** The size's geometry as the type's maps: Body (the solids) and, for families placed on a floor, a FootPrint outline. The
 *  map lines stay (elements' IfcMappedItems point at them); their representations are made again. */
export function writeSizeMaps(w, typeId, fam, values) {
  const ev = evaluateFamily(fam, values, {});
  if (!ev.ok) throw Object.assign(new Error(ev.error.key), { key: ev.error.key, fill: ev.error.fill });
  const ctx = w.contexts();
  const body = bodyItems(w, ev);
  const reps = [['body', 'Body', body.type, body.items]];
  if (fam.host !== 'wall') {
    const fp = footprint(w, ev);
    if (fp) reps.push(['foot', 'FootPrint', 'GeometricCurveSet', [fp]]);
  }
  const tl = w.touch(typeId);
  const old = (tl.RepresentationMaps || []).map((h) => ({ id: h.value, line: w.api.GetLine(w.mid, h.value, false) })).filter((x) => x.line);
  const maps = [];
  for (const [ck, ident, type, items] of reps) {
    const rep = w.make('IFCSHAPEREPRESENTATION', w.H(ck === 'body' ? ctx.body : ctx.foot), w.L(ident), w.L(type), items.map((i) => w.H(i)));
    const was = old.find((x) => val(w.api.GetLine(w.mid, x.line.MappedRepresentation.value, false)?.RepresentationIdentifier) === ident);
    if (was) {
      const ml = w.touch(was.id), prev = ml.MappedRepresentation.value;
      ml.MappedRepresentation = w.H(rep); w.write(ml);
      w.dropTree(prev);
      maps.push(w.H(was.id));
    } else maps.push(w.H(w.make('IFCREPRESENTATIONMAP', w.H(w.origin()), w.H(rep))));
  }
  // maps no longer made (a footprint that went): their elements' mapped items go first
  for (const x of old) if (!maps.some((h) => h.value === x.id)) dropMap(w, x.id);
  tl.RepresentationMaps = maps;
  w.write(tl);
}
/** A map and the mapped items (and their representations) that point at it. */
function dropMap(w, mapId) {
  for (const mi of ids(w.api, w.mid, 'IFCMAPPEDITEM')) {
    const l = w.api.GetLine(w.mid, mi, false);
    if (l?.MappingSource?.value !== mapId) continue;
    for (const rid of ids(w.api, w.mid, 'IFCSHAPEREPRESENTATION')) {
      const r = w.api.GetLine(w.mid, rid, false);
      if (!(r?.Items || []).some((h) => h.value === mi)) continue;
      for (const pid of ids(w.api, w.mid, 'IFCPRODUCTDEFINITIONSHAPE')) {
        const p = w.api.GetLine(w.mid, pid, false);
        if (!(p?.Representations || []).some((h) => h.value === rid)) continue;
        const pl = w.touch(pid); pl.Representations = pl.Representations.filter((h) => h.value !== rid); w.write(pl);
      }
      w.touch(rid); deleteLine(w.api, w.mid, rid);
    }
    w.touch(mi); deleteLine(w.api, w.mid, mi);
  }
  const rep = w.api.GetLine(w.mid, mapId, false)?.MappedRepresentation?.value;
  w.touch(mapId); deleteLine(w.api, w.mid, mapId);
  if (rep) w.dropTree(rep);
}
/** The plan outline of an unhosted family: each visible solid's outline seen from above, as 2D polylines. */
function footprint(w, ev) {
  const loops = [];
  for (const s of ev.solids.values()) {
    if (!s.visible) continue;
    if (s.op === 'box') { const [x0, y0, , x1, y1] = s.box; loops.push([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]); }
    else if (s.op === 'extrude' && s.plane === 'xy') {
      const flat = [];
      s.profile.forEach((a, i) => { flat.push([a[0], a[1]]); if (a[2]) flat.push(...arcPoints(a, s.profile[(i + 1) % s.profile.length], a[2])); });
      loops.push(flat);
    } else {
      const b = planBounds(s);
      if (b) loops.push([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]);
    }
  }
  if (!loops.length) return null;
  return w.make('IFCGEOMETRICCURVESET', loops.map((l) => w.H(w.polyline2(l, true))));
}
/** A solid's plan bounds [x0, y0, x1, y1] (conservative for revolves: the profile swept a whole turn). */
export function planBounds(s) {
  if (s.op === 'box') return [s.box[0], s.box[1], s.box[3], s.box[4]];
  if (s.op === 'sweep') { const xs = s.path.map((p) => p[0]), ys = s.path.map((p) => p[1]); return [Math.min(...xs) - s.radius, Math.min(...ys) - s.radius, Math.max(...xs) + s.radius, Math.max(...ys) + s.radius]; }
  const P = s.profile.map((p) => planeTo3(s.plane, s.at, p[0], p[1]));
  if (s.op === 'extrude') {
    const d = s.plane === 'xy' ? [0, 0, s.depth] : s.plane === 'xz' ? [0, s.depth, 0] : [s.depth, 0, 0];
    const all = [...P, ...P.map((p) => [p[0] + d[0], p[1] + d[1], p[2] + d[2]])];
    return [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))];
  }
  const A = planeTo3(s.plane, s.at, s.axis[0], s.axis[1]), B = planeTo3(s.plane, s.at, s.axis[2], s.axis[3]);
  const L = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]) || 1, d = [(B[0] - A[0]) / L, (B[1] - A[1]) / L, (B[2] - A[2]) / L];
  let R = 0;
  for (const p of P) { const v = [p[0] - A[0], p[1] - A[1], p[2] - A[2]], k = v[0] * d[0] + v[1] * d[1] + v[2] * d[2]; R = Math.max(R, Math.hypot(v[0] - k * d[0], v[1] - k * d[1], v[2] - k * d[2])); }
  const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
  return [Math.min(A[0] - R, ...xs), Math.min(A[1] - R, ...ys), Math.max(A[0] + R, ...xs), Math.max(A[1] + R, ...ys)];
}
/** A profile point (u, v) on a plane at `at` → x, y, z. */
export function planeTo3(plane, at, u, v) {
  if (plane === 'xz') return [u, at, v];
  if (plane === 'yz') return [at, u, v];
  return [u, v, at];
}
export { dropIndex as forgetFamilyIndex };
