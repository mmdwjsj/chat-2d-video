import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectMissingAssets, parseRegistry, resolveActionClip,
  resolveCharacterRig, resolveSceneSpec,
} from './registry.js';
import { directShot } from './director.js';
import type {
  ActionClip, ActionCue, AnimationRegistry, CharacterRig, MouthShape, SceneSpec,
} from './contracts.js';

const makeRig = (): CharacterRig => ({
  id: 'char-a',
  name: '妮娜',
  width: 1024,
  height: 1536,
  defaultPose: 'stand',
  poses: {
    stand: { key: 'stand', src: 'assets/a/stand.png', anchor: [0.5, 0.94], mouth: [0.5, 0.25], mouthW: 0.06 },
    sit: { key: 'sit', src: 'assets/a/sit.png', anchor: [0.5, 0.98] },
    walk1: { key: 'walk1', src: 'assets/a/walk1.png', anchor: [0.5, 0.94] },
    walk2: { key: 'walk2', src: 'assets/a/walk2.png', anchor: [0.5, 0.94] },
  },
});

const RAW = {
  schemaVersion: 1,
  enabled: true,
  defaults: {
    layers: [
      { key: 'sky', kind: 'sky', parallax: 0.05 },
      { key: 'far', kind: 'far', parallax: 0.18 },
      { key: 'mid', kind: 'mid', parallax: 0.42 },
      { key: 'foreground', kind: 'foreground', parallax: 1 },
    ],
    baseline: 1560,
    anchors: { center: [0.5, 0.8], sofa: [0.28, 0.8], kitchen: [0.82, 0.8] },
  },
  characters: { 'char-a': makeRig() },
  scenes: { 'scene-apartment': { id: 'scene-apartment', palette: 'scene-apartment' } },
  actions: {
    idle: { id: 'idle', poses: ['stand'], phases: 1 },
    'stand-up': { id: 'stand-up', poses: ['sit', 'stand', 'stand'], phases: 3, move: [0, -0.06] },
    'walk-to-kitchen': {
      id: 'walk-to-kitchen', poses: ['stand', 'walk1', 'walk2'], phases: 4,
      from: 'sofa', to: 'kitchen', move: [0.4, 0], bob: 12, rotate: 3,
    },
  },
};

const load = (): AnimationRegistry => {
  const { value } = parseRegistry(RAW);
  assert.ok(value, '注册表应能解析');
  return value;
};

const SCENE: SceneSpec = {
  id: 'scene-apartment',
  palette: 'scene-apartment',
  layers: [
    { key: 'sky', kind: 'sky', parallax: 0.05 },
    { key: 'foreground', kind: 'foreground', parallax: 1 },
  ],
  anchors: { sofa: [0.28, 0.8], kitchen: [0.82, 0.8] },
  baseline: 1560,
};

const CUES: ActionCue[] = [
  { actorId: 'char-a', verb: '站起', clipId: 'stand-up', startSec: 0, durationSec: 1 },
  { actorId: 'char-a', verb: '走到厨房', clipId: 'walk-to-kitchen', from: 'sofa', to: 'kitchen', startSec: 1, durationSec: 1 },
];

const CLIPS: Record<string, ActionClip> = {
  idle: { id: 'idle', poses: ['stand'], phases: 1, move: [0, 0] },
  'stand-up': { id: 'stand-up', poses: ['sit', 'stand', 'stand'], phases: 3, move: [0, -0.06] },
  'walk-to-kitchen': {
    id: 'walk-to-kitchen', poses: ['stand', 'walk1', 'walk2'], phases: 4,
    from: 'sofa', to: 'kitchen', move: [0.4, 0], bob: 12, rotate: 3,
  },
};

const MOUTHS: MouthShape[] = Array.from(
  { length: 60 }, (_, i) => (['closed', 'small', 'open', 'wide'] as MouthShape[])[i % 4],
);

test('换第 4 个人：未注册返回 null 并留痕，绝不冒用已有三人的形象', () => {
  const reg = load();
  const known = resolveCharacterRig(reg, 'char-a');
  assert.equal(known.value?.id, 'char-a');
  assert.deepEqual(known.degradations, []);

  const unknown = resolveCharacterRig(reg, 'char-x');
  assert.equal(unknown.value, null);
  assert.ok(unknown.degradations.some((n) => n.includes('char-x')));
});

test('换场景：未注册留痕，palette 用自身 id，不再静默兜底成街边餐馆', () => {
  const reg = load();
  const resolved = resolveSceneSpec(reg, 'scene-new-terrace');
  assert.ok(resolved.degradations.length > 0);
  assert.equal(resolved.value.palette, 'scene-new-terrace');
  assert.equal(resolveSceneSpec(reg, 'scene-apartment').degradations.length, 0);
});

test('未注册动作回退 idle 且留痕；缺姿态图全部记录', () => {
  const reg = load();
  const clip = resolveActionClip(reg, 'not-exist');
  assert.equal(clip.value.id, 'idle');
  assert.ok(clip.degradations.length > 0);

  const missing = collectMissingAssets(makeRig(), () => false);
  assert.equal(missing.length, Object.keys(makeRig().poses).length);
  assert.equal(collectMissingAssets(makeRig(), () => true).length, 0);
});

test('enabled=false 时注册表标记关闭，调用方据此回退', () => {
  const { value } = parseRegistry({ ...RAW, enabled: false });
  assert.equal(value?.enabled, false);
  const broken = parseRegistry(null);
  assert.equal(broken.value, null);
  assert.ok(broken.degradations.length > 0);
});

test('directShot：时间轴与帧数一致，首尾帧姿态/位移不同', () => {
  const result = directShot({
    fps: 30, frames: 60, actorIds: ['char-a'], speakingId: 'char-a',
    rigs: { 'char-a': makeRig() }, scene: SCENE, clips: CLIPS, cues: CUES, mouths: MOUTHS,
  });
  assert.equal(result.timeline.length, 60);
  assert.notEqual(result.timeline[0], result.timeline[59]);

  const first = result.frames.find((f) => f.frameKey === result.timeline[0]);
  const last = result.frames.find((f) => f.frameKey === result.timeline[59]);
  assert.ok(first && last);
  assert.notEqual(first.actors[0].pose, last.actors[0].pose);
  assert.notEqual(first.sceneOffset, last.sceneOffset);
  assert.ok(Math.abs(last.actors[0].x) > 0, '走过厨房后人物位置应发生位移');
});

test('directShot：帧档数量有上界，不会退化成每帧一张截图', () => {
  const result = directShot({
    fps: 30, frames: 300, actorIds: ['char-a'], speakingId: 'char-a',
    rigs: { 'char-a': makeRig() }, scene: SCENE, clips: CLIPS, cues: CUES, mouths: MOUTHS.concat(MOUTHS),
  });
  assert.ok(result.frameKeyCount <= 32, `帧档 ${result.frameKeyCount} 应远小于帧数 300`);
  assert.ok(result.frames.length === result.frameKeyCount);
});

test('directShot：缺 rig 的 actor 记录降级但不崩，多人镜头可正常求值', () => {
  const result = directShot({
    fps: 30, frames: 30, actorIds: ['char-a', 'char-x'], speakingId: 'char-a',
    rigs: { 'char-a': makeRig(), 'char-x': null },
    scene: SCENE, clips: CLIPS, cues: CUES, mouths: MOUTHS.slice(0, 30),
  });
  assert.equal(result.timeline.length, 30);
  assert.ok(result.degradations.some((n) => n.includes('char-x')));
  assert.equal(result.frames[0].actors.length, 2);
});
