#!/usr/bin/env bash
# Builds a .deb package from the already-built dist/linux-unpacked app
# bundle by assembling the ar/tar archive directly (the plain Debian binary
# package format), rather than going through dpkg-deb or fpm.
#
# Why: this machine has neither `dpkg-deb` (Arch doesn't ship it) nor a
# working `fpm` (electron-builder's bundled portable-Ruby fpm fails to load
# here — libcrypt.so.1/glibc ABI mismatch — without installing
# `libxcrypt-compat` as root). The .deb format itself is simple and
# well-documented (an `ar` archive of debian-binary + two tarballs), so it's
# straightforward to build with just ar/tar/xz, all of which are present.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PROJECT_ROOT="$(pwd)"

VERSION="$(node -p "require('./package.json').version")"
MAINTAINER_EMAIL="$(node -p "require('./package.json').author.email")"
HOMEPAGE="$(node -p "require('./package.json').homepage")"
ARCH="amd64"
PKG="claude-lingui"
APPDIR="$PROJECT_ROOT/dist/linux-unpacked"

if [ ! -d "$APPDIR" ]; then
  echo "dist/linux-unpacked not found — run 'npm run pack:linux' first." >&2
  exit 1
fi

STAGE="$PROJECT_ROOT/packaging/deb"
rm -rf "$STAGE"
mkdir -p "$STAGE/data/opt/claude-lingui" \
         "$STAGE/data/usr/bin" \
         "$STAGE/data/usr/share/applications" \
         "$STAGE/control"

# --- payload -----------------------------------------------------------
cp -a "$APPDIR/." "$STAGE/data/opt/claude-lingui/"
chmod 4755 "$STAGE/data/opt/claude-lingui/chrome-sandbox"
ln -sf /opt/claude-lingui/claude-lingui "$STAGE/data/usr/bin/claude-lingui"

# Only sizes actually listed in hicolor/index.theme's Directories= get
# looked at by spec-compliant lookups (confirmed directly: KDE's icon
# lookup silently ignores a claude-lingui.png dropped in an undeclared
# 1024x1024/apps — the app_id/.desktop association can be perfect and the
# icon still won't show). 512 is the largest declared raster size.
# IM7+ provides a unified `magick` binary; Ubuntu's `imagemagick` apt
# package still ships IM6 (imagemagick-6.q16), which only has `convert` —
# both take the same `-resize WxH` invocation, so fall back to it.
if command -v magick >/dev/null 2>&1; then
  IM_CMD="magick"
elif command -v convert >/dev/null 2>&1; then
  IM_CMD="convert"
else
  echo "ImageMagick ('magick' or 'convert') is required to build icon sizes." >&2
  exit 1
fi
for size in 16 22 24 32 48 64 128 256 512; do
  dir="$STAGE/data/usr/share/icons/hicolor/${size}x${size}/apps"
  mkdir -p "$dir"
  "$IM_CMD" "$PROJECT_ROOT/build/icon.png" -resize "${size}x${size}" "$dir/claude-lingui.png"
done

cat > "$STAGE/data/usr/share/applications/claude-lingui.desktop" <<EOF
[Desktop Entry]
Name=Claude LinGUI
Comment=A graphical desktop client for Claude Code
Exec=claude-lingui %U
Terminal=false
Type=Application
Icon=claude-lingui
StartupWMClass=claude-lingui
Categories=Development;Utility;
EOF

# --- control -------------------------------------------------------------
INSTALLED_KB=$(du -sk "$STAGE/data" | cut -f1)

cat > "$STAGE/control/control" <<EOF
Package: ${PKG}
Version: ${VERSION}
Section: devel
Priority: optional
Architecture: ${ARCH}
Installed-Size: ${INSTALLED_KB}
Maintainer: Claude LinGUI <${MAINTAINER_EMAIL}>
Homepage: ${HOMEPAGE}
Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0
Description: A graphical desktop client for Claude Code
 Claude LinGUI drives the claude CLI and renders its streaming output as
 a real chat interface, with tool-call cards, markdown, and syntax
 highlighting.
EOF

# --- assemble --------------------------------------------------------------
cd "$STAGE/control"
tar --owner=0 --group=0 -Jcf ../control.tar.xz ./control
cd "$STAGE/data"
tar --owner=0 --group=0 -Jcf ../data.tar.xz .
cd "$STAGE"
echo "2.0" > debian-binary

OUT="$PROJECT_ROOT/dist/${PKG}_${VERSION}_${ARCH}.deb"
mkdir -p "$PROJECT_ROOT/dist"
rm -f "$OUT"
ar rc "$OUT" debian-binary control.tar.xz data.tar.xz

echo "Built: dist/$(basename "$OUT")"
