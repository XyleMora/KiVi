// Diff engine tests (gjs): apply known edits to demo files and check the
// reported changes.   gjs -m tests/diff.js

import { readText, kicadDemos } from "./gjs-fs.js";
import { parseSchematic, libSymbolFor } from "../src/sch/model.js";
import { renderSchematic } from "../src/sch/render.js";
import { parsePcb } from "../src/pcb/model.js";
import { renderPcb } from "../src/pcb/render.js";
import { diffSchematic } from "../src/diff/sch-diff.js";
import { diffPcb } from "../src/diff/pcb-diff.js";
import { diffRules } from "../src/diff/rules-diff.js";
import { textBeforePatch } from "../src/sources.js";
import { kicadFilesChanged } from "../src/desktop/pr-files.js";
import GLib from "gi://GLib";

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

// ---- schematic nets ----
{
  const text = readText(`${DEMO}/pic_programmer.kicad_sch`);
  const a = parseSchematic(text);
  const net = (b) => diffSchematic(a, b, renderSchematic(a), renderSchematic(b)).changes.filter((c) => c.type === "net");

  // Redrawing a wire (split in two at a bend, same connections) is no net change.
  const b1 = parseSchematic(text);
  const w = b1.wires.find((x) => x.pts.length === 2 && Math.abs(x.pts[0].x - x.pts[1].x) > 5);
  const mid = { x: (w.pts[0].x + w.pts[1].x) / 2, y: w.pts[0].y };
  b1.wires = b1.wires.filter((x) => x !== w).concat({ ...w, pts: [w.pts[0], mid] }, { ...w, pts: [mid, w.pts[1]] });
  check(net(b1).length === 0, `wire split in two → no net change (got ${net(b1).map((c) => c.label).join(", ")})`);

  // Removing wires disconnects pins.
  const b2 = parseSchematic(text);
  b2.wires = b2.wires.slice(2);
  const cut = net(b2);
  check(cut.some((c) => c.kind === "modified" && c.pinsRemoved.length && c.boxesBefore.length), `removed wires → pins leave their nets (${cut.map((c) => `${c.label}: ${c.detail}`).join(" | ")})`);

  // A renamed label moves its pins to the new net.
  const b3 = parseSchematic(text);
  const lab = b3.labels.find((l) => l.kind === "label" || l.kind === "global_label");
  const old = lab.text;
  lab.text = "RENAMED_NET";
  const moved = net(b3);
  const to = moved.find((c) => c.label === "RENAMED_NET");
  check(to && to.pinsAdded.length > 0, `renamed label → pins join RENAMED_NET (${to?.detail})`);
  check(moved.some((c) => c.label === old && c.pinsRemoved.length) || moved.some((c) => /renamed from/.test(c.detail)), `…and leave ${old}`);

  // Renumbering a part is not a connectivity change (pins are matched by symbol UUID).
  const b4 = parseSchematic(text);
  const sym = b4.symbols.find((s) => !s.libId.includes("power") && s.instances?.length);
  for (const inst of sym.instances) inst.reference = "R999";
  const ref = sym.properties.find((p) => p.name === "Reference");
  if (ref) ref.value = "R999";
  check(net(b4).length === 0, "renumbered part → no net change");

  // Pins of a removed symbol are reported by the symbol, not by every net it touched.
  const b5 = parseSchematic(text);
  const gone = b5.symbols.find((s) => !s.libId.includes("power"));
  b5.symbols = b5.symbols.filter((s) => s !== gone);
  check(net(b5).length === 0, "removed symbol → no net changes for its pins");
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

// ---- duplicate pad numbers and footprint texts ----
{
  const dir = kicadDemos("cm5_minima");
  const text = readText(`${dir}/CM5_MINIMA_3.kicad_pcb`);
  const a = parsePcb(text);
  const fp = a.footprints.find((f) => f.pads.filter((p) => p.number === "MP").length > 1 && new Set(f.pads.filter((p) => p.number === "MP").map((p) => p.net)).size > 1);
  check(!!fp, `footprint with several MP pads on different nets (${fp?.reference})`);
  check(diffPcb(a, parsePcb(text)).changes.length === 0, "identical board with duplicate pad numbers → no changes");
  for (const name of ["openair-max/One-Air-Max", "tiny_tapeout/tinytapeout-demo"]) {
    const t = readText(`${kicadDemos(name.split("/")[0])}/${name.split("/")[1]}.kicad_pcb`);
    check(diffPcb(parsePcb(t), parsePcb(t)).changes.length === 0, `identical ${name.split("/")[1]} (duplicate Fab texts) → no changes`);
  }
  // A real change on the second MP pad is still found.
  const b = parsePcb(text);
  const g = b.footprints.find((f) => f.uuid === fp.uuid);
  g.pads.filter((p) => p.number === "MP")[1].net = "/NEW";
  const c = diffPcb(a, b).changes.find((x) => x.label === fp.reference);
  check(c && c.detail.includes("→ /NEW"), `second MP pad's net change (${c?.detail})`);
}

// ---- zones, teardrops and board setup ----
{
  const dir = kicadDemos("complex_hierarchy");
  const text = readText(`${dir}/complex_hierarchy.kicad_pcb`);
  const a = parsePcb(text);
  check(diffPcb(a, parsePcb(text)).changes.length === 0, "identical board with zones → no changes");
  const zone = a.zones.find((z) => !z.teardrop && !z.keepout && z.settings.clearance != null);
  check(!!zone && a.zones.some((z) => z.teardrop), "zones and teardrops parsed");

  const b = parsePcb(text);
  const z = b.zones.find((x) => x.uuid === zone.uuid);
  z.settings.clearance = zone.settings.clearance + 0.25;
  z.settings.priority = zone.settings.priority + 1;
  z.settings.pads = "solid";
  z.outline[0][0] = { x: z.outline[0][0].x + 1, y: z.outline[0][0].y };
  const tds = b.zones.filter((x) => x.teardrop);
  b.zones = b.zones.filter((x) => !tds.slice(0, 5).includes(x));
  b.setup.pad_to_mask_clearance = (a.setup.pad_to_mask_clearance ?? 0) + 0.05;
  if (b.stackup.length) b.stackup[Math.floor(b.stackup.length / 2)].thickness += 0.1;

  const d = diffPcb(a, b);
  const zc = d.changes.filter((c) => c.type === "zone");
  const zm = zc.find((c) => c.kind === "modified");
  check(zc.length === 1 && zm, `edited zone → one modified zone, not removed + added (got ${zc.map((c) => c.kind).join(", ")})`);
  check(zm && /outline changed/.test(zm.detail) && /clearance [\d.]+ mm → [\d.]+ mm/.test(zm.detail) && /priority/.test(zm.detail) && /pad connections .* → solid/.test(zm.detail), `zone settings listed: ${zm?.detail}`);
  const td = d.changes.filter((c) => c.type === "teardrops");
  check(td.length === 1 && td[0].detail === "−5", `teardrops grouped in one line (${td.map((c) => c.detail).join(", ")})`);
  const board = d.changes.find((c) => c.type === "board");
  check(board && /solder mask expansion/.test(board.detail), `board setup: mask expansion (${board?.detail})`);
  check(!b.stackup.length || /stackup .*thickness/.test(board?.detail), "board setup: stackup thickness");
}

// ---- design rules (.kicad_pro, .kicad_dru) ----
{
  const dir = kicadDemos("jetson-agx-thor-baseboard");
  const proText = readText(`${dir}/jetson-agx-thor-baseboard.kicad_pro`);
  check(diffRules("x.kicad_pro", proText, proText).changes.length === 0, "identical project → no rule changes");
  const pro = JSON.parse(proText);
  pro.board.design_settings.rules.min_clearance += 0.05;
  pro.board.design_settings.rule_severities.clearance = "ignore";
  pro.board.design_settings.track_widths.push(0.42);
  pro.net_settings.classes[0].clearance += 0.1;
  pro.net_settings.classes.push({ ...pro.net_settings.classes[0], name: "HV", clearance: 1.5 });
  const net = Object.keys(pro.net_settings.netclass_assignments)[0];
  pro.net_settings.netclass_assignments[net] = ["HV"];
  pro.meta = { filename: "noise.kicad_pro" }; // settings outside the design rules are ignored
  const d = diffRules("x.kicad_pro", proText, JSON.stringify(pro));
  const find = (pred) => d.changes.find(pred);
  check(find((c) => c.type === "constraint" && c.label === "Min clearance" && / mm → /.test(c.detail)), "constraint change");
  check(find((c) => c.type === "DRC check" && c.label === "Clearance" && c.detail === "error → ignore"), "DRC severity change");
  check(find((c) => c.type === "size presets" && c.kind === "added" && /0\.42 mm/.test(c.detail)), "track width preset added");
  check(find((c) => c.type === "netclass" && c.kind === "modified" && c.label === pro.net_settings.classes[0].name && /Clearance/.test(c.detail)), "netclass clearance change");
  check(find((c) => c.type === "netclass" && c.kind === "added" && c.label === "HV" && c.rows.some((r) => r[0] === "Clearance" && r[2] === "1.5 mm")), "netclass added");
  check(find((c) => c.type === "net assignment" && c.label === "HV" && c.rows.some((r) => r[0] === net)), "net moved to another netclass");
  check(d.changes.length === 6, `nothing else reported (${d.changes.length} changes)`);

  const dru = readText(`${dir}/jetson-agx-thor-baseboard.kicad_dru`);
  check(diffRules("x.kicad_dru", dru, dru).changes.length === 0, "identical custom rules → no changes");
  const edited = dru.replace("(constraint track_width (opt 0.15mm))", "(constraint track_width (opt 0.14mm))").replace(/\(rule "\(90_ohm_outer"[\s\S]*?\n\)\n/, "") + '\n# added\n(rule "hv" (condition "A.NetClass == \'HV\'") (constraint clearance (min 1.5mm)))\n';
  const dd = diffRules("x.kicad_dru", dru, edited).changes;
  check(dd.some((c) => c.kind === "modified" && c.label === "(85_ohm_inner" && c.rows.some((r) => r[0] === "constraint track_width" && r[1] === "(opt 0.15mm)" && r[2] === "(opt 0.14mm)")), "custom rule constraint change");
  check(dd.some((c) => c.kind === "removed" && c.label === "(90_ohm_outer"), "custom rule removed");
  check(dd.some((c) => c.kind === "added" && c.label === "hv" && /HV/.test(c.detail)), "custom rule added");
  check(dd.length === 3, `nothing else reported (${dd.map((c) => c.label).join(", ")})`);
}

// ---- PR inbox badge: patches and which files count ----
{
  /** A unified diff like GitHub's `patch`, from diff -u (its ---/+++ header is skipped). */
  const unified = (x, y) => {
    const dir = GLib.dir_make_tmp("kivi-diff-XXXXXX");
    GLib.file_set_contents(`${dir}/a`, x);
    GLib.file_set_contents(`${dir}/b`, y);
    const [, out] = GLib.spawn_command_line_sync(`diff -u ${dir}/a ${dir}/b`);
    for (const f of ["a", "b"]) GLib.unlink(`${dir}/${f}`);
    GLib.rmdir(dir);
    return new TextDecoder().decode(out);
  };
  const pro = readText(`${kicadDemos("jetson-agx-thor-baseboard")}/jetson-agx-thor-baseboard.kicad_pro`);
  const lines = pro.split("\n");
  const edits = {
    "changed line": (l) => l.map((x, i) => (i === 40 ? x + " " : x)),
    "lines removed": (l) => l.filter((_, i) => i < 100 || i > 104),
    "lines added": (l) => [...l.slice(0, 200), "  \"new\": 1,", ...l.slice(200)],
    "first line": (l) => ["{ ", ...l.slice(1)],
    "last lines": (l) => [...l.slice(0, -3), "}"],
    "several hunks": (l) => l.map((x, i) => (i % 150 === 7 ? x + "x" : x)).filter((_, i) => i !== 333),
  };
  for (const [name, edit] of Object.entries(edits)) {
    const after = edit(lines).join("\n");
    check(textBeforePatch(after, unified(pro, after)) === pro, `text before a patch: ${name}`);
  }

  const proRules = JSON.parse(pro);
  proRules.board.design_settings.rules.min_clearance = 0.2;
  const ruled = JSON.stringify(proRules, null, 2), base = JSON.stringify(JSON.parse(pro), null, 2);
  const cosmetic = base.replace('"meta": {', '"meta": {\n    "x_window": 1,');
  const contents = (path) => `https://api.github.com/repos/o/r/contents/${path}?ref=${"c".repeat(40)}`;
  const heads = { "a/rules.kicad_pro": ruled, "b/cosmetic.kicad_pro": cosmetic };
  const files = [
    { filename: "a/x.kicad_sch", status: "modified" },
    { filename: "a/rules.kicad_pro", status: "modified", patch: unified(base, ruled), contents_url: contents("a/rules.kicad_pro") },
    { filename: "b/cosmetic.kicad_pro", status: "modified", patch: unified(base, cosmetic), contents_url: contents("b/cosmetic.kicad_pro") },
    { filename: "c/big.kicad_pro", status: "modified", contents_url: contents("c/big.kicad_pro") }, // no patch: too large
    { filename: "d/broken.kicad_pro", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b", contents_url: contents("d/broken.kicad_pro") },
    { filename: "e/new.kicad_pro", status: "added" },
    { filename: "a/rules.kicad_dru", status: "modified" },
    { filename: "README.md", status: "modified" },
  ];
  const reads = [];
  const read = async (path, ref) => {
    reads.push([path, ref]);
    if (!heads[path]) throw new Error("404");
    return heads[path];
  };
  const counted = (await kicadFilesChanged(files, read)).map((f) => f.filename);
  check(counted.join() === "a/x.kicad_sch,a/rules.kicad_pro,c/big.kicad_pro,d/broken.kicad_pro,e/new.kicad_pro,a/rules.kicad_dru", `PR files counted: ${counted.join(", ")}`);
  check(!counted.includes("b/cosmetic.kicad_pro"), "a .kicad_pro without rule changes doesn't count");
  check(reads.every(([, ref]) => ref === "c".repeat(40)) && reads.length === 3, `only the changed .kicad_pro files are read, at the PR head (${reads.length})`);
}

// ---- library symbols (the sheet's copies: pins, graphics) ----
{
  const text = readText(`${DEMO}/pic_programmer.kicad_sch`);
  const a = parseSchematic(text);
  const libChanges = (b) => diffSchematic(a, b, renderSchematic(a), renderSchematic(b)).changes.filter((c) => c.type === "library symbol");
  const uses = new Map();
  for (const s of a.symbols) uses.set(s.libId, (uses.get(s.libId) ?? 0) + 1);
  const sym = a.symbols.filter((s) => libSymbolFor(a, s)?.units.flatMap((u) => u.pins).length >= 2).sort((x, y) => uses.get(y.libId) - uses.get(x.libId))[0];
  const name = libSymbolFor(a, sym).name, n = uses.get(sym.libId);
  const pinsOf = (b) => b.libSymbols.get(name).units.flatMap((u) => u.pins);

  const b1 = parseSchematic(text);
  const p1 = pinsOf(b1)[0];
  p1.type = p1.type === "power_in" ? "passive" : "power_in";
  const c1 = libChanges(b1);
  check(c1.length === 1 && new RegExp(`pin ${p1.number}: type .* → ${p1.type === "power_in" ? "power input" : "passive"}`).test(c1[0].detail), `pin type change on ${sym.libId} (${c1[0]?.detail})`);
  check(c1[0]?.boxesAfter.length === n && /used by /.test(c1[0].detail), `reported once with its ${n} parts`);

  const b2 = parseSchematic(text);
  const [q1, q2] = pinsOf(b2);
  [q1.number, q2.number] = [q2.number, q1.number];
  const c2 = libChanges(b2);
  check(c2.length === 1 && c2[0].detail.includes(`moved to pin ${q2.number}'s place`), `swapped pins say where they went (${c2[0]?.detail})`);

  const b3 = parseSchematic(text);
  b3.libSymbols.get(name).units.find((u) => u.graphics.length).graphics.pop();
  const c3 = libChanges(b3);
  check(c3.length === 1 && /graphics changed/.test(c3[0].detail), `symbol body change (${c3[0]?.detail})`);
}

// ---- footprint contents: pads, 3D models, graphics ----
{
  const text = readText(`${kicadDemos("cm5_minima")}/CM5_MINIMA_3.kicad_pcb`);
  const a = parsePcb(text);
  const b = parsePcb(text);
  const smd = a.footprints.find((f) => f.pads.length >= 4 && f.pads.every((p) => p.type === "smd") && f.models.length);
  const tht = a.footprints.find((f) => f.pads.some((p) => p.drill && !p.drill.oval));
  const g = b.footprints.find((f) => f.uuid === smd.uuid);
  for (const p of g.pads.slice(1)) p.w += 0.1; // updated from the library: the same change on many pads
  g.pads[0].settings.maskMargin = 0.05;
  g.models[0].path = "other.step";
  g.graphics.push({ kind: "line", layer: "F.SilkS", width: 0.12, start: { x: g.x, y: g.y }, end: { x: g.x + 1, y: g.y } });
  const h = b.footprints.find((f) => f.uuid === tht.uuid);
  const dp = h.pads.find((p) => p.drill && !p.drill.oval);
  dp.drill = { ...dp.drill, w: dp.drill.w + 0.2, h: dp.drill.h + 0.2 };
  const d = diffPcb(a, b).changes;
  const cs = d.find((c) => c.label === smd.reference)?.detail ?? "";
  check(new RegExp(`pads [^:]+: size [\\d.× ]+ → [\\d.× ]+ mm`).test(cs) && !/pad 1: size/.test(cs.replace(/pad 1: solder/, "")), `pads with the same change grouped (${cs})`);
  check(/solder mask margin — → 0.05 mm/.test(cs), "pad solder mask override");
  const model = smd.models[0].path.split("/").pop();
  check(cs.includes(`3D model ${model} → other.step`) && !cs.includes("3DMODEL_DIR"), `3D model change names the files only (${model} → other.step)`);
  check(/F\.SilkS graphics \+1/.test(cs), "silkscreen line added");
  const ct = d.find((c) => c.label === tht.reference)?.detail ?? "";
  check(new RegExp(`pad ${dp.number || "\\(unnumbered\\)"}: drill [\\d.]+ mm → [\\d.]+ mm`).test(ct), `drill change (${ct})`);

  // The same model from another library version: only the part of the path that differs.
  const b2 = parsePcb(text);
  const m2 = b2.footprints.find((f) => f.uuid === smd.uuid).models[0];
  m2.path = m2.path.replace(/KICAD\d+_3DMODEL_DIR/, "KICAD10_3DMODEL_DIR");
  const c2 = diffPcb(a, b2).changes.find((c) => c.label === smd.reference)?.detail ?? "";
  check(new RegExp(`^3D model \\$\\{KICAD\\d+_3DMODEL_DIR\\}/… → \\$\\{KICAD10_3DMODEL_DIR\\}/… \\(${model.replace(/\./g, "\\.")}\\)$`).test(c2), `same file in another folder: the folders that differ (${c2})`);

  // Moving and rotating parts the way KiCad saves them changes nothing inside them.
  const r = parsePcb(text);
  for (const fp of r.footprints) {
    const T = (p) => {
      const x = p.x - fp.x, y = p.y - fp.y;
      p.x = fp.x + 3.3 + y;
      p.y = fp.y - 1.7 - x;
    };
    for (const s of fp.graphics) {
      for (const k of ["start", "mid", "end", "center"]) if (s[k]) T(s[k]);
      for (const p of s.pts ?? []) if (p.arc) [p.start, p.mid, p.end].forEach(T);
      else T(p);
    }
    for (const p of [...fp.pads, ...fp.texts]) {
      T(p);
      p.angle += 90;
    }
    fp.x += 3.3;
    fp.y -= 1.7;
    fp.angle += 90;
  }
  const rot = diffPcb(a, r).changes.filter((c) => c.type === "footprint");
  const noise = rot.filter((c) => c.detail.split("; ").some((x) => !/^moved [\d.]+ mm$|^rotated /.test(x)));
  check(rot.length > 50 && !noise.length, `${rot.length} parts moved and rotated: no pad, graphics or text noise (${noise[0]?.detail ?? "none"})`);
}

print(failures ? `\n${failures} failure(s)` : "\nall diff checks passed");
if (failures) imports.system.exit(1);
