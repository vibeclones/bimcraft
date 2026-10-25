/* SPDX-License-Identifier: Apache-2.0 */
/**
 * main.js — the Plant add-on for BimCraft (0.7 LC.5 step 2, session plant-design): pipe specs, isometrics, process equipment
 * with nozzles and a factory layout check, on BimCraft's add-on API 1.0 (docs/ADDONS-SPEC.md §5.7).
 *
 *   Properties    a "Pipe spec" section for a selected pipe run: the spec its material and class name, whether its size and
 *                 valves are allowed, its bends and branches (lib/spec.js)
 *   Export        "Isometric of the selected pipe runs" (SVG, DXF), "Process equipment" (an IFC4 file with nozzle ports)
 *   Panel tab     Plant: the equipment table (type, tag, place), the specs, the isometric, the layout check
 *   Commands      plant:spec-check · plant:iso-svg · plant:iso-dxf · plant:equipment-ifc · plant:layout-check
 *
 * What needs BimCraft to WRITE into the open model — placing equipment in it, routing a run between nozzles — needs add-on
 * API 1.1 (`api.model.write`, session mep-07). Until the app has it those two say so; nothing here edits the model.
 * A drafting aid, not an engineering approval.
 */

import { setT, t, csv } from './lib/core.js';
import { STARTERS, cleanSpec, specFor, allowedSizes, checkRun, bendRadius, branchKind } from './lib/spec.js';
import { readRun, fromMep } from './lib/runs.js';
import { iso, toSvg, toDxf, bom } from './lib/iso.js';
import { TYPES, TYPE, makeEquipment } from './lib/equip.js';
import { writeIfc } from './lib/ifc-out.js';
import { checkLayout, itemFromEquipment, DEFAULTS as LAYOUT_DEFAULTS } from './lib/layout.js';
import { placeEquipment } from './lib/place.js';
import { route } from './lib/route.js';
import { pipeSize } from '../../mep/tables.js';
import { placeEquipment as placeEquip } from './lib/equip.js';

const FIELD = 40;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

