/**
 * 多屏漫游几何 —— 纯计算,无 DOM / 无 Electron 依赖。
 *
 * 借鉴来源:PC2005-cloud/dsh-pet (MIT License) 的「探测空间、不走出屏幕」思路。
 * 上游把「屏幕」当成一个矩形,桌宠走动时按矩形边界折返。本项目实测发现原始
 * 实现只覆盖单屏场景,而用户机器上可能是主屏 + 副屏、分辨率不同、任务栏位置不同,
 * 甚至主屏左侧还有一个负坐标的屏(X 可以为负)。所以这里把「空间」抽象成
 * **多个矩形组成的可行走带**,并显式处理:
 *
 *   1. 屏与屏之间**有缝隙**(未对齐的上下沿 / 任务栏预留区)→ 不能直接从 A 屏走过去,
 *      因为中间那段既不是 A 的可用区、也不是 B 的可用区 → 判定为「断桥」,需要折返。
 *   2. 屏与屏**高度不同** → 走动时地面 Y 不一样。桌宠跨屏会「掉台阶」。
 *      这里不模拟自由落体,只做**瞬移贴合**:跨屏那一刻 y 直接落到新屏的地面。
 *   3. 所有几何量按宠物实际显示尺寸缩放(与 hatch-pet-host 的 geoScale 同源),
 *      避免大宠物半个身子出屏、小宠物不敢动。
 *
 * 坐标系约定:全部用**窗口内 CSS 像素**。窗口本身铺满整个虚拟桌面(spanning),
 * 窗口左上角 = 虚拟桌面左上角(virtualBounds.x/y)。渲染端拿到的显示器矩形
 * 已经由主进程换算成「相对窗口左上角」的坐标。
 */

/** 一个显示器的可用区域(已扣除任务栏),坐标为相对窗口左上角的 CSS 像素 */
export interface RoamRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 跨屏时允许「往上爬」的最大落差(px)。
 *  超过这个高度就当作走不上去的坎(现实里宠物也翻不过一堵墙),
 *  而不是让桌宠瞬移上去 —— 瞬移看着像 bug。往下走不受此限(掉台阶是自然的)。 */
const STEP_UP_MAX = 120;

/** 漫游几何参数 —— 全部按宠物实际尺寸派生 */
export interface RoamGeometry {
  /** 左/右边界内缩量(半个身位 + 余量),宠物中心最多走到 x = rect.x + leftMargin */
  margin: number;
  /** 地面 Y:宠物**中心点**能落到的最大 y(即 rect.y + rect.h - 半身高 - 余量) */
  groundY: number;
}

/**
 * 由显示器矩形 + 宠物尺寸算漫游几何。
 *
 * @param rect     当前所在显示器的可用区域
 * @param petW     宠物显示宽度(px)
 * @param petH     宠物显示高度(px)
 * @param padTop   顶部额外安全区(留给通知/挂件,通常 0)
 */
export function roamGeometry(
  rect: RoamRect,
  petW: number,
  petH: number,
  padTop = 0,
): RoamGeometry {
  const halfW = Math.max(1, petW / 2);
  const halfH = Math.max(1, petH / 2);
  // 边距 = 半个身位 + 20px 呼吸余量(与 hatch-pet-host 的 edgeMargin 保持一致)
  const margin = Math.round(halfW + 20);
  // 地面:宠物**中心**贴地时,中心 y = rect 底 - 半身高 - 呼吸余量
  const groundY = Math.round(rect.y + rect.h - halfH - 10);
  return {
    margin,
    groundY: Math.max(rect.y + halfH + padTop, groundY),
  };
}

