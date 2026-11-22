/**
 * 正面步态「网格变形」走路样片（mesh warp / LBS）。
 *
 * 为什么推翻上一版「切 4 块 + 绕髋旋转」：
 *   1) 这批立绘双腿并拢贴合，按中线硬切后，每条腿的内侧就是一条竖直切面。
 *      腿一旋转，切面直接暴露成一条深色直线 —— 就是"腿像被锯掉"的观感。
 *   2) 腿的上端切在枢轴上方 16px，旋转时那一截反向甩出，裤腰处出现楔形透明缺口。
 *   3) 更根本的问题：立绘是正面视角，用侧视骨骼去"前后劈腿"，
 *      屏幕投影就变成左右张开，本质上是劈叉而不是走路。
 *
 * 这一版的做法：
 *   - 不切图。整张去背人物作为一张连续网格，按骨骼权重做线性混合蒙皮（LBS），
 *     像素永远连续，腿根/膝盖不会出现任何断口。
 *   - 正面视角的走路 = 交替抬脚（小腿透视缩短）+ 膝盖弯曲 + 骨盆上下起伏 + 重心左右转移，
 *     腿的左右张开角度压到 ±3°，避免劈叉感。
 *   - 双脚由独立 foot 骨骼纯平移，落地时鞋底保持水平、始终贴地。
 *
 * 用法：
 *   node scripts/render_walk_mesh.mjs nina            # 出 MP4 + 抽帧
 *   node scripts/render_walk_mesh.mjs nina --stills    # 只出 6 张静帧（调参用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve('.');
const slug = process.argv[2] || 'nina';
const STILLS = process.argv.includes('--stills');

const SW = 1024, SH = 1536;              // 源画布
const W = 540, H = 960, FPS = 30;        // 输出
const DUR = 4.4;
const N = Math.round(FPS * DUR);
const GROUND = 800;                      // 地面 y（输出坐标）
const SCALE = 0.455;                     // 源 -> 输出
const TMP = path.join(ROOT, 'output/demo/_mesh_tmp');
fs.mkdirSync(TMP, { recursive: true });

/* ------------------------------------------------------------------ 读图 */
const readRgba = (png) => {
  const raw = path.join(TMP, `_r_${path.basename(png, '.png')}.rgba`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgba', raw]);
  const d = fs.readFileSync(raw);
  fs.unlinkSync(raw);
  if (d.length !== SW * SH * 4) throw new Error(`尺寸不符 ${png}: ${d.length} != ${SW * SH * 4}`);
  return d;
};

const fullBody = path.join(ROOT, 'assets/characters/library', slug, 'fullBody.png');
if (!fs.existsSync(fullBody)) throw new Error(`缺少 ${fullBody}`);
const src = readRgba(fullBody);

/* ------------------------------------------------------------ 去背（漫水） */
const TOL = 46, tol2 = TOL * TOL;
const px3 = (p) => [src[p * 4], src[p * 4 + 1], src[p * 4 + 2]];
const corners = [[3, 3], [SW - 4, 3], [3, SH - 4], [SW - 4, SH - 4]].map(([x, y]) => px3(y * SW + x));
const base = [0, 1, 2].map((k) => Math.round(corners.reduce((s, c) => s + c[k], 0) / 4));

const isBg = new Uint8Array(SW * SH);
const stack = new Int32Array(SW * SH);
let sp = 0;
const nearBase = (p) => {
  const dr = src[p * 4] - base[0], dg = src[p * 4 + 1] - base[1], db = src[p * 4 + 2] - base[2];
  return dr * dr + dg * dg + db * db < tol2;
};
const push = (x, y) => {
  if (x < 0 || x >= SW || y < 0 || y >= SH) return;
  const p = y * SW + x;
  if (isBg[p] || !nearBase(p)) return;
  isBg[p] = 1; stack[sp++] = p;
};
for (let x = 0; x < SW; x++) { push(x, 0); push(x, SH - 1); }
for (let y = 0; y < SH; y++) { push(0, y); push(SW - 1, y); }
while (sp > 0) {
  const p = stack[--sp], x = p % SW, y = (p / SW) | 0;
  push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
}

/* --------------------------------- 预乘 RGB + 1px 羽化 alpha + 去白边 */
const pr = new Float32Array(SW * SH);
const pg = new Float32Array(SW * SH);
const pb = new Float32Array(SW * SH);
const pa = new Float32Array(SW * SH);
for (let p = 0; p < SW * SH; p++) pa[p] = isBg[p] ? 0 : 1;

// 羽化：3x3 盒式模糊，只作用在轮廓 1px 内
const pa2 = new Float32Array(pa);
for (let y = 1; y < SH - 1; y++) {
  for (let x = 1; x < SW - 1; x++) {
    const p = y * SW + x;
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { s += pa[p + dy * SW + dx]; n++; }
    pa2[p] = s / n;
  }
}
for (let p = 0; p < SW * SH; p++) {
  pr[p] = src[p * 4] * pa2[p];
  pg[p] = src[p * 4 + 1] * pa2[p];
  pb[p] = src[p * 4 + 2] * pa2[p];
  pa[p] = pa2[p];
}
// 去白边：边缘像素颜色向内侧前景均值靠拢（只改 RGB，不改 alpha）
for (let y = 1; y < SH - 1; y++) {
  for (let x = 1; x < SW - 1; x++) {
    const p = y * SW + x;
    if (pa[p] <= 0.02 || pa[p] >= 0.98) continue;
    let r = 0, g = 0, b = 0, w = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const q = p + dy * SW + dx;
      if (pa[q] < 0.9) continue;
      r += src[q * 4]; g += src[q * 4 + 1]; b += src[q * 4 + 2]; w++;
    }
    if (!w) continue;
    pr[p] = (r / w) * pa[p]; pg[p] = (g / w) * pa[p]; pb[p] = (b / w) * pa[p];
  }
}

