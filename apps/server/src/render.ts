/**
 * video.render 任务：把「项目 → 剧本 → 分镜」真正合成为一个可播放的 MP4。
 *
 * 链路：挑台词 → 配音（可选）→ ffprobe 实测 → computeTimeline 定长时间轴 →
 * HTML/SVG 画面帧 → Edge 截图 → FFmpeg 动效/拼接/混音 → output/<项目ID>/*.mp4。
 * 没有配音时不伪造人声，改为字幕 + 本地氛围音，并在结果里如实标注。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { P } from '@thai-video/core';
import type { Workbench } from '@thai-video/core';
import type { ExportMode, Task } from '@thai-video/core/types';
import { diagnoseTtsError } from '@thai-video/tts-providers';
import type { TtsDiagnosis, TtsProvider } from '@thai-video/tts-providers';
import {
  buildFrame, captureFrame, computeTimeline, findBrowser, mouthTimeline,
  prepareShotVoice, renderEnvironment, renderVideo, scheduleCleanup,
  usedShapes, writeFrameSequence, writeKeyedFrameSequence,
} from '@thai-video/video-renderer';
import type { FrameInput, MouthShape } from '@thai-video/video-renderer';
import { buildAnimatedShotPlan } from './animationWiring.js';
import type { AnimatedShotPlan } from './animationWiring.js';
import {
  castOf, characterArtOf, resolveAudio, sceneOf, shotFrameInput, shotVoiceCachePath,
  subtitles, voiceLines,
} from './frameData.js';

export type RenderProgress = (percent: number, status?: 'generating' | 'processing') => void;

const MODE_LABEL: Record<ExportMode, string> = {
  zh: '中文版', th: '泰语版', bilingual: '双语版',
};

const safeName = (name: string): string =>
  (name || '未命名项目').replace(/[\\/:*?"<>|\r\n]/g, '').trim().slice(0, 40) || '未命名项目';

const stamp = (): string => {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

/**
 * edge-tts 走公网，一次网络抖动就会让整片没有配音，所以网络类失败单句最多试两次。
 * 但本机缺依赖/命令写错属于必失败，重试 2 次只是把同一个错误打 18 遍，直接跳出。
 * 仍失败也不静默吞掉：调用方会回退到镜头已挂的 WAV 并记下诊断。
 * provider 自带按台词哈希的 WAV 缓存，命中缓存时不会联网。
 */
const synthesizeWithRetry = async (
  tts: TtsProvider,
  request: Parameters<TtsProvider['synthesize']>[0],
): Promise<Awaited<ReturnType<TtsProvider['synthesize']>>> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await tts.synthesize(request); }
    catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!diagnoseTtsError(message).retryable) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

