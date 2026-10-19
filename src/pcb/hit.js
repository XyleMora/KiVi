// Hit testing on board items (document coordinates, mm).

import { arcPoints } from "../geom.js";
import { onLayer } from "./model.js";

function distToSegment(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

export function padContains(pad, x, y, slack = 0) {
  // Into the pad frame: inverse of geom.rotate (x' = c·x + s·y, y' = −s·x + c·y).
  const a = (pad.angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const dx = x - pad.x, dy = y - pad.y;
  const lx = c * dx - s * dy;
  const ly = s * dx + c * dy;
  const hw = pad.w / 2 + slack, hh = pad.h / 2 + slack;
  if (pad.shape === "circle") return Math.hypot(dx, dy) <= hw;
  if (pad.shape === "custom") return Math.hypot(dx, dy) <= Math.max(hw, hh) * 1.2;
  return Math.abs(lx) <= hw && Math.abs(ly) <= hh;
}

export function trackHit(t, x, y, slack = 0) {
  if (t.type === "arc") {
    const pts = arcPoints(t.start, t.mid, t.end, 0.5);
    for (let i = 1; i < pts.length; i++) if (distToSegment(x, y, pts[i - 1], pts[i]) <= t.width / 2 + slack) return true;
    return false;
  }
  return distToSegment(x, y, t.start, t.end) <= t.width / 2 + slack;
}

/**
 * Find what is under (x, y).
 * @param {object} pcb
 * @param {Set<string>} visible   visible layer names
 * @param {"front"|"back"} side   preferred side
 * @param {number} slack          pick tolerance (mm)
 */
export function hitTest(pcb, x, y, visible, side, slack = 0.15) {
  const front = side !== "back";
  const prefer = (layer) => (front ? layer.startsWith("F.") : layer.startsWith("B."));
  // Pads on visible copper, preferred side first.
  let padHit = null;
  for (const fp of pcb.footprints) {
    for (const p of fp.pads) {
      const layers = [...visible].filter((l) => l.endsWith(".Cu") && onLayer(p.layers, l));
      if (!layers.length) continue;
      if (padContains(p, x, y, slack)) {
        const score = layers.some(prefer) ? 0 : 1;
        if (!padHit || score < padHit.score) padHit = { kind: "pad", pad: p, footprint: fp, score };
      }
    }
  }
  if (padHit && padHit.score === 0) return padHit;
  for (const v of pcb.vias) {
    if (Math.hypot(x - v.x, y - v.y) <= v.size / 2 + slack) return { kind: "via", via: v };
  }
  let trackHitRes = null;
  for (const t of pcb.tracks) {
    if (!visible.has(t.layer)) continue;
    if (trackHit(t, x, y, slack)) {
      const score = prefer(t.layer) ? 0 : 1;
      if (!trackHitRes || score < trackHitRes.score) trackHitRes = { kind: "track", track: t, score };
      if (score === 0) break;
    }
  }
  if (trackHitRes && trackHitRes.score === 0) return trackHitRes;
  if (padHit) return padHit;
  if (trackHitRes) return trackHitRes;
  return null;
}
