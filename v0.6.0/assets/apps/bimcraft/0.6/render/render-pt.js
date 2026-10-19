/* SPDX-License-Identifier: Apache-2.0 */
/**
 * render-pt.js — Render a picture › High quality (0.5 RC.11 (c)): the same scene the fast render takes (render-core.js),
 * path traced by three-gpu-pathtracer (MIT, its own vendor folder: /assets/vendor/three-gpu-pathtracer/<version>/, with
 * three-mesh-bvh). Shared like the rest of render/ (canonical in modelcraft/dev, synced into bimcraft/dev). The library is
 * imported only when this mode runs.
 *
 *   pathTraceStill(scene, settings, {w, h, onProgress(frac, canvas), signal, seconds}) → Promise<{blob, w, h, passes, ms,
 *                                                                                                  stopped, budget}>
 *   bakeItems(items, planes) → items   every mesh as world-space triangles with the same attributes (position, normal, uv —
 *                                      zeros where a mesh has none: a mix of layouts turns the tracer's picture black), cut by
 *                                      the section planes on the CPU (the path tracer has no clipping planes)
 *
 * What it adds over the fast render: light bouncing between surfaces (rooms lit by a window, colour bleeding), real glass
 * (light bends through it), mirrors and metal reflecting the model, area lights as true areas. Progressive: one sample a
 * pass, `QUALITY[settings.quality]` samples or `seconds` (0 = no limit), whichever comes first; Stop keeps the picture.
 * Textures: colour and roughness maps; the bump maps of the fast render are left out here.
 */
import * as THREE from 'three';
import { QUALITY, SKIES, NIGHT, lookFor, farPlane, basis, lampCandela } from './looks.js';
import { material as libDef } from './materials.js';
import { libTextures, imageTextureReady } from './three-mats.js';

let PT = null;   // the library, once loaded
async function lib() { PT ||= await import('three-gpu-pathtracer'); return PT; }

/** Every mesh item baked to world space (drawRange and index applied), cut by the planes (keep n·p ≤ d); edges pass through. */
export function bakeItems(items, planes = []) {
  planes = planes || [];
  const out = [];
  const inside = (p, pl) => pl.n[0] * p[0] + pl.n[1] * p[1] + pl.n[2] * p[2] - pl.d;
  for (const it of items) {
    if (it.lines) { out.push(it); continue; }
    const g = it.geometry, P = g.getAttribute('position'), N = g.getAttribute('normal'), U = g.getAttribute('uv');
    const M = it.matrix ? new THREE.Matrix4().fromArray(it.matrix) : new THREE.Matrix4(), Nm = new THREE.Matrix3().getNormalMatrix(M);
    const idx = g.index ? g.index.array : null, start = g.drawRange.start || 0;
    const count = Math.min(idx ? idx.length : P.count, g.drawRange.count === Infinity ? Infinity : start + g.drawRange.count) - start;
    const v = new THREE.Vector3(), n = new THREE.Vector3();
    const vert = (i) => {
      v.fromBufferAttribute(P, i).applyMatrix4(M);
      n.fromBufferAttribute(N, i).applyMatrix3(Nm).normalize();
      return { p: v.toArray(), n: n.toArray(), uv: U ? [U.getX(i), U.getY(i)] : null };
    };
    const lerp = (a, b, f) => ({ p: a.p.map((x, k) => x + (b.p[k] - x) * f), n: a.n.map((x, k) => x + (b.n[k] - x) * f), uv: a.uv ? a.uv.map((x, k) => x + (b.uv[k] - x) * f) : null });
    const pos = [], nor = [], uv = [];
    for (let t = start; t + 2 < start + count; t += 3) {
      let poly = [0, 1, 2].map((k) => vert(idx ? idx[t + k] : t + k));
      for (const pl of planes) {
        const d = poly.map((q) => inside(q.p, pl));
        if (d.every((x) => x <= 0)) continue;
        const next = [];
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length], da = d[i], db = d[(i + 1) % poly.length];
          if (da <= 0) next.push(a);
          if ((da <= 0) !== (db <= 0)) next.push(lerp(a, b, da / (da - db)));
        }
        poly = next;
        if (poly.length < 3) break;
      }
      for (let i = 1; i + 1 < poly.length; i++) for (const q of [poly[0], poly[i], poly[i + 1]]) { pos.push(...q.p); nor.push(...q.n); uv.push(...(q.uv || [0, 0])); }
    }
    if (!pos.length) continue;
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    ng.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    ng.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    out.push({ ...it, geometry: ng, matrix: null, _own: true });
  }
  return out;
}

