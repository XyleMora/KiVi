// Desktop (Tauri) integration shared by the app pages. Without `window.__TAURI__`
// (the pages served to a headless test browser) `isDesktop` is false and nothing
// gets wired up.

import { settings, saveSettings, toast, tokenFor } from "../app/ui.js";
import { FORGES, forge } from "../forge/index.js";

const T = window.__TAURI__;
export const isDesktop = !!T;
export const invoke = (cmd, args) => T.core.invoke(cmd, args);
export const listen = (event, fn) => T.event.listen(event, fn);

// ---- local folders -------------------------------------------------------------

/**
 * A project folder on disk, read through the Rust side (no browser file picker,
 * no copying into memory, and it can be reloaded when KiCad saves).
 */
export class TauriSource {
  constructor(path, files) {
    this.kind = "local";
    this.path = path;
    this.files = files;
    this.label = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  }
  async list() {
    return this.files;
  }
  has(path) {
    return this.files.includes(path);
  }
  async readBinary(path) {
    return new Uint8Array(await invoke("read_file", { path }));
  }
  async readText(path) {
    return new TextDecoder().decode(await this.readBinary(path));
  }
  url() {
    return null; // 3D models are handed over as blobs
  }
}

/** Where `path` sits inside the git copy at `root`: "" at its top, else "hardware/" (repository path style). */
export function folderPrefix(path, root) {
  const trim = (p) => p.replace(/[\\/]+$/, "");
  const inside = trim(path).slice(trim(root).length + 1);
  return trim(path).startsWith(trim(root)) && inside ? `${inside.replace(/\\/g, "/")}/` : "";
}

/**
 * A project folder in a git copy as it was at a commit (the viewer's history
 * menu), read from git; file paths are relative to the folder, as in TauriSource.
 */
export class GitRevSource {
  constructor(path, rev, prefix, files) {
    this.kind = "local";
    this.path = path;
    this.rev = rev;
    this.prefix = prefix; // the folder inside the copy ("" or "hardware/")
    this.files = files;
    this.label = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  }
  /** The folder `path` at commit `rev`. */
  static async open(path, rev) {
    const { root } = await invoke("git_info", { path });
    const prefix = folderPrefix(path, root);
    const all = await invoke("git_list", { path, rev });
    return new GitRevSource(path, rev, prefix, all.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length)));
  }
  async list() {
    return this.files;
  }
  has(path) {
    return this.files.includes(path);
  }
  async readBinary(path) {
    return new Uint8Array(await invoke("git_read", { path: this.path, rev: this.rev, file: this.prefix + path }));
  }
  async readText(path) {
    return new TextDecoder().decode(await this.readBinary(path));
  }
  url() {
    return null;
  }
}

/**
 * A 3D model folder from Settings (e.g. KiCad's installed library), read
 * through the Rust side, which only hands out model files inside it.
 */
export class ModelDirSource {
  constructor(path) {
    this.kind = "model-dir";
    this.path = path;
    this.label = path;
    this.files = null;
  }
  list() {
    // Listed once: KiCad's library is thousands of files, and both the index
    // and the library-path lookup need the list.
    this.files ??= invoke("list_model_dir", { dir: this.path });
    return this.files;
  }
  async readBinary(path) {
    return new Uint8Array(await invoke("read_model_file", { dir: this.path, path }));
  }
  url() {
    return null; // handed over as blobs
  }
}

/** List `path` and start watching it; returns the source to open. */
export async function openFolder(path) {
  const files = await invoke("open_folder", { path });
  return new TauriSource(path, files);
}

/**
 * Files or folders dropped on the window. Tauri takes the drop itself and
 * reports file system paths (the page's own drop events get no files), so a
 * dropped folder opens like a picked one: from disk, with live reload.
 * `drop` gets the folder to open and, for a dropped KiCad file, its project.
 */
export function onDrop({ enter, leave, drop }) {
  listen("tauri://drag-enter", () => enter?.());
  listen("tauri://drag-leave", () => leave?.());
  listen("tauri://drag-drop", (e) => {
    leave?.();
    const path = e.payload?.paths?.[0];
    if (!path) return;
    const file = /\.kicad_(pro|sch|pcb)$/i.test(path);
    const name = path.split(/[\\/]/).pop();
    drop(file ? path.slice(0, path.length - name.length - 1) : path, file ? name.replace(/\.kicad_(sch|pcb)$/i, ".kicad_pro") : null);
  });
}

/**
 * Ask for a folder with the system's own chooser. On Linux that's the desktop
 * portal's (KDE: the Dolphin-style dialog), through picker.rs, since the dialog
 * plugin always shows GTK's; elsewhere, and if that fails, the dialog plugin.
 * @returns {Promise<string|null>} the folder, or null when cancelled
 */
