#!/usr/bin/env bash
# build.sh — Render build script
# Installs Python dependencies + Playwright Chromium browser binary

set -e

echo "==> Installing archive extraction support (7-Zip for RAR5)..."
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y 7zip || apt-get install -y p7zip-full
fi

echo "==> Installing Python dependencies..."
pip install -r backend/requirements.txt

echo "==> Installing Playwright browser binary..."
playwright install chromium

echo "==> Build complete."