// 字幕取法、出场人物、人物图标定、配音路径都在 frameData.ts 里，
// 界面预览调的是同一组函数：改一处，成片和预览一起变，不会再各自漂移。
export const runVideoRender = async (
  wb: Workbench,
  task: Task,
  progress: RenderProgress,
  deps: { tts: TtsProvider },
): Promise<Record<string, unknown>> => {
  const projectId = task.projectId;
  const meta = wb.projects.meta(projectId);
  const mode: ExportMode = (['zh', 'th', 'bilingual'].includes(String(task.payload.mode))
    ? task.payload.mode : meta.exportMode) as ExportMode;
  const bundle = wb.projects.get(projectId);
  const shots = [...bundle.shots].sort((a, b) => a.order - b.order);
  if (!shots.length) throw new Error('没有可渲染的分镜：请先到「剧本编辑」生成剧本，再点「自动分镜」');

  const env = renderEnvironment();
  if (!env.available) throw new Error(`本机渲染环境未就绪：${env.reason}`);

  const { width, height, fps } = wb.config.video;
  const workDir = path.join(P.root, 'data', 'render-tmp', task.id);
  const framesDir = path.join(workDir, 'frames');
  const voiceDir = path.join(workDir, 'voice');
  // Edge 缓存有上千个小文件：放系统临时目录并固定复用一份，交给 OS 管理，
  // 不在每次渲染后递归删除（那会长时间占用线程池/删除锁，拖慢其它操作）。
  const profileDir = path.join(os.tmpdir(), 'thai-video-edge-render');
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(voiceDir, { recursive: true });

  const introSec = 1.6;
  const outroSec = 1.4;
  // 人物图标定、字幕、出场人物与预览共用 frameData.ts 的同一份实现。
  // 唯一差别：截图时 Edge 以 file:// 打开 HTML，图片必须内联成 data URI。
  const characterArt = characterArtOf(bundle, { inline: true });

  /* 1. 配音：优先已配置的 TTS，其次镜头里已有的真实 WAV ------------------- */
  progress(6, 'processing');
  // 先做一次本机自检（挑解释器 / 检查依赖），纯本地、不联网。缺包若当成「断网」，
  // 用户等网络恢复也不会好，且 9 句台词会白白重复 18 次同一个错误。
  const ttsPreflight = deps.tts.available && deps.tts.preflight
    ? await deps.tts.preflight()
    : undefined;
  // 预检只做本机 import，不联网；失败一律是本机环境/配置问题，直接跳过逐句合成。
  const ttsBlocked = Boolean(ttsPreflight && !ttsPreflight.ok);
  const blockedReason = ttsPreflight?.ok
    ? ''
    : `配音环境未就绪：${ttsPreflight?.reason ?? '本机 TTS 命令不可用'}`;
  const voiceWavs: (string | null)[] = [];
  const audioDurations: Record<string, number> = {};
  const voiceFailures: { shotId: string; text: string; reason: string }[] = [];
  let voiceLinesUsed = 0;
  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i];
    const lines = voiceLines(shot, mode);
    const speaker = bundle.characters.find((c) => shot.characterIds.includes(c.id));
    const files: string[] = [];
    for (const line of lines) {
      try {
        if (ttsBlocked) throw new Error(blockedReason);
        if (deps.tts.available) {
          const voice = speaker?.voices?.[line.language];
          const result = await synthesizeWithRetry(deps.tts, {
            text: line.text, language: line.language,
            engine: voice?.engine ?? '', voice: voice?.voice ?? '',
            speed: voice?.speed ?? 1, volume: voice?.volume ?? 1,
            emotion: voice?.emotion ?? shot.expression, shotId: `${shot.id}.${line.language}`,
          });
          files.push(result.wavPath);
        } else {
          const existing = resolveAudio(line.slot);
          if (existing) files.push(existing);
        }
      } catch (error) {
        // 单句失败不拖垮整片，但不能静默：先回退镜头已生成的 WAV，再如实记录原因，
        // 否则用户只会看到「成片没声音」却不知道是 TTS 联网失败。
        const reason = error instanceof Error ? error.message : String(error);
        const existing = resolveAudio(line.slot);
        if (existing) files.push(existing);
        else voiceFailures.push({ shotId: shot.id, text: line.text.slice(0, 24), reason });
        console.warn('[render] 配音跳过：', reason);
      }
    }
    // 整句都合成失败时，用上次导出留下的整镜头配音兜底，避免离线就整片没声。
    // 缓存补回了这一镜头，就不能再把它算作「成片没声音」的失败。
    if (!files.length) {
      const cached = shotVoiceCachePath(shot.id, mode);
      if (fs.existsSync(cached)) {
        files.push(cached);
        for (let k = voiceFailures.length - 1; k >= 0; k -= 1) {
          if (voiceFailures[k].shotId === shot.id) voiceFailures.splice(k, 1);
        }
      }
    }
    voiceLinesUsed += files.length;
    const merged = await prepareShotVoice(files, path.join(voiceDir, `${shot.id}.wav`));
    if (merged) {
      voiceWavs.push(merged.path);
      audioDurations[merged.path] = merged.durationSec;
      // 配音持久化到 assets：预览能直接播放，下次 TTS 失败也能兜底。
      const cached = shotVoiceCachePath(shot.id, mode);
      fs.mkdirSync(path.dirname(cached), { recursive: true });
      fs.copyFileSync(merged.path, cached);
    } else {
      voiceWavs.push(null);
    }
    progress(6 + Math.round(((i + 1) / shots.length) * 16), 'processing');
  }

  /* 2. 时间轴：镜头时长 ≥ 配音实测时长 + 尾部留白 -------------------------- */
  const timeline = computeTimeline(
    shots.map((shot, i) => ({
      id: shot.id, durationSec: shot.durationSec,
      audioZhPath: voiceWavs[i] ?? '', audioThPath: '',
    })),
    audioDurations, 'zh', { fps },
  );
  const warnings = timeline.warnings.filter((w) => !w.includes('缺少'));

  /* 3. 画面帧：片头 → 每个镜头 → 片尾 ------------------------------------- */
  type SegmentDef = {
    id: string;
    frame: FrameInput;
    durationSec: number;
    motion: boolean;
    voiceWav: string | null;
    /** 有人说话的镜头才有：与视频帧一一对应的口型序列 */
    mouthTimeline?: MouthShape[];
    /** 动画镜头的帧档（与成片同源）；有值时优先于 4 档口型链路 */
    animated?: AnimatedShotPlan;
  };
  const defs: SegmentDef[] = [];
  const animationNotes = new Set<string>();
  const firstScene = sceneOf(bundle, shots[0]);
  defs.push({
    id: 'intro', durationSec: introSec, motion: false, voiceWav: null,
    frame: {
      kind: 'intro', projectTitle: meta.name, mode, scene: firstScene,
      durationSec: introSec, voiceOver: voiceLinesUsed > 0,
    },
  });
  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i];
    const cast = castOf(bundle, shot);
    const text = subtitles(shot, mode);
    const durationSec = timeline.shots[i].durationSec;
    // 帧数必须与 renderVideo 的 framesOf(durationSec) 完全一致，否则时长铁律会破。
    const frameCount = Math.max(1, Math.round(durationSec * fps));
    // 动画帧档构建失败 / 注册表关闭时返回 null，自动回退到下面的 4 档口型链路。
    const animation = buildAnimatedShotPlan({
      bundle, shot, mode, index: i + 1, total: shots.length,
      durationSec, fps, frameCount, voiceWav: voiceWavs[i], inline: true,
      projectTitle: meta.name,
    });
    for (const note of animation.notes) animationNotes.add(note);
    defs.push({
      id: shot.id,
      durationSec,
      motion: true,
      voiceWav: voiceWavs[i],
      animated: animation.plan ?? undefined,
      mouthTimeline: cast.length
        ? mouthTimeline({
          frames: frameCount, fps, voiceWav: voiceWavs[i],
          text: text.primary || text.secondary,
        })
        : undefined,
      frame: shotFrameInput({
        bundle, shot, mode, index: i + 1, total: shots.length,
        durationSec, characterArt, projectTitle: meta.name,
        voiceOver: voiceLinesUsed > 0,
      }),
    });
  }
  defs.push({
    id: 'outro', durationSec: outroSec, motion: false, voiceWav: null,
    frame: {
      kind: 'outro', projectTitle: meta.name, mode, scene: firstScene,
      durationSec: outroSec, voiceOver: voiceLinesUsed > 0,
    },
  });

  const browser = findBrowser();
  const framePngs: string[] = [];
  const frameSequences: (string | undefined)[] = [];
  for (let i = 0; i < defs.length; i += 1) {
    const def = defs[i];
    const capture = { browser: browser ?? undefined, profileDir };
    // 截图串行执行，共用一个浏览器缓存目录，避免每个镜头都留下一份几十 MB 的 profile
    if (def.animated) {
      // 动画镜头：每个 frameKey 只截一张 PNG，再按时间轴硬链接铺成逐帧序列。
      // 文件名用序号而不是 frameKey（frameKey 含 | 等 Windows 非法字符）。
      const pngByKey: Record<string, string> = {};
      let n = 0;
      for (const [key, html] of Object.entries(def.animated.htmlByKey)) {
        const tag = `k${String(n).padStart(3, '0')}`;
        n += 1;
        const htmlPath = path.join(framesDir, `frame-${i}-${tag}.html`);
        const png = path.join(framesDir, `frame-${i}-${tag}.png`);
        await captureFrame(html, htmlPath, png, capture);
        pngByKey[key] = png;
      }
      frameSequences.push(writeKeyedFrameSequence({
        dir: path.join(framesDir, `anim-${i}`),
        pngByKey,
        timeline: def.animated.timeline,
      }));
      framePngs.push(Object.values(pngByKey)[0] ?? '');
    } else if (def.mouthTimeline) {
      // 对白镜头：按本镜头实际用到的嘴型各截一张，再铺成逐帧序列。
      // 无配音时 mouthTimeline 也会给出开合节奏，不会退回「一张静帧」。
      const shapePngs: Partial<Record<MouthShape, string>> = {};
      for (const shape of usedShapes(def.mouthTimeline)) {
        const shapeHtmlPath = path.join(framesDir, `frame-${i}-${shape}.html`);
        const shapePng = path.join(framesDir, `frame-${i}-${shape}.png`);
        await captureFrame(buildFrame({ ...def.frame, mouthShape: shape }), shapeHtmlPath, shapePng, capture);
        shapePngs[shape] = shapePng;
      }
      frameSequences.push(writeFrameSequence({
        dir: path.join(framesDir, `mouth-${i}`),
        shapePngs,
        timeline: def.mouthTimeline,
      }));
      framePngs.push(shapePngs[def.mouthTimeline[0]] ?? '');
    } else {
      const htmlPath = path.join(framesDir, `frame-${i}.html`);
      const pngPath = path.join(framesDir, `frame-${i}.png`);
      await captureFrame(buildFrame(def.frame), htmlPath, pngPath, capture);
      framePngs.push(pngPath);
      frameSequences.push(undefined);
    }
    progress(24 + Math.round(((i + 1) / defs.length) * 26), 'processing');
  }

  /* 4. FFmpeg 合成 ---------------------------------------------------------- */
  const fileName = `${safeName(meta.name)}-${MODE_LABEL[mode]}-${stamp()}.mp4`;
  const relPath = `${projectId}/${fileName}`;
  const outputFile = path.join(P.outputDir(), projectId, fileName);
  const result = await renderVideo({
    workDir: path.join(workDir, 'ffmpeg'),
    outputFile,
    fps, width, height,
    segments: defs.map((def, i) => ({
      id: def.id, framePng: framePngs[i], frameSequence: frameSequences[i],
      durationSec: def.durationSec, voiceWav: def.voiceWav, motion: def.motion,
    })),
    onProgress: (percent, _note) => progress(Math.min(98, 50 + Math.round(percent * 0.48)), 'processing'),
  });

  // 帧、配音等中间产物异步清理；成片在 output/ 下，不受影响。
  scheduleCleanup(workDir);

  // 用完整原始报错分类，别拿 slice(0, 80) 的残句判断——那会把 edge_tts 截成 edg。
  const voiceDiagnosis: TtsDiagnosis | undefined = voiceFailures.length
    ? diagnoseTtsError(voiceFailures[0].reason, ttsPreflight?.command ?? '')
    : undefined;

  return {
    path: relPath,
    url: `/output/${relPath.split('/').map(encodeURIComponent).join('/')}`,
    file: outputFile,
    name: fileName,
    projectName: meta.name,
    mode,
    modeLabel: MODE_LABEL[mode],
    durationSec: result.durationSec,
    sizeBytes: result.sizeBytes,
    totalFrames: result.totalFrames,
    shotCount: shots.length,
    mouthSyncedShots: frameSequences.filter(Boolean).length,
    animatedShots: defs.filter((d) => d.animated).length,
    animationFrameKeys: defs.reduce((sum, d) => sum + (d.animated?.frameKeyCount ?? 0), 0),
    width, height, fps,
    codec: 'H.264 / AAC',
    hasVoiceOver: result.hasVoiceOver,
    voiceFailures,
    voiceDiagnosis,
    ttsPreflight: ttsPreflight ? {
      ok: ttsPreflight.ok,
      command: ttsPreflight.command,
      requiresNetwork: ttsPreflight.requiresNetwork,
      networkNote: ttsPreflight.networkNote,
    } : undefined,
    voiceOverNote: result.hasVoiceOver
      ? `已混入 ${voiceLinesUsed} 条真实配音，镜头时长按 ffprobe 实测值撑开`
      : voiceFailures.length
        ? `配音合成失败 ${voiceLinesUsed ? `部分（${voiceFailures.length} 句）` : '全部'}：${voiceDiagnosis?.summary ?? '原因见下方明细'}。成片为字幕 + 氛围音，处理建议见下方`
        : '未配音（未配置 TTS 且镜头无 WAV）：成片为字幕 + 本地合成氛围音',
    timelineWarnings: [
      ...warnings,
      ...voiceFailures.map((f) => `镜头 ${f.shotId}「${f.text}」配音失败：${f.reason}`),
      ...[...animationNotes].map((n) => `动画降级：${n}`),
    ],
    browser: env.browser,
    renderedAt: new Date().toISOString(),
  };
};
