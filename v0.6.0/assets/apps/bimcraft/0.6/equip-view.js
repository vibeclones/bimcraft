/* SPDX-License-Identifier: Apache-2.0 */
/**
 * equip-view.js — draws the equipment list (dwg-equipment.js) as a schedule: pick which sheet's
 * equipment to list, filter by any word, download CSV, and jump to an item on the drawing.
 * All text from the drawing goes in through el() (text nodes).
 *
 *   renderEquipment(container, list, { sheetName(key), onShow(row), onCsv(rows, label, pick), intro, sheetWord })
 *   sheetWord picks the wording, not text: 'sheet' (drawings) or 'storey' (IFC models).
 */
import { el, num } from './ui-util.js';
import { t } from "./i18n.js";

const ALL = 'all', OFF = 'off', EVERY = 'every';

export function renderEquipment(container, list, { sheetName, onShow, onCsv, intro = null, sheetWord = 'sheet' }) {
  const storey = sheetWord === 'storey';
  const choices = [
    ...(list.sheets.length > 1 ? [[ALL, storey ? t('equip.every.storey') : t('equip.every.sheet'), list.rows.filter((r) => r.sheets.length).length]] : []),
    ...list.sheets.map((s) => [s.key, s.name, s.count]),
    ...(list.offSheet ? [[OFF, storey ? t('equip.off.storey') : t('equip.off.sheet'), list.offSheet]] : []),
    ...(intro ? [] : [[EVERY, t('equip.everything'), list.rows.length]]),
  ];
  let pick = choices[0][0], query = '';

  const select = el('select', { className: 'select-cc', id: 'bc-equip-on', 'aria-label': t('equip.which') },
    choices.map(([v, label, n]) => el('option', { value: v }, t('equip.option', { label, count: num(n) }))));
  const search = el('input', { type: 'search', className: 'bc-equip-search', placeholder: t('equip.filter.placeholder'), 'aria-label': t('equip.filter.label') });
  const csv = el('button', { type: 'button', className: 'btn-line btn-sm-cc', onClick: () => onCsv(shown(), labelOf(pick), pick) },
    el('i', { className: 'bi bi-filetype-csv', 'aria-hidden': 'true' }), ' ' + t('qto.csv'));
  const count = el('p', { className: 'bc-muted bc-equip-count', 'aria-live': 'polite' });
  const body = el('tbody');
  const note = el('p', { className: 'bc-muted bc-equip-note' });

  const labelOf = (v) => choices.find((c) => c[0] === v)[1];
  const inPick = (r) => pick === EVERY || (pick === ALL ? r.sheets.length > 0 : pick === OFF ? !r.sheets.length : r.sheets.includes(pick));
  const words = () => query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (r) => [r.no, r.category, r.mfr, r.model, r.remark, r.elecText, r.plumbText].join(' ').toLowerCase();
  const shown = () => { const w = words(); return list.rows.filter((r) => inPick(r) && w.every((x) => hay(r).includes(x))); };

  function draw() {
    const rows = shown();
    count.textContent = t(query ? 'equip.count.match' : 'equip.count', { n: rows.length, count: num(rows.length), query });
    body.replaceChildren(...rows.map((r) => el('tr', { className: r.clash ? 'is-clash' : '' },
      el('th', { scope: 'row', 'data-label': t('equip.col.item') }, r.no),
      el('td', { 'data-label': t('equip.col.qty'), className: 'is-num' }, r.qty, r.qtys.length > 1 ? el('span', { className: 'bc-sub' }, r.qtys.join(' + ')) : null),
      el('td', { 'data-label': t('ui.equipment') }, r.category || '—',
        r.clash ? el('span', { className: 'bc-pill is-warn bc-equip-clash' }, t('equip.clash')) : null,
        r.remark ? el('span', { className: 'bc-sub' }, r.remark) : null),
      el('td', { 'data-label': t('equip.col.manufacturer') }, r.mfr),
      el('td', { 'data-label': t('equip.col.model') }, r.model),
      el('td', { 'data-label': t('equip.col.electrical') }, r.elecText, r.elRemark ? el('span', { className: 'bc-sub' }, r.elRemark) : null),
      el('td', { 'data-label': t('equip.col.plumbing') }, r.plumbText, r.plRemark ? el('span', { className: 'bc-sub' }, r.plRemark) : null),
      el('td', { 'data-label': t('equip.col.where') },
        el('button', { type: 'button', className: 'bc-linkbtn', title: t('equip.show.title', { no: r.no }), onClick: () => onShow(r) },
          r.sheets.length ? r.sheets.map(sheetName).join(', ') : t('equip.modelonly')),
        r.places.length > 1 ? el('span', { className: 'bc-sub' }, t('equip.tags', { n: r.places.length, count: num(r.places.length) })) : null),
    )));
    csv.disabled = !rows.length;
  }

  select.addEventListener('change', () => { pick = select.value; draw(); });
  search.addEventListener('input', () => { query = search.value.trim(); draw(); });

  const parts = [];
  if (list.offSheet) parts.push(t('equip.offsheet.note', { n: list.offSheet, count: num(list.offSheet) }));
  if (list.rows.some((r) => r.clash)) parts.push(t('equip.clash.note'));
  parts.push(t('equip.fields.note'));
  note.textContent = parts.join(' ');

  container.replaceChildren(
    el('div', { className: 'bc-equip-head' },
      el('p', { className: 'bc-card-kind' }, t('ui.equipment')),
      el('h1', {}, t('equip.title')),
      el('p', { className: 'bc-muted' }, intro || t('equip.intro', { n: list.tags, count: num(list.tags) }))),
    el('div', { className: 'bc-equip-tools' },
      el('label', { className: 'visually-hidden', for: 'bc-equip-on' }, t('equip.which')), select, search, csv),
    count,
    el('div', { className: 'bc-equip-scroll' },
      el('table', { className: 'bc-ftable bc-equip-table' },
        el('thead', {}, el('tr', {}, [t('equip.col.item'), t('equip.col.qty'), t('ui.equipment'), t('equip.col.manufacturer'), t('equip.col.model'),
          t('equip.col.electrical'), t('equip.col.plumbing'), t('equip.col.where')].map((h) => el('th', { scope: 'col' }, h)))),
        body)),
    note);
  draw();
}
