"""Stage 0 downloader: candidate GGUF models + a fresh llama.cpp CUDA build.

Shows a live console view (per-file and total: size, %, speed, elapsed, ETA),
resumes interrupted downloads from *.part files, verifies SHA-256 and writes a
machine-readable status file so progress can be watched from another process.

Usage:  python -u scripts/stage0/download-models.py [--root C:\\Models] [--only substr] [--flash]
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import sys
import threading
import time
import urllib.error
import subprocess
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

LLAMA_TAG = "b12063"
UA = "afkllm-stage0-downloader/1.0"
CHUNK = 8 * 1024 * 1024


@dataclass
class Item:
    label: str
    url: str
    dest: Path
    size: int = 0
    sha256: str | None = None
    extract_to: Path | None = None
    done_bytes: int = field(default=0, repr=False)


def hf(repo: str, path: str, label: str, root: Path, keep_path: bool = False) -> Item:
    return Item(
        label=label,
        url=f"https://huggingface.co/{repo}/resolve/main/{path}",
        dest=root / repo.replace("/", "__") / (Path(path) if keep_path else Path(path).name),
    )


COMFY_TAG = "v0.43.0"
COMFY_DIR = Path(r"C:\ComfyUI")  # app (python + torch) next to the weights on NVMe (moved off G: 2026-11-03)
QWEN_IMAGE = "Comfy-Org/Qwen-Image-2.1"


def build_plan(root: Path) -> list[Item]:
    """Default set: the llama.cpp runtime + image generation (ComfyUI + Qwen-Image 2.1 turbo for 16 GB)."""
    rt = root / "llama.cpp" / LLAMA_TAG
    gh = f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}"
    zips = root / "llama.cpp" / "_zips"
    cg = f"https://github.com/Comfy-Org/ComfyUI/releases/download/{COMFY_TAG}"
    return [
        Item("llama.cpp win-cuda-13.4", f"{gh}/llama-{LLAMA_TAG}-bin-win-cuda-13.4-x64.zip",
             zips / f"llama-{LLAMA_TAG}-bin-win-cuda-13.4-x64.zip", extract_to=rt),
        Item("cudart 13.4", f"{gh}/cudart-llama-bin-win-cuda-13.4-x64.zip",
             zips / f"cudart-llama-bin-win-cuda-13.4-x64-{LLAMA_TAG}.zip", extract_to=rt),
        # ---- image generation: swapped in while the LLM is unloaded, so the whole GPU is free.
        # User's pick: abenzerps uncensored Qwen-Image 2.1 DiT as Q8_0 GGUF (needs the ComfyUI-GGUF node), the
        # Comfy-Org Qwen3-VL 8B W4A8 text encoder (a llama.cpp Q6_K GGUF has no vision tower, so ComfyUI would
        # mis-detect it as plain Qwen3-8B), and the official VAE. ~14.6 GB of weights.
        Item("[image] ComfyUI portable (NVIDIA)", f"{cg}/ComfyUI_windows_portable_nvidia.7z",
             COMFY_DIR / "_zips" / f"ComfyUI_windows_portable_nvidia_{COMFY_TAG}.7z", extract_to=COMFY_DIR),
        img("abenzerps/Qwen-Image-2.1-Uncensored-Quantized", "qwen-image-2.1-UC-Q8_0.gguf", "diffusion_models",
            "[image] Qwen-Image 2.1 UC DiT Q8_0", root),
        img(QWEN_IMAGE, "text_encoders/qwen3vl_8b_w4a8.safetensors", "text_encoders",
            "[image] Qwen3-VL 8B text encoder W4A8", root),
        img(QWEN_IMAGE, "vae/qwen_image_2.1_vae_bf16.safetensors", "vae",
            "[image] Qwen-Image 2.1 VAE bf16", root),
    ]


FLASH_REPO = "ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF"


def flash_plan(root: Path) -> list[Item]:
    """The `flash` profile: Qwen3.8-Flash-Next IQ3_XXS (shard 1 = weights, shard 2 = the n-gram table) + the
    vision projector, all in <root>\\ISTA-DASLab__Qwen3.8-Flash-Next-GSQ-RCO-GGUF\\IQ3_XXS (where Strata's preset
    and src/core/server.ts look). ~76.7 GB."""
    q = root / FLASH_REPO.replace("/", "__") / "IQ3_XXS"
    base = f"https://huggingface.co/{FLASH_REPO}/resolve/main"
    names = [f"IQ3_XXS/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-0000{i}-of-00002.gguf" for i in (1, 2)]
    return [Item(f"[flash] {Path(n).name}", f"{base}/{n}", q / Path(n).name) for n in names] + [
        Item("[flash] mmproj-Qwen3.8-Flash-Next-BF16.gguf", f"{base}/mmproj-Qwen3.8-Flash-Next-BF16.gguf",
             q / "mmproj-Qwen3.8-Flash-Next-BF16.gguf"),
    ]


IMAGE_DIR = "Qwen-Image-2.1"  # C:\Models\Qwen-Image-2.1\{diffusion_models,text_encoders,vae}


def img(repo: str, path: str, sub: str, label: str, root: Path) -> Item:
    return Item(label=label, url=f"https://huggingface.co/{repo}/resolve/main/{path}",
                dest=root / IMAGE_DIR / sub / Path(path).name)


def stage0_candidates(root: Path) -> list[Item]:
    """The stage-0 LLM shortlist (kept for the record; most of these were benchmarked and deleted)."""
    return [
        # Small model first so benchmarking can start while the big ones download.
        hf("protoLabsAI/Ornith-1.5-9B-MTP-GGUF", "Ornith-1.5-9B-MTP-NVFP4.gguf",
           "Ornith 1.5 9B MTP NVFP4", root),
        hf("protoLabsAI/Ornith-1.5-9B-MTP-GGUF", "mmproj-Ornith-1.5-9B-BF16.gguf",
           "Ornith 1.5 9B mmproj", root),
        hf("FreedomAISVR/Qwen3.6-35B-A3B-MXFP4-MOE-NoMTP-GGUF", "qwen3.6-35b-a3b-mxfp4-moe-nomtp.gguf",
           "Qwen3.6 35B-A3B MXFP4 NoMTP", root),
        hf("FreedomAISVR/Qwen3.6-35B-A3B-MXFP4-MOE-GGUF", "qwen3.6-35b-a3b-mxfp4-moe-mmproj-f16.gguf",
           "Qwen3.6 35B-A3B mmproj", root),
        hf("esatapedico/Qwen3.8-27B-NVFP4-MTP-GGUF", "Qwen3.8-27B-NVFP4-MTP-VERY-LOW.gguf",
           "Qwen3.8 27B NVFP4 MTP VERY-LOW", root),
        hf("esatapedico/Qwen3.8-27B-NVFP4-MTP-GGUF", "mmproj-BF16.gguf",
           "Qwen3.8 27B mmproj", root),
        # Control quant: smaller than NVFP4, leaves room for long context on 16 GB.
        hf("unsloth/Qwen3.8-27B-GGUF", "Qwen3.8-27B-UD-Q3_K_XL.gguf",
           "Qwen3.8 27B UD-Q3_K_XL (long-ctx control)", root),
        # Ornith 1.5 NVFP4 body + the updated official MTP head (24 Aug). The "1M" part is YaRN x4 over the
        # native 262K, applied with llama-server flags (that is all satgeze's 1M builds do, in metadata).
        hf("Cobra91310/Ornith-1.5-9B-MTP-NVFP4-newhead", "Ornith-1.5-9B-MTP-NVFP4.gguf",
           "Ornith 1.5 9B MTP NVFP4 newhead (1M via YaRN)", root),
        # Second chance for the 27B: a separate MTP draft head (llama-server -md) for speed, and a per-tensor
        # mixed quant of the same size as UD-Q3_K_XL with better perplexity (6.02 vs IQ3_M 6.34).
        hf("unsloth/Qwen3.8-27B-GGUF", "MTP/mtp-Qwen3.8-27B-Q4_0.gguf",
           "[27B duel] Qwen3.8 27B MTP head Q4_0", root),
        hf("baa-ai/Qwen3.8-27B-RAM-13GB-GGUF", "Qwen3.8-27B-RAM-13GB.gguf",
           "[27B duel] Qwen3.8 27B baa-ai RAM-13GB", root),
    ]


# ---------------------------------------------------------------- metadata

def http_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def fill_metadata(items: list[Item]) -> None:
    trees: dict[str, dict[str, dict]] = {}
    gh_assets: dict[str, dict[str, dict]] | None = None
    for it in items:
        if "huggingface.co" in it.url:
            repo = it.url.split("huggingface.co/")[1].split("/resolve/")[0]
            path = it.url.split("/resolve/main/")[1]
            if repo not in trees:
                tree = http_json(f"https://huggingface.co/api/models/{repo}/tree/main?recursive=1")
                trees[repo] = {x["path"]: x for x in tree if x.get("type") == "file"}
            meta = trees[repo][path]
            it.size = int(meta.get("size") or 0)
            lfs = meta.get("lfs") or {}
            it.sha256 = lfs.get("oid") or lfs.get("sha256")
        else:
            # https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>
            owner_repo, tail = it.url.split("github.com/")[1].split("/releases/download/")
            tag = tail.split("/")[0]
            key = f"{owner_repo}@{tag}"
            if gh_assets is None:
                gh_assets = {}
            if key not in gh_assets:
                rel = http_json(f"https://api.github.com/repos/{owner_repo}/releases/tags/{tag}")
                gh_assets[key] = {a["name"]: a for a in rel["assets"]}
            a = gh_assets[key][it.url.rsplit("/", 1)[1]]
            it.size = int(a["size"])
            digest = a.get("digest") or ""
            it.sha256 = digest.split(":", 1)[1] if digest.startswith("sha256:") else None


# ---------------------------------------------------------------- display

def fmt_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:6.2f} {unit}" if unit == "GB" else f"{n:6.1f} {unit}"
        n /= 1024
    return f"{n:.2f} GB"


def fmt_time(s: float | None) -> str:
    if s is None or s != s or s == float("inf"):
        return "--:--:--"
    s = int(s)
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def bar(frac: float, width: int = 28) -> str:
    full = int(frac * width)
    return "█" * full + "░" * (width - full)


def set_title(text: str) -> None:
    if os.name == "nt":
        try:
            ctypes.windll.kernel32.SetConsoleTitleW(text)
        except Exception:
            pass


class Speed:
    """Moving-window speed so the number reacts to throttling but does not jitter."""

    def __init__(self, window: float = 6.0):
        self.window = window
        self.samples: list[tuple[float, int]] = []

    def add(self, t: float, total_bytes: int) -> float:
        self.samples.append((t, total_bytes))
        while len(self.samples) > 2 and t - self.samples[0][0] > self.window:
            self.samples.pop(0)
        (t0, b0), (t1, b1) = self.samples[0], self.samples[-1]
        return (b1 - b0) / (t1 - t0) if t1 > t0 else 0.0


class View:
    def __init__(self, items: list[Item], status_path: Path):
        self.items = items
        self.status_path = status_path
        self.t_start = time.time()
        self.total = sum(i.size for i in items)
        self.speed = Speed()
        self.session_bytes = 0
        self.last_draw = 0.0
        self.drawn_lines = 0
        self.history: list[dict] = []
        self.retries = 0
        self.last_error = ''

    def overall_done(self) -> int:
        return sum(i.done_bytes for i in self.items)

    def clear(self) -> None:
        if self.drawn_lines:
            sys.stdout.write(f"\x1b[{self.drawn_lines}F\x1b[J")
            self.drawn_lines = 0

    def println(self, text: str) -> None:
        self.clear()
        print(text, flush=True)
        self.last_draw = 0.0

    def draw(self, idx: int, phase: str, file_start: float, file_session_start_bytes: int, force=False):
        now = time.time()
        if not force and now - self.last_draw < 0.5:
            return
        self.last_draw = now
        it = self.items[idx]
        spd = self.speed.add(now, self.session_bytes)
        f_frac = it.done_bytes / it.size if it.size else 0
        f_left = it.size - it.done_bytes
        done_all = self.overall_done()
        a_frac = done_all / self.total if self.total else 0
        a_left = self.total - done_all
        f_eta = f_left / spd if spd > 0 else None
        a_eta = a_left / spd if spd > 0 else None
        lines = [
            f" [{idx + 1}/{len(self.items)}] {it.label}  ({phase})",
            f"   {bar(f_frac)} {f_frac * 100:5.1f}%  {fmt_bytes(it.done_bytes)} / {fmt_bytes(it.size)}"
            f"   {spd / 1048576:7.1f} MB/s   file {fmt_time(now - file_start)}  ETA {fmt_time(f_eta)}",
            f"   ВСЕГО {bar(a_frac)} {a_frac * 100:5.1f}%  {fmt_bytes(done_all)} / {fmt_bytes(self.total)}"
            f"   прошло {fmt_time(now - self.t_start)}  осталось {fmt_time(a_eta)}"
            + (f"   переподключений: {self.retries}" if self.retries else ""),
        ]
        self.clear()
        sys.stdout.write("\n".join(lines) + "\n")
        sys.stdout.flush()
        self.drawn_lines = len(lines)
        set_title(f"{a_frac * 100:4.1f}% · {spd / 1048576:.0f} MB/s · ETA {fmt_time(a_eta)} — AFKLLM models")
        self.write_status(idx, phase, spd, a_eta, f_eta)

    def write_status(self, idx: int, phase: str, spd: float, a_eta, f_eta, state="running"):
        it = self.items[idx] if idx < len(self.items) else None
        data = {
            "state": state,
            "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
            "elapsed_s": round(time.time() - self.t_start),
            "speed_mb_s": round(spd / 1048576, 1),
            "total_gb": round(self.total / 1e9, 2),
            "done_gb": round(self.overall_done() / 1e9, 2),
            "eta_s": round(a_eta) if a_eta else None,
            "current": None if it is None else {
                "index": idx + 1, "label": it.label, "phase": phase,
                "done_gb": round(it.done_bytes / 1e9, 2), "size_gb": round(it.size / 1e9, 2),
                "eta_s": round(f_eta) if f_eta else None,
            },
            "files": self.history,
        }
        # The status file is advisory: a reader holding it open on Windows makes os.replace fail
        # with WinError 5, and that must never abort a 20 GB download (it did once for Qwen3.6).
        tmp = self.status_path.with_suffix(".tmp")
        for attempt in range(5):
            try:
                tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
                os.replace(tmp, self.status_path)
                return
            except OSError:
                time.sleep(0.1 * (attempt + 1))


# ---------------------------------------------------------------- download

MIN_SEGMENT = 64 * 1024 * 1024


def plan_segments(it: Item, part: Path, streams: int) -> list[list[int]]:
    """Byte ranges [start, end) for parallel streams, persisted so a restart resumes them.

    A legacy single-stream .part (from an older run) becomes segment 0 as-is.
    """
    plan_file = part.with_name(part.name + ".segments.json")
    if plan_file.exists():
        plan = json.loads(plan_file.read_text(encoding="utf-8"))
        if plan.get("size") == it.size:
            return plan["segments"]
    have = part.stat().st_size if part.exists() else 0
    if have > it.size:
        part.unlink()
        have = 0
    n = max(1, min(streams, (it.size - have) // MIN_SEGMENT or 1))
    rest = it.size - have
    first_end = have + rest // n
    bounds = [0, first_end] + [first_end + (it.size - first_end) * k // max(1, n - 1) for k in range(1, n)]
    bounds = sorted(set(bounds)) if n > 1 else [0, it.size]
    segs = [[bounds[k], bounds[k + 1]] for k in range(len(bounds) - 1)]
    if have:
        os.replace(part, seg_path(part, 0))
    plan_file.write_text(json.dumps({"size": it.size, "segments": segs}), encoding="utf-8")
    return segs


def seg_path(part: Path, k: int) -> Path:
    return part.with_name(f"{part.name}.seg{k}")


def fetch_segment(it: Item, path: Path, start: int, end: int, view: View, lock: threading.Lock,
                  errors: list[str], stop: threading.Event) -> None:
    attempt = 0
    while not stop.is_set():
        have = path.stat().st_size if path.exists() else 0
        if have >= end - start:
            return
        headers = {"User-Agent": UA, "Range": f"bytes={start + have}-{end - 1}"}
        try:
            req = urllib.request.Request(it.url, headers=headers)
            with urllib.request.urlopen(req, timeout=60) as r:
                if r.status != 206:
                    raise RuntimeError(f"server ignored Range (HTTP {r.status})")
                with open(path, "ab") as f:
                    while not stop.is_set():
                        chunk = r.read(1024 * 1024)
                        if not chunk:
                            break
                        chunk = chunk[: max(0, end - start - have)]
                        f.write(chunk)
                        have += len(chunk)
                        with lock:
                            it.done_bytes += len(chunk)
                            view.session_bytes += len(chunk)
                        if have >= end - start:
                            return
            attempt = 0
        except RuntimeError as e:
            errors.append(str(e))
            stop.set()
            return
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            attempt += 1
            if attempt > 40:
                errors.append(f"network: {e}")
                stop.set()
                return
            with lock:
                view.retries += 1
                view.last_error = str(e)[:80]
            time.sleep(min(30, 2 ** min(attempt, 5)))


def download(it: Item, idx: int, view: View, streams: int) -> None:
    it.dest.parent.mkdir(parents=True, exist_ok=True)
    marker = it.dest.with_name(it.dest.name + ".verified")
    if it.dest.exists() and it.dest.stat().st_size == it.size and it.sha256 and not marker.exists():
        # a complete file from elsewhere (a browser, another tool): check it instead of downloading it again
        view.println(f"   {it.label}: файл уже есть, проверяю SHA-256…")
        h = hashlib.sha256()
        with open(it.dest, "rb") as f:
            for chunk in iter(lambda: f.read(CHUNK), b""):
                h.update(chunk)
        if h.hexdigest() == it.sha256:
            marker.write_text(it.sha256, encoding="utf-8")
        else:
            view.println(f"   {it.label}: SHA-256 не совпал, скачиваю заново")
            it.dest.unlink()
    if it.dest.exists() and it.dest.stat().st_size == it.size and (marker.exists() or not it.sha256):
        it.done_bytes = it.size
        view.println(f" ✓ {it.label}: уже скачан ({fmt_bytes(it.size).strip()})")
        view.history.append({"label": it.label, "result": "cached", "path": str(it.dest)})
        return

    part = it.dest.with_name(it.dest.name + ".part")
    segs = plan_segments(it, part, streams)
    paths = [seg_path(part, k) for k in range(len(segs))]

    # A join that died midway left: .part = segments 0..j-1 (plus a partial copy of j) with those
    # segment files already deleted. Keep that prefix instead of re-downloading it.
    joined = 0  # number of leading segments already inside .part
    if part.exists() and not paths[0].exists():
        have = part.stat().st_size
        while joined < len(segs) and segs[joined][1] <= have and not paths[joined].exists():
            joined += 1
        if joined == 0:
            part.unlink()
    it.done_bytes = sum(segs[k][1] - segs[k][0] for k in range(joined)) + sum(
        min(p.stat().st_size, e - s) if p.exists() else 0
        for p, (s, e) in list(zip(paths, segs))[joined:])
    if joined:
        view.println(f" ↻ {it.label}: продолжаю склейку с сегмента {joined}/{len(segs)}")
    paths_to_fetch = list(zip(paths, segs))[joined:]
    file_start = time.time()
    lock = threading.Lock()
    errors: list[str] = []
    stop = threading.Event()
    threads = [threading.Thread(target=fetch_segment, args=(it, p, s, e, view, lock, errors, stop), daemon=True)
               for p, (s, e) in paths_to_fetch]
    for t in threads:
        t.start()
    while any(t.is_alive() for t in threads):
        view.draw(idx, f"загрузка · {sum(t.is_alive() for t in threads)} потоков", file_start, 0)
        time.sleep(0.25)
    if errors:
        raise RuntimeError(errors[0])

    # Join segments into one file and hash in the same pass (segment files are deleted as consumed).
    h = hashlib.sha256()
    hashed = 0
    t_join = time.time()
    prefix = segs[joined - 1][1] if joined else 0
    with open(part, "r+b" if joined else "wb") as out:
        if joined:
            out.truncate(prefix)  # drop the half-copied next segment
            out.seek(0)
            while hashed < prefix and (chunk := out.read(min(CHUNK, prefix - hashed))):
                h.update(chunk)
                hashed += len(chunk)
                view.draw(idx, f"SHA-256 уже склеенного {hashed * 100 // max(1, it.size)}%", t_join, 0)
            out.seek(prefix)
        for p in paths[joined:]:
            with open(p, "rb") as f:
                while chunk := f.read(CHUNK):
                    out.write(chunk)
                    h.update(chunk)
                    hashed += len(chunk)
                    view.draw(idx, f"склейка + SHA-256 {hashed * 100 // max(1, it.size)}%", t_join, 0)
            p.unlink()
    part.with_name(part.name + ".segments.json").unlink(missing_ok=True)
    if part.stat().st_size != it.size:
        raise RuntimeError(f"size mismatch for {it.label}: {part.stat().st_size} != {it.size}")
    if it.sha256 and h.hexdigest() != it.sha256:
        bad = part.with_name(part.name + ".bad")
        os.replace(part, bad)
        raise RuntimeError(f"SHA-256 mismatch for {it.label}: got {h.hexdigest()}, want {it.sha256}")
    os.replace(part, it.dest)
    if it.sha256:
        marker.write_text(it.sha256, encoding="utf-8")
    took = time.time() - file_start
    avg = (it.size - 0) / took / 1048576 if took > 0 else 0
    view.println(f" ✓ {it.label}: {fmt_bytes(it.size).strip()} за {fmt_time(took)}"
                 f" (~{avg:.0f} MB/s){'  sha256 OK' if it.sha256 else ''}")
    view.history.append({"label": it.label, "result": "ok", "path": str(it.dest),
                         "seconds": round(took), "sha256_ok": bool(it.sha256)})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=r"C:\Models")
    ap.add_argument("--streams", type=int, default=8, help="parallel HTTP range streams per file")
    ap.add_argument("--only", default=None, help="download only items whose label contains this")
    ap.add_argument("--stage0", action="store_true", help="the old stage-0 LLM candidate list instead")
    ap.add_argument("--flash", action="store_true",
                    help="only the `flash` model (Qwen3.8-Flash-Next IQ3_XXS for Strata, ~76.7 GB, needs 64 GB RAM)")
    args = ap.parse_args()
    if os.name == "nt":
        os.system("")  # enable ANSI cursor control in the Windows console
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    root = Path(args.root)
    root.mkdir(parents=True, exist_ok=True)
    status = root / "_download-status.json"

    items = stage0_candidates(root) if args.stage0 else flash_plan(root) if args.flash else build_plan(root)
    if args.only:
        items = [i for i in items if args.only.lower() in i.label.lower()]
    print(" AFKLLM · загрузка моделей в", root)
    print(" получаю размеры и SHA-256 с Hugging Face / GitHub…", flush=True)
    fill_metadata(items)
    for i, it in enumerate(items, 1):
        print(f"   {i}. {it.label:<44} {fmt_bytes(it.size)}  → {it.dest}")
    print(f"   итого {fmt_bytes(sum(i.size for i in items)).strip()}\n", flush=True)

    view = View(items, status)
    failed = []
    for idx, it in enumerate(items):
        try:
            download(it, idx, view, args.streams)
            if it.extract_to:
                view.println(f"   распаковываю {it.dest.name} → {it.extract_to}")
                it.extract_to.mkdir(parents=True, exist_ok=True)
                if it.dest.suffix.lower() == ".7z":
                    seven = Path(r"C:\Program Files\7-Zip\7z.exe")
                    subprocess.run([str(seven), "x", str(it.dest), f"-o{it.extract_to}", "-y", "-bso0", "-bsp1"], check=True)
                else:
                    with zipfile.ZipFile(it.dest) as z:
                        z.extractall(it.extract_to)
        except Exception as e:  # keep going with the rest of the queue
            failed.append(it.label)
            view.println(f" ✗ {it.label}: {e}")
            view.history.append({"label": it.label, "result": "error", "error": str(e)})

    view.clear()
    took = time.time() - view.t_start
    state = "failed" if failed else "done"
    view.write_status(len(items), "", 0, None, None, state=state)
    set_title(f"{'ГОТОВО' if not failed else 'ЕСТЬ ОШИБКИ'} — AFKLLM models")
    print(f"\n {'Готово' if not failed else 'Завершено с ошибками'} за {fmt_time(took)}."
          + (f" Ошибки: {', '.join(failed)}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
