#!/usr/bin/env bash
# 定点提取球棒狸资源：只喂 AnimeStudio 那 5 个真正含随宠资源的 block。
#
# 为什么这么做：AnimeStudio 每次都要遍历传入目录里**全部** block。
# 全量是 9450 个（60 G），每次跑几分钟起步；而实测含 w5_limao_00 资源的
# 只有 5 个 block（从 3.3 GB asset map 流式 grep 出来的，见
# docs/球棒狸资源定位.md）。先把这 5 个复制到一个小目录，再导出 = 秒级。
set +e
SRC="D:/MHY/miHoYo Launcher/games/Star Rail Game/StarRail_Data/StreamingAssets/Asb/Windows"
WORK="E:/hsr-pet-extract/blocks"
LIST="/d/hsr-pet/dl/map_hits/limao_blocks.txt"
OUT="E:/hsr-pet-extract/export2"
CLI_DIR="/d/hsr-pet/tools/AnimeStudio/AnimeStudio-net9-e616e3f824f47dd68cfbd44977bf8584756ac446"

mkdir -p "$WORK"
echo "=== 复制相关 block 到 $WORK ==="
n=0
while read -r b; do
  [ -z "$b" ] && continue
  if [ -f "$SRC/$b.block" ]; then
    cp -n "$SRC/$b.block" "$WORK/" && { echo "  + $b.block ($(du -h "$WORK/$b.block" | cut -f1))"; n=$((n+1)); }
  else
    echo "  ! 缺失 $b.block"
  fi
done < "$LIST"
echo "已复制 $n 个 block，总大小: $(du -sh "$WORK" | cut -f1)"

cd "$CLI_DIR" || exit 1

# Windows 侧路径
WIN_WORK=$(cygpath -w "$WORK")
WIN_OUT=$(cygpath -w "$OUT")

echo
echo "=== 导出：模型 + 动画 + 贴图 + 材质（只扫这 5 个 block）==="
time ./AnimeStudio.CLI.exe "$WIN_WORK" "$WIN_OUT" \
  --game SR \
  --containers 'characters/monster/w5_limao_00/' \
  --export_type Convert --group_assets ByContainer \
  --logger_flags Warning 2>&1 | tail -12

echo
echo "=== 结果 ==="
echo "总文件: $(find "$OUT" -type f 2>/dev/null | wc -l)"
find "$OUT" -type f \( -name '*.fbx' -o -name '*.png' -o -name '*.mat' \) 2>/dev/null \
  | sed "s|$OUT/||" | sort
du -sh "$OUT" 2>/dev/null