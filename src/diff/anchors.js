// Comment anchors: what a review comment points at, and where that thing is
// in a given version of the file.
//
// An anchor names an element by its stable identity (footprint/symbol UUID
// and reference, pad number, net name) and also keeps the clicked point, so
// it can still be placed when the element has moved, and falls back to the
// point when it no longer exists.

import { BBox, arcPoints } from "../geom.js";
import { hitTest } from "../pcb/hit.js";

const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Element under (x, y) in a board.
 * @param {object} pcb      parsed board
 * @param {object} render   renderPcb() result
 * @param {{x: number, y: number}} p
 * @param {{visible: Set<string>, side?: string, slack?: number}} o
 * @returns {{anchor: object, mark: object}}
 */
export function pickPcb(pcb, render, p, { visible, side = "front", slack = 0.15 }) {
  const point = { x: r2(p.x), y: r2(p.y) };
  const hit = hitTest(pcb, p.x, p.y, visible, side, slack);
  if (hit?.kind === "pad") {
    const fp = hit.footprint;
    return { anchor: { type: "pad", ref: fp.reference, uuid: fp.uuid || undefined, pad: hit.pad.number, net: hit.pad.net || undefined, ...point }, mark: padMark(hit.pad) };
  }
  if ((hit?.kind === "track" || hit?.kind === "via") && (hit.track ?? hit.via).net) {
    const net = (hit.track ?? hit.via).net;
    return { anchor: { type: "net", net, ...point }, mark: netMark(pcb, net) };
  }
  const item = footprintAt(render, p, side);
  if (item) return { anchor: { type: "footprint", ref: item.fp.reference, uuid: item.fp.uuid || undefined, ...point }, mark: { box: item.bbox } };
  return { anchor: { type: "point", ...point }, mark: null };
}

/**
 * Element under (x, y) on a schematic sheet.
 * @param {object} sch      parsed schematic
 * @param {object} render   renderSchematic() result
 * @param {object} conn     buildConnectivity() result
 * @param {{x: number, y: number}} p
 * @param {number} tol      wire pick tolerance (mm)
 */
export function pickSch(sch, render, conn, p, tol = 0.5) {
  const point = { x: r2(p.x), y: r2(p.y) };
  let item = null, area = Infinity;
  for (const it of render.items) {
    if (!it.bbox.contains(p.x, p.y)) continue;
    const a = it.bbox.w * it.bbox.h * (it.kind === "sheet" ? 50 : 1);
    if (a < area) {
      area = a;
      item = it;
    }
  }
  let group = null;
  if (item?.kind === "label") {
    const label = sch.labels.find((l) => l.x === item.x && l.y === item.y);
    group = label ? conn.forLabel(label) : null;
  }
  if (!group) {
    const g = conn.atPoint(p.x, p.y, tol);
    const onPin = item?.kind === "symbol" && item.pins.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < tol * 2);
    if (g && (!item || item.kind !== "symbol" || onPin)) group = g;
  }
  if (group) return { anchor: { type: "net", ...netIdentity(group), ...point }, mark: groupMark(group) };
  if (item?.kind === "symbol") return { anchor: { type: "symbol", ref: item.reference, uuid: item.uuid, ...point }, mark: { box: item.bbox } };
  if (item?.kind === "sheet") return { anchor: { type: "sheet", name: item.name, uuid: item.uuid, ...point }, mark: { box: item.bbox } };
  return { anchor: { type: "point", ...point }, mark: null };
}

/** Net name, plus one pin so unnamed nets ("Net-(R1-Pad2)") can be found again. */
function netIdentity(group) {
  const pin = group.pins.find((q) => !q.power && q.ref && q.number);
  const id = {};
  if (group.name) id.net = group.name;
  if (pin) id.pin = `${pin.ref}:${pin.number}`;
  return id;
}

/**
 * Where an anchor is in this version of a board.
 * @returns {{x: number, y: number, found: boolean, mark: object|null}}
 */