/* ------------------------------------------------------------- 轮廓与骨架 */
let minX = SW, maxX = 0, minY = SH, maxY = 0;
const rowL = new Int32Array(SH), rowR = new Int32Array(SH);
for (let y = 0; y < SH; y++) {
  let l = -1, r = -1;
  for (let x = 0; x < SW; x++) if (!isBg[y * SW + x]) { if (l < 0) l = x; r = x; }
  rowL[y] = l; rowR[y] = r;
  if (l >= 0) {
    if (l < minX) minX = l; if (r > maxX) maxX = r;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
}

// 骨架参数沿用已验证的 parts.json 枢轴（髋/颈），避免重新猜
const parts = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/characters/cutout', slug, 'parts.json'), 'utf8'));
const hipY = parts.parts.legL.pivot.y;
const hipX = (parts.parts.legL.pivot.x + parts.parts.legR.pivot.x) / 2;
const neckY = parts.parts.head.pivot.y;
const footY = parts.parts.legL.box.y + parts.parts.legL.box.h - 2;

const legH = footY - hipY;
const kneeY = hipY + legH * 0.50;
const ankleY = footY - legH * 0.115;
const legSpanW = (parts.parts.legR.box.x + parts.parts.legR.box.w) - parts.parts.legL.box.x;
const legSep = Math.max(26, legSpanW * 0.135);          // 单腿中心到中线距离

const thighLen = kneeY - hipY;
const shinLen = ankleY - kneeY;
const footLen = footY - ankleY;

/* ------------------------------------------------------------- 网格构建 */
const PAD = 6;
const gx0 = minX - PAD, gx1 = maxX + PAD;
const gy0 = minY - PAD, gy1 = maxY + PAD;
const cols = Math.max(18, Math.min(30, Math.round((gx1 - gx0) / 20)));
const rows = Math.max(32, Math.min(66, Math.round((gy1 - gy0) / 20)));
const NIC = cols * rows;

const gridSrcX = new Float32Array(NIC);
const gridSrcY = new Float32Array(NIC);
const wTorso = new Float32Array(NIC);
const wLT = new Float32Array(NIC), wLS = new Float32Array(NIC), wLF = new Float32Array(NIC);
const wRT = new Float32Array(NIC), wRS = new Float32Array(NIC), wRF = new Float32Array(NIC);
const wAL = new Float32Array(NIC), wAR = new Float32Array(NIC);

const smoothstep = (e0, e1, x) => {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};
const WB = 26;          // 左右腿过渡带半宽（避免中线撕裂）
const KNEE_B = 40;      // 膝盖过渡带

/* 手臂区：正面走路最关键的"在走"信号，没有摆臂就像原地踏步 */
const torsoW = parts.parts.torso.box.w;
const shoulderY = neckY + (hipY - neckY) * 0.14;
const handY = hipY + (footY - hipY) * 0.12;
const armBand = torsoW * 0.20;
const armLIn = hipX - torsoW * 0.5, armLOut = hipX - torsoW * 0.5 + armBand;
const armRIn = hipX + torsoW * 0.5 - armBand, armROut = hipX + torsoW * 0.5;

for (let j = 0; j < rows; j++) {
  const y = gy0 + (gy1 - gy0) * (j / (rows - 1));
  for (let i = 0; i < cols; i++) {
    const x = gx0 + (gx1 - gx0) * (i / (cols - 1));
    const k = j * cols + i;
    gridSrcX[k] = x; gridSrcY[k] = y;

    const wUp = smoothstep(hipY + 16, hipY - 34, y);   // y 小 -> 1（躯干）
    const wLeg = 1 - wUp;
    const sR = smoothstep(hipX - WB, hipX + WB, x);     // 0 左 1 右

    const kTh = smoothstep(kneeY + KNEE_B, kneeY - KNEE_B, y);   // y 小 -> 1 大腿
    // 脚必须是刚体：过渡带整体压在鞋口以上（鞋顶约在 ankleY），否则鞋面会被小腿拉伸成拖尾
    const kFt = smoothstep(ankleY - 52, ankleY - 8, y);          // y 大 -> 1 脚
    let kSh = 1 - kTh - kFt;
    if (kSh < 0) kSh = 0;

    // 手臂权重：只在上身、只在躯干两侧的窄带里
    let armW = 0;
    if (y > shoulderY - 30 && y < handY + 30) {
      const inY = smoothstep(shoulderY - 26, shoulderY + 24, y) * smoothstep(handY + 28, handY - 24, y);
      const sideL = 1 - smoothstep(armLIn - 6, armLOut, x);
      const sideR = smoothstep(armRIn, armROut + 6, x);
      armW = inY * Math.max(sideL, sideR) * 0.9;
    }
    const wALr = armW * (1 - sR);
    const wARr = armW * sR;

    const sum = wUp * (1 - armW) + wLeg + wALr + wARr;
    const inv = sum > 1e-6 ? 1 / sum : 0;

    wTorso[k] = wUp * (1 - armW) * inv;
    const wl = wLeg * (1 - sR) * inv, wr = wLeg * sR * inv;
    wLT[k] = wl * kTh; wLS[k] = wl * kSh; wLF[k] = wl * kFt;
    wRT[k] = wr * kTh; wRS[k] = wr * kSh; wRF[k] = wr * kFt;
    wAL[k] = wALr * inv; wAR[k] = wARr * inv;
  }
}

/* --------------------------------------------------------------- 背景绘制 */
const fb = new Uint8Array(W * H * 3);
const put = (x, y, c, a = 1) => {
  x |= 0; y |= 0;
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 3;
  if (a >= 1) { fb[i] = c[0]; fb[i + 1] = c[1]; fb[i + 2] = c[2]; }
  else {
    fb[i] = fb[i] * (1 - a) + c[0] * a;
    fb[i + 1] = fb[i + 1] * (1 - a) + c[1] * a;
    fb[i + 2] = fb[i + 2] * (1 - a) + c[2] * a;
  }
};
const rect = (x0, y0, x1, y1, c, a = 1) => {
  for (let y = Math.max(0, y0 | 0); y <= Math.min(H - 1, y1 | 0); y++)
    for (let x = Math.max(0, x0 | 0); x <= Math.min(W - 1, x1 | 0); x++) put(x, y, c, a);
};
const ellipse = (cx, cy, rx, ry, c, a = 1) => {
  for (let y = Math.max(0, (cy - ry) | 0); y <= Math.min(H - 1, (cy + ry) | 0); y++)
    for (let x = Math.max(0, (cx - rx) | 0); x <= Math.min(W - 1, (cx + rx) | 0); x++)
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) put(x, y, c, a);
};

