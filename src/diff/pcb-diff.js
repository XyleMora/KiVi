// Semantic diff of two versions of a board.

import { BBox, multiply, rotate, translate, apply } from "../geom.js";
import { arcBounds } from "../pcb/shapes.js";
import { summarize, byOccurrence, geometry } from "./sch-diff.js";

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

  // ---- zones (outline, net, layers, settings; fills are regenerated and too noisy) ----
  const outlineKey = (z) => z.outline.map((o) => o.map((p) => (p.arc ? pk(p.start) : pk(p))).join(";")).join("/");
  const zk = (z) => `${z.net}|${z.layers.join(",")}|${z.keepout}|${outlineKey(z)}`;
  const zoneBox = (z) => {
    const bb = new BBox();
    for (const o of z.outline) for (const p of o) p.arc ? bb.add(p.start.x, p.start.y) : bb.add(p.x, p.y);
    return bb;
  };
  const outline = (z) => z.outline.map((o) => o.map((p) => (p.arc ? p.start : p)));
  const zoneType = (z) => (z.keepout ? "rule area" : "zone");
  const zoneLabel = (z) => (z.keepout ? z.name || "rule area" : z.net || z.name || "zone");
  const zonesA = (a?.zones ?? []).filter((z) => !z.teardrop), zonesB = (b?.zones ?? []).filter((z) => !z.teardrop);
  // Matched by UUID (KiCad 6+ keeps it while a zone is edited), else by net, layers and outline.
  const zoneUuids = new Map(zonesB.filter((z) => z.uuid).map((z) => [z.uuid, z]));
  const zonePairs = [];
  const leftA = [], leftB = new Set(zonesB);
  for (const z of zonesA) {
    const w = z.uuid && zoneUuids.get(z.uuid);
    if (w && leftB.has(w)) {
      zonePairs.push([z, w]);
      leftB.delete(w);
    } else leftA.push(z);
  }
  const byKey = new Map([...leftB].map((z) => [zk(z), z]));
  for (const z of leftA) {
    const w = byKey.get(zk(z));
    if (w && leftB.has(w)) {
      zonePairs.push([z, w]);
      leftB.delete(w);
    } else changes.push({ kind: "removed", type: zoneType(z), label: zoneLabel(z), detail: z.layers.join(", "), before: zoneBox(z), outlinesBefore: outline(z) });
  }
  for (const w of leftB) changes.push({ kind: "added", type: zoneType(w), label: zoneLabel(w), detail: w.layers.join(", "), after: zoneBox(w), outlinesAfter: outline(w) });
  for (const [z, w] of zonePairs) {
    const d = [];
    if (z.net !== w.net) d.push(`net ${z.net || "—"} → ${w.net || "—"}`);
    if (z.layers.join(",") !== w.layers.join(",")) d.push(`layers ${z.layers.join(", ")} → ${w.layers.join(", ")}`);
    if (z.keepout !== w.keepout) d.push(w.keepout ? "became a rule area" : "became a zone");
    if (outlineKey(z) !== outlineKey(w)) d.push("outline changed");
    d.push(...zoneSettingDiffs(z.settings, w.settings));
    if (d.length) changes.push({ kind: "modified", type: zoneType(w), label: zoneLabel(w), detail: d.join("; "), fields: d, before: zoneBox(z), after: zoneBox(w), outlinesBefore: outline(z), outlinesAfter: outline(w) });
  }
  // Teardrops follow the routing; one line says they changed, without listing hundreds of them.
  const tdKey = (z) => `${z.net}|${z.layers.join(",")}|${outlineKey(z)}`;
  const tda = new Map((a?.zones ?? []).filter((z) => z.teardrop).map((z) => [tdKey(z), z]));
  const tdb = new Map((b?.zones ?? []).filter((z) => z.teardrop).map((z) => [tdKey(z), z]));
  const remTd = [...tda].filter(([k]) => !tdb.has(k)).map(([, z]) => z);
  const addTd = [...tdb].filter(([k]) => !tda.has(k)).map(([, z]) => z);
  if (remTd.length || addTd.length) {
    const box = (list) => {
      const bb = new BBox();
      for (const z of list) bb.addBox(zoneBox(z));
      return bb.grow(0.3);
    };
    changes.push({
      kind: addTd.length && remTd.length ? "modified" : addTd.length ? "added" : "removed",
      type: "teardrops",
      label: "Teardrops",
      detail: [addTd.length ? `+${addTd.length}` : "", remTd.length ? `−${remTd.length}` : ""].filter(Boolean).join(" / "),
      before: remTd.length ? box(remTd) : null,
      after: addTd.length ? box(addTd) : null,
      outlinesBefore: remTd.flatMap(outline),
      outlinesAfter: addTd.flatMap(outline),
    });
  }

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
    if ((a.finish ?? null) !== (b.finish ?? null)) d.push(`copper finish ${a.finish || "—"} → ${b.finish || "—"}`);
    d.push(...stackupDiffs(a.stackup, b.stackup));
    for (const [k, label, unit] of SETUP_FIELDS) {
      const x = a.setup?.[k], y = b.setup?.[k];
      if (x !== y && !(typeof x === "number" && typeof y === "number" && r3(x) === r3(y))) d.push(`${label} ${show(x, unit)} → ${show(y, unit)}`);
    }
    if (d.length) changes.push({ kind: "modified", type: "board", label: "Board setup", detail: d.join("; "), fields: d });
  }

  return { changes, summary: summarize(changes) };
}

