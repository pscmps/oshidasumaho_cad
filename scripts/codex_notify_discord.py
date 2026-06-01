#!/usr/bin/env python3
"""Send Codex task notifications to Discord via webhook."""

from __future__ import annotations

import argparse
import json
import os
import platform
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional


MAX_DETAILS_CHARS = 3200
MAX_FIELD_CHARS = 1024


STATUS_COLORS = {
    "success": 0x2ECC71,
    "failure": 0xE74C3C,
    "cancelled": 0xF1C40F,
    "info": 0x3498DB,
}


def run_git(args: list[str], cwd: Path) -> Optional[str]:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = result.stdout.strip()
    return value or None


def truncate(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    suffix = "\n... truncated ..."
    return value[: max(0, limit - len(suffix))].rstrip() + suffix


def read_details(args: argparse.Namespace) -> Optional[str]:
    parts: list[str] = []
    if args.details:
        parts.append(args.details)
    if args.details_file:
        try:
            parts.append(Path(args.details_file).read_text(encoding="utf-8", errors="replace"))
        except OSError as exc:
            parts.append(f"Could not read details file {args.details_file!r}: {exc}")
    if not parts:
        return None
    return truncate("\n\n".join(parts).strip(), MAX_DETAILS_CHARS)


def field(name: str, value: Optional[str], inline: bool = True) -> Optional[dict[str, object]]:
    if not value:
        return None
    return {"name": name, "value": truncate(value, MAX_FIELD_CHARS), "inline": inline}


def build_payload(args: argparse.Namespace, cwd: Path) -> dict[str, object]:
    project = args.project or cwd.name
    branch = run_git(["branch", "--show-current"], cwd)
    commit = run_git(["rev-parse", "--short", "HEAD"], cwd)
    repo_root = run_git(["rev-parse", "--show-toplevel"], cwd)
    details = read_details(args)

    fields = [
        field("Project", project),
        field("Status", args.status),
        field("Branch", branch),
        field("Commit", commit),
        field("Path", repo_root or str(cwd), inline=False),
        field("Host", socket.gethostname()),
        field("Platform", platform.platform()),
    ]

    if details:
        fields.append(field("Details", f"```text\n{details}\n```", inline=False))

    embed = {
        "title": f"Codex task {args.status}: {project}",
        "description": truncate(args.message, 2048),
        "color": STATUS_COLORS[args.status],
        "fields": [item for item in fields if item],
    }

    return {
        "username": args.username,
        "content": args.content,
        "embeds": [embed],
    }


def send_webhook(webhook_url: str, payload: dict[str, object], timeout: int) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        webhook_url,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": "codex-discord-notifier/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status >= 300:
                raise RuntimeError(f"Discord webhook returned HTTP {response.status}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Discord webhook returned HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach Discord webhook: {exc.reason}") from exc


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--status",
        choices=sorted(STATUS_COLORS),
        default="info",
        help="Notification status.",
    )
    parser.add_argument("--message", default="Codex task update", help="Main notification message.")
    parser.add_argument("--project", help="Project name. Defaults to current directory name.")
    parser.add_argument("--details", help="Additional details to include in the embed.")
    parser.add_argument("--details-file", help="Read additional details from a text file.")
    parser.add_argument(
        "--webhook-url-env",
        default="DISCORD_WEBHOOK_URL",
        help="Environment variable containing the Discord webhook URL.",
    )
    parser.add_argument("--username", default="Codex", help="Discord webhook display name.")
    parser.add_argument("--content", default="", help="Plain message content outside the embed.")
    parser.add_argument("--timeout", type=int, default=10, help="Webhook request timeout in seconds.")
    parser.add_argument("--dry-run", action="store_true", help="Print payload without sending.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    cwd = Path.cwd()
    payload = build_payload(args, cwd)

    if args.dry_run:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0

    webhook_url = os.environ.get(args.webhook_url_env)
    if not webhook_url:
        print(
            f"Missing Discord webhook URL. Set {args.webhook_url_env} or use --dry-run.",
            file=sys.stderr,
        )
        return 2

    try:
        send_webhook(webhook_url, payload, args.timeout)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print("Discord notification sent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

