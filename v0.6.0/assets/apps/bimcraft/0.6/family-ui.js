/* SPDX-License-Identifier: Apache-2.0 */
/**
 * family-ui.js — families on screen (0.6 DC.114, session bim-families_PART_2), through model-ui.js `extend()`:
 *   Project browser › Families  [data-pb-group="families"]: the file's families ([data-pb-family=<key>]: its sizes, how many are
 *                 placed; other programs' types grouped by a guess, marked so), the starter families ([data-pb-starter=<key>]),
 *                 New family [data-pb-famnew], Open a family file [data-pb-famopen], Place family [data-pb-famplace].
 *   Family dialog [data-fam-dialog]: its sizes ([data-fam-size=<type GlobalId>]: Select [data-fam-select], Rename
 *                 [data-fam-rename], Remove [data-fam-remove]), New size from this family [data-fam-newsize] (its parameters,
 *                 a name), Duplicate [data-fam-dup], Edit the family [data-fam-edit] (family-editor.js), Place [data-fam-place],
 *                 Save the family file [data-fam-file], Save as IFC [data-fam-ifc], Remove the family [data-fam-delete].
 *   New family    dialog [data-fam-newdlg]: name, what it is, for doors / windows the starter it takes its plan symbol from.
 *   Place family  tool [data-mtool="family"] (a row [data-mopts="family"]: family, size, turn): click on the plan places the size
 *                 on the level; R turns it 90°. Picked family elements: Properties (size, where, turn), Delete.
 * Doors and windows choose their family and size in the Door / Window tools and in Properties (model-ui.js).
 * The model side: family-model.js / family-ops.js. Test hook: window.bimcraftFamilies = { state, api }.
 */
import { readFamilies, readFamilyElements, unhostedFamilies, newSize, renameSize, removeSizes, duplicateFamily, newFamily, importFamilies, removeFamily,
  placeFamily, setFamilySize, moveFamilyElement, removeFamilyElements, familyFile, familyWriter, saveFamily } from './family-ops.js';
import { familyFor, evaluateFamily, inputParams, sizeValues, planBounds, newFamilyKey } from './family-model.js';
import { STARTER_KEYS, starterRecipe } from './family-starters.js';
import { DOOR_TYPES, WINDOW_TYPES, openingTypeName } from './opening-types.js';
import { familyScratch } from './family-ifc.js';
import { openFamilyEditor } from './family-editor.js';
import { ModelWriter } from './model-write.js';
import { IfcModel } from './ifc-model.js';
import { fmtLen, parseLen } from './model-units.js';
import { el } from './ui-util.js';

const CSS = `
.bc-fam-dlg { width: min(46rem, calc(100vw - 2rem)); max-width: none; max-height: calc(100vh - 2rem); overflow: auto; }
.bc-fam-dlg table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm, .875rem); margin: .4rem 0; }
.bc-fam-dlg th, .bc-fam-dlg td { text-align: left; padding: .2rem .35rem; border-bottom: var(--pen-1, 1px) solid var(--line); vertical-align: middle; }
.bc-fam-dlg td.bc-fam-n { text-align: right; font-variant-numeric: tabular-nums; }
.bc-fam-dlg .bc-fam-acts { display: flex; flex-wrap: wrap; gap: .3rem; }
.bc-fam-dlg .bc-fam-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); gap: .3rem .75rem; margin: .3rem 0; }
.bc-fam-dlg .bc-fam-grid label { display: grid; gap: .1rem; font-size: var(--fs-sm, .875rem); }
.bc-fam-dlg .bc-fam-grid label.bc-fam-yn { display: flex; gap: .35rem; align-items: center; }
.bc-fam-dlg h3 { font-size: var(--fs-base, 1rem); margin: .8rem 0 .2rem; }
.bc-pb .bc-pb-guess { font-style: italic; }
`;

