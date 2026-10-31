/**
 * Video-Pet 渲染器 —— 播 dsh-pet 的透明 webm 动画(大肥鱼/蓝发小女仆)。
 *
 * 与另两个渲染器的差别:
 *   - character-host:PIXI 画 Live2D 模型
 *   - hatch-pet-host:Canvas 2D 逐帧切精灵表
 *   - video-pet-host:<video> 元素播 VP9-alpha webm
 *
 * 为什么用 <video> 而不是拆成帧:109 段 × 24fps × 10s ≈ 2.6 万帧,
 * 拆成 PNG 会膨胀到几百 MB,而 webm 全部只有 53MB。直接播视频更划算,
 * 而且 alpha 通道由编码器负责(VP9 alpha),我们不用抠像。
 *
 * 借鉴来源:PC2005-cloud/dsh-pet(MIT)的「A/B 双缓冲换源」——
 * 一次只能有一个 video 在播,换源时用另一个 video 接棒,避免中间黑帧。
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type { VideoPetCharacter } from '../../shared/character';
import {
  firstSleepSet,
  pickRandomAction,
  shouldMirrorAnimation,
  type VideoPetAnimationConfig,
} from '../../shared/video-pet';
import type { CharacterHostHandle } from './character-host';

interface Props {
  character: VideoPetCharacter;
  /** 资源根 — 主进程扫描后下发 */
  roots: { videoPet: string; videoPetUser: string };
  onLoaded?: () => void;
  onError?: (err: Error) => void;
  onContextMenu?: (e: { clientX: number; clientY: number }) => void;
  onScaleChange?: (scale: number) => void;
  onAnchorY?: (y: number) => void;
  visible?: boolean;
}

/** 素材视频的原始尺寸(VP9 webm 640×360)。 */
const VIDEO_W = 640;
const VIDEO_H = 360;

/**
 * 桌宠在视频里的实际占位 —— 视频是 16:9,但角色只占中间一小块。
 *
 * 这决定了桌宠窗口该开多大、角色该画在哪儿。dsh-pet 的配置里 pets[].size = 462
 * 是「角色宽度(px)」,而视频画布是 640 宽 —— 所以角色约占画布的 72%。
 * 我们的窗口按画布尺寸开,再靠 CSS transform 把角色区域放大到目标宽度。
 */
const CHARACTER_WIDTH_RATIO = 462 / VIDEO_W;

/** 角色在画布里的垂直锚点 —— 脚底位置(约在画布 85% 处,绿幕规范里的脚底线)。 */
const CHARACTER_FOOT_RATIO = 0.85;

const SCALE_KEY_PREFIX = 'pet:scale:';
const POS_KEY_PREFIX = 'pet:position:';

/** 动画结束后的处理:回到 idle / 播下一段 / 什么都不做。 */
type EndedAction = 'idle' | 'next' | 'loop';

