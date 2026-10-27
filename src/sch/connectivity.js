// Schematic connectivity for one sheet: which wires, labels and pins form a net.
//
// Wires connect at shared points and where a wire end, label, pin or junction
// lands on another wire's interior (KiCad joins those too). Buses and bus
// entries are left out; hidden power pins are global and not drawn, so they
// are skipped as well.

const KEY = (x, y) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
const EPS = 0.005;

/**
 * @param {object} sch    parsed schematic sheet
 * @param {object[]} items renderSchematic() items (symbols carry world pin positions)
 */
export function buildConnectivity(sch, items) {
  const parent = [];
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const nodes = [];
  const add = (node) => {
    node.id = nodes.length;
    nodes.push(node);
    parent.push(node.id);
    return node;
  };

  // Segments.
  const segments = [];
  sch.wires.forEach((w, wi) => {
    for (let i = 1; i < w.pts.length; i++) segments.push(add({ kind: "seg", wire: wi, a: w.pts[i - 1], b: w.pts[i] }));
  });
  // Point-like items.
  const points = [];
  sch.labels.forEach((l, li) => {
    if (l.kind !== "netclass_flag") points.push(add({ kind: "label", label: l, index: li, x: l.x, y: l.y }));
  });
  for (const j of sch.junctions) points.push(add({ kind: "junction", x: j.x, y: j.y }));
  for (const it of items) {
    if (it.kind !== "symbol") continue;
    for (const p of it.pins) {
      if (p.hidden) continue;
      points.push(add({ kind: "pin", uuid: it.uuid, ref: it.baseReference, number: p.number, name: p.name, power: it.power, value: it.value, x: p.x, y: p.y }));
    }
  }

  // 1. Coincident points (segment ends, labels, pins, junctions).
  const at = new Map();
  const put = (x, y, id) => {
    const k = KEY(x, y);
    const list = at.get(k);
    if (list) {
      union(list[0], id);
      list.push(id);
    } else at.set(k, [id]);
  };
  for (const s of segments) {
    put(s.a.x, s.a.y, s.id);
    put(s.b.x, s.b.y, s.id);
  }
  for (const p of points) put(p.x, p.y, p.id);

  // 2. Points on segment interiors (T-joins, labels mid-wire, pins on wires).
  const horiz = new Map(), vert = new Map(), diag = [];
  for (const s of segments) {
    if (Math.abs(s.a.y - s.b.y) < EPS) pushTo(horiz, Math.round(s.a.y * 100), s);
    else if (Math.abs(s.a.x - s.b.x) < EPS) pushTo(vert, Math.round(s.a.x * 100), s);
    else diag.push(s);
  }
  const probe = (x, y, id) => {
    for (const s of horiz.get(Math.round(y * 100)) ?? []) if (x > Math.min(s.a.x, s.b.x) - EPS && x < Math.max(s.a.x, s.b.x) + EPS) union(s.id, id);
    for (const s of vert.get(Math.round(x * 100)) ?? []) if (y > Math.min(s.a.y, s.b.y) - EPS && y < Math.max(s.a.y, s.b.y) + EPS) union(s.id, id);
    for (const s of diag) if (onSegment(x, y, s.a, s.b)) union(s.id, id);
  };
  for (const p of points) probe(p.x, p.y, p.id);
  for (const s of segments) {
    probe(s.a.x, s.a.y, s.id);
    probe(s.b.x, s.b.y, s.id);
  }

  // Collect groups.
  const groups = new Map();
  for (const n of nodes) {
    const r = find(n.id);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { id: r, segments: [], wires: new Set(), labels: [], pins: [], junctions: 0 }));
    if (n.kind === "seg") {
      g.segments.push(n);
      g.wires.add(n.wire);
    } else if (n.kind === "label") g.labels.push(n.label);
    else if (n.kind === "pin") g.pins.push(n);
    else g.junctions++;
  }
  const list = [...groups.values()].filter((g) => g.segments.length || g.labels.length || g.pins.length > 1);
  for (const g of list) g.name = netName(g);
  const byNode = new Map();
  for (const g of list) {
    for (const s of g.segments) byNode.set(s.id, g);
  }
  return {
    groups: list,
    /** Net group of the wire segment nearest to (x, y) within `tol` mm. */
    atPoint(x, y, tol) {
      let best = null, bd = tol;
      for (const s of segments) {
        const d = distToSegment(x, y, s.a, s.b);
        if (d < bd) {
          bd = d;
          best = s;
        }
      }
      return best ? byNode.get(best.id) ?? null : null;
    },
    forLabel(label) {
      return list.find((g) => g.labels.includes(label)) ?? null;
    },
    forPin(ref, number) {
      return list.find((g) => g.pins.some((p) => p.ref === ref && p.number === number)) ?? null;
    },
    named(name) {
      return list.filter((g) => g.name === name || g.labels.some((l) => l.text === name));
    },
  };
}

/** Display name like KiCad: global label > power symbol > hierarchical > local label. */
function netName(g) {
  const pick = (kind) => g.labels.find((l) => l.kind === kind)?.text;
  return pick("global_label") ?? g.pins.find((p) => p.power && !isFlag(p))?.value ?? pick("hierarchical_label") ?? pick("label") ?? null;
}

/** PWR_FLAG marks a net as driven for ERC; it is a power symbol that never names a net. */
function isFlag(p) {
  return p.ref?.startsWith("#FLG") || /^PWR_FLAG$/i.test(p.value ?? "");
}

function pushTo(map, k, v) {
  const list = map.get(k);
  if (list) list.push(v);
  else map.set(k, [v]);
}

function onSegment(x, y, a, b) {
  return distToSegment(x, y, a, b) < EPS * 2;
}

function distToSegment(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/**
 * Board net for a schematic net group: through a symbol pin → footprint pad
 * (exact, works for local, hierarchical and global nets), else by name.
 */
export function boardNetFor(group, pcb) {
  if (!pcb || !group) return null;
  for (const p of group.pins) {
    if (p.power) continue;
    const fp = pcb.footprints.find((f) => f.reference === p.ref);
    const pad = fp?.pads.find((q) => q.number === p.number && q.net);
    if (pad) return pad.net;
  }
  const names = [group.name, ...group.labels.map((l) => l.text), ...group.pins.filter((p) => p.power && !isFlag(p)).map((p) => p.value)].filter(Boolean);
  for (const n of names) if (pcb.netNames.has(n)) return n;
  for (const n of names) {
    const hit = [...pcb.netNames].find((x) => x.endsWith("/" + n));
    if (hit) return hit;
  }
  return null;
}
