#!/usr/bin/env python3
"""Pack the Samsung Tizen application.

Tizen wants two archives:

  * the web application (`.wgt`), a zip of the `wgt/` folder;
  * the install package (`.tpk`), a zip that carries `metadata.xml`, the
    `.wgt` and the signature files.

The signature is produced by Tizen Studio's `signing_cli.jar`. When it is not
available the package is written unsigned, which is enough to import the
project into Tizen Studio and to sign it there.

Usage:
    python3 scripts/build_tizen_tpk.py
    python3 scripts/build_tizen_tpk.py --signing-cli ~/tizen-studio/tools/signing_cli.jar \
        --profile ~/tizen-studio/tools/profiles/prd.p12 --password ...
"""

from __future__ import annotations

import argparse
import os
import pathlib
import shutil
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROJECT = ROOT / "tizen-app"
DIST = ROOT / "dist"
WGT_NAME = "cinestream.wgt"
TPK_NAME = "cinestream.tpk"


def zip_folder(folder: pathlib.Path, target: pathlib.Path) -> None:
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(folder.rglob("*")):
            if path.is_dir():
                continue
            bundle.write(path, path.relative_to(folder).as_posix())


def build_wgt() -> pathlib.Path:
    wgt = DIST / WGT_NAME
    DIST.mkdir(parents=True, exist_ok=True)
    zip_folder(PROJECT / "wgt", wgt)
    print(f"wrote {wgt} ({wgt.stat().st_size} bytes)")
    return wgt


def build_tpk(wgt: pathlib.Path, signature_files: list[pathlib.Path]) -> pathlib.Path:
    tpk = DIST / TPK_NAME
    with zipfile.ZipFile(tpk, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.write(PROJECT / "metadata.xml", "metadata.xml")
        bundle.write(wgt, WGT_NAME)
        for signature in signature_files:
            bundle.write(signature, signature.name)
    print(f"wrote {tpk} ({tpk.stat().st_size} bytes)")
    return tpk


def sign_with_studio(cli: pathlib.Path, profile: pathlib.Path, password: str, target: pathlib.Path) -> list[pathlib.Path]:
    """Delegate the signature to Tizen Studio's signing tool."""
    workdir = DIST / "signed"
    if workdir.exists():
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    shutil.copy(target, workdir / target.name)

    command = [
        "java", "-jar", str(cli), "-sign",
        "-p", str(profile),
        "-k", "cinestream",
        "-n", "cinestream",
        "-o", str(workdir),
        str(workdir / target.name),
    ]
    if password:
        command.extend(["-P", password])

    result = subprocess.run(command, capture_output=True, text=True)
    print(result.stdout.strip() or result.stderr.strip())
    if result.returncode != 0:
        print("signing failed; the package stays unsigned", file=sys.stderr)
        return []

    signed = sorted(workdir.glob("*.tpk"))
    produced = []
    for package in signed:
        destination = DIST / package.name
        shutil.copy(package, destination)
        produced.append(destination)
    return produced


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--signing-cli", default=os.environ.get("TIZEN_SIGNING_CLI", ""))
    parser.add_argument("--profile", default=os.environ.get("TIZEN_PROFILE", ""))
    parser.add_argument("--password", default=os.environ.get("TIZEN_PASSWORD", ""))
    args = parser.parse_args()

    icon_source = ROOT / "assets" / "app-icon-512.png"
    icon_target = PROJECT / "icon.png"
    if icon_source.exists():
        shutil.copy(icon_source, icon_target)
    wgt_icon = PROJECT / "wgt" / "icon.png"
    if icon_source.exists():
        shutil.copy(icon_source, wgt_icon)

    wgt = build_wgt()
    tpk = build_tpk(wgt, [])

    if args.signing_cli and args.profile:
        signed = sign_with_studio(
            pathlib.Path(args.signing_cli), pathlib.Path(args.profile), args.password, tpk
        )
        for package in signed:
            print(f"signed package: {package}")

    print(
        "\nNext step on the TV:\n"
        "  1. Developer mode: Menu → Suporte → Smart Hub → TV Plus → Gerenciamento\n"
        "     → Configurações de desenvolvedor → Modo desenvolvedor (PIN 0000) e\n"
        "     'Conexão de TV' ligado.\n"
        "  2. No PC, com o Tizen Studio: File → Open Project → tizen-app,\n"
        "     crie um certificado, Build → Build TPK, e instale com 'Run'.\n"
        "  3. Sem Tizen Studio: importe o .wgt em um projeto novo e assine por lá."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
