/* SPDX-License-Identifier: Apache-2.0 */
/**
 * family-starters.js — the families BimCraft starts with (0.6 DC.114, session bim-families_PART_2). No DOM.
 *
 *   starterRecipe(key) → a family recipe (family-model.js format) for a starter door / window kind of model-openings.js
 *                        (DOOR_TYPES / WINDOW_TYPES keys), or for a starter furniture family (STARTER_FURNITURE keys)
 *   STARTER_KEYS       every starter family key, doors first, then windows, then furniture
 *   STARTER_FURNITURE  the furniture families: a table, a shelf unit, a base cabinet (each with a visibility parameter)
 *
 * The door and window recipes are model-openings.js `doorParts` / `windowParts` written as solids bound to parameters: the
 * same boxes, in the same order, with the same numbers (constants are written with JavaScript's own digits), so an element
 * drawn from its recipe is the element drawn before families existed (bin/test-bimcraft.mjs --families checks every kind,
 * both faces, several sizes and wall thicknesses against doorParts / windowParts). Hosted recipes read two names the wall
 * gives: WallThickness (mm) and Face (1 = the door swings to / the window sits on the wall's left, −1 = its right).
 */
import { DOOR_TYPES, WINDOW_TYPES, openingType, openingTypeName } from './opening-types.js';
import { t as tr } from './i18n.js';

const IN = 25.4;
const FRAME = 1.5 * IN, LEAF = 1.75 * IN, WFRAME = 2 * IN, WDEPTH = 4.5 * IN, GLASS = 6;

// ---- a tiny expression builder: numbers fold as JavaScript would, names stay names ----
const ex = (x) => (typeof x === 'number' ? String(x) : x);
const num = (x) => typeof x === 'number';
const add = (a, b) => (num(a) && num(b) ? a + b : `(${ex(a)} + ${ex(b)})`);
const sub = (a, b) => (num(a) && num(b) ? a - b : `(${ex(a)} - ${ex(b)})`);
const mul = (a, b) => (num(a) && num(b) ? a * b : `(${ex(a)} * ${ex(b)})`);
const div = (a, b) => (num(a) && num(b) ? a / b : `(${ex(a)} / ${ex(b)})`);
const neg = (a) => (num(a) ? -a : `(-${ex(a)})`);
const min = (...a) => `min(${a.map(ex).join(', ')})`;
const max = (...a) => `max(${a.map(ex).join(', ')})`;
const iff = (c, a, b) => `if(${c}, ${ex(a)}, ${ex(b)})`;
const POS = '(Face > 0)';

const P = (key, kind, value, formula = null) => (formula === null ? { key, kind, value } : { key, kind, value: 0, formula: ex(formula) });

