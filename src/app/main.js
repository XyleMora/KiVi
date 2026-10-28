// KiVi application controller: sources, project loading, tabs, deep links.

import { findProjects, loadProject } from "../project.js";
import { GitHubSource, parseGitHubSpec, makeModelResolver } from "../sources.js";
import { DEFAULT_MODEL_BASE } from "../pcb/board3d.js";

/** 3D model sources from Settings (the account menu; older settings had a single library URL). */
const modelSources = (s) => s.modelSources ?? [s.modelBase ?? DEFAULT_MODEL_BASE];
import { SchematicTab } from "./sch-tab.js";
import { PcbTab } from "./pcb-tab.js";
import { BomTab } from "./bom-tab.js";
import { ReviewStore } from "./review-ui.js";
import { mountBranchMenu } from "./branch-menu.js";
import { mountHistoryMenu } from "./history-menu.js";
import { setDiffButton } from "./diff-button.js";
import { $, toast, settings } from "./ui.js";

class App {
  constructor() {
    this.source = null;
    this.projects = [];
    this.project = null;
    this.tab = "sch";
    this.pr = null; // pull request under review: comments in the schematic and PCB tabs
    this.store = new ReviewStore(); // its review comments, or else the repository's issues
    this.localIssues = null; // {folder, owner, repo, prefix, commit}: a local copy's GitHub repository (desktop.js)
    this.sch = new SchematicTab(this);
    this.pcb = new PcbTab(this);
    this.bom = new BomTab(this);
    this.view3d = null;
    this.bind();
    this.restoreFromHash();
  }

  bind() {
    for (const b of document.querySelectorAll(".tabs [data-tab]")) b.addEventListener("click", () => this.showTab(b.dataset.tab));
    $("#project-select").addEventListener("change", (e) => this.openProject(this.projects[Number(e.target.value)]));

    window.addEventListener("hashchange", () => {
      if (this._writingHash) return;
      this.restoreFromHash();
    });
  }

  // ---- loading ----

  busy(msg) {
    $("#loading").hidden = !msg;
    $("#loading-text").textContent = msg || "";
  }

  async openGitHub(spec, state = null) {
    try {
      this.busy("Connecting to GitHub…");
      // Reviewing a pull request: show its head commit and its review comments.
      const pr = state?.pr ? await this.resolvePr(state.pr, spec) : null;
      if (pr) spec = pr.spec;
      const src = await GitHubSource.open(spec, settings().token);
      // An earlier commit from the history menu: read at that commit, still labelled with the branch.
      if (!pr && /^[0-9a-f]{40}$/i.test(state?.commit ?? "")) src.sha = src.commit = state.commit;
      this.pr = pr;
      await this.openSource(src, state);
      this.showPr();
    } catch (e) {
      this.busy(null);
      toast(e.message, true);
    }
  }

  /** "owner/repo#12" (or "12" with the repository from `spec`) → head commit and spec to open. */
  async resolvePr(value, spec) {
    const gh = parseGitHubSpec(spec);
    const m = /^(?:([\w.-]+)\/([\w.-]+))?#?(\d+)$/.exec(String(value).trim());
    if (!m || !gh) return null;
    const owner = m[1] ?? gh.owner, repo = m[2] ?? gh.repo, number = Number(m[3]);
    this.busy(`Reading pull request #${number}…`);
    const pr = await GitHubSource.api(`/repos/${owner}/${repo}/pulls/${number}`, settings().token);
    const head = pr.head.repo ?? { owner: { login: owner }, name: repo }; // fork deleted: the base repo still has the commits
    const path = gh.path ?? "";
    return {
      owner, repo, number,
      headSha: pr.head.sha,
      // Fork branches are shown as "owner:branch", like GitHub does.
      headRef: pr.head.repo && pr.head.repo.owner.login !== owner ? pr.head.label : pr.head.ref,
      title: pr.title,
      url: pr.html_url,
      spec: `${head.owner.login}/${head.name}@${pr.head.sha}${path ? `:${path}` : ""}`,
    };
  }

  showPr() {
    const chip = $("#pr-chip");
    if (this.pr) {
      chip.hidden = false;
      chip.href = this.pr.url;
      chip.title = `Viewing the head of pull request #${this.pr.number}: ${this.pr.title}`;
      chip.innerHTML = `PR #${this.pr.number} <span class="mono muted">${this.pr.headSha.slice(0, 7)}</span>`;
      if (this.store.pr?.number !== this.pr.number || this.store.pr?.headSha !== this.pr.headSha || this.store.pr?.repo !== this.pr.repo) this.store.open(this.pr);
    } else {
      chip.hidden = true;
      this.showIssues();
    }
  }

