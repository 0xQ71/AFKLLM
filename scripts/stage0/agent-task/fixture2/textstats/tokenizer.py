import re

WORD_RE = re.compile(r"[A-Za-zА-Яа-яЁё']+")


def tokenize(text: str) -> list[str]:
    """Split text into words (letters and apostrophes)."""
    return [w.strip("'") for w in WORD_RE.findall(text) if w.strip("'")]