function doorRecipe(type) {
  const W = 'Width', H = 'Height', T = 'WallThickness', s = 'Face';
  const params = [P('Width', 'length', type.width), P('Height', 'length', type.height),
    P('Frame', 'length', 0, min(FRAME, div(W, 6))), P('Inner', 'length', 0, sub(W, mul(2, 'Frame'))), P('Top', 'length', 0, sub(H, 'Frame'))];
  const f = 'Frame', inner = 'Inner', top = 'Top';
  const solids = [];
  const box = (x0, y0, z0, x1, y1, z1, style) => solids.push({ id: 's' + (solids.length + 1), op: 'box', x0: ex(x0), y0: ex(y0), z0: ex(z0), x1: ex(x1), y1: ex(y1), z1: ex(z1), style });
  const y0 = div(neg(T), 2), y1 = div(T, 2);
  box(0, y0, 0, f, y1, H, 'frame'); box(sub(W, f), y0, 0, W, y1, H, 'frame'); box(f, y0, sub(H, f), sub(W, f), y1, H, 'frame');
  const ly0 = iff(POS, sub(y1, LEAF), y0), ly1 = iff(POS, y1, add(y0, LEAF));
  if (type.garage) box(f, -LEAF / 2, 0, sub(W, f), LEAF / 2, top, 'garage');
  else if (type.slide) {
    params.push(P('Half', 'length', 0, add(div(inner, 2), 25)));
    const half = 'Half';
    box(f, -LEAF, 0, add(f, half), 0, top, 'glass'); box(sub(sub(W, f), half), 0, 0, sub(W, f), LEAF, top, 'glass');
    box(f, -LEAF, 0, add(f, 40), 0, top, 'leaf'); box(sub(sub(W, f), 40), 0, 0, sub(W, f), LEAF, top, 'leaf');
  } else if (type.pocket) box(f, -LEAF / 2, 0, sub(W, f), LEAF / 2, top, 'leaf');
  else if (type.bifold) box(f, -LEAF / 2, 0, sub(W, f), LEAF / 2, top, 'leaf');
  else if (type.barn) {
    const yb = iff(POS, y1, sub(y0, LEAF)), yt = iff(POS, add(y1, LEAF), y0);
    box(-50, yb, 0, add(W, 50), yt, add(H, 25), 'leaf');
    box(-50, iff(POS, yt, sub(yb, 25)), add(H, 40), mul(2, W), iff(POS, add(yt, 25), yb), add(H, 80), 'frame');
  } else if (type.sidelites) {
    params.push(P('Sidelite', 'length', 0, min(type.sidelites, div(W, 4))));
    const sl = 'Sidelite';
    box(f, -GLASS / 2, 0, add(f, sl), GLASS / 2, top, 'glass'); box(sub(sub(W, f), sl), -GLASS / 2, 0, sub(W, f), GLASS / 2, top, 'glass');
    box(add(f, sl), y0, 0, add(add(f, sl), f), y1, top, 'frame'); box(sub(sub(sub(W, f), sl), f), y0, 0, sub(sub(W, f), sl), y1, top, 'frame');
    box(add(add(f, sl), f), ly0, 0, sub(sub(sub(W, f), sl), f), ly1, sub(top, 3), 'leaf');
  } else if (type.leaves === 2) {
    if (type.glazed) {
      for (const [a, b] of [[f, sub(add(f, div(inner, 2)), 2)], [add(add(f, div(inner, 2)), 2), sub(W, f)]]) {
        const st = 100;
        box(a, ly0, 0, add(a, st), ly1, sub(top, 3), 'leaf'); box(sub(b, st), ly0, 0, b, ly1, sub(top, 3), 'leaf');
        box(add(a, st), ly0, 0, sub(b, st), ly1, 200, 'leaf'); box(add(a, st), ly0, sub(sub(top, 3), st), sub(b, st), ly1, sub(top, 3), 'leaf');
        box(add(a, st), sub(div(add(ly0, ly1), 2), GLASS / 2), 200, sub(b, st), add(div(add(ly0, ly1), 2), GLASS / 2), sub(sub(top, 3), st), 'glass');
      }
    } else { box(f, ly0, 0, sub(add(f, div(inner, 2)), 2), ly1, sub(top, 3), 'leaf'); box(add(add(f, div(inner, 2)), 2), ly0, 0, sub(W, f), ly1, sub(top, 3), 'leaf'); }
  } else box(f, ly0, 0, sub(W, f), ly1, sub(top, 3), 'leaf');
  void s;
  return { params, solids };
}

function windowRecipe(type) {
  const W = 'Width', H = 'Height', T = 'WallThickness';
  const params = [P('Width', 'length', type.width), P('Height', 'length', type.height),
    P('Frame', 'length', 0, min(WFRAME, div(W, 6), div(H, 6))), P('Depth', 'length', 0, min(WDEPTH, T))];
  const f = 'Frame', d = 'Depth';
  params.push(P('Y0', 'length', 0, iff(POS, sub(div(T, 2), d), div(neg(T), 2))));
  params.push(P('Y1', 'length', 0, add('Y0', d)));
  params.push(P('GlassY', 'length', 0, div(add('Y0', 'Y1'), 2)));
  const y0 = 'Y0', y1 = 'Y1', gy = 'GlassY';
  const solids = [];
  const box = (x0, by0, z0, x1, by1, z1, style) => solids.push({ id: 's' + (solids.length + 1), op: 'box', x0: ex(x0), y0: ex(by0), z0: ex(z0), x1: ex(x1), y1: ex(by1), z1: ex(z1), style });
  box(0, y0, 0, f, y1, H, 'frame'); box(sub(W, f), y0, 0, W, y1, H, 'frame');
  box(f, y0, 0, sub(W, f), y1, f, 'frame'); box(f, y0, sub(H, f), sub(W, f), y1, H, 'frame');
  if (type.rail) { const m = div(H, 2); box(f, add(y0, mul(d, 0.15)), sub(m, div(f, 2)), sub(W, f), sub(y1, mul(d, 0.15)), add(m, div(f, 2)), 'frame'); }
  if (type.stile) { const m = div(W, 2); box(sub(m, div(f, 2)), add(y0, mul(d, 0.15)), f, add(m, div(f, 2)), sub(y1, mul(d, 0.15)), sub(H, f), 'frame'); }
  box(f, sub(gy, GLASS / 2), f, sub(W, f), add(gy, GLASS / 2), sub(H, f), 'glass');
  if (type.well) {
    params.push(P('WellWidth', 'length', 0, max(48 * IN, add(W, 12 * IN))));
    const ww = 'WellWidth', x0 = div(sub(W, ww), 2), x1 = div(add(W, ww), 2), near = div(T, 2), far = add(div(T, 2), 36 * IN), bottom = -6 * IN, gauge = IN;
    const Y = (v) => mul('Face', v);
    const wall = (a, b, c, e) => box(a, min(Y(b), Y(e)), bottom, c, max(Y(b), Y(e)), H, 'frame');
    wall(sub(x0, gauge), near, x0, add(far, gauge));
    wall(x1, near, add(x1, gauge), add(far, gauge));
    wall(x0, far, x1, add(far, gauge));
  }
  return { params, solids };
}

