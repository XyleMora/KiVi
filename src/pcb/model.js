// Board (.kicad_pcb) model.
//
// Footprint children (pads, graphics, texts) are transformed to board
// coordinates while parsing, so renderers never deal with footprint frames.
// Units are millimetres, Y down, angles counter-clockwise on screen.

import { parse, child, children, value, flag, at, xy, num } from "../sexpr.js";
import { multiply, rotate, translate, apply, arcMidFromCenter } from "../geom.js";
import { parsePaper, parseTitleBlock } from "../sch/model.js";

export function parsePcb(src, filename = "") {
  const root = typeof src === "string" ? parse(src) : src;
  if (root[0] !== "kicad_pcb") throw new Error(`${filename || "file"} is not a KiCad board (found "${root[0]}")`);

  const pcb = {
    filename,
    version: value(root, "version", 1, 0),
    generatorVersion: value(root, "generator_version", 1, ""),
    thickness: value(child(root, "general"), "thickness", 1, 1.6),
    paper: parsePaper(child(root, "paper")),
    titleBlock: parseTitleBlock(child(root, "title_block")),
    layers: [],
    stackup: [],
    finish: null,
    nets: new Map(), // code → name (legacy numbered nets)
    netNames: new Set(),
    footprints: [],
    drawings: [],
    tracks: [],
    vias: [],
    zones: [],
    setup: {},
  };

  // Layer table entries are lists headed by the layer ordinal: (0 "F.Cu" signal)
  const layers = child(root, "layers");
  for (let i = 1; layers && i < layers.length; i++) {
    const l = layers[i];
    if (Array.isArray(l)) pcb.layers.push({ ordinal: num(l[0]), name: String(l[1]), type: String(l[2] ?? ""), userName: l[3] ? String(l[3]) : null });
  }

  const setup = child(root, "setup");
  // Board-wide mask and paste rules (the rest of the design rules live in the .kicad_pro).
  for (const k of ["pad_to_mask_clearance", "solder_mask_min_width", "pad_to_paste_clearance", "pad_to_paste_clearance_ratio", "allow_soldermask_bridges_in_footprints"]) {
    const v = value(setup, k, 1, undefined);
    if (v !== undefined) pcb.setup[k] = v;
  }
  const stackup = child(setup, "stackup");
  if (stackup) {
    for (const l of children(stackup, "layer")) {
      pcb.stackup.push({
        name: String(l[1]),
        type: String(value(l, "type", 1, "")),
        thickness: value(l, "thickness", 1, 0),
        material: value(l, "material", 1, null),
        color: value(l, "color", 1, null),
        epsilon: value(l, "epsilon_r", 1, null),
      });
    }
    pcb.finish = value(stackup, "copper_finish", 1, null);
  }

  for (let i = 1; i < root.length; i++) {
    const n = root[i];
    if (!Array.isArray(n)) continue;
    switch (n[0]) {
      case "net":
        if (typeof n[1] === "number") {
          pcb.nets.set(n[1], String(n[2] ?? ""));
          if (n[2]) pcb.netNames.add(String(n[2]));
        } else if (n[1] !== undefined) pcb.netNames.add(String(n[1]));
        break;
      case "footprint":
      case "module":
        pcb.footprints.push(parseFootprint(n, pcb));
        break;
      case "segment":
        pcb.tracks.push({ type: "segment", start: xy(n, "start"), end: xy(n, "end"), width: value(n, "width", 1, 0.25), layer: String(value(n, "layer", 1, "F.Cu")), net: netOf(n, pcb), uuid: value(n, "uuid", 1) });
        break;
      case "arc":
        pcb.tracks.push({ type: "arc", start: xy(n, "start"), mid: xy(n, "mid"), end: xy(n, "end"), width: value(n, "width", 1, 0.25), layer: String(value(n, "layer", 1, "F.Cu")), net: netOf(n, pcb), uuid: value(n, "uuid", 1) });
        break;
      case "via": {
        const p = at(n);
        const ls = child(n, "layers");
        pcb.vias.push({
          x: p.x,
          y: p.y,
          size: value(n, "size", 1, 0.8),
          drill: value(n, "drill", 1, 0.4),
          layers: ls ? ls.slice(1).map(String) : ["F.Cu", "B.Cu"],
          kind: n.includes("micro") ? "micro" : n.includes("blind") ? "blind" : "through",
          net: netOf(n, pcb),
          uuid: value(n, "uuid", 1),
        });
        break;
      }
      case "zone":
        pcb.zones.push(parseZone(n, pcb));
        break;
      case "gr_line":
      case "gr_arc":
      case "gr_circle":
      case "gr_rect":
      case "gr_poly":
      case "gr_curve":
      case "gr_bbox": {
        const g = parseShape(n, null);
        if (g) pcb.drawings.push(g);
        break;
      }
      case "gr_text":
        pcb.drawings.push(parseText(n, null));
        break;
      case "gr_text_box":
        pcb.drawings.push(parseTextBox(n, null));
        break;
      case "dimension":
        pcb.drawings.push(...parseDimension(n));
        break;
      case "group":
      case "generated":
        // Groups only bundle existing items.
        break;
    }
  }
  return pcb;
}

