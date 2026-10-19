// Diff engine tests (gjs): apply known edits to demo files and check the
// reported changes.   gjs -m tests/diff.js

import { readText, kicadDemos } from "./gjs-fs.js";
import { parseSchematic } from "../src/sch/model.js";
import { renderSchematic } from "../src/sch/render.js";
import { parsePcb } from "../src/pcb/model.js";
import { renderPcb } from "../src/pcb/render.js";
import { diffSchematic } from "../src/diff/sch-diff.js";
import { diffPcb } from "../src/diff/pcb-diff.js";

let failures = 0;
const check = (cond, msg) => {
  print(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  if (!cond) failures++;
};

const DEMO = kicadDemos("pic_programmer");

// ---- schematic ----
{
  const text = readText(`${DEMO}/pic_programmer.kicad_sch`);
  const a = parseSchematic(text, "a.kicad_sch");
  const b = parseSchematic(text, "b.kicad_sch");
  const same = diffSchematic(a, parseSchematic(text), renderSchematic(a), renderSchematic(parseSchematic(text)));
  check(same.changes.length === 0, `identical files → no changes (got ${same.changes.length})`);

  const r1 = b.symbols.find((s) => s.properties.find((p) => p.name === "Reference")?.value === "R1" || s.instances[0]?.reference === "R1");
  r1.properties.find((p) => p.name === "Value").value = "4K7";
  const moved = b.symbols.find((s) => s !== r1 && !s.libId.includes("power"));
  moved.x += 2.54;
  const removedSym = b.symbols.filter((s) => s !== r1 && s !== moved && !s.libId.includes("power"))[3];
  b.symbols = b.symbols.filter((s) => s !== removedSym);
  b.wires = b.wires.slice(2);
  b.labels.push({ kind: "label", text: "NEW_NET", shape: "passive", x: 10, y: 10, angle: 0, effects: b.labels[0].effects, properties: [] });

  const d = diffSchematic(a, b, renderSchematic(a), renderSchematic(b));
  const find = (pred) => d.changes.find(pred);
  check(find((c) => c.type === "symbol" && c.kind === "modified" && /value 10K → 4K7/i.test(c.detail)), "value change detected");
  check(find((c) => c.type === "symbol" && c.kind === "modified" && /moved/.test(c.detail) && c.before && c.after), "moved symbol has before/after boxes");
  check(find((c) => c.type === "symbol" && c.kind === "removed" && c.before), "removed symbol detected");
  check(find((c) => c.type === "wire" && c.kind === "removed" && c.label === "2 wires"), "2 removed wires grouped");
  check(find((c) => c.type === "label" && c.kind === "added" && c.label === "NEW_NET"), "added label detected");
  check(d.summary.removed >= 2 && d.summary.added >= 1, `summary ${JSON.stringify(d.summary)}`);

  const added = diffSchematic(null, a, null, renderSchematic(a));
  check(added.changes.every((c) => c.kind === "added") && added.changes.length > 10, "new file → everything added");
}

// ---- board ----
{
  const text = readText(`${DEMO}/pic_programmer.kicad_pcb`);
  const a = parsePcb(text), b = parsePcb(text);
  check(diffPcb(a, parsePcb(text)).changes.length === 0, "identical boards → no changes");

  const u1 = b.footprints.find((f) => f.reference === "U1");
  u1.x += 1.27;
  u1.angle = 90;
  const r2 = b.footprints.find((f) => f.reference === "R2");
  r2.value = "22K";
  b.footprints = b.footprints.filter((f) => f.reference !== "C5");
  const net = b.tracks[0].net;
  const removedTracks = b.tracks.filter((t) => t.net === net).length;
  b.tracks = b.tracks.filter((t) => t.net !== net);
  b.vias = b.vias.slice(1);
  const pad = b.footprints.find((f) => f.reference === "R3").pads[0];
  const oldNet = pad.net;
  pad.net = "/NEW";

  const d = diffPcb(a, b, renderPcb(a), renderPcb(b));
  const find = (pred) => d.changes.find(pred);
  check(find((c) => c.label === "U1" && /moved 1\.27 mm/.test(c.detail) && /rotated 0° → 90°/.test(c.detail)), "footprint move + rotation");
  check(find((c) => c.label === "R2" && /value 10K → 22K/i.test(c.detail)), "footprint value change");
  check(find((c) => c.label === "C5" && c.kind === "removed"), "removed footprint");
  check(find((c) => c.type === "routing" && c.label === net && c.kind === "removed" && c.tracksBefore.length === removedTracks), `removed routing of ${net} (${removedTracks} segments)`);
  check(find((c) => c.type === "vias" && c.kind === "removed"), "removed via");
  check(find((c) => c.label === "R3" && c.detail.includes(`${oldNet || "—"} → /NEW`)), "pad net change");
}

print(failures ? `\n${failures} failure(s)` : "\nall diff checks passed");
if (failures) imports.system.exit(1);
