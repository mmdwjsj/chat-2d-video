/**
 * 立绘 → 可动部位图（去背 + 按关节掩膜切割）。
 *
 * 为什么只切 4 块：这批立绘手臂完全贴身（躯干行宽连续变化、手臂与身体之间无像素缝隙），
 * 右臂还被挎包压住。硬切手臂必然带走一片躯干，旋转时穿帮。所以按「不穿帮」优先：
 *   head  头+头发+颈根
 *   torso 躯干+手臂+挎包（一体，只做整体前倾/起伏）
 *   legL / legR 左右腿（含脚），以髋中心为界硬分，髋部重叠 16px 遮缝
 * 后续若有「双臂自然离身」的立绘，再扩成 8+ 部件，本脚本加一个掩膜框即可。
 *
 * 产物：assets/characters/cutout/<slug>/<part>.png （画布 1024x1536，统一坐标，部件外透明）
 *       assets/characters/cutout/<slug>/parts.json（枢轴/尺寸/来源，供渲染直接消费）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve('.');
const W = 1024, H = 1536;
const TOL = 30;
const SLUGS = process.argv.slice(2).length ? process.argv.slice(2) : ['nina', 'aton', 'dundun'];
const OUT_BASE = path.join(ROOT, 'assets/characters/cutout');
const TMP = path.join(ROOT, 'output/demo/_parts_tmp');
fs.mkdirSync(TMP, { recursive: true });

const readRgba = (png) => {
  const raw = path.join(TMP, `${path.basename(png, '.png')}.rgba`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgba', raw]);
  const data = fs.readFileSync(raw);
  fs.unlinkSync(raw);
  return data;
};
const writePng = (rgba, out) => {
  const raw = path.join(TMP, `_w_${path.basename(out, '.png')}.rgba`);
  fs.writeFileSync(raw, rgba);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${W}x${H}`, '-i', raw, '-frames:v', '1', out]);
  fs.unlinkSync(raw);
};

for (const slug of SLUGS) {
  const src = path.join(ROOT, 'assets/characters/library', slug, 'fullBody.png');
  if (!fs.existsSync(src)) { console.log(`[跳过] ${slug} 无 fullBody.png`); continue; }
  const buf = readRgba(src);

  // 1) 底色 + 边界漫水填充去背
  const at = (x, y) => { const i = (y * W + x) * 4; return [buf[i], buf[i + 1], buf[i + 2]]; };
  const cs = [at(3, 3), at(W - 4, 3), at(3, H - 4), at(W - 4, H - 4)];
  const base = [0, 1, 2].map((k) => Math.round(cs.reduce((s, c) => s + c[k], 0) / 4));
  const near = (p) => Math.hypot(buf[p * 4] - base[0], buf[p * 4 + 1] - base[1], buf[p * 4 + 2] - base[2]) < TOL;
  const isBg = new Uint8Array(W * H);
  const stack = [];
  const visit = (x, y) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const p = y * W + x;
    if (isBg[p] || !near(p)) return;
    isBg[p] = 1; stack.push(p);
  };
  for (let x = 0; x < W; x++) { visit(x, 0); visit(x, H - 1); }
  for (let y = 0; y < H; y++) { visit(0, y); visit(W - 1, y); }
  while (stack.length) {
    const p = stack.pop(), x = p % W, y = (p / W) | 0;
    visit(x + 1, y); visit(x - 1, y); visit(x, y + 1); visit(x, y - 1);
  }

  // 2) 逐行剖面
  const rows = new Array(H);
  let minX = W, maxX = 0, minY = H, maxY = 0;
  for (let y = 0; y < H; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < W; x++) if (!isBg[y * W + x]) { if (l < 0) l = x; r = x; }
    rows[y] = { l, r, w: l < 0 ? 0 : r - l + 1 };
    if (l >= 0) { if (l < minX) minX = l; if (r > maxX) maxX = r; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  const BH = maxY - minY;

  // 3) 关键横线：脖子最窄 / 髋部宽度骤降
  let neckY = Math.round(minY + BH * 0.25), neckW = Infinity;
  for (let y = Math.round(minY + BH * 0.18); y <= Math.round(minY + BH * 0.40); y++)
    if (rows[y].w > 0 && rows[y].w < neckW) { neckW = rows[y].w; neckY = y; }
  let hipY = Math.round(minY + BH * 0.62), bestDrop = -1;
  for (let y = Math.round(minY + BH * 0.52); y <= Math.round(minY + BH * 0.78); y++) {
    const drop = rows[y].w - rows[Math.min(H - 1, y + 36)].w;
    if (drop > bestDrop) { bestDrop = drop; hipY = y; }
  }
  const neck = rows[neckY];
  const neckX = Math.round((neck.l + neck.r) / 2);
  const hipRow = rows[hipY];
  const hipX = Math.round((hipRow.l + hipRow.r) / 2);

  // 4) 各部件掩膜范围（绝对坐标）
  const headY0 = minY - 2, headY1 = neckY + 8;
  const legY0 = hipY - 16, legY1 = maxY + 2;
  const spanOf = (y0, y1) => {
    let l = W, r = 0;
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) if (rows[y].w > 0) { if (rows[y].l < l) l = rows[y].l; if (rows[y].r > r) r = rows[y].r; }
    return { l: l - 4, r: r + 4 };
  };
  const headSpan = spanOf(headY0, headY1 - 10);
  const torsoSpan = spanOf(neckY - 6, hipY + 12);
  const legSpan = spanOf(legY0, legY1);

  const masks = {
    head: { x0: headSpan.l, x1: headSpan.r, y0: headY0, y1: headY1, pivot: [neckX, neckY] },
    torso: { x0: torsoSpan.l, x1: torsoSpan.r, y0: neckY - 6, y1: hipY + 14, pivot: [hipX, hipY] },
    legL: { x0: legSpan.l, x1: hipX, y0: legY0, y1: legY1, pivot: [hipX - 4, hipY] },
    legR: { x0: hipX, x1: legSpan.r, y0: legY0, y1: legY1, pivot: [hipX + 4, hipY] },
  };

  const outDir = path.join(OUT_BASE, slug);
  const manifest = { slug, source: `assets/characters/library/${slug}/fullBody.png`, canvas: { w: W, h: H }, baseColor: base, parts: {} };
  for (const [name, m] of Object.entries(masks)) {
    const out = Buffer.alloc(W * H * 4);
    for (let y = Math.max(0, m.y0); y <= Math.min(H - 1, m.y1); y++) {
      if (rows[y].w === 0) continue;
      for (let x = Math.max(0, m.x0); x <= Math.min(W - 1, m.x1); x++) {
        const p = y * W + x;
        if (isBg[p]) continue;
        out[p * 4] = buf[p * 4]; out[p * 4 + 1] = buf[p * 4 + 1];
        out[p * 4 + 2] = buf[p * 4 + 2]; out[p * 4 + 3] = 255;
      }
    }
    const png = path.join(outDir, `${name}.png`);
    writePng(out, png);
    manifest.parts[name] = {
      src: `assets/characters/cutout/${slug}/${name}.png`,
      box: { x: m.x0, y: m.y0, w: m.x1 - m.x0, h: m.y1 - m.y0 },
      pivot: { x: m.pivot[0], y: m.pivot[1] },
    };
  }
  fs.writeFileSync(path.join(outDir, 'parts.json'), JSON.stringify(manifest, null, 2));
  console.log(`[切图完成] ${slug}  neckY=${neckY}(w=${neckW}) hipY=${hipY}(x=${hipX}) bbox=(${minX},${minY})-(${maxX},${maxY})`);
  for (const [k, v] of Object.entries(manifest.parts)) console.log(`   ${k.padEnd(6)} box=${v.box.w}x${v.box.h} pivot=(${v.pivot.x},${v.pivot.y})`);
}
