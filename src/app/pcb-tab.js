// PCB tab: layers, side, picking, net highlight, inspector.

import { renderPcb, DEFAULT_VISIBLE, boardBBox } from "../pcb/render.js";
import { PCB_THEMES } from "../pcb/theme.js";
import { hitTest } from "../pcb/hit.js";
import { snapPoints } from "../pcb/snap.js";
import { arcFrom3 } from "../geom.js";
import { unescapeKiCad } from "../text.js";
import { SvgView } from "./svgview.js";
import { MeasureTool } from "./measure.js";
import { ReviewPanel } from "./review-ui.js";
import { pickPcb, locatePcb } from "../diff/anchors.js";
import { $, escapeHtml, refCompare, toast } from "./ui.js";

const LAYER_ALIASES = {
  "F.SilkS": "Silkscreen", "B.SilkS": "Silkscreen", "F.Mask": "Solder mask", "B.Mask": "Solder mask",
  "F.Paste": "Paste", "B.Paste": "Paste", "F.Fab": "Fabrication", "B.Fab": "Fabrication",
  "F.CrtYd": "Courtyard", "B.CrtYd": "Courtyard", "Edge.Cuts": "Board outline", "Dwgs.User": "Drawings",
  "Cmts.User": "Comments", "F.Adhes": "Adhesive", "B.Adhes": "Adhesive", Vias: "", Holes: "",
};

