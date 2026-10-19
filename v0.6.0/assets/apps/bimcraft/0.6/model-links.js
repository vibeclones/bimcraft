/* SPDX-License-Identifier: Apache-2.0 */
/**
 * model-links.js — linked models for coordination (0.6 DF.21, session `bim-draw`): another IFC shown beside the model by
 * reference (never merged), where it goes, and the link written into the model. No DOM: bin/test-bimcraft.mjs --draw06.
 *
 * In the file: an IfcDocumentReference (Location = the linked file's name or path, Identification "link-<n>", Name = its
 * file name; IFC2X3: Location, ItemReference, Name) associated with the project by IfcRelAssociatesDocument, and its
 * placement in the project's property set CadCraft_Links: one IfcText per link, named by its Identification, holding JSON
 * { mode: 'file' | 'map' | 'points', m: 4 × 4 (column-major) taking the linked file's own coordinates (mm, Z up) to the
 * model's (mm, Z up) }. 'file' = the same coordinates (shared origin; m identity), 'map' = through both files' map
 * conversions, 'points' = two pairs of points picked in the view (a turn about the vertical and a move).
 *
 *   readLinks(w) → [{ ref (expressID), id ('link-n'), name, location, mode, m }]
 *   addLink({ name, location, mode, m }) → op          · changeLink(id, { mode, m, location }) → op · removeLink(id) → op
 *   mapMatrix(hostGeo, linkGeo, hostUnitMm, linkUnitMm) → m | null   (ifc-geo.js readGeoref of each; both 'map')
 *   pairsMatrix([[link0, host0], [link1, host1]]) → m   points in file mm (Z up): the turn about Z that carries the first
 *                                                      pair's direction onto the second's, then the move of the first point
 *   sceneAdjust(m, F) → A      the same change in the scene: F = the model's file mm → scene matrix; A = F · m · F⁻¹ applied
 *                              after the link's default (shared-coordinates) placement
 *   fileOfScene(A, F) → m      the inverse (a change made in the scene, back to file mm)
 */
import { op } from './model-ops.js';
import { ids, val, inv4, mul4, apply4, deleteLine } from './ifc-util.js';

export const LINKS_PSET = 'CadCraft_Links';
export const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const refuse = (key) => { throw Object.assign(new Error(key), { key }); };
const project = (w) => ids(w.api, w.mid, 'IFCPROJECT')[0];

export function readLinks(w) {
  const out = [];
  const pj = project(w);
  if (pj === undefined) return out;
  const ps = w.readPset(pj, LINKS_PSET) || {};
  for (const rid of ids(w.api, w.mid, 'IFCRELASSOCIATESDOCUMENT')) {
    const r = w.api.GetLine(w.mid, rid, false);
    if (!(r.RelatedObjects || []).some((h) => h.value === pj)) continue;
    const d = r.RelatingDocument?.value ? w.api.GetLine(w.mid, r.RelatingDocument.value, false) : null;
    if (!d || !/DocumentReference/i.test(d.constructor?.name || '')) continue;
    const id = String(val(d.Identification ?? d.ItemReference) || '');
    if (!/^link-\d+$/.test(id)) continue;   // ours only: other programs' document references are left alone
    let meta = {};
    try { meta = JSON.parse(ps[id] || '{}') || {}; } catch (e) { meta = {}; }
    out.push({ ref: d.expressID ?? r.RelatingDocument.value, rel: rid, id, name: String(val(d.Name) || ''), location: String(val(d.Location) || ''), mode: ['file', 'map', 'points'].includes(meta.mode) ? meta.mode : 'file', m: Array.isArray(meta.m) && meta.m.length === 16 && meta.m.every(Number.isFinite) ? meta.m : I4.slice() });
  }
  return out;
}

const metaText = (mode, m) => JSON.stringify({ mode, m: m.map((v) => Math.round(v * 1e9) / 1e9) });

export function addLink({ name, location, mode = 'file', m = I4 }) {
  const M = m.slice();
  let fixedId = null;
  return op((w) => {
    const pj = project(w);
    if (pj === undefined) refuse('model.err.link.noproject');
    const have = readLinks(w);
    if (!fixedId) { let n = 1; while (have.some((x) => x.id === 'link-' + n)) n++; fixedId = 'link-' + n; }
    const loc = w.T('IFCURIREFERENCE', String(location || name).slice(0, 255));
    const ref = w.v4
      ? w.make('IFCDOCUMENTREFERENCE', loc, w.T('IFCIDENTIFIER', fixedId), w.L(name), null, null)
      : w.make('IFCDOCUMENTREFERENCE', w.T('IFCLABEL', String(location || name).slice(0, 255)), w.T('IFCIDENTIFIER', fixedId), w.L(name));
    w.make('IFCRELASSOCIATESDOCUMENT', w.guid(), w.ownerHistory(), null, null, [w.H(pj)], w.H(ref));
    w.upsertPset(pj, LINKS_PSET, [[fixedId, 'IFCTEXT', metaText(mode, M)]]);
    return { id: ref, ids: [], link: fixedId };
  });
}

export function changeLink(id, { mode, m, location } = {}) {
  return op((w) => {
    const L = readLinks(w).find((x) => x.id === id);
    if (!L) refuse('model.err.link.none');
    if (mode || m) w.upsertPset(project(w), LINKS_PSET, [[id, 'IFCTEXT', metaText(mode || L.mode, m || L.m)]]);
    if (location) { const d = w.touch(L.ref); d.Location = w.v4 ? w.T('IFCURIREFERENCE', String(location).slice(0, 255)) : w.T('IFCLABEL', String(location).slice(0, 255)); w.write(d); }
    return { id: L.ref, ids: [] };
  });
}

export function removeLink(id) {
  return op((w) => {
    const L = readLinks(w).find((x) => x.id === id);
    if (!L) refuse('model.err.link.none');
    w.touch(L.rel); deleteLine(w.api, w.mid, L.rel);
    w.touch(L.ref); deleteLine(w.api, w.mid, L.ref);
    w.upsertPset(project(w), LINKS_PSET, [[id, 'IFCTEXT', '']]);   // emptied: read as no link
    return { id: null, ids: [] };
  });
}

const S = (k) => [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1];
export function mapMatrix(hg, lg, hostUnitMm, linkUnitMm) {
  if (!hg || !lg || hg.kind !== 'map' || lg.kind !== 'map') return null;
  // link mm → link file units → its map (metres) → the model's map units → the model's file units → mm
  const linkToMetres = mul4(S(lg.mapUnitM), mul4(lg.matrix, S(1 / linkUnitMm)));
  const metresToHost = mul4(S(hostUnitMm), mul4(inv4(hg.matrix), S(1 / hg.mapUnitM)));
  return mul4(metresToHost, linkToMetres);
}

export function pairsMatrix(pairs) {
  const [[l0, h0], [l1, h1]] = pairs;
  const a = Math.atan2(h1[1] - h0[1], h1[0] - h0[0]) - Math.atan2(l1[1] - l0[1], l1[0] - l0[0]);
  const c = Math.cos(a), s = Math.sin(a);
  const R = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const r0 = apply4(R, l0[0], l0[1], l0[2] || 0);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, h0[0] - r0[0], h0[1] - r0[1], (h0[2] || 0) - r0[2], 1];
}

export const sceneAdjust = (m, F) => mul4(F, mul4(m, inv4(F)));
export const fileOfScene = (A, F) => mul4(inv4(F), mul4(A, F));
