/**
 * 真人部件版动画样片：读取 assets/characters/cutout/<slug>/parts.json，
 * 把 4 个部件按枢轴做「旋转 + 平移 + 缩放」的仿射贴图，逐帧合成后交 ffmpeg 出 MP4。
 *
 * 与上一版几何小人的区别：这一版的像素全部来自真实立绘，只是按关节角度重新摆位。
 * 动作：站立呼吸 → 起步 → 连续迈步前进 → 停步回正。
 * 由于素材是「站立像」，坐姿无法凭空生成（没有坐姿素材），所以不假装做坐姿。
 *
 * 用法：node scripts/render_live_demo.mjs nina
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve('.');
const slug = process.argv[2] || 'nina';
const W = 540, H = 960, FPS = 30, DUR = 4, N = FPS * DUR;
const GROUND = 768;
const TMP = path.join(ROOT, 'output/demo/_live_tmp');
fs.mkdirSync(TMP, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/characters/cutout', slug, 'parts.json'), 'utf8'));
const SW = manifest.canvas.w, SH = manifest.canvas.h;

/** PNG -> RGBA raw -> {data,w,h} */
const loadPart = (name) => {
  const rel = manifest.parts[name].src;
  const png = path.join(ROOT, rel);
  const raw = path.join(TMP, `${slug}_${name}.rgba`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgba', raw]);
  const data = fs.readFileSync(raw);
  fs.unlinkSync(raw);
  return { data, w: SW, h: SH, pivot: manifest.parts[name].pivot, box: manifest.parts[name].box };
};
const Parts = {};
for (const n of ['head', 'torso', 'legL', 'legR']) Parts[n] = loadPart(n);

const fb = new Uint8Array(W * H * 3);
const px = (x, y, c, a = 1) => {
  x |= 0; y |= 0;
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  if (a >= 1) { fb[i] = c[0]; fb[i + 1] = c[1]; fb[i + 2] = c[2]; }
  else { fb[i] = fb[i] * (1 - a) + c[0] * a; fb[i + 1] = fb[i + 1] * (1 - a) + c[1] * a; fb[i + 2] = fb[i + 2] * (1 - a) + c[2] * a; }
};
const rect = (x0, y0, x1, y1, c, a = 1) => {
  for (let y = Math.max(0, y0 | 0); y <= Math.min(H - 1, y1 | 0); y++)
    for (let x = Math.max(0, x0 | 0); x <= Math.min(W - 1, x1 | 0); x++) px(x, y, c, a);
};
const ellipse = (cx, cy, rx, ry, c, a = 1) => {
  for (let y = Math.max(0, (cy - ry) | 0); y <= Math.min(H - 1, (cy + ry) | 0); y++)
    for (let x = Math.max(0, (cx - rx) | 0); x <= Math.min(W - 1, (cx + rx) | 0); x++)
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) px(x, y, c, a);
};

/**
 * 旋转贴图：把源部件以其 pivot 为轴，旋转 ang、缩放 s，落到输出画布 (Tx,Ty)。
 * 逐输出像素反算源坐标 + 双线性采样 + alpha 混合。
 */
const blit = (part, Tx, Ty, ang, s) => {
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const { w, h, data, pivot, box } = part;
  // 源 box 四角变换后的输出包围盒
  const corners = [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [ux, uy] of corners) {
    const du = (ux - pivot.x) * s, dv = (uy - pivot.y) * s;
    const X = Tx + du * cos - dv * sin, Y = Ty + du * sin + dv * cos;
    if (X < minX) minX = X; if (X > maxX) maxX = X; if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
  }
  minX = Math.max(0, minX | 0); maxX = Math.min(W - 1, maxX | 0);
  minY = Math.max(0, minY | 0); maxY = Math.min(H - 1, maxY | 0);
  for (let Y = minY; Y <= maxY; Y++) {
    for (let X = minX; X <= maxX; X++) {
      const dx = X - Tx, dy = Y - Ty;
      const u = (dx * cos + dy * sin) / s + pivot.x;
      const v = (-dx * sin + dy * cos) / s + pivot.y;
      if (u < box.x || u >= box.x + box.w || v < box.y || v >= box.y + box.h) continue;
      const x0 = Math.floor(u), y0 = Math.floor(v);
      const fx = u - x0, fy = v - y0;
      let r = 0, g = 0, b = 0, a = 0;
      for (const [ox, oy, wgt] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
        const sx = x0 + ox, sy = y0 + oy;
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
        const i = (sy * w + sx) * 4;
        const al = data[i + 3] / 255 * wgt;
        r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += al;
      }
      if (a <= 0.004) continue;
      px(X, Y, [r / a, g / a, b / a], Math.min(1, a));
    }
  }
};

