/**
 * pet-roam 单测 —— 与 pet-physics.test.ts 同样的自跑断言风格(打印通过数,不依赖 vitest)。
 *
 * 跑法:cd Desktop-pet/app && npx tsx shared/pet-roam.test.ts
 *
 * 覆盖重点(全部是多屏真实会遇到的边界):
 *   1. 单屏:走到左右沿折返,不出屏
 *   2. 双屏等高贴合:能跨过去,且跨屏后 y 贴合新屏地面
 *   3. 双屏**高度不同**:跨过去「掉台阶」,y 变成新屏地面
 *   4. 双屏**有垂直缝隙**:不算邻居 → 折返,绝不踩空
 *   5. 负坐标屏(主屏左边还有一块):margin 与折返都正确
 *   6. clampToNearestRect:把屏幕外的点拉回最近屏的地面
 *   7. 大宠物 / 小宠物:边距随尺寸缩放
 */
import {
  type RoamRect,
  roamGeometry,
  insideRect,
  pickRectAt,
  pickNearestRect,
  roamStep,
  clampToNearestRect,
} from './pet-roam.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(cond: boolean, name: string, extra?: unknown): void {
  if (cond) {
    pass++;
    return;
  }
  fail++;
  const detail = extra === undefined ? '' : `  ← 实际: ${JSON.stringify(extra)}`;
  failures.push(`${name}${detail}`);
}

function eq(actual: unknown, expected: unknown, name: string): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(same, name, { actual, expected });
}

function near(actual: number, expected: number, tol: number, name: string): void {
  const d = Math.abs(actual - expected);
  ok(d <= tol, `${name} (容差 ${tol}, 实际差 ${d.toFixed(2)})`, { actual, expected });
}

/* ============ 1. 单屏 ============ */

const SINGLE: RoamRect = { x: 0, y: 0, w: 1920, h: 1040 };
const PET_W = 192;
const PET_H = 208;

{
  const g = roamGeometry(SINGLE, PET_W, PET_H);
  eq(g.margin, Math.round(PET_W / 2 + 20), '单屏:边距 = 半身宽 + 20');
  eq(g.groundY, Math.round(1040 - PET_H / 2 - 10), '单屏:地面 = 底 - 半身高 - 10');

  // 从中间向右走很远 → 停在右沿并折返
  const r1 = roamStep([SINGLE], { x: 960, y: g.groundY }, 1, 5000, PET_W, PET_H);
  eq(r1.dir, -1, '单屏:走到右沿后朝向翻转');
  eq(r1.x, SINGLE.w - g.margin, '单屏:停在右沿(不越界)');
  ok(!r1.crossed, '单屏:不算跨屏');
  ok(insideRect(SINGLE, r1.x, r1.y), '单屏:结果点仍在屏内');

  const r2 = roamStep([SINGLE], { x: 960, y: g.groundY }, -1, 5000, PET_W, PET_H);
  eq(r2.dir, 1, '单屏:走到左沿后朝向翻转');
  eq(r2.x, g.margin, '单屏:停在左沿');

  // 正常小步走:不该折返
  const r3 = roamStep([SINGLE], { x: 960, y: g.groundY }, 1, 3, PET_W, PET_H);
  eq(r3.dir, 1, '单屏小步:朝向不变');
  near(r3.x, 963, 0.01, '单屏小步:位移等于步长');
  ok(!r3.crossed, '单屏小步:未跨屏');
}

/* ============ 2. 双屏等高贴合 ============ */

const LEFT: RoamRect = { x: 0, y: 0, w: 1920, h: 1040 };
const RIGHT_SAME_H: RoamRect = { x: 1920, y: 0, w: 1920, h: 1040 };

{
  const gL = roamGeometry(LEFT, PET_W, PET_H);
  // 从左侧屏右沿附近继续往右走 → 跨到右屏
  const atEdge = LEFT.x + LEFT.w - gL.margin;
  const r = roamStep([LEFT, RIGHT_SAME_H], { x: atEdge, y: gL.groundY }, 1, 60, PET_W, PET_H);
  ok(r.crossed, '等高双屏:能跨屏');
  ok(r.dir === 1, '等高双屏:跨屏后朝向不变');
  ok(insideRect(RIGHT_SAME_H, r.x, r.y), '等高双屏:落点在右屏内');

  const gR = roamGeometry(RIGHT_SAME_H, PET_W, PET_H);
  near(r.y, gR.groundY, 0.01, '等高双屏:y 贴合右屏地面');
  // 等高时两块屏 groundY 相同 → 看不出跳变,这正是期望
  eq(gL.groundY, gR.groundY, '等高双屏:两块屏地面等高');
}

