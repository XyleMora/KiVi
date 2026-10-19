// Small DOM helpers shared by the tabs.

export const $ = (sel, root = document) => root.querySelector(sel);

import { unescapeKiCad } from "../text.js";

/** HTML-escape a KiCad string for display (also decodes KiCad's {slash}-style escapes). */
export function escapeHtml(s) {
  return unescapeKiCad(String(s ?? "")).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

let toastTimer = 0;
export function toast(msg, error = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", !!error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), error ? 7000 : 2500);
}

const KEY = "kivi.settings";
let memory = null; // used when localStorage is unavailable (private mode, sandboxed frames)

export function settings() {
  if (memory) return memory;
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    memory = null;
  } catch {
    memory = s; // settings last for this page only
  }
}

const CHEVRON = '<svg class="chev" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 3.5l4.5 4.5L6 12.5"/></svg>';

/**
 * Turn `head` (a button) into the toggle of a collapsible section `body`.
 * Starts collapsed unless `expanded`; returns a setter.
 */
export function collapsible(head, body, expanded = false) {
  if (!head.querySelector(".chev")) head.insertAdjacentHTML("afterbegin", CHEVRON);
  head.classList.add("collapse-head");
  if (body.id) head.setAttribute("aria-controls", body.id);
  const set = (open) => {
    head.setAttribute("aria-expanded", String(open));
    body.hidden = !open;
  };
  head.addEventListener("click", () => set(head.getAttribute("aria-expanded") !== "true"));
  set(expanded);
  return set;
}

/** Natural sort for references: R2 < R10, U1A < U1B. */
export function refCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}
