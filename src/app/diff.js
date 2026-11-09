// Visual diff page: compares KiCad files between two commits on GitHub, or
// (desktop app, diff.html#local=<folder>) a local git copy's working files with
// the point where its branch left main.

import { DIFFABLE, RULE_FILES } from "../project.js";
import { forge, forgeInHash, splitNwo } from "../forge/index.js";
import { parseSchematic } from "../sch/model.js";
import { renderSchematic } from "../sch/render.js";
import { parsePcb } from "../pcb/model.js";
import { renderPcb } from "../pcb/render.js";
import { trackPath, circlePath } from "../pcb/shapes.js";
import { diffSchematic } from "../diff/sch-diff.js";
import { diffPcb } from "../diff/pcb-diff.js";
import { diffRules } from "../diff/rules-diff.js";
import { BBox, f } from "../geom.js";
import { dirname } from "../project.js";
import { SvgView } from "./svgview.js";
import { ReviewStore, ReviewPanel, openCounts, COMMENT_ICON } from "./review-ui.js";
import { pickPcb, pickSch, locatePcb, locateSch } from "../diff/anchors.js";
import { buildConnectivity } from "../sch/connectivity.js";
import { refPicker } from "./ref-picker.js";
import { $, ago, escapeHtml, toast, refCompare, tokenFor } from "./ui.js";

const LAYER_PRESETS = {
  top: (l) => ["F.Cu", "F.SilkS", "Edge.Cuts", "Vias", "Holes", "Dwgs.User"].includes(l),
  bottom: (l) => ["B.Cu", "B.SilkS", "Edge.Cuts", "Vias", "Holes", "Dwgs.User"].includes(l),
  copper: (l) => l.endsWith(".Cu") || ["Edge.Cuts", "Vias", "Holes"].includes(l),
};

const VIEW_SIDE = { before: "base", after: "head", overlay: "head" };
const TYPE_ORDER = ["symbol", "library symbol", "footprint", "sheet", "net", "label", "routing", "vias", "wire", "bus", "zone", "rule area", "teardrops", "outline", "graphics", "junction", "no-connect", "text", "title block", "board",
  "constraint", "DRC check", "netclass", "netclass pattern", "net assignment", "size presets", "custom rule"];
const COMPARED = (path) => DIFFABLE.test(path ?? "") || RULE_FILES.test(path ?? "");

class DiffApp {
  constructor() {
    this.mode = "split";
    this.layers = "top";
    this.cache = new Map();
    this.selected = -1;
    const linked = (other) => (v) => {
      this[other]?.syncFrom(v);
      this.review?.position();
    };
    const view = (name, onViewChange) => new SvgView($(`#${name}`), { onViewChange, onPick: (p) => this.pickAt(p, name), onHover: (p) => this.review.hover(p, name) });
    this.before = view("before", linked("after"));
    this.after = view("after", linked("before"));
    this.overlay = view("overlay", () => this.review?.position());
    this.store = new ReviewStore();
    this.review = new ReviewPanel(this.store, this.reviewHost(), { container: $(".diff-side"), wrap: $("#diff-main .canvas-wrap"), modeButton: $("#comment-mode") });
    this.store.onChange(() => this.renderFileBadges());

    const params = new URLSearchParams(location.hash.slice(1));
    this.bind();
    const spec = this.specFromHash(params);
    const focus = params.get("thread") || params.get("at") ? { thread: params.get("thread"), at: params.get("at") } : null;
    // A local copy is read through the desktop app, which attaches itself after this page loads.
    if (spec?.local) this.pendingLocal = [spec, params.get("file")];
    else if (spec) this.open(spec, params.get("file"), focus);
  }

  /**
   * Called by the desktop app (src/desktop/desktop.js) with what reading a local
   * git copy needs: changes(root, base, head), source(root, rev) ("" = working files),
   * and branches(root) / commits(root, rev, offset, count) for the pickers.
   */
  attachLocalGit(api) {
    this.localGit = api;
    if (this.pendingLocal) this.open(...this.pendingLocal);
    this.pendingLocal = null;
  }