/** Net reference in any of KiCad's forms: (net 5) (net 5 "GND") (net "GND"). */
function netOf(n, pcb) {
  const c = child(n, "net");
  if (!c) return "";
  if (typeof c[1] === "number") return c[2] !== undefined ? String(c[2]) : pcb.nets.get(c[1]) ?? "";
  return String(c[1] ?? "");
}

// ---- footprints -----------------------------------------------------------

function parseFootprint(n, pcb) {
  const p = at(n);
  const m = multiply(translate(p.x, p.y), rotate(p.angle));
  const layer = String(value(n, "layer", 1, "F.Cu"));
  const fp = {
    libId: String(n[1] ?? ""),
    layer,
    side: layer.startsWith("B.") ? "back" : "front",
    x: p.x,
    y: p.y,
    angle: p.angle,
    uuid: value(n, "uuid", 1, value(n, "tstamp", 1, "")),
    path: value(n, "path", 1, ""),
    sheetName: value(n, "sheetname", 1, ""),
    description: value(n, "descr", 1, ""),
    attrs: (child(n, "attr") ?? []).slice(1).map(String),
    reference: "",
    value: "",
    properties: {},
    texts: [],
    graphics: [],
    pads: [],
    models: [],
    dnp: false,
    settings: padSettings(n),
  };
  fp.dnp = fp.attrs.includes("dnp");

  for (let i = 1; i < n.length; i++) {
    const c = n[i];
    if (!Array.isArray(c)) continue;
    switch (c[0]) {
      case "property": {
        const name = String(c[1]), val = String(c[2] ?? "");
        fp.properties[name] = val;
        if (name === "Reference") fp.reference = val;
        if (name === "Value") fp.value = val;
        // v8+: Reference/Value are properties with a position and layer.
        if (child(c, "at") && child(c, "layer")) {
          const t = parseText(c, m, val);
          t.field = name;
          t.parentAngle = p.angle;
          fp.texts.push(t);
        }
        break;
      }
      case "fp_text": {
        const t = parseText(c, m, String(c[2] ?? ""));
        const kind = String(c[1]);
        if (kind === "reference") {
          fp.reference = t.text;
          t.field = "Reference";
        } else if (kind === "value") {
          fp.value = t.text;
          t.field = "Value";
        }
        t.parentAngle = p.angle;
        fp.texts.push(t);
        break;
      }
      case "fp_text_box":
        fp.texts.push(parseTextBox(c, m));
        break;
      case "fp_line":
      case "fp_arc":
      case "fp_circle":
      case "fp_rect":
      case "fp_poly":
      case "fp_curve": {
        const g = parseShape(c, m);
        if (g) fp.graphics.push(g);
        break;
      }
      case "pad":
        fp.pads.push(parsePad(c, m, p.angle, pcb, fp));
        break;
      case "model": {
        const off = child(child(c, "offset") ?? child(c, "at"), "xyz");
        const sc = child(child(c, "scale"), "xyz");
        const rot = child(child(c, "rotate"), "xyz");
        fp.models.push({
          path: String(c[1] ?? ""),
          hide: flag(c, "hide") || flag(c, "hidden") || c.includes("hide"),
          opacity: value(c, "opacity", 1, 1),
          offset: off ? { x: num(off[1]), y: num(off[2]), z: num(off[3]) } : { x: 0, y: 0, z: 0 },
          scale: sc ? { x: num(sc[1], 1), y: num(sc[2], 1), z: num(sc[3], 1) } : { x: 1, y: 1, z: 1 },
          rotate: rot ? { x: num(rot[1]), y: num(rot[2]), z: num(rot[3]) } : { x: 0, y: 0, z: 0 },
        });
        break;
      }
    }
  }
  // Older boards keep reference/value text with ${REFERENCE} variables.
  for (const t of fp.texts) {
    if (t.text.includes("${REFERENCE}")) t.text = t.text.replace(/\$\{REFERENCE\}/g, fp.reference);
    if (t.text.includes("${VALUE}")) t.text = t.text.replace(/\$\{VALUE\}/g, fp.value);
  }
  return fp;
}

