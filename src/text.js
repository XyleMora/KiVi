// Text layout for SVG output.
//
// KiCad draws text with its own stroke font, where the text "size" is the
// capital-letter height and characters average ~0.8×size wide. We render with
// a regular sans font scaled so the cap height matches, which keeps layout
// (anchors, justification, label outlines) faithful without bundling the
// GPL-licensed KiCad font data.

import { escapeXml, f } from "./geom.js";

export const FONT_FAMILY = "'DejaVu Sans', 'Noto Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
/** font-size / cap-height for the font stack above (DejaVu Sans cap height ≈ 0.73 em). */
export const CAP_TO_EM = 1.37;
/** KiCad's interline pitch as a multiple of the text size. */
export const INTERLINE = 1.62;

// Rough advance widths in em for DejaVu Sans, used when no canvas is
// available (tests, workers). Grouped by visual width class.
const ADV = new Map();
(function buildAdvances() {
  const set = (chars, w) => {
    for (const c of chars) ADV.set(c, w);
  };
  set("abcdeghknopqsuvxyz", 0.6);
  set("fjtr", 0.38);
  set("il", 0.28);
  set("mw", 0.92);
  set("ABCDEFGHKNOPQRSTUVXYZ", 0.7);
  set("IJ", 0.3);
  set("LM", 0.68);
  set("MW", 0.95);
  set("0123456789", 0.636);
  set(" ", 0.32);
  set(".,:;'!|", 0.32);
  set("()[]{}", 0.39);
  set("-", 0.36);
  set("_+=<>~^*#$%&@?/\\\"", 0.7);
})();

let canvasCtx = null;
function getCanvas() {
  if (canvasCtx !== null) return canvasCtx;
  try {
    if (typeof OffscreenCanvas !== "undefined") canvasCtx = new OffscreenCanvas(8, 8).getContext("2d");
    else if (typeof document !== "undefined") canvasCtx = document.createElement("canvas").getContext("2d");
  } catch {
    canvasCtx = false;
  }
  if (!canvasCtx) canvasCtx = false;
  return canvasCtx;
}

const widthCache = new Map();

