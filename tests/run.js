// Test runner (gjs): parses and renders every KiCad project found under the
// given directories, checks invariants, and reports timings.
//
//   gjs -m tests/run.js [dir ...]      (default: KiCad's demos, see tools/fetch_demos.py)

import { readText, listDir, kicadDemos } from "./gjs-fs.js";
import { parse } from "../src/sexpr.js";
import { findProjects, loadProject, pageRenderOptions } from "../src/project.js";
import { renderSchematic } from "../src/sch/render.js";
import { renderPcb } from "../src/pcb/render.js";
import { multiply, rotate, scale, translate, apply } from "../src/geom.js";
import { libSymbolFor } from "../src/sch/model.js";
import { netSide } from "../src/pcb/model.js";

let failures = 0;
const check = (cond, msg) => {
  if (!cond) {
    failures++;
    print(`  FAIL ${msg}`);
  }
};

// ---- unit checks ----

{
  // Cross-probing a net shows the side most of its copper is on.
  const pad = (net, layers) => ({ net, layers });
  const board = {
    footprints: [{ pads: [pad("A", ["F.Cu", "F.Mask"]), pad("A", ["*.Cu"]), pad("B", ["B.Cu"]), pad("C", ["*.Cu"])] }],
    tracks: [{ net: "A", layer: "B.Cu" }, { net: "A", layer: "F.Cu" }, { net: "B", layer: "In1.Cu" }, { net: "C", layer: "In2.Cu" }],
  };
  check(netSide(board, "A") === "front", "netSide: SMD pad and track on F.Cu outweigh one B.Cu track");
  check(netSide(board, "B") === "back", "netSide: B.Cu pad, inner track ignored");
  check(netSide(board, "C") === null, "netSide: through-hole and inner layers only → no side");
  check(netSide(board, "D") === null, "netSide: unknown net → no side");
}
{
  const t = parse('(a 1 -2.5 "3" b (c "x\\"y") (d))');
  check(t[0] === "a" && t[1] === 1 && t[2] === -2.5 && t[3] === "3" && t[4] === "b", "sexpr atoms");
  check(t[5][1] === 'x"y' && Array.isArray(t[6]) && t[6].length === 1, "sexpr strings/lists");
  const p = apply(rotate(90), 1, 0);
  check(Math.abs(p.x) < 1e-9 && Math.abs(p.y + 1) < 1e-9, "rotate(90) turns +x to screen-up");
}

function walk(dir, out = []) {
  for (const e of listDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.dir) {
      if (!e.name.endsWith("-backups")) walk(p, out);
    } else out.push(p);
  }
  return out;
}

const dirs = ARGV.length ? ARGV : [kicadDemos()];
const maxBytes = 20e6; // skip the multi-ten-MB boards in the default run
for (const dir of dirs) {
  const files = walk(dir);
  const source = { list: async () => files, readText: async (p) => readText(p) };
  for (const entry of findProjects(files)) {
    const t0 = Date.now();
    let project;
    try {
      const big = entry.pcb && (await import("gi://GLib")).default.file_test(entry.pcb, 1) && readSize(entry.pcb) > maxBytes;
      project = await loadProject(source, big ? { ...entry, pcb: null } : entry);
    } catch (e) {
      check(false, `${entry.name}: load threw ${e.message}`);
      continue;
    }
    for (const err of project.errors) check(false, `${entry.name}: ${err}`);
    const t1 = Date.now();
    let pins = 0, connected = 0, symbols = 0;
    for (const page of project.pages) {
      const r = renderSchematic(page.sch, pageRenderOptions(project, page));
      check(r.svg.startsWith("<svg") && r.svg.endsWith("</svg>"), `${page.file}: svg envelope`);
      check(!/NaN|undefined/.test(r.svg.replace(/href="data:[^"]*"/g, "")), `${page.file}: NaN/undefined in svg`);
      for (const it of r.items) {
        if (it.kind !== "symbol") continue;
        symbols++;
        check(!it.reference.includes("?") || it.reference === "?", `${page.file}: unresolved ref ${it.reference}`);
      }
      // Connectivity sanity: most visible pins land on a wire/label/pin.
      const sch = page.sch, pts = new Set();
      const k = (x, y) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
      for (const w of [...sch.wires, ...sch.buses]) for (const p of w.pts) pts.add(k(p.x, p.y));
      for (const l of sch.labels) pts.add(k(l.x, l.y));
      for (const n of [...sch.noConnects, ...sch.junctions]) pts.add(k(n.x, n.y));
      const counts = new Map();
      const pinPts = [];
      for (const s of sch.symbols) {
        const lib = libSymbolFor(sch, s);
        if (!lib) continue;
        const m = multiply(translate(s.x, s.y), multiply(s.mirror === "x" ? scale(1, -1) : s.mirror === "y" ? scale(-1, 1) : scale(1, 1), rotate(s.angle)));
        for (const u of lib.units) {
          if ((u.unit && u.unit !== s.unit) || (u.bodyStyle && u.bodyStyle !== (s.bodyStyle || 1))) continue;
          for (const p of u.pins) {
            const q = apply(m, p.x, p.y);
            pinPts.push(q);
            counts.set(k(q.x, q.y), (counts.get(k(q.x, q.y)) ?? 0) + 1);
          }
        }
      }
      for (const q of pinPts) {
        pins++;
        if (pts.has(k(q.x, q.y)) || counts.get(k(q.x, q.y)) > 1) connected++;
      }
    }
    const t2 = Date.now();
    let pcbInfo = "";
    if (project.pcb) {
      const r = renderPcb(project.pcb);
      check(!/NaN|undefined/.test(r.svg), `${entry.name}: NaN/undefined in pcb svg`);
      check(r.items.length === project.pcb.footprints.length, `${entry.name}: footprint items`);
      pcbInfo = `pcb ${project.pcb.footprints.length} fp, ${project.pcb.tracks.length} tracks, ${(r.svg.length / 1e6).toFixed(1)} MB svg`;
    }
    const ratio = pins ? (100 * connected) / pins : 100;
    check(ratio > 80, `${entry.name}: only ${ratio.toFixed(0)}% of pins connect`);
    print(`${entry.name.padEnd(28)} ${String(project.pages.length).padStart(3)} pages ${String(symbols).padStart(5)} sym  pins ${ratio.toFixed(0)}%  ${pcbInfo}  [load ${t1 - t0} ms, sch ${t2 - t1} ms, pcb ${Date.now() - t2} ms]`);
  }
}

function readSize(path) {
  return readText(path).length;
}

print(failures ? `\n${failures} failure(s)` : "\nall checks passed");
if (failures) imports.system.exit(1);
