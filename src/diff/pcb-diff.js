// Semantic diff of two versions of a board.

import { BBox } from "../geom.js";
import { arcBounds } from "../pcb/shapes.js";
import { summarize } from "./sch-diff.js";

const r3 = (v) => Math.round(v * 1000) / 1000;
const pk = (p) => `${r3(p.x)},${r3(p.y)}`;

/**
 * @param {object|null} a  parsed board before (null if added)
 * @param {object|null} b  parsed board after (null if removed)
 * @param {object} [ra]    renderPcb() result for `a` (footprint bboxes)
 * @param {object} [rb]    renderPcb() result for `b`
 */
export function diffPcb(a, b, ra, rb) {
  const changes = [];
  const boxOf = (r, fp) => r?.items.find((i) => i.fp === fp)?.bbox ?? new BBox().add(fp.x - 1, fp.y - 1).add(fp.x + 1, fp.y + 1);

  // ---- footprints ----
  const key = (fp) => fp.uuid || `ref:${fp.reference}`;
  const fa = new Map((a?.footprints ?? []).map((f) => [key(f), f]));
  const fb = new Map((b?.footprints ?? []).map((f) => [key(f), f]));
  // Older boards regenerate UUIDs; fall back to references when nothing matches.
  const byRef = (map) => new Map([...map.values()].map((f) => [f.reference, f]));
  const matchByRef = a && b && [...fa.keys()].filter((k) => fb.has(k)).length < Math.min(fa.size, fb.size) / 2;
  const A = matchByRef ? byRef(fa) : fa, B = matchByRef ? byRef(fb) : fb;
  for (const [k, f] of A) {
    if (!B.has(k)) {
      changes.push({ kind: "removed", type: "footprint", label: f.reference, detail: f.value, before: boxOf(ra, f), side: f.side });
      continue;
    }
    const g = B.get(k);
    const d = footprintDiffs(f, g);
    if (d.length) changes.push({ kind: "modified", type: "footprint", label: g.reference, detail: d.join("; "), fields: d, before: boxOf(ra, f), after: boxOf(rb, g), side: g.side });
  }
  for (const [k, g] of B) if (!A.has(k)) changes.push({ kind: "added", type: "footprint", label: g.reference, detail: g.value, after: boxOf(rb, g), side: g.side });

  // ---- tracks, grouped by net ----
  const tk = (t) => {
    const ends = [pk(t.start), pk(t.end)].sort().join(";");
    return `${t.layer}|${r3(t.width)}|${t.type === "arc" ? pk(t.mid) + "|" : ""}${ends}`;
  };
  const ta = new Map((a?.tracks ?? []).map((t) => [tk(t), t]));
  const tb = new Map((b?.tracks ?? []).map((t) => [tk(t), t]));
  const groupByNet = (list) => {
    const m = new Map();
    for (const t of list) {
      if (!m.has(t.net)) m.set(t.net, []);
      m.get(t.net).push(t);
    }
    return m;
  };
  const removedT = groupByNet([...ta].filter(([k]) => !tb.has(k)).map(([, t]) => t));
  const addedT = groupByNet([...tb].filter(([k]) => !ta.has(k)).map(([, t]) => t));
  for (const net of new Set([...removedT.keys(), ...addedT.keys()])) {
    const rem = removedT.get(net) ?? [], add = addedT.get(net) ?? [];
    const parts = [];
    if (add.length) parts.push(`+${add.length}`);
    if (rem.length) parts.push(`−${rem.length}`);
    const layers = [...new Set([...rem, ...add].map((t) => t.layer))].join(", ");
    const kind = add.length && rem.length ? "modified" : add.length ? "added" : "removed";
    changes.push({
      kind,
      type: "routing",
      label: net || "(no net)",
      detail: `${parts.join(" / ")} segment${add.length + rem.length > 1 ? "s" : ""} on ${layers}`,
      before: rem.length ? trackBox(rem) : null,
      after: add.length ? trackBox(add) : null,
      tracksBefore: rem,
      tracksAfter: add,
    });
  }

  // ---- vias ----
  const vk = (v) => `${pk(v)}|${r3(v.size)}|${r3(v.drill)}|${v.layers.join(",")}`;
  const va = new Map((a?.vias ?? []).map((v) => [vk(v), v]));
  const vb = new Map((b?.vias ?? []).map((v) => [vk(v), v]));
  const remV = [...va].filter(([k]) => !vb.has(k)).map(([, v]) => v);
  const addV = [...vb].filter(([k]) => !va.has(k)).map(([, v]) => v);
  const viaBox = (list) => {
    const bb = new BBox();
    for (const v of list) bb.add(v.x - v.size, v.y - v.size).add(v.x + v.size, v.y + v.size);
    return bb;
  };
  if (remV.length) changes.push({ kind: "removed", type: "vias", label: `${remV.length} via${remV.length > 1 ? "s" : ""}`, before: viaBox(remV), viasBefore: remV });
  if (addV.length) changes.push({ kind: "added", type: "vias", label: `${addV.length} via${addV.length > 1 ? "s" : ""}`, after: viaBox(addV), viasAfter: addV });

  // ---- zones (outline / net / layers; fills are regenerated and too noisy) ----
  const zk = (z) => `${z.net}|${z.layers.join(",")}|${z.keepout}|${z.outline.map((o) => o.map((p) => (p.arc ? pk(p.start) : pk(p))).join(";")).join("/")}`;
  const za = new Map((a?.zones ?? []).map((z) => [zk(z), z]));
  const zb = new Map((b?.zones ?? []).map((z) => [zk(z), z]));
  const zoneBox = (z) => {
    const bb = new BBox();
    for (const o of z.outline) for (const p of o) p.arc ? bb.add(p.start.x, p.start.y) : bb.add(p.x, p.y);
    return bb;
  };
  const outline = (z) => z.outline.map((o) => o.map((p) => (p.arc ? p.start : p)));
  for (const [k, z] of za) if (!zb.has(k)) changes.push({ kind: "removed", type: z.keepout ? "rule area" : "zone", label: z.net || z.name || "zone", detail: z.layers.join(", "), before: zoneBox(z), outlinesBefore: outline(z) });
  for (const [k, z] of zb) if (!za.has(k)) changes.push({ kind: "added", type: z.keepout ? "rule area" : "zone", label: z.net || z.name || "zone", detail: z.layers.join(", "), after: zoneBox(z), outlinesAfter: outline(z) });

  // ---- board graphics (outline, silkscreen, documentation), grouped per layer ----
  const gk = (g) => {
    switch (g.kind) {
      case "line":
        return `${g.layer}|l|${[pk(g.start), pk(g.end)].sort().join(";")}|${r3(g.width)}`;
      case "arc":
        return `${g.layer}|a|${pk(g.start)}|${pk(g.mid)}|${pk(g.end)}`;
      case "circle":
        return `${g.layer}|c|${pk(g.center)}|${r3(g.r)}`;
      case "poly":
      case "curve":
        return `${g.layer}|p|${g.pts.map((p) => (p.arc ? pk(p.start) : pk(p))).join(";")}`;
      case "text":
        return `${g.layer}|t|${g.text}|${pk(g)}|${g.angle}`;
      default:
        return `${g.layer}|${g.kind}|${JSON.stringify(g.pts ?? "")}`;
    }
  };
  const ga = new Map((a?.drawings ?? []).map((g) => [gk(g), g]));
  const gb = new Map((b?.drawings ?? []).map((g) => [gk(g), g]));
  const byLayer = (list) => {
    const m = new Map();
    for (const g of list) {
      if (!m.has(g.layer)) m.set(g.layer, []);
      m.get(g.layer).push(g);
    }
    return m;
  };
  const remG = byLayer([...ga].filter(([k]) => !gb.has(k)).map(([, g]) => g));
  const addG = byLayer([...gb].filter(([k]) => !ga.has(k)).map(([, g]) => g));
  for (const layer of new Set([...remG.keys(), ...addG.keys()])) {
    const rem = remG.get(layer) ?? [], add = addG.get(layer) ?? [];
    const kind = add.length && rem.length ? "modified" : add.length ? "added" : "removed";
    const label = layer === "Edge.Cuts" ? "Board outline" : layer;
    const texts = [...rem, ...add].filter((g) => g.kind === "text").map((g) => g.text);
    changes.push({
      kind,
      type: layer === "Edge.Cuts" ? "outline" : "graphics",
      label,
      detail: `${add.length ? `+${add.length}` : ""}${add.length && rem.length ? " / " : ""}${rem.length ? `−${rem.length}` : ""} item${add.length + rem.length > 1 ? "s" : ""}${texts.length ? ` (${texts.slice(0, 3).join(", ")}${texts.length > 3 ? "…" : ""})` : ""}`,
      before: rem.length ? shapesBox(rem) : null,
      after: add.length ? shapesBox(add) : null,
    });
  }

  // Board-level properties.
  if (a && b) {
    const d = [];
    if (a.thickness !== b.thickness) d.push(`thickness ${a.thickness} → ${b.thickness} mm`);
    const cuA = a.layers.filter((l) => l.name.endsWith(".Cu")).length, cuB = b.layers.filter((l) => l.name.endsWith(".Cu")).length;
    if (cuA !== cuB) d.push(`copper layers ${cuA} → ${cuB}`);
    if (d.length) changes.push({ kind: "modified", type: "board", label: "Board setup", detail: d.join("; "), fields: d });
  }

  return { changes, summary: summarize(changes) };
}

