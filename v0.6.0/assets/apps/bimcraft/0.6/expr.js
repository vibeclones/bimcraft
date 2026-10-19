/* SPDX-License-Identifier: Apache-2.0 */
/**
 * expr.js — the parameter expression language (DOM-free, import-free). CANONICAL COPY: CadCraft keeps a
 * byte-identical copy (cadcraft/dev/expr.js; bin/test-cadcraft.mjs checks it) — change both or neither.
 *
 * A small tokenizer + recursive-descent parser + tree walker. NEVER eval / Function: an expression can
 * only name the variables it is given and the functions in FUNCS (a null-prototype table, so
 * "constructor", "__proto__" and friends are just unknown names).
 *
 *   cond    := sum (('<' | '<=' | '>' | '>=' | '==' | '!=') sum)?
 *   sum     := term (('+' | '-') term)*
 *   term    := power (('*' | '/' | '%') power)*
 *   power   := unary ('^' power)?                      right-associative; -2^2 = -4
 *   unary   := ('-' | '+') unary | primary
 *   primary := number unit? | name | name '(' cond (',' cond)* ')' | '(' cond ')'
 *
 * Units: lengths are millimetres and angles degrees. A number may carry a unit right after it —
 * mm cm m in ft (or ' and ") for lengths, deg (or °) rad for angles — and is converted: 1in = 25.4,
 * 2' = 609.6, 0.5rad = 28.6479…; the result is always a plain number. Trigonometry is in degrees
 * (sin(30) = 0.5; asin/acos/atan/atan2 return degrees), like the angle fields it feeds.
 * Comparisons give 1 or 0 and feed if(c, a, b). Names are case-sensitive (Width ≠ width), as in the
 * parameter table. Any non-finite result or division by zero is an error, never a quiet wrong number.
 */

