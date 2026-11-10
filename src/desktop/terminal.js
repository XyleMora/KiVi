// The integrated terminal: a panel at the bottom of every desktop page, opened
// with the header's terminal button or Ctrl+` (as in VS Code and JetBrains IDEs).
// It runs the user's shell (terminal.rs) in the open project's folder, or the
// home folder on the home page. Hiding the panel keeps the shell running, and
// so does moving between pages: the next page reattaches to it and replays its
// recent output. The × button ends the shell; so does `exit`.
//
// vt.js turns the output into character cells; this file draws them as one
// <div> per row (so the text can be selected and copied normally), with the
// lines scrolled off the top kept above as scrollback.

import { toast } from "../app/ui.js";
import { invoke, listen } from "./tauri.js";
import { DEF, Screen } from "./vt.js";

const STATE_KEY = "kivi.terminal"; // {id, open, height}, per window (sessionStorage)
const SCROLLBACK = 5000; // lines
const ROW_PX = 17;

// The 16 ANSI colours, tuned to the app's dark theme.
const PALETTE = [
  "#20242a", "#f07178", "#a6d189", "#f0c674", "#81a2be", "#c397d8", "#7fd3df", "#c5c8c6",
  "#5c6370", "#ff8b8b", "#c3e88d", "#ffd580", "#9cc4ff", "#e0b0ff", "#a6f0fb", "#ffffff",
];

function colour(c) {
  if (c == null) return null;
  if (typeof c === "string") return c;
  if (c < 16) return PALETTE[c];
  if (c < 232) {
    const i = c - 16;
    const l = [0, 95, 135, 175, 215, 255];
    return `rgb(${l[Math.floor(i / 36)]},${l[Math.floor(i / 6) % 6]},${l[i % 6]})`;
  }
  const g = 8 + 10 * (c - 232);
  return `rgb(${g},${g},${g})`;
}

const styles = new WeakMap();
function styleOf(a) {
  if (a === DEF) return "";
  if (!styles.has(a)) {
    let fg = a.fg;
    if (a.bold && typeof fg === "number" && fg < 8) fg += 8; // bold shows as bright, as most terminals do
    let f = colour(fg);
    let b = colour(a.bg);
    if (a.inverse) [f, b] = [b ?? "var(--term-bg)", f ?? "var(--term-fg)"];
    const css = [
      f && `color:${f}`,
      b && `background:${b}`,
      a.bold && "font-weight:600",
      a.italic && "font-style:italic",
      a.underline && "text-decoration:underline",
      a.dim && "opacity:.6",
    ].filter(Boolean);
    styles.set(a, css.length ? ` style="${css.join(";")}"` : "");
  }
  return styles.get(a);
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** One row as HTML; `cursor` is the cursor's column on this row, or -1. */
function rowHtml(line, cursor) {
  // Trailing blanks are left out, so copied text has no trailing spaces.
  let last = line.length - 1;
  while (last >= 0 && line[last].ch === " " && line[last].a.bg == null && !line[last].a.inverse) last--;
  last = Math.max(last, cursor);
  let html = "";
  let run = "";
  let attr = null;
  const flush = () => {
    if (run) html += attr === DEF ? esc(run) : `<span${styleOf(attr)}>${esc(run)}</span>`;
    run = "";
  };
  for (let x = 0; x <= last; x++) {
    const c = line[x];
    if (c.ch === "") continue; // right half of a wide character
    const wide = line[x + 1]?.ch === "";
    if (x === cursor || wide) {
      flush();
      const cls = [x === cursor && "term-cursor", wide && "term-wide"].filter(Boolean).join(" ");
      html += `<span class="${cls}"${styleOf(c.a)}>${esc(c.ch)}</span>`;
      attr = null;
      continue;
    }
    if (c.a !== attr) {
      flush();
      attr = c.a;
    }
    run += c.ch;
  }
  flush();
  return html;
}

/** Bytes for a key press, or null to let the hidden input take it (text, pastes). */
function keyBytes(e, appCursor) {
  const mod = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
  const csi = (code, tilde) => (tilde ? `\x1b[${code}${mod > 1 ? `;${mod}` : ""}~` : mod > 1 ? `\x1b[1;${mod}${code}` : appCursor ? `\x1bO${code}` : `\x1b[${code}`);
  switch (e.key) {
    case "Enter":
      return e.altKey ? "\x1b\r" : "\r";
    case "Backspace":
      return e.ctrlKey ? "\x08" : e.altKey ? "\x1b\x7f" : "\x7f";
    case "Tab":
      return e.shiftKey ? "\x1b[Z" : "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return csi("A");
    case "ArrowDown":
      return csi("B");
    case "ArrowRight":
      return csi("C");
    case "ArrowLeft":
      return csi("D");
    case "Home":
      return csi("H");
    case "End":
      return csi("F");
    case "Insert":
      return csi(2, true);
    case "Delete":
      return csi(3, true);
    case "PageUp":
      return csi(5, true);
    case "PageDown":
      return csi(6, true);
  }
  const fkey = /^F(\d{1,2})$/.exec(e.key);
  if (fkey) {
    const n = Number(fkey[1]);
    if (n <= 4) return mod > 1 ? `\x1b[1;${mod}${"PQRS"[n - 1]}` : `\x1bO${"PQRS"[n - 1]}`;
    const code = { 5: 15, 6: 17, 7: 18, 8: 19, 9: 20, 10: 21, 11: 23, 12: 24 }[n];
    return code ? csi(code, true) : null;
  }
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    // Ctrl+letter by the key's position too, so it works with any keyboard layout.
    const k = e.key.length === 1 && /[a-z]/i.test(e.key) ? e.key.toLowerCase() : /^Key([A-Z])$/.exec(e.code)?.[1].toLowerCase();
    if (k) return String.fromCharCode(k.charCodeAt(0) - 96);
    const special = { " ": "\x00", "@": "\x00", "2": "\x00", "[": "\x1b", "\\": "\x1c", "]": "\x1d", "^": "\x1e", "6": "\x1e", "_": "\x1f", "-": "\x1f", "/": "\x1f", "?": "\x7f" }[e.key];
    return special ?? null;
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) return `\x1b${e.key}`;
  return null;
}

