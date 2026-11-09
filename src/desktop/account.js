// Header shared by every desktop page: the projects / pull requests icons and
// the account menu (per forge: profile, repository access, sign in/out; then
// Settings), plus the Settings dialog. Forge access is only through signing in
// (device flow, src/desktop/tauri.js); there is no token to paste.
//
// Other code asks for a sign-in with
// `window.dispatchEvent(new CustomEvent("kivi:signin", {detail: {forge: id}}))`
// (the review panel does, so it needs no Tauri imports; no detail = the default
// forge), and hears about saved settings through the "kivi:settings" event.
//
// Settings → KiCad links an installed KiCad (settings.kicad, from kicad_inspect):
// "Open in KiCad" uses its program, and the 3D view its path variables.

import { $, escapeHtml, settings, saveSettings, toast, tokenFor } from "../app/ui.js";
import { parseModelSource } from "../sources.js";
import { FORGES, forge } from "../forge/index.js";
import { ICONS } from "./icons.js";
import { appInstallUrl, inspectKicad, pickFolder, signInTo, signOut as signOutOf } from "./tauri.js";

// Where KiCad usually is, as the path box's example and the folder picker's start.
const KICAD_HINT = /Windows/.test(navigator.userAgent)
  ? "C:\\Program Files\\KiCad\\10.0"
  : /Mac OS X|Macintosh/.test(navigator.userAgent)
    ? "/Applications/KiCad"
    : "/usr";

const SETTINGS_HTML = `
<form method="dialog" class="settings">
  <h2>Settings</h2>
  <label class="check"><input type="checkbox" id="set-sch-dark"> Dark schematic</label>
  <label class="field-label" for="set-model-sources">3D model sources <span class="muted">(one per line; after the project, folders first, then the rest in order)</span></label>
  <textarea id="set-model-sources" class="input mono" rows="4" spellcheck="false"></textarea>
  <div class="row between gap">
    <p class="muted settings-hint">A URL prefix for KiCad library models, a GitHub repository (<code>owner/repo</code>, <code>owner/repo@branch:folder</code>) or GitLab project address searched for models by file name, or a folder on this computer. A linked KiCad adds its own library and add-ons by itself.</p>
    <button type="button" class="btn small" id="set-add-model-dir">Add folder…</button>
  </div>
  <label class="check"><input type="checkbox" id="set-load-models"> Load 3D component models</label>
  <label class="field-label" for="set-kicad-path">KiCad <span class="muted">(its program or installation folder; for Open in KiCad and its 3D model folders)</span></label>
  <div class="row gap">
    <input id="set-kicad-path" class="input mono kicad-path" spellcheck="false" autocomplete="off">
    <button type="button" class="btn small" id="set-kicad-browse">Browse…</button>
  </div>
  <div class="muted settings-hint" id="set-kicad-status" aria-live="polite"></div>
  <div class="row end gap">
    <button value="cancel" class="btn">Cancel</button>
    <button value="save" class="btn primary">Save</button>
  </div>
</form>`;

/** The account menu: `face` is the button's content, `head` the top of the panel. */
/**
 * The account menu: `sections` of {head, items} (one per forge), then Settings.
 * An item is [icon, label, action, href?, forge id?].
 */
function accountMenu(face, sections, footer) {
  const item = ([icon, label, act, href, f]) =>
    href
      ? `<a role="menuitem" href="${escapeHtml(href)}">${ICONS[icon]}<span>${escapeHtml(label)}</span></a>`
      : `<button type="button" role="menuitem" data-act="${act}"${f ? ` data-forge="${escapeHtml(f)}"` : ""}>${ICONS[icon]}<span>${escapeHtml(label)}</span></button>`;
  const section = ({ head, items }) => `${head ? `<div class="menu-head">${head}</div><hr>` : ""}${items.map(item).join("")}`;
  return `<details class="menu account-menu">
    <summary class="account-button" aria-label="Account menu" aria-haspopup="menu">${face}${ICONS.chevron}</summary>
    <div class="menu-panel" role="menu">
      ${[...sections.map(section), footer.map(item).join("")].join("<hr>")}
    </div>
  </details>`;
}

/**
 * Put the shared header controls into the page's `.top-actions`.
 * @param {object} [opts]
 * @param {boolean} [opts.homeLinks]  add the projects / pull requests / issues icons (the home page has its own)
 * @param {() => void} [opts.onAccountChange]  after signing in or out (default: reload the page)
 * @returns {{renderAccount(): Promise<void>, signIn(): Promise<void>}}
 */
