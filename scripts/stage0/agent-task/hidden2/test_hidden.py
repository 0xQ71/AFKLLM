"""Hidden acceptance tests for task 2 (the agent never sees this file)."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path.cwd()
TEXT = ("Ёж и ёлка. Еж, ЕЖ, ёж! The cat and the hat. Cat? cat. Hat; Елка — елка, ЕЛКА.\n"
        "Мир мир Мир. Zebra apple. apple")


def run_cli(*args):
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
        f.write(TEXT)
    return subprocess.run([sys.executable, "-m", "textstats.cli", f.name, *args], cwd=ROOT,
                          capture_output=True, text=True, encoding="utf-8")


class Hidden(unittest.TestCase):
    def stop(self):
        from textstats.cli import __file__ as cli_file  # noqa: F401
        lines = (ROOT / "textstats" / "stopwords.txt").read_text(encoding="utf-8").splitlines()
        return {l.strip() for l in lines if l.strip() and not l.strip().startswith("#")}

    def test_function_exists_and_counts(self):
        from textstats.stats import top_words
        res = top_words(TEXT, 3, self.stop())
        self.assertEqual([tuple(x) for x in res], [("еж", 4), ("елка", 4), ("cat", 3)])

    def test_ties_alphabetical_and_n(self):
        from textstats.stats import top_words
        res = [tuple(x) for x in top_words(TEXT, 10, self.stop())]
        self.assertEqual(res, [("еж", 4), ("елка", 4), ("cat", 3), ("мир", 3), ("apple", 2), ("hat", 2), ("zebra", 1)])

    def test_cli_text(self):
        p = run_cli("top", "-n", "2")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.strip().splitlines(), ["еж\t4", "елка\t4"])

    def test_cli_default_n_and_stopwords(self):
        p = run_cli("top")
        self.assertEqual(p.returncode, 0, p.stderr)
        words = [l.split("\t")[0] for l in p.stdout.strip().splitlines()]
        self.assertEqual(len(words), 7)
        for sw in ("и", "the", "and"):
            self.assertNotIn(sw, words)

    def test_cli_json(self):
        p = run_cli("top", "-n", "3", "--json")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(json.loads(p.stdout), [{"word": "еж", "count": 4}, {"word": "елка", "count": 4}, {"word": "cat", "count": 3}])

    def test_cli_bad_n(self):
        self.assertEqual(run_cli("top", "-n", "0").returncode, 2)

    def test_old_commands_still_work(self):
        p = run_cli("count")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.strip(), "23")


if __name__ == "__main__":
    unittest.main()