const drawScene = (camX) => {
  // 墙面
  for (let y = 0; y < GROUND; y++) {
    const k = y / GROUND;
    const c = [250 - 10 * k, 240 - 14 * k, 228 - 14 * k];
    for (let x = 0; x < W; x++) put(x, y, c);
  }
  // 墙板缝（每 96px 一条，滚动参照）
  for (let i = -2; i < 9; i++) {
    const x = i * 96 - (camX % 96);
    rect(x, 60, x + 1.5, GROUND - 26, [236, 224, 206], 0.85);
  }
  // 画框（每 288px 一幅，明确的"走过"参照物）
  for (let i = -2; i < 5; i++) {
    const x = i * 288 - (camX % 288);
    const fy = 210 + ((i % 2 + 2) % 2) * 24;
    rect(x + 44, fy, x + 152, fy + 118, [214, 196, 172]);
    rect(x + 50, fy + 6, x + 146, fy + 112, [238, 228, 212]);
    rect(x + 62, fy + 22, x + 134, fy + 74, [206, 190, 168], 0.7);
    ellipse(x + 98, fy + 92, 22, 12, [214, 198, 176], 0.8);
  }
  // 踢脚线
  rect(0, GROUND - 22, W - 1, GROUND - 1, [226, 212, 192]);
  rect(0, GROUND - 22, W - 1, GROUND - 20, [206, 190, 168]);
  // 地板
  rect(0, GROUND, W - 1, H - 1, [206, 186, 160]);
  // 地板砖缝：越靠近底部（越近）越宽
  for (let i = -2; i < 14; i++) {
    const x = i * 78 - (camX * 1.55) % 78;
    rect(x, GROUND + 2, x + 1.6, H - 1, [186, 165, 138], 0.6);
  }
  rect(0, GROUND + 96, W - 1, GROUND + 98, [190, 169, 142], 0.35);
};

