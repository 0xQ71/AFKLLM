"""Stage 0 benchmark: what each candidate model actually does on this machine.

For one model profile it starts llama-server, then measures:
  decode     short coding prompt -> generation t/s (+ MTP draft acceptance when on)
  depth      prefill t/s and decode t/s with N tokens of real repo code in the prompt
  cache      follow-up turn that only APPENDS -> how many prompt tokens are re-processed
  mutate     same follow-up but the system prompt changed at the top (what the app does
             today with injectChecklistIntoSystem) -> cost of a broken prefix
  tools      structured tool_calls reliability over several trials
  fill       fill the context to ~85% and decode, proving the ctx really fits (no OOM)
  needle     recall six facts hidden at 5..95% depth (~100K tokens) — does a quantized KV cache keep details

Results are appended to <root>/_bench/results.jsonl and printed as a summary.

  python -u scripts/stage0/bench.py --profile ornith
  python -u scripts/stage0/bench.py --profile q36moe --ctx 131072 --set n-cpu-moe=20
  python -u scripts/stage0/bench.py --profile q38nvfp4 --ctx 32768 --tests decode,tools
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(r"C:\Models")
LLAMA = ROOT / "llama.cpp" / "b12063" / "llama-server.exe"
REPO = Path(__file__).resolve().parents[2]
PORT = 18181

# Sampling: coding-precise settings from each model card.
QWEN_CODE = {"temperature": 0.6, "top_p": 0.95, "top_k": 20, "min_p": 0.0, "presence_penalty": 0.0}
ORNITH_CODE = {"temperature": 0.6, "top_p": 0.95, "top_k": 20, "min_p": 0.0, "presence_penalty": 0.0}

PROFILES: dict[str, dict] = {
    "ornith": {
        "label": "Ornith 1.5 9B MTP NVFP4",
        "model": ROOT / "protoLabsAI__Ornith-1.5-9B-MTP-GGUF" / "Ornith-1.5-9B-MTP-NVFP4.gguf",
        "ctx": 131072,
        # MTP only wins at full offload, so -fit off + explicit -ngl.
        "args": {"n-gpu-layers": "99", "fit": "off", "spec-type": "draft-mtp", "spec-draft-n-max": "3"},
        "sampling": ORNITH_CODE,
    },
    "q36moe": {
        "label": "Qwen3.6 35B-A3B MXFP4 NoMTP",
        "model": ROOT / "FreedomAISVR__Qwen3.6-35B-A3B-MXFP4-MOE-NoMTP-GGUF" / "qwen3.6-35b-a3b-mxfp4-moe-nomtp.gguf",
        "ctx": 131072,
        "args": {"n-gpu-layers": "99", "fit": "off", "n-cpu-moe": "18", "ubatch-size": "2048", "threads": "8"},
        "sampling": QWEN_CODE,
    },
    "q38nvfp4": {
        "label": "Qwen3.8 27B NVFP4 MTP VERY-LOW",
        "model": ROOT / "esatapedico__Qwen3.8-27B-NVFP4-MTP-GGUF" / "Qwen3.8-27B-NVFP4-MTP-VERY-LOW.gguf",
        "ctx": 8192,  # 32K spills out of 16 GB VRAM (measured: 12 t/s)
        "args": {"n-gpu-layers": "99", "fit": "off", "spec-type": "draft-mtp", "spec-draft-n-max": "3"},
        "sampling": QWEN_CODE,
    },
    "q38q3": {
        "label": "Qwen3.8 27B UD-Q3_K_XL",
        "model": ROOT / "unsloth__Qwen3.8-27B-GGUF" / "Qwen3.8-27B-UD-Q3_K_XL.gguf",
        "ctx": 65536,
        "args": {"n-gpu-layers": "99", "fit": "off"},
        "sampling": QWEN_CODE,
    },
    # 27B second chance: same weights + Unsloth's separate MTP draft head (-md), and baa-ai's mixed quant.
    "q38m": {
        "label": "Qwen3.8 27B UD-Q3_K_XL + MTP head",
        "model": ROOT / "unsloth__Qwen3.8-27B-GGUF" / "Qwen3.8-27B-UD-Q3_K_XL.gguf",
        "ctx": 65536,
        "args": {"n-gpu-layers": "99", "fit": "off", "spec-type": "draft-mtp", "spec-draft-n-max": "3",
                 "model-draft": str(ROOT / "unsloth__Qwen3.8-27B-GGUF" / "mtp-Qwen3.8-27B-Q4_0.gguf"),
                 "n-gpu-layers-draft": "99", "cache-type-k": "q4_0", "cache-type-v": "q4_0"},
        "sampling": QWEN_CODE,
    },
    "q38baa": {
        "label": "Qwen3.8 27B baa-ai RAM-13GB + MTP head",
        "model": ROOT / "baa-ai__Qwen3.8-27B-RAM-13GB-GGUF" / "Qwen3.8-27B-RAM-13GB.gguf",
        "ctx": 65536,
        "args": {"n-gpu-layers": "99", "fit": "off", "spec-type": "draft-mtp", "spec-draft-n-max": "3",
                 "model-draft": str(ROOT / "unsloth__Qwen3.8-27B-GGUF" / "mtp-Qwen3.8-27B-Q4_0.gguf"),
                 "n-gpu-layers-draft": "99", "cache-type-k": "q4_0", "cache-type-v": "q4_0"},
        "sampling": QWEN_CODE,
    },
    # baa-ai + the unsloth MTP layer grafted in (scripts/stage0/graft-mtp.py): built-in MTP shares the main
    # output head/context, so the draft's own output.weight (521 MiB), context and f16 KV are gone.
    "q38baamtp": {
        "label": "Qwen3.8 27B baa-ai RAM-13GB + grafted MTP",
        "model": ROOT / "baa-ai__Qwen3.8-27B-RAM-13GB-GGUF" / "Qwen3.8-27B-RAM-13GB-MTP.gguf",
        "ctx": 131072,
        "args": {"n-gpu-layers": "99", "fit": "off", "spec-type": "draft-mtp", "spec-draft-n-max": "3",
                 "ubatch-size": "256", "cache-type-k": "q4_0", "cache-type-v": "q4_0",
                 # the MTP layer still gets its own KV, f16 by default (0.5 GiB at 128K)
                 "cache-type-k-draft": "q4_0", "cache-type-v-draft": "q4_0"},
        "sampling": QWEN_CODE,
    },
    # same + unsloth's imatrix Q5_K output head (834 MiB) instead of baa-ai's Q6_K (995 MiB): -161 MiB VRAM
    "q38baamtpo5": {
        "label": "Qwen3.8 27B baa-ai + grafted MTP + Q5_K head",
        "model": ROOT / "baa-ai__Qwen3.8-27B-RAM-13GB-GGUF" / "Qwen3.8-27B-RAM-13GB-MTP-o5.gguf",
        "ctx": 106496,  # = CLI profile q38: the largest context that stays fully on the GPU with MTP draft 3
        "args": {"n-gpu-layers": "99", "fit": "off", "spec-type": "draft-mtp", "spec-draft-n-max": "3",
                 "ubatch-size": "256", "cache-type-k": "q4_0", "cache-type-v": "q4_0",
                 "cache-type-k-draft": "q4_0", "cache-type-v-draft": "q4_0"},
        "sampling": QWEN_CODE,
    },
    # Ornith 1.5 NVFP4 + updated official MTP head, YaRN x4 over the native 262K => 1M window.
    "ornith1m": {
        "label": "Ornith 1.5 9B MTP NVFP4 newhead 1M (YaRN)",
        "model": ROOT / "Cobra91310__Ornith-1.5-9B-MTP-NVFP4-newhead" / "Ornith-1.5-9B-MTP-NVFP4.gguf",
        "ctx": 131072,
        "args": {"n-gpu-layers": "99", "fit": "off", "spec-type": "draft-mtp", "spec-draft-n-max": "3",
                 "rope-scaling": "yarn", "rope-scale": "4", "yarn-orig-ctx": "262144"},
        "sampling": ORNITH_CODE,
    },
}

COMMON_ARGS = {
    "flash-attn": "on",
    "cache-type-k": "q8_0",
    "cache-type-v": "q8_0",
    "parallel": "1",
    "batch-size": "2048",
    "ubatch-size": "512",
    "jinja": None,
    "no-webui": None,
    # same per-step thinking ceiling as the CLI (src/core/server.ts)
    "reasoning-budget": "16384",
    "reasoning-budget-message": "I have thought about this enough. Time to act on it.",
}

TOOLS = [
    {"type": "function", "function": {
        "name": "write_file", "description": "Create or overwrite a file in the project.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "Path relative to project root"},
            "content": {"type": "string", "description": "Full file content"}},
            "required": ["path", "content"]}}},
    {"type": "function", "function": {
        "name": "run_command", "description": "Run a PowerShell command in the project root and return its output.",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string"}}, "required": ["command"]}}},
    {"type": "function", "function": {
        "name": "read_file", "description": "Read a file from the project.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string"}}, "required": ["path"]}}},
]

SYSTEM = (
    "You are a coding agent working in a local repository on Windows. "
    "Use the provided tools to act; do not describe actions you could take with a tool. "
    "Keep answers short."
)


# ---------------------------------------------------------------- helpers

def log(msg: str) -> None:
    print(time.strftime("[%H:%M:%S] ") + msg, flush=True)


def post(path: str, body: dict, timeout: float = 1800) -> dict:
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


# Live echo of what the model writes (thinking + answer), line by line, so the bench window shows the work
# itself and not only progress numbers. AFK_BENCH_ECHO=0 turns it off.
ECHO = os.environ.get("AFK_BENCH_ECHO", "1") != "0"


class Echo:
    WIDTH = 150

    def __init__(self):
        self.kind = ""
        self.buf = ""

    def _emit(self, line: str) -> None:
        tag = "┊" if self.kind == "think" else "│"
        print(f"   {tag} {line}", flush=True)

    def feed(self, kind: str, text: str) -> None:
        if not ECHO or not text:
            return
        if kind != self.kind:
            self.flush()
            self.kind = kind
            print(f"   ── {'thinking' if kind == 'think' else 'answer'} ──", flush=True)
        self.buf += text
        while "\n" in self.buf or len(self.buf) > self.WIDTH:
            if "\n" in self.buf and self.buf.index("\n") <= self.WIDTH:
                line, self.buf = self.buf.split("\n", 1)
            else:
                cut = self.buf.rfind(" ", 0, self.WIDTH)
                cut = cut if cut > 40 else self.WIDTH
                line, self.buf = self.buf[:cut], self.buf[cut:].lstrip(" ")
            if line.strip():
                self._emit(line)

    def flush(self) -> None:
        if ECHO and self.buf.strip():
            self._emit(self.buf)
        self.buf = ""


def post_stream(path: str, body: dict, timeout: float = 1800) -> dict:
    """Streaming chat completion; echoes deltas live and returns the same shape as the non-streaming call."""
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}", data=json.dumps({**body, "stream": True}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    content, reasoning, finish, timings_, echo = [], [], None, None, Echo()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            ev = json.loads(data)
            if ev.get("timings"):
                timings_ = ev["timings"]
            for ch in ev.get("choices") or []:
                d = ch.get("delta") or {}
                if d.get("reasoning_content"):
                    reasoning.append(d["reasoning_content"])
                    echo.feed("think", d["reasoning_content"])
                if d.get("content"):
                    content.append(d["content"])
                    echo.feed("answer", d["content"])
                finish = ch.get("finish_reason") or finish
    echo.flush()
    msg = {"role": "assistant", "content": "".join(content)}
    if reasoning:
        msg["reasoning_content"] = "".join(reasoning)
    return {"choices": [{"message": msg, "finish_reason": finish}], "timings": timings_ or {}}


def get(path: str, timeout: float = 5) -> tuple[int, str]:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception:
        return 0, ""


def vram_used_mib() -> int:
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], text=True)
        return int(out.strip().splitlines()[0])
    except Exception:
        return -1


def gpu_stats() -> tuple[int, int, int]:
    """(used MiB, total MiB, util %) or (-1, -1, -1)."""
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total,utilization.gpu",
             "--format=csv,noheader,nounits"], text=True)
        u, t, g = (int(x) for x in out.strip().splitlines()[0].split(","))
        return u, t, g
    except Exception:
        return -1, -1, -1


def gpu_process_mem_mib(pid: int) -> tuple[int, int]:
    """(dedicated, shared) GPU memory of one process from the Windows 'GPU Process Memory' counters.
    Shared above ~250 MiB means the driver has spilled this process's VRAM into system RAM."""
    try:
        ps = (rf"$c=(Get-Counter '\GPU Process Memory(pid_{pid}*)\*' -ErrorAction SilentlyContinue).CounterSamples;"
              "$d=($c | ? Path -like '*dedicated usage' | Measure CookedValue -Sum).Sum;"
              "$s=($c | ? Path -like '*shared usage' | Measure CookedValue -Sum).Sum;"
              "'{0} {1}' -f [int]($d/1MB), [int]($s/1MB)")
        out = subprocess.check_output(["powershell", "-NoProfile", "-Command", ps], text=True, timeout=30)
        d, sh = out.split()
        return int(d), int(sh)
    except Exception:
        return -1, -1