function loadState() {
  try {
    return JSON.parse(sessionStorage.getItem(STATE_KEY)) ?? {};
  } catch {
    return {};
  }
}

class TerminalPanel {
  constructor(button) {
    this.button = button;
    this.state = loadState();
    this.id = null; // the running shell
    this.queue = null; // output that arrived before the shell's id or backlog did
    this.end = 0; // bytes of output drawn so far
    this.raf = 0;
    this.lastCursor = -1;
    this.muted = false; // replaying a backlog: don't answer old queries

    const panel = document.createElement("section");
    panel.id = "term-panel";
    panel.className = "term-panel";
    panel.hidden = true;
    panel.setAttribute("aria-label", "Terminal");
    panel.innerHTML = `
      <div class="term-grip" title="Drag to resize"></div>
      <div class="term-head">
        <span class="term-name">Terminal</span>
        <span class="term-cwd muted mono"></span>
        <span class="term-tools">
          <button type="button" class="btn icon small" data-term="hide" title="Hide (Ctrl+\`); the shell keeps running" aria-label="Hide terminal"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button>
          <button type="button" class="btn icon small" data-term="kill" title="End the shell and close" aria-label="Close terminal"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
        </span>
      </div>
      <div class="term-view">
        <div class="term-scroll"><div class="term-back"></div><div class="term-screen"></div></div>
        <textarea class="term-input" aria-label="Terminal input" autocapitalize="off" autocomplete="off" spellcheck="false"></textarea>
        <span class="term-probe" aria-hidden="true">MMMMMMMMMMMMMMMMMMMM</span>
      </div>`;
    document.body.appendChild(panel);
    this.panel = panel;
    this.view = panel.querySelector(".term-view");
    this.scroll = panel.querySelector(".term-scroll");
    this.back = panel.querySelector(".term-back");
    this.screenEl = panel.querySelector(".term-screen");
    this.input = panel.querySelector(".term-input");
    this.screen = new Screen(80, 24, (answer) => !this.muted && this.send(answer));
    panel.style.height = `${this.state.height ?? 280}px`;

    panel.querySelector('[data-term="hide"]').addEventListener("click", () => this.hide());
    panel.querySelector('[data-term="kill"]').addEventListener("click", () => this.kill());
    this.wireInput();
    this.wireGrip(panel.querySelector(".term-grip"));
    new ResizeObserver(() => !panel.hidden && this.fit()).observe(this.view);

    listen("term-data", (e) => this.onData(e.payload));
    listen("term-exit", (e) => e.payload === this.id && this.onExit());

    if (this.state.id) this.attach(this.state.id).then(() => this.state.open && this.show());
    else if (this.state.open) this.show();
  }

