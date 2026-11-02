/* SPDX-License-Identifier: Apache-2.0 */
/**
 * textures.js — the material library's textures, drawn by code (0.5 RC.11 (b)). No DOM, no imports: Node tests it, the page
 * turns its pixels into three.js textures. Every texture is made here from numbers (seeded noise and simple geometry), so the
 * library is entirely our own work: CC0 (CREDITS: CadCraft). The same id and size always give the same pixels.
 *
 *   makeTexture(spec, size = 256) → {w, h, albedo: Uint8ClampedArray RGBA, height: Float32Array 0…1 (for bump), rough: Float32Array}
 *                                    (w = size; h follows the tile's real shape `spec.size` [width, height] in metres)
 *   GENERATORS  {brick, planks, siding, shingles, stone, tile, concrete, block, grass, stucco, seam, gravel}
 *
 * Every texture tiles: noise wraps at the edge and patterns repeat a whole number of times. `spec` = a material's `tex`
 * ({kind, …options}, materials.js); colours are '#rrggbb'.
 */

// ---- seeded randomness and tileable noise ----
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash2 = (x, y, s) => { let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const fade = (t) => t * t * (3 - 2 * t);
const mod = (a, n) => ((a % n) + n) % n;
/** Value noise at (x, y) in cells, wrapping every `px` cells across and `py` up (so it tiles). */
function vnoise(x, y, px, seed, py = px) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = fade(x - x0), fy = fade(y - y0);
  const a = hash2(mod(x0, px), mod(y0, py), seed), b = hash2(mod(x0 + 1, px), mod(y0, py), seed);
  const c = hash2(mod(x0, px), mod(y0 + 1, py), seed), d = hash2(mod(x0 + 1, px), mod(y0 + 1, py), seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
/** Fractal noise over the unit square (u, v in 0…1), tiling; `base` cells across at the first octave. 0…1. */
export function fbm(u, v, base, octaves, seed, gain = 0.5) {
  let s = 0, amp = 1, norm = 0, f = base;
  for (let o = 0; o < octaves; o++) { s += amp * vnoise(u * f, v * f, f, seed + o * 101); norm += amp; amp *= gain; f *= 2; }
  return s / norm;
}
/** Stretched fractal noise: `bu` cells across, `bv` up at the first octave (whole numbers, so it still tiles). Wood grain. */
export function fbm2(u, v, bu, bv, octaves, seed, gain = 0.5) {
  let s = 0, amp = 1, norm = 0, fu = bu, fv = bv;
  for (let o = 0; o < octaves; o++) { s += amp * vnoise(u * fu, v * fv, fu, seed + o * 101, fv); norm += amp; amp *= gain; fu *= 2; fv *= 2; }
  return s / norm;
}

const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

/** A canvas of size × size(×aspect): fill(u, v) → [rgb (0…255), height 0…1, roughness 0…1]. */
function paint(size, aspect, fill) {
  const w = size, h = Math.max(4, Math.round(size * aspect));
  const albedo = new Uint8ClampedArray(w * h * 4), height = new Float32Array(w * h), rough = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w, i = y * w + x;
      const [c, ht, r] = fill(u, v);
      albedo[i * 4] = c[0]; albedo[i * 4 + 1] = c[1]; albedo[i * 4 + 2] = c[2]; albedo[i * 4 + 3] = 255;
      height[i] = clamp01(ht); rough[i] = clamp01(r);
    }
  }
  return { w, h, albedo, height, rough };
}

// ---- the generators: (spec, size, seed) → texture. v runs up the surface (courses, slope). ----

