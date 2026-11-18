// The decisions behind in-app updates, with no DOM, Tauri or settings access so
// they run headless under gjs (tests/updates.js). src/desktop/updates.js does the
// rest (timers, requests, the dialog).

/** How often to look for a new release while the app runs (ms). */
export const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

/**
 * Is a new check due? Pages share the last successful check through
 * localStorage (`kivi.updateCheck` = {checkedAt, available}), so opening a page
 * doesn't repeat the request. A failed check is never stored, so it is due again.
 * @param {number} now  Date.now()
 * @param {{checkedAt?: number}|null|undefined} cache
 * @param {number} [intervalMs]
 */
export function shouldCheck(now, cache, intervalMs = CHECK_INTERVAL) {
  const at = cache?.checkedAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return true;
  if (at > now) return true; // clock went back: don't wait for it to catch up
  return now - at >= intervalMs;
}

/** Is semver-ish `a` newer than `b`? ("0.2.10" > "0.2.9"; a pre-release suffix is ignored.) */
export function isNewer(a, b) {
  const nums = (v) => String(v).replace(/^v/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/**
 * The update to show the user, or null: nothing available, switched off
 * (settings `checkUpdates === false`), skipped (`updateSkip` = that version) or,
 * when `current` is given, not newer than what is running (a cache from before the
 * app was updated).
 * @param {{available?: {version: string}|null}|null|undefined} cache
 * @param {{checkUpdates?: boolean, updateSkip?: string}} [settings]
 * @param {string} [current]  the running version
 */
export function visibleUpdate(cache, settings = {}, current) {
  const available = cache?.available;
  if (!available?.version) return null;
  if (settings.checkUpdates === false) return null;
  if (settings.updateSkip === available.version) return null;
  if (current && !isNewer(available.version, current)) return null;
  return available;
}

/** "12.3 of 45.6 MB" (the total is missing when the server doesn't say). */
export function progressText(downloaded, total) {
  const mb = (n) => (n / 1e6).toFixed(1);
  return total ? `${mb(downloaded)} of ${mb(total)} MB` : `${mb(downloaded)} MB`;
}