export interface VideoPetHostHandle extends CharacterHostHandle {
  /** 播一段指定动画(名字 = webm 文件名去扩展名)。 */
  playAnimation?: (name: string, once?: boolean) => void;
  /** 当前正在播的动画名。 */
  currentAnimation?: () => string;
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

function loadModelPos(id: string): { x: number; y: number } | null {
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
      return { x: obj.x, y: obj.y };
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

/**
 * 挑下一段动画。
 *
 * 权重口径来自 dsh-pet 的 animationWeights:
 *   idle / turn / move / action 四档,前三档占比之和 < 100,剩下的给 action。
 * 我们的权重直接用 dsh-config.json 里的 animationWeights(若缺省用一组合理的)。
 */
const DEFAULT_WEIGHTS = { idle: 55, turn: 10, move: 15, action: 20 };

function rollNextKind(weights: typeof DEFAULT_WEIGHTS): 'idle' | 'turn' | 'move' | 'action' {
  const roll = Math.random() * 100;
  const topEnd = weights.idle + weights.turn + weights.move;
  if (roll < weights.idle) return 'idle';
  if (roll < weights.idle + weights.turn) return 'turn';
  if (roll < topEnd) return 'move';
  return 'action';
}

export const VideoPetHost = forwardRef<VideoPetHostHandle, Props>(function VideoPetHost(
  { character, roots, onLoaded, onError, onContextMenu, onScaleChange, onAnchorY, visible },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoARef = useRef<HTMLVideoElement | null>(null);
  const videoBRef = useRef<HTMLVideoElement | null>(null);
  /** 当前在前台播的 video 元素 */
  const frontRef = useRef<HTMLVideoElement | null>(null);
  /** 换源世代号 —— 迟到的加载结果要丢弃 */
  const genRef = useRef(0);
  /** 当前动画名 */
  const currentAnimRef = useRef<string>('');
  /** 这一段播完后要干什么 */
  const endedActionRef = useRef<EndedAction>('idle');
  /** 用户是否正按着(拖拽期间不推进动画链) */
  const draggingRef = useRef(false);
  /** 朝向:1=右,-1=左 */
  const facingRef = useRef<1 | -1>(1);
  /** 睡觉状态 */
  const sleepingRef = useRef(false);

  const [scale, setScale] = useState<number>(() => loadUserScale(character.id));
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentAnim, setCurrentAnim] = useState<string>('');

  const manifest = character.manifest;
  const categories: VideoPetAnimationConfig['categories'] = manifest.categories.categories;

  // ---- 素材 URL ----
  /** 素材 URL:pet://video-pet/<角色名>/webm/<动画>.webm */
  const assetUrl = useCallback(
    (anim: string): string => {
      const file = manifest.animations[anim];
      if (!file) return '';
      const host = character.source === 'user' ? 'video-pet-user' : 'video-pet';
      const rel = pathSegments(character.root, roots, host);
      return `pet://${host}/${rel}/webm/${encodeURIComponent(file)}`;
    },
    [character.id, character.root, character.source, manifest.animations, roots],
  );

  // ---- 位置 ----
  const posRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  if (posRef.current.x === 0 && posRef.current.y === 0) {
    posRef.current = loadModelPos(character.id) ?? {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2 + 50,
    };
  }

  const applyPosToDom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.style.left = `${posRef.current.x}px`;
    el.style.top = `${posRef.current.y}px`;
  }, []);

  // ---- 播一段动画 ----
  /**
   * 切到一段动画。
   *
   * A/B 双缓冲:当前在播的是 front,新动画交给 back,等它能播了再换。
   * 直接改 front.src 会闪一下黑帧(解码要时间),双缓冲能消掉这个。
   */
  const switchTo = useCallback(
    (next: string, once: boolean, endedAction: EndedAction = 'idle') => {
      const url = assetUrl(next);
      if (!url) return;
      const front = frontRef.current;
      const back = front === videoARef.current ? videoBRef.current : videoARef.current;
      if (!front || !back) return;

      const gen = ++genRef.current;
      endedActionRef.current = endedAction;
      currentAnimRef.current = next;
      setCurrentAnim(next);

      const onReady = () => {
        // 迟到的加载 —— 期间已经换过源了,丢弃
        if (gen !== genRef.current) return;
        back.loop = false;
        back.currentTime = 0;
        const playPromise = back.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {
            /* 自动播放策略拒绝 —— 静音 + playsInline 下一般不会,失败就退回 front */
          });
        }
        // 接管前台
        front.pause();
        frontRef.current = back;
        // 背靠背接上:让 front(现在的 back)循环播下一段
        front.loop = true;
      };

