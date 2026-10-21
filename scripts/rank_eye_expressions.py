# -*- coding: utf-8 -*-
"""Is the chosen expression actually the OPEN-EYE one?

The vision read of 00_01 said the eyes look closed. Two possibilities:
  (a) we picked a closed-eye sprite -> wrong expression, must re-pick
  (b) the sprite is open-eyed but renders small/blurred at this size
Measure the source sprite itself: an open anime eye has a large IRIS (a
saturated, mid-luminance region) enclosed by a dark outline. A closed eye is
mostly a thin dark arc, so its "saturated area / total area" is far lower and
its solidity (pixels / bbox area) is tiny.
Score every candidate pair in the atlas and print the ranking."""
import numpy as np
from PIL import Image
import os, json

TEX = r"E:\hsr-pet-extract\export_raccoon\assets\asbres\characters\npc\special"


def components(mask, min_px=800):
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32); cur = 0; out = []
    ys, xs = np.where(mask)
    for y0, x0 in zip(ys, xs):
        if lab[y0, x0]:
            continue
        cur += 1; stack = [(y0, x0)]; lab[y0, x0] = cur; pix = []
        while stack:
            y, x = stack.pop(); pix.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not lab[ny, nx]:
                        lab[ny, nx] = cur; stack.append((ny, nx))
        if len(pix) >= min_px:
            p = np.array(pix)
            out.append(dict(n=len(pix), x0=int(p[:, 1].min()), x1=int(p[:, 1].max()),
                            y0=int(p[:, 0].min()), y1=int(p[:, 0].max())))
    return out


SKINS = {"SP01": r"raccoonsp_00\texture\NPC_Special_RaccoonSP_00_01_Eyes_Color.png",
         "00_01": r"raccoon_00\texture\NPC_Special_Raccoon_00_01_Eyes_Color.png",
         "00_03": r"raccoon_00\texture\NPC_Special_Raccoon_00_03_Eyes_Color.png"}

for skin, rel in SKINS.items():
    fp = os.path.join(TEX, rel)
    im = Image.open(fp).convert("RGBA")
    W, H = im.size
    a = np.asarray(im).astype(float)
    alpha = a[:, :, 3] > 24
    wy0, wy1 = round((1 - 0.7760) * H), round((1 - 0.2545) * H)
    comps = [dict(c, y0=c['y0'] + wy0, y1=c['y1'] + wy0)
             for c in components(alpha[wy0:wy1, :], 800)]
    print("=" * 74)
    print("%s — candidate eye sprites, ranked by 'openness'" % skin)
    rows = []
    for c in comps:
        sub = a[c['y0']:c['y1'] + 1, c['x0']:c['x1'] + 1, :3]
        m = alpha[c['y0']:c['y1'] + 1, c['x0']:c['x1'] + 1]
        w = c['x1'] - c['x0'] + 1; h = c['y1'] - c['y0'] + 1
        if w < 30 or h < 20:
            continue
        px = sub[m]
        if len(px) == 0:
            continue
        lum = px.mean(1)
        mx = px.max(1); mn = px.min(1)
        sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
        solidity = m.sum() / float(w * h)
        # openness: bright+saturated interior area relative to bbox, plus solidity
        iris = ((lum > 60) & (sat > 0.25)).sum() / float(w * h)
        rows.append((c, w, h, solidity, iris, px[:, 0].mean(), px[:, 1].mean(), px[:, 2].mean()))
    rows.sort(key=lambda r: -(r[4] * 2 + r[3]))
    for c, w, h, sol, iris, r, g, b in rows[:8]:
        print("  x[%4d..%4d] y[%4d..%4d] %3dx%-3d solidity=%.3f iris=%.3f  meanRGB=(%5.1f,%5.1f,%5.1f) %s"
              % (c['x0'], c['x1'], c['y0'], c['y1'], w, h, sol, iris, r, g, b,
                 "<-- OPEN-EYE?" if iris > 0.06 else "closed/thin"))
print("OPEN_DONE")
