// KiVi's review data, the same on every forge: what a comment or change
// request points at (a footprint, pad, net, symbol or a bare point) travels in
// an HTML comment at the end of its body, which forges don't render:
//
//   Is this the right footprint?
//
//   <sub>📍 KiVi · footprint **U3**</sub>
//   <!-- kivi:{"v":1,"type":"footprint","ref":"U3","uuid":"…","x":12.5,"y":40,"side":"head"} -->
//
// A change request (an issue labelled "kivi") carries the same marker, plus
// the file and commit it was made on, since an issue has no file of its own.
// Forge adapters (../forge/) read and write them and hand back threads:
//   {id, rootId, key?, path, line, isResolved, isOutdated, resolvedBy,
//    canResolve, canUnresolve, canReply, anchor, comments: [comment()…]}
// and for issues also {issue: true, number, title, commit} (issueThread).

const MARKER = /<!--\s*kivi:(\{[\s\S]*?\})\s*-->/;
const FOOTER = /\n*<sub>📍 KiVi ·[^\n]*<\/sub>[ \t]*/;

/** Human-readable name of what an anchor points at. */
export function anchorLabel(a) {
  if (!a) return "File";
  switch (a.type) {
    case "footprint":
    case "symbol":
      return a.ref || "component";
    case "pad":
      return `${a.ref} pad ${a.pad}`;
    case "net":
      return a.net || (a.pin ? `net at ${a.pin}` : "unnamed net");
    case "sheet":
      return a.name || "sheet";
    default:
      return `point ${a.x.toFixed(1)}, ${a.y.toFixed(1)} mm`;
  }
}

export function anchorKind(a) {
  return !a ? "file" : a.type === "point" ? "point" : a.type;
}

/** Comment body as posted: text, a visible footer and the machine-readable anchor. */
export function encodeBody(text, anchor) {
  const json = JSON.stringify({ v: 1, ...anchor }).replace(/--/g, "-\\u002d"); // "--" would end the HTML comment
  const what = anchor.type === "point" ? "point" : `${anchor.type} **${escapeMd(anchorLabel(anchor))}**`;
  const footer = `<sub>📍 KiVi · ${what}</sub>`;
  return `${text.trim()}\n\n${footer}\n<!-- kivi:${json} -->`;
}

/** → {text, anchor|null} */
export function decodeBody(body) {
  body = String(body ?? "").replace(/\r\n/g, "\n");
  const m = MARKER.exec(body);
  let anchor = null;
  if (m) {
    try {
      anchor = JSON.parse(m[1]);
      if (typeof anchor.x !== "number" || typeof anchor.y !== "number") anchor = null;
    } catch {
      anchor = null;
    }
  }
  const text = (m ? body.slice(0, m.index) + body.slice(m.index + m[0].length) : body).replace(FOOTER, "").trim();
  return { text, anchor };
}

function escapeMd(s) {
  return String(s).replace(/[\\`*_[\]<>|]/g, (c) => `\\${c}`);
}

/** Issue numbers after GitHub's closing keywords in a description ("Fixes #12, closes #3"). */
export function closingNumbers(text) {
  const out = new Set();
  for (const m of String(text ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi)) out.add(Number(m[1]));
  return out;
}

export const ISSUE_LABEL = "kivi";
export const LABEL_COLOUR = "f0a63b"; // the brand orange
export const LABEL_DESCRIPTION = "Hardware change request pinned in KiVi";

/** An issue as a review thread (rootId = the issue number, resolved = closed); `path` is the repository path from the marker. */
export function issueThread(id, number, title, closed, root, replies, { canUpdate = false, locked = false, signedIn }) {
  return {
    id,
    rootId: number,
    key: `i${number}`, // unlike review threads' comment ids, so both can share a store (and a link)
    issue: true,
    number,
    title,
    path: root.anchor?.file ?? null,
    commit: root.anchor?.commit ?? null,
    line: null,
    isResolved: closed,
    isOutdated: false,
    resolvedBy: null,
    canResolve: signedIn && canUpdate && !closed,
    canUnresolve: signedIn && canUpdate && closed,
    canReply: signedIn && !locked,
    anchor: root.anchor,
    comments: [root, ...replies],
  };
}

/** One comment of a thread, with its text and anchor decoded. */
export function comment(id, body, author, avatar, createdAt, url, mine) {
  const { text, anchor } = decodeBody(body);
  return { id, text, anchor, author: author ?? "ghost", avatar: avatar ?? null, createdAt, url, mine: !!mine };
}

/** Minimal, safe rendering of comment Markdown: code, bold, italics, links, line breaks. */
export function renderCommentText(text) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const parts = String(text).split(/(```[\s\S]*?```|`[^`\n]+`)/);
  return parts
    .map((p, i) => {
      if (i % 2) return p.startsWith("```") ? `<pre><code>${esc(p.slice(3, -3).replace(/^[\w-]*\n/, ""))}</code></pre>` : `<code>${esc(p.slice(1, -1))}</code>`;
      return esc(p)
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`)
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener">${u}</a>`)
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
        .replace(/(^|\s)@([\w-]+)/g, '$1<span class="mention">@$2</span>')
        .replace(/\n/g, "<br>");
    })
    .join("");
}
