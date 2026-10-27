// Measuring tool for the schematic and PCB views: click two points to read the
// distance (mm and mil), Δx, Δy and the angle. Points snap to what the view
// offers (pads, vias, track ends, outline points, pins…); Shift measures freely.
//
// It works through SvgView's `tool` hook, so while it's on, clicks and hovers
// don't select or comment, and it draws on the view's own tool layer, which
// selection redraws leave alone. Points are kept in document (board/sheet)
// coordinates; the bottom PCB view only changes where they're drawn.

const SNAP_PX = 10;
const MIL = 0.0254;
const FONT_PX = 12;

export class MeasureTool {
  /**
   * @param {import("./svgview.js").SvgView} view
   * @param {object} o
   * @param {HTMLElement} o.button   toggles the tool (aria-pressed)
   * @param {HTMLElement} o.chip     hint and readout over the canvas
   * @param {() => {x: number, y: number, r?: number, label: string}[]} o.points  snap candidates
   *   (document mm; `r`: a pad's or via's size, so clicking anywhere on it snaps to its centre)
   */
  constructor(view, { button, chip, points }) {
    this.view = view;
    this.button = button;
    this.chip = chip;
    this.points = points;
    this.active = false;
    this.cands = null;
    this.reset();
    view.tool = this;
    button.addEventListener("click", () => this.toggle());
    view.el.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "m" || e.key === "M") {
        this.toggle();
        e.preventDefault();
      } else if (e.key === "Escape" && this.active) {
        // First Escape drops the measurement, the next one leaves the tool.
        if (this.a) this.reset();
        else this.toggle(false);
        e.stopImmediatePropagation();
      }
    });
  }

  toggle(on = !this.active) {
    this.active = on;
    this.button.setAttribute("aria-pressed", String(on));
    this.view.el.classList.toggle("measuring", on);
    this.chip.hidden = !on;
    this.reset();
    if (on) this.view.el.focus({ preventScroll: true });
  }

  /** Forget the measurement (another sheet, another project). */
  reset() {
    this.a = this.b = this.cur = null;
    this.redraw();
  }

  /** Snap candidates changed (layers shown, side, sheet). */
  invalidate() {
    this.cands = null;
  }

  /** Nearest candidate within SNAP_PX on screen of its edge, else the point itself. */
  snap(p, e) {
    if (e?.shiftKey) return { x: p.x, y: p.y };
    this.cands ??= this.points();
    const tol = SNAP_PX / (this.view.scale || 1);
    let best = null, bd = tol;
    for (const c of this.cands) {
      const d = Math.hypot(c.x - p.x, c.y - p.y) - (c.r ?? 0);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best ? { x: best.x, y: best.y, label: best.label } : { x: p.x, y: p.y };
  }

  // ---- SvgView hooks: true = handled ----

  pick(p, e) {
    if (!this.active) return false;
    const q = this.snap(p, e);
    if (!this.a || this.b) {
      this.a = q;
      this.b = null;
    } else this.b = q;
    this.cur = q;
    this.redraw();
    return true;
  }

  hover(p, e) {
    if (!this.active) return false;
    this.cur = this.snap(p, e);
    this.redraw();
    return true;
  }

  /** Redraw on the tool layer (also after zooming, since labels keep their screen size). */
  redraw() {
    const layer = this.view.toolLayer;
    if (!layer) return;
    if (!this.active) {
      layer.innerHTML = "";
      return;
    }
    const k = 1 / (this.view.scale || 1); // mm per screen pixel
    const sx = (x) => (this.view.flipX ? this.view.flipX(x) : x); // its own inverse
    const end = this.b ?? this.cur;
    let html = "";
    if (this.a && end) {
      const m = measurement(this.a, end);
      const [ax, ay, bx, by] = [sx(this.a.x), this.a.y, sx(end.x), end.y];
      if (m.dx && m.dy) html += `<path class="ms-leg" d="M${ax} ${ay}H${bx}V${by}"/>`;
      html += `<line class="ms-line" x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"/>`;
      html += dot(ax, ay, k) + dot(bx, by, k);
      html += label([`${m.length.toFixed(3)} mm · ${(m.length / MIL).toFixed(1)} mil`, `Δx ${m.dx.toFixed(3)}  Δy ${m.dy.toFixed(3)}  ${m.angle.toFixed(1)}°`], bx + 12 * k, by - 12 * k, k);
      this.chip.innerHTML = `<b>${m.length.toFixed(3)} mm</b> <span class="muted">${(m.length / MIL).toFixed(1)} mil</span>${this.b ? "" : ` <span class="muted">· click the second point</span>`}`;
    } else {
      this.chip.innerHTML = `Click the first point <span class="muted">· Shift: no snapping · Esc: stop</span>`;
    }
    if (this.cur?.label && !this.b) {
      html += `<circle class="ms-snap" cx="${sx(this.cur.x)}" cy="${this.cur.y}" r="${6 * k}"/>`;
      this.chip.innerHTML += ` <span class="ms-snapped">${escapeXml(this.cur.label)}</span>`;
    }
    layer.innerHTML = html;
  }
}

/**
 * Distance between two document points. Δy and the angle follow the screen
 * (y down in the file, angle counter-clockwise from +x as drawn on the top side).
 */
export function measurement(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const angle = dx || dy ? (Math.atan2(-dy, dx) * 180) / Math.PI : 0;
  return { dx, dy, length: Math.hypot(dx, dy), angle };
}

function dot(x, y, k) {
  return `<circle class="ms-end" cx="${x}" cy="${y}" r="${3 * k}"/>`;
}

/** Text lines on a dark box, sized in screen pixels (k = mm per pixel). */
function label(lines, x, y, k) {
  const fs = FONT_PX * k, lh = fs * 1.35, pad = 5 * k;
  const w = Math.max(...lines.map((l) => l.length)) * fs * 0.62 + 2 * pad;
  const h = lines.length * lh + 2 * pad;
  const text = lines.map((l, i) => `<text x="${x + pad}" y="${y - h + pad + lh * (i + 0.78)}" font-size="${fs}">${escapeXml(l)}</text>`).join("");
  return `<g class="ms-label"><rect x="${x}" y="${y - h}" width="${w}" height="${h}" rx="${3 * k}"/>${text}</g>`;
}

function escapeXml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