export function locatePcb(pcb, render, a) {
  const fallback = { x: a.x, y: a.y, found: false, mark: null };
  if (!pcb) return fallback;
  if (a.type === "footprint" || a.type === "pad") {
    const item = (a.uuid && render.items.find((i) => i.fp.uuid === a.uuid)) || render.items.find((i) => i.fp.reference === a.ref);
    if (!item) return fallback;
    if (a.type === "pad") {
      const pad = item.fp.pads.find((q) => q.number === a.pad);
      if (pad) return { x: pad.x, y: pad.y, found: true, mark: padMark(pad) };
    }
    return { ...placeIn(item.bbox, a), found: true, mark: { box: item.bbox } };
  }
  if (a.type === "net") {
    const mark = netMark(pcb, a.net);
    if (!mark.tracks.length && !mark.vias.length) {
      // Net without routing: point at one of its pads.
      for (const fp of pcb.footprints) {
        const pad = fp.pads.find((q) => q.net === a.net);
        if (pad) return { x: pad.x, y: pad.y, found: true, mark: padMark(pad) };
      }
      return fallback;
    }
    const q = nearestOnTracks(mark.tracks, mark.vias, a);
    return { x: q.x, y: q.y, found: true, mark };
  }
  return { x: a.x, y: a.y, found: true, mark: null };
}

/** Where an anchor is on this version of a sheet. */
export function locateSch(sch, render, conn, a) {
  const fallback = { x: a.x, y: a.y, found: false, mark: null };
  if (!sch) return fallback;
  if (a.type === "symbol" || a.type === "sheet") {
    const kind = a.type;
    const item = render.items.find((i) => i.kind === kind && i.uuid === a.uuid) || (kind === "symbol" ? render.items.find((i) => i.kind === "symbol" && i.reference === a.ref) : render.items.find((i) => i.kind === "sheet" && i.name === a.name));
    if (!item) return fallback;
    return { ...placeIn(item.bbox, a), found: true, mark: { box: item.bbox } };
  }
  if (a.type === "net") {
    let group = null;
    if (a.pin) {
      const [ref, number] = [a.pin.slice(0, a.pin.lastIndexOf(":")), a.pin.slice(a.pin.lastIndexOf(":") + 1)];
      group = conn.forPin(ref, number);
    }
    if (!group && a.net) group = conn.named(a.net)[0] ?? null;
    if (!group) return fallback;
    const segs = group.segments.map((s) => ({ start: s.a, end: s.b }));
    const pts = [...group.labels, ...group.pins].map((q) => ({ x: q.x, y: q.y, size: 0 }));
    const q = nearestOnTracks(segs, pts, a);
    return { x: q.x, y: q.y, found: true, mark: groupMark(group) };
  }
  return { x: a.x, y: a.y, found: true, mark: null };
}

// ---- helpers ----

function footprintAt(render, p, side) {
  let best = null, area = Infinity;
  for (const it of render.items) {
    if (!it.bbox.contains(p.x, p.y)) continue;
    const a = it.bbox.w * it.bbox.h * (it.side === (side === "back" ? "back" : "front") ? 1 : 4);
    if (a < area) {
      area = a;
      best = it;
    }
  }
  return best;
}

/** The clicked point if it is still on the element, otherwise its centre. */
function placeIn(box, a) {
  if (box.contains(a.x, a.y)) return { x: a.x, y: a.y };
  return { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
}

function padMark(pad) {
  const r = Math.max(pad.w, pad.h) / 2;
  return { box: new BBox().add(pad.x - r, pad.y - r).add(pad.x + r, pad.y + r) };
}

function netMark(pcb, net) {
  const tracks = pcb.tracks.filter((t) => t.net === net);
  const vias = pcb.vias.filter((v) => v.net === net);
  const box = new BBox();
  for (const t of tracks) box.add(t.start.x, t.start.y).add(t.end.x, t.end.y);
  for (const v of vias) box.add(v.x, v.y);
  return { tracks, vias, box };
}

function groupMark(group) {
  const box = new BBox();
  for (const s of group.segments) box.add(s.a.x, s.a.y).add(s.b.x, s.b.y);
  for (const q of [...group.labels, ...group.pins]) box.add(q.x, q.y);
  return { paths: group.segments.map((s) => [s.a, s.b]), box };
}

/** Closest point to `p` on any track (or via / point). */
function nearestOnTracks(tracks, points, p) {
  let best = null, bd = Infinity;
  const consider = (x, y) => {
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < bd) {
      bd = d;
      best = { x, y };
    }
  };
  for (const t of tracks) {
    const pts = t.type === "arc" ? arcPoints(t.start, t.mid, t.end, 0.5) : [t.start, t.end];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const k = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
      consider(a.x + k * dx, a.y + k * dy);
    }
  }
  for (const v of points) consider(v.x, v.y);
  return best ?? { x: p.x, y: p.y };
}
