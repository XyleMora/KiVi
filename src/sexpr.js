// KiCad S-expression parser.
//
// A list becomes a JS array; its first element is normally the head symbol
// (e.g. ["at", 10, 20, 90]). Unquoted atoms that look numeric become numbers,
// everything else (including every quoted string) stays a string, so quoted
// pin numbers like "1" are never turned into numbers.

const OPEN = 40, CLOSE = 41, QUOTE = 34, BACKSLASH = 92;

function isSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/**
 * Parse KiCad S-expression text.
 * @param {string} text
 * @returns {any[]} the top-level list (e.g. ["kicad_sch", ...])
 */
export function parse(text) {
  const len = text.length;
  const stack = [];
  let cur = null;
  let root = null;
  let i = 0;

  while (i < len) {
    const c = text.charCodeAt(i);
    if (isSpace(c)) {
      i++;
    } else if (c === OPEN) {
      const list = [];
      if (cur) cur.push(list);
      else if (!root) root = list;
      stack.push(cur);
      cur = list;
      i++;
    } else if (c === CLOSE) {
      if (!cur) throw new SyntaxError(`Unbalanced ')' at offset ${i}`);
      cur = stack.pop();
      i++;
      if (!cur && root) break;
    } else if (c === QUOTE) {
      i++;
      let start = i;
      let out = null;
      while (i < len) {
        const d = text.charCodeAt(i);
        if (d === QUOTE) break;
        if (d === BACKSLASH) {
          out = (out ?? "") + text.slice(start, i);
          const e = text[i + 1];
          out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e;
          i += 2;
          start = i;
          continue;
        }
        i++;
      }
      if (i >= len) throw new SyntaxError("Unterminated string");
      const s = out === null ? text.slice(start, i) : out + text.slice(start, i);
      i++;
      if (cur) cur.push(s);
    } else {
      const start = i;
      while (i < len) {
        const d = text.charCodeAt(i);
        if (isSpace(d) || d === OPEN || d === CLOSE) break;
        i++;
      }
      const tok = text.slice(start, i);
      // Fast path: first char decides whether a number test is worth it.
      const f = tok.charCodeAt(0);
      const maybeNum = (f >= 48 && f <= 57) || f === 45 || f === 43 || f === 46;
      const v = maybeNum && NUMERIC.test(tok) ? Number(tok) : tok;
      if (cur) cur.push(v);
    }
  }
  if (cur) throw new SyntaxError("Unexpected end of input (unclosed list)");
  if (!root) throw new SyntaxError("No S-expression found");
  return root;
}

// ---- Tree helpers --------------------------------------------------------

/** First child list whose head is `name`. */
export function child(node, name) {
  if (!node) return undefined;
  for (let i = 1; i < node.length; i++) {
    const n = node[i];
    if (Array.isArray(n) && n[0] === name) return n;
  }
  return undefined;
}

/** All child lists whose head is `name` (or any of `names`). */
export function children(node, ...names) {
  const out = [];
  if (!node) return out;
  for (let i = 1; i < node.length; i++) {
    const n = node[i];
    if (Array.isArray(n) && names.includes(n[0])) out.push(n);
  }
  return out;
}

/** Value at position `idx` of child list `name`: (name v1 v2 ...). */
export function value(node, name, idx = 1, fallback = undefined) {
  const c = child(node, name);
  return c && c.length > idx ? c[idx] : fallback;
}

/** True if `atom` appears as a bare atom child, e.g. (pad ... locked). */
export function hasAtom(node, atom) {
  if (!node) return false;
  for (let i = 1; i < node.length; i++) if (node[i] === atom) return true;
  return false;
}

/**
 * KiCad booleans come in several shapes across versions:
 * `(hide yes)`, `(hide)`, a bare `hide` atom, or absent.
 */
export function flag(node, name, fallback = false) {
  if (!node) return fallback;
  if (hasAtom(node, name)) return true;
  const c = child(node, name);
  if (!c) return fallback;
  if (c.length === 1) return true;
  return c[1] === "yes" || c[1] === true || c[1] === "true";
}

/** (at x y [angle]) → {x, y, angle} */
export function at(node, name = "at") {
  const c = child(node, name);
  if (!c) return { x: 0, y: 0, angle: 0 };
  return { x: num(c[1]), y: num(c[2]), angle: num(c[3]) };
}

/** (xy x y) / (start x y) etc. → {x, y} */
export function xy(node, name) {
  const c = name ? child(node, name) : node;
  if (!c) return undefined;
  return { x: num(c[1]), y: num(c[2]) };
}

export function num(v, fallback = 0) {
  return typeof v === "number" ? v : fallback;
}
