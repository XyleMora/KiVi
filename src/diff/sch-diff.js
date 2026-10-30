// Semantic diff of two versions of one schematic sheet.
//
// Symbols and sheets are matched by UUID (stable across edits in KiCad);
// wires, labels, junctions and text by geometry, nets by the pins they
// connect (net-diff.js). Each change carries bounding boxes (document mm) for
// highlighting before/after.

import { BBox } from "../geom.js";
import { buildConnectivity } from "../sch/connectivity.js";
import { diffNets } from "./net-diff.js";
import { libSymbolFor } from "../sch/model.js";

const r3 = (v) => Math.round(v * 1000) / 1000;
const key2 = (x, y) => `${r3(x)},${r3(y)}`;

/**
 * @param {object} a       parsed schematic (before) or null if the file was added
 * @param {object} b       parsed schematic (after) or null if the file was removed
 * @param {object} ra      renderSchematic() result for `a` (items with bboxes)
 * @param {object} rb      renderSchematic() result for `b`
 * @returns {{changes: object[], summary: object, connA: object|null, connB: object|null}}
 *   connA/connB: each side's buildConnectivity(), for callers that need it too
 */
export function diffSchematic(a, b, ra, rb) {
  const changes = [];
  const symItems = (r) => new Map((r?.items ?? []).filter((i) => i.kind === "symbol" || i.kind === "sheet").map((i) => [i.uuid, i]));
  const ia = symItems(ra), ib = symItems(rb);

  // ---- symbols ----
  const sa = new Map((a?.symbols ?? []).map((s) => [s.uuid, s]));
  const sb = new Map((b?.symbols ?? []).map((s) => [s.uuid, s]));
  // The sheet's copy of each library symbol (pins, graphics), compared once per
  // pair of copies and reported once with the parts that use it.
  const libDiffs = new Map(); // "nameA\nnameB" → string[]
  const libChanged = new Map(); // same key → change
  for (const [uuid, s] of sa) {
    const item = ia.get(uuid);
    if (!sb.has(uuid)) {
      changes.push({ kind: "removed", type: "symbol", label: item?.reference ?? prop(s, "Reference"), detail: prop(s, "Value"), before: item?.bbox, power: item?.power });
      continue;
    }
    const t = sb.get(uuid);
    const itemB = ib.get(uuid);
    const diffs = symbolDiffs(s, t, item, itemB);
    if (diffs.length) changes.push({ kind: "modified", type: "symbol", label: itemB?.reference ?? prop(t, "Reference"), detail: diffs.join("; "), fields: diffs, before: item?.bbox, after: itemB?.bbox, power: itemB?.power });
    const la = s.libId === t.libId && libSymbolFor(a, s), lb = la && libSymbolFor(b, t);
    if (!lb) continue; // another library symbol is already a symbol change
    const key = `${la.name}\n${lb.name}`;
    if (!libDiffs.has(key)) libDiffs.set(key, libSymbolDiffs(la, lb));
    if (!libDiffs.get(key).length) continue;
    if (!libChanged.has(key)) libChanged.set(key, { kind: "modified", type: "library symbol", label: t.libId, fields: libDiffs.get(key), refs: [], boxesBefore: [], boxesAfter: [] });
    const c = libChanged.get(key);
    c.refs.push(itemB?.reference ?? prop(t, "Reference"));
    if (item?.bbox) c.boxesBefore.push(item.bbox);
    if (itemB?.bbox) c.boxesAfter.push(itemB.bbox);
  }
  for (const c of libChanged.values()) {
    const refs = [...new Set(c.refs)].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
    c.detail = `${c.fields.join("; ")} · used by ${refs.length > 8 ? `${refs.slice(0, 8).join(", ")} and ${refs.length - 8} more` : refs.join(", ")}`;
    c.before = union(c.boxesBefore);
    c.after = union(c.boxesAfter);
    changes.push(c);
  }
  for (const [uuid, t] of sb) {
    if (sa.has(uuid)) continue;
    const item = ib.get(uuid);
    changes.push({ kind: "added", type: "symbol", label: item?.reference ?? prop(t, "Reference"), detail: prop(t, "Value"), after: item?.bbox, power: item?.power });
  }

  // ---- sheets ----
  const sha = new Map((a?.sheets ?? []).map((s) => [s.uuid, s]));
  const shb = new Map((b?.sheets ?? []).map((s) => [s.uuid, s]));
  for (const [uuid, s] of sha) {
    if (!shb.has(uuid)) changes.push({ kind: "removed", type: "sheet", label: s.name, detail: s.file, before: sheetBox(s) });
    else {
      const t = shb.get(uuid);
      const d = [];
      if (s.name !== t.name) d.push(`name ${s.name} → ${t.name}`);
      if (s.file !== t.file) d.push(`file ${s.file} → ${t.file}`);
      if (r3(s.x) !== r3(t.x) || r3(s.y) !== r3(t.y) || r3(s.w) !== r3(t.w) || r3(s.h) !== r3(t.h)) d.push("moved/resized");
      const pa = new Set(s.pins.map((p) => p.name)), pb = new Set(t.pins.map((p) => p.name));
      const addedPins = [...pb].filter((p) => !pa.has(p)), removedPins = [...pa].filter((p) => !pb.has(p));
      if (addedPins.length) d.push(`pins added: ${addedPins.join(", ")}`);
      if (removedPins.length) d.push(`pins removed: ${removedPins.join(", ")}`);
      if (d.length) changes.push({ kind: "modified", type: "sheet", label: t.name, detail: d.join("; "), fields: d, before: sheetBox(s), after: sheetBox(t) });
    }
  }
  for (const [uuid, t] of shb) if (!sha.has(uuid)) changes.push({ kind: "added", type: "sheet", label: t.name, detail: t.file, after: sheetBox(t) });

  // ---- nets (connectivity) ----
  const connA = a && ra ? buildConnectivity(a, ra.items) : null;
  const connB = b && rb ? buildConnectivity(b, rb.items) : null;
  changes.push(...diffNets(connA, connB, ra, rb));

  // ---- wires & buses (geometry) ----
  for (const [type, la, lb] of [["wire", a?.wires, b?.wires], ["bus", a?.buses, b?.buses]]) {
    const ka = lineKeys(la ?? []), kb = lineKeys(lb ?? []);
    const removed = [...ka].filter(([k]) => !kb.has(k)).map(([, w]) => w);
    const added = [...kb].filter(([k]) => !ka.has(k)).map(([, w]) => w);
    if (removed.length) changes.push({ kind: "removed", type, label: `${removed.length} ${type}${removed.length > 1 ? (type === "bus" ? "es" : "s") : ""}`, before: unionLines(removed), paths: removed.map((w) => w.pts) });
    if (added.length) changes.push({ kind: "added", type, label: `${added.length} ${type}${added.length > 1 ? (type === "bus" ? "es" : "s") : ""}`, after: unionLines(added), paths: added.map((w) => w.pts) });
  }

  // ---- labels ----
  const lk = (l) => `${l.kind}|${l.text}|${key2(l.x, l.y)}`;
  const la = new Map((a?.labels ?? []).map((l) => [lk(l), l]));
  const lb = new Map((b?.labels ?? []).map((l) => [lk(l), l]));
  const labelBox = (r, l) => (r?.items ?? []).find((i) => i.kind === "label" && i.x === l.x && i.y === l.y)?.bbox ?? pointBox(l.x, l.y, 2);
  // A label whose text changed at the same spot reads better as "renamed".
  const posA = new Map([...la.values()].map((l) => [`${l.kind}|${key2(l.x, l.y)}`, l]));
  const posB = new Map([...lb.values()].map((l) => [`${l.kind}|${key2(l.x, l.y)}`, l]));
  for (const [k, l] of la) {
    if (lb.has(k)) continue;
    const moved = posB.get(`${l.kind}|${key2(l.x, l.y)}`);
    if (moved && !la.has(lk(moved))) changes.push({ kind: "modified", type: "label", label: moved.text, detail: `renamed from ${l.text}`, before: labelBox(ra, l), after: labelBox(rb, moved) });
    else changes.push({ kind: "removed", type: "label", label: l.text, detail: l.kind.replace("_", " "), before: labelBox(ra, l) });
  }
  for (const [k, l] of lb) {
    if (la.has(k)) continue;
    const prev = posA.get(`${l.kind}|${key2(l.x, l.y)}`);
    if (prev && !lb.has(lk(prev))) continue; // reported as renamed above
    changes.push({ kind: "added", type: "label", label: l.text, detail: l.kind.replace("_", " "), after: labelBox(rb, l) });
  }

  // ---- junctions / no-connects / text (counts, grouped) ----
  for (const [type, fa, fb, keyFn, boxFn] of [
    ["junction", a?.junctions, b?.junctions, (j) => key2(j.x, j.y), (j) => pointBox(j.x, j.y, 0.8)],
    ["no-connect", a?.noConnects, b?.noConnects, (j) => key2(j.x, j.y), (j) => pointBox(j.x, j.y, 0.8)],
    ["text", a?.texts, b?.texts, (t) => `${t.text}|${key2(t.x, t.y)}`, (t) => pointBox(t.x, t.y, 3)],
  ]) {
    const ma = new Map((fa ?? []).map((x) => [keyFn(x), x]));
    const mb = new Map((fb ?? []).map((x) => [keyFn(x), x]));
    const removed = [...ma].filter(([k]) => !mb.has(k)).map(([, x]) => x);
    const added = [...mb].filter(([k]) => !ma.has(k)).map(([, x]) => x);
    const plural = (n) => `${n} ${type}${n > 1 ? "s" : ""}`;
    if (removed.length) changes.push({ kind: "removed", type, label: type === "text" && removed.length === 1 ? removed[0].text.slice(0, 40) : plural(removed.length), before: union(removed.map(boxFn)), boxes: removed.map(boxFn) });
    if (added.length) changes.push({ kind: "added", type, label: type === "text" && added.length === 1 ? added[0].text.slice(0, 40) : plural(added.length), after: union(added.map(boxFn)), boxes: added.map(boxFn) });
  }

  // Title block changes are worth a line of their own.
  const ta = a?.titleBlock, tb = b?.titleBlock;
  if (ta && tb) {
    const d = [];
    for (const k of ["title", "rev", "date", "company"]) if (ta[k] !== tb[k]) d.push(`${k}: ${ta[k] || "—"} → ${tb[k] || "—"}`);
    if (d.length) changes.push({ kind: "modified", type: "title block", label: "Title block", detail: d.join("; "), fields: d, before: pageCorner(a), after: pageCorner(b) });
  }

  return { changes, summary: summarize(changes), connA, connB };
}