      back.onloadeddata = onReady;
      back.onerror = () => {
        if (gen !== genRef.current) return;
        setError(`动画加载失败:${next}`);
        onError?.(new Error(`动画加载失败:${next}`));
      };
      back.src = url;
      back.load();
    },
    [assetUrl, onError],
  );

  /** 播一段指定动画(外部调用,比如右键点播)。 */
  const playAnimation = useCallback(
    (name: string, once = true) => {
      if (!manifest.animations[name]) return;
      switchTo(name, once, once ? 'idle' : 'loop');
    },
    [manifest.animations, switchTo],
  );

  /** 随机下一段。 */
  const pickNextAnimation = useCallback(() => {
    const kind = rollNextKind(DEFAULT_WEIGHTS);
    if (kind === 'idle') {
      const pool = manifest.categories.idle;
      if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    }
    if (kind === 'turn') {
      const pool = manifest.categories.turn;
      if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    }
    if (kind === 'move') {
      const pool = manifest.categories.moves.actions.map((a) => a.name);
      if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    }
    // action:按分类权重抽
    const action = pickRandomAction(categories);
    if (action) return action;
    // 全空了 → 回落 idle
    const idle = manifest.categories.idle;
    return idle.length ? idle[0] : '';
  }, [categories, manifest.categories.idle, manifest.categories.moves.actions, manifest.categories.turn]);

  // ---- 动画结束处理 ----
  useEffect(() => {
    const handleEnded = () => {
      const action = endedActionRef.current;
      const next = pickNextAnimation();
      if (action === 'loop') {
        // 循环段:重播自己
        const front = frontRef.current;
        if (front) {
          front.currentTime = 0;
          void front.play().catch(() => undefined);
        }
        return;
      }
      if (next && next !== currentAnimRef.current) {
        switchTo(next, false, 'loop');
      } else if (next) {
        const front = frontRef.current;
        if (front) {
          front.currentTime = 0;
          void front.play().catch(() => undefined);
        }
      }
    };

    const a = videoARef.current;
    const b = videoBRef.current;
    a?.addEventListener('ended', handleEnded);
    b?.addEventListener('ended', handleEnded);
    return () => {
      a?.removeEventListener('ended', handleEnded);
      b?.removeEventListener('ended', handleEnded);
    };
  }, [pickNextAnimation, switchTo]);

  // ---- 初始动画 ----
  useEffect(() => {
    // ★ frontRef 必须先指向 videoA —— 否则 switchTo 里 `if (!front || !back) return`
    //   会直接返回,video 永远拿不到 src(表现为「元素在但 readyState=0,一片空白」)。
    //   ref 在 commit 阶段就挂好了,这个 effect 里能拿到。
    if (!frontRef.current) frontRef.current = videoARef.current;

    const idlePool = manifest.categories.idle;
    const first = idlePool[0] ?? Object.keys(manifest.animations)[0] ?? '';
    if (first) switchTo(first, false, 'loop');
    setLoaded(true);
    onLoaded?.();
    // 只在角色变化时重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character.id]);

  // ---- 角色切换:复位 ----
  useEffect(() => {
    const idlePool = manifest.categories.idle;
    const first = idlePool[0] ?? Object.keys(manifest.animations)[0] ?? '';
    if (first) switchTo(first, false, 'loop');
    posRef.current = loadModelPos(character.id) ?? {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2 + 50,
    };
    applyPosToDom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character.id]);

  // ---- 朝向镜像 ----
  useEffect(() => {
    const front = frontRef.current;
    if (!front) return;
    const mirror = shouldMirrorAnimation(currentAnimRef.current, categories);
    front.style.transform = mirror && facingRef.current === -1 ? 'scaleX(-1)' : '';
  }, [currentAnim, categories]);

  // ---- 可见性 ----
  useEffect(() => {
    const front = frontRef.current;
    if (!front) return;
    if (visible) {
      void front.play().catch(() => undefined);
    } else {
      front.pause();
    }
  }, [visible, currentAnim]);

  // ---- 缩放与锚点上报 ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // 角色宽度 = 画布宽度 × 比例 × 用户缩放
    const charWidth = VIDEO_W * CHARACTER_WIDTH_RATIO * scale;
    const charHeight = charWidth * (VIDEO_H / VIDEO_W);
    el.style.width = `${charWidth}px`;
    el.style.height = `${charHeight}px`;
    onScaleChange?.(scale);
    onAnchorY?.(charHeight * CHARACTER_FOOT_RATIO);
  }, [scale, onScaleChange, onAnchorY]);

  // ---- 拖拽 + 甩抛 ----
  useEffect(() => {
    const canvas = containerRef.current;
    if (!canvas) return;

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    let rafId: number | null = null;

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      draggingRef.current = true;
      startX = e.clientX;
      startY = e.clientY;
      originX = posRef.current.x;
      originY = posRef.current.y;
      const front = frontRef.current;
      // 拖拽期间播「被拖拽悬空反馈」
      const dragPool = manifest.categories.drag;
      if (front && dragPool.length) {
        switchTo(dragPool[0], false, 'loop');
      }
      e.preventDefault();
    };

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      posRef.current = { x: originX + dx, y: originY + dy };
      if (rafId == null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          applyPosToDom();
        });
      }
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      draggingRef.current = false;
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      applyPosToDom();
      saveModelPos(character.id, posRef.current);
      if (moved) {
        // 松手 → 播点击回应之一
        const clicks = manifest.categories.clicks;
        if (clicks.length) switchTo(clicks[Math.floor(Math.random() * clicks.length)], true, 'idle');
      } else {
        // 纯点击 → 播点击回应
        const clicks = manifest.categories.clicks;
        if (clicks.length) switchTo(clicks[Math.floor(Math.random() * clicks.length)], true, 'idle');
      }
    };

    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      onContextMenu?.({ clientX: e.clientX, clientY: e.clientY });
    };

    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('contextmenu', onCtx);

    return () => {
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('contextmenu', onCtx);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [character.id, manifest.categories.clicks, manifest.categories.drag, applyPosToDom, switchTo]);

  // ---- 暴露给外部(handle) ----
  useImperativeHandle(
    ref,
    (): VideoPetHostHandle => ({
      setUserScale: (s: number) => {
        setScale(s);
        saveUserScale(character.id, s);
      },
      previewUserScale: (s: number) => setScale(s),
      resetUserScale: () => {
        setScale(1);
        saveUserScale(character.id, 1);
      },
      getUserScale: () => scale,
      // 视频桌宠没有 Live2D 概念 —— 这几个调试接口留空实现,免得调用方炸。
      listExpressions: () => [],
      listMotions: () => [],
      playExpression: async () => undefined,
      playMotion: async () => undefined,
      resetExpression: () => undefined,
      playAnimation,
      currentAnimation: () => currentAnimRef.current,
    }),
    [character.id, scale, playAnimation],
  );

  const videoStyle: React.CSSProperties = {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    pointerEvents: 'none',
  };

  return (
    <div
      ref={containerRef}
      className="video-pet-host"
      style={{
        position: 'absolute',
        transform: 'translate(-50%, -50%)',
        left: `${posRef.current.x}px`,
        top: `${posRef.current.y}px`,
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.({ clientX: e.clientX, clientY: e.clientY });
      }}
    >
      {error && <div className="scan-error">{error}</div>}
      {/* A/B 双缓冲:两个 video 交替播,换源时无缝接上 */}
      <video ref={videoARef} style={videoStyle} muted playsInline autoPlay />
      <video ref={videoBRef} style={videoStyle} muted playsInline autoPlay />
    </div>
  );
});

/**
 * 算角色在资源根下的相对路径(不含角色名本身)。
 *
 * 例:roots.videoPet = D:/app/video-pet,character.root = D:/app/video-pet/大肥鱼
 *   → "大肥鱼"
 */
function pathSegments(root: string, roots: { videoPet: string; videoPetUser: string }, host: string): string {
  const base = host === 'video-pet-user' ? roots.videoPetUser : roots.videoPet;
  const a = root.replace(/\\/g, '/');
  const b = base.replace(/\\/g, '/').replace(/\/$/, '');
  const rel = a.startsWith(b + '/') ? a.slice(b.length + 1) : a;
  return rel
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}
