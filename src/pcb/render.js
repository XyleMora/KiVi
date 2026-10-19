// Board → SVG renderer.
//
// Every layer is rendered into its own <g data-layer="..."> so the viewer can
// toggle layers without re-rendering. Copper is grouped per net
// (data-net="<index>") which makes net highlighting a class toggle.

import { BBox, f, escapeXml } from "../geom.js";
import { svgText, readable, FONT_FAMILY } from "../text.js";
import { onLayer, copperOrder, viaLayers } from "./model.js";
import { padShape, drillPath, shapePath, polyD, trackPath, circlePath, arcBounds } from "./shapes.js";
import { PCB_THEMES, layerOpacity } from "./theme.js";

const BACK_TECH = ["B.CrtYd", "B.Fab", "B.Adhes", "B.Paste", "B.SilkS", "B.Mask"];
const FRONT_TECH = ["F.Mask", "F.Paste", "F.Adhes", "F.SilkS", "F.Fab", "F.CrtYd"];
const USER = ["Dwgs.User", "Cmts.User", "Eco1.User", "Eco2.User"];

export const DEFAULT_VISIBLE = (name) => name === "F.Cu" || name === "B.Cu" || name.endsWith(".SilkS") || name === "Edge.Cuts" || name === "Dwgs.User" || name === "Cmts.User";

/** Layer names bottom → top as seen from `side`. */
export function drawOrder(pcb, side = "front") {
  const present = new Set(pcb.layers.map((l) => l.name));
  present.add("Edge.Cuts");
  const cu = copperOrder(pcb); // front → back
  const userN = pcb.layers.map((l) => l.name).filter((n) => /^User\.\d+$/.test(n));
  let order;
  if (side === "back") order = [...FRONT_TECH.slice().reverse(), ...cu, ...BACK_TECH.slice().reverse()];
  else order = [...BACK_TECH, ...cu.slice().reverse(), ...FRONT_TECH];
  order = order.concat(USER, userN, ["Margin", "Edge.Cuts"]);
  return order.filter((n, i) => present.has(n) && order.indexOf(n) === i);
}

/** Bounding box of the board outline (Edge.Cuts), falling back to all items. */
export function boardBBox(pcb) {
  const b = new BBox();
  const addShape = (g) => {
    if (g.kind === "line") b.add(g.start.x, g.start.y).add(g.end.x, g.end.y);
    else if (g.kind === "arc") arcBounds(g.start, g.mid, g.end, b);
    else if (g.kind === "circle") b.add(g.center.x - g.r, g.center.y - g.r).add(g.center.x + g.r, g.center.y + g.r);
    else if (g.kind === "poly" || g.kind === "curve") for (const p of g.pts) p.arc ? b.add(p.start.x, p.start.y).add(p.end.x, p.end.y) : b.add(p.x, p.y);
  };
  for (const g of pcb.drawings) if (g.layer === "Edge.Cuts") addShape(g);
  for (const fp of pcb.footprints) for (const g of fp.graphics) if (g.layer === "Edge.Cuts") addShape(g);
  if (b.empty) {
    for (const t of pcb.tracks) b.add(t.start.x, t.start.y).add(t.end.x, t.end.y);
    for (const fp of pcb.footprints) for (const p of fp.pads) b.add(p.x, p.y);
    for (const g of pcb.drawings) if (g.kind !== "text") addShape(g);
  }
  if (b.empty) b.add(0, 0).add(100, 100);
  return b;
}

/**
 * @param {object} pcb
 * @param {object} [opts]
 * @param {"front"|"back"} [opts.side]
 * @param {string[]} [opts.layers]  initially visible layers (others rendered hidden)
 * @param {string|object} [opts.theme]
 */
