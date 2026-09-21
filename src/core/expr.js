/* A very small expression language, so a design can be written in terms of itself.
 *
 * Geometry authored as bare numbers is geometry that only describes one machine. The moment a
 * coil outline says `ro - 1` rather than `39`, changing the outer radius moves the coil with it,
 * every derived coordinate stays consistent, and the parameter becomes something a sweep or an
 * optimizer can vary. That is the whole reason this file exists: it is less a convenience than it
 * is the design-variable space.
 *
 *   evalExpr("min(ro - 1, 2 * ri)", scope)   -> number
 *   resolveScope({ ri: 15, ro: "3 * ri" })   -> { ri: 15, ro: 45 }
 *
 * It is a hand-written tokenizer and recursive-descent parser rather than `new Function`, for two
 * reasons that both matter here. A spec is untrusted input — it arrives from a file, a URL or an
 * agent — and handing it to the JavaScript engine would make "geometry" a code-execution surface.
 * And a restricted grammar can produce *useful* errors: an unknown name can be reported with the
 * list of names that were in scope and the nearest match, which is what turns a failed generation
 * into a fixed one on the next attempt rather than a guessing game.
 *
 * The grammar, in full:
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | '%') unary)*
 *   unary   := ('-' | '+') unary | power       so -2^2 is -4, as in mathematical notation
 *   power   := primary ('^' unary)?            right associative; 2^-3 is allowed
 *   primary := number | name | name '(' args ')' | '(' expr ')'
 *
 * No assignment, no statements, no strings, no member access, no control flow. Everything is a
 * finite double.
 */

/* Functions available to an expression. Names are lower case; `deg`/`rad` convert, because angles
 * in this codebase are radians internally and degrees in every user-facing field, and that
 * conversion is exactly where a hand-written expression goes wrong. */
export const FUNCTIONS = {
  min: Math.min, max: Math.max, abs: Math.abs, sqrt: Math.sqrt,
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  hypot: Math.hypot, log: Math.log, exp: Math.exp, pow: Math.pow,
  deg: r => r * 180 / Math.PI,
  rad: d => d * Math.PI / 180,
  clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v))
};

/* Constants, folded into every scope. Shadowable by a parameter of the same name, because a design
 * that wants a parameter called `e` should get it rather than a lecture. */
export const CONSTANTS = { pi: Math.PI, tau: 2 * Math.PI, e: Math.E };

const ARITY = { atan2: 2, pow: 2, clamp: 3 };   // everything else is 1, or variadic for min/max/hypot
const VARIADIC = new Set(["min", "max", "hypot"]);

export class ExprError extends Error {}

/* ---- tokenizer ------------------------------------------------------------------------------ */

const isDigit = c => c >= "0" && c <= "9";
const isNameStart = c => /[A-Za-z_]/.test(c);
const isNameChar = c => /[A-Za-z0-9_.]/.test(c);

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
      const start = i;
      while (i < src.length && isDigit(src[i])) i++;
      if (src[i] === ".") { i++; while (i < src.length && isDigit(src[i])) i++; }
      // An exponent only counts if it is actually followed by digits, so `2e` reads as a number
      // times a name rather than as a truncated literal — and then fails as a syntax error.
      if ((src[i] === "e" || src[i] === "E")) {
        let j = i + 1;
        if (src[j] === "+" || src[j] === "-") j++;
        if (isDigit(src[j])) { j++; while (j < src.length && isDigit(src[j])) j++; i = j; }
      }
      out.push({ t: "num", v: +src.slice(start, i), at: start });
      continue;
    }
    if (isNameStart(c)) {
      const start = i;
      while (i < src.length && isNameChar(src[i])) i++;
      out.push({ t: "name", v: src.slice(start, i), at: start });
      continue;
    }
    if ("+-*/%^(),".includes(c)) { out.push({ t: c, at: i }); i++; continue; }
    throw new ExprError(`Unexpected character ${JSON.stringify(c)} at position ${i} of ${JSON.stringify(src)}.`);
  }
  out.push({ t: "end", at: src.length });
  return out;
}

/* ---- parser --------------------------------------------------------------------------------- */

/* Parses to a tree once; `compile` hands back something that can be evaluated against many scopes,
 * which is what a sweep does thousands of times. */
