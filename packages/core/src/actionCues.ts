/**
 * 对白行的行为说明 → 结构化动作指令。
 *
 * 以前 `shot.action` 只是一个标签字符串（「挥手」「正视对方」），渲染层完全不消费。
 * 这里把它解析成带主体、动作 clip、起止锚点与时间的指令序列，
 * 让「从沙发站起来走到厨房」真的能落成多个连续动作阶段。
 *
 * 纯函数，不认识的描述保留原文并回退到 talk，绝不假装执行了某个动作。
 */
import type { ActionCue } from './types.js';

type Rule = {
  verb: string;
  clipId: string;
  test: RegExp;
  from?: string;
  to?: string;
};

/** 顺序有讲究：先认带起止的长动作，再认单个姿态词。 */
const RULES: Rule[] = [
  { verb: '从沙发站起来', clipId: 'stand-up', test: /站起|起身|站起来|从沙发.*站/, from: 'sofa' },
  { verb: '走到厨房', clipId: 'walk-to-kitchen', test: /走到厨房|去厨房|走进厨房|厨房/, from: 'sofa', to: 'kitchen' },
  { verb: '走到门口', clipId: 'walk', test: /走到门口|去门口|出门/, from: 'center', to: 'door' },
  { verb: '转身', clipId: 'turn', test: /转身|回头|转过身|背对/ },
  { verb: '坐下', clipId: 'sit', test: /坐下|坐在|坐着|坐到沙发/ },
  { verb: '走动', clipId: 'walk', test: /走|散步|走过去|跑|赶路/ },
  { verb: '打招呼', clipId: 'greet', test: /挥手|招手|打招呼|抬手|举手|递|端起|放下|抱臂|叉腰/ },
  { verb: '看向对方', clipId: 'talk', test: /看向|正视|点头|摇头|歪头|摊手|愣住|托腮/ },
];

/**
 * @param action   对白行的动作描述（可能为空、可能是一串连续行为）
 * @param actorId  说话人 / 动作主体
 * @param durationSec 本镜头总时长，用于把多个动作按出现顺序均分时间段
 */
export const parseActionCues = (
  action: string, actorId: string, durationSec: number,
): ActionCue[] => {
  const text = (action ?? '').trim();
  const total = Math.max(0.2, durationSec);
  if (!text) {
    return [{ actorId, verb: '待机', clipId: 'idle', startSec: 0, durationSec: total }];
  }

  const hits = RULES.filter((rule) => rule.test.test(text));
  // 「走到厨房」会同时命中长动作与泛化的「走」，保留更具体的那个，避免多插一段原地走。
  const specific = hits.some((h) => h.clipId === 'walk-to-kitchen' || h.clipId === 'walk');
  const cues = hits.length
    ? (specific && hits.some((h) => h.clipId === 'walk-to-kitchen')
      ? hits.filter((h) => h.clipId !== 'walk')
      : hits)
    : [{ verb: '自然对话', clipId: 'talk' } as Rule];
  const span = total / cues.length;

  return cues.map((rule, i) => ({
    actorId,
    verb: rule.verb,
    clipId: rule.clipId,
    from: rule.from,
    to: rule.to,
    startSec: Math.round(i * span * 1000) / 1000,
    durationSec: Math.round((i === cues.length - 1 ? total - i * span : span) * 1000) / 1000,
  }));
};

/** 既有结构化指令优先，没有才从文本解析；保证旧项目 JSON 不用迁移。 */
export const cuesForShot = (
  shot: { action: string; actionCues?: ActionCue[]; characterIds: string[]; durationSec: number },
): ActionCue[] => {
  if (shot.actionCues?.length) return shot.actionCues;
  const actorId = shot.characterIds[0] ?? '';
  return parseActionCues(shot.action, actorId, shot.durationSec);
};
