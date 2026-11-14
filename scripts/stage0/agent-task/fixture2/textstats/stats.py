from .tokenizer import tokenize


def word_count(text: str) -> int:
    return len(tokenize(text))


def char_count(text: str, spaces: bool = True) -> int:
    return len(text) if spaces else len("".join(text.split()))


def avg_word_len(text: str) -> float:
    words = tokenize(text)
    return round(sum(map(len, words)) / len(words), 2) if words else 0.0
