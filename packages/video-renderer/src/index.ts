import { spawnSync } from 'node:child_process';
import type { AppConfig } from '@thai-video/core';

export * from './timeline.js';
export * from './commands.js';
export * from './sceneArt.js';
export * from './animatedFrame.js';
export * from './frameSequence.js';
export * from './mouth.js';
export * from './frames.js';
export * from './ffmpeg.js';
export * from './audio.js';
export * from './render.js';

import { findBrowser } from './frames.js';

export type RenderEnvironment = {
  browser: string | null;
  ffmpeg: boolean;
  ffprobe: boolean;
  available: boolean;
  reason: string;
};

/** 同步探测本机渲染能力，供 /api/config 与导出页显示。 */
export const renderEnvironment = (): RenderEnvironment => {
  const browser = findBrowser();
  const probe = (name: string, envKey: string): boolean => {
    const executable = process.env[envKey] ?? name;
    const result = spawnSync(executable, ['-version'], { windowsHide: true, stdio: 'ignore' });
    return result.status === 0;
  };
  const ffmpeg = probe('ffmpeg', 'THAI_VIDEO_FFMPEG');
  const ffprobe = probe('ffprobe', 'THAI_VIDEO_FFPROBE');
  const missing = [
    !browser && 'Edge/Chrome', !ffmpeg && 'FFmpeg', !ffprobe && 'ffprobe',
  ].filter(Boolean).join('、');
  return {
    browser, ffmpeg, ffprobe,
    available: Boolean(browser) && ffmpeg && ffprobe,
    reason: missing ? `缺少 ${missing}` : '本机渲染链路就绪',
  };
};

/** 阶段四入口：现在返回真实可执行的渲染配置，不再是占位说明。 */
export const createRenderer = (config: AppConfig) => ({
  available: renderEnvironment().available,
  fps: config.video.fps,
  width: config.video.width,
  height: config.video.height,
  video: config.video,
  note: '本地渲染：HTML/SVG 画面 → Edge 截图 → FFmpeg H.264/AAC 合成；总时长由 computeTimeline 按音频实测值决定',
});
