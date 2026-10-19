// PCB shape → SVG path data. The same strings feed Path2D for canvas
// textures in the 3D view, so everything here is plain path syntax.

import { multiply, rotate, translate, apply, f, svgArcTo, arcFrom3 } from "../geom.js";

function pathFromPoints(pts, close = true) {
  let d = "";
  for (let i = 0; i < pts.length; i++) d += `${i ? "L" : "M"}${f(pts[i].x)} ${f(pts[i].y)}`;
  return close ? d + "Z" : d;
}

/** Circle as two arcs (path form so it can be merged with other shapes). */
export function circlePath(cx, cy, r) {
  return `M${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 0 ${f(cx + r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 0 ${f(cx - r)} ${f(cy)}Z`;
}

/** Rounded rectangle centred at origin, transformed by m. */
function roundRectPath(m, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const x0 = -w / 2, x1 = w / 2, y0 = -h / 2, y1 = h / 2;
  if (r < 1e-6) return pathFromPoints([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }].map((p) => apply(m, p.x, p.y)));
  // Corners as arcs; sweep direction depends on whether m mirrors.
  const P = (x, y) => apply(m, x, y);
  const k = 1 - Math.SQRT1_2;
  const seg = [];
  const arc = (sx, sy, mx, my, ex, ey) => {
    const s = P(sx, sy), mm = P(mx, my), e = P(ex, ey);
    seg.push(svgArcTo(s, mm, e));
  };
  const start = P(x0 + r, y0);
  let d = `M${f(start.x)} ${f(start.y)}`;
  const L = (x, y) => {
    const p = P(x, y);
    return `L${f(p.x)} ${f(p.y)}`;
  };
  d += L(x1 - r, y0);
  arc(x1 - r, y0, x1 - r * k, y0 + r * k, x1, y0 + r);
  d += seg.pop() + L(x1, y1 - r);
  arc(x1, y1 - r, x1 - r * k, y1 - r * k, x1 - r, y1);
  d += seg.pop() + L(x0 + r, y1);
  arc(x0 + r, y1, x0 + r * k, y1 - r * k, x0, y1 - r);
  d += seg.pop() + L(x0, y0 + r);
  arc(x0, y0 + r, x0 + r * k, y0 + r * k, x0 + r, y0);
  d += seg.pop() + "Z";
  return d;
}

/**
 * Pad copper outline(s).
 * @param {object} pad
 * @param {number} [expand] outward offset (mask/paste margins)
 * @returns {{fill: string, strokes: {d: string, width: number}[]}}
 */
export function padShape(pad, expand = 0) {
  const m = multiply(translate(pad.x, pad.y), rotate(pad.angle));
  const w = Math.max(0, pad.w + 2 * expand), h = Math.max(0, pad.h + 2 * expand);
  const strokes = [];
  let fill = "";
  switch (pad.shape) {
    case "circle":
      fill = circlePath(pad.x, pad.y, w / 2);
      break;
    case "oval":
      fill = roundRectPath(m, w, h, Math.min(w, h) / 2);
      break;
    case "roundrect":
      if (pad.chamferRatio > 0 && pad.chamfer.length) fill = chamferPath(m, w, h, pad);
      else fill = roundRectPath(m, w, h, pad.roundrectRatio * Math.min(pad.w, pad.h) + expand);
      break;
    case "chamfered_rect":
      fill = chamferPath(m, w, h, pad);
      break;
    case "trapezoid": {
      const hx = w / 2, hy = h / 2, dx = pad.delta.x / 2, dy = pad.delta.y / 2;
      const pts = [
        { x: -hx - dy, y: hy + dx },
        { x: -hx + dy, y: -hy - dx },
        { x: hx - dy, y: -hy + dx },
        { x: hx + dy, y: hy - dx },
      ].map((p) => apply(m, p.x, p.y));
      fill = pathFromPoints(pts);
      break;
    }
    case "custom": {
      // Anchor pad plus primitives in the pad's frame.
      if (pad.anchor === "circle") fill = circlePath(pad.x, pad.y, w / 2);
      else fill = roundRectPath(m, w, h, 0);
      for (const g of pad.primitives) {
        const s = shapePath(g, m);
        if (!s) continue;
        if (s.fill) fill += s.fill;
        if (s.stroke) strokes.push({ d: s.stroke, width: (g.width || 0) + 2 * expand });
        else if (expand > 0 && s.fill) strokes.push({ d: s.fill, width: 2 * expand });
      }
      break;
    }
    default:
      fill = roundRectPath(m, w, h, 0);
  }
  return { fill, strokes };
}

