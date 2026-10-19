// Schematic (.kicad_sch) model: turns the S-expression tree into plain objects.
//
// Coordinates are millimetres, Y pointing down (screen convention). Library
// symbol graphics are stored Y-up in the file; they are flipped while parsing
// so everything downstream works in one coordinate system.

import { parse, child, children, value, flag, at, xy, num } from "../sexpr.js";

/** @param {string|any[]} src file text or parsed tree */
export function parseSchematic(src, filename = "") {
  const root = typeof src === "string" ? parse(src) : src;
  if (root[0] !== "kicad_sch") throw new Error(`${filename || "file"} is not a KiCad schematic (found "${root[0]}")`);

  const sch = {
    filename,
    version: value(root, "version", 1, 0),
    generator: value(root, "generator", 1, ""),
    generatorVersion: value(root, "generator_version", 1, ""),
    uuid: value(root, "uuid", 1, ""),
    paper: parsePaper(child(root, "paper")),
    titleBlock: parseTitleBlock(child(root, "title_block")),
    libSymbols: new Map(),
    symbols: [],
    wires: [],
    buses: [],
    busEntries: [],
    junctions: [],
    noConnects: [],
    labels: [],
    texts: [],
    textBoxes: [],
    graphics: [],
    sheets: [],
    images: [],
    tables: [],
    ruleAreas: [],
    // v6 files keep per-sheet references in the root file only.
    legacySymbolInstances: new Map(),
    sheetInstances: new Map(),
  };

  const lib = child(root, "lib_symbols");
  if (lib) {
    for (const s of children(lib, "symbol")) {
      const sym = parseLibSymbol(s);
      sch.libSymbols.set(sym.name, sym);
    }
    for (const sym of sch.libSymbols.values()) resolveExtends(sym, sch.libSymbols);
  }

  for (let i = 1; i < root.length; i++) {
    const n = root[i];
    if (!Array.isArray(n)) continue;
    switch (n[0]) {
      case "symbol":
        sch.symbols.push(parseSymbolInstance(n));
        break;
      case "wire":
        sch.wires.push(parseLine(n));
        break;
      case "bus":
        sch.buses.push(parseLine(n));
        break;
      case "polyline":
        // Top-level polylines are graphic lines (notes layer).
        sch.graphics.push(parseGraphic(n, false));
        break;
      case "arc":
      case "circle":
      case "rectangle":
      case "bezier":
        sch.graphics.push(parseGraphic(n, false));
        break;
      case "bus_entry": {
        const p = at(n);
        const size = child(n, "size");
        sch.busEntries.push({ x: p.x, y: p.y, dx: num(size?.[1]), dy: num(size?.[2]), stroke: parseStroke(child(n, "stroke")) });
        break;
      }
      case "junction": {
        const p = at(n);
        sch.junctions.push({ x: p.x, y: p.y, diameter: value(n, "diameter", 1, 0), color: parseColor(child(n, "color")) });
        break;
      }
      case "no_connect": {
        const p = at(n);
        sch.noConnects.push({ x: p.x, y: p.y });
        break;
      }
      case "label":
      case "global_label":
      case "hierarchical_label":
      case "netclass_flag":
      case "directive_label":
        sch.labels.push(parseLabel(n));
        break;
      case "text":
        sch.texts.push(parseText(n, false));
        break;
      case "text_box":
        sch.textBoxes.push(parseTextBox(n, false));
        break;
      case "sheet":
        sch.sheets.push(parseSheet(n));
        break;
      case "image":
        sch.images.push(parseImage(n));
        break;
      case "table":
        sch.tables.push(parseTable(n));
        break;
      case "rule_area": {
        const poly = child(n, "polyline");
        if (poly) sch.ruleAreas.push(parseGraphic(poly, false));
        break;
      }
      case "symbol_instances":
        for (const p of children(n, "path")) {
          sch.legacySymbolInstances.set(p[1], { reference: value(p, "reference", 1, ""), unit: value(p, "unit", 1, 1), value: value(p, "value", 1), footprint: value(p, "footprint", 1) });
        }
        break;
      case "sheet_instances":
        for (const p of children(n, "path")) sch.sheetInstances.set(p[1], { page: String(value(p, "page", 1, "")) });
        break;
    }
  }
  return sch;
}