const SETUP_FIELDS = [
  ["pad_to_mask_clearance", "solder mask expansion", "mm"],
  ["solder_mask_min_width", "solder mask minimum web", "mm"],
  ["pad_to_paste_clearance", "paste clearance", "mm"],
  ["pad_to_paste_clearance_ratio", "paste clearance ratio", ""],
  ["allow_soldermask_bridges_in_footprints", "solder mask bridges in footprints", ""],
];

const ZONE_FIELDS = [
  ["priority", "priority", ""],
  ["pads", "pad connections", ""],
  ["clearance", "clearance", "mm"],
  ["minWidth", "minimum width", "mm"],
  ["fill", "fill", ""],
  ["thermalGap", "thermal relief gap", "mm"],
  ["spokeWidth", "thermal spoke width", "mm"],
  ["islands", "remove islands", ""],
  ["islandArea", "minimum island area", "mm²"],
  ["hatchWidth", "hatch width", "mm"],
  ["hatchGap", "hatch gap", "mm"],
  ["smoothing", "corner smoothing", ""],
  ["radius", "corner radius", "mm"],
  ["keepout", "keep out", ""],
];

/** Changed zone settings, worded like KiCad's zone dialog. */
function zoneSettingDiffs(s, t) {
  const d = [];
  if (!s || !t) return d;
  for (const [k, label, unit] of ZONE_FIELDS) {
    const x = s[k] ?? null, y = t[k] ?? null;
    if (typeof x === "number" && typeof y === "number" ? r3(x) !== r3(y) : x !== y) d.push(`${label} ${show(x, unit)} → ${show(y, unit)}`);
  }
  return d;
}

/** Stackup layers added, removed or with another thickness, material or dielectric constant. */
function stackupDiffs(sa, sb) {
  const d = [];
  if (!sa?.length || !sb?.length) return d; // boards without a stackup section use KiCad's defaults
  const mb = new Map(sb.map((l) => [l.name, l]));
  const ma = new Map(sa.map((l) => [l.name, l]));
  for (const l of sa) {
    const m = mb.get(l.name);
    if (!m) {
      d.push(`stackup: ${l.name} removed`);
      continue;
    }
    const parts = [];
    if (r3(l.thickness) !== r3(m.thickness)) parts.push(`thickness ${show(l.thickness, "mm")} → ${show(m.thickness, "mm")}`);
    if ((l.material ?? null) !== (m.material ?? null)) parts.push(`material ${l.material || "—"} → ${m.material || "—"}`);
    if ((l.epsilon ?? null) !== (m.epsilon ?? null)) parts.push(`εr ${l.epsilon ?? "—"} → ${m.epsilon ?? "—"}`);
    if (parts.length) d.push(`stackup ${l.name}: ${parts.join(", ")}`);
  }
  for (const m of sb) if (!ma.has(m.name)) d.push(`stackup: ${m.name} added`);
  return d;
}