/* ------------------------------------------------------- 骨骼变换与蒙皮求值 */
const mkRot = (srcA, newA, ang, sy = 1) => {
  const c = Math.cos(ang), s = Math.sin(ang);
  return (x, y) => {
    const u = x - srcA.x, v = (y - srcA.y) * sy;
    return [newA.x + u * c - v * s, newA.y + u * s + v * c];
  };
};
const mkMove = (srcA, newA) => (x, y) => [newA.x + (x - srcA.x), newA.y + (y - srcA.y)];

const ease = (s) => s * s * (3 - 2 * s);
const lerp = (a, b, s) => a + (b - a) * s;

/** 步态：返回一条腿在周期内的相位 p(0..1)、支撑/摆动标识、抬脚量 */
const STRIDE = 0.74;                 // 一个完整步态周期（左右各一步）
const SUPPORT = 0.54;                // 支撑相占比
const SPEED = 132;                   // 背景滚动速度（输出 px/s），负责"在前进"的观感

const legPhase = (t, offset) => {
  const p = ((t / STRIDE + offset) % 1 + 1) % 1;
  return p;
};

const buildFrame = (t) => {
  const camX = SPEED * t;

  const bob = Math.sin((t / STRIDE) * Math.PI * 4) * 4.2;   // 每个支撑相一次起伏
  const sway = Math.sin((t / STRIDE) * Math.PI * 2) * 8.0;  // 重心左右转移
  const lean = Math.sin((t / STRIDE) * Math.PI * 2) * 0.016;

  const hipNewTorso = { x: hipX + sway, y: hipY + bob };
  // 腿的锚点不吃 bob：脚必须实实在在踩在地上，不能被身体起伏带着离地
  const hipNewLeg = { x: hipX + sway * 0.35, y: hipY };

  const legTarget = (sgn, p) => {
    const support = p < SUPPORT;
    const swing = support ? 0 : Math.sin(((p - SUPPORT) / (1 - SUPPORT)) * Math.PI);


    const hipS = { x: hipX + sgn * legSep, y: hipY };
    const hipN = { x: hipNewLeg.x + sgn * legSep, y: hipNewLeg.y };

    /* 摆动腿整条骨链向外张 4~6°：绕关节旋转是刚体变换，长度和形状不变，
       所以既能看出"腿打开了"，又不可能再出现切面。髋部锚点位移为 0，不会撕裂裤腰。 */
    const angT = sgn * 0.050 * swing;
    const thighEff = thighLen * (1 - 0.12 * swing);
    const kneeS = { x: hipS.x, y: kneeY };
    const kneeN = {
      x: hipN.x + Math.sin(angT) * thighEff,
      y: hipN.y + Math.cos(angT) * thighEff,
    };

    const syShin = 1 - 0.32 * swing;                       // 摆动相小腿透视缩短
    const shinEff = shinLen * syShin;
    const angS = angT + sgn * 0.040 * swing;
    const ankleN = {
      x: kneeN.x + Math.sin(angS) * shinEff,
      y: kneeN.y + Math.cos(angS) * shinEff,
    };

    return {
      thigh: mkRot(hipS, hipN, angT),
      shin: mkRot(kneeS, kneeN, angS, syShin),
      // 鞋保持纯平移（不旋转）：一转鞋口就和裤腿错开，出现"腿被截断"的折角
      foot: mkMove({ x: hipS.x, y: ankleY }, { x: ankleN.x, y: ankleN.y }),
      hipN, kneeN, ankleN,
    };
  };

  return {
    torso: mkRot({ x: hipX, y: hipY }, hipNewTorso, lean),
    L: legTarget(-1, legPhase(t, 0)),
    R: legTarget(1, legPhase(t, 0.5)),
    // 摆臂：与对侧腿同相（左臂跟右腿），幅度压在 5° 以内，避免"甩手"
    armL: mkRot({ x: (armLIn + armLOut) / 2, y: shoulderY },
      { x: (armLIn + armLOut) / 2, y: shoulderY + bob * 0.8 },
      -0.085 * Math.sin(legPhase(t, 0.5) * Math.PI * 2)),
    armR: mkRot({ x: (armRIn + armROut) / 2, y: shoulderY },
      { x: (armRIn + armROut) / 2, y: shoulderY + bob * 0.8 },
      -0.085 * Math.sin(legPhase(t, 0) * Math.PI * 2)),
    hipNewTorso, hipNewLeg, bob, sway, camX,
  };
};