// ---- Paper / title block -------------------------------------------------

export const PAPER_SIZES = {
  A5: [210, 148], A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
  A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6],
  USLetter: [279.4, 215.9], USLegal: [355.6, 215.9], USLedger: [431.8, 279.4],
  GERBER: [812.8, 812.8],
};

export function parsePaper(n) {
  if (!n) return { size: "A4", width: 297, height: 210, portrait: false };
  const size = String(n[1] ?? "A4");
  let w, h;
  if (size === "User") {
    w = num(n[2], 297);
    h = num(n[3], 210);
  } else {
    [w, h] = PAPER_SIZES[size] ?? PAPER_SIZES.A4;
  }
  const portrait = n.includes("portrait");
  if (portrait) [w, h] = [h, w];
  return { size, width: w, height: h, portrait };
}

export function parseTitleBlock(n) {
  const tb = { title: "", date: "", rev: "", company: "", comments: {} };
  if (!n) return tb;
  tb.title = String(value(n, "title", 1, ""));
  tb.date = String(value(n, "date", 1, ""));
  tb.rev = String(value(n, "rev", 1, ""));
  tb.company = String(value(n, "company", 1, ""));
  for (const c of children(n, "comment")) tb.comments[c[1]] = String(c[2] ?? "");
  return tb;
}

// ---- Shared primitives ---------------------------------------------------

export function parseStroke(n) {
  if (!n) return { width: 0, type: "default", color: null };
  return { width: value(n, "width", 1, 0), type: String(value(n, "type", 1, "default")), color: parseColor(child(n, "color")) };
}

export function parseColor(n) {
  if (!n) return null;
  const r = num(n[1]), g = num(n[2]), b = num(n[3]), a = num(n[4], 1);
  if (r === 0 && g === 0 && b === 0 && a === 0) return null; // "use default"
  return { r, g, b, a };
}

function parseFill(n) {
  if (!n) return { type: "none", color: null };
  return { type: String(value(n, "type", 1, "none")), color: parseColor(child(n, "color")) };
}

/**
 * Text effects. `justify` atoms combine horizontal (left/right),
 * vertical (top/bottom) and `mirror`; missing means centered.
 */
export function parseEffects(n) {
  const e = { size: 1.27, width: 1.27, thickness: 0, bold: false, italic: false, h: "center", v: "center", mirror: false, hide: false, color: null, face: null, lineSpacing: 1 };
  if (!n) return e;
  const font = child(n, "font");
  if (font) {
    const size = child(font, "size");
    if (size) {
      e.size = num(size[1], 1.27);
      e.width = num(size[2], e.size);
    }
    e.thickness = value(font, "thickness", 1, 0);
    e.bold = flag(font, "bold");
    e.italic = flag(font, "italic");
    e.color = parseColor(child(font, "color"));
    e.face = value(font, "face", 1, null);
    e.lineSpacing = value(font, "line_spacing", 1, 1);
  }
  const j = child(n, "justify");
  if (j) {
    for (const a of j.slice(1)) {
      if (a === "left" || a === "right") e.h = a;
      else if (a === "top" || a === "bottom") e.v = a;
      else if (a === "mirror") e.mirror = true;
    }
  }
  e.hide = flag(n, "hide");
  return e;
}

function parseProperty(n, flipY) {
  const p = at(n);
  const effects = parseEffects(child(n, "effects"));
  return {
    name: String(n[1]),
    value: String(n[2] ?? ""),
    id: value(n, "id", 1),
    x: p.x,
    y: flipY ? -p.y : p.y,
    angle: p.angle,
    effects,
    hide: effects.hide || flag(n, "hide"),
    showName: flag(n, "show_name"),
  };
}

