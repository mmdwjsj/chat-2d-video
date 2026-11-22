import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { assetUrl } from './characterLibrary';

export type PoseKey = 'stand' | 'sit' | 'walk1' | 'walk2' | 'turn' | 'back';
export type LayerKey = 'sky' | 'far' | 'mid' | 'near' | 'foreground';

export type AssetTarget =
  | { kind: 'characterPose'; id: string; key: PoseKey }
  | { kind: 'sceneBackground'; id: string }
  | { kind: 'sceneLayer'; id: string; key: LayerKey };

export type SlotState = { src: string; ready: boolean };
export type AssetsPayload = {
  poseKeys: { key: PoseKey; label: string }[];
  layerKeys: { key: LayerKey; label: string }[];
  characters: Record<string, { name: string; poses: Record<string, SlotState> }>;
  scenes: Record<string, {
    backgroundImage: SlotState;
    layers: Record<string, SlotState>;
  }>;
};

/** 首屏 GET 返回前也先把格子画出来，避免闪一下空白。 */
export const POSE_SLOTS: { key: PoseKey; label: string }[] = [
  { key: 'stand', label: '站立' }, { key: 'sit', label: '坐姿' },
  { key: 'walk1', label: '迈步 1' }, { key: 'walk2', label: '迈步 2' },
  { key: 'turn', label: '侧身' }, { key: 'back', label: '背面' },
];
export const LAYER_SLOTS: { key: LayerKey; label: string }[] = [
  { key: 'sky', label: '天空远景' }, { key: 'far', label: '远景' },
  { key: 'mid', label: '中景' }, { key: 'near', label: '近景' },
  { key: 'foreground', label: '前景遮挡' },
];

const EMPTY: AssetsPayload = {
  poseKeys: POSE_SLOTS, layerKeys: LAYER_SLOTS, characters: {}, scenes: {},
};

const toBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(new Error('读取图片失败'));
  reader.readAsDataURL(file);
});

/**
 * 动画资产槽位：GET 拉注册表状态，上传/清除后服务端返回全量最新状态。
 * 两个页面各调一次即可，人物/场景格子共享同一份数据。
 */
export const useAnimationAssets = () => {
  const [assets, setAssets] = useState<AssetsPayload>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const result = await api.get<{ assets: AssetsPayload }>('/api/animation-assets');
      setAssets(result.assets);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const upload = useCallback(async (target: AssetTarget, file: File) => {
    setBusy(true);
    setError(null);
    try {
      const base64 = await toBase64(file);
      const result = await api.post<{ assets: AssetsPayload }>('/api/animation-assets', {
        base64, mimeType: file.type || 'image/png', fileName: file.name, target,
      });
      setAssets(result.assets);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = useCallback(async (target: AssetTarget) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ assets: AssetsPayload }>('/api/animation-assets/clear', { target });
      setAssets(result.assets);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return { assets, busy, error, upload, clear, reload };
};

export const slotImage = (slot: SlotState | undefined): string =>
  slot?.src ? assetUrl(slot.src) : '';

export const slotMissing = (slot: SlotState | undefined): boolean =>
  Boolean(slot?.src) && !slot?.ready;