function parsePad(n, m, fpAngle, pcb, fp) {
  const p = at(n);
  const pos = apply(m, p.x, p.y);
  const size = child(n, "size");
  const drillNode = child(n, "drill");
  let drill = null;
  if (drillNode) {
    const oval = drillNode.includes("oval");
    const nums = drillNode.slice(1).filter((v) => typeof v === "number");
    const off = child(drillNode, "offset");
    drill = { oval, w: nums[0] ?? 0, h: oval ? nums[1] ?? nums[0] ?? 0 : nums[0] ?? 0, offset: off ? { x: num(off[1]), y: num(off[2]) } : { x: 0, y: 0 } };
    if (!drill.w) drill = null;
  }
  const delta = child(n, "rect_delta");
  const chamfer = child(n, "chamfer");
  const opts = child(n, "options");
  const prims = child(n, "primitives");
  const pad = {
    number: String(n[1] ?? ""),
    type: String(n[2] ?? "smd"),
    shape: String(n[3] ?? "rect"),
    x: pos.x,
    y: pos.y,
    // Pad angle in the file already includes the footprint rotation.
    angle: p.angle,
    localX: p.x,
    localY: p.y,
    w: num(size?.[1]),
    h: num(size?.[2]),
    drill,
    layers: (child(n, "layers") ?? []).slice(1).map(String),
    roundrectRatio: value(n, "roundrect_rratio", 1, 0.25),
    chamferRatio: value(n, "chamfer_ratio", 1, 0),
    chamfer: chamfer ? chamfer.slice(1).map(String) : [],
    delta: delta ? { x: num(delta[1]), y: num(delta[2]) } : { x: 0, y: 0 },
    net: netOf(n, pcb),
    pinFunction: value(n, "pinfunction", 1, ""),
    pinType: value(n, "pintype", 1, ""),
    anchor: opts ? String(value(opts, "anchor", 1, "rect")) : "rect",
    primitives: [],
    removeUnusedLayers: flag(n, "remove_unused_layers"),
    // Local overrides of the footprint's and board's mask, paste and clearance rules.
    settings: padSettings(n),
    footprint: fp,
  };
  if (prims) {
    // Primitives live in the pad's own frame (pad rotation applies).
    for (const c of prims.slice(1)) {
      if (!Array.isArray(c)) continue;
      const g = parseShape(c, null);
      if (g) pad.primitives.push(g);
    }
  }
  return pad;
}

const ZONE_CONNECT = { 0: "none", 1: "thermal reliefs", 2: "solid", 3: "thermal reliefs for PTH only" };

/** Mask, paste, clearance and zone connection overrides of a pad or footprint (null = inherited). */
function padSettings(n) {
  const zc = value(n, "zone_connect", 1, null);
  return {
    maskMargin: value(n, "solder_mask_margin", 1, null),
    pasteMargin: value(n, "solder_paste_margin", 1, null),
    pasteRatio: value(n, "solder_paste_margin_ratio", 1, value(n, "solder_paste_ratio", 1, null)),
    clearance: value(n, "clearance", 1, null),
    zoneConnect: zc === null ? null : ZONE_CONNECT[zc] ?? String(zc),
    thermalWidth: value(n, "thermal_bridge_width", 1, value(n, "thermal_width", 1, null)),
    thermalGap: value(n, "thermal_gap", 1, null),
  };
}

