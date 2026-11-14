r"""Graft a separate MTP draft head (blk.N.* + nextn) into a main GGUF so llama.cpp runs it as built-in MTP.

Why: a separate `-md mtp-*.gguf` brings its own output.weight (521 MiB on the GPU), its own llama context
(compute buffers) and an f16 KV cache. Built-in MTP shares the main model's output head and context, which
frees VRAM for a longer context. Only metadata changes: <arch>.block_count += 1, <arch>.nextn_predict_layers = 1.
Tensor data is copied byte for byte — nothing is re-quantized.

  python -u scripts/stage0/graft-mtp.py MAIN.gguf MTP.gguf OUT.gguf [--output-from DONOR.gguf]

--output-from takes output.weight (the LM head, always on the GPU) from another quant of the SAME model, e.g.
unsloth's imatrix Q5_K (834 MiB) instead of baa-ai's Q6_K (995 MiB) — no double quantization, just a swap.
"""
from __future__ import annotations

import os
import struct
import sys
import time

SCALAR = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}
T_UINT32 = 4


class Reader:
    def __init__(self, path: str):
        self.path = path
        self.f = open(path, "rb")
        if self.f.read(4) != b"GGUF":
            raise SystemExit(f"{path}: not a GGUF file")
        self.version, = struct.unpack("<I", self.f.read(4))
        n_tensors, n_kv = struct.unpack("<QQ", self.f.read(16))
        self.kv: list[tuple[str, int, bytes]] = []  # key, type, raw value bytes
        self.values: dict[str, object] = {}
        for _ in range(n_kv):
            key = self._str()
            typ, = struct.unpack("<I", self.f.read(4))
            start = self.f.tell()
            val = self._val(typ)
            end = self.f.tell()
            self.f.seek(start)
            self.kv.append((key, typ, self.f.read(end - start)))
            self.values[key] = val
        self.tensors: list[dict] = []
        for _ in range(n_tensors):
            name = self._str()
            nd, = struct.unpack("<I", self.f.read(4))
            dims = struct.unpack(f"<{nd}Q", self.f.read(8 * nd))
            typ, off = struct.unpack("<IQ", self.f.read(12))
            self.tensors.append({"name": name, "dims": dims, "type": typ, "off": off})
        self.align = int(self.values.get("general.alignment", 32))
        self.data_start = pad(self.f.tell(), self.align)
        size = os.path.getsize(path)
        order = sorted(self.tensors, key=lambda t: t["off"])
        for i, t in enumerate(order):  # byte size = distance to the next tensor (includes its alignment padding)
            nxt = order[i + 1]["off"] if i + 1 < len(order) else size - self.data_start
            t["size"] = nxt - t["off"]

    def _str(self) -> str:
        n, = struct.unpack("<Q", self.f.read(8))
        return self.f.read(n).decode("utf-8")

    def _val(self, typ: int):
        if typ in SCALAR:
            fmt = SCALAR[typ]
            return struct.unpack(fmt, self.f.read(struct.calcsize(fmt)))[0]
        if typ == 8:
            return self._str()
        if typ == 9:
            et, n = struct.unpack("<IQ", self.f.read(12))
            return [self._val(et) for _ in range(n)]
        raise SystemExit(f"{self.path}: unknown GGUF value type {typ}")


def pad(n: int, a: int) -> int:
    return (n + a - 1) // a * a


def gstr(s: str) -> bytes:
    b = s.encode("utf-8")
    return struct.pack("<Q", len(b)) + b


