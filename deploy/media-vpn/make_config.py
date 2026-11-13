"""Derive a private media-only Xray config from an existing operator-managed VPN outbound."""

import argparse
import copy
import json
import os
from pathlib import Path

DOMAINS = (
    "youtube.com", "youtu.be", "googlevideo.com", "youtube-nocookie.com", "ytimg.com", "ggpht.com",
    "soundcloud.com", "sndcdn.com", "soundcloud.cloud", "gstatic.com", "googleusercontent.com",
    "youtubei.googleapis.com", "jnn-pa.googleapis.com", "www.google.com",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = json.loads(args.source.read_text())
    matches = [x for x in source.get("outbounds", []) if x.get("tag") == "vpn"]
    if len(matches) != 1 or matches[0].get("protocol") != "hysteria":
        raise SystemExit("Expected one existing Hysteria outbound tagged vpn")
    config = {
        "log": {"loglevel": "warning", "access": "none"},
        "inbounds": [{"tag": "media-http", "listen": "0.0.0.0", "port": 19810, "protocol": "http"}],
        "outbounds": [{"tag": "block", "protocol": "blackhole"}, copy.deepcopy(matches[0])],
        "routing": {"domainStrategy": "AsIs", "rules": [{
            "type": "field", "inboundTag": ["media-http"], "domain": ["domain:" + d for d in DOMAINS],
            "port": "80,443", "outboundTag": "vpn",
        }]},
    }
    # Never overwrite the source or an existing destination; never print VPN settings or credentials.
    os.umask(0o077)
    with args.output.open("x", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    args.output.chmod(0o600)


if __name__ == "__main__":
    main()
