%global debug_package %{nil}
%global __strip /bin/true
%global __brp_mangle_shebangs %{nil}
%global __brp_check_rpaths %{nil}
%global _build_id_links none
%global appdir /opt/monkey-wrench

Name:           monkey-wrench
Version:        2.1.66
Release:        3%{?dist}
Summary:        Monkey Wrench: the Monka keyboard driver on Linux (A75 and related keyboards)
License:        Proprietary (vendor UI) and MIT (Linux port)
URL:            https://github.com/JimmYCHUU/MonkeyWrench
BuildArch:      x86_64
AutoReqProv:    no
# the package was called monka-driver before 2.1.66-2
Obsoletes:      monka-driver < 2.1.66-2
Provides:       monka-driver = %{version}-%{release}
Requires:       gtk3 libnotify nss libXScrnSaver libXtst xdg-utils at-spi2-core libuuid
Requires:       google-noto-sans-cjk-vf-fonts liberation-sans-fonts liberation-mono-fonts liberation-serif-fonts
# the electron-builder "dir" output is staged by packaging/build-rpm.sh
%define unpacked %{getenv:MONKA_UNPACKED}
%define srcdir %{getenv:MONKA_SRC}

%description
Monkey Wrench is a Linux port of the Monka Driver keyboard configurator. It runs the vendor's
original user interface on top of a native HID bridge (hidraw), packaged as a
regular desktop application with a launcher entry and tray icon.

%prep
%build

%install
mkdir -p %{buildroot}%{appdir}
cp -a %{unpacked}/. %{buildroot}%{appdir}/
# setuid helper so the Chromium sandbox also works where unprivileged user namespaces are disabled
chmod 4755 %{buildroot}%{appdir}/chrome-sandbox
install -Dm755 %{srcdir}/packaging/monkey-wrench %{buildroot}%{_bindir}/monkey-wrench
install -Dm644 %{srcdir}/packaging/monkey-wrench.desktop %{buildroot}%{_datadir}/applications/monkey-wrench.desktop
for s in 16 22 24 32 48 64 128 256 512; do
  install -Dm644 %{srcdir}/packaging/icons/${s}x${s}.png %{buildroot}%{_datadir}/icons/hicolor/${s}x${s}/apps/monkey-wrench.png
done

%check
desktop-file-validate %{buildroot}%{_datadir}/applications/monkey-wrench.desktop

%files
%{_bindir}/monkey-wrench
%{_datadir}/applications/monkey-wrench.desktop
%{_datadir}/icons/hicolor/*/apps/monkey-wrench.png
%dir %{appdir}
%{appdir}/*

%changelog
* Tue Oct 27 2026 JimmYCHUU <asajibtisamnipun@gmail.com> - 2.1.66-3
- Battery percentage beside Monka's icon, with a bolt while charging (dongle and cable)
- The keyboard is recognised on its USB cable (wired mode)

* Sun Oct 18 2026 JimmYCHUU <asajibtisamnipun@gmail.com> - 2.1.66-2
- Renamed to Monkey Wrench (was monka-driver)

* Sun Oct 18 2026 JimmYCHUU <asajibtisamnipun@gmail.com> - 2.1.66-1
- Linux port of Monka Driver 2.1.66