  /**
   * Outside a pull request the pins are the repository's KiVi issues: for a
   * GitHub repository, and for a local copy whose GitHub repository desktop.js
   * reported (`setLocalIssues`). Anything else has none.
   */
  showIssues() {
    const s = this.source;
    if (s?.kind === "github") this.store.openIssues({ owner: s.owner, repo: s.repo, prefix: "", commit: s.sha ?? s.commit ?? null });
    else if (s && this.localIssues && s.path === this.localIssues.folder) this.store.openIssues(this.localIssues);
    else this.store.close();
  }

  /** A local folder's GitHub repository (null: none), from desktop.js once git has said. */
  setLocalIssues(target) {
    this.localIssues = target;
    if (!this.pr) this.showIssues();
  }

  /** Branch (or short commit) being viewed, for the project bar; the full address goes in the tooltip. */
  refLabel() {
    const s = this.source;
    if (s.kind !== "github") return s.label;
    if (this.pr?.headRef) return this.pr.headRef;
    return /^[0-9a-f]{40}$/i.test(s.ref) ? s.ref.slice(0, 7) : s.ref;
  }

  async openSource(source, state = null) {
    if (source.kind !== "github" || (source.sha ?? source.ref) !== this.pr?.headSha) {
      this.pr = null;
      this.showPr();
    }
    try {
      this.busy("Listing files…");
      const files = await source.list();
      let projects = findProjects(files);
      // A repo path narrows the choice (e.g. a /tree/<ref>/hardware link).
      if (source.path) {
        const p = source.path.replace(/\/$/, "");
        const inPath = projects.filter((x) => x.pro === p || x.sch === p || x.pcb === p || x.dir === p || x.dir.startsWith(p + "/") || (p.endsWith(".kicad_sch") && files.includes(p)));
        if (inPath.length) projects = inPath;
      }
      if (!projects.length) throw new Error(source.truncated ? "Repository too large to list completely; open a sub-folder URL instead" : "No KiCad project (.kicad_pro / .kicad_sch / .kicad_pcb) found");
      this.source = source;
      if (!this.pr) this.showIssues(); // this repository's issues (a local copy's once desktop.js knows its repository)
      this.projects = projects;
      const sel = $("#project-select");
      sel.innerHTML = projects.map((p, i) => `<option value="${i}">${escapeHtml(p.dir ? `${p.dir}/${p.name}` : p.name)}</option>`).join("");
      sel.hidden = projects.length < 2;
      let pick = projects[0];
      if (state?.project) pick = projects.find((p) => (p.pro ?? p.sch ?? p.pcb) === state.project) ?? pick;
      // Opened for a file (an issue's pin): the project it belongs to, the deepest folder holding it.
      else if (state?.file) pick = projectOfFile(projects, state.file) ?? pick;
      sel.value = String(projects.indexOf(pick));
      await this.openProject(pick, state);
    } catch (e) {
      toast(e.message, true);
    } finally {
      this.busy(null);
    }
  }

