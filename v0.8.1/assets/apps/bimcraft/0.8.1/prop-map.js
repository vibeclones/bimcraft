// SPDX-License-Identifier: Apache-2.0
// Property groups and property mapping (0.6 DF.12, session `bim-interop`). DOM-free.
//
// groupProps(manifest, p)   an element's properties (IfcModel.properties shape) in the groups a project bundle defines
//                           (manifest.properties: groups + definitions with their IFC pset/name) → [{group, rows}], then
//                           what no definition names under `other`.

const bare = (setName) => String(setName || '').replace(/ \(type\)$/, '');
const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * → { groups: [{ id, name, rows: [{ name, value, set, prop }] }], other: [{ set, rows }] }.
 * A definition matches a property by its `ifc` {pset, name} (exact, case-insensitive), else by its own name in any set.
 * Groups keep the manifest's order; empty groups are left out. The instance value wins over the type's.
 */
export function groupProps(manifest, p) {
  const defs = manifest?.properties?.definitions || [];
  const groups = manifest?.properties?.groups || [];
  const byIfc = new Map(), byName = new Map();
  for (const d of defs) {
    if (d.ifc?.pset && d.ifc?.name) byIfc.set(norm(d.ifc.pset) + '|' + norm(d.ifc.name), d);
    if (!byName.has(norm(d.name))) byName.set(norm(d.name), d);
  }
  const hits = new Map();   // definition id → row
  const used = new Set();   // "set|prop" taken by a definition
  const sets = [...(p?.sets || [])].sort((a, b) => (a.fromType ? 1 : 0) - (b.fromType ? 1 : 0));   // instance sets first
  for (const pass of ['ifc', 'name']) {
    for (const s of sets) {
      const set = bare(s.name);
      for (const r of s.rows) {
        const k = set + '|' + r.name;
        if (used.has(k)) continue;
        const d = pass === 'ifc' ? byIfc.get(norm(set) + '|' + norm(r.name)) : byName.get(norm(r.name));
        if (!d || hits.has(d.id)) continue;
        hits.set(d.id, { name: d.name, value: r.value, set, prop: r.name, unit: d.unit });
        used.add(k);
      }
    }
  }
  const out = [];
  const known = new Set(groups.map((g) => g.id));
  for (const g of [...groups, { id: null, name: null }]) {
    const rows = defs.filter((d) => (g.id === null ? !known.has(d.group) : d.group === g.id) && hits.has(d.id)).map((d) => hits.get(d.id));
    if (rows.length) out.push({ id: g.id, name: g.name, rows });
  }
  const other = [];
  for (const s of p?.sets || []) {
    const set = bare(s.name);
    const rows = s.rows.filter((r) => !used.has(set + '|' + r.name));
    if (rows.length) other.push({ set: s.name, rows });
  }
  return { groups: out, other };
}

// ---- (c) a property mapping between two BIM programs, through IFC (0.6 DF.12 (c)) ----
//
// One table, read from what the model carries (its property sets, through ifc-props.js propertyIndex) and, when a project
// bundle is open, the Archicad property definitions that name an IFC pset/property:
//   { format: 'cadcraft-property-map', version: 1, rows: [{ pset, name, type, classes [IfcWall…], standard (Pset_/Qto_ of
//     buildingSMART), revit { param, guid, datatype, group }, archicad { group, name } }] }
// Writers for each program's own file: a Revit shared parameter file, a Revit IFC-export user-defined property set file,
// and a CSV for Archicad's IFC translator (Archicad's mapping file format is not published: it is set up by hand from it).
// No program is run here; which settings bring the values through is the run sheet's (docs/spikes/two-bim-programs-run-sheet.md).

export const MAP_FORMAT = 'cadcraft-property-map';
const TYPES = ['text', 'integer', 'number', 'boolean', 'length', 'area', 'volume', 'angle'];
const REVIT_DATATYPE = { text: 'TEXT', integer: 'INTEGER', number: 'NUMBER', boolean: 'YESNO', length: 'LENGTH', area: 'AREA', volume: 'VOLUME', angle: 'ANGLE' };   // i18n-ignore: file format words
const REVIT_IFC_TYPE = { text: 'Text', integer: 'Integer', number: 'Real', boolean: 'Boolean', length: 'Length', area: 'Area', volume: 'Volume', angle: 'PlaneAngle' };   // i18n-ignore: file format words
const BUNDLE_TYPE = { string: 'text', enum: 'text', list: 'text', integer: 'integer', number: 'number', boolean: 'boolean', length: 'length', area: 'area', volume: 'volume', angle: 'angle' };
const isStandard = (pset) => /^(Pset|Qto)_/.test(pset);
const BOOL = /^(yes|no|true|false|\.t\.|\.f\.|ja|nein|sí|si)$/i;