export function renderPcb(pcb, opts = {}) {
  const theme = typeof opts.theme === "object" ? opts.theme : PCB_THEMES[opts.theme ?? "kicad"] ?? PCB_THEMES.kicad;
  const side = opts.side ?? "front";
  const visible = opts.layers ? new Set(opts.layers) : null;
  const order = drawOrder(pcb, side);

  // Net index for compact data attributes.
  const nets = [""];
  const netIndex = new Map([["", 0]]);
  const ni = (name) => {
    if (!name) return 0;
    let i = netIndex.get(name);
    if (i === undefined) {
      i = nets.length;
      nets.push(name);
      netIndex.set(name, i);
    }
    return i;
  };

  // Bucket items per layer once.
  const perLayer = new Map(order.map((l) => [l, { zones: [], shapes: [], texts: [], tracks: new Map(), pads: new Map() }]));
  const bucket = (l) => perLayer.get(l);

  for (const z of pcb.zones) {
    if (z.keepout) {
      for (const l of z.layers) for (const o of z.outline) bucket(l)?.shapes.push({ kind: "poly", pts: o, width: 0.1, dashed: true });
      continue;
    }
    for (const fp of z.filled) bucket(fp.layer)?.zones.push({ d: polyD(fp.pts) + "Z", net: ni(z.net) });
  }
  for (const g of pcb.drawings) {
    if (g.kind === "text" || g.kind === "textbox") bucket(g.layer)?.texts.push({ t: g, fp: null });
    else bucket(g.layer)?.shapes.push(g);
  }
  const fpItems = [];
  for (const fp of pcb.footprints) {
    const fb = new BBox();
    for (const g of fp.graphics) {
      bucket(g.layer)?.shapes.push(g);
      if (g.layer.endsWith("CrtYd")) addShapeBounds(g, fb);
    }
    for (const t of fp.texts) if (!t.hide && t.text) bucket(t.layer)?.texts.push({ t, fp });
    const pb = new BBox();
    for (const p of fp.pads) {
      const r = Math.max(p.w, p.h) / 2;
      pb.add(p.x - r, p.y - r).add(p.x + r, p.y + r);
      const n = ni(p.net);
      for (const l of order) {
        if (!onLayer(p.layers, l)) continue;
        // Unconnected inner layers of through-hole pads may be removed.
        if (p.removeUnusedLayers && /^In\d+\.Cu$/.test(l) && !p.net) continue;
        const b = bucket(l);
        if (!b.pads.has(n)) b.pads.set(n, []);
        b.pads.get(n).push(p);
      }
    }
    if (fb.empty) fb.addBox(pb);
    if (fb.empty) fb.add(fp.x - 1, fp.y - 1).add(fp.x + 1, fp.y + 1);
    fpItems.push({ kind: "footprint", fp, reference: fp.reference, value: fp.value, bbox: fb, side: fp.side });
  }
  for (const t of pcb.tracks) {
    const b = bucket(t.layer);
    if (!b) continue;
    const n = ni(t.net);
    let byWidth = b.tracks.get(n);
    if (!byWidth) b.tracks.set(n, (byWidth = new Map()));
    const k = f(t.width);
    byWidth.set(k, (byWidth.get(k) ?? "") + trackPath(t));
  }

  // ---- emit ----
  let out = "";
  for (const l of order) {
    const b = bucket(l);
    const color = theme.layer(l);
    const isCu = l.endsWith(".Cu");
    let body = "";
    // Zones: one path per net.
    const zoneByNet = new Map();
    for (const z of b.zones) zoneByNet.set(z.net, (zoneByNet.get(z.net) ?? "") + z.d);
    for (const [n, d] of zoneByNet) body += `<path d="${d}" data-net="${n}" fill-rule="evenodd" class="zone"/>`;
    for (const [n, byWidth] of b.tracks) {
      for (const [w, d] of byWidth) body += `<path d="${d}" data-net="${n}" fill="none" stroke-width="${w}" class="track"/>`;
    }
    for (const [n, pads] of b.pads) {
      let fill = "";
      let strokes = "";
      for (const p of pads) {
        const s = padShape(p, isCu ? 0 : l.endsWith(".Mask") ? 0.05 : 0);
        fill += s.fill;
        for (const st of s.strokes) strokes += `<path d="${st.d}" fill="none" stroke-width="${f(st.width)}"/>`;
      }
      body += `<g data-net="${n}" class="pads"><path d="${fill}" stroke="none"/>${strokes}</g>`;
    }
    let shapeD = new Map();
    let fills = "";
    for (const g of b.shapes) {
      const s = shapePath(g);
      if (!s) continue;
      if (s.fill) fills += s.fill;
      if (s.stroke) {
        const w = g.width > 0 ? g.width : s.fill ? 0 : 0.1;
        if (!w) continue;
        const k = f(w) + (g.dashed ? "d" : "");
        shapeD.set(k, (shapeD.get(k) ?? "") + s.stroke);
      }
    }
    if (fills) body += `<path d="${fills}" stroke="none"/>`;
    for (const [k, d] of shapeD) {
      const dashed = k.endsWith("d");
      body += `<path d="${d}" fill="none" stroke-width="${dashed ? k.slice(0, -1) : k}"${dashed ? ' stroke-dasharray="0.5 0.5"' : ""}/>`;
    }
    for (const { t, fp } of b.texts) body += pcbText(t, fp, color);
    if (!body) continue;
    const hidden = visible ? !visible.has(l) : !DEFAULT_VISIBLE(l);
    out += `<g data-layer="${escapeXml(l)}" fill="${color}" stroke="${color}" opacity="${layerOpacity(l)}"${hidden ? ' display="none"' : ""}>${body}</g>`;
  }

  // Vias and holes sit above all layers.
  let vias = "";
  const viaByNet = new Map();
  for (const v of pcb.vias) {
    const n = ni(v.net);
    viaByNet.set(n, (viaByNet.get(n) ?? "") + circlePath(v.x, v.y, v.size / 2));
  }
  for (const [n, d] of viaByNet) vias += `<path d="${d}" data-net="${n}"/>`;
  let holes = "";
  let npHoles = "";
  for (const v of pcb.vias) holes += circlePath(v.x, v.y, v.drill / 2);
  for (const fp of pcb.footprints) {
    for (const p of fp.pads) {
      if (!p.drill) continue;
      if (p.type === "np_thru_hole") npHoles += drillPath(p);
      else holes += drillPath(p);
    }
  }
  const viaVisible = !visible || order.some((l) => l.endsWith(".Cu") && visible.has(l));
  out += `<g data-layer="Vias" fill="${theme.via}" opacity="0.9"${viaVisible ? "" : ' display="none"'}>${vias}</g>`;
  out += `<g data-layer="Holes"><path d="${holes}" fill="${theme.hole}"/><path d="${npHoles}" fill="${theme.npHole}"/></g>`;

  const outline = boardBBox(pcb);
  const bb = new BBox().addBox(outline).grow(Math.max(2, 0.04 * Math.max(outline.w, outline.h)));
  const cx = (bb.x0 + bb.x1) / 2;
  const flip = side === "back" ? ` transform="translate(${f(2 * cx)} 0) scale(-1 1)"` : "";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(bb.x0)} ${f(bb.y0)} ${f(bb.w)} ${f(bb.h)}" width="${f(bb.w)}mm" height="${f(bb.h)}mm" ` +
    `font-family="${escapeXml(FONT_FAMILY)}" stroke-linecap="round" stroke-linejoin="round">` +
    `<rect x="${f(bb.x0)}" y="${f(bb.y0)}" width="${f(bb.w)}" height="${f(bb.h)}" fill="${theme.background}"/>` +
    `<g class="board"${flip}>${out}</g></svg>`;
  return { svg, bbox: bb, order, nets, netIndex, items: fpItems, side, center: cx };
}

