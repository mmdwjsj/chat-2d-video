import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearSlotSrc, describeSlots, setSlotSrc, slotSrc,
  POSE_KEYS, LAYER_KEYS,
} from './animationAssets.js';
import type { AssetTarget } from './animationAssets.js';
import {
  animationAssetTargetSchema, clearAnimationAssetSchema, uploadAnimationAssetSchema,
} from './validation.js';

type PoseT = {
  key?: string; src?: string; anchor?: [number, number];
  mouth?: [number, number]; mouthW?: number; skin?: string;
};
type RigT = {
  id: string; name?: string; width?: number; height?: number;
  defaultPose?: string; poses: Record<string, PoseT>;
};
type LayerT = { key: string; kind: string; parallax: number; src?: string };
type SceneT = {
  id: string; palette?: string; backgroundImage?: string;
  layers?: LayerT[]; baseline?: number;
};
type RawT = {
  schemaVersion: number; enabled: boolean; note: string;
  _sceneImageExample: { 说明: string };
  defaults: { layers: LayerT[]; baseline: number; anchors: Record<string, [number, number]> };
  characters: Record<string, RigT>;
  scenes: Record<string, SceneT>;
  actions: Record<string, { id: string; poses: string[]; phases: number }>;
};

const raw = (): RawT => ({
  schemaVersion: 1,
  enabled: true,
  note: '原始说明，写回时必须保留',
  _sceneImageExample: { 说明: '模板，不能丢' },
  defaults: {
    layers: [
      { key: 'sky', kind: 'sky', parallax: 0.05 },
      { key: 'foreground', kind: 'foreground', parallax: 1 },
    ],
    baseline: 1560,
    anchors: { sofa: [0.28, 0.8] },
  },
  characters: {
    'char-a': {
      id: 'char-a', name: '妮娜', width: 1024, height: 1536, defaultPose: 'stand',
      poses: {
        stand: { key: 'stand', src: 'assets/a/stand.png', anchor: [0.5, 0.94], mouth: [0.49, 0.25] },
      },
    },
  },
  scenes: {
    'scene-apartment': { id: 'scene-apartment', palette: 'scene-apartment', baseline: 1560 },
  },
  actions: { idle: { id: 'idle', poses: ['stand'], phases: 1 } },
});

const asRaw = (value: unknown): RawT => value as RawT;

test('上传人物姿态图：只改目标 src，保留标定与其它字段', () => {
  const target: AssetTarget = { kind: 'characterPose', id: 'char-a', key: 'walk1' };
  const next = asRaw(setSlotSrc(raw(), target, 'assets/images/char-a/pose-walk1-v1.png'));
  assert.equal(slotSrc(next, target), 'assets/images/char-a/pose-walk1-v1.png');
  assert.equal(next.note, '原始说明，写回时必须保留');
  assert.deepEqual(next._sceneImageExample, { 说明: '模板，不能丢' });
  assert.equal(next.actions.idle.poses[0], 'stand');
  // 已有姿态的嘴部标定不受影响
  assert.equal(next.characters['char-a'].poses.stand.mouth?.[0], 0.49);
  // 新姿态自动带默认 anchor，不冒用他人标定
  assert.deepEqual(next.characters['char-a'].poses.walk1.anchor, [0.5, 0.94]);
  assert.equal(next.characters['char-a'].poses.walk1.mouth, undefined);
});

test('未注册人物上传：自动登记，defaultPose 指向真实存在的姿态', () => {
  const target: AssetTarget = { kind: 'characterPose', id: 'char-new', key: 'sit' };
  const next = asRaw(setSlotSrc(raw(), target, 'assets/images/char-new/pose-sit-v1.png'));
  const rig = next.characters['char-new'];
  assert.ok(rig, '新人物应自动登记');
  assert.equal(rig.defaultPose, 'sit', 'defaultPose 不能指向不存在的 stand，否则整帧不渲染');
  assert.equal(slotSrc(next, target), 'assets/images/char-new/pose-sit-v1.png');
  // 绝不套用 char-a 的形象
  assert.notEqual(rig.poses.sit.src, next.characters['char-a'].poses.stand.src);
});