  /** A local copy (its working files, or `spec.head`) against main or `spec.base`, in the shape a forge's compare() returns. */
  async localComparison(spec) {
    if (!this.localGit) throw new Error("Local changes can only be shown in the KiVi desktop app");
    const lc = await this.localGit.changes(spec.local, spec.base, spec.head);
    const files = lc.files.filter((f) => COMPARED(f.path) || COMPARED(f.previous)).map((f) => ({ path: f.path, previous: f.previous, status: f.status }));
    const branch = lc.branch ?? "working copy";
    const head = lc.head_sha
      ? { sha: lc.head_sha, ref: lc.head_ref, src: this.localGit.source(lc.root, lc.head_sha) }
      : { sha: null, ref: branch, label: "working copy", src: this.localGit.source(lc.root, "") };
    return {
      base: { sha: lc.base_sha, ref: lc.base_ref, src: this.localGit.source(lc.root, lc.base_sha) },
      head,
      files,
      title: lc.head_sha ? `${lc.base_ref} → ${lc.head_ref}` : `Local changes on ${branch}`,
      branch: lc.branch,
      url: null,
      root: lc.root,
    };
  }

  bind() {
    for (const b of document.querySelectorAll("[data-mode]")) b.addEventListener("click", () => this.setMode(b.dataset.mode));
    for (const b of document.querySelectorAll("[data-layers]")) {
      b.addEventListener("click", () => {
        this.layers = b.dataset.layers;
        for (const o of document.querySelectorAll("[data-layers]")) o.setAttribute("aria-pressed", String(o === b));
        this.applyLayers();
      });
    }
    $("#opacity").addEventListener("input", () => this.applyOpacity());
    $("#show-marks").addEventListener("change", () => this.drawMarks());
    for (const b of document.querySelectorAll("[data-zoom]")) {
      b.addEventListener("click", () => {
        const views = this.mode === "split" ? [this.after] : [this.overlay];
        for (const v of views) {
          if (!v.view) continue;
          if (b.dataset.zoom === "fit") v.fit();
          else v.zoomAt(b.dataset.zoom === "in" ? 0.7 : 1.4, v.view.x + v.view.w / 2, v.view.y + v.view.h / 2);
        }
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.target.closest("input, textarea, dialog") || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "n" || e.key === "j") this.step(1);
      if (e.key === "p" || e.key === "k") this.step(-1);
    });
  }

  specFromHash(p) {
    if (p.get("local")) return { local: p.get("local"), base: p.get("base"), head: p.get("head") };
    const at = forgeInHash(p);
    if (!at) return null;
    const { owner, repo } = splitNwo(at.value);
    const f = at.forge.id;
    if (p.get("pr")) return { forge: f, owner, repo, pr: Number(p.get("pr")) };
    if (p.get("commit")) return { forge: f, owner, repo, commit: p.get("commit") };
    // Without a base: the default branch (the forge's compare).
    if (p.get("head")) return { forge: f, owner, repo, base: p.get("base"), head: p.get("head") };
    return null;
  }

  writeHash() {
    const s = this.spec;
    const p = new URLSearchParams();
    if (s.local) {
      p.set("local", s.local);
      if (s.base) p.set("base", s.base);
      if (s.head) p.set("head", s.head);
    } else {
      p.set(forge(s.forge).hashKey, `${s.owner}/${s.repo}`);
      if (s.pr) p.set("pr", String(s.pr));
      else if (s.commit) p.set("commit", s.commit);
      else {
        if (s.base) p.set("base", s.base);
        p.set("head", s.head);
      }
    }
    if (this.file) p.set("file", this.file.path);
    if (this.review?.activeThreadId) p.set("thread", String(this.review.activeThreadId));
    history.replaceState(null, "", `#${p}`);
  }

  busy(msg) {
    $("#loading").hidden = !msg;
    $("#loading-text").textContent = msg || "";
  }

