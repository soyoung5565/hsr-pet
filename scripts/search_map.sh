#!/usr/bin/env bash
# 在 AnimeStudio 全量 asset map（3.3 GB）里流式搜索随宠相关资源。
#
# 为什么不直接 python json.load：full_map.json 有 3.3 GB，
# json.loads 会 MemoryError（已实测失败）。好消息是这个 JSON 是
# **每字段一行的**pretty-print 格式，所以可以逐行 grep，内存恒定。
#
# 用法: ./search_map.sh <map.json> [关键字...]
set +e
MAP="$1"; shift
KEYS=("$@")
if [ ${#KEYS[@]} -eq 0 ]; then
  KEYS=("Pet" "Trailblazer" "Charm" "PetMarble" "Suipet" "Follower")
fi

OUT=/d/hsr-pet/dl/map_hits
rm -rf "$OUT"; mkdir -p "$OUT"

echo "map = $MAP ($(du -h "$MAP" | cut -f1))"
for k in "${KEYS[@]}"; do
  # Container 行包含资源路径，是最有效的过滤面
  grep -i -- "$k" "$MAP" > "$OUT/$k.txt" 2>/dev/null
  n=$(wc -l < "$OUT/$k.txt")
  printf '%-14s %10s 行命中\n' "$k" "$n"
done

echo
echo "=== 把 Container 行还原成可读的资源路径（去重 + 排序）==="
cat "$OUT"/*.txt \
  | grep '"Container"' \
  | sed 's/.*"Container": "//; s/",\s*$//' \
  | sort -u > "$OUT/containers.txt"
echo "唯一资源路径: $(wc -l < "$OUT/containers.txt")"

echo
echo "=== 只看含 mesh/model/animation 的（真正要做成桌宠的素材）==="
grep -iE '\.(fbx|mesh|mdl|anim|animation)|/mesh/|/model/|anim|skel' \
  "$OUT/containers.txt" > "$OUT/meshlike.txt"
echo "mesh/animation 类: $(wc -l < "$OUT/meshlike.txt")"
head -40 "$OUT/meshlike.txt"

echo
echo "=== pet 相关路径里最像模型/动作的（top 60）==="
grep -iE 'pet' "$OUT/containers.txt" \
  | grep -viE '\.(png|jpg|prefab|ttf|bytes|ogg|wav|mp3|usm)$' \
  | head -60

echo
echo "输出目录: $OUT"