#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PYTHON_BIN:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
  elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
  else
    echo "Python 3 was not found. Install Python 3 and re-run this script."
    exit 1
  fi
fi

if [[ ! -d ".venv" ]]; then
  echo "Creating virtual environment with $PYTHON_BIN..."
  "$PYTHON_BIN" -m venv .venv
fi

source .venv/bin/activate

echo "Upgrading pip..."
python -m pip install --upgrade pip

echo "Installing Python dependencies..."
python -m pip install -r requirements.txt

if [[ ! -f ".env" ]]; then
  cp .env.example .env
  echo "Created .env from .env.example. Fill in your local credentials before running extractors."
fi

cat <<'EOF'

macOS Python setup complete.

Next steps:
1. Edit .env and fill in your credentials.
2. If you plan to use the Python Meta extractor, install Google Chrome and ChromeDriver on macOS.
3. Start the dashboard with:
   ./scripts/mac_python_dashboard.sh

EOF
