/**
 * FrameDirector：把「剧本动作指令 + 口型时间轴 + 分层场景」求值成逐帧状态。
 *
 * 性能关键：不产生「每帧一张新画面」，而是把连续变化量化到有限个 phase，
 * 每个 (phase 组合, 口型) 只对应一个 frameKey。服务端只截每个 frameKey 一张 PNG，
 * 再按 timeline 硬链接铺成逐帧序列，截图次数有上界。
 *
 * 纯计算，不读盘、不依赖浏览器，前后端可共用同一份判定。
 */
import type {
  ActionClip, ActionCue, ActorState, CharacterRig, FrameState, MouthShape, SceneSpec,
} from './contracts.js';
import { DEFAULT_CLIP_ID } from './contracts.js';

export type DirectInput = {
  fps: number;
  frames: number;
  actorIds: string[];
  speakingId: string;
  /** 未注册 / 缺资产的 actor 传 null，director 会标注降级而不是冒用他人 */
  rigs: Record<string, CharacterRig | null>;
  scene: SceneSpec;
  clips: Record<string, ActionClip>;
  cues: ActionCue[];
  mouths: MouthShape[];
};

export type DirectResult = {
  /** 与视频帧一一对应的 frameKey，长度 = frames */
  timeline: string[];
  /** 去重后的帧档定义，服务端按它截图 */
  frames: FrameState[];
  degradations: string[];
  /** 帧档数量，用于验收「截图次数有上界」 */
  frameKeyCount: number;
};

const FALLBACK_CLIP: ActionClip = {
  id: DEFAULT_CLIP_ID, poses: ['stand'], phases: 1, move: [0, 0], bob: 0, rotate: 0,
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * 求第 k 帧的状态。导出以便单测直接验证「首尾帧不同 / 姿态确实切换」。
 */
export const frameStateAt = (
  input: DirectInput, k: number,
): { state: FrameState; degradations: string[] } => {
  const idle = input.clips[DEFAULT_CLIP_ID] ?? FALLBACK_CLIP;
  const t = k / Math.max(1, input.fps);
  const degradations: string[] = [];
  const actors: ActorState[] = [];
  const phaseParts: string[] = [];
  let sceneOffset = 0;

  const active = input.cues.find(
    (c) => t >= c.startSec && t < c.startSec + Math.max(0.01, c.durationSec),
  );

  for (const id of input.actorIds) {
    const rig = input.rigs[id] ?? null;
    const cue = active && (active.actorId === id || active.actorId === '*') ? active : null;
    let clip = idle;
    let phase = 0;
    let q = 1;
    if (cue) {
      const resolved = input.clips[cue.clipId];
      if (!resolved) degradations.push(`动作 ${cue.clipId} 未注册：按 idle 处理`);
      clip = resolved ?? idle;
      const phases = Math.min(6, Math.max(1, Math.round(clip.phases)));
      const p = cue.durationSec > 0
        ? clamp01((t - cue.startSec) / cue.durationSec) : 1;
      phase = Math.min(phases - 1, Math.floor(p * phases));
      q = phases <= 1 ? 1 : phase / (phases - 1);
    }

    let pose = clip.poses[Math.min(clip.poses.length - 1, Math.floor(q * clip.poses.length))]
      ?? rig?.defaultPose ?? 'stand';
    if (!rig) {
      degradations.push(`人物 ${id} 缺 rig：不渲染动作`);
    } else if (!rig.poses[pose]) {
      degradations.push(`人物 ${id} 缺姿态 ${pose}：改用 ${rig.defaultPose}`);
      pose = rig.defaultPose;
    }

    const move = clip.move ?? [0, 0];
    const bob = clip.bob ?? 0;
    const wobble = Math.sin(q * Math.PI * 4);
    const x = move[0] * q;
    const y = move[1] * q + (bob * wobble) / 1920;
    const rotate = (clip.rotate ?? 0) * wobble;

    actors.push({
      id, pose, x, y,
      scale: 1,
      rotate,
      opacity: 1,
    });
    phaseParts.push(`${id}:${phase}:${pose}`);

    // 主说话人的空间移动决定场景位移；其余 actor 不重复叠加
    if (id === input.speakingId || (!input.speakingId && id === input.actorIds[0])) {
      const fromKey = cue?.from ?? clip.from;
      const toKey = cue?.to ?? clip.to;
      const from = (fromKey && input.scene.anchors[fromKey]) || [0.5, 0.8];
      const to = (toKey && input.scene.anchors[toKey]) || from;
      sceneOffset = fromKey && toKey
        ? (to[0] - from[0]) * q
        : -(move[0] * q * 0.6);
    }
  }

  const mouth: MouthShape = input.mouths[k] ?? 'closed';
  const frameKey = `${phaseParts.join('_')}|${mouth}`;
  return {
    state: { frameKey, sceneOffset, actors, mouth },
    degradations,
  };
};

/** 整镜头求值：去重帧档 + 逐帧时间轴 + 显式降级清单。 */
export const directShot = (input: DirectInput): DirectResult => {
  const total = Math.max(1, Math.floor(input.frames));
  const timeline: string[] = [];
  const byKey = new Map<string, FrameState>();
  const degradations = new Set<string>();

  for (let k = 0; k < total; k += 1) {
    const { state, degradations: notes } = frameStateAt(input, k);
    timeline.push(state.frameKey);
    if (!byKey.has(state.frameKey)) byKey.set(state.frameKey, state);
    for (const note of notes) degradations.add(note);
  }

  return {
    timeline,
    frames: [...byKey.values()],
    degradations: [...degradations],
    frameKeyCount: byKey.size,
  };
};
