%global debug_package %{nil}
%global __strip /bin/true
%global __brp_mangle_shebangs %{nil}
%global __brp_check_rpaths %{nil}
%global _build_id_links none
%global appdir /opt/monka-driver

Name:           monka-driver
Version:        2.1.66
Release:        1%{?dist}
Summary:        Monka keyboard driver (configurator for Monka A75 and related keyboards)
License:        Proprietary (vendor UI) and MIT (Linux port)
URL:            https://github.com/jimmysama/monka-fedora-kde-driver
BuildArch:      x86_64
AutoReqProv:    no
Requires:       gtk3 libnotify nss libXScrnSaver libXtst xdg-utils at-spi2-core libuuid
Requires:       google-noto-sans-cjk-vf-fonts liberation-sans-fonts liberation-mono-fonts liberation-serif-fonts
# the electron-builder "dir" output is staged by packaging/build-rpm.sh
%define unpacked %{getenv:MONKA_UNPACKED}
%define srcdir %{getenv:MONKA_SRC}

%description
Linux port of the Monka Driver keyboard configurator. Runs the vendor's
original user interface on top of a native HID bridge (hidraw), packaged as a
regular desktop application with a launcher entry and tray icon.

%prep
%build

%install
mkdir -p %{buildroot}%{appdir}
cp -a %{unpacked}/. %{buildroot}%{appdir}/
# setuid helper so the Chromium sandbox also works where unprivileged user namespaces are disabled
chmod 4755 %{buildroot}%{appdir}/chrome-sandbox
install -Dm755 %{srcdir}/packaging/monka-driver %{buildroot}%{_bindir}/monka-driver
install -Dm644 %{srcdir}/packaging/monka-driver.desktop %{buildroot}%{_datadir}/applications/monka-driver.desktop
for s in 16 22 24 32 48 64 128 256 512; do
  install -Dm644 %{srcdir}/packaging/icons/${s}x${s}.png %{buildroot}%{_datadir}/icons/hicolor/${s}x${s}/apps/monka-driver.png
done

%check
desktop-file-validate %{buildroot}%{_datadir}/applications/monka-driver.desktop

%files
%{_bindir}/monka-driver
%{_datadir}/applications/monka-driver.desktop
%{_datadir}/icons/hicolor/*/apps/monka-driver.png
%dir %{appdir}
%{appdir}/*

%changelog
* Sat Oct 18 2026 jimmysama <marketing@carbarn.com.au> - 2.1.66-1
- Linux port of Monka Driver 2.1.66
