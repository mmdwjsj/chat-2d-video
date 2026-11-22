/**
 * 分层动画帧：把 FrameDirector 求出的 FrameState 画成 1080×1920 HTML。
 *
 * 与 sceneArt.buildFrame 并存、互不影响：老链路（4 档口型静帧）继续服务片头/片尾/回退，
 * 本文件只服务「有动作的对白镜头」。自带分层场景 SVG，不改动 sceneArt.ts，
 * 因此现有渲染与 96 个测试零回归。
 *
 * 关键点：场景拆成 sky/far/mid/near/foreground 五层，各层按 parallax 分摊位移；
 * 人物按 pose 图 + 变换渲染，前景层盖在人物之上形成遮挡；口型沿用实测标定口径。
 */
import type { ExportMode, Scene } from '@thai-video/core/types';
import type {
  CharacterRig, FrameState, MouthShape, RigPose, SceneLayer, SceneSpec,
} from '@thai-video/animation';
import { FRAME_HEIGHT, FRAME_WIDTH, paletteFor } from './sceneArt.js';

const esc = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const PERSON_W = 420;
const PERSON_H = 780;
const PARALLAX_PX = 260;

export type AnimatedFrameInput = {
  projectTitle: string;
  mode: ExportMode;
  index: number;
  total: number;
  durationSec: number;
  scene?: Scene | null;
  sceneSpec: SceneSpec;
  frame: FrameState;
  rigs: Record<string, CharacterRig | null>;
  characters: { id: string; name: string; nameTh?: string }[];
  speakingId: string;
  primarySubtitle: string;
  secondarySubtitle: string;
  /** 导出用 data URI，界面预览用 /assets URL；由调用方注入，避免把 node:fs 拖进前端 */
  resolveImage: (src: string) => string;
  degradations?: string[];
};

type Palette = ReturnType<typeof paletteFor>;

/** 每一层独立 SVG，位移由 frame.sceneOffset × layer.parallax 决定。 */
const layerSvg = (
  kind: string, p: Palette, offsetPx: number,
): string => {
  const shift = `transform:translate3d(${offsetPx.toFixed(1)}px,0,0)`;
  const open = `<svg class="layer" viewBox="0 0 ${FRAME_WIDTH} ${FRAME_HEIGHT}" preserveAspectRatio="xMidYMid slice" style="${shift}" xmlns="http://www.w3.org/2000/svg">`;
  switch (kind) {
    case 'sky':
      return `${open}<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${p.skyTop}"/><stop offset="52%" stop-color="${p.skyMid}"/>
        <stop offset="100%" stop-color="${p.skyBottom}"/></linearGradient>
        <radialGradient id="glow"><stop offset="0%" stop-color="${p.glow}" stop-opacity="0.9"/>
        <stop offset="100%" stop-color="${p.glow}" stop-opacity="0"/></radialGradient></defs>
        <rect width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" fill="url(#sky)"/>
        <circle cx="850" cy="300" r="170" fill="url(#glow)"/>
        ${p.night ? `<circle cx="820" cy="280" r="72" fill="${p.glow}" opacity="0.8"/>` : ''}
        </svg>`;
    case 'far':
      return `${open}${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => {
        const x = -40 + i * 140;
        const h = 220 + ((i * 73) % 280);
        return `<rect x="${x}" y="${1180 - h}" width="${110 + (i % 3) * 18}" height="${h + 40}" rx="4" fill="${i % 2 ? p.silhouette2 : p.silhouette}" opacity="0.72"/>`;
      }).join('')}</svg>`;
    case 'mid':
      return `${open}<g opacity="0.9">
        <rect x="60" y="1290" width="320" height="210" rx="12" fill="${p.silhouette}" opacity="0.8"/>
        <rect x="700" y="1320" width="320" height="180" rx="12" fill="${p.silhouette2}" opacity="0.8"/>
        <rect x="420" y="1210" width="240" height="120" rx="10" fill="${p.accent}" opacity="0.35"/>
        <circle cx="540" cy="620" r="210" fill="${p.glow}" opacity="0.12"/>
        ${p.night ? [120, 300, 480, 660, 840, 1000].map((x, i) =>
          `<circle cx="${x}" cy="${230 + (i % 2) * 60}" r="22" fill="${p.accent}" opacity="0.75"/>`).join('') : ''}
        </g></svg>`;
    case 'near':
      return `${open}<defs><linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${p.ground}" stop-opacity="0"/>
        <stop offset="100%" stop-color="${p.ground}" stop-opacity="0.92"/></linearGradient></defs>
        <rect x="0" y="1180" width="${FRAME_WIDTH}" height="740" fill="url(#ground)"/>
        <ellipse cx="540" cy="1560" rx="520" ry="80" fill="${p.glow}" opacity="0.14"/></svg>`;
    case 'foreground':
      // 底部前景遮挡：人物走过时下半身被挡住，产生真实的空间层次
      return `${open}<rect x="-120" y="1690" width="1320" height="230" rx="40" fill="${p.silhouette}" opacity="0.55"/>
        <rect x="760" y="1560" width="300" height="170" rx="24" fill="${p.silhouette2}" opacity="0.6"/></svg>`;
    default:
      return `${open}</svg>`;
  }
};

