// Headless browser check (WebKitGTK via gjs): load the app, wait for a
// condition, optionally run a script, print console output, save a screenshot.
//
//   xvfb-run -a gjs -m tools/browser-check.js <url> <out.png> [--wait "<js expr>"] [--run "<js>"] [--delay ms] [--size 1440x900]

import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=3.0";
import WebKit2 from "gi://WebKit2?version=4.1";

const argv = ARGV.slice();
const opt = (name, def) => {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const waitExpr = opt("--wait", "true");
const runJs = opt("--run", "");
const delay = Number(opt("--delay", "500"));
const timeout = Number(opt("--timeout", "60000"));
const [W, H] = opt("--size", "1440x900").split("x").map(Number);
// Extra code for the loaded page: --prelude "js" (before its scripts)  --inject a.js,b.js  --inject-css x.css
const injectJs = opt("--inject", "");
const injectCss = opt("--inject-css", "");
const prelude = opt("--prelude", "");
const resultJs = opt("--result", ""); // evaluated after --delay (for async --run scripts)
const [url, out] = argv;

Gtk.init(null);
const win = new Gtk.OffscreenWindow();
win.set_default_size(W, H);
const settings = new WebKit2.Settings({
  enable_developer_extras: true,
  enable_write_console_messages_to_stdout: true,
  enable_webgl: true,
  allow_file_access_from_file_urls: true,
});
const ucm = new WebKit2.UserContentManager();
const readFile = (p) => new TextDecoder().decode(GLib.file_get_contents(p)[1]);
// The prelude runs before the page's own scripts (e.g. to define window.__TAURI__), injected files after the DOM is ready.
if (prelude) ucm.add_script(new WebKit2.UserScript(prelude, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, null, null));
const sources = injectJs.split(",").filter(Boolean).map(readFile).join("\n;\n");
if (sources) ucm.add_script(new WebKit2.UserScript(sources, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.END, null, null));
for (const css of injectCss.split(",").filter(Boolean)) ucm.add_style_sheet(new WebKit2.UserStyleSheet(readFile(css), WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserStyleLevel.USER, null, null));
const view = new WebKit2.WebView({ settings, user_content_manager: ucm });
view.set_size_request(W, H);
win.add(view);
win.show_all();

const loop = new GLib.MainLoop(null, false);
let done = false;
const finish = (code) => {
  if (done) return;
  done = true;
  loop.quit();
  imports.system.exit(code);
};

function evalJs(js) {
  return new Promise((resolve, reject) => {
    view.evaluate_javascript(js, -1, null, null, null, (v, res) => {
      try {
        const r = v.evaluate_javascript_finish(res);
        resolve(r.is_string() ? r.to_string() : r.is_boolean() ? r.to_boolean() : r.is_number() ? r.to_double() : r.to_string());
      } catch (e) {
        reject(e);
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => (r(), GLib.SOURCE_REMOVE)));

async function main() {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let ok = false;
    try {
      ok = await evalJs(`!!(${waitExpr})`);
    } catch (e) {
      /* page not ready */
    }
    if (ok) break;
    await sleep(250);
  }
  if (runJs) {
    try {
      const r = await evalJs(runJs);
      print(`run: ${r}`);
    } catch (e) {
      print(`run failed: ${e.message}`);
    }
  }
  await sleep(delay);
  if (resultJs) {
    try {
      print(`result: ${await evalJs(resultJs)}`);
    } catch (e) {
      print(`result failed: ${e.message}`);
    }
  }
  const info = await evalJs(`JSON.stringify({ toast: document.querySelector('#toast')?.hidden ? null : document.querySelector('#toast')?.textContent, title: document.title })`).catch(() => "{}");
  print(`state: ${info}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, null, (v, res) => {
    try {
      const surface = v.get_snapshot_finish(res);
      surface.writeToPNG(out);
      print(`saved ${out}`);
      finish(0);
    } catch (e) {
      print(`snapshot failed: ${e.message}`);
      finish(1);
    }
  });
}

let started = false;
const start = () => {
  if (started) return;
  started = true;
  main().catch((e) => (print(e), finish(1)));
};
view.connect("load-changed", (v, ev) => {
  if (ev === WebKit2.LoadEvent.FINISHED) start();
  // Heavy pages may keep loading subresources; the DOM is usable once committed.
  if (ev === WebKit2.LoadEvent.COMMITTED) GLib.timeout_add(GLib.PRIORITY_DEFAULT, 8000, () => (start(), GLib.SOURCE_REMOVE));
});
view.connect("load-failed", (v, ev, uri, err) => {
  print(`load failed: ${err.message}`);
  finish(1);
  return true;
});
GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout + 30000, () => (print("timeout"), finish(2), GLib.SOURCE_REMOVE));
view.load_uri(url);
loop.run();
