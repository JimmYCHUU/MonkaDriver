#!/bin/sh
# Extract the vendor's renderer (UI) assets from the official Windows installer.
# These files are Monka's / Rongyuan's property and are not part of this
# repository; the app loads them from the project root at runtime.
#
#   scripts/extract-vendor.sh ~/Downloads/A75.exe        (or the .zip that contains it)
#
# Produces: dist/  company/  CurrentCompany.json  iot_driver.exe (empty placeholder)
set -eu
SRC="${1:-}"
[ -n "$SRC" ] && [ -f "$SRC" ] || { echo "usage: $0 <A75.exe | Monka driver .zip>" >&2; exit 1; }
command -v 7z >/dev/null || { echo "7z is required (sudo dnf install p7zip p7zip-plugins)" >&2; exit 1; }
cd "$(dirname "$0")/.."
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

case "$SRC" in
  *.zip) 7z x -y -o"$WORK/zip" "$SRC" >/dev/null; EXE="$(find "$WORK/zip" -iname '*.exe' | head -1)" ;;
  *) EXE="$SRC" ;;
esac
[ -f "$EXE" ] || { echo "no installer .exe found in $SRC" >&2; exit 1; }

# NSIS installer -> $PLUGINSDIR/app-32.7z -> resources/app/
7z x -y -o"$WORK/nsis" "$EXE" '$PLUGINSDIR/app-32.7z' >/dev/null
7z x -y -o"$WORK/app" "$WORK/nsis/\$PLUGINSDIR/app-32.7z" 'resources/app/dist' 'resources/app/company' 'resources/app/CurrentCompany.json' >/dev/null
APP="$WORK/app/resources/app"
[ -f "$APP/dist/index.html" ] || { echo "unexpected installer layout: dist/index.html not found" >&2; exit 1; }

chmod -R u+w dist company 2>/dev/null || true
rm -rf dist company CurrentCompany.json
cp -r "$APP/dist" "$APP/company" "$APP/CurrentCompany.json" .
: > iot_driver.exe          # the renderer copies this file at start-up; it is never executed on Linux
chmod -R a-w dist company   # the vendor UI tries to self-update by rewriting its bundle; keep it read-only

echo "vendor assets extracted:"
echo "  dist/static/js: $(ls dist/static/js)"
echo "  company: $(ls company)"
echo "  version: $(node -p "require('$APP/package.json').version" 2>/dev/null || echo '?')"
