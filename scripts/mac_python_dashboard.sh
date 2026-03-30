#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -x ".venv/bin/python" ]]; then
  echo "Python virtual environment not found."
  echo "Run ./scripts/mac_python_setup.sh first."
  exit 1
fi

source .venv/bin/activate
exec python cli.py dashboard --serve "$@"
