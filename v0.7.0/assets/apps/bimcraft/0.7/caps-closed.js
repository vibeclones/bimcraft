// SPDX-License-Identifier: Apache-2.0
/**
 * caps-closed.js — which elements of a batch are closed solids, for the section caps (viewer3d.js updateCaps).
 *
 * The caps count, along each view ray, how often it crosses an element's surface behind the section plane: odd = inside a
 * solid, so the cut face paints there. That only holds for closed surfaces. An open one (tree foliage, a terrain sheet,
 * a single-sided panel) gives odd counts over its whole outline, and the cut colour painted over it — the "ghosted"
 * elements of a Discord report (PokeJohn, 2026-10-14), worse or better depending on the view angle. Such elements are
 * left out of the count: they have no inside to fill.
 *
 * Closed = every edge of the element's triangles is used an even number of times, with vertices compared by position
 * (exporters split vertices at hard edges, so indices alone would call every box open). DOM-free; no three.js.
 *
 *   openElements(positions, indices, triIds) → Set of element ids whose surface is open
 *   openAcross(batches) → the same over every batch at once ({positions, indices, triIds, elems?} each)
 *   stencilIndex(index, nSolid, triIds, open) → Uint32Array: the shown (group 0) triangles of closed elements
 *
 * Batches are storey × colour, so an element whose parts have different colours (a frame, a leaf and its glass; shells
 * styled one by one) lands in several, and each part alone can be open while the element is closed: judged batch by
 * batch it got no cut face and looked hollow (0.6 DC.53). openAcross checks such elements again over all their parts;
 * an element in one batch costs no more than before.
 */

const Q = 1e4;   // positions are compared at 0.1 mm (model metres)

/** Element ids (triIds[t] for triangle t of `indices`) whose triangles do not make a closed surface. */
export function openElements(positions, indices, triIds) {
  const nV = positions.length / 3;
  // One id per distinct position, so split vertices meet again.
  const canon = new Int32Array(nV);
  const seen = new Map();
  for (let v = 0; v < nV; v++) {
    const k = Math.round(positions[v * 3] * Q) + ',' + Math.round(positions[v * 3 + 1] * Q) + ',' + Math.round(positions[v * 3 + 2] * Q);
    let id = seen.get(k);
    if (id === undefined) { id = seen.size; seen.set(k, id); }
    canon[v] = id;
  }
  const nP = seen.size;
  // Triangles by element.
  const byEl = new Map();
  const nT = indices.length / 3;
  for (let t = 0; t < nT; t++) {
    const e = triIds[t];
    let l = byEl.get(e);
    if (!l) { l = []; byEl.set(e, l); }
    l.push(t);
  }
  const open = new Set();
  const edges = new Map();
  for (const [e, tris] of byEl) {
    edges.clear();
    for (const t of tris) {
      const a = canon[indices[t * 3]], b = canon[indices[t * 3 + 1]], c = canon[indices[t * 3 + 2]];
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        if (p === q) continue;   // a degenerate edge adds nothing
        const key = p < q ? p * nP + q : q * nP + p;
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    }
    for (const n of edges.values()) if (n % 2) { open.add(e); break; }
  }
  return open;
}

/** Element ids open over every batch they are in (the stencil passes count all batches into one buffer). */
export function openAcross(batches) {
  const open = new Set(), seen = new Map();   // element id → number of batches it is in
  const idsOf = (b) => (b.elems ? b.elems.ids : new Set(b.triIds));
  for (const b of batches) {
    for (const e of openElements(b.positions, b.indices, b.triIds)) open.add(e);
    for (const e of new Set(idsOf(b))) seen.set(e, (seen.get(e) || 0) + 1);
  }
  const again = new Set([...open].filter((e) => seen.get(e) > 1));
  if (!again.size) return open;
  // their triangles from every batch, unindexed (openElements meets the corners again by position)
  const pos = [], ids = [];
  for (const b of batches) {
    const P = b.positions, I = b.indices, T = b.triIds;
    for (let t = 0; t < T.length; t++) {
      if (!again.has(T[t])) continue;
      for (let k = 0; k < 3; k++) { const v = I[t * 3 + k] * 3; pos.push(P[v], P[v + 1], P[v + 2]); }
      ids.push(T[t]);
    }
  }
  const still = openElements(Float32Array.from(pos), Uint32Array.from({ length: pos.length / 3 }, (_, i) => i), ids);
  for (const e of again) if (!still.has(e)) open.delete(e);
  return open;
}

/** The index for a stencil pass: the first nSolid triangles (group 0, shown) whose element is closed. */
export function stencilIndex(index, nSolid, triIds, open) {
  if (!open.size) return index.subarray(0, nSolid * 3);
  const out = new Uint32Array(nSolid * 3);
  let n = 0;
  for (let t = 0; t < nSolid; t++) {
    if (open.has(triIds[t])) continue;
    out[n++] = index[t * 3]; out[n++] = index[t * 3 + 1]; out[n++] = index[t * 3 + 2];
  }
  return out.subarray(0, n);
}
