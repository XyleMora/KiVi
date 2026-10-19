// Small 2D geometry toolkit shared by the schematic, PCB and 3D code.
// Matrices use the SVG convention [a b c d e f]:
//   x' = a*x + c*y + e
//   y' = b*x + d*y + f

export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

export function multiply(m, n) {
  // m ∘ n : apply n first, then m.
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function translate(x, y) {
  return [1, 0, 0, 1, x, y];
}

/**
 * Rotation by `deg` degrees counter-clockwise *as seen on screen* in a
 * Y-down coordinate system (KiCad's convention for both editors).
 */
export function rotate(deg) {
  const r = (deg * Math.PI) / 180;
  const c = round(Math.cos(r)), s = round(Math.sin(r));
  return [c, -s, s, c, 0, 0];
}

export function scale(sx, sy = sx) {
  return [sx, 0, 0, sy, 0, 0];
}

export function apply(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Apply only the linear part (directions, offsets). */
export function applyVec(m, x, y) {
  return { x: m[0] * x + m[2] * y, y: m[1] * x + m[3] * y };
}

export function det(m) {
  return m[0] * m[3] - m[1] * m[2];
}

/** Clean up floating noise so sin(90°) is exactly 1 etc. */
function round(v) {
  const r = Math.round(v);
  return Math.abs(v - r) < 1e-12 ? r : v;
}

export function rotatePoint(x, y, deg) {
  const p = apply(rotate(deg), x, y);
  return p;
}

/**
 * Circle through three points (KiCad arcs are stored as start/mid/end).
 * Returns null for collinear points.
 */
export function arcFrom3(s, m, e) {
  const ax = s.x, ay = s.y, bx = m.x, by = m.y, cx = e.x, cy = e.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux);
  const a1 = Math.atan2(by - uy, bx - ux);
  const a2n = Math.atan2(cy - uy, cx - ux);
  // Sweep direction: is mid between start and end going positive-angle?
  const ccwSpan = norm(a2n - a0); // span going in +angle direction
  const midSpan = norm(a1 - a0);
  const positive = midSpan < ccwSpan; // travelling +angle hits mid before end
  const sweep = positive ? ccwSpan : ccwSpan - 2 * Math.PI;
  return { cx: ux, cy: uy, r, start: a0, sweep };
}

function norm(a) {
  const t = 2 * Math.PI;
  return ((a % t) + t) % t;
}

/** SVG path fragment "A ..." for an arc from s through m to e (s already the pen position). */
export function svgArcTo(s, m, e) {
  const arc = arcFrom3(s, m, e);
  if (!arc) return `L${f(e.x)} ${f(e.y)}`;
  const large = Math.abs(arc.sweep) > Math.PI ? 1 : 0;
  // In SVG (y-down) sweep-flag 1 means increasing angle in screen terms,
  // which is the same as increasing atan2 angle in y-down coordinates.
  const sweep = arc.sweep > 0 ? 1 : 0;
  return `A${f(arc.r)} ${f(arc.r)} 0 ${large} ${sweep} ${f(e.x)} ${f(e.y)}`;
}

/** Sample an arc into points (for 3D outlines and polygons). */
export function arcPoints(s, m, e, maxSegLen = 0.25) {
  const arc = arcFrom3(s, m, e);
  if (!arc) return [s, e];
  const n = Math.max(2, Math.ceil((Math.abs(arc.sweep) * arc.r) / maxSegLen));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = arc.start + (arc.sweep * i) / n;
    out.push({ x: arc.cx + arc.r * Math.cos(a), y: arc.cy + arc.r * Math.sin(a) });
  }
  out[0] = s;
  out[n] = e;
  return out;
}

/** Arc given by center, start point and angle (PCB legacy form). */
export function arcMidFromCenter(c, s, angleDeg) {
  const a = Math.atan2(s.y - c.y, s.x - c.x);
  const r = Math.hypot(s.x - c.x, s.y - c.y);
  const sw = (angleDeg * Math.PI) / 180;
  return {
    mid: { x: c.x + r * Math.cos(a + sw / 2), y: c.y + r * Math.sin(a + sw / 2) },
    end: { x: c.x + r * Math.cos(a + sw), y: c.y + r * Math.sin(a + sw) },
  };
}

/** Number formatting for SVG output: compact, ≤4 decimals. */
export function f(v) {
  if (!Number.isFinite(v)) return "0";
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? "0" : String(r);
}

export class BBox {
  constructor() {
    this.x0 = Infinity;
    this.y0 = Infinity;
    this.x1 = -Infinity;
    this.y1 = -Infinity;
  }
  add(x, y) {
    if (x < this.x0) this.x0 = x;
    if (y < this.y0) this.y0 = y;
    if (x > this.x1) this.x1 = x;
    if (y > this.y1) this.y1 = y;
    return this;
  }
  addBox(b) {
    if (!b.empty) {
      this.add(b.x0, b.y0);
      this.add(b.x1, b.y1);
    }
    return this;
  }
  grow(d) {
    if (!this.empty) {
      this.x0 -= d;
      this.y0 -= d;
      this.x1 += d;
      this.y1 += d;
    }
    return this;
  }
  get empty() {
    return this.x0 > this.x1;
  }
  get w() {
    return this.x1 - this.x0;
  }
  get h() {
    return this.y1 - this.y0;
  }
  contains(x, y) {
    return x >= this.x0 && x <= this.x1 && y >= this.y0 && y <= this.y1;
  }
}

/** Signed polygon area (positive = clockwise on screen with y-down). */
export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return -a / 2;
}

export function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