SPILL_SHARED_MIB = 300  # measured baseline for a llama-server that fits: ~180-215 MiB shared (host-pinned buffers)

PROMPT_RE = re.compile(r"prompt processing, n_tokens =\s*(\d+), progress = ([\d.]+), t =\s*([\d.]+) s / ([\d.]+) tokens per second")
GEN_RE = re.compile(r"n_gen =\s*(\d+), tg =\s*([\d.]+) t/s")


class LiveView:
    """Echo what llama-server is doing right now (prefill %, decode t/s, VRAM, GPU load) to the console.

    Tails the server log; prints a line only when there is news, so the console doubles as a readable log.
    Warns once when VRAM is ~full: on Windows the driver then silently spills into system RAM and every
    number after that is 10-100x slower than the GPU can do.
    """

    def __init__(self, log_path: Path, every: float = 3.0, on_spill=None):
        self.log_path = log_path
        self.every = every
        # Spill guard: once VRAM is full and the prefill rate between samples drops below 25% of the best
        # seen for this prompt (for 3 samples in a row), the run is measuring system RAM, not the GPU —
        # call on_spill (stops the server) instead of waiting up to an hour for a number we would discard.
        self.on_spill = on_spill
        self.spilled = False
        self._prev: tuple[int, float] | None = None
        self._best = 0.0
        self._slow = 0
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)
        self._pos = 0
        self._warned = False

    def _new_lines(self) -> list[str]:
        try:
            with open(self.log_path, "r", encoding="utf-8", errors="replace") as f:
                f.seek(self._pos)
                data = f.read()
                self._pos = f.tell()
            return data.splitlines()
        except Exception:
            return []

    def _run(self):
        last = ""
        while not self._stop.wait(self.every):
            lines = self._new_lines()
            msg = ""
            for ln in reversed(lines):
                m = PROMPT_RE.search(ln)
                if m:
                    n, prog, t, tps = int(m[1]), float(m[2]), float(m[3]), float(m[4])
                    total = int(n / prog) if prog > 0 else 0
                    eta = (total - n) / tps if tps > 0 else 0
                    msg = f"prefill {n}/{total} tok ({prog * 100:.0f}%) · {tps:.0f} t/s · {t:.0f}s · ETA {eta:.0f}s"
                    self._guard(n, t)
                    break
                m = GEN_RE.search(ln)
                if m:
                    msg = f"generating · {m[1]} tok · {float(m[2]):.1f} t/s"
                    break
            used, total_mib, util = gpu_stats()
            if used > 0 and used >= total_mib - 350 and not self._warned:
                self._warned = True
                log(f"   ⚠ VRAM {used}/{total_mib} MiB — memory is full, the driver spills into system RAM (expect a big slowdown)")
            if msg and msg != last:
                log(f"   ↳ {msg} · VRAM {used / 1024:.1f}/{total_mib / 1024:.1f} GB · GPU {util}%")
                last = msg

    def _guard(self, n: int, t: float) -> None:
        prev, self._prev = self._prev, (n, t)
        if not prev or n <= prev[0] or t <= prev[1]:  # new prompt (or no progress): restart the baseline
            if prev and n < prev[0]:
                self._best, self._slow = 0.0, 0
            return
        rate = (n - prev[0]) / (t - prev[1])
        self._best = max(self._best, rate)
        self._slow = self._slow + 1 if self._warned and rate < 0.25 * self._best else 0
        if self._slow >= 3 and not self.spilled and self.on_spill:
            self.spilled = True
            log(f"   ✖ SPILL: prefill fell to {rate:.0f} t/s (best {self._best:.0f}) with VRAM full — stopping this run")
            self.on_spill()

    def __enter__(self):
        self._t.start()
        return self

    def __exit__(self, *a):
        self._stop.set()
        self._t.join(timeout=5)