/** Bricks in running bond: `cols` bricks across, `rows` courses up, mortar `joint` metres thick (the tile's real size, `size`). */
function brick(s, size, seed) {
  const cols = s.cols || 4, rows = s.rows || 8, [W, H] = s.size || [0.9, 0.6], m = s.joint ?? 0.01;
  const ju = (m * cols) / W, jv = (m * rows) / H;   // the joint as a fraction of one brick's width / height
  const base = hex(s.color), mortar = hex(s.mortar || '#b9b2a6'), R = rng(seed);
  const tint = Array.from({ length: cols * rows }, () => 0.82 + R() * 0.3);
  return paint(size, s.aspect ?? 1, (u, v) => {
    const row = Math.floor(v * rows), fv = v * rows - row;
    const cu = u * cols + (row % 2) * 0.5, col = Math.floor(cu), fu = cu - col;
    const n = fbm(u, v, 16, 4, seed);
    if (fv < jv / 2 || fv > 1 - jv / 2 || fu < ju / 2 || fu > 1 - ju / 2) { const k = 0.9 + n * 0.2; return [shade(mortar, k), 0.15 + n * 0.1, 0.95]; }
    const k = tint[row * cols + mod(col, cols)] * (0.88 + n * 0.24);
    const speck = fbm(u, v, 64, 2, seed + 7) > 0.72 ? 0.8 : 1;
    return [shade(base, k * speck), 0.75 + n * 0.25, 0.85];
  });
}

/** Wood planks running along u: `boards` boards up the tile, butt joints staggered, grain along the board. */
function planks(s, size, seed) {
  const boards = s.boards || 6, base = hex(s.color), dark = hex(s.dark || '#000000'), R = rng(seed);
  const tone = Array.from({ length: boards * 3 }, () => 0.8 + R() * 0.35), cut = Array.from({ length: boards }, () => R());
  return paint(size, s.aspect ?? 1, (u, v) => {
    const b = Math.floor(v * boards), fv = v * boards - b;
    const seg = Math.floor(mod(u + cut[b], 1) * 2), fu = mod(u + cut[b], 1) * 2 - seg;
    const gap = fv < 0.035 || fv > 0.965 || fu < 0.004 || fu > 0.996;
    const grain = fbm2(u, v, 2, 32, 3, seed + b * 13);
    const rings = 0.5 + 0.5 * Math.sin((v * boards * 14 + grain * 9 + b * 3.1) * Math.PI);
    const k = tone[b * 3 + seg] * (0.85 + 0.25 * rings * (s.figure ?? 0.6));
    const c = mix(shade(base, k), dark, (1 - rings) * 0.18 * (s.figure ?? 0.6));
    if (gap) return [shade(c, 0.45), 0.1, 0.9];
    return [c, 0.6 + 0.2 * rings, (s.rough ?? 0.6) + grain * 0.1];
  });
}

/** Lap siding: horizontal boards up the tile, each with a shadow line at its bottom edge. */
function siding(s, size, seed) {
  const boards = s.boards || 8, base = hex(s.color);
  return paint(size, s.aspect ?? 1, (u, v) => {
    const b = Math.floor(v * boards), fv = v * boards - b;
    const n = fbm(u, v, 24, 3, seed);
    const grain = s.grain ? fbm2(u, v, 2, 48, 2, seed + 3) : 0.5;
    if (fv < 0.07) return [shade(base, 0.55 + fv * 3), 0.05 + fv, 0.8];   // the overlap's shadow
    return [shade(base, 0.92 + n * 0.1 + (grain - 0.5) * 0.12), 0.3 + fv * 0.6, s.rough ?? 0.55];
  });
}

/** Three-tab or wood shingles: courses up the tile, tabs staggered by half, dark keyways and per-tab colour. */
function shingles(s, size, seed) {
  const rows = s.rows || 8, tabs = s.tabs || 6, base = hex(s.color), R = rng(seed);
  const tone = Array.from({ length: rows * tabs * 2 }, () => 0.78 + R() * 0.4);
  return paint(size, s.aspect ?? 1, (u, v) => {
    const r = Math.floor(v * rows), fv = v * rows - r;
    const cu = u * tabs + (r % 2) * 0.5, t = Math.floor(cu), fu = cu - t;
    const grit = fbm(u, v, 48, 3, seed) * 0.35 + (hash2(Math.floor(u * size), Math.floor(v * size), seed) - 0.5) * 0.25;
    const k = tone[mod(r * tabs * 2 + mod(t, tabs * 2), tone.length)];
    if (fu < 0.03 || fu > 0.97) return [shade(base, 0.35), 0.05, 0.95];                  // keyway
    if (fv < 0.12) return [shade(base, 0.45 + fv * 2.5), 0.1 + fv * 3, 0.95];            // the course above's shadow
    return [shade(base, k * (0.85 + grit)), 0.55 + fv * 0.4 + grit * 0.2, 0.92];
  });
}

