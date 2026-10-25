/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pipes.js — every pipe the Pipe tool draws, from one place: the US tables (mep/tables.js, a copy of CadCraft's Piping
 * add-on: steel, copper, PVC Schedule 40 / 80, PEX) and the Brazilian ones (mep/tables-br.js: PVC soldável NBR 5648, PVC
 * esgoto NBR 5688). DOM-free. Which standard a run follows comes from its material.
 *
 *   MATERIALS, CLASSES, DEFAULT_CLASS · sizesFor(mat, cls) (smallest first) · pipeSize(mat, cls, size) (as tables.js; a Brazilian
 *   size has metric: true and its label) · bendRadius(p) (inches) · drainSlope(p) → the smallest slope its standard allows a
 *   horizontal drain of that size (IPC 2021 Table 704.1 for the US tables, NBR 8160 for the Brazilian ones)
 *   standardOf(mat) → 'us' | 'br' · SYSTEM_MATERIALS[std][system] → the usual material of a system under a standard
 *   BR_MAX_VELOCITY (m/s): the speed Brazilian water pipes are sized to by flow (NBR 5626)
 */
import * as US from './tables.js';
import { BR_MATERIALS, BR_CLASSES, BR_DEFAULT_CLASS, brSizesFor, brPipeSize, brDrainSlope, isBrMaterial } from './tables-br.js';
export { BR_MAX_VELOCITY } from './tables-br.js';

export const MATERIALS = [...US.MATERIALS, ...BR_MATERIALS];
export const CLASSES = { ...US.CLASSES, ...BR_CLASSES };
export const DEFAULT_CLASS = { ...US.DEFAULT_CLASS, ...BR_DEFAULT_CLASS };
export const standardOf = (mat) => (isBrMaterial(mat) ? 'br' : 'us');

/** The usual material of each system: the US ones as before; in Brazil PVC soldável for water, PVC esgoto for drains and vents
 *  (other systems keep steel: there is no Brazilian table here for them). */
export const SYSTEM_MATERIALS = {
  us: { cw: 'copper', hw: 'copper', hwr: 'copper', san: 'pvc', vent: 'pvc', storm: 'pvc', chw: 'steel', hhw: 'steel', gas: 'steel', fire: 'steel' },
  br: { cw: 'pvc-sold', hw: 'copper', hwr: 'copper', san: 'pvc-esg', vent: 'pvc-esg', storm: 'pvc-esg', chw: 'steel', hhw: 'steel', gas: 'steel', fire: 'steel' },
};

const nominalOf = (mat, cls, s) => { const p = pipeSize(mat, cls, s); return p ? (p.metric ? p.dn : p.nps * 25.4) : Infinity; };
/** The sizes made in a material and class, smallest first (the US tables list "1", "2" … before "1/2"). */
export function sizesFor(mat, cls) {
  if (isBrMaterial(mat)) return brSizesFor(mat, cls);
  return US.sizesFor(mat, cls).slice().sort((a, b) => nominalOf(mat, cls, a) - nominalOf(mat, cls, b));
}
export function pipeSize(mat, cls, size) {
  return isBrMaterial(mat) ? brPipeSize(mat, cls, size) : US.pipeSize(mat, cls, size);
}
/** The bend radius elbows are drawn with (inches): the US rule; PVC of the Brazilian tables at one outside diameter. */
export function bendRadius(p) {
  return p.metric ? p.od : US.bendRadius(p);
}
export function drainSlope(p) {
  if (!p) return null;
  return p.metric ? brDrainSlope(p.dn) : US.minDrainSlope(p.nps);
}
