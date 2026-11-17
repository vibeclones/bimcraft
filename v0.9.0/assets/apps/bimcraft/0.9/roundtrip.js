// SPDX-License-Identifier: Apache-2.0
// What survived a trip through other programs (0.6 DF.12 (c), session `bim-interop`). DOM-free.
//
// A model leaves (say, an IFC exported from one BIM program), goes through BimCraft and another program, and comes back as
// another IFC. Elements are matched by GlobalId; for every matched element the report counts what was kept, changed or
// lost: its IFC class, every property (each "<set>.<property>" of ifc-props.js propertyIndex, built-ins too) and its
// classification references. Nothing is judged right or wrong: a changed value is listed with both values.
//
//   classificationIndex(api, mid)        → Map(expressID → [{ system, code, name }]) from IfcRelAssociatesClassification
//   roundTrip(A, B)                      A = the model that left, B = the one that came back; each { ix, cls (classificationIndex) }
//     → { elements { before, after, kept, lost, added, dupes, classChanged }, props [{ field, label, group, before, kept, changed, lost, added }],
//         classifications { before, kept, changed, lost, added }, lost [guid], added [guid], changes [{ guid, field, before, after }] (≤ 5000) }
//   roundTripCsv(r, header)              the per-property table as CSV (BOM, CRLF, formula cells quoted)
//   keptShare(stats)                     percent of what was there before that came back unchanged

const ref = (x) => (x && typeof x === 'object' ? x.value : x);
const plain = (v) => { const x = typeof v === 'object' && v ? v.value : v; return x === undefined || x === null ? '' : String(x); };
const ids = (api, mid, name) => { const v = api.GetLineIDsWithType(mid, api.GetTypeCodeFromName(name), true); const out = []; for (let i = 0; i < v.size(); i++) out.push(v.get(i)); return out; };
const MAX_CHANGES = 5000;

export function classificationIndex(api, mid) {
  const out = new Map();
  const get = (id) => { try { return api.GetLine(mid, id, false); } catch (e) { return null; } };
  const sysName = (src, depth = 0) => {
    const l = src && get(ref(src));
    if (!l || depth > 8) return '';
    if (l.ReferencedSource) return sysName(l.ReferencedSource, depth + 1) || plain(l.Name);   // a reference inside a reference
    return plain(l.Name) || plain(l.Source);
  };
  for (const rid of ids(api, mid, 'IFCRELASSOCIATESCLASSIFICATION')) {
    const r = get(rid);
    const c = r && get(ref(r.RelatingClassification));
    if (!c) continue;
    const entry = { system: c.ReferencedSource ? sysName(c.ReferencedSource) : plain(c.Name), code: plain(c.Identification ?? c.ItemReference), name: c.ReferencedSource ? plain(c.Name) : '' };
    for (const o of r.RelatedObjects || []) { const id = ref(o); if (!out.has(id)) out.set(id, []); out.get(id).push(entry); }
  }
  return out;
}

const byGuid = (ix) => {
  const m = new Map(), dup = new Set();
  for (const [id, g] of ix.values('guid')) { if (!g) continue; if (m.has(g)) dup.add(g); else m.set(g, id); }
  for (const g of dup) m.delete(g);
  return { m, dup };
};
const same = (a, b) => {
  if (a === b) return true;
  const x = Number(a), y = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(x) && Number.isFinite(y)) return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  return String(a).trim() === String(b).trim();
};
const clsKey = (c) => (c.system + '|' + c.code).toLowerCase();

export function roundTrip(A, B) {
  const a = byGuid(A.ix), b = byGuid(B.ix);
  const kept = [], lost = [], added = [];
  for (const [g, ia] of a.m) { const ib = b.m.get(g); if (ib === undefined) lost.push(g); else kept.push([g, ia, ib]); }
  for (const g of b.m.keys()) if (!a.m.has(g)) added.push(g);
  let classChanged = 0;
  const changes = [];
  const fields = new Map();   // field id → stats
  const meta = new Map([...A.ix.fields, ...B.ix.fields].map((f) => [f.id, f]));
  const stat = (fid) => { let s = fields.get(fid); if (!s) fields.set(fid, (s = { field: fid, label: meta.get(fid)?.label || fid, group: meta.get(fid)?.group || '', before: 0, kept: 0, changed: 0, lost: 0, added: 0 })); return s; };
  const fieldIds = [...new Set([...A.ix.fields, ...B.ix.fields].map((f) => f.id))].filter((f) => f !== 'guid');
  for (const [g, ia, ib] of kept) {
    if (!same(A.ix.value('cls', ia) ?? '', B.ix.value('cls', ib) ?? '')) classChanged++;
    for (const fid of fieldIds) {
      const va = A.ix.value(fid, ia), vb = B.ix.value(fid, ib);
      const ha = va !== undefined && va !== '', hb = vb !== undefined && vb !== '';
      if (!ha && !hb) continue;
      const s = stat(fid);
      if (ha) s.before++;
      if (ha && hb) { if (same(va, vb)) s.kept++; else { s.changed++; if (changes.length < MAX_CHANGES) changes.push({ guid: g, field: fid, before: va, after: vb }); } }
      else if (ha) { s.lost++; if (changes.length < MAX_CHANGES) changes.push({ guid: g, field: fid, before: va, after: null }); }
      else s.added++;
    }
  }
  const cl = { before: 0, kept: 0, changed: 0, lost: 0, added: 0 };
  for (const [, ia, ib] of kept) {
    const ca = A.cls?.get(ia) || [], cb = B.cls?.get(ib) || [];
    const kb = new Set(cb.map(clsKey)), ka = new Set(ca.map(clsKey)), sysB = new Set(cb.map((c) => c.system.toLowerCase()));
    for (const c of ca) {
      cl.before++;
      if (kb.has(clsKey(c))) cl.kept++;
      else if (sysB.has(c.system.toLowerCase())) cl.changed++;
      else cl.lost++;
    }
    for (const c of cb) if (!ka.has(clsKey(c)) && !ca.some((x) => x.system.toLowerCase() === c.system.toLowerCase())) cl.added++;
  }
  const props = [...fields.values()].sort((x, y) => (x.group || '~').localeCompare(y.group || '~') || x.label.localeCompare(y.label));
  return {
    elements: { before: a.m.size, after: b.m.size, kept: kept.length, lost: lost.length, added: added.length, dupes: a.dup.size + b.dup.size, classChanged },
    props, classifications: cl, lost, added, changes,
  };
}

export function roundTripCsv(r, header) {
  const q = (s) => { s = String(s ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\r\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [header.map(q).join(',')];
  for (const p of r.props) lines.push([p.group, p.label || p.field, p.before, p.kept, p.changed, p.lost, p.added].map(q).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Percent of what was there before that came back unchanged (null when there was nothing). */
export const keptShare = (s) => (s.before ? Math.round((1000 * s.kept) / s.before) / 10 : null);