// ---- shapes ---------------------------------------------------------------

function strokeWidth(n) {
  const s = child(n, "stroke");
  if (s) return value(s, "width", 1, 0);
  return value(n, "width", 1, 0);
}

function isFilled(n) {
  const fNode = child(n, "fill");
  if (!fNode) return false;
  const v = fNode[1];
  if (v === "solid" || v === "yes" || v === true) return true;
  return value(fNode, "type", 1, "none") === "solid";
}

/**
 * Normalised shape: {kind: line|arc|circle|poly|curve, layer, width, fill, ...}
 * Rectangles become polygons so footprint rotation needs no special case.
 */
export function parseShape(n, m) {
  const T = m ? (p) => apply(m, p.x, p.y) : (p) => p;
  const layer = String(value(n, "layer", 1, ""));
  const width = strokeWidth(n);
  const fill = isFilled(n);
  const kind = n[0].replace(/^(fp|gr)_/, "");
  switch (kind) {
    case "line":
      return { kind: "line", layer, width, start: T(xy(n, "start")), end: T(xy(n, "end")) };
    case "rect": {
      const s = xy(n, "start"), e = xy(n, "end");
      const pts = [s, { x: e.x, y: s.y }, e, { x: s.x, y: e.y }].map(T);
      return { kind: "poly", layer, width, fill, pts, rect: true };
    }
    case "circle": {
      const c = xy(n, "center"), e = xy(n, "end");
      return { kind: "circle", layer, width, fill, center: T(c), r: Math.hypot(e.x - c.x, e.y - c.y) };
    }
    case "arc": {
      let s = xy(n, "start"), mid = xy(n, "mid"), e = xy(n, "end");
      if (!mid) {
        // Legacy: (start = centre) (end = arc start) (angle sweep)
        const angle = value(n, "angle", 1, 90);
        const c = s;
        const r = arcMidFromCenter(c, e, angle);
        s = e;
        mid = r.mid;
        e = r.end;
      }
      return { kind: "arc", layer, width, start: T(s), mid: T(mid), end: T(e) };
    }
    case "poly":
      return { kind: "poly", layer, width, fill, pts: polyPoints(child(n, "pts"), T) };
    case "curve": {
      const pts = polyPoints(child(n, "pts"), T);
      return { kind: "curve", layer, width, pts };
    }
    case "bbox":
      return null;
  }
  return null;
}

/** Points list that may contain (arc (start)(mid)(end)) elements. */
function polyPoints(ptsNode, T = (p) => p) {
  const out = [];
  if (!ptsNode) return out;
  for (let i = 1; i < ptsNode.length; i++) {
    const c = ptsNode[i];
    if (!Array.isArray(c)) continue;
    if (c[0] === "xy") out.push(T({ x: num(c[1]), y: num(c[2]) }));
    else if (c[0] === "arc") out.push({ arc: true, start: T(xy(c, "start")), mid: T(xy(c, "mid")), end: T(xy(c, "end")) });
  }
  return out;
}

function parseTextEffects(n) {
  const e = child(n, "effects");
  const font = child(e, "font");
  const size = child(font, "size");
  const j = child(e, "justify");
  const out = {
    size: size ? num(size[1], 1) : 1,
    width: size ? num(size[2], num(size[1], 1)) : 1,
    thickness: value(font, "thickness", 1, 0.15),
    bold: flag(font, "bold"),
    italic: flag(font, "italic"),
    h: "center",
    v: "center",
    mirror: false,
    hide: flag(e, "hide"),
  };
  if (j) {
    for (const a of j.slice(1)) {
      if (a === "left" || a === "right") out.h = a;
      else if (a === "top" || a === "bottom") out.v = a;
      else if (a === "mirror") out.mirror = true;
    }
  }
  return out;
}

