// Board thumbnails for the home screen's project grid: parses a .kicad_pcb and
// returns the realistic front face as SVG, clipped to the board outline. Runs
// in a worker because big boards take a second or two to parse.

import { parsePcb } from "../pcb/model.js";
import { boardFaceSvg } from "../pcb/texture.js";
import { boardOutline } from "../pcb/outline.js";
import { polyD } from "../pcb/shapes.js";

self.onmessage = ({ data: { id, text, name } }) => {
  try {
    const pcb = parsePcb(text, name);
    const { svg, bbox } = boardFaceSvg(pcb, "front");
    if (!(bbox.w > 0 && bbox.h > 0)) throw new Error("empty board");
    let out = svg;
    const edge = boardOutline(pcb);
    if (edge.outer) {
      // The face is painted over the whole bounding box; cut it to the board's shape.
      const d = [edge.outer, ...edge.holes].map((l) => polyD(l) + "Z").join("");
      const head = svg.indexOf(">") + 1;
      out = `${svg.slice(0, head)}<defs><clipPath id="edge"><path d="${d}" clip-rule="evenodd"/></clipPath></defs><g clip-path="url(#edge)">${svg.slice(head, -"</svg>".length)}</g></svg>`;
    }
    self.postMessage({ id, svg: out, w: bbox.w, h: bbox.h });
  } catch (e) {
    self.postMessage({ id, error: String(e?.message ?? e) });
  }
};