function parsePts(n, flipY) {
  const pts = [];
  const ptsNode = child(n, "pts");
  if (!ptsNode) return pts;
  for (let i = 1; i < ptsNode.length; i++) {
    const c = ptsNode[i];
    if (Array.isArray(c) && c[0] === "xy") pts.push({ x: num(c[1]), y: flipY ? -num(c[2]) : num(c[2]) });
  }
  return pts;
}

function parseLine(n) {
  return { pts: parsePts(n, false), stroke: parseStroke(child(n, "stroke")), uuid: value(n, "uuid", 1) };
}

function pt(n, name, flipY) {
  const p = xy(n, name);
  if (!p) return { x: 0, y: 0 };
  return flipY ? { x: p.x, y: -p.y } : p;
}

/** Graphic primitives shared by lib symbols (flipY) and sheets. */
function parseGraphic(n, flipY) {
  const g = { type: n[0], stroke: parseStroke(child(n, "stroke")), fill: parseFill(child(n, "fill")) };
  switch (n[0]) {
    case "polyline":
    case "bezier":
      g.pts = parsePts(n, flipY);
      break;
    case "rectangle":
      g.start = pt(n, "start", flipY);
      g.end = pt(n, "end", flipY);
      g.radius = value(n, "radius", 1, 0);
      break;
    case "circle":
      g.center = pt(n, "center", flipY);
      g.radius = value(n, "radius", 1, 0);
      break;
    case "arc":
      g.start = pt(n, "start", flipY);
      g.end = pt(n, "end", flipY);
      if (child(n, "mid")) {
        g.mid = pt(n, "mid", flipY);
      } else {
        // KiCad 6 pre-release: (radius (at) (length) (angles a b))
        const rad = child(n, "radius");
        const c = rad ? pt(rad, "at", flipY) : { x: 0, y: 0 };
        const r = value(rad, "length", 1, 0);
        const a0 = Math.atan2(g.start.y - c.y, g.start.x - c.x);
        let a1 = Math.atan2(g.end.y - c.y, g.end.x - c.x);
        if (a1 < a0) a1 += Math.PI * 2;
        g.mid = { x: c.x + r * Math.cos((a0 + a1) / 2), y: c.y + r * Math.sin((a0 + a1) / 2) };
      }
      break;
  }
  return g;
}

function parseText(n, flipY) {
  const p = at(n);
  return {
    text: String(n[1] ?? ""),
    x: p.x,
    y: flipY ? -p.y : p.y,
    angle: p.angle,
    effects: parseEffects(child(n, "effects")),
    uuid: value(n, "uuid", 1),
  };
}

function parseTextBox(n, flipY) {
  const effects = parseEffects(child(n, "effects"));
  let x0, y0, w, h, angle = 0;
  if (child(n, "size")) {
    const p = at(n);
    x0 = p.x;
    y0 = flipY ? -p.y : p.y;
    angle = p.angle;
    w = value(n, "size", 1, 0);
    h = value(n, "size", 2, 0);
    if (flipY) y0 -= h;
  } else {
    const s = pt(n, "start", flipY), e = pt(n, "end", flipY);
    x0 = Math.min(s.x, e.x);
    y0 = Math.min(s.y, e.y);
    w = Math.abs(e.x - s.x);
    h = Math.abs(e.y - s.y);
  }
  const m = child(n, "margins");
  const margin = m ? [num(m[1]), num(m[2]), num(m[3]), num(m[4])] : null;
  return { text: String(n[1] ?? ""), x: x0, y: y0, w, h, angle, margins: margin, effects, stroke: parseStroke(child(n, "stroke")), fill: parseFill(child(n, "fill")) };
}

// ---- Library symbols -----------------------------------------------------