class VramPeak:
    def __init__(self):
        self.peak = 0
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self._stop.is_set():
            self.peak = max(self.peak, vram_used_mib())
            time.sleep(0.5)

    def __enter__(self):
        self._t.start()
        return self

    def __exit__(self, *a):
        self._stop.set()
        self._t.join(timeout=2)


def corpus_text() -> str:
    parts = []
    for p in sorted((REPO / "src").rglob("*")):
        if p.suffix in (".ts", ".tsx") and p.is_file():
            parts.append(f"// FILE: {p.relative_to(REPO).as_posix()}\n" + p.read_text(encoding="utf-8", errors="replace"))
    return "\n\n".join(parts)


def text_of_tokens(corpus: str, n_tokens: int) -> str:
    """Cut the corpus to about n_tokens using the server tokenizer (one calibration pass)."""
    probe = corpus[: 400_000]
    toks = len(post("/tokenize", {"content": probe})["tokens"])
    chars_per_tok = len(probe) / max(1, toks)
    want = int(n_tokens * chars_per_tok)
    if want > len(corpus):
        reps = want // len(corpus) + 1
        corpus = (corpus + "\n\n") * reps
    return corpus[:want]


def chat(messages: list[dict], sampling: dict, max_tokens: int, tools=None, thinking=False,
         timeout: float = 1800) -> tuple[dict, float]:
    body = {
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": False,
        "cache_prompt": True,
        "chat_template_kwargs": {"enable_thinking": thinking},
        **sampling,
    }
    if tools:
        body["tools"] = tools
    t0 = time.time()
    if tools:  # tool-call tests keep the plain call: they score the exact non-streamed message
        res = post("/v1/chat/completions", body, timeout=timeout)
    else:
        res = post_stream("/v1/chat/completions", body, timeout=timeout)
    return res, time.time() - t0