function addShapeBounds(g, b) {
  if (g.kind === "line") b.add(g.start.x, g.start.y).add(g.end.x, g.end.y);
  else if (g.kind === "arc") arcBounds(g.start, g.mid, g.end, b);
  else if (g.kind === "circle") b.add(g.center.x - g.r, g.center.y - g.r).add(g.center.x + g.r, g.center.y + g.r);
  else if (g.kind === "poly") for (const p of g.pts) p.arc ? b.add(p.start.x, p.start.y).add(p.end.x, p.end.y) : b.add(p.x, p.y);
}

function pcbText(t, fp, color) {
  const e = t.effects;
  if (t.kind === "textbox") {
    let d = polyD(t.pts) + "Z";
    const xs = t.pts.map((p) => p.x), ys = t.pts.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const border = t.border && t.width > 0 ? `<path d="${d}" fill="none" stroke-width="${f(t.width)}"/>` : "";
    return border + svgText({ text: t.text, x: cx, y: cy, angle: t.angle, size: e.size, width: e.width, h: "center", v: "center", mirror: e.mirror, bold: e.bold, italic: e.italic, color, penWidth: e.thickness });
  }
  let angle = t.angle, h = e.h, v = e.v;
  // Footprint text stays readable like in pcbnew.
  if (fp) ({ angle, h, v } = readable(angle, h, v));
  return svgText({ text: t.text, x: t.x, y: t.y, angle, size: e.size, width: e.width, h, v, mirror: e.mirror, bold: e.bold, italic: e.italic, color, penWidth: e.thickness });
}
