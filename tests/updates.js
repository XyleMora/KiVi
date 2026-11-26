// In-app update decisions (gjs, no network): when a check is due, and which
// update the header may show.
//   gjs -m tests/updates.js

import { CHECK_INTERVAL, isNewer, progressText, shouldCheck, visibleUpdate } from "../src/desktop/update-check.js";

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  print(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`);
};

const H = 3600 * 1000;
const now = 1_800_000_000_000;

// shouldCheck: due with no result, after the interval, never inside it.
check("no cache: check", shouldCheck(now, null), true);
check("empty cache: check", shouldCheck(now, {}), true);
check("garbage checkedAt: check", shouldCheck(now, { checkedAt: "yesterday" }), true);
check("NaN checkedAt: check", shouldCheck(now, { checkedAt: NaN }), true);
check("just checked: wait", shouldCheck(now, { checkedAt: now - 1000 }), false);
check("5 h 59 min ago: wait", shouldCheck(now, { checkedAt: now - 6 * H + 60_000 }), false);
check("exactly 6 h ago: check", shouldCheck(now, { checkedAt: now - 6 * H }), true);
check("a day ago: check", shouldCheck(now, { checkedAt: now - 24 * H }), true);
check("checked in the future (clock changed): check", shouldCheck(now, { checkedAt: now + H }), true);
check("custom interval", shouldCheck(now, { checkedAt: now - 2 * H }, H), true);
check("default interval is 6 h", CHECK_INTERVAL, 6 * H);

// isNewer: numeric, not textual.
check("0.2.10 > 0.2.9", isNewer("0.2.10", "0.2.9"), true);
check("0.2.9 > 0.2.10 is false", isNewer("0.2.9", "0.2.10"), false);
check("equal", isNewer("1.0.0", "1.0.0"), false);
check("v prefix and missing patch", isNewer("v1.1", "1.0.5"), true);
check("pre-release suffix ignored", isNewer("0.3.0-rc1", "0.2.9"), true);

// visibleUpdate
const up = { version: "0.3.0", date: "2026-11-16", url: "https://github.com/XyleMora/KiVi/releases/tag/v0.3.0" };
const cache = { checkedAt: now, available: up };
check("available: shown", visibleUpdate(cache, {}), up);
check("no settings given: shown", visibleUpdate(cache), up);
check("nothing available", visibleUpdate({ checkedAt: now, available: null }, {}), null);
check("no cache", visibleUpdate(null, {}), null);
check("available without a version", visibleUpdate({ available: {} }, {}), null);
check("switched off", visibleUpdate(cache, { checkUpdates: false }), null);
check("switched on explicitly", visibleUpdate(cache, { checkUpdates: true }), up);
check("this version skipped", visibleUpdate(cache, { updateSkip: "0.3.0" }), null);
check("an older version skipped: a later one shows", visibleUpdate(cache, { updateSkip: "0.2.9" }), up);
check("stale cache after updating to it", visibleUpdate(cache, {}, "0.3.0"), null);
check("stale cache after updating past it", visibleUpdate(cache, {}, "0.3.1"), null);
check("running older: shown", visibleUpdate(cache, {}, "0.2.90"), up);

check("progress with total", progressText(12_345_678, 45_600_000), "12.3 of 45.6 MB");
check("progress without total", progressText(2_000_000, null), "2.0 MB");

if (failures) {
  print(`${failures} failed`);
  imports.system.exit(1);
}
print("all passed");
