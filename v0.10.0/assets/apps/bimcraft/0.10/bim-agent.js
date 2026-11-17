/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: tool definitions and results are read by the assistant (MCP), not shown on the page (AGENTS-SPEC §5) */
/**
 * bim-agent.js — BimCraft's live tools for AI assistants and scripts (0.4 X.7; docs/AGENTS-SPEC.md §5.2, §6.3). No DOM:
 * bin/test-bimcraft.mjs --agent runs them in Node through host.js's dispatcher on the fixture's property index.
 *
 *   bimTools(app) → [tool definitions] for host.control.tool(def) (one call each; each returns its unregister function)
 *     app.index()            → the open model's property index (ifc-props.js propertyIndex), or null with no model
 *     app.properties(id)     → Promise<IfcModel.properties(id)> (attributes, type name, property and quantity sets)
 *     app.visibility(how, keys) → { hidden } (how many are hidden now) after applying it: how 'isolate' | 'ghost' | 'hide' |
 *                              'show_all' — the Show menu's own calls, so the person sees the same as after the menu
 *     app.name()             → the open model's file name
 *
 * Tools (ids are BimCraft's element keys, the same numbers in every tool; guid is the IFC GlobalId):
 *   elements_find      read   class?, storey?, name? (contains), property? {set?, name, equals? | contains?}, rules?
 *                             (BimCraft's own Find rules: [{field, op, value}]), mode all|any, offset, limit ≤ 500
 *                             → {total, offset, elements: [{id, guid, class, name, storey, type}]}
 *   elements_isolate   edit   ids? or the same filters as elements_find, how isolate|ghost|hide|show_all → {how, elements,
 *                             hidden}; visibility only: the model is not changed, so there is no undo step
 *   element_properties read   id or guid → {id, guid, class, name, objectType, tag, description, typeName, sets: [{name,
 *                             fromType, properties: [{name, value}]}]}
 */
import { find, OPS } from './ifc-find.js';

const LIMIT = 500;
const FILTERS = {
  class: { type: 'string', description: 'IFC class, e.g. IfcWall (case does not matter).' },
  storey: { type: 'string', description: 'Storey name, exactly as the model names it.' },
  name: { type: 'string', description: 'Text the element name contains.' },
  property: {
    type: 'object', description: 'A property (or quantity) value. Without "set", any set holding a property of that name.',
    properties: { set: { type: 'string' }, name: { type: 'string' }, equals: { type: 'string' }, contains: { type: 'string' } },
    required: ['name'], additionalProperties: false,
  },
  rules: {
    type: 'array', maxItems: 20, description: 'BimCraft Find rules; field = cls, type, storey, material, name, longname, objtype, tag, predefined, guid or p:<Set>.<Property>.',
    items: { type: 'object', properties: { field: { type: 'string' }, op: { type: 'string', enum: OPS }, value: { type: 'string' } }, required: ['field', 'op'], additionalProperties: false },
  },
  mode: { type: 'string', enum: ['all', 'any'], description: 'all = every rule must match (default), any = one is enough.' },
};

// a refusal the assistant can act on: the dispatcher answers it as an error result (isError) with this message
class ToolError extends Error {}

/** The filters as Find rules (ifc-find.js), or null when none is given. */
export function filterRules(ix, a) {
  const rules = [];
  if (a.class) rules.push({ field: 'cls', op: 'is', value: a.class });
  if (a.storey) rules.push({ field: 'storey', op: 'is', value: a.storey });
  if (a.name) rules.push({ field: 'name', op: 'contains', value: a.name });
  if (a.property) {
    const p = a.property, want = String(p.name).trim().toLowerCase();
    const fields = ix.fields.filter((f) => f.id.startsWith('p:') && f.label.toLowerCase() === want && (!p.set || f.group.toLowerCase() === String(p.set).trim().toLowerCase()));
    const op = p.equals !== undefined ? 'is' : p.contains !== undefined ? 'contains' : 'has';
    const value = p.equals ?? p.contains ?? '';
    // one property in several sets: any of them may match (a rule group of its own, joined below)
    rules.push({ any: fields.length ? fields.map((f) => ({ field: f.id, op, value })) : [{ field: 'p:' + (p.set || '?') + '.' + p.name, op, value }] });
  }
  for (const r of a.rules || []) rules.push({ field: r.field, op: r.op, value: r.value ?? '' });
  return rules.length ? rules : null;
}