import { t as tr } from './i18n.js';   // tr: these parsers call their tokens t
const EPS = 1e-9;
const D2R = Math.PI / 180;
export const UNITS = Object.freeze({ mm: 1, cm: 10, m: 1000, in: 25.4, '"': 25.4, ft: 304.8, "'": 304.8, deg: 1, '°': 1, rad: 180 / Math.PI });
const UNIT_RE = /^(mm|cm|m|in|ft|deg|rad|°|"|')(?![A-Za-z0-9_])/;

const fin = (x, name) => { if (!Number.isFinite(x)) throw new ExprError(tr('expr.does_not_give_number', { name })); return x; };
const FUNCS = Object.assign(Object.create(null), {
  sin: { min: 1, max: 1, fn: (x) => clean(Math.sin(x * D2R)) },
  cos: { min: 1, max: 1, fn: (x) => clean(Math.cos(x * D2R)) },
  tan: { min: 1, max: 1, fn: (x) => { const c = Math.cos(x * D2R); if (Math.abs(c) < 1e-12) throw new ExprError('tan() of 90° has no value.'); return clean(Math.tan(x * D2R)); } },
  asin: { min: 1, max: 1, fn: (x) => { if (x < -1 - EPS || x > 1 + EPS) throw new ExprError('asin() takes a value from -1 to 1.'); return Math.asin(Math.max(-1, Math.min(1, x))) / D2R; } },
  acos: { min: 1, max: 1, fn: (x) => { if (x < -1 - EPS || x > 1 + EPS) throw new ExprError('acos() takes a value from -1 to 1.'); return Math.acos(Math.max(-1, Math.min(1, x))) / D2R; } },
  atan: { min: 1, max: 1, fn: (x) => Math.atan(x) / D2R },
  atan2: { min: 2, max: 2, fn: (y, x) => Math.atan2(y, x) / D2R },
  sqrt: { min: 1, max: 1, fn: (x) => { if (x < -EPS) throw new ExprError('sqrt() of a negative number has no value.'); return Math.sqrt(Math.max(0, x)); } },
  pow: { min: 2, max: 2, fn: (a, b) => fin(a ** b, 'pow') },
  exp: { min: 1, max: 1, fn: (x) => fin(Math.exp(x), 'exp') },
  ln: { min: 1, max: 1, fn: (x) => { if (x <= 0) throw new ExprError('ln() takes a number above zero.'); return Math.log(x); } },
  log: { min: 1, max: 1, fn: (x) => { if (x <= 0) throw new ExprError('log() takes a number above zero.'); return Math.log10(x); } },
  abs: { min: 1, max: 1, fn: (x) => Math.abs(x) },
  sign: { min: 1, max: 1, fn: (x) => Math.sign(x) },
  ceil: { min: 1, max: 1, fn: (x) => Math.ceil(x - EPS * Math.max(1, Math.abs(x))) },
  floor: { min: 1, max: 1, fn: (x) => Math.floor(x + EPS * Math.max(1, Math.abs(x))) },
  int: { min: 1, max: 1, fn: (x) => Math.trunc(x + Math.sign(x) * EPS * Math.max(1, Math.abs(x))) },
  round: { min: 1, max: 2, fn: (x, d = 0) => {
    if (!Number.isInteger(d) || d < 0 || d > 10) throw new ExprError('round(x, digits) needs whole digits from 0 to 10.');
    const f = 10 ** d, y = Math.abs(x) * f, r = Math.floor(y + 0.5 + EPS * Math.max(1, y));
    return (x < 0 ? -r : r) / f;
  } },
  min: { min: 1, max: 99, fn: (...a) => Math.min(...a) },
  max: { min: 1, max: 99, fn: (...a) => Math.max(...a) },
  if: { min: 3, max: 3, lazy: true },
});
export const FUNCTION_NAMES = Object.keys(FUNCS);
export const CONSTANTS = Object.freeze({ pi: Math.PI });
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
/** Names a parameter may not take (functions, constants, units). */
export const RESERVED = new Set([...FUNCTION_NAMES, ...Object.keys(CONSTANTS), 'mm', 'cm', 'm', 'in', 'ft', 'deg', 'rad']);

/** sin(180) is 1.2e-16 and sin(30) 0.49999999999999994 in floating point: trig results are kept to 15 digits. */
function clean(x) { return Math.abs(x) < 1e-15 ? 0 : Number(x.toPrecision(15)); }

export class ExprError extends Error {
  constructor(message, pos = null) { super(message); this.pos = pos; }
}

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = src.slice(i).match(/^(\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (num) {
      let v = Number(num[0]);
      const at = i;
      i += num[0].length;
      const rest = src.slice(i).replace(/^ (?=[°"'])/, '');
      const u = rest.match(UNIT_RE);
      if (u) { v *= UNITS[u[1]]; i += u[0].length + (src.length - i - rest.length); }
      out.push({ t: 'num', v, pos: at, unit: u ? u[1] : null });
      continue;
    }
    const id = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (id) { out.push({ t: 'id', v: id[0], pos: i }); i += id[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!='].includes(two)) { out.push({ t: two, pos: i }); i += 2; continue; }
    const op = { '+': '+', '-': '-', '−': '-', '–': '-', '*': '*', '×': '*', '·': '*', '/': '/', '÷': '/', '%': '%', '^': '^', '(': '(', ')': ')', ',': ',', '<': '<', '>': '>', '≤': '<=', '≥': '>=', '≠': '!=' }[c];
    if (op) { out.push({ t: op, pos: i }); i++; continue; }
    throw new ExprError(tr('expr.not_allowed_expression', { c }), i);
  }
  out.push({ t: 'end', pos: src.length });
  return out;
}

/**
 * Parse an expression. `names` lists the variables it may use (null = any name, checked at evaluation).
 * → { ok: true, ast, uses: [names] } | { ok: false, error, pos }.
 */
export function parse(src, names = null) {
  const allowed = names ? new Set(names) : null;
  const uses = new Set();
  let tk, i = 0;
  try {
    const s = String(src ?? '');
    if (s.trim() === '') throw new ExprError(tr('expr.type_value_expression_like'), 0);
    if (s.length > 1000) throw new ExprError(tr('expr.expression_too_long_1000'), 0);
    tk = tokenize(s);
    const peek = () => tk[i];
    const take = (t) => { if (tk[i].t !== t) throw new ExprError(expected(t, tk[i]), tk[i].pos); return tk[i++]; };
    let depth = 0;
    const deeper = () => { if (++depth > 100) throw new ExprError(tr('expr.expression_nested_too_deeply'), peek().pos); };
    const cond = () => {
      const a = sum();
      if (['<', '<=', '>', '>=', '==', '!='].includes(peek().t)) { const t = tk[i++]; return { k: 'cmp', op: t.t, a, b: sum() }; }
      return a;
    };
    const sum = () => {
      let n = term();
      while (peek().t === '+' || peek().t === '-') { const op = tk[i++].t; n = { k: 'bin', op, a: n, b: term() }; }
      return n;
    };
    const term = () => {
      let n = power();
      while (['*', '/', '%'].includes(peek().t)) { const t = tk[i++]; n = { k: 'bin', op: t.t, a: n, b: power(), pos: t.pos }; }
      return n;
    };
    const power = () => {
      const a = unary();
      if (peek().t !== '^') return a;
      const t = tk[i++];
      deeper();
      try { return { k: 'bin', op: '^', a, b: power(), pos: t.pos }; } finally { depth--; }
    };
    const unary = () => {
      deeper();
      try {
        if (peek().t === '-') { i++; return { k: 'neg', a: unaryPow() }; }
        if (peek().t === '+') { i++; return unaryPow(); }
        return primary();
      } finally { depth--; }
    };
    // -2^2 = -(2^2) = -4, as in maths (spreadsheets differ; the tests pin this)
    const unaryPow = () => {
      const a = unary();
      if (peek().t !== '^') return a;
      const t = tk[i++];
      return { k: 'bin', op: '^', a, b: power(), pos: t.pos };
    };
    const primary = () => {
      const t = peek();
      if (t.t === 'num') { i++; return { k: 'num', v: t.v }; }
      if (t.t === '(') { i++; const n = cond(); take(')'); return n; }
      if (t.t === 'id') {
        i++;
        if (peek().t === '(') {
          const name = t.v.toLowerCase();
          const f = FUNCS[name];
          if (!f) throw new ExprError(tr('expr.not_function_use', { v: t.v, v2: FUNCTION_NAMES.join(', ') }), t.pos);
          i++;
          const args = [cond()];
          while (peek().t === ',') { i++; args.push(cond()); }
          take(')');
          if (args.length < f.min || args.length > f.max) throw new ExprError(f.min === f.max ? tr('expr.args.exact', { name, n: f.min }) : f.max > 9 ? tr('expr.args.atleast', { name, min: f.min }) : tr('expr.args.range', { name, min: f.min, max: f.max }), t.pos);
          return { k: 'call', name, args, pos: t.pos };
        }
        if (Object.hasOwn(CONSTANTS, t.v)) return { k: 'num', v: CONSTANTS[t.v], name: t.v };
        if (allowed && !allowed.has(t.v)) throw new ExprError(tr('expr.there_no_parameter_called', { v: t.v }), t.pos);
        uses.add(t.v);
        return { k: 'var', name: t.v, pos: t.pos };
      }
      if (t.t === ')' || t.t === ',') throw new ExprError(tr('expr.value_missing_before', { t: t.t }), t.pos);
      throw new ExprError(t.t === 'end' ? tr('expr.expression_ends_too_soon') : tr('expr.unexpected', { v: t.v ?? t.t }), t.pos);
    };
    const ast = cond();
    if (peek().t !== 'end') throw new ExprError(peek().t === ')' ? tr('expr.there_without') : tr('expr.unexpected_operator_missing', { v: peek().v ?? peek().t }), peek().pos);
    return { ok: true, ast, uses: [...uses] };
  } catch (err) {
    if (!(err instanceof ExprError)) throw err;
    return { ok: false, error: err.message, pos: err.pos };
  }
}

function expected(t, got) {
  if (t === ')') return got.t === 'end' ? tr('expr.a_is_missing') : tr('expr.expected_before', { v: got.v ?? got.t });
  return tr('expr.expected', { t });
}

/** Evaluate a parsed tree with values (an object or a Map of name → number). Throws ExprError. */
export function evaluate(ast, values) {
  const get = values instanceof Map ? (n) => values.get(n) : (n) => (Object.hasOwn(values, n) ? values[n] : undefined);
  const ev = (n) => {
    switch (n.k) {
      case 'num': return n.v;
      case 'var': {
        const v = get(n.name);
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new ExprError(tr('expr.has_no_value', { name: n.name }), n.pos);
        return v;
      }
      case 'neg': return -ev(n.a);
      case 'cmp': {
        const a = ev(n.a), b = ev(n.b), tol = EPS * Math.max(1, Math.abs(a), Math.abs(b));
        switch (n.op) {
          case '<': return a < b - tol ? 1 : 0;
          case '<=': return a <= b + tol ? 1 : 0;
          case '>': return a > b + tol ? 1 : 0;
          case '>=': return a >= b - tol ? 1 : 0;
          case '==': return Math.abs(a - b) <= tol ? 1 : 0;
          default: return Math.abs(a - b) > tol ? 1 : 0;
        }
      }
      case 'bin': {
        const a = ev(n.a), b = ev(n.b);
        switch (n.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '^': { const r = a ** b; if (!Number.isFinite(r)) throw new ExprError(tr('expr.power_has_no_value'), n.pos); return r; }
          default:
            if (b === 0) throw new ExprError(tr('expr.expression_divides_zero'), n.pos);
            return n.op === '/' ? a / b : a - b * Math.floor(a / b);
        }
      }
      case 'call': {
        if (n.name === 'if') return ev(n.args[0]) !== 0 ? ev(n.args[1]) : ev(n.args[2]);
        return FUNCS[n.name].fn(...n.args.map(ev));
      }
      default: throw new ExprError(tr('expr.bad_expression'));
    }
  };
  const r = ev(ast);
  if (!Number.isFinite(r)) throw new ExprError(tr('expr.expression_does_not_give'));
  return r;
}

/** Parse + evaluate: { ok, value, uses } | { ok: false, error, pos }. */
export function compute(src, values = {}) {
  const p = parse(src);
  if (!p.ok) return p;
  try { return { ok: true, value: evaluate(p.ast, values), uses: p.uses }; } catch (err) {
    if (!(err instanceof ExprError)) throw err;
    return { ok: false, error: err.message, pos: err.pos };
  }
}

/** Is this expression a plain number (with or without a unit)? → the number, or null. */
export function literal(src) {
  const p = parse(src, []);
  if (!p.ok) return null;
  const n = p.ast.k === 'neg' && p.ast.a.k === 'num' && !p.ast.a.name ? -p.ast.a.v : p.ast.k === 'num' && !p.ast.name ? p.ast.v : null;
  return n;
}

/** Shortest text for a number that reads back to the same value (to 12 significant digits). */
export function formatNumber(v) {
  if (!Number.isFinite(v)) return String(v);
  const r = Number(v.toPrecision(12));
  return Object.is(r, -0) ? '0' : String(r);
}

/**
 * Solve f(x) = target for one variable: the value of `name` that makes the expression give `target`,
 * the other values held. Starts at the variable's current value; secant steps, then a bracketing
 * search outward, then bisection. → { ok, value } | { ok: false, error }.
 */
export function solveFor(ast, values, name, target, { tol = 1e-9 } = {}) {
  const base = values instanceof Map ? Object.fromEntries(values) : { ...values };
  const x0 = Number.isFinite(base[name]) ? base[name] : 1;
  const f = (x) => { base[name] = x; try { return evaluate(ast, base) - target; } catch { return NaN; } };
  const scale = Math.max(1, Math.abs(target), Math.abs(x0));
  const close = (y) => Number.isFinite(y) && Math.abs(y) <= tol * scale;
  let a = x0, fa = f(a);
  if (close(fa)) return { ok: true, value: a };
  // secant from the current value (linear expressions land in one step)
  let b = x0 === 0 ? 1e-3 : x0 * (1 + 1e-4), fb = f(b);
  for (let k = 0; k < 60 && Number.isFinite(fa) && Number.isFinite(fb) && fb !== fa; k++) {
    const c = b - fb * (b - a) / (fb - fa), fc = f(c);
    if (close(fc)) return { ok: true, value: polish(c) };
    a = b; fa = fb; b = c; fb = fc;
  }
  // bracket outward from x0, then bisect
  const g0 = f(x0);
  for (let step = Math.max(1e-6, Math.abs(x0) * 1e-3); step < 1e9; step *= 2) {
    for (const s of [x0 + step, x0 - step]) {
      const gs = f(s);
      if (close(gs)) return { ok: true, value: polish(s) };
      if (Number.isFinite(g0) && Number.isFinite(gs) && Math.sign(gs) !== Math.sign(g0)) {
        let lo = x0, hi = s, glo = g0;
        for (let k = 0; k < 200; k++) {
          const mid = (lo + hi) / 2, gm = f(mid);
          if (close(gm) || Math.abs(hi - lo) <= 1e-15 * Math.max(1, Math.abs(mid))) return { ok: true, value: polish(mid) };
          if (Math.sign(gm) === Math.sign(glo)) { lo = mid; glo = gm; } else hi = mid;
        }
      }
    }
  }
  return { ok: false, error: tr('expr.no_value_gives', { name, target: formatNumber(target) }) };
}
const polish = (x) => { const r = Number(x.toPrecision(13)); return Math.abs(r - x) <= 1e-12 * Math.max(1, Math.abs(x)) ? r : x; };

/** Rewrite an expression's text with a parameter renamed (whole names only, never inside other names). */
export function renameIn(src, from, to) {
  return String(src).replace(/[A-Za-z_][A-Za-z0-9_]*/g, (m, at, s) => {
    const prev = s[at - 1];
    if (prev && /[0-9.]/.test(prev)) return m;   // a unit after a number (25mm)
    return m === from ? to : m;
  });
}