def timings(res: dict) -> dict:
    t = res.get("timings") or {}
    keep = ("prompt_n", "prompt_ms", "prompt_per_second", "predicted_n", "predicted_ms",
            "predicted_per_second", "draft_n", "draft_n_accepted", "cache_n")
    out = {k: round(v, 2) if isinstance(v, float) else v for k, v in t.items() if k in keep}
    if t.get("draft_n"):
        out["draft_accept_rate"] = round(t.get("draft_n_accepted", 0) / t["draft_n"], 3)
    return out


# ---------------------------------------------------------------- server

class Server:
    def __init__(self, profile: dict, ctx: int, overrides: dict[str, str | None], log_path: Path):
        self.args = {**COMMON_ARGS, **profile["args"], **overrides, "ctx-size": str(ctx)}
        self.model = profile["model"]
        self.log_path = log_path
        self.proc: subprocess.Popen | None = None

    def cmdline(self) -> list[str]:
        cmd = [str(LLAMA), "-m", str(self.model), "--host", "127.0.0.1", "--port", str(PORT)]
        for k, v in self.args.items():
            if v == "__off__":
                continue
            cmd.append(f"--{k}")
            if v is not None:
                cmd.append(v)
        return cmd

    def start(self, timeout: float = 600) -> float:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._logf = open(self.log_path, "w", encoding="utf-8", errors="replace")
        cmd = self.cmdline()
        self._logf.write(" ".join(cmd) + "\n\n")
        self._logf.flush()
        t0 = time.time()
        self.proc = subprocess.Popen(cmd, cwd=str(LLAMA.parent), stdout=self._logf, stderr=subprocess.STDOUT,
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        last_note = t0
        while time.time() - t0 < timeout:
            if time.time() - last_note >= 5:
                last_note = time.time()
                used, total, _ = gpu_stats()
                log(f"   ↳ loading… {time.time() - t0:.0f}s · VRAM {used / 1024:.1f}/{total / 1024:.1f} GB")
            if self.proc.poll() is not None:
                raise RuntimeError(f"llama-server exited with {self.proc.returncode} during load:\n{self.tail()}")
            code, _ = get("/health")
            if code == 200:
                return time.time() - t0
            time.sleep(0.5)
        raise RuntimeError("llama-server load timeout")

    def tail(self, n: int = 25) -> str:
        try:
            lines = self.log_path.read_text(encoding="utf-8", errors="replace").splitlines()
            return "\n".join(lines[-n:])
        except Exception:
            return ""

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if getattr(self, "_logf", None):
            self._logf.close()


# ---------------------------------------------------------------- tests

def t_decode(p: dict) -> dict:
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": "Write a Python LRU cache class with get/put and O(1) operations, "
                                         "plus 5 unittest cases. Code only."}]
    res, wall = chat(msgs, p["sampling"], 768)
    return {"wall_s": round(wall, 1), **timings(res)}


