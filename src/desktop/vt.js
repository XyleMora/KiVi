// A small terminal emulator: turns a shell's output (text plus xterm escape
// sequences) into a grid of character cells for terminal.js to draw. It covers
// what shells, prompts, git, less, top and editors use: cursor movement,
// erasing, scroll regions, insert/delete, 16/256/true colour, the alternate
// screen, bracketed paste and the cursor-position report. No DOM, so it can run
// headless. Lines scrolled off the top of the main screen are collected in `out`
// for the scrollback.

/** The default look of a cell. Attributes are frozen objects shared by cells. */
export const DEF = Object.freeze({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false });

/** Columns a character takes: 0 (combining), 1, or 2 (East Asian wide, emoji). */
export function charWidth(c) {
  if ((c >= 0x300 && c <= 0x36f) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0x20d0 && c <= 0x20ff)) return 0;
  if (
    (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1f64f) || (c >= 0x1f900 && c <= 0x1f9ff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  )
    return 2;
  return 1;
}

export class Screen {
  /**
   * @param {number} cols
   * @param {number} rows
   * @param {(answer: string) => void} reply  answers to the shell's queries (cursor position, device attributes)
   */
  constructor(cols, rows, reply = () => {}) {
    this.cols = cols;
    this.rows = rows;
    this.reply = reply;
    this.out = []; // lines scrolled into the scrollback since the last draw
    this.dirty = new Set(); // screen rows to redraw
    this.reset();
  }

  reset() {
    this.attr = DEF;
    this.eraseCache = new Map();
    this.main = this.blankLines(this.rows);
    this.alt = null;
    this.lines = this.main;
    this.x = 0;
    this.y = 0;
    this.top = 0;
    this.bottom = this.rows - 1;
    this.wrapPending = false; // the cursor is past the last column; the next character wraps
    this.saved = null;
    this.appCursor = false;
    this.cursorVisible = true;
    this.bracketed = false;
    this.autowrap = true;
    this.state = "ground";
    this.buf = "";
    this.clearBack = true; // the scrollback is wiped too (also by CSI 3 J)
    this.markAll();
  }

  markAll() {
    for (let r = 0; r < this.rows; r++) this.dirty.add(r);
  }

  /** Erased cells keep the current background colour, as xterm's do. */
  eraseAttr() {
    const bg = this.attr.bg;
    if (bg == null) return DEF;
    if (!this.eraseCache.has(bg)) this.eraseCache.set(bg, Object.freeze({ ...DEF, bg }));
    return this.eraseCache.get(bg);
  }

  blankLine(n = this.cols) {
    const a = this.eraseAttr();
    return Array.from({ length: n }, () => ({ ch: " ", a }));
  }

  blankLines(n) {
    return Array.from({ length: n }, () => this.blankLine());
  }

  /** Feed output from the shell. */
  write(text) {
    for (const ch of text) {
      const c = ch.codePointAt(0);
      switch (this.state) {
        case "ground":
          this.ground(ch, c);
          break;
        case "esc":
          this.esc(ch);
          break;
        case "csi":
          if (c >= 0x40 && c <= 0x7e) {
            this.state = "ground";
            this.csi(ch, this.buf);
          } else if (c === 0x1b) this.state = "esc";
          else if (c < 0x20) this.ground(ch, c); // control characters still work inside a sequence
          else this.buf += ch;
          break;
        case "osc": // OSC, DCS and the like: skipped up to BEL or ESC \
          if (c === 7) this.state = "ground";
          else if (c === 0x1b) this.state = "oscEsc";
          break;
        case "oscEsc":
          this.state = "ground";
          if (ch !== "\\") this.esc(ch);
          break;
        case "charset": // ESC ( B and friends: only one character set here
          this.state = "ground";
          break;
      }
    }
  }