function guessType(values) {
  let n = 0, ints = 0, bools = 0, all = 0;
  for (const v of values) {
    if (v === undefined || v === null || v === '') continue;
    all++;
    if (typeof v === 'boolean' || BOOL.test(String(v))) bools++;
    else if (typeof v === 'number' || (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(String(v)))) { n++; if (Number.isInteger(Number(v))) ints++; }
  }
  if (!all) return 'text';
  if (bools === all) return 'boolean';
  if (n === all) return ints === all ? 'integer' : 'number';
  return 'text';
}

/**
 * The mapping table. ix = ifc-props.js propertyIndex of the model; manifest = a bundle's (optional).
 * Quantity sets (Qto_…) are left out: both programs compute them. → { format, version, rows }
 */
export function buildMap(ix, manifest = null) {
  const defs = manifest?.properties?.definitions || [];
  const groups = new Map((manifest?.properties?.groups || []).map((g) => [g.id, g.name]));
  const byIfc = new Map(defs.filter((d) => d.ifc?.pset && d.ifc?.name).map((d) => [norm(d.ifc.pset) + '|' + norm(d.ifc.name), d]));
  const rows = [];
  for (const f of ix.fields) {
    if (!f.id.startsWith('p:') || !f.group || /^Qto_/.test(f.group)) continue;
    const vals = ix.values(f.id);
    const classes = new Set();
    for (const id of vals.keys()) { const c = ix.value('cls', id); if (c) classes.add(c); }
    const d = byIfc.get(norm(f.group) + '|' + norm(f.label));
    const type = d && BUNDLE_TYPE[d.type] ? BUNDLE_TYPE[d.type] : guessType(vals.values());
    rows.push({ pset: f.group, name: f.label, type, classes: [...classes].sort(), standard: isStandard(f.group),
      revit: { param: f.label, guid: null, datatype: REVIT_DATATYPE[type], group: f.group },
      archicad: d ? { group: groups.get(d.group) || f.group, name: d.name } : { group: f.group, name: f.label } });
  }
  // Archicad definitions with an IFC name that this model does not carry yet: kept, so both programs get them
  for (const d of byIfc.values()) {
    if (rows.some((r) => norm(r.pset) === norm(d.ifc.pset) && norm(r.name) === norm(d.ifc.name))) continue;
    const type = BUNDLE_TYPE[d.type] || 'text';
    rows.push({ pset: d.ifc.pset, name: d.ifc.name, type, classes: [], standard: isStandard(d.ifc.pset), fromBundle: true,
      revit: { param: d.ifc.name, guid: null, datatype: REVIT_DATATYPE[type], group: d.ifc.pset },
      archicad: { group: groups.get(d.group) || d.ifc.pset, name: d.name } });
  }
  rows.sort((a, b) => a.pset.localeCompare(b.pset) || a.name.localeCompare(b.name));
  return { format: MAP_FORMAT, version: 1, rows };
}

/** Stable shared-parameter GUIDs: a UUID v5 of "<pset>.<name>" in CadCraft's namespace (async: SubtleCrypto). */
const NS = 'c4dc7a2f-5e1b-4d6e-9a43-0b6f1c2d8e91';
export async function paramGuid(pset, name) {
  const ns = NS.replace(/-/g, '').match(/../g).map((h) => parseInt(h, 16));
  const data = new Uint8Array([...ns, ...new TextEncoder().encode(pset + '.' + name)]);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-1', data)).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
export async function withGuids(map) {
  for (const r of map.rows) r.revit.guid ||= await paramGuid(r.pset, r.name);
  return map;
}

const tsv = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();

/**
 * A Revit shared parameter file (tab-separated text: *META, *GROUP, *PARAM). One group per property set; standard
 * buildingSMART sets are left out unless `standard` (Revit's IFC export writes those from its own parameters).
 */
export async function revitSharedParams(map, { standard = false } = {}) {
  await withGuids(map);
  const rows = map.rows.filter((r) => standard || !r.standard);
  const groups = [...new Set(rows.map((r) => r.revit.group))];
  const gid = new Map(groups.map((g, i) => [g, i + 1]));
  const out = ['# This is a Revit shared parameter file.', '# Do not edit manually.', '*META\tVERSION\tMINVERSION', 'META\t2\t1', '*GROUP\tID\tNAME'];   // i18n-ignore: file format
  for (const g of groups) out.push(`GROUP\t${gid.get(g)}\t${tsv(g)}`);
  out.push('*PARAM\tGUID\tNAME\tDATATYPE\tDATACATEGORY\tGROUP\tVISIBLE\tDESCRIPTION\tUSERMODIFIABLE\tHIDEINDIALOG');   // i18n-ignore: file format
  for (const r of rows) out.push(['PARAM', r.revit.guid, tsv(r.revit.param), r.revit.datatype, '', gid.get(r.revit.group), 1, tsv(`IFC ${r.pset}.${r.name}`), 1, 0].join('\t'));   // i18n-ignore: file format
  return out.join('\r\n') + '\r\n';
}

/** Read a Revit shared parameter file back → { groups Map(id → name), params [{ guid, name, datatype, group }] }. */
export function readRevitSharedParams(text) {
  const groups = new Map(), params = [];
  let cols = null;
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const c = line.split('\t');
    if (c[0] === '*PARAM') { cols = c.slice(1); continue; }
    if (c[0] === 'GROUP') groups.set(Number(c[1]), c[2] || '');
    if (c[0] === 'PARAM' && cols) { const o = Object.fromEntries(cols.map((k, i) => [k, c[i + 1] ?? ''])); params.push({ guid: o.GUID, name: o.NAME, datatype: o.DATATYPE, group: groups.get(Number(o.GROUP)) ?? null }); }
  }
  return { groups, params };
}

