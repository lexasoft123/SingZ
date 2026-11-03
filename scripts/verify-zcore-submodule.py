#!/usr/bin/env python3
"""Verify that a consumer checkout has the exact, clean zCore gitlink checked out.

This is deliberately read-only and offline. Initialization and pin changes are
Git operations owned by the repository coordinator/bootstrap, never by a build.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath


OID_RE = re.compile(r"^[0-9a-f]{40,64}$")


class VerificationError(RuntimeError):
    pass


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["GIT_TERMINAL_PROMPT"] = "0"
    # This command-scoped trust entry supports bind-mounted CI/container
    # checkouts without modifying either global or repository Git config.
    command = ["git", "-c", f"safe.directory={repo}", "-C", str(repo), *args]
    result = subprocess.run(command, text=True, capture_output=True, env=env)
    if check and result.returncode:
        detail = result.stderr.strip() or result.stdout.strip()
        raise VerificationError(detail or f"git {' '.join(args)} failed")
    return result


def require_init_action(path: str, detail: str) -> VerificationError:
    return VerificationError(
        f"zCore submodule {path} is unavailable or invalid: {detail}\n"
        f"Initialize it with: git submodule update --init -- {path}"
    )


def normalized(path: Path) -> Path:
    return Path(os.path.realpath(path))


def verify(root_arg: Path, relative_path: str) -> str:
    path_value = PurePosixPath(relative_path)
    if (
        path_value.is_absolute()
        or not path_value.parts
        or any(part in ("", ".", "..") for part in path_value.parts)
        or "\\" in relative_path
    ):
        raise VerificationError(f"invalid repository-relative submodule path: {relative_path!r}")

    root = normalized(root_arg)
    if not root.is_dir():
        raise VerificationError(f"consumer repository root does not exist: {root}")
    root_result = git(root, "rev-parse", "--show-toplevel")
    parent_root = normalized(Path(root_result.stdout.strip()))
    if parent_root != root:
        raise VerificationError(f"--root must be the consumer repository root: {root}")

    # Parse NUL-delimited stage entries so paths with spaces are unambiguous and
    # a conflicted index cannot be mistaken for one clean gitlink.
    index = git(root, "ls-files", "--stage", "-z", "--", relative_path)
    records = [record for record in index.stdout.split("\0") if record]
    parsed: list[tuple[str, str, str]] = []
    for record in records:
        try:
            metadata, indexed_path = record.split("\t", 1)
            mode, oid, stage = metadata.split(" ", 2)
        except ValueError as error:
            raise VerificationError("could not parse the submodule index entry") from error
        if indexed_path != relative_path:
            continue
        parsed.append((mode, oid, stage))
    if len(parsed) != 1 or parsed[0][0] != "160000" or parsed[0][2] != "0":
        raise require_init_action(
            relative_path,
            "the parent index must contain exactly one stage-0 mode-160000 gitlink entry",
        )
    expected_oid = parsed[0][1].lower()
    if not OID_RE.fullmatch(expected_oid):
        raise VerificationError("the parent gitlink does not contain a valid object ID")

    child = normalized(root.joinpath(*path_value.parts))
    if not child.is_dir():
        raise require_init_action(relative_path, "the submodule working directory is missing")
    child_root_result = git(child, "rev-parse", "--show-toplevel", check=False)
    if child_root_result.returncode:
        raise require_init_action(relative_path, "the directory is not an initialized Git repository")
    child_root = normalized(Path(child_root_result.stdout.strip()))
    if child_root != child:
        raise require_init_action(
            relative_path,
            "the checkout resolves to a different repository (a copied/plain folder is not accepted)",
        )
    child_head_result = git(child, "rev-parse", "--verify", "HEAD^{commit}", check=False)
    if child_head_result.returncode:
        raise require_init_action(relative_path, "the child repository has no checked-out commit")
    actual_oid = child_head_result.stdout.strip().lower()
    if actual_oid != expected_oid:
        raise VerificationError(
            f"zCore checkout revision {actual_oid} does not match parent gitlink {expected_oid};\n"
            f"update the child and parent pin together, then verify with: "
            f"python3 scripts/verify-zcore-submodule.py --root . --path {relative_path}"
        )

    status = git(
        child,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
    ).stdout
    if status:
        first = status.splitlines()[0]
        raise VerificationError(
            f"zCore submodule {relative_path} is dirty (first status row: {first!r}); "
            "restore or commit its changes before building"
        )
    return expected_oid


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path, help="consumer repository root")
    parser.add_argument("--path", required=True, help="gitlink path relative to --root")
    parser.add_argument(
        "--print-revision",
        action="store_true",
        help="print only the verified gitlink object ID (for fingerprints)",
    )
    args = parser.parse_args()
    try:
        revision = verify(args.root, args.path)
    except (VerificationError, OSError) as error:
        print(f"zCore submodule verification failed: {error}", file=sys.stderr)
        return 1
    if args.print_revision:
        print(revision)
    else:
        print(f"zCore submodule verified: {args.path} at {revision}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