function show(v, unit) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return unit ? `${r3(v)} ${unit}` : String(r3(v));
  return String(v);
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
  const pa = byOccurrence(f.pads, (p) => p.number);
  let netChanges = 0;
  const examples = [];
  for (const [k, p] of byOccurrence(g.pads, (q) => q.number)) {
    const q = pa.get(k);
    if (q && q.net !== p.net) {
      netChanges++;
      if (examples.length < 2) examples.push(`pad ${p.number}: ${q.net || "—"} → ${p.net || "—"}`);
    }
  }
  if (netChanges) d.push(netChanges <= 2 ? examples.join("; ") : `${netChanges} pad nets changed`);
  d.push(...settingDiffs(f.settings, g.settings, "footprint "));
  // Flipping a footprint mirrors everything in it; "moved to bottom" already says so.
  if (f.side === g.side) {
    d.push(...padDiffs(f, g));
    d.push(...graphicDiffs(f, g));
  } else if (f.pads.length !== g.pads.length) d.push(`pads ${f.pads.length} → ${g.pads.length}`);
  d.push(...modelDiffs(f.models, g.models));
  // Footprint text (e.g. reference resized for readability): pair by layer + content.
  d.push(...textDiffs(f, g));
  return d;
}

const PAD_SETTINGS = [
  ["maskMargin", "solder mask margin", "mm"],
  ["pasteMargin", "paste margin", "mm"],
  ["pasteRatio", "paste ratio", ""],
  ["clearance", "clearance", "mm"],
  ["zoneConnect", "zone connection", ""],
  ["thermalWidth", "thermal spoke width", "mm"],
  ["thermalGap", "thermal relief gap", "mm"],
];

/** Changed local overrides of a pad or footprint ("—" = inherited from the footprint or board). */
function settingDiffs(s, t, prefix = "") {
  const d = [];
  for (const [k, label, unit] of PAD_SETTINGS) {
    const x = s?.[k] ?? null, y = t?.[k] ?? null;
    if (typeof x === "number" && typeof y === "number" ? r3(x) !== r3(y) : x !== y) d.push(`${prefix}${label} ${show(x, unit)} → ${show(y, unit)}`);
  }
  return d;
}

const PAD_TYPE = { smd: "SMD", thru_hole: "through-hole", np_thru_hole: "NPTH", connect: "connector" };
const norm = (a) => r3((((a ?? 0) % 360) + 360) % 360);
const size = (w, h) => (r3(w) === r3(h) ? `${r3(w)}` : `${r3(w)} × ${r3(h)}`);
const drillText = (dr) => (dr ? `${size(dr.w, dr.h)} mm${dr.oval ? " oval" : ""}` : "none");

/** What changed on one pad, in its footprint's frame (so moving the part changes nothing here). */
function padChanges(p, q, f, g) {
  const c = [];
  if (p.type !== q.type) c.push(`type ${PAD_TYPE[p.type] ?? p.type} → ${PAD_TYPE[q.type] ?? q.type}`);
  if (p.shape !== q.shape) c.push(`shape ${p.shape} → ${q.shape}`);
  if (r3(p.w) !== r3(q.w) || r3(p.h) !== r3(q.h)) c.push(`size ${size(p.w, p.h)} → ${size(q.w, q.h)} mm`);
  if (r3(p.localX) !== r3(q.localX) || r3(p.localY) !== r3(q.localY)) c.push("moved");
  const ra = norm(p.angle - f.angle), rb = norm(q.angle - g.angle);
  if (ra !== rb) c.push(`rotated ${ra}° → ${rb}°`);
  const da = p.drill, db = q.drill;
  if (!!da !== !!db || (da && (r3(da.w) !== r3(db.w) || r3(da.h) !== r3(db.h) || da.oval !== db.oval))) c.push(`drill ${drillText(da)} → ${drillText(db)}`);
  else if (da && (r3(da.offset.x) !== r3(db.offset.x) || r3(da.offset.y) !== r3(db.offset.y))) c.push("drill offset");
  const la = [...p.layers].sort().join(", "), lb = [...q.layers].sort().join(", ");
  if (la !== lb) c.push(`layers ${la || "—"} → ${lb || "—"}`);
  if ((p.shape === "roundrect" || q.shape === "roundrect") && r3(p.roundrectRatio) !== r3(q.roundrectRatio)) c.push(`corner ratio ${r3(p.roundrectRatio)} → ${r3(q.roundrectRatio)}`);
  if (r3(p.chamferRatio) !== r3(q.chamferRatio) || p.chamfer.join() !== q.chamfer.join()) c.push("chamfer");
  if (r3(p.delta.x) !== r3(q.delta.x) || r3(p.delta.y) !== r3(q.delta.y)) c.push("trapezoid");
  if (geometry(p.primitives) !== geometry(q.primitives) || p.anchor !== q.anchor) c.push("custom shape");
  c.push(...settingDiffs(p.settings, q.settings));
  return c.join(", ");
}

