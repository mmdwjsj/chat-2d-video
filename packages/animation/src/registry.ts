/**
 * 注册表解析与解析（resolve）：全部是纯函数，不读盘。
 *
 * 读盘交给 apps/server 侧，这样 packages/animation 保持零运行时依赖，
 * 前端也能安全地 import 同一套判定逻辑。
 *
 * 关键不变量：任何「没查到 / 资产缺失」都必须返回 degradations，
 * 绝不静默回退成别人的形象或别的场景配色。
 */
import type {
  ActionClip, AnimationDefaults, AnimationRegistry, CharacterRig,
  ResolveResult, SceneLayer, SceneSpec,
} from './contracts.js';
import { DEFAULT_CLIP_ID } from './contracts.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : fallback;

const pair = (v: unknown, fallback: [number, number]): [number, number] => {
  if (Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
    return [v[0], v[1]];
  }
  return fallback;
};

/** 解析一层：src 存在即用真图，否则渲染程序化 SVG。 */
const parseLayer = (raw: unknown, i: number): SceneLayer => {
  const item = isRecord(raw) ? raw : {};
  const src = str(item.src);
  return {
    key: str(item.key, `layer-${i}`),
    kind: (['sky', 'far', 'mid', 'near', 'foreground'].includes(str(item.kind))
      ? str(item.kind) : 'mid') as SceneLayer['kind'],
    parallax: Math.min(1, Math.max(0, num(item.parallax, 0.3))),
    ...(src ? { src, fit: item.fit === 'contain' ? 'contain' as const : 'cover' as const } : {}),
    opacity: Math.min(1, Math.max(0, num(item.opacity, 1))),
  };
};

const parseLayers = (raw: unknown): SceneLayer[] =>
  Array.isArray(raw) ? raw.map(parseLayer) : [];

const parseDefaults = (raw: unknown): AnimationDefaults => {
  const r = isRecord(raw) ? raw : {};
  const parsed = parseLayers(r.layers);
  const anchors: Record<string, [number, number]> = {};
  if (isRecord(r.anchors)) {
    for (const [k, v] of Object.entries(r.anchors)) anchors[k] = pair(v, [0.5, 0.8]);
  }
  return {
    layers: parsed.length ? parsed : [
      { key: 'sky', kind: 'sky', parallax: 0.05 },
      { key: 'far', kind: 'far', parallax: 0.18 },
      { key: 'mid', kind: 'mid', parallax: 0.42 },
      { key: 'near', kind: 'near', parallax: 0.72 },
      { key: 'foreground', kind: 'foreground', parallax: 1 },
    ],
    baseline: num(r.baseline, 1560),
    anchors,
  };
};

const parseRig = (id: string, raw: unknown): CharacterRig | null => {
  if (!isRecord(raw)) return null;
  const poses: CharacterRig['poses'] = {};
  if (isRecord(raw.poses)) {
    for (const [key, p] of Object.entries(raw.poses)) {
      if (!isRecord(p) || !str(p.src)) continue;
      const mouth = Array.isArray(p.mouth) ? pair(p.mouth, [0.5, 0.25]) : undefined;
      poses[key] = {
        key,
        src: str(p.src),
        anchor: pair(p.anchor, [0.5, 0.94]),
        mouth,
        mouthW: typeof p.mouthW === 'number' ? p.mouthW : undefined,
        skin: typeof p.skin === 'string' ? p.skin : undefined,
      };
    }
  }
  if (!Object.keys(poses).length) return null;
  return {
    id,
    name: str(raw.name, id),
    width: num(raw.width, 1024),
    height: num(raw.height, 1536),
    defaultPose: str(raw.defaultPose, Object.keys(poses)[0]),
    poses,
  };
};

const parseScene = (id: string, raw: unknown, defaults: AnimationDefaults): SceneSpec => {
  const r = isRecord(raw) ? raw : {};
  // 场景自带 layers 时以它为准（可逐层挂真图），否则继承 defaults.layers。
  const own = parseLayers(r.layers);
  const layers = own.length ? own : defaults.layers;
  const anchors: Record<string, [number, number]> = { ...defaults.anchors };
  if (isRecord(r.anchors)) {
    for (const [k, v] of Object.entries(r.anchors)) anchors[k] = pair(v, [0.5, 0.8]);
  }
  const backgroundImage = str(r.backgroundImage);
  return {
    id,
    palette: str(r.palette, id),
    ...(backgroundImage ? { backgroundImage } : {}),
    layers,
    anchors,
    baseline: num(r.baseline, defaults.baseline),
  };
};

