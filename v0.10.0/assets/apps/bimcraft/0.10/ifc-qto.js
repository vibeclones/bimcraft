/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ifc-qto.js — quantity totals grouped by properties, and their CSV (0.4 B20). No DOM: bin/test-bimcraft.mjs --qto runs it.
 *
 *   totals(ix, { keys, groupBy: [fieldId…], sum: [fieldId…] })
 *     → { groupBy, sum, rows: [{ values: [v…], count, sums: [n…], counted: [n…] }], total: { count, sums, counted } }
 *   keys: element keys to count (default every element with a shape: ix.ids); groupBy: up to MAX_GROUP fields (built-ins
 *   or 'p:<set>.<name>'); sum: number fields. A row per distinct combination of the group values (no value = ''), sorted
 *   by those values (numbers as numbers). `counted[i]` = how many of the row's elements had a number for sum[i]: an element
 *   without one adds nothing, and the CSV says how many were left out.
 *   totalsCsv(result, { label(fieldId) → header, countLabel, totalLabel, leftOut(header) → header }) → text (no BOM: the page adds it; formula-looking cells get a leading ').
 *   quantityFields(ix) → the number fields, quantity sets (Qto_…, BaseQuantities) first.
 *
 * Schedules (0.4 B10): one row per element or per space.
 *   elementRows(ix, { keys, columns }) → { columns, rows: [{ key, values }] }   sorted by the columns in order
 *   spaceSchedule(ix, model, { keys }) → { rows: [{ key, number, name, storey, area, areaFrom, volume, volumeFrom }],
 *     total: { count, area, volume } }   number = Name, name = Long name; area / volume from the space's quantity set
 *     (Net… before Gross…, any set — Qto_SpaceBaseQuantities, BaseQuantities) as the file states them, else measured from
 *     its shape in m² / m³ (areaFrom / volumeFrom 'file' | 'shape'): floor = the downward faces seen from below, volume =
 *     the closed shell's signed volume.
 *   tableCsv(head, rows) → text (no BOM), cells escaped as in totalsCsv.
 */

export const MAX_GROUP = 3;

const cmp = (a, b) => {
  if (a === b) return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
};
/** Rounds away binary noise (0.1 + 0.2) without hiding real digits. */
export const tidy = (n) => (Number.isFinite(n) ? Number(n.toPrecision(12)) : n);

export function totals(ix, { keys = null, groupBy = ['cls'], sum = [] } = {}) {
  const kb = ix.keyBase;
  const known = keys ? new Set(ix.ids) : null;
  const ids = keys ? [...new Set([...keys].map((k) => k - kb))].filter((id) => known.has(id)) : ix.ids;
  const gv = groupBy.slice(0, MAX_GROUP).map((f) => ix.values(f)), sv = sum.map((f) => ix.values(f));
  const rows = new Map();
  const total = { count: 0, sums: sum.map(() => 0), counted: sum.map(() => 0) };
  for (const id of ids) {
    const values = gv.map((m) => { const v = m.get(id); return v === undefined ? '' : v; });
    const k = JSON.stringify(values);
    let r = rows.get(k);
    if (!r) rows.set(k, (r = { values, count: 0, sums: sum.map(() => 0), counted: sum.map(() => 0) }));
    r.count++; total.count++;
    sv.forEach((m, i) => { const v = m.get(id); if (typeof v === 'number' && Number.isFinite(v)) { r.sums[i] += v; r.counted[i]++; total.sums[i] += v; total.counted[i]++; } });
  }
  const out = [...rows.values()].sort((a, b) => { for (let i = 0; i < a.values.length; i++) { const c = cmp(a.values[i], b.values[i]); if (c) return c; } return 0; });
  for (const r of out) r.sums = r.sums.map(tidy);
  total.sums = total.sums.map(tidy);
  return { groupBy: groupBy.slice(0, MAX_GROUP), sum: [...sum], rows: out, total };
}

const cell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = "'" + s;   // a negative number stays a number
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const csvLine = (l) => l.map(cell).join(',');
export const tableCsv = (head, rows) => [head, ...rows].map(csvLine).join('\r\n') + '\r\n';

export function elementRows(ix, { keys = null, columns = ['cls', 'name'] } = {}) {
  const kb = ix.keyBase, known = new Set(ix.ids);
  const ids = keys ? [...new Set([...keys].map((k) => k - kb))].filter((id) => known.has(id)) : ix.ids;
  const cols = columns.map((f) => ix.values(f));
  const rows = ids.map((id) => ({ key: kb + id, values: cols.map((m) => { const v = m.get(id); return v === undefined ? '' : v; }) }));
  rows.sort((a, b) => { for (let i = 0; i < a.values.length; i++) { const c = cmp(a.values[i], b.values[i]); if (c) return c; } return a.key - b.key; });
  return { columns: [...columns], rows };
}

/** Floor area (downward faces, projected) and volume (signed tetrahedra) of each key's triangles, viewer metres. */
function measureShapes(batches, want) {
  const out = new Map();
  for (const b of batches) {
    const E = b.elems, P = b.positions, I = b.indices;
    for (let r = 0; r < E.ids.length; r++) {
      const k = E.ids[r];
      if (!want.has(k)) continue;
      let m = out.get(k);
      if (!m) out.set(k, (m = { area: 0, volume: 0 }));
      for (let t = E.t0[r]; t < E.t0[r] + E.tn[r]; t++) {
        const a = I[t * 3] * 3, c1 = I[t * 3 + 1] * 3, c2 = I[t * 3 + 2] * 3;
        const ux = P[c1] - P[a], uy = P[c1 + 1] - P[a + 1], uz = P[c1 + 2] - P[a + 2];
        const vx = P[c2] - P[a], vy = P[c2 + 1] - P[a + 1], vz = P[c2 + 2] - P[a + 2];
        const ny = uz * vx - ux * vz, len = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx);
        if (len > 0 && ny / len < -0.5) m.area += -ny / 2;   // facing down: its area seen from below (viewer Y is up)
        m.volume += (P[a] * (P[c1 + 1] * P[c2 + 2] - P[c1 + 2] * P[c2 + 1]) - P[a + 1] * (P[c1] * P[c2 + 2] - P[c1 + 2] * P[c2]) + P[a + 2] * (P[c1] * P[c2 + 1] - P[c1 + 1] * P[c2])) / 6;
      }
    }
  }
  for (const m of out.values()) m.volume = Math.abs(m.volume);
  return out;
}

