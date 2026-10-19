// Review comments on pull requests, in the visual diff and in the viewer's
// schematic and PCB tabs: comment pins on a canvas, a composer and thread
// popover, and the list of threads in a side panel.
//
// Threads live on GitHub (see ../review.js). A ReviewStore holds the threads
// of one pull request; each canvas gets a ReviewPanel with a small "host"
// adapter that knows its documents:
//
//   host.enabled()               comments possible here (optional)
//   host.active()                the canvas is on screen (keyboard shortcuts)
//   host.docKey()                identity of the shown document (drafts reset when it changes)
//   host.view(name)              SvgView of a canvas
//   host.defaultView(side)       canvas to open a thread in
//   host.showsSide(name, side)   canvas shows "head" / "base" pins
//   host.place(thread)           {side, x, y, found, mark, note?} | {side: null, note?} | null (not here)
//   host.list(threads)           [{thread, here, where?}] for the side panel
//   host.goto(thread)            show the document of a thread: true | "pending" | false (optional)
//   host.target(p, name)         {anchor, mark, side} under a click | null
//   host.commentPath(draft)      repository path to post a new comment on
//   host.toSvgX(name, x)         document → SVG x (mirrored board side; optional)
//   host.markTransform(name)     SVG transform for marks (optional)
//   host.refreshOverlay()        redraw the canvas overlay (calls panel.overlay(name))
//   host.zoomMin                 minimum zoom box (mm)
//   host.writeHash()             (optional)

import { ReviewComments, anchorLabel, anchorKind, renderCommentText } from "../review.js";
import { trackPath, circlePath } from "../pcb/shapes.js";
import { f } from "../geom.js";
import { $, toast, settings, collapsible } from "./ui.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const BUBBLE = { dx: 12, dy: -14, r: 10 }; // pin bubble centre and radius in screen px, tip at the anchor

export const COMMENT_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" stroke-linejoin="round"/></svg>';

/** Threads of one pull request, shared by every panel showing it. */
export class ReviewStore {
  constructor() {
    this.api = null;
    this.pr = null;
    this.threads = [];
    this.listeners = new Set();
    // Pick up comments added or resolved on GitHub while this tab was in the background.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.api && Date.now() - (this.loadedAt ?? 0) > 20000) this.reload();
    });
  }

  get enabled() {
    return !!this.api;
  }

  get canWrite() {
    return !!this.api?.canWrite;
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  /** @param {{owner: string, repo: string, number: number, headSha: string}} pr */
  async open(pr) {
    this.pr = pr;
    this.threads = [];
    this.loadedAt = 0;
    this.error = null;
    this.api = new ReviewComments({ owner: pr.owner, repo: pr.repo, pr: pr.number, token: settings().token ?? null });
    this.emit();
    await this.reload();
  }

  close() {
    this.api = null;
    this.pr = null;
    this.threads = [];
    this.emit();
  }

  async reload() {
    const api = this.api;
    if (!api) return;
    this.loading = true;
    this.emit();
    try {
      await api.load();
      if (api !== this.api) return;
      // Numbered across the pull request, so a pin reads the same in every view.
      this.threads = api.threads.slice().sort((a, b) => a.comments[0].createdAt.localeCompare(b.comments[0].createdAt));
      this.threads.forEach((t, i) => (t.number = i + 1));
      this.loadedAt = Date.now();
      this.error = null;
    } catch (e) {
      console.error(e);
      this.error = e.message;
    } finally {
      this.loading = false;
    }
    if (api === this.api) this.emit();
  }

  byRoot(id) {
    return this.threads.find((t) => t.rootId === Number(id)) ?? null;
  }

  /** Start a thread on the pull request's head commit. */
  async post(path, anchor, text) {
    return this.api.create({ path, commitId: this.pr.headSha, anchor, text });
  }
}

/** Open (unresolved) threads per repository path, for file list badges. */
export function openCounts(threads) {
  const m = new Map();
  for (const t of threads) if (t.isResolved !== true) m.set(t.path, (m.get(t.path) ?? 0) + 1);
  return m;
}

