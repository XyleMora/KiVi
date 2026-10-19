// Board outline extraction: chains Edge.Cuts primitives into closed loops.

import { arcPoints, polygonArea, pointInPolygon } from "../geom.js";

const TOL = 0.02; // mm, endpoint matching tolerance

function sampleCircle(c, r, maxSeg = 0.3) {
  const n = Math.max(24, Math.ceil((2 * Math.PI * r) / maxSeg));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return pts;
}

function samplePoly(pts) {
  const out = [];
  for (const p of pts) {
    if (p.arc) out.push(...arcPoints(p.start, p.mid, p.end, 0.3));
    else out.push(p);
  }
  return out;
}

function bezierPoints(pts, n = 24) {
  const [p0, p1, p2, p3] = pts;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return out;
}

/** All Edge.Cuts shapes of the board, including those inside footprints. */
export function edgeShapes(pcb) {
  const out = pcb.drawings.filter((g) => g.layer === "Edge.Cuts" && g.kind !== "text");
  for (const fp of pcb.footprints) for (const g of fp.graphics) if (g.layer === "Edge.Cuts") out.push(g);
  return out;
}

/**
 * @returns {{outer: {x,y}[] | null, holes: {x,y}[][], loops: {x,y}[][]}}
 */
export function boardOutline(pcb) {
  const loops = [];
  const open = []; // polylines to chain
  for (const g of edgeShapes(pcb)) {
    switch (g.kind) {
      case "line":
        open.push([g.start, g.end]);
        break;
      case "arc":
        open.push(arcPoints(g.start, g.mid, g.end, 0.3));
        break;
      case "curve":
        if (g.pts.length >= 4) open.push(bezierPoints(g.pts));
        break;
      case "circle":
        loops.push(sampleCircle(g.center, g.r));
        break;
      case "poly": {
        const pts = samplePoly(g.pts);
        if (pts.length >= 3) loops.push(pts);
        break;
      }
    }
  }

  // Greedy chaining of open polylines.
  const used = new Array(open.length).fill(false);
  const near = (a, b) => Math.abs(a.x - b.x) < TOL && Math.abs(a.y - b.y) < TOL;
  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const chain = open[i].slice();
    let grew = true;
    while (grew && !near(chain[0], chain[chain.length - 1])) {
      grew = false;
      const end = chain[chain.length - 1];
      for (let j = 0; j < open.length; j++) {
        if (used[j]) continue;
        const s = open[j];
        if (near(s[0], end)) chain.push(...s.slice(1));
        else if (near(s[s.length - 1], end)) chain.push(...s.slice(0, -1).reverse());
        else continue;
        used[j] = true;
        grew = true;
        break;
      }
    }
    if (chain.length >= 3) {
      if (near(chain[0], chain[chain.length - 1])) chain.pop();
      loops.push(chain);
    }
  }

  if (!loops.length) return { outer: null, holes: [], loops };
  let outerIdx = 0;
  let best = 0;
  loops.forEach((l, i) => {
    const a = Math.abs(polygonArea(l));
    if (a > best) {
      best = a;
      outerIdx = i;
    }
  });
  const outer = loops[outerIdx];
  const holes = loops.filter((l, i) => i !== outerIdx && pointInPolygon(l[0].x, l[0].y, outer));
  return { outer, holes, loops };
}
