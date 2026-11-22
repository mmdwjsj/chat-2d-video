import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MOUTH_SHAPES } from '@thai-video/video-renderer/mouthCore';
import type { MouthShape } from '@thai-video/video-renderer/mouthCore';
import type { PreviewShotFrames } from './previewFrames';

/**
 * 成片同款画面播放器。
 *
 * 画面是服务端用 buildFrame 生成的 1080×1920 HTML（与导出截图用的是同一个函数），
 * 四档口型各一张 iframe 常驻叠放，按 mouthTimeline 逐帧切 visibility：
 * 不重新加载、不闪，播放的就是成片里那几张画面。
 *
 * 预览页和分镜页都用它，任何一处改画面，两处一起变。
 */
const FRAME_W = 1080;
const FRAME_H = 1920;

const LIP_LABEL: Record<PreviewShotFrames['lipSource'], string> = {
  voice: '口型跟配音音量',
  text: '口型按台词节奏（未配音）',
  none: '旁白 / 无人物镜头 · 无口型',
};

type Props = {
  shot: PreviewShotFrames | null;
  /** false 时只显示一帧，用作缩略图 */
  animate?: boolean;
  /** 播放 / 暂停 / 拖进度 */
  controls?: boolean;
  /** 画面加载失败或等待时的提示 */
  hint?: string;
  /** 服务端给出的该镜头配音；有值时播放声音并用音频时钟驱动口型 */
  audioUrl?: string | null;
  className?: string;
};

const useFrameScale = (ref: React.RefObject<HTMLDivElement | null>): number => {
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setScale(el.clientWidth / FRAME_W);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return scale;
};

