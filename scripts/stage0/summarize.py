r"""One table for all stage-0 evals (thinking ON): coder pass@1 + agent tasks + speed.

  python scripts/stage0/summarize.py [--out C:\Models\_bench\SUMMARY.md]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

B = Path(r"C:\Models\_bench")
# bench/coder profile -> CLI profile used by the agent runner
ALIAS = {"ornith1m": "ornith1m", "ornith": "ornith", "q36moe": "q36", "q38q3": "q38q3", "q38nvfp4": "q38mtp", "q38m": "q38m", "q38baa": "q38baa", "q38baamtp": "q38baamtp", "q38baamtpo5": "q38"}
LABEL = {
    "ornith1m": "Ornith 1.5 9B MTP NVFP4 1M (newhead+YaRN)",
    "ornith": "Ornith 1.5 9B MTP NVFP4 (protoLabs)",
    "q36": "Qwen3.6 35B-A3B MXFP4",
    "q38": "Qwen3.8 27B baa-ai + grafted MTP + Q5_K head @104K (CLI default)",
    "q38q3": "Qwen3.8 27B UD-Q3_K_XL",
    "q38mtp": "Qwen3.8 27B NVFP4 MTP (8K ctx)",
    "q38m": "Qwen3.8 27B UD-Q3_K_XL + MTP head",
    "q38baa": "Qwen3.8 27B baa-ai RAM-13GB + MTP head",
    "q38baamtp": "Qwen3.8 27B baa-ai RAM-13GB + grafted MTP",
}


def rows(name: str) -> list[dict]:
    p = B / name
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()] if p.exists() else []


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(B / "SUMMARY.md"))
    ap.add_argument("--since", default="", help="only records with time >= this stamp, e.g. 20261103-1700")
    ap.add_argument("--only", default="", help="comma-separated CLI profile names to show")
    a = ap.parse_args()

    coder = {ALIAS.get(r["profile"], r["profile"]): r for r in rows("coder-results.jsonl") if r["time"] >= a.since}
    agent: dict[str, dict[str, list[dict]]] = {}
    for r in rows("agent-results.jsonl"):
        if r["time"] >= a.since:
            prof = r["profile"]
            if prof == "q38" and r["time"] < "20261103-1930":  # CLI "q38" meant UD-Q3_K_XL before it became baa+MTP
                prof = "q38q3"
            agent.setdefault(prof, {}).setdefault(r["task"], []).append(r)

    def cell(runs: list[dict] | None) -> str:
        if not runs:
            return "—"
        marks = "".join("✅" if r["all_green"] else "❌" for r in runs)
        avg = sum(r["wall_s"] for r in runs) / len(runs)
        return f"{marks} {sum(r['all_green'] for r in runs)}/{len(runs)} · {avg:.0f}s"

    lines = [
        "# Stage 0 — models for the AFKLLM agent (thinking ON)",
        "",
        "Coder: 16 hidden-test Python problems, one shot. Agent: `afk -p --auto`; task 1 fix 6 bugs to pass 8 tests, "
        "task 2 implement a spec'd CLI feature (7 hidden tests), task 3 debug a crashing multi-file app "
        "(output must match on visible + hidden data).",
        "",
        "| Model | Coder | t/s | Agent T3 debug | Agent T2 feature | Agent T1 bugs |",
        "|---|---|---:|---|---|---|",
    ]
    shown = [x for x in a.only.split(",") if x] or list(LABEL)
    for prof in shown:
        label = LABEL.get(prof, prof)
        c = coder.get(prof)
        ag = agent.get(prof, {})
        lines.append(
            f"| {label} | {f'{c['passed']}/16 · {c['wall_s']:.0f}s' if c else '—'} | {c['gen_tps'] if c else '—'} "
            f"| {cell(ag.get('3'))} | {cell(ag.get('2'))} | {cell(ag.get('1'))} |")
    text = "\n".join(lines) + "\n"
    Path(a.out).write_text(text, encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
