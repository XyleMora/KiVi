// Pan/zoom viewport for a rendered SVG string.
//
// Zoom works on the root viewBox, so vector content stays crisp at any scale.
// Emits "hover"/"pick" callbacks with document (mm) coordinates.

// Windows' default double-click time; the distance allows a little hand movement.
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_PX = 6;

export class SvgView {
  constructor(container, { onPick, onHover, onDblPick, onViewChange, flipX = null } = {}) {
    this.el = container;
    this.onViewChange = onViewChange;
    this.onPick = onPick;
    this.onHover = onHover;
    this.onDblPick = onDblPick;
    this.flipX = flipX; // x → document x (back-side PCB view)
    this.svg = null;
    this.view = null;
    this.home = null;
    this.overlay = null;

    this.el.classList.add("svgview");
    this.el.tabIndex = 0;
    this.el.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.el.addEventListener("pointerdown", (e) => this.down(e));
    this.el.addEventListener("pointermove", (e) => this.move(e));
    this.el.addEventListener("pointerup", (e) => this.up(e));
    this.el.addEventListener("pointercancel", () => (this.drag = null));
    this.el.addEventListener("keydown", (e) => this.key(e));
    this.ro = new ResizeObserver(() => this.apply());
    this.ro.observe(this.el);
    this.touches = new Map();
    this.lastTap = null; // last click without a drag, for double-click detection
  }

  /** Replace content. `home` is the box to fit ({x0,y0,x1,y1}). */
  setSvg(svgText, home, keepView = false) {
    const prev = this.view;
    this.el.innerHTML = svgText;
    this.svg = this.el.querySelector("svg");
    this.svg.setAttribute("width", "100%");
    this.svg.setAttribute("height", "100%");
    this.svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    this.overlay = document.createElementNS("http://www.w3.org/2000/svg", "g");
    this.overlay.setAttribute("class", "overlay");
    this.svg.appendChild(this.overlay);
    const vb = this.svg.viewBox.baseVal;
    this.home = home ?? { x0: vb.x, y0: vb.y, x1: vb.x + vb.width, y1: vb.y + vb.height };
    if (keepView && prev) this.view = prev;
    else this.fit();
    this.apply();
  }

  fit(box = this.home, pad = 0.03) {
    if (!box) return;
    const w = box.x1 - box.x0, h = box.y1 - box.y0;
    this.view = { x: box.x0 - w * pad, y: box.y0 - h * pad, w: w * (1 + 2 * pad), h: h * (1 + 2 * pad) };
    this.apply();
  }

  /** Zoom so `box` fills a comfortable part of the screen. */
  zoomTo(box, minSize = 20) {
    const w = Math.max(box.x1 - box.x0, minSize), h = Math.max(box.y1 - box.y0, minSize);
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    this.view = { x: cx - w, y: cy - h, w: 2 * w, h: 2 * h };
    this.apply();
  }

  apply() {
    if (!this.svg || !this.view) return;
    // Match the viewport aspect ratio so coordinates map 1:1 without letterboxing.
    const r = this.el.getBoundingClientRect();
    if (r.width && r.height) {
      const aspect = r.width / r.height;
      const v = this.view;
      if (v.w / v.h > aspect) {
        const nh = v.w / aspect;
        v.y -= (nh - v.h) / 2;
        v.h = nh;
      } else {
        const nw = v.h * aspect;
        v.x -= (nw - v.w) / 2;
        v.w = nw;
      }
    }
    const v = this.view;
    this.svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
    this.scale = r.width ? r.width / v.w : 1; // px per mm
    this.el.style.setProperty("--px", String(1 / this.scale));
    if (!this._syncing) this.onViewChange?.(this.view);
  }

  /** Adopt another view's camera (linked views) without echoing back. */
  syncFrom(view) {
    if (!this.svg || !view) return;
    this._syncing = true;
    this.view = { ...view };
    this.apply();
    this._syncing = false;
  }

  /** Screen event → document coordinates (mm). */
  toDoc(e) {
    const r = this.el.getBoundingClientRect();
    const x = this.view.x + ((e.clientX - r.left) / r.width) * this.view.w;
    const y = this.view.y + ((e.clientY - r.top) / r.height) * this.view.h;
    return { x: this.flipX ? this.flipX(x) : x, y, svgX: x };
  }