/* 场景：极简、干净（不做"稀巴烂"的拼贴家具），给人物留出表演空间 */
const drawScene = (camX) => {
  for (let y = 0; y < GROUND; y++) {
    const k = y / GROUND;
    const c = [252 - 12 * k, 238 - 16 * k, 220 - 14 * k];
    for (let x = 0; x < W; x++) px(x, y, c);
  }
  rect(0, GROUND, W - 1, H - 1, [214, 196, 172]);
  rect(0, GROUND, W - 1, GROUND + 3, [188, 166, 140]);
  // 墙裙 + 地板缝线（随相机移动，给"走"提供参照）
  const off = -camX;
  for (let i = -2; i < 10; i++) {
    const x = i * 96 + (off % 96);
    rect(x, GROUND + 6, x + 2, H - 1, [198, 178, 152], 0.55);
  }
  // 远处两个柔和的竖向光带，避免大片空墙
  rect(70 + off * 0.12, 120, 130 + off * 0.12, GROUND - 30, [250, 236, 214], 0.55);
  rect(380 + off * 0.12, 120, 440 + off * 0.12, GROUND - 30, [250, 236, 214], 0.55);
};

const ease = (s) => s * s * (3 - 2 * s);
const lerp = (a, b, s) => a + (b - a) * s;

/** 骨架求值：返回整体位移 + 三根主关节角 */
const poseAt = (t) => {
  const S = { x: 196, angTorso: 0, angHead: 0, angLegL: 0, angLegR: 0, bob: 0 };
  if (t < 0.8) {
    S.bob = Math.sin(t * 2.4) * 2.0;
  } else if (t < 1.5) {
    const s = ease((t - 0.8) / 0.7);
    S.x = lerp(196, 232, s);
    S.angLegL = -0.28 * s; S.angLegR = 0.16 * s;
    S.bob = Math.abs(Math.sin(s * Math.PI)) * 3;
  } else if (t < 3.5) {
    const s = (t - 1.5) / 2.0;
    S.x = lerp(232, 358, s);
    const ph = s * Math.PI * 2 * 2.6, sw = Math.sin(ph);
    S.angLegL = sw * 0.34; S.angLegR = -sw * 0.34;
    S.angTorso = sw * 0.035;
    S.angHead = -sw * 0.02;
    S.bob = Math.abs(Math.sin(ph)) * 4.5;
  } else {
    const s = ease((t - 3.5) / 0.5);
    S.x = lerp(358, 364, s);
    S.angLegL = lerp(0.34, 0, s) * -1; S.angLegR = lerp(-0.34, 0, s) * -1;
    S.bob = 0;
  }
  return S;
};

const S_SCALE = 0.40;
const legOutH = (manifest.parts.legL.box.h) * S_SCALE;
const hipOut = (S) => ({
  x: S.x,
  y: GROUND - legOutH + 8 - S.bob,
});
const pivotOut = (part, hip, ang, s = S_SCALE) => {
  const du = (part.pivot.x - manifest.parts.torso.pivot.x) * s;
  const dv = (part.pivot.y - manifest.parts.torso.pivot.y) * s;
  return { x: hip.x + du * Math.cos(ang) - dv * Math.sin(ang), y: hip.y + du * Math.sin(ang) + dv * Math.cos(ang) };
};

const fd = fs.openSync(path.join(TMP, 'frames.rgb'), 'w');
for (let f = 0; f < N; f++) {
  const t = f / FPS, S = poseAt(t);
  const hip = hipOut(S);
  const camX = (S.x - 196) * 0.55;
  drawScene(camX);
  ellipse(hip.x + 6, GROUND + 2, 78, 13, [176, 152, 126], 0.55);
  // 腿（绕髋）
  const lHip = pivotOut(Parts.legL, hip, S.angTorso);
  const rHip = pivotOut(Parts.legR, hip, S.angTorso);
  blit(Parts.legL, lHip.x, lHip.y, S.angTorso + S.angLegL, S_SCALE);
  blit(Parts.legR, rHip.x, rHip.y, S.angTorso + S.angLegR, S_SCALE);
  // 躯干（绕髋）
  blit(Parts.torso, hip.x, hip.y, S.angTorso, S_SCALE);
  // 头（绕颈，颈点随躯干旋转）
  const neck = pivotOut(Parts.head, hip, S.angTorso);
  blit(Parts.head, neck.x, neck.y, S.angTorso + S.angHead, S_SCALE);
  fs.writeSync(fd, fb);
}
fs.closeSync(fd);

const outDir = path.join(ROOT, 'output/demo');
const mp4 = path.join(outDir, `真人部件版-${slug}-走路.mp4`);
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
  '-s', `${W}x${H}`, '-r', String(FPS), '-i', path.join(TMP, 'frames.rgb'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: ['ignore', 'pipe', 'pipe'] });
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', mp4, '-vf', 'fps=1', path.join(outDir, `live_${slug}_%02d.png`)],
  { stdio: ['ignore', 'pipe', 'pipe'] });

fs.rmSync(TMP, { recursive: true, force: true });
console.log(JSON.stringify({ mp4, size: fs.statSync(mp4).size, frames: N, scale: S_SCALE, legOutH: +legOutH.toFixed(1) }, null, 2));