/**
 * 单层渲染：配了 src 就用真图（仍参与 parallax 视差），否则画程序化 SVG。
 * 真图左右外扩 PARALLAX_PX，保证视差位移时不露白边；object-fit 由 layer.fit 决定。
 */
const layerHtml = (
  layer: SceneLayer, p: Palette, offsetPx: number,
  resolveImage: (src: string) => string, isFg: boolean,
): string => {
  const cls = isFg ? 'layer fg' : 'layer';
  if (!layer.src) {
    return layerSvg(layer.kind, p, offsetPx).replace('class="layer"', `class="${cls}"`);
  }
  const shift = `transform:translate3d(${offsetPx.toFixed(1)}px,0,0)`;
  const fit = layer.fit === 'contain' ? 'contain' : 'cover';
  const opacity = layer.opacity ?? 1;
  const pad = PARALLAX_PX;
  return `<div class="${cls}" style="left:-${pad}px;right:-${pad}px;width:calc(100% + ${pad * 2}px);${shift};opacity:${opacity}">
    <img class="layer-img" src="${esc(resolveImage(layer.src))}" alt="${esc(layer.key)}" style="object-fit:${fit}"/></div>`;
};

const mouthOverlay = (rig: CharacterRig, pose: RigPose, shape: MouthShape): string => {
  if (!pose.mouth || !pose.mouthW) return '';
  const w = rig.width;
  const h = rig.height;
  const cx = pose.mouth[0] * w;
  const cy = pose.mouth[1] * h;
  const mw = pose.mouthW * w;
  const skin = esc(pose.skin ?? '#e2b78f');
  const patchH = Math.max(mw * 0.28, 10);
  const r = (n: number): number => Math.round(n * 100) / 100;
  const patch = `<rect x="${r(cx - mw * 0.72)}" y="${r(cy - patchH / 2)}" width="${r(mw * 1.44)}" height="${r(patchH)}" rx="${r(patchH / 2)}" fill="${skin}"/>`;
  let mouth: string;
  if (shape === 'closed') {
    mouth = `<path d="M${r(cx - mw * 0.45)} ${r(cy)} Q${r(cx)} ${r(cy + mw * 0.22)} ${r(cx + mw * 0.45)} ${r(cy)}" fill="none" stroke="#3a2a2a" stroke-width="${r(Math.max(2, mw * 0.06))}" stroke-linecap="round"/>`;
  } else {
    const sizes: Record<Exclude<MouthShape, 'closed'>, [number, number]> = {
      small: [1.05, 0.26], open: [1.18, 0.46], wide: [1.28, 0.68],
    };
    const [wr, hr] = sizes[shape];
    const bw = mw * wr;
    const bh = mw * hr;
    mouth = `<rect x="${r(cx - bw / 2)}" y="${r(cy - bh * 0.42)}" width="${r(bw)}" height="${r(bh)}" rx="${r(bh / 2)}" fill="#5e2c34" stroke="#3a2a2a" stroke-width="${r(Math.max(2, mw * 0.06))}"/>`;
  }
  return `<svg class="mouth" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMax meet" xmlns="http://www.w3.org/2000/svg">${patch}${mouth}</svg>`;
};