export async function pickFolder(title = "Open KiCad project folder", defaultPath = undefined) {
  try {
    return await invoke("pick_folder", { title, defaultPath: defaultPath ?? null });
  } catch {
    return T.dialog.open({ directory: true, title, defaultPath });
  }
}

// ---- KiCad -----------------------------------------------------------------------

/** The KiCad linked in Settings: {program, version, vars} (lib.rs/kicad.rs), or null. */
export const linkedKicad = () => settings().kicad ?? null;

/** Check a KiCad program or installation folder; rejects with why it isn't one. */
export const inspectKicad = (path) => invoke("kicad_inspect", { path });

/** A project file inside a folder (`project` relative, with forward slashes). */
export const projectPath = (folder, project) => `${folder.replace(/[\\/]+$/, "")}/${project}`;

/**
 * Whether "Open in KiCad" can open `project` (a .kicad_pro path on this computer,
 * or null when the project isn't on it): {ok, title} for the button or menu item.
 */
export function kicadAction(project, notLocal = "Only for projects on this computer: open its folder, or Download or Link it from its card") {
  const k = linkedKicad();
  if (!k) return { ok: false, title: "Link KiCad in Settings first" };
  if (!project) return { ok: false, title: notLocal };
  if (!/\.kicad_pro$/i.test(project)) return { ok: false, title: "This project has no .kicad_pro file to open" };
  return { ok: true, title: `Open ${project.split(/[\\/]/).pop()} in KiCad ${k.version}` };
}

/** Open a project file (.kicad_pro) in the linked KiCad. */
export async function openInKicad(project) {
  const k = linkedKicad();
  if (!k) throw new Error("Link KiCad in Settings first");
  await invoke("kicad_open", { program: k.program, project });
  toast(`Opening ${project.split(/[\\/]/).pop()} in KiCad…`);
}

// ---- links ---------------------------------------------------------------------

/** Web links open in the system browser; the app's own pages stay in the window. */
export function routeExternalLinks() {
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target.closest?.("a[href]");
      if (!a) return;
      const url = new URL(a.getAttribute("href"), location.href);
      if (url.origin === location.origin) {
        if (a.target === "_blank") {
          e.preventDefault();
          location.href = url.href; // "Open in new tab" etc.: one window, so navigate
        }
        return;
      }
      if (/^https?:$/.test(url.protocol)) {
        e.preventDefault();
        T.opener.openUrl(url.href);
      }
    },
    true,
  );
}

// ---- forge sign-in ---------------------------------------------------------------
// OAuth device flow, the same steps on every forge; what differs (addresses,
// scopes, error codes, how to register an app) is the adapter's `auth`
// (src/forge/*.js). Tokens expire (GitHub: 8 h, GitLab: 2 h) and come with a
// single-use refresh token; each forge's account is settings.accounts[id] =
// {token, auth: {clientId, token, refreshToken, expires, refreshExpires}}.

let buildConfig = null;
/** Sign-in settings baked into this build, per forge id ({clientId, appSlug?}). */
function built(f) {
  buildConfig ??= (isDesktop ? invoke("forge_build_config") : Promise.resolve({})).catch(() => ({}));
  return buildConfig.then((c) => c?.[f.id] ?? {});
}

/** The OAuth app's client ID: built in, else the one the user entered. */
async function clientIdOf(f) {
  return (await built(f)).clientId ?? settings()[f.auth.clientIdKey] ?? "";
}

/** The GitHub App's install / repository access page, or null if its URL name isn't known. */
export async function appInstallUrl(f = forge()) {
  if (!f.auth.appSlugKey || !f.web.appInstall) return null;
  const slug = (await built(f)).appSlug ?? settings()[f.auth.appSlugKey];
  return slug ? f.web.appInstall(slug) : null;
}

const oauth = (url, form) => invoke("oauth_post", { url, form });
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** The account to save for a token reply. */
function account(res, clientId) {
  const now = Date.now();
  return {
    token: res.access_token,
    auth: {
      clientId,
      token: res.access_token, // the token the refresh token belongs to
      refreshToken: res.refresh_token ?? null,
      expires: res.expires_in ? now + res.expires_in * 1000 : null,
      refreshExpires: res.refresh_token_expires_in ? now + res.refresh_token_expires_in * 1000 : null,
    },
  };
}

/** Settings with one forge's account changed (null: signed out of it). */
function withAccount(s, id, acc) {
  const accounts = { ...(s.accounts ?? {}) };
  if (acc) accounts[id] = acc;
  else delete accounts[id];
  return { ...s, accounts };
}

/** Sign out of a forge. */
export function signOut(f) {
  saveSettings(withAccount(settings(), f.id, null));
}

