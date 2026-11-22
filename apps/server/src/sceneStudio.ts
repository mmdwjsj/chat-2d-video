/**
 * 场景工程（Scene Studio）：把「场景长什么样」从代码里的色块字典，变成用户可编辑的数据。
 *
 * 双轨存储：
 *  1) 元素数据 → 写回 config/animation.json 的 scenes[<id>].studio，供编辑器下次打开继续改；
 *  2) 导出产物 → 每层一个 SVG + 整张底图，写到 assets/scenes/<id>/，
 *     同时把 layers[].src 指向这些 SVG，渲染链路（animatedFrame）读到就立即生效。
 *
 * 只写 layers[].src，不写 backgroundImage：整张底图会让分层视差失效，分层才是这里要的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { P } from '@thai-video/core';
import { invalidateAnimationRegistry } from './animationWiring.js';
import { readRaw, writeRaw } from './animationAssets.js';

export const STUDIO_LAYER_KINDS = ['sky', 'far', 'mid', 'near', 'foreground'] as const;
export type StudioLayerKind = (typeof STUDIO_LAYER_KINDS)[number];

export type StudioElement = {
  id: string;
  type: 'rect' | 'ellipse';
  x: number; y: number; w: number; h: number;
  fill: string;
  opacity?: number;
  /** 仅 rect：圆角半径 */
  rx?: number;
};

export type StudioLayer = {
  key: string;
  kind: StudioLayerKind;
  parallax: number;
  elements: StudioElement[];
};

export type Studio = {
  canvas: { w: number; h: number };
  layers: StudioLayer[];
  anchors: Record<string, [number, number]>;
  baseline: number;
};

const SCENE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HEX = /^#[0-9a-fA-F]{3,8}$/;
const num = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** 默认工程：干净的三段式房间（天空/墙/地板 + 一扇窗 + 一个门框），用户在此基础上改。 */
export const defaultStudio = (): Studio => ({
  canvas: { w: 540, h: 960 },
  baseline: 1560,
  anchors: { left: [0.24, 0.82], center: [0.5, 0.82], right: [0.76, 0.82], kitchen: [0.86, 0.82] },
  layers: [
    {
      key: 'sky', kind: 'sky', parallax: 0.05,
      elements: [
        { id: 'wall', type: 'rect', x: 0, y: 0, w: 540, h: 780, fill: '#fbf0dd' },
        { id: 'wall-top', type: 'rect', x: 0, y: 0, w: 540, h: 140, fill: '#f6e4c4' },
      ],
    },
    {
      key: 'far', kind: 'far', parallax: 0.18,
      elements: [
        { id: 'win', type: 'rect', x: 54, y: 180, w: 128, h: 208, fill: '#bfd8ea' },
        { id: 'win-bar-v', type: 'rect', x: 115, y: 180, w: 6, h: 208, fill: '#f3e8d6' },
        { id: 'win-bar-h', type: 'rect', x: 54, y: 281, w: 128, h: 6, fill: '#f3e8d6' },
      ],
    },
    {
      key: 'mid', kind: 'mid', parallax: 0.42,
      elements: [
        { id: 'floor', type: 'rect', x: 0, y: 780, w: 540, h: 180, fill: '#d6bd9c' },
        { id: 'skirting', type: 'rect', x: 0, y: 776, w: 540, h: 8, fill: '#bfa27e' },
        { id: 'door', type: 'rect', x: 428, y: 420, w: 88, h: 360, fill: '#8d6248', rx: 5 },
        { id: 'door-in', type: 'rect', x: 440, y: 436, w: 64, h: 344, fill: '#5c3f2e' },
      ],
    },
    { key: 'near', kind: 'near', parallax: 0.72, elements: [] },
    {
      key: 'foreground', kind: 'foreground', parallax: 1,
      elements: [
        { id: 'plant-pot', type: 'rect', x: 16, y: 738, w: 50, h: 44, fill: '#9a6a4e' },
        { id: 'plant-a', type: 'ellipse', x: 10, y: 682, w: 62, h: 62, fill: '#43764e' },
      ],
    },
  ],
});

const sanitizeElement = (raw: unknown, i: number): StudioElement | null => {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const type = e.type === 'ellipse' ? 'ellipse' : 'rect';
  const fill = typeof e.fill === 'string' && (HEX.test(e.fill) || e.fill === 'transparent') ? e.fill : '#cccccc';
  return {
    id: typeof e.id === 'string' && e.id ? e.id.slice(0, 40) : `el-${i}`,
    type,
    x: num(e.x, -2000, 4000, 0),
    y: num(e.y, -2000, 4000, 0),
    w: num(e.w, 0, 4000, 10),
    h: num(e.h, 0, 4000, 10),
    fill,
    ...(typeof e.opacity === 'number' ? { opacity: num(e.opacity, 0, 1, 1) } : {}),
    ...(type === 'rect' ? { rx: num(e.rx, 0, 200, 0) } : {}),
  };
};

