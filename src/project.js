// KiCad project loading: hierarchy walk over schematic sheets plus the board.
//
// Files are read through a "source" object so the same code works for local
// folders, dropped files and GitHub repositories:
//   source.list()            → Promise<string[]>  all file paths (posix, relative)
//   source.readText(path)    → Promise<string>
//   source.readBinary?(path) → Promise<Uint8Array>

import { parseSchematic } from "./sch/model.js";
import { parsePcb } from "./pcb/model.js";
import { parseDrawingSheet } from "./drawing-sheet.js";

export function dirname(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function joinPath(dir, rel) {
  const parts = (dir ? dir.split("/") : []).concat(rel.replace(/\\/g, "/").split("/"));
  const out = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return (dir.startsWith("/") ? "/" : "") + out.join("/");
}

/** Find KiCad projects among a list of paths. */
export function findProjects(paths) {
  const projects = [];
  const pros = paths.filter((p) => p.endsWith(".kicad_pro"));
  for (const pro of pros) {
    const base = pro.slice(0, -".kicad_pro".length);
    projects.push({
      name: base.split("/").pop(),
      dir: dirname(pro),
      pro,
      sch: paths.includes(base + ".kicad_sch") ? base + ".kicad_sch" : null,
      pcb: paths.includes(base + ".kicad_pcb") ? base + ".kicad_pcb" : null,
    });
  }
  // Loose files without a .kicad_pro are still viewable.
  if (!projects.length) {
    const sch = paths.filter((p) => p.endsWith(".kicad_sch"));
    const pcb = paths.filter((p) => p.endsWith(".kicad_pcb"));
    const bases = new Set([...sch, ...pcb].map((p) => p.replace(/\.kicad_(sch|pcb)$/, "")));
    for (const base of bases) {
      projects.push({ name: base.split("/").pop(), dir: dirname(base), pro: null, sch: sch.includes(base + ".kicad_sch") ? base + ".kicad_sch" : null, pcb: pcb.includes(base + ".kicad_pcb") ? base + ".kicad_pcb" : null });
    }
    // Prefer the schematic that no other schematic references (the root):
    // handled later by the hierarchy walk, so keep them all.
  }
  return projects.sort((a, b) => a.pro?.length - b.pro?.length || a.name.localeCompare(b.name));
}

/**
 * Load a project.
 * @param {object} source  file source (see top of file)
 * @param {object} entry   one element of findProjects()
 * @param {object} [opts]  {onProgress(msg)}
 */
export async function loadProject(source, entry, opts = {}) {
  const progress = opts.onProgress ?? (() => {});
  const project = {
    name: entry.name,
    dir: entry.dir,
    settings: {},
    textVars: {},
    pages: [],
    schematics: new Map(), // file path → parsed schematic
    pcb: null,
    drawingSheet: null,
    errors: [],
  };

  if (entry.pro) {
    try {
      project.settings = JSON.parse(await source.readText(entry.pro));
      project.textVars = project.settings.text_variables ?? {};
    } catch (e) {
      project.errors.push(`${entry.pro}: ${e.message}`);
    }
  }

  // Custom drawing sheet (if the project points at one inside the repo).
  const wks = project.settings?.schematic?.page_layout_descr_file;
  if (wks && !wks.includes("${")) {
    try {
      project.drawingSheet = parseDrawingSheet(await source.readText(joinPath(entry.dir, wks)));
    } catch {
      /* fall back to the default sheet */
    }
  }

  if (entry.sch) {
    progress("Reading schematics…");
    await loadHierarchy(source, project, entry.sch);
  }
  if (entry.pcb) {
    progress("Reading board…");
    try {
      project.pcb = parsePcb(await source.readText(entry.pcb), entry.pcb);
    } catch (e) {
      project.errors.push(`${entry.pcb}: ${e.message}`);
    }
  }
  return project;
}

async function loadHierarchy(source, project, rootFile) {
  const cache = project.schematics;
  const read = async (file) => {
    if (!cache.has(file)) {
      try {
        cache.set(file, parseSchematic(await source.readText(file), file));
      } catch (e) {
        project.errors.push(`${file}: ${e.message}`);
        cache.set(file, null);
      }
    }
    return cache.get(file);
  };

  const root = await read(rootFile);
  if (!root) return;
  const rootPath = root.uuid ? `/${root.uuid}` : "/";
  const legacy = root.legacySymbolInstances.size ? root.legacySymbolInstances : null;
  const legacyPages = root.sheetInstances;

  // Depth-first walk keeps KiCad's natural page order before sorting.
  const walk = async (file, sch, path, legacyPath, sheetName, sheetPathName, parentSheet, depth) => {
    let page = parentSheet?.pages.find((p) => p.path === parentPath(path))?.page ?? (depth === 0 ? "1" : "");
    if (!page && legacyPages.size) page = legacyPages.get(legacyPath || "/")?.page ?? "";
    project.pages.push({ file, sch, path, legacyPath, name: sheetName, sheetPath: sheetPathName, page, depth, children: [] });
    if (depth > 32) return; // recursion guard
    for (const s of sch.sheets) {
      const childFile = joinPath(dirname(file), s.file);
      const childSch = await read(childFile);
      if (!childSch) continue;
      await walk(childFile, childSch, `${path === "/" ? "" : path}/${s.uuid}`, `${legacyPath}/${s.uuid}`, s.name, `${sheetPathName}${s.name}/`, s, depth + 1);
    }
  };
  await walk(rootFile, root, rootPath, "", "Root", "/", null, 0);

  // Assign missing page numbers sequentially, then sort like KiCad does.
  project.pages.forEach((p, i) => {
    if (!p.page) p.page = String(i + 1);
  });
  const pageNum = (p) => (/^\d+$/.test(p.page) ? Number(p.page) : Infinity);
  project.pages.sort((a, b) => pageNum(a) - pageNum(b));
  project.pageCount = project.pages.length;
  project.legacyInstances = legacy;

  // Global label name → pages where it appears (for ${INTERSHEET_REFS}).
  const refs = new Map();
  for (const p of project.pages) {
    for (const l of p.sch.labels) {
      if (l.kind !== "global_label") continue;
      const list = refs.get(l.text) ?? [];
      if (!list.includes(p.page)) list.push(p.page);
      refs.set(l.text, list);
    }
  }
  project.intersheetRefs = refs;
}

function parentPath(path) {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/** Options for renderSchematic() for a given page of the project. */
export function pageRenderOptions(project, page, extra = {}) {
  return {
    path: page.path,
    legacyInstances: project.legacyInstances,
    legacyPath: page.legacyPath,
    intersheetRefs: project.intersheetRefs,
    drawingSheet: project.drawingSheet ?? undefined,
    vars: {
      ...project.textVars,
      "#": page.page,
      "##": String(project.pageCount),
      SHEETPATH: page.sheetPath,
      SHEETNAME: page.name,
      PROJECTNAME: project.name,
      FILENAME: page.file.split("/").pop(),
    },
    ...extra,
  };
}
