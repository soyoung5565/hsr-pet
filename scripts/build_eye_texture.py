# -*- coding: utf-8 -*-
"""Build a single-expression eye texture, placed BY THE REFERENCE PROPORTIONS.

Root cause measured: the Eye plate samples u[0.002,0.999] x v[0.2545,0.7760] of a
2048x1024 atlas. Inside that window the atlas holds ~8 expression PAIRS (two eyes
each) both side-by-side AND stacked -> the plate averaged all of them into a dark
muddy slab (measured: 95.9% of sampled pixels near-black).

The game picks one expression with the material's Mapping offset. We do it by
construction: take the open-eye pair (2D blob detection) and place ONE eye into
each half-window at the reference proportion.

Reference (wiki立绘 + in-game card art): one eye spans 25-30% of face width; the
two eyes together ~60%, centred -> eye centres at 20% and 80% of face width.
Face span in UV = [0.0021, 0.9989] = cols 4..2046 (2042 px)."""
from PIL import Image
import numpy as np, os, json

TEX = r"E:\hsr-pet-extract\export_raccoon\assets\asbres\characters\npc\special"
OUT = r"E:\hsr-pet-extract\eyefix3"
os.makedirs(OUT, exist_ok=True)

LU0, RU1 = 0.0021, 0.9989          # mesh's full u span = the face
V0, V1 = 0.2545, 0.7760            # mesh's v window
EYE_FRAC = 0.275                   # one eye as a fraction of face width (target 25-30)
CENTRE_L, CENTRE_R = 0.205, 0.795  # eye centres as a fraction of face width

SKINS = {"SP01": r"raccoonsp_00\texture\NPC_Special_RaccoonSP_00_01_Eyes_Color.png",
         "SP0911": r"raccoonsp_00\texture\NPC_Special_RaccoonSP_00_11_Eyes_Color.png"}
for i in range(8):
    SKINS["00_%02d" % i] = r"raccoon_00\texture\NPC_Special_Raccoon_00_%02d_Eyes_Color.png" % i


def components(mask, min_px=800):
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
                            y0=int(p[:, 0].min()), y1=int(p[:, 0].max()),
                            cy=float(p[:, 0].mean())))
    return out


def overlap(a, b):
    return min(a['y1'], b['y1']) - max(a['y0'], b['y0'])


rep = {}
for skin, rel in SKINS.items():
    fp = os.path.join(TEX, rel)
    if not os.path.exists(fp):
        print("MISS", skin)
        continue
    im = Image.open(fp).convert("RGBA")
    W, H = im.size
    alpha = np.asarray(im)[:, :, 3] > 24

    wy0, wy1 = round((1 - V1) * H), round((1 - V0) * H)
    comps = components(alpha[wy0:wy1, :], 800)
    comps = [dict(c, y0=c['y0'] + wy0, y1=c['y1'] + wy0, cy=c['cy'] + wy0) for c in comps]
    comps.sort(key=lambda c: -c['n'])
    print("=" * 66)
    print("%s  atlas %dx%d  window rows %d..%d  blobs=%d"
          % (skin, W, H, wy0, wy1, len(comps)))
    for c in comps[:10]:
        print("   n=%6d  %3dx%-3d  x[%4d..%4d] y[%3d..%3d] aspect=%.2f"
              % (c['n'], c['x1'] - c['x0'] + 1, c['y1'] - c['y0'] + 1,
                 c['x0'], c['x1'], c['y0'], c['y1'],
                 (c['x1'] - c['x0'] + 1) / max(1, c['y1'] - c['y0'] + 1)))

    # pick the PAIR: two blobs, same vertical band, similar size, largest total
    best = None
    for i in range(len(comps)):
        for j in range(i + 1, len(comps)):
            a, b = comps[i], comps[j]
            wa, wb = a['x1'] - a['x0'] + 1, b['x1'] - b['x0'] + 1
            ha, hb = a['y1'] - a['y0'] + 1, b['y1'] - b['y0'] + 1
            if abs(wa - wb) > max(10, 0.2 * max(wa, wb)):
                continue
            if abs(ha - hb) > max(12, 0.5 * max(ha, hb)):
                continue
            if overlap(a, b) < 0.5 * min(ha, hb):
                continue
            score = a['n'] + b['n']
            if best is None or score > best[0]:
                best = (score, a, b)
    if not best:
        print("   no matching pair -> skip")
        continue
    _, A, B = best
    if A['x0'] > B['x0']:
        A, B = B, A
    print("   chosen pair: A x[%d..%d] y[%d..%d] | B x[%d..%d] y[%d..%d]"
          % (A['x0'], A['x1'], A['y0'], A['y1'], B['x0'], B['x1'], B['y0'], B['y1']))

    artL = im.crop((A['x0'], A['y0'], A['x1'] + 1, A['y1'] + 1))
    artR = im.crop((B['x0'], B['y0'], B['x1'] + 1, B['y1'] + 1)).transpose(Image.FLIP_LEFT_RIGHT)
    print("   art sizes L=%s R=%s" % (artL.size, artR.size))

    face_x0, face_x1 = round(LU0 * W), round(RU1 * W)
    face_w = face_x1 - face_x0
    win_y0, win_y1 = wy0, wy1
    win_h = win_y1 - win_y0
    target_w = int(face_w * EYE_FRAC)

    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    placed = []
    for art, frac in ((artL, CENTRE_L), (artR, CENTRE_R)):
        sc = target_w / art.width
        tw2, th2 = max(1, int(round(art.width * sc))), max(1, int(round(art.height * sc)))
        if th2 > win_h:
            sc = win_h / art.height
            tw2, th2 = max(1, int(round(art.width * sc))), win_h
        fit = art.resize((tw2, th2), Image.LANCZOS)
        cx = face_x0 + int(face_w * frac)
        px = cx - tw2 // 2
        py = win_y0 + (win_h - th2) // 2
        px = max(0, min(W - tw2, px))
        out.paste(fit, (px, py))
        placed.append((px, py, tw2, th2))

    op = os.path.join(OUT, "%s_eye.png" % skin)
    out.save(op)
    chk = np.asarray(out)[:, :, 3] > 24
    cc = np.where(chk.any(0))[0]
    if len(cc):
        ew = cc.max() - cc.min() + 1
        pct = 100.0 * ew / face_w
        print("   -> %s  eye span=%d px  = %.1f%% of face width   %s"
              % (os.path.basename(op), ew, pct, "PASS" if 20 <= pct <= 36 else "CHECK"))
        print("      placed: %s" % placed)
    rep[skin] = dict(placed=[list(p) for p in placed], face_w=face_w,
                     target_w=target_w, art_L=list(artL.size), art_R=list(artR.size))

with open(os.path.join(OUT, "report.json"), "w") as f:
    json.dump(rep, f, indent=1)
print("\nEYECELL3_DONE")
