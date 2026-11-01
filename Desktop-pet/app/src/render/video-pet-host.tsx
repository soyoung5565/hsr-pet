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
import {
  DEFAULT_SLEEP_REFUSE,
  SleepMachine,
  readMemePool,
  type MemeEntry,
} from '../../shared/video-pet-runtime';
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
  /** 桌宠在窗口里的位置(中心点,窗口坐标)—— 菜单要贴着它弹,而不是贴屏幕边。 */
  onAnchor?: (pos: { x: number; y: number }) => void;
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

/**
 * 角色在 640×360 画布里的实际占位(实测自 alpha bbox)。
 *
 * 视频画布是 16:9,但角色只占中间一小块 —— 四周大量留白。
 * 这几个比例用来:
 *   ① 命中检测的兜底区域(alpha 检测不可用时)
 *   ② 位置计算:让「角色脚底」而不是「容器中心」贴地
 */
const CHARACTER_WIDTH_IN_VIDEO = 0.4;   // 角色宽约占画布 40%(实测 204/640)
const CHARACTER_HEIGHT_IN_VIDEO = 0.75; // 角色高约占画布 75%(实测 267/360)
const CHARACTER_LEFT_RATIO = 0.3;       // 角色左边距约占画布 30%(实测 215/640)
const CHARACTER_TOP_RATIO = 0.1;        // 角色上边距约占画布 10%(实测 62/360)

const SCALE_KEY_PREFIX = 'pet:scale:';
const POS_KEY_PREFIX = 'pet:position:';

/** 动画结束后的处理:回到 idle / 播下一段 / 什么都不做。 */
type EndedAction = 'idle' | 'next' | 'loop';