  zoomAt(factor, cx, cy) {
    const v = this.view;
    const minW = 0.5, maxW = Math.max(this.home.x1 - this.home.x0, this.home.y1 - this.home.y0) * 20;
    const nw = Math.min(maxW, Math.max(minW, v.w * factor));
    const k = nw / v.w;
    v.x = cx - (cx - v.x) * k;
    v.y = cy - (cy - v.y) * k;
    v.w *= k;
    v.h *= k;
    this.apply();
  }

  wheel(e) {
    if (!this.view) return;
    e.preventDefault();
    const p = this.toDoc(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    if (e.ctrlKey || !e.shiftKey) this.zoomAt(Math.exp(dy * 0.0015), p.svgX, p.y);
    else {
      this.view.x += (dy / this.scale) * 0.5;
      this.apply();
    }
  }

  down(e) {
    if (!this.view) return;
    this.el.setPointerCapture(e.pointerId);
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false, button: e.button };
    if (this.touches.size === 2) this.pinch = this.pinchState();
  }

  pinchState() {
    const [a, b] = [...this.touches.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }

  move(e) {
    if (!this.view) return;
    if (this.touches.has(e.pointerId)) this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.touches.size === 2) {
      const s = this.pinchState();
      const p = this.toDoc({ clientX: s.cx, clientY: s.cy });
      this.zoomAt(this.pinch.d / s.d, p.svgX, p.y);
      this.pinch = s;
      return;
    }
    if (this.drag) {
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
      if (this.drag.moved) {
        this.view.x = this.drag.vx - dx / this.scale;
        this.view.y = this.drag.vy - dy / this.scale;
        this.apply();
        this.el.classList.add("panning");
      }
      return;
    }
    this.onHover?.(this.toDoc(e));
  }

  up(e) {
    this.touches.delete(e.pointerId);
    if (this.touches.size < 2) this.pinch = null;
    const d = this.drag;
    this.drag = null;
    this.el.classList.remove("panning");
    if (d && !d.moved && d.button === 0) {
      const p = this.toDoc(e);
      this.onPick?.(p, e);
      this.tap(e, p);
    }
  }

  /**
   * Double-click detection from our own pointer events. The native dblclick
   * isn't reliable here: each click redraws the overlay under the cursor and
   * pointer capture retargets the events, and Chromium (WebView2 on Windows)
   * then drops dblclick while WebKitGTK still fires it.
   */
  tap(e, p) {
    const last = this.lastTap;
    if (last && e.timeStamp - last.t < DOUBLE_CLICK_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_CLICK_PX) {
      this.lastTap = null; // a third click starts a new pair
      this.onDblPick?.(p);
    } else {
      this.lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
    }
  }

  key(e) {
    if (!this.view) return;
    const v = this.view;
    const step = v.w * 0.1;
    const c = { x: v.x + v.w / 2, y: v.y + v.h / 2 };
    switch (e.key) {
      case "+":
      case "=":
        this.zoomAt(0.8, c.x, c.y);
        break;
      case "-":
        this.zoomAt(1.25, c.x, c.y);
        break;
      case "f":
      case "Home":
        this.fit();
        break;
      case "ArrowLeft":
        v.x -= step;
        this.apply();
        break;
      case "ArrowRight":
        v.x += step;
        this.apply();
        break;
      case "ArrowUp":
        v.y -= step;
        this.apply();
        break;
      case "ArrowDown":
        v.y += step;
        this.apply();
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  /** Draw overlay rectangles (selection/hover) in document coordinates, plus raw SVG markup. */
  setOverlay(boxes, extraHtml = "") {
    if (!this.overlay) return;
    let html = "";
    for (const b of boxes) {
      const x0 = this.flipX ? this.flipX(b.x1) : b.x0;
      const x1 = this.flipX ? this.flipX(b.x0) : b.x1;
      html += `<rect class="${b.cls ?? "sel"}" x="${x0}" y="${b.y0}" width="${x1 - x0}" height="${b.y1 - b.y0}"/>`;
    }
    this.overlay.innerHTML = html + extraHtml;
  }

  /** Raw SVG overlay markup in document coordinates. */
  setOverlayHtml(html) {
    if (this.overlay) this.overlay.innerHTML = html;
  }

  destroy() {
    this.ro.disconnect();
    this.el.innerHTML = "";
  }
}