const parseClip = (id: string, raw: unknown): ActionClip => {
  const r = isRecord(raw) ? raw : {};
  const poses = Array.isArray(r.poses) ? r.poses.filter((p): p is string => typeof p === 'string') : [];
  return {
    id,
    poses: poses.length ? poses : ['stand'],
    phases: Math.min(6, Math.max(1, Math.round(num(r.phases, 4)))),
    from: typeof r.from === 'string' ? r.from : undefined,
    to: typeof r.to === 'string' ? r.to : undefined,
    move: Array.isArray(r.move) ? pair(r.move, [0, 0]) : [0, 0],
    bob: num(r.bob, 0),
    rotate: num(r.rotate, 0),
    transition: (['cut', 'slide', 'fade'].includes(str(r.transition))
      ? str(r.transition) : 'cut') as ActionClip['transition'],
  };
};

/** 从 config/animation.json 的原始对象构造注册表；结构不合法时返回 null 并说明原因。 */
export const parseRegistry = (raw: unknown): ResolveResult<AnimationRegistry | null> => {
  if (!isRecord(raw)) return { value: null, degradations: ['动画注册表不是对象，已回退到原口型链路'] };
  const defaults = parseDefaults(raw.defaults);
  const characters: Record<string, CharacterRig> = {};
  const scenes: Record<string, SceneSpec> = {};
  const actions: Record<string, ActionClip> = {};
  const degradations: string[] = [];

  if (isRecord(raw.characters)) {
    for (const [id, value] of Object.entries(raw.characters)) {
      const rig = parseRig(id, value);
      if (rig) characters[id] = rig;
      else degradations.push(`人物 ${id} 的 rig 无可用姿态，已跳过注册`);
    }
  }
  if (isRecord(raw.scenes)) {
    for (const [id, value] of Object.entries(raw.scenes)) scenes[id] = parseScene(id, value, defaults);
  }
  if (isRecord(raw.actions)) {
    for (const [id, value] of Object.entries(raw.actions)) actions[id] = parseClip(id, value);
  }
  if (!actions[DEFAULT_CLIP_ID]) actions[DEFAULT_CLIP_ID] = parseClip(DEFAULT_CLIP_ID, { poses: ['stand'], phases: 1 });
  if (!Object.keys(characters).length) degradations.push('注册表里没有可用人物 rig');

  return {
    value: {
      schemaVersion: num(raw.schemaVersion, 1),
      enabled: raw.enabled !== false,
      defaults,
      characters,
      scenes,
      actions,
    },
    degradations,
  };
};

/** 按 Character.id 查 rig：未注册返回 null + 降级说明，绝不冒用已有三人的形象。 */
export const resolveCharacterRig = (
  reg: AnimationRegistry, id: string,
): ResolveResult<CharacterRig | null> => {
  const rig = reg.characters[id];
  if (rig) return { value: rig, degradations: [] };
  return {
    value: null,
    degradations: [`人物 ${id} 未注册 rig：本镜头该人物不显示动作，请到 config/animation.json 追加注册项`],
  };
};

/** 按 Scene.id 查分层规格：未注册时给一个中性规格并明确标注，不静默套用街边餐馆配色。 */
export const resolveSceneSpec = (
  reg: AnimationRegistry, id: string,
): ResolveResult<SceneSpec> => {
  const spec = reg.scenes[id];
  if (spec) return { value: spec, degradations: [] };
  return {
    value: {
      id,
      palette: id,
      layers: reg.defaults.layers,
      anchors: reg.defaults.anchors,
      baseline: reg.defaults.baseline,
    },
    degradations: [`场景 ${id} 未注册分层规格：已用中性分层，配色按场景名推断（不再是固定兜底为街边餐馆）`],
  };
};

export const resolveActionClip = (
  reg: AnimationRegistry, clipId: string,
): ResolveResult<ActionClip> => {
  const clip = reg.actions[clipId];
  if (clip) return { value: clip, degradations: [] };
  return {
    value: reg.actions[DEFAULT_CLIP_ID] ?? parseClip(DEFAULT_CLIP_ID, {}),
    degradations: [`动作 ${clipId} 未注册：本镜头按 idle 处理，请到 config/animation.json 的 actions 追加`],
  };
};

/** 校验姿态图是否存在；exist 由调用方注入（服务端读盘 / 前端恒 true）。 */
export const collectMissingAssets = (
  rig: CharacterRig, exists: (src: string) => boolean,
): string[] =>
  Object.values(rig.poses)
    .filter((pose) => !exists(pose.src))
    .map((pose) => `人物 ${rig.id} 的姿态图缺失：${pose.src}（该姿态将标注降级）`);

/**
 * 校验场景真图（整张底图 + 各层 src）是否存在。
 * 与人物一致：缺图必须显式留痕，绝不静默回到程序化色块冒充正常出片。
 */
export const collectMissingSceneAssets = (
  spec: SceneSpec, exists: (src: string) => boolean,
): string[] => {
  const srcs = [
    ...(spec.backgroundImage ? [spec.backgroundImage] : []),
    ...spec.layers.map((l) => l.src).filter((s): s is string => Boolean(s)),
  ];
  return [...new Set(srcs)]
    .filter((src) => !exists(src))
    .map((src) => `场景 ${spec.id} 的图片缺失：${src}（该层将标注降级）`);
};
