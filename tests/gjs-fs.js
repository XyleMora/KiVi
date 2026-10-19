// Minimal file helpers for running tests/tools under gjs (no Node needed).
import GLib from "gi://GLib";
import Gio from "gi://Gio";

const decoder = new TextDecoder("utf-8");

export function readText(path) {
  const [ok, bytes] = GLib.file_get_contents(path);
  if (!ok) throw new Error(`cannot read ${path}`);
  return decoder.decode(bytes);
}

export function readBytes(path) {
  const [, bytes] = GLib.file_get_contents(path);
  return bytes;
}

export function writeText(path, text) {
  GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
  GLib.file_set_contents(path, text);
}

export function exists(path) {
  return GLib.file_test(path, GLib.FileTest.EXISTS);
}

export function listDir(path) {
  const dir = Gio.File.new_for_path(path);
  const en = dir.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null);
  const out = [];
  let info;
  while ((info = en.next_file(null))) out.push({ name: info.get_name(), dir: info.get_file_type() === Gio.FileType.DIRECTORY });
  return out;
}

export function args() {
  return ARGV;
}

/**
 * KiCad's demo projects, downloaded from the KiCad repository into
 * tests/kicad-demos by `python3 tools/fetch_demos.py` (git-ignored; no KiCad
 * installation needed). Exits with a hint when they haven't been fetched.
 */
export function kicadDemos(sub = "") {
  const dir = GLib.build_filenamev([GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), "kicad-demos"]);
  if (!exists(`${dir}/VERSION`)) {
    printerr("KiCad demo projects not found: run  python3 tools/fetch_demos.py  first");
    imports.system.exit(2);
  }
  return sub ? `${dir}/${sub}` : dir;
}
