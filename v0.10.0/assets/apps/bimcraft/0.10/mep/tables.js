/* SPDX-License-Identifier: Apache-2.0 */
/**
 * tables.js — pipe and tube sizes from public standards (0.5 MQ.2). DOM-free. Dimensions are the standards' nominal figures
 * in inches; metric figures are the same pipe in millimetres (OD × 25.4, rounded as the standards' SI tables round them).
 *
 *   Steel pipe, ASME B36.10M (Welded and Seamless Wrought Steel Pipe): NPS 1/8–24, outside diameter, wall for Schedule 40 and
 *     80; DN by the standard's NPS ↔ DN pairs; plain-end weight w = 10.69 (D − t) t lb/ft  (SI: 0.0246615 (D − t) t kg/m).
 *   Copper water tube, ASTM B88 (Seamless Copper Water Tube): 1/4–4, outside diameter = nominal + 1/8 in, wall for types K, L, M.
 *   PVC pipe, ASTM D1785 (PVC Plastic Pipe, Schedules 40, 80 and 120): NPS 1/2–12, the steel pipe outside diameters, minimum
 *     wall for Schedule 40 and 80.
 *   PEX tubing, ASTM F876 (Crosslinked Polyethylene Tubing), copper tube sizes, SDR 9: outside diameter = nominal + 1/8 in,
 *     wall = OD / 9 but at least 0.070 in.
 *   Long-radius elbows, ASME B16.9 (Factory-Made Wrought Buttwelding Fittings): the 90° elbow's center-to-end A, which is its
 *     bend radius (1.5 × NPS from NPS 3/4 up). Used to draw steel elbows; other materials' bends are drawn at one OD (a drawing
 *     choice, not a fitting dimension).
 *   Minimum slope of horizontal drainage piping, International Plumbing Code (2021) Table 704.1: 2-1/2 in and smaller 1/4 in
 *     per foot (2 %), 3 to 6 in 1/8 in per foot (1 %), 8 in and larger 1/16 in per foot (0.5 %).
 */

// NPS: [OD in, Sch 40 wall, Sch 80 wall, DN]  — ASME B36.10M
export const STEEL = {
  '1/8': [0.405, 0.068, 0.095, 6], '1/4': [0.54, 0.088, 0.119, 8], '3/8': [0.675, 0.091, 0.126, 10], '1/2': [0.84, 0.109, 0.147, 15],
  '3/4': [1.05, 0.113, 0.154, 20], '1': [1.315, 0.133, 0.179, 25], '1-1/4': [1.66, 0.14, 0.191, 32], '1-1/2': [1.9, 0.145, 0.2, 40],
  '2': [2.375, 0.154, 0.218, 50], '2-1/2': [2.875, 0.203, 0.276, 65], '3': [3.5, 0.216, 0.3, 80], '3-1/2': [4, 0.226, 0.318, 90],
  '4': [4.5, 0.237, 0.337, 100], '5': [5.563, 0.258, 0.375, 125], '6': [6.625, 0.28, 0.432, 150], '8': [8.625, 0.322, 0.5, 200],
  '10': [10.75, 0.365, 0.594, 250], '12': [12.75, 0.406, 0.688, 300], '14': [14, 0.438, 0.75, 350], '16': [16, 0.5, 0.844, 400],
  '18': [18, 0.562, 0.938, 450], '20': [20, 0.594, 1.031, 500], '24': [24, 0.688, 1.219, 600],
};
// nominal: [OD in, K, L, M]  — ASTM B88 (M is not made in every size)
export const COPPER = {
  '1/4': [0.375, 0.035, 0.03, null], '3/8': [0.5, 0.049, 0.035, 0.025], '1/2': [0.625, 0.049, 0.04, 0.028], '5/8': [0.75, 0.049, 0.042, null],
  '3/4': [0.875, 0.065, 0.045, 0.032], '1': [1.125, 0.065, 0.05, 0.035], '1-1/4': [1.375, 0.065, 0.055, 0.042], '1-1/2': [1.625, 0.072, 0.06, 0.049],
  '2': [2.125, 0.083, 0.07, 0.058], '2-1/2': [2.625, 0.095, 0.08, 0.065], '3': [3.125, 0.109, 0.09, 0.072], '3-1/2': [3.625, 0.12, 0.1, 0.083],
  '4': [4.125, 0.134, 0.11, 0.095],
};
// NPS: [Sch 40 min wall, Sch 80 min wall]  — ASTM D1785 (outside diameters as STEEL)
export const PVC = {
  '1/2': [0.109, 0.147], '3/4': [0.113, 0.154], '1': [0.133, 0.179], '1-1/4': [0.14, 0.191], '1-1/2': [0.145, 0.2], '2': [0.154, 0.218],
  '2-1/2': [0.203, 0.276], '3': [0.216, 0.3], '3-1/2': [0.226, 0.318], '4': [0.237, 0.337], '5': [0.258, 0.375], '6': [0.28, 0.432],
  '8': [0.322, 0.5], '10': [0.365, 0.593], '12': [0.406, 0.687],
};
export const PEX_SIZES = ['3/8', '1/2', '3/4', '1', '1-1/4', '1-1/2', '2'];   // ASTM F876, copper tube sizes, SDR 9
// NPS: 90° long-radius elbow center-to-end A, in  — ASME B16.9
export const LR90 = {
  '1/2': 1.5, '3/4': 1.12, '1': 1.5, '1-1/4': 1.88, '1-1/2': 2.25, '2': 3, '2-1/2': 3.75, '3': 4.5, '3-1/2': 5.25, '4': 6, '5': 7.5,
  '6': 9, '8': 12, '10': 15, '12': 18, '14': 21, '16': 24, '18': 27, '20': 30, '24': 36,
};
// the usual NPS ↔ DN pairing, for copper and PEX named in a metric drawing
const DN = { '1/8': 6, '1/4': 8, '3/8': 10, '1/2': 15, '5/8': 18, '3/4': 20, '1': 25, '1-1/4': 32, '1-1/2': 40, '2': 50, '2-1/2': 65, '3': 80, '3-1/2': 90, '4': 100 };

