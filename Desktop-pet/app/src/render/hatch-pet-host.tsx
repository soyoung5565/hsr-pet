import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { HatchPetBehaviorConfig, HatchPetCharacter } from '../../shared/character';
import {
  DEFAULT_HATCH_PET_BEHAVIOR,
  HATCH_PET_ROWS,
  mergeHatchPetBehaviorConfig,
} from '../../shared/hatch-pet-behavior';
import {
  DEFAULT_PHYSICS,
  estimateReleaseVelocity,
  softClampSpeed,
  springStep,
  throwBounds,
  throwStep,
  throwSubsteps,
  trimTrail,
  type DragSample,
  type PhysicsParams,
  type ThrowBounds,
} from '../../shared/pet-physics';
import type { CharacterHostHandle } from './character-host';
import type { Emotion } from '../../shared/emotion-map';
import { roamStep, clampToNearestRect, pickRectAt, type RoamRect } from '../../shared/pet-roam';

/**
 * Hatch-Pet 渲染器 —— OpenAI Codex 的 hatch-pet skill 桌宠包格式。
 *
 * 资源契约(详见 https://codexpets.org/install):
 *   - 1 张 spritesheet.webp,1536×1872,8 列 × 9 行 = 72 帧,单帧 192×208,未填格透明。
 *   - 9 行固定语义:
 *       0 idle / 1 running-right / 2 running-left / 3 waving / 4 jumping
 *       5 failed / 6 waiting / 7 running / 8 review
 *
 * 对接到本项目 pet 状态:
 *   - `pet:state` (thinking / talking / idle) → 切到 waiting / review / idle 行
 *   - `pet:emotion` (happy / sad / surprised…) → 短暂播放 jumping / failed / waving 行,
 *     播完回到当前长期态(thinking 期间不打断 hint)
 *
 * 渲染策略:用 Canvas 2D drawImage + 透明帧检测推断每行实际帧数,然后 8fps 循环。
 * 组件 API(props/handle)向 CharacterHost 看齐,App.tsx 切换两种角色不用改外层。
 */

const FRAME_W = 192;
const FRAME_H = 208;
const COLS = 8;
const ROWS = 9;
const FPS = DEFAULT_HATCH_PET_BEHAVIOR.fps ?? 8;

/** 行号 → 语义,目前我们只主动切 idle / waiting / review;其余在 emotion 触发或 idle 兜底。 */
const ROW_IDLE = HATCH_PET_ROWS.idle;
const ROW_RUNNING_RIGHT = HATCH_PET_ROWS.runningRight;
const ROW_RUNNING_LEFT = HATCH_PET_ROWS.runningLeft;
const ROW_JUMPING = HATCH_PET_ROWS.jumping;
const ROW_RUNNING = HATCH_PET_ROWS.running;
const ROW_REVIEW = HATCH_PET_ROWS.review;
const DEFAULT_WALK_SPEED = DEFAULT_HATCH_PET_BEHAVIOR.walkSpeed ?? 24;
const DEFAULT_WALK_MS: [number, number] = DEFAULT_HATCH_PET_BEHAVIOR.walkMs ?? [2000, 5000];
const DEFAULT_REST_MS: [number, number] = DEFAULT_HATCH_PET_BEHAVIOR.restMs ?? [8000, 20000];
const DRAG_START_PX = 4;
const LONG_PRESS_MS = 320;

interface Props {
  character: HatchPetCharacter;
  /** 资源根 — 由主进程扫描后下发,渲染端用 character.source 选 builtin / user */
  roots: { live2d: string; sprite: string; hatchPet: string; hatchPetUser: string };
  onLoaded?: () => void;
  onError?: (err: Error) => void;
  onContextMenu?: (e: { clientX: number; clientY: number }) => void;
  onScaleChange?: (scale: number) => void;
  onAnchorY?: (y: number) => void;
  visible?: boolean;
}

const SCALE_KEY_PREFIX = 'pet:scale:';
const POS_KEY_PREFIX = 'pet:position:';
const RENDER_STYLE_KEY_PREFIX = 'pet:render-style:';
const MODEL_POS_SAFE_MARGIN = 100;

/**
 * 抛掷物理的共享状态 —— 拖拽 effect 写,物理步进 effect 读。
 * 用 ref 而非 React state:每帧都变,进 state 会导致整棵子树 re-render。
 */
interface PhysicsState {
  /** 是否正在飞行(被甩出) */
  flying: boolean;
  /** 当前位置(包围盒左上角,px) */
  x: number;
  y: number;
  /** 当前速度(px/s) */
  vx: number;
  vy: number;
}

function createPhysicsState(): PhysicsState {
  return {
    flying: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
  };
}

function loadUserScale(id: string): number {
  try {
    const v = localStorage.getItem(SCALE_KEY_PREFIX + id);
    if (!v) return 1;
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? Math.max(0.3, Math.min(3, n)) : 1;
  } catch {
    return 1;
  }
}
function saveUserScale(id: string, s: number): void {
  try {
    localStorage.setItem(SCALE_KEY_PREFIX + id, s.toFixed(3));
  } catch {
    /* ignore */
  }
}

/**
 * 读渲染风格:用户覆盖(localStorage)优先,其次素材声明(pet.json),最后默认 auto。
 *
 * 优先级:localStorage(用户手动改过) > pet.json.renderStyle(素材声明) > 'auto'
 */
function loadRenderStyle(id: string, declared?: RenderStyle): RenderStyle {
  try {
    const v = localStorage.getItem(RENDER_STYLE_KEY_PREFIX + id);
    if (v === 'auto' || v === 'pixelated') return v;
  } catch {
    /* ignore */
  }
  if (declared === 'auto' || declared === 'pixelated') return declared;
  return 'auto';
}

function saveRenderStyle(id: string, style: RenderStyle): void {
  try {
    localStorage.setItem(RENDER_STYLE_KEY_PREFIX + id, style);
  } catch {
    /* ignore */
  }
}

