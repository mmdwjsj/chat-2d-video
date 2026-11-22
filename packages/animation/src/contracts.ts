/**
 * 动画数据契约（纯 TypeScript，零运行时依赖）。
 *
 * 设计要点：渲染器只认这份契约，不认任何具体人物 / 场景 id。
 * 新增人物、场景、动作 = 往 config/animation.json 追加注册项 + 放图片，代码不改。
 * 与 core/types.ts 的 ActionCue 保持结构兼容，避免包之间产生循环依赖。
 */

export type MouthShape = 'closed' | 'small' | 'open' | 'wide';

/** 单个姿态：一张图 + 该图自己的锚点与嘴部标定。 */
export type RigPose = {
  key: string;
  /** 相对项目根的图片路径 */
  src: string;
  /** 归一化重心/脚底锚点，[x, y] ∈ 0..1 */
  anchor: [number, number];
  /** 归一化嘴部中心；背面等无正脸姿态可省略 */
  mouth?: [number, number];
  /** 归一化嘴宽；省略时不画口型 */
  mouthW?: number;
  /** 原图肤色，用来盖掉静态嘴 */
  skin?: string;
};

export type CharacterRig = {
  id: string;
  name: string;
  width: number;
  height: number;
  defaultPose: string;
  poses: Record<string, RigPose>;
};

export type LayerKind = 'sky' | 'far' | 'mid' | 'near' | 'foreground';

export type SceneLayer = {
  key: string;
  kind: LayerKind;
  /** 视差系数，0 = 不动，1 = 跟相机全量位移 */
  parallax: number;
  /** 相对项目根的图片路径；填了就用真图替代该层的程序化 SVG，留空则程序化生成 */
  src?: string;
  /** 图片铺法，默认 cover */
  fit?: 'cover' | 'contain';
  /** 该层不透明度，默认 1 */
  opacity?: number;
};

export type SceneSpec = {
  id: string;
  /** 指向 sceneArt 已知的配色 id；新场景可显式指定，不再靠关键词猜 */
  palette: string;
  /** 整张场景底图（相对项目根）；填了就以它为主背景，程序化色块层自动让位 */
  backgroundImage?: string;
  layers: SceneLayer[];
  /** 归一化空间锚点，如 sofa / door / kitchen */
  anchors: Record<string, [number, number]>;
  /** 人物脚底 y（像素，1080×1920 画布） */
  baseline: number;
};

/** 动作 clip：姿态阶段 + 位移 + 起伏，帧与帧之间由 director 量化插值。 */
export type ActionClip = {
  id: string;
  poses: string[];
  /** 量化阶段数（上限 6），决定帧档数量与截图次数 */
  phases: number;
  from?: string;
  to?: string;
  /** 归一化位移 [dx, dy] */
  move?: [number, number];
  /** 起伏幅度（像素） */
  bob?: number;
  /** 摆动角度（度） */
  rotate?: number;
  transition?: 'cut' | 'slide' | 'fade';
};

/** 剧本行为指令：从对白行的 action 文本解析而来。 */
export type ActionCue = {
  actorId: string;
  verb: string;
  clipId: string;
  from?: string;
  to?: string;
  target?: string;
  startSec: number;
  durationSec: number;
};

/** 单个视频帧的完整状态。 */
export type FrameState = {
  frameKey: string;
  /** 场景整体位移，-1..1，供各层按 parallax 分摊 */
  sceneOffset: number;
  actors: ActorState[];
  mouth: MouthShape;
};

export type ActorState = {
  id: string;
  pose: string;
  /** 归一化屏幕偏移 */
  x: number;
  y: number;
  scale: number;
  rotate: number;
  opacity: number;
};

export type AnimationDefaults = {
  layers: SceneLayer[];
  baseline: number;
  anchors: Record<string, [number, number]>;
};

export type AnimationRegistry = {
  schemaVersion: number;
  enabled: boolean;
  defaults: AnimationDefaults;
  characters: Record<string, CharacterRig>;
  scenes: Record<string, SceneSpec>;
  actions: Record<string, ActionClip>;
};

export type ResolveResult<T> = {
  value: T;
  /** 显式降级说明；非空时必须出现在导出结果里，不允许静默吞掉 */
  degradations: string[];
};

export const DEFAULT_CLIP_ID = 'idle';
