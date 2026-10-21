// 3D model resolution order (gjs, no network): project paths, file-name search
// in the project, URL model sources and model folders on this computer.
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
check("library variable → project first, then URL sources (VRML first)", await all("${KICAD9_3DMODEL_DIR}/Conn.3dshapes/USB_C.step"), [
  "proj:3d_lib/USB_C.step",
  "proj:3d_lib/vendor/USB_C.wrl",
  "https://lib.example/3d/Conn.3dshapes/USB_C.wrl",
  "https://lib.example/3d/Conn.3dshapes/USB_C.step",
  "https://mirror.example/Conn.3dshapes/USB_C.wrl",
  "https://mirror.example/Conn.3dshapes/USB_C.step",
]);
check("unknown model", await all("/home/me/nothing.step"), []);

// A model folder on this computer (KiCad's installed library), read through openDir.
const libFiles = ["Resistor_SMD.3dshapes/R_0402_1005Metric.step", "Connector_USB.3dshapes/USB_C.step", "Vendor/Odd.wrl"];
const opened = [];
const openDir = (path) => {
  opened.push(path);
  return { label: path, list: async () => libFiles, readBinary: async (p) => new Uint8Array([1]), url: (p) => `dir:${path}:${p}` };
};
const withDir = makeModelResolver(source, "hw", ["/usr/share/kicad/3dmodels", "https://lib.example/3d/"], { openDir });
const allDir = async (path) => {
  const out = [];
  for await (const c of withDir(path)) if (c) out.push(c.url);
  return out;
};
check("library variable → folder first (STEP for a .wrl path), then URL sources, then project", await allDir("${KICAD8_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.wrl"), [
  "dir:/usr/share/kicad/3dmodels:Resistor_SMD.3dshapes/R_0402_1005Metric.step",
  "https://lib.example/3d/Resistor_SMD.3dshapes/R_0402_1005Metric.wrl",
]);
check("absolute path from another machine → by name in the folder", (await allDir("/Users/me/lib/Odd.wrl"))[0], "dir:/usr/share/kicad/3dmodels:Vendor/Odd.wrl");
check("folder listed once", opened, ["/usr/share/kicad/3dmodels"]);
const webFirst = makeModelResolver(source, "hw", ["https://lib.example/3d/", "/usr/share/kicad/3dmodels"], { openDir });
const order = [];
for await (const c of webFirst("${KICAD8_3DMODEL_DIR}/Connector_USB.3dshapes/USB_C.step")) if (c) order.push(c.url);
check("project, then a folder even when listed after a web source, then the web", order, [
  "proj:3d_lib/USB_C.step",
  "proj:3d_lib/vendor/USB_C.wrl",
  "dir:/usr/share/kicad/3dmodels:Connector_USB.3dshapes/USB_C.step",
  "https://lib.example/3d/Connector_USB.3dshapes/USB_C.wrl",
  "https://lib.example/3d/Connector_USB.3dshapes/USB_C.step",
]);
const flags = [];
for await (const c of withDir("${KICAD8_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.wrl")) flags.push(c.alt);
check("another format is marked as a stand-in (alt), the named one isn't", flags, [true, false]);
const errors = [];
const noDesktop = makeModelResolver(source, "hw", ["C:\\KiCad\\3dmodels", "https://lib.example/3d/"], { onSourceError: (spec) => errors.push(spec) });
const firstNoDesktop = [];
for await (const c of noDesktop("${KICAD9_3DMODEL_DIR}/A.3dshapes/B.step")) if (c) firstNoDesktop.push(c.url);
check("folder without the desktop app → skipped with an error, URL sources still tried", [errors, firstNoDesktop[0]], [["C:\\KiCad\\3dmodels"], "https://lib.example/3d/A.3dshapes/B.wrl"]);

// A linked KiCad (Settings → KiCad): its path variables point at exact folders.
const kicadFiles = {
  "/kicad/3dmodels": ["Package_SO.3dshapes/SOIC-8.step"],
  "/kicad/3rdparty": ["3dmodels/com_github_x/Lib.3dshapes/Part.step"],
  "/mine": ["sub/Mine.wrl"],
};
const kicadOpened = [];
const kicadDir = (path) => {
  kicadOpened.push(path);
  const has = (p) => (kicadFiles[path] ?? []).includes(p);
  return { label: path, list: async () => kicadFiles[path] ?? [], readBinary: async (p) => Promise.reject(new Error(`no ${p}`)), url: (p) => (has(p) ? `kicad:${path}:${p}` : null) };
};
const pathVars = { KICAD10_3DMODEL_DIR: "/kicad/3dmodels", KICAD10_3RD_PARTY: "/kicad/3rdparty", MY_MODELS: "/mine" };
const linked = makeModelResolver(source, "hw", ["https://lib.example/3d/"], { openDir: kicadDir, pathVars });
const allLinked = async (path) => {
  const out = [];
  for await (const c of linked(path)) if (c) out.push(c.url);
  return out;
};
check("linked KiCad: library variable of another version → KiCad's library, then the web", await allLinked("${KICAD8_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.wrl"), [
  "kicad:/kicad/3dmodels:Package_SO.3dshapes/SOIC-8.step",
  "https://lib.example/3d/Package_SO.3dshapes/SOIC-8.wrl",
]);
check("linked KiCad: add-on library", (await allLinked("${KICAD10_3RD_PARTY}/3dmodels/com_github_x/Lib.3dshapes/Part.step"))[0], "kicad:/kicad/3rdparty:3dmodels/com_github_x/Lib.3dshapes/Part.step");
check("linked KiCad: the user's own variable, exact path", (await allLinked("${MY_MODELS}/sub/Mine.wrl"))[0], "kicad:/mine:sub/Mine.wrl");
check("linked KiCad: the user's own folders aren't listed, KiCad's are", [...new Set(kicadOpened)].sort(), ["/kicad/3dmodels", "/kicad/3rdparty", "/mine"]);

check("source: Linux folder", parseModelSource("/usr/share/kicad/3dmodels")?.kind, "dir");
check("source: home folder", parseModelSource("~/kicad/3dmodels")?.kind, "dir");
check("source: Windows folder", parseModelSource("C:\\Program Files\\KiCad\\9.0\\share\\kicad\\3dmodels")?.kind, "dir");
check("source: network share", parseModelSource("\\\\server\\models")?.kind, "dir");
check("source: owner/repo", parseModelSource("me/models@main:3d")?.kind, "repo");
check("source: github.com link", parseModelSource("https://github.com/me/models/tree/main/3d")?.kind, "repo");
check("source: raw URL prefix", parseModelSource("https://raw.githubusercontent.com/KiCad/kicad-packages3D/master/")?.kind, "url");
check("source: comment", parseModelSource("# off"), null);

print(failures ? `${failures} failed` : "all passed");
if (failures) imports.system.exit(1);
