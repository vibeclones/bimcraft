/* SPDX-License-Identifier: Apache-2.0 */
/**
 * looks.js — the render's settings, material looks, skies and the small maths the renderer needs. No DOM, no three.js,
 * no imports, so Node tests it as is. Part of the shared renderer (0.5 RC.11): canonical in modelcraft/dev/render/,
 * byte-identical copy in bimcraft/dev/render/ (node tools/render/sync.mjs [--check]); never edit the copy.
 *
 *   DEFAULTS, MODES, MINUTES, QUALITY, SIZES, SKIES, LOOKS, LOOK_KEYS
 *   cleanSettings(obj) → settings      (untrusted: a file or localStorage; unknown keys dropped, values clamped)
 *   lookFor(key, settings, fallbackColor, ownLook) → {color, rough, metal, glass, look}   (ownLook: the file's own, e.g. IFC glass)
 *   sizeFor(settings, viewW, viewH) → {w, h}   (≤ MAX_SIDE on each side, view aspect kept for view sizes)
 *   halton(i, base)                    the low-discrepancy sequence every pass jitters by (same model → same image)
 *   farPlane(proj, far) → proj         a projection with its far plane pushed out (perspective or parallel)
 *   basis(up) → {up, e1, e2}           two unit vectors square to `up` (sky samples, the ground plane)
 *   hemisphere(i, up) → dir            cosine-weighted direction over the sky for pass i (kept off the horizon)
 *   sunDisc(dir, i, degrees) → dir     a direction inside the sun's small cone for pass i (soft shadow edges)
 *   colorKey(c) → '#rrggbb' | null     a colour as the looks table keys it
 *   NIGHT, LIGHT_SCALE, SHADOW_LAMPS, lampCandela(L), lampAt(L, i)   lamps and the night (RC.11 (d))
 */

export const MAX_SIDE = 4096;

/** Passes per render: each pass jitters the camera, the sun and one sky light, and the image is their average. */
export const QUALITY = { draft: 16, good: 64, best: 256 };

/** Image sizes: the view's own size (×1, ×2) or a fixed size (the view is framed to its aspect). */
export const SIZES = {
  view: { scale: 1 }, view2: { scale: 2 },
  hd: { w: 1920, h: 1080 }, uhd: { w: 3840, h: 2160 }, square: { w: 2048, h: 2048 },
};

/**
 * Skies: the gradient dome (image light and background) and the two lights every pass samples. `sun` and `sky` are the
 * intensities of the sun and the sampled sky light; `env` the dome's image light; `tint` the sun's colour.
 */
export const SKIES = {
  clear: { zenith: '#2f6cb3', horizon: '#c4d6e8', ground: '#8f8a80', sun: 3.2, sky: 1.6, env: 0.45, tint: '#fff4e5', skyTint: '#dfeaff' },
  overcast: { zenith: '#b9c0c8', horizon: '#dfe2e5', ground: '#8a8781', sun: 0.35, sky: 3.0, env: 0.8, tint: '#f4f2ee', skyTint: '#eef0f3' },
  dusk: { zenith: '#3d4f78', horizon: '#e9b48a', ground: '#5d5650', sun: 2.2, sky: 0.9, env: 0.35, tint: '#ffb877', skyTint: '#b9c4e6' },
  white: { zenith: '#ffffff', horizon: '#ffffff', ground: '#f2f2f2', sun: 2.6, sky: 2.0, env: 0.7, tint: '#fffaf2', skyTint: '#f4f7ff', plain: true },
};
/** The sky when the sun is down (any sky but the white studio): a dark blue night, lit faintly; lamps do the rest. */
export const NIGHT = { zenith: '#070b16', horizon: '#18202f', ground: '#0c0d0f', sun: 0, sky: 0.05, env: 0.06, tint: '#ffffff', skyTint: '#8fa3c8' };
/**
 * Lamps (0.5 RC.11 (d)): lumens → three.js candela (point, spot: Φ/4π; an area light, a Lambertian panel: Φ/π), times
 * LIGHT_SCALE, the scene's own scale (the sun is 3.2 here, not 100 000 lux) so an 800 lm bulb lights a room at night with the
 * brightness at 0. The SHADOW_LAMPS brightest lamps cast shadows; the rest light without (each shadow costs passes).
 */
