// Stand-in for the Tauri API so the desktop pages run in a plain headless
// WebKit: pass it to tools/browser-check.js as --prelude "$(cat tests/tauri-mock.js)".
// Commands answer from window.__tauriReplies (set it in the prelude too), else null;
// __tauriEmit(event, payload) fires an event, e.g. "tauri://drag-drop" with {paths: [...]}.
window.__tauriCalls = [];
window.__tauriListeners = {};
window.__tauriEmit = (event, payload) => (window.__tauriListeners[event] ?? []).forEach((fn) => fn({ event, payload }));
window.__TAURI__ = {
  core: {
    invoke: async (cmd, args) => {
      window.__tauriCalls.push([cmd, args]);
      const r = window.__tauriReplies?.[cmd];
      return typeof r === "function" ? r(args) : (r ?? null);
    },
  },
  event: {
    listen: async (event, fn) => {
      (window.__tauriListeners[event] ??= []).push(fn);
      return () => {};
    },
  },
  opener: { openUrl: (url) => window.__tauriCalls.push(["openUrl", url]) },
  dialog: { open: async () => null },
};