function parseText(n, m, text = null) {
  const p = at(n);
  const pos = m ? apply(m, p.x, p.y) : { x: p.x, y: p.y };
  const effects = parseTextEffects(n);
  const layerNode = child(n, "layer");
  return {
    kind: "text",
    text: text ?? String(n[1] ?? ""),
    x: pos.x,
    y: pos.y,
    angle: p.angle,
    layer: String(layerNode?.[1] ?? ""),
    knockout: !!layerNode && layerNode.includes("knockout"),
    effects,
    hide: effects.hide || flag(n, "hide") || n.includes("hide"),
    unlocked: flag(n, "unlocked"),
  };
}

function parseTextBox(n, m) {
  const T = m ? (p) => apply(m, p.x, p.y) : (p) => p;
  const effects = parseTextEffects(n);
  let pts;
  if (child(n, "pts")) pts = polyPoints(child(n, "pts"), T);
  else {
    const s = xy(n, "start"), e = xy(n, "end");
    pts = [s, { x: e.x, y: s.y }, e, { x: s.x, y: e.y }].map(T);
  }
  return { kind: "textbox", text: String(n[1] ?? ""), layer: String(value(n, "layer", 1, "")), pts, angle: value(n, "angle", 1, 0), effects, width: strokeWidth(n), border: flag(n, "border", true) };
}

function parseDimension(n) {
  const out = [];
  const layer = String(value(n, "layer", 1, "Dwgs.User"));
  const style = child(n, "style");
  const width = value(style, "thickness", 1, 0.15);
  const type = String(value(n, "type", 1, "aligned"));
  const pts = children(child(n, "pts"), "xy").map((c) => ({ x: num(c[1]), y: num(c[2]) }));
  const height = value(n, "height", 1, 0);
  if (pts.length >= 2 && (type === "aligned" || type === "orthogonal")) {
    let [a, b] = pts;
    if (type === "orthogonal") {
      const orient = value(n, "orientation", 1, 0);
      b = orient === 1 ? { x: a.x, y: b.y } : { x: b.x, y: a.y };
    }
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len; // KiCad offsets along the left-hand normal
    const a2 = { x: a.x - nx * height, y: a.y - ny * height };
    const b2 = { x: b.x - nx * height, y: b.y - ny * height };
    out.push({ kind: "line", layer, width, start: a, end: a2 });
    out.push({ kind: "line", layer, width, start: pts[1], end: b2 });
    out.push({ kind: "line", layer, width, start: a2, end: b2 });
  } else if (pts.length >= 2) {
    out.push({ kind: "line", layer, width, start: pts[0], end: pts[1] });
  }
  const t = child(n, "gr_text");
  if (t) out.push(parseText(t, null));
  return out;
}

// ---- zones ----------------------------------------------------------------

function parseZone(n, pcb) {
  const layersNode = child(n, "layers");
  const layer = value(n, "layer", 1, null);
  const layers = layersNode ? layersNode.slice(1).map(String) : layer ? [String(layer)] : [];
  const outline = children(n, "polygon").map((p) => polyPoints(child(p, "pts")));
  const filled = children(n, "filled_polygon").map((p) => ({ layer: String(value(p, "layer", 1, layers[0] ?? "")), pts: polyPoints(child(p, "pts")), island: flag(p, "island") }));
  const keepout = child(n, "keepout");
  return {
    uuid: String(value(n, "uuid", 1, value(n, "tstamp", 1, ""))),
    net: netOf(n, pcb) || String(value(n, "net_name", 1, "")),
    name: value(n, "name", 1, ""),
    layers,
    outline,
    filled,
    keepout: !!keepout,
    // KiCad 8+ teardrops are zones it regenerates from the routing.
    teardrop: !!child(child(n, "attr"), "teardrop") || String(value(n, "name", 1, "")).startsWith("$teardrop"),
    settings: zoneSettings(n, keepout),
    hatch: value(n, "hatch", 1, "edge"),
    // Fills drawn with an outline of min_thickness (KiCad 6 and older; newer files say "no").
    fillWidth: String(value(n, "filled_areas_thickness", 1, "yes")) === "no" ? 0 : Number(value(n, "min_thickness", 1, 0)) || 0,
  };
}