/**
 * Revit's IFC export: a user-defined property set file (PropertySet: <name> I|T <classes>, then one tab-indented line per
 * property: <IFC name> <type> [<Revit parameter, when it differs>]). Classes default to IfcBuildingElementProxy when the
 * model carries none for a set.
 */
export function revitIfcPsets(map, { standard = true } = {}) {
  const out = ['#', '# User Defined PropertySet Definition File', '# Written by CadCraft BimCraft from a property mapping (cadcraft-property-map 1).', '#',   // i18n-ignore: file format
    '# Format:', '#\tPropertySet:\t<Pset Name>\tI[nstance]/T[ype]\t<element list separated by \',\'>', '#\t<Property Name>\t<Data type>\t<[opt] Revit parameter name, if different from IFC>', '#'];   // i18n-ignore: file format
  const sets = new Map();
  for (const r of map.rows) { if (!standard && r.standard) continue; if (!sets.has(r.pset)) sets.set(r.pset, []); sets.get(r.pset).push(r); }
  for (const [pset, rows] of sets) {
    const classes = [...new Set(rows.flatMap((r) => r.classes))];
    out.push(`PropertySet:\t${tsv(pset)}\tI\t${(classes.length ? classes : ['IfcBuildingElementProxy']).join(',')}`);   // i18n-ignore: file format
    for (const r of rows) out.push(`\t${tsv(r.name)}\t${REVIT_IFC_TYPE[r.type] || 'Text'}${r.revit.param !== r.name ? '\t' + tsv(r.revit.param) : ''}`);
  }
  return out.join('\r\n') + '\r\n';
}

/** Read that file back → [{ pset, kind I|T, classes, props [{ name, type, param }] }]. */
export function readRevitIfcPsets(text) {
  const sets = [];
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (line.startsWith('PropertySet:')) { const c = line.split('\t').map((s) => s.trim()); sets.push({ pset: c[1], kind: c[2], classes: (c[3] || '').split(',').filter(Boolean), props: [] }); continue; }
    if (/^\s/.test(line) && sets.length) { const c = line.trim().split('\t'); sets[sets.length - 1].props.push({ name: c[0], type: c[1] || 'Text', param: c[2] || c[0] }); }
  }
  return sets;
}

/** A CSV for setting up Archicad's IFC translator and property manager by hand (BOM, CRLF; formula-looking cells quoted). */
export function archicadMapCsv(map, header) {
  const q = (s) => { s = String(s ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\r\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [header.map(q).join(',')];
  for (const r of map.rows) lines.push([r.pset, r.name, r.type, r.archicad.group, r.archicad.name, r.revit.param, r.revit.guid || '', r.classes.join(' '), r.standard ? 'yes' : 'no'].map(q).join(','));   // i18n-ignore: CSV cells
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Our own mapping file, checked like any untrusted input on the way in. → { ok, map } | { ok: false, error } */
export function readMap(json) {
  let m = json;
  if (typeof json === 'string') { try { m = JSON.parse(json); } catch (e) { return { ok: false, error: 'json' }; } }
  if (!m || m.format !== MAP_FORMAT) return { ok: false, error: 'format' };
  if (m.version !== 1) return { ok: false, error: 'version' };
  if (!Array.isArray(m.rows) || m.rows.length > 20000) return { ok: false, error: 'rows' };
  const s = (v, n = 255) => (typeof v === 'string' ? v.slice(0, n) : '');
  const rows = m.rows.filter((r) => r && typeof r === 'object' && s(r.pset) && s(r.name)).map((r) => ({
    pset: s(r.pset), name: s(r.name), type: TYPES.includes(r.type) ? r.type : 'text',
    classes: Array.isArray(r.classes) ? r.classes.filter((c) => typeof c === 'string' && /^Ifc[A-Za-z]+$/.test(c)).slice(0, 200) : [],
    standard: isStandard(s(r.pset)),
    revit: { param: s(r.revit?.param) || s(r.name), guid: /^[0-9a-f-]{36}$/i.test(r.revit?.guid || '') ? r.revit.guid.toLowerCase() : null, datatype: REVIT_DATATYPE[TYPES.includes(r.type) ? r.type : 'text'], group: s(r.revit?.group) || s(r.pset) },
    archicad: { group: s(r.archicad?.group) || s(r.pset), name: s(r.archicad?.name) || s(r.name) },
  }));
  return { ok: true, map: { format: MAP_FORMAT, version: 1, rows } };
}