/** A material the path tracer understands: physical, glass as real transmission. */
function ptMaterial(key, settings, scene, imgTex) {
  const side = THREE.DoubleSide;
  if (key.startsWith('img:')) {
    const tex = imgTex.get(key);
    if (tex) return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, side });
  }
  if (key.startsWith('mat:')) {
    const m = libDef(key.slice(4));
    if (m) {
      const tx = libTextures(m.id, 512);
      if (m.glass > 0) return new THREE.MeshPhysicalMaterial({ color: m.color, roughness: m.rough, metalness: 0, transmission: m.glass, ior: 1.5, thickness: 0.01, side });
      return new THREE.MeshStandardMaterial({ color: tx ? 0xffffff : m.color, map: tx ? tx.map : null, roughness: tx ? 1 : m.rough, roughnessMap: tx ? tx.bump : null, metalness: m.metal, side });
    }
  }
  const L = lookFor(key, settings, scene.defaultColor, scene.looks && scene.looks[key]);
  if (L.glass > 0) return new THREE.MeshPhysicalMaterial({ color: L.color, roughness: L.rough, metalness: 0, transmission: L.glass, ior: 1.5, thickness: 0.01, side });
  return new THREE.MeshStandardMaterial({ color: L.color, roughness: L.rough, metalness: L.metal, side });
}

/** The camera the path tracer needs (a perspective or parallel three.js camera), from the app's matrices. */
function ptCamera(spec, far) {
  const P = farPlane(spec.proj, far);
  let cam;
  if (P[11] === -1) {
    const n = P[14] / (P[10] - 1), f = P[14] / (P[10] + 1);
    cam = new THREE.PerspectiveCamera((2 * Math.atan(1 / P[5]) * 180) / Math.PI, P[5] / P[0], n, f);
  } else {
    const fn = -2 / P[10], sum = -P[14] * fn, n = (sum - fn) / 2, hw = 1 / P[0], hh = 1 / P[5];
    cam = new THREE.OrthographicCamera(-hw, hw, hh, -hh, n, n + fn);
  }
  new THREE.Matrix4().fromArray(spec.world).decompose(cam.position, cam.quaternion, cam.scale);
  cam.updateMatrixWorld(true);
  return cam;
}

