import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cuesForShot, parseActionCues } from './actionCues.js';

test('连续行为拆成多段指令，时间加起来正好等于镜头时长', () => {
  const cues = parseActionCues('从沙发站起来走到厨房', 'char-a', 4);
  assert.ok(cues.length >= 2, '「站起来」与「走到厨房」应分成两段');
  assert.equal(cues[0].clipId, 'stand-up');
  assert.ok(cues.some((c) => c.clipId === 'walk-to-kitchen'));
  assert.ok(!cues.some((c) => c.clipId === 'walk'), '不应额外插一段泛化的原地走');
  const total = cues.reduce((sum, c) => sum + c.durationSec, 0);
  assert.ok(Math.abs(total - 4) < 0.01, `时长合计应等于 4s，实际 ${total}`);
  assert.equal(cues[0].startSec, 0);
  assert.ok(cues.every((c) => c.actorId === 'char-a'));
});

test('单动作词能映射到对应 clip', () => {
  assert.equal(parseActionCues('转身', 'char-b', 3)[0].clipId, 'turn');
  assert.equal(parseActionCues('坐下', 'char-b', 3)[0].clipId, 'sit');
  assert.equal(parseActionCues('挥手打招呼', 'char-b', 3)[0].clipId, 'greet');
});

test('空文本回退 idle，不假装执行动作', () => {
  const cues = parseActionCues('', 'char-a', 3);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].clipId, 'idle');
  assert.equal(cues[0].durationSec, 3);
});

test('旧项目 JSON 没有 actionCues 时即时从文本解析', () => {
  const cues = cuesForShot({
    action: '走到厨房', characterIds: ['char-a'], durationSec: 3.5,
  });
  assert.ok(cues.some((c) => c.clipId === 'walk-to-kitchen'));
  assert.equal(cues[0].actorId, 'char-a');
});

test('已有结构化指令优先，不被文本覆盖', () => {
  const stored = [{
    actorId: 'char-c', verb: '自定义', clipId: 'sit', startSec: 0, durationSec: 2,
  }];
  const cues = cuesForShot({
    action: '转身', actionCues: stored, characterIds: ['char-c'], durationSec: 2,
  });
  assert.equal(cues, stored);
  assert.equal(cues[0].clipId, 'sit');
});