export const MATERIALS = ['steel', 'copper', 'pvc', 'pex'];
export const CLASSES = { steel: ['40', '80'], copper: ['K', 'L', 'M'], pvc: ['40', '80'], pex: ['SDR9'] };
export const DEFAULT_CLASS = { steel: '40', copper: 'L', pvc: '40', pex: 'SDR9' };

/** The sizes made in a material and class, smallest first. */
export function sizesFor(mat, cls) {
  if (mat === 'steel') return Object.keys(STEEL);
  if (mat === 'pvc') return Object.keys(PVC);
  if (mat === 'pex') return PEX_SIZES.slice();
  if (mat === 'copper') { const i = CLASSES.copper.indexOf(cls) + 1; return Object.keys(COPPER).filter((k) => i > 0 && COPPER[k][i] !== null); }
  return [];
}

/** Inches of a size name: "1-1/4" → 1.25, "3/8" → 0.375, "2" → 2. */
export function nominal(size) {
  const m = /^(\d+)(?:-(\d+)\/(\d+))?$|^(\d+)\/(\d+)$/.exec(String(size));
  if (!m) return NaN;
  if (m[4]) return Number(m[4]) / Number(m[5]);
  return Number(m[1]) + (m[2] ? Number(m[2]) / Number(m[3]) : 0);
}

/**
 * One size: { mat, cls, size, od, wall, id (inches), dn, nps (inches) } — or null when that size is not made in that class.
 */
export function pipeSize(mat, cls, size) {
  size = String(size);
  let od, wall;
  if (mat === 'steel') { const r = STEEL[size]; if (!r) return null; od = r[0]; wall = cls === '80' ? r[2] : cls === '40' ? r[1] : NaN; }
  else if (mat === 'pvc') { const r = PVC[size], s = STEEL[size]; if (!r || !s) return null; od = s[0]; wall = cls === '80' ? r[1] : cls === '40' ? r[0] : NaN; }
  else if (mat === 'copper') { const r = COPPER[size], i = CLASSES.copper.indexOf(cls) + 1; if (!r || i < 1 || r[i] === null) return null; od = r[0]; wall = r[i]; }
  else if (mat === 'pex') { if (!PEX_SIZES.includes(size) || cls !== 'SDR9') return null; od = nominal(size) + 0.125; wall = Math.max(od / 9, 0.07); }
  else return null;
  if (!Number.isFinite(wall)) return null;
  return { mat, cls, size, od, wall, id: od - 2 * wall, dn: mat === 'steel' ? STEEL[size][3] : DN[size] ?? null, nps: nominal(size) };
}

/** Plain-end weight of steel pipe (ASME B36.10M): lb/ft from inches, or kg/m from millimetres. */
export const steelWeightLbFt = (od, t) => 10.69 * (od - t) * t;
export const steelWeightKgM = (odMm, tMm) => 0.0246615 * (odMm - tMm) * tMm;

/** The centerline bend radius a run's elbows are drawn with, in inches: ASME B16.9 long radius for steel, else one OD. */
export function bendRadius(p) {
  if (p.mat === 'steel' && LR90[p.size]) return LR90[p.size];
  return p.od;
}

/** The smallest slope the International Plumbing Code (Table 704.1) allows a horizontal drain of this size (rise per run). */
export function minDrainSlope(nps) {
  if (!(nps > 0)) return null;
  if (nps <= 2.5) return 0.25 / 12;
  if (nps <= 6) return 0.125 / 12;
  return 0.0625 / 12;
}
