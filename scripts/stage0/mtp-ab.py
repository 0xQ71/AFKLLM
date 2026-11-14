r"""Does MTP change what the model writes? Same GGUF, same prompts, greedy decoding — once with MTP, once without.

Speculative decoding only decides how many tokens the main model verifies per pass; every kept token is the main
model's own choice. So with greedy sampling both runs should be identical, up to rare float differences between
batched (verify) and single-token kernels. A big, early divergence would point to a bug (e.g. the recurrent-state
rollback of the hybrid layers after a rejected draft).

  python -u scripts/stage0/mtp-ab.py [profile]      (default q38baamtp; results -> C:\Models\_bench\mtp-ab.jsonl)
"""
from __future__ import annotations

import difflib
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bench  # noqa: E402

GREEDY = {"temperature": 0.0, "top_k": 1, "top_p": 1.0, "min_p": 0.0, "seed": 1}
PROMPTS = [
    ("code", False, 700, "Write a Python function `merge_k_sorted(lists)` that merges k sorted lists using a heap. "
                         "Include type hints, a docstring and 3 doctest examples."),
    ("bug", False, 600, "This JavaScript has a bug:\n\nfunction sum(a){let s;for(const x of a)s+=x;return s}\n\n"
                        "Explain the bug and give the fixed code."),
    ("ru", False, 600, "Объясни простыми словами, чем процесс отличается от потока в операционной системе. "
                       "Приведи два примера."),
    ("plan", False, 600, "I need to add a dark-mode toggle to a React + Tailwind app. Give a short, concrete plan "
                         "with the files I would touch."),
    ("think", True, 3000, "A train leaves at 09:40 and arrives at 13:05 the same day, with a 25-minute stop. "
                          "How long was it actually moving? Answer with the number of minutes."),
]
OFF = {"spec-type": "__off__", "spec-draft-n-max": "__off__", "cache-type-k-draft": "__off__",
       "cache-type-v-draft": "__off__", "model-draft": "__off__", "n-gpu-layers-draft": "__off__"}


def run(profile: dict, overrides: dict, tag: str) -> dict[str, dict]:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    srv = bench.Server(profile, 32768, overrides, bench.ROOT / "_bench" / f"mtp-ab-{tag}-{stamp}.server.log")
    out: dict[str, dict] = {}
    try:
        bench.log(f"===== {tag}: loading {profile['label']} =====")
        bench.log(f"loaded in {srv.start():.0f}s")
        for name, think, max_tokens, prompt in PROMPTS:
            bench.log(f"▶ [{tag}] {name}")
            msgs = [{"role": "user", "content": prompt}]
            res, wall = bench.chat(msgs, GREEDY, max_tokens, thinking=think, timeout=900)
            m = res["choices"][0]["message"]
            t = bench.timings(res)
            out[name] = {"text": (m.get("reasoning_content") or "") + "\n<<answer>>\n" + (m.get("content") or ""),
                         "tps": t.get("predicted_per_second"), "accept": t.get("draft_accept_rate"),
                         "n": t.get("predicted_n")}
            bench.log(f"   {name}: {t.get('predicted_n')} tok · {t.get('predicted_per_second')} t/s"
                      + (f" · accept {t['draft_accept_rate']}" if t.get("draft_accept_rate") else ""))
    finally:
        srv.stop()
    return out


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    name = sys.argv[1] if len(sys.argv) > 1 else "q38baamtp"
    p = bench.PROFILES[name]
    on = run(p, {}, "mtp-on")
    off = run(p, OFF, "mtp-off")
    bench.log("===== MTP A/B (greedy) =====")
    rows = []
    for key, *_ in PROMPTS:
        a, b = on[key]["text"], off[key]["text"]
        same = a == b
        prefix = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
        ratio = difflib.SequenceMatcher(None, a, b).ratio()
        rows.append({"prompt": key, "identical": same, "first_diff_char": None if same else prefix,
                     "len_on": len(a), "len_off": len(b), "similarity": round(ratio, 4),
                     "tps_on": on[key]["tps"], "tps_off": off[key]["tps"], "accept": on[key]["accept"]})
        verdict = "IDENTICAL" if same else f"differs from char {prefix}/{min(len(a), len(b))} · similarity {ratio:.3f}"
        bench.log(f"   {key:6s} {verdict} · {on[key]['tps']} vs {off[key]['tps']} t/s")
        if not same:
            ctx = 80
            bench.log(f"      MTP on : …{a[max(0, prefix - ctx):prefix + ctx]!r}")
            bench.log(f"      MTP off: …{b[max(0, prefix - ctx):prefix + ctx]!r}")
    with open(bench.ROOT / "_bench" / "mtp-ab.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps({"time": time.strftime("%Y%m%d-%H%M%S"), "profile": name, "rows": rows,
                            "texts": {k: {"on": on[k]["text"], "off": off[k]["text"]} for k in on}},
                           ensure_ascii=False) + "\n")
    n_same = sum(r["identical"] for r in rows)
    bench.log(f">>> MTP A/B: {n_same}/{len(rows)} identical · saved → {bench.ROOT / '_bench' / 'mtp-ab.jsonl'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
