/* SPDX-License-Identifier: Apache-2.0 */
/**
 * model-levels.js — the building's levels (IfcBuildingStorey) for the Levels panel and the plan views (0.5 part 3,
 * BM.2). No DOM: bin/test-bimcraft.mjs --model runs it in Node.
 *
 *   readLevels(w)  → [{ id, guid, name, elevation, height, own }]   elevation = world Z of the storey (mm), height = the
 *                    CadCraft_Level pset's Height, else the distance to the next level up, else 3000 mm; own = it has the pset
 *   levelAbove(levels, id) → the next level up or null
 *   addLevel(w, { name, elevation, height, guid })          a new storey in the building (one undo step through run())
 *   setLevel(w, guid, { name, elevation, height, shiftAbove })  rename / move / change height; shiftAbove moves every level
 *                    above by the same amount (a taller level 1 lifts levels 2, 3 …) — the default in the panel
 *
 * A level's elevation is written twice, as IFC asks: the storey's placement (relative to the building) and its
 * Elevation attribute. Walls on a level are placed relative to it, so they move with it; walls whose top follows the
 * level above get new heights (model-walls.js regenWalls, called by the page after these).
 */
import { ids, val } from './ifc-util.js';

export const LEVEL_PSET = 'CadCraft_Level';
export const DEFAULT_HEIGHT = 3000;

export function readLevels(w) {
  const out = [];
  for (const id of ids(w.api, w.mid, 'IFCBUILDINGSTOREY')) {
    const s = w.api.GetLine(w.mid, id, false);
    const M = w.storeyWorld(id);
    const ps = w.readPset(id, LEVEL_PSET);
    out.push({ id, guid: val(s.GlobalId), name: val(s.Name) || val(s.LongName) || '#' + id, elevation: M[14], height: Number(ps?.Height) > 0 ? Number(ps.Height) * w.unitMm : null, own: !!ps });
  }
  out.sort((a, b) => a.elevation - b.elevation || a.id - b.id);
  out.forEach((l, i) => { if (!(l.height > 0)) l.height = out[i + 1] ? Math.max(1000, out[i + 1].elevation - l.elevation) : (out[i - 1]?.height || DEFAULT_HEIGHT); });
  return out;
}
export const levelAbove = (levels, id) => { const i = levels.findIndex((l) => l.id === id); return i >= 0 ? levels[i + 1] || null : null; };

/** The building the storeys hang under (the parent of the first storey, else the first IfcBuilding). */
function buildingOf(w) {
  for (const rid of ids(w.api, w.mid, 'IFCRELAGGREGATES')) {
    const r = w.api.GetLine(w.mid, rid, false);
    const parent = r.RelatingObject?.value;
    if (!parent) continue;
    if (/^IfcBuilding$/i.test(w.api.GetLine(w.mid, parent, false)?.constructor?.name || '')) return { id: parent, rel: rid };
  }
  const b = ids(w.api, w.mid, 'IFCBUILDING')[0];
  return b ? { id: b, rel: null } : null;
}

export function addLevel(w, { name, elevation, height = DEFAULT_HEIGHT, guid } = {}) {
  const b = buildingOf(w);
  if (!b) throw Object.assign(new Error('model.err.nobuilding'), { key: 'model.err.nobuilding' });
  const bl = w.api.GetLine(w.mid, b.id, false);
  const bz = bl.ObjectPlacement ? w.relWorldZ(bl.ObjectPlacement.value) : 0;
  const lp = w.placeAt(bl.ObjectPlacement?.value ?? null, 0, 0, elevation - bz, 0);
  const g = w.gid(guid);
  const id = w.make('IFCBUILDINGSTOREY', g, w.ownerHistory(), w.L(name), null, null, w.H(lp), null, null, 'ELEMENT', w.u(elevation));
  w.noteGuid(g, id);
  if (b.rel) {
    const r = w.touch(b.rel);
    r.RelatedObjects = [...(r.RelatedObjects || []), w.H(id)];
    w.write(r);
  } else w.make('IFCRELAGGREGATES', w.guid(), w.ownerHistory(), null, null, w.H(b.id), [w.H(id)]);
  w.upsertPset(id, LEVEL_PSET, [['Height', 'IFCPOSITIVELENGTHMEASURE', w.u(height)]]);
  return { id, guid: g };
}

export function setLevel(w, guid, { name, elevation, height, shiftAbove = true } = {}) {
  const levels = readLevels(w);
  const i = levels.findIndex((l) => l.guid === guid);
  if (i < 0) throw Object.assign(new Error('model.err.nolevel'), { key: 'model.err.nolevel' });
  const L = levels[i];
  if (name !== undefined && name !== null && String(name).trim() && String(name).trim() !== L.name) {
    const s = w.touch(L.id); s.Name = w.L(String(name).trim()); w.write(s);
  }
  let dz = 0;
  if (Number.isFinite(elevation) && Math.abs(elevation - L.elevation) > 0.01) dz = elevation - L.elevation;
  if (Number.isFinite(height) && height > 0 && (!L.own || Math.abs(height - L.height) > 0.01)) {
    w.upsertPset(L.id, LEVEL_PSET, [['Height', 'IFCPOSITIVELENGTHMEASURE', w.u(height)]]);
  }
  const moves = new Map();
  if (dz) moves.set(L.id, dz);
  // a taller (or shorter) level, or a moved one, carries the levels above with it
  if (shiftAbove) {
    const dh = Number.isFinite(height) && height > 0 ? height - L.height : 0;
    const up = dz + dh;
    if (Math.abs(up) > 0.01) for (const A of levels.slice(i + 1)) moves.set(A.id, (moves.get(A.id) || 0) + up);
  }
  for (const [id, d] of moves) moveStorey(w, id, d);
  return { moved: [...moves.keys()] };
}

/** Raise a storey by dz mm: its placement's Z and its Elevation attribute. */
function moveStorey(w, id, dz) {
  const s = w.api.GetLine(w.mid, id, false);
  const lp = s.ObjectPlacement?.value;
  if (lp) {
    const pl = w.api.GetLine(w.mid, lp, false);
    const ax = pl.RelativePlacement ? w.api.GetLine(w.mid, pl.RelativePlacement.value, false) : null;
    const loc = ax?.Location ? w.api.GetLine(w.mid, ax.Location.value, false) : null;
    const c = (loc?.Coordinates || []).map((v) => Number(val(v)) || 0);
    const ref = ax?.RefDirection ? (w.api.GetLine(w.mid, ax.RefDirection.value, false)?.DirectionRatios || []).map((v) => Number(val(v)) || 0) : [1, 0];
    const axisZ = ax?.Axis ? (w.api.GetLine(w.mid, ax.Axis.value, false)?.DirectionRatios || []).map((v) => Number(val(v)) || 0) : [0, 0, 1];
    if (Math.abs(axisZ[2] - 1) > 1e-6) throw Object.assign(new Error('model.err.tilted'), { key: 'model.err.tilted' });
    // a new axis placement: the old one may be shared by other placements in a file from elsewhere
    const p = w.point3(c[0] || 0, c[1] || 0, (c[2] || 0) + w.u(dz));
    const a = w.make('IFCAXIS2PLACEMENT3D', w.H(p), w.H(w.dir(0, 0, 1)), w.H(w.dir(ref[0] ?? 1, ref[1] ?? 0, 0)));
    const t = w.touch(lp); t.RelativePlacement = w.H(a); w.write(t);
  }
  const st = w.touch(id);
  st.Elevation = (Number(val(st.Elevation)) || 0) + w.u(dz);
  w.write(st);
}