export function spaceSchedule(ix, model, { keys = null } = {}) {
  const kb = ix.keyBase, known = new Set(ix.ids);
  let ids = keys ? [...new Set([...keys].map((k) => k - kb))].filter((id) => known.has(id)) : ix.ids;
  ids = ids.filter((id) => ix.value('cls', id) === 'IfcSpace');
  const find = (re) => { const fs = ix.fields.filter((f) => f.kind === 'number' && re.test(f.id)); return fs.sort((a, b) => (/\.Net/.test(b.id) ? 1 : 0) - (/\.Net/.test(a.id) ? 1 : 0)); };
  const areaF = find(/\.(Net|Gross)FloorArea$/), volF = find(/\.(Net|Gross)Volume$/);
  const shapes = measureShapes(model.batches, new Set(ids.map((id) => kb + id)));
  const first = (fs, id) => { for (const f of fs) { const v = ix.value(f.id, id); if (typeof v === 'number') return v; } return undefined; };
  const rows = ids.map((id) => {
    const sh = shapes.get(kb + id), a = first(areaF, id), v = first(volF, id);
    return { key: kb + id, number: ix.value('name', id) ?? '', name: ix.value('longname', id) ?? '', storey: ix.value('storey', id) ?? '',
      // measured from float32 vertices: kept to 0.0001 m² / m³ (no more digits are real)
      area: a !== undefined ? a : sh ? Number(sh.area.toFixed(4)) : '', areaFrom: a !== undefined ? 'file' : sh ? 'shape' : '',
      volume: v !== undefined ? v : sh ? Number(sh.volume.toFixed(4)) : '', volumeFrom: v !== undefined ? 'file' : sh ? 'shape' : '' };
  });
  rows.sort((x, y) => cmp(x.storey, y.storey) || cmp(x.number, y.number));
  const sum = (f) => tidy(rows.reduce((s, r) => s + (typeof r[f] === 'number' ? r[f] : 0), 0));
  return { rows, total: { count: rows.length, area: sum('area'), volume: sum('volume') } };
}

/** CSV: group columns, Count, one column per sum (+ "<sum> left out" when some elements had no value), a total row. */
export function totalsCsv(res, { label = (f) => f, countLabel = 'Count', totalLabel = 'Total', leftOut = (h) => h + ' (left out)' } = {}) {   // i18n-ignore: defaults; the page passes translated words
  const gaps = res.sum.map((_, i) => res.total.counted[i] < res.total.count);
  const head = [...res.groupBy.map(label), countLabel];
  res.sum.forEach((f, i) => { head.push(label(f)); if (gaps[i]) head.push(leftOut(label(f))); });
  const line = (values, r) => {
    const a = [...values, r.count];
    res.sum.forEach((_, i) => { a.push(r.sums[i]); if (gaps[i]) a.push(r.count - r.counted[i]); });
    return a;
  };
  const lines = [head, ...res.rows.map((r) => line(r.values, r)), line([totalLabel, ...res.groupBy.slice(1).map(() => '')], res.total)];
  return lines.map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Number fields, quantity sets first (Qto_*, BaseQuantities), then the rest by name. */
export function quantityFields(ix) {
  const q = (f) => /^Qto_|BaseQuantities/i.test(f.group) ? 0 : 1;
  return ix.fields.filter((f) => f.kind === 'number').sort((a, b) => q(a) - q(b) || 0);
}
