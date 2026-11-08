// Which files of a pull request count as KiCad changes, for the inbox badge:
// the same files the visual diff lists, so the two agree.

import { DIFFABLE, RULE_FILES } from "../project.js";
import { textBeforePatch } from "../sources.js";
import { diffRules } from "../diff/rules-diff.js";

/**
 * Schematics, boards and .kicad_dru files always count; a .kicad_pro only when
 * its design rules changed (KiCad rewrites it on almost every save). A file
 * that can't be checked counts, so a change is never hidden.
 * @param {import("../forge/index.js").ChangedFile[]} files  a pull request's files (forge.pullFiles)
 * @param {(path: string, ref: string) => Promise<string>} readText  reads a file at a commit
 * @returns {Promise<object[]>} the files that count
 */
export async function kicadFilesChanged(files, readText) {
  const checks = files.map(async (f) => {
    if (DIFFABLE.test(f.path) || DIFFABLE.test(f.previous ?? "")) return true;
    if (!RULE_FILES.test(f.path)) return false;
    if (/\.kicad_dru$/i.test(f.path) || f.status !== "modified" && f.status !== "renamed" && f.status !== "changed") return true;
    if (!f.patch || !f.ref) return true; // forges leave out the patch of very large diffs
    try {
      const after = await readText(f.path, f.ref);
      return diffRules(f.path, textBeforePatch(after, f.patch), after).changes.length > 0;
    } catch (e) {
      console.warn(f.path, e);
      return true;
    }
  });
  const flags = await Promise.all(checks);
  return files.filter((_, i) => flags[i]);
}
