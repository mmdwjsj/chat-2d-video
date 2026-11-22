/**
 * 界面预览的画面数据：和成片导出走同一个 buildFrame、同一个 FrameInput、
 * 同一套 mouthTimeline，前端只负责把四档画面按时间轴播放出来。
 *
 * 以前预览页/分镜页各自用 React 画「背景图 + 人物贴图 + 字幕」，与成片
 * 完全是两套画面；这里把画面生成收回服务端，前端不再拥有任何画面逻辑。
 */
import { buildFrame, MOUTH_SHAPES, mouthTimeline, voiceLevels } from '@thai-video/video-renderer';
import { buildAnimatedShotPlan } from './animationWiring.js';
import type { MouthShape } from '@thai-video/video-renderer';
import type { ExportMode, ProjectBundle } from '@thai-video/core/types';
import {
  castOf, characterArtOf, previewAudioUrl, previewVoiceWav, shotFrameInput, subtitles,
} from './frameData.js';

export type PreviewShotFrames = {
  shotId: string;
  durationSec: number;
  fps: number;
  /** 有台词的镜头才有：与逐帧画面一一对应的口型序列 */
  timeline: MouthShape[] | null;
  /** 四档口型 HTML（只给实际用到的档）；无对白镜头只有 closed */
  frames: Partial<Record<MouthShape, string>>;
  /** 该镜头的配音（导出时留存或镜头已挂 WAV）；null = 还没有配音 */
  audioUrl: string | null;
  /** 口型驱动来源，界面如实标注，避免把「按台词节奏」说成「配音同步」 */
  lipSource: 'voice' | 'text' | 'none';
  /** 动画帧档：与成片同源，frameKeys[i] 决定第 i 帧显示哪张 HTML */
  frameKeys?: string[];
  framesByKey?: Record<string, string>;
  /** 显式降级说明，界面要显示，不能静默 */
  degradations?: string[];
};

export type PreviewFramesPayload = {
  mode: ExportMode;
  fps: number;
  shots: PreviewShotFrames[];
};

/** 图片走 /assets URL、不内联 base64，所以整个响应只有几百 KB。 */
export const buildPreviewFrames = (input: {
  bundle: ProjectBundle;
  mode: ExportMode;
  fps: number;
  projectTitle?: string;
}): PreviewFramesPayload => {
  const { bundle, mode, fps } = input;
  const characterArt = characterArtOf(bundle, { inline: false });
  const shots = [...bundle.shots].sort((a, b) => a.order - b.order);
  // 导出留下的配音缓存也算「已有配音」，画面上的标注不能与实际音轨矛盾。
  const voiceOver = shots.some((s) => Boolean(previewAudioUrl(s, mode)));

  const items = shots.map((shot, i): PreviewShotFrames => {
    const durationSec = shot.durationSec;
    const frameCount = Math.max(1, Math.round(durationSec * fps));
    const cast = castOf(bundle, shot);
    const text = subtitles(shot, mode);
    const wav = cast.length ? previewVoiceWav(shot, mode) : null;
    const levels = wav ? voiceLevels(wav, fps, frameCount) : null;
    const byVoice = Boolean(levels?.some((v) => v > 0.02));
    const timeline = cast.length
      ? mouthTimeline({ frames: frameCount, fps, voiceWav: wav, text: text.primary || text.secondary })
      : null;
    const frame = shotFrameInput({
      bundle, shot, mode, index: i + 1, total: shots.length,
      durationSec, characterArt, projectTitle: input.projectTitle,
      voiceOver,
    });

    // 只生成时间轴里真正出现过的档 + closed（静态展示的兜底档），
    // 前端把这几张 iframe 常驻叠放，切档时不会重新加载、不闪。
    const shapes = new Set<MouthShape>(['closed']);
    for (const shape of timeline ?? []) shapes.add(shape);
    const frames: Partial<Record<MouthShape, string>> = {};
    for (const shape of MOUTH_SHAPES) {
      if (!shapes.has(shape)) continue;
      frames[shape] = timeline
        ? buildFrame({ ...frame, mouthShape: shape })
        : buildFrame(frame); // 旁白 / 无人物镜头：保留原来的情绪嘴型，与成片一致
    }
    // 动画帧档与成片导出走同一份 wiring：预览里能看到姿态、位移与视差。
    const animation = buildAnimatedShotPlan({
      bundle, shot, mode, index: i + 1, total: shots.length,
      durationSec, fps, frameCount, voiceWav: wav, inline: false,
      projectTitle: input.projectTitle,
    });

    return {
      shotId: shot.id, durationSec, fps, timeline, frames,
      audioUrl: previewAudioUrl(shot, mode),
      lipSource: !cast.length ? 'none' : byVoice ? 'voice' : 'text',
      ...(animation.plan ? {
        frameKeys: animation.plan.timeline,
        framesByKey: animation.plan.htmlByKey,
        degradations: animation.plan.degradations,
      } : {}),
    };
  });

  return { mode, fps, shots: items };
};
