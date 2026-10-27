// Which files of a pull request count as KiCad changes, for the inbox badge:
// the same files the visual diff lists, so the two agree.

import { DIFFABLE, RULE_FILES, textBeforePatch } from "../sources.js";
import { diffRules } from "../diff/rules-diff.js";

/**
 * Schematics, boards and .kicad_dru files always count; a .kicad_pro only when
 * its design rules changed (KiCad rewrites it on almost every save). A file
 * that can't be checked counts, so a change is never hidden.
 * @param {object[]} files              entries of GET /repos/x/y/pulls/N/files
 * @param {(path: string, ref: string) => Promise<string>} readText  reads a file at a commit
 * @returns {Promise<object[]>} the files that count
 */
export async function kicadFilesChanged(files, readText) {
  const checks = files.map(async (f) => {
    if (DIFFABLE.test(f.filename) || DIFFABLE.test(f.previous_filename ?? "")) return true;
    if (!RULE_FILES.test(f.filename)) return false;
    if (/\.kicad_dru$/i.test(f.filename) || f.status !== "modified" && f.status !== "renamed" && f.status !== "changed") return true;
    const ref = /[?&]ref=([^&]+)/.exec(f.contents_url ?? "")?.[1];
    if (!f.patch || !ref) return true; // GitHub leaves out the patch of very large diffs
    try {
      const after = await readText(f.filename, ref);
      return diffRules(f.filename, textBeforePatch(after, f.patch), after).changes.length > 0;
    } catch (e) {
      console.warn(f.filename, e);
      return true;
    }
  });
  const flags = await Promise.all(checks);
  return files.filter((_, i) => flags[i]);
}