/** Stone: irregular cells (cobbles, fieldstone) or `ashlar` rectangles, with mortar between. */
function stone(s, size, seed) {
  const base = hex(s.color), mortar = hex(s.mortar || '#a9a39a'), R = rng(seed);
  if (s.ashlar) {
    const rows = s.rows || 5;
    const lens = Array.from({ length: rows }, () => { const a = []; let x = 0; while (x < 1) { const l = 0.18 + R() * 0.3; a.push(Math.min(1, x + l)); x += l; } a[a.length - 1] = 1; return a; });
    const tone = Array.from({ length: rows * 8 }, () => 0.8 + R() * 0.35);
    return paint(size, s.aspect ?? 1, (u, v) => {
      const r = Math.floor(v * rows), fv = v * rows - r, ends = lens[r];
      let i = 0; while (i < ends.length - 1 && u > ends[i]) i++;
      const start = i ? ends[i - 1] : 0, du = Math.min(u - start, ends[i] - u) * rows;
      const n = fbm(u, v, 12, 5, seed);
      if (fv < 0.05 || fv > 0.95 || du < 0.04) return [shade(mortar, 0.85 + n * 0.2), 0.1, 0.95];
      return [shade(base, tone[r * 8 + (i % 8)] * (0.8 + n * 0.35)), 0.7 + n * 0.3, 0.8];
    });
  }
  const cells = s.cells || 7, pts = [];
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) pts.push([(i + 0.15 + R() * 0.7) / cells, (j + 0.15 + R() * 0.7) / cells, 0.75 + R() * 0.4]);
  return paint(size, s.aspect ?? 1, (u, v) => {
    let d1 = 9, d2 = 9, k = 1;
    const ci = Math.floor(u * cells), cj = Math.floor(v * cells);
    for (let j = cj - 2; j <= cj + 2; j++) for (let i = ci - 2; i <= ci + 2; i++) {   // each point lies in its own cell
      const p = pts[mod(j, cells) * cells + mod(i, cells)];
      const dx = u - (p[0] + Math.floor(i / cells)), dy = v - (p[1] + Math.floor(j / cells));
      const d = Math.hypot(dx, dy);
      if (d < d1) { d2 = d1; d1 = d; k = p[2]; } else if (d < d2) d2 = d;
    }
    const edge = (d2 - d1) * cells, n = fbm(u, v, 10, 5, seed);
    if (edge < (s.joint ?? 0.12)) return [shade(mortar, 0.8 + n * 0.25), 0.05 + edge, 0.95];
    return [shade(base, k * (0.78 + n * 0.4)), 0.55 + Math.min(0.45, edge * 0.8) * (0.7 + n * 0.3), 0.85];
  });
}

/** Square tiles with grout; `tiles` across and up. */
function tile(s, size, seed) {
  const n0 = s.tiles || 4, base = hex(s.color), grout = hex(s.grout || '#cfcac2'), R = rng(seed);
  const tone = Array.from({ length: n0 * n0 }, () => 0.9 + R() * 0.16);
  return paint(size, s.aspect ?? 1, (u, v) => {
    const i = Math.floor(u * n0), j = Math.floor(v * n0), fu = u * n0 - i, fv = v * n0 - j, g = s.joint ?? 0.04;
    const n = fbm(u, v, 20, 3, seed);
    if (fu < g / 2 || fu > 1 - g / 2 || fv < g / 2 || fv > 1 - g / 2) return [shade(grout, 0.9 + n * 0.15), 0.1, 0.95];
    return [shade(base, tone[j * n0 + i] * (0.95 + n * 0.08)), 0.8, s.rough ?? 0.25];
  });
}

