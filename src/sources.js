// What the pages share about project sources: forge sources come from the
// forge adapters (src/forge/), local folders are TauriSource in
// src/desktop/tauri.js. Every source exposes: kind, label, list(),
// readText(path), readBinary(path), url(path)?
// Here: rebuilding a file's old text from a patch, and finding 3D models.

import { joinPath } from "./project.js";
import { parseRepoSpec } from "./forge/index.js";

export { DIFFABLE, RULE_FILES } from "./project.js";

/**
 * A file's text before a change, rebuilt from its text after and the unified
 * diff the forge lists for it (a ChangedFile's `patch`), so the old
 * version needs no request of its own.
 * @param {string} after
 * @param {string} patch
 * @returns {string}
 */
export function textBeforePatch(after, patch) {
  const afterNewline = after.endsWith("\n");
  const lines = (afterNewline ? after.slice(0, -1) : after).split("\n");
  const out = [];
  let i = 0; // next line of `after`
  let inHunk = false, prev = "";
  // Whether the old text ends with a newline: as the new one, unless a
  // "\ No newline at end of file" marker says otherwise.
  let beforeNewline = afterNewline;
  for (const line of patch.split("\n")) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      // "+c,0" (lines only removed) means after line c; otherwise the hunk starts at line c.
      const start = m[2] === "0" ? Number(m[1]) : Number(m[1]) - 1;
      while (i < start) out.push(lines[i++]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) beforeNewline = prev === "+";
    else if (line.startsWith("+")) i++;
    else if (line.startsWith("-")) out.push(line.slice(1));
    else if (line.startsWith(" ")) out.push(lines[i++]);
    prev = line[0];
  }
  while (i < lines.length) out.push(lines[i++]);
  return out.join("\n") + (beforeNewline ? "\n" : "");
}

// ---- 3D model resolution -------------------------------------------------

const MODEL_EXT = /\.(wrl|step|stp)$/i;
const LIB_VAR = /^\$\{(KICAD\d*_3DMODEL_DIR|KISYS3DMOD)\}\/?/;
const LIB_VAR_NAME = /^(KICAD\d*_3DMODEL_DIR|KISYS3DMOD)$/;
const THIRD_PARTY_VAR = /^KICAD\d*_3RD_PARTY$/;
const modelFormat = (p) => (/\.wrl$/i.test(p) ? "wrl" : /\.(step|stp)$/i.test(p) ? "step" : null);
/** The same model under its other extensions, VRML first (lighter, and has KiCad's colours). */
const modelVariants = (p) => {
  const stem = p.replace(MODEL_EXT, "");
  return [...new Set([p, `${stem}.wrl`, `${stem}.step`, `${stem}.stp`])];
};
const urlPath = (p) => p.split("/").map(encodeURIComponent).join("/");

/** A folder on this computer: `/…`, `~/…`, `C:\…` or `\\server\…`. */
const LOCAL_DIR = /^(\/|~([\\/]|$)|[a-z]:[\\/]|\\\\)/i;

/**
 * A 3D model source from Settings: a URL prefix (e.g. a raw mirror of KiCad's
 * library), a forge repository (`owner/repo[@ref][:dir]` or its web address),
 * or a folder on this computer such as KiCad's installed library (desktop app only).
 */
