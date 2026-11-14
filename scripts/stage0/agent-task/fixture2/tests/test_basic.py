import unittest

from textstats.stats import avg_word_len, char_count, word_count
from textstats.tokenizer import tokenize


class BasicTest(unittest.TestCase):
    def test_tokenize(self):
        self.assertEqual(tokenize("Hello, world! It's ok."), ["Hello", "world", "It's", "ok"])

    def test_counts(self):
        self.assertEqual(word_count("один два, три"), 3)
        self.assertEqual(char_count("a b"), 3)
        self.assertEqual(char_count("a b", spaces=False), 2)
        self.assertEqual(avg_word_len("ab abcd"), 3.0)


if __name__ == "__main__":
    unittest.main()
