
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIBUSB_VERSION="${LIBUSB_VERSION:-1.0.29}"
LIBUSB_BUILD_DIR="$ROOT_DIR/ref/libusb-${LIBUSB_VERSION}/build-wasm"

if [[ "${1:-}" == "clean" ]]; then
  rm -rf "$ROOT_DIR/build-wasm" \
    "$ROOT_DIR/dist" \
    "$ROOT_DIR/webarchive" \
    "$LIBUSB_BUILD_DIR"
  echo "clean finished."
  exit 0
fi

which crc32 >/dev/null 2>&1 || { echo "crc32 command not found. Please install it to proceed." >&2; exit 1; }
which git >/dev/null 2>&1 || { echo "git command not found. Please install it to proceed." >&2; exit 1; }

bash "$ROOT_DIR/build_wasm.sh"

rm -rf "$ROOT_DIR/webarchive/web"
mkdir -p "$ROOT_DIR/webarchive"
cp -a "$ROOT_DIR/examples/browser" "$ROOT_DIR/webarchive/web"
rm -f "$ROOT_DIR/webarchive/web/dist" "$ROOT_DIR/webarchive/web/src"
mkdir -p "$ROOT_DIR/webarchive/web/dist"
cp -a "$ROOT_DIR"/dist/*.js "$ROOT_DIR/webarchive/web/dist/"
cp -a "$ROOT_DIR"/dist/*.wasm "$ROOT_DIR/webarchive/web/dist/"
cp -a "$ROOT_DIR/src" "$ROOT_DIR/webarchive/web/"
rm -rf "$ROOT_DIR/webarchive/web/src/node"

RKWASM_HASH=$(crc32 "$ROOT_DIR/webarchive/web/dist/rkdeveloptool.wasm")
RKTOOLSRC_VER=$(git -C "$ROOT_DIR" log -1 --format="%h")
REPO_URL=$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null || true)

case "$REPO_URL" in
  git@github.com:*)
    REPO_URL="https://github.com/${REPO_URL#git@github.com:}"
    ;;
  ssh://git@github.com/*)
    REPO_URL="https://github.com/${REPO_URL#ssh://git@github.com/}"
    ;;
esac

REPO_URL=${REPO_URL%.git}

find "$ROOT_DIR/webarchive/web" \( -name '*.js' -o -name '*.html' \) | xargs -r sed -i '' \
  -e "s#RKDEVELOPTOOL_VER#$RKWASM_HASH#g" \
  -e "s#RKTOOLSRC_VER#$RKTOOLSRC_VER#g" \
  -e "s#REPO_URL#$REPO_URL#g"

xattr -cr "$ROOT_DIR/webarchive/web" 2>/dev/null || true

TAR=tar

which gtar >/dev/null 2>&1 && TAR=gtar

$TAR -C "$ROOT_DIR/webarchive/web" -czf "$ROOT_DIR/webarchive/webarchive.tar.gz" .

echo "pack webarchive/webarchive.tar.gz finished!"