export function activate(api) {
  setT(api.t);
  const stored = (k, d) => { const v = api.storage.get(k); return v === undefined || v === null ? d : v; };

  // ---------------------------------------------------------------------------------------------- the person's tables
  const userSpecs = () => (Array.isArray(stored('specs', [])) ? stored('specs', []).map(cleanSpec).filter(Boolean) : []);
  // the starter specs in the person's language (their records keep the English: spec.js)
  const starter = (s) => ({ ...s, name: t('spec.starter.' + s.id.toLowerCase() + '.name'), notes: t('spec.starter.' + s.id.toLowerCase() + '.notes') });
  const specs = () => { const u = userSpecs(); return [...u, ...STARTERS.filter((s) => !u.some((x) => x.id === s.id)).map(starter)]; };
  const cleanItem = (r) => {
    if (!r || !TYPE[r.type]) return null;
    const num = (v) => (fin(Number(v)) ? Number(v) : 0);
    return { type: r.type, tag: String(r.tag ?? '').slice(0, 24), desc: String(r.desc ?? '').slice(0, 60), x: num(r.x), y: num(r.y), z: num(r.z), rot: num(r.rot), weight: Math.max(0, num(r.weight)), params: r.params && typeof r.params === 'object' ? r.params : {}, guid: typeof r.guid === 'string' && /^[0-9A-Za-z_$]{22}$/.test(r.guid) ? r.guid : '' };
  };
  const equipment = () => (Array.isArray(stored('equipment', [])) ? stored('equipment', []).map(cleanItem).filter(Boolean).slice(0, 200) : []);
  const saveEquipment = (list) => api.storage.set('equipment', list.slice(0, 200));
  const limits = () => ({ minAisle: fin(stored('limits', {}).minAisle) ? stored('limits', {}).minAisle : LAYOUT_DEFAULTS.minAisle, floorLoad: fin(stored('limits', {}).floorLoad) ? stored('limits', {}).floorLoad : LAYOUT_DEFAULTS.floorLoad });

  // ---------------------------------------------------------------------------------------------- reading the selection
  /**
   * The pipe runs the selection is part of. With add-on API 1.1 a pipe segment, fitting or valve picked in the view leads to its
   * run (mep.runs()); with 1.0 only a selected run assembly itself is read (its CadCraft_MepRun set).
   */
  const selectedRuns = () => runsOf(api.model.selection());
  async function runsOf(ids) {
    const sel = [...ids].map(Number);
    if (api.mep && typeof api.mep.runs === 'function') {
      const out = [];
      let all = [];
      try { all = api.mep.runs(); } catch { all = []; }   // no model, or a model the engine cannot read: fall back to the property sets
      for (const r of all) {
        if (r.kind !== 'pipe' || out.some((x) => x.guid === r.guid)) continue;
        if (sel.includes(Number(r.id)) || (r.parts || []).some((p) => sel.includes(Number(p)))) { const run = fromMep(r); if (run) out.push(run); }
      }
      if (out.length) return out;
    }
    const out = [];
    for (const id of sel) {
      let p = null;
      try { p = await api.model.properties(id); } catch { p = null; }
      const r = p ? readRun(p) : null;
      if (r && r.kind === 'pipe' && !out.some((x) => x.guid === r.guid)) out.push(r);
    }
    return out;
  }
  const findingText = (f) => t('finding.' + f.code, f.vars || {});
  function checkAll(runs) {
    const out = [];
    for (const r of runs) {
      const spec = specFor(specs(), r.mat, r.cls);
      if (!spec) { out.push({ run: r, code: 'spec-none', level: 'warning', vars: { mat: r.mat, cls: r.cls } }); continue; }
      for (const f of checkRun(spec, r)) out.push({ run: r, ...f });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------- Properties: Pipe spec
  api.props.section({
    key: 'plant', label: t('props.spec'),
    fields: async (sel) => {
      const runs = await runsOf(sel);
      if (runs.length !== 1) return [];
      const r = runs[0], spec = specFor(specs(), r.mat, r.cls);
      if (!spec) return [{ label: t('props.spec'), value: t('props.nospec', { mat: r.mat, cls: r.cls }) }];
      const sizes = allowedSizes(spec), found = checkRun(spec, r);
      const rad = bendRadius(spec, r.size);
      return [
        { label: t('props.spec'), value: spec.id + ' — ' + spec.name },
        { label: t('props.sizes'), value: spec.sizes.min + ' to ' + spec.sizes.max + (sizes.includes(r.size) ? '' : ' — ' + t('props.size.bad', { size: r.size })) },
        { label: t('props.valves'), value: found.some((f) => f.code === 'spec-valve') ? found.filter((f) => f.code === 'spec-valve').map(findingText).join('; ') : (r.valves.length ? t('props.valves.ok', { n: r.valves.length }) : t('props.valves.none')) },
        { label: t('props.bends'), value: rad ? t('props.bends.' + spec.bends, { r: Math.round(rad * 25.4) }) : '' },
        { label: t('props.branch'), value: ['4:1', '2:1', '1:1'].map((x) => { const [h, b] = x.split(':'); return x + ' ' + (branchKind(spec, h, b) || '—'); }).join(', ') },
      ];
    },
  });

  // ---------------------------------------------------------------------------------------------- files
  async function isoOf() {
    const runs = await selectedRuns();
    if (!runs.length) throw new Error(t('err.noruns'));
    const name = api.model.current()?.name || '';
    return iso({ runs: runs.map((r) => ({ id: r.guid, tag: r.tag, size: r.size, mat: r.mat, cls: r.cls, spec: specFor(specs(), r.mat, r.cls)?.id, od: r.od, points: r.points, valves: r.valves })), units: stored('units', 'mm'), title: { project: name.replace(/\.[^.]+$/, ''), drawing: runs.length === 1 && runs[0].tag ? runs[0].tag : t('iso.drawing'), drawn: 'CadCraft', date: new Date().toISOString().slice(0, 10) } });
  }
  api.files.exporter({ id: 'iso-svg', label: t('export.iso.svg'), extension: 'svg', mime: 'image/svg+xml', write: async () => toSvg(await isoOf()) });
  api.files.exporter({ id: 'iso-dxf', label: t('export.iso.dxf'), extension: 'dxf', mime: 'application/dxf', write: async () => toDxf(await isoOf()) });
  api.files.exporter({
    id: 'equipment-ifc', label: t('export.equipment'), extension: 'ifc', mime: 'application/x-step',
    write: async () => ifcBytes(),
  });
  function ifcBytes() {
    const list = equipment();
    if (!list.length) throw new Error(t('err.noequipment'));
    return writeIfc({ name: (api.model.current()?.name || t('plant.name')).replace(/\.[^.]+$/, ''), items: list.map((it) => ({ equip: makeEquipment(it.type, it.params), tag: it.tag, desc: it.desc, x: it.x, y: it.y, z: it.z, rot: it.rot })) }).bytes;
  }

  // ---------------------------------------------------------------------------------------------- commands
  const say = (s) => api.status(s);
  const needWrite = () => { say(t('need.write')); return false; };
  api.commands.add('spec-check', async () => {
    const runs = await selectedRuns();
    if (!runs.length) { say(t('err.noruns')); return; }
    const found = checkAll(runs);
    say(found.length ? t('done.spec.found', { n: found.length, first: findingText(found[0]) }) : t('done.spec.clean', { n: runs.length }));
  }, { label: t('cmd.spec-check') });
  api.commands.add('iso-svg', async () => { try { await isoOf(); say(t('done.iso')); } catch (e) { say(e.message); } }, { label: t('cmd.iso') });
  api.commands.add('layout-check', () => { const f = layoutFindings(); say(f.length ? t('done.layout.found', { n: f.length }) : t('done.layout.clean')); }, { label: t('cmd.layout-check') });
  /** Put the table's equipment (the rows not placed yet, or one row) into the open model: one undo step. → how many. */
  async function placeRows(only = null) {
    if (typeof api.model.write !== 'function') { needWrite(); return 0; }
    if (!api.model.current()) { say(t('err.nomodel')); return 0; }
    const list = equipment();
    const todo = list.map((it, i) => ({ it, i })).filter(({ it, i }) => (only === null ? !it.guid : i === only));
    if (!todo.length) { say(t('done.place.none')); return 0; }
    const r = await api.model.write(t('cmd.place-equipment'), (w) => todo.map(({ it }) => placeEquipment(w, { equip: makeEquipment(it.type, it.params), tag: it.tag, desc: it.desc, x: it.x, y: it.y, z: it.z, rot: it.rot }).guid));
    const guids = Array.isArray(r.value) ? r.value : [];
    saveEquipment(list.map((it, i) => { const k = todo.findIndex((x) => x.i === i); return k >= 0 && guids[k] ? { ...it, guid: guids[k] } : it; }));
    say(t('done.place', { n: todo.length }));
    return todo.length;
  }
  api.commands.add('place-equipment', () => placeRows(), { label: t('cmd.place-equipment') });
  api.commands.add('route', () => say(hasMep() ? t('route.hint') : t('need.write')), { label: t('cmd.route') });

  const hasMep = () => !!api.mep && typeof api.mep.ports === 'function';
  const portLabel = (p) => (p.ownerClass ? p.ownerClass.replace(/^IFC/, '').toLowerCase() + ' ' : '') + (p.name || '') + ' (' + (p.size ? Math.round(Number(p.size)) || p.size : '?') + ', ' + p.flow + ')';
  /** A route between two ports of the model (mep.ports(): storey plan mm), round the equipment of the table that is in the model. */
  function findRoute(a, b, specId, size) {
    const spec = specs().find((x) => x.id === specId) || specs()[0];
    const ps = pipeSize(spec.material, spec.cls, size);
    if (!ps) return { ok: false, error: 'size' };
    const obstacles = equipment().filter((it) => it.guid).map((it) => placeEquip(makeEquipment(it.type, it.params), { x: it.x, y: it.y, z: it.z, rot: it.rot }).bbox);
    const r = route({ from: { p: a.at, out: a.out }, to: { p: b.at, out: b.out }, obstacles, od: ps.od * 25.4 });
    return r.ok ? { ...r, spec, size, od: ps.od * 25.4 } : r;
  }

  function layoutFindings() {
    const items = equipment().map((it, i) => itemFromEquipment(makeEquipment(it.type, it.params), { id: 'e' + i, tag: it.tag, name: t('type.' + it.type), x: it.x, y: it.y, rot: it.rot, weight: it.weight })).filter(Boolean);
    return checkLayout({ items, ...limits() });
  }

  // ---------------------------------------------------------------------------------------------- the panel tab
  let lastRoute = null;   // the route the person found last: { ok, points, length, bends, climbs, spec, size, od, a, b }
  api.ui.panelTab({ id: 'plant', title: t('plant.name'), render: (pane) => render(pane) });
  function render(pane) {
    const d = pane.ownerDocument;
    const el = (tag, attrs = {}, ...kids) => {
      const n = d.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) { if (k === 'class') n.className = v; else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn); else if (v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v); }
      n.append(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false));
      return n;
    };
    const section = (title, body) => el('details', { open: true, class: 'plant-sec' }, el('summary', {}, title), ...body);
    const download = (name, data, mime) => { const a = el('a', { download: name, href: URL.createObjectURL(new Blob([data], { type: mime })) }); d.body.append(a); a.click(); a.remove(); };
    const list = (items) => el('ul', { class: 'plant-list' }, ...items.map((s) => el('li', {}, s)));
    const again = () => { pane.replaceChildren(); render(pane); };

    // equipment table
    const eq = equipment();
    const num = (name) => el('input', { type: 'number', step: 'any', name, 'aria-label': t('field.' + name), placeholder: t('field.' + name), style: 'width:100%;min-width:0' });
    // add-ons bring no stylesheet: layout only, in the page's own classes and a little inline style
    const form = el('form', { class: 'plant-form', style: 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0.25rem;margin:0.5rem 0' },
      el('select', { name: 'type', class: 'select-cc', 'aria-label': t('field.type'), style: 'grid-column:1/-1' }, ...TYPES.map((k) => el('option', { value: k }, t('type.' + k)))),
      el('input', { type: 'text', name: 'tag', maxlength: FIELD, 'aria-label': t('field.tag'), placeholder: t('field.tag'), style: 'grid-column:1/-1' }),
      num('x'), num('y'), num('z'), num('rot'), num('weight'),
      el('button', { type: 'submit', class: 'btn-line btn-sm-cc', style: 'grid-column:1/-1' }, t('btn.add')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = (n) => form.elements[n].value;
      const item = cleanItem({ type: v('type'), tag: v('tag'), x: v('x'), y: v('y'), z: v('z'), rot: v('rot'), weight: v('weight') });
      if (item) { saveEquipment([...equipment(), item]); again(); }
    });
    const table = eq.length
      ? el('table', { class: 'plant-table', style: 'width:100%;font-size:0.75rem;border-collapse:collapse;margin:0.5rem 0' }, el('thead', {}, el('tr', {}, ...['type', 'tag', 'place', 'weight', ''].map((k) => el('th', { style: 'text-align:left;padding:0.125rem 0.25rem' }, k ? t('field.' + k) : '')))),
        el('tbody', {}, ...eq.map((it, i) => el('tr', {}, el('td', {}, t('type.' + it.type)), el('td', {}, it.tag), el('td', {}, it.x + ', ' + it.y + ', ' + it.z + (it.rot ? ' @ ' + it.rot + '°' : '')), el('td', {}, it.weight || ''),
          el('td', { style: 'white-space:nowrap' },
            it.guid ? el('span', { title: t('equip.placed') }, '✓ ') : (typeof api.model.write === 'function' ? el('button', { type: 'button', class: 'btn-line btn-sm-cc', 'data-plant-place': String(i), on: { click: async () => { try { await placeRows(i); } catch (e) { say(e.message); } again(); } } }, t('btn.place')) : null),
            el('button', { type: 'button', class: 'btn-line btn-sm-cc', 'aria-label': t('btn.remove'), on: { click: () => { saveEquipment(equipment().filter((_, j) => j !== i)); again(); } } }, '×'))))))
      : el('p', {}, t('equip.empty'));
    const eqSec = section(t('sec.equipment'), [
      el('p', {}, t('equip.intro')), form, table,
      el('p', {}, el('button', { type: 'button', class: 'btn-line btn-sm-cc', on: { click: async () => { try { download('plant-equipment.ifc', ifcBytes(), 'application/x-step'); } catch (e) { say(e.message); } } } }, t('btn.equipment.ifc'))),
    ]);

    // layout
    const out = el('div', { class: 'plant-out', 'aria-live': 'polite' });
    const lim = limits();
    const aisle = el('input', { type: 'number', min: '0', value: String(lim.minAisle), style: 'width:5rem', 'aria-label': t('field.aisle') });
    const load = el('input', { type: 'number', min: '0', value: String(lim.floorLoad), style: 'width:5rem', 'aria-label': t('field.load') });
    const layoutSec = section(t('sec.layout'), [
      el('p', {}, t('layout.intro')),
      el('label', {}, t('field.aisle'), ' ', aisle), ' ', el('label', {}, t('field.load'), ' ', load), ' ',
      el('button', { type: 'button', class: 'btn-line btn-sm-cc', on: { click: () => {
        api.storage.set('limits', { minAisle: Number(aisle.value) || 0, floorLoad: Number(load.value) || 0 });
        const found = layoutFindings();
        out.replaceChildren(found.length ? list(found.map((x) => t('level.' + x.level) + ': ' + t('layout.' + x.code, x.vars))) : el('p', {}, t('done.layout.clean')));
      } } }, t('btn.layout')),
    ]);

    // specs
    const specSec = section(t('sec.specs'), [
      el('p', {}, t('specs.intro')),
      list(specs().map((s) => s.id + ' — ' + s.name + ' (' + s.sizes.min + '–' + s.sizes.max + ')')),
      el('button', { type: 'button', class: 'btn-line btn-sm-cc', on: { click: async () => {
        const runs = await selectedRuns();
        out.replaceChildren(!runs.length ? el('p', {}, t('err.noruns')) : (() => { const found = checkAll(runs); return found.length ? list(found.map((x) => (x.run.tag || x.run.guid) + ' — ' + t('level.' + x.level) + ': ' + findingText(x))) : el('p', {}, t('done.spec.clean', { n: runs.length })); })());
      } } }, t('btn.spec')),
    ]);

    // isometric
    const isoSec = section(t('sec.iso'), [
      el('p', {}, t('iso.intro')),
      el('button', { type: 'button', class: 'btn-line btn-sm-cc', on: { click: async () => { try { download('isometric.svg', toSvg(await isoOf()), 'image/svg+xml'); } catch (e) { say(e.message); } } } }, t('btn.iso.svg')), ' ',
      el('button', { type: 'button', class: 'btn-line btn-sm-cc', on: { click: async () => { try { download('isometric.dxf', toDxf(await isoOf()), 'application/dxf'); } catch (e) { say(e.message); } } } }, t('btn.iso.dxf')), ' ',
      el('button', { type: 'button', class: 'btn-line btn-sm-cc', on: { click: async () => { try { const runs = await selectedRuns(); if (!runs.length) throw new Error(t('err.noruns')); const b = bom(runs.map((r) => ({ ...r, spec: specFor(specs(), r.mat, r.cls)?.id })), stored('units', 'mm')); download('bill-of-materials.csv', '﻿' + csv([b.columns, ...b.rows]), 'text/csv'); } catch (e) { say(e.message); } } } }, t('btn.bom')),
    ]);

    // routing between two ports of the model
    let routeSec = null;
    if (hasMep()) {
      let ports = [];
      try { ports = api.mep.ports().filter((p) => Array.isArray(p.at) && Array.isArray(p.out) && p.out.some((c) => Math.abs(Math.abs(c) - 1) < 1e-6)); } catch { ports = []; }
      const sel = (name) => el('select', { name, class: 'select-cc', 'aria-label': t('route.' + name), style: 'width:100%' }, ...ports.map((p, i) => el('option', { value: String(i) }, portLabel(p))));
      const from = sel('from'), to = sel('to');
      const specSel = el('select', { name: 'spec', class: 'select-cc', 'aria-label': t('route.spec'), style: 'width:100%' }, ...specs().map((s2) => el('option', { value: s2.id }, s2.id + ' — ' + s2.name)));
      const size = el('input', { type: 'text', name: 'size', value: '2', 'aria-label': t('route.size'), style: 'width:4rem' });
      if (ports.length > 1) to.selectedIndex = 1;
      routeSec = section(t('sec.route'), [
        el('p', {}, ports.length < 2 ? t('route.few') : t('route.intro')),
        ports.length < 2 ? null : el('div', { style: 'display:grid;gap:0.25rem' }, el('label', {}, t('route.from'), from), el('label', {}, t('route.to'), to), el('label', {}, t('route.spec'), specSel), el('label', {}, t('route.size'), ' ', size)),
        ports.length < 2 ? null : el('button', { type: 'button', class: 'btn-line btn-sm-cc', 'data-plant-route': '', on: { click: () => {
          const a = ports[Number(from.value)], b = ports[Number(to.value)];
          if (!a || !b || a === b) { out.replaceChildren(el('p', {}, t('route.same'))); return; }
          const r = findRoute(a, b, specSel.value, size.value.trim());
          if (!r.ok) { out.replaceChildren(el('p', {}, t('route.err.' + r.error))); return; }
          lastRoute = { ...r, a, b };
          out.replaceChildren(el('p', {}, t('route.found', { len: Math.round(r.length), bends: r.bends, climbs: r.climbs })), list(r.points.map((p) => p.map((v) => Math.round(v)).join(', '))),
            el('p', { class: 'plant-note' }, t('route.nowrite')));
        } } }, t('btn.route')),
      ]);
    }
    const writeNote = el('p', { class: 'plant-note' }, typeof api.model.write === 'function' ? t('note.write.yes') : t('need.write'));
    pane.append(el('p', {}, t('plant.intro')), eqSec, ...(routeSec ? [routeSec] : []), specSec, isoSec, layoutSec, out, writeNote);
  }

  api.log('Plant ready');   // i18n-ignore (developer log)
}
