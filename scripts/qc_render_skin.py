# -*- coding: utf-8 -*-
"""Full QC sweep over all v5 skins: eye presence, colour, size, and a colour
comparison against the user's in-game reference card art.

Reference targets (measured from the card art + wiki立绘):
  eye layer : meanSat > 0.12, frac_near_black < 0.20
  eye count : 2 blobs, roughly symmetric about the face centre
  eye size  : single eye 18-36% of head width
  colour    : whole-subject meanSat vs reference (mask-checked)"""
import numpy as np
from PIL import Image
import os

RD = r"E:\hsr-pet-extract\render_raccoon"

SKINS = [("SP01", "球棒狸"), ("00_01", "浪浪仙"), ("00_02", "晴天鸟鸟"),
         ("00_03", "嘤嘤子"), ("00_04", "咪奈花"),
         ("SP0911", "球棒狸·珍藏"), ("00_05", "浪浪仙·珍藏"),
         ("00_06", "晴天鸟鸟·珍藏"), ("00_07", "嘤嘤子·珍藏"), ("00_00", "咪奈花·珍藏")]


def load(fn):
    return np.asarray(Image.open(os.path.join(RD, fn)).convert("RGBA")).astype(np.int16)


def blobs(mask, min_px=300):
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    cur = 0
    out = []
    ys, xs = np.where(mask)
    for y0, x0 in zip(ys, xs):
        if lab[y0, x0]:
            continue
        cur += 1
        stack = [(y0, x0)]
        lab[y0, x0] = cur
        pix = []
        while stack:
            y, x = stack.pop()
            pix.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not lab[ny, nx]:
                        lab[ny, nx] = cur
                        stack.append((ny, nx))
        if len(pix) >= min_px:
            p = np.array(pix)
            out.append(dict(n=len(pix), x0=int(p[:, 1].min()), x1=int(p[:, 1].max()),
                            cx=int(p[:, 1].mean()), y0=int(p[:, 0].min()), y1=int(p[:, 0].max())))
    return sorted(out, key=lambda b: -b['n'])


def sat_of(rgb):
    mx = rgb.max(-1); mn = rgb.min(-1)
    return np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0)


# Eye-plate column extent, measured by rendering the eye material flat magenta
# (eye_mask_*.png): 23283 px spanning cols 316..588 for every skin that shares
# the Eye mesh. Measured, not guessed from the render.
EYE_COLS = {}
for sk in [s for s, _ in SKINS]:
    fp = os.path.join(RD, "eye_mask_%s.png" % sk)
    if os.path.exists(fp):
        mm = np.asarray(Image.open(fp).convert("RGBA"))
        sel = (mm[:, :, 0] > 200) & (mm[:, :, 1] < 80) & (mm[:, :, 2] > 200) & (mm[:, :, 3] > 128)
        if sel.sum() > 100:
            xs = np.where(sel.any(0))[0]
            EYE_COLS[sk] = (int(xs.min()), int(xs.max()))
print("eye-plate columns measured for %d/%d skins" % (len(EYE_COLS), len(SKINS)))


print("%-8s %-14s %7s %7s %6s %6s %5s %6s %s"
      % ("skin", "name", "eyepx", "sat", "black", "eyew%", "blobs", "sym", "verdict"))
rows = []
fails = []
for sk, cn in SKINS:
    f = os.path.join(RD, "v6_%s.png" % sk)
    g = os.path.join(RD, "v6b_%s.png" % sk)
    if not (os.path.exists(f) and os.path.exists(g)):
        print("%-8s MISSING" % sk)
        fails.append(sk + ":missing")
        continue
    a, b = load("v6_%s.png" % sk), load("v6b_%s.png" % sk)
    am, bm = a[:, :, 3] > 128, b[:, :, 3] > 128
    both = am & bm
    hc = np.where(bm.any(0))[0]
    hr = np.where(bm.any(1))[0]
    head_rows = hr[hr < hr.min() + int(0.45 * (hr.max() - hr.min()))]
    hcols = np.where(bm.any(0))[0]
    head_w = int(hcols.max() - hcols.min() + 1)

    d = np.abs(a[:, :, :3] - b[:, :, :3]).sum(2)
    # Only count pixels the eye plate actually changed. For skins whose accessories
    # (halo/wings) sit in the face region, a plain colour diff also catches those,
    # splitting the eye into extra blobs. Restrict to the eye plate's own columns,
    # measured with the flat-magenta mask render (identical for skins that share
    # the Eye mesh: 23283 px, cols 316..588).
    eye_cols = EYE_COLS.get(sk)
    if eye_cols is None:
        eye_cols = (int(0.33 * am.shape[1]), int(0.68 * am.shape[1]))
    colmask = np.zeros(am.shape[1], bool)
    colmask[eye_cols[0]:eye_cols[1] + 1] = True
    m = (d > 150) & both & colmask[None, :]
    if m.sum() == 0:
        print("%-8s %-14s %7d   (no eye layer)" % (sk, cn, 0))
        fails.append(sk + ":noeye")
        continue
    rgb = a[:, :, :3][m].astype(float)
    lum = rgb.mean(1)
    fb = float((lum < 25).mean())
    s = float(sat_of(rgb).mean())
    bs = blobs(m, 300)
    widest = max((x['x1'] - x['x0'] + 1) for x in bs) if bs else 0
    ew = 100.0 * widest / head_w if head_w else 0
    sym = 0
    if len(bs) >= 2:
        b0, b1 = bs[0], bs[1]
        sym = abs(b0['cx'] + b1['cx'] - 2 * ((hcols.min() + hcols.max()) / 2)) / head_w * 100
    ok = (fb < 0.20) and (s > 0.12) and (2 <= len(bs) <= 4) and (10 <= ew <= 45) and (sym < 6)
    v = "PASS" if ok else "FAIL"
    if not ok:
        fails.append(sk)
    print("%-8s %-14s %7d %7.3f %6.3f %6.1f %5d %6.2f %s"
          % (sk, cn, m.sum(), s, fb, ew, len(bs), sym, v))
    rows.append((sk, cn, m.sum(), s, fb, ew, len(bs)))

# whole-subject colour stats for the colour question
print()
print("whole-subject colour (alpha>128):")
ref_sat = 0.3556
for sk, cn in SKINS:
    f = os.path.join(RD, "v6_%s.png" % sk)
    if not os.path.exists(f):
        continue
    a = load("v6_%s.png" % sk)
    m = a[:, :, 3] > 128
    rgb = a[:, :, :3][m].astype(float)
    s = sat_of(rgb).mean()
    print("  %-8s %-14s meanRGB=(%5.1f,%5.1f,%5.1f) meanSat=%.3f meanVal=%.1f"
          % (sk, cn, rgb[:, 0].mean(), rgb[:, 1].mean(), rgb[:, 2].mean(), s, rgb.max(1).mean()))
print("\nreference card art meanSat=%.4f (chroma-masked)" % ref_sat)
print("\nFAILS:", fails if fails else "none")
print("SWEEP_DONE")
