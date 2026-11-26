#!/usr/bin/env python3
"""The tauri config overlay CI passes as `cargo tauri build --config "$(python3 tools/updater_config.py)"`
when the update signing key is set: it turns on the updater files and hands the
CLI the public key from $KIVI_UPDATER_PUBKEY (the config in the repository keeps
it empty; the app gets it at compile time from the same variable).
"""
import json
import os
import sys

pubkey = os.environ.get("KIVI_UPDATER_PUBKEY", "").strip()
if not pubkey:
    sys.exit("KIVI_UPDATER_PUBKEY isn't set")
print(json.dumps({"bundle": {"createUpdaterArtifacts": True}, "plugins": {"updater": {"pubkey": pubkey}}}))
