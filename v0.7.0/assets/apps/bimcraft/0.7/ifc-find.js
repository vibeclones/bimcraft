/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ifc-find.js — Find by class, name or any property, and named search sets (0.4 B14). No DOM: bin/test-bimcraft.mjs
 * --find runs it in Node on the property index (ifc-props.js propertyIndex).
 *
 *   find(ix, { rules: [{ field, op, value }], mode: 'all' | 'any' })  → [keys]
 *   OPS                       the operators, in menu order: is, isnot, contains, notcontains, starts, gt, lt, gte, lte, has, hasnot
 *   cleanSets(raw)            search sets read back from storage (untrusted): → [{ name, mode, rules }] that are valid
 *   SETS_KEY                  localStorage "bimcraft.searchsets"
 *
 * Text compares ignore case and surrounding spaces; numbers compare as numbers when both sides are numbers (a value
 * typed "2.5" against 2.5), else as text. A rule on a field the index does not have matches nothing (except hasnot).
 */

export const OPS = ['is', 'isnot', 'contains', 'notcontains', 'starts', 'gt', 'lt', 'gte', 'lte', 'has', 'hasnot'];
export const SETS_KEY = 'bimcraft.searchsets';
const NEEDS_VALUE = new Set(['is', 'isnot', 'contains', 'notcontains', 'starts', 'gt', 'lt', 'gte', 'lte']);
const MAX = { sets: 200, rules: 20, name: 80, field: 300, value: 300 };

const norm = (v) => String(v ?? '').trim().toLowerCase();
const asNum = (v) => { if (typeof v === 'number') return v; const s = String(v ?? '').trim().replace(',', '.'); return s !== '' && Number.isFinite(Number(s)) ? Number(s) : null; };

function test(v, op, want) {
  if (op === 'has') return v !== undefined && v !== '';
  if (op === 'hasnot') return v === undefined || v === '';
  if (v === undefined) return op === 'isnot' || op === 'notcontains';
  const a = asNum(v), b = asNum(want);
  switch (op) {
    case 'is': return a !== null && b !== null ? a === b : norm(v) === norm(want);
    case 'isnot': return a !== null && b !== null ? a !== b : norm(v) !== norm(want);
    case 'contains': return norm(v).includes(norm(want));
    case 'notcontains': return !norm(v).includes(norm(want));
    case 'starts': return norm(v).startsWith(norm(want));
    case 'gt': return a !== null && b !== null && a > b;
    case 'lt': return a !== null && b !== null && a < b;
    case 'gte': return a !== null && b !== null && a >= b;
    case 'lte': return a !== null && b !== null && a <= b;
    default: return false;
  }
}

/** Keys of the elements the rules match ('all' = every rule, 'any' = at least one). No rules: nothing. */
export function find(ix, { rules = [], mode = 'all' } = {}) {
  const rs = rules.filter((r) => r && r.field && OPS.includes(r.op) && (!NEEDS_VALUE.has(r.op) || String(r.value ?? '').trim() !== ''));
  if (!rs.length) return [];
  const vals = rs.map((r) => ix.values(r.field));
  const out = [];
  for (const id of ix.ids) {
    const hit = rs.map((r, i) => test(vals[i].get(id), r.op, r.value));
    if (mode === 'any' ? hit.some(Boolean) : hit.every(Boolean)) out.push(ix.keyBase + id);
  }
  return out;
}

/** Saved search sets from storage: only well-formed ones, cut to size. */
export function cleanSets(raw) {
  let arr = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch (e) { return []; } }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr.slice(0, MAX.sets)) {
    if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !s.name.trim() || !Array.isArray(s.rules)) continue;
    const rules = s.rules.slice(0, MAX.rules).filter((r) => r && typeof r.field === 'string' && r.field.length <= MAX.field && OPS.includes(r.op)
      && (r.value === undefined || r.value === null || typeof r.value === 'string' || typeof r.value === 'number'))
      .map((r) => ({ field: r.field, op: r.op, value: r.value === undefined || r.value === null ? '' : String(r.value).slice(0, MAX.value) }));
    if (!rules.length) continue;
    out.push({ name: s.name.trim().slice(0, MAX.name), mode: s.mode === 'any' ? 'any' : 'all', rules });
  }
  return out;
}

/** Distinct values of a field (for the value box's suggestions), most common first. */
export function suggestions(ix, field, limit = 200) {
  const counts = new Map();
  for (const v of ix.values(field).values()) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true })).slice(0, limit).map(([v]) => String(v));
}