  ground(ch, c) {
    if (c >= 0x20 && c !== 0x7f) return this.print(ch, c);
    switch (c) {
      case 0x1b:
        this.state = "esc";
        break;
      case 13:
        this.x = 0;
        this.wrapPending = false;
        break;
      case 10:
      case 11:
      case 12:
        this.lineFeed();
        break;
      case 8:
        if (this.x > 0) this.x--;
        this.wrapPending = false;
        break;
      case 9:
        this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8);
        break;
    }
  }

  print(ch, c) {
    const w = charWidth(c);
    if (w === 0) {
      // A combining mark joins the character before it.
      const px = this.wrapPending ? this.x : this.x - 1;
      if (px >= 0) {
        const cell = this.lines[this.y][px];
        this.lines[this.y][px] = { ch: cell.ch + ch, a: cell.a };
        this.dirty.add(this.y);
      }
      return;
    }
    if (this.wrapPending && this.autowrap) {
      this.x = 0;
      this.lineFeed();
    }
    this.wrapPending = false;
    if (w === 2 && this.x === this.cols - 1 && this.autowrap) {
      this.lines[this.y][this.x] = { ch: " ", a: this.attr };
      this.dirty.add(this.y);
      this.x = 0;
      this.lineFeed();
    }
    const line = this.lines[this.y];
    line[this.x] = { ch, a: this.attr };
    if (w === 2 && this.x + 1 < this.cols) line[this.x + 1] = { ch: "", a: this.attr }; // the wide character's right half
    this.dirty.add(this.y);
    this.x += w;
    if (this.x >= this.cols) {
      this.x = this.cols - 1;
      this.wrapPending = true;
    }
  }

  lineFeed() {
    if (this.y === this.bottom) this.scrollUp(1, this.top, this.bottom, true);
    else if (this.y < this.rows - 1) this.y++;
  }

  /** Move rows top..bottom up by n; with `toBack`, what leaves the top of the main screen goes to the scrollback. */
  scrollUp(n, top = this.top, bottom = this.bottom, toBack = false) {
    n = Math.min(n, bottom - top + 1);
    for (let i = 0; i < n; i++) {
      const [gone] = this.lines.splice(top, 1);
      this.lines.splice(bottom, 0, this.blankLine());
      if (toBack && top === 0 && this.lines === this.main) this.out.push(gone);
    }
    for (let r = top; r <= bottom; r++) this.dirty.add(r);
  }

  scrollDown(n, top = this.top, bottom = this.bottom) {
    n = Math.min(n, bottom - top + 1);
    for (let i = 0; i < n; i++) {
      this.lines.splice(bottom, 1);
      this.lines.splice(top, 0, this.blankLine());
    }
    for (let r = top; r <= bottom; r++) this.dirty.add(r);
  }

  esc(ch) {
    this.state = "ground";
    switch (ch) {
      case "[":
        this.state = "csi";
        this.buf = "";
        break;
      case "]":
      case "P":
      case "_":
      case "^":
        this.state = "osc";
        break;
      case "(":
      case ")":
      case "*":
      case "+":
        this.state = "charset";
        break;
      case "7":
        this.saveCursor();
        break;
      case "8":
        this.restoreCursor();
        break;
      case "D":
        this.lineFeed();
        break;
      case "E":
        this.x = 0;
        this.lineFeed();
        break;
      case "M":
        if (this.y === this.top) this.scrollDown(1);
        else if (this.y > 0) this.y--;
        break;
      case "c":
        this.reset();
        break;
    }
  }

  saveCursor() {
    this.saved = { x: this.x, y: this.y, attr: this.attr };
  }

  restoreCursor() {
    if (!this.saved) return;
    this.x = Math.min(this.saved.x, this.cols - 1);
    this.y = Math.min(this.saved.y, this.rows - 1);
    this.attr = this.saved.attr;
    this.wrapPending = false;
  }

  csi(final, buf) {
    let prefix = "";
    if (/^[?>=<]/.test(buf)) {
      prefix = buf[0];
      buf = buf.slice(1);
    }
    if (/[\x20-\x2f]/.test(buf)) return; // with intermediates (cursor shape, …): not drawn here
    const ps = buf.split(/[;:]/).map((n) => parseInt(n, 10) || 0);
    const p = (i, d = 1) => ps[i] || d;
    const clampX = (v) => Math.max(0, Math.min(this.cols - 1, v));
    const clampY = (v) => Math.max(0, Math.min(this.rows - 1, v));
    if (prefix && !"hlcJKm".includes(final)) return;
    if (prefix === ">" || prefix === "=") {
      if (final === "c" && prefix === ">") this.reply("\x1b[>0;276;0c");
      return; // modifyOtherKeys (CSI > … m) and the like
    }
    const line = this.lines[this.y];
    if ("ABCDEFGHadef`".includes(final)) this.wrapPending = false;
    switch (final) {
      case "A":
        this.y = clampY(this.y - p(0));
        break;
      case "B":
      case "e":
        this.y = clampY(this.y + p(0));
        break;
      case "C":
      case "a":
        this.x = clampX(this.x + p(0));
        break;
      case "D":
        this.x = clampX(this.x - p(0));
        break;
      case "E":
        this.x = 0;
        this.y = clampY(this.y + p(0));
        break;
      case "F":
        this.x = 0;
        this.y = clampY(this.y - p(0));
        break;
      case "G":
      case "`":
        this.x = clampX(p(0) - 1);
        break;
      case "d":
        this.y = clampY(p(0) - 1);
        break;
      case "H":
      case "f":
        this.y = clampY(p(0) - 1);
        this.x = clampX(p(1) - 1);
        break;
      case "J":
        this.eraseDisplay(ps[0]);
        break;
      case "K":
        this.eraseLine(ps[0]);
        break;
      case "@": {
        const n = Math.min(p(0), this.cols - this.x);
        line.splice(this.x, 0, ...this.blankLine(n));
        line.length = this.cols;
        this.dirty.add(this.y);
        break;
      }
      case "P": {
        const n = Math.min(p(0), this.cols - this.x);
        line.splice(this.x, n);
        line.push(...this.blankLine(n));
        this.dirty.add(this.y);
        break;
      }
      case "X": {
        const a = this.eraseAttr();
        for (let i = this.x; i < Math.min(this.cols, this.x + p(0)); i++) line[i] = { ch: " ", a };
        this.dirty.add(this.y);
        break;
      }
      case "L":
        if (this.y >= this.top && this.y <= this.bottom) this.scrollDown(p(0), this.y, this.bottom);
        this.x = 0;
        break;
      case "M":
        if (this.y >= this.top && this.y <= this.bottom) this.scrollUp(p(0), this.y, this.bottom);
        this.x = 0;
        break;
      case "S":
        this.scrollUp(p(0));
        break;
      case "T":
        if (ps.length <= 1) this.scrollDown(p(0));
        break;
      case "m":
        if (!prefix) this.sgr(ps);
        break;
      case "r": {
        const top = p(0) - 1;
        const bottom = Math.min(this.rows, p(1, this.rows)) - 1;
        [this.top, this.bottom] = top < bottom ? [top, bottom] : [0, this.rows - 1];
        this.x = 0;
        this.y = 0;
        this.wrapPending = false;
        break;
      }
      case "h":
      case "l":
        if (prefix === "?") for (const n of ps) this.mode(n, final === "h");
        break;
      case "s":
        this.saveCursor();
        break;
      case "u":
        this.restoreCursor();
        break;
      case "n":
        if (ps[0] === 6) this.reply(`\x1b[${this.y + 1};${this.x + 1}R`);
        else if (ps[0] === 5) this.reply("\x1b[0n");
        break;
      case "c":
        if (!prefix) this.reply("\x1b[?1;2c");
        break;
    }
  }

  eraseDisplay(n) {
    const blankFrom = (from) => {
      for (let r = from; r < this.rows; r++) {
        this.lines[r] = this.blankLine();
        this.dirty.add(r);
      }
    };
    if (n === 0) {
      this.eraseLine(0);
      blankFrom(this.y + 1);
    } else if (n === 1) {
      for (let r = 0; r < this.y; r++) {
        this.lines[r] = this.blankLine();
        this.dirty.add(r);
      }
      this.eraseLine(1);
    } else {
      blankFrom(0);
      if (n === 3) this.clearBack = true;
    }
  }

  eraseLine(n) {
    const line = this.lines[this.y];
    const a = this.eraseAttr();
    const [from, to] = n === 0 ? [this.x, this.cols] : n === 1 ? [0, this.x + 1] : [0, this.cols];
    for (let i = from; i < to; i++) line[i] = { ch: " ", a };
    this.dirty.add(this.y);
  }

  mode(n, on) {
    switch (n) {
      case 1:
        this.appCursor = on;
        break;
      case 7:
        this.autowrap = on;
        break;
      case 25:
        this.cursorVisible = on;
        this.dirty.add(this.y);
        break;
      case 47:
      case 1047:
      case 1049:
        if (on && !this.alt) {
          if (n === 1049) this.saveCursor();
          this.alt = this.blankLines(this.rows);
          this.lines = this.alt;
          this.markAll();
        } else if (!on && this.alt) {
          this.alt = null;
          this.lines = this.main;
          if (n === 1049) this.restoreCursor();
          this.markAll();
        }
        break;
      case 2004:
        this.bracketed = on;
        break;
    }
  }

  sgr(ps) {
    const a = { ...this.attr };
    for (let i = 0; i < ps.length; i++) {
      const n = ps[i];
      if (n === 0) Object.assign(a, DEF);
      else if (n === 1) a.bold = true;
      else if (n === 2) a.dim = true;
      else if (n === 3) a.italic = true;
      else if (n === 4) a.underline = true;
      else if (n === 7) a.inverse = true;
      else if (n === 22) a.bold = a.dim = false;
      else if (n === 23) a.italic = false;
      else if (n === 24) a.underline = false;
      else if (n === 27) a.inverse = false;
      else if (n >= 30 && n <= 37) a.fg = n - 30;
      else if (n >= 90 && n <= 97) a.fg = n - 82;
      else if (n === 39) a.fg = null;
      else if (n >= 40 && n <= 47) a.bg = n - 40;
      else if (n >= 100 && n <= 107) a.bg = n - 92;
      else if (n === 49) a.bg = null;
      else if (n === 38 || n === 48) {
        let c = null;
        if (ps[i + 1] === 5) {
          c = ps[i + 2] ?? 0;
          i += 2;
        } else if (ps[i + 1] === 2) {
          const [r, g, b] = [ps[i + 2] ?? 0, ps[i + 3] ?? 0, ps[i + 4] ?? 0];
          c = `rgb(${r},${g},${b})`;
          i += 4;
        }
        if (n === 38) a.fg = c;
        else a.bg = c;
      }
    }
    this.attr = Object.freeze(a);
  }

  /** New size in cells. Lines that no longer fit above the cursor go to the scrollback. */
  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    const fit = (lines) => {
      for (const l of lines) {
        if (l.length > cols) l.length = cols;
        while (l.length < cols) l.push({ ch: " ", a: DEF });
      }
    };
    const height = (lines, active) => {
      const excess = lines.length - rows;
      if (excess > 0) {
        const fromTop = active ? Math.max(0, Math.min(excess, this.y - rows + 1)) : 0;
        const gone = lines.splice(0, fromTop);
        if (lines === this.main) this.out.push(...gone);
        lines.length = rows;
        if (active) this.y -= fromTop;
      }
      while (lines.length < rows) lines.push(this.blankLine());
    };
    fit(this.main);
    height(this.main, this.lines === this.main);
    if (this.alt) {
      fit(this.alt);
      height(this.alt, true);
    }
    this.rows = rows;
    this.top = 0;
    this.bottom = rows - 1;
    this.x = Math.min(this.x, cols - 1);
    this.y = Math.max(0, Math.min(this.y, rows - 1));
    this.wrapPending = false;
    this.dirty.clear();
    this.markAll();
  }
}
