/* SPDX-License-Identifier: Apache-2.0 */
/**
 * three-mats.js — library materials as three.js textures and materials (0.5 RC.11 (b)). Shared by the renderer and the apps'
 * live 3D views (render/ is synced into BimCraft, tools/render/sync.mjs).
 *
 *   libTextures(id, size = 256) → {map, bump, w, h, size: [w, h] metres} | null   cached per (id, size); map is sRGB, bump
 *                                  carries the height in red and the roughness in green (three reads .r for bump, .g for
 *                                  roughness), both repeat. Callers never dispose them (they are shared): disposeLibTextures().
 *   libMaterial(id, {size, clipping, front, lambert, fog}) → THREE.Material   a new material using the cached textures; UVs
 *                                  in metres (materials.js planarUVs), so the textures repeat every `size` metres
 *   uvTransform(tex, sizeM)        set a texture's repeat so UVs in metres land on one copy per `sizeM`
 *   swatchPixels(id, px) → {w, h, data: Uint8ClampedArray}   a small square for a library button (the texture's corner)
 *   imageTexture({mime, data}, onLoad) → THREE.Texture           an imported image (base64) as a repeating texture; the
 *                                  pixels arrive when the browser has decoded it (onLoad then); UVs as SketchUp's (v up)
 *   imageTextureReady(im) → Promise<THREE.Texture>                the same, once decoded (the renderer waits for it)
 *   imageMaterial(texture, {lambert, front, clipping}) → THREE.Material
 */
import * as THREE from 'three';
import { material } from './materials.js';
import { makeTexture } from './textures.js';

const cache = new Map();

function dataTexture(data, w, h, srgb) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export function libTextures(id, size = 256) {
  const m = material(id);
  if (!m || !m.tex) return null;
  const key = id + '@' + size;
  let c = cache.get(key);
  if (c) return c;
  const t = makeTexture(m.tex, size);
  const br = new Uint8ClampedArray(t.w * t.h * 4);
  for (let i = 0; i < t.w * t.h; i++) { br[i * 4] = t.height[i] * 255; br[i * 4 + 1] = t.rough[i] * 255; br[i * 4 + 2] = 0; br[i * 4 + 3] = 255; }
  c = { map: dataTexture(t.albedo, t.w, t.h, true), bump: dataTexture(br, t.w, t.h, false), w: t.w, h: t.h, size: m.tex.size || [1, 1] };
  uvTransform(c.map, c.size); uvTransform(c.bump, c.size);
  cache.set(key, c);
  return c;
}

export function uvTransform(tex, sizeM) { tex.repeat.set(1 / sizeM[0], 1 / sizeM[1]); tex.needsUpdate = true; }

export function disposeLibTextures() { for (const c of cache.values()) { c.map.dispose(); c.bump.dispose(); } cache.clear(); }

export function libMaterial(id, { size = 256, clipping = [], front = false, lambert = false, fog = false } = {}) {
  const m = material(id);
  if (!m) return null;
  const tx = libTextures(id, size);
  const common = { side: front ? THREE.FrontSide : THREE.DoubleSide, fog, clippingPlanes: clipping, clipShadows: true };
  if (lambert) {
    // the live 3D views: Lambert like the rest of the view, the texture on a white base
    return new THREE.MeshLambertMaterial({ ...common, color: tx ? 0xffffff : m.color, map: tx ? tx.map : null, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  }
  if (m.glass > 0) {
    return new THREE.MeshPhysicalMaterial({ ...common, color: m.color, roughness: m.rough, metalness: m.metal, transparent: true, opacity: Math.max(0.08, 1 - m.glass), depthWrite: false, ior: 1.5, specularIntensity: 1, envMapIntensity: 1.4 });
  }
  return new THREE.MeshStandardMaterial({
    ...common, shadowSide: THREE.BackSide, metalness: m.metal,
    color: tx ? 0xffffff : m.color, map: tx ? tx.map : null,
    roughness: tx ? 1 : m.rough, roughnessMap: tx ? tx.bump : null,
    bumpMap: tx ? tx.bump : null, bumpScale: tx ? m.bump * 1.5 : 1,
  });
}

/** A swatch for the library's buttons: the texture's lower-left `px` × `px` (or the flat colour). */
export function swatchPixels(id, px = 48) {
  const m = material(id);
  if (!m) return null;
  const data = new Uint8ClampedArray(px * px * 4);
  if (!m.tex) {
    const c = [parseInt(m.color.slice(1, 3), 16), parseInt(m.color.slice(3, 5), 16), parseInt(m.color.slice(5, 7), 16)];
    for (let i = 0; i < px * px; i++) data.set([c[0], c[1], c[2], 255], i * 4);
    return { w: px, h: px, data };
  }
  const t = makeTexture(m.tex, 128);
  const k = Math.min(t.w, t.h) / px;
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    const sx = Math.min(t.w - 1, Math.floor(x * k)), sy = Math.min(t.h - 1, Math.floor((px - 1 - y) * k));   // rows from the top
    const i = (sy * t.w + sx) * 4;
    data.set([t.albedo[i], t.albedo[i + 1], t.albedo[i + 2], 255], (y * px + x) * 4);
  }
  return { w: px, h: px, data };
}

// ---- imported images (0.5 RC.11 (b): textures that came with SketchUp and glTF files) ----
export function imageTexture(im, onLoad) {
  const tex = new THREE.Texture();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const img = new Image();
  img.onload = () => { tex.image = img; tex.needsUpdate = true; onLoad?.(tex); };
  img.onerror = () => onLoad?.(null);
  img.src = 'data:' + im.mime + ';base64,' + im.data;
  return tex;
}
export function imageTextureReady(im) { return new Promise((res) => { const t = imageTexture(im, (ok) => res(ok ? t : null)); }); }
export function imageMaterial(tex, { lambert = false, front = false, clipping = [] } = {}) {
  const common = { side: front ? THREE.FrontSide : THREE.DoubleSide, fog: false, clippingPlanes: clipping, clipShadows: true, map: tex, color: 0xffffff };
  return lambert ? new THREE.MeshLambertMaterial({ ...common, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
    : new THREE.MeshStandardMaterial({ ...common, roughness: 0.7, metalness: 0, shadowSide: THREE.BackSide });
}

