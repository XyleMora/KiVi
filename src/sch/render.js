// Schematic → SVG renderer.

import { multiply, rotate, scale, translate, apply, applyVec, f, svgArcTo, BBox, escapeXml } from "../geom.js";
import { svgText, textWidth, plainText, textBlockSize, FONT_FAMILY } from "../text.js";
import { getDefaultDrawingSheet, renderDrawingSheet, substitute } from "../drawing-sheet.js";
import { libSymbolFor } from "./model.js";
import { SCH_THEMES } from "./theme.js";

const DEFAULT_LINE = 0.1524; // 6 mil
const BUS_LINE = 0.3048; // 12 mil
const JUNCTION_DIAMETER = 0.9144; // 36 mil
const NC_HALF = 0.6096; // 24 mil
const PIN_TEXT_GAP = 0.4064; // distance between pin line and its number/name
const INVERT_RADIUS = 0.635;
const CLOCK_SIZE = 0.635;
const TEXT_OFFSET_RATIO = 0.15; // label text offset (KiCad schematic setup default)
const LABEL_BOX_RATIO = 0.375; // global label box expansion (KiCad default)

/** Schematic text: stroke-font pen width defaults to the schematic line width. */
const stext = (o) => svgText({ penWidth: o.bold ? Math.max(DEFAULT_LINE, o.size / 5) : DEFAULT_LINE, ...o });

/**
 * Render one schematic sheet.
 *
 * @param {object} sch    parsed schematic (parseSchematic)
 * @param {object} [opts]
 * @param {string} [opts.theme]           theme name or theme object
 * @param {string} [opts.path]            hierarchical instance path, e.g. "/<root-uuid>/<sheet-uuid>"
 * @param {Map}    [opts.legacyInstances] v6 symbol_instances map from the root schematic
 * @param {object} [opts.vars]            text variables (project + title block)
 * @param {object} [opts.drawingSheet]    parsed .kicad_wks (default sheet if omitted)
 * @param {boolean} [opts.frame=true]     draw page frame / title block
 * @param {Map<string,string[]>} [opts.intersheetRefs] global label name → page numbers
 * @returns {{svg: string, bbox: BBox, items: object[]}}
 */
export function renderSchematic(sch, opts = {}) {
  const theme = typeof opts.theme === "object" ? opts.theme : SCH_THEMES[opts.theme ?? "kicad"];
  const ctx = new Ctx(sch, theme, opts);
  const parts = [];

  parts.push(`<rect class="page" x="0" y="0" width="${f(sch.paper.width)}" height="${f(sch.paper.height)}" fill="${theme.background}"/>`);
  if (opts.frame !== false) {
    const ds = opts.drawingSheet ?? getDefaultDrawingSheet();
    parts.push(renderDrawingSheet(ds, sch.paper, ctx.vars, { color: theme.pageFrame, pageNumber: Number(ctx.vars["#"]) || 1 }));
  }
  for (const img of sch.images) parts.push(ctx.image(img));
  for (const s of sch.sheets) parts.push(ctx.sheet(s));
  for (const g of sch.graphics) parts.push(ctx.graphic(g, theme.notes, null));
  for (const r of sch.ruleAreas) parts.push(ctx.graphic({ ...r, stroke: { ...r.stroke, type: r.stroke.type === "default" ? "dash" : r.stroke.type } }, theme.notes, null));
  for (const t of sch.textBoxes) parts.push(ctx.textBox(t, theme.notes));
  for (const t of sch.tables) parts.push(ctx.table(t));
  for (const s of sch.symbols) parts.push(ctx.symbol(s));
  parts.push(ctx.wires());
  for (const l of sch.labels) parts.push(ctx.label(l));
  for (const t of sch.texts) parts.push(ctx.note(t));

  const bbox = new BBox().add(0, 0).add(sch.paper.width, sch.paper.height);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(sch.paper.width)} ${f(sch.paper.height)}" ` +
    `width="${f(sch.paper.width)}mm" height="${f(sch.paper.height)}mm" ` +
    `font-family="${escapeXml(FONT_FAMILY)}" stroke-linecap="round" stroke-linejoin="round">` +
    parts.join("") +
    `</svg>`;
  return { svg, bbox, items: ctx.items };
}


