/**
 * 通用逐帧序列：把有限个 frameKey 底图按时间轴铺成 f00001.png…。
 *
 * 与 mouth.ts 的 writeFrameSequence 同构，但键从「4 档口型」推广为任意 frameKey
 * （动作阶段 × 口型档）。仍用硬链接复用底图，磁盘上不产生上百份重复 PNG。
 */
import fs from 'node:fs';
import path from 'node:path';

export const writeKeyedFrameSequence = (input: {
  dir: string;
  pngByKey: Record<string, string>;
  timeline: string[];
}): string => {
  const { dir, pngByKey, timeline } = input;
  const fallback = Object.values(pngByKey).find((v): v is string => Boolean(v));
  if (!fallback) throw new Error('动画帧序列缺失：没有生成任何可用的底图 PNG');
  if (!timeline.length) throw new Error('动画帧时间轴为空');
  fs.mkdirSync(dir, { recursive: true });
  for (let k = 0; k < timeline.length; k += 1) {
    const src = pngByKey[timeline[k]] ?? fallback;
    if (!fs.existsSync(src)) throw new Error(`动画帧底图缺失：${src}`);
    const dst = path.join(dir, `f${String(k + 1).padStart(5, '0')}.png`);
    try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
  }
  return path.join(dir, 'f%05d.png');
};
