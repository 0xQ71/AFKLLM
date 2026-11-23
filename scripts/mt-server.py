"""Offline translator for AFKLLM: DeepSeek Harness reasoning English -> Russian, /image prompts Russian -> English.

Speaks the Microsoft Edge (Bing) translate protocol that Harness' translator plugin uses; afk api starts this
worker on the first request and forwards /translate/translatetext to it (src/core/translate.ts).

  POST /translate/translatetext?to=ru[&from=en]   body ["text", ...]  ->  [{"translations": [{"text": "...", "to": "ru"}]}]
  POST /forget                                    drop the in-memory cache
  GET  /health                                    {"ok": true, ...} (counters only, never texts)

OPUS-MT (Marian) through CTranslate2 int8 on the CPU: no GPU, 2 threads, idle priority, so the local LLM (which also
uses the CPU for MoE experts) keeps its speed. Nothing is written to disk and no text is logged: English -> Russian
results stay in an in-memory cache until the worker exits (Harness itself keeps a chat's translations inside that
chat); Russian -> English (image prompts) is never cached at all. Code spans, paths, file names and identifiers
are kept as they are. Exits by itself after --idle-exit seconds without requests.

  python mt-server.py --model en-ru=C:\\Models\\mt\\opus-mt-tc-big-en-zle-ct2-int8 --model ru-en=... [--port 18302]
"""

import argparse
import ctypes
import json
import os
import re
import sys
import threading
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

CYR = re.compile(r"[\u0400-\u04FF]")
LATIN = re.compile(r"[A-Za-z]")
FILE_EXT = (r"ts|tsx|js|mjs|cjs|jsx|json|glsl|vert|frag|css|scss|html|md|py|ps1|cmd|bat|yml|yaml|toml|txt|lock|cpp|h|"
            r"hpp|cs|rs|go|gd|tscn|uasset|png|jpg|jpeg|webp|gguf|exe|dll|log|sh|zst|zip|bin|spm")
# spans copied verbatim around English -> Russian translation
PROTECT_EN = re.compile(
    r"`[^`\n]+`"                                              # inline code
    r"|https?://\S+"                                          # URLs
    r"|(?:[A-Za-z]:)?[\w.@~$-]*(?:[\\/][\w.@~${}()+-]+)+[\\/]?"  # paths: src/main.ts, C:\Models\x, ./a
    rf"|\b[\w.-]+\.(?:{FILE_EXT})\b"                          # file names
    r"|\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?"    # dotted names: THREE.Mesh, a.b.c()
    r"|\b[A-Za-z_$][\w$]*\(\)"                                # calls: foo()
    r"|\b[a-z]+[A-Z][\w$]*"                                   # camelCase
    r"|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b"                 # PascalCase
    r"|\b\w*_\w+\b"                                           # snake_case / CONSTANT_CASE
    r"|(?<![\w-])--?[a-z][\w-]*"                              # CLI flags
    r"|[\u0400-\u04FF][\u0400-\u04FF0-9\s,.:;!?«»\"'()-]*[\u0400-\u04FF»\")]"  # Russian already in the text
    r"|[\u0400-\u04FF]"
    r"|[=<>]=?|[→←↔⇒⇐≈≤≥≠×÷±·•…✓✗⚠\u2190-\u21FF\u2200-\u22FF\u2500-\u27BF]+"  # symbols the model has no tokens for
)
# Russian -> English (image prompts): keep URLs and code only
PROTECT_RU = re.compile(r"`[^`\n]+`|https?://\S+")
SENTENCE = re.compile(r"(?<=[.!?])\s+(?=[\"'(\[`A-ZА-ЯЁ0-9])")
LIST_PREFIX = re.compile(r"^(\s*(?:[-*+>]|\d+[.)]|#{1,6})?\s*)")
PLACEHOLDER = re.compile(r"X\d+X")


def looks_like_code(line: str) -> bool:
    s = line.strip()
    if not s:
        return True
    if s.startswith(("```", "//", "/*", "*/", "<", "{", "}", "import ", "export ", "const ", "let ", "function ",
                     "return ", "if (", "for (", "$ ", "PS ", ">>> ")):
        return True
    sym = sum(ch in "{}()[];=<>|&$\\/" for ch in s)
    letters = len(LATIN.findall(s)) + len(CYR.findall(s))
    return letters == 0 or sym / max(len(s), 1) > 0.12


def split_long(sentence: str, limit: int = 400) -> list[str]:
    if len(sentence) <= limit:
        return [sentence]
    parts, cur = [], ""
    for piece in re.split(r"(?<=[,;:])\s+", sentence):
        if cur and len(cur) + len(piece) + 1 > limit:
            parts.append(cur)
            cur = piece
        else:
            cur = f"{cur} {piece}" if cur else piece
    if cur:
        parts.append(cur)
    return parts


