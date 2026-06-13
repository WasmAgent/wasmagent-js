#!/usr/bin/env python3
"""
judge.py — SWE-bench-lite per-instance evaluator.

Runs INSIDE the container; the JS harness on the host bind-mounts a
work directory containing the inputs and reads the result back. Never
runs on the host (per the brief's pre-run checklist).

Inputs:
    --instance PATH    JSON descriptor for the SWE-bench-lite task.
    --patch PATH       The agent-produced patch (unified diff).
    --output PATH      Where to write the result JSON.

Output JSON shape:
    {
        "resolved": bool,                     # true iff fail_to_pass all pass AND pass_to_pass all pass
        "fail_to_pass": {"passed": [...], "failed": [...]},
        "pass_to_pass": {"passed": [...], "failed": [...]},
        "applied":      bool,                  # did `git apply` succeed?
        "error":        str | null,
    }

Strategy:
    1. Clone the instance's repo at base_commit into /tmp/<instance_id>.
    2. Apply the test_patch (the upstream-supplied harness patch) +
       the agent's patch. Either failing means resolved=False.
    3. Set up a minimal venv inside the clone, pip install the repo
       (best-effort: setup.py / pyproject / requirements.txt; skip if
       none).
    4. Run pytest on the union of fail_to_pass and pass_to_pass test
       node-ids; classify pass/fail per node-id.
    5. Write result.json.

Failure modes are surfaced in `error` rather than raised — the harness
treats every well-formed result.json as authoritative.

This is NOT a re-implementation of SWE-bench's official evaluator.
The official one is in the `swebench` pip package and uses Docker
images per repo + version. We do the lightweight in-container
equivalent because we already ARE in a container; the tradeoff is
that Python-version-specific environment edge cases that SWE-bench's
images handle (e.g. pinned numpy ABI) may surface as flake here. For
publication runs we should consider switching to the official
swebench-evaluate; for the wiring sanity test (which is what runTests
in the JS harness primarily exercises) the lightweight path is what
matters.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path


def write_result(path: str, data: dict) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, indent=2))


def run(cmd: list[str], cwd: str | None = None, timeout: int = 600) -> tuple[int, str, str]:
    """Run a subprocess; return (returncode, stdout, stderr)."""
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    return proc.returncode, proc.stdout, proc.stderr


def clone_repo(repo: str, base_commit: str, dest: Path) -> tuple[bool, str | None]:
    """Shallow-clone the upstream repo and check out the base_commit.

    SWE-bench-lite pins commits; we use a depth-200 clone and then
    fetch the specific commit. If the commit isn't reachable we fall
    back to a full clone (slower but always works).
    """
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)
    url = f"https://github.com/{repo}.git"

    code, _, err = run(["git", "clone", "--depth", "200", url, str(dest)], timeout=600)
    if code != 0:
        return False, f"git clone --depth=200 failed: {err.strip()}"

    code, _, _ = run(["git", "checkout", base_commit], cwd=str(dest))
    if code == 0:
        return True, None

    # Fallback: fetch deeper or unshallow.
    run(["git", "fetch", "--unshallow"], cwd=str(dest), timeout=900)
    code, _, err = run(["git", "checkout", base_commit], cwd=str(dest))
    if code != 0:
        return False, f"git checkout {base_commit} failed even after unshallow: {err.strip()}"
    return True, None


def apply_patch(repo_dir: Path, patch_text: str, label: str) -> tuple[bool, str | None]:
    """git apply a patch from a string; return (ok, error)."""
    if not patch_text.strip():
        return True, None  # empty patch is a no-op
    patch_file = repo_dir / f"_apply_{label}.diff"
    patch_file.write_text(patch_text)
    code, _, err = run(["git", "apply", "--whitespace=nowarn", str(patch_file)], cwd=str(repo_dir))
    if code != 0:
        # Try -3way for context-mismatch tolerance.
        code, _, err2 = run(
            ["git", "apply", "--3way", "--whitespace=nowarn", str(patch_file)],
            cwd=str(repo_dir),
        )
        if code != 0:
            return False, f"git apply ({label}) failed: {err.strip() or err2.strip()}"
    return True, None


def install_repo(repo_dir: Path) -> str | None:
    """Best-effort install: pyproject / setup.py / requirements.txt.

    Returns an error string on hard failure; None on success (or on a
    'no installer found' soft failure where pytest may still work).
    """
    venv = repo_dir / ".judge-venv"
    code, _, err = run([sys.executable, "-m", "venv", str(venv)])
    if code != 0:
        return f"venv create failed: {err}"

    pip = str(venv / "bin" / "pip")
    # Upgrade pip first (some old repos pin ancient numpy that needs
    # modern pip's PEP 517 build-system support).
    run([pip, "install", "--upgrade", "pip", "wheel", "setuptools"])

    if (repo_dir / "pyproject.toml").exists() or (repo_dir / "setup.py").exists():
        code, _, err = run([pip, "install", "-e", "."], cwd=str(repo_dir), timeout=1800)
        if code != 0:
            return f"pip install -e . failed: {err[-2000:]}"
    if (repo_dir / "requirements.txt").exists():
        run(
            [pip, "install", "-r", "requirements.txt"],
            cwd=str(repo_dir),
            timeout=1800,
        )
    # Ensure pytest is available even when the project doesn't list it.
    run([pip, "install", "pytest"], timeout=600)
    return None


def run_pytest(repo_dir: Path, node_ids: list[str]) -> dict[str, str]:
    """Run pytest for the given node-ids; return {node_id: 'pass'|'fail'}.

    Uses the venv's pytest. Failures (collection errors, unknown ids)
    are reported as 'fail' so the resolved gate stays strict.
    """
    if not node_ids:
        return {}
    venv = repo_dir / ".judge-venv"
    pytest_bin = venv / "bin" / "pytest"
    if not pytest_bin.exists():
        # Fall back to the system pytest installed in the image.
        pytest_bin = Path(shutil.which("pytest") or "pytest")

    # We run each node-id in its own pytest invocation so a collection
    # error on one doesn't poison the rest. This is slower but more
    # informative.
    results: dict[str, str] = {}
    for node_id in node_ids:
        code, _, _ = run(
            [str(pytest_bin), "-x", "--no-header", "-q", "--tb=no", node_id],
            cwd=str(repo_dir),
            timeout=300,
        )
        results[node_id] = "pass" if code == 0 else "fail"
    return results


def split_results(node_ids: list[str], results: dict[str, str]) -> dict[str, list[str]]:
    passed = [n for n in node_ids if results.get(n) == "pass"]
    failed = [n for n in node_ids if results.get(n) != "pass"]
    return {"passed": passed, "failed": failed}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--instance", required=True)
    ap.add_argument("--patch", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    out_path = args.output
    try:
        instance = json.loads(Path(args.instance).read_text())
        patch_text = Path(args.patch).read_text()

        repo = instance["repo"]
        base_commit = instance["base_commit"]
        test_patch = instance.get("test_patch", "")
        fail_to_pass = instance.get("fail_to_pass", [])
        pass_to_pass = instance.get("pass_to_pass", [])
        instance_id = instance.get("instance_id", "unknown")

        work = Path(tempfile.mkdtemp(prefix=f"swe-{instance_id}-"))
        repo_dir = work / "repo"

        ok, err = clone_repo(repo, base_commit, repo_dir)
        if not ok:
            write_result(
                out_path,
                {"resolved": False, "applied": False, "error": err,
                 "fail_to_pass": {"passed": [], "failed": fail_to_pass},
                 "pass_to_pass": {"passed": [], "failed": pass_to_pass}},
            )
            return 0

        ok, err = apply_patch(repo_dir, test_patch, "test")
        if not ok:
            write_result(
                out_path,
                {"resolved": False, "applied": False, "error": f"test_patch did not apply: {err}",
                 "fail_to_pass": {"passed": [], "failed": fail_to_pass},
                 "pass_to_pass": {"passed": [], "failed": pass_to_pass}},
            )
            return 0

        ok, err = apply_patch(repo_dir, patch_text, "agent")
        applied = ok
        if not ok:
            write_result(
                out_path,
                {"resolved": False, "applied": False, "error": f"agent patch did not apply: {err}",
                 "fail_to_pass": {"passed": [], "failed": fail_to_pass},
                 "pass_to_pass": {"passed": [], "failed": pass_to_pass}},
            )
            return 0

        install_err = install_repo(repo_dir)
        if install_err:
            # We continue to pytest — it MIGHT still work for repos
            # that don't need an editable install — but the error is
            # in the result for visibility.
            install_err_short = install_err[:500]
        else:
            install_err_short = None

        all_ids = list(dict.fromkeys(fail_to_pass + pass_to_pass))
        per_id = run_pytest(repo_dir, all_ids)

        f2p = split_results(fail_to_pass, per_id)
        p2p = split_results(pass_to_pass, per_id)
        resolved = (
            applied
            and len(f2p["failed"]) == 0
            and len(p2p["failed"]) == 0
        )

        write_result(
            out_path,
            {
                "resolved": resolved,
                "applied": applied,
                "fail_to_pass": f2p,
                "pass_to_pass": p2p,
                "error": install_err_short,
            },
        )
        return 0
    except Exception as e:  # noqa: BLE001
        write_result(
            out_path,
            {
                "resolved": False,
                "applied": False,
                "error": f"judge.py crashed: {e}\n{traceback.format_exc()}",
                "fail_to_pass": {"passed": [], "failed": []},
                "pass_to_pass": {"passed": [], "failed": []},
            },
        )
        return 0


if __name__ == "__main__":
    sys.exit(main())
