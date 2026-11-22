/**
 * 动画链路接线层：项目数据 → FrameDirector → 每帧档 HTML。
 *
 * 成片导出与界面预览都调这里，保证「画面只有一套实现」。
 * 注册表读盘只在本文件发生，packages/animation 保持纯计算、零运行时依赖。
 * 任何一步不可用都返回 null，由调用方回退到原有 4 档口型链路，并带上降级说明。
 */
import fs from 'node:fs';
import path from 'node:path';
import { P, cuesForShot } from '@thai-video/core';
import type { ExportMode, ProjectBundle, Shot } from '@thai-video/core/types';
import {
  collectMissingAssets, collectMissingSceneAssets, directShot, parseRegistry,
  resolveActionClip, resolveCharacterRig, resolveSceneSpec,
} from '@thai-video/animation';
import type {
  ActionClip, AnimationRegistry, CharacterRig, SceneSpec,
} from '@thai-video/animation';
import { buildAnimatedFrame, mouthTimeline } from '@thai-video/video-renderer';
import { castOf, sceneOf, subtitles } from './frameData.js';

export type AnimatedShotPlan = {
  /** frameKey → 该档的完整 HTML；相同 key 只截一次图 */
  htmlByKey: Record<string, string>;
  /** 与视频帧一一对应的 frameKey 序列 */
  timeline: string[];
  /** 显式降级说明，必须出现在导出结果 / 预览数据里 */
  degradations: string[];
  frameKeyCount: number;
};

const CONFIG_FILE = (): string => P.config('animation.json');

let cached: { mtimeMs: number; registry: AnimationRegistry | null; notes: string[] } | null = null;

/** 注册表被外部写入（界面上传/清除）后主动清缓存，避免同一毫秒内 mtime 相同读不到新值。 */
export const invalidateAnimationRegistry = (): void => { cached = null; };

/** 按 mtime 缓存，改 config 立刻生效，不用重启服务。 */
export const loadAnimationRegistry = (): { registry: AnimationRegistry | null; notes: string[] } => {
  try {
    const file = CONFIG_FILE();
    const mtimeMs = fs.statSync(file).mtimeMs;
    if (cached && cached.mtimeMs === mtimeMs) {
      return { registry: cached.registry, notes: cached.notes };
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const parsed = parseRegistry(raw);
    cached = { mtimeMs, registry: parsed.value, notes: parsed.degradations };
  } catch (error) {
    cached = {
      mtimeMs: 0, registry: null,
      notes: [`动画注册表读取失败（${error instanceof Error ? error.message : String(error)}）：已回退到原口型链路`],
    };
  }
  return { registry: cached.registry, notes: cached.notes };
};

const PLACEHOLDER = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="780"><rect x="120" y="180" width="180" height="420" rx="60" fill="#9a9a9a" opacity="0.45"/></svg>',
)}`;

const resolveImage = (src: string, inline: boolean): string => {
  if (/^(data:|https?:)/.test(src)) return src;
  const absolute = path.resolve(P.root, src);
  if (!inline) return `/${src.replace(/^[\\/]+/, '').split(path.sep).join('/')}`;
  try {
    const buffer = fs.readFileSync(absolute);
    const mime = /\.jpe?g$/i.test(src) ? 'image/jpeg'
      : /\.webp$/i.test(src) ? 'image/webp' : 'image/png';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch {
    return PLACEHOLDER;
  }
};

const assetExists = (src: string): boolean => fs.existsSync(path.resolve(P.root, src));

/**
 * 构建单个镜头的动画帧档。返回 null 表示该镜头应走原有静帧/口型链路
 * （旁白镜头、注册表关闭、读取失败），调用方需把 notes 写进结果。
 */
export const buildAnimatedShotPlan = (input: {
  bundle: ProjectBundle;
  shot: Shot;
  mode: ExportMode;
  index: number;
  total: number;
  durationSec: number;
  fps: number;
  frameCount: number;
  voiceWav: string | null;
  /** true = 导出（图片内联 data URI）；false = 界面预览（/assets URL） */
  inline: boolean;
  projectTitle?: string;
}): { plan: AnimatedShotPlan | null; notes: string[] } => {
  const { registry, notes } = loadAnimationRegistry();
  if (!registry || !registry.enabled) {
    return { plan: null, notes: [...notes, registry ? '动画链路已在 config/animation.json 关闭' : ''] };
  }

  const cast = castOf(input.bundle, input.shot);
  // 旁白 / 无出场人物镜头本来就没有动作主体，沿用原静帧链路
  if (!cast.length) return { plan: null, notes: [] };

  const degradations = new Set<string>(notes);
  const scene = sceneOf(input.bundle, input.shot);
  const sceneResolved = resolveSceneSpec(registry, input.shot.sceneId);
  for (const note of sceneResolved.degradations) degradations.add(note);
  // Scene.backgroundImage 是历史上一直没接进渲染的字段：项目里填了就作为整张底图生效。
  // 注册表里显式配的 backgroundImage 优先级更高，便于资产统一治理。
  const projectBg = (scene?.backgroundImage ?? '').trim();
  const sceneSpec: SceneSpec = projectBg && !sceneResolved.value.backgroundImage
    ? { ...sceneResolved.value, backgroundImage: projectBg }
    : sceneResolved.value;
  for (const note of collectMissingSceneAssets(sceneSpec, assetExists)) degradations.add(note);

  const rigs: Record<string, CharacterRig | null> = {};
  for (const character of cast) {
    const resolved = resolveCharacterRig(registry, character.id);
    for (const note of resolved.degradations) degradations.add(note);
    rigs[character.id] = resolved.value;
    if (resolved.value) {
      for (const note of collectMissingAssets(resolved.value, assetExists)) degradations.add(note);
    }
  }

  const cues = cuesForShot(input.shot);
  const clips: Record<string, ActionClip> = { ...registry.actions };
  for (const cue of cues) {
    const resolved = resolveActionClip(registry, cue.clipId);
    for (const note of resolved.degradations) degradations.add(note);
    clips[cue.clipId] = resolved.value;
  }

  const text = subtitles(input.shot, input.mode);
  const mouths = mouthTimeline({
    frames: input.frameCount,
    fps: input.fps,
    voiceWav: input.voiceWav,
    text: text.primary || text.secondary,
  });

  const directed = directShot({
    fps: input.fps,
    frames: input.frameCount,
    actorIds: cast.map((c) => c.id),
    speakingId: cast[0].id,
    rigs,
    scene: sceneSpec,
    clips,
    cues,
    mouths,
  });
  for (const note of directed.degradations) degradations.add(note);

  const notesList = [...degradations].filter(Boolean);
  const htmlByKey: Record<string, string> = {};
  for (const frame of directed.frames) {
    htmlByKey[frame.frameKey] = buildAnimatedFrame({
      projectTitle: input.projectTitle ?? input.bundle.meta.name,
      mode: input.mode,
      index: input.index,
      total: input.total,
      durationSec: input.durationSec,
      scene,
      sceneSpec,
      frame,
      rigs,
      characters: cast,
      speakingId: cast[0].id,
      primarySubtitle: text.primary,
      secondarySubtitle: text.secondary,
      resolveImage: (src) => resolveImage(src, input.inline),
      degradations: notesList,
    });
  }

  return {
    plan: {
      htmlByKey,
      timeline: directed.timeline,
      degradations: notesList,
      frameKeyCount: directed.frameKeyCount,
    },
    notes: notesList,
  };
};
