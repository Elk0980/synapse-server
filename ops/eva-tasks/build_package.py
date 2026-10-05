#!/usr/bin/env python3
"""Reproducible, offline source preparation package. Never reads live configuration."""

import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import zipfile

MAIN_SHA = "29c10c07f27cd0b1e60dcf4c87f61236228e5c03"
EVA_SHA = "1d7d0b5e4066de8a07cec5cd598d8af05b4cd98a"
INTEGRATED_SHA = "32ef85a8df6f4b76ff3d0d7cc3270d983b44c425"
ORIGINAL_FILES = tuple("ops/eva-tasks/" + name for name in (
    ".dockerignore", "Dockerfile", "README.md", "audit-source-ref.test.js",
    "bot.js", "bot.test.js", "compose.eva-crm.example.yml", "compose.eva.yml",
    "demo.js", "pairing.py", "pairing_test.py", "runtime.js", "runtime.test.js",
    "setup.py", "setup_test.py", "socket-source.js", "socket-source.test.js",
    "task-source.js", "task-source.test.js",
)) + ("ops/crm/eva-task-reader.js",)
COMPANY_CODES = ["alvi", "palitra-love", "synapse-business", "avokado", "novyi-etap", "taisabai"]


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args):
    result = subprocess.run(
        ["git", "-c", "safe.directory=" + root.as_posix(), "-C", str(root), *args],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode:
        raise ValueError("Required committed source is unavailable; fetch the reviewed branch first.")
    return result.stdout


def read_commit(root, ref, path):
    return git(root, "show", ref + ":" + path)


def stored_zip(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_STORED
            archive.writestr(info, data)
    return output.getvalue()


def render_artifacts(files, template, source_sha):
    if not re.fullmatch(r"[0-9a-f]{40}", source_sha):
        raise ValueError("A full immutable source commit is required.")
    payload = stored_zip(files)
    digest = sha256(payload)
    metadata = {
        "schema": 1, "main_sha": MAIN_SHA, "eva_sha": EVA_SHA,
        "integrated_sha": INTEGRATED_SHA, "package_source_sha": source_sha,
        "file_sha256": {name: sha256(data) for name, data in sorted(files.items())},
        "company_codes": COMPANY_CODES, "timezone": "Etc/UTC",
        "expected_bot": "SynapseBusinessEvaBot",
    }
    # Constants are valid Python literals; no shell interpolation or secret arguments.
    metadata_literal = repr(dict(sorted(metadata.items())))
    trailer = ("\nPACKAGE_METADATA = " + metadata_literal
               + "\nPAYLOAD_SHA256 = " + repr(digest)
               + "\nPAYLOAD_B64 = " + repr(base64.b64encode(payload).decode("ascii"))
               + "\n\nif __name__ == '__main__':\n    raise SystemExit(main())\n")
    executable = template.replace(b"\r\n", b"\n").rstrip() + trailer.encode("utf-8")
    stem = "eva-prepare-" + source_sha[:12]
    name = stem + ".py"
    command = ("printf '%s  %s\\n' '" + sha256(executable) + "' '" + name
               + "' | sha256sum --check --status && python3 '" + name + "' --prepare\n")
    artifacts = {
        name: executable,
        stem + ".zip": payload,
        "MANIFEST.json": (json.dumps(metadata, sort_keys=True, ensure_ascii=False, indent=2) + "\n").encode(),
        "COMMAND.txt": command.encode(),
        "README.md": files["PACKAGE_README.md"],
    }
    artifacts["SHA256SUMS"] = "".join(
        sha256(data) + "  " + path + "\n" for path, data in sorted(artifacts.items())
    ).encode()
    return artifacts


def integration_patch(root):
    return git(
        root, "diff", "--no-ext-diff", "--no-color", "--no-renames", "--binary",
        "--no-textconv", "--full-index", "--unified=3", "--inter-hunk-context=0",
        "--src-prefix=a/", "--dst-prefix=b/", "--diff-algorithm=myers", "--no-indent-heuristic", "--no-relative",
        MAIN_SHA, INTEGRATED_SHA, "--", "ops/crm/server.js", "ops/crm/eva-task-reader.js",
    )


def build(root, source_sha):
    if not re.fullmatch(r"[0-9a-f]{40}", source_sha):
        raise ValueError("A full immutable source commit is required.")
    git(root, "cat-file", "-e", source_sha + "^{commit}")
    committed_builder = read_commit(root, source_sha, "ops/eva-tasks/build_package.py")
    if committed_builder.replace(b"\r\n", b"\n") != Path(__file__).read_bytes().replace(b"\r\n", b"\n"):
        raise ValueError("Run the unchanged builder belonging to the requested source commit.")
    files = {path: read_commit(root, INTEGRATED_SHA, path) for path in ORIGINAL_FILES}
    files["integration.patch"] = integration_patch(root)
    files["PACKAGE_README.md"] = read_commit(root, source_sha, "ops/eva-tasks/PACKAGE_README.md")
    template = read_commit(root, source_sha, "ops/eva-tasks/package_bootstrap.py")
    return render_artifacts(files, template, source_sha)


def write_artifacts(output, artifacts):
    # A new destination only; a failed build never replaces another delivery.
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    for name, data in artifacts.items():
        with (output / name).open("xb") as target:
            target.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="full committed packaging source SHA")
    parser.add_argument("--output", required=True, type=Path, help="new output directory")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    try:
        artifacts = build(root, args.source)
        write_artifacts(args.output, artifacts)
    except (OSError, ValueError):
        parser.exit(1, "Build stopped; use an available full source commit and a NEW output directory.\n")
    print("Prepared immutable source artifacts. No deployment or bot connection performed.")
    print(artifacts["SHA256SUMS"].decode(), end="")


if __name__ == "__main__":
    main()