const PAD_CONNECTION = { yes: "solid", no: "none", thru_hole_only: "thermal reliefs for PTH only" };
const ISLANDS = { 0: "always", 1: "never", 2: "below minimum area" };

/** The settings of KiCad's zone dialog that change the copper, as comparable values. */
function zoneSettings(n, keepout) {
  const pads = child(n, "connect_pads");
  const fill = child(n, "fill");
  const s = {
    priority: value(n, "priority", 1, 0),
    pads: pads && typeof pads[1] === "string" ? PAD_CONNECTION[pads[1]] ?? pads[1] : "thermal reliefs",
    clearance: value(pads, "clearance", 1, null),
    minWidth: value(n, "min_thickness", 1, null),
    fill: value(fill, "mode", 1, "solid") === "hatch" ? "hatched" : "solid",
    thermalGap: value(fill, "thermal_gap", 1, null),
    spokeWidth: value(fill, "thermal_bridge_width", 1, null),
    islands: ISLANDS[value(fill, "island_removal_mode", 1, 0)] ?? "always",
    islandArea: value(fill, "island_removal_mode", 1, 0) === 2 ? value(fill, "island_area_min", 1, null) : null,
    hatchWidth: value(fill, "hatch_thickness", 1, null),
    hatchGap: value(fill, "hatch_gap", 1, null),
    smoothing: value(fill, "smoothing", 1, "none"),
    radius: value(fill, "radius", 1, null),
  };
  if (keepout) {
    const banned = ["tracks", "vias", "pads", "copperpour", "footprints"].filter((k) => value(keepout, k, 1, "allowed") === "not_allowed");
    s.keepout = banned.map((k) => (k === "copperpour" ? "copper pour" : k)).join(", ") || "nothing";
  }
  return s;
}

// ---- helpers --------------------------------------------------------------

/** Does a pad/via layer list include `layer`? Handles *.Cu, F&B.Cu, *.Mask etc. */
export function onLayer(list, layer) {
  for (const l of list) {
    if (l === layer) return true;
    if (l.startsWith("*.") && layer.endsWith(l.slice(1))) return true;
    if (l.startsWith("F&B.") && (layer === "F." + l.slice(4) || layer === "B." + l.slice(4))) return true;
  }
  return false;
}

export function copperLayers(pcb) {
  return pcb.layers.filter((l) => l.name.endsWith(".Cu")).map((l) => l.name);
}

/** Copper layers in physical order, front to back. */
export function copperOrder(pcb) {
  const cu = copperLayers(pcb);
  const inner = cu.filter((n) => /^In\d+\.Cu$/.test(n)).sort((a, b) => parseInt(a.slice(2)) - parseInt(b.slice(2)));
  return [cu.includes("F.Cu") ? "F.Cu" : null, ...inner, cu.includes("B.Cu") ? "B.Cu" : null].filter(Boolean);
}

/** Copper layers spanned by a via (blind/buried vias cover a range). */
export function viaLayers(pcb, via) {
  const order = copperOrder(pcb);
  if (via.kind === "through") return order;
  const i0 = order.indexOf(via.layers[0]), i1 = order.indexOf(via.layers[1]);
  if (i0 < 0 || i1 < 0) return order;
  return order.slice(Math.min(i0, i1), Math.max(i0, i1) + 1);
}

/**
 * The outer side most of a net's copper is on, for cross-probing: pads and
 * track pieces on F.Cu count for the front, on B.Cu for the back (through-hole
 * pads and inner layers for neither). Null when it's even, or there's none.
 * @returns {"front" | "back" | null}
 */
export function netSide(pcb, net) {
  let front = 0, back = 0;
  const count = (layers) => {
    const f = layers.includes("F.Cu"), b = layers.includes("B.Cu");
    if (f && !b) front++;
    else if (b && !f) back++;
  };
  for (const fp of pcb.footprints) for (const p of fp.pads) if (p.net === net) count(p.layers);
  for (const t of pcb.tracks) if (t.net === net) count([t.layer]);
  return front > back ? "front" : back > front ? "back" : null;
}