/* ============ 3. 双屏底面不同高 → 掉台阶 ============ */

// 注意:判「地面是否不同」看的是**底边**(groundY = y + h - 半身高 - 10),
// 不是顶边。第一版测试数据写成「顶边下移、底边不变」(y:200,h:840 vs y:0,h:1040)
// → 两者底边都是 1040,groundY 相同,断言直接假红。真实差异必须让底边不同。
const RIGHT_LOWER: RoamRect = { x: 1920, y: 200, w: 1920, h: 740 }; // 底边 940 < 1040

{
  const gL = roamGeometry(LEFT, PET_W, PET_H);
  const gR = roamGeometry(RIGHT_LOWER, PET_W, PET_H);
  ok(gR.groundY !== gL.groundY, '不等高双屏:两块屏地面确实不同');

  const atEdge = LEFT.x + LEFT.w - gL.margin;
  const r = roamStep([LEFT, RIGHT_LOWER], { x: atEdge, y: gL.groundY }, 1, 60, PET_W, PET_H);
  ok(r.crossed, '不等高双屏:能跨屏');
  near(r.y, gR.groundY, 0.01, '不等高双屏:跨屏后 y 落到新屏地面(掉台阶)');
  ok(r.y !== gL.groundY, '不等高双屏:确实发生了 Y 跳变');
}

{
  // 反向:从低屏走回高屏
  const gR = roamGeometry(RIGHT_LOWER, PET_W, PET_H);
  const gL = roamGeometry(LEFT, PET_W, PET_H);
  const atEdge = RIGHT_LOWER.x + gR.margin;
  const r = roamStep([LEFT, RIGHT_LOWER], { x: atEdge, y: gR.groundY }, -1, 60, PET_W, PET_H);
  ok(r.crossed, '不等高双屏(反向):能跨回');
  near(r.y, gL.groundY, 0.01, '不等高双屏(反向):y 抬回高屏地面');
}

/* ============ 4. 高屏旁边贴一块矮屏 → 必须折返,绝不踩空 ============ */

// 真实场景:主屏(下方)旁边接一块小副屏(顶对齐,矮)。两块屏底边不同 → groundY 差很大。
// 判据是「落差是否可承受」:往下走允许(掉台阶),往上爬超过 STEP_UP_MAX(120) 就走不上去。
// 这里造一块**底边高于主屏**的副屏 → 从主屏右沿往右走需要「往上爬 200px」→ 应当挡住。
const RIGHT_SHORT: RoamRect = { x: 1920, y: 0, w: 1920, h: 300 };

{
  const gL = roamGeometry(LEFT, PET_W, PET_H);
  const gS = roamGeometry(RIGHT_SHORT, PET_W, PET_H);
  ok(gL.groundY - gS.groundY > 120, '高坎前置:确实超过 STEP_UP_MAX');
  const r = roamStep([LEFT, RIGHT_SHORT], { x: 960, y: gL.groundY }, 1, 5000, PET_W, PET_H);
  ok(!r.crossed, '往上爬 700px 的坎:跨不过去');
  eq(r.dir, -1, '高坎:折返');
  eq(r.x, LEFT.w - gL.margin, '高坎:停在主屏右沿');
  ok(insideRect(LEFT, r.x, r.y), '高坎:落点仍在主屏内(没有瞬移)');
}

// 另一种断桥:两屏水平方向根本没贴合(中间留 200px 空隙)
const RIGHT_GAP: RoamRect = { x: 2120, y: 0, w: 1920, h: 1040 };
{
  const gL = roamGeometry(LEFT, PET_W, PET_H);
  const r = roamStep([LEFT, RIGHT_GAP], { x: 960, y: gL.groundY }, 1, 5000, PET_W, PET_H);
  ok(!r.crossed, '屏间空隙:不跨屏');
  eq(r.dir, -1, '屏间空隙:折返');
}

/* ============ 5. 负坐标屏(主屏左侧还有一块)============ */

const NEG: RoamRect = { x: -1920, y: 0, w: 1920, h: 1040 };

{
  const gMain = roamGeometry(LEFT, PET_W, PET_H);
  const leftEdge = gMain.margin;
  const r = roamStep([NEG, LEFT], { x: leftEdge, y: gMain.groundY }, -1, 60, PET_W, PET_H);
  ok(r.crossed, '负坐标屏:能跨过去');
  ok(insideRect(NEG, r.x, r.y), '负坐标屏:落点在负坐标屏内');
  ok(r.x < 0, '负坐标屏:落点 X 确实是负数');
  near(r.y, roamGeometry(NEG, PET_W, PET_H).groundY, 0.01, '负坐标屏:y 贴合该屏地面');
}

