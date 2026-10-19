// Schematic connectivity check (gjs): every schematic net with ≥2 component
// pins must map to exactly one board net via the footprint pads.
//   gjs -m tests/nets.js [dir ...]

import { readText, listDir, kicadDemos } from "./gjs-fs.js";
import { findProjects, loadProject, pageRenderOptions } from "../src/project.js";
import { renderSchematic } from "../src/sch/render.js";
import { buildConnectivity, boardNetFor } from "../src/sch/connectivity.js";

function walk(dir, out = []) {
  for (const e of listDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.dir) {
      if (!e.name.endsWith("-backups")) walk(p, out);
    } else out.push(p);
  }
  return out;
}

let failures = 0;
const dirs = ARGV.length ? ARGV : [kicadDemos()];
for (const dir of dirs) {
  const files = walk(dir);
  const source = { list: async () => files, readText: async (p) => readText(p) };
  for (const entry of findProjects(files)) {
    if (!entry.pcb || !entry.sch || readText(entry.pcb).length > 20e6) continue;
    const project = await loadProject(source, entry);
    if (!project.pcb) continue;
    let nets = 0, consistent = 0, mapped = 0, bad = [];
    for (const page of project.pages) {
      const r = renderSchematic(page.sch, pageRenderOptions(project, page));
      const conn = buildConnectivity(page.sch, r.items);
      for (const g of conn.groups) {
        const pins = g.pins.filter((p) => !p.power);
        const padNets = new Set();
        for (const p of pins) {
          const fp = project.pcb.footprints.find((f) => f.reference === p.ref);
          const pad = fp?.pads.find((q) => q.number === p.number);
          if (pad?.net && !pad.net.startsWith("unconnected-")) padNets.add(pad.net);
        }
        if (padNets.size === 0) continue;
        nets++;
        if (boardNetFor(g, project.pcb)) mapped++;
        if (padNets.size === 1) consistent++;
        else if (bad.length < 3) bad.push(`${page.file.split("/").pop()}: ${g.name ?? "?"} → ${[...padNets].join(" | ")}`);
      }
    }
    const pct = nets ? (100 * consistent) / nets : 100;
    const ok = pct >= 98;
    if (!ok) failures++;
    print(`${ok ? "  ok  " : "  FAIL"} ${entry.name.padEnd(28)} ${nets} nets, ${pct.toFixed(1)}% single board net, ${mapped} mapped`);
    for (const b of bad) print(`         ${b}`);
  }
}
print(failures ? `\n${failures} failure(s)` : "\nall net checks passed");
if (failures) imports.system.exit(1);