  async open(spec, initialFile = null, focus = null) {
    this.spec = spec;
    this.cache.clear();
    this.proCache = new Map(); // the sides may be other commits now
    try {
      this.busy(spec.local ? "Reading local changes…" : `Reading changes from ${forge(spec.forge).name}…`);
      const cmp = spec.local ? await this.localComparison(spec) : await forge(spec.forge).compare(spec, tokenFor(forge(spec.forge)));
      this.cmp = cmp;
      $("#diff-bar").hidden = false;
      $("#diff-main").hidden = false;
      // The project's name (set per file by showFile); a pull request adds its title.
      $("#diff-title").textContent = this.repoName();
      $("#diff-refs").textContent = spec.pr ? cmp.title : "";
      $("#diff-refs").hidden = !spec.pr;
      // A pull request's sides stay as they are (its review comments belong to them); anything else can be re-picked.
      $("#before-ref").textContent = spec.pr ? (cmp.base.sha?.slice(0, 7) ?? "") : "";
      $("#after-ref").textContent = spec.pr ? (cmp.head.label ?? cmp.head.sha.slice(0, 7)) : "";
      this.mountPickers(spec, cmp);
      document.title = `${cmp.title} — KiVi diff`;
      await this.dropUnchangedRules(cmp);
      if (!cmp.files.length) {
        // The panes stay, empty, so their labels can still pick other versions.
        this.file = null;
        this.res = null;
        $("#file-list").innerHTML = `<li class="muted" style="font-size:13px">No schematic or board files changed.</li>`;
        $("#change-list").innerHTML = "";
        $("#change-count").textContent = "";
        $("#layer-preset").hidden = true;
        const home = { x0: 0, y0: 0, x1: 400, y1: 100 };
        const empty = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><text x="200" y="50" text-anchor="middle" font-size="10" fill="#6e7681" font-family="sans-serif">No schematic or board files changed between these versions</text></svg>`;
        for (const v of [this.before, this.after, this.overlay]) v.setSvg(empty, home);
        this.busy(null);
        return;
      }
      const order = (p) => (RULE_FILES.test(p) ? 2 : p.endsWith(".kicad_pcb") ? 1 : 0);
      cmp.files.sort((a, b) => order(a.path) - order(b.path) || a.path.localeCompare(b.path));
      this.renderFileList();
      if (spec.pr) {
        this.store.open({ forge: spec.forge, owner: spec.owner, repo: spec.repo, number: spec.pr, headSha: cmp.head.sha });
        if (focus) this.review.setFocus(focus);
      } else this.store.close();
      const first = cmp.files.find((f) => f.path === initialFile) ?? cmp.files[0];
      await this.showFile(first);
    } catch (e) {
      console.error(e);
      toast(e.message, true);
    } finally {
      this.busy(null);
    }
  }

  /**
   * KiCad rewrites the .kicad_pro on almost every save, so design rule files
   * stay in the list only when their rules changed. One that can't be read stays.
   */
  async dropUnchangedRules(cmp) {
    const rules = cmp.files.filter((fl) => RULE_FILES.test(fl.path) || RULE_FILES.test(fl.previous));
    if (!rules.length) return;
    const unchanged = new Set();
    await Promise.all(
      rules.map((fl) =>
        this.computeFile(fl).then(
          (res) => res.diff.changes.length || unchanged.add(fl),
          (e) => console.warn(fl.path, e),
        ),
      ),
    );
    cmp.files = cmp.files.filter((fl) => !unchanged.has(fl));
  }

  /**
   * The pickers in the pane labels: a branch or a commit for each side (and a
   * local copy's working files for the after side), in the Before and After
   * labels and again in the Overlay one. Picking reloads the diff with `base` /
   * `head` in the URL. Not for a pull request.
   */
  mountPickers(spec, cmp) {
    for (const slot of document.querySelectorAll(".pick-slot")) slot.replaceChildren();
    if (spec.pr) return;
    const local = !!spec.local;
    const f = local ? null : forge(spec.forge);
    // Both pickers list the same branches, read once per comparison.
    let branchList = null;
    const branches = () =>
      (branchList ??= local
        ? this.localGit.branches(cmp.root).then((bs) => bs.map((b) => ({ name: b.name, note: b.current ? "checked out" : b.remote ? `on ${b.forge ?? "the remote"}` : "" })))
        : f.branches(spec.owner, spec.repo, tokenFor(f)));
    const commits = local
      ? (branch, offset, count) => this.localGit.commits(cmp.root, branch, offset, count)
      : (branch, offset, count) => f.commits(spec.owner, spec.repo, branch, offset, count, tokenFor(f));
    const sha = /^[0-9a-f]{7,40}\^?$/i;
    // What each side is now: the URL's choice, else what it was resolved to
    // (a local copy's default base is e.g. origin/main, listed as main).
    const baseValue = spec.base ?? (local ? cmp.base.ref.split("/").pop() : !cmp.base.sha ? null : cmp.base.sha.startsWith(cmp.base.ref) ? cmp.base.sha : cmp.base.ref); // null: a first commit has no parent
    const headValue = local ? (spec.head ?? "") : (spec.head ?? cmp.head.sha);
    const headBranch = local ? (spec.head && !sha.test(spec.head) ? spec.head : cmp.branch) : !sha.test(headValue) ? headValue : null;
    const pick = (side) => async (value) => {
      const next = local ? { local: spec.local, base: spec.base, head: spec.head } : { forge: spec.forge, owner: spec.owner, repo: spec.repo, base: baseValue, head: headValue };
      next[side] = value || null;
      await this.open(next, this.file?.path);
      this.writeHash();
    };
    const before = () =>
      refPicker({
        current: cmp.base.ref ?? cmp.base.sha?.slice(0, 7) ?? "(none)",
        value: baseValue,
        hint: `A branch: the changes since the after side left it, like a ${local ? "pull request" : forge(spec.forge).words.pr}. A commit: compared with it as it is.`,
        commitsOf: !sha.test(baseValue ?? "") ? baseValue : headBranch,
        branches,
        commits,
        pick: pick("base"),
      });
    const after = () =>
      refPicker({
        current: cmp.head.label ?? cmp.head.ref ?? cmp.head.sha.slice(0, 7),
        value: headValue,
        working: local,
        hint: local ? "The working files (uncommitted edits too), a branch or a commit." : "A branch or a commit.",
        commitsOf: headBranch ?? (!sha.test(baseValue ?? "") ? baseValue : null),
        branches,
        commits,
        pick: pick("head"),
      });
    $("#before-pick").append(before());
    $("#after-pick").append(after());
    $("#overlay-before-pick").append(before());
    $("#overlay-after-pick").append(after());
  }

  /** The repository's or folder's name, the header until a file's project is known. */
  repoName() {
    return this.cmp.root ? this.cmp.root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : this.cmp.head.repo ?? this.spec.repo;
  }

  /** The project a changed file belongs to: the .kicad_pro next to it, else the repository's or folder's name. */
  async projectName(fl) {
    const side = fl.status === "removed" ? "base" : "head";
    const { pro } = await this.projectInfo(side, side === "base" ? fl.previous : fl.path);
    return pro ? pro.split("/").pop().replace(/\.kicad_pro$/i, "") : this.repoName();
  }

  renderFileList() {
    const icon = { added: "+", removed: "−", renamed: "→", modified: "~" };
    $("#file-list").innerHTML = this.cmp.files
      .map((fl, i) => {
        const name = fl.path.split("/").pop();
        const dir = fl.path.slice(0, -name.length);
        return `<li><button data-file="${i}" title="${escapeHtml(fl.path)}"><span class="st st-${fl.status}">${icon[fl.status] ?? "~"}</span><span class="fname"><span class="dir">${escapeHtml(dir)}</span>${escapeHtml(name)}</span><span class="cnt" id="cnt-${i}"></span></button></li>`;
      })
      .join("");
    for (const b of document.querySelectorAll("#file-list button")) b.addEventListener("click", () => this.showFile(this.cmp.files[Number(b.dataset.file)]));
  }

  async loadVersion(side, path) {
    const ref = this.cmp[side];
    if (ref.src) return ref.src.readText(path); // a local copy
    if (!ref.sha) return null;
    const src = forge(this.spec.forge).source({ owner: ref.owner, repo: ref.repo, ref: ref.sha, sha: ref.sha, token: tokenFor(forge(this.spec.forge)) });
    return src.readText(path);
  }

  /** Text variables of the project next to `path` (${TITLE}, ${VERSION}, …), best effort. */
  async projectVars(side, path) {
    return (await this.projectInfo(side, path)).vars;
  }

  /** The .kicad_pro next to `path` on one side and its text variables, read once per folder: {pro, vars}. */
  projectInfo(side, path) {
    const ref = this.cmp[side];
    if (!ref.sha && !ref.src) return Promise.resolve({ pro: null, vars: {} });
    const dir = dirname(path);
    const key = `${side}:${dir}`;
    if (!this.proCache.has(key)) {
      this.proCache.set(
        key,
        (async () => {
          const src = ref.src ?? forge(this.spec.forge).source({ owner: ref.owner, repo: ref.repo, ref: ref.sha, sha: ref.sha, path: dir, token: tokenFor(forge(this.spec.forge)) });
          const pro = (await src.list()).find((p) => p.endsWith(".kicad_pro") && dirname(p) === dir) ?? null;
          if (!pro) return { pro, vars: {} };
          return { pro, vars: JSON.parse(await src.readText(pro)).text_variables ?? {} };
        })().catch(() => ({ pro: null, vars: {} })),
      );
    }
    return this.proCache.get(key);
  }

  async computeFile(fl) {
    if (this.cache.has(fl.path)) return this.cache.get(fl.path);
    const isPcb = fl.path.endsWith(".kicad_pcb");
    this.busy(`Loading ${fl.path.split("/").pop()}…`);
    const [ta, tb] = await Promise.all([
      fl.status === "added" ? null : this.loadVersion("base", fl.previous).catch((e) => (fl.status === "modified" || fl.status === "renamed" ? Promise.reject(e) : null)),
      fl.status === "removed" ? null : this.loadVersion("head", fl.path),
    ]);
    this.busy("Comparing…");
    await new Promise((r) => setTimeout(r, 0));
    let res;
    if (RULE_FILES.test(fl.path)) {
      res = { kind: "rules", diff: diffRules(fl.path, ta, tb), home: new BBox().add(0, 0).add(100, 100) };
    } else if (isPcb) {
      const a = ta ? parsePcb(ta, fl.previous) : null, b = tb ? parsePcb(tb, fl.path) : null;
      const ra = a ? renderPcb(a, {}) : null, rb = b ? renderPcb(b, {}) : null;
      const d = diffPcb(a, b, ra, rb);
      const home = new BBox();
      if (ra) home.addBox(ra.bbox);
      if (rb) home.addBox(rb.bbox);
      res = { kind: "pcb", a, b, ra, rb, diff: d, home };
    } else {
      const a = ta ? parseSchematic(ta, fl.previous) : null, b = tb ? parseSchematic(tb, fl.path) : null;
      const [va, vb] = await Promise.all([a ? this.projectVars("base", fl.previous) : {}, b ? this.projectVars("head", fl.path) : {}]);
      const ra = a ? renderSchematic(a, { vars: va }) : null, rb = b ? renderSchematic(b, { vars: vb }) : null;
      const d = diffSchematic(a, b, ra, rb);
      const home = new BBox();
      for (const s of [a, b]) if (s) home.add(0, 0).add(s.paper.width, s.paper.height);
      res = { kind: "sch", a, b, ra, rb, diff: d, home, connA: d.connA, connB: d.connB };
    }
    // Sort changes for the list.
    res.diff.changes.sort((x, y) => TYPE_ORDER.indexOf(x.type) - TYPE_ORDER.indexOf(y.type) || refCompare(x.label, y.label));
    this.cache.set(fl.path, res);
    const i = this.cmp.files.indexOf(fl);
    const s = res.diff.summary;
    const cnt = $(`#cnt-${i}`);
    if (cnt) cnt.textContent = String(s.added + s.removed + s.modified);
    return res;
  }

  async showFile(fl) {
    try {
      const res = await this.computeFile(fl);
      this.file = fl;
      this.projectName(fl).then((name) => this.file === fl && ($("#diff-title").textContent = name));
      this.res = res;
      this.selected = -1;
      for (const b of document.querySelectorAll("#file-list button")) b.toggleAttribute("aria-current", this.cmp.files[Number(b.dataset.file)] === fl);
      $("#layer-preset").hidden = res.kind !== "pcb";
      $("#diff-main").classList.toggle("rules-mode", res.kind === "rules");
      $("#rules-view").hidden = res.kind !== "rules";
      if (res.kind === "rules") this.renderRules(res);
      const home = { x0: res.home.x0, y0: res.home.y0, x1: res.home.x1, y1: res.home.y1 };
      const empty = (msg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${home.x0} ${home.y0} ${home.x1 - home.x0} ${home.y1 - home.y0}"><text x="${(home.x0 + home.x1) / 2}" y="${(home.y0 + home.y1) / 2}" text-anchor="middle" font-size="${(home.x1 - home.x0) / 40}" fill="#6e7681" font-family="sans-serif">${msg}</text></svg>`;
      this.before.setSvg(res.ra?.svg ?? empty("File does not exist in this version"), home);
      this.after.setSvg(res.rb?.svg ?? empty("File was deleted"), home);
      this.overlay.setSvg(this.composite(res, home), home);
      $("#before").classList.toggle("pcb", res.kind === "pcb");
      $("#after").classList.toggle("pcb", res.kind === "pcb");
      $("#overlay").classList.toggle("pcb", res.kind === "pcb");
      if (res.kind === "pcb") this.applyLayers();
      this.applyOpacity();
      this.renderChanges();
      this.drawMarks();
      this.review.refresh();
      // A local copy opens its working files (the folder, with the project of this file), or the compared commit.
      const viewerHash = this.cmp.root
        ? new URLSearchParams({ folder: this.cmp.root, project: fl.path.replace(/\.kicad_(sch|pcb|dru)$/i, ".kicad_pro"), ...(this.cmp.head.sha && { commit: this.cmp.head.sha }) })
        : new URLSearchParams({ [forge(this.spec.forge).hashKey]: `${this.cmp.head.owner}/${this.cmp.head.repo}@${this.cmp.head.sha}${dirname(fl.path) ? `:${dirname(fl.path)}` : ""}`, tab: res.kind === "sch" ? "sch" : "pcb", ...(res.kind !== "rules" && { file: fl.path }) });
      if (this.spec.pr) viewerHash.set("pr", `${this.spec.owner}/${this.spec.repo}#${this.spec.pr}`);
      $("#open-viewer").href = `index.html#${viewerHash}`;
      this.writeHash();
    } catch (e) {
      console.error(e);
      toast(e.message, true);
    } finally {
      this.busy(null);
    }
  }

  /** A design rule file: its changes as a Setting / Before / After table, one group per change. */
  renderRules(res) {
    const ch = res.diff.changes;
    const sign = { added: "+", removed: "−", modified: "~" };
    $("#rules-view").innerHTML = ch.length
      ? `<table class="rules-table"><thead><tr><th>Setting</th><th>Before</th><th>After</th></tr></thead>` +
        ch
          .map(
            (c, i) =>
              `<tbody data-i="${i}"><tr class="rules-head"><th colspan="3"><span class="st st-${c.kind}">${sign[c.kind]}</span> ${escapeHtml(c.label)} <span class="ctype">${escapeHtml(c.type)}</span></th></tr>` +
              (c.rows ?? []).map(([k, x, y]) => `<tr><td>${escapeHtml(k)}</td><td class="mono">${escapeHtml(x)}</td><td class="mono">${escapeHtml(y)}</td></tr>`).join("") +
              `</tbody>`,
          )
          .join("") +
        `</table>`
      : `<p class="muted">No design rule changes in this file.</p>`;
    for (const tb of document.querySelectorAll("#rules-view tbody[data-i]")) tb.addEventListener("click", () => this.select(Number(tb.dataset.i)));
  }

  /** Both versions stacked in one SVG (nested viewports keep coordinates aligned). */
  composite(res, home) {
    const inner = (svg, cls) => {
      if (!svg) return "";
      const m = /^<svg[^>]*viewBox="([^"]+)"[^>]*>/.exec(svg);
      const vb = m[1].split(/[ ,]+/).map(Number);
      return `<g class="${cls}"><svg x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" viewBox="${m[1]}" overflow="visible">${svg.slice(m[0].length, -"</svg>".length)}</svg></g>`;
    };
    const w = home.x1 - home.x0, h = home.y1 - home.y0;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${home.x0} ${home.y0} ${w} ${h}">${inner(res.ra?.svg, "ov-before")}${inner(res.rb?.svg, "ov-after")}</svg>`;
  }

  applyOpacity() {
    const v = Number($("#opacity").value) / 100;
    const g = $("#overlay .ov-after");
    if (g) g.setAttribute("opacity", String(v));
  }

  applyLayers() {
    if (this.res?.kind !== "pcb") return;
    const pred = LAYER_PRESETS[this.layers];
    for (const root of [$("#before"), $("#after"), $("#overlay")]) {
      for (const g of root.querySelectorAll("g[data-layer]")) {
        if (pred(g.dataset.layer)) g.removeAttribute("display");
        else g.setAttribute("display", "none");
      }
    }
  }

  setMode(mode) {
    this.mode = mode;
    for (const b of document.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    $("#split").hidden = mode !== "split";
    $("#overlay-pane").hidden = mode !== "overlay";
    $("#opacity-wrap").hidden = mode !== "overlay";
    const src = mode === "overlay" ? this.after : this.overlay;
    const dst = mode === "overlay" ? this.overlay : this.after;
    requestAnimationFrame(() => {
      dst.syncFrom(src.view);
      if (mode === "split") this.before.syncFrom(src.view);
    });
  }

  renderChanges() {
    const ch = this.res.diff.changes;
    const s = this.res.diff.summary;
    $("#change-count").textContent = ch.length ? `+${s.added} −${s.removed} ~${s.modified}` : "";
    const sign = { added: "+", removed: "−", modified: "~" };
    $("#change-list").innerHTML = ch.length
      ? ch
          .map(
            (c, i) =>
              `<li><button data-i="${i}" class="chg chg-${c.kind}"><span class="st st-${c.kind}">${sign[c.kind]}</span><span class="cbody"><span class="clabel"><span class="${c.type === "symbol" || c.type === "library symbol" || c.type === "footprint" ? "mono" : ""}">${escapeHtml(c.label)}</span> <span class="ctype">${escapeHtml(c.type)}</span></span>${c.detail ? `<span class="cdetail">${escapeHtml(c.detail)}</span>` : ""}</span></button></li>`,
          )
          .join("")
      : `<li class="muted" style="font-size:13px;padding:6px 2px">No differences in this file's content.</li>`;
    for (const b of document.querySelectorAll("#change-list button")) b.addEventListener("click", () => this.select(Number(b.dataset.i), true));
  }

  select(i, zoom = false) {
    this.selected = i;
    for (const b of document.querySelectorAll("#change-list button")) b.toggleAttribute("aria-current", Number(b.dataset.i) === i);
    document.querySelector(`#change-list button[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
    if (this.res?.kind === "rules") {
      for (const tb of document.querySelectorAll("#rules-view tbody[data-i]")) tb.toggleAttribute("aria-current", Number(tb.dataset.i) === i);
      document.querySelector(`#rules-view tbody[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    this.drawMarks();
    const c = this.res.diff.changes[i];
    if (c && zoom) {
      const bb = new BBox();
      if (c.before) bb.addBox(c.before);
      if (c.after) bb.addBox(c.after);
      if (!bb.empty) {
        const min = this.res.kind === "pcb" ? 6 : 20;
        (this.mode === "split" ? this.after : this.overlay).zoomTo(bb, min);
      }
    }
  }

  step(d) {
    const n = this.res?.diff.changes.length ?? 0;
    if (!n) return;
    this.select((this.selected + d + n) % n, true);
  }

  // ---- review comments ----

  /** Adapter between the comment panel and the diff canvases (see review-ui.js). */
  reviewHost() {
    const app = this;
    const here = (t) => !!app.file && (t.path === app.file.path || t.path === app.file.previous);
    return {
      active: () => true,
      docKey: () => app.file,
      view: (name) => app[name],
      defaultView: (side) => (app.mode === "overlay" ? "overlay" : side === "base" ? "before" : "after"),
      showsSide: (name, side) => name === "overlay" || VIEW_SIDE[name] === side,
      place(t) {
        if (!app.res || !here(t)) return null;
        if (!t.anchor) return { side: null };
        const side = t.anchor.side === "base" ? "base" : "head";
        return { side, ...app.locateAnchor(t.anchor, side) };
      },
      list: (threads) => threads.filter(here).map((thread) => ({ thread, here: true })),
      goto(t) {
        const fl = app.cmp?.files.find((x) => x.path === t.path || x.previous === t.path);
        if (!fl) return false;
        if (fl === app.file) return true;
        app.showFile(fl);
        return "pending";
      },
      target: (p, name) => app.commentTarget(p, name),
      commentPath: () => app.file?.path ?? null,
      refreshOverlay: () => app.refreshOverlay(),
      get zoomMin() {
        return app.res?.kind === "pcb" ? 8 : 25;
      },
      writeHash: () => app.writeHash(),
    };
  }

  /** Parsed document, render and connectivity of one side of the current file. */
  sideDoc(side) {
    const res = this.res;
    const d = side === "base" ? { doc: res.a, render: res.ra, key: "connA" } : { doc: res.b, render: res.rb, key: "connB" };
    if (d.doc && res.kind === "sch") d.conn = res[d.key] ??= buildConnectivity(d.doc, d.render.items);
    return d;
  }

  locateAnchor(anchor, side) {
    const d = this.sideDoc(side);
    if (!d.doc || this.res.kind === "rules") return { x: anchor.x, y: anchor.y, found: false, mark: null };
    return this.res.kind === "pcb" ? locatePcb(d.doc, d.render, anchor) : locateSch(d.doc, d.render, d.conn, anchor);
  }

  commentTarget(p, view) {
    if (!this.res || this.res.kind === "rules") return null;
    const side = VIEW_SIDE[view], d = this.sideDoc(side);
    if (!d.doc) return null;
    const scale = this[view].scale || 1;
    const t =
      this.res.kind === "pcb"
        ? pickPcb(d.doc, d.render, p, { visible: this.visibleLayers(d.doc), side: this.layers === "bottom" ? "back" : "front", slack: Math.max(0.05, 3 / scale) })
        : pickSch(d.doc, d.render, d.conn, p, Math.max(0.4, 5 / scale));
    return { ...t, side };
  }

  /** Open comment count next to each file. */
  renderFileBadges() {
    const counts = openCounts(this.store.threads);
    for (const b of document.querySelectorAll("#file-list button[data-file]")) {
      const fl = this.cmp?.files[Number(b.dataset.file)];
      if (!fl) continue;
      const n = (counts.get(fl.path) ?? 0) + (fl.previous !== fl.path ? counts.get(fl.previous) ?? 0 : 0);
      let el = b.querySelector(".cm-cnt");
      if (!n) {
        el?.remove();
        continue;
      }
      if (!el) {
        el = document.createElement("span");
        el.className = "cm-cnt";
        b.querySelector(".cnt").before(el);
      }
      el.innerHTML = `${COMMENT_ICON}${n}`;
      el.title = `${n} open comment${n > 1 ? "s" : ""}`;
    }
  }

  /** Layer names shown by the current preset (picking only hits what is visible). */
  visibleLayers(pcb) {
    const pred = LAYER_PRESETS[this.layers];
    return new Set(pcb.layers.map((l) => l.name).filter(pred));
  }

  pickAt(p, view) {
    if (this.review.pick(p, view)) return;
    const ch = this.res?.diff.changes ?? [];
    let best = -1, area = Infinity;
    ch.forEach((c, i) => {
      for (const b of [view !== "after" ? c.before : null, view !== "before" ? c.after : null]) {
        if (b && !b.empty && b.contains(p.x, p.y) && b.w * b.h < area) {
          area = b.w * b.h;
          best = i;
        }
      }
    });
    if (best >= 0) this.select(best);
  }

  drawMarks() {
    const show = $("#show-marks").checked;
    const ch = this.res?.diff.changes ?? [];
    const marks = (side) => {
      if (!show) return "";
      let out = "";
      ch.forEach((c, i) => {
        const box = side === "before" ? c.before : c.after;
        if (!box || box.empty) return;
        const cls = `mk mk-${c.kind}${i === this.selected ? " sel" : ""}`;
        const tracks = side === "before" ? c.tracksBefore : c.tracksAfter;
        const vias = side === "before" ? c.viasBefore : c.viasAfter;
        if (tracks?.length) {
          let d = "";
          let w = 0;
          for (const t of tracks) {
            d += trackPath(t);
            w = Math.max(w, t.width);
          }
          out += `<path class="${cls} mk-path" d="${d}" style="stroke-width:${f(w + 0.25)}px"/>`;
        }
        if (vias?.length) out += `<path class="${cls} mk-fill" d="${vias.map((v) => circlePath(v.x, v.y, v.size / 2 + 0.15)).join("")}"/>`;
        const outlines = side === "before" ? c.outlinesBefore : c.outlinesAfter;
        if (outlines?.length) out += `<path class="${cls} mk-outline" d="${outlines.map((pts) => pts.map((p, k) => `${k ? "L" : "M"}${f(p.x)} ${f(p.y)}`).join("") + "Z").join("")}"/>`;
        if (c.paths?.length) out += `<path class="${cls} mk-path" d="${c.paths.map((pts) => pts.map((p, k) => `${k ? "L" : "M"}${f(p.x)} ${f(p.y)}`).join("")).join("")}" style="stroke-width:0.5px"/>`;
        const boxes = (side === "before" ? c.boxesBefore : c.boxesAfter) ?? c.boxes;
        if (boxes?.length) for (const b of boxes) out += `<rect class="${cls}" x="${f(b.x0)}" y="${f(b.y0)}" width="${f(b.w)}" height="${f(b.h)}"/>`;
        if (!tracks?.length && !vias?.length && !c.paths?.length && !boxes?.length && !outlines?.length) out += `<rect class="${cls}" x="${f(box.x0)}" y="${f(box.y0)}" width="${f(box.w)}" height="${f(box.h)}" rx="0.4"/>`;
        else if (i === this.selected) out += `<rect class="mk mk-${c.kind} sel" x="${f(box.x0)}" y="${f(box.y0)}" width="${f(box.w)}" height="${f(box.h)}" rx="0.4" fill="none"/>`;
      });
      return out;
    };
    this.markHtml = { before: marks("before"), after: marks("after") };
    this.markHtml.overlay = this.markHtml.before + this.markHtml.after;
    this.refreshOverlay();
  }

  /** Change marks plus review comment pins (redrawn on hover without recomputing the marks). */
  refreshOverlay() {
    if (!this.markHtml) return;
    for (const name of ["before", "after", "overlay"]) this[name].setOverlayHtml(this.markHtml[name] + this.review.overlay(name));
  }
}

if (typeof document !== "undefined" && document.querySelector("#diff-main")) window.kiviDiff = new DiffApp();
