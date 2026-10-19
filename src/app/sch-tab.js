// Schematic tab: sheet navigation, selection, inspector, search.

import { renderSchematic } from "../sch/render.js";
import { pageRenderOptions } from "../project.js";
import { buildConnectivity, boardNetFor } from "../sch/connectivity.js";
import { f } from "../geom.js";
import { SvgView } from "./svgview.js";
import { ReviewPanel } from "./review-ui.js";
import { pickSch, locateSch } from "../diff/anchors.js";
import { $, escapeHtml, refCompare, toast, collapsible, settings } from "./ui.js";

export class SchematicTab {
  constructor(app) {
    this.app = app;
    this.view = new SvgView($("#sch-canvas"), {
      onPick: (p) => this.pick(p),
      onHover: (p) => this.hover(p),
      onDblPick: (p) => this.dblPick(p),
      onViewChange: () => this.review?.position(),
    });
    this.review = new ReviewPanel(app.store, this.reviewHost(), { container: $("#tab-sch .panel.left"), wrap: $("#sch-canvas").parentElement, collapsed: true });
    this.cache = new Map();
    this.pageIndex = 0;
    this.selected = null;
    this.selectedRef = null;
    this.dark = false;
    this.setDark(settings().schDark === true);
    // The switch is in Settings (account menu).
    window.addEventListener("kivi:settings", () => {
      if ((settings().schDark === true) !== this.dark) this.setDark(settings().schDark === true);
    });
    const search = $("#search");
    search.addEventListener("change", () => this.search(search.value));
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.search(search.value);
    });
    for (const b of document.querySelectorAll("#tab-sch [data-zoom]")) b.addEventListener("click", () => this.zoom(b.dataset.zoom));
    collapsible($("#sheets-head"), $("#sheet-list"));
  }

  /** Dark schematic colours (the `schDark` setting). */
  setDark(on) {
    this.dark = on;
    $("#sch-canvas").classList.toggle("dark", on);
    this.connCache = new Map();
    if (this.rendered) this.showPage(this.pageIndex, true);
  }

  load(project) {
    this.project = project;
    this.cache.clear();
    this.connCache = new Map();
    this.pageIndex = 0;
    this.selected = null;
    this.selectedRef = null;
    this.rendered = false;
    const list = $("#sheet-list");
    list.innerHTML = project.pages
      .map((p, i) => `<li><button data-page="${i}" style="padding-left:${8 + Math.min(p.depth, 6) * 12}px"><span>${escapeHtml(p.depth ? p.name : project.name)}</span><span class="pg">${escapeHtml(p.page)}</span></button></li>`)
      .join("");
    for (const b of list.querySelectorAll("button")) b.addEventListener("click", () => this.showPage(Number(b.dataset.page)));
    this.inspect(null);
    // Search suggestions (references across all sheets) are built lazily.
    this.index = null;
    $("#search-list").innerHTML = "";
    setTimeout(() => this.buildIndex(), 50);
  }

  show() {
    if (!this.rendered && this.project?.pages.length) this.showPage(this.pageIndex);
  }

  render(i) {
    const key = `${i}:${this.dark ? "d" : "k"}`;
    if (!this.cache.has(key)) {
      const page = this.project.pages[i];
      this.cache.set(key, renderSchematic(page.sch, pageRenderOptions(this.project, page, { theme: this.dark ? "dark" : "kicad" })));
    }
    return this.cache.get(key);
  }

  showPage(i, keepView = false) {
    if (!this.project?.pages[i]) return;
    const sameSheet = i === this.pageIndex && this.rendered;
    this.pageIndex = i;
    const r = this.render(i);
    this.items = r.items;
    const page = this.project.pages[i];
    this.view.setSvg(r.svg, { x0: 0, y0: 0, x1: page.sch.paper.width, y1: page.sch.paper.height }, keepView && sameSheet);
    this.rendered = true;
    for (const b of document.querySelectorAll("#sheet-list button")) {
      if (Number(b.dataset.page) === i) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    }
    this.crumbs(page);
    // Shown next to the (collapsed) Sheets heading.
    $("#sheet-current").textContent = `${page.depth ? page.name : this.project.name} · ${page.page}/${this.project.pageCount}`;
    if (!keepView) {
      this.selected = null;
      this.selectedRef = null;
      this.inspect(null);
    }
    this.review.refresh(); // pins of this sheet (redraws the overlay)
    this.app.writeHash();
  }

  crumbs(page) {
    // Walk up the hierarchy by path prefix.
    const chain = [];
    let path = page.path;
    while (path) {
      const idx = this.project.pages.findIndex((p) => p.path === path);
      if (idx >= 0) chain.unshift(idx);
      const cut = path.lastIndexOf("/");
      if (cut <= 0) break;
      path = path.slice(0, cut);
    }
    const el = $("#sch-crumbs");
    if (chain.length < 2) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = chain
      .map((idx, k) => {
        const p = this.project.pages[idx];
        const name = escapeHtml(p.depth ? p.name : this.project.name);
        return k === chain.length - 1 ? `<span>${name}</span>` : `<a href="#" data-page="${idx}">${name}</a><span class="sep">/</span>`;
      })
      .join("");
    for (const a of el.querySelectorAll("a")) {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        this.showPage(Number(a.dataset.page));
      });
    }
  }

  zoom(kind) {
    const v = this.view.view;
    if (!v) return;
    if (kind === "fit") this.view.fit();
    else this.view.zoomAt(kind === "in" ? 0.7 : 1.4, v.x + v.w / 2, v.y + v.h / 2);
  }

  hit(p) {
    let best = null, area = Infinity;
    for (const it of this.items ?? []) {
      if (!it.bbox.contains(p.x, p.y)) continue;
      const a = it.bbox.w * it.bbox.h * (it.kind === "sheet" ? 50 : 1); // prefer things inside sheets
      if (a < area) {
        area = a;
        best = it;
      }
    }
    return best;
  }

  /** Net connectivity of a page (built on demand, cached). */
  connectivity(i = this.pageIndex) {
    this.connCache ??= new Map();
    if (!this.connCache.has(i)) this.connCache.set(i, buildConnectivity(this.project.pages[i].sch, this.render(i).items));
    return this.connCache.get(i);
  }

  pick(p) {
    if (this.review.pick(p, "sch")) return;
    const it = this.hit(p);
    // Labels and wires select the whole net.
    if (it?.kind === "label") {
      const label = this.project.pages[this.pageIndex].sch.labels.find((l) => l.x === it.x && l.y === it.y);
      const g = label && this.connectivity().forLabel(label);
      if (g) return this.selectNet(g);
    }
    const tol = Math.max(0.4, 5 / (this.view.scale || 1));
    const g = this.connectivity().atPoint(p.x, p.y, tol);
    if (g && (!it || it.kind !== "symbol" || this.nearWireOnly(it, p, tol))) return this.selectNet(g);
    this.select(it);
  }

  /** A click on a symbol's pin tip that touches a wire counts as the wire. */
  nearWireOnly(it, p, tol) {
    return it.pins.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < tol * 2);
  }

  hover(p) {
    this.review.hover(p, "sch");
    const it = this.hit(p);
    if (it === this.hovered) return;
    this.hovered = it;
    this.updateOverlay();
  }

  dblPick(p) {
    const it = this.hit(p);
    if (it?.kind === "sheet") this.enterSheet(it.uuid);
  }

  enterSheet(uuid) {
    const cur = this.project.pages[this.pageIndex];
    const target = this.project.pages.findIndex((pg) => pg.path === `${cur.path === "/" ? "" : cur.path}/${uuid}`);
    if (target >= 0) this.showPage(target);
  }

  /** Select a schematic net (connectivity group): highlight its wires and inspect it. */
  selectNet(group, zoom = false) {
    const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const grow = (x, y) => {
      bb.x0 = Math.min(bb.x0, x);
      bb.y0 = Math.min(bb.y0, y);
      bb.x1 = Math.max(bb.x1, x);
      bb.y1 = Math.max(bb.y1, y);
    };
    for (const sg of group.segments) (grow(sg.a.x, sg.a.y), grow(sg.b.x, sg.b.y));
    for (const l of group.labels) grow(l.x, l.y);
    for (const q of group.pins) grow(q.x, q.y);
    const boardNet = boardNetFor(group, this.app.project.pcb);
    this.selected = { kind: "net", group, boardNet, bbox: { ...bb, w: bb.x1 - bb.x0, h: bb.y1 - bb.y0, contains: () => false } };
    this.selectedRef = null;
    this.updateOverlay();
    this.inspectNet(group, boardNet);
    if (zoom && Number.isFinite(bb.x0)) this.view.zoomTo(bb, 30);
    this.app.writeHash();
  }

  /** Show a board net in the schematic: page of one of its pads' symbols. */
  selectBoardNet(net, zoom = true) {
    const pcb = this.app.project.pcb;
    const idx = this.buildIndex();
    const tryPage = (page, finder) => {
      const g = finder(this.connectivity(page));
      if (!g) return false;
      if (page !== this.pageIndex || !this.rendered) this.showPage(page);
      this.selectNet(g, zoom);
      return true;
    };
    for (const fp of pcb?.footprints ?? []) {
      for (const pad of fp.pads) {
        if (pad.net !== net) continue;
        for (const { page } of idx.refs.get(fp.reference) ?? []) {
          if (tryPage(page, (c) => c.forPin(fp.reference, pad.number))) return true;
        }
      }
    }
    // Nets without component pins on a sheet: match labels by name.
    const name = net.split("/").pop();
    for (let i = 0; i < this.project.pages.length; i++) if (tryPage(i, (c) => c.named(name)[0])) return true;
    return false;
  }

  select(it, zoom = false) {
    this.selected = it;
    this.selectedRef = it?.kind === "symbol" && !it.power ? it.baseReference : null;
    this.updateOverlay();
    this.inspect(it);
    if (it && zoom) this.view.zoomTo(it.bbox, 25);
    this.app.writeHash();
  }

  updateOverlay() {
    const rect = (b, cls) => `<rect class="${cls}" x="${f(b.x0)}" y="${f(b.y0)}" width="${f(b.x1 - b.x0)}" height="${f(b.y1 - b.y0)}"/>`;
    let html = "";
    if (this.hovered && this.hovered !== this.selected) html += rect(this.hovered.bbox, "hover");
    const sel = this.selected;
    if (sel?.kind === "net") {
      const g = sel.group;
      const d = g.segments.map((sg) => `M${f(sg.a.x)} ${f(sg.a.y)}L${f(sg.b.x)} ${f(sg.b.y)}`).join("");
      html += `<path class="net-hl" d="${d}"/>`;
      for (const q of g.pins) html += `<circle class="net-pin" cx="${f(q.x)}" cy="${f(q.y)}" r="0.55"/>`;
      for (const l of g.labels) {
        const it = this.items.find((i) => i.kind === "label" && i.x === l.x && i.y === l.y);
        if (it) html += rect(it.bbox, "net-label");
      }
    } else if (sel) html += rect(sel.bbox, "sel");
    this.view.setOverlayHtml(html + this.review.overlay("sch"));
  }

  inspectNet(g, boardNet) {
    const el = $("#sch-inspector");
    const pins = g.pins.filter((p) => !p.power).sort((a, b) => refCompare(`${a.ref}.${a.number}`, `${b.ref}.${b.number}`));
    const labels = [...new Map(g.labels.map((l) => [`${l.kind}|${l.text}`, l])).values()];
    const pcb = this.app.project.pcb;
    const kind = { label: "local", global_label: "global", hierarchical_label: "hierarchical" };
    // The board's net name is KiCad's own choice when several labels meet; prefer it.
    const title = boardNet && !/^(Net-\(|unconnected-)/.test(boardNet) ? boardNet.split("/").pop() : g.name ?? boardNet ?? "unnamed net";
    el.innerHTML = `
      <div class="panel-title">Net</div>
      <h2 style="word-break:break-all">${escapeHtml(title)}</h2>
      ${boardNet && boardNet !== title ? `<div class="sub mono">Board net ${escapeHtml(boardNet)}</div>` : ""}
      <div class="actions">
        ${boardNet ? `<button class="btn" data-netprobe="pcb">Highlight on PCB</button><button class="btn" data-netprobe="3d">Show in 3D</button>` : pcb ? `<span class="muted" style="font-size:12px">Not routed on the board</span>` : ""}
      </div>
      <dl class="kv">
        <dt>Wires</dt><dd>${g.segments.length}</dd>
        <dt>Pins on sheet</dt><dd>${pins.length}</dd>
        ${labels.length ? `<dt>Labels</dt><dd>${labels.map((l) => `${escapeHtml(l.text)} <span class="muted">(${kind[l.kind] ?? l.kind})</span>`).join("<br>")}</dd>` : ""}
      </dl>
      ${pins.length ? `<div class="panel-title">Pins</div><div class="pins">${pins.map((p) => `<a class="n" data-ref="${escapeHtml(p.ref)}">${escapeHtml(p.ref)}</a><span class="n">${escapeHtml(p.number)}</span><span>${escapeHtml(p.name && p.name !== "~" ? p.name : "")}</span>`).join("")}</div>` : ""}`;
    for (const b of el.querySelectorAll("[data-netprobe]")) b.addEventListener("click", () => this.app.crossProbeNet(boardNet, b.dataset.netprobe));
    for (const a of el.querySelectorAll("a[data-ref]")) a.addEventListener("click", () => this.selectReference(a.dataset.ref, true));
  }

  inspect(it) {
    const el = $("#sch-inspector");
    if (!it) {
      const page = this.project?.pages[this.pageIndex];
      if (!page) {
        el.innerHTML = "";
        return;
      }
      const tb = page.sch.titleBlock;
      const symbols = (this.items ?? []).filter((i) => i.kind === "symbol" && !i.power).length;
      el.innerHTML = `
        <div class="panel-title">Sheet</div>
        <h2 style="font-family:var(--font);font-size:17px;color:var(--text)">${escapeHtml(page.depth ? page.name : this.project.name)}</h2>
        <dl class="kv">
          <dt>File</dt><dd class="mono">${escapeHtml(page.file.split("/").pop())}</dd>
          <dt>Page</dt><dd>${escapeHtml(page.page)} / ${this.project.pageCount}</dd>
          ${tb.title ? `<dt>Title</dt><dd>${escapeHtml(tb.title)}</dd>` : ""}
          ${tb.rev ? `<dt>Revision</dt><dd>${escapeHtml(tb.rev)}</dd>` : ""}
          ${tb.date ? `<dt>Date</dt><dd>${escapeHtml(tb.date)}</dd>` : ""}
          ${tb.company ? `<dt>Company</dt><dd>${escapeHtml(tb.company)}</dd>` : ""}
          <dt>Symbols</dt><dd>${symbols}</dd>
        </dl>
        <p class="empty">Click a symbol to inspect it. Double-click a sheet to open it. Scroll to zoom, drag to pan.</p>`;
      return;
    }
    if (it.kind === "symbol") {
      const fp = this.app.project.pcb?.footprints.find((f) => f.reference === it.baseReference);
      const netOf = (num) => fp?.pads.find((p) => p.number === num)?.net ?? "";
      const props = it.properties.filter((p) => !["Reference", "Value"].includes(p.name) && p.value && p.value !== "~");
      const datasheet = props.find((p) => p.name === "Datasheet" && /^https?:/.test(p.value));
      const pins = it.pins
        .slice()
        .sort((a, b) => refCompare(a.number, b.number))
        .map((p) => {
          const net = netOf(p.number);
          return `<span class="n">${escapeHtml(p.number)}</span><span>${escapeHtml(p.name && p.name !== "~" ? p.name : "")}</span>${net ? `<a data-net="${escapeHtml(net)}" title="Highlight on PCB">${escapeHtml(net)}</a>` : `<span class="muted">${escapeHtml(p.type)}</span>`}`;
        })
        .join("");
      el.innerHTML = `
        <div class="row gap"><h2>${escapeHtml(it.reference)}</h2>${it.dnp ? '<span class="tag warn">DNP</span>' : ""}${it.power ? '<span class="tag">power</span>' : ""}</div>
        <div style="font-weight:500">${escapeHtml(it.value)}</div>
        ${it.description ? `<div class="sub">${escapeHtml(it.description)}</div>` : ""}
        <div class="actions">
          ${fp ? `<button class="btn" data-probe="pcb">Show on PCB</button><button class="btn" data-probe="3d">Show in 3D</button>` : ""}
          ${datasheet ? `<a class="btn" href="${escapeHtml(datasheet.value)}" target="_blank" rel="noopener">Datasheet</a>` : ""}
        </div>
        <dl class="kv">
          <dt>Symbol</dt><dd class="mono" style="font-size:12px">${escapeHtml(it.libId)}</dd>
          ${it.unit > 1 || /[A-Z]$/.test(it.reference) ? `<dt>Unit</dt><dd>${it.unit}</dd>` : ""}
          ${props.filter((p) => p.name !== "Datasheet" || !datasheet).map((p) => `<dt>${escapeHtml(p.name)}</dt><dd>${linkify(p.value)}</dd>`).join("")}
        </dl>
        ${it.pins.length ? `<div class="panel-title">Pins · ${it.pins.length}</div><div class="pins">${pins}</div>` : ""}`;
      for (const b of el.querySelectorAll("[data-probe]")) b.addEventListener("click", () => this.app.crossProbe(it.baseReference, b.dataset.probe));
      for (const a of el.querySelectorAll("a[data-net]")) a.addEventListener("click", () => this.app.crossProbeNet(a.dataset.net, "pcb"));
    } else if (it.kind === "sheet") {
      el.innerHTML = `
        <div class="panel-title">Hierarchical sheet</div>
        <h2 style="font-family:var(--font);font-size:17px;color:var(--text)">${escapeHtml(it.name)}</h2>
        <dl class="kv"><dt>File</dt><dd class="mono">${escapeHtml(it.file)}</dd><dt>Pins</dt><dd>${it.pins.length}</dd></dl>
        <div class="actions"><button class="btn primary" id="enter-sheet">Open sheet</button></div>`;
      $("#enter-sheet").addEventListener("click", () => this.enterSheet(it.uuid));
    }
  }

  // ---- review comments (pull requests) ----

  /** Page a thread belongs to: its sheet instance, else the first page drawn from its file. */
  pageOf(t) {
    const pages = this.project?.pages ?? [];
    const inst = t.anchor?.sheet ? pages.findIndex((p) => p.path === t.anchor.sheet && p.file === t.path) : -1;
    return inst >= 0 ? inst : pages.findIndex((p) => p.file === t.path);
  }

  /** Adapter between the comment panel and this canvas (see review-ui.js). */
  reviewHost() {
    const tab = this;
    const page = () => tab.project?.pages[tab.pageIndex];
    const pageName = (p) => (p.depth ? p.name : tab.project.name);
    return {
      enabled: () => !!tab.project?.pages.length,
      active: () => tab.app.tab === "sch" && !$("#app").hidden,
      docKey: () => page(),
      view: () => tab.view,
      defaultView: () => "sch",
      showsSide: (name, side) => side === "head",
      place(t) {
        const pg = page();
        if (!pg || !tab.rendered || t.path !== pg.file) return null;
        // Another instance of a multi-instance sheet.
        if (t.anchor?.sheet && t.anchor.sheet !== pg.path && tab.pageOf(t) !== tab.pageIndex) return null;
        if (!t.anchor) return { side: null };
        if (t.anchor.side === "base") return { side: null, note: "Made on the previous version, in the visual diff." };
        return { side: "head", ...locateSch(pg.sch, tab.render(tab.pageIndex), tab.connectivity(), t.anchor) };
      },
      list(threads) {
        const files = new Set(tab.project?.pages.map((p) => p.file) ?? []);
        return threads
          .filter((t) => files.has(t.path))
          .map((thread) => {
            const i = tab.pageOf(thread);
            return { thread, here: i === tab.pageIndex, where: i >= 0 ? `sheet ${pageName(tab.project.pages[i])}` : null };
          })
          .sort((a, b) => b.here - a.here);
      },
      goto(t) {
        const i = tab.pageOf(t);
        if (i < 0) return false;
        if (i !== tab.pageIndex || !tab.rendered) tab.showPage(i);
        return true;
      },
      target(p) {
        const pg = page();
        if (!pg) return null;
        const t = pickSch(pg.sch, tab.render(tab.pageIndex), tab.connectivity(), p, Math.max(0.4, 5 / (tab.view.scale || 1)));
        t.anchor.sheet = pg.path; // which instance of the sheet
        return { ...t, side: "head" };
      },
      commentPath: () => page().file,
      refreshOverlay: () => tab.rendered && tab.updateOverlay(),
      zoomMin: 25,
      writeHash: () => tab.app.writeHash(),
    };
  }

  /** Index of references → page for search and cross-probing. */
  buildIndex() {
    if (this.index || !this.project) return this.index;
    const refs = new Map();
    const nets = new Set();
    this.project.pages.forEach((page, i) => {
      const r = this.render(i);
      for (const it of r.items) {
        if (it.kind === "symbol" && !it.power) {
          if (!refs.has(it.baseReference)) refs.set(it.baseReference, []);
          refs.get(it.baseReference).push({ page: i, item: it });
        } else if (it.kind === "label") nets.add(it.text);
      }
    });
    this.index = { refs, nets };
    const opts = [...refs.keys()].sort(refCompare).concat([...nets].sort());
    $("#search-list").innerHTML = opts
      .slice(0, 5000)
      .map((o) => `<option value="${escapeHtml(o)}"></option>`)
      .join("");
    return this.index;
  }

  selectReference(ref, zoom) {
    const idx = this.buildIndex();
    const hit = idx.refs.get(ref) ?? idx.refs.get(ref.replace(/[A-Z]+$/, ""));
    if (!hit) return false;
    const { page, item } = hit[0];
    if (page !== this.pageIndex || !this.rendered) this.showPage(page);
    const live = this.items.find((i) => i.uuid === item.uuid) ?? item;
    this.select(live, zoom);
    return true;
  }

  search(q) {
    q = q.trim();
    if (!q) return;
    const idx = this.buildIndex();
    if (this.selectReference(q, true)) return;
    const upper = q.toUpperCase();
    const ref = [...idx.refs.keys()].find((r) => r.toUpperCase() === upper);
    if (ref) return this.selectReference(ref, true);
    // Net label: first page containing it.
    for (let i = 0; i < this.project.pages.length; i++) {
      const r = this.render(i);
      const lab = r.items.find((it) => it.kind === "label" && it.text.toUpperCase() === upper);
      if (lab) {
        if (i !== this.pageIndex) this.showPage(i);
        const label = this.project.pages[i].sch.labels.find((l) => l.x === lab.x && l.y === lab.y);
        const g = label && this.connectivity(i).forLabel(label);
        if (g) this.selectNet(g, true);
        else this.select(this.items.find((it) => it.kind === "label" && it.x === lab.x && it.y === lab.y) ?? lab, true);
        return;
      }
    }
    toast(`Nothing named "${q}" in the schematic`, true);
  }
}

function linkify(v) {
  const s = escapeHtml(v);
  return /^https?:\/\//.test(v) ? `<a href="${s}" target="_blank" rel="noopener">${s}</a>` : s;
}