export function parseModelSource(spec) {
  spec = spec.trim();
  if (!spec || spec.startsWith("#")) return null;
  if (LOCAL_DIR.test(spec)) return { kind: "dir", spec, path: spec };
  const repo = parseRepoSpec(spec);
  if (repo) return { kind: "repo", spec, forge: repo.forge, repo: repo.spec };
  if (/^https?:\/\//i.test(spec)) return { kind: "url", spec, base: spec.replace(/\/?$/, "/") };
  return null;
}

/** Model files of a source, indexed by lower-case file name, for finding models whatever folder they're in. */
async function modelIndex(source, dir = "") {
  const index = new Map();
  const prefix = dir ? dir.replace(/\/+$/, "") + "/" : "";
  for (const p of await source.list()) {
    if (!MODEL_EXT.test(p) || (prefix && !p.startsWith(prefix))) continue;
    const name = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
    if (!index.has(name)) index.set(name, []);
    index.get(name).push(p);
  }
  return index;
}

/** Paths in `index` holding the model `path` refers to, best match first (most trailing folders in common). */
function findByName(index, path) {
  const want = path.toLowerCase().split("/");
  const hits = [];
  for (const variant of modelVariants(want.at(-1))) {
    const found = index.get(variant) ?? [];
    const score = (p) => {
      const have = p.toLowerCase().split("/");
      let n = 1;
      while (n < want.length && n < have.length && want.at(-1 - n) === have.at(-1 - n)) n++;
      return n;
    };
    hits.push(...[...found].sort((a, b) => score(b) - score(a)));
  }
  return hits;
}

/**
 * Map a footprint's model path to the places it may be fetched from, tried in order
 * until one loads (an async iterable, so later sources are only listed if needed).
 * Each candidate is `{url, format, alt}`; `alt` marks the same model in another
 * format (a .step for a .wrl path), which KiCad itself wouldn't load.
 * Always the project first, then folders on this computer, then web sources
 * (URL prefixes, forge repositories), each group in the order of the list:
 *   ${KIPRJMOD}/x.step, relative/x.wrl  → that path in the project, then by name as below
 *   ${KICADn_3DMODEL_DIR}/..., absolute paths from the designer's machine, other variables
 *                                       → a file with that name anywhere in the project,
 *                                         then, for a variable the linked KiCad defines,
 *                                         that path in its folder, then the library-relative
 *                                         path and the file name in each model source
 * @param {object} source project source
 * @param {string} projectDir
 * @param {string[]} modelSources URL prefixes, forge repositories and folders (folders go first)
 * @param {{tokenFor?: (forge: object) => string|null, onSourceError?: (spec: string, err: Error) => void,
 *   openDir?: (path: string) => object, pathVars?: Record<string, string>}} [opts] `openDir` makes
 *   a source (list/readBinary) for a folder model source; without it (in a browser) folder sources
 *   are skipped with an error. `pathVars` are the linked KiCad's path variables (name → folder);
 *   its library and third-party folders are also searched, after the folders in `modelSources`.
 */
export function makeModelResolver(source, projectDir, modelSources = [], { tokenFor = () => null, onSourceError = null, openDir = null, pathVars = {} } = {}) {
  const blobCache = new Map();
  // A local folder is faster and works offline, so it goes before any web source.
  const parsed = modelSources.map(parseModelSource).filter(Boolean);
  const dirs = parsed.filter((m) => m.kind === "dir");
  // Only KiCad's model library and add-ons are searched by name: the user's own
  // variables may point at large folders, so those are only used for exact paths.
  for (const [name, path] of Object.entries(pathVars)) {
    if ((LIB_VAR_NAME.test(name) || THIRD_PARTY_VAR.test(name)) && !dirs.some((m) => m.path === path)) dirs.push({ kind: "dir", spec: path, path });
  }
  const sources = [...dirs, ...parsed.filter((m) => m.kind !== "dir")];
  // ${KICAD9_3DMODEL_DIR} in a board made with another version: KiCad's own library still has it.
  const varDir = (name) =>
    pathVars[name] ??
    (LIB_VAR_NAME.test(name) ? Object.entries(pathVars).find(([k]) => LIB_VAR_NAME.test(k))?.[1] : null) ??
    (THIRD_PARTY_VAR.test(name) ? Object.entries(pathVars).find(([k]) => THIRD_PARTY_VAR.test(k))?.[1] : null);
  const dirSources = new Map(); // folder → source, for exact paths
  const opened = new Map(); // spec → Promise<{source, dir, index}|null> for repositories and folders
  let projectIndex = null;

  /** null when the file can't be read, so the next candidate is tried. */
  const fetchable = async (src, hit) => {
    const format = modelFormat(hit);
    let url = src.url?.(hit);
    if (!url) {
      const key = `${src.label}\n${hit}`;
      if (!blobCache.has(key)) blobCache.set(key, src.readBinary(hit).then((b) => URL.createObjectURL(new Blob([b])), () => null));
      url = await blobCache.get(key);
    }
    return url ? { url, format } : null;
  };
  /** A source that can be listed (repository or folder), opened once and indexed by file name. */
  const openListed = (m) => {
    if (!opened.has(m.spec)) {
      opened.set(
        m.spec,
        (async () => {
          if (m.kind === "dir") {
            if (!openDir) throw new Error("folders work only in the desktop app");
            const src = openDir(m.path);
            return { source: src, dir: "", index: await modelIndex(src) };
          }
          const src = await m.forge.open(m.repo, tokenFor(m.forge));
          return { source: src, dir: src.dir, index: await modelIndex(src, src.dir) };
        })().catch((e) => {
          console.warn(`3D model source ${m.spec}: ${e.message}`);
          onSourceError?.(m.spec, e);
          return null;
        }),
      );
    }
    return opened.get(m.spec);
  };

  /** `${NAME}/rel` where the linked KiCad puts NAME; read directly, so the folder isn't listed. */
  async function* inVarDir(name, rel) {
    const dir = varDir(name);
    if (!dir || !openDir || !rel) return;
    if (!dirSources.has(dir)) dirSources.set(dir, openDir(dir));
    for (const v of modelVariants(rel)) yield fetchable(dirSources.get(dir), v);
  }

  async function* inProject(path) {
    projectIndex ??= modelIndex(source).catch(() => new Map());
    for (const hit of findByName(await projectIndex, path)) yield fetchable(source, hit);
  }
  async function* inSources(rel, path) {
    for (const m of sources) {
      if (m.kind === "url") {
        // A URL prefix can't be listed: only library-relative paths can be tried.
        // VRML first: KiCad's library has both, and VRML is lighter and carries KiCad's colours.
        if (rel) {
          const stem = rel.replace(MODEL_EXT, "");
          for (const v of new Set([`${stem}.wrl`, rel])) yield { url: m.base + urlPath(v), format: modelFormat(v) };
        }
        continue;
      }
      const repo = await openListed(m);
      if (!repo) continue;
      const tried = new Set();
      if (rel) {
        const files = new Set(await repo.source.list());
        for (const v of modelVariants(joinPath(repo.dir, rel))) {
          if (!files.has(v)) continue;
          tried.add(v);
          yield fetchable(repo.source, v);
        }
      }
      for (const hit of findByName(repo.index, path)) if (!tried.has(hit)) yield fetchable(repo.source, hit);
    }
  }

  return async function* resolve(rawPath) {
    const want = modelFormat(rawPath);
    const seen = new Set(); // an exact path in KiCad's folder is also found by the search after it
    for await (const c of candidates(rawPath)) {
      if (!c || seen.has(c.url)) continue;
      seen.add(c.url);
      yield { ...c, alt: !!want && c.format !== want };
    }
  };

  async function* candidates(rawPath) {
    const path = rawPath.replace(/\\/g, "/");
    const libVar = LIB_VAR.exec(path);
    if (libVar) {
      const rel = path.slice(libVar[0].length);
      yield* inProject(path); // a copy shipped with the project beats any library
      yield* inVarDir(libVar[1], rel);
      yield* inSources(rel, path);
      return;
    }
    const local = path.replace(/^\$\{KIPRJMOD\}\/?/, "");
    if (!/^\$\{/.test(local) && !/^([a-z]:|\/)/i.test(local)) {
      // Relative to the project, as KiCad would load it.
      const list = new Set(await source.list());
      for (const v of modelVariants(joinPath(projectDir, local))) if (list.has(v)) yield fetchable(source, v);
    }
    // Absolute path or another variable: look for the file by name.
    const custom = /^\$\{([^}]+)\}\/?(.*)$/.exec(local);
    yield* inProject(path);
    if (custom) yield* inVarDir(custom[1], custom[2]);
    yield* inSources(custom ? custom[2] : null, path);
  }
}