/** Concrete: soft cloudy tone, pores, optional form-tie holes on a grid. */
function concrete(s, size, seed) {
  const base = hex(s.color);
  return paint(size, s.aspect ?? 1, (u, v) => {
    const n = fbm(u, v, 4, 6, seed), p = hash2(Math.floor(u * size), Math.floor(v * size), seed + 1);
    let k = 0.86 + n * 0.26, h = 0.5 + n * 0.3;
    if (p > 0.993) { k *= 0.6; h = 0.2; }
    if (s.ties) { const du = mod(u * 2, 1) - 0.5, dv = mod(v * 2, 1) - 0.5; if (Math.hypot(du, dv) < 0.025) { k *= 0.45; h = 0.05; } }
    return [shade(base, k), h, 0.85];
  });
}

/** Concrete block (CMU) in running bond: 2 blocks across, 4 courses up a square tile. */
function block(s, size, seed) {
  return brick({ ...s, cols: s.cols || 2, rows: s.rows || 4, joint: s.joint ?? 0.05, mortar: s.mortar || '#9d9a94' }, size, seed);
}

/** Grass: blades as streaky noise in greens, with dry patches. */
function grass(s, size, seed) {
  const base = hex(s.color), dry = hex(s.dry || '#9c9a55');
  return paint(size, s.aspect ?? 1, (u, v) => {
    const blades = fbm2(u, v, 120, 32, 3, seed), patch = fbm(u, v, 3, 4, seed + 5), fine = hash2(Math.floor(u * size), Math.floor(v * size), seed);
    const c = mix(base, dry, clamp01((patch - 0.55) * 2.5) * 0.6);
    return [shade(c, 0.7 + blades * 0.45 + (fine - 0.5) * 0.18), blades, 0.95];
  });
}

/** Stucco / render: fine sand texture. */
function stucco(s, size, seed) {
  const base = hex(s.color);
  return paint(size, s.aspect ?? 1, (u, v) => {
    const n = fbm(u, v, 24, 4, seed), f = hash2(Math.floor(u * size), Math.floor(v * size), seed + 2);
    return [shade(base, 0.9 + n * 0.12 + (f - 0.5) * 0.08), n * 0.7 + f * 0.3, 0.92];
  });
}

/** Standing-seam metal: vertical panels (seams along v) with a faint sheen. */
function seam(s, size, seed) {
  const panels = s.panels || 4, base = hex(s.color);
  return paint(size, s.aspect ?? 1, (u, v) => {
    const fu = mod(u * panels, 1), n = fbm(u, v, 8, 3, seed);
    if (fu < 0.03) return [shade(base, 1.15), 1, 0.35];
    if (fu < 0.06) return [shade(base, 0.7), 0.4, 0.4];
    return [shade(base, 0.95 + n * 0.08), 0.5, 0.4];
  });
}

/** Gravel: small stones of mixed tone. */
function gravel(s, size, seed) {
  return stone({ ...s, cells: s.cells || 22, joint: 0.08, mortar: s.mortar || '#6f6a62' }, size, seed);
}

export const GENERATORS = { brick, planks, siding, shingles, stone, tile, concrete, block, grass, stucco, seam, gravel };

/** One material's texture. The seed comes from the spec (so two materials of one kind still differ). */
export function makeTexture(spec, size = 256) {
  const g = GENERATORS[spec && spec.kind];
  if (!g) throw new Error('unknown texture kind');   // i18n-ignore: a programming error, never shown
  const s = spec.size ? { ...spec, aspect: spec.size[1] / spec.size[0] } : spec;   // square pixels on the tile's real shape
  return g(s, Math.max(16, Math.min(1024, size | 0)), (spec.seed ?? 1) >>> 0);
}
