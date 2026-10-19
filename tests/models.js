// 3D model resolution order (gjs, no network): project paths, file-name search
// in the project, and URL model sources.
//   gjs -m tests/models.js

import { makeModelResolver, parseModelSource } from "../src/sources.js";

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  print(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`);
};

const files = [
  "hw/board.kicad_pcb",
  "hw/models/local.step",
  "3d_lib/USB_C.step",
  "3d_lib/vendor/USB_C.wrl",
  "other/Thing.wrl",
];
const source = { label: "test", list: async () => files, url: (p) => `proj:${p}` };
const resolve = makeModelResolver(source, "hw", ["https://lib.example/3d/", "# a comment", "https://mirror.example"]);
const all = async (path) => {
  const out = [];
  for await (const c of resolve(path)) if (c) out.push(c.url);
  return out;
};

check("relative to the project", (await all("${KIPRJMOD}/models/local.step"))[0], "proj:hw/models/local.step");
check("relative path, other extension", (await all("models/local.wrl"))[0], "proj:hw/models/local.step");
check(
  "absolute Windows path → by name in the project, same extension first",
  await all("C:\\Users\\me\\kicad\\3d_lib\\vendor\\USB_C.step"),
  ["proj:3d_lib/USB_C.step", "proj:3d_lib/vendor/USB_C.wrl"],
);
check("same name in several folders → closest folder first", await all("D:/lib/other/Thing.wrl"), ["proj:other/Thing.wrl"]);
check("custom variable → project, then URL sources", await all("${MY_MODELS}/x/Thing.wrl"), [
  "proj:other/Thing.wrl",
  "https://lib.example/3d/x/Thing.wrl",
  "https://mirror.example/x/Thing.wrl",
]);
check("library variable → URL sources (VRML first), then project", await all("${KICAD9_3DMODEL_DIR}/Conn.3dshapes/USB_C.step"), [
  "https://lib.example/3d/Conn.3dshapes/USB_C.wrl",
  "https://lib.example/3d/Conn.3dshapes/USB_C.step",
  "https://mirror.example/Conn.3dshapes/USB_C.wrl",
  "https://mirror.example/Conn.3dshapes/USB_C.step",
  "proj:3d_lib/USB_C.step",
  "proj:3d_lib/vendor/USB_C.wrl",
]);
check("unknown model", await all("/home/me/nothing.step"), []);

check("source: owner/repo", parseModelSource("me/models@main:3d")?.kind, "repo");
check("source: github.com link", parseModelSource("https://github.com/me/models/tree/main/3d")?.kind, "repo");
check("source: raw URL prefix", parseModelSource("https://raw.githubusercontent.com/KiCad/kicad-packages3D/master/")?.kind, "url");
check("source: comment", parseModelSource("# off"), null);

print(failures ? `${failures} failed` : "all passed");
if (failures) imports.system.exit(1);
