/* SPDX-License-Identifier: Apache-2.0 */
/**
 * cloud-slice.js — drawing on a point cloud (0.6 DF.22, session `bim-draw`): the cloud's slice at a level's cut height in the
 * plan, a grid of its points for snapping, and what aligns a scan to the building (its floor to a level, its walls square).
 * No DOM, no three.js: bin/test-bimcraft.mjs --draw06 runs it in Node. Plan millimetres in a storey's own axes.
 *
 * The cloud is read as drawn: positions `pos` (Float32Array, 3 per point, relative to the cloud's origin, pointcloud.js) taken
 * to the plan by one 4 × 4 `M` (column-major): the layer's matrix (cloud-ui.js), the model's scene placement undone and
 * model-plan.js viewerToPlan for the level — see planMatrix.
 *
 *   planMatrix(layerMatrix, modelMatrix, C, storeyWorldMm) → M      cloud positions → the level's plan (mm, z above the level)
 *   slicePoints(pos, n, M, { cutZ, thick, max }) → { xy: Float32Array (2 per point), n, zs }   the points within thick / 2 of
 *                                         cutZ (1200 = the plan's own cut), thinned evenly to `max` (60 000)
 *   new SliceGrid(xy, n, cell)  .nearest(x, y, r) → [x, y] | null   the slice point nearest a plan point within r
 *   squareAngle(xy, n, { cell }) → { angle (degrees, −45…45], strength 0…1 } | null   the walls' direction in the slice: each
 *                                         cell's points fitted with a line (principal axis), long thin cells vote for their
 *                                         angle folded into ±45° by weight, the strongest 0.5° wins; then the turn within ±1°
 *                                         (0.02° steps) that piles the points up most sharply along X and Y (to ~0.05°)
 *   floorZ(pos, n, M, { step }) → z | null   the floor's height in the plan's z: the densest 20 mm band in the lowest third of the
 *                                         cloud (a scan sees most of the floor)
 *   planAdjust(M4plan, Mvp) → the same change in the scene: inv(Mvp) · A · Mvp
 *   rotZ(angleDeg, about) / moveZ(dz)     plan changes (mm): a turn about a plan point, a lift
 */
import { mul4, inv4, apply4 } from './ifc-util.js';

export function planMatrix(layerMatrix, modelMatrix, C, storeyWorldMm) {
  const S = [1000, 0, 0, 0, 0, 0, 1000, 0, 0, -1000, 0, 0, 0, 0, 0, 1];   // as model-plan.js viewerToPlan
  const vToPlan = mul4(inv4(storeyWorldMm), mul4(S, inv4(C)));
  return mul4(vToPlan, mul4(inv4(modelMatrix), layerMatrix));
}

export function slicePoints(pos, n, M, { cutZ = 1200, thick = 100, max = 60000 } = {}) {
  const half = thick / 2, keep = [];
  const m = M;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const pz = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (pz < cutZ - half || pz > cutZ + half) continue;
    keep.push(i);
  }
  const step = keep.length > max ? keep.length / max : 1, cnt = Math.min(keep.length, max);
  const xy = new Float32Array(cnt * 2), zs = new Float32Array(cnt);
  for (let k = 0; k < cnt; k++) {
    const i = keep[Math.floor(k * step)], x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    xy[k * 2] = m[0] * x + m[4] * y + m[8] * z + m[12];
    xy[k * 2 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    zs[k] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return { xy, n: cnt, zs, total: keep.length };
}

export class SliceGrid {
  constructor(xy, n, cell = 200) {
    this.xy = xy; this.n = n; this.cell = cell; this.map = new Map();
    for (let i = 0; i < n; i++) {
      const k = this.key(Math.floor(xy[i * 2] / cell), Math.floor(xy[i * 2 + 1] / cell));
      let a = this.map.get(k); if (!a) { a = []; this.map.set(k, a); } a.push(i);
    }
  }
  key(i, j) { return i * 73856093 ^ j * 19349663; }
  nearest(x, y, r) {
    const c = this.cell, i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c), j0 = Math.floor((y - r) / c), j1 = Math.floor((y + r) / c);
    let best = -1, bd = r * r;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const a = this.map.get(this.key(i, j));
      if (!a) continue;
      for (const k of a) { const dx = this.xy[k * 2] - x, dy = this.xy[k * 2 + 1] - y, d = dx * dx + dy * dy; if (d <= bd) { bd = d; best = k; } }
    }
    return best < 0 ? null : [this.xy[best * 2], this.xy[best * 2 + 1]];
  }
}

