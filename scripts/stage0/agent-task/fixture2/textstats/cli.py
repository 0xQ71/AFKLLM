import argparse
import sys
from pathlib import Path

from .stats import avg_word_len, char_count, word_count


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="textstats")
    ap.add_argument("file")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("count", help="number of words")
    ch = sub.add_parser("chars", help="number of characters")
    ch.add_argument("--no-spaces", action="store_true")
    sub.add_parser("avg", help="average word length")
    args = ap.parse_args(argv)

    text = Path(args.file).read_text(encoding="utf-8")
    if args.cmd == "count":
        print(word_count(text))
    elif args.cmd == "chars":
        print(char_count(text, spaces=not args.no_spaces))
    elif args.cmd == "avg":
        print(avg_word_len(text))
    return 0


if __name__ == "__main__":
    sys.exit(main())
