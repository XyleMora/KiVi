// In-app updates (desktop only): look for a newer release now and then, tell the
// user in the account menu, and on request download it, replace the running copy
// and restart (src-tauri/src/update.rs does the work; this is the UI side).
//
// All three pages share one throttle and one result in localStorage
// (`kivi.updateCheck` = {checkedAt, available: {version, date, url} | null}).
// The pure decisions are in update-check.js (re-exported here).

import { $, escapeHtml, settings, saveSettings, toast } from "../app/ui.js";
import { invoke, isDesktop, listen } from "./tauri.js";
import { CHECK_INTERVAL, progressText, shouldCheck, visibleUpdate } from "./update-check.js";

export { shouldCheck, visibleUpdate };

const CACHE_KEY = "kivi.updateCheck";
const FIRST_CHECK_DELAY = 10_000;
const RETRY_AFTER_FAILURE = 5 * 60 * 1000;

let info = null; // update_info: {enabled, repo, current, canInstall, reason}
let cache = readCache();
let onChange = () => {};
let checking = null;
let failedAt = 0;

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
  } catch {
    return null;
  }
}

function writeCache(value) {
  cache = value;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(value));
  } catch {
    // no storage: this page still knows, the others check on their own
  }
}

const shown = () => visibleUpdate(cache, settings(), info?.current);

/** Tell the header, but only when what it shows changed. */
function changed(before) {
  if (JSON.stringify(before) !== JSON.stringify(shown())) onChange();
}

/** {info, available}: what the header and Settings show (`available` is null when nothing should be offered). */
export function updateState() {
  return { info, available: shown() };
}

async function check() {
  const found = await invoke("update_check");
  const before = shown();
  writeCache({ checkedAt: Date.now(), available: found ?? null });
  changed(before);
  return found ?? null;
}

/**
 * Runs a check now, ignoring the throttle and the Settings switch. Resolves to the
 * update found (or null); rejects with the reason when the check failed.
 */
export async function checkNow() {
  if (!isDesktop) return null;
  checking ??= check().finally(() => (checking = null));
  return checking;
}

/** The automatic check: only when switched on, enabled in this build, and due. */
async function maybeCheck() {
  if (!info?.enabled || settings().checkUpdates === false || checking) return;
  const now = Date.now();
  if (!shouldCheck(now, cache) || now - failedAt < RETRY_AFTER_FAILURE) return;
  try {
    await checkNow();
  } catch (e) {
    failedAt = now; // not cached as "no update" (nothing may be assumed); tried again later
    console.warn("Update check failed:", e);
  }
}

/** Starts checking; calls onChange() when what the header should show changes. */
export function initUpdates(callback) {
  if (!isDesktop) return;
  onChange = callback;
  invoke("update_info").then(
    (i) => {
      info = i;
      onChange();
      if (!i?.enabled) return; // null: no answer (the headless tests' Tauri mock)
      setTimeout(maybeCheck, FIRST_CHECK_DELAY);
      setInterval(maybeCheck, CHECK_INTERVAL);
      window.addEventListener("focus", maybeCheck);
    },
    (e) => console.warn("Update info failed:", e),
  );
  // Another page checked, skipped or was switched off: keep this one's dot in step.
  window.addEventListener("storage", (e) => {
    if (e.key !== CACHE_KEY && e.key !== "kivi.settings") return;
    cache = readCache();
    onChange();
  });
  window.addEventListener("kivi:settings", () => onChange());
}

/** Remembers to not offer this version again (a later one shows again). */
export function skipVersion(version) {
  const before = shown();
  saveSettings({ ...settings(), updateSkip: version });
  changed(before);
}

/** Opens the update dialog for the update found. */
export function openUpdateDialog() {
  const found = cache?.available;
  if (!found || !info) return;
  const { current, canInstall, reason, repo } = info;
  const dlg = document.createElement("dialog");
  dlg.id = "update-dialog";
  dlg.className = "git-dialog";
  dlg.innerHTML = `
    <form method="dialog" class="settings">
      <h2>KiVi ${escapeHtml(found.version)} is available</h2>
      <p>You have ${escapeHtml(current)}.${found.date ? ` Released ${escapeHtml(found.date)}.` : ""}
        <a href="${escapeHtml(found.url)}">What's new</a></p>
      ${canInstall ? "" : `<p class="muted">${escapeHtml(reason ?? "KiVi can't update itself here")}. Download it from ${escapeHtml(repo)} instead.</p>`}
      <div id="update-progress" hidden>
        <progress id="update-bar"></progress>
        <p class="muted" id="update-text" aria-live="polite"></p>
      </div>
      <p class="error-text" id="update-error" hidden></p>
      <div class="row end gap">
        <button type="button" class="btn" id="update-skip">Skip this version</button>
        <button value="cancel" class="btn" id="update-later">Later</button>
        ${canInstall ? `<button type="button" class="btn primary" id="update-go">Update and restart</button>` : `<a class="btn primary" id="update-open" href="${escapeHtml(found.url)}">Download…</a>`}
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  const buttons = dlg.querySelectorAll("button");
  let busy = false;
  dlg.addEventListener("cancel", (e) => busy && e.preventDefault()); // Escape mid-update
  $("#update-skip", dlg).addEventListener("click", () => {
    skipVersion(found.version);
    dlg.close();
  });
  $("#update-go", dlg)?.addEventListener("click", async () => {
    busy = true;
    for (const b of buttons) b.disabled = true;
    const error = $("#update-error", dlg);
    error.hidden = true;
    $("#update-progress", dlg).hidden = false;
    const text = $("#update-text", dlg);
    text.textContent = "Downloading…";
    const stop = await listen("update-progress", ({ payload: p }) => {
      const bar = $("#update-bar", dlg);
      if (p.total) (bar.max = p.total), (bar.value = p.downloaded);
      text.textContent = p.total && p.downloaded >= p.total ? "Installing…" : `Downloading… ${progressText(p.downloaded, p.total)}`;
    });
    try {
      // The Rust side keeps the update found by the last check; after a restart it
      // has none, so look again first (one small request).
      if (!(await invoke("update_check"))) throw new Error("KiVi is already up to date");
      await invoke("update_install"); // restarts the app when it works
    } catch (e) {
      error.textContent = e?.message ?? String(e);
      error.hidden = false;
      $("#update-progress", dlg).hidden = true;
      busy = false;
      for (const b of buttons) b.disabled = false;
    } finally {
      stop();
    }
  });
  dlg.showModal();
}