/**
 * Pads added, removed or changed. Pads with the same change are listed
 * together ("pads 1, 2: size 1 × 0.6 → 1.2 × 0.8 mm"), as updating a
 * footprint from its library often changes every pad the same way.
 */
function padDiffs(f, g) {
  const d = [];
  const pa = byOccurrence(f.pads, (p) => p.number), pb = byOccurrence(g.pads, (p) => p.number);
  const added = [...pb.keys()].filter((k) => !pa.has(k)), removed = [...pa.keys()].filter((k) => !pb.has(k));
  const names = (keys) => (keys.length > 6 ? `${keys.length}` : keys.map((k) => k.replace(/#\d+$/, "") || "(unnumbered)").join(", "));
  if (added.length) d.push(`pad${added.length > 1 ? "s" : ""} added: ${names(added)}`);
  if (removed.length) d.push(`pad${removed.length > 1 ? "s" : ""} removed: ${names(removed)}`);
  const same = new Map(); // change → pad keys
  for (const [k, p] of pa) {
    const q = pb.get(k);
    const c = q && padChanges(p, q, f, g);
    if (c) same.set(c, [...(same.get(c) ?? []), k]);
  }
  const groups = [...same].map(([c, keys]) => `${keys.length > 1 ? "pads" : "pad"} ${names(keys)}: ${c}`);
  d.push(...groups.slice(0, 3));
  if (groups.length > 3) d.push(`${[...same.values()].slice(3).reduce((n, k) => n + k.length, 0)} more pads changed`);
  return d;
}

/** Board → footprint frame (the inverse of the transform parsePcb applied). */
function localFrame(fp) {
  const m = multiply(rotate(-fp.angle), translate(-fp.x, -fp.y));
  return (p) => apply(m, p.x, p.y);
}

/** Footprint graphics added or removed per layer, compared in the footprint's frame. */
function graphicDiffs(f, g) {
  const keys = (fp) => {
    const L = localFrame(fp);
    const k = (p) => pk(L(p));
    return byOccurrence(fp.graphics, (s) => {
      switch (s.kind) {
        case "line":
          return `${s.layer}|l|${[k(s.start), k(s.end)].sort().join(";")}|${r3(s.width)}`;
        case "arc":
          return `${s.layer}|a|${k(s.start)}|${k(s.mid)}|${k(s.end)}|${r3(s.width)}`;
        case "circle":
          return `${s.layer}|c|${k(s.center)}|${r3(s.r)}|${r3(s.width)}|${s.fill}`;
        default:
          return `${s.layer}|${s.kind}|${s.pts.map((p) => (p.arc ? `${k(p.start)}~${k(p.mid)}~${k(p.end)}` : k(p))).join(";")}|${r3(s.width)}|${s.fill}`;
      }
    });
  };
  const ka = keys(f), kb = keys(g);
  const count = new Map(); // layer → [added, removed]
  const tally = (map, other, i) => {
    for (const [k, s] of map) {
      if (other.has(k)) continue;
      const n = count.get(s.layer) ?? [0, 0];
      n[i]++;
      count.set(s.layer, n);
    }
  };
  tally(kb, ka, 0);
  tally(ka, kb, 1);
  return [...count].map(([layer, [add, rem]]) => `${layer} graphics ${[add ? `+${add}` : "", rem ? `−${rem}` : ""].filter(Boolean).join(" / ")}`);
}

const fileName = (p) => p.split(/[\\/]/).pop();

/**
 * A model path change, short: the file names when they differ, else only the
 * folders that do ("…/Old.3dshapes/… → …/New.3dshapes/…"). Full paths with
 * `${KICADn_3DMODEL_DIR}` prefixes made the detail line unreadable.
 */
function pathChange(a, b) {
  if (fileName(a) !== fileName(b)) return `${fileName(a)} → ${fileName(b)}`;
  const sa = a.split(/[\\/]/), sb = b.split(/[\\/]/);
  let head = 0, tail = 0;
  while (head < Math.min(sa.length, sb.length) - 1 && sa[head] === sb[head]) head++;
  while (tail < Math.min(sa.length, sb.length) - head && sa[sa.length - 1 - tail] === sb[sb.length - 1 - tail]) tail++;
  const part = (s) => `${head ? "…/" : ""}${s.slice(head, s.length - tail).join("/") || "."}${tail ? "/…" : ""}`;
  return `${part(sa)} → ${part(sb)} (${fileName(b)})`;
}

/** 3D models changed, added or removed (paired in file order). */
function modelDiffs(ma, mb) {
  const d = [];
  const xyz = (v) => `${r3(v.x)}, ${r3(v.y)}, ${r3(v.z)}`;
  for (let i = 0; i < Math.max(ma.length, mb.length); i++) {
    const a = ma[i], b = mb[i];
    if (!a) d.push(`3D model added: ${fileName(b.path)}`);
    else if (!b) d.push(`3D model removed: ${fileName(a.path)}`);
    else {
      const c = [];
      if (a.path !== b.path) c.push(pathChange(a.path, b.path));
      if (xyz(a.offset) !== xyz(b.offset)) c.push(`offset ${xyz(a.offset)} → ${xyz(b.offset)} mm`);
      if (xyz(a.rotate) !== xyz(b.rotate)) c.push(`rotation ${xyz(a.rotate)} → ${xyz(b.rotate)}°`);
      if (xyz(a.scale) !== xyz(b.scale)) c.push(`scale ${xyz(a.scale)} → ${xyz(b.scale)}`);
      if (a.hide !== b.hide) c.push(b.hide ? "hidden" : "shown");
      if (r3(a.opacity) !== r3(b.opacity)) c.push(`opacity ${r3(a.opacity)} → ${r3(b.opacity)}`);
      if (c.length) d.push(`3D model ${c.join(", ")}`);
    }
  }
  return d;
}

function textDiffs(f, g) {
  const out = [];
  const visible = (fp) => fp.texts.filter((t) => !t.hide && t.text);
  const name = (t) => `${t.field ?? `"${t.text}"`} on ${t.layer}`;
  const ka = (t) => `${t.layer}|${t.field ?? t.text}`;
  const tb = byOccurrence(visible(g), ka);
  const La = localFrame(f), Lb = localFrame(g);
  const seen = new Set();
  for (const [k, t] of byOccurrence(visible(f), ka)) {
    const u = tb.get(k);
    if (!u) {
      out.push(`${name(t)} removed`);
      continue;
    }
    seen.add(k);
    const parts = [];
    if (r3(t.effects.size) !== r3(u.effects.size) || r3(t.effects.width) !== r3(u.effects.width)) parts.push(`size ${r3(t.effects.size)} → ${r3(u.effects.size)} mm`);
    if (r3(t.effects.thickness) !== r3(u.effects.thickness)) parts.push(`thickness ${r3(t.effects.thickness)} → ${r3(u.effects.thickness)} mm`);
    // In the footprint's frame, so moving or rotating the part is not reported twice.
    if (pk(La(t)) !== pk(Lb(u))) parts.push("moved");
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
