/* SPDX-License-Identifier: Apache-2.0 */
/**
 * tree-view.js — the model tree panel (0.4 B13) for ifc-tree.js data. DOM; text through el() only (names come from the
 * file). Rows exist only for opened branches; a long group shows PAGE rows at a time with "Show more".
 *
 *   const tv = new TreeView(ul, { label(what, node), onToggle(node, on), onPick(node, { add }), onInfo(node), onZoom(node) });
 *   tv.setTree(tree, vis, { keep });  tv.sync();  tv.reveal([keys])  (opens the path to the first, marks every picked row)
 *
 * Row: twisty · checkbox (on / off / mixed: hidden elements, ifc-vis.js) · name button (picks what the row stands for;
 * a double-click zooms to it) ·
 * for spatial nodes an info button (their own properties). Keys: Up/Down move, Right opens / goes in, Left closes / goes
 * up, Space ticks, Enter picks (Ctrl/Cmd+Enter adds).
 */
import { el } from './ui-util.js';
import { checkState, pathTo, shown } from './ifc-tree.js';

const PAGE = 200;

export class TreeView {
  constructor(ul, opts) {
    this.ul = ul;
    this.o = opts;
    this.open = new Set();      // keys of opened nodes
    this.pages = new Map();     // node key → how many children are shown
    this.picked = new Set();
    this.rows = new Map();      // node key → { li, box, name }
    ul.setAttribute('role', 'tree');
    ul.addEventListener('keydown', (e) => this.key(e));
  }

  /** A new model's tree; `keep` (the same model rebuilt after an edit) keeps what was open. */
  setTree(tree, vis, { keep = false } = {}) {
    this.tree = tree; this.vis = vis;
    if (keep) { this.render(); return; }
    this.open = new Set(tree.root ? [tree.root.key] : []);
    // open the single chain project → site → building, so the storeys show (closed); stop where it forks
    for (let n = tree.root; n; ) { const sp = n.kids.filter((k) => k.kind === 'spatial'); if (sp.length !== 1) break; n = sp[0]; this.open.add(n.key); }
    this.pages.clear();
    this.picked.clear();
    this.render();
  }

  render() {
    this.rows.clear();
    const top = [this.tree.root, this.tree.loose].filter(Boolean);
    this.ul.replaceChildren(...top.map((n) => this.item(n, 1)));
    const first = this.ul.querySelector('.bc-tree-name');
    if (first) first.tabIndex = 0;
    this.sync();
  }

  item(n, level) {
    const has = n.kids.length > 0, isOpen = has && this.open.has(n.key);
    const twisty = el('button', { type: 'button', className: 'bc-tree-twisty', tabIndex: -1, 'aria-hidden': 'true', onClick: () => this.toggleOpen(n) },
      has ? el('i', { className: 'bi ' + (isOpen ? 'bi-chevron-down' : 'bi-chevron-right') }) : null);
    const box = el('input', { type: 'checkbox', tabIndex: -1, 'aria-label': this.o.label('check', n) });
    box.addEventListener('change', () => this.o.onToggle(n, box.checked));
    const nm = el('button', { type: 'button', className: 'bc-tree-name', tabIndex: -1, 'data-tree-key': String(n.key), onClick: (e) => this.o.onPick(n, { add: e.ctrlKey || e.metaKey || e.shiftKey }) },
      el('span', { className: 'bc-tree-label' }, this.o.label('name', n)),
      this.o.label('sub', n) ? el('span', { className: 'bc-tree-sub' }, this.o.label('sub', n)) : null);
    nm.addEventListener('dblclick', () => this.o.onZoom?.(n));   // el() wires onClick only
    const info = n.kind === 'spatial' ? el('button', { type: 'button', className: 'bc-tree-info', tabIndex: -1, title: this.o.label('info', n), 'aria-label': this.o.label('info', n), onClick: () => this.o.onInfo(n) },
      el('i', { className: 'bi bi-info-circle', 'aria-hidden': 'true' })) : null;
    const li = el('li', { role: 'treeitem', 'aria-level': String(level), 'data-node': String(n.key) },
      el('div', { className: 'bc-tree-row' }, twisty, box, nm, info));
    if (has) li.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (isOpen) li.append(this.group(n, level));
    this.rows.set(n.key, { li, box, name: nm, node: n });
    return li;
  }

