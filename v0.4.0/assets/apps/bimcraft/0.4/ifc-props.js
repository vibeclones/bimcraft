/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ifc-props.js — every element's properties in one index, and Color by property (0.4 B15). No DOM: bin/test-bimcraft.mjs
 * --color runs it in Node. Find (B14), model checks (B19) and quantity totals (B20) read the same index.
 *
 *   const ix = propertyIndex(WebIFC, api, mid, model[, { spaces: true }])   once per model; elements, or the spaces only
 *   ix.fields   [{ id, label ('' for a built-in), group ('' | set name), kind ('text' | 'number'), count }]   built-ins first
 *   ix.value(fieldId, expressID) → string | number | undefined      ix.keys = every element key with geometry
 *   const c = colorBy(ix, fieldId, { theme: 'light' | 'dark' })
 *     → { kind: 'category' | 'range', legend: [{ label, keys, color, count, other?, none? }], colorOf: Map(key → '#rrggbb') }
 *
 * Built-in fields: Class, Type (type object's name), Storey, Material, Name, Long name, Object type, Tag, Predefined type, GlobalId.
 * Property fields 'p:<set>.<name>' from IfcRelDefinesByProperties (property sets and quantity sets) and the type's own
 * sets; an instance value wins over its type's. Values: numbers stay numbers, booleans 'Yes' / 'No', the rest text.
 *
 * Colors (validated with the dataviz skill's validator, both themes; see docs/apps/bimcraft-04.md):
 *   up to 7 values → one categorical color each, in a FIXED order (most common value first); the rest fold into "Other"
 *   a number with more than 7 values → 6 equal ranges on a one-hue sequential ramp (light → dark; dark theme reversed)
 *   no value → a pale neutral, so the colored ones stand out
 */

export const CATEGORICAL = {
  light: ['#B3122E', '#1E48C8', '#8A6200', '#9A1F86', '#17703A', '#5B3CC4', '#A84A00'],
  dark: ['#EF5467', '#688CF0', '#B78B00', '#D65AC4', '#25AD5C', '#987DE5', '#D47713'],
};
export const SEQUENTIAL = {
  light: ['#83A9FB', '#658EEC', '#4873DD', '#2C57CE', '#143AB9', '#051B9E'],
  dark: ['#2C57CE', '#4873DD', '#658EEC', '#83A9FB', '#A3C3FF', '#C3DEFF'],
};
export const OTHER = { light: '#8A929C', dark: '#7D8792' };
export const NONE = { light: '#D5DAE0', dark: '#3A434E' };

/** Built-in fields, in this order; their labels come from the page's language file (color.field.<id>). */
const BUILTIN = ['cls', 'type', 'storey', 'material', 'name', 'longname', 'objtype', 'tag', 'predefined', 'guid'];

const isH = (v) => v && typeof v === 'object' && v.type === 5 && typeof v.value === 'number';
function plain(v) {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) { const a = v.map(plain).filter((x) => x !== undefined); return a.length ? a.join(', ') : undefined; }
  let x = typeof v === 'object' && 'value' in v ? v.value : v;
  if (x === null || x === undefined || x === '') return undefined;
  if (typeof x === 'number') return Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : undefined;
  if (x === true || x === '.T.' || x === 'T') return 'Yes';
  if (x === false || x === '.F.' || x === 'F') return 'No';
  return String(x);
}

export function propertyIndex(W, api, mid, model, { spaces = false } = {}) {
  const kb = model.keyBase || 0;
  // elements by default; { spaces: true } → the spaces only (rooms, not elements: the spaces schedule, 0.4 B10)
  const ids = [...model.classOf.keys()].filter((id) => (model.classOf.get(id) === 'IfcSpace') === spaces);
  const want = new Set(ids);
  const line = new Map();
  const get = (id) => { if (!line.has(id)) { let l = null; try { l = api.GetLine(mid, id, false); } catch (e) { l = null; } line.set(id, l); } return line.get(id); };
  const vals = new Map();   // field id → Map(expressID → value)
  const meta = new Map();   // field id → { label, group }
  const put = (fid, label, group, id, v) => {
    if (v === undefined) return;
    let m = vals.get(fid);
    if (!m) { m = new Map(); vals.set(fid, m); meta.set(fid, { label, group }); }
    if (!m.has(id)) m.set(id, v);   // the first value wins: instance sets are read before type sets
  };
  const list = (code) => { const v = api.GetLineIDsWithType(mid, code, true); const out = []; for (let i = 0; i < v.size(); i++) out.push(v.get(i)); return out; };
  const code = (n) => api.GetTypeCodeFromName(n);

  // built-ins
  const storeyName = new Map(model.storeys.map((s) => [s.id, s.name]));
  for (const id of ids) {
    const l = get(id);
    put('cls', '', '', id, model.classOf.get(id));
    put('storey', '', '', id, storeyName.get(model.storeyOf.get(id)));
    if (!l) continue;
    put('name', '', '', id, plain(l.Name));
    put('longname', '', '', id, plain(l.LongName));   // spaces, zones and storeys have one (B10's spaces schedule)
    put('objtype', '', '', id, plain(l.ObjectType));
    put('tag', '', '', id, plain(l.Tag));
    put('predefined', '', '', id, plain(l.PredefinedType));
    put('guid', '', '', id, plain(l.GlobalId));
  }
  // a set's single values and quantities
  const setRows = (psId) => {
    const ps = get(psId);
    if (!ps) return null;
    const name = plain(ps.Name) || 'Properties', rows = [];
    for (const h of ps.HasProperties || ps.Quantities || []) {
      const p = isH(h) ? get(h.value) : null;
      if (!p || !p.Name) continue;
      const v = p.NominalValue !== undefined ? plain(p.NominalValue)
        : plain(p.LengthValue ?? p.AreaValue ?? p.VolumeValue ?? p.CountValue ?? p.WeightValue ?? p.TimeValue ?? p.EnumerationValues ?? p.ListValues);
      rows.push([plain(p.Name), v]);
    }
    return { name, rows };
  };
  const setCache = new Map();
  const rowsOf = (psId) => { if (!setCache.has(psId)) setCache.set(psId, setRows(psId)); return setCache.get(psId); };
  const putSet = (id, set) => { if (set) for (const [n, v] of set.rows) put('p:' + set.name + '.' + n, n, set.name, id, v); };
  for (const rid of list(code('IFCRELDEFINESBYPROPERTIES'))) {
    const r = get(rid);
    const ps = r?.RelatingPropertyDefinition?.value;
    if (!ps) continue;
    for (const h of r.RelatedObjects || []) if (want.has(h.value)) putSet(h.value, rowsOf(ps));
  }
  // type name and type sets (after the instance sets, so an instance value wins)
  for (const rid of list(code('IFCRELDEFINESBYTYPE'))) {
    const r = get(rid);
    const ty = r?.RelatingType?.value ? get(r.RelatingType.value) : null;
    if (!ty) continue;
    const tsets = (ty.HasPropertySets || []).filter(isH).map((h) => rowsOf(h.value));
    for (const h of r.RelatedObjects || []) {
      if (!want.has(h.value)) continue;
      put('type', '', '', h.value, plain(ty.Name));
      for (const s of tsets) putSet(h.value, s);
    }
  }
  // materials: a material, a layer set (usage), a list, a constituent set — names joined
  const matName = (id, depth = 0) => {
    const m = get(id);
    if (!m || depth > 4) return undefined;
    const t = String(m.constructor?.name || '');
    if (t === 'IfcMaterial') return plain(m.Name);
    if (t === 'IfcMaterialLayerSetUsage') return m.ForLayerSet ? matName(m.ForLayerSet.value, depth + 1) : undefined;
    if (t === 'IfcMaterialProfileSetUsage') return m.ForProfileSet ? matName(m.ForProfileSet.value, depth + 1) : undefined;
    const parts = (m.MaterialLayers || m.Materials || m.MaterialConstituents || m.MaterialProfiles || []).filter(isH)
      .map((h) => { const x = get(h.value); return x && x.Material ? matName(x.Material.value, depth + 1) : matName(h.value, depth + 1); }).filter(Boolean);
    return parts.length ? [...new Set(parts)].join(', ') : plain(m.LayerSetName ?? m.Name);
  };
  for (const rid of list(code('IFCRELASSOCIATESMATERIAL'))) {
    const r = get(rid);
    if (!r?.RelatingMaterial) continue;
    const n = matName(r.RelatingMaterial.value);
    for (const h of r.RelatedObjects || []) if (want.has(h.value)) put('material', '', '', h.value, n);
  }

  const fields = [];
  for (const id of BUILTIN) if (vals.has(id)) fields.push({ id, label: '', group: '', kind: kindOf(vals.get(id)), count: vals.get(id).size });
  const rest = [...vals.keys()].filter((k) => k.startsWith('p:')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const id of rest) fields.push({ id, label: meta.get(id).label, group: meta.get(id).group, kind: kindOf(vals.get(id)), count: vals.get(id).size });
  return {
    fields, keyBase: kb, ids,
    keys: ids.map((id) => kb + id),
    value: (fid, id) => vals.get(fid)?.get(id),
    values: (fid) => vals.get(fid) || new Map(),
  };
}
function kindOf(m) { for (const v of m.values()) if (typeof v !== 'number') return 'text'; return 'number'; }

/** Colors and legend for one field (see the header). */
export function colorBy(ix, fid, { theme = 'light' } = {}) {
  const vals = ix.values(fid);
  const cat = CATEGORICAL[theme] || CATEGORICAL.light, seq = SEQUENTIAL[theme] || SEQUENTIAL.light;
  const groups = new Map();
  for (const [id, v] of vals) { const k = typeof v === 'number' ? v : String(v); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(ix.keyBase + id); }
  const none = ix.ids.filter((id) => !vals.has(id)).map((id) => ix.keyBase + id);
  const numeric = vals.size > 0 && [...groups.keys()].every((k) => typeof k === 'number');
  const legend = [];
  let kind = 'category';
  if (numeric && groups.size > cat.length) {
    kind = 'range';
    const nums = [...groups.keys()];
    const lo = Math.min(...nums), hi = Math.max(...nums), n = seq.length, step = (hi - lo) / n || 1;
    const bins = seq.map((color, i) => ({ label: fmtRange(lo + i * step, i === n - 1 ? hi : lo + (i + 1) * step), keys: [], color, lo: lo + i * step, hi: i === n - 1 ? hi : lo + (i + 1) * step }));
    for (const [v, keys] of groups) bins[Math.min(n - 1, Math.floor((v - lo) / step))].keys.push(...keys);
    for (const b of bins) legend.push({ ...b, count: b.keys.length });
  } else {
    // most common first (ties: by value), so the order is stable for the same model and field
    const sorted = [...groups].sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }));
    sorted.slice(0, cat.length).forEach(([v, keys], i) => legend.push({ label: String(v), keys, color: cat[i], count: keys.length }));
    const more = sorted.slice(cat.length);
    if (more.length) { const keys = more.flatMap(([, k]) => k); legend.push({ label: '', other: more.length, keys, color: OTHER[theme] || OTHER.light, count: keys.length }); }
  }
  if (none.length) legend.push({ label: '', none: true, keys: none, color: NONE[theme] || NONE.light, count: none.length });
  const colorOf = new Map();
  for (const l of legend) for (const k of l.keys) colorOf.set(k, l.color);
  return { kind, legend, colorOf };
}
const fmtN = (v) => { const a = Math.abs(v); return a >= 1000 ? v.toFixed(0) : a >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(3).replace(/\.?0+$/, ''); };
function fmtRange(a, b) { return fmtN(a) + ' – ' + fmtN(b); }
