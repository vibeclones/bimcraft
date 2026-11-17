/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pointcloud-three.js — a point cloud (pointcloud.js) drawn with three.js, for BimCraft's IFC view and CadCraft's 3D tab
 * (0.5 SG.1). Canonical in bimcraft/dev; CadCraft carries a byte-identical copy (tools/pointcloud/sync.mjs). Imported only
 * when a cloud is opened.
 *
 *   const layer = new CloudLayer({ renderer, camera: () => cam, parent, render: () => …, patch: (mat) => mat })
 *     parent: the Object3D the cloud hangs under; patch: the viewer's own clipping (BimCraft: viewer.clipped, so the
 *     section plane / box cuts the cloud with the model)
 *   layer.set(cloud, matrix16)       a cloud and its placement (column-major 4 × 4: file units → the viewer's space)
 *   layer.setMatrix(m16) · setColors(Uint8Array rgb) · setSize(px) · setVisible(on)
 *   layer.setSlice({ normal: [x, y, z], at, half } | null)   keep only points within `half` of the plane normal·p = at
 *                                                            (the viewer's space) — the section slice to trace from
 *   layer.box() → THREE.Box3 | null  (the viewer's space)
 *   layer.pick(clientX, clientY, canvas, tol = 8) → { index, point [x, y, z] (viewer space), dist } | null
 *     the drawn point nearest the pointer within tol px: the points are drawn once more, each in a colour that is its
 *     number, into a small target round the pointer (so hidden, sliced-away and section-cut points are never picked)
 *   layer.worldOf(i) → [x, y, z]  ·  layer.dispose()
 *
 * Points are float32 offsets from the cloud's origin; the placement matrix carries the big numbers (in doubles, on the
 * CPU), so state-plane coordinates keep their millimetres on the GPU too.
 */
import * as THREE from 'three';

const VERT = /* glsl */`
uniform float uSize;
uniform float uScale;
uniform vec3 uSliceN;
uniform float uSliceAt;
attribute vec3 rgb;
varying vec3 vColor;
varying float vD;
#include <clipping_planes_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vD = dot(wp.xyz, uSliceN) - uSliceAt;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = uSize * uScale;
#ifdef PICK
  int id = gl_VertexID + 1;
  vColor = vec3(float(id & 255), float((id >> 8) & 255), float((id >> 16) & 255)) / 255.0;
#else
  vColor = rgb;
#endif
  #include <clipping_planes_vertex>
}`;
const FRAG = /* glsl */`
uniform float uSliceHalf;
varying vec3 vColor;
varying float vD;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  if (uSliceHalf >= 0.0 && abs(vD) > uSliceHalf) discard;
#ifndef PICK
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
#endif
  gl_FragColor = vec4(vColor, 1.0);
}`;

export class CloudLayer {
  constructor({ renderer, camera, parent, render = () => {}, patch = (m) => m }) {
    this.renderer = renderer;
    this.camera = camera;
    this.parent = parent;
    this.render = render;
    this.patch = patch;
    this.uniforms = {
      uSize: { value: 2 }, uScale: { value: 1 },
      uSliceN: { value: new THREE.Vector3(0, 0, 1) }, uSliceAt: { value: 0 }, uSliceHalf: { value: -1 },
    };
    this.points = null;
    this.cloud = null;
    this.pickScene = new THREE.Scene();
    this.rt = null;
  }

  material(pick) {
    const m = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, clipping: true, defines: pick ? { PICK: '' } : {} });
    return this.patch(m);
  }

  set(cloud, matrix) {
    this.dispose(false);
    this.cloud = cloud;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(cloud.pos, 3));
    g.setAttribute('rgb', new THREE.BufferAttribute(new Uint8Array(cloud.n * 3).fill(200), 3, true));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    this.geometry = g;
    this.points = new THREE.Points(g, this.material(false));
    this.points.matrixAutoUpdate = false;
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.userData.cloud = true;
    this.pickPoints = new THREE.Points(g, this.material(true));
    this.pickPoints.matrixAutoUpdate = false;
    this.pickPoints.frustumCulled = false;
    this.pickScene.add(this.pickPoints);
    this.parent.add(this.points);
    this.setMatrix(matrix);
  }

  setMatrix(m) {
    if (!this.points) return;
    this.points.matrix.fromArray(m);
    this.points.matrixWorldNeedsUpdate = true;
    this.render();
  }
  setColors(rgb) {
    if (!this.points) return;
    const a = this.geometry.getAttribute('rgb');
    a.array.set(rgb);
    a.needsUpdate = true;
    this.render();
  }
  setSize(px) { this.uniforms.uSize.value = Math.max(1, Math.min(12, px)); this.render(); }
  setVisible(on) { if (this.points) { this.points.visible = on; this.render(); } }
  get visible() { return !!this.points?.visible; }
  setSlice(s) {
    if (!s) this.uniforms.uSliceHalf.value = -1;
    else {
      this.uniforms.uSliceN.value.set(...s.normal).normalize();
      this.uniforms.uSliceAt.value = s.at;
      this.uniforms.uSliceHalf.value = Math.max(0, s.half);
    }
    this.render();
  }

  box() {
    if (!this.points || !this.points.visible) return null;
    this.points.updateMatrixWorld(true);
    return this.geometry.boundingBox.clone().applyMatrix4(this.points.matrixWorld);
  }

  worldOf(i) {
    const p = this.cloud.pos;
    this.points.updateMatrixWorld(true);
    return new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]).applyMatrix4(this.points.matrixWorld).toArray();
  }

  pick(clientX, clientY, canvas, tol = 8) {
    if (!this.points || !this.isShown()) return null;
    const cam = this.camera();
    const r = canvas.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    if (x < 0 || y < 0 || x > r.width || y > r.height) return null;
    const S = 2 * tol + 1;
    if (!this.rt) this.rt = new THREE.WebGLRenderTarget(S, S, { depthBuffer: true });
    if (this.rt.width !== S) this.rt.setSize(S, S);
    // a projection that shows only the S × S pixels round the pointer (works for any camera, bare ones too)
    cam.updateMatrixWorld();
    const P = cam.projectionMatrix.clone(), Pi = cam.projectionMatrixInverse.clone();
    const sx = r.width / S, sy = r.height / S;
    const cx = (x / r.width) * 2 - 1, cy = 1 - (y / r.height) * 2;
    const W = new THREE.Matrix4().set(sx, 0, 0, -cx * sx, 0, sy, 0, -cy * sy, 0, 0, 1, 0, 0, 0, 0, 1);
    cam.projectionMatrix.premultiply(W);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    this.points.updateMatrixWorld(true);
    this.pickPoints.matrix.copy(this.points.matrixWorld);
    this.pickPoints.matrixWorld.copy(this.points.matrixWorld);
    const R = this.renderer, prev = R.getRenderTarget(), prevColor = R.getClearColor(new THREE.Color()), prevAlpha = R.getClearAlpha();
    const size = this.uniforms.uSize.value, scale = this.uniforms.uScale.value;
    this.uniforms.uSize.value = Math.max(size, 3);
    this.uniforms.uScale.value = 1;
    const buf = new Uint8Array(S * S * 4);
    try {
      R.setRenderTarget(this.rt);
      R.setClearColor(0x000000, 0);
      R.clear(true, true, true);
      R.render(this.pickScene, cam);
      R.readRenderTargetPixels(this.rt, 0, 0, S, S, buf);
    } finally {
      R.setRenderTarget(prev);
      R.setClearColor(prevColor, prevAlpha);
      cam.projectionMatrix.copy(P);
      cam.projectionMatrixInverse.copy(Pi);
      this.uniforms.uSize.value = size;
      this.uniforms.uScale.value = scale;
    }
    let best = -1, bd = Infinity;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const o = (j * S + i) * 4;
      if (!buf[o + 3]) continue;
      const id = buf[o] + buf[o + 1] * 256 + buf[o + 2] * 65536 - 1;
      if (id < 0 || id >= this.cloud.n) continue;
      const d = (i - tol) ** 2 + (j - tol) ** 2;   // rows run bottom up; the middle row is the pointer either way
      if (d < bd && d <= tol * tol) { bd = d; best = id; }
    }
    if (best < 0) return null;
    const point = this.worldOf(best);
    const cp = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    return { index: best, point, dist: cp.distanceTo(new THREE.Vector3(...point)) };
  }
  isShown() { for (let o = this.points; o; o = o.parent) if (!o.visible) return false; return true; }
  /** The display scale for gl_PointSize (the renderer's pixel ratio). */
  setPixelRatio(r) { this.uniforms.uScale.value = r || 1; this.render(); }

  dispose(all = true) {
    if (this.points) {
      this.points.removeFromParent();
      this.pickPoints.removeFromParent();
      this.geometry.dispose();
      this.points.material.dispose();
      this.pickPoints.material.dispose();
      this.points = this.pickPoints = this.geometry = null;
      this.cloud = null;
    }
    if (all && this.rt) { this.rt.dispose(); this.rt = null; }
    this.render();
  }
}

/** Column-major 4 × 4 helpers (doubles) for placements. */
export const M4 = {
  I: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  mul(a, b) {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
    return o;
  },
  T: (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
  S: (s, sy = s, sz = s) => [s, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1],
  /** Z up → Y up (x, y, z) → (x, z, −y): web-ifc's viewer space. */
  YUP: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1],
  apply(m, p) { return [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]); },
  inv(m) { return new THREE.Matrix4().fromArray(m).invert().toArray(); },
};
