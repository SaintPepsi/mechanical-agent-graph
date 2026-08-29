#!/usr/bin/env python3
"""Iteration-3 grading: kill rate, false-red rate, dead-test survival, and suite density."""
import json, shutil, subprocess, sys, tempfile
from pathlib import Path

W = Path(__file__).resolve().parent.parent  # the evals/ directory
TIMEOUT = 240
FIXTURE = {
  "10-limiter-repair": ("limiter", True), "11-normalize-repair": ("normalize", True),
  "12-sync-repair": ("sync", True), "13-pricing-repair": ("pricing", True),
  "14-inventory-repair": ("inventory", True), "15-duration-repair": ("legacy-coverage", True),
  "16-limiter-greenfield": ("limiter", False), "17-normalize-greenfield": ("normalize", False),
}

def bun_test(cwd):
    try:
        p = subprocess.run(["bun", "test"], cwd=cwd, capture_output=True, text=True, timeout=TIMEOUT)
        return p.returncode, (p.stdout + p.stderr)[-2500:]
    except subprocess.TimeoutExpired:
        return 124, "TIMEOUT"

def apply_edits(text, edits):
    for e in edits:
        if e["find"] not in text:
            return None
        text = text.replace(e["find"], e["replace"]) if e.get("all") else text.replace(e["find"], e["replace"], 1)
    return text

def smells(outputs):
    p = subprocess.run(["node", str(W.parent / "scripts" / "test-smells.mjs"), str(outputs), "--json"],
                       capture_output=True, text=True)
    try: return json.loads(p.stdout)
    except json.JSONDecodeError: return {"testRecords": [], "findings": []}

def score(run_dir, fixture_name, is_repair):
    outputs = run_dir / "outputs"
    fx = W / "fixtures" / fixture_name
    mutants = json.loads((fx / "mutants.json").read_text())
    refactors = json.loads((fx / "refactors.json").read_text()) if (fx / "refactors.json").exists() else []
    src_file = mutants[0]["file"]

    result = {"fixture": fixture_name, "repair": is_repair}
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "w"
        def reset():
            if work.exists(): shutil.rmtree(work)
            shutil.copytree(outputs, work)
        reset()
        code, log = bun_test(work)
        result["baseline_passed"] = code == 0
        if code != 0: result["baseline_log"] = log[-800:]

        killed = []
        for m in mutants:
            reset()
            t = work / m["file"]; s = t.read_text()
            if m["find"] not in s:
                killed.append({"id": m["id"], "killed": None}); continue
            t.write_text(s.replace(m["find"], m["replace"], 1))
            c, _ = bun_test(work)
            killed.append({"id": m["id"], "killed": c != 0, "category": m.get("category")})

        false_reds = []
        for r in refactors:
            reset()
            t = work / r["file"]
            new = apply_edits(t.read_text(), r["edits"])
            if new is None:
                false_reds.append({"id": r["id"], "red": None}); continue
            t.write_text(new)
            c, lg = bun_test(work)
            false_reds.append({"id": r["id"], "red": c != 0, "log": lg[-400:] if c != 0 else ""})

    applicable = [k for k in killed if k["killed"] is not None]
    nk = sum(1 for k in applicable if k["killed"])
    fr_app = [f for f in false_reds if f["red"] is not None]
    nfr = sum(1 for f in fr_app if f["red"])

    sm = smells(outputs)
    records = sm.get("testRecords", [])
    dead_registry = json.loads((W / "fixtures" / "dead-tests.json").read_text()).get(fixture_name, []) if is_repair else []
    names = {t["name"] for t in records}
    dead_still_there = [n for n in dead_registry if n in names]
    dead_still_dead = [t["name"] for t in records if t["name"] in dead_registry and t["dead"]]

    result.update({
      "mutants": killed, "mutants_killed": nk, "mutants_applicable": len(applicable),
      "kill_rate": round(nk / len(applicable), 3) if applicable else 0.0,
      "survivors": [k["id"] for k in applicable if not k["killed"]],
      "refactors": false_reds, "false_reds": nfr, "refactors_applicable": len(fr_app),
      "false_red_rate": round(nfr / len(fr_app), 3) if fr_app else None,
      "tests": len(records),
      "kills_per_test": round(nk / len(records), 3) if records else 0.0,
      "dead_tests_seeded": len(dead_registry),
      "dead_tests_still_present": dead_still_there,
      "dead_tests_still_dead": dead_still_dead,
      "dead_removed": len(dead_registry) - len(dead_still_dead) if dead_registry else None,
      "smell_errors": [f["rule"] for f in sm.get("findings", []) if f.get("severity") == "error"],
    })
    (run_dir / "score.json").write_text(json.dumps(result, indent=2))
    return result

if __name__ == "__main__":
    it = W / (sys.argv[1] if len(sys.argv) > 1 else "iteration-3")
    only = sys.argv[2] if len(sys.argv) > 2 else None
    for eval_dir in sorted(it.glob("eval-*")):
        key = eval_dir.name.replace("eval-", "")
        if key not in FIXTURE or (only and only not in key): continue
        fixture_name, is_repair = FIXTURE[key]
        for arm in sorted(d.name for d in eval_dir.iterdir() if d.is_dir()):
            run = eval_dir / arm / "run-1"
            if not (run / "outputs").exists(): continue
            if not any((run / "outputs").rglob("*.test.ts")): 
                print(f"{eval_dir.name:30s} {arm:14s} NO TESTS YET"); continue
            r = score(run, fixture_name, is_repair)
            fr = "n/a" if r["false_red_rate"] is None else f"{r['false_red_rate']:.0%}"
            dr = "n/a" if r["dead_removed"] is None else f"{r['dead_removed']}/{r['dead_tests_seeded']}"
            print(f"{eval_dir.name:30s} {arm:14s} kill {r['kill_rate']:.0%} ({r['mutants_killed']}/{r['mutants_applicable']})"
                  f"  false-red {fr}  dead-removed {dr}  tests {r['tests']}  base {'ok' if r['baseline_passed'] else 'RED'}")
