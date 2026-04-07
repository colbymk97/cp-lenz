#!/usr/bin/env bash
# dev-install.sh — build, install, and launch a fresh VS Code window with RepoLens active

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Find the 'code' binary — prefer PATH, fall back to known macOS app locations
if command -v code &>/dev/null; then
  CODE=code
elif [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
  CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
elif [ -x "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
  CODE="$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
else
  echo "ERROR: Could not find the 'code' CLI."
  echo "Fix: Open VS Code → Command Palette → 'Shell Command: Install code command in PATH'"
  exit 1
fi

# Verify that Xcode Command Line Tools are properly registered.
# node-gyp needs them to compile better-sqlite3 against Electron headers.
if [[ "$(uname -s)" == "Darwin" ]]; then
  if ! pkgutil --pkg-info=com.apple.pkg.CLTools_Executables &>/dev/null; then
    echo ""
    echo "ERROR: Xcode Command Line Tools are not properly registered."
    echo "node-gyp requires them to compile native modules for VS Code's Electron."
    echo ""
    echo "Fix: run the following, then re-run this script:"
    echo "  xcode-select --install"
    echo ""
    echo "If CLT is already installed but unregistered, try:"
    echo "  sudo xcode-select --switch /Library/Developer/CommandLineTools"
    echo ""
    exit 1
  fi
fi

cd "$ROOT"

echo "==> Building..."
npm run build

# Detect VS Code's Electron version. better-sqlite3 is a V8 native module that must be
# compiled against Electron's headers (not Node's) to load in VS Code's extension host.
echo "==> Detecting VS Code Electron version..."
ELECTRON_VERSION=""
for vscode_pkg in \
  "/Applications/Visual Studio Code.app/Contents/Resources/app/package.json" \
  "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/package.json"; do
  if [[ -f "$vscode_pkg" ]]; then
    ELECTRON_VERSION=$(python3 -c "import json; print(json.load(open('$vscode_pkg'))['dependencies']['electron'])" 2>/dev/null || true)
    [[ -n "$ELECTRON_VERSION" ]] && break
  fi
done
# Fall back to the version shipped with VS Code 1.114 (update alongside engines.vscode bumps)
ELECTRON_VERSION="${ELECTRON_VERSION:-39.8.3}"
echo "==> Rebuilding native modules for Electron $ELECTRON_VERSION..."

REBUILD_ARCH="$(node -p "process.arch")"
# On Apple Silicon with x64 Node (Rosetta), explicitly target arm64 to match VS Code
if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" && "$REBUILD_ARCH" == "x64" ]]; then
  REBUILD_ARCH="arm64"
  # Ensure the arm64 sqlite-vec optional dependency is also installed
  npm install --no-save sqlite-vec-darwin-arm64 2>/dev/null || true
fi

npx --yes @electron/rebuild -v "$ELECTRON_VERSION" --arch "$REBUILD_ARCH"

echo "==> Packaging VSIX..."
npx vsce package --out repolens-dev.vsix

echo "==> Installing extension..."
"$CODE" --install-extension repolens-dev.vsix --force

echo "==> Opening new VS Code window..."
"$CODE" --new-window .

echo ""
echo "Done. To view logs:"
echo "  VS Code → View → Output → select 'RepoLens' from the dropdown"
echo "  Or set repoLens.log.level to 'debug' in settings for verbose output"