/** 模型在窗口内的中心点位置(CSS 像素)。每个角色独立持久化,跟 character-host 共享 key 前缀。 */
function scaledFrameSize(scale: number): { w: number; h: number } {
  return { w: FRAME_W * scale, h: FRAME_H * scale };
}

function clampModelPos(
  pos: { x: number; y: number },
  size: { w: number; h: number } = { w: MODEL_POS_SAFE_MARGIN * 2, h: MODEL_POS_SAFE_MARGIN * 2 },
): { x: number; y: number } {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const halfW = Math.max(1, size.w / 2);
  const halfH = Math.max(1, size.h / 2);
  const mx = Math.min(MODEL_POS_SAFE_MARGIN, halfW, Math.max(0, w / 2));
  const my = Math.min(MODEL_POS_SAFE_MARGIN, halfH, Math.max(0, h / 2));
  return {
    x: Math.max(mx, Math.min(Math.max(mx, w - mx), pos.x)),
    y: Math.max(my, Math.min(Math.max(my, h - my), pos.y)),
  };
}
function loadModelPos(id: string, scale: number): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY_PREFIX + id);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (
      typeof obj?.x === 'number' &&
      Number.isFinite(obj.x) &&
      typeof obj?.y === 'number' &&
      Number.isFinite(obj.y)
    ) {
      return clampModelPos(obj, scaledFrameSize(scale));
    }
    return null;
  } catch {
    return null;
  }
}
function saveModelPos(id: string, pos: { x: number; y: number }): void {
  try {
    localStorage.setItem(POS_KEY_PREFIX + id, JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

function clampAtlasRow(row: unknown, fallback: number): number {
  const n = typeof row === 'number' ? row : Number(row);
  if (!Number.isInteger(n) || n < 0 || n >= ROWS) return fallback;
  return n;
}

function clampPositiveNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampMsRange(range: unknown, fallback: [number, number]): [number, number] {
  if (!Array.isArray(range) || range.length < 2) return fallback;
  const a = clampPositiveNumber(range[0], fallback[0], 300, 60000);
  const b = clampPositiveNumber(range[1], fallback[1], 300, 60000);
  return a <= b ? [a, b] : [b, a];
}

function pickIdleRow(config: HatchPetBehaviorConfig | undefined): number {
  const rows = (config?.idleRows ?? [])
    .map((row) => clampAtlasRow(row, -1))
    .filter((row) => row >= 0);
  if (rows.length === 0) return ROW_IDLE;
  return rows[Math.floor(Math.random() * rows.length)] ?? ROW_IDLE;
}

function emotionRow(config: HatchPetBehaviorConfig | undefined, emotion: Emotion): number {
  const fallback = DEFAULT_HATCH_PET_BEHAVIOR.emotionRows?.[emotion] ?? ROW_IDLE;
  return clampAtlasRow(config?.emotionRows?.[emotion], fallback);
}

function normalizeAliasRows(value: unknown, fallback: number): number[] {
  const values = Array.isArray(value) ? value : [value];
  const rows = values
    .map((row) => clampAtlasRow(row, -1))
    .filter((row) => row >= 0);
  return rows.length > 0 ? rows : [fallback];
}

function pickMotionRow(rows: number[] | undefined): number | null {
  if (!rows || rows.length === 0) return null;
  return rows[Math.floor(Math.random() * rows.length)] ?? null;
}

function buildMotionAliasMap(config: HatchPetBehaviorConfig | undefined): Record<string, number[]> {
  const raw = {
    ...(DEFAULT_HATCH_PET_BEHAVIOR.aliases ?? {}),
    ...(config?.aliases ?? {}),
  };
  const map: Record<string, number[]> = {};
  for (const [name, row] of Object.entries(raw)) {
    const key = name.trim();
    if (!key) continue;
    map[key] = normalizeAliasRows(row, map[key]?.[0] ?? ROW_IDLE);
  }
  return map;
}

function shouldClearGuidePixel(r: number, g: number, b: number, a: number): boolean {
  if (a < 8) return true;
  const saturated = Math.max(r, g, b) - Math.min(r, g, b) > 70;
  if (!saturated) return false;
  return (
    (r < 95 && g > 110 && b > 110) ||
    (g < 95 && r > 120 && b > 110) ||
    (r < 95 && g < 110 && b > 120) ||
    (r < 95 && g > 120 && b < 110)
  );
}

function drawPetFrame(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  col: number,
  row: number,
): void {
  ctx.clearRect(0, 0, FRAME_W, FRAME_H);
  ctx.drawImage(
    img,
    col * FRAME_W,
    row * FRAME_H,
    FRAME_W,
    FRAME_H,
    0,
    0,
    FRAME_W,
    FRAME_H,
  );

  try {
    const imageData = ctx.getImageData(0, 0, FRAME_W, FRAME_H);
    const { data } = imageData;
    let changed = false;
    for (let i = 0; i < data.length; i += 4) {
      if (shouldClearGuidePixel(data[i], data[i + 1], data[i + 2], data[i + 3])) {
        data[i + 3] = 0;
        changed = true;
      }
    }
    if (changed) ctx.putImageData(imageData, 0, 0);
  } catch {
    // If the canvas ever becomes unreadable, keep drawing the original frame.
  }
}

/** 把 spritesheetPath 绝对路径换成 pet:// URL,让 protocol handler 走文件系统。
 *  根据 character.source 选 host:builtin → pet://hatch-pet/,user → pet://hatch-pet-user/。 */
function toPetUrl(
  absSheet: string,
  source: 'builtin' | 'user',
  builtinRoot: string,
  userRoot: string,
): string {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const root = norm(source === 'builtin' ? builtinRoot : userRoot).replace(/\/+$/, '');
  const abs = norm(absSheet);
  let rel = abs.startsWith(root + '/') ? abs.slice(root.length + 1) : abs;
  // 编码每段路径,保留斜杠
  rel = rel
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const host = source === 'builtin' ? 'hatch-pet' : 'hatch-pet-user';
  return `pet://${host}/${rel}`;
}

/** 给一张 sprite sheet 算出每行实际有效帧数(从右往左找第一个非全透明列)。
 *  hatch-pet 未填格是透明 RGBA(0,0,0,0),用一个 offscreen canvas 取像素判定。 */
function computeRowFrameCounts(img: HTMLImageElement): number[] {
  const off = document.createElement('canvas');
  off.width = img.naturalWidth;
  off.height = img.naturalHeight;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  if (!ctx) return new Array<number>(ROWS).fill(COLS);
  ctx.drawImage(img, 0, 0);
  const counts: number[] = [];
  for (let r = 0; r < ROWS; r++) {
    let lastNonEmpty = -1;
    for (let c = 0; c < COLS; c++) {
      // 取该单元格中心 8x8 区域采样,任一 alpha>0 即非空
      const x = c * FRAME_W + FRAME_W / 2 - 4;
      const y = r * FRAME_H + FRAME_H / 2 - 4;
      try {
        const data = ctx.getImageData(x, y, 8, 8).data;
        let any = false;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] > 0) {
            any = true;
            break;
          }
        }
        if (any) lastNonEmpty = c;
      } catch {
        // tainted canvas (CORS) 时退回保守值
        lastNonEmpty = COLS - 1;
      }
    }
    counts.push(lastNonEmpty + 1 || 1); // 至少 1 帧避免除 0
  }
  return counts;
}

