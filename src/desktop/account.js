// Header shared by every desktop page: the projects / pull requests icons and
// the account menu (GitHub profile, repository access, Settings, sign in/out),
// plus the Settings dialog. GitHub access is only through signing in with the
// GitHub App (src/desktop/tauri.js); there is no token to paste.
//
// Other code asks for a sign-in with `window.dispatchEvent(new Event("kivi:signin"))`
// (the review panel does, so it needs no Tauri imports), and hears about saved
// settings through the "kivi:settings" event.
//
// Settings → KiCad links an installed KiCad (settings.kicad, from kicad_inspect):
// "Open in KiCad" uses its program, and the 3D view its path variables.

import { $, escapeHtml, settings, saveSettings, toast } from "../app/ui.js";
import { parseModelSource } from "../sources.js";
import { forge } from "../forge/index.js";
import { ICONS } from "./icons.js";
import { appInstallUrl, inspectKicad, pickFolder, signInWithGitHub, withoutGitHubToken } from "./tauri.js";

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
    <p class="muted settings-hint">A URL prefix for KiCad library models, a GitHub repository (<code>owner/repo</code>, <code>owner/repo@branch:folder</code>) searched for models by file name, or a folder on this computer. A linked KiCad adds its own library and add-ons by itself.</p>
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
function accountMenu(face, head, items) {
  const item = ([icon, label, act, href]) =>
    href
      ? `<a role="menuitem" href="${escapeHtml(href)}">${ICONS[icon]}<span>${escapeHtml(label)}</span></a>`
      : `<button type="button" role="menuitem" data-act="${act}">${ICONS[icon]}<span>${escapeHtml(label)}</span></button>`;
  return `<details class="menu account-menu">
    <summary class="account-button" aria-label="Account menu" aria-haspopup="menu">${face}${ICONS.chevron}</summary>
    <div class="menu-panel" role="menu">
      <div class="menu-head">${head}</div><hr>
      ${items.map((group) => group.map(item).join("")).join("<hr>")}
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
    if (bad.length) toast(`Not a URL, GitHub repository or folder: ${bad[0]}`, true);
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

  async function signIn() {
    try {
      if (await signInWithGitHub()) onAccountChange();
    } catch (e) {
      toast(`GitHub sign-in failed: ${e.message ?? e}`, true);
    }
  }

  function signOut() {
    saveSettings(withoutGitHubToken());
    onAccountChange();
  }

  async function renderAccount() {
    const token = settings().token ?? null;
    const settingsItem = ["gear", "Settings", "settings"];
    const signInItem = ["signIn", "Sign in with GitHub", "signin"];
    if (!token) {
      el.innerHTML = accountMenu(
        `<span class="avatar avatar-blank">${ICONS.person}</span>`,
        `<div><strong>Not signed in</strong><span class="muted">Public repositories only</span></div>`,
        [[signInItem], [settingsItem]],
      );
    } else {
      let me = null, error = null;
      try {
        me = await forge().user(token);
      } catch (e) {
        error = e;
      }
      const access = me ? await appInstallUrl() : null;
      el.innerHTML = me
        ? accountMenu(
            `<img class="avatar" src="${escapeHtml(forge().avatar(me.avatar, 64))}" alt=""><span class="account-login">${escapeHtml(me.login)}</span>`,
            `<img class="avatar avatar-lg" src="${escapeHtml(forge().avatar(me.avatar, 80))}" alt=""><div><strong>${escapeHtml(me.login)}</strong>${me.name ? `<span class="muted">${escapeHtml(me.name)}</span>` : ""}</div>`,
            [[["person", "Your GitHub profile", null, me.url], ...(access ? [["key", "Repository access", null, access]] : []), settingsItem], [["signOut", "Sign out", "signout"]]],
          )
        : accountMenu(
            `<span class="tag warn">signed out</span>`,
            `<div><strong>GitHub ended the sign-in</strong><span class="muted">${escapeHtml(error.message)}</span></div>`,
            [[signInItem, settingsItem], [["signOut", "Sign out", "signout"]]],
          );
    }
    for (const b of el.querySelectorAll("[data-act]")) {
      b.addEventListener("click", () => {
        b.closest("details").open = false;
        if (b.dataset.act === "signin") signIn();
        if (b.dataset.act === "settings") openSettings();
        if (b.dataset.act === "signout") signOut();
      });
    }
  }

  window.addEventListener("kivi:signin", signIn);
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
