// Render KiCad files to SVG from the command line (runs under gjs, no Node needed):
//
//   gjs -m tools/render.js <file.kicad_sch|file.kicad_pcb> <out.svg> [--theme dark] [--layers F.Cu,B.Cu]
//
// Used for visual regression checks against `kicad-cli ... export svg`.

import { readText, writeText } from "../tests/gjs-fs.js";

const argv = ARGV.slice();
const opt = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const theme = opt("--theme");
const layers = opt("--layers");
const side = opt("--side");
const face = opt("--face");
const [input, output] = argv;
if (!input || !output) {
  print("usage: gjs -m tools/render.js <file> <out.svg> [--theme name] [--layers L1,L2] [--side front|back] [--face front|back]");
  imports.system.exit(2);
}

const t0 = Date.now();
const text = readText(input);
let svg;
if (input.endsWith(".kicad_sch")) {
  const { parseSchematic } = await import("../src/sch/model.js");
  const { renderSchematic } = await import("../src/sch/render.js");
  const sch = parseSchematic(text, input);
  const t1 = Date.now();
  svg = renderSchematic(sch, { theme }).svg;
  print(`parsed in ${t1 - t0} ms, rendered in ${Date.now() - t1} ms`);
} else {
  const { parsePcb } = await import("../src/pcb/model.js");
  const { renderPcb } = await import("../src/pcb/render.js");
  const pcb = parsePcb(text, input);
  const t1 = Date.now();
  if (face) {
    const { boardFaceSvg } = await import("../src/pcb/texture.js");
    svg = boardFaceSvg(pcb, face).svg;
  } else svg = renderPcb(pcb, { theme, layers: layers ? layers.split(",") : undefined, side }).svg;
  print(`parsed in ${t1 - t0} ms, rendered in ${Date.now() - t1} ms`);
}
writeText(output, svg);
print(`${output}: ${(svg.length / 1024).toFixed(0)} KiB`);
