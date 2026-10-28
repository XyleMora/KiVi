// Desktop (Tauri) integration shared by the app pages. Without `window.__TAURI__`
// (the pages served to a headless test browser) `isDesktop` is false and nothing
// gets wired up.

import { settings, saveSettings, toast } from "../app/ui.js";

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

export async function pickFolder(title = "Open KiCad project folder", defaultPath = undefined) {
  return T.dialog.open({ directory: true, title, defaultPath });
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

// ---- GitHub sign-in --------------------------------------------------------------
// A GitHub App with device flow. Its user tokens (ghu_…) expire after 8 hours and
// come with a single-use refresh token (ghr_…, 6 months), kept next to the token
// in Settings as `githubAuth`. They only reach repositories the App is installed on.

const SIGNIN_HTML = `
<form method="dialog" class="settings signin">
  <h2>Sign in with GitHub</h2>
  <div data-step="client" hidden>
    <p class="muted settings-hint">This build has no GitHub App configured. Register one at
      <a href="https://github.com/settings/apps/new">github.com/settings/apps/new</a> with <em>Enable Device Flow</em>
      ticked, and paste its Client ID (or build with <code>KIVI_GITHUB_CLIENT_ID</code> set).</p>
    <label class="field-label" for="signin-client">GitHub App Client ID</label>
    <input id="signin-client" class="input mono" spellcheck="false" placeholder="Iv23li…">
    <label class="field-label" for="signin-slug">App URL name (github.com/apps/<em>name</em>), optional</label>
    <input id="signin-slug" class="input mono" spellcheck="false" placeholder="kivi-desktop">
  </div>
  <div data-step="code" hidden>
    <p>Enter this code on GitHub:</p>
    <div class="signin-code mono" id="signin-code"></div>
    <p class="muted settings-hint" id="signin-status">Waiting for you to approve KiVi on github.com…</p>
  </div>
  <div data-step="install" hidden>
    <p>Signed in. Now choose which repositories KiVi may read:</p>
    <p class="muted settings-hint">The app isn't installed on your account or any of your organisations yet, so only
      public repositories are visible. Install it on GitHub, pick the repositories, then close this dialog.</p>
  </div>
  <div class="row end gap">
    <button value="cancel" class="btn">Cancel</button>
    <button type="button" id="signin-go" class="btn primary">Continue</button>
  </div>
</form>`;

/** Install / repository-access page of the App, or null if its URL name isn't known. */
export async function appInstallUrl() {
  const slug = (await invoke("github_app_slug")) ?? settings().githubAppSlug;
  return slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : null;
}

/** Settings fields for a token response from GitHub. */
function authFields(res, clientId) {
  const now = Date.now();
  return {
    token: res.access_token,
    githubAuth: {
      clientId,
      token: res.access_token, // the token the refresh token belongs to
      refreshToken: res.refresh_token ?? null,
      expires: res.expires_in ? now + res.expires_in * 1000 : null,
      refreshExpires: res.refresh_token_expires_in ? now + res.refresh_token_expires_in * 1000 : null,
    },
  };
}

/** Settings without the GitHub token (sign out). */
export function withoutGitHubToken(s = settings()) {
  const { token, githubAuth, ...rest } = s;
  return rest;
}

// GitHub access is only through the App sign-in. A token that didn't come from it
// (pasted into Settings by earlier versions) is dropped, so the app is signed out.
if (isDesktop) {
  const s = settings();
  if (s.token && s.githubAuth?.token !== s.token) saveSettings(withoutGitHubToken(s));
}

let refreshing = null;
let refreshTimer = 0;
const MARGIN = 10 * 60 * 1000; // refresh this long before expiry

/**
 * Make sure the signed-in token is valid for a while; refreshes it if it's about
 * to expire. Resolves with the current token. Safe to call often.
 */
export function ensureFreshToken() {
  if (!isDesktop) return Promise.resolve(settings().token ?? null);
  return (refreshing ??= refreshIfNeeded().finally(() => {
    refreshing = null;
    scheduleRefresh();
  }));
}

async function refreshIfNeeded() {
  const s = settings();
  const auth = s.githubAuth;
  if (!auth?.refreshToken || !auth.expires || auth.token !== s.token) return s.token ?? null;
  if (Date.now() < auth.expires - MARGIN) return s.token;
  if (auth.refreshExpires && Date.now() > auth.refreshExpires) {
    saveSettings({ ...s, githubAuth: { ...auth, refreshToken: null } });
    return s.token; // expired: the page shows "token rejected" and offers sign-in
  }
  try {
    const res = await invoke("github_device_refresh", { clientId: auth.clientId, refreshToken: auth.refreshToken });
    if (res.access_token) {
      saveSettings({ ...settings(), ...authFields(res, auth.clientId) });
      return res.access_token;
    }
    if (res.error === "bad_refresh_token") saveSettings({ ...settings(), githubAuth: { ...auth, refreshToken: null } });
    console.warn("GitHub token refresh failed:", res.error_description ?? res.error);
  } catch (e) {
    console.warn("GitHub token refresh failed:", e); // offline: try again later
  }
  return settings().token ?? null;
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  const auth = settings().githubAuth;
  if (!auth?.refreshToken || !auth.expires) return;
  const wait = Math.max(60_000, auth.expires - MARGIN - Date.now());
  refreshTimer = setTimeout(ensureFreshToken, Math.min(wait, 2 ** 31 - 1));
}

if (isDesktop) {
  // Timers stall while the computer sleeps; check again when the window comes back.
  window.addEventListener("focus", () => ensureFreshToken());
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && ensureFreshToken());
}