class Ctx {
  constructor(sch, theme, opts) {
    this.sch = sch;
    this.t = theme;
    this.opts = opts;
    this.path = opts.path ?? (sch.uuid ? `/${sch.uuid}` : "/");
    this.items = [];
    const tb = sch.titleBlock;
    this.vars = {
      TITLE: tb.title,
      ISSUE_DATE: tb.date,
      CURRENT_DATE: new Date().toISOString().slice(0, 10),
      REVISION: tb.rev,
      COMPANY: tb.company,
      PAPER: sch.paper.size,
      FILENAME: sch.filename.split("/").pop(),
      SHEETPATH: "/",
      SHEETNAME: "",
      KICAD_VERSION: `KiCad E.D.A. ${sch.generatorVersion || ""}`.trim(),
      "#": "1",
      "##": "1",
      ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`COMMENT${i + 1}`, tb.comments[i + 1] ?? ""])),
      ...(opts.vars ?? {}),
    };
  }

  // ---- generic drawing helpers ----

  strokeAttrs(stroke, fallbackColor, fallbackWidth = DEFAULT_LINE) {
    const w = stroke?.width > 0 ? stroke.width : fallbackWidth;
    const color = stroke?.color ? rgba(stroke.color) : fallbackColor;
    let dash = "";
    const type = stroke?.type ?? "default";
    const u = Math.max(w, 0.15);
    if (type === "dash") dash = ` stroke-dasharray="${f(u * 7)} ${f(u * 4)}"`;
    else if (type === "dot") dash = ` stroke-dasharray="${f(u * 0.01)} ${f(u * 3)}"`;
    else if (type === "dash_dot") dash = ` stroke-dasharray="${f(u * 7)} ${f(u * 3)} ${f(u * 0.01)} ${f(u * 3)}"`;
    else if (type === "dash_dot_dot") dash = ` stroke-dasharray="${f(u * 7)} ${f(u * 3)} ${f(u * 0.01)} ${f(u * 3)} ${f(u * 0.01)} ${f(u * 3)}"`;
    return `stroke="${color}" stroke-width="${f(w)}"${dash}`;
  }

  fillAttr(fill, strokeColor) {
    switch (fill?.type) {
      case "outline":
        return `fill="${strokeColor}"`;
      case "background":
        return `fill="${this.t.bodyFill}"`;
      case "color":
        return fill.color ? `fill="${rgba(fill.color)}"` : `fill="none"`;
      default:
        return fill?.color && fill.color.a > 0 ? `fill="${rgba(fill.color)}"` : `fill="none"`;
    }
  }

  /** Graphic primitive in its own coordinates (caller applies transforms). */
  graphic(g, color, bboxOut, m = null) {
    const P = m ? (p) => apply(m, p.x, p.y) : (p) => p;
    const strokeColor = g.stroke?.color ? rgba(g.stroke.color) : color;
    const sa = this.strokeAttrs(g.stroke, color);
    const fa = this.fillAttr(g.fill, strokeColor);
    const add = (p) => bboxOut?.add(p.x, p.y);
    switch (g.type) {
      case "polyline": {
        if (g.pts.length < 2) return "";
        const pts = g.pts.map(P);
        pts.forEach(add);
        const d = pts.map((p, i) => `${i ? "L" : "M"}${f(p.x)} ${f(p.y)}`).join("");
        return `<path d="${d}" ${fa} ${sa}/>`;
      }
      case "bezier": {
        const pts = g.pts.map(P);
        if (pts.length < 4) return "";
        pts.forEach(add);
        return `<path d="M${f(pts[0].x)} ${f(pts[0].y)}C${pts.slice(1, 4).map((p) => `${f(p.x)} ${f(p.y)}`).join(" ")}" ${fa} ${sa}/>`;
      }
      case "rectangle": {
        const a = P(g.start), b = P(g.end);
        add(a);
        add(b);
        if (g.radius) {
          return `<rect x="${f(Math.min(a.x, b.x))}" y="${f(Math.min(a.y, b.y))}" width="${f(Math.abs(b.x - a.x))}" height="${f(Math.abs(b.y - a.y))}" rx="${f(g.radius)}" ${fa} ${sa}/>`;
        }
        // A path, not <rect>: libraries use zero-width rectangles as lines.
        return `<path d="M${f(a.x)} ${f(a.y)}H${f(b.x)}V${f(b.y)}H${f(a.x)}Z" ${fa} ${sa}/>`;
      }
      case "circle": {
        const c = P(g.center);
        bboxOut?.add(c.x - g.radius, c.y - g.radius).add(c.x + g.radius, c.y + g.radius);
        return `<circle cx="${f(c.x)}" cy="${f(c.y)}" r="${f(g.radius)}" ${fa} ${sa}/>`;
      }
      case "arc": {
        const s = P(g.start), mid = P(g.mid), e = P(g.end);
        add(s);
        add(mid);
        add(e);
        return `<path d="M${f(s.x)} ${f(s.y)}${svgArcTo(s, mid, e)}" ${fa} ${sa}/>`;
      }
    }
    return "";
  }

  // ---- symbols ----

  resolveInstance(sym) {
    const path = this.path;
    let hit = sym.instances.find((i) => i.path === path);
    if (!hit && sym.instances.length) {
      // Paths may or may not include the root sheet uuid depending on version.
      const strip = (p) => p.replace(/^\/[^/]+/, "");
      hit = sym.instances.find((i) => strip(i.path) === strip(path) || i.path === strip(path) || strip(i.path) === path);
      if (!hit && this.opts.allowFirstInstance !== false) hit = sym.instances[0];
    }
    if (!hit && this.opts.legacyInstances) {
      const legacyPath = (this.opts.legacyPath ?? "") + "/" + sym.uuid;
      const l = this.opts.legacyInstances.get(legacyPath);
      if (l) hit = { reference: l.reference, unit: l.unit };
    }
    return hit;
  }

  symbol(s) {
    const lib = libSymbolFor(this.sch, s);
    const inst = this.resolveInstance(s);
    const unit = inst?.unit ?? s.unit ?? 1;
    const refProp = s.properties.find((p) => p.name === "Reference");
    const reference = inst?.reference || refProp?.value || "?";
    const t = this.t;

    const lin = multiply(s.mirror === "x" ? scale(1, -1) : s.mirror === "y" ? scale(-1, 1) : scale(1, 1), rotate(s.angle));
    const m = multiply(translate(s.x, s.y), lin);
    const bbox = new BBox();
    let body = "";
    let pins = "";
    const pinsInfo = [];

    if (!lib) {
      body += stext({ text: `??${s.libId}`, x: s.x, y: s.y, size: 1.27, color: t.dnp });
      bbox.add(s.x - 2, s.y - 2).add(s.x + 2, s.y + 2);
    } else {
      const units = lib.units.filter((u) => (u.unit === 0 || u.unit === unit) && (u.bodyStyle === 0 || u.bodyStyle === (s.bodyStyle || 1)));
      // Background fills first so outlines drawn later stay visible.
      for (const u of units) for (const g of u.graphics) if (g.fill?.type === "background") body += this.graphic({ ...g, stroke: { ...g.stroke, width: 0.0001 } }, t.body, null, m);
      for (const u of units) {
        for (const g of u.graphics) {
          const g2 = g.fill?.type === "background" ? { ...g, fill: { type: "none" } } : g;
          body += this.graphic(g2, t.body, bbox, m);
        }
        for (const tx of u.texts) body += this.libText(tx, m, lin, bbox);
      }
      for (const u of units) {
        for (const p of u.pins) {
          const pin = this.pin(p, lib, m, lin, bbox);
          pins += pin.svg;
          pinsInfo.push(pin.info);
        }
      }
    }

    // DNP cross covers the body only, like eeschema.
    const bodyBox = new BBox().addBox(bbox);
    let fields = "";
    const unitSuffix = lib && lib.unitCount > 1 ? unitLetter(unit) : "";
    for (const p of s.properties) {
      if (p.hide || p.name.startsWith("ki_")) continue;
      let text = p.value;
      if (p.name === "Reference") text = reference + unitSuffix;
      text = this.fieldVars(text, s, reference);
      if (!text) continue;
      if (p.showName) text = `${p.name}: ${text}`;
      const color = p.effects.color ? rgba(p.effects.color) : p.name === "Reference" ? t.reference : p.name === "Value" ? t.value : t.fields;
      fields += this.field(p, text, lin, color, bbox);
    }

    if (bbox.empty) bbox.add(s.x, s.y);
    let dnp = "";
    if (s.dnp && lib) {
      const b = bodyBox.empty ? bbox : bodyBox;
      dnp = `<path d="M${f(b.x0)} ${f(b.y0)}L${f(b.x1)} ${f(b.y1)}M${f(b.x1)} ${f(b.y0)}L${f(b.x0)} ${f(b.y1)}" stroke="${t.dnp}" stroke-width="${f(DEFAULT_LINE * 2)}" opacity="0.8"/>`;
    }

    const valueProp = s.properties.find((p) => p.name === "Value");
    const item = {
      kind: "symbol",
      uuid: s.uuid,
      reference: reference + unitSuffix,
      baseReference: reference,
      value: valueProp?.value ?? "",
      libId: s.libId,
      unit,
      power: !!lib?.power,
      dnp: s.dnp,
      properties: s.properties.filter((p) => !p.name.startsWith("ki_")).map((p) => ({ name: p.name, value: p.name === "Reference" ? reference : p.value })),
      description: lib?.properties.find((p) => p.name === "Description")?.value ?? "",
      pins: pinsInfo,
      bbox: new BBox().addBox(bbox).grow(0.3),
    };
    this.items.push(item);
    const opacity = s.dnp ? ` opacity="0.55"` : "";
    return `<g class="symbol" data-uuid="${escapeXml(s.uuid)}"${opacity}>${body}${pins}${fields}</g>${dnp}`;
  }

  fieldVars(text, s, reference) {
    if (!text.includes("${")) return text;
    const local = { REFERENCE: reference };
    for (const p of s.properties) local[p.name.toUpperCase()] = p.value;
    return substitute(text, { ...this.vars, ...local });
  }

  /**
   * Symbol field. Positions are absolute; justification and angle are in the
   * symbol's frame, so they are re-oriented by the symbol transform and then
   * kept readable (horizontal or bottom-to-top vertical).
   */
  field(p, text, lin, color, bboxOut) {
    const e = p.effects;
    const fa = ((p.angle % 180) + 180) % 180 === 90 ? 90 : 0;
    const u = fa === 90 ? { x: 0, y: -1 } : { x: 1, y: 0 }; // text direction in field frame
    const w = fa === 90 ? { x: -1, y: 0 } : { x: 0, y: -1 }; // text "up" in field frame
    const u2 = applyVec(lin, u.x, u.y), w2 = applyVec(lin, w.x, w.y);
    const drawAngle = Math.abs(u2.x) > 0.5 ? 0 : 90;
    const U = drawAngle === 0 ? { x: 1, y: 0 } : { x: 0, y: -1 };
    const W = drawAngle === 0 ? { x: 0, y: -1 } : { x: -1, y: 0 };
    let h = e.h, v = e.v;
    if (u2.x * U.x + u2.y * U.y < 0) h = flipH(h);
    if (w2.x * W.x + w2.y * W.y < 0) v = flipV(v);
    this.textBounds(bboxOut, text, p.x, p.y, drawAngle, e.size, h, v, e.bold);
    return stext({ text, x: p.x, y: p.y, angle: drawAngle, size: e.size, width: e.width, h, v, bold: e.bold, italic: e.italic, color });
  }

  /** Free text inside a library symbol: rotates with the symbol, stays readable. */
  libText(tx, m, lin, bboxOut) {
    const pos = apply(m, tx.x, tx.y);
    if (tx.box) {
      // Text boxes inside symbols are rare; draw them as plain text at the box centre.
      return stext({ text: tx.text, x: pos.x, y: pos.y, size: tx.effects.size, color: this.t.body });
    }
    return this.field({ ...tx, x: pos.x, y: pos.y, effects: tx.effects }, tx.text, lin, tx.effects.color ? rgba(tx.effects.color) : this.t.body, bboxOut);
  }

  pin(p, lib, m, lin, bboxOut) {
    const t = this.t;
    const rad = (p.angle * Math.PI) / 180;
    const d = { x: Math.round(Math.cos(rad) * 1e6) / 1e6, y: -Math.round(Math.sin(rad) * 1e6) / 1e6 }; // lib frame, y-down
    const start = { x: p.x, y: p.y };
    const end = { x: p.x + d.x * p.length, y: p.y + d.y * p.length };
    const A = apply(m, start.x, start.y);
    const B = apply(m, end.x, end.y);
    const dw = applyVec(lin, d.x, d.y);
    const info = { number: p.number, name: p.name, type: p.type, x: A.x, y: A.y, hidden: p.hide };
    if (p.hide) return { svg: "", info };
    bboxOut.add(A.x, A.y).add(B.x, B.y);

    let svg = "";
    const shape = p.shape;
    const inverted = shape === "inverted" || shape === "inverted_clock";
    const lineEnd = inverted ? { x: B.x - dw.x * INVERT_RADIUS * 2, y: B.y - dw.y * INVERT_RADIUS * 2 } : B;
    const sw = f(DEFAULT_LINE);
    if (p.length > 0) svg += `<path d="M${f(A.x)} ${f(A.y)}L${f(lineEnd.x)} ${f(lineEnd.y)}" stroke="${t.pin}" stroke-width="${sw}"/>`;
    if (inverted) {
      svg += `<circle cx="${f(B.x - dw.x * INVERT_RADIUS)}" cy="${f(B.y - dw.y * INVERT_RADIUS)}" r="${f(INVERT_RADIUS)}" fill="none" stroke="${t.pin}" stroke-width="${sw}"/>`;
    }
    const perp = { x: -dw.y, y: dw.x };
    if (shape === "clock" || shape === "inverted_clock" || shape === "clock_low" || shape === "edge_clock_high") {
      const c1 = { x: B.x + perp.x * CLOCK_SIZE, y: B.y + perp.y * CLOCK_SIZE };
      const c2 = { x: B.x + dw.x * CLOCK_SIZE, y: B.y + dw.y * CLOCK_SIZE };
      const c3 = { x: B.x - perp.x * CLOCK_SIZE, y: B.y - perp.y * CLOCK_SIZE };
      svg += `<path d="M${f(c1.x)} ${f(c1.y)}L${f(c2.x)} ${f(c2.y)}L${f(c3.x)} ${f(c3.y)}" fill="none" stroke="${t.pin}" stroke-width="${sw}"/>`;
    }
    if (shape === "input_low" || shape === "clock_low" || shape === "output_low") {
      // Low-active "wedge" outside the body.
      const s2 = CLOCK_SIZE * 2;
      const w1 = { x: B.x - dw.x * s2, y: B.y - dw.y * s2 };
      const up = Math.abs(dw.x) > 0.5 ? { x: 0, y: -1 } : { x: -1, y: 0 };
      if (shape === "output_low") {
        const tip = { x: B.x + up.x * s2, y: B.y + up.y * s2 };
        svg += `<path d="M${f(w1.x)} ${f(w1.y)}L${f(tip.x)} ${f(tip.y)}" stroke="${t.pin}" stroke-width="${sw}"/>`;
      } else {
        const w2 = { x: w1.x + up.x * s2, y: w1.y + up.y * s2 };
        svg += `<path d="M${f(w1.x)} ${f(w1.y)}L${f(w2.x)} ${f(w2.y)}L${f(B.x)} ${f(B.y)}" fill="none" stroke="${t.pin}" stroke-width="${sw}"/>`;
      }
    }
    if (shape === "non_logic") {
      const k = CLOCK_SIZE;
      svg += `<path d="M${f(A.x - k)} ${f(A.y - k)}L${f(A.x + k)} ${f(A.y + k)}M${f(A.x + k)} ${f(A.y - k)}L${f(A.x - k)} ${f(A.y + k)}" stroke="${t.pin}" stroke-width="${sw}"/>`;
    }

    const horizontal = Math.abs(dw.x) > 0.5;
    const angle = horizontal ? 0 : 90;
    const up = horizontal ? { x: 0, y: -1 } : { x: -1, y: 0 };
    const along = horizontal ? { x: 1, y: 0 } : { x: 0, y: -1 };
    const alongSign = dw.x * along.x + dw.y * along.y; // +1 when pin points along reading direction
    const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    const showNum = !lib.pinNumbersHidden && p.number !== "";
    const showName = !lib.pinNamesHidden && p.name !== "" && p.name !== "~";
    const gap = PIN_TEXT_GAP;

    if (lib.pinNamesOffset > 0) {
      if (showName) {
        const e = p.nameEffects;
        const o = lib.pinNamesOffset;
        const pos = { x: B.x + dw.x * o, y: B.y + dw.y * o };
        const h = alongSign > 0 ? "left" : "right";
        svg += stext({ text: p.name, x: pos.x, y: pos.y, angle, size: e.size, width: e.width, h, v: "center", bold: e.bold, italic: e.italic, color: t.pinName });
        this.textBounds(bboxOut, p.name, pos.x, pos.y, angle, e.size, h, "center", e.bold);
      }
      if (showNum) {
        const e = p.numberEffects;
        const pos = { x: mid.x + up.x * gap, y: mid.y + up.y * gap };
        svg += stext({ text: p.number, x: pos.x, y: pos.y, angle, size: e.size, width: e.width, h: "center", v: "bottom", color: t.pinNumber });
      }
    } else {
      if (showName) {
        const e = p.nameEffects;
        const pos = { x: mid.x + up.x * gap, y: mid.y + up.y * gap };
        svg += stext({ text: p.name, x: pos.x, y: pos.y, angle, size: e.size, width: e.width, h: "center", v: "bottom", bold: e.bold, italic: e.italic, color: t.pinName });
      }
      if (showNum) {
        const e = p.numberEffects;
        const pos = { x: mid.x - up.x * gap, y: mid.y - up.y * gap };
        svg += stext({ text: p.number, x: pos.x, y: pos.y, angle, size: e.size, width: e.width, h: "center", v: "top", color: t.pinNumber });
      }
    }
    return { svg, info };
  }

  textBounds(bbox, text, x, y, angle, size, h, v, bold) {
    if (!bbox) return;
    const { w, h: hh } = textBlockSize(plainText(text), size, bold);
    let x0 = h === "left" ? 0 : h === "right" ? -w : -w / 2;
    let y0 = v === "top" ? 0 : v === "bottom" ? -hh : -hh / 2;
    if (angle === 90) bbox.add(x + y0, y - x0).add(x + y0 + hh, y - x0 - w);
    else bbox.add(x + x0, y + y0).add(x + x0 + w, y + y0 + hh);
  }

  // ---- wires, buses, junctions ----

  wires() {
    const t = this.t;
    let out = "";
    for (const w of this.sch.wires) {
      if (w.pts.length < 2) continue;
      out += `<path class="wire" d="${polyD(w.pts)}" fill="none" ${this.strokeAttrs(w.stroke, t.wire)}/>`;
    }
    for (const b of this.sch.buses) {
      if (b.pts.length < 2) continue;
      out += `<path class="bus" d="${polyD(b.pts)}" fill="none" ${this.strokeAttrs(b.stroke, t.bus, BUS_LINE)}/>`;
    }
    for (const e of this.sch.busEntries) {
      out += `<path d="M${f(e.x)} ${f(e.y)}l${f(e.dx)} ${f(e.dy)}" ${this.strokeAttrs(e.stroke, t.wire)}/>`;
    }
    for (const j of this.sch.junctions) {
      const r = (j.diameter > 0 ? j.diameter : JUNCTION_DIAMETER) / 2;
      out += `<circle cx="${f(j.x)}" cy="${f(j.y)}" r="${f(r)}" fill="${j.color ? rgba(j.color) : t.junction}"/>`;
    }
    let nc = "";
    for (const n of this.sch.noConnects) {
      nc += `M${f(n.x - NC_HALF)} ${f(n.y - NC_HALF)}L${f(n.x + NC_HALF)} ${f(n.y + NC_HALF)}M${f(n.x + NC_HALF)} ${f(n.y - NC_HALF)}L${f(n.x - NC_HALF)} ${f(n.y + NC_HALF)}`;
    }
    if (nc) out += `<path d="${nc}" stroke="${t.noConnect}" stroke-width="${f(DEFAULT_LINE)}"/>`;
    return out;
  }

  // ---- labels ----

  label(l) {
    const t = this.t;
    const e = l.effects;
    const size = e.size;
    const dir = dirVec(l.angle); // direction the label body extends to
    const horizontal = Math.abs(dir.x) > 0.5;
    const angle = horizontal ? 0 : 90;
    const reading = horizontal ? { x: 1, y: 0 } : { x: 0, y: -1 };
    const forward = dir.x * reading.x + dir.y * reading.y > 0;
    const up = horizontal ? { x: 0, y: -1 } : { x: -1, y: 0 };
    const text = substitute(l.text, this.vars);
    let out = "";
    const bbox = new BBox().add(l.x, l.y);

    if (l.kind === "label") {
      const off = TEXT_OFFSET_RATIO * size + DEFAULT_LINE / 2;
      const x = l.x + up.x * off, y = l.y + up.y * off;
      out += stext({ text, x, y, angle, size, width: e.width, h: forward ? "left" : "right", v: "bottom", bold: e.bold, italic: e.italic, color: e.color ? rgba(e.color) : t.label });
      this.textBounds(bbox, text, x, y, angle, size, forward ? "left" : "right", "bottom", e.bold);
    } else if (l.kind === "global_label") {
      const margin = LABEL_BOX_RATIO * size;
      const half = size / 2 + margin;
      const tw = textWidth(plainText(text), size, e.bold);
      const tipNear = ["input", "bidirectional", "tri_state"].includes(l.shape);
      const tipFar = ["output", "bidirectional", "tri_state"].includes(l.shape);
      const s0 = tipNear ? half : 0;
      const s1 = s0 + tw + 2 * margin + (tipNear ? size * 0.25 : 0);
      const local = [];
      if (tipNear) local.push([0, 0]);
      local.push([s0, -half], [s1, -half]);
      if (tipFar) local.push([s1 + half, 0]);
      local.push([s1, half], [s0, half]);
      const pts = local.map(([a, b]) => {
        const pp = perpWorld(dir, b);
        return { x: l.x + dir.x * a + pp.x, y: l.y + dir.y * a + pp.y };
      });
      pts.forEach((p) => bbox.add(p.x, p.y));
      const color = e.color ? rgba(e.color) : t.globalLabel;
      out += `<path d="${polyD(pts)}Z" fill="none" stroke="${color}" stroke-width="${f(DEFAULT_LINE)}"/>`;
      const startOff = margin + (tipNear ? size * 0.75 : 0);
      const x = l.x + dir.x * startOff, y = l.y + dir.y * startOff;
      out += stext({ text, x, y, angle, size, width: e.width, h: forward ? "left" : "right", v: "center", bold: e.bold, italic: e.italic, color });
    } else if (l.kind === "hierarchical_label") {
      const color = e.color ? rgba(e.color) : t.hierLabel;
      out += this.hierShape(l.x, l.y, dir, l.shape, size, color, bbox);
      const off = size + TEXT_OFFSET_RATIO * size;
      const x = l.x + dir.x * off, y = l.y + dir.y * off;
      out += stext({ text, x, y, angle, size, width: e.width, h: forward ? "left" : "right", v: "center", bold: e.bold, italic: e.italic, color });
      this.textBounds(bbox, text, x, y, angle, size, forward ? "left" : "right", "center", e.bold);
    } else if (l.kind === "netclass_flag") {
      // Directive label: a stem perpendicular to the wire ending in a symbol.
      const color = e.color ? rgba(e.color) : t.netclassFlag;
      const stem = dirVec(l.angle + 90);
      const len = l.length || 2.54;
      const end = { x: l.x + stem.x * len, y: l.y + stem.y * len };
      out += `<path d="M${f(l.x)} ${f(l.y)}L${f(end.x)} ${f(end.y)}" stroke="${color}" stroke-width="${f(DEFAULT_LINE)}"/>`;
      const r = size * 0.4;
      const c = { x: end.x + stem.x * r, y: end.y + stem.y * r };
      if (l.shape === "dot") out += `<circle cx="${f(c.x)}" cy="${f(c.y)}" r="${f(r)}" fill="${color}"/>`;
      else if (l.shape === "round") out += `<circle cx="${f(c.x)}" cy="${f(c.y)}" r="${f(r)}" fill="none" stroke="${color}" stroke-width="${f(DEFAULT_LINE)}"/>`;
      else if (l.shape === "diamond") out += `<path d="M${f(c.x - r)} ${f(c.y)}L${f(c.x)} ${f(c.y - r)}L${f(c.x + r)} ${f(c.y)}L${f(c.x)} ${f(c.y + r)}Z" fill="none" stroke="${color}" stroke-width="${f(DEFAULT_LINE)}"/>`;
      else out += `<rect x="${f(c.x - r)}" y="${f(c.y - r)}" width="${f(2 * r)}" height="${f(2 * r)}" fill="none" stroke="${color}" stroke-width="${f(DEFAULT_LINE)}"/>`;
      bbox.add(end.x, end.y).add(c.x - r, c.y - r).add(c.x + r, c.y + r);
    }

    // Visible label properties (net class, intersheet references, ...).
    for (const p of l.properties) {
      if (p.hide) continue;
      let v = p.value;
      if (v.includes("${INTERSHEET_REFS}")) {
        const pages = this.opts.intersheetRefs?.get(l.text) ?? [];
        v = v.replace("${INTERSHEET_REFS}", pages.length ? `[${pages.join(",")}]` : "");
      }
      v = substitute(v, this.vars);
      if (!v) continue;
      const text2 = p.showName ? `${p.name}: ${v}` : v;
      const pa = ((p.angle % 180) + 180) % 180 === 90 ? 90 : 0;
      out += stext({ text: text2, x: p.x, y: p.y, angle: pa, size: p.effects.size, h: p.effects.h, v: p.effects.v, italic: p.effects.italic, color: t.fields });
    }

    this.items.push({ kind: "label", labelKind: l.kind, text, x: l.x, y: l.y, bbox: bbox.grow(0.3) });
    return `<g class="label" data-net="${escapeXml(text)}">${out}</g>`;
  }

  /** Hierarchical label / sheet pin glyph, `dir` pointing away from the anchor. */
  hierShape(x, y, dir, shape, size, color, bbox) {
    const h = size / 2;
    const templates = {
      input: [[0, 0], [1, -1], [2, -1], [2, 1], [1, 1]],
      output: [[2, 0], [1, 1], [0, 1], [0, -1], [1, -1]],
      bidirectional: [[0, 0], [1, -1], [2, 0], [1, 1]],
      tri_state: [[0, 0], [1, -1], [2, 0], [1, 1]],
      passive: [[0, -1], [2, -1], [2, 1], [0, 1]],
    };
    const tpl = templates[shape] ?? templates.passive;
    const pts = tpl.map(([a, b]) => {
      const pp = perpWorld(dir, b * h);
      return { x: x + dir.x * a * h + pp.x, y: y + dir.y * a * h + pp.y };
    });
    pts.forEach((p) => bbox?.add(p.x, p.y));
    return `<path d="${polyD(pts)}Z" fill="none" stroke="${color}" stroke-width="${f(DEFAULT_LINE)}"/>`;
  }

  // ---- sheets ----

  sheet(s) {
    const t = this.t;
    let out = "";
    const fill = s.fill?.color && s.fill.color.a > 0 ? rgba(s.fill.color) : t.sheetFill;
    out += `<rect x="${f(s.x)}" y="${f(s.y)}" width="${f(s.w)}" height="${f(s.h)}" fill="${fill}" ${this.strokeAttrs(s.stroke, t.sheet)}/>`;
    for (const p of s.properties) {
      if (p.hide) continue;
      let text = p.value;
      let color = t.fields;
      if (p.name === "Sheetname" || p.name === "Sheet name") {
        color = t.sheetName;
      } else if (p.name === "Sheetfile" || p.name === "Sheet file") {
        text = `File: ${text}`;
        color = t.sheetFile;
      } else if (p.showName) {
        text = `${p.name}: ${text}`;
      }
      const pa = ((p.angle % 180) + 180) % 180 === 90 ? 90 : 0;
      out += stext({ text, x: p.x, y: p.y, angle: pa, size: p.effects.size, width: p.effects.width, h: p.effects.h, v: p.effects.v, bold: p.effects.bold, italic: p.effects.italic, color });
    }
    for (const pin of s.pins) {
      // Pin angle points out of the sheet; the glyph and text sit inside.
      const out2 = dirVec(pin.angle);
      const dir = { x: -out2.x, y: -out2.y };
      const swapped = pin.shape === "input" ? "output" : pin.shape === "output" ? "input" : pin.shape;
      const size = pin.effects.size;
      out += this.hierShape(pin.x, pin.y, dir, swapped, size, t.sheetLabel, null);
      const horizontal = Math.abs(dir.x) > 0.5;
      const reading = horizontal ? { x: 1, y: 0 } : { x: 0, y: -1 };
      const forward = dir.x * reading.x + dir.y * reading.y > 0;
      const off = size + TEXT_OFFSET_RATIO * size;
      out += stext({ text: pin.name, x: pin.x + dir.x * off, y: pin.y + dir.y * off, angle: horizontal ? 0 : 90, size, width: pin.effects.width, h: forward ? "left" : "right", v: "center", color: t.sheetLabel });
    }
    const bbox = new BBox().add(s.x, s.y).add(s.x + s.w, s.y + s.h);
    this.items.push({ kind: "sheet", uuid: s.uuid, name: s.name, file: s.file, bbox, pins: s.pins.map((p) => p.name) });
    return `<g class="sheet" data-uuid="${escapeXml(s.uuid)}">${out}</g>`;
  }

  // ---- text ----

  note(tx) {
    const e = tx.effects;
    const a = ((tx.angle % 180) + 180) % 180 === 90 ? 90 : 0;
    const text = substitute(tx.text, this.vars);
    return stext({ text, x: tx.x, y: tx.y, angle: a, size: e.size, width: e.width, h: e.h, v: e.v, bold: e.bold, italic: e.italic, color: e.color ? rgba(e.color) : this.t.notes, lineSpacing: e.lineSpacing });
  }

  textBox(tb, color) {
    const e = tb.effects;
    let out = "";
    const fill = tb.fill?.type === "color" && tb.fill.color ? rgba(tb.fill.color) : tb.fill?.type === "background" ? this.t.bodyFill : "none";
    const hasBorder = tb.stroke && tb.stroke.width >= 0 && tb.stroke.type !== "none";
    out += `<rect x="${f(tb.x)}" y="${f(tb.y)}" width="${f(tb.w)}" height="${f(tb.h)}" fill="${fill}" ${hasBorder ? this.strokeAttrs(tb.stroke, color) : 'stroke="none"'}/>`;
    const m = tb.margins ?? [e.size * 0.6, e.size * 0.6, e.size * 0.6, e.size * 0.6];
    const h = e.h === "center" ? "center" : e.h;
    const v = e.v === "center" ? "center" : e.v;
    let x = h === "left" ? tb.x + m[0] : h === "right" ? tb.x + tb.w - m[2] : tb.x + tb.w / 2;
    let y = v === "top" || v === "center" ? tb.y + m[1] : tb.y + tb.h - m[3];
    let vv = v === "center" ? "top" : v;
    if (e.v === "center") {
      y = tb.y + tb.h / 2;
      vv = "center";
    }
    if (tb.angle === 90) {
      // Vertical text boxes read bottom-to-top.
      x = tb.x + tb.w / 2;
      y = tb.y + tb.h - m[3];
      out += stext({ text: substitute(tb.text, this.vars), x, y, angle: 90, size: e.size, width: e.width, h: "left", v: "center", bold: e.bold, italic: e.italic, color: e.color ? rgba(e.color) : color });
      return `<g class="text-box">${out}</g>`;
    }
    out += stext({ text: wrapText(substitute(tb.text, this.vars), tb.w - m[0] - m[2], e.size, e.bold), x, y, size: e.size, width: e.width, h, v: vv, bold: e.bold, italic: e.italic, color: e.color ? rgba(e.color) : color, lineSpacing: e.lineSpacing });
    return `<g class="text-box">${out}</g>`;
  }

  table(tbl) {
    let out = "";
    for (const c of tbl.cells) out += this.textBox({ ...c, stroke: tbl.border?.width ? tbl.border : { width: DEFAULT_LINE, type: "solid" } }, this.t.notes);
    return `<g class="table">${out}</g>`;
  }

  image(img) {
    const info = pngInfo(img.data);
    if (!info) return "";
    const ppi = info.ppi || 300;
    const w = (info.width / ppi) * 25.4 * img.scale;
    const h = (info.height / ppi) * 25.4 * img.scale;
    return `<image x="${f(img.x - w / 2)}" y="${f(img.y - h / 2)}" width="${f(w)}" height="${f(h)}" href="data:${info.mime};base64,${img.data}" preserveAspectRatio="none"/>`;
  }
}

