#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REF_DIR="$ROOT_DIR/ref"
LIBUSB_VERSION="${LIBUSB_VERSION:-1.0.29}"
LIBUSB_DIR_NAME="libusb-${LIBUSB_VERSION}"
LIBUSB_SRC_DIR="$REF_DIR/$LIBUSB_DIR_NAME"
LIBUSB_ARCHIVE="$REF_DIR/${LIBUSB_DIR_NAME}.tar.bz2"
LIBUSB_URL="${LIBUSB_URL:-https://github.com/libusb/libusb/releases/download/v${LIBUSB_VERSION}/${LIBUSB_DIR_NAME}.tar.bz2}"
RKDEVELOPTOOL_DIR="$ROOT_DIR/rkdeveloptool"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

download_file() {
  local url="$1"
  local output="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -L --fail --retry 3 -o "$output" "$url"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -O "$output" "$url"
    return
  fi

  echo "missing required command: curl or wget" >&2
  exit 1
}

apply_patch_if_needed() {
  local target_dir="$1"
  local patch_file="$2"
  local strip_level="$3"

  if patch --batch --forward --dry-run -d "$target_dir" "-p${strip_level}" < "$patch_file" >/dev/null 2>&1; then
    patch --batch --forward -d "$target_dir" "-p${strip_level}" < "$patch_file"
    return
  fi

  if patch --batch --dry-run -R -d "$target_dir" "-p${strip_level}" < "$patch_file" >/dev/null 2>&1; then
    echo "patch already applied: $(basename "$patch_file")"
    return
  fi

  echo "failed to apply patch: $patch_file" >&2
  exit 1
}

require_cmd git
require_cmd tar
require_cmd patch

mkdir -p "$REF_DIR"

if [[ ! -d "$RKDEVELOPTOOL_DIR/.git" ]]; then
  git submodule update --init --recursive rkdeveloptool
fi

if [[ ! -d "$LIBUSB_SRC_DIR" ]]; then
  if [[ ! -f "$LIBUSB_ARCHIVE" ]]; then
    echo "downloading $LIBUSB_DIR_NAME..."
    download_file "$LIBUSB_URL" "$LIBUSB_ARCHIVE"
  fi

  echo "extracting $LIBUSB_DIR_NAME..."
  tar -xf "$LIBUSB_ARCHIVE" -C "$REF_DIR"
fi

for patch_file in "$ROOT_DIR"/patches/libusb/*.patch; do
  apply_patch_if_needed "$LIBUSB_SRC_DIR" "$patch_file" 1
done

for patch_file in "$ROOT_DIR"/patches/rkdeveloptool/*.patch; do
  apply_patch_if_needed "$ROOT_DIR" "$patch_file" 0
done

echo "source dependencies are ready."