export const sanitizeStudio = (raw: unknown): Studio => {
  const base = defaultStudio();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const canvasRaw = (r.canvas ?? {}) as Record<string, unknown>;
  const canvas = {
    w: num(canvasRaw.w, 200, 2000, base.canvas.w),
    h: num(canvasRaw.h, 200, 3000, base.canvas.h),
  };
  const incoming = Array.isArray(r.layers) ? r.layers : [];
  const layers: StudioLayer[] = STUDIO_LAYER_KINDS.map((kind, idx) => {
    const found = incoming.find((l) => l && typeof l === 'object' && (l as Record<string, unknown>).kind === kind) as Record<string, unknown> | undefined;
    const fallback = base.layers[idx];
    const elementsRaw = Array.isArray(found?.elements) ? (found!.elements as unknown[]) : fallback.elements;
    return {
      key: typeof found?.key === 'string' && found.key ? found.key.slice(0, 40) : fallback.key,
      kind,
      parallax: num(found?.parallax, 0, 1, fallback.parallax),
      elements: elementsRaw.map((e, i) => sanitizeElement(e, i)).filter((e): e is StudioElement => Boolean(e)),
    };
  });
  const anchors: Record<string, [number, number]> = { ...base.anchors };
  if (r.anchors && typeof r.anchors === 'object') {
    for (const [k, v] of Object.entries(r.anchors as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_-]{1,24}$/.test(k)) continue;
      if (Array.isArray(v) && v.length === 2) anchors[k] = [num(v[0], 0, 1, 0.5), num(v[1], 0, 1, 0.82)];
    }
  }
  return { canvas, layers, anchors, baseline: num(r.baseline, 0, 5000, base.baseline) };
};

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const elementSvg = (e: StudioElement): string => {
  const op = e.opacity != null && e.opacity < 1 ? ` opacity="${e.opacity}"` : '';
  if (e.type === 'ellipse') {
    return `<ellipse cx="${e.x + e.w / 2}" cy="${e.y + e.h / 2}" rx="${e.w / 2}" ry="${e.h / 2}" fill="${esc(e.fill)}"${op}/>`;
  }
  const rx = e.rx ? ` rx="${e.rx}"` : '';
  return `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" fill="${esc(e.fill)}"${rx}${op}/>`;
};

const layerSvg = (layer: StudioLayer, canvas: Studio['canvas']): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas.w} ${canvas.h}" width="${canvas.w}" height="${canvas.h}" preserveAspectRatio="none">${layer.elements.map(elementSvg).join('')}</svg>`;

const studioDir = (sceneId: string): string => path.join(P.root, 'assets', 'scenes', sceneId);

/** 读当前工程：注册表里有 studio 就用它，否则给默认模板（不落盘，保存时才写）。 */
export const loadStudio = (sceneId: string): { studio: Studio; saved: boolean; files: string[] } => {
  if (!SCENE_ID.test(sceneId)) throw new Error('场景 id 不合法');
  const raw = readRaw() as Record<string, unknown>;
  const scenes = (raw.scenes ?? {}) as Record<string, Record<string, unknown>>;
  const entry = scenes[sceneId];
  const studio = entry?.studio ? sanitizeStudio(entry.studio) : defaultStudio();
  const dir = studioDir(sceneId);
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.svg')).map((f) => `assets/scenes/${sceneId}/${f}`)
    : [];
  return { studio, saved: Boolean(entry?.studio), files };
};

export type SaveResult = {
  studio: Studio;
  files: { layer: string; src: string; bytes: number }[];
  configPath: string;
  preview: string;
};

/** 保存工程：导出每层 SVG 到 assets/scenes/<id>/，并更新注册表 layers[].src。 */
export const saveStudio = (sceneId: string, input: unknown): SaveResult => {
  if (!SCENE_ID.test(sceneId)) throw new Error('场景 id 不合法');
  const studio = sanitizeStudio(input);
  const dir = studioDir(sceneId);
  fs.mkdirSync(dir, { recursive: true });

  const files: SaveResult['files'] = [];
  for (const layer of studio.layers) {
    const file = `${layer.key}.svg`;
    const abs = path.join(dir, file);
    const svg = layerSvg(layer, studio.canvas);
    fs.writeFileSync(abs, svg, 'utf8');
    files.push({ layer: layer.key, src: `assets/scenes/${sceneId}/${file}`, bytes: Buffer.byteLength(svg) });
  }
  // 合成预览（所有层按顺序叠加，含前景）：只用于界面缩略图，不参与成片渲染。
  const previewSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${studio.canvas.w} ${studio.canvas.h}" width="${studio.canvas.w}" height="${studio.canvas.h}" preserveAspectRatio="none">${studio.layers.map((l) => l.elements.map(elementSvg).join('')).join('')}</svg>`;
  fs.writeFileSync(path.join(dir, 'preview.svg'), previewSvg, 'utf8');

  const raw = readRaw() as Record<string, unknown>;
  const scenes = (raw.scenes ?? {}) as Record<string, Record<string, unknown>>;
  const prev = scenes[sceneId] ?? { id: sceneId, palette: sceneId };
  scenes[sceneId] = {
    ...prev,
    id: sceneId,
    baseline: studio.baseline,
    studio,
    anchors: studio.anchors,
    layers: studio.layers.map((l) => ({
      key: l.key,
      kind: l.kind,
      parallax: l.parallax,
      src: `assets/scenes/${sceneId}/${l.key}.svg`,
    })),
  };
  raw.scenes = scenes;
  writeRaw(raw as Parameters<typeof writeRaw>[0]);
  invalidateAnimationRegistry();

  return { studio, files, configPath: 'config/animation.json', preview: `assets/scenes/${sceneId}/preview.svg` };
};