  async openProject(entry, state = null) {
    this.busy(`Loading ${entry.name}…`);
    try {
      const project = await loadProject(this.source, entry, { onProgress: (m) => this.busy(m) });
      this.project = project;
      this.entry = entry;
      for (const err of project.errors) console.warn(err);
      if (project.errors.length) toast(`${project.errors.length} file(s) could not be read: ${project.errors[0]}`, true);
      this.view3d?.dispose();
      this.view3d = null;
      this.view3dReady = null;
      $("#app").hidden = false;
      $("#projbar").hidden = false;
      $("#proj-name").textContent = project.name;
      // Where it comes from on the left (repository or folder); the branch is the menu on the right.
      const srcLabel = $("#proj-source");
      srcLabel.textContent = this.source.kind === "github" ? this.source.repo : this.source.label;
      srcLabel.title = this.source.label;
      if (this.source.kind === "github") {
        this.mountGitHubBranches(entry);
        this.mountGitHubHistory();
        this.setGitHubDiff();
      } else {
        // a local copy's come from desktop.js
        for (const id of ["#branch-menu", "#history-menu"]) if ($(id)?.dataset.kind === "github") $(id).remove();
      }
      document.title = `${project.name} — KiVi`;

      this.sch.load(project);
      this.pcb.load(project);
      this.bom.load(project);
      for (const b of document.querySelectorAll(".tabs [data-tab]")) {
        const t = b.dataset.tab;
        b.disabled = (t === "pcb" || t === "3d") ? !project.pcb : t === "sch" || t === "bom" ? !project.pages.length : false;
      }
      let tab = state?.tab ?? (project.pages.length ? "sch" : "pcb");
      let page = state?.page ? Number(state.page) || 0 : 0;
      // Opened for a specific file (e.g. from a GitHub file page).
      if (state?.file) {
        if (state.file.endsWith(".kicad_pcb") && project.pcb) tab = state.tab ?? "pcb";
        if (state.file.endsWith(".kicad_sch")) {
          tab = state.tab ?? "sch";
          page = Math.max(0, project.pages.findIndex((p) => p.file === state.file));
        }
      }
      this.showTab(tab, true);
      if (page && tab === "sch") this.sch.showPage(page);
      if (state?.thread && (tab === "sch" || tab === "pcb")) this[tab].review.setFocus({ thread: state.thread });
      else if (state?.sel) setTimeout(() => this.select(state.sel, tab), 0);
      else if (state?.net) setTimeout(() => this.crossProbeNet(state.net, tab), 0);
      this.writeHash();
    } catch (e) {
      console.error(e);
      toast(e.message, true);
    } finally {
      this.busy(null);
    }
  }

  // ---- tabs & cross-probing ----