def t_depth(p: dict, corpus: str, depth: int, state: dict) -> dict:
    code = text_of_tokens(corpus, depth)
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": "Here is the source of the project:\n\n" + code +
             "\n\nIn 3 sentences: what does runAgentTurn do?"}]
    res, wall = chat(msgs, p["sampling"], 160)
    state["depth_msgs"] = msgs + [{"role": "assistant", "content": res["choices"][0]["message"].get("content") or ""}]
    return {"target_tokens": depth, "wall_s": round(wall, 1), **timings(res)}


def t_cache(p: dict, state: dict) -> dict:
    msgs = state["depth_msgs"] + [{"role": "user", "content": "And what does LlamaProcessManager do? One sentence."}]
    res, wall = chat(msgs, p["sampling"], 80)
    return {"wall_s": round(wall, 1), **timings(res)}


def t_mutate(p: dict, state: dict) -> dict:
    msgs = [dict(m) for m in state["depth_msgs"]]
    msgs[0]["content"] = "## Checklist\n- [x] read files\n- [ ] answer\n\n" + msgs[0]["content"]
    msgs.append({"role": "user", "content": "And what does LlamaProcessManager do? One sentence."})
    res, wall = chat(msgs, p["sampling"], 80)
    return {"wall_s": round(wall, 1), **timings(res)}


