#!/usr/bin/env python3
"""Mechanically verify each adversary's escape claim. Trust nothing.

Valid escape = (a) case source is pristine, (b) find applies exactly once,
(c) full suite GREEN with mutation applied, (d) probe output DIFFERS between
original and mutated source, and the probe itself exits 0 both times.
"""
import hashlib, json, pathlib, shutil, subprocess, sys, tempfile

W = pathlib.Path(__file__).resolve().parent.parent  # the evals/ directory
manifest = json.loads((W/"results"/"it7-manifest.json").read_text())

def run(cmd, cwd, timeout=240):
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr)
    except subprocess.TimeoutExpired:
        return 124, "TIMEOUT"

results = []
for m in manifest:
    case = W/"iteration-7"/"break"/m["case"]
    row = dict(m)
    esc = case/"escape.json"
    if not esc.exists():
        row.update(valid=False, why="no escape.json submitted"); results.append(row); continue
    try:
        e = json.loads(esc.read_text())
    except json.JSONDecodeError as ex:
        row.update(valid=False, why=f"escape.json unparseable: {ex}"); results.append(row); continue
    row["rationale"] = e.get("rationale","")

    pristine = (W/"fixtures"/m["fixture"]/"src"/f"{m['module']}.ts").read_bytes()
    if (case/"src"/f"{m['module']}.ts").read_bytes() != pristine:
        row.update(valid=False, why="case source not restored to pristine"); results.append(row); continue
    src = pristine.decode()
    if src.count(e.get("find","")) != 1:
        row.update(valid=False, why=f"find appears {src.count(e.get('find',''))} times, need exactly 1"); results.append(row); continue
    if not (case/"probe.ts").exists():
        row.update(valid=False, why="no probe.ts"); results.append(row); continue

    with tempfile.TemporaryDirectory() as tmp:
        orig = pathlib.Path(tmp)/"orig"; shutil.copytree(case, orig)
        rc_o, out_o = run(["bun","probe.ts"], orig)
        mut = pathlib.Path(tmp)/"mut"; shutil.copytree(case, mut)
        t = mut/"src"/f"{m['module']}.ts"
        t.write_text(src.replace(e["find"], e["replace"], 1))
        rc_g, log_g = run(["bun","test"], mut)
        rc_m, out_m = run(["bun","probe.ts"], mut)

    row["suite_green_after_mutation"] = rc_g == 0
    row["probe_ok"] = rc_o == 0 and rc_m == 0
    row["probe_differs"] = out_o.strip() != out_m.strip()
    row["valid"] = row["suite_green_after_mutation"] and row["probe_ok"] and row["probe_differs"]
    if not row["valid"]:
        row["why"] = ("suite went RED under mutation — escape refuted" if rc_g != 0 else
                      "probe errored" if not row["probe_ok"] else "probe output identical — no behaviour change proven")
    row["find"] = e["find"][:120]; row["replace"] = e["replace"][:120]
    row["probe_orig"] = out_o.strip()[-400:]; row["probe_mut"] = out_m.strip()[-400:]
    results.append(row)

out = W/"results"/"escapes-verified.json"
out.write_text(json.dumps(results, indent=2))
for r in results:
    tag = "VALID  " if r.get("valid") else "invalid"
    print(f"{tag} {r['case']:8s} {r['arm']:9s} {r['fixture']:10s} {r.get('why','')}")
print(f"\n{sum(1 for r in results if r.get('valid'))}/{len(results)} escapes verified -> {out}")