/**
 * Device flow: show a code, open github.com/login/device, poll until approved,
 * then offer to install the App if it has no installations yet.
 * Resolves with the token (also saved in Settings), or null if cancelled.
 */
export async function signInWithGitHub() {
  let dlg = document.querySelector("#signin-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "signin-dialog";
    dlg.innerHTML = SIGNIN_HTML;
    document.body.appendChild(dlg);
  }
  const step = (name) => {
    for (const el of dlg.querySelectorAll("[data-step]")) el.hidden = el.dataset.step !== name;
  };
  const go = dlg.querySelector("#signin-go");
  go.textContent = "Continue";
  let clientId = (await invoke("github_client_id")) ?? settings().githubAppClientId ?? "";
  let cancelled = false;
  dlg.addEventListener("close", () => (cancelled = true), { once: true });
  dlg.showModal();

  if (!clientId) {
    step("client");
    go.hidden = false;
    clientId = await new Promise((resolve) => {
      go.onclick = () => resolve(dlg.querySelector("#signin-client").value.trim());
      dlg.addEventListener("close", () => resolve(""), { once: true });
    });
    if (!clientId || cancelled) return null;
    const slug = dlg.querySelector("#signin-slug").value.trim().replace(/^.*\/apps\//, "").replace(/\/.*$/, "");
    saveSettings({ ...settings(), githubAppClientId: clientId, ...(slug && { githubAppSlug: slug }) });
  }

  try {
    const code = await invoke("github_device_start", { clientId });
    if (code.error === "Not Found") {
      // Wrong ID: forget it so the dialog asks again next time.
      const { githubAppClientId, githubAppSlug, ...rest } = settings();
      saveSettings(rest);
      throw new Error(`GitHub doesn't know the Client ID "${clientId}"; check it and try again`);
    }
    if (code.error === "device_flow_disabled") throw new Error("tick “Enable Device Flow” in the GitHub App's settings, then try again");
    if (code.error) throw new Error(code.error_description ?? code.error);
    step("code");
    dlg.querySelector("#signin-code").textContent = code.user_code;
    go.textContent = "Copy code and open GitHub";
    go.hidden = false;
    go.onclick = () => {
      navigator.clipboard?.writeText(code.user_code).catch(() => {});
      T.opener.openUrl(code.verification_uri);
    };
    let interval = (code.interval ?? 5) * 1000;
    const deadline = Date.now() + (code.expires_in ?? 900) * 1000;
    while (!cancelled && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      if (cancelled) break;
      const res = await invoke("github_device_poll", { clientId, deviceCode: code.device_code });
      if (res.access_token) {
        saveSettings({ ...settings(), ...authFields(res, clientId) });
        scheduleRefresh();
        toast("Signed in to GitHub");
        await offerInstall(dlg, step, go, res.access_token);
        if (dlg.open) dlg.close();
        return res.access_token;
      }
      if (res.error === "slow_down") interval += 5000;
      else if (res.error !== "authorization_pending") throw new Error(res.error_description ?? res.error);
    }
    if (!cancelled) throw new Error("The code expired; try again");
  } catch (e) {
    if (dlg.open) dlg.close();
    toast(`GitHub sign-in failed: ${e.message ?? e}`, true);
  }
  return null;
}

/** If the App isn't installed anywhere the user can see, point them at the install page. */
async function offerInstall(dlg, step, go, token) {
  const url = await appInstallUrl();
  if (!url) return;
  try {
    const r = await fetch("https://api.github.com/user/installations?per_page=1", {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
    });
    if (!r.ok || (await r.json()).total_count > 0) return;
  } catch {
    return;
  }
  step("install");
  go.textContent = "Install on GitHub";
  go.onclick = () => T.opener.openUrl(url);
  dlg.querySelector('button[value="cancel"]').textContent = "Done";
  await new Promise((resolve) => dlg.addEventListener("close", resolve, { once: true }));
  dlg.querySelector('button[value="cancel"]').textContent = "Cancel";
}