function chamferPath(m, w, h, pad) {
  const c = pad.chamferRatio * Math.min(pad.w, pad.h);
  const has = (k) => pad.chamfer.includes(k);
  const x0 = -w / 2, x1 = w / 2, y0 = -h / 2, y1 = h / 2;
  const pts = [];
  if (has("top_left")) pts.push({ x: x0, y: y0 + c }, { x: x0 + c, y: y0 });
  else pts.push({ x: x0, y: y0 });
  if (has("top_right")) pts.push({ x: x1 - c, y: y0 }, { x: x1, y: y0 + c });
  else pts.push({ x: x1, y: y0 });
  if (has("bottom_right")) pts.push({ x: x1, y: y1 - c }, { x: x1 - c, y: y1 });
  else pts.push({ x: x1, y: y1 });
  if (has("bottom_left")) pts.push({ x: x0 + c, y: y1 }, { x: x0, y: y1 - c });
  else pts.push({ x: x0, y: y1 });
  return pathFromPoints(pts.map((p) => apply(m, p.x, p.y)));
}

/** Drill hole outline (circle or slot), including drill offset. */
export function drillPath(pad) {
  const d = pad.drill;
  if (!d) return "";
  const m = multiply(translate(pad.x, pad.y), rotate(pad.angle));
  const c = apply(m, d.offset.x, d.offset.y);
  if (!d.oval || Math.abs(d.w - d.h) < 1e-6) return circlePath(c.x, c.y, Math.min(d.w, d.h) / 2);
  const m2 = multiply(translate(c.x, c.y), rotate(pad.angle));
  return roundRectPath(m2, d.w, d.h, Math.min(d.w, d.h) / 2);
}

/**
 * Generic shape (line/arc/circle/poly/curve) → {stroke?: d, fill?: d}.
 * `m` optionally transforms coordinates (pad primitives).
 */
export function shapePath(g, m = null) {
  const P = m ? (p) => apply(m, p.x, p.y) : (p) => p;
  switch (g.kind) {
    case "line": {
      const a = P(g.start), b = P(g.end);
      return { stroke: `M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}` };
    }
    case "arc": {
      const a = P(g.start), mid = P(g.mid), b = P(g.end);
      return { stroke: `M${f(a.x)} ${f(a.y)}${svgArcTo(a, mid, b)}` };
    }
    case "circle": {
      const c = P(g.center);
      const d = circlePath(c.x, c.y, g.r);
      return g.fill ? { fill: d, stroke: g.width > 0 ? d : null } : { stroke: d };
    }
    case "poly": {
      if (!g.pts.length) return null;
      const d = polyD(g.pts, P) + "Z";
      return g.fill || (m && !g.width) ? { fill: d, stroke: g.width > 0 ? d : null } : { stroke: d };
    }
    case "curve": {
      const pts = g.pts.map(P);
      if (pts.length < 4) return null;
      return { stroke: `M${f(pts[0].x)} ${f(pts[0].y)}C${pts.slice(1, 4).map((p) => `${f(p.x)} ${f(p.y)}`).join(" ")}` };
    }
  }
  return null;
}

/** Polygon path data from points that may include arc entries. */
export function polyD(pts, P = (p) => p) {
  let d = "";
  let first = true;
  for (const p of pts) {
    if (p.arc) {
      const s = P(p.start), mid = P(p.mid), e = P(p.end);
      d += first ? `M${f(s.x)} ${f(s.y)}` : `L${f(s.x)} ${f(s.y)}`;
      d += svgArcTo(s, mid, e);
    } else {
      const q = P(p);
      d += `${first ? "M" : "L"}${f(q.x)} ${f(q.y)}`;
    }
    first = false;
  }
  return d;
}

/** Track path (segment or arc). */
export function trackPath(t) {
  if (t.type === "arc") return `M${f(t.start.x)} ${f(t.start.y)}${svgArcTo(t.start, t.mid, t.end)}`;
  return `M${f(t.start.x)} ${f(t.start.y)}L${f(t.end.x)} ${f(t.end.y)}`;
}

/** Points of an arc track/shape for bounds computations. */
export function arcBounds(s, m, e, bbox) {
  const a = arcFrom3(s, m, e);
  if (!a) {
    bbox.add(s.x, s.y).add(e.x, e.y);
    return;
  }
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const t = a.start + (a.sweep * i) / n;
    bbox.add(a.cx + a.r * Math.cos(t), a.cy + a.r * Math.sin(t));
  }
}
