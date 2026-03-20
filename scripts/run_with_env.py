#!/usr/bin/env python3
"""Run a command after loading KEY=VALUE pairs from project .env.

This intentionally follows a dotenv-like parser instead of shell `source`, so
cron jobs and the Node runtime consume the same `.env` file with closer
semantics.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def load_env_file(env_path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not env_path.exists():
        return values

    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue

        if value and value[0] in ('"', "'") and value[-1] == value[0]:
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()

        values[key] = value

    return values


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: run_with_env.py <project_dir> <command> [args...]", file=sys.stderr)
        return 2

    project_dir = Path(sys.argv[1]).resolve()
    command = sys.argv[2:]

    env = os.environ.copy()
    env.update(load_env_file(project_dir / ".env"))

    completed = subprocess.run(command, cwd=project_dir, env=env)
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
