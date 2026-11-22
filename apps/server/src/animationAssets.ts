/**
 * 动画资产上传：把界面上传的图片路径写回 config/animation.json。
 *
 * 注册表是渲染链路的唯一真值；animationWiring 按 mtime 缓存，写文件后自动重载，
 * 因此「界面传图 → 写注册表 → 预览/成片立即生效」，不需要重启、不需要改代码。
 *
 * 纯函数（setSlotSrc / clearSlotSrc / describeSlots）不碰磁盘，便于单测；
 * IO 只读写 animation.json 这一个文件，且保留 note / _sceneImageExample 等所有原字段。
 */
import fs from 'node:fs';
import path from 'node:path';
import { P } from '@thai-video/core';
import { invalidateAnimationRegistry } from './animationWiring.js';

export const POSE_KEYS = ['stand', 'sit', 'walk1', 'walk2', 'turn', 'back'] as const;
export const LAYER_KEYS = ['sky', 'far', 'mid', 'near', 'foreground'] as const;
export type PoseKey = (typeof POSE_KEYS)[number];
export type LayerKey = (typeof LAYER_KEYS)[number];

export const POSE_LABELS: Record<PoseKey, string> = {
  stand: '站立', sit: '坐姿', walk1: '迈步 1', walk2: '迈步 2', turn: '侧身', back: '背面',
};
export const LAYER_LABELS: Record<LayerKey, string> = {
  sky: '天空远景', far: '远景', mid: '中景', near: '近景', foreground: '前景遮挡',
};

export type AssetTarget =
  | { kind: 'characterPose'; id: string; key: PoseKey }
  | { kind: 'sceneBackground'; id: string }
  | { kind: 'sceneLayer'; id: string; key: LayerKey };

type PoseRaw = {
  key?: string; src?: string; anchor?: [number, number];
  mouth?: [number, number]; mouthW?: number; skin?: string;
  [k: string]: unknown;
};
type RigRaw = {
  id: string; name?: string; width?: number; height?: number;
  defaultPose?: string; poses: Record<string, PoseRaw>;
  [k: string]: unknown;
};
type LayerRaw = {
  key: string; kind: string; parallax: number;
  src?: string; fit?: string; opacity?: number;
  [k: string]: unknown;
};
type SceneRaw = {
  id: string; palette?: string; backgroundImage?: string;
  layers?: LayerRaw[]; baseline?: number;
  [k: string]: unknown;
};
type RegistryRaw = {
  enabled?: boolean;
  defaults?: { layers?: LayerRaw[]; baseline?: number; [k: string]: unknown };
  characters: Record<string, RigRaw>;
  scenes: Record<string, SceneRaw>;
  [k: string]: unknown;
};

const FALLBACK_LAYERS: LayerRaw[] = [
  { key: 'sky', kind: 'sky', parallax: 0.05 },
  { key: 'far', kind: 'far', parallax: 0.18 },
  { key: 'mid', kind: 'mid', parallax: 0.42 },
  { key: 'near', kind: 'near', parallax: 0.72 },
  { key: 'foreground', kind: 'foreground', parallax: 1 },
];

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const configFile = (): string => P.config('animation.json');

/** 读取原始注册表（保留全部字段，不经过 parseRegistry 以免丢字段）。 */
export const readRaw = (): RegistryRaw =>
  JSON.parse(fs.readFileSync(configFile(), 'utf8')) as RegistryRaw;

/** 原子写回：先写同目录临时文件再改名，避免写一半被渲染链路读到。 */
export const writeRaw = (raw: RegistryRaw): void => {
  const file = configFile();
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
};

export const slotSrc = (raw: RegistryRaw, target: AssetTarget): string => {
  if (target.kind === 'characterPose') {
    return raw.characters?.[target.id]?.poses?.[target.key]?.src ?? '';
  }
  if (target.kind === 'sceneBackground') {
    return raw.scenes?.[target.id]?.backgroundImage ?? '';
  }
  return raw.scenes?.[target.id]?.layers?.find((l) => l.key === target.key)?.src ?? '';
};

/**
 * 把上传得到的相对路径写进目标槽位。
 * 人物/场景未注册时自动登记最小可用项：不套用已有三人的形象或别人的场景配色，
 * 缺失的其它姿态由 director 走显式降级（改用 defaultPose），不会静默冒用。
 */
