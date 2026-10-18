# Build container for the RPM: the host has no rpmbuild, so the package is
# assembled with Fedora's own rpmbuild inside this image.
FROM fedora:44
RUN dnf -y install rpm-build desktop-file-utils rpmlint && dnf clean all
WORKDIR /work