def main() -> int:
    argv = sys.argv[1:]
    donor_p = None
    if "--output-from" in argv:
        i = argv.index("--output-from")
        donor_p = argv[i + 1]
        del argv[i:i + 2]
    if len(argv) != 3:
        print(__doc__)
        return 2
    main_p, mtp_p, out_p = argv
    if os.path.exists(out_p):
        raise SystemExit(f"{out_p} exists — refusing to overwrite")
    m, d = Reader(main_p), Reader(mtp_p)
    arch = m.values["general.architecture"]
    if d.values.get("general.architecture") != arch:
        raise SystemExit(f"arch mismatch: {arch} vs {d.values.get('general.architecture')}")
    n_layer = int(m.values[f"{arch}.block_count"])
    if m.values.get(f"{arch}.nextn_predict_layers"):
        raise SystemExit("main model already has nextn layers")
    if int(d.values[f"{arch}.block_count"]) != n_layer + 1:
        raise SystemExit(f"MTP file block_count {d.values[f'{arch}.block_count']} != {n_layer}+1")
    for k in ("embedding_length", "feed_forward_length", "attention.head_count", "attention.head_count_kv",
              "attention.key_length", "attention.value_length"):
        if m.values.get(f"{arch}.{k}") != d.values.get(f"{arch}.{k}"):
            raise SystemExit(f"shape mismatch on {k}")
    prefix = f"blk.{n_layer}."
    graft = [t for t in d.tensors if t["name"].startswith(prefix)]
    if not graft or not any(".nextn." in t["name"] for t in graft):
        raise SystemExit(f"no {prefix}*nextn* tensors in {mtp_p}")

    # metadata: main's KV with block_count+1 and nextn_predict_layers=1 inserted right after it
    kv_out = []
    for key, typ, raw in m.kv:
        if key == f"{arch}.block_count":
            fmt = SCALAR[typ]
            kv_out.append((key, typ, struct.pack(fmt, n_layer + 1)))
            kv_out.append((f"{arch}.nextn_predict_layers", T_UINT32, struct.pack("<I", 1)))
        else:
            kv_out.append((key, typ, raw))

    tensors = [dict(t, src=m) for t in m.tensors] + [dict(t, src=d) for t in graft]
    if donor_p:
        dn = Reader(donor_p)
        if dn.values.get("general.architecture") != arch:
            raise SystemExit(f"donor arch mismatch: {dn.values.get('general.architecture')}")
        donor = next((t for t in dn.tensors if t["name"] == "output.weight"), None)
        i = next((k for k, t in enumerate(tensors) if t["name"] == "output.weight"), None)
        if donor is None or i is None or tuple(donor["dims"]) != tuple(tensors[i]["dims"]):
            raise SystemExit("output.weight missing or shape differs between main and donor")
        print(f"output.weight: type {tensors[i]['type']} {tensors[i]['size'] / 2**20:.0f} MiB -> donor type "
              f"{donor['type']} {donor['size'] / 2**20:.0f} MiB", flush=True)
        tensors[i] = dict(donor, src=dn)
    off = 0
    for t in tensors:
        t["new_off"] = off
        off = pad(off + t["size"], m.align)

    head = bytearray(b"GGUF" + struct.pack("<IQQ", m.version, len(tensors), len(kv_out)))
    for key, typ, raw in kv_out:
        head += gstr(key) + struct.pack("<I", typ) + raw
    for t in tensors:
        head += gstr(t["name"]) + struct.pack("<I", len(t["dims"])) + struct.pack(f"<{len(t['dims'])}Q", *t["dims"])
        head += struct.pack("<IQ", t["type"], t["new_off"])
    head += b"\0" * (pad(len(head), m.align) - len(head))

    total = len(head) + off
    print(f"main {len(m.tensors)} tensors + {len(graft)} grafted ({sum(t['size'] for t in graft) / 2**20:.0f} MiB) "
          f"-> {total / 2**30:.2f} GiB, block_count {n_layer} -> {n_layer + 1}", flush=True)
    tmp = out_p + ".part"
    t0, done, last = time.time(), 0, 0.0
    with open(tmp, "wb") as o:
        o.write(head)
        base = len(head)
        for t in tensors:
            src = t["src"]
            src.f.seek(src.data_start + t["off"])
            o.seek(base + t["new_off"])
            left = t["size"]
            while left:
                chunk = src.f.read(min(left, 64 << 20))
                if not chunk:
                    raise SystemExit(f"short read in {t['name']}")
                o.write(chunk)
                left -= len(chunk)
                done += len(chunk)
                if time.time() - last > 3:
                    last = time.time()
                    el = last - t0
                    print(f"  {done / 2**30:5.1f}/{off / 2**30:.1f} GiB · {done / 2**20 / max(el, 1e-6):.0f} MiB/s "
                          f"· {el:.0f}s", flush=True)
        o.truncate(total)
    os.replace(tmp, out_p)
    print(f"done in {time.time() - t0:.0f}s -> {out_p}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
