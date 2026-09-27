#!/usr/bin/env bash
# build.sh — Render build script
# Installs Python dependencies + Playwright Chromium browser binary

set -e

echo "==> Installing archive extraction support (7-Zip for RAR5)..."
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y 7zip || apt-get install -y p7zip-full || true
fi

echo "==> Installing Python dependencies..."
pip install -r backend/requirements.txt
# Also install the root requirements file when a Render service or local
# deployment overrides the normal build command and uses the repository root.
if [ -f requirements.txt ]; then
  pip install -r requirements.txt
fi

echo "==> Installing Playwright browser binary..."
playwright install chromium

echo "==> Build complete."