export const LIGHT_SCALE = 0.02;
export const SHADOW_LAMPS = 4;
export function lampCandela(L) { return (L.kind === 'area' ? L.lumens / Math.PI : L.lumens / (4 * Math.PI)) * LIGHT_SCALE; }
/** Where pass i puts a lamp: a point inside its bulb (point, spot) or on its panel (area), so shadows come out soft. */
export function lampAt(L, i) {
  const a = halton(i + 1, 17), b = halton(i + 1, 19);
  if (L.kind === 'area') {
    const { e1, e2 } = basis(L.dir), w = L.size[0], h = L.size[1];
    return [0, 1, 2].map((k) => L.p[k] + e1[k] * (a - 0.5) * w + e2[k] * (b - 0.5) * h);
  }
  const r = (L.size ? L.size[0] : 0.06) / 2, z = 2 * a - 1, ph = 2 * Math.PI * b, s = Math.sqrt(Math.max(0, 1 - z * z)), c = halton(i + 1, 23) ** (1 / 3);
  return [L.p[0] + r * c * s * Math.cos(ph), L.p[1] + r * c * s * Math.sin(ph), L.p[2] + r * c * z];
}

/**
 * Material looks a colour can take. rough 0 = mirror-smooth … 1 = chalk; metal 0 | 1; glass = how much light passes
 * (0 opaque … 1 clear). The raster render shows glass as see-through with sky reflections; light bending through it and
 * mirrors reflecting the model need the high-quality mode.
 */
export const LOOKS = {
  matte: { rough: 0.78, metal: 0, glass: 0 },
  satin: { rough: 0.5, metal: 0, glass: 0 },
  glossy: { rough: 0.18, metal: 0, glass: 0 },
  metal: { rough: 0.32, metal: 1, glass: 0 },
  chrome: { rough: 0.04, metal: 1, glass: 0 },
  glass: { rough: 0.04, metal: 0, glass: 0.82 },
  frosted: { rough: 0.45, metal: 0, glass: 0.55 },
};
export const LOOK_KEYS = Object.keys(LOOKS);

/** Fast = the raster render (render-core.js); High quality = path traced (render-pt.js, RC.11 (c)), with a time limit. */
export const MODES = ['fast', 'hq'];
export const MINUTES = [0, 1, 5, 15, 60];   // 0 = no limit

export const DEFAULTS = Object.freeze({
  mode: 'fast', minutes: 5,
  size: 'view2', quality: 'good', sky: 'clear', exposure: 0, edges: false, ground: true,
  sun: null,          // null = the model's own sun (its place, date and time); else {month, day, hour} for this render
  looks: {},          // '#rrggbb' | 'default' → a LOOK_KEYS name
});

const HEX = /^#[0-9a-f]{6}$/;
export function colorKey(c) {
  if (typeof c !== 'string') return null;
  let s = c.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  return HEX.test(s) ? s : null;
}

const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const pick = (v, table, d) => (typeof v === 'string' && Object.prototype.hasOwnProperty.call(table, v) ? v : d);

/** Settings from anything (a file, localStorage): a fresh object with only known keys and sane values. */
export function cleanSettings(obj) {
  const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  const s = {
    mode: MODES.includes(o.mode) ? o.mode : DEFAULTS.mode,
    minutes: MINUTES.includes(o.minutes) ? o.minutes : DEFAULTS.minutes,
    size: pick(o.size, SIZES, DEFAULTS.size),
    quality: pick(o.quality, QUALITY, DEFAULTS.quality),
    sky: pick(o.sky, SKIES, DEFAULTS.sky),
    exposure: Math.round(num(o.exposure, -3, 3, 0) * 10) / 10,
    edges: o.edges === true,
    ground: o.ground !== false,
    sun: null,
    looks: {},
  };
  if (o.sun && typeof o.sun === 'object') {
    const m = Math.round(num(o.sun.month, 1, 12, NaN)), d = Math.round(num(o.sun.day, 1, 31, NaN)), h = num(o.sun.hour, 0, 24, NaN);
    if (Number.isFinite(m) && Number.isFinite(d) && Number.isFinite(h)) s.sun = { month: m, day: Math.min(d, [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]), hour: Math.round(h * 4) / 4 };
  }
  if (o.looks && typeof o.looks === 'object' && !Array.isArray(o.looks)) {
    let n = 0;
    for (const [k, v] of Object.entries(o.looks)) {
      const key = k === 'default' ? k : colorKey(k);
      if (!key || !LOOK_KEYS.includes(v)) continue;
      s.looks[key] = v;
      if (++n >= 512) break;
    }
  }
  return s;
}

