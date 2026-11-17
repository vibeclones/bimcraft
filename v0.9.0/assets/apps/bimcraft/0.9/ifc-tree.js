/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ifc-tree.js — the model tree's data (0.4 B13): project → site → building → storey → space → elements, elements grouped
 * by class under each spatial node, parts under their element (a stair's flights). No DOM: bin/test-bimcraft.mjs --tree
 * runs it in Node; tree-view.js draws it.
 *
 *   const tree = buildTree(model, { className: (id) => 'IfcWall' })   model = IfcModel.load() result (its `tree`)
 *   tree.root                       the project node (null for a file without a spatial structure)
 *   tree.loose                      elements with geometry that are in no spatial element (a group at the end), or null
 *   tree.byKey.get(key)             the element / spatial node for a key (keyBase + expressID)
 *   leaves(node)                    keys of every element with geometry at or under the node (what hiding acts on)
 *   checkState(node, vis)           'on' | 'off' | 'mixed' for its checkbox (ifc-vis.js Visibility; hidden = off)
 *   pathTo(tree, key)               [root … node] — to open the tree down to a picked element
 *
 * node = { kind: 'spatial' | 'group' | 'element', id (expressID, groups: null), key, cls, kids [], parent, geo (has
 * geometry), size (elements with geometry at or under it; spaces are leaves but not counted) }. Groups: { cls, label: count } keyed 'g:<parent key>:<cls>'.
 */
import { HIDDEN } from './ifc-vis.js';

const SPATIAL = /^IFC(PROJECT|SITE|BUILDING|BUILDINGSTOREY|SPACE|FACILITY|FACILITYPART|BRIDGE|BRIDGEPART|ROAD|ROADPART|RAILWAY|RAILWAYPART|MARINEFACILITY|MARINEPART|SPATIALZONE|EXTERNALSPATIALELEMENT)$/;
export const isSpatial = (cls) => SPATIAL.test(String(cls || '').toUpperCase());

export function buildTree(model, { className = () => 'Unknown' } = {}) {
  const kb = model.keyBase || 0;
  const geo = model.classOf;   // expressID → class, elements with geometry
  const byKey = new Map();
  const cls = (n) => { const c = String(n.type || ''); return /^IFC/.test(c) ? className(n.expressID) : c; };
  const node = (n, parent) => {
    const c = cls(n);
    const me = { kind: isSpatial(c) ? 'spatial' : 'element', id: n.expressID, key: kb + n.expressID, cls: c, kids: [], parent, geo: geo.has(n.expressID), size: 0 };
    byKey.set(me.key, me);
    const spatialKids = [], elements = [];
    for (const ch of n.children || []) {
      const k = node(ch, me);
      (k.kind === 'spatial' ? spatialKids : elements).push(k);
    }
    if (me.kind === 'spatial') {
      // elements grouped by class (a wall group, a door group …), after the spatial children
      const groups = new Map();
      for (const e of elements) { if (!groups.has(e.cls)) groups.set(e.cls, []); groups.get(e.cls).push(e); }
      const gs = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([c, list]) => {
        const g = { kind: 'group', id: null, key: 'g:' + me.key + ':' + c, cls: c, kids: list, parent: me, geo: false, size: 0 };
        for (const e of list) e.parent = g;
        g.size = list.reduce((a, e) => a + e.size, 0);
        return g;
      });
      me.kids = [...spatialKids, ...gs];
    } else me.kids = elements;   // parts of an element (a stair's flights)
    me.size = (me.geo && c !== 'IfcSpace' ? 1 : 0) + me.kids.reduce((a, k) => a + k.size, 0);   // counts elements; a space (a room) is a leaf, not counted
    return me;
  };
  const root = model.tree ? node(model.tree, null) : null;
  // elements with geometry the spatial structure does not hold (contained nowhere)
  const lost = [...geo.keys()].filter((id) => !byKey.has(kb + id));
  let loose = null;
  if (lost.length) {
    loose = { kind: 'group', id: null, key: 'g:loose', cls: '', loose: true, kids: [], parent: null, geo: false, size: lost.length };
    for (const id of lost) { const e = { kind: 'element', id, key: kb + id, cls: geo.get(id), kids: [], parent: loose, geo: true, size: 1 }; byKey.set(e.key, e); loose.kids.push(e); }
  }
  return { root, loose, byKey, keyBase: kb };
}

/** Keys of every element with geometry at or under a node. */
export function leaves(node, out = []) {
  if (node.geo) out.push(node.key);
  for (const k of node.kids) leaves(k, out);
  return out;
}

/** The checkbox of a node: on (all its elements shown), off (all hidden), mixed. A node without geometry under it is on. */
export function checkState(node, vis) {
  let on = 0, off = 0;
  const walk = (n) => {
    if (n.geo) { if (vis.hidden.has(n.key)) off++; else on++; }
    for (const k of n.kids) { walk(k); if (on && off) return; }
  };
  walk(node);
  return off === 0 ? 'on' : on === 0 ? 'off' : 'mixed';
}

/** Is the element drawn at all (not hidden, not isolated away)? For the tree's dimmed rows. */
export const shown = (vis, key) => vis.state(key) !== HIDDEN;

/** Root … node for a key, or [] when the key is not in the tree. */
export function pathTo(tree, key) {
  const n = tree.byKey.get(key);
  if (!n) return [];
  const path = [];
  for (let x = n; x; x = x.parent) path.unshift(x);
  return path;
}