function prop(s, name) {
  return s.properties.find((p) => p.name === name)?.value ?? "";
}

function symbolDiffs(s, t, ia, ib) {
  const d = [];
  if (ia && ib && ia.reference !== ib.reference) d.push(`reference ${ia.reference} → ${ib.reference}`);
  const va = prop(s, "Value"), vb = prop(t, "Value");
  if (va !== vb) d.push(`value ${va} → ${vb}`);
  if (s.libId !== t.libId) d.push(`symbol ${s.libId} → ${t.libId}`);
  const fa = prop(s, "Footprint"), fb = prop(t, "Footprint");
  if (fa !== fb) d.push(`footprint ${fa || "—"} → ${fb || "—"}`);
  if (r3(s.x) !== r3(t.x) || r3(s.y) !== r3(t.y)) d.push("moved");
  if (s.angle !== t.angle || s.mirror !== t.mirror) d.push(`orientation ${s.angle}°${s.mirror ? ` mirror ${s.mirror}` : ""} → ${t.angle}°${t.mirror ? ` mirror ${t.mirror}` : ""}`);
  if (s.unit !== t.unit) d.push(`unit ${s.unit} → ${t.unit}`);
  if (s.dnp !== t.dnp) d.push(t.dnp ? "marked DNP" : "DNP cleared");
  if (s.inBom !== t.inBom) d.push(t.inBom ? "added to BOM" : "excluded from BOM");
  const skip = new Set(["Reference", "Value", "Footprint"]);
  const pa = new Map(s.properties.filter((p) => !skip.has(p.name)).map((p) => [p.name, p.value]));
  const pb = new Map(t.properties.filter((p) => !skip.has(p.name)).map((p) => [p.name, p.value]));
  for (const [k, v] of pb) if (pa.get(k) !== v && !k.startsWith("ki_")) d.push(pa.has(k) ? `${k}: ${pa.get(k) || "—"} → ${v || "—"}` : `${k} added: ${v}`);
  for (const k of pa.keys()) if (!pb.has(k) && !k.startsWith("ki_")) d.push(`${k} removed`);
  return d;
}

