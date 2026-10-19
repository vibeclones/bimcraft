/* SPDX-License-Identifier: Apache-2.0 */
/**
 * model-ops.js — what the building tools do to the model, as changes for IfcEditor.modelChange (0.5 part 3, track BM):
 * each op is a function (editor) → { journal, id, ids, made } that writes through a ModelWriter, so it is ONE undo step and
 * a redo runs it again. Ops name storeys and elements by GlobalId (stable across undo / redo), never by expressID.
 * No DOM: bin/test-bimcraft.mjs --model runs it in Node.
 *
 *   ed.modelChange(drawWalls({ storey, segs: [{ a, b }], typeKey, … }), { label, verb })
 *   ed.modelChange(changeWall(guid, { a, b, typeKey, height, … }))
 *   ed.modelChange(removeWalls([guid…]))
 *   ed.modelChange(newLevel({ name, elevation, height }))  ·  ed.modelChange(changeLevel(guid, { name, elevation, height }))
 *
 * Every op ends by bringing the walls it may have changed up to date (model-walls.js regenWalls): joins, heights that
 * follow a level, quantities.
 */
import { ModelWriter } from './model-write.js';
import { readLevels, addLevel, setLevel } from './model-levels.js';
import { addWall, updateWall, deleteWalls, regenWalls, readWalls } from './model-walls.js';
import { addOpening, updateOpening, deleteOpenings, readOpenings, regenOpenings } from './model-openings.js';
import { syncDerived, readDerived, storeyLoops, addFloor, addCeiling, addRoof, updateDerived, deleteDerived } from './model-slabs.js';
import { wallPath } from './model-tools.js';
import { val } from './ifc-util.js';
import { syncResidential } from './res-follow.js';   // 0.5 part 4 track RC: wall framing follows its doors and windows

/** Wrap a writing function as an op: a fresh writer on the editor's model, one journal. */
export function op(fn) {
  return (ed) => {
    const w = new ModelWriter(ed.W, ed.api, ed.mid);
    return w.run(fn);
  };
}
const storeyId = (w, guid) => {
  const id = w.byGuid(guid);
  if (!id) throw Object.assign(new Error('model.err.nolevel'), { key: 'model.err.nolevel' });
  return id;
};
/** Fresh GlobalIds fixed into the op the first time it runs, so a redo makes the same elements again. */
const fix = (w, list) => { for (const s of list) if (!s.guid) s.guid = val(w.guid()); };
/** After doors / windows changed in these walls: the walls, then what follows them (RC: their framing). */
function afterOpenings(w, guids) {
  const walls = readWalls(w), storeys = new Set();
  for (const g of guids) { const x = walls.find((y) => y.guid === g); if (x) { regenWalls(w, x.storey, [g]); storeys.add(x.storey); } }
  for (const st of storeys) syncResidential(w, st);
}
/** Regenerate every storey's walls (after a level change: heights that follow a level). */
export function regenAll(w) {
  let n = 0;
  for (const l of readLevels(w)) { n += regenWalls(w, l.id).walls; syncDerived(w, l.id); }
  return n;
}
/** After walls changed on these storeys: joins, then rooms / floors / ceilings / roofs that follow them. */
function settle(w, storeys, force = null) {
  for (const s of new Set(storeys)) { if (s === null || s === undefined) continue; regenWalls(w, s, force); syncDerived(w, s); }
}
/** For ops written elsewhere (model-trim.js, 0.6): the same follow-ups as this file's own wall changes. */
export const afterWallMoveFor = (w, before, ops0, guids) => afterWallMove(w, before, ops0, guids, false);
export const settleFor = (w, storeys, force = null) => settle(w, storeys, force);

/** Draw walls on a storey: segs [{ a, b }] in its plan axes (mm). One undo step for all of them. */
export function drawWalls({ storey, segs, typeKey, baseOffset = 0, topLevel = '', topOffset = 0, height = 0, extSide = 'left' }) {
  const list = segs.map((s) => ({ ...s }));
  return op((w) => {
    fix(w, list);
    const st = storeyId(w, storey);
    const made = new Map();
    for (const s of list) {
      const r = addWall(w, { storey: st, a: s.a, b: s.b, typeKey: s.typeKey || typeKey, baseOffset, topLevel, topOffset, height, extSide: s.extSide || extSide, guid: s.guid, bulge: s.bulge || 0, justification: s.justification || 'center' });   // 0.6 round 2: curved walls, the location line
      made.set(r.guid, r.id);
    }
    settle(w, [st]);
    const ids = [...made.values()];
    return { id: ids[ids.length - 1], ids, made };
  });
}