/** Furniture to start from (each with a Yes / No parameter, so a visibility parameter is there to see). */
export const STARTER_FURNITURE = ['fam-table', 'fam-shelf', 'fam-cabinet'];

function furnitureRecipe(key) {
  /* i18n-ignore-start: the furniture's expressions (code, not words) */
  if (key === 'fam-table') return {
    ifc: { class: 'IfcFurniture', predefined: 'TABLE' },
    params: [P('Width', 'length', 1500), P('Depth', 'length', 900), P('Height', 'length', 750), P('Top', 'length', 30), P('Leg', 'length', 50),
      { key: 'Apron', kind: 'yesno', value: 1 }],
    solids: [
      { id: 's1', name: tr('fam.part.top'), op: 'box', x0: '(-Width / 2)', y0: '(-Depth / 2)', z0: '(Height - Top)', x1: '(Width / 2)', y1: '(Depth / 2)', z1: 'Height', style: 'wood' },
      { id: 's2', name: tr('fam.part.leg'), op: 'box', x0: '(-Width / 2 + 25)', y0: '(-Depth / 2 + 25)', z0: '0', x1: '(-Width / 2 + 25 + Leg)', y1: '(-Depth / 2 + 25 + Leg)', z1: '(Height - Top)', style: 'wood' },
      { id: 's3', name: tr('fam.part.leg'), op: 'box', x0: '(Width / 2 - 25 - Leg)', y0: '(-Depth / 2 + 25)', z0: '0', x1: '(Width / 2 - 25)', y1: '(-Depth / 2 + 25 + Leg)', z1: '(Height - Top)', style: 'wood' },
      { id: 's4', name: tr('fam.part.leg'), op: 'box', x0: '(-Width / 2 + 25)', y0: '(Depth / 2 - 25 - Leg)', z0: '0', x1: '(-Width / 2 + 25 + Leg)', y1: '(Depth / 2 - 25)', z1: '(Height - Top)', style: 'wood' },
      { id: 's5', name: tr('fam.part.leg'), op: 'box', x0: '(Width / 2 - 25 - Leg)', y0: '(Depth / 2 - 25 - Leg)', z0: '0', x1: '(Width / 2 - 25)', y1: '(Depth / 2 - 25)', z1: '(Height - Top)', style: 'wood' },
      { id: 's6', name: tr('fam.part.apron'), op: 'box', x0: '(-Width / 2 + 25 + Leg)', y0: '(-Depth / 2 + 35)', z0: '(Height - Top - 90)', x1: '(Width / 2 - 25 - Leg)', y1: '(-Depth / 2 + 55)', z1: '(Height - Top)', style: 'wood', visible: 'Apron' },
      { id: 's7', name: tr('fam.part.apron'), op: 'box', x0: '(-Width / 2 + 25 + Leg)', y0: '(Depth / 2 - 55)', z0: '(Height - Top - 90)', x1: '(Width / 2 - 25 - Leg)', y1: '(Depth / 2 - 35)', z1: '(Height - Top)', style: 'wood', visible: 'Apron' },
    ],
    booleans: [],
  };
  if (key === 'fam-shelf') return {
    ifc: { class: 'IfcFurniture', predefined: 'SHELF' },
    params: [P('Width', 'length', 900), P('Depth', 'length', 350), P('Height', 'length', 1800), P('Board', 'length', 18), { key: 'Shelves', kind: 'number', value: 4 },
      { key: 'Back', kind: 'yesno', value: 1 }, P('Gap', 'length', 0, '((Height - 2 * Board) / Shelves)')],
    solids: [
      { id: 's1', name: tr('fam.part.side'), op: 'box', x0: '(-Width / 2)', y0: '0', z0: '0', x1: '(-Width / 2 + Board)', y1: 'Depth', z1: 'Height', style: 'wood' },
      { id: 's2', name: tr('fam.part.side'), op: 'box', x0: '(Width / 2 - Board)', y0: '0', z0: '0', x1: '(Width / 2)', y1: 'Depth', z1: 'Height', style: 'wood' },
      { id: 's3', name: tr('fam.part.bottom'), op: 'box', x0: '(-Width / 2 + Board)', y0: '0', z0: '0', x1: '(Width / 2 - Board)', y1: 'Depth', z1: 'Board', style: 'wood' },
      { id: 's4', name: tr('fam.part.top'), op: 'box', x0: '(-Width / 2 + Board)', y0: '0', z0: '(Height - Board)', x1: '(Width / 2 - Board)', y1: 'Depth', z1: 'Height', style: 'wood' },
      { id: 's5', name: tr('fam.part.shelf'), op: 'box', x0: '(-Width / 2 + Board)', y0: '0', z0: '(Board + Gap)', x1: '(Width / 2 - Board)', y1: 'Depth', z1: '(2 * Board + Gap)', style: 'wood', visible: '(Shelves >= 2)' },
      { id: 's6', name: tr('fam.part.shelf'), op: 'box', x0: '(-Width / 2 + Board)', y0: '0', z0: '(Board + 2 * Gap)', x1: '(Width / 2 - Board)', y1: 'Depth', z1: '(2 * Board + 2 * Gap)', style: 'wood', visible: '(Shelves >= 3)' },
      { id: 's7', name: tr('fam.part.shelf'), op: 'box', x0: '(-Width / 2 + Board)', y0: '0', z0: '(Board + 3 * Gap)', x1: '(Width / 2 - Board)', y1: 'Depth', z1: '(2 * Board + 3 * Gap)', style: 'wood', visible: '(Shelves >= 4)' },
      { id: 's8', name: tr('fam.part.back'), op: 'box', x0: '(-Width / 2)', y0: '(Depth - 6)', z0: '0', x1: '(Width / 2)', y1: 'Depth', z1: 'Height', style: 'wood', visible: 'Back' },
    ],
    booleans: [],
  };
  // a base cabinet: a carcass with its front recess cut out by a Boolean, a door, a toe kick cut
  return {
    ifc: { class: 'IfcFurniture', predefined: 'NOTDEFINED' },
    params: [P('Width', 'length', 600), P('Depth', 'length', 600), P('Height', 'length', 870), P('ToeKick', 'length', 100), { key: 'Door', kind: 'yesno', value: 1 }],
    solids: [
      { id: 's1', name: tr('fam.part.carcass'), op: 'box', x0: '(-Width / 2)', y0: '0', z0: '0', x1: '(Width / 2)', y1: 'Depth', z1: 'Height', style: 'wood' },
      { id: 's2', name: tr('fam.part.recess'), op: 'box', x0: '(-Width / 2 + 18)', y0: '-1', z0: '(ToeKick + 18)', x1: '(Width / 2 - 18)', y1: '(Depth - 18)', z1: '(Height - 18)', style: 'wood' },
      { id: 's3', name: tr('fam.part.toekick'), op: 'box', x0: '(-Width / 2 - 1)', y0: '-1', z0: '-1', x1: '(Width / 2 + 1)', y1: '75', z1: 'ToeKick', style: 'wood' },
      { id: 's4', name: tr('fam.part.door'), op: 'box', x0: '(-Width / 2 + 2)', y0: '-18', z0: 'ToeKick', x1: '(Width / 2 - 2)', y1: '0', z1: 'Height', style: 'leaf', visible: 'Door' },
    ],
    booleans: [{ id: 'b1', op: 'difference', a: 's1', b: 's2' }, { id: 'b2', op: 'difference', a: 'b1', b: 's3' }],
  };
  /* i18n-ignore-end */
}

export const STARTER_KEYS = [...DOOR_TYPES.map((x) => x.key), ...WINDOW_TYPES.map((x) => x.key), ...STARTER_FURNITURE];

/** A starter family's recipe; null for an unknown key. Names come from the language files (as the tools show them). */
export function starterRecipe(key) {
  const type = openingType(key);
  if (type) {
    const r = type.kind === 'door' ? doorRecipe(type) : windowRecipe(type);
    return {
      format: 'cadcraft-family', version: 1, key, name: openingTypeName(type), kind: type.kind, host: 'wall', base: key,
      ifc: { class: type.kind === 'door' ? 'IfcDoor' : 'IfcWindow' }, params: r.params, solids: r.solids, booleans: [], starter: true,
    };
  }
  if (!STARTER_FURNITURE.includes(key)) return null;
  const r = furnitureRecipe(key);
  return { format: 'cadcraft-family', version: 1, key, name: tr('fam.starter.' + key), kind: 'furniture', host: 'none', base: '', ifc: r.ifc, params: r.params, solids: r.solids, booleans: r.booleans, starter: true };
}