/* --------------------------------------------------------------- 光栅化 */
const dstX = new Float32Array(NIC), dstY = new Float32Array(NIC);
const offX = 252 - hipX * SCALE;            // 人物横向构图（镜头跟随，人物固定屏幕位置）
const offY = GROUND - footY * SCALE;

const samplePremul = (x, y, out) => {
  if (x < 0 || y < 0 || x >= SW - 1 || y >= SH - 1) { out[3] = 0; return; }
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const i00 = y0 * SW + x0, i10 = i00 + 1, i01 = i00 + SW, i11 = i01 + 1;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  out[0] = pr[i00] * w00 + pr[i10] * w10 + pr[i01] * w01 + pr[i11] * w11;
  out[1] = pg[i00] * w00 + pg[i10] * w10 + pg[i01] * w01 + pg[i11] * w11;
  out[2] = pb[i00] * w00 + pb[i10] * w10 + pb[i01] * w01 + pb[i11] * w11;
  out[3] = pa[i00] * w00 + pa[i10] * w10 + pa[i01] * w01 + pa[i11] * w11;
};

const smp = new Float32Array(4);

/** 把源三角形 (ax,ay).. 光栅化到目标三角形 (bx,by).. */
const tri = (ax, ay, bx, by, cx, cy, Ax, Ay, Bx, By, Cx, Cy) => {
  // 目标三角形包围盒，向外 0.6px 消除共享边缝隙
  let minPX = Math.min(Ax, Bx, Cx) - 0.6, maxPX = Math.max(Ax, Bx, Cx) + 0.6;
  let minPY = Math.min(Ay, By, Cy) - 0.6, maxPY = Math.max(Ay, By, Cy) + 0.6;
  minPX = Math.max(0, Math.floor(minPX)); maxPX = Math.min(W - 1, Math.ceil(maxPX));
  minPY = Math.max(0, Math.floor(minPY)); maxPY = Math.min(H - 1, Math.ceil(maxPY));

  const d = (By - Cy) * (Ax - Cx) + (Cx - Bx) * (Ay - Cy);
  if (Math.abs(d) < 1e-9) return;
  const invD = 1 / d;

  for (let Y = minPY; Y <= maxPY; Y++) {
    const py = Y + 0.5;
    for (let X = minPX; X <= maxPX; X++) {
      const pxc = X + 0.5;
      let a = ((By - Cy) * (pxc - Cx) + (Cx - Bx) * (py - Cy)) * invD;
      let b = ((Cy - Ay) * (pxc - Cx) + (Ax - Cx) * (py - Cy)) * invD;
      let c = 1 - a - b;
      const eps = -0.03;
      if (a < eps || b < eps || c < eps) continue;
      const sx = a * ax + b * bx + c * cx;
      const sy = a * ay + b * by + c * cy;
      samplePremul(sx, sy, smp);
      const al = smp[3];
      if (al <= 0.006) continue;
      const i = ((Y | 0) * W + (X | 0)) * 3;
      fb[i] = smp[0] + fb[i] * (1 - al);
      fb[i + 1] = smp[1] + fb[i + 1] * (1 - al);
      fb[i + 2] = smp[2] + fb[i + 2] * (1 - al);
    }
  }
};

