/**
 * 场景画板数据 → PNG 预览（不写项目文件，只产出 output/demo 下的对比图）。
 * 支持的元素只有 rect / ellipse（画板也只产出这两种），所以不需要任何 SVG 光栅化库。
 * 用法：node --import tsx scripts/render_scene_preview.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultStudio } from '../apps/server/src/sceneStudio.ts';

const ROOT = path.resolve('.');
const studio = defaultStudio();
const W = studio.canvas.w, H = studio.canvas.h;
const fb = new Uint8Array(W * H * 3);

const hex = (s) => {
  const v = s.replace('#', '');
  if (v.length === 3) return [parseInt(v[0] + v[0], 16), parseInt(v[1] + v[1], 16), parseInt(v[2] + v[2], 16)];
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
};
const px = (x, y, c, a = 1) => {
  x |= 0; y |= 0;
  if (x < 0 || x >= W || y < 0 || y >= H || a <= 0) return;
  const i = (y * W + x) * 3;
  if (a >= 1) { fb[i] = c[0]; fb[i + 1] = c[1]; fb[i + 2] = c[2]; }
  else { fb[i] = fb[i] * (1 - a) + c[0] * a; fb[i + 1] = fb[i + 1] * (1 - a) + c[1] * a; fb[i + 2] = fb[i + 2] * (1 - a) + c[2] * a; }
};
const rrect = (x0, y0, x1, y1, r, c, a) => {
  for (let y = Math.max(0, y0 | 0); y <= Math.min(H - 1, y1 | 0); y++)
    for (let x = Math.max(0, x0 | 0); x <= Math.min(W - 1, x1 | 0); x++) {
      if (r > 0) {
        const cx = Math.min(Math.max(x, x0 + r), x1 - r);
        const cy = Math.min(Math.max(y, y0 + r), y1 - r);
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      }
      px(x, y, c, a);
    }
};
const ell = (cx, cy, rx, ry, c, a) => {
  for (let y = Math.max(0, (cy - ry) | 0); y <= Math.min(H - 1, (cy + ry) | 0); y++)
    for (let x = Math.max(0, (cx - rx) | 0); x <= Math.min(W - 1, (cx + rx) | 0); x++)
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) px(x, y, c, a);
};

// 背景先铺白，避免透明区变黑
rrect(0, 0, W - 1, H - 1, 0, [255, 255, 255], 1);
for (const layer of studio.layers) {
  for (const e of layer.elements) {
    const c = hex(e.fill), a = e.opacity ?? 1;
    if (e.type === 'ellipse') ell(e.x + e.w / 2, e.y + e.h / 2, e.w / 2, e.h / 2, c, a);
    else rrect(e.x, e.y, e.x + e.w, e.y + e.h, e.rx ?? 0, c, a);
  }
}

const tmp = path.join(ROOT, 'output/demo/_scene_preview.rgb');
fs.writeFileSync(tmp, fb);
const out = path.join(ROOT, 'output/demo/场景画板默认模板.png');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
  '-s', `${W}x${H}`, '-i', tmp, '-frames:v', '1', out], { stdio: ['ignore', 'pipe', 'pipe'] });
fs.unlinkSync(tmp);
console.log(JSON.stringify({ out, size: fs.statSync(out).size, layers: studio.layers.length }, null, 2));
