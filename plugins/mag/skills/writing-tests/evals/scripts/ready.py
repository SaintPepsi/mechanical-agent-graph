#!/usr/bin/env python3
"""A repair fixture ships with a seeded test file, so 'a .test.ts exists' proves nothing.
Compare against the seed hashes: an untouched seed means the agent has not written yet."""
import hashlib, pathlib, sys
W = pathlib.Path(__file__).resolve().parent.parent  # the evals/ directory
seeds = {hashlib.md5((W/"fixtures"/fx/"seed.test.ts").read_bytes()).hexdigest()
         for fx in ["limiter","normalize","sync","pricing","inventory"]}
seeds.add(hashlib.md5((W/"fixtures/legacy-coverage/src/duration.test.ts").read_bytes()).hexdigest())
it = W / (sys.argv[1] if len(sys.argv) > 1 else "iteration-4")
pending, done = [], 0
for e in sorted(it.glob("eval-*")):
    for arm in sorted(d for d in e.iterdir() if d.is_dir()):
        tf = list((arm/"run-1"/"outputs").rglob("*.test.ts"))
        if not tf or hashlib.md5(tf[0].read_bytes()).hexdigest() in seeds:
            pending.append(f"{e.name}/{arm.name}")
        else: done += 1
print(f"{done}/{done+len(pending)} written")
for p in pending: print("  pending:", p)
sys.exit(0 if not pending else 1)