function footprintDiffs(f, g) {
  const d = [];
  if (f.reference !== g.reference) d.push(`reference ${f.reference} → ${g.reference}`);
  if (f.value !== g.value) d.push(`value ${f.value} → ${g.value}`);
  if (f.libId !== g.libId) d.push(`footprint ${f.libId} → ${g.libId}`);
  if (f.side !== g.side) d.push(`moved to ${g.side === "back" ? "bottom" : "top"}`);
  const dx = g.x - f.x, dy = g.y - f.y;
  if (Math.abs(dx) > 1e-3 || Math.abs(dy) > 1e-3) d.push(`moved ${Math.hypot(dx, dy).toFixed(2)} mm`);
  if (r3(f.angle) !== r3(g.angle)) d.push(`rotated ${f.angle}° → ${g.angle}°`);
  if (f.dnp !== g.dnp) d.push(g.dnp ? "marked DNP" : "DNP cleared");
  const attrsA = f.attrs.filter((x) => x !== "dnp").join(","), attrsB = g.attrs.filter((x) => x !== "dnp").join(",");
  if (attrsA !== attrsB) d.push(`attributes ${attrsA || "—"} → ${attrsB || "—"}`);
  // Pad net changes (re-wiring in the schematic shows up here).
  const pa = new Map(f.pads.map((p) => [p.number, p.net]));
  let netChanges = 0;
  const examples = [];
  for (const p of g.pads) {
    if (pa.has(p.number) && pa.get(p.number) !== p.net) {
      netChanges++;
      if (examples.length < 2) examples.push(`pad ${p.number}: ${pa.get(p.number) || "—"} → ${p.net || "—"}`);
    }
  }
  if (netChanges) d.push(netChanges <= 2 ? examples.join("; ") : `${netChanges} pad nets changed`);
  if (f.pads.length !== g.pads.length) d.push(`pads ${f.pads.length} → ${g.pads.length}`);
  // Footprint text (e.g. reference resized for readability): pair by layer + content.
  d.push(...textDiffs(f, g));
  const gsig = (fp) => fp.graphics.length + ":" + fp.graphics.filter((x) => x.layer.endsWith("SilkS")).length;
  if (gsig(f) !== gsig(g)) d.push("graphics changed");
  return d;
}