export function parseExpr(src) {
  const tk = tokenize(src);
  let pos = 0;
  const peek = () => tk[pos];
  const take = t => {
    if (tk[pos].t !== t) throw new ExprError(
      `Expected ${t === "end" ? "the end of the expression" : JSON.stringify(t)} but found ` +
      `${describe(tk[pos])} at position ${tk[pos].at} of ${JSON.stringify(src)}.`);
    return tk[pos++];
  };

  const expr = () => {
    let a = term();
    while (peek().t === "+" || peek().t === "-") { const op = tk[pos++].t; a = { op, a, b: term() }; }
    return a;
  };
  const term = () => {
    let a = unary();
    while (peek().t === "*" || peek().t === "/" || peek().t === "%") { const op = tk[pos++].t; a = { op, a, b: unary() }; }
    return a;
  };
  /* Unary minus binds *looser* than the power, so -2^2 is -4, as it is in mathematical notation
   * and in Python. JavaScript refuses to answer the question at all — `-2 ** 2` is a syntax error
   * — which is not an option for a language that has to accept whatever an author writes. */
  const unary = () => {
    if (peek().t === "-") { pos++; return { op: "neg", a: unary() }; }
    if (peek().t === "+") { pos++; return unary(); }
    return power();
  };
  // Right associative, and its exponent may itself be signed: 2^-3 is a valid eighth.
  const power = () => {
    const a = primary();
    if (peek().t === "^") { pos++; return { op: "^", a, b: unary() }; }
    return a;
  };
  const primary = () => {
    const t = peek();
    if (t.t === "num") { pos++; return { op: "num", v: t.v }; }
    if (t.t === "(") { pos++; const e = expr(); take(")"); return e; }
    if (t.t === "name") {
      pos++;
      if (peek().t === "(") {
        pos++;
        const args = [];
        if (peek().t !== ")") { args.push(expr()); while (peek().t === ",") { pos++; args.push(expr()); } }
        take(")");
        return { op: "call", name: t.v, args, at: t.at, src };
      }
      return { op: "ref", name: t.v, at: t.at, src };
    }
    throw new ExprError(`Expected a number, a name or "(" but found ${describe(t)} at position ${t.at} of ${JSON.stringify(src)}.`);
  };

  const tree = expr();
  take("end");
  return tree;
}

const describe = t => t.t === "end" ? "the end of the expression"
  : t.t === "num" ? `the number ${t.v}`
  : t.t === "name" ? `the name ${JSON.stringify(t.v)}`
  : JSON.stringify(t.t);

/* ---- evaluation ----------------------------------------------------------------------------- */

function evalNode(n, scope) {
  switch (n.op) {
    case "num": return n.v;
    case "neg": return -evalNode(n.a, scope);
    case "+": return evalNode(n.a, scope) + evalNode(n.b, scope);
    case "-": return evalNode(n.a, scope) - evalNode(n.b, scope);
    case "*": return evalNode(n.a, scope) * evalNode(n.b, scope);
    case "/": return evalNode(n.a, scope) / evalNode(n.b, scope);
    case "%": return evalNode(n.a, scope) % evalNode(n.b, scope);
    case "^": return Math.pow(evalNode(n.a, scope), evalNode(n.b, scope));
    case "ref": {
      const v = lookup(n.name, scope);
      if (v === undefined) throw new ExprError(unknownName(n.name, scope, "name"));
      if (typeof v !== "number" || !Number.isFinite(v))
        throw new ExprError(`${JSON.stringify(n.name)} is ${JSON.stringify(v)}, which is not a finite number.`);
      return v;
    }
    case "call": {
      const f = FUNCTIONS[n.name];
      if (!f) throw new ExprError(unknownName(n.name, scope, "function"));
      const args = n.args.map(a => evalNode(a, scope));
      if (!VARIADIC.has(n.name)) {
        const want = ARITY[n.name] ?? 1;
        if (args.length !== want) throw new ExprError(
          `${n.name}() takes ${want} argument${want === 1 ? "" : "s"}, but was given ${args.length}.`);
      } else if (!args.length) throw new ExprError(`${n.name}() needs at least one argument.`);
      return f(...args);
    }
  }
  throw new ExprError(`Internal: unknown node ${n.op}.`);
}

const lookup = (name, scope) => (name in scope ? scope[name] : CONSTANTS[name]);

/* The error an author actually needs: what was not found, what was available, and the nearest
 * match. Sorted by edit distance, then alphabetically, and capped so the message stays readable on
 * a scope with a hundred landmarks in it. */
