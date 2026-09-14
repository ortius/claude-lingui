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
  install -Dm644 "$PROJECT_ROOT/build/icon.png" "\$pkgdir/usr/share/icons/hicolor/1024x1024/apps/claude-lingui.png"
}
EOF

cd "$BUILD_DIR"
# BUILDDIR must be writable and is where makepkg stages pkg/ — keep it local
# to the packaging dir rather than polluting the project root.
makepkg -f --noconfirm --skipchecksums

OUT=$(ls -1 ./*.pkg.tar.zst | head -n1)
mkdir -p "$PROJECT_ROOT/dist"
mv -f "$OUT" "$PROJECT_ROOT/dist/"
echo "Built: dist/$(basename "$OUT")"