function parsePin(n) {
  const p = at(n);
  const nameNode = child(n, "name");
  const numNode = child(n, "number");
  return {
    type: String(n[1] ?? "passive"),
    shape: String(n[2] ?? "line"),
    x: p.x,
    y: -p.y,
    // Angle is the direction from the connection point towards the body,
    // counter-clockwise on screen (lib Y-up angles stay valid after the flip).
    angle: p.angle,
    length: value(n, "length", 1, 2.54),
    name: String(nameNode?.[1] ?? ""),
    nameEffects: parseEffects(child(nameNode, "effects")),
    number: String(numNode?.[1] ?? ""),
    numberEffects: parseEffects(child(numNode, "effects")),
    hide: flag(n, "hide"),
    alternates: children(n, "alternate").map((a) => ({ name: String(a[1]), type: String(a[2] ?? ""), shape: String(a[3] ?? "") })),
  };
}

export function parseLibSymbol(n) {
  const name = String(n[1]);
  const pinNames = child(n, "pin_names");
  const pinNumbers = child(n, "pin_numbers");
  const sym = {
    name,
    extends: value(n, "extends", 1, null),
    power: !!child(n, "power") || n.includes("power"),
    pinNamesOffset: pinNames ? value(pinNames, "offset", 1, 0.508) : 0.508,
    pinNamesHidden: pinNames ? flag(pinNames, "hide") : false,
    pinNumbersHidden: pinNumbers ? flag(pinNumbers, "hide") : false,
    properties: children(n, "property").map((p) => parseProperty(p, true)),
    units: [],
    unitCount: 1,
    hasBodyStyles: false,
  };

  // Graphics directly under the symbol (rare) count as unit 0.
  const direct = { unit: 0, bodyStyle: 0, graphics: [], pins: [], texts: [] };
  collectUnitItems(n, direct);
  if (direct.graphics.length || direct.pins.length || direct.texts.length) sym.units.push(direct);

  for (const u of children(n, "symbol")) {
    // Sub-symbol names are "<name>_<unit>_<bodystyle>".
    const m = /_(\d+)_(\d+)$/.exec(String(u[1]));
    const unit = { unit: m ? Number(m[1]) : 0, bodyStyle: m ? Number(m[2]) : 0, graphics: [], pins: [], texts: [] };
    collectUnitItems(u, unit);
    sym.units.push(unit);
  }
  sym.unitCount = Math.max(1, ...sym.units.map((u) => u.unit));
  sym.hasBodyStyles = sym.units.some((u) => u.bodyStyle > 1) || flag(child(n, "body_styles"), "demorgan");
  return sym;
}

function collectUnitItems(node, unit) {
  for (let i = 1; i < node.length; i++) {
    const c = node[i];
    if (!Array.isArray(c)) continue;
    switch (c[0]) {
      case "polyline":
      case "rectangle":
      case "circle":
      case "arc":
      case "bezier":
        unit.graphics.push(parseGraphic(c, true));
        break;
      case "text":
        unit.texts.push(parseText(c, true));
        break;
      case "text_box":
        unit.texts.push({ ...parseTextBox(c, true), box: true });
        break;
      case "pin":
        unit.pins.push(parsePin(c));
        break;
    }
  }
}

function resolveExtends(sym, lib) {
  if (!sym.extends || sym.units.length) return;
  // Library names in a schematic are "lib:name"; the parent shares the prefix.
  const prefix = sym.name.includes(":") ? sym.name.slice(0, sym.name.indexOf(":") + 1) : "";
  const parent = lib.get(prefix + sym.extends) ?? lib.get(sym.extends);
  if (!parent) return;
  resolveExtends(parent, lib);
  sym.units = parent.units;
  sym.unitCount = parent.unitCount;
  sym.hasBodyStyles = parent.hasBodyStyles;
  sym.pinNamesOffset = parent.pinNamesOffset;
  sym.pinNamesHidden = parent.pinNamesHidden;
  sym.pinNumbersHidden = parent.pinNumbersHidden;
  sym.power ||= parent.power;
}

// ---- Placed items --------------------------------------------------------

