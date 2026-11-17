/* SPDX-License-Identifier: Apache-2.0 */
/**
 * dwg-props.js — what Properties shows for an object picked in a drawing's 3D view (0.4 B2). No DOM: bin/test-bimcraft.mjs
 * runs it in Node. Reads the drawing model's own entity (cc-dwg readDwg / dxf-model.js; docs/DWG-LIB-SPEC.md) — never
 * the compiled 3D batches — so what it says is what the file says.
 *
 *   entityRows(e, { units }) → [{ key, value }]   key = a lang/en.json key (the page translates it), value = plain text
 *   attributeRows(e)         → [{ tag, value }]   a block reference's attribute values, in file order
 *   colorText(color)         → 'ByLayer' | 'ByBlock' | 'ACI 1' | '#rrggbb'
 *
 * Angles in the model are radians; shown in degrees. Lengths are drawing units (the units name is added to sizes).
 */

const num = (v) => {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  const s = a >= 1e5 ? v.toFixed(0) : a >= 100 ? v.toFixed(2) : v.toFixed(4);
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace(/^-0$/, '0');
};
const pt = (p) => (p ? [p.x, p.y, p.z ?? 0].map(num).join(', ') : '');
const deg = (r) => (Number.isFinite(r) ? num(r * 180 / Math.PI) + '°' : '');
const yes = (b) => (b ? 'dwg.yes' : 'dwg.no');

export function colorText(c) {
  if (!c) return 'ByLayer';
  if (c.rgb !== undefined) return '#' + (c.rgb >>> 0 & 0xffffff).toString(16).padStart(6, '0');
  if (c.index === 0) return 'ByBlock';
  if (c.index === 256 || c.index === undefined) return 'ByLayer';
  return 'ACI ' + c.index;   // i18n-ignore: AutoCAD Color Index, a technical name
}

export function attributeRows(e) {
  return (e.attribs || []).filter((a) => a && a.tag).map((a) => ({ tag: String(a.tag), value: String(a.value ?? '') }));
}

/** Rows for one entity. Values that are lang keys (yes/no) are marked { key, valueKey }. */
export function entityRows(e, { units = '', dyn = null } = {}) {
  const rows = [];
  const add = (key, value, extra = {}) => { if (value !== '' && value !== null && value !== undefined) rows.push({ key, value: String(value), ...extra }); };
  const len = (v) => (Number.isFinite(v) ? num(v) + (units ? ' ' + units : '') : '');
  add('dwg.prop.type', e.type === 'UNKNOWN' ? (e.dxfName || e.className || 'UNKNOWN') : e.type);
  add('dwg.prop.layer', e.layer || '0');
  add('dwg.prop.color', colorText(e.color));
  if (e.linetype) add('dwg.prop.linetype', e.linetype);
  add('dwg.prop.handle', e.handle);
  if (dyn) {   // 0.5 DB.11: a dynamic block reference (dwg-dynamic.js dynamicOf): its block, the state it shows, the others
    add('dwg.prop.dyn', dyn.name);
    if (dyn.states.length) {
      add('dwg.prop.dyn.state', dyn.state ?? 'dwg.dyn.unknown', dyn.state ? {} : { valueKey: true });
      add('dwg.prop.dyn.others', dyn.others.length ? dyn.others.join(', ') : 'dwg.dyn.none', dyn.others.length ? {} : { valueKey: true });
    }
  }
  switch (e.type) {
    case 'LINE':
      add('dwg.prop.start', pt(e.start)); add('dwg.prop.end', pt(e.end));
      if (e.start && e.end) add('dwg.prop.length', len(Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y, (e.end.z || 0) - (e.start.z || 0))));
      break;
    case 'CIRCLE': case 'ARC':
      add('dwg.prop.center', pt(e.center)); add('dwg.prop.radius', len(e.radius));
      if (e.type === 'ARC') { add('dwg.prop.startangle', deg(e.startAngle)); add('dwg.prop.endangle', deg(e.endAngle)); }
      break;
    case 'ELLIPSE':
      add('dwg.prop.center', pt(e.center)); add('dwg.prop.majoraxis', pt(e.majorAxis)); add('dwg.prop.ratio', num(e.ratio));
      break;
    case 'LWPOLYLINE': case 'POLYLINE_2D': case 'POLYLINE_3D':
      add('dwg.prop.vertices', (e.vertices || []).length);
      add('dwg.prop.closed', yes(e.closed), { valueKey: true });
      if (e.type !== 'POLYLINE_3D') add('dwg.prop.elevation', len(e.elevation || 0));
      break;
    case 'POLYLINE_PFACE':
      add('dwg.prop.vertices', (e.vertices || []).length); add('dwg.prop.faces', (e.faces || []).length);
      break;
    case 'POLYLINE_MESH':
      add('dwg.prop.mesh', (e.m || 0) + ' × ' + (e.n || 0));
      break;
    case '3DFACE': case 'SOLID': case 'TRACE':
      (e.points || []).slice(0, 4).forEach((p, i) => add('dwg.prop.corner' + (i + 1), pt(p)));
      break;
    case 'SPLINE':
      add('dwg.prop.degree', e.degree); add('dwg.prop.control', (e.control || []).length); add('dwg.prop.fit', (e.fit || []).length);
      break;
    case 'INSERT': case 'MINSERT':
      add('dwg.prop.block', e.block); add('dwg.prop.insert', pt(e.insert));
      if (e.scale) add('dwg.prop.scale', [e.scale.x ?? 1, e.scale.y ?? 1, e.scale.z ?? 1].map(num).join(', '));
      add('dwg.prop.rotation', deg(e.rotation || 0));
      if ((e.cols || 1) * (e.rows || 1) > 1) add('dwg.prop.array', (e.cols || 1) + ' × ' + (e.rows || 1));
      break;
    case 'HATCH':
      add('dwg.prop.pattern', e.solid ? 'SOLID' : e.pattern); add('dwg.prop.loops', (e.loops || []).length);
      break;
    default:
      if (/^DIMENSION|_DIMENSION$/.test(e.type)) { add('dwg.prop.block', e.block); add('dwg.prop.measurement', len(e.measurement)); }
  }
  if (e.thickness) add('dwg.prop.thickness', len(e.thickness));
  const x = e.extrusion;
  if (x && (Math.abs(x.x || 0) > 1e-9 || Math.abs(x.y || 0) > 1e-9 || (x.z ?? 1) < 0)) add('dwg.prop.extrusion', pt(x));
  return rows;
}
