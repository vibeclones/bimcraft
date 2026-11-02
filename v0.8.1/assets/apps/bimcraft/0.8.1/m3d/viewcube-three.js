/* SPDX-License-Identifier: Apache-2.0 */
/**
 * viewcube-three.js — connects the view cube (viewcube.js) to a three.js camera + OrbitControls. Does not import three
 * (it only calls the camera's own methods), so Node runs it with a stand-in. Canonical copy: modelcraft/dev/; PartCraft,
 * DetailCraft and BimCraft keep BYTE-IDENTICAL copies next to their viewcube.js.
 *
 *   import { mountViewCube } from './viewcube.js';
 *   import { threeCubeOptions } from './viewcube-three.js';
 *   const cube = mountViewCube(stage, threeCubeOptions({
 *     camera: () => view.camera, controls: () => view.controls, render: () => view.render(),
 *     yUp: false,          // true when the app's world is Y up (PartCraft): the cube's Top is the app's +Y,
 *                          // its Front looks from +Z (the cube itself is always Z up)
 *     home: () => view.view('iso'),
 *   }));
 *   // after every render: cube.update()
 *
 * The camera keeps `up` = the world's up (what OrbitControls orbits about). Straight-down/up views are tilted by
 * 0.0002 rad towards the wanted screen-up, so a turned plan view survives OrbitControls.update(). Dragging the cube
 * turns the view itself (turntable), no OrbitControls involvement.
 */
import { basis, animateView, reducedMotion } from './viewcube.js';

const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? a.map((x) => x / l) : [0, 0, 0]; };
/** Cube (Z up) ↔ app coordinates. */
export const toApp = (v, yUp) => (yUp ? [v[0], v[2], -v[1]] : v.slice());
export const toCube = (v, yUp) => (yUp ? [v[0], -v[2], v[1]] : v.slice());

/** {dir, up, persp} of a three camera, in cube coordinates. */
export function threeView(camera, yUp = false) {
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements;
  const up = norm([e[4], e[5], e[6]]), dir = norm([-e[8], -e[9], -e[10]]);
  return { dir: toCube(dir, yUp), up: toCube(up, yUp), persp: !!camera.isPerspectiveCamera };
}
/** Put the camera on view (cube coordinates) about controls.target, same distance. final = settle `up` for OrbitControls. */
export function applyThreeView(camera, controls, view, { yUp = false, final = true } = {}) {
  const B = basis(view);
  const d = toApp(B.d, yUp), u = toApp(B.u, yUp), W = yUp ? [0, 1, 0] : [0, 0, 1];
  const t = controls.target;
  const dist = Math.max(Math.hypot(camera.position.x - t.x, camera.position.y - t.y, camera.position.z - t.z), 1e-6);
  let off = [-d[0], -d[1], -d[2]];
  const dw = d[0] * W[0] + d[1] * W[1] + d[2] * W[2];
  // lookAt takes screen-right = up × (eye − target): tilt towards −up looking down, +up looking up
  if (final && Math.abs(dw) > 0.9999) { const k = 2e-4 * Math.sign(dw); off = norm([off[0] + u[0] * k, off[1] + u[1] * k, off[2] + u[2] * k]); }
  camera.position.set(t.x + off[0] * dist, t.y + off[1] * dist, t.z + off[2] * dist);
  if (final) camera.up.set(W[0], W[1], W[2]); else camera.up.set(u[0], u[1], u[2]);
  camera.lookAt(t.x, t.y, t.z);
  if (final) controls.update?.();
}
/** Options for mountViewCube. camera/controls are getters (apps that swap cameras give the current one). */
export function threeCubeOptions({ camera, controls, render = () => {}, home = null, yUp = false, ms = 420, ...rest } = {}) {
  let cancel = null;
  const stop = () => { if (cancel) { cancel(); cancel = null; } };
  return {
    ...rest,
    getView: () => threeView(camera(), yUp),
    setView(view, { animate = false } = {}) {
      stop();
      const cam = camera(), ctl = controls();
      const from = threeView(cam, yUp);
      cancel = animateView(from, { dir: view.dir, up: view.up }, (v, last) => { applyThreeView(cam, ctl, v, { yUp, final: last }); render(); },
        { ms: animate && !reducedMotion() ? ms : 0, done: () => { cancel = null; } });
    },
    home: home ? () => { stop(); home(); render(); } : null,
    stop,
  };
}