def t_tools(p: dict, trials: int = 5) -> dict:
    ok = 0
    details = []
    for i in range(trials):
        msgs = [{"role": "system", "content": SYSTEM},
                {"role": "user", "content": f"Create hello{i}.py that prints 'hi {i}', then run it with python."}]
        try:
            res, wall = chat(msgs, p["sampling"], 1024, tools=TOOLS, thinking=False)
            msg = res["choices"][0]["message"]
            calls = msg.get("tool_calls") or []
            valid = False
            if calls:
                fn = calls[0]["function"]
                args = json.loads(fn["arguments"]) if isinstance(fn["arguments"], str) else fn["arguments"]
                valid = fn["name"] == "write_file" and "print" in args.get("content", "") and \
                    args.get("path", "").endswith(".py")
            ok += valid
            details.append({"calls": [c["function"]["name"] for c in calls], "valid": valid,
                            "leaked_text": bool((msg.get("content") or "").strip() and not calls),
                            "wall_s": round(wall, 1)})
        except Exception as e:
            details.append({"error": str(e)[:200]})
    return {"valid": ok, "trials": trials, "details": details}


def t_fill(p: dict, corpus: str, ctx: int) -> dict:
    depth = int(ctx * 0.85)
    code = text_of_tokens(corpus, depth)
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": code + "\n\nName three files you saw above. One line."}]
    with VramPeak() as vp:
        res, wall = chat(msgs, p["sampling"], 64, timeout=3600)
    return {"target_tokens": depth, "wall_s": round(wall, 1), "vram_peak_mib": vp.peak, **timings(res)}


