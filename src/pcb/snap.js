// Points a measuring tool snaps to on a board (document mm): pad and via
// centres, track ends, footprint origins and corners of board graphics, on the
// given layers. Shared by the PCB view and the 3D view (measure.js, measure3d.js).

import { onLayer } from "./model.js";
import { unescapeKiCad } from "../text.js";

/**
 * @param {object} pcb
 * @param {Set<string>} vis       layer names shown ("Vias" for vias)
 * @param {"front"|"back"} side   whose footprint origins count
 * @returns {{x: number, y: number, r?: number, label: string}[]}  `r`: the pad's,
 *   via's or track's size, so clicking anywhere on the copper snaps to its centre
 */
export function snapPoints(pcb, vis, side) {
  const shown = [...vis];
  const out = [];
  for (const fp of pcb.footprints) {
    if (fp.side === side) out.push({ x: fp.x, y: fp.y, label: `${fp.reference} origin` });
    // The pad's inscribed circle: a click on the pad, not beside it, snaps to its centre.
    for (const p of fp.pads) if (shown.some((l) => onLayer(p.layers, l))) out.push({ x: p.x, y: p.y, r: Math.min(p.w, p.h) / 2, label: `${fp.reference} pad ${p.number}` });
  }
  if (vis.has("Vias")) for (const v of pcb.vias) out.push({ x: v.x, y: v.y, r: v.size / 2, label: `via${v.net ? ` (${unescapeKiCad(v.net)})` : ""}` });
  for (const t of pcb.tracks) {
    if (!vis.has(t.layer)) continue;
    const label = `track end${t.net ? ` (${unescapeKiCad(t.net)})` : ""}`;
    out.push({ x: t.start.x, y: t.start.y, r: t.width / 2, label }, { x: t.end.x, y: t.end.y, r: t.width / 2, label });
  }
  for (const g of pcb.drawings) {
    if (!vis.has(g.layer)) continue;
    const what = g.layer === "Edge.Cuts" ? "outline" : g.layer;
    if (g.kind === "line" || g.kind === "arc") out.push({ ...g.start, label: `${what} corner` }, { ...g.end, label: `${what} corner` });
    else if (g.kind === "circle") out.push({ ...g.center, label: `${what} circle centre` });
    else if (g.kind === "poly") for (const p of g.pts) if (!p.arc) out.push({ x: p.x, y: p.y, label: `${what} corner` });
  }
  return out;
}