  save() {
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify(this.state));
    } catch {
      /* storage unavailable: the next page starts without the terminal */
    }
  }

  /** The folder the page shows: the viewer's or the diff's local folder, else none (home). */
  cwd() {
    const h = new URLSearchParams(location.hash.slice(1));
    return h.get("folder") ?? h.get("local") ?? null;
  }

  toggle() {
    if (this.panel.hidden) this.show();
    else this.hide();
  }

  /** Let fixed elements (the home page's "+") sit above the panel. */
  syncHeight() {
    document.body.style.setProperty("--term-h", this.panel.hidden ? "0px" : `${this.panel.offsetHeight}px`);
  }

  async show() {
    this.panel.hidden = false;
    this.syncHeight();
    this.button.setAttribute("aria-pressed", "true");
    this.state.open = true;
    this.save();
    this.fit();
    this.input.focus({ preventScroll: true });
    if (!this.id) await this.start();
  }

  hide() {
    this.panel.hidden = true;
    this.syncHeight();
    this.button.setAttribute("aria-pressed", "false");
    this.state.open = false;
    this.save();
    this.input.blur();
  }

  async start() {
    const cwd = this.cwd();
    this.screen.reset();
    this.back.textContent = "";
    this.end = 0;
    this.queue = [];
    try {
      const { cols, rows } = this.screen;
      this.id = await invoke("term_open", { cwd, cols, rows });
    } catch (e) {
      this.queue = null;
      toast(`Couldn't start a terminal: ${e.message ?? e}`, true);
      this.hide();
      return;
    }
    this.panel.querySelector(".term-cwd").textContent = this.state.cwd = cwd ?? "~";
    this.state.id = this.id;
    this.save();
    const early = this.queue;
    this.queue = null;
    for (const p of early) this.onData(p);
  }

  /** Reconnect to the shell an earlier page started. */
  async attach(id) {
    this.queue = [];
    const backlog = await invoke("term_attach", { id }).catch(() => null);
    const early = this.queue;
    this.queue = null;
    if (!backlog) {
      this.state.id = null;
      this.save();
      return;
    }
    this.id = id;
    this.panel.querySelector(".term-cwd").textContent = this.state.cwd ?? "";
    this.muted = true;
    this.screen.write(backlog.data);
    this.muted = false;
    this.end = backlog.end;
    for (const p of early) if (p.id === id && p.end > this.end) this.onData(p);
    this.draw();
  }

  onData(p) {
    if (this.queue) return void this.queue.push(p);
    if (p.id !== this.id || p.end <= this.end) return;
    this.end = p.end;
    this.screen.write(p.data);
    if (!this.raf) this.raf = requestAnimationFrame(() => this.draw());
  }

  onExit() {
    this.id = null;
    this.state.id = null;
    this.save();
    this.hide();
  }

  kill() {
    if (this.id) invoke("term_close", { id: this.id }).catch(() => {});
    this.onExit();
  }

  send(data) {
    if (this.id) invoke("term_write", { id: this.id, data }).catch((e) => toast(`Terminal: ${e.message ?? e}`, true));
  }

  /** Size the screen to the panel, in character cells. */
  fit() {
    const probe = this.panel.querySelector(".term-probe");
    const cw = probe.getBoundingClientRect().width / 20 || 8;
    this.view.style.setProperty("--cw", `${cw}px`);
    const cols = Math.max(20, Math.floor((this.scroll.clientWidth - 16) / cw));
    const rows = Math.max(4, Math.floor((this.scroll.clientHeight - 8) / ROW_PX));
    if (cols === this.screen.cols && rows === this.screen.rows && this.screenEl.childElementCount === rows) return;
    this.screen.resize(cols, rows);
    if (this.id) invoke("term_resize", { id: this.id, cols, rows }).catch(() => {});
    this.draw();
  }

  draw() {
    this.raf = 0;
    const s = this.screen;
    const atBottom = this.scroll.scrollTop + this.scroll.clientHeight >= this.scroll.scrollHeight - ROW_PX;
    if (s.clearBack) {
      this.back.textContent = "";
      s.clearBack = false;
    }
    if (s.out.length) {
      const frag = document.createDocumentFragment();
      for (const line of s.out) {
        const d = document.createElement("div");
        d.className = "term-row";
        d.innerHTML = rowHtml(line, -1);
        frag.appendChild(d);
      }
      s.out.length = 0;
      this.back.appendChild(frag);
      for (let extra = this.back.childElementCount - SCROLLBACK; extra > 0; extra--) this.back.firstElementChild.remove();
    }
    while (this.screenEl.childElementCount < s.rows) {
      const d = document.createElement("div");
      d.className = "term-row";
      this.screenEl.appendChild(d);
    }
    while (this.screenEl.childElementCount > s.rows) this.screenEl.lastElementChild.remove();
    const cursor = s.cursorVisible ? s.y : -1;
    s.dirty.add(this.lastCursor);
    s.dirty.add(cursor);
    this.lastCursor = cursor;
    for (const r of s.dirty) if (r >= 0 && r < s.rows) this.screenEl.children[r].innerHTML = rowHtml(s.lines[r], r === cursor ? s.x : -1);
    s.dirty.clear();
    if (atBottom) this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  wireInput() {
    const input = this.input;
    const selected = () => {
      const sel = getSelection();
      return sel && !sel.isCollapsed && this.view.contains(sel.anchorNode) ? sel.toString() : "";
    };
    const copy = (text) => navigator.clipboard?.writeText(text).catch(() => document.execCommand("copy"));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // the page's own shortcuts (M, Escape, …) stay out of the way
      if (e.isComposing) return;
      const k = e.key.toLowerCase();
      // Ctrl+Shift+C copies; Ctrl+C copies when text is selected, else interrupts.
      if (e.ctrlKey && k === "c" && (e.shiftKey || selected())) {
        e.preventDefault();
        copy(selected());
        getSelection().removeAllRanges();
        return;
      }
      if (e.ctrlKey && k === "v") return; // the browser pastes into the input: see "paste"
      if (e.shiftKey && (e.key === "PageUp" || e.key === "PageDown")) {
        e.preventDefault();
        this.scroll.scrollBy(0, (e.key === "PageUp" ? -1 : 1) * (this.scroll.clientHeight - ROW_PX));
        return;
      }
      const bytes = keyBytes(e, this.screen.appCursor);
      if (bytes == null) return; // typed text arrives through "input"
      e.preventDefault();
      this.scroll.scrollTop = this.scroll.scrollHeight;
      this.send(bytes);
    });
    // Typed text, dead keys and input methods: whatever the input received.
    const take = () => {
      if (input.value) this.send(input.value);
      input.value = "";
    };
    input.addEventListener("input", (e) => !e.isComposing && take());
    input.addEventListener("compositionend", take);
    input.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = e.clipboardData.getData("text/plain").replace(/\r?\n/g, "\r");
      if (text) this.send(this.screen.bracketed ? `\x1b[200~${text}\x1b[201~` : text);
    });
    // Clicking the terminal types into it, unless the click made a selection to copy.
    this.view.addEventListener("mouseup", () => !selected() && input.focus({ preventScroll: true }));
  }

  wireGrip(grip) {
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startH = this.panel.getBoundingClientRect().height;
      const move = (ev) => {
        const h = Math.max(120, Math.min(innerHeight - 160, startH + startY - ev.clientY));
        this.panel.style.height = `${h}px`;
        this.syncHeight();
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        this.state.height = Math.round(this.panel.getBoundingClientRect().height);
        this.save();
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up, { once: true });
    });
  }
}

/**
 * Add the terminal panel to the page, toggled by `button` and Ctrl+`.
 * @param {HTMLButtonElement} button the header's terminal button
 */
export function initTerminal(button) {
  const panel = new TerminalPanel(button);
  button.addEventListener("click", () => panel.toggle());
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.code === "Backquote") {
        e.preventDefault();
        e.stopPropagation();
        panel.toggle();
      }
    },
    true,
  );
}