export function squareAngle(xy, n, { cell = 400 } = {}) {
  // the cells' lines give the angle to a fraction of a degree; then the turn within ±1° (0.02° steps) at which the points
  // pile up most sharply along X and along Y (walls square to the axes: 10 mm bins, the sum of squared counts) refines it
  const first = angleOnce(xy, n, cell);
  if (!first) return null;
  let best = first.angle, bs = -1;
  for (let d = -1; d <= 1 + 1e-9; d += 0.02) {
    const sc = sharpness(xy, n, first.angle + d);
    if (sc > bs) { bs = sc; best = first.angle + d; }
  }
  return { angle: best, strength: first.strength };
}
function sharpness(xy, n, deg, bin = 10) {
  const a = -deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), hx = new Map(), hy = new Map();
  for (let i = 0; i < n; i++) {
    const x = xy[i * 2], y = xy[i * 2 + 1], kx = Math.floor((x * c - y * s) / bin), ky = Math.floor((x * s + y * c) / bin);
    hx.set(kx, (hx.get(kx) || 0) + 1); hy.set(ky, (hy.get(ky) || 0) + 1);
  }
  let sum = 0;
  for (const v of hx.values()) sum += v * v;
  for (const v of hy.values()) sum += v * v;
  return sum;
}
function angleOnce(xy, n, cell) {
  const cells = new Map();
  for (let i = 0; i < n; i++) {
    const k = Math.floor(xy[i * 2] / cell) + ',' + Math.floor(xy[i * 2 + 1] / cell);
    let s = cells.get(k); if (!s) { s = { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 }; cells.set(k, s); }
    const x = xy[i * 2], y = xy[i * 2 + 1];
    s.n++; s.sx += x; s.sy += y; s.sxx += x * x; s.syy += y * y; s.sxy += x * y;
  }
  const bins = new Float64Array(180);   // 0.5° bins over 90°
  const votes = [];   // [angle 0…90, weight] of each line-like cell
  let total = 0;
  for (const s of cells.values()) {
    if (s.n < 8) continue;
    const mx = s.sx / s.n, my = s.sy / s.n;
    const cxx = s.sxx / s.n - mx * mx, cyy = s.syy / s.n - my * my, cxy = s.sxy / s.n - mx * my;
    const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    if (!(l1 > 0) || l2 > l1 * 0.05) continue;   // not a line (a corner, clutter)
    let a = Math.atan2(l1 - cxx, cxy) * 180 / Math.PI;   // the principal axis
    if (Math.abs(cxy) < 1e-12) a = cxx >= cyy ? 0 : 90;
    a = ((a % 90) + 90) % 90;   // folded: walls square to each other vote together
    bins[Math.min(179, Math.floor(a * 2))] += s.n;
    votes.push([a, s.n]);
    total += s.n;
  }
  if (!total) return null;
  // the strongest bin, smoothed over its neighbours (wrapping at 90°)
  let best = 0, bw = -1;
  for (let i = 0; i < 180; i++) { const w = bins[(i + 179) % 180] + 2 * bins[i] + bins[(i + 1) % 180]; if (w > bw) { bw = w; best = i; } }
  const wA = bins[(best + 179) % 180], wB = bins[best], wC = bins[(best + 1) % 180];
  // refined: the weighted mean of the votes within 1.5° of the peak (taken round it, so 89.9° and 0.1° average to 0)
  const peak = (best + 0.5) / 2;
  let sw = 0, sa = 0;
  for (const [a, wt] of votes) { let d = a - peak; if (d > 45) d -= 90; if (d < -45) d += 90; if (Math.abs(d) <= 1.5) { sw += wt; sa += wt * d; } }
  let angle = peak + (sw ? sa / sw : 0);
  if (angle > 45) angle -= 90;
  if (angle <= -45) angle += 90;
  return { angle, strength: (wA + wB + wC) / total };
}

export function floorZ(pos, n, M, { step = 20 } = {}) {
  if (!n) return null;
  const m = M, zs = new Float64Array(n);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]; const pz = m[2] * x + m[6] * y + m[10] * z + m[14]; zs[i] = pz; if (pz < lo) lo = pz; if (pz > hi) hi = pz; }
  const top = lo + (hi - lo) / 3, nb = Math.max(1, Math.ceil((top - lo) / step) + 1), bins = new Uint32Array(nb);
  for (let i = 0; i < n; i++) if (zs[i] <= top) bins[Math.min(nb - 1, Math.floor((zs[i] - lo) / step))]++;
  let b = 0; for (let i = 1; i < nb; i++) if (bins[i] > bins[b]) b = i;
  // the band's own points: their middle height
  let s = 0, c = 0;
  for (let i = 0; i < n; i++) { const k = Math.floor((zs[i] - lo) / step); if (k === b) { s += zs[i]; c++; } }
  return c ? s / c : null;
}

export const rotZ = (deg, about = [0, 0]) => {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), [x, y] = about;
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, x - c * x + s * y, y - s * x - c * y, 0, 1];
};
export const moveZ = (dz) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, dz, 1];
export const planAdjust = (A, Mvp) => mul4(inv4(Mvp), mul4(A, Mvp));
export { apply4 };
