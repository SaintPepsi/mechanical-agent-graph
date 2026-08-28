#!/usr/bin/env python3
"""Grade a produced test suite by mutation: how many deliberate bugs does it actually catch?

Usage: score.py <run_dir> <fixture_dir> [--out grading.json]

<run_dir> is a copy of the fixture project containing whatever test files the agent wrote.
For each mutant in <fixture_dir>/mutants.json we apply one source edit to a scratch copy of
<run_dir> and run `bun test`. A mutant is "killed" if the suite goes red.
"""
import json, shutil, subprocess, sys, tempfile, os
from pathlib import Path

TIMEOUT = 180

def run_bun_test(cwd):
    try:
        p = subprocess.run(["bun", "test"], cwd=cwd, capture_output=True, text=True, timeout=TIMEOUT)
        return p.returncode, (p.stdout + p.stderr)[-4000:]
    except subprocess.TimeoutExpired:
        return 124, "TIMEOUT: the suite did not finish in %ds" % TIMEOUT

def main():
    run_dir = Path(sys.argv[1]).resolve()
    fixture = Path(sys.argv[2]).resolve()
    out = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else run_dir.parent / "grading.json"

    mutants = json.loads((fixture / "mutants.json").read_text())
    test_files = sorted(str(p.relative_to(run_dir)) for p in run_dir.rglob("*.test.ts"))
    test_files += sorted(str(p.relative_to(run_dir)) for p in run_dir.rglob("*.spec.ts"))

    result = {"run_dir": str(run_dir), "fixture": fixture.name, "test_files": test_files}

    # The agent is allowed to mutate the source while working, but must leave it as it found it.
    drift = []
    for original in (fixture / "src").rglob("*.ts"):
        if original.name.endswith(".test.ts"):
            continue
        mirror = run_dir / "src" / original.name
        if not mirror.exists() or mirror.read_text() != original.read_text():
            drift.append(str(original.name))
    result["source_unchanged"] = not drift
    result["source_drift"] = drift

    if not test_files:
        result.update({"baseline_passed": False, "baseline_note": "no test files produced",
                       "mutants_killed": 0, "mutants_total": len(mutants), "kill_rate": 0.0,
                       "mutants": [{"id": m["id"], "describes": m["describes"], "killed": False} for m in mutants]})
        out.write_text(json.dumps(result, indent=2)); print(json.dumps(result["mutants_killed"] if False else result, indent=2)[:200]); return

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "work"
        shutil.copytree(run_dir, work)
        code, log = run_bun_test(work)
        result["baseline_passed"] = code == 0
        result["baseline_log"] = log[-1500:]

        rows = []
        for m in mutants:
            shutil.rmtree(work); shutil.copytree(run_dir, work)
            target = work / m["file"]
            src = target.read_text()
            if m["find"] not in src:
                rows.append({"id": m["id"], "describes": m["describes"], "killed": None,
                             "error": "mutant no longer applies — the agent edited the source"})
                continue
            target.write_text(src.replace(m["find"], m["replace"], 1))
            code, log = run_bun_test(work)
            rows.append({"id": m["id"], "describes": m["describes"], "killed": code != 0,
                         "detail": log[-600:] if code == 0 else ""})

        killed = sum(1 for r in rows if r["killed"] is True)
        applicable = sum(1 for r in rows if r["killed"] is not None)
        result.update({"mutants": rows, "mutants_killed": killed, "mutants_total": len(mutants),
                       "mutants_applicable": applicable,
                       "kill_rate": round(killed / applicable, 3) if applicable else 0.0})

    out.write_text(json.dumps(result, indent=2))
    print(f"{run_dir.name}: baseline={'PASS' if result['baseline_passed'] else 'FAIL'} "
          f"killed {result['mutants_killed']}/{result.get('mutants_applicable', 0)} "
          f"({result['kill_rate']:.0%})  files={len(test_files)}")

main()
