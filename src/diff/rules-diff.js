// Design rule diff: the board constraints, DRC severities, netclasses and
// their assignments in a .kicad_pro, and the custom rules of a .kicad_dru.
//
// Everything else a .kicad_pro holds (window layout, plot and ERC settings,
// last used paths) changes on almost every save and is ignored. Changes carry
// `rows` ([setting, before, after]) for the diff page's rules table.

import { parse, child, children } from "../sexpr.js";
import { summarize } from "./sch-diff.js";

const r4 = (v) => Math.round(v * 10000) / 10000;
const UNITLESS = new Set(["min_resolved_spokes", "priority", "use_height_for_length_calcs"]);

/**
 * @param {string} path      the file (decides .kicad_pro or .kicad_dru)
 * @param {string|null} ta   text before (null if added)
 * @param {string|null} tb   text after (null if removed)
 * @returns {{changes: object[], summary: object}}
 */
export function diffRules(path, ta, tb) {
  const changes = /\.kicad_dru$/i.test(path) ? diffDru(ta, tb) : diffProject(ta && JSON.parse(ta), tb && JSON.parse(tb));
  return { changes, summary: summarize(changes) };
}

// ---- .kicad_pro --------------------------------------------------------------

/**
 * @param {object|null} a  parsed .kicad_pro before
 * @param {object|null} b  parsed .kicad_pro after
 */
export function diffProject(a, b) {
  const changes = [];
  const dsA = a?.board?.design_settings ?? {}, dsB = b?.board?.design_settings ?? {};

  // Constraints (Board Setup → Design Rules → Constraints).
  for (const [k, x, y] of changedKeys(dsA.rules, dsB.rules)) {
    const unit = UNITLESS.has(k) ? "" : "mm";
    changes.push(change(x, y, "constraint", humanize(k), [[humanize(k), show(x, unit), show(y, unit)]]));
  }
  // DRC checks switched between error, warning and ignore.
  for (const [k, x, y] of changedKeys(dsA.rule_severities, dsB.rule_severities)) {
    changes.push(change(x, y, "DRC check", humanize(k), [[humanize(k), show(x), show(y)]]));
  }
  // Predefined sizes (the track and via dropdowns).
  const sizeLists = [
    ["track_widths", "Track widths", (w) => show(w, "mm")],
    ["via_dimensions", "Via sizes", (v) => `${r4(v.diameter)} / ${r4(v.drill)} mm`],
    ["diff_pair_dimensions", "Differential pairs", (p) => `${r4(p.width)} / ${r4(p.gap)} / ${r4(p.via_gap)} mm`],
  ];
  for (const [k, label, fmt] of sizeLists) {
    // The first entry is a placeholder for "use the netclass".
    const la = (dsA[k] ?? []).slice(1).map(fmt), lb = (dsB[k] ?? []).slice(1).map(fmt);
    const added = lb.filter((v) => !la.includes(v)), removed = la.filter((v) => !lb.includes(v));
    if (!added.length && !removed.length) continue;
    const rows = [...removed.map((v) => [label, v, "—"]), ...added.map((v) => [label, "—", v])];
    const detail = [added.length ? `+ ${added.join(", ")}` : "", removed.length ? `− ${removed.join(", ")}` : ""].filter(Boolean).join("; ");
    changes.push({ kind: added.length && removed.length ? "modified" : added.length ? "added" : "removed", type: "size presets", label, detail, rows });
  }

  // Netclasses by name.
  const nsA = a?.net_settings ?? {}, nsB = b?.net_settings ?? {};
  const classesA = new Map((nsA.classes ?? []).map((c) => [c.name, c]));
  const classesB = new Map((nsB.classes ?? []).map((c) => [c.name, c]));
  for (const name of new Set([...classesA.keys(), ...classesB.keys()])) {
    const x = classesA.get(name), y = classesB.get(name);
    // KiCad 9+ leaves out what a netclass inherits from Default.
    const cell = (c, k, unit) => (!c ? "—" : c[k] == null && c.name !== "Default" ? "from Default" : show(c[k], unit));
    const rows = NETCLASS_FIELDS.filter(([k]) => !same(x?.[k], y?.[k])).map(([k, label, unit]) => [label, cell(x, k, unit), cell(y, k, unit)]);
    if (!rows.length) continue;
    const detail = x && y ? rows.map(([l, p, q]) => `${l} ${p} → ${q}`).join("; ") : rows.filter(([, p, q]) => (y ? q : p) !== "from Default").slice(0, 3).map(([l, p, q]) => `${l} ${y ? q : p}`).join(", ");
    changes.push({ kind: x && y ? "modified" : y ? "added" : "removed", type: "netclass", label: name, detail: x && y ? detail : detail || (y ? "added" : "removed"), rows });
  }
  // Pattern assignments (net name pattern → netclass).
  const patterns = (ns) => new Map((ns.netclass_patterns ?? []).map((p) => [p.pattern, p.netclass]));
  const pa = patterns(nsA), pb = patterns(nsB);
  for (const pattern of new Set([...pa.keys(), ...pb.keys()])) {
    const x = pa.get(pattern), y = pb.get(pattern);
    if (x === y) continue;
    changes.push({ kind: x && y ? "modified" : y ? "added" : "removed", type: "netclass pattern", label: pattern, detail: x && y ? `${x} → ${y}` : x ?? y, rows: [[pattern, x ?? "—", y ?? "—"]] });
  }
  // Nets given another netclass (KiCad 7+ netclass_assignments, KiCad 6 classes[].nets).
  const assignments = (ns) => {
    const m = new Map();
    for (const [net, cls] of Object.entries(ns.netclass_assignments ?? {})) m.set(net, [cls].flat().join(", "));
    for (const c of ns.classes ?? []) for (const net of c.nets ?? []) m.set(net, c.name);
    return m;
  };
  const aa = assignments(nsA), ab = assignments(nsB);
  const moved = new Map(); // netclass after (or "Default") → rows
  for (const net of new Set([...aa.keys(), ...ab.keys()])) {
    const x = aa.get(net) ?? "Default", y = ab.get(net) ?? "Default";
    if (x === y) continue;
    if (!moved.has(y)) moved.set(y, []);
    moved.get(y).push([net, x, y]);
  }
  for (const [cls, rows] of moved) {
    rows.sort((p, q) => p[0].localeCompare(q[0], undefined, { numeric: true }));
    const nets = rows.map((r) => r[0]);
    changes.push({ kind: "modified", type: "net assignment", label: cls, detail: `${nets.length} net${nets.length > 1 ? "s" : ""} moved here: ${nets.slice(0, 4).join(", ")}${nets.length > 4 ? "…" : ""}`, rows });
  }
  return changes;
}