  group(n, level) {
    const max = this.pages.get(n.key) || PAGE;
    const kids = n.kids.slice(0, max);
    const ul = el('ul', { role: 'group' }, ...kids.map((k) => this.item(k, level + 1)));
    if (n.kids.length > max) {
      ul.append(el('li', { role: 'none', className: 'bc-tree-more' }, el('button', { type: 'button', className: 'bc-linkbtn', onClick: () => {
        this.pages.set(n.key, max + PAGE); this.rerow(n);
      } }, this.o.label('more', { n: Math.min(PAGE, n.kids.length - max), total: n.kids.length }))));
    }
    return ul;
  }

  /** Draw one row again (opened, closed, more shown). */
  rerow(n) {
    const old = this.rows.get(n.key);
    if (!old) return;
    const focused = old.li.contains(document.activeElement);
    const level = Number(old.li.getAttribute('aria-level'));
    const li = this.item(n, level);
    old.li.replaceWith(li);
    for (const [k, r] of this.rows) if (!r.li.isConnected) this.rows.delete(k);   // rows of a closed branch
    this.sync();
    if (focused) this.focus(this.rows.get(n.key).name);
  }

  toggleOpen(n, want = null) {
    if (!n.kids.length) return;
    const on = want === null ? !this.open.has(n.key) : want;
    if (on) this.open.add(n.key); else this.open.delete(n.key);
    this.rerow(n);
  }

  /** Checkbox states and dimmed rows (hidden), and the picked marks, for every row on screen. */
  sync() {
    for (const { box, li, node } of this.rows.values()) {
      const st = checkState(node, this.vis);
      box.checked = st !== 'off';
      box.indeterminate = st === 'mixed';
      li.classList.toggle('is-hidden', node.kind === 'element' && node.geo && !shown(this.vis, node.key));
      li.setAttribute('aria-selected', this.picked.has(node.key) ? 'true' : 'false');
    }
  }

  /** Mark these keys as picked; open the tree down to the first and scroll it into view. */
  reveal(keys) {
    this.picked = new Set(keys);
    const first = keys[0];
    if (first !== undefined) {
      const path = pathTo(this.tree, first);
      let changed = false;
      for (const n of path.slice(0, -1)) if (!this.open.has(n.key)) { this.open.add(n.key); changed = true; }
      // a long group shows enough rows to include it
      for (let i = 0; i + 1 < path.length; i++) {
        const at = path[i].kids.indexOf(path[i + 1]);
        if (at >= (this.pages.get(path[i].key) || PAGE)) { this.pages.set(path[i].key, Math.ceil((at + 1) / PAGE) * PAGE); changed = true; }
      }
      if (changed) this.render(); else this.sync();
      const row = this.rows.get(first);
      if (row) row.name.scrollIntoView({ block: 'nearest' });
    } else this.sync();
  }

  focus(btn) {
    for (const b of this.ul.querySelectorAll('.bc-tree-name[tabindex="0"]')) b.tabIndex = -1;
    btn.tabIndex = 0;
    btn.focus();
  }

  key(e) {
    const btn = e.target.closest('.bc-tree-name');
    if (!btn) return;
    const row = this.rows.get(Number(btn.dataset.treeKey)) || this.rows.get(btn.dataset.treeKey);
    const all = [...this.ul.querySelectorAll('.bc-tree-name')];
    const i = all.indexOf(btn);
    if (e.key === 'ArrowDown' && i + 1 < all.length) { e.preventDefault(); this.focus(all[i + 1]); }
    else if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); this.focus(all[i - 1]); }
    else if (e.key === 'ArrowRight' && row) {
      e.preventDefault();
      if (row.node.kids.length && !this.open.has(row.node.key)) this.toggleOpen(row.node, true);
      else if (all[i + 1]) this.focus(all[i + 1]);
    } else if (e.key === 'ArrowLeft' && row) {
      e.preventDefault();
      if (this.open.has(row.node.key)) this.toggleOpen(row.node, false);
      else if (row.node.parent && this.rows.get(row.node.parent.key)) this.focus(this.rows.get(row.node.parent.key).name);
    } else if (e.key === ' ' && row) { e.preventDefault(); row.box.click(); }
    else if (e.key === 'Enter' && row) { e.preventDefault(); this.o.onPick(row.node, { add: e.ctrlKey || e.metaKey }); }
  }
}
