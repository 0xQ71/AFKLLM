r"""Stage 0, part 2: the same real agent task for every model, through the new `afk` CLI in AUTO MODE.

For each profile: copy fixture/ to C:\Models\_bench\agent\<profile>-<time>, run
`afk -p --auto -m <profile>` on it (tool calls stream live to this console), then verify independently:
unit tests passing, test file untouched. Results -> C:\Models\_bench\agent-results.jsonl

  python -u scripts/stage0/agent-task/run_agent_task.py [--task=2] q38 q38-128k ornith1m
"""
from __future__ import annotations

import hashlib
import os
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
OUT = Path(r"C:\Models\_bench\agent")
RESULTS = Path(r"C:\Models\_bench\agent-results.jsonl")
TSX = REPO / "node_modules" / ".bin" / "tsx.cmd"
TASKS = {
    "1": {
        "fixture": "fixture", "protect": "test_inventory.py", "expect": 8,
        "prompt": ("Сделай так, чтобы все тесты в test_inventory.py проходили (python -m unittest). "
                   "Файл test_inventory.py не меняй. Проверь результат, запустив тесты."),
    },
    "2": {
        "fixture": "fixture2", "protect": "tests/test_basic.py", "expect": 7, "hidden": "hidden2/test_hidden.py",
        "prompt": (
            "Добавь подкоманду `top` в пакет textstats: `python -m textstats.cli FILE top [-n N] [--json]`.\n"
            "- слова считаются без учёта регистра (Привет и привет — одно слово), буква ё приравнивается к е;\n"
            "- стоп-слова из textstats/stopwords.txt исключаются (по одному на строку, строки с # — комментарии);\n"
            "- выводятся N (по умолчанию 10) самых частых слов, при равной частоте — по алфавиту;\n"
            "- текстовый вывод: одна строка на слово `слово<TAB>число`; с --json — JSON-массив объектов "
            "{\"word\": ..., \"count\": ...};\n"
            "- если N <= 0 — ошибка с кодом выхода 2.\n"
            "Логику подсчёта вынеси в функцию top_words(text, n, stopwords) в textstats/stats.py, которая "
            "возвращает список пар (слово, число). Добавь тесты в tests/. Существующие тесты должны проходить "
            "(python -m unittest discover -s tests -t .)."),
    },
    "3": {
        "fixture": "fixture3", "protect": "data/expected_report.txt", "expect": 2,
        "runs": [("data/orders.csv", None, "data/expected_report.txt"),
                 ("_hidden.csv", "hidden3/data2.csv", "hidden3/expected2.txt")],
        "prompt": ("Команда `python -m shop.main data/orders.csv` падает. Почини программу так, чтобы её вывод в "
                   "точности совпадал с data/expected_report.txt (заказы отсортированы по дате, от старых к новым). "
                   "Файлы в data/ не меняй и не подставляй ожидаемый вывод напрямую: программа должна правильно "
                   "работать для любых заказов в этом формате."),
    },
}


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run(profile: str, port: int, task: str) -> dict:
    t = TASKS[task]
    stamp = time.strftime("%Y%m%d-%H%M%S")
    work = OUT / f"t{task}-{profile}-{stamp}"
    shutil.copytree(HERE / t["fixture"], work)
    test_hash = sha(work / t["protect"])
    print(f"\n==================== {profile} · {work} ====================", flush=True)
    t0 = time.time()
    try:
        proc = subprocess.run(
            [str(TSX), str(REPO / "src" / "cli" / "main.ts"), "-p", "--auto", "--verbose", "-m", profile,
             "--port", str(port), "--max-turns", "60", "--cwd", str(work)],
            # The prompt goes through stdin: tsx.cmd is a batch file, and cmd.exe cuts arguments at a newline.
            input=t["prompt"], stdout=subprocess.PIPE, stderr=None, text=True, encoding="utf-8", errors="replace",
            timeout=20 * 60)
    except subprocess.TimeoutExpired as e:
        # kill the llama-server the CLI started (port is per profile), then score what is on disk
        subprocess.run(["powershell", "-NoProfile", "-Command",
                        f"Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | "
                        "ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"], capture_output=True)
        proc = subprocess.CompletedProcess([], 124, (e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or ""), "")
    wall = time.time() - t0
    answer = proc.stdout.strip()
    print("\n--- final answer ---\n" + answer, flush=True)

    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    if "runs" in t:
        passed = 0
        details = []
        for csv_rel, src, expected_rel in t["runs"]:
            if src:
                shutil.copy(HERE / src, work / csv_rel)
            exp_path = (HERE / expected_rel) if expected_rel.startswith("hidden") else (work / expected_rel)
            want = exp_path.read_text(encoding="utf-8").strip().splitlines()
            try:
                r = subprocess.run([sys.executable, "-m", "shop.main", csv_rel], cwd=work, capture_output=True,
                                   text=True, encoding="utf-8", errors="replace", env=env, timeout=60)
            except subprocess.TimeoutExpired:
                r = subprocess.CompletedProcess([], 1, "", "timeout")
            got = r.stdout.strip().splitlines()
            ok = r.returncode == 0 and got == want
            passed += ok
            details.append({"csv": csv_rel, "ok": ok, "err": r.stderr.strip()[-200:]})
            if src:
                (work / csv_rel).unlink()
        v = None
        extra = {"runs": details}
        total, failed = len(t["runs"]), len(t["runs"]) - passed
        rec_ok = passed == total
    elif "hidden" in t:
        shutil.copy(HERE / t["hidden"], work / "_hidden_acceptance.py")
        v = subprocess.run([sys.executable, "-m", "unittest", "-v", "_hidden_acceptance"], cwd=work,
                           capture_output=True, text=True, encoding="utf-8", errors="replace", env=env)
        (work / "_hidden_acceptance.py").unlink()
        own = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."], cwd=work,
                             capture_output=True, text=True, encoding="utf-8", errors="replace", env=env)
        own_ran = re.search(r"Ran (\d+) tests", own.stderr)
        extra = {"own_tests": int(own_ran.group(1)) if own_ran else 0, "own_tests_green": own.returncode == 0}
    else:
        v = subprocess.run([sys.executable, "-m", "unittest", "-v"], cwd=work, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", env=env)
        extra = {}
    if v is not None:
        report = v.stderr + v.stdout
        ran = re.search(r"Ran (\d+) tests", report)
        failed = len(re.findall(r"\.\.\. (FAIL|ERROR)", report))
        total = int(ran.group(1)) if ran else 0
        rec_ok = v.returncode == 0 and total == t["expect"]
    rec = {
        "task": task, "profile": profile, "time": stamp, "wall_s": round(wall, 1), "exit": proc.returncode,
        "tests_total": total, "tests_passed": total - failed if total else 0,
        "all_green": rec_ok, **extra,
        "test_file_untouched": sha(work / t["protect"]) == test_hash,
        "answer": answer[:2000], "dir": str(work),
    }
    print(f"\n>>> {profile}: tests {rec['tests_passed']}/{rec['tests_total']} · "
          f"{'GREEN' if rec['all_green'] else 'NOT green'} · test file "
          f"{'untouched' if rec['test_file_untouched'] else 'MODIFIED'} · {wall:.0f}s", flush=True)
    with open(RESULTS, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec


def main() -> int:
    args = sys.argv[1:]
    task = "1"
    if args and args[0].startswith("--task="):
        task = args.pop(0).split("=", 1)[1]
    profiles = args or ["q38"]
    OUT.mkdir(parents=True, exist_ok=True)
    recs = [run(p, 18310 + i, task) for i, p in enumerate(profiles)]
    print("\n==================== summary ====================")
    for r in recs:
        print(f"{r['profile']:8s} {r['tests_passed']}/{r['tests_total']} "
              f"{'GREEN' if r['all_green'] else 'red  '} tests-file:{'ok' if r['test_file_untouched'] else 'MODIFIED'} "
              f"{r['wall_s']:6.0f}s  own-tests:{r.get('own_tests', '-')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
