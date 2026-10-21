#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探查 HSR 4.x AssetBundle(Asb) 结构：manifest 格式 + .block 头部魔数。

目的：判断 AnimeStudio/AssetStudio 能否直接吃这些块，还是需要先自己解包。
"""
import os
import sys
import binascii

GAME = r"D:\MHY\miHoYo Launcher\games\Star Rail Game\StarRail_Data"
PERSIST = os.path.join(GAME, "Persistent", "Asb", "Windows")
STREAM = os.path.join(GAME, "StreamingAssets", "Asb", "Windows")


def hexdump(path, n=64):
    with open(path, "rb") as f:
        data = f.read(n)
    for i in range(0, len(data), 16):
        chunk = data[i:i + 16]
        hx = " ".join(f"{b:02x}" for b in chunk)
        asc = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        print(f"  {i:04x}  {hx:<47}  {asc}")
    return data


def describe_manifest(path):
    size = os.path.getsize(path)
    print(f"\n### {os.path.basename(path)}  ({size} bytes)")
    with open(path, "rb") as f:
        head = f.read(96)
    print("  head:", binascii.hexlify(head[:48]).decode())
    # 尝试按 utf-8 抓可见字符串
    with open(path, "rb") as f:
        blob = f.read()
    printable = []
    cur = bytearray()
    for b in blob[:200000]:
        if 32 <= b < 127:
            cur.append(b)
        else:
            if len(cur) >= 5:
                printable.append(cur.decode("ascii"))
            cur = bytearray()
    if len(cur) >= 5:
        printable.append(cur.decode("ascii"))
    print(f"  visible strings (>=5 chars), first 40 of {len(printable)}:")
    for s in printable[:40]:
        print("   ", s)


def main():
    print("=" * 70)
    print("1. Persistent manifest (.bytes) files")
    for name in sorted(os.listdir(PERSIST)):
        p = os.path.join(PERSIST, name)
        if name.endswith(".bytes"):
            describe_manifest(p)

    print("\n" + "=" * 70)
    print("2. StreamingAssets .block headers (first 5)")
    blocks = sorted(f for f in os.listdir(STREAM) if f.endswith(".block"))
    print(f"  total .block = {len(blocks)}")
    print(f"  total .block.hdiff = {len([f for f in os.listdir(STREAM) if f.endswith('.hdiff')])}")
    for name in blocks[:5]:
        p = os.path.join(STREAM, name)
        print(f"\n--- {name}  ({os.path.getsize(p)} bytes)")
        hexdump(p)

    print("\n" + "=" * 70)
    print("3. 是否存在未加密的 UnityFS 头（grep 前 2000 个块）")
    unityfs = 0
    checked = 0
    for name in blocks[:2000]:
        p = os.path.join(STREAM, name)
        with open(p, "rb") as f:
            sig = f.read(8)
        checked += 1
        if sig.startswith(b"UnityFS") or sig.startswith(b"UnityWeb") or sig.startswith(b"UnityRaw"):
            unityfs += 1
    print(f"  checked {checked} blocks -> UnityFS/Web/Raw signatures: {unityfs}")


if __name__ == "__main__":
    main()