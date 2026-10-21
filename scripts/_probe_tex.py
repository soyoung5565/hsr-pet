
import sys
from PIL import Image
import numpy as np
base = r"E:\hsr-pet-extract\export_raccoon\assets\asbres\characters\npc\special\raccoonsp_00\texture"
for n in ["NPC_Special_RaccoonSP_00_01_Body_LightMap.png",
          "NPC_Special_RaccoonSP_00_01_Body_Color.png",
          "NPC_Special_RaccoonSP_00_01_Cool_Ramp.png",
          "NPC_Special_RaccoonSP_00_01_Warm_Ramp.png",
          "MaterialIDValuesLUTNPC_Special_RaccoonSP_00_01_Body_Mat.png",
          "NPC_Special_RaccoonSP_00_01_Item_Mask.png"]:
    p = base + "\\" + n
    im = Image.open(p)
    a = np.array(im.convert("RGBA"))
    print("="*70)
    print(n, " size:", im.size, " mode:", im.mode)
    if "LightMap" in n or "Ramp" in n or "LUT" in n or "Mask" in n:
        for ci, cn in enumerate("RGBA"):
            ch = a[..., ci]
            print(f"  {cn}: min={ch.min():>4} max={ch.max():>4} mean={ch.mean():7.2f} uniq={len(np.unique(ch))}")