// ---- helpers --------------------------------------------------------------

function polyD(pts) {
  let d = "";
  for (let i = 0; i < pts.length; i++) d += `${i ? "L" : "M"}${f(pts[i].x)} ${f(pts[i].y)}`;
  return d;
}

function dirVec(angle) {
  const a = ((Math.round(angle) % 360) + 360) % 360;
  if (a === 0) return { x: 1, y: 0 };
  if (a === 90) return { x: 0, y: -1 };
  if (a === 180) return { x: -1, y: 0 };
  if (a === 270) return { x: 0, y: 1 };
  const r = (a * Math.PI) / 180;
  return { x: Math.cos(r), y: -Math.sin(r) };
}

/** Offset `b` perpendicular to `dir` (positive = screen-down for horizontal dir). */
function perpWorld(dir, b) {
  return { x: -dir.y * b, y: dir.x * b };
}

function flipH(h) {
  return h === "left" ? "right" : h === "right" ? "left" : h;
}
function flipV(v) {
  return v === "top" ? "bottom" : v === "bottom" ? "top" : v;
}

export function unitLetter(unit) {
  // 1 → A, 26 → Z, 27 → AA ...
  let s = "";
  let n = unit;
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

export function rgba(c) {
  if (!c) return "none";
  return c.a >= 1 ? `rgb(${c.r},${c.g},${c.b})` : `rgba(${c.r},${c.g},${c.b},${c.a})`;
}

function wrapText(text, width, size, bold) {
  if (width <= 0) return text;
  const out = [];
  for (const para of text.split("\n")) {
    const words = para.split(" ");
    let line = "";
    for (const w of words) {
      const cand = line ? line + " " + w : w;
      if (line && textWidth(plainText(cand), size, bold) > width) {
        out.push(line);
        line = w;
      } else line = cand;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Width/height/ppi from a base64 PNG or JPEG header. */
function pngInfo(b64) {
  try {
    const head = atobBytes(b64.slice(0, 4000));
    if (head[0] === 0x89 && head[1] === 0x50) {
      const dv = new DataView(head.buffer);
      const width = dv.getUint32(16), height = dv.getUint32(20);
      let ppi = 0;
      // Look for pHYs chunk among the first chunks.
      let off = 8;
      while (off + 8 < head.length) {
        const len = dv.getUint32(off);
        const type = String.fromCharCode(head[off + 4], head[off + 5], head[off + 6], head[off + 7]);
        if (type === "pHYs" && off + 17 <= head.length) {
          const ppm = dv.getUint32(off + 8);
          if (head[off + 16] === 1 && ppm) ppi = ppm * 0.0254;
          break;
        }
        if (type === "IDAT") break;
        off += 12 + len;
      }
      return { width, height, ppi, mime: "image/png" };
    }
    if (head[0] === 0xff && head[1] === 0xd8) {
      // JPEG: scan for SOF0/2 marker.
      let i = 2;
      while (i < head.length) {
        if (head[i] !== 0xff) break;
        const marker = head[i + 1];
        const len = (head[i + 2] << 8) | head[i + 3];
        if (marker === 0xc0 || marker === 0xc2) return { height: (head[i + 5] << 8) | head[i + 6], width: (head[i + 7] << 8) | head[i + 8], ppi: 0, mime: "image/jpeg" };
        i += 2 + len;
      }
    }
  } catch {
    /* unreadable image */
  }
  return null;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function atobBytes(s) {
  s = s.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i + 3 < s.length; i += 4) {
    const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | (B64.indexOf(s[i + 2]) << 6) | B64.indexOf(s[i + 3]);
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  return out;
}
