import type { AnimationPlan, PlanInput } from './types.js';

export * from './types.js';
export * from './contracts.js';
export * from './registry.js';
export * from './director.js';

const COMPLEX = ['走路', '骑摩托', '骑车', '跳舞', '跑', '复杂动作'];

/**
 * 阶段三的确定性 2D 动画计划：只算参数，不生成素材。
 * 复杂动作镜头标成 `ai-video`，交给阶段二的视频 Provider。
 */
export const planBasicShot = (input: PlanInput): AnimationPlan => {
  const duration = Math.max(1, input.audioDurationSec ?? input.durationSec);
  const blinkAtSec = [0.8, 2.4, 4.1, 6.3].filter((t) => t < duration);
  const mouthCues = Array.from({ length: Math.max(1, Math.floor(duration / 0.45)) }, (_, i) => ({
    atSec: Math.round(i * 0.45 * 100) / 100,
    shape: (['closed', 'small', 'wide', 'round'] as const)[i % 4],
    intensity: 0.5 + (i % 3) * 0.2,
  }));
  const complex = (input.complexActions ?? COMPLEX).some((word) => input.action.includes(word));
  return {
    shotId: input.shotId,
    kind: complex ? 'ai-video' : 'static-2d',
    expression: input.expression || '自然',
    pose: complex ? '由视频模型生成' : '半身站姿 / 坐姿',
    blinkAtSec,
    mouthCues,
    cameraMove: input.cameraMove || '固定',
    notes: complex
      ? '复杂动作：阶段二用 AI 视频模型，需注入人物参考图'
      : '固定人物素材 + 表情切换 + 嘴型参数，阶段三由 Remotion 播放',
  };
};
