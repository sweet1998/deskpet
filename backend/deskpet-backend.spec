from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules


backend_root = Path(SPECPATH)
repository_root = backend_root.parent

akshare_datas, akshare_binaries, akshare_hiddenimports = collect_all("akshare")
role_file = repository_root / "deskpet-app" / "src" / "shared" / "role-profiles.json"

analysis = Analysis(
    [str(backend_root / "desktop_entry.py")],
    pathex=[str(backend_root)],
    binaries=akshare_binaries,
    datas=akshare_datas + [
        (
            str(role_file),
            "deskpet-app/src/shared",
        ),
    ],
    hiddenimports=akshare_hiddenimports + collect_submodules("app"),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(analysis.pure)

executable = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="deskpet-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

bundle = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name="deskpet-backend",
)