/** Extend a face-referenced chain and settle its corners in the same undo step. */
export function drawWallPath({ storey, points, guids, typeKey, thickness, reference, extSide, ...top }) {
  const segs = wallPath(points, thickness, reference, extSide);
  let existing = null;
  return op((w) => {
    existing ??= guids.slice();
    const st = storeyId(w, storey), made = new Map();
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (existing[i]) updateWall(w, existing[i], { a: seg.a, b: seg.b, extSide }, { carryJoined: false });
      else {
        if (!seg.guid) seg.guid = val(w.guid());
        const r = addWall(w, { storey: st, ...seg, typeKey, extSide, ...top });
        made.set(r.guid, r.id);
      }
    }
    settle(w, [st]);
    return { id: [...made.values()].at(-1), made };
  });
}

/** Change one wall (see model-walls.js updateWall); walls joined at a moved end move with it, and what they host keeps
 *  its place (or fits itself in again). */
export function changeWall(guid, changes, opts = {}) {
  return op((w) => {
    const before = readWalls(w), wall = before.find((x) => x.guid === guid);
    if (!wall) throw Object.assign(new Error('model.err.nowall'), { key: 'model.err.nowall' });
    const ops0 = readOpenings(w, null, before);
    const r = updateWall(w, guid, changes, opts);
    afterWallMove(w, before, ops0, r.guids, !!changes.typeKey);
    settle(w, [wall.storey], r.guids);
    return { id: w.byGuid(guid), ids: [w.byGuid(guid)] };
  });
}
/** Doors and windows of walls that moved or changed: same place in the world when a wall end slid along its line; made
 *  again for a new thickness; fitted into a shorter wall (or the change is refused: model.err.nofit). */
function afterWallMove(w, before, ops0, guids, rethick) {
  const after = readWalls(w);
  for (const g of guids) {
    const A = before.find((x) => x.guid === g), B = after.find((x) => x.guid === g);
    if (!A || !B) continue;
    const mine = ops0.filter((o) => o.wallGuid === g);
    if (!mine.length) continue;
    const uA = [(A.b[0] - A.a[0]) / A.len, (A.b[1] - A.a[1]) / A.len], uB = [(B.b[0] - B.a[0]) / B.len, (B.b[1] - B.a[1]) / B.len];
    const sameLine = Math.abs(uA[0] * uB[1] - uA[1] * uB[0]) < 1e-9 && uA[0] * uB[0] + uA[1] * uB[1] > 0;
    const shift = sameLine ? (B.a[0] - A.a[0]) * uA[0] + (B.a[1] - A.a[1]) * uA[1] : 0;
    const moved = Math.abs(shift) > 1e-6 || Math.abs(A.len - B.len) > 1e-6 || Math.abs(A.t - B.t) > 1e-6 || rethick;
    if (!moved) continue;
    for (const o of mine) updateOpening(w, o.guid, { offset: o.offset - shift });
  }
}

/** Change several walls the same way (Properties with many picked; "Change type…"). */
export function changeWalls(guids, changes) {
  return op((w) => {
    const all = readWalls(w), ops0 = readOpenings(w, null, all);
    const storeys = new Set();
    for (const g of guids) {
      const wall = all.find((x) => x.guid === g);
      if (!wall) continue;
      updateWall(w, g, changes, { carryJoined: false });
      storeys.add(wall.storey);
    }
    afterWallMove(w, all, ops0, guids, !!changes.typeKey);
    settle(w, storeys, guids);
    const ids = guids.map((g) => w.byGuid(g)).filter(Boolean);
    return { id: ids[0] ?? null, ids };
  });
}

/** Put a door or window in a wall: { wall (GlobalId), typeKey, offset, width, height, sill, hand, face }. */
export function placeOpening(spec) {
  const s = { ...spec };
  return op((w) => {
    if (!s.guid) { s.guid = val(w.guid()); s.openingGuid = val(w.guid()); }
    const r = addOpening(w, s);
    afterOpenings(w, [s.wall]);
    return { id: r.id, ids: [r.id], made: new Map([[r.guid, r.id], [r.opening, w.byGuid(r.opening)]]) };
  });
}
/** Move a door or window along its wall (or to another wall), resize it, flip it, change its type. */
export function changeOpening(guid, changes) {
  return op((w) => {
    const r = updateOpening(w, guid, changes);
    afterOpenings(w, r.walls);
    const id = w.byGuid(guid);
    return { id, ids: [id] };
  });
}
/** The same change to several doors / windows (Properties with many picked): one undo step. */
export function changeOpenings(guids, changes) {
  return op((w) => {
    const hosts = new Set();
    for (const g of guids) for (const h of updateOpening(w, g, changes).walls) hosts.add(h);
    afterOpenings(w, [...hosts]);
    const ids = guids.map((g) => w.byGuid(g)).filter(Boolean);
    return { id: ids[0] ?? null, ids };
  });
}