/** Element keys matching the filters (sorted). */
export function findKeys(ix, a) {
  const rules = filterRules(ix, a);
  if (!rules) return null;
  const mode = a.mode === 'any' ? 'any' : 'all';
  const sets = rules.map((r) => new Set(r.any ? r.any.flatMap((x) => find(ix, { rules: [x] })) : find(ix, { rules: [r] })));
  const keys = mode === 'any' ? ix.keys.filter((k) => sets.some((s) => s.has(k))) : ix.keys.filter((k) => sets.every((s) => s.has(k)));
  return keys;
}

export function describe(ix, key) {
  const id = key - ix.keyBase, v = (f) => ix.value(f, id) ?? null;
  return { id: key, guid: v('guid'), class: v('cls'), name: v('name'), storey: v('storey'), type: v('type') };
}

export function bimTools(app) {
  const model = () => { const ix = app.index(); if (!ix) throw new ToolError('No IFC model is open in BimCraft. Open one first (the person opens files; there is no open tool).'); return ix; };
  const keyOf = (ix, a) => {
    if (a.id !== undefined) { if (!ix.keys.includes(a.id)) throw new ToolError('No element ' + a.id + ' in ' + app.name() + '.'); return a.id; }
    if (a.guid) { const k = ix.keys.find((x) => ix.value('guid', x - ix.keyBase) === a.guid); if (k === undefined) throw new ToolError('No element with GlobalId ' + a.guid + '.'); return k; }
    throw new ToolError('Give id or guid.');
  };
  return [
    {
      name: 'elements_find', group: 'read', title: 'Find elements',
      description: 'Find elements of the open IFC model by class, storey, name or property value. Returns their ids for elements_isolate and element_properties.',
      inputSchema: { type: 'object', properties: { ...FILTERS, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: LIMIT } }, additionalProperties: false },
      run: (a) => {
        const ix = model();
        const keys = findKeys(ix, a) ?? ix.keys;
        const offset = a.offset || 0, limit = a.limit || 100;
        return { model: app.name(), total: keys.length, offset, elements: keys.slice(offset, offset + limit).map((k) => describe(ix, k)) };
      },
    },
    {
      name: 'elements_isolate', group: 'edit', title: 'Isolate, hide or show elements',
      description: 'Change what the 3D view shows: isolate (only these), ghost (these, the rest see-through), hide (these), or show_all. Visibility only: the model is not changed.',
      inputSchema: {
        type: 'object', properties: {
          how: { type: 'string', enum: ['isolate', 'ghost', 'hide', 'show_all'] },
          ids: { type: 'array', items: { type: 'integer' }, maxItems: 100000 },
          ...FILTERS,
        }, required: ['how'], additionalProperties: false,
      },
      run: (a) => {
        const ix = model();
        if (a.how === 'show_all') return { how: a.how, elements: ix.keys.length, ...app.visibility('show_all', []) };
        let keys = a.ids ? [...new Set(a.ids)] : findKeys(ix, a);
        if (!keys) throw new ToolError('Say which elements: ids, or class / storey / name / property / rules.');
        const unknown = keys.filter((k) => !ix.keys.includes(k));
        if (unknown.length) throw new ToolError('Unknown element ids: ' + unknown.slice(0, 20).join(', ') + (unknown.length > 20 ? ' …' : '') + '. Nothing changed.');
        if (!keys.length) throw new ToolError('No element matches. Nothing changed.');
        return { how: a.how, elements: keys.length, ...app.visibility(a.how, keys) };
      },
    },
    {
      name: 'element_properties', group: 'read', title: 'Element properties',
      description: 'Attributes, type name, property sets and quantity sets of one element of the open IFC model (type sets included).',
      inputSchema: { type: 'object', properties: { id: { type: 'integer' }, guid: { type: 'string' } }, additionalProperties: false },
      run: async (a) => {
        const ix = model();
        const key = keyOf(ix, a);
        const p = await app.properties(key);
        return {
          id: key, guid: p.guid, class: p.cls, name: p.name, objectType: p.objectType, tag: p.tag, description: p.description, typeName: p.typeName,
          storey: ix.value('storey', key - ix.keyBase) ?? null,
          sets: p.sets.map((s) => ({ name: s.name, fromType: s.fromType, properties: s.rows.map((r) => ({ name: r.name, value: r.value })) })),
        };
      },
    },
  ];
}