export interface VideoPetHostHandle extends CharacterHostHandle {
  /** 播一段指定动画(名字 = webm 文件名去扩展名)。 */
  playAnimation?: (name: string, once?: boolean) => void;
  /** 当前正在播的动画名。 */
  currentAnimation?: () => string;
  /**
   * 播一个**事件类**动画(碎碎念 / 工作状态 / 余额)。
   *
   * 事件池来自 dsh-config.json 的 animations.events.{whisper,workStatus,balance}。
   * 随机抽一段(避开当前正播的),播一次后回到 idle。
   * 池子为空 → 返回 false,调用方可以退化成「只弹气泡不换动画」。
   */
  playEventAnimation?: (kind: 'whisper' | 'workStatus' | 'balance') => boolean;
  /** 让桌宠睡下。返回 false = 素材里没有睡觉动画。 */
  sleep?: () => boolean;
  /** 叫醒桌宠。 */
  wake?: () => boolean;
  /** 此刻是否在睡。 */
  isSleeping?: () => boolean;
  /** 表情包池(碎碎念配图用)。 */
  memes?: () => MemeEntry[];
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
 * 把桌宠位置钳制在屏幕内。
 *
 * ★ 为什么必须钳制(实测踩过):
 *   桌宠容器是 462×260,但角色只占容器中间 40%×75%(四周大量留白)。
 *   如果按**容器**算边界,角色本身会跑到屏幕外 —— 实测保存的位置是
 *   (1660, 1033),而屏幕只有 1708×1020,角色整个掉到屏幕下方,用户看不见也点不到。
 *
 * 所以这里按**角色实际占位**算:容器左上 + 角色在容器里的偏移。
 */
function clampPetPos(
  pos: { x: number; y: number },
  scale: number,
): { x: number; y: number } {
  const charWidth = VIDEO_W * CHARACTER_WIDTH_RATIO * scale;
  const charHeight = VIDEO_H * CHARACTER_HEIGHT_IN_VIDEO * scale;
  const containerW = VIDEO_W * CHARACTER_WIDTH_RATIO * scale;
  const containerH = VIDEO_H * (CHARACTER_HEIGHT_IN_VIDEO / CHARACTER_FOOT_RATIO) * scale;

  // 角色中心相对容器中心的偏移
  const offX = (CHARACTER_LEFT_RATIO + CHARACTER_WIDTH_IN_VIDEO / 2 - 0.5) * containerW;
  const offY = (CHARACTER_TOP_RATIO + CHARACTER_HEIGHT_IN_VIDEO / 2 - 0.5) * containerH;

  // 角色中心允许的范围(留 20px 边距)
  const margin = 20;
  const minCx = margin + charWidth / 2;
  const maxCx = Math.max(minCx, window.innerWidth - margin - charWidth / 2);
  const minCy = margin + charHeight / 2;
  const maxCy = Math.max(minCy, window.innerHeight - margin - charHeight / 2);

  const cx = Math.min(Math.max(minCx, pos.x + offX), maxCx);
  const cy = Math.min(Math.max(minCy, pos.y + offY), maxCy);
  return { x: cx - offX, y: cy - offY };
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
      return clampPetPos({ x: obj.x, y: obj.y }, scale);
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

/**
 * 点击音效的 URL。
 *
 * pet://video-pet/<角色名>/sound/<文件名>.wav
 */
export function clickSoundUrl(manifest: { id: string }, file: string): string {
  return `pet://video-pet/${encodeURIComponent(manifest.id)}/sound/${encodeURIComponent(file)}`;
}

export const VideoPetHost = forwardRef<VideoPetHostHandle, Props>(function VideoPetHost(
  { character, roots, onLoaded, onError, onContextMenu, onScaleChange, onAnchorY, onAnchor, visible },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoARef = useRef<HTMLVideoElement | null>(null);
  const videoBRef = useRef<HTMLVideoElement | null>(null);
  /**
   * 命中检测用的隐藏 canvas —— 把 video 画上去读 alpha。
   *
   * ★ 为什么必须做这个:
   *   桌宠窗口是**全屏**的透明置顶窗(为了能 roam/漫游)。
   *   如果不做像素命中检测,整个屏幕都被这个窗口吃掉 ——
   *   用户点任何别的应用都没反应(实测踩过)。
   *   所以要逐帧判断「鼠标下���有没有角色像素」,没有就 setIgnoreMouseEvents(true) 穿透。
   */
  const hitCanvasRef = useRef<HTMLCanvasElement | null>(null);
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
    posRef.current = loadModelPos(character.id, scale) ?? {
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
        // ★ loop 按「这一段要不要循环播」来定,不能一律 false:
        //   睡觉的 loop 段是无限播的(once=false),播一次的话
        //   ended 事件触发后画面就停在最后一帧(用户看着像卡住)。
        back.loop = !once;
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

  /**
   * 播一段事件动画。返回是否真的播了。
   *
   * 为什么要「避开当前正播的」:事件动画都是 10 秒左右的长动画,
   * 如果正好在播同一段,换源等于没换 —— 看起来像没反应。
   */
  const playEventAnimation = useCallback(
    (kind: 'whisper' | 'workStatus' | 'balance'): boolean => {
      const pool =
        kind === 'whisper'
          ? manifest.whisperAnimations
          : kind === 'workStatus'
            ? manifest.workStatusAnimations
            : manifest.balanceAnimations;
      if (!pool || !pool.length) return false;
      const current = currentAnimRef.current;
      const choices = pool.filter((n) => n !== current);
      const pickFrom = choices.length ? choices : pool;
      const name = pickFrom[Math.floor(Math.random() * pickFrom.length)];
      if (!name || !manifest.animations[name]) return false;
      switchTo(name, true, 'idle');
      return true;
    },
    [manifest, switchTo],
  );

  /**
   * 睡觉状态机。
   *
   * 上游 dsh-pet 的三段式:start(入睡过渡,播一次)→ loop(睡眠循环,无限播)→ end(醒来过渡,播一次)。
   * 睡着时随机链停摆 —— 由 sleepMachine.consumeEnded() 接管动画结束判定。
   */
  const sleepMachineRef = useRef<SleepMachine | null>(null);
  if (!sleepMachineRef.current) {
    sleepMachineRef.current = new SleepMachine(
      (name, once) => {
        if (name && manifest.animations[name]) switchTo(name, once, once ? 'idle' : 'loop');
      },
      () => {
        // 醒来后回到待机
        const idlePool = manifest.categories.idle;
        const first = idlePool[0];
        if (first) switchTo(first, false, 'loop');
      },
    );
  }

  /** 让桌宠睡下。 */
  const sleep = useCallback((): boolean => {
    const set = firstSleepSet(manifest.categories.sleep);
    if (!set) return false;
    // 三段各挑一个候选(上游是「整套随机 → 段内随机」)
    const pickOne = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
    const start = pickOne(set.start);
    const loop = pickOne(set.loop);
    const end = pickOne(set.end);
    if (!start || !loop || !end) return false;
    sleepMachineRef.current!.sleep({ start, loop, end });
    return true;
  }, [manifest.categories.sleep, switchTo]);

  /** 叫醒桌宠。 */
  const wake = useCallback((): boolean => {
    // 入睡过渡中被叫醒 → 立刻切回待机(否则画面会停在「睡觉-开始」直到那段播完)
    return sleepMachineRef.current!.wake(() => {
      const idlePool = manifest.categories.idle;
      const first = idlePool[0];
      if (first) switchTo(first, false, 'loop');
    });
  }, [manifest.categories.idle, switchTo]);

  /** 表情包池。 */
  const memes = useCallback((): MemeEntry[] => {
    return readMemePool(manifest.memeDescriptions, manifest.memes);
  }, [manifest.memeDescriptions, manifest.memes]);

  /** 随机下一段。 */
  const pickNextAnimation = useCallback(() => {
    // 睡着时不做随机动作
    if (sleepMachineRef.current?.sleeping()) {
      const loop = firstSleepSet(manifest.categories.sleep)?.loop?.[0];
      return loop ?? '';
    }
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
      // 睡觉时,动画结束归睡觉状态机管(切 loop / 收尾),不推进随机链
      if (sleepMachineRef.current?.sleeping()) {
        sleepMachineRef.current.consumeEnded();
        return;
      }
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
    posRef.current = loadModelPos(character.id, scale) ?? {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2 + 50,
    };
    applyPosToDom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character.id]);

  // ---- 工作状态联动 ----
  // 桌宠在 AI 思考/说话时切到工作状态动画,闲下来回 idle。
  // 素材里 events.workStatus 有 6 段(思考冒泡/忙碌点按/清点归档/原地踱步张望/雀跃庆祝/垂头叹气冒汗)。
  useEffect(() => {
    const onState = (e: Event) => {
      const kind = (e as CustomEvent).detail?.kind as string | undefined;
      if (kind === 'thinking' || kind === 'talking') {
        // 正在忙 → 切到工作状态动画(连播,不打断)
        const pool = manifest.workStatusAnimations;
        if (pool && pool.length) {
          const current = currentAnimRef.current;
          const choices = pool.filter((n) => n !== current);
          const pickFrom = choices.length ? choices : pool;
          const name = pickFrom[Math.floor(Math.random() * pickFrom.length)];
          if (name && manifest.animations[name]) switchTo(name, false, 'loop');
        }
      } else {
        // 闲下来了 → 回待机
        const idlePool = manifest.categories.idle;
        const first = idlePool[0];
        if (first && first !== currentAnimRef.current) switchTo(first, false, 'loop');
      }
    };
    window.addEventListener('pet:state', onState as EventListener);
    return () => window.removeEventListener('pet:state', onState as EventListener);
  }, [manifest, switchTo]);

  // ---- 点击音效 ----
  //
  // 上游 dsh-pet:点一下宠物播一声内置音效(click-duck.wav,音量固定 0.5),
  // 100ms 内的连续点击只响一次(多开时也不会叠成一片)。
  //
  // 用 WebAudio 直接解 wav —— 不需要 <audio> 元素,也没有加载延迟。
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastClickSoundAtRef = useRef(0);

  const playClickSound = useCallback(() => {
    const file = manifest.clickSound;
    if (!file) return;
    const now = Date.now();
    // 100ms 内的连续点击只响一次
    if (now - lastClickSoundAtRef.current < 100) return;
    lastClickSoundAtRef.current = now;

    try {
      const ctx = audioCtxRef.current ?? new AudioContext();
      audioCtxRef.current = ctx;
      void fetch(clickSoundUrl(manifest, file))
        .then((r) => r.arrayBuffer())
        .then((buf) => ctx.decodeAudioData(buf))
        .then((audio) => {
          const src = ctx.createBufferSource();
          src.buffer = audio;
          const gain = ctx.createGain();
          gain.gain.value = 0.5;
          src.connect(gain).connect(ctx.destination);
          src.start();
        })
        .catch(() => {
          /* 音效失败不影响别的 */
        });
    } catch {
      /* 浏览器不支持 WebAudio 就跳过 */
    }
  }, [manifest]);

  // ---- 菜单命令(睡觉 / 起来 / 随机动作)----
  //
  // 上游 dsh-pet 的右键菜单有「睡觉」「起来」,点它睡下、点一下或右键叫醒。
  // 这里用 window 事件跟菜单通信(菜单在 document.body,宿主在 app 根里)。
  useEffect(() => {
    const onSleep = () => {
      sleep();
    };
    const onWake = () => {
      wake();
    };
    const onRandom = () => {
      const name = pickRandomAction(manifest.categories.categories);
      if (name && manifest.animations[name]) switchTo(name, true, 'idle');
    };
    window.addEventListener('pet:sleep', onSleep);
    window.addEventListener('pet:wake', onWake);
    window.addEventListener('pet:random-action', onRandom);
    return () => {
      window.removeEventListener('pet:sleep', onSleep);
      window.removeEventListener('pet:wake', onWake);
      window.removeEventListener('pet:random-action', onRandom);
    };
  }, [manifest.animations, manifest.categories.categories, sleep, wake, switchTo]);

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

  // ---- 上报桌宠位置(菜单定位用)----
  // 每次位置变化(拖拽/漫游/甩抛)都要上报,否则菜单会留在旧位置。
  useEffect(() => {
    const report = () => {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      onAnchor?.({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    };
    // ★ 只在位置真的变了才上报 —— 桌宠不动时不该每 500ms 触发一次
    //   setState(整棵菜单树重渲染)。
    let last = '';
    const reportIfMoved = () => {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}`;
      if (key === last) return;
      last = key;
      onAnchor?.({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    };
    reportIfMoved();
    const timer = window.setInterval(reportIfMoved, 400);
    return () => window.clearInterval(timer);
  }, [onAnchor]);

  // ---- 像素命中检测(click-through)----
  //
  // 桌宠窗口铺满全屏,如果不做这件事,整个屏幕都会被窗口挡住 —— 用户点别的应用没反应。
  // 做法(与 hatch-pet-host 同源):
  //   1. 全局 mousemove → 记下坐标
  //   2. rAF 里把当前正在播的 video 画到隐藏 canvas,读那一像素的 alpha
  //   3. alpha > 16 → 鼠标在角色身上 → 不穿透;否则 → 穿透
  //   4. 菜单/气泡等 UI 元素上也不穿透
  //
  // ⚠ 用 video.currentTime 拿不到像素 —— 必须 drawImage 到 canvas 才能读。
  useEffect(() => {
    const canvas = hitCanvasRef.current;
    if (!canvas) return;
    const hitCtx = canvas.getContext('2d', { willReadFrequently: true });
    if (!hitCtx) return;

    let insideRef = { current: false };
    let hitRaf: number | null = null;
    let pendingX = 0;
    let pendingY = 0;

    const runHitTest = () => {
      hitRaf = null;
      const cx = pendingX;
      const cy = pendingY;

      // UI 元素上不穿透(菜单、气泡、错误提示…)
      const elAt = document.elementFromPoint(cx, cy);
      const overUi =
        !!elAt &&
        elAt.closest(
          '.pet-menu, .pet-menu-panel, .scan-error, .scan-hint, .vosk-toast, .dialog-frame, .qa-popup, .debug-trigger, .debug-panel, .clipboard-suggest',
        ) !== null;

      let onPixel = false;
      if (!overUi) {
        // 取当前在前台播的 video
        const v = frontRef.current;
        const host = containerRef.current;
        if (v && host && v.videoWidth > 0) {
          const rect = host.getBoundingClientRect();
          const localX = cx - rect.left;
          const localY = cy - rect.top;
          if (localX >= 0 && localX < rect.width && localY >= 0 && localY < rect.height) {
            // 容器是缩放后的尺寸,canvas 是原始 640×360;按比例换算
            const px = Math.floor((localX / rect.width) * canvas.width);
            const py = Math.floor((localY / rect.height) * canvas.height);
            try {
              // 把当前帧画到隐藏 canvas 上再读 alpha
              hitCtx.clearRect(0, 0, canvas.width, canvas.height);
              hitCtx.drawImage(v, 0, 0, canvas.width, canvas.height);
              const data = hitCtx.getImageData(px, py, 1, 1).data;
              onPixel = data[3] > 16;
            } catch {
              // 跨域/解码未就绪 → 保守当成「不在角色上」(穿透),别挡住用户
              onPixel = false;
            }
          }
        }
      }

      // ★ 兜底:即使 alpha 检测失败(解码未就绪 / 浏览器限制),
      //   也要保证「角色大致所在的那一块」能点得到。
      //   否则用户会看到桌宠却点不动它 —— 实测踩过(video 还没 ready 时整块都穿透)。
      if (!onPixel && !overUi) {
        const host = containerRef.current;
        if (host) {
          const rect = host.getBoundingClientRect();
          // 角色在视频画布里的位置:居中,宽度约占 40%(200/640),高度约占 75%(270/360)
          const charLeft = rect.left + rect.width * CHARACTER_LEFT_RATIO;
          const charTop = rect.top + rect.height * CHARACTER_TOP_RATIO;
          const charW = rect.width * CHARACTER_WIDTH_IN_VIDEO;
          const charH = rect.height * CHARACTER_HEIGHT_IN_VIDEO;
          if (cx >= charLeft && cx <= charLeft + charW && cy >= charTop && cy <= charTop + charH) {
            onPixel = true;
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
      pendingX = e.clientX;
      pendingY = e.clientY;
      if (hitRaf == null) hitRaf = requestAnimationFrame(runHitTest);
    };

    window.addEventListener('mousemove', onMove);
    // ★ 启动就穿透(2026-10-31 修):
    //   桌宠窗口是全屏透明置顶窗。启动时不穿透 → 从窗口出现到用户第一次
    //   移动鼠标之间,整个屏幕都被这个透明窗挡住,用户点别的应用没反应。
    //   forward:true 让穿透状态下 mousemove 仍能送到渲染端,hit-test 才能工作。
    window.petAPI?.setIgnoreMouseEvents(true, true);

    return () => {
      window.removeEventListener('mousemove', onMove);
      if (hitRaf != null) cancelAnimationFrame(hitRaf);
      // 卸载时恢复「不穿透」—— 下一个角色的挂载 effect 会自己设成穿透
      window.petAPI?.setIgnoreMouseEvents(false, false);
    };
  }, []);

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
      posRef.current = clampPetPos({ x: originX + dx, y: originY + dy }, scale);
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
        // 纯点击 → 播点击回应 + 音效
        playClickSound();
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
  }, [character.id, manifest.categories.clicks, manifest.categories.drag, applyPosToDom, switchTo, scale, playClickSound]);

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
      playEventAnimation,
      sleep,
      wake,
      isSleeping: () => sleepMachineRef.current?.sleeping() ?? false,
      memes,
    }),
    [character.id, scale, playAnimation, playEventAnimation, sleep, wake, memes],
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
      {/* 命中检测专用:离屏 canvas,只用来读当前帧的 alpha(不显示) */}
      <canvas
        ref={hitCanvasRef}
        width={VIDEO_W}
        height={VIDEO_H}
        style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
      />
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