// KiCad's names for pin electrical types.
const PIN_TYPE = { power_in: "power input", power_out: "power output", tri_state: "tri-state", open_collector: "open collector", open_emitter: "open emitter", no_connect: "unconnected" };
const pinType = (t) => PIN_TYPE[t] ?? t;

/** What changed in a sheet's copy of a library symbol: pins, units, graphics. */
export function libSymbolDiffs(la, lb) {
  const d = [];
  if (la.power !== lb.power) d.push(lb.power ? "became a power symbol" : "no longer a power symbol");
  if (la.unitCount !== lb.unitCount) d.push(`units ${la.unitCount} → ${lb.unitCount}`);
  if (la.pinNamesHidden !== lb.pinNamesHidden) d.push(lb.pinNamesHidden ? "pin names hidden" : "pin names shown");
  if (la.pinNumbersHidden !== lb.pinNumbersHidden) d.push(lb.pinNumbersHidden ? "pin numbers hidden" : "pin numbers shown");

  const pins = (sym) => byOccurrence(sym.units.flatMap((u) => u.pins.map((p) => ({ ...p, unit: u.unit, bodyStyle: u.bodyStyle }))), (p) => p.number);
  const pa = pins(la), pb = pins(lb);
  const names = (keys) => (keys.length > 6 ? `${keys.length}` : keys.map((k) => k.replace(/#\d+$/, "") || "(unnumbered)").join(", "));
  const added = [...pb.keys()].filter((k) => !pa.has(k)), removed = [...pa.keys()].filter((k) => !pb.has(k));
  if (added.length) d.push(`pin${added.length > 1 ? "s" : ""} added: ${names(added)}`);
  if (removed.length) d.push(`pin${removed.length > 1 ? "s" : ""} removed: ${names(removed)}`);
  const same = new Map(); // change → pin keys, so a change shared by many pins is one line
  const wasAt = new Map([...pa.values()].map((p) => [`${p.unit}.${p.bodyStyle}|${key2(p.x, p.y)}`, p.number]));
  for (const [k, p] of pa) {
    const q = pb.get(k);
    if (!q) continue;
    const c = [];
    if (p.name !== q.name) c.push(`name ${p.name || "—"} → ${q.name || "—"}`);
    if (p.type !== q.type) c.push(`type ${pinType(p.type)} → ${pinType(q.type)}`);
    if (p.shape !== q.shape) c.push(`shape ${p.shape} → ${q.shape}`);
    if (p.unit !== q.unit) c.push(`unit ${p.unit} → ${q.unit}`);
    if (r3(p.x) !== r3(q.x) || r3(p.y) !== r3(q.y)) {
      // Swapped pins (a pinout fix) say where they went.
      const was = wasAt.get(`${q.unit}.${q.bodyStyle}|${key2(q.x, q.y)}`);
      c.push(was !== undefined && was !== q.number ? `moved to pin ${was}'s place` : "moved");
    }
    if (r3(p.angle) !== r3(q.angle)) c.push("orientation");
    if (r3(p.length) !== r3(q.length)) c.push(`length ${r3(p.length)} → ${r3(q.length)} mm`);
    if (p.hide !== q.hide) c.push(q.hide ? "hidden" : "shown");
    if (JSON.stringify(p.alternates) !== JSON.stringify(q.alternates)) c.push("alternate functions");
    if (c.length) same.set(c.join(", "), [...(same.get(c.join(", ")) ?? []), k]);
  }
  const groups = [...same].map(([c, keys]) => `${keys.length > 1 ? "pins" : "pin"} ${names(keys)}: ${c}`);
  d.push(...groups.slice(0, 3));
  if (groups.length > 3) d.push(`${[...same.values()].slice(3).reduce((n, k) => n + k.length, 0)} more pins changed`);

  // Body graphics and text per unit (and De Morgan body style).
  const bodies = (sym) => new Map(sym.units.map((u) => [`${u.unit}.${u.bodyStyle}`, geometry([u.graphics, u.texts])]));
  const ba = bodies(la), bb = bodies(lb);
  const changedUnits = [...new Set([...ba.keys(), ...bb.keys()])].filter((k) => ba.has(k) && bb.has(k) && ba.get(k) !== bb.get(k));
  if (changedUnits.length) {
    const units = [...new Set(changedUnits.map((k) => Number(k.split(".")[0])))].filter((u) => u > 0);
    d.push(`graphics changed${lb.unitCount > 1 && units.length ? ` (unit${units.length > 1 ? "s" : ""} ${units.map(unitLetter).join(", ")})` : ""}`);
  }
  return d;
}

/** Unit 1 → A, 27 → AA, like KiCad's reference suffixes. */
function unitLetter(n) {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Comparable text of parsed geometry (numbers rounded to a micrometre). */
export function geometry(v) {
  return JSON.stringify(v, (k, x) => (typeof x === "number" ? r3(x) : x));
}

function lineKeys(lines) {
  const m = new Map();
  for (const w of lines) {
    const pts = w.pts.map((p) => key2(p.x, p.y));
    const k = pts.join(";") < pts.slice().reverse().join(";") ? pts.join(";") : pts.slice().reverse().join(";");
    m.set(k, w);
  }
  return m;
}

function unionLines(lines) {
  const b = new BBox();
  for (const w of lines) for (const p of w.pts) b.add(p.x, p.y);
  return b.grow(1);
}

function union(boxes) {
  const b = new BBox();
  for (const x of boxes) b.addBox(x);
  return b;
}

function pointBox(x, y, r) {
  return new BBox().add(x - r, y - r).add(x + r, y + r);
}

function sheetBox(s) {
  return new BBox().add(s.x, s.y).add(s.x + s.w, s.y + s.h).grow(1);
}

function pageCorner(sch) {
  const W = sch.paper.width, H = sch.paper.height;
  return new BBox().add(W - 120, H - 45).add(W - 10, H - 10);
}

export function summarize(changes) {
  const s = { added: 0, removed: 0, modified: 0 };
  for (const c of changes) s[c.kind]++;
  return s;
}

/**
 * Items keyed by `key` plus their occurrence ("MP", "MP#2", …), so duplicates
 * (several mounting pads numbered MP, two texts alike on a layer) pair up in
 * file order instead of all meeting the last one.
 */
export function byOccurrence(list, key) {
  const seen = new Map(), out = new Map();
  for (const x of list) {
    const k = key(x);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    out.set(n > 1 ? `${k}#${n}` : k, x);
  }
  return out;
}