/**
 * 判断精灵表是不是像素风(pixel art)。
 *
 * ⚠ **本函数已被弃用,保留仅为参考** —— 两次自动检测尝试都不可靠:
 *   v1 突变率判据:把平滑的「球棒狸」判成像素风、把像素的「耄耋」判成平滑风(全错);
 *   v2 唯一色数判据:更错 —— 比值大小与画风几乎不相关
 *      (平滑风大面积同色背景反而色更少)。
 *   根本原因:从「像素统计」推断「画风」这个映射本身就不稳。
 *   → 改用**用户显式配置**(pet.json 的 renderStyle / 设置面板),
 *     默认 'auto'(浏览器双线性)—— 社区桌宠(主流)是插画风,双线正确;
 *     像素风桌宠放大后略糊,但不像最近邻那样出锯齿色块。
 */

/** 渲染风格:auto = 浏览器双线性;pixelated = 最近邻(像素风专用) */
export type RenderStyle = 'auto' | 'pixelated';

export const HatchPetHost = forwardRef<CharacterHostHandle, Props>(function HatchPetHost(
  { character, roots, onLoaded, onError, onContextMenu, onScaleChange, onAnchorY, visible = true },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const rowCountsRef = useRef<number[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef(0);
  const frameIndexRef = useRef(0);
  const lastDrawKeyRef = useRef('');
  const visibleRef = useRef(visible);
  const behaviorConfigRef = useRef<HatchPetBehaviorConfig>(
    mergeHatchPetBehaviorConfig(character.behavior),
  );
  const draggingRef = useRef(false);
  const dragMovingRef = useRef(false);
  const holdJumpRef = useRef(false);
  const dragDirRef = useRef<1 | -1>(1);
  /** 抛掷物理共享状态(拖拽 effect 写,物理 effect 读) */
  const physicsStateRef = useRef<PhysicsState>(createPhysicsState());

  // ---- 行为状态机 ----
  // 系统态(由外部 pet:state 注入):idle 时跑桌宠行为(walk/rest);
  //   thinking/talking 期间冻结位置 + 用 row 6 / 8(站定播 waiting/review 动画)。
  type SystemState = 'idle' | 'thinking' | 'talking';
  type Behavior = 'walk' | 'rest';
  const systemRef = useRef<SystemState>('idle');
  const behaviorRef = useRef<Behavior>('walk');
  const dirRef = useRef<1 | -1>(1); // 1=右,-1=左
  const restRowRef = useRef<number>(ROW_IDLE);
  // 下一次 walk↔rest 切换时间戳(performance.now ms)
  const behaviorUntilRef = useRef<number>(0);
  // emotion 临时打断 row(jumping/failed/waving),结束后回到行为/系统态
  const emotionRowRef = useRef<number | null>(null);
  const emotionUntilRef = useRef(0);

  const [scale, setScale] = useState<number>(() => loadUserScale(character.id));
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 渲染风格(放大时的插值策略)。
   *
   * ★ 不用自动检测 —— 试过两版像素统计判据,都判错
   *   (突变率/唯一色数,详见上方注释)。从像素统计推断画风本身就不稳。
   * → 素材自己声明(pet.json 的 renderStyle),用户可在设置里覆盖。
   * 默认 'auto'(浏览器双线性):社区桌宠(主流)是插画风,双线正确;
   * 像素风桌宠放大后略糊,但不会像最近邻那样出难看的锯齿色块。
   */
  const [renderStyle, setRenderStyle] = useState<RenderStyle>(() =>
    loadRenderStyle(character.id, character.renderStyle),
  );

  // 位置完全用 ref + 直接 DOM 写,不进 React state(避免每帧 re-render)。
  // 初始位置:loadModelPos 优先,没存过就放窗口中心偏下。
  const posRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  if (posRef.current.x === 0 && posRef.current.y === 0) {
    posRef.current = loadModelPos(character.id, scale) ?? {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2 + 50,
    };
  }

  /**
   * 显示器可用区(相对窗口左上角)—— 多屏漫游用。
   *
   * ★ 为什么不直接用 window.innerWidth/innerHeight:
   *   窗口只铺满主屏(WINDOW_FRAC=1.0,位置固定在主屏原点)。副屏在窗口之外,
   *   `window.innerWidth` 看不到它。要让桌宠走到副屏,必须从主进程拿真实显示器矩形,
   *   并且这些矩形是**相对窗口原点**的 —— 副屏的 x 可能是 1920,也可能是负数。
   *   用 ref 而不是 state:渲染循环里每帧要读,state 会造成闭包过期 / 频繁 re-render。
   */
  const roamRectsRef = useRef<RoamRect[]>([]);
  /** 是否有真实的多屏数据(没拿到之前退回原来的单屏 clamp 行为,保证不会更差) */
  const roamReadyRef = useRef(false);
  /** 漫游时是否贴地(从 config.proactive.roamSnapToGround 读,默认开) */
  const snapToGroundRef = useRef(true);

  /** 拉一次显示器信息。失败/单屏都安全:单屏时退化成原来的行为。 */
  const refreshRoamRects = useCallback(async () => {
    try {
      const rects = await window.petAPI?.screenGetRoamRects?.();
      if (Array.isArray(rects) && rects.length > 0) {
        roamRectsRef.current = rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
        roamReadyRef.current = true;
        return;
      }
    } catch {
      // ignore —— 退回单屏行为
    }
    roamRectsRef.current = [];
    roamReadyRef.current = false;
  }, []);

  useEffect(() => {
    void refreshRoamRects();
    // 插拔外接屏 / 改分辨率 / 改任务栏 → 重算区域,否则桌宠会走进不存在的屏幕
    const off = window.petAPI?.onDisplaysChanged?.(() => void refreshRoamRects());
    return () => {
      off?.();
    };
  }, [refreshRoamRects]);

  // 读取漫游相关配置(贴地开关)。配置变了要实时生效,不用重启。
  useEffect(() => {
    const syncRoamCfg = async () => {
      try {
        const cfg = await window.petAPI?.getConfig?.();
        const pro = cfg?.proactive;
        // 只有明确写了 false 才关;老配置没有这个字段 → 默认开
        snapToGroundRef.current = pro?.roamSnapToGround !== false;
      } catch {
        snapToGroundRef.current = true;
      }
    };
    void syncRoamCfg();
    window.addEventListener('petAI:configChanged', syncRoamCfg);
    return () => window.removeEventListener('petAI:configChanged', syncRoamCfg);
  }, []);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    behaviorConfigRef.current = mergeHatchPetBehaviorConfig(character.behavior);
  }, [character.behavior]);

  // 角色切换时:读新角色的持久化位置 + 同步 DOM
  useEffect(() => {
    // 停止飞行
    const pst = physicsStateRef.current;
    pst.flying = false;
    pst.vx = 0;
    pst.vy = 0;
    // 重新读该角色的渲染风格(不同素材声明可能不同)
    setRenderStyle(loadRenderStyle(character.id, character.renderStyle));
    posRef.current = loadModelPos(character.id, scale) ?? {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2 + 50,
    };
    const el = containerRef.current;
    if (el) {
      el.style.left = `${posRef.current.x}px`;
      el.style.top = `${posRef.current.y}px`;
    }
  }, [character.id, character.renderStyle]);

  // ---- 拖窗 + 像素穿透 hit-test ----
  // hatch-pet 不挂在 character-host 那套 PIXI 上,需要自己实现:
  //  - 全局 mousemove → 用 canvas 2D ctx.getImageData 取目标像素 alpha,>16 判定 onPixel
  //  - 在模型不透明像素上 / 在 UI 上 → 不穿透;否则穿透
  //  - 容器 mousedown → 拖窗:累加 dx/dy,rAF flush 改 posRef + 持久化
  // 卸载时关穿透,避免遗留状态影响别的角色。
  const characterIdRef = useRef(character.id);
  useEffect(() => {
    characterIdRef.current = character.id;
  }, [character.id]);

  /** 直接把 posRef 同步到容器 DOM(left/top),避免 React re-render */
  const applyPosToDom = () => {
    const el = containerRef.current;
    if (!el) return;
    el.style.left = `${posRef.current.x}px`;
    el.style.top = `${posRef.current.y}px`;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const hitCtx = canvas.getContext('2d', { willReadFrequently: true });
    if (!hitCtx) return;

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let pendingDx = 0;
    let pendingDy = 0;
    let rafId: number | null = null;
    let hasMoved = false;
    let downStartX = 0;
    let downStartY = 0;
    let longPressTimer: number | null = null;
    const insideRef = { current: true };

    // ---- 抛掷物理状态(纯数据,渲染循环消费) ----
    /** 拖拽轨迹采样:用于松手时估算初速 */
    const trail: DragSample[] = [];

    const clearLongPressTimer = () => {
      if (longPressTimer == null) return;
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
    };

    const resetDragGesture = () => {
      draggingRef.current = false;
      dragMovingRef.current = false;
      holdJumpRef.current = false;
      clearLongPressTimer();
    };

    const flushDrag = () => {
      rafId = null;
      if (pendingDx === 0 && pendingDy === 0) return;
      const dx = pendingDx;
      const dy = pendingDy;
      pendingDx = 0;
      pendingDy = 0;
      const cur = posRef.current;
      const raw = { x: cur.x + dx, y: cur.y + dy };
      // 有真实显示器数据时:允许在**所有屏**的并集里拖动(含副屏 / 负坐标屏)。
      // 只用 clampModelPos 会把它锁死在本窗口(主屏)内 —— 用户就永远拖不到副屏。
      if (roamReadyRef.current && roamRectsRef.current.length > 0) {
        const insideAny = pickRectAt(roamRectsRef.current, raw.x, raw.y) != null;
        posRef.current = insideAny
          ? raw
          : clampToNearestRect(
              roamRectsRef.current,
              raw.x,
              raw.y,
              FRAME_W * scale,
              FRAME_H * scale,
            );
      } else {
        posRef.current = clampModelPos(raw, scaledFrameSize(scale));
      }
      applyPosToDom();
      saveModelPos(characterIdRef.current, posRef.current);
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      draggingRef.current = true;
      dragMovingRef.current = false;
      holdJumpRef.current = false;
      lastX = e.screenX;
      lastY = e.screenY;
      downStartX = e.screenX;
      downStartY = e.screenY;
      hasMoved = false;
      // 新一轮拖拽:清空轨迹,停止飞行
      trail.length = 0;
      const pst = physicsStateRef.current;
      pst.flying = false;
      pst.vx = 0;
      pst.vy = 0;
      clearLongPressTimer();
      longPressTimer = window.setTimeout(() => {
        if (!dragging || hasMoved) return;
        holdJumpRef.current = true;
        frameIndexRef.current = 0;
      }, LONG_PRESS_MS);
    };

    // 全局 mousemove:拖动期间累加位移;非拖动期间做 hit-test
    let hitRaf: number | null = null;
    let pendingHitX = 0;
    let pendingHitY = 0;
    const runHitTest = () => {
      hitRaf = null;
      if (dragging) return;
      const cx = pendingHitX;
      const cy = pendingHitY;
      const elAt = document.elementFromPoint(cx, cy);
      const overUi =
        !!elAt &&
        elAt.closest(
          '.pet-menu, .pet-menu-panel, .scan-error, .scan-hint, .vosk-toast, .dialog-frame, .qa-popup, .debug-trigger, .debug-panel, .clipboard-suggest',
        ) !== null;

      let onPixel = false;
      if (!overUi) {
        const rect = canvas.getBoundingClientRect();
        const localX = cx - rect.left;
        const localY = cy - rect.top;
        if (localX >= 0 && localX < rect.width && localY >= 0 && localY < rect.height) {
          // 容器是缩放后的尺寸,canvas backing 是 FRAME_W×FRAME_H;按比例换算
          const px = Math.floor((localX / rect.width) * canvas.width);
          const py = Math.floor((localY / rect.height) * canvas.height);
          try {
            const data = hitCtx.getImageData(px, py, 1, 1).data;
            onPixel = data[3] > 16;
          } catch {
            onPixel = false;
          }
        }
      }

      const inside = overUi || onPixel;
      if (inside !== insideRef.current) {
        insideRef.current = inside;
        window.petAPI?.setIgnoreMouseEvents(!inside, true);
      }
    };

    const onMove = (e: MouseEvent) => {
      if (!dragging) {
        pendingHitX = e.clientX;
        pendingHitY = e.clientY;
        if (hitRaf == null) hitRaf = requestAnimationFrame(runHitTest);
        return;
      }
      const totalDx = e.screenX - downStartX;
      const totalDy = e.screenY - downStartY;
      if (!hasMoved && Math.hypot(totalDx, totalDy) >= DRAG_START_PX) {
        hasMoved = true;
        dragMovingRef.current = true;
        holdJumpRef.current = false;
        clearLongPressTimer();
        frameIndexRef.current = 0;
      }
      if (!hasMoved) return;

      const dx = e.screenX - lastX;
      const dy = e.screenY - lastY;
      if (dx > 0) dragDirRef.current = 1;
      else if (dx < 0) dragDirRef.current = -1;
      dirRef.current = dragDirRef.current;
      // 记录轨迹采样(用于松手估算初速)。用 screenX/screenY 绝对坐标。
      trail.push({ t: performance.now(), x: e.screenX, y: e.screenY });
      pendingDx += dx;
      pendingDy += dy;
      lastX = e.screenX;
      lastY = e.screenY;
      if (rafId == null) rafId = requestAnimationFrame(flushDrag);
    };

    const onUp = () => {
      if (dragging) {
        // ---- 松手:估算初速,够快就甩出去 ----
        const now = performance.now();
        const v = estimateReleaseVelocity(trimTrail(trail, now), now);
        if (v) {
          const pst = physicsStateRef.current;
          pst.flying = true;
          pst.vx = v.vx;
          pst.vy = v.vy;
          // posRef 是中心点,物理层是左上角语义 —— 存中心点,物理 effect 里负责换算
          pst.x = posRef.current.x;
          pst.y = posRef.current.y;
        } else {
          // 纯点击(没拖动)→ 播开心动作
          emotionRowRef.current = clampAtlasRow(
            behaviorConfigRef.current?.emotionRows?.happy,
            ROW_JUMPING,
          );
          emotionUntilRef.current = performance.now() + 1200;
          frameIndexRef.current = 0;
        }
      }
      dragging = false;
      resetDragGesture();
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        flushDrag();
      }
    };

    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    // 启动:默认不穿透。下一次 mousemove 会按 hit-test 调整。
    window.petAPI?.setIgnoreMouseEvents(false, false);

    return () => {
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (rafId != null) cancelAnimationFrame(rafId);
      if (hitRaf != null) cancelAnimationFrame(hitRaf);
      resetDragGesture();
      // 卸载时一定关穿透,避免影响其它角色
      window.petAPI?.setIgnoreMouseEvents(false, false);
    };
  }, [loaded, scale]); // 等 spritesheet 加载完才有像素可读

  // ---- 抛掷物理步进(独立 rAF 循环)----
  // 为什么不放在渲染循环里:渲染循环按 fps 切帧(8fps 很慢),
  // 而抛掷需要 60fps 级别的积分才不卡顿/不穿透。两套循环各管各的。
  useEffect(() => {
    if (!loaded) return;
    const physics: PhysicsParams = {
      ...DEFAULT_PHYSICS,
      throwPower: 1,
    };
    let raf: number | null = null;
    let last = performance.now();

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      // 抛掷状态由拖拽 effect 写入(通过共享 ref)。
      // 这里读同一份 state。
      const st = physicsStateRef.current;
      if (!st.flying) {
        // 不在飞行:Q 弹动画由自己的 rAF 驱动,这里无需处理
        return;
      }

      // 有真实显示器数据时,用「宠物当前所在屏」的边界,而不是窗口边界 ——
      // 否则被甩到副屏方向时会撞在窗口边缘弹回来,看着像有无形的墙。
      //
      // ⚠ 坐标系陷阱(改这里之前务必读):
      //   throwBounds({W,H}) 生成的是**原点在(0,0)**的边界(minX=0, maxX=W-size)。
      //   而副屏的 x 可能是 1920 或负数,直接传 r.x+r.w 会导致 minX 固定为 0,
      //   宠物在副屏上会被拉回左上角。
      //   正解:传「相对该屏」的宽高,再把物理层算出的局部坐标加上屏原点偏移。
      const here = roamReadyRef.current
        ? pickRectAt(roamRectsRef.current, posRef.current.x, posRef.current.y)
        : null;
      const originX = here ? here.x : 0;
      const originY = here ? here.y : 0;
      const bounds: ThrowBounds = throwBounds({
        W: here ? here.w : window.innerWidth,
        H: here ? here.h : window.innerHeight,
        size: FRAME_W * scale,
        sideAllow: 0,
        // hatch-pet 是 192x208 像素图(12:13),不是 16:9 —— 必须传真实高度,
        // 否则地面算高 100px,桌宠落地会有一半沉在屏幕外。
        height: FRAME_H * scale,
      });
      /**
       * ★ 坐标系换算 —— 这是移植时最容易踩的坑。
       * 物理层(throwStep/throwBounds)用「包围盒左上角」语义(上游 dsh-pet 约定);
       * 而本项目的 posRef 存的是「中心点」(容器 CSS 带 translate(-50%,-50%))。
       * 两者差半个身位,不换算 → 桌宠落地时整体偏移 100px 左右。
       */
      const halfW = (FRAME_W * scale) / 2;
      const halfH = (FRAME_H * scale) / 2;

      // 细分积分:高速时一帧位移可能上百 px,单步会跳过落地/反弹帧
      const steps = throwSubsteps(st.vx, st.vy, dt);
      const sub = dt / steps;
      for (let i = 0; i < steps; i++) {
        // 中心点 → 局部左上角(物理层语义,原点在该屏左上角)
        const r = throwStep(
          { x: st.x - halfW - originX, y: st.y - halfH - originY, vx: st.vx, vy: st.vy },
          sub,
          bounds,
          physics,
        );
        // 局部左上角 → 全局中心点(加回屏原点偏移)
        st.x = r.x + halfW + originX;
        st.y = r.y + halfH + originY;
        st.vx = r.vx;
        st.vy = r.vy;
        if (r.atRest) {
          st.flying = false;
          st.vx = 0;
          st.vy = 0;
          // 落地后把位置写回,保证不悬空
          posRef.current = { x: st.x, y: st.y };
          applyPosToDom();
          saveModelPos(characterIdRef.current, posRef.current);
          break;
        }
      }

      // 飞行中:位置跟着速度走
      // ⚠ 不用 clampModelPos —— 它带 100px 安全边距,会把落地位置往回拉,
      //   导致桌宠悬空。飞行/落地的边界完全交给物理层的 throwBounds 管。
      if (st.flying) {
        posRef.current = { x: st.x, y: st.y };
        applyPosToDom();
        // 飞行中播跑步行(朝向由飞行方向决定)
        dirRef.current = st.vx >= 0 ? 1 : -1;
      }
    };

    raf = requestAnimationFrame(tick);
    return () => {
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [loaded, scale]);

  // 加载 spritesheet — character 切换 / 路径变更时重新加载
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    const url = toPetUrl(
      character.spritesheetPath,
      character.source,
      roots.hatchPet,
      roots.hatchPetUser,
    );
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      rowCountsRef.current = computeRowFrameCounts(img);
      lastDrawKeyRef.current = '';
      setLoaded(true);
      onLoaded?.();
    };
    img.onerror = () => {
      if (cancelled) return;
      const msg = `加载 hatch-pet spritesheet 失败:${url}`;
      setError(msg);
      onError?.(new Error(msg));
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [
    character.id,
    character.spritesheetPath,
    character.source,
    roots.hatchPet,
    roots.hatchPetUser,
    onLoaded,
    onError,
  ]);

  // 监听 pet:state / pet:emotion — 写 systemRef + 临时 emotion row
  useEffect(() => {
    const onState = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { kind?: 'idle' | 'thinking' | 'talking' }
        | undefined;
      if (!detail) return;
      systemRef.current = detail.kind ?? 'idle';
      // 切系统态时让 frame 从 0 重播(否则会从 walk row 的中间帧接到 waiting)
      frameIndexRef.current = 0;
    };
    const onEmotion = (e: Event) => {
      const detail = (e as CustomEvent).detail as { emotion?: Emotion } | undefined;
      const emo = detail?.emotion;
      if (!emo) return;
      // hatch-pet 角色优先读 pet.json behavior.emotionRows,没有配置才走默认 atlas 语义。
      emotionRowRef.current = emotionRow(behaviorConfigRef.current, emo);
      emotionUntilRef.current = performance.now() + 1500;
      frameIndexRef.current = 0;
    };
    window.addEventListener('pet:state', onState as EventListener);
    window.addEventListener('pet:emotion', onEmotion as EventListener);
    return () => {
      window.removeEventListener('pet:state', onState as EventListener);
      window.removeEventListener('pet:emotion', onEmotion as EventListener);
    };
  }, []);

  // 渲染循环 + 行为状态机
  // 设计:
  //   层级优先(高 → 低): emotion 临时(1.5s) > system(thinking/talking) > behavior(walk/rest)
  //   走路速度 24 px/s,撞屏幕边距 80px 翻方向。
  //   每 5~10s 在 walk ↔ rest 之间随机切换;rest 期间停在原地播 idle 行 1.5~3s。
  //   切到 walk 时随机选个方向(50/50),让桌宠不会一直一个方向。
  useEffect(() => {
    if (!loaded) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    /**
     * 漫游几何全部按**宠物实际显示尺寸**等比缩放。
     *
     * 为什么不能写死:底座原本用固定 EDGE_MARGIN=80px + 固定 24px/s,
     * 但宠物可缩放(0.3~3 倍)。放大后 80px 边距相对宠物太小 → 贴边时半个身子出屏;
     * 缩小后 80px 边距又太大 → 宠物在屏幕中央不敢动。
     * 参照 dsh-pet 的做法:所有几何量乘 (实际宽 / 参考宽)。
     */
    const PET_REF_WIDTH = 192; // 参考宽:scale=1 时的单帧宽
    const geoScale = () => (FRAME_W * scale) / PET_REF_WIDTH;

    /** 边距 = 半个身位 + 一点余量,随尺寸缩放 */
    const edgeMargin = () => Math.round((FRAME_W * scale) / 2 + 20 * geoScale());

    /** 漫游速度:基准 24px/s,按尺寸缩放(小宠物慢一点,大宠物快一点) */
    const walkSpeedPx = (base: number) => base * geoScale();

    const randInRange = (a: number, b: number) => a + Math.random() * (b - a);
    const planNextBehavior = (now: number) => {
      const config = behaviorConfigRef.current;
      if (behaviorRef.current === 'walk') {
        const [a, b] = clampMsRange(config?.walkMs, DEFAULT_WALK_MS);
        behaviorUntilRef.current = now + randInRange(a, b);
      } else {
        restRowRef.current = pickIdleRow(config);
        const [a, b] = clampMsRange(config?.restMs, DEFAULT_REST_MS);
        behaviorUntilRef.current = now + randInRange(a, b);
      }
    };
    // 常态保持 idle。只有外部 motion / 情绪 / 鼠标交互才切到其它行。
    behaviorRef.current = 'rest';
    restRowRef.current = ROW_IDLE;
    dirRef.current = Math.random() < 0.5 ? -1 : 1;
    dragDirRef.current = dirRef.current;
    behaviorUntilRef.current = Number.POSITIVE_INFINITY;

    let lastTickTime = performance.now();
    const tick = (now: number) => {
      rafRef.current = requestAnimationFrame(tick);
      if (!visibleRef.current) {
        lastTickTime = now;
        return;
      }
      const dt = Math.min(100, now - lastTickTime); // 最大 100ms 防止 tab 切回时大跳
      lastTickTime = now;
      const config = behaviorConfigRef.current;

      // emotion 临时到期 → 清掉
      if (emotionRowRef.current != null && now >= emotionUntilRef.current) {
        emotionRowRef.current = null;
        frameIndexRef.current = 0;
      }

      // 行为切换计时(只在系统态 idle 时推进)
      if (systemRef.current === 'idle' && now >= behaviorUntilRef.current) {
        behaviorRef.current = behaviorRef.current === 'walk' ? 'rest' : 'walk';
        if (behaviorRef.current === 'walk') {
          // 切走时随机重选方向
          dirRef.current = Math.random() < 0.5 ? -1 : 1;
        }
        frameIndexRef.current = 0;
        planNextBehavior(now);
      }

      // 决定当前应该播哪一行
      let row: number;
      if (draggingRef.current && dragMovingRef.current) {
        row =
          dragDirRef.current === 1
            ? clampAtlasRow(config?.walkRightRow, ROW_RUNNING_RIGHT)
            : clampAtlasRow(config?.walkLeftRow, ROW_RUNNING_LEFT);
      } else if (draggingRef.current && holdJumpRef.current) {
        row = clampAtlasRow(config?.draggingRow, ROW_JUMPING);
      } else if (physicsStateRef.current.flying) {
        // 飞行中:播跑步行(朝向由飞行方向决定)
        row =
          dirRef.current === 1
            ? clampAtlasRow(config?.walkRightRow, ROW_RUNNING_RIGHT)
            : clampAtlasRow(config?.walkLeftRow, ROW_RUNNING_LEFT);
      } else if (emotionRowRef.current != null) {
        row = emotionRowRef.current;
      } else if (systemRef.current === 'thinking') {
        row = clampAtlasRow(config?.thinkingRow, ROW_RUNNING);
      } else if (systemRef.current === 'talking') {
        row = clampAtlasRow(config?.talkingRow, ROW_REVIEW);
      } else if (behaviorRef.current === 'walk') {
        row =
          dirRef.current === 1
            ? clampAtlasRow(config?.walkRightRow, ROW_RUNNING_RIGHT)
            : clampAtlasRow(config?.walkLeftRow, ROW_RUNNING_LEFT);
      } else {
        row = restRowRef.current;
      }

      // 移动位置(只在系统态 idle + behavior=walk + emotion 不在打断时)
      // 飞行中不移动 —— 抛掷物理已经在写 posRef,两套同时改会打架。
      if (
        systemRef.current === 'idle' &&
        behaviorRef.current === 'walk' &&
        emotionRowRef.current == null &&
        !draggingRef.current &&
        !physicsStateRef.current.flying
      ) {
        const walkSpeed = clampPositiveNumber(
          config?.walkSpeed,
          DEFAULT_WALK_SPEED,
          0,
          240,
        );
        const dx = (dirRef.current * walkSpeedPx(walkSpeed) * dt) / 1000;
        const cur = posRef.current;

        // ---- 多屏漫游 ----
        // 有真实显示器数据时走 roamStep:它负责「当前这块屏的边界 / 跨屏 / 断桥折返 / 掉台阶」。
        // 没有数据(IPC 还没回来 / 老版本宿主) → 退回原来的单屏 clamp,保证不会更差。
        const rects = roamRectsRef.current;
        if (roamReadyRef.current && rects.length > 0) {
          const step = roamStep(
            rects,
            cur,
            dirRef.current,
            Math.abs(dx),
            FRAME_W * scale,
            FRAME_H * scale,
          );
          // ⚠ roamStep 返回的 y 是「贴地后的中心点 y」。只有开了 roamSnapToGround
          //   才写回 y;否则保留用户拖到的高度,只改 x(有些用户喜欢让宠物悬在半空)。
          const nextY = snapToGroundRef.current ? step.y : cur.y;
          if (step.dir !== dirRef.current) dirRef.current = step.dir;
          if (step.x !== cur.x || nextY !== cur.y) {
            posRef.current = { x: step.x, y: nextY };
            applyPosToDom();
          }
        } else {
          let nx = cur.x + dx;
          // 边距随宠物尺寸缩放 —— 放大后不能还按 80px 留白,否则半个身子出屏
          const margin = edgeMargin();
          if (nx < margin) {
            nx = margin;
            dirRef.current = 1;
          } else if (nx > window.innerWidth - margin) {
            nx = window.innerWidth - margin;
            dirRef.current = -1;
          }
          if (nx !== cur.x) {
            posRef.current = { x: nx, y: cur.y };
            applyPosToDom();
          }
        }
      }

      // frame 切换
      const elapsed = now - lastFrameTimeRef.current;
      const fps = Math.round(clampPositiveNumber(config?.fps, FPS, 1, 24));
      const frameDuration = 1000 / fps;
      if (elapsed >= frameDuration) {
        lastFrameTimeRef.current = now;
        const cols = rowCountsRef.current[row] ?? COLS;
        frameIndexRef.current = (frameIndexRef.current + 1) % cols;
      }

      // draw
      const img = imgRef.current;
      if (!img) return;
      const cols = rowCountsRef.current[row] ?? COLS;
      const col = frameIndexRef.current % cols;
      frameIndexRef.current = col;
      const drawKey = `${row}:${col}`;
      if (drawKey !== lastDrawKeyRef.current) {
        lastDrawKeyRef.current = drawKey;
        drawPetFrame(ctx, img, col, row);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [loaded]);

  // 上报 anchorY(腰线 ≈ canvas 顶 + 高度的 60% 处)— 给 chat-bubble 用
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const report = () => {
      const rect = el.getBoundingClientRect();
      onAnchorY?.(rect.top + rect.height * 0.6);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [onAnchorY, scale]);

  useEffect(() => {
    onScaleChange?.(scale);
  }, [scale, onScaleChange]);

  // CharacterHostHandle 兼容实现 — hatch-pet 没有 expression / motion 概念,
  // playExpression / playMotion 给 noop,debug-panel 不会崩。
  useImperativeHandle(
    ref,
    () => ({
      setUserScale: (s: number) => {
        const clamped = Math.max(0.3, Math.min(3, s));
        setScale(clamped);
        saveUserScale(character.id, clamped);
      },
      previewUserScale: (s: number) => {
        const clamped = Math.max(0.3, Math.min(3, s));
        setScale(clamped);
      },
      resetUserScale: () => {
        setScale(1);
        saveUserScale(character.id, 1);
      },
      getUserScale: () => scale,
      listExpressions: () => [],
      listMotions: () => Object.keys(buildMotionAliasMap(behaviorConfigRef.current)),
      playExpression: async () => null,
      playMotion: async (group: string) => {
        // 调试/AI 指令:用动作名字直接切 row,2s 后自动回到当前行为态。
        const map = buildMotionAliasMap(behaviorConfigRef.current);
        const row = pickMotionRow(map[group]);
        if (row != null) {
          emotionRowRef.current = clampAtlasRow(row, ROW_IDLE);
          emotionUntilRef.current = performance.now() + 2000;
          frameIndexRef.current = 0;
        }
        return null;
      },
      resetExpression: () => undefined,
      setRenderStyle: (s: RenderStyle) => {
        const next: RenderStyle = s === 'pixelated' ? 'pixelated' : 'auto';
        setRenderStyle(next);
        saveRenderStyle(character.id, next);
        return next;
      },
      getRenderStyle: () => renderStyle,
    }),
    [character.id, scale, renderStyle],
  );

  // ---- 动作点播(右键菜单用)----
  // dsh-pet 的招牌功能:右键 → 动作分类 → 点播任意动画。
  // 这里把「切到某一行并播 N 毫秒」抽成公共事件,菜单层通过 window 事件触发。
  useEffect(() => {
    /**
     * 详情:{ row: number; durationMs?: number } — row 是 atlas 行号(0-8)
     * 未给 row 时按别名解析(中文名/英文名都行)。
     */
    const onPlay = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { row?: number; alias?: string; durationMs?: number }
        | undefined;
      if (!detail) return;
      let row: number | null = null;
      if (typeof detail.row === 'number') {
        row = clampAtlasRow(detail.row, -1);
        if (row < 0) return;
      } else if (detail.alias) {
        const map = buildMotionAliasMap(behaviorConfigRef.current);
        row = pickMotionRow(map[detail.alias]) ?? pickMotionRow(map[detail.alias.toLowerCase()]);
        if (row == null) return;
      } else {
        return;
      }
      emotionRowRef.current = row;
      emotionUntilRef.current = performance.now() + (detail.durationMs ?? 2000);
      frameIndexRef.current = 0;
    };
    window.addEventListener('pet:play-action', onPlay as EventListener);
    return () => window.removeEventListener('pet:play-action', onPlay as EventListener);
  }, []);

  const styleW = Math.round(FRAME_W * scale);
  const styleH = Math.round(FRAME_H * scale);

  return (
    <div
      ref={containerRef}
      className="character-host hatch-pet-host"
      // 当前角色 id —— 供端到端测试断言「真的切换到了这只」,
      // 也方便用户在 DevTools 里确认渲染的是谁。
      data-pet-id={character.id}
      data-pet-name={character.name}
      style={{
        // 容器中心点跟随 posRef:left/top 由 rAF 循环 / 拖窗 / 角色切换 直接改 DOM,
        // 不进 React state 避免每帧 re-render。这里只设置初始值。
        position: 'absolute',
        left: posRef.current.x,
        top: posRef.current.y,
        transform: 'translate(-50%, -50%)',
        width: styleW,
        height: styleH,
        display: visible ? undefined : 'none',
        cursor: 'grab',
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.({ clientX: e.clientX, clientY: e.clientY });
      }}
    >
      <canvas
        ref={canvasRef}
        width={FRAME_W}
        height={FRAME_H}
        style={{
          width: styleW,
          height: styleH,
          // 放大时的插值策略:
          //   'auto'      = 浏览器双线性 —— 插画风素材(社区桌宠、3D 渲染)用这个
          //   'pixelated' = 最近邻 —— 像素风素材(Codex 内置橘猫)用这个
          // 素材自己在 pet.json 里声明 renderStyle,用户可在设置里覆盖。
          imageRendering: renderStyle === 'pixelated' ? 'pixelated' : 'auto',
        }}
      />
      {error && <div className="overlay err">{error}</div>}
      {!loaded && !error && <div className="overlay hint">加载中…</div>}
    </div>
  );
});

// 故意不用 React.memo:character 切换时 props.character 变,我们已经在 useEffect 里
// 按 character.id / character.spritesheetPath 重新加载,父级 key={active.id} 也会
// 触发 remount,语义清晰不容易出错。
