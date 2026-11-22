import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnimatedFrame } from './animatedFrame.js';
import {
  collectMissingSceneAssets, parseRegistry, resolveSceneSpec,
} from '@thai-video/animation';
import type { FrameState, SceneSpec } from '@thai-video/animation';

const BASE_LAYERS = [
  { key: 'sky', kind: 'sky' as const, parallax: 0.05 },
  { key: 'mid', kind: 'mid' as const, parallax: 0.42 },
  { key: 'fg', kind: 'foreground' as const, parallax: 1 },
];

const SPEC: SceneSpec = {
  id: 'scene-apartment',
  palette: 'scene-apartment',
  layers: BASE_LAYERS,
  anchors: {},
  baseline: 1560,
};

const FRAME: FrameState = {
  frameKey: 'stand:0|closed', sceneOffset: 0.4, actors: [], mouth: 'closed',
};

const frameInput = (sceneSpec: SceneSpec, frame: FrameState = FRAME) => ({
  projectTitle: '测试项目',
  mode: 'zh' as const,
  index: 1, total: 1, durationSec: 4,
  scene: null,
  sceneSpec,
  frame,
  rigs: {},
  characters: [],
  speakingId: '',
  primarySubtitle: '你好',
  secondarySubtitle: '',
  resolveImage: (src: string) => `/ASSET/${src}`,
});

test('未配真图时仍是程序化 SVG 分层，零回归', () => {
  const html = buildAnimatedFrame(frameInput(SPEC));
  assert.ok(html.includes('<svg class="layer"'), '应有程序化分层 SVG');
  assert.ok(!html.includes('<img class="bg"'), '不应出现整张底图');
  assert.ok(!html.includes('<img class="layer-img"'), '不应出现真图层 img');
});

test('parseScene 不再忽略自定义 layers：逐层 src / fit / opacity 都保留', () => {
  const raw = {
    schemaVersion: 1, enabled: true,
    defaults: { layers: BASE_LAYERS, baseline: 1560, anchors: {} },
    characters: {},
    scenes: {
      'scene-apartment': {
        id: 'scene-apartment',
        palette: 'scene-apartment',
        backgroundImage: 'assets/scenes/a/bg.png',
        layers: [
          { key: 'sky', kind: 'sky', parallax: 0.05, src: 'assets/scenes/a/sky.png', fit: 'contain' },
          { key: 'fg', kind: 'foreground', parallax: 1, src: 'assets/scenes/a/fg.png', opacity: 0.8 },
        ],
      },
    },
    actions: { idle: { id: 'idle', poses: ['stand'], phases: 1 } },
  };
  const { value } = parseRegistry(raw);
  assert.ok(value);
  const spec = resolveSceneSpec(value, 'scene-apartment').value;
  assert.equal(spec.backgroundImage, 'assets/scenes/a/bg.png');
  assert.equal(spec.layers.length, 2, '应使用场景自己的 2 层，而不是 defaults 的 3 层');
  assert.equal(spec.layers[0].src, 'assets/scenes/a/sky.png');
  assert.equal(spec.layers[0].fit, 'contain');
  assert.equal(spec.layers[1].opacity, 0.8);
});

test('场景真图缺失必须留痕（整张底图 + 分层图都查），存在时不报', () => {
  const spec: SceneSpec = {
    ...SPEC,
    backgroundImage: 'assets/scenes/x/bg.png',
    layers: [
      { key: 'sky', kind: 'sky', parallax: 0.05, src: 'assets/scenes/x/sky.png' },
      { key: 'near', kind: 'near', parallax: 0.72 },
    ],
  };
  const missing = collectMissingSceneAssets(spec, () => false);
  assert.equal(missing.length, 2);
  assert.ok(missing.every((n) => n.includes('图片缺失')));
  assert.equal(collectMissingSceneAssets(spec, () => true).length, 0);
  assert.equal(collectMissingSceneAssets(SPEC, () => false).length, 0, '程序化场景没有图片可缺');
});

test('整张底图 + 分层真图都渲染成 img，程序化色块层让位', () => {
  const spec: SceneSpec = {
    ...SPEC,
    backgroundImage: 'assets/scenes/a/bg.png',
    layers: [
      { key: 'sky', kind: 'sky', parallax: 0.05, src: 'assets/scenes/a/sky.png' },
      { key: 'mid', kind: 'mid', parallax: 0.42, src: 'assets/scenes/a/mid.png' },
      { key: 'fg', kind: 'foreground', parallax: 1, src: 'assets/scenes/a/fg.png' },
    ],
  };
  const html = buildAnimatedFrame(frameInput(spec));
  assert.ok(html.includes('<img class="bg" src="/ASSET/assets/scenes/a/bg.png"'), '整张底图应生效');
  assert.equal((html.match(/class="layer-img"/g) ?? []).length, 3, '三层真图都应输出');
  assert.ok(!html.includes('<svg class="layer"'), '有真底图时程序化色块层应让位');
  assert.ok(html.includes('class="layer fg"'), '前景层仍是 fg 层级（遮挡）');
});

test('真图层仍按各自 parallax 做视差位移，首尾帧画面不同', () => {
  const spec: SceneSpec = {
    ...SPEC,
    layers: [
      { key: 'sky', kind: 'sky', parallax: 0.05, src: 'assets/scenes/a/sky.png' },
      { key: 'mid', kind: 'mid', parallax: 0.42, src: 'assets/scenes/a/mid.png' },
      { key: 'fg', kind: 'foreground', parallax: 1, src: 'assets/scenes/a/fg.png' },
    ],
  };
  const html = buildAnimatedFrame(frameInput(spec));
  assert.ok(html.includes('translate3d(5.2px,0,0)'), 'sky 位移 = 0.4×0.05×260');
  assert.ok(html.includes('translate3d(43.7px,0,0)'), 'mid 位移 = 0.4×0.42×260');
  assert.ok(html.includes('translate3d(104.0px,0,0)'), '前景位移 = 0.4×1×260');

  const first = buildAnimatedFrame(frameInput(spec, { ...FRAME, sceneOffset: 0 }));
  const last = buildAnimatedFrame(frameInput(spec, { ...FRAME, sceneOffset: 1 }));
  assert.notEqual(first, last, '场景位移变化应产生不同画面');
});

test('fit / opacity 透传到真图层', () => {
  const spec: SceneSpec = {
    ...SPEC,
    layers: [
      { key: 'sky', kind: 'sky', parallax: 0.05, src: 'a.png', fit: 'contain' as const, opacity: 0.6 },
    ],
  };
  const html = buildAnimatedFrame(frameInput(spec));
  assert.ok(html.includes('object-fit:contain'));
  assert.ok(html.includes('opacity:0.6'));
});
