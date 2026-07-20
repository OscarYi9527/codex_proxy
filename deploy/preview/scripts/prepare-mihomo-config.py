#!/usr/bin/env python3
import os
import pathlib
import secrets
import stat
import sys
import urllib.request

import yaml


PREVIEW_DIR = pathlib.Path(__file__).resolve().parent.parent
URL_FILE = PREVIEW_DIR / "secrets" / "clash-subscription-url"
TARGET = PREVIEW_DIR / "state" / "mihomo" / "config.yaml"
CONTROLLER_SECRET = PREVIEW_DIR / "secrets" / "mihomo-controller-secret"


def require_private_file(path: pathlib.Path) -> None:
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise RuntimeError(f"{path} must not be readable by group or other users")


def main() -> None:
    if not URL_FILE.is_file():
        raise RuntimeError(
            "Create secrets/clash-subscription-url with mode 0600; do not pass the URL on the command line"
        )
    require_private_file(URL_FILE)
    subscription_url = URL_FILE.read_text(encoding="utf-8").strip()
    if not subscription_url.startswith("https://"):
        raise RuntimeError("The subscription URL must use HTTPS")

    request = urllib.request.Request(
        subscription_url,
        headers={"User-Agent": "AI-Editor-Preview/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = response.read(8 * 1024 * 1024 + 1)
    if len(payload) > 8 * 1024 * 1024:
        raise RuntimeError("The subscription response exceeds 8 MiB")
    config = yaml.safe_load(payload.decode("utf-8"))
    if not isinstance(config, dict) or not (
        isinstance(config.get("proxies"), list)
        or isinstance(config.get("proxy-providers"), dict)
    ):
        raise RuntimeError("The subscription did not return a Mihomo/Clash YAML configuration")

    if not CONTROLLER_SECRET.exists():
        CONTROLLER_SECRET.parent.mkdir(parents=True, exist_ok=True)
        CONTROLLER_SECRET.write_text(secrets.token_urlsafe(32), encoding="utf-8")
        os.chmod(CONTROLLER_SECRET, 0o600)
    require_private_file(CONTROLLER_SECRET)

    for unsafe_listener in (
        "port",
        "socks-port",
        "redir-port",
        "tproxy-port",
        "tun",
        "listeners",
    ):
        config.pop(unsafe_listener, None)
    config["mixed-port"] = 7890
    config["allow-lan"] = False
    config["bind-address"] = "127.0.0.1"
    config["external-controller"] = "127.0.0.1:9090"
    config["secret"] = CONTROLLER_SECRET.read_text(encoding="utf-8").strip()
    config["ipv6"] = False
    if isinstance(config.get("dns"), dict):
        config["dns"]["listen"] = "127.0.0.1:1053"

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    temporary = TARGET.with_suffix(".yaml.tmp")
    temporary.write_text(
        yaml.safe_dump(config, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    temporary.replace(TARGET)
    print(f"Prepared private Mihomo configuration at {TARGET}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"prepare-mihomo-config: {error}", file=sys.stderr)
        raise SystemExit(1)