// Access is only through signing in. A token that didn't come from it (pasted
// into Settings by earlier versions) is dropped, so the app is signed out.
if (isDesktop) {
  const s = settings();
  for (const [id, acc] of Object.entries(s.accounts ?? {})) if (acc?.token && acc.auth?.token !== acc.token) saveSettings(withAccount(settings(), id, null));
}

const refreshing = new Map(); // forge id → Promise<token>
const refreshTimers = new Map();
const MARGIN = 10 * 60 * 1000; // refresh this long before expiry

/**
 * Make sure a forge's signed-in token is valid for a while; refreshes it if
 * it's about to expire. Resolves with the current token (null signed out).
 * Safe to call often.
 * @param {import("../forge/index.js").Forge} [f]  the default forge if left out
 */
export function ensureFreshToken(f = forge()) {
  if (!isDesktop) return Promise.resolve(tokenFor(f));
  if (!refreshing.has(f.id)) {
    refreshing.set(
      f.id,
      refreshIfNeeded(f).finally(() => {
        refreshing.delete(f.id);
        scheduleRefresh(f);
      }),
    );
  }
  return refreshing.get(f.id);
}

/** Every signed-in forge's token, refreshed when needed (page load, window focus). */
export const ensureFreshTokens = () => Promise.all(FORGES.map((f) => ensureFreshToken(f)));

async function refreshIfNeeded(f) {
  const acc = settings().accounts?.[f.id];
  const auth = acc?.auth;
  if (!auth?.refreshToken || !auth.expires || auth.token !== acc.token) return acc?.token ?? null;
  if (Date.now() < auth.expires - MARGIN) return acc.token;
  const dropRefresh = () => saveSettings(withAccount(settings(), f.id, { ...acc, auth: { ...auth, refreshToken: null } }));
  if (auth.refreshExpires && Date.now() > auth.refreshExpires) {
    dropRefresh();
    return acc.token; // expired: the page shows "token rejected" and offers sign-in
  }
  try {
    const res = await oauth(f.auth.tokenUrl, { client_id: auth.clientId, refresh_token: auth.refreshToken, grant_type: "refresh_token" });
    if (res.access_token) {
      saveSettings(withAccount(settings(), f.id, account(res, auth.clientId)));
      return res.access_token;
    }
    if (f.auth.refreshRejected(res)) dropRefresh();
    console.warn(`${f.name} token refresh failed:`, res.error_description ?? res.error);
  } catch (e) {
    console.warn(`${f.name} token refresh failed:`, e); // offline: try again later
  }
  return tokenFor(f);
}

function scheduleRefresh(f) {
  clearTimeout(refreshTimers.get(f.id));
  const auth = settings().accounts?.[f.id]?.auth;
  if (!auth?.refreshToken || !auth.expires) return;
  const wait = Math.max(60_000, auth.expires - MARGIN - Date.now());
  refreshTimers.set(f.id, setTimeout(() => ensureFreshToken(f), Math.min(wait, 2 ** 31 - 1)));
}

if (isDesktop) {
  // Timers stall while the computer sleeps; check again when the window comes back.
  window.addEventListener("focus", () => ensureFreshTokens());
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && ensureFreshTokens());
}

const signinHtml = (f) => `
<form method="dialog" class="settings signin">
  <h2>Sign in to ${escapeHtml(f.name)}</h2>
  <div data-step="client" hidden>
    <p class="muted settings-hint">This build has no ${escapeHtml(f.auth.appName)} configured. Register one at
      <a href="${escapeHtml(f.auth.registerUrl)}">${escapeHtml(f.auth.registerUrl.replace(/^https:\/\//, ""))}</a> ${f.auth.registerHint},
      and paste its ${escapeHtml(f.auth.idLabel)} (or build with <code>${escapeHtml(f.auth.buildEnv)}</code> set).</p>
    <label class="field-label" for="signin-client">${escapeHtml(f.auth.appName)} ${escapeHtml(f.auth.idLabel)}</label>
    <input id="signin-client" class="input mono" spellcheck="false" placeholder="${escapeHtml(f.auth.idPlaceholder)}">
    ${
      f.auth.appSlugKey
        ? `<label class="field-label" for="signin-slug">App URL name (${escapeHtml(f.host)}/apps/<em>name</em>), optional</label>
    <input id="signin-slug" class="input mono" spellcheck="false" placeholder="kivi-desktop">`
        : ""
    }
  </div>
  <div data-step="code" hidden>
    <p>Enter this code on ${escapeHtml(f.name)}:</p>
    <div class="signin-code mono" id="signin-code"></div>
    <p class="muted settings-hint" id="signin-status">Waiting for you to approve KiVi on ${escapeHtml(f.host)}…</p>
  </div>
  <div data-step="install" hidden>
    <p>Signed in. Now choose which repositories KiVi may read:</p>
    <p class="muted settings-hint">The app isn't installed on your account or any of your organisations yet, so only
      public repositories are visible. Install it on ${escapeHtml(f.name)}, pick the repositories, then close this dialog.</p>
  </div>
  <div class="row end gap">
    <button value="cancel" class="btn">Cancel</button>
    <button type="button" id="signin-go" class="btn primary">Continue</button>
  </div>
</form>`;

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * Device flow: show a code, open the forge's device page, poll until approved,
 * then (GitHub) offer to install the App if it has no installations yet.
 * Resolves with the token (also saved in Settings), or null if cancelled.
 * @param {import("../forge/index.js").Forge} f
 */
