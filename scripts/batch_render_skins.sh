#!/bin/bash
# Batch v6: full renders + same-pipeline no-eye baselines, all 10 skins.
set +e
BL="/c/Program Files/Blender Foundation/Blender 4.2/blender.exe"
E="E:/hsr-pet-extract/export_raccoon/assets/asbres/characters/npc/special"
S="$E/raccoonsp_00"; R="$E/raccoon_00"
Y="E:/hsr-pet-extract/render_raccoon"
X="E:/hsr-pet-extract/eyefix3"
P="E:/hsr-pet-extract/render_v6.py"

run () { # name fbx eyetex mode tag
  "$BL" -b --factory-startup -P "$P" -- "$2" "$Y/$5_$1.png" 900 0 "$3" "$4" > "$Y/$5_$1.log" 2>&1
  if grep -q "V6_DONE" "$Y/$5_$1.log"; then echo "OK   $5 $1"; else
    echo "FAIL $5 $1"; grep -E "Error|Traceback|NO TEXTURE" "$Y/$5_$1.log" | head -3; fi
}

run SP01   "$S/Art_NPC_Special_RaccoonSP_00.fbx" "$X/SP01_eye.png"   orig   v6
run SP0911 "$S/Art_NPC_Special_RaccoonSP_00.fbx" "$X/SP0911_eye.png" orig   v6
for i in 00 01 02 03 04 05 06 07; do
  run "00_$i" "$R/Art_NPC_Special_Raccoon_00_$i.fbx" "$X/00_${i}_eye.png" orig v6
done

run SP01   "$S/Art_NPC_Special_RaccoonSP_00.fbx" - noeye v6b
run SP0911 "$S/Art_NPC_Special_RaccoonSP_00.fbx" - noeye v6b
for i in 00 01 02 03 04 05 06 07; do
  run "00_$i" "$R/Art_NPC_Special_Raccoon_00_$i.fbx" - noeye v6b
done
echo V6_BATCH_DONE