/** The material for a colour: its chosen look (settings.looks), else its own (the adapter's), else matte. `key` is '#rrggbb' or 'default'. */
export function lookFor(key, settings, fallbackColor = '#e6e3dc', ownLook = null) {
  const look = (settings && settings.looks && settings.looks[key]) || (LOOKS[ownLook] ? ownLook : 'matte');
  const L = LOOKS[look] || LOOKS.matte;
  return { color: colorKey(key) || colorKey(fallbackColor) || '#e6e3dc', rough: L.rough, metal: L.metal, glass: L.glass, look };
}

export function sizeFor(settings, viewW, viewH) {
  const z = SIZES[settings?.size] || SIZES[DEFAULTS.size];
  let w, h;
  if (z.scale) { w = Math.round(Math.max(1, viewW) * z.scale); h = Math.round(Math.max(1, viewH) * z.scale); } else { w = z.w; h = z.h; }
  const k = Math.min(1, MAX_SIDE / w, MAX_SIDE / h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

export function halton(i, b) {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
}

/**
 * Push the far plane out (so the ground reaches the horizon) without moving the near plane. Column-major OpenGL
 * matrices as three.js and ModelCraft's Camera build them: perspective has [11] = -1, parallel has [15] = 1.
 */
export function farPlane(proj, far) {
  const e = proj.slice();
  if (e[15] === 1 && e[11] === 0) {
    // parallel: [10] = -2/(f-n), [14] = -(f+n)/(f-n)
    const fn = -2 / e[10], sum = -e[14] * fn, n = (sum - fn) / 2, f = Math.max(far, n + fn);
    e[10] = -2 / (f - n); e[14] = -(f + n) / (f - n);
    return e;
  }
  // perspective: [10] = (f+n)/(n-f), [14] = 2fn/(n-f)  →  n = e14/(e10-1)
  const n = e[14] / (e[10] - 1), f0 = e[14] / (e[10] + 1), f = Math.max(far, f0);
  e[10] = (f + n) / (n - f); e[14] = (2 * f * n) / (n - f);
  return e;
}

const vnorm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function basis(up) {
  const u = vnorm(up);
  const ax = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1 = vnorm(vcross(u, ax)), e2 = vcross(u, e1);
  return { up: u, e1, e2 };
}

/** Pass i's sky light: cosine-weighted over the hemisphere around `up`, at least ~10° above the horizon. */
export function hemisphere(i, up) {
  const { up: u, e1, e2 } = basis(up);
  const r = Math.sqrt(Math.min(0.97, halton(i + 1, 11))), a = 2 * Math.PI * halton(i + 1, 13), z = Math.sqrt(1 - r * r);
  const x = r * Math.cos(a), y = r * Math.sin(a);
  return vnorm([e1[0] * x + e2[0] * y + u[0] * z, e1[1] * x + e2[1] * y + u[1] * z, e1[2] * x + e2[2] * y + u[2] * z]);
}

/** Pass i's sun: a point in a disc of `degrees` around the sun's direction (the sun is ~0.5° across; wider = softer). */
export function sunDisc(dir, i, degrees = 1.5) {
  const { up: d, e1, e2 } = basis(dir);
  const r = Math.sqrt(halton(i + 1, 5)) * Math.tan((degrees * Math.PI) / 180), a = 2 * Math.PI * halton(i + 1, 7);
  const x = r * Math.cos(a), y = r * Math.sin(a);
  return vnorm([d[0] + e1[0] * x + e2[0] * y, d[1] + e1[1] * x + e2[1] * y, d[2] + e1[2] * x + e2[2] * y]);
}