function textDiffs(f, g) {
  const out = [];
  const visible = (fp) => fp.texts.filter((t) => !t.hide && t.text);
  const name = (t) => `${t.field ?? `"${t.text}"`} on ${t.layer}`;
  const ka = (t) => `${t.layer}|${t.field ?? t.text}`;
  const tb = new Map(visible(g).map((t) => [ka(t), t]));
  const seen = new Set();
  for (const t of visible(f)) {
    const u = tb.get(ka(t));
    if (!u) {
      out.push(`${name(t)} removed`);
      continue;
    }
    seen.add(ka(t));
    const parts = [];
    if (r3(t.effects.size) !== r3(u.effects.size) || r3(t.effects.width) !== r3(u.effects.width)) parts.push(`size ${r3(t.effects.size)} → ${r3(u.effects.size)} mm`);
    if (r3(t.effects.thickness) !== r3(u.effects.thickness)) parts.push(`thickness ${r3(t.effects.thickness)} → ${r3(u.effects.thickness)} mm`);
    // Position relative to the footprint, so moving the part is not reported twice.
    if (r3(t.x - f.x) !== r3(u.x - g.x) || r3(t.y - f.y) !== r3(u.y - g.y)) parts.push("moved");
    if (r3(t.angle - f.angle) !== r3(u.angle - g.angle)) parts.push("rotated");
    if (t.effects.h !== u.effects.h || t.effects.v !== u.effects.v) parts.push("justification");
    if (parts.length) out.push(`${name(u)}: ${parts.join(", ")}`);
  }
  for (const [k, u] of tb) if (!seen.has(k)) out.push(`${name(u)} added`);
  return out.length > 3 ? [...out.slice(0, 3), `${out.length - 3} more text changes`] : out;
}

function trackBox(list) {
  const b = new BBox();
  for (const t of list) {
    if (t.type === "arc") arcBounds(t.start, t.mid, t.end, b);
    else b.add(t.start.x, t.start.y).add(t.end.x, t.end.y);
  }
  return b.grow(0.5);
}

function shapesBox(list) {
  const b = new BBox();
  for (const g of list) {
    if (g.kind === "line") b.add(g.start.x, g.start.y).add(g.end.x, g.end.y);
    else if (g.kind === "arc") arcBounds(g.start, g.mid, g.end, b);
    else if (g.kind === "circle") b.add(g.center.x - g.r, g.center.y - g.r).add(g.center.x + g.r, g.center.y + g.r);
    else if (g.kind === "text") b.add(g.x - 2, g.y - 1).add(g.x + 2, g.y + 1);
    else if (g.pts) for (const p of g.pts) p.arc ? b.add(p.start.x, p.start.y) : b.add(p.x, p.y);
  }
  return b.grow(0.5);
}
