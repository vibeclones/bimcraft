/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ifc-elements.js — delete, copy and paste any IFC element (0.4 B1). No DOM: bin/test-bimcraft.mjs --elements runs it
 * in Node and re-opens what it saves. Built on IfcPlacer (ifc-place.js) for its journal: every line created and the
 * first state of every line changed or deleted is kept, so IfcEditor undoes each operation as one step.
 *
 *   const ie = new IfcElements(WebIFC, api, mid);
 *   ie.remove([ids])                → { removed: [ids], refused: [{ id, why }], journal }
 *   const snap = ie.snapshot([ids]) → what Paste needs, held in memory by the page (it names lines of THIS model)
 *   ie.paste(snap, { storey, dx, dy, rot, about })   → { ids: [new top-level ids], all: [every new element], journal }
 *
 * What an element takes with it (both ways): its decomposition (IfcRelAggregates / IfcRelNests parts: a stair's
 * flights, a curtain wall's panels), its openings (IfcRelVoidsElement), and — deleting — the opening a removed door or
 * window filled, when nothing else fills it, so the wall closes as it does in an authoring program.
 *
 * Deleting: every relationship that names a removed element loses it; one left empty, or one whose single
 * relating/related element is removed, goes too. The element's placement and shape lines stay in the file, unused —
 * Paste after Cut builds the copies on them (Not built: removing those lines on Save).
 *
 * Pasting: new lines with new GlobalIds, the same attributes, the SAME shape (IfcProductDefinitionShape is shared, which
 * IFC allows), the same property sets, type and material (shared: IfcEditor copies a shared property set on the first
 * edit), and a new IfcLocalPlacement. Parts placed relative to a copied element follow it unchanged; the rest are moved:
 * world = T(about + d) · Rz(rot) · T(−about) · world before, then expressed in the new parent placement (the target
 * storey's when the storey changes, else the old parent). A library placement (CadCraft_Placement) gets its own
 * placement property set with the next free item number. Contained in the target storey, or the space it came from
 * when it stays on the same storey.
 *
 * Refused: the project, sites, buildings, storeys and spaces (spatial structure), and anything not in the model.
 */
import { IfcPlacer, PSETS, undoJournal } from './ifc-place.js';
import { ids, val, inv4, mul4, deleteLine, retypeLine } from './ifc-util.js';

const isHandle = (v) => v && typeof v === 'object' && v.type === 5 && typeof v.value === 'number';
const D2R = Math.PI / 180;

export class IfcElements extends IfcPlacer {
  /** Every relationship line (IfcRelationship and its subtypes) of the model. */
  relationshipIds() { return ids(this.api, this.mid, 'IFCRELATIONSHIP', true); }

  /** Why an element cannot be deleted or copied ('' = it can). */
  whyNot(id) {
    let line;
    try { line = this.api.GetLine(this.mid, id, false); } catch (e) { line = null; }
    if (!line || !line.GlobalId) return 'not-element';
    const cls = String(line.constructor?.name || '').toUpperCase();
    if (cls === 'IFCPROJECT') return 'spatial';
    if (/^IFC(SITE|BUILDING|BUILDINGSTOREY|SPACE|FACILITY|FACILITYPART|BRIDGE|ROAD|RAILWAY|MARINEFACILITY|SPATIALZONE|EXTERNALSPATIALELEMENT)$/.test(cls)) return 'spatial';
    if (!('ObjectPlacement' in line)) return 'not-element';
    return '';
  }

  /** The relationships an element set leans on, read once: parts, openings, fills, containment, psets, type, material. */
  relations() {
    const api = this.api, mid = this.mid;
    const R = { parts: new Map(), partOf: new Map(), voids: new Map(), voidHost: new Map(), fills: new Map(), filledBy: new Map(),
      container: new Map(), psets: new Map(), type: new Map(), material: new Map(), rels: [] };
    const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    for (const rid of this.relationshipIds()) {
      const r = api.GetLine(mid, rid, false);
      R.rels.push(rid);
      const t = String(r.constructor?.name || '').toUpperCase();
      if (t === 'IFCRELAGGREGATES' || t === 'IFCRELNESTS') {
        for (const h of r.RelatedObjects || []) { push(R.parts, r.RelatingObject?.value, h.value); R.partOf.set(h.value, r.RelatingObject?.value); }
      } else if (t === 'IFCRELVOIDSELEMENT') { push(R.voids, r.RelatingBuildingElement?.value, r.RelatedOpeningElement?.value); R.voidHost.set(r.RelatedOpeningElement?.value, r.RelatingBuildingElement?.value); }
      else if (t === 'IFCRELFILLSELEMENT') { push(R.fills, r.RelatingOpeningElement?.value, r.RelatedBuildingElement?.value); R.filledBy.set(r.RelatedBuildingElement?.value, r.RelatingOpeningElement?.value); }
      else if (t === 'IFCRELCONTAINEDINSPATIALSTRUCTURE') { for (const h of r.RelatedElements || []) R.container.set(h.value, r.RelatingStructure?.value); }
      else if (t === 'IFCRELDEFINESBYPROPERTIES') { const p = r.RelatingPropertyDefinition?.value; for (const h of r.RelatedObjects || []) push(R.psets, h.value, p); }
      else if (t === 'IFCRELDEFINESBYTYPE') { for (const h of r.RelatedObjects || []) R.type.set(h.value, r.RelatingType?.value); }
      else if (t === 'IFCRELASSOCIATESMATERIAL') { for (const h of r.RelatedObjects || []) R.material.set(h.value, r.RelatingMaterial?.value); }
    }
    return R;
  }

  /** The elements plus their parts and openings (any depth), and — when `withFilledOpenings` — openings left empty. */
  expand(list, R, { withFilledOpenings = false } = {}) {
    const out = new Set(list), todo = [...list];
    while (todo.length) {
      const x = todo.pop();
      for (const y of [...(R.parts.get(x) || []), ...(R.voids.get(x) || [])]) if (y && !out.has(y)) { out.add(y); todo.push(y); }
    }
    if (withFilledOpenings) {
      for (const x of [...out]) {
        const op = R.filledBy.get(x);
        if (op && !out.has(op) && (R.fills.get(op) || []).every((f) => out.has(f))) out.add(op);
      }
    }
    return out;
  }

  /** Delete elements (with their parts and openings). One journal: undoJournal puts everything back. */
  remove(list) {
    const api = this.api, mid = this.mid;
    const refused = [], ok = [];
    for (const id of new Set(list)) { const why = this.whyNot(id); if (why) refused.push({ id, why }); else ok.push(id); }
    if (!ok.length) return { removed: [], refused, journal: null };
    const R = this.relations();
    const targets = this.expand(ok, R, { withFilledOpenings: true });
    this.begin();
    try {
      for (const rid of R.rels) {
        const line = api.GetLine(mid, rid, false);
        let dead = false, changed = false;
        for (const k of Object.keys(line)) {
          if (k === 'expressID' || k === 'type') continue;
          const v = line[k];
          if (isHandle(v)) { if (targets.has(v.value)) dead = true; }
          else if (Array.isArray(v) && v.some((h) => isHandle(h) && targets.has(h.value))) {
            const keep = v.filter((h) => !(isHandle(h) && targets.has(h.value)));
            if (!keep.length) dead = true; else { line[k] = keep; changed = true; }
          }
          if (dead) break;
        }
        if (dead) { this.touch(rid); deleteLine(api, mid, rid); }
        else if (changed) { this.touch(rid); this.write(retypeLine(api, mid, line)); }
      }
      for (const id of targets) { this.touch(id); deleteLine(api, mid, id); }
      const journal = this.journal; this.journal = null;
      return { removed: [...targets], refused, journal };
    } catch (e) {
      if (this.journal) { this.undoNow(); }
      throw e;
    }
  }

  /**
   * What Paste needs, read now (a Cut deletes the originals right after): each element's line, its placement and parent,
   * and its relations. Top level = the elements asked for that are not parts or openings of another one asked for.
   */
  snapshot(list) {
    const api = this.api, mid = this.mid;
    const ok = [...new Set(list)].filter((id) => !this.whyNot(id));
    const R = this.relations();
    const all = this.expand(ok, R);
    const els = [];
    for (const id of all) {
      const line = api.GetLine(mid, id, false);
      const plId = line.ObjectPlacement?.value || null;
      let relTo = null;
      if (plId) { const pl = api.GetLine(mid, plId, false); relTo = pl.PlacementRelTo?.value || null; }
      els.push({
        id, line, plId, relTo,
        world: plId ? [...api.GetWorldTransformMatrix(mid, plId)] : null,
        parentWorld: relTo ? [...api.GetWorldTransformMatrix(mid, relTo)] : null,
        psets: (R.psets.get(id) || []).filter(Boolean), type: R.type.get(id) || null, material: R.material.get(id) || null,
        container: R.container.get(id) || null, parts: (R.parts.get(id) || []).filter((x) => all.has(x)),
        voids: (R.voids.get(id) || []).filter((x) => all.has(x)), fills: R.filledBy.get(id) && all.has(R.filledBy.get(id)) ? R.filledBy.get(id) : null,
        top: ok.includes(id) && !(R.partOf.has(id) && all.has(R.partOf.get(id))) && !(R.voidHost.has(id) && all.has(R.voidHost.get(id))),
        placementPset: this.placementPsetOf(id, R),
      });
    }
    // Parents before children, so a part placed relative to a copied element finds its new placement.
    const byPl = new Map(els.filter((e) => e.plId).map((e) => [e.plId, e]));
    const depth = (e, seen = new Set()) => { const p = e.relTo && byPl.get(e.relTo); if (!p || seen.has(p)) return 0; seen.add(p); return 1 + depth(p, seen); };
    els.sort((a, b) => depth(a) - depth(b));
    const storeyOf = (id) => { let c = R.container.get(id); let guard = 0; while (c && guard++ < 20) { const l = api.GetLine(mid, c, false); if (/BuildingStorey/i.test(l.constructor?.name || '')) return c; c = R.partOf.get(c); } return null; };
    const topEls = els.filter((e) => e.top);
    return { mid, unitMm: this.unitMm, elements: els, top: topEls.map((e) => e.id), storey: topEls.map((e) => storeyOf(e.id) ?? (R.partOf.has(e.id) ? storeyOf(R.partOf.get(e.id)) : null)).find(Boolean) || null };
  }

  /** The CadCraft_Placement values of a placed library item (null for other elements). */
  placementPsetOf(id, R) {
    for (const ps of R.psets.get(id) || []) {
      const l = this.api.GetLine(this.mid, ps, false);
      if (val(l.Name) !== PSETS.placement) continue;
      const p = this.propsOf(ps);
      return { id: ps, itemNumber: String(p.ItemNumber?.value ?? ''), quantity: p.Quantity?.value ?? 1, notes: p.Notes?.value || '' };
    }
    return null;
  }

  /**
   * New copies of a snapshot. opts: { storey (target storey id), dx, dy (model mm), rot (degrees about Z), about: [x, y]
   * (model mm; the turn's centre, default the snapshot's first top-level element), keepNumbers (library placements keep
   * their item number: the first paste after a Cut) }. dz follows the storey change.
   */
  paste(snap, opts = {}) {
    const api = this.api, mid = this.mid;
    // The page only pastes a snapshot into the model it was taken from (its session tag: web-ifc's model id changes on
    // every rebuild, the lines a snapshot names do not).
    const u = (mm) => mm / this.unitMm;
    const srcStorey = snap.storey, dstStorey = opts.storey || srcStorey;
    const elev = (st) => (st ? api.GetWorldTransformMatrix(mid, api.GetLine(mid, st, false).ObjectPlacement.value)[14] : 0);
    const dz = dstStorey && srcStorey && dstStorey !== srcStorey ? elev(dstStorey) - elev(srcStorey) : 0;
    const about = opts.about ? [u(opts.about[0]), u(opts.about[1])] : (() => { const w = snap.elements.find((e) => e.top)?.world; return w ? [w[12], w[13]] : [0, 0]; })();
    const r = (opts.rot || 0) * D2R, c = Math.cos(r), s = Math.sin(r);
    // M = T(about + d) · Rz · T(−about), column-major
    const ax = about[0], ay = about[1], tx = ax + u(opts.dx || 0), ty = ay + u(opts.dy || 0);
    const M = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, tx - (c * ax - s * ay), ty - (s * ax + c * ay), dz, 1];
    const dstPl = dstStorey && dstStorey !== srcStorey ? api.GetLine(mid, dstStorey, false).ObjectPlacement?.value : null;
    const dstPlWorld = dstPl ? [...api.GetWorldTransformMatrix(mid, dstPl)] : null;
    let next = null;   // next free item number, read once
    this._psetIndex = null;

    this.begin();
    try {
      const newPl = new Map(), newId = new Map();
      for (const e of snap.elements) {
        // placement: parts placed relative to a copied element keep their own axes; the rest move
        let pl = null;
        if (e.plId) {
          const old = api.GetLine(mid, e.plId, false);
          if (e.relTo && newPl.has(e.relTo)) pl = this.make('IFCLOCALPLACEMENT', this.H(newPl.get(e.relTo)), old.RelativePlacement);
          else {
            const world = mul4(M, e.world);
            const parent = dstPl && e.top ? dstPl : e.relTo;
            const pw = dstPl && e.top ? dstPlWorld : e.parentWorld;
            const local = pw ? mul4(inv4(pw), world) : world;
            pl = this.make('IFCLOCALPLACEMENT', parent ? this.H(parent) : null, this.H(this.axis(local)));
          }
          newPl.set(e.plId, pl);
        }
        const line = retypeLine(api, mid, Object.assign(Object.create(Object.getPrototypeOf(e.line)), e.line));
        line.expressID = -1;
        line.GlobalId = this.guid();
        if (pl) line.ObjectPlacement = this.H(pl);
        this.write(line);
        if (!(line.expressID > 0)) throw new Error('Could not write the copy of #' + e.id + '.');   // i18n-ignore: an engine failure, shown as is
        this.journal.created.push(line.expressID);
        newId.set(e.id, line.expressID);
      }
      for (const e of snap.elements) {
        const id = newId.get(e.id);
        if (e.type) this.relateType(id, e.type);
        if (e.material) this.relateMaterial(id, e.material);
        for (const ps of e.psets) {
          if (e.placementPset && ps === e.placementPset.id) {
            // a paste after a Cut keeps the number (the original is gone); a copy gets the next free one
            let no = opts.keepNumbers ? e.placementPset.itemNumber : '';
            if (!no) { if (next === null) next = Number(this.nextItemNumber()) || 1; no = String(next++); }
            this.relate(id, this.placementPset({ itemNumber: no, quantity: e.placementPset.quantity, notes: e.placementPset.notes }));
          } else this.relatePset(id, ps);
        }
        if (e.parts.length) this.make('IFCRELAGGREGATES', this.guid(), this.ownerHistory(), null, null, this.H(id), e.parts.map((p) => this.H(newId.get(p))));
        for (const o of e.voids) this.make('IFCRELVOIDSELEMENT', this.guid(), this.ownerHistory(), null, null, this.H(id), this.H(newId.get(o)));
        if (e.fills) this.make('IFCRELFILLSELEMENT', this.guid(), this.ownerHistory(), null, null, this.H(newId.get(e.fills)), this.H(id));
        if (e.top) {
          const into = dstStorey && dstStorey !== srcStorey ? dstStorey : (e.container || dstStorey);
          if (into) this.contain(id, into);
        }
      }
      const journal = this.journal; this.journal = null;
      return { ids: snap.elements.filter((e) => e.top).map((e) => newId.get(e.id)), all: [...newId.values()], journal };
    } catch (e) {
      if (this.journal) this.undoNow();
      throw e;
    }
  }

  /** IfcAxis2Placement3D of a column-major matrix (no scale): location, Z axis, X axis. */
  axis(m) {
    const rd = (v) => Math.round(v * 1e9) / 1e9, rl = (v) => Math.round(v * 1e6) / 1e6;
    const n = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [rd(x / l), rd(y / l), rd(z / l)]; };
    return this.make('IFCAXIS2PLACEMENT3D', this.H(this.point3(rl(m[12]), rl(m[13]), rl(m[14]))), this.H(this.dir(...n(m[8], m[9], m[10]))), this.H(this.dir(...n(m[0], m[1], m[2]))));
  }

  /** Relate to a property set: added to a relation that already holds it, else a new relation. */
  relatePset(id, ps) {
    for (const rid of ids(this.api, this.mid, 'IFCRELDEFINESBYPROPERTIES')) {
      const r = this.api.GetLine(this.mid, rid, false);
      if (r.RelatingPropertyDefinition?.value === ps) { const l = this.touch(rid); l.RelatedObjects = [...l.RelatedObjects, this.H(id)]; this.write(l); return rid; }
    }
    return this.relate(id, ps);
  }
  relateMaterial(id, mat) {
    for (const rid of ids(this.api, this.mid, 'IFCRELASSOCIATESMATERIAL')) {
      const r = this.api.GetLine(this.mid, rid, false);
      if (r.RelatingMaterial?.value === mat) { const l = this.touch(rid); l.RelatedObjects = [...l.RelatedObjects, this.H(id)]; this.write(l); return rid; }
    }
    return this.make('IFCRELASSOCIATESMATERIAL', this.guid(), this.ownerHistory(), null, null, [this.H(id)], this.H(mat));
  }

  /** Take back what this operation wrote so far (it failed half way). */
  undoNow() { undoJournal(this.api, this.mid, this.journal); this.journal = null; }
}

/** Room for a localized message per refusal reason; the page maps these codes to words. */
export const REFUSALS = ['spatial', 'not-element'];
