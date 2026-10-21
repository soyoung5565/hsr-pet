/**
 * 抛掷物理单元测试 —— 纯函数，无 DOM 依赖。
 *
 * 用法:
 *   npx tsx shared/pet-physics.test.ts
 *   node --experimental-strip-types shared/pet-physics.test.ts   (Node 22+)
 *
 * 为什么要有这层测试：物理代码是从 dsh-pet 移植的，移植过程本身就是风险源。
 * 「读懂了」不等于「搬对了」——必须用可复现的断言把行为钉住。
 */

import {
  DEFAULT_PHYSICS,
  DEAD_ZONE_SPEED,
  GRAVITY,
  MAX_THROW_SPEED,
  RESTITUTION,
  REST_VX,
  REST_VY,
  SPRING_C,
  SPRING_K,
  TRAIL_KEEP_MS,
  estimateReleaseVelocity,
  landingSquash,
  softClampSpeed,
  springStep,
  squashScale,
  throwBounds,
  throwStep,
  throwSubsteps,
  trimTrail,
  type DragSample,
  type ThrowState,
} from './pet-physics';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

function nearEq(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

// ============================================================
// 1. 边界计算
// ============================================================
console.log('\n[1] throwBounds');
{
  const b = throwBounds({ W: 1000, H: 800, size: 200, sideAllow: 0 });
  check('maxX = W - size', near(b.maxX, 800), `got ${b.maxX}`);
  check('maxY = H - h (h = size*9/16)', near(b.maxY, 800 - 112.5), `got ${b.maxY}`);
  check('minX = -sideAllow', near(b.minX, 0));
  check('minY = 0', near(b.minY, 0));

  const b2 = throwBounds({ W: 1000, H: 800, size: 200, sideAllow: 20 });
  check('sideAllow 放宽 minX', near(b2.minX, -20), `got ${b2.minX}`);
  check('sideAllow 放宽 maxX', near(b2.maxX, 820), `got ${b2.maxX}`);
}

// ============================================================
// 2. 轨迹裁剪
// ============================================================
console.log('\n[2] trimTrail');
{
  const now = 1000;
  const trail: DragSample[] = [
    { t: now - TRAIL_KEEP_MS - 50, x: 0, y: 0 },
    { t: now - 100, x: 1, y: 1 },
    { t: now - 10, x: 2, y: 2 },
  ];
  const out = trimTrail(trail, now);
  check('剔除过期采样', out.length === 2, `got ${out.length}`);
  check('保留最新采样', out[out.length - 1].t === now - 10);

  const fresh = trimTrail([{ t: now, x: 0, y: 0 }], now);
  check('全部新鲜时原样返回', fresh.length === 1);
}

// ============================================================
// 3. 弹簧步进（过阻尼，不应 overshoot）
// ============================================================
console.log('\n[3] springStep');
{
  // 从 0 追 100,记录轨迹,检查是否单调且不越过目标
  let v = 0;
  let x = 0;
  let overshoot = false;
  let prev = 0;
  for (let i = 0; i < 600; i++) {
    v = springStep(v, x, 100, 1 / 60);
    x += v * (1 / 60);
    if (x > 100 + 1e-6) overshoot = true;
    if (x < prev - 1e-9) overshoot = true; // 不该反向
    prev = x;
  }
  check('过阻尼: 不 overshoot', !overshoot, `final x=${x.toFixed(3)}`);
  check('最终收敛到目标', near(x, 100, 0.5), `got ${x.toFixed(3)}`);

  // 阻尼比 ζ = c / (2*sqrt(k))
  const zeta = SPRING_C / (2 * Math.sqrt(SPRING_K));
  check('阻尼比 ≥ 1 (过阻尼)', zeta >= 1, `ζ=${zeta.toFixed(3)}`);
}

// ============================================================
// 4. 软钳速：单调、有上限
// ============================================================
console.log('\n[4] softClampSpeed');
{
  check('负数 → 0', softClampSpeed(-10) === 0);
  check('0 → 0', softClampSpeed(0) === 0);
  const s1 = softClampSpeed(500);
  const s2 = softClampSpeed(1000);
  const s3 = softClampSpeed(5000);
  check('单调递增', s1 < s2 && s2 < s3, `${s1.toFixed(1)} ${s2.toFixed(1)} ${s3.toFixed(1)}`);
  check('永不超过上限', s3 < MAX_THROW_SPEED, `got ${s3.toFixed(1)}`);
  check('渐近接近上限', near(softClampSpeed(100000), MAX_THROW_SPEED, 1), `got ${softClampSpeed(100000).toFixed(3)}`);
}

// ============================================================
// 5. 初速估算
// ============================================================
console.log('\n[5] estimateReleaseVelocity');
{
  // 5.1 空轨迹 → null
  check('空轨迹 → null', estimateReleaseVelocity([], 1000) === null);

  // 5.2 停留过久（松手前停顿）→ null
  const stale: DragSample[] = [
    { t: 500, x: 0, y: 0 },
    { t: 600, x: 100, y: 0 },
  ];
  check(
    '停顿超 150ms → null(温柔放下)',
    estimateReleaseVelocity(stale, 1000) === null,
  );

  // 5.3 快速水平甩动 → 正向速度
  const fast: DragSample[] = [];
  for (let i = 0; i <= 10; i++) {
    fast.push({ t: 900 + i * 8, x: 200 + i * 40, y: 500 });
  }
  const v = estimateReleaseVelocity(fast, 980);
  check('快甩 → 有初速', v !== null);
  if (v) {
    check('方向为正 x', v.vx > 0, `vx=${v.vx.toFixed(1)}`);
    check('y 方向基本不动', Math.abs(v.vy) < 1, `vy=${v.vy.toFixed(3)}`);
    check(
      '速度不超过上限',
      Math.hypot(v.vx, v.vy) <= MAX_THROW_SPEED + 1,
      `speed=${Math.hypot(v.vx, v.vy).toFixed(1)}`,
    );
  }

  // 5.4 太慢 → 死区 → null
  const slow: DragSample[] = [];
  for (let i = 0; i <= 10; i++) {
    slow.push({ t: 900 + i * 8, x: 200 + i * 2, y: 500 });
  }
  const vs = estimateReleaseVelocity(slow, 980);
  check(
    `慢速(<${DEAD_ZONE_SPEED}) → null`,
    vs === null,
    vs ? `speed=${Math.hypot(vs.vx, vs.vy).toFixed(1)}` : '',
  );

  // 5.5 反向甩动 → 负 x
  const back: DragSample[] = [];
  for (let i = 0; i <= 10; i++) {
    back.push({ t: 900 + i * 8, x: 800 - i * 40, y: 500 });
  }
  const vb = estimateReleaseVelocity(back, 980);
  check('反向甩 → vx < 0', vb !== null && vb.vx < 0, vb ? `vx=${vb.vx.toFixed(1)}` : 'null');

  // 5.6 throwPower 线性缩放
  const p1 = estimateReleaseVelocity(fast, 980, { ...DEFAULT_PHYSICS, throwPower: 1 });
  const p2 = estimateReleaseVelocity(fast, 980, { ...DEFAULT_PHYSICS, throwPower: 2 });
  check(
    'throwPower=2 速度翻倍',
    p1 !== null && p2 !== null && near(p2.vx, p1.vx * 2, 1),
    p1 && p2 ? `${p1.vx.toFixed(1)} vs ${p2.vx.toFixed(1)}` : '',
  );
}

// ============================================================
// 6. 抛体步进
// ============================================================
console.log('\n[6] throwStep');
{
  const b = throwBounds({ W: 1000, H: 800, size: 200, sideAllow: 0 });

  // 6.1 重力:无初速时 vy 递增为正
  let s: ThrowState = { x: 500, y: 0, vx: 0, vy: 0 };
  const s1 = throwStep(s, 1 / 60, b);
  check('重力使 vy 变正', s1.vy > 0, `vy=${s1.vy}`);
  check('y 增大', s1.y > 0);

  // 6.2 落地:从高处落下 → Q 弹若干次后停在 maxY
  //     注意:这是**弹跳物理**,落地后 vy 反弹(×0.78),不是一次到位 ——
  //     实测 vy=2000 落下需 544 帧 / 15 次弹跳才静止。
  s = { x: 500, y: 0, vx: 0, vy: 2000 };
  let cur: ThrowState & { bounced: boolean; atRest: boolean } = {
    x: 500,
    y: 0,
    vx: 0,
    vy: 2000,
    bounced: false,
    atRest: false,
  };
  for (let i = 0; i < 2000; i++) {
    cur = throwStep(cur, 1 / 60, b);
    if (cur.atRest) break;
  }
  check('最终静止', cur.atRest, `vx=${cur.vx.toFixed(2)} vy=${cur.vy.toFixed(2)}`);
  check('停在地面 maxY', near(cur.y, b.maxY, 0.5), `y=${cur.y.toFixed(2)} maxY=${b.maxY}`);
  check('静止时速度归零', Math.abs(cur.vx) < REST_VX && Math.abs(cur.vy) < 1,
    `vx=${cur.vx.toFixed(2)} vy=${cur.vy.toFixed(2)}`);

  // 6.3 左边界反弹
  //     起点必须在墙边:maxX=800, minX=0;一帧位移 = vx*dt = -50px,
  //     所以 x=10 才会撞到,x=500 差 450px 撞不到(这是边界语义,不是 bug)。
  s = { x: 10, y: 100, vx: -3000, vy: 0 };
  const sLeft = throwStep(s, 1 / 60, b);
  check('撞左墙 → x 被夹住', sLeft.x >= b.minX - 1e-6, `x=${sLeft.x}`);
  check('撞左墙 → vx 反向', sLeft.vx > 0, `vx=${sLeft.vx.toFixed(1)}`);
  check('反弹标记 bounced', sLeft.bounced === true);

  // 6.4 反弹保留速度(恢复系数)
  //     ★ 本项目 RESTITUTION = 0.52(上游 dsh-pet 是 0.78,太弹,详见常量注释)
  check(
    '恢复系数 = RESTITUTION(0.52)',
    near(Math.abs(sLeft.vx) / 3000, RESTITUTION, 0.01),
    `ratio=${(Math.abs(sLeft.vx) / 3000).toFixed(4)}`,
  );

  // 6.5 顶边界:ceilingBounce=false 时不夹不弹
  //     起点必须在界外(y<0)才会走到 y<b.minY 分支。
  const noCeil = throwStep(
    { x: 500, y: -5, vx: 0, vy: -500 },
    1 / 60,
    b,
    { ...DEFAULT_PHYSICS, ceilingBounce: false },
  );
  check('ceilingBounce=false → y 保持越界', noCeil.y < 0, `y=${noCeil.y.toFixed(2)}`);
  //     对照:开启时会被夹到 minY
  const withCeil = throwStep({ x: 500, y: -5, vx: 0, vy: -500 }, 1 / 60, b);
  check('ceilingBounce=true → y 被夹到 0', withCeil.y === 0, `y=${withCeil.y}`);

  // 6.6 dt 钳制:一帧 10 秒不会让宠物瞬移穿墙
  const huge = throwStep({ x: 500, y: 0, vx: 0, vy: 0 }, 10, b);
  check('dt 被钳到 0.05s', huge.y <= GRAVITY * 0.05 * 0.05 + 1e-6, `y=${huge.y}`);

  // 6.7 地面摩擦:贴地水平速度衰减
  let fs: ThrowState = { x: 100, y: b.maxY, vx: 400, vy: 0 };
  for (let i = 0; i < 30; i++) {
    fs = throwStep(fs, 1 / 60, b);
  }
  check('地面摩擦让 vx 衰减', Math.abs(fs.vx) < 400, `vx=${fs.vx.toFixed(1)}`);
}

// ============================================================
// 7. 积分细分
// ============================================================
console.log('\n[7] throwSubsteps');
{
  check('低速 → 1 步', throwSubsteps(10, 0, 1 / 60) === 1);
  check('高速 → 多步', throwSubsteps(3000, 0, 1 / 60) > 1, `got ${throwSubsteps(3000, 0, 1 / 60)}`);
  check('步数有上限', throwSubsteps(1e9, 1e9, 1 / 60) <= 64, `got ${throwSubsteps(1e9, 1e9, 1 / 60)}`);
}

// ============================================================
// 8. Q 弹曲线
// ============================================================
console.log('\n[8] squashScale / landingSquash');
{
  check('u=0 → scaleY=1', near(squashScale(0), 1));
  check('u=1 → 回到 1 附近', near(squashScale(1), 1, 0.001), `got ${squashScale(1)}`);
  const mid = squashScale(0.45);
  check('u=0.45 是最低点附近', mid < 0.7, `got ${mid}`);
  check('最低点不低于 0.5', mid >= 0.5, `got ${mid}`);
  // 曲线上不过冲太多
  let maxV = 0;
  for (let i = 0; i <= 100; i++) maxV = Math.max(maxV, squashScale(i / 100));
  check('回弹过冲 ≤ 1.12', maxV <= 1.1201, `max=${maxV.toFixed(4)}`);

  check('轻落地 → 下限 0.8(设计下限,不是 1.0)', near(landingSquash(0), 0.8), `got ${landingSquash(0)}`);
  check('重砸 → 大压缩', landingSquash(3000) <= 0.56, `got ${landingSquash(3000)}`);
  // 单调性要在「有效区间」内验:SQ_SOFT_SPEED(300) 以下被下限钳平,是设计如此。
  check(
    '压缩量随速度单调(在 300~1500 区间)',
    landingSquash(600) > landingSquash(900) &&
      landingSquash(900) > landingSquash(1200) &&
      landingSquash(1200) > landingSquash(1500),
    `${landingSquash(600).toFixed(3)} ${landingSquash(900).toFixed(3)} ${landingSquash(1200).toFixed(3)} ${landingSquash(1500).toFixed(3)}`,
  );
  check('1500 以上吃满最大下压', near(landingSquash(1500), 0.55), `got ${landingSquash(1500)}`);
}

// ============================================================
// 9. 端到端:拖甩 → 抛 → 落地静止
// ============================================================
console.log('\n[9] 端到端:甩出后应能落地静止');
{
  const b = throwBounds({ W: 1000, H: 800, size: 200, sideAllow: 0 });
  const trail: DragSample[] = [];
  for (let i = 0; i <= 8; i++) {
    trail.push({ t: 900 + i * 8, x: 300 + i * 45, y: 300 });
  }
  const v = estimateReleaseVelocity(trail, 964);
  check('甩出有初速', v !== null);
  if (v) {
    let st: ThrowState & { bounced: boolean; atRest: boolean } = {
      x: 300 + 8 * 45,
      y: 300,
      vx: v.vx,
      vy: v.vy,
      bounced: false,
      atRest: false,
    };
    let frames = 0;
    while (frames < 1200) {
      st = throwStep(st, 1 / 60, b);
      frames++;
      if (st.atRest) break;
    }
    check('最终静止', st.atRest, `frames=${frames}`);
    check('最终停在地面', near(st.y, b.maxY, 1), `y=${st.y.toFixed(2)}`);
    check('最终 x 在屏内', st.x >= b.minX - 1 && st.x <= b.maxX + 1, `x=${st.x.toFixed(2)}`);
    check('收敛时间合理(<15s)', frames < 900, `frames=${frames}`);
  }
}

// ============================================================
// 汇总
// ============================================================
console.log('\n' + '='.repeat(56));
console.log(`物理单测:${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.log('\n失败明细:');
  for (const f of failures) console.log('  ✗ ' + f);
  console.log('='.repeat(56));
  process.exit(1);
}
console.log('全部通过 ✅');
console.log('='.repeat(56));
