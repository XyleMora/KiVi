// Drawing sheet (.kicad_wks) support: page frame, grid references and title block.

import { parse, child, children, value, num } from "./sexpr.js";
import { f } from "./geom.js";
import { svgText } from "./text.js";

/** KiCad's built-in default drawing sheet. */
export const DEFAULT_WKS = `(kicad_wks (version 20210606) (generator pl_editor)
(setup (textsize 1.5 1.5)(linewidth 0.15)(textlinewidth 0.15)
(left_margin 10)(right_margin 10)(top_margin 10)(bottom_margin 10))
(rect (name "") (start 110 34) (end 2 2))
(rect (name "") (start 0 0 ltcorner) (end 0 0) (repeat 2) (incrx 2) (incry 2))
(line (name "") (start 50 2 ltcorner) (end 50 0 ltcorner) (repeat 30) (incrx 50))
(tbtext "1" (name "") (pos 25 1 ltcorner) (font (size 1.3 1.3)) (repeat 100) (incrx 50))
(line (name "") (start 50 2 lbcorner) (end 50 0 lbcorner) (repeat 30) (incrx 50))
(tbtext "1" (name "") (pos 25 1 lbcorner) (font (size 1.3 1.3)) (repeat 100) (incrx 50))
(line (name "") (start 0 50 ltcorner) (end 2 50 ltcorner) (repeat 30) (incry 50))
(tbtext "A" (name "") (pos 1 25 ltcorner) (font (size 1.3 1.3)) (justify center) (repeat 100) (incry 50))
(line (name "") (start 0 50 rtcorner) (end 2 50 rtcorner) (repeat 30) (incry 50))
(tbtext "A" (name "") (pos 1 25 rtcorner) (font (size 1.3 1.3)) (justify center) (repeat 100) (incry 50))
(tbtext "Date: \${ISSUE_DATE}" (name "") (pos 87 6.9))
(line (name "") (start 110 5.5) (end 2 5.5))
(tbtext "\${KICAD_VERSION}" (name "") (pos 109 4.1))
(line (name "") (start 110 8.5) (end 2 8.5))
(tbtext "Rev: \${REVISION}" (name "") (pos 24 6.9) (font bold))
(tbtext "Size: \${PAPER}" (name "") (pos 109 6.9))
(tbtext "Id: \${#}/\${##}" (name "") (pos 24 4.1))
(line (name "") (start 110 12.5) (end 2 12.5))
(tbtext "Title: \${TITLE}" (name "") (pos 109 10.7) (font (size 2 2) bold italic))
(tbtext "File: \${FILENAME}" (name "") (pos 109 14.3))
(line (name "") (start 110 18.5) (end 2 18.5))
(tbtext "Sheet: \${SHEETPATH}" (name "") (pos 109 17))
(tbtext "\${COMPANY}" (name "") (pos 109 20) (font bold))
(tbtext "\${COMMENT1}" (name "") (pos 109 23))
(tbtext "\${COMMENT2}" (name "") (pos 109 26))
(tbtext "\${COMMENT3}" (name "") (pos 109 29))
(tbtext "\${COMMENT4}" (name "") (pos 109 32))
(line (name "") (start 90 8.5) (end 90 5.5))
(line (name "") (start 26 8.5) (end 26 2))
)`;

let defaultSheet = null;

export function parseDrawingSheet(text) {
  const root = parse(text);
  const setup = child(root, "setup");
  const ts = child(setup, "textsize");
  const ds = {
    textSize: ts ? { w: num(ts[1], 1.5), h: num(ts[2], 1.5) } : { w: 1.5, h: 1.5 },
    lineWidth: value(setup, "linewidth", 1, 0.15),
    textLineWidth: value(setup, "textlinewidth", 1, 0.15),
    margins: {
      left: value(setup, "left_margin", 1, 10),
      right: value(setup, "right_margin", 1, 10),
      top: value(setup, "top_margin", 1, 10),
      bottom: value(setup, "bottom_margin", 1, 10),
    },
    items: [],
  };
  for (const n of children(root, "line", "rect", "tbtext", "polygon")) {
    const item = {
      type: n[0],
      repeat: value(n, "repeat", 1, 1),
      incrx: value(n, "incrx", 1, 0),
      incry: value(n, "incry", 1, 0),
      incrlabel: value(n, "incrlabel", 1, 1),
      lineWidth: value(n, "linewidth", 1, 0),
      option: value(n, "option", 1, null),
    };
    if (n[0] === "tbtext") {
      item.text = String(n[1] ?? "");
      item.pos = corner(child(n, "pos"));
      const font = child(n, "font");
      const size = child(font, "size");
      item.size = size ? { w: num(size[1]), h: num(size[2]) } : null;
      item.bold = !!font && font.includes("bold");
      item.italic = !!font && font.includes("italic");
      const j = child(n, "justify");
      item.h = "left";
      item.v = "center";
      if (j) {
        for (const a of j.slice(1)) {
          if (a === "center") item.h = "center";
          else if (a === "left" || a === "right") item.h = a;
          else if (a === "top" || a === "bottom") item.v = a;
        }
      }
      item.rotate = value(n, "rotate", 1, 0);
    } else if (n[0] === "polygon") {
      item.pos = corner(child(n, "pos"));
      item.rotate = value(n, "rotate", 1, 0);
      item.polys = children(n, "pts").map((p) => children(p, "xy").map((q) => ({ x: num(q[1]), y: num(q[2]) })));
    } else {
      item.start = corner(child(n, "start"));
      item.end = corner(child(n, "end"));
    }
    ds.items.push(item);
  }
  return ds;
}

