r"""Follow-up to mtp-ab.py: at the first token where the MTP-on and MTP-off greedy answers diverge, how sure was
the main model? Prints the top-5 next-token log-probabilities at that point, with MTP off and on.

A near tie (top-2 within ~0.5 nats) means the split is float noise between batched and single-token kernels
picking a different argmax — not MTP changing the model. A clear winner that one run did NOT pick would mean a bug.

  python -u scripts/stage0/mtp-tie.py [profile]      (reads the last record of C:\Models\_bench\mtp-ab.jsonl)
"""
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bench  # noqa: E402

import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("mtp_ab", Path(__file__).resolve().parent / "mtp-ab.py")
ab = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ab)

MARK = "\n<<answer>>\n"


def probe(prompt: str, think: bool, prefix: str) -> list[tuple[str, float]]:
    body = {
        "messages": [{"role": "user", "content": prompt}, {"role": "assistant", "content": prefix}],
        "max_tokens": 1, "stream": False, "logprobs": True, "top_logprobs": 5, "cache_prompt": False,
        "chat_template_kwargs": {"enable_thinking": think}, **ab.GREEDY,
    }
    res = bench.post("/v1/chat/completions", body, timeout=600)
    lp = res["choices"][0].get("logprobs") or {}
    content = lp.get("content") or []
    if not content:
        return []
    return [(t["token"], t["logprob"]) for t in content[0].get("top_logprobs", [])]


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    name = sys.argv[1] if len(sys.argv) > 1 else "q38baamtp"
    rec = [json.loads(l) for l in (bench.ROOT / "_bench" / "mtp-ab.jsonl").read_text(encoding="utf-8").splitlines()
           if l.strip()][-1]
    cases = []
    for key, think, _, prompt in ab.PROMPTS:
        on, off = rec["texts"][key]["on"], rec["texts"][key]["off"]
        if on == off or think:
            continue  # identical, or the split is inside the reasoning (prefill of reasoning is not portable)
        i = next((k for k, (x, y) in enumerate(zip(on, off)) if x != y), min(len(on), len(off)))
        if i < len(MARK):
            continue
        prefix = on[len(MARK):i]
        # back up to a whitespace boundary so the prefix ends on a token edge
        cut = max(prefix.rfind(" "), prefix.rfind("\n"))
        prefix = prefix[:cut] if cut > 0 else prefix
        cases.append((key, prompt, prefix, on[len(MARK) + len(prefix):i + 40], off[len(MARK) + len(prefix):i + 40]))
        # The wrong claim in the MTP-on "bug" answer ("... which results in a string concatenation") comes AFTER the
        # split. Ask the main model WITHOUT MTP the same question at that exact spot: if it also picks the wrong
        # continuation, the error is the quantized model's own, not something MTP introduced.
        anchor = "which results in"
        body = on[len(MARK):]
        if key == "bug" and anchor in body:
            j = body.index(anchor) + len(anchor)
            cases.append((key + "-claim", prompt, body[:j], body[j:j + 40], "(n/a: MTP-off took another path)"))
    out = {"time": time.strftime("%Y%m%d-%H%M%S"), "profile": name, "cases": {}}
    p = bench.PROFILES[name]
    for tag, overrides in (("mtp-off", ab.OFF), ("mtp-on", {})):
        srv = bench.Server(p, 32768, overrides, bench.ROOT / "_bench" / f"mtp-tie-{tag}-{out['time']}.server.log")
        try:
            bench.log(f"===== {tag}: loading =====")
            bench.log(f"loaded in {srv.start():.0f}s")
            for key, prompt, prefix, on_next, off_next in cases:
                top = probe(prompt, False, prefix)
                out["cases"].setdefault(key, {"prefix_tail": prefix[-80:], "on_next": on_next, "off_next": off_next})
                out["cases"][key][tag] = top
                gap = (top[0][1] - top[1][1]) if len(top) > 1 else float("nan")
                bench.log(f"   {key:5s} …{prefix[-50:]!r}")
                bench.log(f"         MTP-on continued {on_next[:30]!r} · MTP-off continued {off_next[:30]!r}")
                bench.log("         top: " + " · ".join(f"{t!r} {math.exp(l) * 100:.0f}%" for t, l in top[:4])
                          + f" · gap {gap:.2f} nats")
        finally:
            srv.stop()
    with open(bench.ROOT / "_bench" / "mtp-tie.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(out, ensure_ascii=False) + "\n")
    bench.log(f">>> saved → {bench.ROOT / '_bench' / 'mtp-tie.jsonl'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
