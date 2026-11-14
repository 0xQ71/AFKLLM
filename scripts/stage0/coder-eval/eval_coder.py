r"""Quick coder eval: 16 hidden-test Python problems, one shot each, no tools, thinking ON (as the agent runs).

  python -u scripts/stage0/coder-eval/eval_coder.py ornith ornith1m q36 ...

Uses the bench.py profiles (same llama-server flags), prints every problem live, appends a summary to
C:\Models\_bench\coder-results.jsonl.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import bench  # noqa: E402
from problems import PROBLEMS  # noqa: E402

RESULTS = bench.ROOT / "_bench" / "coder-results.jsonl"
SYSTEM = "You are an expert Python programmer. Write correct, complete, idiomatic code."
ASK = ("\n\nImplement this in Python 3. Reply with a single ```python code block containing the complete "
       "implementation (with any imports it needs). No tests, no example usage, no explanation.")
FENCE = re.compile(r"```(?:python|py)?\s*\n(.*?)```", re.S)


def extract(text: str) -> str:
    blocks = FENCE.findall(text or "")
    return max(blocks, key=len) if blocks else (text or "")


def check(code: str, tests: str) -> tuple[bool, str]:
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "t.py"
        f.write_text(code + "\n\n" + tests, encoding="utf-8")
        try:
            p = subprocess.run([sys.executable, "-I", str(f)], cwd=d, capture_output=True, text=True, timeout=30)
        except subprocess.TimeoutExpired:
            return False, "timeout"
        if p.returncode == 0:
            return True, ""
        last = (p.stderr.strip().splitlines() or ["?"])[-1]
        return False, last[:160]


def run(profile_name: str) -> dict:
    p = bench.PROFILES[profile_name]
    stamp = time.strftime("%Y%m%d-%H%M%S")
    ctx = min(40960, p["ctx"])  # room for a 32K answer (thinking capped at 16K by the server)
    srv = bench.Server(p, ctx, {}, bench.ROOT / "_bench" / f"coder-{profile_name}-{stamp}.server.log")
    bench.log(f"===== {p['label']} =====")
    load = srv.start()
    bench.log(f"loaded in {load:.0f}s")
    passed, rows, toks, gen_s = 0, [], 0, 0.0
    t_all = time.time()
    try:
        for i, prob in enumerate(PROBLEMS, 1):
            msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prob["prompt"] + ASK}]
            res = None
            try:
                res, wall = bench.chat(msgs, p["sampling"], min(32768, ctx - 1024), thinking=True, timeout=1800)
                text = res["choices"][0]["message"].get("content") or ""
                t = res.get("timings") or {}
                toks += t.get("predicted_n", 0)
                gen_s += t.get("predicted_ms", 0) / 1000
                ok, err = check(extract(text), prob["tests"])
            except Exception as e:  # noqa: BLE001
                ok, err, wall = False, f"request failed: {e}"[:160], 0.0
            passed += ok
            fin = res["choices"][0].get("finish_reason") if isinstance(res, dict) else None
            rows.append({"id": prob["id"], "ok": ok, "err": err, "wall_s": round(wall, 1), "finish": fin,
                         "tokens": (res.get("timings") or {}).get("predicted_n") if isinstance(res, dict) else None})
            bench.log(f"  [{i:2d}/{len(PROBLEMS)}] {'PASS' if ok else 'FAIL'}  {prob['id']:<17} {wall:5.1f}s  {err}")
    finally:
        srv.stop()
    rec = {
        "profile": profile_name, "label": p["label"], "time": stamp, "thinking": True, "max_tokens": min(32768, ctx - 1024), "reasoning_budget": bench.COMMON_ARGS.get("reasoning-budget"), "passed": passed, "total": len(PROBLEMS),
        "wall_s": round(time.time() - t_all, 1), "gen_tps": round(toks / gen_s, 1) if gen_s else None,
        "problems": rows,
    }
    bench.log(f">>> {p['label']}: {passed}/{len(PROBLEMS)} · {rec['wall_s']:.0f}s · {rec['gen_tps']} t/s")
    with open(RESULTS, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    names = sys.argv[1:] or list(bench.PROFILES)
    recs = [run(n) for n in names]
    print("\n==================== coder summary ====================")
    for r in recs:
        print(f"{r['label']:<45} {r['passed']:2d}/{r['total']}  {r['wall_s']:5.0f}s  {r['gen_tps']} t/s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