const NETCLASS_FIELDS = [
  ["clearance", "Clearance", "mm"],
  ["track_width", "Track width", "mm"],
  ["via_diameter", "Via diameter", "mm"],
  ["via_drill", "Via hole", "mm"],
  ["microvia_diameter", "Microvia diameter", "mm"],
  ["microvia_drill", "Microvia hole", "mm"],
  ["diff_pair_width", "Diff pair width", "mm"],
  ["diff_pair_gap", "Diff pair gap", "mm"],
  ["diff_pair_via_gap", "Diff pair via gap", "mm"],
  ["priority", "Priority", ""],
];

// ---- .kicad_dru --------------------------------------------------------------

/**
 * Custom rules matched by name; a changed rule lists which of its condition,
 * layer, severity and constraints differ.
 * @param {string|null} ta
 * @param {string|null} tb
 */
export function diffDru(ta, tb) {
  const ra = ta == null ? new Map() : druRules(ta), rb = tb == null ? new Map() : druRules(tb);
  const changes = [];
  for (const name of new Set([...ra.keys(), ...rb.keys()])) {
    const x = ra.get(name), y = rb.get(name);
    const keys = [...new Set([...(x ? x.parts.keys() : []), ...(y ? y.parts.keys() : [])])];
    const rows = keys.filter((k) => x?.parts.get(k) !== y?.parts.get(k)).map((k) => [k, x?.parts.get(k) ?? "—", y?.parts.get(k) ?? "—"]);
    if (!rows.length) continue;
    const detail = x && y ? rows.map(([k]) => k).join(", ") + " changed" : (y ?? x).parts.get("condition") ?? [...(y ?? x).parts.values()][0] ?? "";
    changes.push({ kind: x && y ? "modified" : y ? "added" : "removed", type: "custom rule", label: name, detail, rows });
  }
  return changes;
}

/** A .kicad_dru's rules: name → {parts: Map("condition" | "layer" | "severity" | "constraint <type>" → text)}. */
function druRules(text) {
  // Several top-level expressions and # comments: strip those, wrap the rest in one list.
  const root = parse(`(kicad_dru\n${stripComments(text)}\n)`);
  const rules = new Map();
  for (const r of children(root, "rule")) {
    let name = String(r[1] ?? "");
    for (let i = 2; rules.has(name); i++) name = `${r[1]} (${i})`;
    const parts = new Map();
    for (const k of ["condition", "layer", "severity"]) {
      const n = child(r, k);
      if (n) parts.set(k, n.slice(1).map(sx).join(" "));
    }
    for (const c of children(r, "constraint")) {
      let key = `constraint ${c[1]}`;
      for (let i = 2; parts.has(key); i++) key = `constraint ${c[1]} (${i})`;
      parts.set(key, c.slice(2).map(sx).join(" ") || "—");
    }
    rules.set(name, { parts });
  }
  return rules;
}

/** Drop # comments (to the end of the line, outside quoted strings). */
function stripComments(text) {
  let out = "", inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else out += c;
  }
  return out;
}

/** An S-expression node back as text, enough to show and compare a constraint. */
function sx(n) {
  return Array.isArray(n) ? `(${n.map(sx).join(" ")})` : String(n);
}

// ---- helpers -----------------------------------------------------------------

function changedKeys(x = {}, y = {}) {
  const out = [];
  for (const k of new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})])) if (!same(x?.[k], y?.[k])) out.push([k, x?.[k], y?.[k]]);
  return out;
}

function same(x, y) {
  if (x == null && y == null) return true;
  return typeof x === "number" && typeof y === "number" ? r4(x) === r4(y) : JSON.stringify(x) === JSON.stringify(y);
}

function change(x, y, type, label, rows) {
  const kind = x === undefined ? "added" : y === undefined ? "removed" : "modified";
  return { kind, type, label, detail: `${rows[0][1]} → ${rows[0][2]}`, rows };
}

/** min_via_annular_width → Min via annular width */
function humanize(k) {
  const s = k.replace(/_/g, " ");
  return s[0].toUpperCase() + s.slice(1);
}

function show(v, unit = "") {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return unit ? `${r4(v)} ${unit}` : String(r4(v));
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}