function parseSymbolInstance(n) {
  const p = at(n);
  const mirror = value(n, "mirror", 1, null);
  const instances = [];
  const inst = child(n, "instances");
  if (inst) {
    for (const proj of children(inst, "project")) {
      for (const path of children(proj, "path")) {
        instances.push({ project: String(proj[1]), path: String(path[1]), reference: String(value(path, "reference", 1, "")), unit: value(path, "unit", 1, null) });
      }
    }
  }
  return {
    libId: String(value(n, "lib_id", 1, "")),
    libName: value(n, "lib_name", 1, null),
    x: p.x,
    y: p.y,
    angle: p.angle,
    mirror,
    unit: value(n, "unit", 1, 1),
    bodyStyle: value(n, "body_style", 1, value(n, "convert", 1, 1)),
    dnp: flag(n, "dnp"),
    inBom: flag(n, "in_bom", true),
    onBoard: flag(n, "on_board", true),
    uuid: String(value(n, "uuid", 1, "")),
    properties: children(n, "property").map((pp) => parseProperty(pp, false)),
    pinUuids: children(n, "pin").map((pp) => ({ number: String(pp[1]), alternate: value(pp, "alternate", 1, null) })),
    instances,
    fieldsAutoplaced: flag(n, "fields_autoplaced"),
  };
}

function parseLabel(n) {
  const p = at(n);
  const kind = n[0] === "directive_label" ? "netclass_flag" : n[0];
  return {
    kind, // label | global_label | hierarchical_label | netclass_flag
    text: String(n[1] ?? ""),
    shape: String(value(n, "shape", 1, kind === "netclass_flag" ? "round" : "passive")),
    length: value(n, "length", 1, 2.54),
    x: p.x,
    y: p.y,
    angle: p.angle,
    effects: parseEffects(child(n, "effects")),
    properties: children(n, "property").map((pp) => parseProperty(pp, false)),
    uuid: value(n, "uuid", 1),
  };
}

function parseSheet(n) {
  const p = at(n);
  const size = child(n, "size");
  const props = children(n, "property").map((pp) => parseProperty(pp, false));
  const prop = (...names) => props.find((q) => names.includes(q.name));
  const nameProp = prop("Sheetname", "Sheet name");
  const fileProp = prop("Sheetfile", "Sheet file");
  const pages = [];
  const inst = child(n, "instances");
  if (inst) {
    for (const proj of children(inst, "project")) {
      for (const path of children(proj, "path")) pages.push({ path: String(path[1]), page: String(value(path, "page", 1, "")) });
    }
  }
  return {
    x: p.x,
    y: p.y,
    w: num(size?.[1]),
    h: num(size?.[2]),
    uuid: String(value(n, "uuid", 1, "")),
    stroke: parseStroke(child(n, "stroke")),
    fill: parseFill(child(n, "fill")),
    name: nameProp?.value ?? "",
    file: fileProp?.value ?? "",
    properties: props,
    pins: children(n, "pin").map((pin) => {
      const pp = at(pin);
      return { name: String(pin[1]), shape: String(pin[2] ?? "input"), x: pp.x, y: pp.y, angle: pp.angle, effects: parseEffects(child(pin, "effects")), uuid: value(pin, "uuid", 1) };
    }),
    pages,
  };
}

function parseImage(n) {
  const p = at(n);
  const dataNode = child(n, "data");
  // Image data is split into many quoted base64 chunks.
  const data = dataNode ? dataNode.slice(1).join("").replace(/\s+/g, "") : "";
  return { x: p.x, y: p.y, scale: value(n, "scale", 1, 1), data };
}

function parseTable(n) {
  const cells = [];
  const cellsNode = child(n, "cells");
  for (const c of children(cellsNode, "table_cell")) cells.push(parseTextBox(c, false));
  return { cells, border: parseStroke(child(child(n, "border"), "stroke")), separators: parseStroke(child(child(n, "separators"), "stroke")) };
}

// ---- Helpers for consumers ----------------------------------------------

export function symbolProperty(sym, name) {
  return sym.properties.find((p) => p.name === name);
}

/** Library definition for a placed symbol (lib_name overrides lib_id). */
export function libSymbolFor(sch, sym) {
  return sch.libSymbols.get(sym.libName ?? sym.libId) ?? sch.libSymbols.get(sym.libId);
}