/** Width in mm of a single line of plain text at KiCad size `size`. */
export function textWidth(str, size, bold = false) {
  const em = size * CAP_TO_EM;
  const key = (bold ? "b" : "n") + str;
  let w = widthCache.get(key);
  if (w === undefined) {
    const ctx = getCanvas();
    if (ctx) {
      ctx.font = `${bold ? "bold " : ""}100px ${FONT_FAMILY}`;
      w = ctx.measureText(str).width / 100;
    } else {
      w = 0;
      for (const c of str) w += ADV.get(c) ?? 0.62;
      if (bold) w *= 1.08;
    }
    if (widthCache.size > 20000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w * em;
}

const ESCAPES = { slash: "/", backslash: "\\", colon: ":", dblquote: '"', quote: "'", lt: "<", gt: ">", space: " ", tab: "\t", return: "\n", brace: "{", comma: "," };

/** Undo KiCad's text escaping ("VPP{slash}MCLR" → "VPP/MCLR"). */
export function unescapeKiCad(str) {
  return str.includes("{") ? str.replace(/\{(slash|backslash|colon|dblquote|quote|lt|gt|space|tab|return|brace|comma)\}/g, (_, k) => ESCAPES[k]) : str;
}

/**
 * Split KiCad markup into runs: ~{overbar}, _{subscript}, ^{superscript}.
 * Legacy "~TEXT~" overbars (KiCad ≤5) are also recognised.
 */
export function parseMarkup(str) {
  const runs = [];
  let i = 0, buf = "";
  const flush = (style = "") => {
    if (buf) runs.push({ text: buf, style });
    buf = "";
  };
  while (i < str.length) {
    const c = str[i];
    if ((c === "~" || c === "_" || c === "^") && str[i + 1] === "{") {
      const end = str.indexOf("}", i + 2);
      if (end > 0) {
        flush();
        runs.push({ text: str.slice(i + 2, end), style: c === "~" ? "over" : c === "_" ? "sub" : "sup" });
        i = end + 1;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return runs;
}

export function plainText(str) {
  return unescapeKiCad(
    parseMarkup(str)
      .map((r) => r.text)
      .join(""),
  );
}

function runsToSvg(runs) {
  let out = "";
  for (const r of runs) {
    const t = escapeXml(unescapeKiCad(r.text));
    if (r.style === "over") out += `<tspan text-decoration="overline">${t}</tspan>`;
    else if (r.style === "sub") out += `<tspan baseline-shift="sub" font-size="70%">${t}</tspan>`;
    else if (r.style === "sup") out += `<tspan baseline-shift="super" font-size="70%">${t}</tspan>`;
    else out += t;
  }
  return out;
}

/**
 * Emit an SVG <text> element.
 *
 * @param {object} o
 * @param {string} o.text      may contain newlines and KiCad markup
 * @param {number} o.x         anchor
 * @param {number} o.y
 * @param {number} [o.angle]   degrees, counter-clockwise on screen
 * @param {number} o.size      cap height (mm)
 * @param {number} [o.width]   glyph width (mm); differs from size for stretched text
 * @param {"left"|"center"|"right"} [o.h]
 * @param {"top"|"center"|"bottom"} [o.v]
 * @param {boolean} [o.bold]
 * @param {boolean} [o.italic]
 * @param {boolean} [o.mirror] mirror horizontally (bottom-side PCB text)
 * @param {string} o.color
 * @param {number} [o.lineSpacing]
 * @param {number} [o.penWidth] stroke-font pen width (mm), emulated for small text
 * @param {string} [o.attrs] extra attributes
 */
export function svgText(o) {
  if (!o.text) return "";
  const lines = String(o.text).split("\n");
  const size = o.size || 1.27;
  const em = size * CAP_TO_EM;
  const pitch = size * INTERLINE * (o.lineSpacing || 1);
  const n = lines.length;

  // Baseline of the first line relative to the anchor.
  let y0;
  if (o.v === "top") y0 = size;
  else if (o.v === "bottom") y0 = -(n - 1) * pitch;
  else y0 = size / 2 - ((n - 1) * pitch) / 2;

  const anchor = o.h === "left" ? "start" : o.h === "right" ? "end" : "middle";
  const sx = (o.width && o.width !== size ? o.width / size : 1) * (o.mirror ? -1 : 1);

  let transform = `translate(${f(o.x)} ${f(o.y)})`;
  if (o.angle) transform += ` rotate(${f(-o.angle)})`;
  if (sx !== 1) transform += ` scale(${f(sx)} 1)`;

  let body = "";
  for (let i = 0; i < n; i++) {
    body += `<tspan x="0" y="${f(y0 + i * pitch)}">${runsToSvg(parseMarkup(lines[i]))}</tspan>`;
  }
  const style = [
    `font-size="${f(em)}"`,
    `text-anchor="${anchor}"`,
    `fill="${o.color}"`,
    o.bold ? `font-weight="bold"` : "",
    o.italic ? `font-style="italic"` : "",
    o.opacity !== undefined && o.opacity !== 1 ? `fill-opacity="${f(o.opacity)}"` : "",
    penStroke(o, size),
    o.attrs || "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<text transform="${transform}" ${style}>${body}</text>`;
}

/**
 * KiCad's stroke font uses a fixed pen width, so small text looks heavier
 * than a regular font. Emulate it by outlining glyphs when the pen is
 * thicker than the font's natural stem (~12% of the cap height).
 */
function penStroke(o, size) {
  if (!o.penWidth) return "";
  const extra = o.penWidth - (o.bold ? 0.2 : 0.12) * size;
  // Explicit "none" so text never inherits a parent group's stroke.
  if (extra < 0.01) return `stroke="none"`;
  return `stroke="${o.color}" stroke-width="${f(extra)}" stroke-linejoin="round"`;
}

/** Bounding size of a (possibly multi-line) text block, in its own frame. */
export function textBlockSize(text, size, bold = false, lineSpacing = 1) {
  const lines = String(text).split("\n");
  let w = 0;
  for (const l of lines) w = Math.max(w, textWidth(plainText(l), size, bold));
  return { w, h: size + (lines.length - 1) * size * INTERLINE * lineSpacing };
}

/**
 * Keep text readable: angles in (90°, 270°] are turned by 180° and the
 * justification flipped, which is what KiCad does for schematic text.
 */
export function readable(angle, h, v) {
  let a = ((angle % 360) + 360) % 360;
  if (a > 90 && a <= 270) {
    a = (a + 180) % 360;
    h = h === "left" ? "right" : h === "right" ? "left" : h;
    v = v === "top" ? "bottom" : v === "bottom" ? "top" : v;
  }
  return { angle: a, h, v };
}