/** 宠物中心点是否落在某个矩形的可行走带里(不考虑边距,用于判定「脚下有没有地面」) */
export function insideRect(rect: RoamRect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

/**
 * 找出中心点 (x, y) 所站的那个显示器。
 *
 * 多屏重叠时(镜像模式)取**面积最大**的那块,避免在两块之间抖动。
 * 一个都不命中 → 返回 null(说明宠物被甩到了屏幕缝隙里,调用方应让它落到最近的屏)。
 */
export function pickRectAt(rects: RoamRect[], x: number, y: number): RoamRect | null {
  let best: RoamRect | null = null;
  let bestArea = -1;
  for (const r of rects) {
    if (!insideRect(r, x, y)) continue;
    const area = r.w * r.h;
    if (area > bestArea) {
      bestArea = area;
      best = r;
    }
  }
  return best;
}

/** 取距离 (x,y) 最近的显示器(按中心点距离)。空数组 → null。 */
export function pickNearestRect(rects: RoamRect[], x: number, y: number): RoamRect | null {
  let best: RoamRect | null = null;
  let bestDist = Infinity;
  for (const r of rects) {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const d = Math.hypot(cx - x, cy - y);
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best;
}

/**
 * 按当前所在屏 + 前进方向,算出这一步实际能走到哪。
 *
 * 为什么不能简单地 x += dx 然后在单屏范围内 clamp:
 *   - 多屏时「右边界」不是 window.innerWidth,而是**当前这块屏**的右沿;
 *   - 走到屏的右沿后,如果右边紧邻另一块屏(**且垂直方向有重叠**),就该跨过去继续走;
 *   - 如果两块屏之间有缝(垂直不重叠),跨过去会踩空 → 必须折返。
 *
 * 返回值语义:
 *   x        → 本步结束后的宠物中心 X
 *   y        → 本步结束后的宠物中心 Y(跨屏时会「掉台阶」到新屏地面)
 *   dir      → 本步结束后的朝向(+1 右 / -1 左)。撞墙/断桥会翻转
 *   crossed  → 是否发生了跨屏
 *
 * @param rects   所有显示器的可用区域(按任意顺序)
 * @param cur     当前宠物中心
 * @param dir     当前朝向
 * @param dxAbs   本步想走的距离(绝对值,方向由 dir 决定)
 * @param petW/petH 宠物显示尺寸(用于算边距与地面)
 */
export function roamStep(
  rects: RoamRect[],
  cur: { x: number; y: number },
  dir: 1 | -1,
  dxAbs: number,
  petW: number,
  petH: number,
): { x: number; y: number; dir: 1 | -1; crossed: boolean } {
  if (rects.length === 0 || dxAbs === 0) {
    return { x: cur.x, y: cur.y, dir, crossed: false };
  }
  const here = pickRectAt(rects, cur.x, cur.y) ?? pickNearestRect(rects, cur.x, cur.y);
  if (!here) return { x: cur.x, y: cur.y, dir, crossed: false };

  const g = roamGeometry(here, petW, petH);
  const dx = dir * dxAbs;
  let nx = cur.x + dx;
  let ny = cur.y;
  let nextDir = dir;

  // 当前屏内的可行走区间
  const leftEdge = here.x + g.margin;
  const rightEdge = here.x + here.w - g.margin;

  if (dx > 0 && nx > rightEdge) {
    // 想走出右沿 —— 看看右边有没有可跨的屏
    const neighbour = findNeighbour(rects, here, 1, petW, petH);
    if (neighbour) {
      // 跨屏:落到新屏的可行走区间内,并贴合新屏地面(可能掉台阶)
      const ng = roamGeometry(neighbour, petW, petH);
      nx = Math.min(neighbour.x + neighbour.w - ng.margin, neighbour.x + ng.margin);
      ny = ng.groundY;
      return { x: nx, y: ny, dir: nextDir, crossed: true };
    }
    nx = rightEdge;
    nextDir = -1;
  } else if (dx < 0 && nx < leftEdge) {
    const neighbour = findNeighbour(rects, here, -1, petW, petH);
    if (neighbour) {
      const ng = roamGeometry(neighbour, petW, petH);
      nx = Math.max(neighbour.x + ng.margin, neighbour.x + neighbour.w - ng.margin);
      ny = ng.groundY;
      return { x: nx, y: ny, dir: nextDir, crossed: true };
    }
    nx = leftEdge;
    nextDir = 1;
  }

  // 没跨屏 —— 地面按当前屏重新贴合(处理用户改了任务栏高度 / 分辨率变化)
  ny = g.groundY;

  // 兜底:目标 X 落在「脚下没地面」的缝隙里(比如窗口被拖动导致坐标系漂移)
  if (!pickRectAt(rects, nx, ny)) {
    nx = clampTo(here, nx, g.margin);
  }

  return { x: nx, y: ny, dir: nextDir, crossed: false };
}

/** 在 (x,y) 落在屏内的区间内夹取 */
function clampTo(rect: RoamRect, x: number, margin: number): number {
  const lo = rect.x + margin;
  const hi = rect.x + rect.w - margin;
  if (hi < lo) return rect.x + rect.w / 2;
  return Math.max(lo, Math.min(hi, x));
}

/**
 * 找 direction 方向的紧邻屏(可跨的那块)。
 *
 * 「可跨」判据(三条都满足):
 *   1. 水平贴合:两块屏在 X 方向贴合,差值 ≤ 2px(容忍 DPI 取整误差)
 *   2. 邻居装得下宠物:高度 ≥ 宠物身高,否则站不上去
 *   3. **落差可承受**:用两块屏各自的 groundY 比较
 *      - 邻居**更低**(往下走)→ 允许,跨过去就是"掉台阶",y 落到新屏地面
 *      - 邻居**更高**(往上走)→ 只有落差 ≤ STEP_UP_MAX 才允许;更高的坎跨不过去,
 *        宠物会卡在屏沿(现实里就是"走不过去",不是 bug)
 *
 * ⚠ 第一版判据写错两次,记录下来避免再犯:
 *    v1 用"两块屏有垂直重叠"→ 「高屏旁边贴矮副屏」被当成可跨,宠物走到屏沿掉进虚空;
 *    v2 改成"宠物整个身子必须落在邻居 Y 范围内"→ 连**往下走**(正常的掉台阶)也被拦死,
 *       真实的上下错位双屏根本走不过去。
 *    正解是比较**两块屏的地面高度**,而不是比几何重叠。
 */
function findNeighbour(
  rects: RoamRect[],
  here: RoamRect,
  direction: 1 | -1,
  petW: number,
  petH: number,
): RoamRect | null {
  const tol = 2;
  const groundHere = roamGeometry(here, petW, petH).groundY;
  let best: RoamRect | null = null;
  let bestGap = Infinity;
  for (const r of rects) {
    if (r === here) continue;
    const touchX = direction === 1 ? Math.abs(r.x - (here.x + here.w)) : Math.abs(r.x + r.w - here.x);
    if (touchX > tol) continue;
    // 装不下宠物(太矮)→ 站不上去
    if (r.h < petH) continue;
    const groundN = roamGeometry(r, petW, petH).groundY;
    const stepUp = groundHere - groundN; // >0 = 邻居更高,需要往上爬
    if (stepUp > STEP_UP_MAX) continue;
    if (touchX < bestGap) {
      bestGap = touchX;
      best = r;
    }
  }
  return best;
}

/** 把任意点夹进「最近的屏」的可行走带(抛掷落地 / 首次定位用) */
export function clampToNearestRect(
  rects: RoamRect[],
  x: number,
  y: number,
  petW: number,
  petH: number,
): { x: number; y: number } {
  if (rects.length === 0) return { x, y };
  const r = pickRectAt(rects, x, y) ?? pickNearestRect(rects, x, y);
  if (!r) return { x, y };
  const g = roamGeometry(r, petW, petH);
  return {
    x: clampTo(r, x, g.margin),
    y: Math.min(g.groundY, Math.max(r.y + petH / 2, y)),
  };
}
