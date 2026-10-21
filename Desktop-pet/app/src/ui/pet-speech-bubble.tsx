import { useEffect, useRef, useState } from 'react';

/**
 * 桌宠「一句话气泡」—— 头顶冒出一行字的轻量浮层。
 *
 * 为什么单独做,不复用 ChatBubble:
 *   - ChatBubble 是完整对话面板(输入框 + 历史 + 工具调用),太重;
 *   - 主动搭话只需要「说一句,几秒后消失」,一个 div 就够。
 *
 * 位置:锚在桌宠腰线(anchorY)正上方,居中对齐。
 * 淡入淡出:用 CSS transition,不用 JS 定时器控制 opacity。
 */
interface Props {
  /** 要显示的文字;空字符串 = 不显示 */
  text: string;
  /** 桌宠腰线的 Y(CSS 像素),气泡底边贴这里 */
  anchorY: number | null;
  /** 显示时长(毫秒);到期自动收起 */
  durationMs: number;
}

export function PetSpeechBubble({ text, anchorY, durationMs }: Props): JSX.Element | null {
  const [visible, setVisible] = useState(false);
  const [shown, setShown] = useState('');
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!text) {
      // 清空 → 立即淡出
      setVisible(false);
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    setShown(text);
    // 下一帧再置 visible,让 CSS transition 有起点
    const raf = requestAnimationFrame(() => setVisible(true));
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setVisible(false);
      timerRef.current = null;
    }, Math.max(600, durationMs));
    return () => {
      cancelAnimationFrame(raf);
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [text, durationMs]);

  if (!shown) return null;

  // 腰线在气泡底边 → 往上偏移气泡高度
  const bottom = anchorY != null ? anchorY : window.innerHeight - 120;

  return (
    <div
      className={'pet-speech' + (visible ? ' pet-speech--in' : '')}
      style={{ bottom: `calc(100% - ${bottom}px)` }}
      role="status"
      aria-live="polite"
    >
      <span className="pet-speech-text">{shown}</span>
    </div>
  );
}