/* ============ 6. clampToNearestRect ============ */

{
  // 点远在屏幕外 → 拉回最近屏
  const p = clampToNearestRect([SINGLE], 99999, 99999, PET_W, PET_H);
  ok(insideRect(SINGLE, p.x, p.y), 'clamp:屏幕外的点被拉回屏内');
  near(p.y, roamGeometry(SINGLE, PET_W, PET_H).groundY, 0.01, 'clamp:y 落在该屏地面');

  // 点落在两屏之间的缝隙(没有归属)→ 吸到最近屏
  const gapX = 2000; // LEFT 右沿之外,但 RIGHT_SHORT 太矮站不上
  const p2 = clampToNearestRect([LEFT, RIGHT_SHORT], gapX, 100, PET_W, PET_H);
  ok(insideRect(LEFT, p2.x, p2.y) || insideRect(RIGHT_SHORT, p2.x, p2.y), 'clamp:缝隙点被吸到某块屏内');

  // 空列表 → 原样返回(不能崩)
  eq(clampToNearestRect([], 123, 456, PET_W, PET_H), { x: 123, y: 456 }, 'clamp:没有显示器时原样返回');
}

/* ============ 7. 大/小宠物:边距随尺寸缩放 ============ */

{
  const big = roamGeometry(SINGLE, PET_W * 3, PET_H * 3);
  const small = roamGeometry(SINGLE, PET_W * 0.5, PET_H * 0.5);
  ok(big.margin > small.margin, '尺寸缩放:大宠物边距更大');
  near(big.margin, Math.round(PET_W * 3 / 2 + 20), 0.01, '尺寸缩放:大宠物边距 = 1.5 倍宽 + 20');
  near(small.margin, Math.round(PET_W * 0.5 / 2 + 20), 0.01, '尺寸缩放:小宠物边距 = 0.25 倍宽 + 20');

  // 大宠物在单屏里:左右沿必须留得下整个身子
  const rBig = roamStep([SINGLE], { x: 960, y: big.groundY }, 1, 99999, PET_W * 3, PET_H * 3);
  ok(rBig.x + PET_W * 3 / 2 <= SINGLE.w + 0.01, '尺寸缩放:大宠物整个身子不出屏');
}

/* ============ 8. pickRectAt / pickNearestRect ============ */

{
  eq(pickRectAt([LEFT], 100, 100), LEFT, 'pick:命中屏内点');
  eq(pickRectAt([LEFT], -100, 100), null, 'pick:屏外点返回 null');

  // 重叠区(镜像)→ 取面积大的
  const MIRROR_SMALL: RoamRect = { x: 0, y: 0, w: 800, h: 600 };
  eq(pickRectAt([LEFT, MIRROR_SMALL], 400, 300), LEFT, 'pick:重叠时取面积大的屏');

  eq(pickNearestRect([LEFT, RIGHT_SAME_H], 1900, 500), LEFT, 'pickNearest:靠左侧屏更近');
  eq(pickNearestRect([LEFT, RIGHT_SAME_H], 1940, 500), RIGHT_SAME_H, 'pickNearest:靠右侧屏更近');
  eq(pickNearestRect([], 0, 0), null, 'pickNearest:空列表返回 null');
}

/* ============ 9. 随机漫步不变量:永不落在「脚下没地面」 ============ */

{
  const rects = [NEG, LEFT, RIGHT_LOWER];
  let pos = { x: roamGeometry(LEFT, PET_W, PET_H).groundY ? 960 : 960, y: roamGeometry(LEFT, PET_W, PET_H).groundY };
  let dir: 1 | -1 = 1;
  let violations = 0;
  let steps = 0;
  for (let i = 0; i < 4000; i++) {
    const r = roamStep(rects, pos, dir, 1 + Math.random() * 40, PET_W, PET_H);
    pos = { x: r.x, y: r.y };
    dir = r.dir;
    steps++;
    if (!pickRectAt(rects, pos.x, pos.y)) violations++;
  }
  eq(violations, 0, `随机漫步 ${steps} 步:从未落到无地面区域`);
}

/* ============ 输出 ============ */

console.log('='.repeat(56));
if (fail === 0) {
  console.log(`漫游单测:${pass} 通过 / 0 失败`);
  console.log('全部通过 ✅');
} else {
  console.log(`漫游单测:${pass} 通过 / ${fail} 失败`);
  for (const f of failures) console.log(`  ✗ ${f}`);
}
console.log('='.repeat(56));
if (fail > 0) process.exit(1);
