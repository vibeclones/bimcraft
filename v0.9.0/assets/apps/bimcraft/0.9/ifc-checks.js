/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ifc-checks.js — model checks (0.4 B19). No DOM: bin/test-bimcraft.mjs --checks runs it on the fixture with problems in it.
 *
 *   runChecks(ix, model, { required: [{ cls: '' | 'IfcWall', field }], tolerance }) → [{ id, count, groups: [{ label, keys }] }]
 *     'required'   elements of a class (or any) without a value for a field (ix fields: built-ins or 'p:<set>.<name>')
 *     'guid'       GlobalIds used by more than one element (each group = one GlobalId)
 *     'storey'     elements with a shape that are in no storey (contained nowhere, or only in the site or building)
 *     'stacked'    the same class and type, the same number of triangles and the same bounds within `tolerance`
 *                  (metres, default 0.001): a copy on top of another (each group = one place)
 *   ix = ifc-props.js propertyIndex; model = IfcModel.load() result (storeyOf, batches).
 */
export const CHECKS = ['required', 'guid', 'storey', 'stacked'];

export function runChecks(ix, model, { required = [{ cls: '', field: 'name' }], tolerance = 0.001 } = {}) {
  const kb = ix.keyBase;
  const out = [];
  // required properties
  const req = [];
  for (const r of required) {
    if (!r || !r.field) continue;
    const vals = ix.values(r.field);
    const miss = ix.ids.filter((id) => (!r.cls || ix.value('cls', id) === r.cls) && (vals.get(id) === undefined || vals.get(id) === ''));
    if (miss.length) req.push({ label: (r.cls || '*') + ' · ' + r.field, rule: r, keys: miss.map((id) => kb + id) });   // i18n-ignore: the page labels groups itself
  }
  out.push({ id: 'required', count: req.reduce((a, g) => a + g.keys.length, 0), groups: req });
  // duplicate GlobalIds
  const byGuid = new Map();
  for (const [id, g] of ix.values('guid')) { if (!byGuid.has(g)) byGuid.set(g, []); byGuid.get(g).push(kb + id); }
  const dup = [...byGuid].filter(([, ks]) => ks.length > 1).map(([g, ks]) => ({ label: g, keys: ks }));
  out.push({ id: 'guid', count: dup.reduce((a, g) => a + g.keys.length, 0), groups: dup });
  // no storey
  const loose = ix.ids.filter((id) => !model.storeyOf.has(id)).map((id) => kb + id);
  out.push({ id: 'storey', count: loose.length, groups: loose.length ? [{ label: '', keys: loose }] : [] });
  // stacked duplicates: class + type + triangle count + bounds rounded to the tolerance
  // one pass over the batches: each element's triangle count and bounds
  const tris = new Map(), box = new Map();
  for (const b of model.batches) {
    const E = b.elems, P = b.positions;
    for (let r = 0; r < E.ids.length; r++) {
      const k = E.ids[r];
      tris.set(k, (tris.get(k) || 0) + E.tn[r]);
      let bb = box.get(k);
      if (!bb) box.set(k, (bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]));
      for (let v = E.v0[r] * 3, end = (E.v0[r] + E.vn[r]) * 3; v < end; v += 3) for (let c = 0; c < 3; c++) { const x = P[v + c]; if (x < bb[c]) bb[c] = x; if (x > bb[c + 3]) bb[c + 3] = x; }
    }
  }
  const q = (v) => Math.round(v / tolerance);
  const groups = new Map();
  for (const id of ix.ids) {
    const key = kb + id, bb = box.get(key);
    if (!bb) continue;
    const sig = [ix.value('cls', id), ix.value('type', id) ?? '', tris.get(key) || 0, ...bb.map(q)].join('|');
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(key);
  }
  const stacked = [...groups.values()].filter((ks) => ks.length > 1).map((ks) => ({ label: '', keys: ks }));
  out.push({ id: 'stacked', count: stacked.reduce((a, g) => a + g.keys.length, 0), groups: stacked });
  return out;
}

/** Required-property rules from storage (untrusted). */
export function cleanRules(raw) {
  let arr = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch (e) { return null; } }
  if (!Array.isArray(arr)) return null;
  return arr.slice(0, 50).filter((r) => r && typeof r.field === 'string' && r.field && r.field.length <= 300 && (r.cls === undefined || typeof r.cls === 'string'))
    .map((r) => ({ cls: String(r.cls || '').slice(0, 80), field: r.field }));
}
