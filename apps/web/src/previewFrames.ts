/**
 * 预览画面数据层：向服务端要「成片同款」的四档口型 HTML + 逐帧时间轴。
 *
 * 画面本身全部由服务端 buildFrame 生成，前端这里只有缓存、签名和播放状态，
 * 不再画背景、人物图或字幕——预览页和分镜页共用同一份数据，不会各自漂移。
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import type { MouthShape } from '@thai-video/video-renderer/mouthCore';
import type { ProjectBundle } from '@thai-video/core/types';

export type PreviewShotFrames = {
  shotId: string;
  durationSec: number;
  fps: number;
  timeline: MouthShape[] | null;
  frames: Partial<Record<MouthShape, string>>;
  /** 服务端给出的配音地址（导出留存 / 镜头已挂 WAV）；null = 无配音 */
  audioUrl: string | null;
  lipSource: 'voice' | 'text' | 'none';
  /** 动画帧档（与成片同源）；有值时播放器按 frameKeys 切帧 */
  frameKeys?: string[];
  framesByKey?: Record<string, string>;
  /** 显式降级说明 */
  degradations?: string[];
};

export type PreviewFramesPayload = {
  mode: string;
  fps: number;
  shots: PreviewShotFrames[];
};

/** 内容一变就让画面失效：台词、人物、场景、时长、导出版本都进签名。 */
export const previewSignature = (bundle: ProjectBundle, mode: string): string => JSON.stringify({
  mode,
  name: bundle.meta.name,
  shots: bundle.shots.map((s) => [
    s.id, s.version, s.order, s.durationSec, s.sceneId, s.characterIds.join(','),
    s.dialogueZh, s.dialogueTh, s.narrationZh, s.narrationTh,
    s.subtitleZh, s.subtitleTh, s.expression, s.action,
    s.shotSize, s.cameraAngle, s.cameraMove, s.audioZhPath, s.audioThPath,
  ]),
  characters: bundle.characters.map((c) => [
    c.id, c.name, c.nameTh, c.referenceImages?.fullBody, c.referenceImages?.front,
  ]),
  scenes: bundle.scenes.map((s) => [
    s.id, s.name, s.type, s.location, (s.keywords ?? []).join(','),
  ]),
});

const cache = new Map<string, Promise<PreviewFramesPayload>>();

const load = (projectId: string, mode: string, signature: string): Promise<PreviewFramesPayload> => {
  const key = `${projectId}|${mode}|${signature}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = api.get<PreviewFramesPayload>(
    `/api/projects/${encodeURIComponent(projectId)}/preview-frames?mode=${encodeURIComponent(mode)}`,
  );
  cache.set(key, pending);
  // 只留最近几份：编辑剧本时每敲一次字都会产生新签名，别无限堆积。
  if (cache.size > 4) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  pending.catch(() => cache.delete(key));
  return pending;
};

export type PreviewFramesState = {
  payload: PreviewFramesPayload | null;
  loading: boolean;
  error: string | null;
  /** 画面与当前内容同步，强制绕过缓存重新取一次 */
  refresh: () => void;
};

export const usePreviewFrames = (bundle: ProjectBundle | null, mode: string): PreviewFramesState => {
  const signature = bundle ? previewSignature(bundle, mode) : '';
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{ payload: PreviewFramesPayload | null; loading: boolean; error: string | null }>({
    payload: null, loading: Boolean(bundle), error: null,
  });
  const projectId = bundle?.meta.id ?? '';

  useEffect(() => {
    if (!projectId) { setState({ payload: null, loading: false, error: null }); return; }
    let alive = true;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    load(projectId, mode, `${signature}#${nonce}`).then((payload) => {
      if (alive) setState({ payload, loading: false, error: null });
    }).catch((error: unknown) => {
      if (alive) setState({ payload: null, loading: false, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { alive = false; };
  }, [projectId, mode, signature, nonce]);

  return {
    ...state,
    refresh: () => setNonce((n) => n + 1),
  };
};

/** 按镜头 id 取画面对应项；没有就用第一项，避免页面空白。 */
export const frameOf = (payload: PreviewFramesPayload | null, shotId?: string): PreviewShotFrames | null =>
  payload?.shots.find((s) => s.shotId === shotId) ?? payload?.shots[0] ?? null;