export async function signInTo(f) {
  document.querySelector("#signin-dialog")?.remove(); // one per forge: rebuilt each time
  const dlg = document.createElement("dialog");
  dlg.id = "signin-dialog";
  dlg.innerHTML = signinHtml(f);
  document.body.appendChild(dlg);
  const step = (name) => {
    for (const el of dlg.querySelectorAll("[data-step]")) el.hidden = el.dataset.step !== name;
  };
  const go = dlg.querySelector("#signin-go");
  let clientId = await clientIdOf(f);
  let cancelled = false;
  dlg.addEventListener("close", () => (cancelled = true), { once: true });
  dlg.showModal();

  if (!clientId) {
    step("client");
    clientId = await new Promise((resolve) => {
      go.onclick = () => resolve(dlg.querySelector("#signin-client").value.trim());
      dlg.addEventListener("close", () => resolve(""), { once: true });
    });
    if (!clientId || cancelled) return null;
    const slug = dlg.querySelector("#signin-slug")?.value.trim().replace(/^.*\/apps\//, "").replace(/\/.*$/, "");
    saveSettings({ ...settings(), [f.auth.clientIdKey]: clientId, ...(slug && { [f.auth.appSlugKey]: slug }) });
  }

  try {
    const code = await oauth(f.auth.deviceUrl, { client_id: clientId, ...(f.auth.scope && { scope: f.auth.scope }) });
    if (code.error) {
      if (f.auth.unknownClient(code)) {
        // Wrong ID: forget it so the dialog asks again next time.
        const { [f.auth.clientIdKey]: _id, ...rest } = settings();
        if (f.auth.appSlugKey) delete rest[f.auth.appSlugKey];
        saveSettings(rest);
        throw new Error(`${f.name} doesn't know the ${f.auth.idLabel} "${clientId}"; check it and try again`);
      }
      throw new Error(f.auth.explain?.(code) ?? code.error_description ?? code.error);
    }
    step("code");
    dlg.querySelector("#signin-code").textContent = code.user_code;
    go.textContent = `Copy code and open ${f.name}`;
    go.onclick = () => {
      navigator.clipboard?.writeText(code.user_code).catch(() => {});
      T.opener.openUrl(code.verification_uri);
    };
    let interval = (code.interval ?? 5) * 1000;
    const deadline = Date.now() + (code.expires_in ?? 900) * 1000;
    while (!cancelled && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      if (cancelled) break;
      const res = await oauth(f.auth.tokenUrl, { client_id: clientId, device_code: code.device_code, grant_type: DEVICE_GRANT });
      if (res.access_token) {
        saveSettings(withAccount(settings(), f.id, account(res, clientId)));
        scheduleRefresh(f);
        toast(`Signed in to ${f.name}`);
        await offerInstall(f, dlg, step, go, res.access_token);
        if (dlg.open) dlg.close();
        return res.access_token;
      }
      if (res.error === "slow_down") interval += 5000;
      else if (res.error !== "authorization_pending") throw new Error(res.error_description ?? res.error);
    }
    if (!cancelled) throw new Error("The code expired; try again");
  } catch (e) {
    if (dlg.open) dlg.close();
    toast(`${f.name} sign-in failed: ${e.message ?? e}`, true);
  }
  return null;
}

/** GitHub: if the App isn't installed anywhere the user can see, point them at the install page. */
async function offerInstall(f, dlg, step, go, token) {
  if (!f.hasAppInstallation) return;
  const url = await appInstallUrl(f);
  if (!url || (await f.hasAppInstallation(token)) !== false) return; // installed, or the forge can't tell
  step("install");
  go.textContent = `Install on ${f.name}`;
  go.onclick = () => T.opener.openUrl(url);
  dlg.querySelector('button[value="cancel"]').textContent = "Done";
  await new Promise((resolve) => dlg.addEventListener("close", resolve, { once: true }));
}