export async function pathTraceStill(scene, settings, { w, h, onProgress, signal, seconds = 0 } = {}) {
  const t0 = performance.now();
  const { WebGLPathTracer, ProceduralEquirectTexture, PhysicalSpotLight, ShapedAreaLight } = await lib();
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const target = QUALITY[settings.quality] || QUALITY.good;
  const sky0 = SKIES[settings.sky] || SKIES.clear, night = !sky0.plain && !scene.sun, sky = night ? NIGHT : sky0;
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = Math.pow(2, settings.exposure || 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const disposables = [];
  let pt = null, done = 0, stopped = false, budget = false;
  try {
    const up = basis(scene.up || [0, 0, 1]).up, bb = scene.bounds;
    const c = bb ? [0, 1, 2].map((k) => (bb.min[k] + bb.max[k]) / 2) : [0, 0, 0];
    const R = bb ? Math.max(Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) / 2, 0.5) : 5;
    const three = new THREE.Scene();
    // the model (section cuts made on the CPU), one material per look
    const imgTex = new Map();
    for (const it of scene.items) {
      if (!it.look || !it.look.startsWith('img:') || imgTex.has(it.look)) continue;
      const im = scene.images && scene.images[it.look.slice(4)];
      const tex = im ? await imageTextureReady(im) : null;
      imgTex.set(it.look, tex);
      if (tex) disposables.push(tex);
    }
    const mats = new Map();
    for (const it of bakeItems(scene.items, scene.clip)) {
      if (it.lines) continue;   // edges are a drawing's look: the high-quality picture is a photograph
      let m = mats.get(it.look || 'default');
      if (!m) { m = ptMaterial(it.look || 'default', settings, scene, imgTex); mats.set(it.look || 'default', m); disposables.push(m); }
      const o = new THREE.Mesh(it.geometry, m);
      if (it.matrix) { o.matrixAutoUpdate = false; o.matrix.fromArray(it.matrix); }
      if (it._own) disposables.push(it.geometry);
      three.add(o);
    }
    // the ground
    if (settings.ground) {
      const gm = new THREE.MeshStandardMaterial({ color: sky.plain ? '#f4f4f2' : '#cbc6bb', roughness: 1, metalness: 0 });
      const ground = new THREE.Mesh(new THREE.CircleGeometry(R * 60, 96), gm);
      ground.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...up));
      const lift = (c[0] * up[0] + c[1] * up[1] + c[2] * up[2]) - (scene.groundAt ?? 0) + R * 1e-4;
      ground.position.set(c[0] - up[0] * lift, c[1] - up[1] * lift, c[2] - up[2] * lift);
      three.add(ground);
      disposables.push(gm, ground.geometry);
    }
    // the sky: the fast render's gradient as an equirectangular environment (three's Y up, turned to the scene's up)
    const zen = new THREE.Color(sky.zenith), hor = new THREE.Color(sky.horizon), gnd = new THREE.Color(sky.ground);
    const env = new ProceduralEquirectTexture(512, 256);
    env.generationCallback = (polar, uv, coord, color) => {
      const z = Math.cos(polar.phi);
      if (z >= 0) color.copy(hor).lerp(zen, Math.pow(z, 0.6)); else color.copy(hor).lerp(gnd, Math.pow(-z, 0.4));
    };
    env.update();
    disposables.push(env);
    three.environment = env;
    three.background = env;
    three.environmentIntensity = sky.plain ? 1.2 : 1.0;
    if (Math.abs(up[1]) < 0.9) { three.environmentRotation.set(Math.PI / 2, 0, 0); three.backgroundRotation.set(Math.PI / 2, 0, 0); }   // Z up
    // the sun
    if (scene.sun && !night && sky.sun > 0 && (scene.sun[0] * up[0] + scene.sun[1] * up[1] + scene.sun[2] * up[2]) > 0.02) {
      const sun = new THREE.DirectionalLight(sky.tint, sky.sun);
      sun.position.set(c[0] + scene.sun[0] * R * 4, c[1] + scene.sun[1] * R * 4, c[2] + scene.sun[2] * R * 4);
      sun.target.position.set(...c);
      three.add(sun, sun.target);
    }
    // the lamps: true points, spots with a bulb, rectangles
    for (const L of (scene.lights || []).filter((x) => x && x.on !== false && x.lumens > 0).slice(0, 64)) {
      const col = new THREE.Color(L.color || '#ffe7c4'), I = lampCandela(L);
      let o;
      if (L.kind === 'point') { o = new THREE.PointLight(col, I, 0, 2); o.position.set(...L.p); }
      else if (L.kind === 'spot') {
        o = new PhysicalSpotLight(col, I, 0, (L.angle * Math.PI) / 360, 0.35, 2);
        o.radius = (L.size ? L.size[0] : 0.06) / 2;
        o.position.set(...L.p); o.target.position.set(L.p[0] + L.dir[0], L.p[1] + L.dir[1], L.p[2] + L.dir[2]);
        three.add(o.target);
      } else {
        o = new ShapedAreaLight(col, I / Math.max(1e-4, L.size[0] * L.size[1]), L.size[0], L.size[1]);
        o.position.set(...L.p); o.lookAt(L.p[0] + L.dir[0], L.p[1] + L.dir[1], L.p[2] + L.dir[2]);
      }
      three.add(o);
    }
    three.updateMatrixWorld(true);
    const cam = ptCamera(scene.camera(w / h), R * 200);

    pt = new WebGLPathTracer(renderer);
    pt.renderDelay = 0; pt.minSamples = 0; pt.fadeDuration = 0; pt.dynamicLowRes = false; pt.rasterizeScene = false;
    pt.tiles.set(2, 2); pt.bounces = 6; pt.transmissiveBounces = 10; pt.filterGlossyFactor = 0.5;
    // the BVH is built here, on the page's thread (setSceneAsync wants a BVH worker; a large model pauses the page a moment)
    pt.setScene(three, cam);
    await new Promise((r) => requestAnimationFrame(() => r()));
    const deadline = seconds > 0 ? t0 + seconds * 1000 : Infinity;
    let k = 0;
    const px = new Float32Array(4);
    while (pt.samples < target) {
      if (signal?.aborted) { stopped = true; break; }
      if (performance.now() > deadline) { budget = true; break; }
      pt.renderSample();
      // renderSample only queues the work: read one pixel back so the clock, Stop and the progress follow the real rendering
      try { renderer.readRenderTargetPixels(pt.target, 0, 0, 1, 1, px); } catch { /* a format that cannot be read: no wait */ }
      done = Math.floor(pt.samples);
      if (++k % 4 === 0) {
        onProgress?.(Math.min(1, pt.samples / target), canvas);
        await new Promise((r) => requestAnimationFrame(() => r()));
      }
    }
    done = Math.floor(pt.samples);
    if (!done && pt.samples <= 0) return { blob: null, w, h, passes: 0, ms: Math.round(performance.now() - t0), stopped: true, budget };
    onProgress?.(Math.min(1, pt.samples / target), canvas);
    const blob = await new Promise((res, rej) => canvas.toBlob((bl) => (bl ? res(bl) : rej(new Error('no image'))), 'image/png'));   // i18n-ignore: a media type; never shown
    return { blob, w, h, passes: done, ms: Math.round(performance.now() - t0), stopped, budget };
  } finally {
    pt?.dispose();
    for (const d of disposables) d?.dispose?.();
    renderer.dispose();
    renderer.forceContextLoss?.();
  }
}