class Model:
    def __init__(self, model_dir: str, threads: int, beam: int):
        import ctranslate2
        import sentencepiece as spm

        self.id = os.path.basename(os.path.normpath(model_dir))
        self.tr = ctranslate2.Translator(model_dir, device="cpu", compute_type="int8",
                                         intra_threads=threads, inter_threads=1)
        self.src = spm.SentencePieceProcessor(model_file=os.path.join(model_dir, "source.spm"))
        self.tgt = spm.SentencePieceProcessor(model_file=os.path.join(model_dir, "target.spm"))
        # en-zle (Belarusian, Russian, Ukrainian) needs the target-language token
        self.prefix = [">>rus<<"] if "-en-zle" in self.id else []
        self.beam = beam

    def raw(self, sentences: list[str]) -> list[str]:
        if not sentences:
            return []
        # Marian needs the end-of-sentence token on the source, or it rambles and repeats itself
        toks = [self.prefix + self.src.encode(s, out_type=str) + ["</s>"] for s in sentences]
        longest = max(len(t) for t in toks)
        res = self.tr.translate_batch(toks, beam_size=self.beam, max_batch_size=16, no_repeat_ngram_size=4,
                                      max_decoding_length=min(512, 2 * longest + 16))
        return [self.tgt.decode(r.hypotheses[0]) for r in res]


class Direction:
    """One language pair: lazily loaded model, its text rules and (for en-ru only) an in-memory cache."""

    def __init__(self, name: str, model_dir: str, threads: int, beam: int, cache_size: int):
        self.name, self.model_dir, self.threads, self.beam = name, model_dir, threads, beam
        self.model: Model | None = None
        self.source_is_ru = name.startswith("ru")
        self.protect = PROTECT_RU if self.source_is_ru else PROTECT_EN
        self.cache: OrderedDict[str, str] | None = None if self.source_is_ru else OrderedDict()
        self.cache_size = cache_size

    def ensure(self) -> Model:
        if self.model is None:
            self.model = Model(self.model_dir, self.threads, self.beam)
        return self.model

    def forget(self) -> None:
        if self.cache is not None:
            self.cache.clear()

    def is_source(self, line: str) -> bool:
        cyr, lat = len(CYR.findall(line)), len(LATIN.findall(line))
        return cyr > 0 if self.source_is_ru else lat > 0 and lat >= cyr

    def translate_text(self, text: str, stats: dict) -> str:
        lines = text.split("\n")
        plan: list[tuple[str, list[str] | None]] = []
        todo: list[str] = []
        in_fence = False
        for line in lines:
            if line.strip().startswith("```"):
                in_fence = not in_fence
                plan.append((line, None))
                continue
            if in_fence or looks_like_code(line) or not self.is_source(line):
                plan.append((line, None))
                continue
            m = LIST_PREFIX.match(line)
            prefix, body = m.group(1), line[m.end():]
            sentences = [p for s in SENTENCE.split(body) for p in split_long(s)]
            plan.append((prefix, sentences))
            todo.extend(sentences)

        done: dict[str, str] = {}
        if self.cache is not None:
            for s in todo:
                if s in self.cache:
                    done[s] = self.cache[s]
                    self.cache.move_to_end(s)
            stats["from_cache"] += len(done)
        missing = [s for s in dict.fromkeys(todo) if s not in done]
        if missing:
            new = self.translate_sentences(missing)
            done.update(new)
            if self.cache is not None:
                for s, t in new.items():
                    self.cache[s] = t
                while len(self.cache) > self.cache_size:
                    self.cache.popitem(last=False)
        stats["sentences"] += len(todo)

        out = []
        for head, sentences in plan:
            out.append(head if sentences is None else head + " ".join(done.get(s, s) for s in sentences))
        return "\n".join(out)

    def translate_sentences(self, sentences: list[str]) -> dict[str, str]:
        result: dict[str, str] = {}
        jobs: list[tuple[str, str, list[str]]] = []
        for s in sentences:
            spans: list[str] = []

            def sub(m: re.Match) -> str:
                spans.append(m.group(0))
                return f"X{len(spans)}X"

            p = self.protect.sub(sub, s)
            # nothing left to translate (only code, names, symbols): keep as is
            if not (CYR if self.source_is_ru else LATIN).search(PLACEHOLDER.sub("", p)):
                result[s] = s
            else:
                jobs.append((s, p, spans))
        outs = self.ensure().raw([p for _, p, _ in jobs])
        for (s, _, spans), t in zip(jobs, outs):
            r = t
            for i, span in enumerate(spans, 1):
                tok = f"X{i}X"
                if r.count(tok) != 1:
                    r = None
                    break
                r = r.replace(tok, span)
            # a placeholder got lost or doubled: show the original sentence rather than a broken one
            result[s] = r if r is not None and not PLACEHOLDER.search(r) else s
        return result