export class ReviewPanel {
  /**
   * @param {ReviewStore} store
   * @param {object} host          see the top of this file
   * @param {{container: Element, wrap: Element, modeButton?: Element, collapsed?: boolean}} el
   *   container: side panel to add the thread list to; wrap: the canvas area (popover, mode class);
   *   collapsed: the list is a collapsible section, closed at first
   */
  constructor(store, host, { container, wrap, modeButton = null, collapsed = false }) {
    this.store = store;
    this.host = host;
    this.wrap = wrap;
    this.placed = new Map(); // thread → placement in the shown document
    this.mode = false;
    this.filter = "open";
    this.active = null; // {kind: "thread", thread, view} | {kind: "draft", anchor, side, mark, view, doc}
    this.hovered = null; // {view, mark}
    this.focus = null; // deep link target, applied once threads and document are ready

    this.root = document.createElement("section");
    this.root.className = "cm-section";
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="row between">
        ${collapsed ? `<button class="cm-head-btn" aria-label="Comments"><span class="panel-title">Comments</span><span class="cm-count"></span></button>` : `<div class="panel-title">Comments <span class="cm-count"></span></div>`}
        <button class="btn icon cm-refresh" aria-label="Reload comments" title="Reload comments from GitHub"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/></svg></button>
      </div>
      <div class="cm-body">
        <div class="seg cm-filter" role="group" aria-label="Show comments">
          <button data-cm-filter="open" aria-pressed="true">Open</button>
          <button data-cm-filter="resolved" aria-pressed="false">Resolved</button>
          <button data-cm-filter="all" aria-pressed="false">All</button>
        </div>
        <div class="cm-status muted"></div>
        <ul class="change-list comment-list"></ul>
      </div>`;
    container.appendChild(this.root);
    if (collapsed) {
      this.root.classList.add("collapsible");
      collapsible(this.q(".cm-head-btn"), this.q(".cm-body"));
    }

    this.pop = document.createElement("div");
    this.pop.className = "cm-pop";
    this.pop.setAttribute("role", "dialog");
    this.pop.setAttribute("aria-label", "Review comment");
    this.pop.hidden = true;
    wrap.appendChild(this.pop);

    if (!modeButton) {
      modeButton = document.createElement("button");
      modeButton.className = "btn cm-fab";
      modeButton.innerHTML = `${COMMENT_ICON}<span>Comment</span>`;
      wrap.appendChild(modeButton);
    }
    this.modeButton = modeButton;
    modeButton.title = "Comment on a part, pad, net or spot (C)";
    modeButton.setAttribute("aria-pressed", "false");
    modeButton.hidden = true;

    this.bind();
    store.onChange(() => this.refresh());
  }

  q(sel) {
    return this.root.querySelector(sel);
  }

  bind() {
    this.modeButton.addEventListener("click", () => this.setMode(!this.mode));
    this.q(".cm-refresh").addEventListener("click", () => this.store.reload());
    for (const b of this.root.querySelectorAll("[data-cm-filter]")) b.addEventListener("click", () => this.setFilter(b.dataset.cmFilter));
    document.addEventListener("keydown", (e) => {
      if (!this.enabled || !this.host.active() || e.target.closest?.("input, textarea, select, dialog") || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "c") this.setMode(!this.mode);
      else if (e.key === "Escape") {
        if (this.active) this.close();
        else this.setMode(false);
      }
    });
    this.pop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.close();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.matches("textarea")) {
        e.preventDefault();
        this.pop.querySelector("[data-act=submit], [data-act=reply]")?.click();
      }
      e.stopPropagation(); // keep typing out of the canvas shortcuts
    });
    for (const ev of ["pointerdown", "wheel", "dblclick"]) this.pop.addEventListener(ev, (e) => e.stopPropagation());
  }

  get enabled() {
    return this.store.enabled && this.host.enabled?.() !== false;
  }

  setFilter(filter) {
    this.filter = filter;
    for (const o of this.root.querySelectorAll("[data-cm-filter]")) o.setAttribute("aria-pressed", String(o.dataset.cmFilter === filter));
    this.refresh();
  }

  /** Threads or the shown document changed: place pins, list threads, redraw. */
  refresh() {
    const on = this.enabled;
    this.root.hidden = !on;
    this.modeButton.hidden = !on;
    if (!on && this.mode) this.setMode(false);
    this.placed = new Map();
    if (on) {
      for (const t of this.store.threads) {
        const pl = this.host.place(t);
        if (pl) this.placed.set(t, pl);
      }
    }
    const a = this.active;
    if (a?.kind === "thread") {
      const t = this.store.byRoot(a.thread.rootId);
      if (t && this.placed.has(t)) a.thread = t;
      else this.close(false);
    } else if (a?.kind === "draft" && (!on || a.doc !== this.host.docKey())) this.close(false);
    this.renderList();
    this.host.refreshOverlay();
    if (this.active) this.renderPopover();
    this.applyFocus();
  }

  visible(t) {
    const resolved = t.isResolved === true;
    return this.filter === "all" || (this.filter === "resolved" ? resolved : !resolved);
  }

  toSvgX(name, x) {
    return this.host.toSvgX ? this.host.toSvgX(name, x) : x;
  }

  // ---------------------------------------------------------------- canvas

  setMode(on) {
    this.mode = !!on && this.enabled;
    this.modeButton.setAttribute("aria-pressed", String(this.mode));
    this.wrap.classList.toggle("commenting", this.mode);
    if (!this.mode && this.hovered) {
      this.hovered = null;
      this.host.refreshOverlay();
    }
  }

  pinsIn(name) {
    const out = [];
    for (const [t, pl] of this.placed) if (pl.side && this.host.showsSide(name, pl.side) && this.visible(t)) out.push({ thread: t, ...pl });
    return out;
  }

  pinAt(p, name) {
    const v = this.host.view(name);
    const px = 1 / (v.scale || 1);
    const sx = p.svgX ?? p.x;
    let best = null, bd = (BUBBLE.r + 3) * px;
    for (const pin of this.pinsIn(name)) {
      const d = Math.hypot(sx - (this.toSvgX(name, pin.x) + BUBBLE.dx * px), p.y - (pin.y + BUBBLE.dy * px));
      if (d < bd) {
        bd = d;
        best = pin;
      }
    }
    return best;
  }

  /** Canvas click. Returns true when it was handled here. */
  pick(p, name) {
    if (!this.enabled) return false;
    const pin = this.pinAt(p, name);
    if (pin) {
      this.openThread(pin.thread, { view: name });
      return true;
    }
    if (this.mode) {
      const t = this.host.target(p, name);
      if (!t) {
        toast("Nothing to comment on here — this version of the file doesn't exist", true);
        return true;
      }
      this.active = { kind: "draft", anchor: t.anchor, side: t.side, mark: t.mark, view: name, doc: this.host.docKey() };
      this.hovered = null;
      this.renderPopover();
      this.host.refreshOverlay();
      return true;
    }
    if (this.active) this.close();
    return false;
  }

  hover(p, name) {
    if (!this.mode) return;
    this.pendingHover = { p, name };
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      const { p, name } = this.pendingHover;
      if (!this.mode) return;
      const onPin = this.pinAt(p, name);
      const t = onPin ? null : this.host.target(p, name);
      const prev = this.hovered;
      this.hovered = t?.mark ? { view: name, mark: t.mark } : null;
      this.host.view(name).el.title = onPin ? "" : t ? `Comment on ${t.anchor.type === "point" ? "this spot" : `${t.anchor.type} ${anchorLabel(t.anchor)}`}` : "";
      if (prev?.mark !== this.hovered?.mark) this.host.refreshOverlay();
    });
  }

  /** SVG overlay for one canvas: hover/selection marks and pins (screen-sized). */
  overlay(name) {
    if (!this.enabled) return "";
    const tf = this.host.markTransform?.(name);
    let marks = "", pins = "";
    if (this.hovered?.view === name) marks += markSvg(this.hovered.mark, "cm-hover");
    const a = this.active;
    if (a?.kind === "draft" && this.host.showsSide(name, a.side)) {
      marks += markSvg(a.mark, "cm-sel");
      pins += pinSvg(this.toSvgX(name, a.anchor.x), a.anchor.y, "+", "cm-pin draft");
    }
    for (const pin of this.pinsIn(name)) {
      const t = pin.thread, sel = a?.kind === "thread" && a.thread === t;
      if (sel) marks += markSvg(pin.mark, "cm-sel");
      const cls = `cm-pin${t.isResolved ? " resolved" : ""}${pin.found ? "" : " lost"}${sel ? " sel" : ""}`;
      pins += pinSvg(this.toSvgX(name, pin.x), pin.y, t.isResolved ? "✓" : String(t.number), cls);
    }
    return (marks && tf ? `<g transform="${tf}">${marks}</g>` : marks) + pins;
  }

  // ---------------------------------------------------------------- popover

  /** Open a thread, switching to its document first when needed. Returns false if it can't be shown (yet). */
  openThread(thread, { view = null, zoom = false } = {}) {
    if (!this.placed.has(thread)) {
      if (this.host.goto?.(thread) !== true) return false;
      thread = this.store.byRoot(thread.rootId) ?? thread;
      if (!this.placed.has(thread)) return false;
    }
    const pl = this.placed.get(thread);
    view ??= this.host.defaultView(pl.side);
    if (!this.visible(thread)) this.setFilter("all");
    this.active = { kind: "thread", thread, view };
    if (zoom && pl.side) {
      // Zoom to the element, or around the pin when it is large (GND, a board-wide net).
      const min = this.host.zoomMin;
      const b = pl.mark?.box;
      const box = b && !b.empty && Math.max(b.x1 - b.x0, b.y1 - b.y0) < min * 4 ? b : { x0: pl.x - 1, y0: pl.y - 1, x1: pl.x + 1, y1: pl.y + 1 };
      const xa = this.toSvgX(view, box.x0), xb = this.toSvgX(view, box.x1);
      this.host.view(view).zoomTo({ x0: Math.min(xa, xb), y0: box.y0, x1: Math.max(xa, xb), y1: box.y1 }, min);
    }
    this.renderPopover();
    this.renderList();
    this.host.refreshOverlay();
    this.host.writeHash?.();
    return true;
  }

  close(redraw = true) {
    this.active = null;
    this.popKey = null;
    this.pop.hidden = true;
    this.pop.innerHTML = "";
    if (redraw) {
      this.renderList();
      this.host.refreshOverlay();
      this.host.writeHash?.();
    }
  }

  get activeThreadId() {
    return this.active?.kind === "thread" ? this.active.thread.rootId : null;
  }

  renderPopover() {
    const a = this.active;
    if (!a) return;
    const canWrite = this.store.canWrite;
    const tokenNote = (what) => `<div class="cm-note"><button class="link" data-act="signin">Sign in with GitHub</button> to ${what}.</div>`;
    let html;
    if (a.kind === "draft") {
      html = `${this.head(a.anchor, null)}
        ${
          canWrite
            ? `<textarea class="input cm-input" rows="3" placeholder="Comment on ${esc(a.anchor.type === "point" ? "this spot" : anchorLabel(a.anchor))}…" aria-label="Comment"></textarea>
               <div class="cm-actions"><span class="muted cm-hint">Posted to the pull request · Ctrl+Enter</span><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="submit" disabled>Comment</button></div>`
            : tokenNote("comment")
        }`;
    } else {
      const t = a.thread, pl = this.placed.get(t);
      const notes = [];
      if (pl?.note) notes.push(pl.note);
      else if (pl?.side && !pl.found) notes.push("Not found in this version of the file — shown where it was.");
      if (!t.anchor && t.line) notes.push(`Comment on line ${t.line} of <span class="mono">${esc(t.path.split("/").pop())}</span>.`);
      html = `${this.head(t.anchor, t)}
        ${notes.map((n) => `<div class="cm-note">${n}</div>`).join("")}
        <ol class="cm-comments">${t.comments
          .map(
            (c) => `<li>${c.avatar ? `<img class="cm-avatar" src="${esc(c.avatar + (c.avatar.includes("?") ? "&" : "?") + "s=48")}" alt="" width="24" height="24">` : `<span class="cm-avatar"></span>`}
              <div class="cm-c"><div class="cm-meta"><strong>${esc(c.author)}</strong> <time datetime="${esc(c.createdAt)}" title="${esc(new Date(c.createdAt).toLocaleString())}">${ago(c.createdAt)}</time>${c.mine && canWrite ? `<button class="link cm-del" data-act="delete" data-id="${c.id}">Delete</button>` : ""}</div>
              <div class="cm-text">${renderCommentText(c.text) || '<span class="muted">(empty)</span>'}</div></div></li>`,
          )
          .join("")}</ol>
        ${canWrite && t.canReply !== false ? `<textarea class="input cm-input" rows="2" placeholder="Reply…" aria-label="Reply"></textarea>` : canWrite ? "" : tokenNote("reply and resolve")}
        <div class="cm-actions">
          <a href="${esc(t.comments.at(-1).url)}" target="_blank" rel="noopener" class="cm-gh">View on GitHub</a>
          ${t.isResolved ? (t.canUnresolve ? `<button class="btn" data-act="unresolve">Unresolve</button>` : "") : t.canResolve ? `<button class="btn" data-act="resolve">Resolve</button>` : ""}
          ${canWrite && t.canReply !== false ? `<button class="btn primary" data-act="reply" disabled>Reply</button>` : ""}
        </div>`;
    }
    const keep = this.pop.querySelector("textarea")?.value ?? "";
    const key = a.kind === "draft" ? `d:${a.anchor.x},${a.anchor.y}` : `t:${a.thread.rootId}`;
    const same = this.popKey === key;
    this.pop.innerHTML = html;
    this.pop.hidden = false;
    this.popKey = key;
    const ta = this.pop.querySelector("textarea");
    const submit = this.pop.querySelector("[data-act=submit], [data-act=reply]");
    if (ta) {
      if (same) ta.value = keep;
      ta.addEventListener("input", () => submit && (submit.disabled = !ta.value.trim()));
      if (submit) submit.disabled = !ta.value.trim();
      if (a.kind === "draft" || same) requestAnimationFrame(() => ta.focus());
    }
    for (const b of this.pop.querySelectorAll("[data-act]")) b.addEventListener("click", () => this.act(b.dataset.act, b));
    this.position();
  }

  head(anchor, thread) {
    const kind = thread && !anchor ? (thread.line ? "line" : "file") : anchorKind(anchor);
    const label = anchor ? anchorLabel(anchor) : thread.path.split("/").pop();
    const status = thread ? (thread.isResolved ? `<span class="cm-badge done">Resolved${thread.resolvedBy ? ` by ${esc(thread.resolvedBy)}` : ""}</span>` : thread.isResolved === false ? `<span class="cm-badge">Open</span>` : "") : `<span class="cm-badge new">New</span>`;
    return `<div class="cm-head">${thread ? `<span class="cm-num">${thread.number}</span>` : ""}<span class="cm-title"><span class="mono">${esc(label)}</span> <span class="ctype">${esc(kind)}${anchor?.side === "base" ? " · before" : ""}</span></span>${status}<button class="btn icon cm-x" data-act="cancel" aria-label="Close">×</button></div>`;
  }

  /** Keep the popover next to its pin while panning and zooming. */
  position() {
    const a = this.active;
    if (!a || this.pop.hidden) return;
    const view = this.host.view(a.view);
    const pl = a.kind === "draft" ? { side: a.side, ...a.anchor } : this.placed.get(a.thread);
    const wrap = this.wrap.getBoundingClientRect();
    const r = view.el.getBoundingClientRect();
    const pw = this.pop.offsetWidth, ph = this.pop.offsetHeight;
    let x, y;
    if (pl?.side && view.view && r.width) {
      const sx = this.toSvgX(a.view, pl.x);
      x = r.left - wrap.left + ((sx - view.view.x) / view.view.w) * r.width + BUBBLE.dx + BUBBLE.r + 10;
      y = r.top - wrap.top + ((pl.y - view.view.y) / view.view.h) * r.height + BUBBLE.dy - 20;
      if (x + pw > wrap.width - 8) x -= pw + 2 * (BUBBLE.r + 10) + BUBBLE.dx; // flip to the left of the pin
    } else {
      x = r.left - wrap.left + (r.width - pw) / 2;
      y = r.top - wrap.top + 60;
    }
    this.pop.style.left = `${Math.round(Math.max(8, Math.min(x, wrap.width - pw - 8)))}px`;
    this.pop.style.top = `${Math.round(Math.max(8, Math.min(y, wrap.height - ph - 8)))}px`;
  }

  async act(what, el) {
    const a = this.active;
    const ta = this.pop.querySelector("textarea");
    if (what === "cancel") return this.close();
    if (what === "signin") {
      this.close();
      return window.dispatchEvent(new Event("kivi:signin")); // the account menu (src/desktop/account.js) handles it
    }
    const busy = (on) => {
      for (const b of this.pop.querySelectorAll("button")) b.disabled = on;
      if (ta) ta.disabled = on;
    };
    busy(true);
    try {
      if (what === "submit") {
        const created = await this.store.post(this.host.commentPath(a), { ...a.anchor, side: a.side }, ta.value);
        this.close(false);
        await this.store.reload();
        const t = this.store.byRoot(created.id);
        if (!t || !this.openThread(t, { view: a.view })) this.close();
        toast("Comment posted to the pull request");
      } else if (what === "reply") {
        await this.store.api.reply(a.thread, ta.value);
        ta.value = "";
        this.popKey = null;
        await this.store.reload();
      } else if (what === "resolve" || what === "unresolve") {
        await this.store.api.setResolved(a.thread, what === "resolve");
        await this.store.reload();
      } else if (what === "delete") {
        if (!confirm("Delete this comment on GitHub?")) return busy(false);
        await this.store.api.remove(Number(el.dataset.id));
        await this.store.reload();
      }
    } catch (e) {
      console.error(e);
      toast(e.message, true);
      busy(false);
    }
  }

  // ---------------------------------------------------------------- side panel

  renderList() {
    const list = this.q(".comment-list");
    const status = this.q(".cm-status");
    const entries = this.enabled ? this.host.list(this.store.threads) : [];
    const shown = entries.filter((e) => this.visible(e.thread));
    const open = entries.filter((e) => e.thread.isResolved !== true).length;
    const resolved = entries.length - open;
    this.q(".cm-count").textContent = entries.length ? `${open} open${resolved ? ` · ${resolved} resolved` : ""}` : "";
    status.innerHTML = this.store.error
      ? `<span class="err">${esc(this.store.error)}</span>`
      : this.store.loading && !this.store.loadedAt
        ? "Loading…"
        : this.store.enabled && !this.store.canWrite
          ? `Read-only. <button class="link" data-act="signin">Sign in with GitHub</button> to comment and resolve.`
          : "";
    status.querySelector("[data-act=signin]")?.addEventListener("click", () => this.act("signin"));
    if (!shown.length) {
      const what = this.filter === "resolved" ? "No resolved comments here." : this.filter === "open" && entries.length ? "No open comments here." : "No comments here yet.";
      list.innerHTML = `<li class="muted cm-empty">${what}${this.store.canWrite ? " Press <kbd>C</kbd> or use <b>Comment</b>, then click a part, pad, net or spot." : ""}</li>`;
      return;
    }
    list.innerHTML = shown
      .map(({ thread: t, here, where }) => {
        const first = t.comments[0];
        const pl = this.placed.get(t);
        const kind = t.anchor ? anchorKind(t.anchor) : t.line ? `line ${t.line}` : "file";
        const label = t.anchor ? anchorLabel(t.anchor) : "";
        const replies = t.comments.length - 1;
        const cur = this.active?.kind === "thread" && this.active.thread === t;
        const extra = [t.anchor?.side === "base" ? "before" : "", where && !here ? where : "", pl?.side && !pl.found ? "not in this version" : ""].filter(Boolean).join(" · ");
        return `<li><button data-root="${t.rootId}" class="cm-item${t.isResolved ? " resolved" : ""}"${cur ? " aria-current" : ""}>
          <span class="cm-num">${t.isResolved ? "✓" : t.number}</span>
          <span class="cbody"><span class="clabel">${label ? `<span class="mono">${esc(label)}</span> ` : ""}<span class="ctype">${esc(kind)}${extra ? ` · ${esc(extra)}` : ""}</span></span>
          <span class="cdetail">${esc(excerpt(first.text))}</span>
          <span class="cm-by">${esc(first.author)} · ${ago(first.createdAt)}${replies ? ` · ${replies} repl${replies > 1 ? "ies" : "y"}` : ""}</span></span></button></li>`;
      })
      .join("");
    for (const b of list.querySelectorAll("button[data-root]")) {
      b.addEventListener("click", () => {
        const t = this.store.byRoot(b.dataset.root);
        if (t && !this.openThread(t, { zoom: true })) this.setFocus({ thread: t.rootId });
      });
    }
  }

  // ---------------------------------------------------------------- deep links

  /** {thread: id} or {at: "x,y,side"} → open that thread once it can be shown. */
  setFocus(focus) {
    this.focus = focus;
    this.applyFocus();
  }

  applyFocus() {
    const fc = this.focus;
    if (!fc || !this.enabled || !this.store.loadedAt || this.applyingFocus) return;
    this.applyingFocus = true;
    try {
      if (fc.thread) {
        const t = this.store.byRoot(fc.thread);
        if (!t) return void (this.focus = null);
        if (!this.placed.has(t)) {
          const r = this.host.goto?.(t);
          if (r === "pending") return; // the document is loading; refresh() calls us again
          if (r !== true) return void (this.focus = null);
        }
        this.focus = null;
        const live = this.store.byRoot(fc.thread);
        if (live && this.placed.has(live)) this.openThread(live, { zoom: true });
      } else if (fc.at) {
        this.focus = null;
        const [x, y, side] = fc.at.split(",");
        const near = [...this.placed]
          .filter(([t]) => t.anchor && (t.anchor.side ?? "head") === (side || "head"))
          .map(([t]) => ({ t, d: Math.hypot(t.anchor.x - Number(x), t.anchor.y - Number(y)) }))
          .sort((u, v) => u.d - v.d)[0];
        if (near && near.d < 0.01) this.openThread(near.t, { zoom: true });
      }
    } finally {
      this.applyingFocus = false;
    }
  }
}

// ---- drawing ----

function markSvg(mark, cls) {
  if (!mark) return "";
  let out = "";
  if (mark.tracks?.length) {
    let d = "", w = 0;
    for (const t of mark.tracks) {
      d += trackPath(t);
      w = Math.max(w, t.width);
    }
    out += `<path class="${cls} cm-path" d="${d}" style="stroke-width:${f(w + 0.3)}px"/>`;
  }
  if (mark.vias?.length) out += `<path class="${cls} cm-fill" d="${mark.vias.map((v) => circlePath(v.x, v.y, v.size / 2 + 0.15)).join("")}"/>`;
  if (mark.paths?.length) out += `<path class="${cls} cm-path" d="${mark.paths.map((pts) => pts.map((p, k) => `${k ? "L" : "M"}${f(p.x)} ${f(p.y)}`).join("")).join("")}" style="stroke-width:0.6px"/>`;
  if (!mark.tracks?.length && !mark.paths?.length && mark.box && !mark.box.empty) {
    const b = mark.box;
    out += `<rect class="${cls} cm-box" x="${f(b.x0)}" y="${f(b.y0)}" width="${f(b.x1 - b.x0)}" height="${f(b.y1 - b.y0)}" rx="0.3"/>`;
  }
  return out;
}

/** Comment bubble with its tip at (x, y) in SVG coordinates; drawn in screen pixels via --px. */
function pinSvg(x, y, text, cls) {
  const { dx, dy, r } = BUBBLE;
  const shape = `<circle cx="${dx}" cy="${dy}" r="${r}"/><path d="M0 0L${dx - r * 0.85} ${dy + r * 0.25}L${dx - r * 0.2} ${dy + r * 0.95}Z"/>`;
  return `<g class="${cls}" transform="translate(${f(x)} ${f(y)})"><g class="cm-s"><g class="cm-halo">${shape}</g><g class="cm-body">${shape}</g><text x="${dx}" y="${dy}" dy="0.35em" text-anchor="middle">${esc(text)}</text></g></g>`;
}

/** One-line plain-text preview of comment Markdown. */
function excerpt(text) {
  const s = text.replace(/```[\s\S]*?```/g, "[code]").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*`_]+/g, "").replace(/\s+/g, " ").trim();
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
}

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
