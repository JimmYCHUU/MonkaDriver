#!/bin/sh
# Build the RPM from the electron-builder "dir" output using Fedora's rpmbuild
# inside Docker (the host has neither rpmbuild nor password-less sudo).
#   npm run pack          -> release/linux-unpacked/
#   packaging/build-rpm.sh -> release/monkey-wrench-<ver>-2.fc44.x86_64.rpm
set -eu
cd "$(dirname "$0")/.."
ROOT="$PWD"
UNPACKED="$ROOT/release/linux-unpacked"
[ -x "$UNPACKED/monkey-wrench" ] || { echo "run 'npm run pack' first (missing $UNPACKED/monkey-wrench)" >&2; exit 1; }

IMAGE=monka-rpmbuild
docker build -q -t "$IMAGE" packaging >/dev/null
rm -rf "$ROOT/rpmbuild"
mkdir -p "$ROOT/rpmbuild"/{BUILD,RPMS,SRPMS,SPECS,SOURCES,BUILDROOT}
docker run --rm -u "$(id -u):$(id -g)" \
  -v "$ROOT:/work:z" \
  -e MONKA_UNPACKED=/work/release/linux-unpacked \
  -e MONKA_SRC=/work \
  -e HOME=/tmp \
  "$IMAGE" \
  rpmbuild --define "_topdir /work/rpmbuild" -bb /work/packaging/monkey-wrench.spec
cp "$ROOT"/rpmbuild/RPMS/x86_64/*.rpm "$ROOT/release/"
ls -l "$ROOT"/release/*.rpm