class Service:
    def __init__(self, directions: dict[str, Direction]):
        self.directions = directions
        self.lock = threading.Lock()  # one translation at a time: at most `threads` cores busy
        self.stats = {"requests": 0, "sentences": 0, "from_cache": 0, "seconds": 0.0}

    def pick(self, src: str, dst: str) -> Direction:
        dst = dst.lower().split("-")[0]
        src = (src or "auto").lower().split("-")[0]
        if src == "auto":
            src = "ru" if dst == "en" else "en"
        d = self.directions.get(f"{src}-{dst}")
        if d is None:
            raise ValueError(f"no model for {src} -> {dst} (installed: {', '.join(self.directions) or 'none'})")
        return d

    def translate(self, texts: list[str], src: str, dst: str) -> list[str]:
        d = self.pick(src, dst)
        with self.lock:
            t0 = time.time()
            out = [d.translate_text(t, self.stats) for t in texts]
            self.stats["requests"] += 1
            self.stats["seconds"] = round(self.stats["seconds"] + time.time() - t0, 2)
        return out

    def forget(self) -> None:
        with self.lock:
            for d in self.directions.values():
                d.forget()


def make_handler(svc: Service, state: dict):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # no request log: nothing about the texts reaches a console or file
            pass

        def send_json(self, code: int, obj) -> None:
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            state["last"] = time.time()
            if urlparse(self.path).path == "/health":
                loaded = [n for n, d in svc.directions.items() if d.model is not None]
                self.send_json(200, {"ok": True, "directions": list(svc.directions), "loaded": loaded, **svc.stats})
            else:
                self.send_json(404, {"error": "not found"})

        def do_POST(self):
            state["last"] = time.time()
            url = urlparse(self.path)
            n = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(n) if n else b""
            if url.path == "/forget":
                svc.forget()
                self.send_json(200, {"ok": True})
                return
            if not url.path.endswith("/translate/translatetext"):
                self.send_json(404, {"error": "not found"})
                return
            q = parse_qs(url.query)
            to, frm = (q.get("to") or ["ru"])[0], (q.get("from") or ["auto"])[0]
            try:
                texts = json.loads(raw or b"[]")
                if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
                    raise ValueError("body must be a JSON array of strings")
                out = svc.translate(texts, frm, to)
                self.send_json(200, [{"detectedLanguage": {"language": frm if frm != "auto" else "en", "score": 1.0},
                                      "translations": [{"text": t, "to": to}]} for t in out])
            except Exception as e:  # noqa: BLE001 - the client gets the reason (never the text), the worker keeps running
                self.send_json(400, {"error": f"{type(e).__name__}: {e}"[:300]})
            finally:
                state["last"] = time.time()

    return Handler


def lower_priority() -> None:
    if sys.platform == "win32":
        IDLE_PRIORITY_CLASS = 0x40
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), IDLE_PRIORITY_CLASS)
    else:
        try:
            os.nice(19)
        except OSError:
            pass


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", action="append", required=True, metavar="SRC-DST=DIR",
                    help="CTranslate2 OPUS-MT folder (model.bin, source.spm, target.spm) for a direction; repeatable")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18302)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--beam", type=int, default=2)
    ap.add_argument("--cache-size", type=int, default=20000, help="sentences kept in memory (English -> Russian only)")
    ap.add_argument("--idle-exit", type=int, default=900, help="exit after this many seconds without requests (0 = never)")
    args = ap.parse_args()

    os.environ.setdefault("OMP_NUM_THREADS", str(args.threads))
    lower_priority()
    directions = {}
    for spec in args.model:
        name, _, path = spec.partition("=")
        if not path or not os.path.exists(os.path.join(path, "model.bin")):
            print(f"skip {spec}: no model.bin", file=sys.stderr)
            continue
        directions[name.lower()] = Direction(name.lower(), path, args.threads, args.beam, args.cache_size)
    if not directions:
        sys.exit("no translation model found")
    svc = Service(directions)
    state = {"last": time.time()}
    server = ThreadingHTTPServer((args.host, args.port), make_handler(svc, state))
    server.daemon_threads = True
    print(f"mt-server on {args.host}:{args.port} · {', '.join(directions)} · {args.threads} threads, idle priority",
          flush=True)

    if args.idle_exit > 0:
        def reaper():
            while True:
                time.sleep(15)
                if time.time() - state["last"] > args.idle_exit:
                    server.shutdown()
                    return
        threading.Thread(target=reaper, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
