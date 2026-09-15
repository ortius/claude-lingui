#!/usr/bin/env bash
# Builds a native CachyOS/Arch package (.pkg.tar.zst) from the already-built
# dist/linux-unpacked app bundle, using makepkg directly.
#
# Why not `electron-builder --linux pacman`: electron-builder's pacman/deb
# targets both shell out to a bundled `fpm` (a portable Ruby binary) which,
# on this system, fails to load with a glibc/libxcrypt ABI mismatch
# (`ruby: libcrypt.so.1: version 'GLIBC_2.2.5' not found`) unless the
# `libxcrypt-compat` package is installed system-wide (needs root). makepkg
# is Arch's own native, already-installed tool and needs no such dependency.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PROJECT_ROOT="$(pwd)"

VERSION="$(node -p "require('./package.json').version")"
MAINTAINER_EMAIL="$(node -p "require('./package.json').author.email")"
HOMEPAGE="$(node -p "require('./package.json').homepage")"
LICENSE="$(node -p "require('./package.json').license")"
APPDIR="$PROJECT_ROOT/dist/linux-unpacked"

if [ ! -d "$APPDIR" ]; then
  echo "dist/linux-unpacked not found — run 'npm run pack:linux' first." >&2
  exit 1
fi

BUILD_DIR="$PROJECT_ROOT/packaging/arch"
mkdir -p "$BUILD_DIR"
rm -rf "$BUILD_DIR/pkg" "$BUILD_DIR"/*.pkg.tar.zst

# Only sizes actually listed in hicolor/index.theme's Directories= get
# looked at by spec-compliant lookups (confirmed directly: KDE's icon
# lookup silently ignores a claude-lingui.png dropped in an undeclared
# 1024x1024/apps — the app_id/.desktop association can be perfect and the
# icon still won't show). 512 is the largest declared raster size.
# IM7+ provides a unified `magick` binary; older ImageMagick only has
# `convert` — both take the same `-resize WxH` invocation, so fall back to it.
if command -v magick >/dev/null 2>&1; then
  IM_CMD="magick"
elif command -v convert >/dev/null 2>&1; then
  IM_CMD="convert"
else
  echo "ImageMagick ('magick' or 'convert') is required to build icon sizes." >&2
  exit 1
fi
mkdir -p "$BUILD_DIR/icons"
for size in 16 22 24 32 48 64 128 256 512; do
  "$IM_CMD" "$PROJECT_ROOT/build/icon.png" -resize "${size}x${size}" "$BUILD_DIR/icons/claude-lingui-${size}.png"
done

cat > "$BUILD_DIR/claude-lingui.desktop" <<EOF
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

cat > "$BUILD_DIR/PKGBUILD" <<EOF
# Maintainer: Claude LinGUI <${MAINTAINER_EMAIL}>
pkgname=claude-lingui
pkgver=${VERSION}
pkgrel=1
pkgdesc="A graphical desktop client for Claude Code"
arch=('x86_64')
url="${HOMEPAGE}"
license=('${LICENSE}')
depends=('gtk3' 'nss' 'libxss' 'libxtst' 'at-spi2-core' 'libsecret' 'xdg-utils' 'alsa-lib' 'libnotify')
options=('!strip' '!debug' '!emptydirs')

package() {
  install -dm755 "\$pkgdir/opt/claude-lingui"
  cp -a "$APPDIR/." "\$pkgdir/opt/claude-lingui/"
  chmod 4755 "\$pkgdir/opt/claude-lingui/chrome-sandbox"

  install -dm755 "\$pkgdir/usr/bin"
  ln -sf /opt/claude-lingui/claude-lingui "\$pkgdir/usr/bin/claude-lingui"

  install -Dm644 "$BUILD_DIR/claude-lingui.desktop" "\$pkgdir/usr/share/applications/claude-lingui.desktop"
EOF
for size in 16 22 24 32 48 64 128 256 512; do
  cat >> "$BUILD_DIR/PKGBUILD" <<EOF
  install -Dm644 "$BUILD_DIR/icons/claude-lingui-${size}.png" "\$pkgdir/usr/share/icons/hicolor/${size}x${size}/apps/claude-lingui.png"
EOF
done
cat >> "$BUILD_DIR/PKGBUILD" <<EOF
}
EOF

cd "$BUILD_DIR"
# BUILDDIR must be writable and is where makepkg stages pkg/ — keep it local
# to the packaging dir rather than polluting the project root.
# --nodeps: package() only copies pre-built files, it doesn't compile or
# link against the runtime deps in `depends=()` — those just need to be
# *installed* on whoever runs the package, not on the machine building it
# (a minimal build container/CI image won't have gtk3/nss/etc. present).
makepkg -f --noconfirm --skipchecksums --nodeps

OUT=$(ls -1 ./*.pkg.tar.zst | head -n1)
mkdir -p "$PROJECT_ROOT/dist"
mv -f "$OUT" "$PROJECT_ROOT/dist/"
echo "Built: dist/$(basename "$OUT")"