export class PcbTab {
  constructor(app) {
    this.app = app;
    this.side = "front";
    this.cache = new Map();
    this.visible = null;
    this.selected = null;
    this.selectedRef = null;
    this.net = null;
    this.view = new SvgView($("#pcb-canvas"), {
      onPick: (p) => this.pick(p),
      onHover: (p) => this.hover(p),
      onDblPick: () => this.clear(),
      onViewChange: () => this.review?.position(),
      flipX: null,
    });
    this.review = new ReviewPanel(app.store, this.reviewHost(), { container: $("#tab-pcb .panel.left"), wrap: $("#pcb-canvas").parentElement, collapsed: true });
    this.measure = new MeasureTool(this.view, { button: $("#pcb-measure"), chip: $("#pcb-measure-chip"), points: () => this.measurePoints() });
    for (const b of document.querySelectorAll("#tab-pcb [data-side]")) b.addEventListener("click", () => this.setSide(b.dataset.side));
    $("#layers-all").addEventListener("click", () => this.setVisible(() => true));
    $("#layers-cu").addEventListener("click", () => this.setVisible((l) => l.endsWith(".Cu") || l === "Edge.Cuts" || l === "Vias" || l === "Holes"));
    $("#layers-default").addEventListener("click", () => this.setVisible((l) => DEFAULT_VISIBLE(l) || l === "Vias" || l === "Holes"));
    for (const b of document.querySelectorAll("#tab-pcb [data-zoom]")) {
      b.addEventListener("click", () => {
        const v = this.view.view;
        if (!v) return;
        if (b.dataset.zoom === "fit") this.view.fit();
        else this.view.zoomAt(b.dataset.zoom === "in" ? 0.7 : 1.4, v.x + v.w / 2, v.y + v.h / 2);
      });
    }
    $("#pcb-canvas").addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.clear();
    });
  }

  load(project) {
    this.project = project;
    this.pcb = project.pcb;
    this.cache.clear();
    this.rendered = false;
    this.visible = null;
    this.selected = null;
    this.selectedRef = null;
    this.net = null;
    this.side = "front";
    this.measure.invalidate();
    this.measure.reset();
    if (!this.pcb) return;
    this.boardInfo();
    this.inspect(null);
  }

  show() {
    if (this.pcb && !this.rendered) this.renderSide(this.side);
  }

  renderSide(side, keepView = false) {
    if (!this.cache.has(side)) this.cache.set(side, renderPcb(this.pcb, { side }));
    const r = this.cache.get(side);
    this.result = r;
    this.hovered = null; // hovered on the other side: its box would stay until the mouse moves
    this.side = side;
    this.measure.invalidate(); // footprint origins of the other side
    const cx = r.center;
    this.view.flipX = side === "back" ? (x) => 2 * cx - x : null;
    this.view.setSvg(r.svg, { x0: r.bbox.x0, y0: r.bbox.y0, x1: r.bbox.x1, y1: r.bbox.y1 }, keepView);
    this.rendered = true;
    const groups = [...this.view.svg.querySelectorAll("g[data-layer]")].map((g) => g.dataset.layer);
    if (!this.visible) this.visible = new Set(groups.filter((l) => DEFAULT_VISIBLE(l) || l === "Vias" || l === "Holes"));
    this.layerList(groups);
    this.applyVisibility();
    for (const b of document.querySelectorAll("#tab-pcb [data-side]")) b.setAttribute("aria-pressed", String(b.dataset.side === side));
    if (this.net) this.highlightNet(this.net);
    this.review.refresh(); // pins for this side (redraws the overlay)
  }

  setSide(side) {
    if (side === this.side && this.rendered) return;
    this.renderSide(side, true);
  }

  layerList(groups) {
    const theme = PCB_THEMES.kicad;
    // Top of the list = closest to the viewer.
    const ordered = groups.filter((l) => l !== "Vias" && l !== "Holes").reverse();
    ordered.push("Vias");
    const userName = new Map(this.pcb.layers.map((l) => [l.name, l.userName]));
    $("#layer-list").innerHTML = ordered
      .map((l) => {
        const color = l === "Vias" ? theme.via : theme.layer(l);
        const alias = LAYER_ALIASES[l] ?? (userName.get(l) && userName.get(l) !== l ? userName.get(l) : "");
        return `<li><label><input type="checkbox" data-layer="${escapeHtml(l)}" ${this.visible.has(l) ? "checked" : ""}><span class="sw" style="background:${color}"></span>${escapeHtml(l)}<span class="alias">${escapeHtml(alias)}</span></label></li>`;
      })
      .join("");
    for (const cb of document.querySelectorAll("#layer-list input")) {
      cb.addEventListener("change", () => {
        if (cb.checked) this.visible.add(cb.dataset.layer);
        else this.visible.delete(cb.dataset.layer);
        this.applyVisibility();
      });
    }
  }

  setVisible(pred) {
    const groups = [...this.view.svg.querySelectorAll("g[data-layer]")].map((g) => g.dataset.layer);
    this.visible = new Set(groups.filter(pred));
    this.visible.add("Holes");
    for (const cb of document.querySelectorAll("#layer-list input")) cb.checked = this.visible.has(cb.dataset.layer);
    this.applyVisibility();
  }

  applyVisibility() {
    this.measure.invalidate();
    for (const g of this.view.svg.querySelectorAll("g[data-layer]")) {
      if (this.visible.has(g.dataset.layer)) g.removeAttribute("display");
      else g.setAttribute("display", "none");
    }
  }

  boardInfo() {
    const pcb = this.pcb;
    const bb = boardBBox(pcb);
    const cu = pcb.layers.filter((l) => l.name.endsWith(".Cu")).length;
    const nets = new Set(pcb.footprints.flatMap((f) => f.pads.map((p) => p.net)).filter(Boolean));
    $("#board-info").innerHTML = `
      <dt>Size</dt><dd>${bb.w.toFixed(1)} × ${bb.h.toFixed(1)} mm</dd>
      <dt>Thickness</dt><dd>${pcb.thickness} mm</dd>
      <dt>Copper</dt><dd>${cu} layers</dd>
      <dt>Footprints</dt><dd>${pcb.footprints.length}</dd>
      <dt>Nets</dt><dd>${nets.size}</dd>
      <dt>Tracks</dt><dd>${pcb.tracks.length}</dd>
      <dt>Vias</dt><dd>${pcb.vias.length}</dd>`;
  }

  // ---- measuring ----

  /** Points the measuring tool snaps to, on the layers shown. */
  measurePoints() {
    return this.pcb ? snapPoints(this.pcb, this.visible ?? new Set(), this.side) : [];
  }

  // ---- picking ----

  footprintAt(p) {
    let best = null, area = Infinity;
    for (const it of this.result.items) {
      if (!it.bbox.contains(p.x, p.y)) continue;
      const a = it.bbox.w * it.bbox.h * (it.side === this.side ? 1 : 4);
      if (a < area) {
        area = a;
        best = it;
      }
    }
    return best;
  }

  pick(p) {
    if (!this.result) return;
    if (this.review.pick(p, "pcb")) return;
    const slack = Math.max(0.05, 3 / this.view.scale);
    const hit = hitTest(this.pcb, p.x, p.y, this.visible, this.side, slack);
    const fpItem = this.footprintAt(p);
    if (hit?.kind === "pad") {
      const item = this.result.items.find((i) => i.fp === hit.footprint);
      this.select(item, false, hit.pad);
      if (hit.pad.net) this.highlightNet(hit.pad.net);
      return;
    }
    if (hit?.kind === "track" || hit?.kind === "via") {
      const net = hit.track?.net ?? hit.via?.net;
      this.select(null);
      if (net) {
        this.highlightNet(net);
        this.inspectNet(net);
      }
      return;
    }
    if (fpItem) {
      this.select(fpItem);
      return;
    }
    this.clear();
  }

  hover(p) {
    if (!this.result) return;
    this.review.hover(p, "pcb");
    const it = this.footprintAt(p);
    if (it === this.hovered) return;
    this.hovered = it;
    this.updateOverlay();
  }

  clear() {
    this.select(null);
    this.highlightNet(null);
  }

  select(item, zoom = false, pad = null) {
    this.selected = item;
    this.selectedRef = item?.reference ?? null;
    this.updateOverlay();
    this.inspect(item, pad);
    if (item && zoom) this.zoomToBoard(item.bbox, 8);
    this.app.writeHash();
  }

  /** Zoom to a box in board coordinates. The bottom view is drawn mirrored, so x is mirrored too. */
  zoomToBoard(box, minSize) {
    const m = this.view.flipX; // its own inverse: board x ↔ drawn x
    this.view.zoomTo(m ? { x0: m(box.x1), y0: box.y0, x1: m(box.x0), y1: box.y1 } : box, minSize);
  }

  selectReference(ref, zoom) {
    if (!this.rendered) this.renderSide(this.side);
    const item = this.result.items.find((i) => i.reference === ref) ?? this.result.items.find((i) => i.reference === ref.replace(/[A-Z]+$/, ""));
    if (!item) return false;
    if (item.side !== this.side) this.renderSide(item.side, true);
    const live = this.result.items.find((i) => i.fp === item.fp);
    this.select(live, zoom);
    return true;
  }

  updateOverlay() {
    const boxes = [];
    if (this.hovered && this.hovered !== this.selected) boxes.push({ ...plain(this.hovered.bbox), cls: "hover" });
    if (this.selected) boxes.push({ ...plain(this.selected.bbox), cls: "sel" });
    this.view.setOverlay(boxes, this.review.overlay("pcb"));
  }

  // ---- review comments (pull requests) ----

  /** Adapter between the comment panel and this canvas (see review-ui.js). */
  reviewHost() {
    const tab = this;
    const board = () => tab.app.entry?.pcb;
    const back = () => tab.side === "back" && tab.result;
    return {
      enabled: () => !!tab.pcb,
      active: () => tab.app.tab === "pcb" && !$("#app").hidden,
      docKey: () => tab.pcb,
      view: () => tab.view,
      defaultView: () => "pcb",
      showsSide: (name, side) => side === "head",
      place(t) {
        if (!tab.pcb || t.path !== board()) return null;
        if (!t.anchor || !tab.result) return { side: null };
        if (t.anchor.side === "base") return { side: null, note: "Made on the previous version, in the visual diff." };
        return { side: "head", ...locatePcb(tab.pcb, tab.result, t.anchor) };
      },
      list: (threads) => threads.filter((t) => t.path === board()).map((thread) => ({ thread, here: true })),
      goto(t) {
        if (t.path !== board()) return false;
        if (!tab.rendered) tab.renderSide(tab.side);
        return true;
      },
      target(p) {
        const slack = Math.max(0.05, 3 / (tab.view.scale || 1));
        return { ...pickPcb(tab.pcb, tab.result, p, { visible: tab.visible, side: tab.side, slack }), side: "head" };
      },
      commentPath: () => board(),
      // The bottom view is mirrored: pins move, marks get the board's own flip.
      toSvgX: (name, x) => (back() ? 2 * tab.result.center - x : x),
      markTransform: () => (back() ? `translate(${2 * tab.result.center} 0) scale(-1 1)` : ""),
      refreshOverlay: () => tab.rendered && tab.updateOverlay(),
      zoomMin: 8,
      writeHash: () => tab.app.writeHash(),
    };
  }

  /** Board net name for a (possibly unescaped, display-form) name. */
  resolveNet(name) {
    if (!name || this.result?.netIndex.has(name)) return name;
    for (const k of this.result?.netIndex.keys() ?? []) if (unescapeKiCad(k) === name) return k;
    return name;
  }

  highlightNet(name, zoom = false) {
    if (!this.result && this.pcb) this.renderSide(this.side);
    name = this.resolveNet(name);
    this.net = name || null;
    const canvas = $("#pcb-canvas");
    const svg = this.view.svg;
    if (!svg) return;
    for (const el of svg.querySelectorAll(".hl")) el.classList.remove("hl");
    const chip = $("#net-chip");
    if (!name) {
      canvas.classList.remove("highlighting");
      chip.hidden = true;
      return;
    }
    const idx = this.result.netIndex.get(name);
    if (idx === undefined) {
      toast(`Net ${name} is not on the board`, true);
      return;
    }
    canvas.classList.add("highlighting");
    this.app.writeHash();
    for (const el of svg.querySelectorAll(`[data-net="${idx}"]`)) el.classList.add("hl");
    chip.hidden = false;
    chip.innerHTML = `<span class="dot"></span>Net <span class="mono">${escapeHtml(name)}</span><button class="btn small" id="net-clear" aria-label="Clear highlight">✕</button>`;
    $("#net-clear").addEventListener("click", () => this.highlightNet(null));
    if (zoom) {
      const pads = this.pcb.footprints.flatMap((f) => f.pads).filter((p) => p.net === name);
      if (pads.length) {
        const xs = pads.map((p) => p.x), ys = pads.map((p) => p.y);
        this.zoomToBoard({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }, 10);
      }
      this.inspectNet(name);
    }
  }

  // ---- inspector ----

  inspect(item, pad = null) {
    const el = $("#pcb-inspector");
    if (!item) {
      if (!this.net) el.innerHTML = `<p class="empty">Click a footprint, pad or track. Scroll to zoom, drag to pan, double-click or Esc to clear. M (or the ruler) measures.</p>`;
      return;
    }
    const fp = item.fp;
    const inSch = this.app.project.pages.length > 0;
    const props = Object.entries(fp.properties).filter(([k, v]) => v && !["Reference", "Value"].includes(k) && !k.startsWith("ki_"));
    const pads = fp.pads
      .slice()
      .sort((a, b) => refCompare(a.number, b.number))
      .map((p) => `<span class="n">${escapeHtml(p.number)}</span><span>${escapeHtml(p.pinFunction || "")}</span>${p.net ? `<a data-net="${escapeHtml(p.net)}"${pad === p ? ' style="color:var(--accent)"' : ""}>${escapeHtml(p.net)}</a>` : '<span class="muted">—</span>'}`)
      .join("");
    el.innerHTML = `
      <div class="row gap"><h2>${escapeHtml(fp.reference)}</h2><span class="tag">${fp.side === "back" ? "Bottom" : "Top"}</span>${fp.dnp ? '<span class="tag warn">DNP</span>' : ""}</div>
      <div style="font-weight:500">${escapeHtml(fp.value)}</div>
      ${fp.description ? `<div class="sub">${escapeHtml(fp.description)}</div>` : ""}
      <div class="actions">${inSch ? '<button class="btn" data-probe="sch">Show in schematic</button>' : ""}<button class="btn" data-probe="3d">Show in 3D</button></div>
      ${pad ? `<div class="panel-title">Pad ${escapeHtml(pad.number)}</div><dl class="kv"><dt>Net</dt><dd class="mono">${escapeHtml(pad.net || "—")}</dd><dt>Type</dt><dd>${escapeHtml(pad.type)} · ${escapeHtml(pad.shape)}</dd><dt>Size</dt><dd>${pad.w.toFixed(3)} × ${pad.h.toFixed(3)} mm</dd>${pad.drill ? `<dt>Drill</dt><dd>${pad.drill.w.toFixed(3)}${pad.drill.oval ? ` × ${pad.drill.h.toFixed(3)}` : ""} mm</dd>` : ""}${pad.pinType ? `<dt>Pin type</dt><dd>${escapeHtml(pad.pinType)}</dd>` : ""}</dl>` : ""}
      <dl class="kv">
        <dt>Footprint</dt><dd class="mono" style="font-size:12px">${escapeHtml(fp.libId)}</dd>
        <dt>Position</dt><dd>${fp.x.toFixed(3)}, ${fp.y.toFixed(3)} mm</dd>
        <dt>Rotation</dt><dd>${fp.angle}°</dd>
        ${fp.attrs.length ? `<dt>Attributes</dt><dd>${escapeHtml(fp.attrs.join(", "))}</dd>` : ""}
        ${fp.sheetName ? `<dt>Sheet</dt><dd>${escapeHtml(fp.sheetName)}</dd>` : ""}
        ${props.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${/^https?:/.test(v) ? `<a href="${escapeHtml(v)}" target="_blank" rel="noopener">${escapeHtml(v)}</a>` : escapeHtml(v)}</dd>`).join("")}
      </dl>
      ${fp.pads.length ? `<div class="panel-title">Pads · ${fp.pads.length}</div><div class="pins">${pads}</div>` : ""}`;
    for (const b of el.querySelectorAll("[data-probe]")) b.addEventListener("click", () => this.app.crossProbe(fp.reference, b.dataset.probe));
    for (const a of el.querySelectorAll("a[data-net]")) a.addEventListener("click", () => this.highlightNet(a.dataset.net, true));
  }

  inspectNet(name) {
    name = this.resolveNet(name);
    const el = $("#pcb-inspector");
    const pads = [];
    for (const fp of this.pcb.footprints) for (const p of fp.pads) if (p.net === name) pads.push(`${fp.reference}.${p.number}`);
    let length = 0;
    const layers = new Set();
    for (const t of this.pcb.tracks) {
      if (t.net !== name) continue;
      layers.add(t.layer);
      if (t.type === "arc") {
        const a = arcFrom3(t.start, t.mid, t.end);
        length += a ? Math.abs(a.sweep) * a.r : Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y);
      } else length += Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y);
    }
    const vias = this.pcb.vias.filter((v) => v.net === name).length;
    const zones = this.pcb.zones.filter((z) => z.net === name && !z.keepout).flatMap((z) => z.layers);
    pads.sort(refCompare);
    el.innerHTML = `
      <div class="panel-title">Net</div>
      <h2 style="word-break:break-all">${escapeHtml(name)}</h2>
      <div class="actions">${this.app.project.pages.length ? '<button class="btn" data-netprobe="sch">Show in schematic</button>' : ""}<button class="btn" data-netprobe="3d">Show in 3D</button></div>
      <dl class="kv">
        <dt>Pads</dt><dd>${pads.length}</dd>
        <dt>Track length</dt><dd>${length.toFixed(2)} mm</dd>
        <dt>Layers</dt><dd>${escapeHtml([...layers].join(", ") || "—")}</dd>
        <dt>Vias</dt><dd>${vias}</dd>
        ${zones.length ? `<dt>Zones</dt><dd>${escapeHtml([...new Set(zones)].join(", "))}</dd>` : ""}
      </dl>
      <div class="panel-title">Connected pads</div>
      <div class="mono" style="font-size:12px;line-height:1.7">${pads.map((p) => `<a data-ref="${escapeHtml(p.split(".")[0])}">${escapeHtml(p)}</a>`).join(" ")}</div>`;
    for (const a of el.querySelectorAll("a[data-ref]")) a.addEventListener("click", () => this.selectReference(a.dataset.ref, true));
    for (const b of el.querySelectorAll("[data-netprobe]")) b.addEventListener("click", () => this.app.crossProbeNet(name, b.dataset.netprobe));
  }
}

function plain(b) {
  return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
}
