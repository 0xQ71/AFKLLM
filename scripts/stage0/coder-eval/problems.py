"""Quick coder eval: 16 small Python problems with hidden tests (written for AFKLLM, not from a public set).

Each problem: prompt (what the model sees), tests (hidden), ref (reference solution, used only to
validate the tests themselves: `python problems.py` must print 16/16).
"""

PROBLEMS = [
    {
        "id": "parse_duration",
        "prompt": 'def parse_duration(s: str) -> int:\n    """Parse durations like "1h30m15s", "45s", "2h", "90m", "1h5s" into seconds.\n    Units h, m, s each appear at most once and in that order. Surrounding spaces are allowed.\n    Raise ValueError for anything else ("", "5", "1m2h", "1x", "1h1h", "-5s")."""',
        "tests": """
assert parse_duration("1h30m15s") == 5415
assert parse_duration("45s") == 45
assert parse_duration(" 2h ") == 7200
assert parse_duration("90m") == 5400
assert parse_duration("1h5s") == 3605
for bad in ["", "5", "1m2h", "1x", "1h1h", "-5s", "h", "1h 30m"]:
    try:
        parse_duration(bad)
    except ValueError:
        pass
    else:
        raise AssertionError(f"no ValueError for {bad!r}")
""",
        "ref": """
import re
def parse_duration(s):
    s = s.strip()
    m = re.fullmatch(r"(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?", s)
    if not s or not m or not any(m.groups()):
        raise ValueError(s)
    h, mi, se = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mi * 60 + se
""",
    },
    {
        "id": "merge_intervals",
        "prompt": 'def merge_intervals(intervals: list[list[int]]) -> list[list[int]]:\n    """Merge overlapping or touching closed intervals ([1,3] and [3,5] merge; [1,2] and [3,4] do not).\n    Input may be unsorted; return a new sorted list. Do not modify the input."""',
        "tests": """
assert merge_intervals([[1,3],[2,6],[8,10],[15,18]]) == [[1,6],[8,10],[15,18]]
assert merge_intervals([[1,4],[4,5]]) == [[1,5]]
assert merge_intervals([[1,2],[3,4]]) == [[1,2],[3,4]]
data = [[5,7],[1,2],[2,3],[6,6]]
assert merge_intervals(data) == [[1,3],[5,7]]
assert data == [[5,7],[1,2],[2,3],[6,6]]
assert merge_intervals([]) == []
assert merge_intervals([[1,10],[2,3]]) == [[1,10]]
""",
        "ref": """
def merge_intervals(intervals):
    out = []
    for a, b in sorted(map(list, intervals)):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out
""",
    },
    {
        "id": "roman_to_int",
        "prompt": 'def roman_to_int(s: str) -> int:\n    """Convert a valid Roman numeral (I, V, X, L, C, D, M; subtractive forms like IV, IX, XL, XC, CD, CM) to int."""',
        "tests": """
assert roman_to_int("III") == 3
assert roman_to_int("LVIII") == 58
assert roman_to_int("MCMXCIV") == 1994
assert roman_to_int("MMXXVI") == 2026
assert roman_to_int("CDXLIV") == 444
""",
        "ref": """
def roman_to_int(s):
    v = dict(I=1, V=5, X=10, L=50, C=100, D=500, M=1000)
    t = 0
    for i, c in enumerate(s):
        t += -v[c] if i + 1 < len(s) and v[c] < v[s[i + 1]] else v[c]
    return t
""",
    },
    {
        "id": "lru",
        "prompt": 'class LRU:\n    """Least-recently-used cache. LRU(capacity). get(key) returns the value or -1 and marks the key as recently used.\n    put(key, value) inserts/updates (and marks as recently used); when over capacity evict the least recently used key.\n    len(cache) returns the number of stored keys."""',
        "tests": """
c = LRU(2)
c.put(1, 1); c.put(2, 2)
assert c.get(1) == 1
c.put(3, 3)
assert c.get(2) == -1
c.put(4, 4)
assert c.get(1) == -1 and c.get(3) == 3 and c.get(4) == 4
c.put(3, 30)
c.put(5, 5)
assert c.get(4) == -1 and c.get(3) == 30
assert len(c) == 2
""",
        "ref": """
from collections import OrderedDict
class LRU:
    def __init__(self, capacity):
        self.cap = capacity; self.d = OrderedDict()
    def get(self, k):
        if k not in self.d: return -1
        self.d.move_to_end(k); return self.d[k]
    def put(self, k, v):
        self.d[k] = v; self.d.move_to_end(k)
        while len(self.d) > self.cap: self.d.popitem(last=False)
    def __len__(self): return len(self.d)
""",
    },
    {
        "id": "wrap_text",
        "prompt": 'def wrap_text(text: str, width: int) -> list[str]:\n    """Greedy word wrap. Words are separated by any whitespace (collapse it). Put as many words on a line as fit\n    (joined by single spaces, line length <= width). A word longer than width is split into chunks of exactly\n    width characters (the last chunk may be shorter) and the remainder continues the line normally.\n    Empty or whitespace-only text returns []."""',
        "tests": """
assert wrap_text("the quick brown fox", 10) == ["the quick", "brown fox"]
assert wrap_text("  a   b  ", 3) == ["a b"]
assert wrap_text("", 5) == []
assert wrap_text("abcdefghij xy", 4) == ["abcd", "efgh", "ij", "xy"]
assert wrap_text("aa bb cc", 5) == ["aa bb", "cc"]
assert wrap_text("hello", 5) == ["hello"]
""",
        "ref": """
def wrap_text(text, width):
    lines, cur = [], ""
    for w in text.split():
        while len(w) > width:
            if cur: lines.append(cur); cur = ""
            lines.append(w[:width]); w = w[width:]
        if not w: continue
        if not cur: cur = w
        elif len(cur) + 1 + len(w) <= width: cur += " " + w
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines
""",
    },
    {
        "id": "top_k_frequent",
        "prompt": 'def top_k_frequent(nums: list[int], k: int) -> list[int]:\n    """Return the k most frequent numbers, most frequent first; ties broken by the smaller number first.\n    If there are fewer than k distinct numbers, return all of them."""',
        "tests": """
assert top_k_frequent([1,1,1,2,2,3], 2) == [1, 2]
assert top_k_frequent([4,4,5,5,6], 2) == [4, 5]
assert top_k_frequent([3,3,-1,-1,2], 3) == [-1, 3, 2]
assert top_k_frequent([7], 5) == [7]
assert top_k_frequent([], 1) == []
""",
        "ref": """
from collections import Counter
def top_k_frequent(nums, k):
    return [n for n, _ in sorted(Counter(nums).items(), key=lambda x: (-x[1], x[0]))[:k]]
""",
    },
    {
        "id": "brackets",
        "prompt": 'def is_balanced(s: str) -> bool:\n    """True if (), [], {} in s are balanced and properly nested. Other characters are ignored,\n    except that brackets inside double-quoted string literals ("...") are ignored too. A backslash inside a\n    string escapes the next character."""',
        "tests": """
assert is_balanced("a(b[c]{d}e)f")
assert not is_balanced("(]")
assert not is_balanced("((")
assert is_balanced('print("(")')
assert is_balanced('x = ["a\\\\"]", "]"]')
assert not is_balanced('f("x") )')
assert is_balanced("")
""",
        "ref": """
def is_balanced(s):
    st = []; pair = {')': '(', ']': '[', '}': '{'}
    i = 0; ins = False
    while i < len(s):
        c = s[i]
        if ins:
            if c == '\\\\': i += 2; continue
            if c == '"': ins = False
        elif c == '"': ins = True
        elif c in '([{': st.append(c)
        elif c in ')]}':
            if not st or st.pop() != pair[c]: return False
        i += 1
    return not st
""",
    },
    {
        "id": "flatten",
        "prompt": 'def flatten(obj, sep: str = ".") -> dict:\n    """Flatten nested dicts and lists into a single dict. Dict keys are joined with sep, list items use their\n    index: {"a": {"b": 1, "c": [10, {"d": 2}]}} -> {"a.b": 1, "a.c.0": 10, "a.c.1.d": 2}.\n    Empty dicts/lists inside are kept as values ({"x": {}} -> {"x": {}}). Top-level obj is a dict."""',
        "tests": """
assert flatten({"a": {"b": 1, "c": [10, {"d": 2}]}}) == {"a.b": 1, "a.c.0": 10, "a.c.1.d": 2}
assert flatten({"x": {}, "y": []}) == {"x": {}, "y": []}
assert flatten({"a": {"b": {"c": None}}}, sep="/") == {"a/b/c": None}
assert flatten({}) == {}
assert flatten({"k": [[1, 2], [3]]}) == {"k.0.0": 1, "k.0.1": 2, "k.1.0": 3}
""",
        "ref": """
def flatten(obj, sep="."):
    out = {}
    def go(o, p):
        if isinstance(o, dict) and o:
            for k, v in o.items(): go(v, f"{p}{sep}{k}" if p else str(k))
        elif isinstance(o, list) and o:
            for i, v in enumerate(o): go(v, f"{p}{sep}{i}" if p else str(i))
        else:
            out[p] = o
    for k, v in obj.items(): go(v, str(k))
    return out
""",
    },
    {
        "id": "rle",
        "prompt": 'def rle_encode(s: str) -> str:\n    """Run-length encode: "aaabcc" -> "3a1b2c". Input contains no digits."""\n\ndef rle_decode(s: str) -> str:\n    """Inverse of rle_encode; counts may have several digits ("12a1b")."""',
        "tests": """
assert rle_encode("aaabcc") == "3a1b2c"
assert rle_encode("") == ""
assert rle_encode("a" * 12 + "b") == "12a1b"
assert rle_decode("12a1b") == "a" * 12 + "b"
for t in ["", "x", "xyz", "zzzzzzzzzzzzzzzzzzzzzzzzzk  "]:
    assert rle_decode(rle_encode(t)) == t
""",
        "ref": """
import re
from itertools import groupby
def rle_encode(s): return "".join(f"{len(list(g))}{c}" for c, g in groupby(s))
def rle_decode(s): return "".join(c * int(n) for n, c in re.findall(r"(\\d+)(\\D)", s))
""",
    },
    {
        "id": "next_permutation",
        "prompt": 'def next_permutation(nums: list[int]) -> list[int]:\n    """Return (as a new list) the next lexicographically greater permutation; for the last permutation\n    return the first one (sorted ascending). Duplicates are allowed. Do not modify the input."""',
        "tests": """
assert next_permutation([1,2,3]) == [1,3,2]
assert next_permutation([3,2,1]) == [1,2,3]
assert next_permutation([1,1,5]) == [1,5,1]
assert next_permutation([1,5,1]) == [5,1,1]
a = [2,3,1]
assert next_permutation(a) == [3,1,2] and a == [2,3,1]
assert next_permutation([]) == []
""",
        "ref": """
def next_permutation(nums):
    a = list(nums); i = len(a) - 2
    while i >= 0 and a[i] >= a[i + 1]: i -= 1
    if i >= 0:
        j = len(a) - 1
        while a[j] <= a[i]: j -= 1
        a[i], a[j] = a[j], a[i]
    a[i + 1:] = reversed(a[i + 1:])
    return a
""",
    },
    {
        "id": "semver",
        "prompt": 'def semver_compare(a: str, b: str) -> int:\n    """Compare two SemVer 2.0 versions ("1.2.3", "1.0.0-alpha.1", build metadata "+build" is ignored).\n    Return -1, 0 or 1. Pre-release versions are lower than the release; pre-release identifiers compare\n    numerically when both are numeric, numeric < alphanumeric, otherwise ASCII; a shorter prefix set is lower."""',
        "tests": """
assert semver_compare("1.0.0", "2.0.0") == -1
assert semver_compare("1.10.0", "1.9.9") == 1
assert semver_compare("1.0.0-alpha", "1.0.0") == -1
assert semver_compare("1.0.0-alpha", "1.0.0-alpha.1") == -1
assert semver_compare("1.0.0-alpha.beta", "1.0.0-beta") == -1
assert semver_compare("1.0.0-beta.2", "1.0.0-beta.11") == -1
assert semver_compare("1.0.0-rc.1", "1.0.0-beta.11") == 1
assert semver_compare("1.0.0-1", "1.0.0-alpha") == -1
assert semver_compare("1.0.0+abc", "1.0.0+xyz") == 0
""",
        "ref": """
def semver_compare(a, b):
    def parse(v):
        v = v.split("+")[0]
        core, _, pre = v.partition("-")
        return [int(x) for x in core.split(".")], pre.split(".") if pre else []
    (ca, pa), (cb, pb) = parse(a), parse(b)
    if ca != cb: return -1 if ca < cb else 1
    if not pa or not pb: return (len(pb) > 0) - (len(pa) > 0) if (pa or pb) else 0
    for x, y in zip(pa, pb):
        if x == y: continue
        xd, yd = x.isdigit(), y.isdigit()
        if xd and yd: return -1 if int(x) < int(y) else 1
        if xd != yd: return -1 if xd else 1
        return -1 if x < y else 1
    return (len(pa) > len(pb)) - (len(pa) < len(pb))
""",
    },
    {
        "id": "csv_line",
        "prompt": 'def parse_csv_line(line: str) -> list[str]:\n    """Split one CSV line on commas. Fields may be wrapped in double quotes; inside quotes commas are literal\n    and "" means one quote character. Unquoted fields are returned as-is (no trimming).\n    Do not use the csv module."""',
        "tests": '''
assert parse_csv_line('a,b,c') == ['a', 'b', 'c']
assert parse_csv_line('"a,b",c') == ['a,b', 'c']
assert parse_csv_line('"he said ""hi""",x') == ['he said "hi"', 'x']
assert parse_csv_line('a,,') == ['a', '', '']
assert parse_csv_line('') == ['']
assert parse_csv_line(' a , b') == [' a ', ' b']
''',
        "ref": """
def parse_csv_line(line):
    out, cur, q, i = [], "", False, 0
    while i < len(line):
        c = line[i]
        if q:
            if c == '"':
                if i + 1 < len(line) and line[i + 1] == '"': cur += '"'; i += 1
                else: q = False
            else: cur += c
        elif c == '"': q = True
        elif c == ',': out.append(cur); cur = ""
        else: cur += c
        i += 1
    out.append(cur)
    return out
""",
    },
    {
        "id": "dijkstra",
        "prompt": 'def shortest_paths(graph: dict[str, dict[str, int]], src: str) -> dict[str, int]:\n    """Dijkstra on a directed graph with non-negative weights: graph[u][v] = weight of edge u->v.\n    Return the distance to every node reachable from src (src itself has 0). Nodes may appear only as edge\n    targets. Unreachable nodes are omitted."""',
        "tests": """
g = {"a": {"b": 1, "c": 4}, "b": {"c": 2, "d": 5}, "c": {"d": 1}, "e": {"a": 1}}
assert shortest_paths(g, "a") == {"a": 0, "b": 1, "c": 3, "d": 4}
assert shortest_paths(g, "d") == {"d": 0}
assert shortest_paths({"x": {"y": 0}}, "x") == {"x": 0, "y": 0}
""",
        "ref": """
import heapq
def shortest_paths(graph, src):
    dist = {src: 0}; pq = [(0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, float("inf")): continue
        for v, w in graph.get(u, {}).items():
            if d + w < dist.get(v, float("inf")):
                dist[v] = d + w; heapq.heappush(pq, (d + w, v))
    return dist
""",
    },
    {
        "id": "islands",
        "prompt": 'def count_islands(grid: list[str]) -> int:\n    """grid is a list of equal-length strings of "1" (land) and "0" (water). Count islands: groups of land\n    connected horizontally or vertically (not diagonally). Must handle grids up to 1000x1000 without\n    hitting the recursion limit."""',
        "tests": """
assert count_islands(["11000", "11000", "00100", "00011"]) == 3
assert count_islands(["101", "010", "101"]) == 5
assert count_islands([]) == 0
assert count_islands(["1" * 1000] * 1000) == 1
assert count_islands(["10" * 500] * 1000) == 500
""",
        "ref": """
def count_islands(grid):
    if not grid: return 0
    h, w = len(grid), len(grid[0]); seen = bytearray(h * w); n = 0
    for i in range(h):
        for j in range(w):
            if grid[i][j] == "1" and not seen[i * w + j]:
                n += 1; st = [(i, j)]; seen[i * w + j] = 1
                while st:
                    a, b = st.pop()
                    for x, y in ((a+1,b),(a-1,b),(a,b+1),(a,b-1)):
                        if 0 <= x < h and 0 <= y < w and grid[x][y] == "1" and not seen[x * w + y]:
                            seen[x * w + y] = 1; st.append((x, y))
    return n
""",
    },
    {
        "id": "rpn",
        "prompt": 'def eval_rpn(tokens: list[str]) -> int:\n    """Evaluate integer Reverse Polish Notation with + - * /. Division truncates toward zero (like C).\n    Raise ValueError on malformed input (too few operands, leftover operands, unknown token)."""',
        "tests": """
assert eval_rpn(["2","1","+","3","*"]) == 9
assert eval_rpn(["4","13","5","/","+"]) == 6
assert eval_rpn(["-7","2","/"]) == -3
assert eval_rpn(["10","6","9","3","+","-11","*","/","*","17","+","5","+"]) == 22
for bad in [["+"], ["1","2"], ["1","x","+"], []]:
    try:
        eval_rpn(bad)
    except ValueError:
        pass
    else:
        raise AssertionError(bad)
""",
        "ref": """
def eval_rpn(tokens):
    st = []
    for t in tokens:
        if t in "+-*/" and len(t) == 1:
            if len(st) < 2: raise ValueError("operands")
            b, a = st.pop(), st.pop()
            st.append(a + b if t == "+" else a - b if t == "-" else a * b if t == "*" else int(a / b))
        else:
            try: st.append(int(t))
            except ValueError: raise ValueError(t)
    if len(st) != 1: raise ValueError("leftover")
    return st[0]
""",
    },
    {
        "id": "camel_to_snake",
        "prompt": 'def camel_to_snake(name: str) -> str:\n    """Convert camelCase / PascalCase to snake_case. Acronyms stay together and digits stick to the\n    preceding word: "HTTPServerError" -> "http_server_error", "getHTTP2Response" -> "get_http2_response",\n    "userID" -> "user_id", "already_snake" -> "already_snake", "X" -> "x"."""',
        "tests": """
assert camel_to_snake("HTTPServerError") == "http_server_error"
assert camel_to_snake("getHTTP2Response") == "get_http2_response"
assert camel_to_snake("userID") == "user_id"
assert camel_to_snake("already_snake") == "already_snake"
assert camel_to_snake("X") == "x"
assert camel_to_snake("simpleTest") == "simple_test"
assert camel_to_snake("parseXMLDoc") == "parse_xml_doc"
""",
        "ref": """
import re
def camel_to_snake(name):
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\\1_\\2", name)
    s = re.sub(r"([a-z0-9])([A-Z])", r"\\1_\\2", s)
    return s.lower()
""",
    },
]


if __name__ == "__main__":
    ok = 0
    for p in PROBLEMS:
        ns: dict = {}
        try:
            exec(p["ref"], ns)
            exec(p["tests"], ns)
            ok += 1
        except Exception as e:  # noqa: BLE001
            print("REF FAILS", p["id"], repr(e))
    print(f"{ok}/{len(PROBLEMS)} reference solutions pass")