export const setSlotSrc = (
  raw: RegistryRaw, target: AssetTarget, src: string,
): RegistryRaw => {
  const next = clone(raw);
  next.characters ??= {};
  next.scenes ??= {};

  if (target.kind === 'characterPose') {
    const rig: RigRaw = next.characters[target.id] ?? {
      id: target.id, name: target.id, width: 1024, height: 1536,
      defaultPose: 'stand', poses: {},
    };
    const previous = rig.poses[target.key];
    rig.poses[target.key] = {
      ...(previous ?? {}),
      key: target.key,
      src,
      anchor: previous?.anchor ?? [0.5, 0.94],
    };
    // defaultPose 必须指向一个真实存在的姿态，否则人物整帧不渲染。
    if (!rig.defaultPose || !rig.poses[rig.defaultPose]) rig.defaultPose = target.key;
    next.characters[target.id] = rig;
    return next;
  }

  const scene: SceneRaw = next.scenes[target.id] ?? { id: target.id, palette: target.id };
  if (target.kind === 'sceneBackground') {
    scene.backgroundImage = src;
  } else {
    const layers = scene.layers?.length
      ? scene.layers.map((l) => ({ ...l }))
      : (next.defaults?.layers?.length ? clone(next.defaults.layers) : clone(FALLBACK_LAYERS));
    const layer = layers.find((l) => l.key === target.key);
    if (layer) layer.src = src;
    else layers.push({ key: target.key, kind: target.key, parallax: 0.42, src });
    scene.layers = layers;
  }
  // 整张底图与分层真图是互斥的两种主背景：挂分层时清掉底图，避免同时生效互相盖住。
  if (target.kind === 'sceneLayer') delete scene.backgroundImage;
  next.scenes[target.id] = scene;
  return next;
};

/** 清除槽位：回到程序化生成。人物已无任何姿态时删掉整个注册项。 */
export const clearSlotSrc = (raw: RegistryRaw, target: AssetTarget): RegistryRaw => {
  const next = clone(raw);
  if (target.kind === 'characterPose') {
    const rig = next.characters?.[target.id];
    if (rig?.poses?.[target.key]) {
      delete rig.poses[target.key].src;
      delete rig.poses[target.key];
      if (!Object.keys(rig.poses).length) delete next.characters[target.id];
      else if (!rig.defaultPose || !rig.poses[rig.defaultPose]) {
        rig.defaultPose = Object.keys(rig.poses)[0];
      }
    }
    return next;
  }
  const scene = next.scenes?.[target.id];
  if (!scene) return next;
  if (target.kind === 'sceneBackground') {
    delete scene.backgroundImage;
  } else {
    const layer = scene.layers?.find((l) => l.key === target.key);
    if (layer) delete layer.src;
  }
  const hasImage = Boolean(scene.backgroundImage)
    || Boolean(scene.layers?.some((l) => l.src));
  if (!hasImage) {
    delete scene.layers;
    delete next.scenes[target.id];
  }
  return next;
};

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

/** 供界面展示的槽位状态；exists 由调用方注入（服务端读盘 / 测试恒真）。 */
export const describeSlots = (
  raw: RegistryRaw, exists: (src: string) => boolean,
): AssetsPayload => {
  const state = (src: string): SlotState => ({
    src, ready: Boolean(src) && exists(src),
  });
  const characters: AssetsPayload['characters'] = {};
  for (const [id, rig] of Object.entries(raw.characters ?? {})) {
    const poses: Record<string, SlotState> = {};
    for (const key of POSE_KEYS) poses[key] = state(rig.poses?.[key]?.src ?? '');
    characters[id] = { name: rig.name ?? id, poses };
  }
  const scenes: AssetsPayload['scenes'] = {};
  for (const [id, scene] of Object.entries(raw.scenes ?? {})) {
    const layers: Record<string, SlotState> = {};
    for (const key of LAYER_KEYS) {
      layers[key] = state(scene.layers?.find((l) => l.key === key)?.src ?? '');
    }
    scenes[id] = { backgroundImage: state(scene.backgroundImage ?? ''), layers };
  }
  return {
    poseKeys: POSE_KEYS.map((key) => ({ key, label: POSE_LABELS[key] })),
    layerKeys: LAYER_KEYS.map((key) => ({ key, label: LAYER_LABELS[key] })),
    characters, scenes,
  };
};

const fileExists = (src: string): boolean =>
  Boolean(src) && fs.existsSync(path.resolve(P.root, src));

/** GET：当前槽位状态（含文件是否真实存在）。 */
export const loadSlots = (): AssetsPayload => describeSlots(readRaw(), fileExists);

/** POST：上传落盘后的路径写回注册表，返回最新状态。 */
export const applyUpload = (target: AssetTarget, assetPath: string): AssetsPayload => {
  writeRaw(setSlotSrc(readRaw(), target, assetPath));
  invalidateAnimationRegistry();
  return loadSlots();
};

/** POST /clear：清除槽位，返回最新状态。 */
export const clearSlot = (target: AssetTarget): AssetsPayload => {
  writeRaw(clearSlotSrc(readRaw(), target));
  invalidateAnimationRegistry();
  return loadSlots();
};