NEEDLES = [  # (name, port, code word, depth fraction) — fixed so runs are comparable
    ("Amber", 41873, "lantern", 0.05), ("Basalt", 52906, "thistle", 0.25), ("Cobalt", 30417, "harbor", 0.45),
    ("Dune", 61258, "quarry", 0.65), ("Ember", 27795, "violet", 0.85), ("Fjord", 48362, "saddle", 0.95),
]


def t_needle(p: dict, corpus: str, depth: int) -> dict:
    """Recall test for long context / quantized KV: six facts hidden at 5..95% depth of ~`depth` tokens of code.
    Thinking ON (as the agent runs). A needle counts only if both its port and its code word come back."""
    code = text_of_tokens(corpus, depth)
    parts, prev = [], 0
    for name, port, word, frac in NEEDLES:
        at = code.find("\n", int(len(code) * frac))
        at = len(code) if at < 0 else at
        parts.append(code[prev:at])
        parts.append(f"\n# ops note: relay station {name} listens on port {port}; its maintenance code word is "
                     f"\"{word}\".\n")
        prev = at
    parts.append(code[prev:])
    names = ", ".join(n for n, *_ in NEEDLES)
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": "".join(parts) + "\n\nSomewhere in the code above there are \"ops note\" "
             f"comments about relay stations ({names}). For each station give its port and code word, one per "
             "line as `Name: port word`. Use only what is written above."}]
    with VramPeak() as vp:
        res, wall = chat(msgs, p["sampling"], 12000, thinking=True, timeout=3600)
    answer = res["choices"][0]["message"].get("content") or ""
    hits = {}
    for name, port, word, frac in NEEDLES:
        line = next((l for l in answer.splitlines() if name.lower() in l.lower()), "")
        hits[f"{name}@{int(frac * 100)}%"] = str(port) in line and word in line.lower()
    return {"target_tokens": depth, "found": sum(hits.values()), "of": len(NEEDLES), "hits": hits,
            "answer": answer[:400], "wall_s": round(wall, 1), "vram_peak_mib": vp.peak, **timings(res)}


# ---------------------------------------------------------------- main