export const FramePlayer: React.FC<Props> = ({
  shot, animate = true, controls = false, hint = '画面生成中…', className = '',
  audioUrl = null,
}) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const scale = useFrameScale(boxRef);
  const [playing, setPlaying] = useState(true);
  const [frame, setFrame] = useState(0);
  const frameRef = useRef(0);

  const timeline = animate && shot?.timeline?.length ? shot.timeline : null;
  const fps = shot?.fps ?? 30;
  // 动画帧档优先：有 framesByKey 就按 frameKeys 切档，否则回退到原有 4 档口型。
  const keyed = Boolean(shot?.framesByKey && Object.keys(shot.framesByKey).length > 0);
  const shapes = useMemo(
    () => keyed
      ? Object.keys(shot?.framesByKey ?? {})
      : MOUTH_SHAPES.filter((shape) => Boolean(shot?.frames[shape])),
    [shot, keyed],
  );

  // 换镜头 / 切到静态模式时从头播，不继承上一个镜头的进度。
  useEffect(() => {
    frameRef.current = 0;
    setFrame(0);
    setPlaying(true);
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      try { audio.currentTime = 0; } catch { /* 元数据未就绪 */ }
    }
  }, [shot?.shotId, animate, audioUrl]);

  // 有配音在播时以音频时钟为准，口型和声音严格对齐；音频放完或没配音时
  // 回退到帧计时，画面不会卡住也不会跳回开头。
  useEffect(() => {
    if (!playing || !timeline || timeline.length === 0) return;
    let raf = 0;
    let anchor = 0;
    let base = frameRef.current;
    const tick = (now: number): void => {
      const audio = audioRef.current;
      let next: number;
      if (audio && !audio.paused && !audio.ended && audio.readyState > 0) {
        next = Math.floor(audio.currentTime * fps) % timeline.length;
        base = next;
        anchor = now;
      } else {
        if (!anchor) anchor = now;
        next = (base + Math.floor((now - anchor) / (1000 / fps))) % timeline.length;
      }
      if (next !== frameRef.current) {
        frameRef.current = next;
        setFrame(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, timeline, fps, audioUrl]);

  // 播放 / 暂停 / 换镜头时同步音频；浏览器拦截自动播放时静默降级为无声画面。
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      try { audio.currentTime = frameRef.current / fps; } catch { /* 元数据未就绪 */ }
      void audio.play().catch(() => undefined);
    } else {
      audio.pause();
    }
  }, [playing, audioUrl, shot?.shotId]);

  const wanted = keyed
    ? (shot?.frameKeys?.[Math.min(frame, (shot.frameKeys?.length ?? 1) - 1)] ?? shapes[0] ?? 'closed')
    : (timeline ? (timeline[Math.min(frame, timeline.length - 1)] ?? 'closed') : 'closed');
  const current = shapes.includes(wanted) ? wanted : (shapes[0] ?? 'closed');
  const ready = Boolean(shot && shapes.length > 0 && scale > 0);
  const seek = (k: number): void => {
    frameRef.current = k;
    setFrame(k);
    setPlaying(false);
    const audio = audioRef.current;
    if (audio) { try { audio.currentTime = k / fps; } catch { /* 元数据未就绪 */ } }
  };

  return (
    <div className={className}>
      {controls && audioUrl && animate && (
        <audio ref={audioRef} src={audioUrl} preload="auto" />
      )}
      <div ref={boxRef} className="relative aspect-[9/16] w-full overflow-hidden rounded-xl border border-stone-300 bg-gradient-to-b from-sky-100 to-orange-50">
        {ready && shot ? (
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ width: FRAME_W, height: FRAME_H, transform: `scale(${scale})` }}
          >
            {shapes.map((shape) => (
              <iframe
                key={shape}
                title={`镜头画面 · ${shape}`}
                width={FRAME_W}
                height={FRAME_H}
                scrolling="no"
                srcDoc={keyed
                  ? (shot.framesByKey?.[shape] ?? '')
                  : (shot.frames[shape as MouthShape] ?? '')}
                className="absolute inset-0 border-0 bg-transparent"
                style={{ visibility: shape === current ? 'visible' : 'hidden', pointerEvents: 'none' }}
              />
            ))}
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-[11px] text-stone-400">
            {hint}
          </div>
        )}
      </div>

      {controls && shot && (
        <div className="mt-2 space-y-1">
          <div className="flex items-center gap-2 text-[11px] text-stone-500">
            <button
              type="button"
              className="btn btn-ghost px-2 py-0.5 text-xs"
              onClick={() => setPlaying((p) => !p)}
              disabled={!timeline}
            >
              {playing && timeline ? '暂停' : '播放'}
            </button>
            {audioUrl && (
              <button
                type="button"
                className="btn btn-ghost px-2 py-0.5 text-xs"
                onClick={() => {
                  const audio = audioRef.current;
                  if (audio) {
                    try { audio.currentTime = frameRef.current / fps; } catch { /* 元数据未就绪 */ }
                    void audio.play().catch(() => undefined);
                  }
                  setPlaying(true);
                }}
              >
                重开声音
              </button>
            )}
            {timeline ? (
              <input
                type="range" min={0} max={timeline.length - 1} value={Math.min(frame, timeline.length - 1)}
                onChange={(e) => seek(Number(e.target.value))}
                className="h-1 min-w-0 flex-1"
                aria-label="镜头进度"
              />
            ) : <span className="flex-1">静帧</span>}
            <span className="tabular-nums">
              {timeline ? (frame / fps).toFixed(1) : '0.0'}/{shot.durationSec.toFixed(1)}s
            </span>
          </div>
          <p className="text-center text-[10px] text-stone-400">
            {LIP_LABEL[shot.lipSource]} · 与成片同一套画面
            {keyed ? ' · 动画帧（姿态 / 视差）' : ''}
            {shot.degradations?.length ? ` · 降级：${shot.degradations[0]}` : ''}
            {audioUrl ? ' · 配音已就绪（浏览器拦截自动播放时点「重开声音」）' : ' · 暂无配音'}
          </p>
        </div>
      )}
    </div>
  );
};
