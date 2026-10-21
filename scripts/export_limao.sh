#!/usr/bin/env bash
# 导出球棒狸（随宠开拓者原型）的模型 + 桌宠所需动画 + 贴图。
#
# 目标路径（从 3.3GB asset map 里查到的）：
#   模型  assets/asbres/characters/monster/w5_limao_00/model/monster_w5_limao_00_model.fbx
#   贴图  assets/asbres/characters/monster/w5_limao_00/texture/monster_w5_limao_00_body_color_a.tga
#         .../_body_lightmap.tga / _body_mask.tga / _eye_color_a.tga / warm_ramp / cool_ramp
#
# 桌宠 9 行 → 游戏动画映射（关键：adv_* = 随宠(maze)专用动作，正是游戏中跟随时播的）：
#   row0 idle          <- adv_ani_mazestandby   (随宠待机)
#   row1 running-right <- adv_ani_mazewalk      (随宠行走)
#   row2 running-left  <- adv_ani_mazewalk      (同一 clip，靠水平镜像)
#   row3 waving        <- adv_ani_shakehand     (挥手/打招呼)
#   row4 jumping       <- adv_ani_mazerun       (跑起来≈跳跃感)
#   row5 failed        <- adv_ani_kneelloop     (跪坐循环＝蔫了/难过)
#   row6 waiting       <- adv_ani_standby02     (站立待机2)
#   row7 running       <- adv_ani_mazestandby   (忙：随宠待机当"在思考")
#   row8 review        <- adv_ani_photo         (拍照＝说话/互动)
set +e
AS="D:\\MHY\\miHoYo Launcher\\games\\Star Rail Game\\StarRail_Data\\StreamingAssets\\Asb\\Windows"
OUT="E:\\hsr-pet-extract\\export"
CLI="/d/hsr-pet/tools/AnimeStudio/AnimeStudio-net9-e616e3f824f47dd68cfbd44977bf8584756ac446/AnimeStudio.CLI.exe"
cd "$(dirname "$CLI")" || exit 1

run() {
  desc="$1"; shift
  echo "--- $desc"
  ./AnimeStudio.CLI.exe "$AS" "$OUT" --game SR \
    --export_type Convert --group_assets ByContainer \
    "$@" --logger_flags Warning 2>&1 | tail -4
}

# 1) 模型 + 材质 + 贴图
run "MODEL+TEXTURE (w5_limao_00)" \
    --containers 'characters/monster/w5_limao_00/(model|texture|materials)/'

# 2) 随宠(maze)动作 —— 桌宠大部分行的来源
run "ANIM maze (standby/walk/run/photo)" \
    --containers 'characters/monster/w5_limao_00/animation/.*maze.*'

# 3) 手势动作 —— waving / 难过
run "ANIM gesture (shakehand/kneel)" \
    --containers 'characters/monster/w5_limao_00/animation/.*(shakehand|kneel).*'

echo
echo "=== 导出结果 ==="
find /e/hsr-pet-extract/export -type f \( -name '*.fbx' -o -name '*.tga' -o -name '*.png' -o -name '*.mat' \) \
  2>/dev/null | sed 's|.*/export/||' | sort | head -60
echo "总文件数: $(find /e/hsr-pet-extract/export -type f 2>/dev/null | wc -l)"
du -sh /e/hsr-pet-extract/export 2>/dev/null