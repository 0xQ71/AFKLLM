"""Summarize C:\\Models\\_bench\\results.jsonl into a Markdown table (stdout, or --out FILE)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def g(d: dict, *path, default=None):
    for p in path:
        if not isinstance(d, dict) or p not in d:
            return default
        d = d[p]
    return d


def fmt(v, nd=0, suffix=""):
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v:.{nd}f}{suffix}"
    return f"{v}{suffix}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default=r"C:\Models\_bench\results.jsonl")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    rows = [json.loads(l) for l in Path(a.results).read_text(encoding="utf-8").splitlines() if l.strip()]

    lines = [
        "| Model | Flags | ctx | VRAM MiB | tg short t/s | MTP acc | pp@16K t/s | tg@16K t/s | append re-proc tok / s | "
        "mutated-system re-proc tok / s | tools ok | fill tok · pp t/s · tg t/s · peak MiB |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for r in rows:
        res = r.get("results") or {}
        flags = r.get("flags") or {}
        notable = []
        for k in ("n-cpu-moe", "spec-type", "cache-type-k", "fit"):
            if k in flags and flags[k] not in (None, "__off__"):
                notable.append(f"{k}={flags[k]}")
            elif flags.get(k) == "__off__":
                notable.append(f"{k}=off")
        if r.get("tag"):
            notable.append(f"[{r['tag']}]")
        if "load_error" in r:
            err = r["load_error"].splitlines()[0][:80]
            lines.append(f"| {r['label']} | {' '.join(notable)} | {r['ctx']} | — | LOAD FAILED: {err} |||||||| ")
            continue
        fill = res.get("fill") or {}
        fill_s = "—"
        if fill and "error" not in fill:
            fill_s = (f"{fill.get('prompt_n')} · {fmt(fill.get('prompt_per_second'))} · "
                      f"{fmt(fill.get('predicted_per_second'), 1)} · {fill.get('vram_peak_mib')}")
        elif fill:
            fill_s = "ERROR"
        cache = res.get("cache") or {}
        mut = res.get("mutate") or {}
        tools = res.get("tools") or {}
        lines.append("| " + " | ".join([
            r["label"], " ".join(notable), str(r["ctx"]), str(r.get("vram_loaded_mib", "—")),
            fmt(g(res, "decode", "predicted_per_second"), 1),
            fmt(g(res, "decode", "draft_accept_rate"), 2),
            fmt(g(res, "depth", "prompt_per_second")),
            fmt(g(res, "depth", "predicted_per_second"), 1),
            f"{cache.get('prompt_n', '—')} / {fmt(cache.get('wall_s'), 1)}" if cache else "—",
            f"{mut.get('prompt_n', '—')} / {fmt(mut.get('wall_s'), 1)}" if mut else "—",
            f"{tools.get('valid')}/{tools.get('trials')}" if tools else "—",
            fill_s,
        ]) + " |")
    text = "\n".join(lines) + "\n"
    if a.out:
        Path(a.out).write_text(text, encoding="utf-8")
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