test('场景整张底图 + 分层图写回；挂分层时底图让位', () => {
  const bg: AssetTarget = { kind: 'sceneBackground', id: 'scene-apartment' };
  let next = asRaw(setSlotSrc(raw(), bg, 'assets/images/bg.png'));
  assert.equal(slotSrc(next, bg), 'assets/images/bg.png');

  const layer: AssetTarget = { kind: 'sceneLayer', id: 'scene-apartment', key: 'mid' };
  next = asRaw(setSlotSrc(next, layer, 'assets/images/mid.png'));
  assert.equal(slotSrc(next, layer), 'assets/images/mid.png');
  assert.equal(slotSrc(next, bg), '', '分层真图与整张底图互斥，底图让位');
  // 场景自带 layers 由 defaults 展开 + 新增的 mid，defaults 本身不被改写
  assert.equal(next.scenes['scene-apartment'].layers?.length, 3);
  assert.equal(next.defaults.layers.length, 2);
});

test('未注册场景上传：自动登记且不套用别人的配色', () => {
  const target: AssetTarget = { kind: 'sceneLayer', id: 'scene-terrace', key: 'foreground' };
  const next = asRaw(setSlotSrc(raw(), target, 'assets/images/fg.png'));
  const scene = next.scenes['scene-terrace'];
  assert.ok(scene);
  assert.equal(scene.palette, 'scene-terrace', 'palette 用自身 id，不再兜底街边餐馆');
  assert.equal(slotSrc(next, target), 'assets/images/fg.png');
});

test('清除槽位回到程序化；人物无姿态时删掉整个注册项', () => {
  const target: AssetTarget = { kind: 'characterPose', id: 'char-a', key: 'stand' };
  const cleared = asRaw(clearSlotSrc(raw(), target));
  assert.equal(slotSrc(cleared, target), '');
  assert.equal(cleared.characters['char-a'], undefined, '空 rig 不留残壳');

  const a = setSlotSrc(raw(), { kind: 'sceneBackground', id: 'scene-apartment' }, 'bg.png');
  const b = asRaw(clearSlotSrc(a, { kind: 'sceneBackground', id: 'scene-apartment' }));
  assert.equal(b.scenes['scene-apartment'], undefined, '无真图时回到未注册中性分层');
  assert.equal(b.note, '原始说明，写回时必须保留');
});

test('describeSlots：缺图显式标注 ready=false，未登记项不出现', () => {
  const exists = (src: string) => src.includes('stand.png') || src.includes('bg.png');
  const withBg = setSlotSrc(raw(), { kind: 'sceneBackground', id: 'scene-apartment' }, 'bg.png');
  const withLayer = setSlotSrc(withBg,
    { kind: 'sceneLayer', id: 'scene-apartment', key: 'mid' }, 'missing.png');
  const payload = describeSlots(withLayer, exists);
  assert.equal(payload.poseKeys.length, POSE_KEYS.length);
  assert.equal(payload.layerKeys.length, LAYER_KEYS.length);
  assert.equal(payload.characters['char-a'].poses.stand.ready, true);
  assert.equal(payload.characters['char-a'].poses.sit.ready, false, '未传的姿态不算缺图也不算就绪');
  assert.equal(payload.characters['char-a'].poses.sit.src, '');
  // 挂了分层图后底图让位
  assert.equal(payload.scenes['scene-apartment'].backgroundImage.src, '');
  assert.equal(payload.scenes['scene-apartment'].layers.mid.ready, false, '文件不存在必须标缺图');
  assert.equal(payload.characters['char-zzz'], undefined);
});

test('校验白名单：非法 target / 路径穿越一律拒绝', () => {
  const ok = (body: unknown) => animationAssetTargetSchema.safeParse(body).success;
  assert.equal(ok({ kind: 'characterPose', id: 'char-a', key: 'stand' }), true);
  assert.equal(ok({ kind: 'sceneLayer', id: 'scene-a', key: 'foreground' }), true);
  assert.equal(ok({ kind: 'characterPose', id: '../etc', key: 'stand' }), false, '拒绝路径穿越');
  assert.equal(ok({ kind: 'characterPose', id: 'char-a', key: 'jump' }), false, '姿态键白名单');
  assert.equal(ok({ kind: 'sceneLayer', id: 'scene-a', key: 'hack' }), false, '层级键白名单');
  assert.equal(ok({ kind: 'unknown', id: 'x' }), false);

  assert.equal(uploadAnimationAssetSchema.safeParse({
    base64: 'data:image/png;base64,AAAA', target: { kind: 'sceneBackground', id: 'scene-a' },
  }).success, true);
  assert.equal(clearAnimationAssetSchema.safeParse({
    target: { kind: 'characterPose', id: 'char-a', key: 'walk1' },
  }).success, true);
});
