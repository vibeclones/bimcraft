/* SPDX-License-Identifier: Apache-2.0 */
// CadCraft's one line in this folder (not from the three package): three.webgpu.js imports './three.core.js'; this hands it
// the core already vendored in ../../three/0.186.1/ (byte-identical to the tarball's build/three.core.js, sha256 in
// SOURCE.txt), so a page that loads both 'three' and 'three/webgpu' runs one copy of three's classes, not two.
export * from '../../three/0.186.1/three.core.js';