const actorHtml = (
  input: AnimatedFrameInput, actorId: string,
): string => {
  const rig = input.rigs[actorId];
  const state = input.frame.actors.find((a) => a.id === actorId);
  if (!rig || !state) return '';
  const pose = rig.poses[state.pose] ?? rig.poses[rig.defaultPose];
  if (!pose) return '';
  const src = input.resolveImage(pose.src);
  const x = state.x * FRAME_WIDTH;
  const y = state.y * FRAME_HEIGHT;
  const bottom = FRAME_HEIGHT - input.sceneSpec.baseline;
  const mouth = actorId === input.speakingId
    ? mouthOverlay(rig, pose, input.frame.mouth) : '';
  return `<div class="actor" style="left:calc(50% + ${x.toFixed(1)}px);bottom:${bottom.toFixed(1)}px;
      transform:translateX(-50%) translateY(${(-y).toFixed(1)}px) rotate(${state.rotate.toFixed(2)}deg) scale(${state.scale.toFixed(3)});opacity:${state.opacity}">
    <div class="actor-img"><img src="${esc(src)}" alt="${esc(rig.name)}"/>${mouth}</div>
  </div>`;
};

const MODE_LABEL: Record<ExportMode, string> = {
  zh: '中文版', th: 'ไทย / 泰语版', bilingual: '中泰双语版',
};

/** 生成一帧完整 HTML；调用方按 frameKey 截图，相同 frameKey 只截一次。 */
export const buildAnimatedFrame = (input: AnimatedFrameInput): string => {
  const p = paletteFor({ ...(input.scene ?? {}), id: input.sceneSpec.palette } as Scene);
  const main = (input.primarySubtitle ?? '').trim();
  const secondary = (input.secondarySubtitle ?? '').trim();
  const mainSize = main.length > 60 ? 42 : main.length > 38 ? 50 : main.length > 22 ? 58 : 66;
  const secondarySize = secondary.length > 60 ? 30 : 36;
  const speaker = input.characters.find((c) => c.id === input.speakingId);
  const speakerName = speaker
    ? (input.mode === 'th' ? (speaker.nameTh || speaker.name) : speaker.name) : '';
  const sceneLabel = input.mode === 'th'
    ? (input.scene?.name ?? 'กรุงเทพมหานคร')
    : (input.scene?.name ?? p.label);

  const backgroundImage = input.sceneSpec.backgroundImage;
  const hasBackground = Boolean(backgroundImage);
  const layerAt = (l: SceneLayer, isFg: boolean): string =>
    layerHtml(l, p, input.frame.sceneOffset * l.parallax * PARALLAX_PX, input.resolveImage, isFg);
  // 有整张真底图时，未配 src 的程序化色块层让位，避免盖住真图。
  const visible = input.sceneSpec.layers.filter((l) => l.src || !hasBackground);
  const layers = visible
    .filter((l) => l.kind !== 'foreground')
    .map((l) => layerAt(l, false))
    .join('');
  const foreground = visible
    .filter((l) => l.kind === 'foreground')
    .map((l) => layerAt(l, true))
    .join('');
  // 整张底图垫在所有层之下，不参与视差；分层真图仍各自按 parallax 移动。
  const background = backgroundImage
    ? `<img class="bg" src="${esc(input.resolveImage(backgroundImage))}" alt=""/>`
    : '';
  const actors = input.frame.actors.map((a) => actorHtml(input, a.id)).join('');

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${FRAME_WIDTH}px;height:${FRAME_HEIGHT}px;overflow:hidden;background:${p.skyTop}}
body{font-family:"Microsoft YaHei","Leelawadee UI","Segoe UI",sans-serif;color:${p.text};position:relative}
.layer{position:absolute;inset:0;width:100%;height:100%;will-change:transform}
.layer-img{position:absolute;inset:0;width:100%;height:100%;display:block}
.bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0}
.fg{z-index:3;pointer-events:none}
.vignette{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 42%,transparent 34%,rgba(12,10,20,.4) 100%)}
.actor{position:absolute;width:${PERSON_W}px;height:${PERSON_H}px;transform-origin:bottom center;z-index:2}
.actor-img{position:relative;width:100%;height:100%;display:flex;align-items:flex-end;justify-content:center;overflow:hidden}
.actor-img img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;object-position:center bottom;
  filter:drop-shadow(0 16px 30px rgba(0,0,0,.35))}
