// Realistic board-face artwork (soldermask, exposed copper, silkscreen) as
// SVG. Used as the texture for the 3D view; also handy as a "photo" view.

import { f } from "../geom.js";
import { svgText, readable, FONT_FAMILY } from "../text.js";
import { onLayer } from "./model.js";
import { padShape, drillPath, shapePath, polyD, trackPath, circlePath } from "./shapes.js";
import { boardBBox } from "./render.js";

const MASK_COLORS = {
  green: "#1E5631",
  red: "#8E1B1B",
  blue: "#1D3E7A",
  black: "#141414",
  white: "#E8E8E2",
  yellow: "#C8B21E",
  purple: "#4C2770",
  matte_green: "#2B5A3A",
  matte_black: "#1C1C1C",
};

function namedColor(name, table, fallback) {
  if (!name) return fallback;
  const s = String(name);
  if (s.startsWith("#")) return s.length === 9 ? s.slice(0, 7) : s;
  return table[s.toLowerCase().replace(/[\s-]+/g, "_")] ?? fallback;
}

/** Colours for the realistic rendering, derived from the board stackup. */
export function boardAppearance(pcb, side = "front") {
  const p = side === "back" ? "B." : "F.";
  const mask = pcb.stackup.find((l) => l.name === `${p}Mask`);
  const silk = pcb.stackup.find((l) => l.name === `${p}SilkS`);
  const finish = (pcb.finish ?? "ENIG").toLowerCase();
  const maskColor = namedColor(mask?.color, MASK_COLORS, "#1E5631");
  return {
    mask: maskColor,
    copperUnderMask: mix(maskColor, "#9FD39F", 0.22),
    finish: finish.includes("hal") || finish.includes("tin") || finish.includes("silver") ? "#C9CBCD" : finish === "none" || finish.includes("osp") ? "#C87533" : "#D4AF37",
    silk: namedColor(silk?.color, { white: "#F4F4F0", black: "#111111", yellow: "#E8D44D" }, "#F4F4F0"),
    substrate: "#B79B5B",
    hole: "#1B1B1B",
  };
}

function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (v, s) => (v >> s) & 255;
  const m = (s) => Math.round(ch(pa, s) * (1 - t) + ch(pb, s) * t);
  return `#${[m(16), m(8), m(0)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * SVG artwork of one board face in board coordinates (not mirrored).
 * @returns {{svg: string, bbox: import("../geom.js").BBox}}
 */
export function boardFaceSvg(pcb, side = "front", bbox = boardBBox(pcb)) {
  const c = boardAppearance(pcb, side);
  const P = side === "back" ? "B." : "F.";
  const cu = `${P}Cu`, maskL = `${P}Mask`, silkL = `${P}SilkS`;

  let copperFill = "", copperStrokes = new Map(), openings = "", silkFill = "", silkStrokes = new Map(), silkText = "", holes = "";
  const addStroke = (map, w, d) => map.set(f(w), (map.get(f(w)) ?? "") + d);

  for (const z of pcb.zones) {
    if (z.keepout) continue;
    for (const fp of z.filled) if (fp.layer === cu) copperFill += polyD(fp.pts) + "Z";
  }
  for (const t of pcb.tracks) if (t.layer === cu) addStroke(copperStrokes, t.width, trackPath(t));
  for (const v of pcb.vias) copperFill += circlePath(v.x, v.y, v.size / 2);

  const shapes = (list, layer, fillOut, strokeMap) => {
    let fill = "";
    for (const g of list) {
      if (g.layer !== layer || g.kind === "text" || g.kind === "textbox") continue;
      const s = shapePath(g);
      if (!s) continue;
      if (s.fill) fill += s.fill;
      if (s.stroke && g.width > 0) addStroke(strokeMap, g.width, s.stroke);
    }
    return fillOut + fill;
  };
  const maskStrokes = new Map();
  for (const src of [pcb.drawings, ...pcb.footprints.map((fp) => fp.graphics)]) {
    copperFill = shapes(src, cu, copperFill, copperStrokes);
    openings = shapes(src, maskL, openings, maskStrokes);
    silkFill = shapes(src, silkL, silkFill, silkStrokes);
  }

  for (const fp of pcb.footprints) {
    for (const p of fp.pads) {
      if (onLayer(p.layers, cu)) {
        const s = padShape(p);
        copperFill += s.fill;
        for (const st of s.strokes) addStroke(copperStrokes, st.width, st.d);
      }
      if (onLayer(p.layers, maskL)) {
        const s = padShape(p, 0.05);
        openings += s.fill;
        for (const st of s.strokes) addStroke(maskStrokes, st.width, st.d);
      }
      if (p.drill) holes += drillPath(p);
    }
    for (const t of fp.texts) {
      if (t.hide || !t.text || t.layer !== silkL) continue;
      const r = readable(t.angle, t.effects.h, t.effects.v);
      silkText += svgText({ text: t.text, x: t.x, y: t.y, angle: r.angle, h: r.h, v: r.v, size: t.effects.size, width: t.effects.width, mirror: t.effects.mirror, bold: t.effects.bold, color: c.silk, penWidth: t.effects.thickness });
    }
  }
  for (const t of pcb.drawings) {
    if (t.kind === "text" && t.layer === silkL && !t.hide) {
      silkText += svgText({ text: t.text, x: t.x, y: t.y, angle: t.angle, h: t.effects.h, v: t.effects.v, size: t.effects.size, width: t.effects.width, mirror: t.effects.mirror, bold: t.effects.bold, color: c.silk, penWidth: t.effects.thickness });
    }
  }
  for (const v of pcb.vias) holes += circlePath(v.x, v.y, v.drill / 2);

  const strokesSvg = (map, color) => [...map].map(([w, d]) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}"/>`).join("");
  const W = bbox.w, H = bbox.h;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(bbox.x0)} ${f(bbox.y0)} ${f(W)} ${f(H)}" width="${f(W)}mm" height="${f(H)}mm" font-family="${FONT_FAMILY}" stroke-linecap="round" stroke-linejoin="round">` +
    `<rect x="${f(bbox.x0)}" y="${f(bbox.y0)}" width="${f(W)}" height="${f(H)}" fill="${c.mask}"/>` +
    `<g fill="${c.copperUnderMask}"><path d="${copperFill}" fill-rule="nonzero"/>${strokesSvg(copperStrokes, c.copperUnderMask)}</g>` +
    `<g fill="${c.finish}"><path d="${openings}"/>${strokesSvg(maskStrokes, c.finish)}</g>` +
    `<g fill="${c.silk}"><path d="${silkFill}"/>${strokesSvg(silkStrokes, c.silk)}${silkText}</g>` +
    `<path d="${holes}" fill="${c.hole}"/>` +
    `</svg>`;
  return { svg, bbox, colors: c };
}

