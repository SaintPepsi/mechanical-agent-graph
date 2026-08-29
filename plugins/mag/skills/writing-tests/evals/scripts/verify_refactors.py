#!/usr/bin/env python3
"""A refactor that changes behaviour would poison the false-red metric. Prove each one doesn't."""
import json, shutil, subprocess, sys, tempfile
from pathlib import Path

W = Path(__file__).resolve().parent.parent  # the evals/ directory

def probe(d):
    p = subprocess.run(["bun", "probe.ts"], cwd=d, capture_output=True, text=True, timeout=120)
    return p.stdout.strip() if p.returncode == 0 else f"ERROR:{p.stderr[-400:]}"

def apply(text, edits):
    for e in edits:
        n = text.count(e["find"])
        if n == 0:
            return None, f"edit not found: {e['find'][:50]!r}"
        text = text.replace(e["find"], e["replace"]) if e.get("all") else text.replace(e["find"], e["replace"], 1)
    return text, None

for fx in ["limiter", "normalize", "sync"]:
    src = W / "fixtures" / fx
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp) / fx
        shutil.copytree(src, d)
        baseline = probe(d)
        if baseline.startswith("ERROR"):
            print(f"{fx}: BASELINE PROBE FAILED\n{baseline}"); continue
        print(f"\n{fx}  (baseline probe {len(baseline)} chars)")
        target = d / json.loads((src / "refactors.json").read_text())[0]["file"]
        original = target.read_text()

        for r in json.loads((src / "refactors.json").read_text()):
            target.write_text(original)
            new, err = apply(original, r["edits"])
            if err: print(f"  {r['id']:26s} BROKEN — {err}"); continue
            target.write_text(new)
            got = probe(d)
            target.write_text(original)
            same = got == baseline
            print(f"  {r['id']:26s} {'behaviour preserved' if same else 'CHANGES BEHAVIOUR — unusable'}")
            if not same and got.startswith("ERROR"): print(f"      {got[:300]}")

        # every mutant must still be detectable, i.e. actually change behaviour
        changed, silent = 0, []
        for m in json.loads((src / "mutants.json").read_text()):
            target.write_text(original)
            if m["find"] not in original: silent.append(m["id"] + "(missing)"); continue
            target.write_text(original.replace(m["find"], m["replace"], 1))
            got = probe(d)
            target.write_text(original)
            if got == baseline: silent.append(m["id"])
            else: changed += 1
        print(f"  mutants observable by the probe: {changed}/{changed + len(silent)}"
              + (f"  invisible: {', '.join(silent)}" if silent else ""))
