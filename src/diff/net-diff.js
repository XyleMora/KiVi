// Connectivity diff of one schematic sheet: which symbol pins joined or left
// each net, whatever the wires look like.
//
// Nets are matched by name (labels and power symbols; the same name anywhere
// on the sheet is one net), then the unnamed ones by the pins they share.
// Pins are keyed by symbol UUID and pin number, so renumbering parts is not a
// connectivity change. Pins of symbols added or removed are left out: those
// symbols are reported on their own.

import { BBox } from "../geom.js";

const PIN_BOX = 1.2;

/**
 * @param {object|null} ca  buildConnectivity() of the sheet before (null if added)
 * @param {object|null} cb  buildConnectivity() of the sheet after (null if removed)
 * @param {object|null} ra  renderSchematic() result before
 * @param {object|null} rb  renderSchematic() result after
 * @returns {object[]} changes of type "net"
 */
export function diffNets(ca, cb, ra, rb) {
  if (!ca || !cb) return []; // a whole sheet added or removed: its symbols say it all
  const symbols = (r) => new Set((r?.items ?? []).filter((i) => i.kind === "symbol" && !i.power).map((i) => i.uuid));
  const sa = symbols(ra), sb = symbols(rb);
  const stable = (p) => sa.has(p.uuid) && sb.has(p.uuid);
  const A = nets(ca), B = nets(cb);

  // 1. By name.
  const pairs = [];
  const usedA = new Set(), usedB = new Set();
  for (const n of A) {
    const m = n.name && B.find((x) => x.name === n.name);
    if (m) {
      pairs.push([n, m]);
      usedA.add(n);
      usedB.add(m);
    }
  }
  // 2. The rest by shared pins, most first (an unnamed net, or one whose label changed).
  const owner = new Map();
  for (const m of B) if (!usedB.has(m)) for (const k of m.pins.keys()) owner.set(k, m);
  const overlap = [];
  for (const n of A) {
    if (usedA.has(n)) continue;
    const counts = new Map();
    for (const k of n.pins.keys()) {
      const m = owner.get(k);
      if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    for (const [m, c] of counts) overlap.push([c, n, m]);
  }
  overlap.sort((x, y) => y[0] - x[0]);
  for (const [, n, m] of overlap) {
    if (usedA.has(n) || usedB.has(m)) continue;
    pairs.push([n, m]);
    usedA.add(n);
    usedB.add(m);
  }
  for (const n of A) if (!usedA.has(n)) pairs.push([n, null]);
  for (const m of B) if (!usedB.has(m)) pairs.push([null, m]);

  const changes = [];
  for (const [n, m] of pairs) {
    const before = n ? [...n.pins].filter(([, p]) => stable(p)) : [];
    const after = m ? [...m.pins].filter(([, p]) => stable(p)) : [];
    const keysA = new Set(before.map(([k]) => k)), keysB = new Set(after.map(([k]) => k));
    const lost = before.filter(([k]) => !keysB.has(k)).map(([, p]) => p);
    const gained = after.filter(([k]) => !keysA.has(k)).map(([, p]) => p);
    const renamed = n?.name && m?.name && n.name !== m.name;
    if (!lost.length && !gained.length && !renamed) continue;
    const parts = [];
    if (renamed) parts.push(`renamed from ${n.name}`);
    if (gained.length) parts.push(`+ ${pinList(gained)}`);
    if (lost.length) parts.push(`− ${pinList(lost)}`);
    const boxesBefore = lost.map(pinBox), boxesAfter = gained.map(pinBox);
    changes.push({
      kind: n && m ? "modified" : m ? "added" : "removed",
      type: "net",
      label: m?.name ?? n?.name ?? autoName(m ?? n),
      detail: parts.join("; "),
      fields: parts,
      pinsAdded: gained.map(pinName),
      pinsRemoved: lost.map(pinName),
      before: n ? (boxesBefore.length ? union(boxesBefore) : renamed ? n.box : null) : null,
      after: m ? (boxesAfter.length ? union(boxesAfter) : renamed ? m.box : null) : null,
      boxesBefore,
      boxesAfter,
    });
  }
  return changes;
}

/** The sheet's nets with their symbol pins, groups of the same name merged. */
function nets(conn) {
  const byName = new Map();
  const out = [];
  for (const g of conn.groups) {
    let net = g.name ? byName.get(g.name) : null;
    if (!net) {
      net = { name: g.name, pins: new Map(), box: new BBox() };
      if (g.name) byName.set(g.name, net);
      out.push(net);
    }
    for (const p of g.pins) if (!p.power) net.pins.set(`${p.uuid}|${p.number}`, p);
    for (const s of g.segments) net.box.add(s.a.x, s.a.y).add(s.b.x, s.b.y);
    for (const l of g.labels) net.box.add(l.x, l.y);
  }
  for (const n of out) if (!n.box.empty) n.box.grow(1);
  return out.filter((n) => n.pins.size || n.name);
}

/** KiCad's name for an unlabelled net: Net-(R1-Pad1), after its first pin. */
function autoName(net) {
  const first = [...net.pins.values()].map((p) => `${p.ref}-Pad${p.number}`).sort()[0];
  return first ? `Net-(${first})` : "(unnamed net)";
}

function pinName(p) {
  return `${p.ref}.${p.number}${p.name && p.name !== "~" && p.name !== p.number ? ` (${p.name})` : ""}`;
}

function pinList(pins, max = 6) {
  const names = pins.map(pinName).sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  return names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", ");
}

function pinBox(p) {
  return new BBox().add(p.x - PIN_BOX, p.y - PIN_BOX).add(p.x + PIN_BOX, p.y + PIN_BOX);
}

function union(boxes) {
  const b = new BBox();
  for (const x of boxes) b.addBox(x);
  return b;
}