const rasterize = (F, personX) => {
  // 1) 每个控制点求变形后位置
  for (let k = 0; k < NIC; k++) {
    const x = gridSrcX[k], y = gridSrcY[k];
    let nx = 0, ny = 0;
    const wt = wTorso[k];
    if (wt > 0) { const p = F.torso(x, y); nx += wt * p[0]; ny += wt * p[1]; }
    const oL = F.L, oR = F.R;
    let w;
    if ((w = wLT[k]) > 0) { const p = oL.thigh(x, y); nx += w * p[0]; ny += w * p[1]; }
    if ((w = wLS[k]) > 0) { const p = oL.shin(x, y); nx += w * p[0]; ny += w * p[1]; }
    if ((w = wLF[k]) > 0) { const p = oL.foot(x, y); nx += w * p[0]; ny += w * p[1]; }
    if ((w = wRT[k]) > 0) { const p = oR.thigh(x, y); nx += w * p[0]; ny += w * p[1]; }
    if ((w = wRS[k]) > 0) { const p = oR.shin(x, y); nx += w * p[0]; ny += w * p[1]; }
    if ((w = wRF[k]) > 0) { const p = oR.foot(x, y); nx += w * p[0]; ny += w * p[1]; }
    if ((w = wAL[k]) > 0) { const p = F.armL(x, y); nx += w * p[0]; ny += w * p[1]; }
    if ((w = wAR[k]) > 0) { const p = F.armR(x, y); nx += w * p[0]; ny += w * p[1]; }
    dstX[k] = nx * SCALE + offX + personX;
    dstY[k] = ny * SCALE + offY;
  }
  // 2) 逐三角形正向光栅化
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const k00 = j * cols + i, k10 = k00 + 1, k01 = k00 + cols, k11 = k01 + 1;
      const sx00 = gridSrcX[k00], sy00 = gridSrcY[k00];
      const sx10 = gridSrcX[k10], sy10 = gridSrcY[k10];
      const sx01 = gridSrcX[k01], sy01 = gridSrcY[k01];
      const sx11 = gridSrcX[k11], sy11 = gridSrcY[k11];
      tri(sx00, sy00, sx10, sy10, sx11, sy11,
        dstX[k00], dstY[k00], dstX[k10], dstY[k10], dstX[k11], dstY[k11]);
      tri(sx00, sy00, sx11, sy11, sx01, sy01,
        dstX[k00], dstY[k00], dstX[k11], dstY[k11], dstX[k01], dstY[k01]);
    }
  }
};

