import { useEffect, useRef, useState } from 'react';

/**
 * 桌宠「一句话气泡」—— 头顶冒出一行字的轻量浮层。
 *
 * 为什么单独做,不复用 ChatBubble:
 *   - ChatBubble 是完整对话面板(输入框 + 历史 + 工具调用),太重;
 *   - 主动搭话只需要「说一句,几秒后消失」,一个 div 就够。
 *
 * 位置:锚在桌宠腰线(anchorY)正上方,居中对齐。
 *
 * ★ 淡入用 **CSS animation**(挂载即播放),不用 transition + 两阶段 visible 状态。
 *   踩过的坑:之前用 `useState(visible)` 配合 rAF/setTimeout 切 class,
 *   实测元素一直停在 `opacity: 0` —— 文字已经在 DOM 里但用户看不见。
 *   根因是 React 批处理 / effect 清理的时序让「切 class」这一步时有时无。
 *   CSS animation 在节点插入时自动跑,不依赖任何 JS 时序,稳得多。
 */

type Phase = 'in' | 'out' | 'idle';

interface Props {
  /** 要显示的文字;空字符串 = 不显示 */
  text: string;
  /** 桌宠腰线的 Y(CSS 像素),气泡底边贴这里 */
  anchorY: number | null;
  /**
   * 桌宠中心的 X(CSS 像素)—— 气泡水平居中在它头顶。
   *
   * ★ 为什么必须有 X(2026-11-14 修):之前气泡的 CSS 是 `left:50%`。
   *   那在 dsh-pet 原版是对的(桌宠是一个小盒子,气泡在盒子里居中),
   *   但我们把桌宠放进了**全屏窗口** —— `left:50%` 就变成了**屏幕中心**,
   *   桌宠在右下角时气泡跑到屏幕中间去了(用户实测反馈)。
   *   → 改成按桌宠实际 X 定位。
   */
  anchorX?: number | null;
  /** 显示时长(毫秒);到期开始淡出 */
  durationMs: number;
  /**
   * 配图 URL(表情包)。
   *
   * ★ 上游 dsh-pet 的行为:碎碎念随机配一张图,对话按语境选一张图,
   *   图与文字同时显示(图在上、文字在下)。有图时气泡不再有最小宽度,
   *   否则图旁边会留一大片空白。
   */
  imageUrl?: string | null;
}

/** 淡出动画时长(ms),与 CSS 里 .pet-speech--out 的 animation-duration 对齐 */
const FADE_OUT_MS = 200;

export function PetSpeechBubble({ text, anchorY, anchorX, durationMs, imageUrl }: Props): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>('idle');
  const [shown, setShown] = useState('');
  const hideTimer = useRef<number | null>(null);
  const idleTimer = useRef<number | null>(null);

  useEffect(() => {
    const clearTimers = () => {
      if (hideTimer.current != null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      if (idleTimer.current != null) {
        window.clearTimeout(idleTimer.current);
        idleTimer.current = null;
      }
    };

    if (!text) {
      setPhase('idle');
      clearTimers();
      return clearTimers;
    }

    // 新文字 → 立刻进 'in' 阶段(CSS animation 自动淡入)
    setShown(text);
    setPhase('in');
    clearTimers();
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setPhase('out');
      idleTimer.current = window.setTimeout(() => {
        idleTimer.current = null;
        setPhase('idle');
      }, FADE_OUT_MS);
    }, Math.max(600, durationMs));

    return clearTimers;
  }, [text, durationMs]);

  // 没内容 / 已彻底收起 → 不渲染
  if (!shown || phase === 'idle') return null;

  // 腰线在气泡底边 → 往上偏移气泡高度
  const bottom = anchorY != null ? anchorY : window.innerHeight - 120;
  // ★ 水平:贴在桌宠正上方(不是屏幕中心)。
  //   没有 anchorX 时退回 50%(此时桌宠多半也在中间,不至于离谱)。
  const left = anchorX != null ? anchorX : window.innerWidth / 2;

  return (
    <div
      // ★ key 用 shown —— 文字变了就重新挂载,CSS animation 会重播。
      //   否则同一个 div 复用,新气泡不会重新淡入(看起来像没反应)。
      key={shown}
      className={'pet-speech' + (phase === 'out' ? ' pet-speech--out' : '')}
      style={{ bottom: `calc(100% - ${bottom}px)`, left: `${left}px` }}
      role="status"
      aria-live="polite"
      title={shown}
    >
      {/* 表情包在上、文字在下(上游 dsh-pet 的气泡排版)。
          有图时去掉最小宽度 —— 否则图旁边会留一大片空白。 */}
      {imageUrl && <img className="pet-speech-img" src={imageUrl} alt="" draggable={false} />}
      <span className="pet-speech-text">{shown}</span>
    </div>
  );
}
