// Prelude for the README screenshots (tools/screenshots.sh runs it after
// tests/tauri-mock.js). No network and no sign-in: GitHub and the desktop app
// are answered from the KiCad demo files the tests use.
//
// - GitHub (fetch to api.github.com / raw.githubusercontent.com):
//   XyleMora/cm5_minima_test_repo holds the cm5_minima demo on main, and pull
//   request #1 whose head applies EDITS below, with one KiVi review comment,
//   and four change requests (issues labelled kivi), #9 fixed by the PR;
//   KiCad/kicad-source-mirror holds the demo projects under demos/.
// - Local mode (diff.html#local=…): a copy of cm5_minima whose working files
//   carry EDITS (git_local_changes, git_read, …).
// - A linked KiCad 10 whose 3D library is served at /kicad3d/ (list_model_dir,
//   read_model_file).
//
// The web root (made by screenshots.sh) has the repository's pages plus
// shots/files.json (file lists) and kicad3d/ (KiCad's 3D model folder).

const DEMOS = "/tests/kicad-demos/";
const TEST_REPO = "XyleMora/cm5_minima_test_repo";
const MIRROR = "KiCad/kicad-source-mirror";
const BASE_SHA = "69af933c2f4e8d1b6a0e5f7c3d9b2a1e4f6c8d0a";
const HEAD_SHA = "1651d99b7e3a4c2f8d0b6e1a9c5f3d7b2e4a6c8f";
const PR_BRANCH = "fix/footprints-and-symbols";
const PR_TITLE = "Update U405 footprint, fix LED polarity and U701 GND pin type";
const HOURS = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const ME = { login: "XyleMora", avatar_url: "https://github.com/XyleMora.png?v=4" };

// ---- the fixes a designer would make (the PR head, and the local copy's working files) ----

/** [start, end) of the list that opens at `start`. */
function listAt(t, start) {
  let depth = 0, inStr = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return [start, i + 1];
  }
  throw new Error("unbalanced");
}
const editList = (t, start, fn) => {
  const [s, e] = listAt(t, start);
  return t.slice(0, s) + fn(t.slice(s, e)) + t.slice(e);
};
const footprint = (t, ref, fn) => editList(t, t.lastIndexOf("(footprint ", t.indexOf(`(property "Reference" "${ref}"`)), fn);
const libSymbol = (t, name, fn) => editList(t, t.indexOf(`(symbol "${name}"`, t.indexOf("(lib_symbols")), fn);