.mouth{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none}
.top{position:absolute;top:64px;left:64px;right:64px;display:flex;justify-content:space-between;z-index:4;text-shadow:0 2px 14px rgba(0,0,0,.45)}
.brand{font-size:26px;letter-spacing:3px;opacity:.82}
.title{font-size:46px;font-weight:800;margin-top:10px;line-height:1.25;max-width:720px}
.badge{margin-top:14px;display:inline-block;padding:8px 20px;border-radius:999px;font-size:24px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.34)}
.shotno{text-align:right;min-width:200px}
.shotno b{font-size:72px;letter-spacing:2px;line-height:1;font-weight:800}
.shotno span{display:block;font-size:24px;opacity:.82;margin-top:12px}
.caption{position:absolute;left:0;right:0;bottom:0;height:660px;z-index:5;
  background:linear-gradient(180deg,rgba(9,10,18,0) 0%,rgba(9,10,18,.62) 34%,rgba(9,10,18,.92) 100%)}
.caption-inner{position:absolute;left:76px;right:76px;bottom:132px;text-align:center}
.speaker{display:inline-block;margin-bottom:22px;padding:10px 30px;border-radius:14px;font-size:28px;font-weight:700;background:${p.accent};color:#1b1420}
.main{font-size:${mainSize}px;font-weight:800;line-height:1.42;text-shadow:0 3px 18px rgba(0,0,0,.75);word-break:break-word}
.secondary{margin-top:22px;font-size:${secondarySize}px;line-height:1.5;opacity:.86;text-shadow:0 2px 12px rgba(0,0,0,.7);word-break:break-word}
.meta{position:absolute;left:76px;right:76px;bottom:62px;display:flex;justify-content:space-between;font-size:22px;opacity:.72}
.progress{position:absolute;left:76px;right:76px;bottom:44px;height:6px;border-radius:6px;background:rgba(255,255,255,.22)}
.progress i{display:block;height:100%;border-radius:6px;background:${p.accent}}
</style></head>
<body data-frame-key="${esc(input.frame.frameKey)}" data-degradations="${esc((input.degradations ?? []).join(' | '))}">
${background}${layers}<div class="vignette"></div>
<div class="top"><div>
  <div class="brand">THAI DAILY LIFE · 泰日常</div>
  <div class="title">${esc(input.projectTitle)}</div>
  <div class="badge">${esc(sceneLabel)} · ${esc(MODE_LABEL[input.mode])}</div>
</div><div class="shotno"><b>NO.${String(input.index).padStart(2, '0')}</b>
  <span>${input.index} / ${input.total} · ${(input.durationSec ?? 0).toFixed(1)}s</span></div></div>
${actors}
${foreground}
<div class="caption"></div>
<div class="caption-inner">
  ${main && speakerName ? `<div class="speaker">${esc(speakerName)}</div>` : ''}
  <div class="main">${esc(main)}</div>
  ${secondary ? `<div class="secondary">${esc(secondary)}</div>` : ''}
</div>
<div class="meta"><span>${esc(sceneLabel)}</span><span>动画帧 · ${esc(input.frame.frameKey)}</span></div>
<div class="progress"><i style="width:${Math.round((input.index / Math.max(1, input.total)) * 100)}%"></i></div>
</body></html>`;
};
