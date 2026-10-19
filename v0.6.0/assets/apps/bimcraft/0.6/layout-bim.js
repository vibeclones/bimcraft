/* SPDX-License-Identifier: Apache-2.0 */
/**
 * layout-bim.js — field points from an IFC model (0.6 LC.22, session lc-structure): the places a crew sets out from the
 * model, numbered and written for a total station (layout/layout-points.js, the file CivilCraft and CadCraft's
 * EXPORTPOINTS use), and as-built points read back and compared. No DOM: bin/test-layout.mjs runs it in Node.
 *
 *   KINDS = ['column', 'wall', 'anchor', 'sleeve', 'element']
 *   fieldPoints(W, api, mid, { kinds, selection, words }) → { points: [{ kind, id, gid, name, x, y, z (file mm, Z up), d }], counts }
 *     column  — the foot of each column's centre line (IfcColumn …; the centroid of its extruded section, analysis-bim.js)
 *     wall    — both ends of each wall's axis (its Axis representation, a two-point polyline or the first and last point
 *               of a longer one), at the wall's base
 *     anchor  — each anchor bolt (IfcMechanicalFastener / IfcFastener of type ANCHORBOLT, or named anchor): its placement
 *     sleeve  — each element whose name, type or description says sleeve: its placement
 *     element — each element of `selection` (express ids): its placement
 *     `words` = { column, wall, anchor, sleeve, element } → the description is "<word> <name>" (the app's own language)
 *   inUnits(points, { coords: 'model' | 'survey', georef, unitMm, unit: 'm' | 'mm' | 'ft' }) → the points in the file's
 *     units: model = file coordinates; survey = the map grid (IfcMapConversion) in metres, then the unit asked
 *   UNIT_MM = { m: 1000, mm: 1, ft: 304.8 }
 * Points come in a stable field order (kind, then rows of Y, then X: layout-points.js planOrder), so numbering the same
 * model again gives the same numbers.
 */
import { readFrameElements } from './analysis-bim.js';
import { ids, val, lengthUnitMm } from './ifc-util.js';
import { fileToMap } from './ifc-geo.js';
import { planOrder } from './layout/layout-points.js';

export const KINDS = ['column', 'wall', 'anchor', 'sleeve', 'element'];
export const UNIT_MM = Object.freeze({ m: 1000, mm: 1, ft: 304.8 });
const txt = (s, max = 60) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

export function fieldPoints(W, api, mid, { kinds = new Set(KINDS), selection = [], words = {} } = {}) {
  const unitMm = lengthUnitMm(api, mid);
  const line = (id) => api.GetLine(mid, id, false);
  const M = (pl) => { try { return api.GetWorldTransformMatrix(mid, pl); } catch { return null; } };
  const at = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]].map((v) => v * unitMm);
  const nameOf = (l) => txt(val(l?.Name) || val(l?.Tag) || '');
  const gidOf = (l, id) => String(val(l?.GlobalId) || '#' + id);
  const desc = (kind, nm) => [words[kind] || kind, nm].filter(Boolean).join(' ');
  const points = [];
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const push = (kind, id, l, p) => { if (!p || !p.every(Number.isFinite)) return; const nm = nameOf(l); points.push({ kind, id, gid: gidOf(l, id), name: nm, x: p[0], y: p[1], z: p[2], d: desc(kind, nm) }); counts[kind]++; };
  const origin = (id) => { const l = line(id); const m = l?.ObjectPlacement ? M(l.ObjectPlacement.value) : null; return m ? at(m, [0, 0, 0]) : null; };

  if (kinds.has('column')) {
    for (const e of readFrameElements(W, api, mid).elements) {
      if (e.type !== 'column') continue;
      push('column', e.id, line(e.id), e.a[2] <= e.b[2] ? e.a : e.b);
    }
  }
  if (kinds.has('wall')) {
    for (const id of [...ids(api, mid, 'IFCWALL'), ...ids(api, mid, 'IFCWALLSTANDARDCASE')]) {
      const l = line(id);
      const m = l?.ObjectPlacement ? M(l.ObjectPlacement.value) : null;
      if (!m) continue;
      const reps = (line(l.Representation?.value)?.Representations || []).map((r) => line(r.value)).filter(Boolean);
      const axis = reps.find((r) => /^axis$/i.test(val(r.RepresentationIdentifier) || ''));
      const cv = axis ? line(axis.Items?.[0]?.value) : null;
      let pts = null;
      if (Array.isArray(cv?.Points)) pts = cv.Points.map((h) => (line(h.value)?.Coordinates || []).map((c) => Number(val(c))));   // IfcPolyline
      else if (cv?.Points?.value) pts = (line(cv.Points.value)?.CoordList || []).map((p) => p.map((c) => Number(val(c))));   // IfcIndexedPolyCurve
      if (!pts || pts.length < 2) continue;
      const a = [pts[0][0], pts[0][1], 0], b = [pts[pts.length - 1][0], pts[pts.length - 1][1], 0];
      push('wall', id, l, at(m, a));
      push('wall', id, l, at(m, b));
    }
  }
  if (kinds.has('anchor')) {
    for (const id of [...ids(api, mid, 'IFCMECHANICALFASTENER'), ...ids(api, mid, 'IFCFASTENER')]) {
      const l = line(id);
      const type = String(val(l?.PredefinedType) || '');
      if (!/ANCHOR/i.test(type) && !/anchor/i.test(nameOf(l) + ' ' + (val(l?.ObjectType) || ''))) continue;
      push('anchor', id, l, origin(id));
    }
  }
  if (kinds.has('sleeve')) {
    const seen = new Set();
    for (const cls of ['IFCBUILDINGELEMENTPROXY', 'IFCPIPESEGMENT', 'IFCFLOWSEGMENT', 'IFCDISCRETEACCESSORY', 'IFCOPENINGELEMENT', 'IFCMEMBER', 'IFCPLATE']) {
      let list = [];
      try { list = ids(api, mid, cls); } catch { list = []; }
      for (const id of list) {
        if (seen.has(id)) continue;
        const l = line(id);
        if (!/sleeve/i.test([val(l?.Name), val(l?.ObjectType), val(l?.Description)].filter(Boolean).join(' '))) continue;
        seen.add(id);
        push('sleeve', id, l, origin(id));
      }
    }
  }
  if (kinds.has('element')) for (const id of selection) { const l = line(id); if (l) push('element', id, l, origin(id)); }
  points.sort(planOrder(KINDS));
  return { points, counts, unitMm };
}

/** The points in the units and coordinates asked (file mm in, Z up). */
export function inUnits(points, { coords = 'model', georef = null, unitMm = 1, unit = 'm' } = {}) {
  const k = 1 / (UNIT_MM[unit] || 1000);
  return points.map((p) => {
    if (coords === 'survey' && georef?.kind === 'map') {
      const [E, N, H] = fileToMap(georef, [p.x / unitMm, p.y / unitMm, p.z / unitMm]);
      return { ...p, x: E * 1000 * k, y: N * 1000 * k, z: H * 1000 * k };
    }
    return { ...p, x: p.x * k, y: p.y * k, z: p.z * k };
  });
}