const EDITS = {
  "CM5_MINIMA_3.kicad_pcb": (t) => {
    // U405 updated from a corrected library footprint: longer pads, a mask
    // override on pad 1, a STEP model instead of the VRML, a pin-1 silk mark beside pad 1.
    t = footprint(t, "U405", (b) => {
      b = b.replaceAll("(size 1.325 0.6)", "(size 1.475 0.6)");
      b = b.replace(/(\(pad "1" smd \w+[\s\S]*?\(size [^)]*\))/, "$1\n\t\t\t(solder_mask_margin 0.05)");
      b = b.replace(/\$\{KICAD8_3DMODEL_DIR\}(\/Package_TO_SOT_SMD\.3dshapes\/SOT-23-5)\.wrl/, "${KICAD9_3DMODEL_DIR}$1.step");
      return b.replace(/\n(\t+)\(pad /, '\n$1(fp_line (start -2.15 -1.25) (end -2.15 -0.65) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))\n$1(pad ');
    });
    // M701: mounting hole drilled for an M3 screw with clearance.
    return footprint(t, "M701", (b) => b.replace("(drill 2.95)", "(drill 3.25)"));
  },
  // The power switch's GND pin was typed as a power output: ERC can't see a missing ground.
  "USB.kicad_sch": (t) => libSymbol(t, "CM5IO:AP2553W6", (b) => b.replace(/\(pin power_out line(\s*\(at -8\.89 0 0\))/, "(pin power_in line$1")),
  // LED anode and cathode numbers were swapped in the library: a polarity fix.
  "IO.kicad_sch": (t) => libSymbol(t, "CM5IO:LED", (b) => b.replace('(number "1"', '(number "X"').replace('(number "2"', '(number "1"').replace('(number "X"', '(number "2"')),
};

// ---- files ----

const realFetch = window.fetch.bind(window);
const lists = realFetch("/shots/files.json").then((r) => r.json()); // {cm5: [paths], demos: [{path, sha, size}]}
const fileCache = new Map();
const demoText = (path) => {
  if (!fileCache.has(path)) fileCache.set(path, realFetch(DEMOS + path).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${path}: ${r.status}`)))));
  return fileCache.get(path);
};
/** A cm5_minima file as bytes, at main or with the fixes (head / working files). */
async function cm5File(path, fixed) {
  const buf = await demoText(`cm5_minima/${path}`);
  if (!fixed || !EDITS[path]) return buf;
  return new TextEncoder().encode(EDITS[path](new TextDecoder().decode(buf))).buffer;
}
/** A stable fake blob SHA, different for a fixed file. */
const blobSha = (path, fixed) => {
  let h = 2166136261;
  for (const c of `${path}|${fixed && EDITS[path] ? "fixed" : ""}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return (h.toString(16).padStart(8, "0") + "0".repeat(32)).slice(0, 40);
};

// ---- GitHub ----

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const notFound = () => json({ message: "Not Found" }, 404);
const REPOS = {
  // Older than the mirror, so its CM5 card sorts after the mirror's demo projects.
  [TEST_REPO]: { default_branch: "main", pushed_at: HOURS(24 * 20), description: "CM5 MINIMA carrier board" },
  [MIRROR]: { default_branch: "master", pushed_at: HOURS(30), description: "Mirror of the KiCad source code" },
};
const repoJson = (nwo) => {
  const [owner, name] = nwo.split("/");
  return { id: nwo.length, name, full_name: nwo, private: false, owner: { login: owner, avatar_url: ME.avatar_url }, html_url: `https://github.com/${nwo}`, ...REPOS[nwo] };
};
const testRef = (ref) => (ref === HEAD_SHA || ref === PR_BRANCH ? HEAD_SHA : ref === BASE_SHA || ref === "main" ? BASE_SHA : null);
const commitJson = (sha) => ({
  sha,
  html_url: `https://github.com/${TEST_REPO}/commit/${sha}`,
  commit: { message: sha === HEAD_SHA ? PR_TITLE : "CM5 MINIMA 3.1", author: { name: "XyleMora", date: HOURS(sha === HEAD_SHA ? 2 : 50) } },
  author: ME,
  parents: sha === HEAD_SHA ? [{ sha: BASE_SHA }] : [],
  files: sha === HEAD_SHA ? prFiles() : [],
});
const prFiles = () => Object.keys(EDITS).map((filename) => ({ filename, status: "modified", sha: blobSha(filename, true), additions: 4, deletions: 4, changes: 8 }));
const COMMENT = {
  id: 101,
  body:
    "Are the longer pads from the updated library footprint? The paste stencil for the next batch needs the new size.\n\n" +
    "<sub>📍 KiVi · footprint **U405**</sub>\n" +
    '<!-- kivi:{"v":1,"type":"footprint","ref":"U405","uuid":"000a2094-3032-4626-9f20-f25c4ee64046","x":92.59,"y":67.24,"side":"head"} -->',
  path: "CM5_MINIMA_3.kicad_pcb",
  subject_type: "file",
  position: null,
  line: null,
  user: ME,
  created_at: HOURS(1),
  html_url: `https://github.com/${TEST_REPO}/pull/1#discussion_r101`,
};
// Change requests (GitHub issues labelled kivi), pinned like KiVi makes them.
const pinned = (text, what, anchor) =>
  `${text}\n\n<sub>📍 KiVi · ${what}</sub>\n<!-- kivi:${JSON.stringify({ v: 1, ...anchor, commit: BASE_SHA })} -->`;
const issue = (number, title, state, hours, comments, body) => ({
  number,
  title,
  state,
  body,
  comments,
  user: ME,
  labels: [{ name: "kivi" }],
  created_at: HOURS(hours + 20),
  updated_at: HOURS(hours),
  closed_at: state === "closed" ? HOURS(hours) : null,
  html_url: `https://github.com/${TEST_REPO}/issues/${number}`,
  repository_url: `https://api.github.com/repos/${TEST_REPO}`,
});
const ISSUES = [
  // Open: pull request #1 (whose description says "Fixes #9") changes this drill.
  issue(9, "M701: drill the mounting hole for an M3 screw with clearance", "open", 30, 0,
    pinned("2.95 mm is a tight fit for an M3 screw: use 3.2 mm or more.", "footprint **M701**", { type: "footprint", ref: "M701", uuid: "3c2e2b94-af38-45a6-90e9-a338b999b165", x: 113.6, y: 58.975, file: "CM5_MINIMA_3.kicad_pcb" })),
  issue(12, "Move J501 0.5 mm towards the board edge", "open", 5, 1,
    pinned("The HDMI connector's shield tabs touch the keep-out. Moving J501 0.5 mm towards the edge clears it, and the cable sits flush with the case.", "footprint **J501**", { type: "footprint", ref: "J501", uuid: "c365eee1-26db-4c5a-8ca2-57fcb8282a89", x: 99.09, y: 72.07, file: "CM5_MINIMA_3.kicad_pcb" })),
  issue(13, "Add a test point on +5V", "open", 26, 0,
    pinned("Bring-up needs a probe point on +5V after the power switch.", "net **+5V**", { type: "net", net: "+5V", x: 126.415, y: 67.8, file: "CM5_MINIMA_3.kicad_pcb" })),
  issue(14, "D605: use a red LED for power", "open", 48, 0,
    pinned("Green is the activity LED (D606); power should be red so they can be told apart.", "symbol **D605**", { type: "symbol", ref: "D605", uuid: "f3fe57ba-8a7b-4e86-a173-6c2bbed68eb4", x: 88.9, y: 22.86, file: "IO.kicad_sch" })),
];
const ISSUE_COMMENTS = {
  12: [{ id: 1201, body: "Checked against the case drawing: 0.5 mm is enough. I'll do it with the next footprint update.", user: ME, created_at: HOURS(4), html_url: `https://github.com/${TEST_REPO}/issues/12#issuecomment-1201` }],
};

const PR = {
  number: 1,
  title: PR_TITLE,
  state: "open",
  draft: false,
  body: "Footprint and symbol fixes from bring-up.\n\nFixes #9",
  user: ME,
  html_url: `https://github.com/${TEST_REPO}/pull/1`,
  updated_at: HOURS(1),
  head: { sha: HEAD_SHA, ref: PR_BRANCH, repo: repoJson(TEST_REPO) },
  base: { sha: BASE_SHA, ref: "main", repo: repoJson(TEST_REPO) },
};

async function tree(nwo, ref) {
  const { cm5, demos } = await lists;
  if (nwo === MIRROR) return { sha: "m", truncated: false, tree: demos.map((d) => ({ path: `demos/${d.path}`, type: "blob", sha: d.sha, size: d.size })) };
  const fixed = testRef(ref) === HEAD_SHA;
  return { sha: ref, truncated: false, tree: cm5.map((p) => ({ path: p, type: "blob", sha: blobSha(p, fixed), size: 1000 })) };
}

async function api(path) {
  const url = new URL(path, "https://api.github.com");
  const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
  if (url.pathname === "/search/issues") {
    const q = url.searchParams.get("q");
    if (!q.includes(`repo:${TEST_REPO}`)) return json({ total_count: 0, items: [] });
    if (q.includes("is:issue")) {
      const items = ISSUES.filter((i) => !q.includes("is:open") || i.state === "open");
      return json({ total_count: items.length, items });
    }
    return json({ total_count: 1, items: [{ ...PR, repository_url: `https://api.github.com/repos/${TEST_REPO}`, pull_request: {} }] });
  }
  if (!m || !REPOS[m[1]]) return notFound();
  const [nwo, rest = ""] = [m[1], m[2]];
  if (!rest) return json(repoJson(nwo));
  let r;
  if ((r = rest.match(/^\/git\/trees\/([^/]+)$/))) return json(await tree(nwo, decodeURIComponent(r[1])));
  if (nwo !== TEST_REPO) return notFound();
  if ((r = rest.match(/^\/commits\/([^/]+)$/))) return testRef(decodeURIComponent(r[1])) ? json(commitJson(testRef(decodeURIComponent(r[1])))) : notFound();
  if (rest === "/commits") return json((testRef(url.searchParams.get("sha")) === HEAD_SHA ? [HEAD_SHA, BASE_SHA] : [BASE_SHA]).map(commitJson));
  if (rest === "/branches") return json([{ name: "main", commit: { sha: BASE_SHA } }, { name: PR_BRANCH, commit: { sha: HEAD_SHA } }]);
  if (rest.startsWith("/compare/")) return json({ merge_base_commit: { sha: BASE_SHA }, commits: [commitJson(HEAD_SHA)], files: prFiles() });
  if (rest === "/pulls/1") return json(PR);
  if (rest === "/pulls/1/files") return json(prFiles());
  if (rest === "/pulls/1/comments") return json(url.searchParams.get("page") === "1" || !url.searchParams.get("page") ? [COMMENT] : []);
  if (rest === "/issues") return json(url.searchParams.get("page") > 1 ? [] : ISSUES);
  if ((r = rest.match(/^\/issues\/(\d+)\/comments$/))) return json(url.searchParams.get("page") > 1 ? [] : ISSUE_COMMENTS[r[1]] ?? []);
  return notFound();
}

async function raw(path) {
  const [owner, repo, ref, ...rest] = path.split("/").filter(Boolean).map(decodeURIComponent);
  const nwo = `${owner}/${repo}`, file = rest.join("/");
  try {
    if (nwo === MIRROR && file.startsWith("demos/")) return new Response(await demoText(file.slice(6)));
    if (nwo === TEST_REPO && testRef(ref)) return new Response(await cm5File(file, testRef(ref) === HEAD_SHA));
  } catch {
    /* not in the demo files */
  }
  return new Response("404: Not Found", { status: 404 });
}

window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url, location.href);
  if (url.host === "api.github.com") return api(url.pathname + url.search);
  if (url.host === "raw.githubusercontent.com") return raw(url.pathname);
  if (url.host.endsWith("github.com") || url.host.endsWith("githubusercontent.com")) return new Response("", { status: 404 }); // stay offline
  return realFetch(input, init);
};

// ---- settings: two remote projects, KiCad 10 linked, no web model sources ----

const KICAD3D = "/usr/share/kicad/3dmodels";
const LOCAL = "/home/designer/cm5_minima";
const SETTINGS = {
  watchRepos: [TEST_REPO, MIRROR],
  modelSources: [],
  kicad: { program: "/usr/bin/kicad", version: "10.0.6", vars: { KICAD10_3DMODEL_DIR: KICAD3D } },
};
const realGet = Storage.prototype.getItem;
Storage.prototype.getItem = function (k) {
  return k === "kivi.settings" ? JSON.stringify(SETTINGS) : realGet.call(this, k);
};

// ---- desktop commands ----

const bytes = async (p) => new Uint8Array(await p);
const modelList = realFetch("/shots/kicad3d.json").then((r) => r.json());
window.__tauriReplies = {
  list_model_dir: ({ dir }) => (dir === KICAD3D ? modelList : []),
  read_model_file: async ({ dir, path }) => {
    if (dir !== KICAD3D) throw new Error("not a model folder");
    const r = await realFetch(`/kicad3d/${path.split("/").map(encodeURIComponent).join("/")}`);
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return bytes(r.arrayBuffer());
  },
  kicad_inspect: { program: "/usr/bin/kicad", version: "10.0.6", vars: { ...SETTINGS.kicad.vars, KICAD10_3RD_PARTY: "/home/designer/.local/share/kicad/10.0/3rdparty" } },
  // The local copy for diff.html#local=…, and in the viewer
  // (index.html#folder=/home/designer/cm5_minima) a clone of the test repository
  // with the same working files and one commit to push.
  git_info: () =>
    location.pathname.endsWith("/index.html")
      ? { root: LOCAL, owner: TEST_REPO.split("/")[0], repo: TEST_REPO.split("/")[1], branch: PR_BRANCH, head: HEAD_SHA, changes: Object.keys(EDITS).length, ahead: 1, behind: 0 }
      : { owner: null, repo: null, branch: PR_BRANCH },
  git_branches: [
    { name: PR_BRANCH, current: true },
    { name: "main" },
    { name: "feat/usb/esd/protection", remote: true },
  ],
  open_folder: async () => (await lists).cm5,
  list_folder: async () => (await lists).cm5,
  read_file: ({ path }) => bytes(cm5File(path, true)),
  git_local_changes: () => ({
    root: LOCAL,
    branch: PR_BRANCH,
    base_ref: "main",
    base_sha: BASE_SHA,
    head_ref: null,
    head_sha: null,
    files: Object.keys(EDITS).map((path) => ({ path, previous: path, status: "modified" })),
  }),
  git_read: ({ rev, file }) => bytes(cm5File(file, rev === "")),
  git_list: async () => (await lists).cm5,
  git_log: [],
};