/* ------------------------------------------------------------------ 出帧 */
const renderFrame = (f) => {
  const t = f / FPS;
  const F = buildFrame(t);
  drawScene(F.camX);
  // 影子：跟随重心
  const shX = (hipX + F.sway) * SCALE + offX;
  ellipse(shX + 4, GROUND + 3, 72, 12, [172, 148, 122], 0.42);
  rasterize(F, 0);
};

if (STILLS) {
  const phases = [0, 0.22, 0.42, 0.62, 0.76, 0.92];
  const out = [];
  for (const p of phases) {
    const f = Math.round(p * STRIDE * FPS);   // 直接按步态相位取样
    renderFrame(f);
    const png = path.join(ROOT, 'output/demo', `_mesh_still_${phases.indexOf(p)}.png`);
    const raw = path.join(TMP, `_s_${phases.indexOf(p)}.rgb`);
    fs.writeFileSync(raw, fb);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      '-s', `${W}x${H}`, '-i', raw, '-frames:v', '1', png]);
    fs.unlinkSync(raw);
    out.push(png);
  }
  // 拼 2x3
  const args = ['-y', '-v', 'error'];
  out.forEach((p) => args.push('-i', p));
  args.push('-filter_complex', '[0][1][2]hstack=3[a];[3][4][5]hstack=3[b];[a][b]vstack=2',
    path.join(ROOT, 'output/demo', `_mesh_stills_${slug}.png`));
  execFileSync('ffmpeg', args);
  console.log('stills ->', path.join(ROOT, 'output/demo', `_mesh_stills_${slug}.png`));
} else {
  const rawPath = path.join(TMP, `walk_${slug}.rgb`);
  const fd = fs.openSync(rawPath, 'w');
  for (let f = 0; f < N; f++) {
    renderFrame(f);
    fs.writeSync(fd, fb);
    if (f % 30 === 0) process.stdout.write(`  frame ${f}/${N}\n`);
  }
  fs.closeSync(fd);

  const outDir = path.join(ROOT, 'output/demo');
  const mp4 = path.join(outDir, `网格走路-${slug}.mp4`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    '-s', `${W}x${H}`, '-r', String(FPS), '-i', rawPath,
    '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', mp4, '-vf', 'fps=1',
    path.join(outDir, `mesh_${slug}_%02d.png`)]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', mp4, '-vf', 'select=eq(n\\,0),scale=540:960',
    path.join(outDir, `mesh_${slug}_cover.png`)]);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(JSON.stringify({ mp4, size: fs.statSync(mp4).size, frames: N, cols, rows }, null, 2));
}
