#!/usr/bin/env python3
"""Run the mutation grader + the mechanical smell reader over every run, emit grading.json."""
import json, subprocess, sys, os
from pathlib import Path

W = Path(__file__).resolve().parent.parent  # the evals/ directory
SMELLS = W.parent / "scripts" / "test-smells.mjs"
EVALS = {"pricing-pure-function": "pricing",
         "inventory-async-collaborator": "inventory",
         "legacy-coverage-chase": "legacy-coverage",
         "rate-limiter-window": "limiter",
         "contact-normalizer": "normalize",
         "paged-sync-rushed": "sync"}

def smells(outputs):
    if not SMELLS.exists():
        return {"errors": 0, "findings": []}
    p = subprocess.run(["node", str(SMELLS), str(outputs), "--json"], capture_output=True, text=True)
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        return {"errors": 0, "findings": [], "note": "smell reader failed"}

def grade(run_dir, fixture_name):
    outputs = run_dir / "outputs"
    fixture = W / "fixtures" / fixture_name
    mut_path = run_dir / "mutation.json"
    subprocess.run([sys.executable, str(W / "scripts" / "score.py"), str(outputs), str(fixture),
                    "--out", str(mut_path)], check=True, capture_output=True)
    m = json.loads(mut_path.read_text())
    s = smells(outputs)

    by_cat = {}
    for row in m["mutants"]:
        cat = next(x["category"] for x in json.loads((fixture / "mutants.json").read_text()) if x["id"] == row["id"])
        by_cat.setdefault(cat, []).append(row)

    def cat_all_killed(cat):
        rows = by_cat.get(cat, [])
        return all(r["killed"] for r in rows), rows

    surviving = [r["id"] for r in m["mutants"] if r["killed"] is False]
    b_ok, b_rows = cat_all_killed("boundary")
    e_ok, e_rows = cat_all_killed("error-path")
    smell_errors = [f for f in s.get("findings", []) if f.get("severity") == "error"]

    exps = [
        {"text": "The suite passes against the correct, unmutated source (baseline green)",
         "passed": bool(m["baseline_passed"]),
         "evidence": "bun test exits 0 on the original source" if m["baseline_passed"]
                     else "baseline suite is red: " + m.get("baseline_log", "")[-400:]},
        {"text": "Kills at least 80% of the seeded mutants",
         "passed": m["kill_rate"] >= 0.8,
         "evidence": f"killed {m['mutants_killed']}/{m.get('mutants_applicable', 0)} = {m['kill_rate']:.0%}."
                     + (f" Survivors: {', '.join(surviving)}" if surviving else " No survivors.")},
        {"text": "Kills every boundary mutant (off-by-one / exactly-at-the-limit)",
         "passed": b_ok,
         "evidence": ", ".join(f"{r['id']}={'killed' if r['killed'] else 'SURVIVED'}" for r in b_rows) or "none"},
        {"text": "Kills every error-path mutant (a removed guard, a swallowed or unwrapped failure)",
         "passed": e_ok,
         "evidence": ", ".join(f"{r['id']}={'killed' if r['killed'] else 'SURVIVED'}" for r in e_rows) or "none"},
        {"text": "Leaves src/ byte-identical to how it was found",
         "passed": bool(m.get("source_unchanged", True)),
         "evidence": "unchanged" if m.get("source_unchanged", True) else f"drifted: {m.get('source_drift')}"},
        {"text": "No mechanically-detectable dead assertion (assertion-free test, un-awaited assertion, dropped async promise, .only left behind)",
         "passed": len(smell_errors) == 0,
         "evidence": "; ".join(f"{f['rule']}@L{f['line']}" for f in smell_errors) or
                     f"clean across {s.get('tests', 0)} tests"},
    ]
    passed = sum(1 for e in exps if e["passed"])
    grading = {
        "expectations": exps,
        "summary": {"passed": passed, "failed": len(exps) - passed, "total": len(exps),
                    "pass_rate": round(passed / len(exps), 3)},
        "mutation": {"kill_rate": m["kill_rate"], "killed": m["mutants_killed"],
                     "applicable": m.get("mutants_applicable", 0), "survivors": surviving,
                     "test_files": m["test_files"]},
    }
    stem = f"{run_dir.parents[1].name.split('-', 2)[-1]}.{run_dir.parent.name}"
    t = W / "timing" / f"{stem}.{run_dir.name}.json"
    if not t.exists():
        t = W / "timing" / f"{stem}.json"
    if t.exists():
        grading["timing"] = json.loads(t.read_text())
    (run_dir / "grading.json").write_text(json.dumps(grading, indent=2))
    return grading

if __name__ == "__main__":
    it = W / sys.argv[1] if len(sys.argv) > 1 else W / "iteration-1"
    for eval_dir in sorted(it.glob("eval-*")):
        name = eval_dir.name.split("-", 2)[-1]
        for arm in sorted(d for d in eval_dir.iterdir() if d.is_dir()):
            for run in sorted(arm.glob("run-*")):
                g = grade(run, EVALS[name])
                print(f"{eval_dir.name:38s} {arm.name:15s} "
                      f"pass {g['summary']['passed']}/{g['summary']['total']}  "
                      f"kill {g['mutation']['kill_rate']:.0%}  "
                      f"survivors: {','.join(g['mutation']['survivors']) or '-'}")