/** Delete doors and windows; their walls close up. */
export function removeOpenings(guids) {
  return op((w) => {
    const r = deleteOpenings(w, guids);
    afterOpenings(w, r.walls);
    return { id: null, ids: [] };
  });
}
/** Delete what is picked of the tools' elements: walls (with what they host) and doors / windows, as one change. */
export function removeElements({ walls = [], openings = [], derived = [] }) {
  return op((w) => {
    const storeys = new Set(), hosts = new Set();
    if (derived.length) deleteDerived(w, derived);
    if (openings.length) for (const g of deleteOpenings(w, openings).walls) hosts.add(g);
    if (walls.length) for (const s of deleteWalls(w, walls).storeys) storeys.add(s);
    const all = readWalls(w);
    for (const g of hosts) { const x = all.find((y) => y.guid === g); if (x) storeys.add(x.storey); }
    settle(w, storeys, [...hosts]);
    return { id: null, ids: [] };
  });
}

/** A floor (or a ceiling) for the room at `seed` — or under the whole building — on a level (GlobalId). */
export function placeFloor(spec) {
  const s = { ...spec };
  return op((w) => {
    if (!s.guid) s.guid = val(w.guid());
    const r = addFloor(w, { ...s, storey: storeyId(w, s.storey) });
    return { id: r.id, ids: [r.id], made: new Map([[r.guid, r.id]]) };
  });
}
export function placeCeiling(spec) {
  const s = { ...spec };
  return op((w) => {
    if (!s.guid) s.guid = val(w.guid());
    const r = addCeiling(w, { ...s, storey: storeyId(w, s.storey) });
    return { id: r.id, ids: [r.id], made: new Map([[r.guid, r.id]]) };
  });
}
/** A roof over the building whose walls are on `storey` (GlobalId), around the point `seed`. */
export function placeRoof(spec) {
  const s = { ...spec };
  return op((w) => {
    if (!s.guid) s.guid = val(w.guid());
    const r = addRoof(w, { ...s, storey: storeyId(w, s.storey) });
    return { id: r.id, ids: [r.id], made: new Map([[r.guid, r.id]]) };
  });
}
/** Change a room's name or number, a floor's / ceiling's / roof's numbers; the shape is made again. */
export function changeDerived(guids, changes) {
  return op((w) => {
    const storeys = new Set();
    for (const g of [].concat(guids)) { const r = updateDerived(w, g, changes); if (r.storey !== null) storeys.add(r.storey); }
    for (const st of storeys) syncDerived(w, st);
    const ids = [].concat(guids).map((g) => w.byGuid(g)).filter(Boolean);
    return { id: ids[0] ?? null, ids };
  });
}

/** Delete walls with their openings, doors and windows; the walls they joined are cleaned up again. */
export function removeWalls(guids) {
  return op((w) => {
    const r = deleteWalls(w, guids);
    settle(w, r.storeys);
    return { id: null, ids: [] };
  });
}

/** A new level (storey) in the building. */
export function newLevel({ name, elevation, height }) {
  const fixed = { guid: null };
  return op((w) => {
    if (!fixed.guid) fixed.guid = val(w.guid());
    const r = addLevel(w, { name, elevation, height, guid: fixed.guid });
    regenAll(w);
    return { id: r.id, ids: [r.id], made: new Map([[r.guid, r.id]]) };
  });
}

/** Rename, move or change the height of a level (levels above move with it by default); walls follow. */
export function changeLevel(guid, changes) {
  return op((w) => {
    const r = setLevel(w, guid, changes);
    regenAll(w);
    return { id: w.byGuid(guid), ids: r.moved };
  });
}

/** For the UI: the levels and walls now (no change). */
export function snapshotModel(ed) {
  const w = new ModelWriter(ed.W, ed.api, ed.mid);
  const walls = readWalls(w);
  return { levels: readLevels(w), walls, openings: readOpenings(w, null, walls), derived: readDerived(w), unitMm: w.unitMm, v4: w.v4 };
}
/** The rooms and building outlines of a level, from its walls now (the plan's labels and the tools' hover). */
export function loopsOf(ed, storey) { return storeyLoops(new ModelWriter(ed.W, ed.api, ed.mid), storey); }