export function mountFamilies(modelUi) {
  if (typeof document !== 'undefined' && !document.getElementById('bc-fam-css')) { const st = document.createElement('style'); st.id = 'bc-fam-css'; st.textContent = CSS; document.head.append(st); }
  const R = { fams: [], elements: [], place: { key: 'fam-table', typeGuid: '', rot: 0, at: null }, dlg: null, scratch: null };
  let A = null;
  const t = (...a) => A.t(...a);
  const W = () => { const ed = A.ed(); if (!ed) return null; const w = new ModelWriter(ed.W, ed.api, ed.mid); familyWriter(w); return w; };
  const L = (mm) => fmtLen(mm, A.units());
  const icon = (c) => el('i', { className: 'bi ' + c, 'aria-hidden': 'true' });
  function read() {
    const w = W();
    if (!w) { R.fams = []; R.elements = []; return; }
    try { R.fams = readFamilies(w); R.elements = readFamilyElements(w); } catch (e) { console.error(e); R.fams = []; R.elements = []; }
  }
  const famOf = (key) => R.fams.find((f) => f.key === key) || null;
  const recipeOf = (key) => familyFor(W(), key) || starterRecipe(key);
  /** A size's values as people read them: lengths in their units, Yes / No, numbers. */
  function valuesText(fam, values) {
    if (!fam) return '';
    const v = sizeValues(fam, values);
    return inputParams(fam).map((p) => (p.label || p.key) + ' ' + (p.kind === 'length' ? L(v[p.key]) : p.kind === 'yesno' ? t(v[p.key] ? 'fam.yes' : 'fam.no') : p.kind === 'angle' ? v[p.key] + '°' : String(v[p.key]))).join(', ');
  }
  const sizeName = (fam, v) => (['Width', 'Height'].every((k) => k in v) ? L(v.Width) + ' × ' + L(v.Height) : inputParams(fam).filter((p) => p.kind === 'length').slice(0, 3).map((p) => L(v[p.key])).join(' × ') || fam.name);
  async function scratch() { if (!R.scratch) R.scratch = await familyScratch(A.ed().W, IfcModel); return R.scratch; }
  /** A refusal in words (a reason that is itself a key, as fam.err.atsize carries, is put in words too). */
  function msgOf(e) {
    if (!e?.key) return e ? String(e.message || e) : '';
    const fill = { ...(e.fill || {}) };
    if (typeof fill.why === 'string' && /^fam\.err\./.test(fill.why)) fill.why = t(fill.why, e.fill || {});
    return t(e.key, fill);
  }
  /** Run an op (one undo step); a refusal comes back as its message (dialogs stay open and show it). */
  function run(op, meta = {}) {
    let why = null, back = false;
    // a change that waited for the model to reload is refused later: its words go to the open dialog then
    A.commit(op, { ...meta, onError: (e) => { const m = msgOf(e); if (back) say(m); else why = m; } });
    back = true;
    return why;
  }
  const keysOf = (ids) => ids.map((id) => A.kb() + id);

  // ---------------------------------------------------------------------------------------------- the project browser
  function browserGroups({ group, row, small }) {
    const mine = R.fams.filter((f) => f.source !== 'guess'), guess = R.fams.filter((f) => f.source === 'guess');
    const rowOf = (f) => row({ 'data-pb-family': f.key, className: f.source === 'guess' ? 'bc-pb-go bc-pb-guess' : 'bc-pb-go' }, f.name, () => openFamily(f.key),
      el('span', { className: 'bc-pb-tag' }, t('fam.pb.sizes', { n: f.sizes.length, placed: f.count })));
    const startersLeft = STARTER_KEYS.filter((k) => !mine.some((f) => f.key === k));
    const starters = el('li', {}, el('details', { 'data-pb-starters': '' }, el('summary', {}, t('fam.pb.starters') + ' (' + startersLeft.length + ')'),
      el('ul', {}, ...startersLeft.map((k) => row({ 'data-pb-starter': k }, starterRecipe(k).name, () => openFamily(k))))));
    const items = [...mine.map(rowOf), ...(guess.length ? [el('li', { className: 'bc-pb-tag' }, t('fam.pb.guessed', { n: guess.length }))] : []), ...guess.map(rowOf), starters];
    return [group('families', t('fam.pb.title'), mine.length + guess.length, items, [
      small({ 'data-pb-famnew': '' }, t('fam.new'), () => openNew(), 'bi-plus-lg'),
      small({ 'data-pb-famopen': '' }, t('fam.openfile'), () => openFile(), 'bi-folder2-open'),
      small({ 'data-pb-famplace': '' }, t('fam.place'), () => startPlace(R.place.key), 'bi-box'),
    ])];
  }

  // ---------------------------------------------------------------------------------------------- dialogs
  function dialog(attrs, title, body, buttons, onSubmit, wide = true) {
    const err = el('p', { className: 'bc-input-err', role: 'alert', 'data-fam-err': '' });
    const id = 'bc-' + Object.keys(attrs)[0] + '-h';
    const dlg = el('dialog', { className: 'bc-dialog' + (wide ? ' bc-fam-dlg' : ''), 'aria-labelledby': id, ...attrs },
      el('form', { method: 'dialog' }, el('h2', { className: 'bc-h', id }, title), el('div', { 'data-fam-body': '' }, ...body), err, el('p', { className: 'bc-lib-actions' }, ...buttons)));
    dlg.querySelector('form').addEventListener('submit', (e) => { const why = onSubmit(e.submitter?.value, e); if (why) { e.preventDefault(); err.textContent = why; } });
    dlg.addEventListener('close', () => { dlg.remove(); if (R.dlg?.el === dlg) R.dlg = null; });
    A.root.append(dlg);
    dlg.showModal();
    return dlg;
  }
  const btn = (value, label, attrs = {}, primary = false) => el('button', { type: 'submit', className: (primary ? 'btn-plot' : 'btn-line') + ' btn-sm-cc', value, ...attrs }, label);
  const small = (attrs, label, onClick, ic) => { const b = el('button', { type: 'button', className: 'btn-line btn-sm-cc', ...attrs }, ic ? icon(ic) : null, ic ? ' ' + label : label); b.addEventListener('click', onClick); return b; };
  const say = (text) => { const e = R.dlg?.el?.querySelector('[data-fam-err]'); if (e) e.textContent = text || ''; else if (text) A.host.status(text, true); };

  /** Inputs for a family's input parameters, filled from `values`; value() → values or null (a length that does not read). */
  function paramInputs(fam, values, attr) {
    const v = sizeValues(fam, values), ins = [];
    const box = el('div', { className: 'bc-fam-grid' });
    for (const p of inputParams(fam)) {
      let i;
      if (p.kind === 'yesno') { i = el('input', { type: 'checkbox', [attr]: p.key }); i.checked = !!v[p.key]; box.append(el('label', { className: 'bc-fam-yn' }, i, p.label || p.key)); }
      else { i = el('input', { type: 'text', className: 'bc-input bc-num', [attr]: p.key, value: p.kind === 'length' ? L(v[p.key]) : String(v[p.key]), size: 9 }); box.append(el('label', {}, el('span', {}, (p.label || p.key) + (p.kind === 'angle' ? ' (°)' : '')), i)); }
      ins.push([p, i]);
    }
    const value = () => {
      const out = {};
      for (const [p, i] of ins) {
        if (p.kind === 'yesno') { out[p.key] = i.checked ? 1 : 0; continue; }
        const n = p.kind === 'length' ? parseLen(i.value, A.units()) : Number(String(i.value).replace(',', '.'));
        if (!Number.isFinite(n)) return null;
        out[p.key] = n;
      }
      return out;
    };
    return { box, value };
  }

  function openFamily(key) {
    const draw = () => {
      const f = famOf(key), fam = f?.fam || recipeOf(key);
      if (!fam && !f) return null;
      const editable = !f || f.source !== 'guess';
      const sizes = f?.sizes || [];
      const rows = sizes.map((z) => el('tr', { 'data-fam-size': z.guid || 'legacy' },
        el('td', {}, z.name, z.legacy ? el('span', { className: 'bc-muted' }, ' ' + t('fam.legacy')) : null),
        el('td', { className: 'bc-muted' }, editable ? valuesText(fam, z.values) : ''),
        el('td', { className: 'bc-fam-n' }, String(z.count)),
        el('td', {}, el('span', { className: 'bc-fam-acts' },
          z.count ? small({ 'data-fam-select': '' }, t('fam.select'), () => { R.dlg?.el?.close(); A.host.select(keysOf(z.elements)); }) : null,
          editable && z.guid ? small({ 'data-fam-rename': '' }, t('fam.rename'), () => renameDialog(z)) : null,
          editable && z.guid && !z.count ? small({ 'data-fam-remove': '' }, t('fam.remove'), () => say(run(removeSizes([z.guid]), { label: z.name, verb: t('model.verb.deleted') }))) : null))));
      const body = [];
      body.push(el('p', { className: 'bc-muted', 'data-fam-about': '' }, f?.source === 'guess' ? t('fam.guess.' + (f.how || 'numbers')) : t(fam.host === 'wall' ? 'fam.about.hosted' : 'fam.about.free', { base: fam.base ? openingTypeName(DOOR_TYPES.concat(WINDOW_TYPES).find((x) => x.key === fam.base)) : '' })));
      body.push(sizes.length ? el('table', { 'data-fam-sizes': '' }, el('thead', {}, el('tr', {}, el('th', {}, t('fam.size')), el('th', {}, t('fam.values')), el('th', { className: 'bc-fam-n' }, t('fam.placed')), el('th', {}, ''))), el('tbody', {}, ...rows))
        : el('p', { className: 'bc-muted' }, t('fam.nosizes')));
      if (editable && fam) {
        const P = paramInputs(fam, sizes.find((z) => z.guid)?.values || {}, 'data-fam-nv');
        const nm = el('input', { type: 'text', className: 'bc-input', 'data-fam-nvname': '', maxLength: 80, placeholder: t('fam.size.autoname') });
        const make = small({ 'data-fam-newsize': '' }, t('fam.newsize'), () => {
          const v = P.value();
          if (!v) { say(t('model.err.length')); return; }
          say(run(newSize(key, { name: nm.value.trim() || sizeName(fam, v), values: v }), { label: fam.name, verb: t('model.verb.made') }));
        }, 'bi-plus-lg');
        body.push(el('h3', {}, t('fam.newsize.h')), P.box, el('p', { className: 'bc-fam-acts' }, el('label', { className: 'bc-dlg-field' }, el('span', {}, t('fam.size.name')), nm), make));
      }
      return { body, fam, f, editable };
    };
    const first = draw();
    if (!first) return;
    const { fam, f, editable } = first;
    const buttons = [];
    if (editable) {
      buttons.push(btn('edit', t('fam.edit'), { 'data-fam-edit': '' }, true), btn('dup', t('fam.dup'), { 'data-fam-dup': '' }));
      if (fam.host !== 'wall') buttons.push(btn('place', t('fam.place'), { 'data-fam-place': '' }));
      buttons.push(btn('file', t('fam.file'), { 'data-fam-file': '' }), btn('ifc', t('fam.ifc'), { 'data-fam-ifc': '' }));
      if (f?.source === 'project' && !f.count) buttons.push(btn('delete', t('fam.delete'), { 'data-fam-delete': '' }));
    }
    buttons.push(btn('close', t('model.sh.close')));
    const dlg = dialog({ 'data-fam-dialog': key }, t('fam.dlg.title', { name: f?.name || fam.name }), first.body, buttons, (what, e) => {
      if (what === 'close' || !what) return null;
      if (what === 'edit') { setTimeout(() => editFamily(key), 0); return null; }
      if (what === 'place') { setTimeout(() => startPlace(key), 0); return null; }
      if (what === 'dup') { e.preventDefault(); dupDialog(key, fam); return null; }
      if (what === 'file') { e.preventDefault(); saveFile(key); return null; }
      if (what === 'ifc') { e.preventDefault(); saveIfc(key).catch((x) => say(String(x.message || x))); return null; }
      if (what === 'delete') return run(removeFamily(key), { label: fam.name, verb: t('model.verb.deleted') });
      return null;
    });
    R.dlg = { el: dlg, key, redraw: () => { const d = draw(); if (d) dlg.querySelector('[data-fam-body]').replaceChildren(...d.body); } };
  }
  function renameDialog(z) {
    const nm = el('input', { type: 'text', className: 'bc-input', 'data-fam-newname': '', value: z.name, maxLength: 80 });
    dialog({ 'data-fam-renamedlg': '' }, t('fam.rename.title', { name: z.name }), [el('label', { className: 'bc-dlg-field' }, el('span', {}, t('fam.size.name')), nm)],
      [btn('ok', t('fam.rename'), { 'data-fam-renameok': '' }, true), btn('cancel', t('model.gp.cancel'))],
      (what) => (what === 'ok' ? run(renameSize(z.guid, nm.value), { label: nm.value, verb: t('model.verb.changed') }) : null), false);
  }
  function dupDialog(key, fam) {
    const nm = el('input', { type: 'text', className: 'bc-input', 'data-fam-dupname': '', value: t('fam.dup.name', { name: fam.name }), maxLength: 80 });
    const newKey = newFamilyKey();
    dialog({ 'data-fam-dupdlg': '' }, t('fam.dup.title', { name: fam.name }), [el('p', { className: 'bc-muted' }, t('fam.dup.note')), el('label', { className: 'bc-dlg-field' }, el('span', {}, t('fam.name')), nm)],
      [btn('ok', t('fam.dup'), { 'data-fam-dupok': '' }, true), btn('cancel', t('model.gp.cancel'))],
      (what) => {
        if (what !== 'ok') return null;
        const why = run(duplicateFamily(key, { name: nm.value.trim(), key: newKey }), { label: nm.value.trim(), verb: t('model.verb.made') });
        if (!why) { R.dlg?.el?.close(); setTimeout(() => openFamily(newKey), 0); }
        return why;
      }, false);
  }
  function openNew() {
    const nm = el('input', { type: 'text', className: 'bc-input', 'data-fam-newnm': '', maxLength: 80 });
    const kind = el('select', { className: 'select-cc', 'data-fam-newkind': '' }, ...['door', 'window', 'furniture', 'fixture', 'generic'].map((k) => el('option', { value: k }, t('fam.kind.' + k))));
    const base = el('select', { className: 'select-cc', 'data-fam-newbase': '' });
    const fillBase = () => { const list = kind.value === 'window' ? WINDOW_TYPES : DOOR_TYPES; base.replaceChildren(...list.map((x) => el('option', { value: x.key }, openingTypeName(x)))); base.closest('label').hidden = !['door', 'window'].includes(kind.value); };
    const baseL = el('label', { className: 'bc-dlg-field' }, el('span', {}, t('fam.base')), base);
    kind.addEventListener('change', fillBase);
    const key = newFamilyKey();
    dialog({ 'data-fam-newdlg': '' }, t('fam.new.title'), [el('p', { className: 'bc-muted' }, t('fam.new.note')), el('label', { className: 'bc-dlg-field' }, el('span', {}, t('fam.name')), nm),
      el('label', { className: 'bc-dlg-field' }, el('span', {}, t('fam.kind')), kind), baseL],
      [btn('ok', t('fam.new.ok'), { 'data-fam-newok': '' }, true), btn('cancel', t('model.gp.cancel'))],
      (what) => {
        if (what !== 'ok') return null;
        const name = nm.value.trim();
        if (!name) return t('fam.err.name');
        const hosted = ['door', 'window'].includes(kind.value);
        const why = run(newFamily({ name, kind: kind.value, host: hosted ? 'wall' : 'none', base: hosted ? base.value : '', key }), { label: name, verb: t('model.verb.made') });
        if (!why) setTimeout(() => editFamily(key), 0);
        return why;
      }, false);
    fillBase();
  }
  function openFile() {
    const input = el('input', { type: 'file', accept: '.ccfamily.json,.json,.ifc', hidden: true, 'data-fam-fileinput': '' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let list;
        if (/\.ifc$/i.test(file.name)) list = await (await scratch()).familiesIn(bytes);
        else { try { list = [JSON.parse(new TextDecoder().decode(bytes))]; } catch (e) { A.host.status(t('fam.err.notfamily'), true); return; } }
        if (!list.length) { A.host.status(t('fam.err.nonein'), true); return; }
        const keys = list.map(() => newFamilyKey());
        const why = run(importFamilies(list, { keys }), { label: list.length === 1 ? String(list[0]?.name || file.name) : file.name, verb: t('model.verb.made') });
        if (why) A.host.status(why, true); else { A.host.status(t('fam.opened', { n: list.length })); if (list.length === 1) setTimeout(() => openFamily(keys[0]), 0); }
      } catch (e) { A.host.status(t('fam.err.read', { why: e.message || e }), true); }
    });
    A.root.append(input);
    input.click();
  }
  const baseName = (key) => String(familyFile(W(), key)?.name || key).replace(/[\\/:*?"<>|]+/g, ' ').trim();
  function saveFile(key) {
    const file = familyFile(W(), key);
    if (!file) return;
    A.host.download(baseName(key) + '.ccfamily.json', new TextEncoder().encode(JSON.stringify(file, null, 2) + '\n'), 'application/json');
  }
  async function saveIfc(key) {
    const file = familyFile(W(), key);
    if (!file) return;
    const bytes = await (await scratch()).library(file);
    A.host.download(baseName(key) + ' ' + t('fam.ifc.suffix') + '.ifc', bytes, 'application/x-step');
  }

  /** Every family in one dialog (the toolbar's Families…): the same list as the project browser's group. */
  function openList() {
    read();
    const draw = () => {
      const mine = R.fams.filter((f) => f.source !== 'guess'), guess = R.fams.filter((f) => f.source === 'guess');
      const rowOf = (f) => el('tr', { 'data-famlist-row': f.key, className: f.source === 'guess' ? 'bc-pb-guess' : null },
        el('td', {}, f.name, f.source === 'guess' ? el('span', { className: 'bc-muted' }, ' ' + t('fam.list.guessed')) : f.source === 'starter' ? el('span', { className: 'bc-muted' }, ' ' + t('fam.list.starter')) : null),
        el('td', { className: 'bc-fam-n' }, String(f.sizes.length)), el('td', { className: 'bc-fam-n' }, String(f.count)),
        el('td', {}, small({ 'data-famlist-open': f.key }, t('fam.open'), () => { R.dlg?.el?.close(); setTimeout(() => openFamily(f.key), 0); })));
      const startersLeft = STARTER_KEYS.filter((k) => !mine.some((f) => f.key === k));
      return [
        R.fams.length ? el('table', { 'data-famlist': '' }, el('thead', {}, el('tr', {}, el('th', {}, t('fam.family')), el('th', { className: 'bc-fam-n' }, t('fam.list.sizes')), el('th', { className: 'bc-fam-n' }, t('fam.placed')), el('th', {}, ''))),
          el('tbody', {}, ...mine.map(rowOf), ...guess.map(rowOf))) : el('p', { className: 'bc-muted' }, t('fam.list.none')),
        guess.length ? el('p', { className: 'bc-muted' }, t('fam.list.guessnote')) : null,
        el('details', { 'data-famlist-starters': '' }, el('summary', {}, t('fam.pb.starters') + ' (' + startersLeft.length + ')'),   // i18n-ignore: a count in brackets
          el('p', { className: 'bc-fam-acts' }, ...startersLeft.map((k) => small({ 'data-famlist-starter': k }, starterRecipe(k).name, () => { R.dlg?.el?.close(); setTimeout(() => openFamily(k), 0); })))),
        el('p', { className: 'bc-fam-acts' },
          small({ 'data-famlist-new': '' }, t('fam.new'), () => { R.dlg?.el?.close(); setTimeout(openNew, 0); }, 'bi-plus-lg'),
          small({ 'data-famlist-file': '' }, t('fam.openfile'), () => { R.dlg?.el?.close(); openFile(); }, 'bi-folder2-open'),
          small({ 'data-famlist-place': '' }, t('fam.place'), () => startPlace(R.place.key), 'bi-box')),
      ];
    };
    const dlg = dialog({ 'data-famlist-dialog': '' }, t('fam.list.title'), draw(), [btn('close', t('model.sh.close'))], () => null);
    R.dlg = { el: dlg, key: null, redraw: () => dlg.querySelector('[data-fam-body]').replaceChildren(...draw()) };
  }

  // ---------------------------------------------------------------------------------------------- the editor
  function editFamily(key) {
    const fam = recipeOf(key);
    if (!fam) return;
    const f = famOf(key);
    const values = f?.sizes.find((z) => z.guid || z.legacy)?.values || sizeValues(fam, {});
    openFamilyEditor({
      root: A.root, t, units: () => A.units(), recipe: JSON.parse(JSON.stringify(fam)), values, starter: !!fam.starter, scratch,
      // a starter edited here is kept in this file under its key: other files keep the starter as it is
      onSave: (recipe) => run(saveFamily(recipe), { label: recipe.name, verb: t('model.verb.changed') }),
      onClose: () => { read(); R.dlg?.redraw(); },
    });
  }

  // ---------------------------------------------------------------------------------------------- placing
  function startPlace(key) {
    if (key) R.place.key = key;
    R.dlg?.el?.close();
    if (!modelUi.on) modelUi.show(true);
    A.setTool('family');
  }
  function placeRow() {
    let row = A.root.querySelector('[data-mopts="family"]');
    if (row) return row;
    const anchor = A.root.querySelector('[data-mopts="door"]');
    if (!anchor) return null;
    const fam = el('select', { className: 'bc-mb-select', 'data-fam-pfam': '', 'aria-label': t('fam.family') });
    const size = el('select', { className: 'bc-mb-select', 'data-fam-psize': '', 'aria-label': t('fam.size') });
    const turn = el('button', { type: 'button', className: 'bc-tool', 'data-fam-pturn': '', title: t('fam.turn.title') }, icon('bi-arrow-clockwise'), el('span', {}, t('fam.turn')));
    fam.addEventListener('change', () => { R.place.key = fam.value; R.place.typeGuid = ''; fillPlace(); A.drawOverlay(); });
    size.addEventListener('change', () => { R.place.typeGuid = size.value; A.drawOverlay(); });
    turn.addEventListener('click', () => { R.place.rot = (R.place.rot + 90) % 360; A.drawOverlay(); });
    row = el('div', { className: 'bc-modelbar-row', 'data-mopts': 'family', hidden: true },
      el('label', {}, el('span', { className: 'visually-hidden' }, t('fam.family')), fam), el('label', {}, el('span', { className: 'visually-hidden' }, t('fam.size')), size), turn);
    anchor.parentNode.insertBefore(row, anchor);
    return row;
  }
  function fillPlace() {
    const row = placeRow();
    if (!row) return;
    row.hidden = A.S.tool !== 'family';   // made on the tool's first use, after model-ui.js hid the other rows
    const list = unhostedFamilies(W());
    if (!list.some((f) => f.key === R.place.key)) R.place.key = list[0]?.key || '';
    const fam = row.querySelector('[data-fam-pfam]'), size = row.querySelector('[data-fam-psize]');
    fam.replaceChildren(...list.map((f) => el('option', { value: f.key, selected: f.key === R.place.key }, f.name)));
    const sizes = famOf(R.place.key)?.sizes.filter((z) => z.guid) || [];
    if (!sizes.some((z) => z.guid === R.place.typeGuid)) R.place.typeGuid = sizes[0]?.guid || '';
    size.replaceChildren(...(sizes.length ? [] : [el('option', { value: '' }, t('fam.size.default'))]), ...sizes.map((z) => el('option', { value: z.guid, selected: z.guid === R.place.typeGuid }, z.name)));
  }
  /** The outline the placed size will have on the plan: its solids' plan bounds, turned, at p. */
  function ghost(p) {
    const fam = recipeOf(R.place.key);
    if (!fam) return [];
    const z = famOf(R.place.key)?.sizes.find((q) => q.guid === R.place.typeGuid);
    const ev = evaluateFamily(fam, z?.values || {}, {});
    if (!ev.ok) return [];
    const a = R.place.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), out = [];
    for (const sol of ev.solids.values()) {
      if (!sol.visible) continue;
      const b = planBounds(sol);
      if (!b) continue;
      const pts = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(([x, y]) => [p[0] + x * c - y * s, p[1] + x * s + y * c]);
      for (let i = 0; i < 4; i++) out.push([...pts[i], ...pts[(i + 1) % 4]]);
    }
    return out;
  }
  function placeAt(p) {
    const lv = A.level();
    if (!lv) return;
    const fam = recipeOf(R.place.key);
    if (!fam) return;
    const why = run(placeFamily({ storey: lv.guid, family: R.place.key, typeGuid: R.place.typeGuid || null, x: p[0], y: p[1], rot: R.place.rot }), { label: fam.name, verb: t('model.verb.placed') });
    if (why) A.host.status(why, true);
  }

  // ---------------------------------------------------------------------------------------------- picked family elements
  function pick(key) {
    const id = key - A.kb(), e = R.elements.find((x) => x.id === id);
    if (!e) return null;
    return { kind: 'family', guid: e.guid, id, label: famOf(e.family)?.name || e.family, e };
  }
  function props(items, kit) {
    const els = items.map((i) => i.e), fam0 = els[0].family;
    const same = els.every((e) => e.family === fam0), f = famOf(fam0);
    const title = items.length > 1 ? t('model.elements', { n: items.length }) : (f?.name || fam0);
    const meta = { label: title, verb: t('model.verb.changed'), select: kit.keys };
    if (same && f) {
      const sz = f.sizes.filter((z) => z.guid), one = els.every((e) => e.typeId === els[0].typeId);
      const opts = sz.map((z) => [z.guid, z.name]);
      if (!one) opts.unshift(['', t('fam.size.pick')]);
      kit.field(t('fam.size'), kit.select(opts, one ? (sz.find((z) => z.typeId === els[0].typeId)?.guid || '') : '', 'data-mp-famsize', (v) => { if (v) A.commit(setFamilySize(els.map((e) => e.guid), v), meta); }));
    }
    if (items.length === 1) {
      const e = els[0];
      kit.field('X', kit.lenInput(e.x, 'data-mp-famx', (mm) => A.commit(moveFamilyElement(e.guid, { x: mm }), meta), { any: true }));
      kit.field('Y', kit.lenInput(e.y, 'data-mp-famy', (mm) => A.commit(moveFamilyElement(e.guid, { y: mm }), meta), { any: true }));
      const r = el('input', { type: 'text', className: 'bc-input bc-num', value: String(Math.round(e.rot * 100) / 100), 'data-mp-famrot': '', size: 6 });
      r.addEventListener('change', () => { const v = Number(r.value.replace(',', '.')); if (Number.isFinite(v)) A.commit(moveFamilyElement(e.guid, { rot: v }), meta); else r.value = String(e.rot); });
      kit.field(t('fam.turn.deg'), r);
    }
    if (same) kit.field(t('fam.family'), kit.button(t('fam.open'), 'data-mp-famopen', () => openFamily(fam0)));
    return { title };
  }

  A = modelUi.extend({
    tools: ['family'],
    hint: () => 'fam.hint.place',
    typed: () => false,
    classes: /^Ifc(Furniture|FurnishingElement|BuildingElementProxy|SanitaryTerminal|LightFixture|FlowTerminal)$/,
    move(p) { if (A.S.tool === 'family') R.place.at = p; },
    click(p) { if (A.S.tool === 'family') placeAt(p); },
    key(e, low) { if (A.S.tool === 'family' && low === 'r' && !e.ctrlKey && !e.metaKey) { R.place.rot = (R.place.rot + 90) % 360; A.drawOverlay(); return true; } return false; },
    escape() { return false; },
    toolChanged(name) { R.place.at = null; if (name === 'family') fillPlace(); },
    overlay(o) { if (A.S.tool === 'family' && R.place.at) { o.lines.push(...ghost(R.place.at)); o.snap = { p: R.place.at, kind: 'free' }; } },
    refresh() { read(); if (A.S.tool === 'family') fillPlace(); R.dlg?.redraw(); },
    browserGroups,
    pick, props,
    remove(items) { return removeFamilyElements(items.map((i) => i.guid)); },
    openFamily,
  });
  for (const b of A.root.querySelectorAll('[data-fam-list]')) b.addEventListener('click', () => { b.closest('details')?.removeAttribute('open'); if (!A.ed()) { A.host.status(t('model.needs.ifc')); return; } openList(); });
  const api = { openFamily, editFamily, openNew, openList, openFile, startPlace, saveFile, saveIfc, read };
  if (typeof window !== 'undefined') window.bimcraftFamilies = { state: R, api };   // for tests
  return api;
}