def parse_set(items: list[str]) -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    for s in items:
        k, _, v = s.partition("=")
        out[k.lstrip("-")] = v if _ else None
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", required=True, choices=sorted(PROFILES))
    ap.add_argument("--ctx", type=int, default=None)
    ap.add_argument("--set", action="append", default=[],
                    help="override/add a llama-server flag, e.g. n-cpu-moe=20, spec-type=__off__")
    ap.add_argument("--tests", default="decode,depth,cache,mutate,tools,fill")
    ap.add_argument("--depth", type=int, default=16384)
    ap.add_argument("--needle-depth", type=int, default=102400, help="tokens of code for the needle test")
    ap.add_argument("--tag", default="")
    args = ap.parse_args()
    if os.name == "nt":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass

    p = PROFILES[args.profile]
    ctx = args.ctx or p["ctx"]
    tests = [t.strip() for t in args.tests.split(",") if t.strip()]
    overrides = parse_set(args.set)
    if not p["model"].exists():
        log(f"model not downloaded yet: {p['model']}")
        return 2

    out_dir = ROOT / "_bench"
    stamp = time.strftime("%Y%m%d-%H%M%S")
    srv = Server(p, ctx, overrides, out_dir / f"{args.profile}-{stamp}.server.log")
    record: dict = {"profile": args.profile, "label": p["label"], "ctx": ctx, "tag": args.tag,
                    "time": stamp, "flags": srv.args, "llama": LLAMA.parent.name}
    vram0 = vram_used_mib()
    log(f"{p['label']} · ctx {ctx} · {' '.join(f'{k}={v}' for k, v in overrides.items())}")
    try:
        load_s = srv.start()
        record["load_s"] = round(load_s, 1)
        record["vram_idle_before_mib"] = vram0
        record["vram_loaded_mib"] = vram_used_mib()
        log(f"loaded in {load_s:.1f}s · VRAM {record['vram_loaded_mib']} MiB (desktop {vram0})")
        time.sleep(2)
        ded, shared = gpu_process_mem_mib(srv.proc.pid)
        record["proc_dedicated_mib"], record["proc_shared_mib"] = ded, shared
        if shared >= SPILL_SHARED_MIB:
            record["spill_at_load"] = True
            log(f"   ⚠ SPILL at load: llama-server has {shared} MiB in shared (system) memory, {ded} MiB dedicated "
                f"— everything below runs partly from system RAM")
        elif shared >= 0:
            log(f"   VRAM check: {ded} MiB dedicated, {shared} MiB shared — fits")
        corpus = corpus_text() if any(t in tests for t in ("depth", "fill", "cache", "mutate", "needle")) else ""
        state: dict = {}
        results: dict = {}
        about = {
            "decode": "short coding prompt, 768 tokens out",
            "depth": f"~{min(args.depth, int(ctx * 0.7))} tokens of repo code, then answer",
            "cache": "append one user turn (should reuse the KV cache)",
            "mutate": "change the top of the system prompt (forces full re-prefill)",
            "tools": "5 tool-calling trials",
            "fill": f"fill ~{int(ctx * 0.85)} tokens (85% of ctx)",
            "needle": f"recall 6 facts hidden at 5..95% of ~{min(args.needle_depth, int(ctx * 0.85))} tokens (thinking on)",
        }
        live = LiveView(srv.log_path, on_spill=srv.stop)
        live._pos = srv.log_path.stat().st_size  # skip the load chatter
        live.__enter__()
        for i, t in enumerate(tests, 1):
            log(f"▶ [{i}/{len(tests)}] {t}: {about.get(t, '')}")
            try:
                if t == "decode":
                    results[t] = t_decode(p)
                elif t == "depth":
                    results[t] = t_depth(p, corpus, min(args.depth, int(ctx * 0.7)), state)
                elif t == "cache":
                    if "depth_msgs" not in state:
                        t_depth(p, corpus, min(args.depth, int(ctx * 0.7)), state)
                    results[t] = t_cache(p, state)
                elif t == "mutate":
                    if "depth_msgs" not in state:
                        t_depth(p, corpus, min(args.depth, int(ctx * 0.7)), state)
                    results[t] = t_mutate(p, state)
                elif t == "tools":
                    results[t] = t_tools(p)
                elif t == "fill":
                    results[t] = t_fill(p, corpus, ctx)
                elif t == "needle":
                    results[t] = t_needle(p, corpus, min(args.needle_depth, int(ctx * 0.85)))
                log(f"{t:7s} {json.dumps(results[t], ensure_ascii=False)[:400]}")
            except Exception as e:
                results[t] = {"error": str(e)[:300], "server_tail": srv.tail(8)}
                log(f"{t:7s} ERROR {e}")
                if srv.proc and srv.proc.poll() is not None:
                    log("server died:\n" + srv.tail())
                    break
        live.__exit__()
        record["results"] = results
        if live.spilled:
            record["spill_abort"] = True
        record["vram_after_mib"] = vram_used_mib()
    except Exception as e:
        record["load_error"] = str(e)[:2000]
        log(f"LOAD FAILED: {e}")
    finally:
        srv.stop()
    with open(out_dir / "results.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    log(f"saved → {out_dir / 'results.jsonl'}")
    return 0 if "load_error" not in record else 1


if __name__ == "__main__":
    sys.exit(main())