function corner(n) {
  if (!n) return { x: 0, y: 0, corner: "rbcorner" };
  return { x: num(n[1]), y: num(n[2]), corner: typeof n[3] === "string" ? n[3] : "rbcorner" };
}

export function getDefaultDrawingSheet() {
  return (defaultSheet ??= parseDrawingSheet(DEFAULT_WKS));
}

/**
 * Render a drawing sheet.
 * @param {object} ds         parsed drawing sheet
 * @param {object} page       {width, height}
 * @param {object} vars       text variables (TITLE, REVISION, ...)
 * @param {object} opts       {color, pageNumber (1-based, for page1only)}
 */
export function renderDrawingSheet(ds, page, vars, opts) {
  const W = page.width, H = page.height, m = ds.margins;
  const color = opts.color;
  const isPage1 = (opts.pageNumber ?? 1) === 1;
  const map = (p, dx = 0, dy = 0) => {
    const x = p.x + dx, y = p.y + dy;
    switch (p.corner) {
      case "ltcorner":
        return { x: m.left + x, y: m.top + y };
      case "rtcorner":
        return { x: W - m.right - x, y: m.top + y };
      case "lbcorner":
        return { x: m.left + x, y: H - m.bottom - y };
      default:
        return { x: W - m.right - x, y: H - m.bottom - y };
    }
  };
  const inside = (p) => p.x >= m.left - 0.01 && p.x <= W - m.right + 0.01 && p.y >= m.top - 0.01 && p.y <= H - m.bottom + 0.01;

  let lines = "";
  let texts = "";
  for (const it of ds.items) {
    if (it.option === "page1only" && !isPage1) continue;
    if (it.option === "notonpage1" && isPage1) continue;
    const lw = it.lineWidth || ds.lineWidth;
    for (let i = 0; i < it.repeat; i++) {
      const dx = it.incrx * i, dy = it.incry * i;
      if (it.type === "line" || it.type === "rect") {
        const a = map(it.start, dx, dy), b = map(it.end, dx, dy);
        if (i > 0 && (!inside(a) || !inside(b))) break;
        if (it.type === "line") lines += `<path d="M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}" stroke-width="${f(lw)}"/>`;
        else lines += `<rect x="${f(Math.min(a.x, b.x))}" y="${f(Math.min(a.y, b.y))}" width="${f(Math.abs(b.x - a.x))}" height="${f(Math.abs(b.y - a.y))}" stroke-width="${f(lw)}"/>`;
      } else if (it.type === "tbtext") {
        const p = map(it.pos, dx, dy);
        if (!inside(p)) break;
        const text = substitute(incrementLabel(it.text, i * it.incrlabel), vars);
        if (!text) continue;
        const size = it.size?.h || ds.textSize.h;
        texts += svgText({ text, x: p.x, y: p.y, angle: it.rotate, size, width: it.size?.w || ds.textSize.w, h: it.h, v: it.v, bold: it.bold, italic: it.italic, color });
      } else if (it.type === "polygon") {
        const p = map(it.pos, dx, dy);
        const sgnX = it.pos.corner === "rtcorner" || it.pos.corner === "rbcorner" ? -1 : 1;
        for (const poly of it.polys) {
          const d = poly.map((q, k) => `${k ? "L" : "M"}${f(p.x + q.x * sgnX)} ${f(p.y + q.y)}`).join("") + "Z";
          lines += `<path d="${d}" fill="${color}" stroke="none"/>`;
        }
      }
    }
  }
  return `<g class="drawing-sheet" fill="none" stroke="${color}" stroke-linecap="round">${lines}</g><g class="drawing-sheet-text">${texts}</g>`;
}

function incrementLabel(text, n) {
  if (!n) return text;
  if (text.length === 1) {
    const c = text.charCodeAt(0);
    if (/[A-Za-z0-9]/.test(text)) {
      if (/[0-9]/.test(text)) return String(Number(text) + n);
      return String.fromCharCode(c + n);
    }
  }
  if (/^\d+$/.test(text)) return String(Number(text) + n);
  return text;
}

/** Replace ${VAR} references; unknown variables are left visible like KiCad does. */
export function substitute(text, vars) {
  // Values may reference other variables (title block "${TITLE}" → project var), so expand a few levels.
  for (let pass = 0; pass < 4 && text.includes("${"); pass++) {
    const next = text.replace(/\$\{([^}]+)\}/g, (all, name) => {
      const v = vars[name] ?? vars[name.toUpperCase()];
      return v === undefined || v === null || v === all ? all : String(v);
    });
    if (next === text) break;
    text = next;
  }
  return text;
}