function unknownName(name, scope, kind) {
  const pool = kind === "function" ? Object.keys(FUNCTIONS)
    : [...Object.keys(scope), ...Object.keys(CONSTANTS)];
  const ranked = pool.map(k => [distance(name.toLowerCase(), k.toLowerCase()), k])
    .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  const near = ranked.length && ranked[0][0] <= Math.max(2, Math.ceil(name.length / 3)) ? ranked[0][1] : null;
  const list = ranked.slice(0, 12).map(r => r[1]).join(", ");
  return `Unknown ${kind} ${JSON.stringify(name)}.` + (near ? ` Did you mean ${JSON.stringify(near)}?` : "") +
         (pool.length ? ` Available: ${list}${ranked.length > 12 ? ", …" : ""}.` : "");
}

function distance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/* Evaluate one expression against a scope of numbers. A number passes straight through, so callers
 * never have to ask which form a field is in. */
export function evalExpr(src, scope = {}) {
  if (typeof src === "number") {
    if (!Number.isFinite(src)) throw new ExprError(`${JSON.stringify(src)} is not a finite number.`);
    return src;
  }
  if (typeof src !== "string") throw new ExprError(`Expected a number or an expression, got ${JSON.stringify(src)}.`);
  const v = evalNode(parseExpr(src), scope);
  if (!Number.isFinite(v)) throw new ExprError(`${JSON.stringify(src)} evaluates to ${v}, which is not a finite number.`);
  return v;
}

/* The names an expression reads, for dependency ordering and for reporting what an edit affects. */
export function dependencies(src) {
  const out = new Set();
  if (typeof src !== "string") return out;
  (function walk(n) {
    if (n.op === "ref") out.add(n.name);
    else if (n.op === "call") n.args.forEach(walk);
    else { if (n.a) walk(n.a); if (n.b) walk(n.b); }
  })(parseExpr(src));
  return out;
}

/* ---- scopes --------------------------------------------------------------------------------- */

/* Resolve a set of definitions, each a number or an expression over the others and over `base`.
 *
 * Order is discovered rather than required: definitions resolve lazily on first use, so a spec can
 * list its parameters in whatever order reads best. A definition that depends on itself, directly
 * or through others, is reported with the cycle spelled out — which is the one mistake in this
 * system that produces an infinite loop rather than a wrong number.
 */
export function resolveScope(defs = {}, base = {}) {
  const out = { ...base };
  const state = new Map();          // name -> "busy" | "done"
  const stack = [];

  const resolve = name => {
    if (state.get(name) === "done") return out[name];
    if (state.get(name) === "busy") {
      const cycle = [...stack.slice(stack.indexOf(name)), name].join(" -> ");
      throw new ExprError(`The parameter ${JSON.stringify(name)} is defined in terms of itself: ${cycle}.`);
    }
    state.set(name, "busy");
    stack.push(name);
    const src = defs[name];
    let value;
    try {
      value = typeof src === "string" ? evalNode(parseExpr(src), proxy) : evalExpr(src, proxy);
    } catch (e) {
      // Attribute the failure to the parameter being resolved, but only once: a cycle surfaces
      // several frames deep and should read as one sentence, not as a stack of prefixes.
      if (!(e instanceof ExprError) || e.attributed) throw e;
      const wrapped = new ExprError(`Parameter ${JSON.stringify(name)}: ${e.message}`);
      wrapped.attributed = true;
      throw wrapped;
    }
    stack.pop();
    state.set(name, "done");
    out[name] = value;
    return value;
  };

  /* Reads go through a proxy so a reference resolves its dependency on demand. `has` reports the
   * union of what is defined and what the base scope already holds, so an unknown name is still
   * reported by the evaluator rather than silently becoming undefined. */
  const proxy = new Proxy(out, {
    get: (t, k) => (typeof k === "string" && k in defs && state.get(k) !== "done" ? resolve(k) : t[k]),
    has: (t, k) => k in t || k in defs
  });

  for (const name of Object.keys(defs)) resolve(name);
  return out;
}

/* Evaluate a field that may be a number or an expression, reporting where it came from. Used by
 * the geometry normalizer for every numeric field, so a bad expression names its own JSON path. */
export function field(value, scope, path, fallback) {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw new ExprError(`${path} is required.`);
    return fallback;
  }
  try { return evalExpr(value, scope); }
  catch (e) { throw e instanceof ExprError ? new ExprError(`${path}: ${e.message}`) : e; }
}