export function initHeader({ homeLinks = true, onAccountChange = () => location.reload() } = {}) {
  const actions = $(".top-actions");
  if (homeLinks) {
    const nav = document.createElement("nav");
    nav.className = "home-switch";
    nav.setAttribute("aria-label", "Home");
    nav.innerHTML =
      `<a class="btn icon" href="inbox.html#projects" title="Projects" aria-label="Projects">${ICONS.repo}</a>` +
      `<a class="btn icon" href="inbox.html#prs" title="Pull requests" aria-label="Pull requests">${ICONS.pullRequest}</a>` +
      `<a class="btn icon" href="inbox.html#issues" title="Issues" aria-label="Issues">${ICONS.issue}</a>`;
    actions.appendChild(nav);
  }
  let el = $("#account");
  if (!el) {
    el = document.createElement("div");
    el.id = "account";
    el.className = "account";
    actions.appendChild(el);
  }

  const dlg = document.createElement("dialog");
  dlg.id = "settings";
  dlg.innerHTML = SETTINGS_HTML;
  document.body.appendChild(dlg);
  // Folders are tried before web sources anyway; listing them first shows that.
  $("#set-add-model-dir").addEventListener("click", async () => {
    try {
      const dir = await pickFolder("Choose a 3D model folder");
      if (!dir) return;
      const box = $("#set-model-sources");
      const lines = box.value.split("\n").map((l) => l.trim()).filter((l) => l && l !== dir);
      box.value = [dir, ...lines].join("\n");
    } catch (e) {
      toast(`Couldn't open the folder picker: ${e.message ?? e}`, true);
    }
  });

  // KiCad: checked as soon as the path changes; Save keeps the last good check.
  let kicad = null; // {program, version, vars} | null (not linked)
  let kicadCheck = Promise.resolve();
  const kicadBox = $("#set-kicad-path");
  kicadBox.placeholder = KICAD_HINT;
  const showKicad = (html) => ($("#set-kicad-status").innerHTML = html);
  const describeKicad = (k) =>
    k
      ? `KiCad ${escapeHtml(k.version)} · <code>${escapeHtml(k.program)}</code>` +
        Object.entries(k.vars)
          .map(([name, dir]) => `<div class="kicad-var"><code>\${${escapeHtml(name)}}</code> = <code>${escapeHtml(dir)}</code></div>`)
          .join("")
      : "Not linked: Open in KiCad is greyed out.";
  function checkKicad() {
    const path = kicadBox.value.trim();
    if (!path) {
      kicad = null;
      showKicad(describeKicad(null));
      return (kicadCheck = Promise.resolve());
    }
    if (path === kicad?.program) return kicadCheck;
    showKicad("Checking…");
    kicadCheck = inspectKicad(path).then(
      (info) => {
        if (kicadBox.value.trim() !== path) return; // changed again meanwhile
        kicad = info;
        kicadBox.value = info.program;
        showKicad(describeKicad(info));
      },
      (e) => {
        if (kicadBox.value.trim() !== path) return;
        kicad = undefined; // not a KiCad: Save keeps the one already linked
        showKicad(`<span class="error-text">${escapeHtml(e.message ?? String(e))}</span>`);
      },
    );
    return kicadCheck;
  }
  kicadBox.addEventListener("change", checkKicad);
  $("#set-kicad-browse").addEventListener("click", async () => {
    try {
      const dir = await pickFolder("Choose KiCad's installation folder", kicadBox.value.trim() || KICAD_HINT);
      if (!dir) return;
      kicadBox.value = dir;
      checkKicad();
    } catch (e) {
      toast(`Couldn't open the folder picker: ${e.message ?? e}`, true);
    }
  });

  dlg.addEventListener("close", async () => {
    if (dlg.returnValue !== "save") return;
    await checkKicad(); // a path typed and saved straight away
    const sources = $("#set-model-sources").value.split("\n").map((l) => l.trim()).filter(Boolean);
    const bad = sources.filter((l) => !l.startsWith("#") && !parseModelSource(l));
    if (bad.length) toast(`Not a URL, repository or folder: ${bad[0]}`, true);
    else toast("Settings saved");
    if (kicad === undefined) toast("KiCad wasn't linked: that path isn't a KiCad installation", true);
    const { modelBase, kicad: oldKicad, ...rest } = settings(); // modelBase: replaced by modelSources
    const linked = kicad === undefined ? oldKicad : kicad;
    saveSettings({ ...rest, ...(linked && { kicad: linked }), schDark: $("#set-sch-dark").checked, modelSources: sources, loadModels: $("#set-load-models").checked });
    window.dispatchEvent(new Event("kivi:settings"));
  });

  async function openSettings() {
    const { DEFAULT_MODEL_BASE } = await import("../pcb/board3d.js"); // three.js: only when needed
    const s = settings();
    $("#set-sch-dark").checked = s.schDark === true;
    $("#set-model-sources").value = (s.modelSources ?? [s.modelBase ?? DEFAULT_MODEL_BASE]).join("\n");
    $("#set-load-models").checked = s.loadModels !== false;
    kicad = s.kicad ?? null;
    kicadBox.value = kicad?.program ?? "";
    showKicad(describeKicad(kicad));
    dlg.showModal();
    // KiCad's own paths may have changed since it was linked (Preferences → Configure Paths).
    if (kicad) {
      const program = kicad.program;
      inspectKicad(program).then(
        (info) => kicadBox.value.trim() === program && ((kicad = info), showKicad(describeKicad(info))),
        (e) => kicadBox.value.trim() === program && showKicad(`<span class="error-text">${escapeHtml(e.message ?? String(e))}</span>`),
      );
    }
  }

  /** Sign in to a forge (an id or forge object; the default forge if none). */
  async function signIn(f) {
    f = typeof f === "string" || !f ? forge(f ?? undefined) : f;
    try {
      if (await signInTo(f)) onAccountChange();
    } catch (e) {
      toast(`${f.name} sign-in failed: ${e.message ?? e}`, true);
    }
  }

  function signOut(f) {
    signOutOf(f);
    onAccountChange();
  }

  /** One forge's part of the menu: who is signed in (or why not), and its actions. */
  async function forgeSection(f, many) {
    const token = tokenFor(f);
    const signInItem = ["signIn", `Sign in to ${f.name}`, "signin", null, f.id];
    if (!token) return { face: null, head: many ? `<div><strong>${escapeHtml(f.name)}</strong><span class="muted">Not signed in</span></div>` : null, items: [signInItem] };
    let me = null, error = null;
    try {
      me = await f.user(token);
    } catch (e) {
      error = e;
    }
    if (!me) {
      return {
        face: `<span class="tag warn">signed out</span>`,
        head: `<div><strong>${escapeHtml(f.name)} ended the sign-in</strong><span class="muted">${escapeHtml(error.message)}</span></div>`,
        items: [signInItem, ["signOut", `Sign out of ${f.name}`, "signout", null, f.id]],
      };
    }
    const access = await appInstallUrl(f);
    return {
      face: `<img class="avatar" src="${escapeHtml(f.avatar(me.avatar, 64))}" alt=""><span class="account-login">${escapeHtml(me.login)}</span>`,
      head: `<img class="avatar avatar-lg" src="${escapeHtml(f.avatar(me.avatar, 80))}" alt=""><div><strong>${escapeHtml(me.login)}</strong><span class="muted">${escapeHtml(me.name ? `${me.name} · ${f.name}` : f.name)}</span></div>`,
      items: [["person", `Your ${f.name} profile`, null, me.url], ...(access ? [["key", "Repository access", null, access]] : []), ["signOut", `Sign out of ${f.name}`, "signout", null, f.id]],
    };
  }

  async function renderAccount() {
    const settingsItem = ["gear", "Settings", "settings"];
    const signedIn = FORGES.filter((f) => tokenFor(f));
    if (!signedIn.length) {
      // Signed out everywhere: one "Not signed in" head, then a sign-in per forge.
      el.innerHTML = accountMenu(
        `<span class="avatar avatar-blank">${ICONS.person}</span>`,
        [{ head: `<div><strong>Not signed in</strong><span class="muted">Public repositories only</span></div>`, items: FORGES.map((f) => ["signIn", `Sign in to ${f.name}`, "signin", null, f.id]) }],
        [settingsItem],
      );
    } else {
      const sections = await Promise.all(FORGES.map((f) => forgeSection(f, FORGES.length > 1)));
      // The header shows the first account signed in (or its warning).
      const face = sections.find((x) => x.face)?.face ?? `<span class="avatar avatar-blank">${ICONS.person}</span>`;
      el.innerHTML = accountMenu(face, sections, [settingsItem]);
    }
    for (const b of el.querySelectorAll("[data-act]")) {
      b.addEventListener("click", () => {
        b.closest("details").open = false;
        if (b.dataset.act === "signin") signIn(b.dataset.forge);
        if (b.dataset.act === "settings") openSettings();
        if (b.dataset.act === "signout") signOut(forge(b.dataset.forge));
      });
    }
  }

  window.addEventListener("kivi:signin", (e) => signIn(e.detail?.forge));
  return { renderAccount, signIn };
}

// Menus close on a click elsewhere, on Escape, and after picking a link.
document.addEventListener("click", (e) => {
  for (const d of document.querySelectorAll("details.menu[open]")) if (!d.contains(e.target) || e.target.closest(".menu-panel a")) d.open = false;
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const d of document.querySelectorAll("details.menu[open]")) {
    e.preventDefault(); // handled: other Escape handlers (the home page's drawer) leave it
    d.open = false;
    d.querySelector("summary").focus();
  }
});
