"""python3 -m unittest tests/test_update_manifest.py"""
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import update_manifest as um  # noqa: E402

NOW = datetime(2026, 11, 16, 12, 30, 5, tzinfo=timezone.utc)


def bundle(root: Path, v="0.3.0", sign=("linux-x86_64", "darwin-aarch64", "windows-x86_64"), skip=()):
    """A downloaded-artifacts folder like the release job's: one folder per build."""
    layout = {
        "linux-x86_64": ("kivi-linux", f"KiVi_{v}_amd64.AppImage"),
        "darwin-aarch64": ("kivi-macos", f"KiVi_{v}_universal.app.tar.gz"),
        "windows-x86_64": ("kivi-windows", f"KiVi_{v}_x64.exe"),
    }
    for platform, (folder, name) in layout.items():
        if platform in skip:
            continue
        (root / folder).mkdir(parents=True, exist_ok=True)
        (root / folder / name).write_bytes(b"file")
        if platform in sign:
            (root / folder / (name + ".sig")).write_text(f"SIG-{platform}\n")
    (root / "kivi-macos" / f"KiVi_{v}_universal.dmg").parent.mkdir(exist_ok=True)
    (root / "kivi-macos" / f"KiVi_{v}_universal.dmg").write_bytes(b"dmg")


class Manifest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_complete_feed(self):
        bundle(self.root)
        feed = um.build(self.root, "v0.3.0", "XyleMora/KiVi", NOW)
        base = "https://github.com/XyleMora/KiVi/releases/download/v0.3.0"
        self.assertEqual(feed["version"], "0.3.0")
        self.assertEqual(feed["pub_date"], "2026-11-16T12:30:05Z")
        self.assertEqual(feed["notes"], "")
        self.assertEqual(
            feed["platforms"],
            {
                "linux-x86_64": {"url": f"{base}/KiVi_0.3.0_amd64.AppImage", "signature": "SIG-linux-x86_64"},
                "darwin-aarch64": {"url": f"{base}/KiVi_0.3.0_universal.app.tar.gz", "signature": "SIG-darwin-aarch64"},
                "darwin-x86_64": {"url": f"{base}/KiVi_0.3.0_universal.app.tar.gz", "signature": "SIG-darwin-aarch64"},
                "windows-x86_64": {"url": f"{base}/KiVi_0.3.0_x64.exe", "signature": "SIG-windows-x86_64"},
            },
        )

    def test_repository_and_tag_without_v(self):
        bundle(self.root)
        feed = um.build(self.root, "0.3.0", "budenga/KiVi", NOW)
        self.assertTrue(feed["platforms"]["windows-x86_64"]["url"].startswith("https://github.com/budenga/KiVi/releases/download/v0.3.0/"))

    def test_no_signatures_writes_nothing(self):
        bundle(self.root, sign=())
        self.assertIsNone(um.build(self.root, "v0.3.0", "XyleMora/KiVi", NOW))
        self.assertEqual(um.main(["x", str(self.root), "v0.3.0", "XyleMora/KiVi"]), 0)
        self.assertFalse((self.root / "updater").exists())

    def test_partial_signatures_fail(self):
        bundle(self.root, sign=("linux-x86_64", "windows-x86_64"))
        with self.assertRaisesRegex(ValueError, r"universal\.app\.tar\.gz\.sig is missing"):
            um.build(self.root, "v0.3.0", "XyleMora/KiVi", NOW)
        self.assertEqual(um.main(["x", str(self.root), "v0.3.0", "XyleMora/KiVi"]), 1)
        self.assertFalse((self.root / "updater").exists())

    def test_missing_platform_fails(self):
        bundle(self.root, skip=("windows-x86_64",))
        with self.assertRaisesRegex(ValueError, "x64.exe is missing"):
            um.build(self.root, "v0.3.0", "XyleMora/KiVi", NOW)

    def test_signature_of_another_version_does_not_count(self):
        bundle(self.root, v="0.2.0")
        with self.assertRaises(ValueError):
            um.build(self.root, "v0.3.0", "XyleMora/KiVi", NOW)

    def test_empty_signature_fails(self):
        bundle(self.root)
        (self.root / "kivi-windows" / "KiVi_0.3.0_x64.exe.sig").write_text("\n")
        with self.assertRaisesRegex(ValueError, "empty"):
            um.build(self.root, "v0.3.0", "XyleMora/KiVi", NOW)

    def test_bad_tag(self):
        with self.assertRaises(ValueError):
            um.build(self.root, "latest", "XyleMora/KiVi", NOW)

    def test_main_writes_latest_json(self):
        bundle(self.root)
        self.assertEqual(um.main(["x", str(self.root), "v0.3.0", "XyleMora/KiVi"]), 0)
        feed = json.loads((self.root / "updater" / "latest.json").read_text())
        self.assertEqual(sorted(feed["platforms"]), ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"])

    def test_usage(self):
        self.assertEqual(um.main(["x"]), 2)


if __name__ == "__main__":
    unittest.main()
