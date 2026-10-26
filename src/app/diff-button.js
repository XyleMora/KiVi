// The project bar's Visual diff button, between the history menu and Open in
// KiCad: a link to diff.html set by main.js (GitHub projects) or
// src/desktop/git.js (local git copies); greyed out, saying why, otherwise.

import { $, toast } from "./ui.js";

document.addEventListener("click", (e) => {
  const a = e.target.closest?.("#visual-diff");
  if (a?.getAttribute("aria-disabled") === "true") {
    e.preventDefault();
    toast(a.title, true);
  }
});

/**
 * Point the Visual diff button at a comparison, or grey it out.
 * @param {{href?: string|null, title: string}} o without `href`, `title` says why it's greyed out
 */
export function setDiffButton({ href = null, title }) {
  const a = $("#visual-diff");
  if (!a) return;
  a.hidden = false;
  if (href) a.href = href;
  else a.removeAttribute("href");
  a.setAttribute("aria-disabled", String(!href));
  a.title = title;
}