/**
 * Translucent overlay for one face that dims the board and paints `net`'s
 * copper: the face's own layer bright, other copper layers fainter ("x-ray"),
 * plus pads and vias that reach the face.
 */
export function netOverlaySvg(pcb, side, net, bbox = boardBBox(pcb)) {
  const outer = side === "back" ? "B.Cu" : "F.Cu";
  const glow = "#FFB000";
  const strong = { fill: "", strokes: new Map() };
  const faint = { fill: "", strokes: new Map() };
  const addStroke = (dst, w, d) => dst.strokes.set(f(w), (dst.strokes.get(f(w)) ?? "") + d);
  // Everything not on this face shows through faintly: inner layers and the opposite face.
  const isInner = (l) => l.endsWith(".Cu") && l !== outer;

  for (const z of pcb.zones) {
    if (z.keepout || z.net !== net) continue;
    for (const fp of z.filled) {
      if (fp.layer === outer) strong.fill += polyD(fp.pts) + "Z";
      else if (isInner(fp.layer)) faint.fill += polyD(fp.pts) + "Z";
    }
  }
  for (const t of pcb.tracks) {
    if (t.net !== net) continue;
    if (t.layer === outer) addStroke(strong, t.width, trackPath(t));
    else if (isInner(t.layer)) addStroke(faint, t.width, trackPath(t));
  }
  for (const v of pcb.vias) if (v.net === net) strong.fill += circlePath(v.x, v.y, v.size / 2);
  for (const fp of pcb.footprints) {
    for (const p of fp.pads) {
      if (p.net !== net || !onLayer(p.layers, outer)) continue;
      const s = padShape(p);
      strong.fill += s.fill;
      for (const st of s.strokes) addStroke(strong, st.width, st.d);
    }
  }
  const group = (g, opacity) =>
    `<g fill="${glow}" opacity="${opacity}"><path d="${g.fill}"/>${[...g.strokes].map(([w, d]) => `<path d="${d}" fill="none" stroke="${glow}" stroke-width="${w}"/>`).join("")}</g>`;
  const W = bbox.w, H = bbox.h;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(bbox.x0)} ${f(bbox.y0)} ${f(W)} ${f(H)}" width="${f(W)}mm" height="${f(H)}mm" stroke-linecap="round" stroke-linejoin="round">` +
    `<rect x="${f(bbox.x0)}" y="${f(bbox.y0)}" width="${f(W)}" height="${f(H)}" fill="#000" fill-opacity="0.5"/>` +
    group(faint, 0.45) +
    group(strong, 0.95) +
    `</svg>`
  );
}