  showTab(tab, silent = false) {
    if (!this.project) return;
    const btn = document.querySelector(`.tabs [data-tab="${tab}"]`);
    if (!btn || btn.disabled) tab = this.project.pages.length ? "sch" : "pcb";
    this.tab = tab;
    for (const b of document.querySelectorAll(".tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    for (const id of ["sch", "pcb", "3d", "bom"]) $(`#tab-${id}`).hidden = id !== tab;
    if (tab === "sch") this.sch.show();
    if (tab === "pcb") this.pcb.show();
    if (tab === "3d") this.show3d();
    if (!silent) this.writeHash();
  }

  /** Create the 3D view on first use; resolves once the board is built. */
  show3d() {
    if (!this.project?.pcb) return Promise.resolve(null);
    this.view3dReady ??= this.create3d();
    return this.view3dReady;
  }

  async create3d() {
    const status = (m) => ($("#status3d").textContent = m);
    try {
      const { Board3D } = await import("../pcb/board3d.js");
      const s = settings();
      const resolver =
        s.loadModels !== false
          ? makeModelResolver(this.source, this.entry.dir, modelSources(s), {
              token: s.token,
              onSourceError: (spec, e) => toast(`3D model source ${spec}: ${e.message}`, true),
              openDir: this.openModelDir, // set by the desktop app (src/desktop/desktop.js)
              pathVars: s.kicad?.vars ?? {}, // the KiCad linked in the desktop app's Settings
            })
          : null;
      this.view3d = new Board3D($("#v3d"), {
        resolveModel: resolver,
        onStatus: status,
        onPick: (fp) => {
          // The net (if any) is already highlighted by the view; the panel reads it.
          setTimeout(() => this.render3dInfo(fp), 0);
          this.writeHash();
        },
        onView: (view) => {
          for (const o of document.querySelectorAll("[data-view]")) o.setAttribute("aria-pressed", String(o.dataset.view === view));
        },
        onModelsLoaded: () => this.render3dInfo(this.project.pcb.footprints.find((f) => f.reference === this.view3d?.selectedRef) ?? null),
      });
      const { Measure3D } = await import("../pcb/measure3d.js");
      new Measure3D(this.view3d, { button: $("#m3d-measure"), chip: $("#m3d-chip"), label: $("#m3d-label") });
      await this.view3d.load(this.project.pcb);
      this.render3dInfo();
      for (const b of document.querySelectorAll("[data-view]")) {
        b.onclick = () => {
          for (const o of document.querySelectorAll("[data-view]")) o.setAttribute("aria-pressed", String(o === b));
          this.view3d.frame(b.dataset.view);
        };
      }
      $("#show-components").onchange = (e) => this.view3d.setComponentsVisible(e.target.checked);
      for (const b of document.querySelectorAll("[data-zoom3d]")) {
        b.onclick = () => (b.dataset.zoom3d === "fit" ? this.view3d.fit() : this.view3d.zoom(b.dataset.zoom3d === "in" ? 0.7 : 1.4));
      }
      return this.view3d;
    } catch (e) {
      console.error(e);
      status(`3D view unavailable: ${e.message}`);
      return null;
    }
  }

  render3dInfo(selected = null) {
    const pcb = this.project.pcb;
    const net = this.view3d?.highlightedNet;
    const netCard = net
      ? `<div class="panel-title">Net</div><div class="row gap"><h2 style="word-break:break-all">${escapeHtml(net)}</h2></div>
        <div class="actions">${this.project.pages.length ? '<button class="btn" data-netprobe3d="sch">Show in schematic</button>' : ""}<button class="btn" data-netprobe3d="pcb">Highlight on PCB</button><button class="btn" id="net3d-clear">Clear</button></div>`
      : "";
    const part = selected
      ? `<div class="row gap"><h2>${escapeHtml(selected.reference)}</h2><span class="tag">${selected.side === "back" ? "Bottom" : "Top"}</span>${selected.dnp ? '<span class="tag warn">DNP</span>' : ""}</div>
        <div style="font-weight:500">${escapeHtml(selected.value)}</div>
        <dl class="kv"><dt>Footprint</dt><dd class="mono" style="font-size:12px">${escapeHtml(selected.libId)}</dd>
        <dt>3D model</dt><dd class="mono" style="font-size:12px;word-break:break-all">${escapeHtml(selected.models.find((m) => !m.hide)?.path.split("/").pop() ?? "none")}${this.view3d?.missingModels?.some((m) => m.reference === selected.reference) ? ' <span class="tag warn">not found</span>' : ""}</dd></dl>
        <div class="actions">${this.project.pages.length ? '<button class="btn" data-probe3d="sch">Show in schematic</button>' : ""}<button class="btn" data-probe3d="pcb">Show on PCB</button></div>`
      : `<p class="empty">Click a part to select it. Drag to rotate freely, right-drag to pan, scroll to zoom.</p>`;
    const rows = pcb.stackup
      .filter((l) => l.type)
      .map((l) => {
        const color = /copper/i.test(l.type) ? "#C87533" : /mask/i.test(l.type) ? "#1E5631" : /silk/i.test(l.type) ? "#F4F4F0" : /paste/i.test(l.type) ? "#9aa" : "#B79B5B";
        const t = l.thickness ? (l.thickness < 0.1 ? `${Math.round(l.thickness * 1000)} µm` : `${l.thickness.toFixed(3)} mm`) : "";
        return `<span class="sw" style="background:${color}"></span><span>${escapeHtml(l.name)}${l.material ? ` <span class="muted">· ${escapeHtml(l.material)}</span>` : ""}</span><span class="t">${t}</span>`;
      })
      .join("");
    const withModels = pcb.footprints.filter((f) => f.models.some((m) => !m.hide)).length;
    const missing = this.view3d?.missingModels ?? [];
    const missingList = missing.length
      ? `<div class="panel-title">3D models not found · ${missing.length}</div>
        <div class="pins">${missing
          .slice()
          .sort((a, b) => a.reference.localeCompare(b.reference, undefined, { numeric: true }))
          .map((m) => `<a class="n" data-ref3d="${escapeHtml(m.reference)}">${escapeHtml(m.reference)}</a><span></span><span class="muted" style="word-break:break-all">${escapeHtml(m.path.split("/").pop())}</span>`)
          .join("")}</div>`
      : "";
    $("#info3d").innerHTML = `
      ${netCard}
      ${selected || !net ? part : ""}
      <div class="panel-title">Board</div>
      <dl class="kv"><dt>Thickness</dt><dd>${pcb.thickness} mm</dd><dt>Finish</dt><dd>${escapeHtml(pcb.finish ?? "—")}</dd><dt>Footprints</dt><dd>${pcb.footprints.length}</dd><dt>With 3D model</dt><dd>${withModels}</dd></dl>
      ${rows ? `<div class="panel-title">Stackup</div><div class="stack">${rows}</div>` : ""}
      ${missingList}
      <p class="muted" style="font-size:12px">Models load from the project and from the 3D model sources in Settings; models referenced by a path on the designer's computer are looked up by file name in the project's repository and in those sources. Parts whose model can't be loaded are not shown.</p>`;
    for (const b of document.querySelectorAll("#info3d [data-probe3d]")) b.addEventListener("click", () => this.crossProbe(selected.reference, b.dataset.probe3d));
    for (const a of document.querySelectorAll("#info3d [data-ref3d]")) a.addEventListener("click", () => this.crossProbe(a.dataset.ref3d, "3d"));
    for (const b of document.querySelectorAll("#info3d [data-netprobe3d]")) b.addEventListener("click", () => this.crossProbeNet(net, b.dataset.netprobe3d));
    $("#net3d-clear")?.addEventListener("click", () => {
      this.view3d.highlightNet(null);
      this.render3dInfo(selected);
      this.writeHash();
    });
  }

  /** Select a reference across views ("U3"), switching tab if needed. */
  select(ref, tab = this.tab) {
    if (tab === "pcb") return this.pcb.selectReference(ref, true);
    if (tab === "sch") return this.sch.selectReference(ref, true);
    if (tab === "3d") return this.crossProbe(ref, "3d");
  }

  crossProbe(ref, toTab) {
    if (toTab === "pcb" && this.project.pcb) {
      this.showTab("pcb");
      if (!this.pcb.selectReference(ref, true)) toast(`${ref} is not on the board`, true);
    } else if (toTab === "sch") {
      this.showTab("sch");
      if (!this.sch.selectReference(ref, true)) toast(`${ref} is not in the schematic`, true);
    } else if (toTab === "3d" && this.project.pcb) {
      this.showTab("3d");
      this.show3d().then((v) => {
        if (!v) return;
        if (!v.select(ref, { focus: true }) && !v.select(ref.replace(/[A-Z]+$/, ""), { focus: true })) toast(`${ref} is not on the board`, true);
        this.render3dInfo(this.project.pcb.footprints.find((f) => f.reference === v.selectedRef) ?? null);
        this.writeHash();
      });
    }
  }

  /** Show a board net in another view: highlighted traces, pads and wires. */
  crossProbeNet(net, toTab) {
    if (!net) return;
    if (toTab === "pcb" && this.project.pcb) {
      this.showTab("pcb");
      this.pcb.highlightNet(net, true);
    } else if (toTab === "sch") {
      this.showTab("sch");
      if (!this.sch.selectBoardNet(net)) toast(`${net} is not drawn in the schematic`, true);
    } else if (toTab === "3d" && this.project.pcb) {
      this.showTab("3d");
      this.show3d().then(async (v) => {
        if (!v) return;
        v.select(null);
        if (!(await v.highlightNet(net, { focus: true }))) toast(`${net} is not on the board`, true);
        this.render3dInfo(null);
        this.writeHash();
      });
    }
  }

  // ---- deep links ----

  stateForHash() {
    if (!this.source || this.source.kind !== "github") return null;
    const s = this.source;
    const p = new URLSearchParams();
    p.set("gh", `${s.owner}/${s.repo}@${s.ref}${s.dir ? `:${s.dir}` : ""}`);
    if (s.commit) p.set("commit", s.commit);
    if (this.entry) p.set("project", this.entry.pro ?? this.entry.sch ?? this.entry.pcb);
    p.set("tab", this.tab);
    if (this.tab === "sch" && this.sch.pageIndex) p.set("page", String(this.sch.pageIndex));
    const sel = this.tab === "pcb" ? this.pcb.selectedRef : this.tab === "sch" ? this.sch.selectedRef : this.tab === "3d" ? this.view3d?.selectedRef : null;
    if (sel) p.set("sel", sel);
    const net = this.tab === "pcb" ? this.pcb.net : this.tab === "3d" ? this.view3d?.highlightedNet : this.tab === "sch" ? this.sch.selected?.boardNet : null;
    if (net) p.set("net", net);
    if (this.pr) p.set("pr", `${this.pr.owner}/${this.pr.repo}#${this.pr.number}`);
    const thread = this.tab === "sch" || this.tab === "pcb" ? this[this.tab].review.activeThreadId : null;
    if (thread) p.set("thread", String(thread));
    return p;
  }

  writeHash() {
    const p = this.stateForHash();
    if (!p) return;
    this._writingHash = true;
    history.replaceState(null, "", `#${p.toString()}`);
    setTimeout(() => (this._writingHash = false), 0);
  }

  /** The branch menu of a GitHub project: the repository's branches; picking one reopens the project there. */
  mountGitHubBranches(entry) {
    const s = this.source;
    const project = entry.pro ?? entry.sch ?? entry.pcb;
    const current = this.pr?.headRef ?? s.ref;
    mountBranchMenu({
      kind: "github",
      branch: this.refLabel(),
      title: `${s.owner}/${s.repo} at ${this.refLabel()}`,
      listBranches: async () => {
        const all = [];
        for (let page = 1; page <= 5; page++) {
          const batch = await GitHubSource.api(`/repos/${s.owner}/${s.repo}/branches?per_page=100&page=${page}`, settings().token);
          all.push(...batch);
          if (batch.length < 100) break;
        }
        return all.map((b) => ({ name: b.name, current: b.name === current })).sort((a, b) => b.current - a.current || a.name.localeCompare(b.name));
      },
      // Through the URL, like a link: the viewer reopens the same project and tab on that branch.
      switchTo: async (name) => {
        location.hash = new URLSearchParams({ gh: `${s.owner}/${s.repo}@${name}${s.dir ? `:${s.dir}` : ""}`, project, tab: this.tab }).toString();
      },
    });
  }

  /**
   * The history menu of a GitHub project: the branch's commits; picking one reopens
   * the project at that commit, through the URL (`commit=`, the branch stays in `gh=`).
   * Not for a pull request, which shows its head commit with its review comments.
   */
  mountGitHubHistory() {
    if (this.pr) return $("#history-menu")?.remove();
    const s = this.source;
    mountHistoryMenu({
      kind: "github",
      viewing: s.commit ?? null,
      latest: `Latest on ${this.refLabel()}`,
      branch: this.refLabel(),
      listCommits: async (offset, count) => {
        const page = Math.floor(offset / count) + 1;
        const batch = await GitHubSource.api(`/repos/${s.owner}/${s.repo}/commits?sha=${encodeURIComponent(s.ref)}&per_page=${count}&page=${page}`, settings().token);
        return batch.map((c) => ({
          sha: c.sha,
          summary: c.commit.message.split("\n")[0],
          author: c.commit.author?.name ?? c.author?.login ?? "",
          time: Date.parse(c.commit.author?.date ?? c.commit.committer?.date) / 1000,
        }));
      },
      // The same project, tab, sheet and selection at the other commit.
      show: async (sha) => {
        const p = this.stateForHash();
        p.delete("commit");
        if (sha) p.set("commit", sha);
        location.hash = p.toString();
      },
    });
  }

  /**
   * The Visual diff button of a GitHub project: the pull request, the commit
   * shown, or the branch against the default branch (the diff page then lets
   * other branches and commits be picked).
   */
  setGitHubDiff() {
    const s = this.source;
    const at = this.pr ? { pr: String(this.pr.number) } : s.commit || /^[0-9a-f]{40}$/i.test(s.ref) ? { commit: s.commit ?? s.ref } : { head: s.ref };
    const owner = this.pr?.owner ?? s.owner, repo = this.pr?.repo ?? s.repo; // a fork's PR is diffed in the base repository
    setDiffButton({
      href: `diff.html#${new URLSearchParams({ gh: `${owner}/${repo}`, ...at })}`,
      title: this.pr ? `Visual diff of pull request #${this.pr.number}` : at.commit ? `Visual diff of commit ${at.commit.slice(0, 7)}` : `Visual diff of ${s.ref} against the default branch (its latest commit if it is the default); pick other branches or commits there`,
    });
  }

  restoreFromHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const gh = p.get("gh");
    if (!gh) return;
    this.openGitHub(gh, { project: p.get("project"), tab: p.get("tab"), page: p.get("page"), sel: p.get("sel"), net: p.get("net"), file: p.get("file"), pr: p.get("pr"), thread: p.get("thread"), commit: p.get("commit") });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

window.kivi = new App();

/** The project a repository file belongs to: its board or root sheet, else the deepest project folder holding it. */
function projectOfFile(projects, file) {
  const exact = projects.find((p) => p.pcb === file || p.sch === file || p.pro === file);
  if (exact) return exact;
  const holding = projects.filter((p) => !p.dir || file.startsWith(p.dir + "/"));
  return holding.sort((a, b) => (b.dir?.length ?? 0) - (a.dir?.length ?? 0))[0] ?? null;
}
