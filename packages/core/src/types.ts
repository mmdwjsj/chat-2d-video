/**
 * 领域类型（纯 TypeScript，零运行时依赖）。
 *
 * 前端直接 import 这一份类型，server / packages 也用同一份，避免「前端一个
 * Shot、后端另一个 Shot」。所有工厂函数都是纯函数，可在浏览器里安全调用。
 */

export type Language = 'zh' | 'th';
export type ExportMode = 'zh' | 'th' | 'bilingual';
/**
 * 项目语言类型（与导出模式同一个值，全项目唯一真值）：
 * 决定剧本编辑框、配音语种、字幕与最终成片版本。
 * 'zh' 只做中文，'th' 只做泰语，'bilingual' 中泰都做。
 */
export type LanguageMode = ExportMode;
export type ScriptInputMode = 'topic' | 'zh' | 'th' | 'import';

export const LANGUAGE_MODES = ['zh', 'th', 'bilingual'] as const;
export const LANGUAGE_LABELS: Record<LanguageMode, string> = {
  zh: '中文', th: '泰语', bilingual: '双语（中＋泰）',
};
/** 该语言类型下是否显示中文字段（纯函数，浏览器可安全调用）。 */
export const showsZh = (mode: LanguageMode): boolean => mode !== 'th';
/** 该语言类型下是否显示泰语字段。 */
export const showsTh = (mode: LanguageMode): boolean => mode !== 'zh';

export const TASK_STATUSES = [
  'pending', 'analyzing', 'generating', 'processing',
  'completed', 'failed', 'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_TYPES = [
  'project.init', 'script.generate', 'storyboard.split',
  'shot.image', 'shot.audio.zh', 'shot.audio.th', 'video.render',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const SHOT_STATUSES = ['draft', 'queued', 'generating', 'ready', 'failed'] as const;
export type ShotStatus = (typeof SHOT_STATUSES)[number];

/* -------------------------------------------------------------------------- */

export type VoiceConfig = {
  engine: string;
  voice: string;
  /** 语速倍率，1 = 原速 */
  speed: number;
  /** 音量倍率，1 = 原音量 */
  volume: number;
  emotion: string;
};

export type ReferenceImages = {
  front: string;
  side: string;
  back: string;
  fullBody: string;
  halfBody: string;
  face: string;
  expressions: string[];
  actions: string[];
};

export type IdentityLock = {
  enabled: boolean;
  /** 不可变的核心外貌描述，生成任务必须带上 */
  coreAppearance: string;
  notes: string;
};

export type CharacterRelation = { characterId: string; label: string };

export type Character = {
  id: string;
  name: string;
  nameTh: string;
  ageSetting: string;
  occupation: string;
  personality: string;
  background: string;
  referenceImages: ReferenceImages;
  wardrobe: string[];
  accessories: string[];
  voices: { zh: VoiceConfig; th: VoiceConfig };
  relations: CharacterRelation[];
  identityLock: IdentityLock;
  updatedAt: string;
};

export type Scene = {
  id: string;
  name: string;
  type: string;
  location: string;
  time: string;
  weather: string;
  lighting: string;
  backgroundImage: string;
  cameraAngles: string[];
  /** 本地规则分镜按关键词把台词匹配到场景 */
  keywords: string[];
  updatedAt: string;
};

/* -------------------------------------------------------------------------- */

export type ScriptLine = {
  id: string;
  speakerId: string;
  textZh: string;
  textTh: string;
  emotion: string;
  action: string;
  sceneSuggestion: string;
  /** 该行在剧本正文里的原始行号（0 基），供对白行编辑后写回正文；旧数据可缺省。 */
  sourceIndex?: number;
};

export type Script = {
  topic: string;
  inputMode: ScriptInputMode;
  title: string;
  structure: string;
  hook: string;
  cast: { characterId: string; role: string }[];
  lines: ScriptLine[];
  /** 可编辑的双栏完整剧本，互不自动覆盖 */
  zh: string;
  th: string;
  narrationZh: string;
  narrationTh: string;
  emotion: string;
  actionSuggestion: string;
  sceneSuggestions: string[];
  shotCountEstimate: number;
  durationEstimateSec: number;
  /** 一侧改过、另一侧尚未确认时置 true，UI 显示待确认提示 */
  syncPending: boolean;
  updatedAt: string;
};

/* -------------------------------------------------------------------------- */

/**
 * 剧本行为指令：把对白行里「从沙发站起来走到厨房」这类连续行为
 * 拆成带主体、动作、起止锚点与时间的可执行单元。
 * 与 packages/animation 的 ActionCue 结构兼容，避免包之间产生循环依赖。
 */
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

/* -------------------------------------------------------------------------- */

/** 分镜：整个系统的核心数据对象。 */
export type Shot = {
  id: string;
  order: number;
  durationSec: number;
  sceneId: string;
  /** 'auto' = 自动匹配结果；'manual' = 用户手动指定，重新自动分镜时不会被覆盖 */
  sceneSource: 'auto' | 'manual';
  /** 剧本行里用户写的场景提示，自动匹配时权重最高，也用于审阅面板展示依据 */
  sceneHint: string;
  characterIds: string[];
  action: string;
  /** 结构化行为指令；旧数据可缺省，缺省时由 action 文本即时解析 */
  actionCues?: ActionCue[];
  expression: string;
  shotSize: string;
  cameraAngle: string;
  cameraMove: string;
  dialogueZh: string;
  dialogueTh: string;
  narrationZh: string;
  narrationTh: string;
  audioZhPath: string;
  audioThPath: string;
  backgroundImagePath: string;
  generatedImagePath: string;
  generatedVideoPath: string;
  subtitleZh: string;
  subtitleTh: string;
  status: ShotStatus;
  version: number;
  locked: boolean;
  /** 最近一次生成任务，便于追溯模型与成本 */
  lastTaskId: string;
  updatedAt: string;
};

export type ShotVersion = {
  shotId: string;
  version: number;
  path: string;
  note: string;
  savedAt: string;
};

/* -------------------------------------------------------------------------- */

export type Task = {
  id: string;
  projectId: string;
  shotId: string | null;
  type: TaskType;
  status: TaskStatus;
  progress: number;
  error: string;
  attempts: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  provider: string;
  model: string;
  cost: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type AssetMeta = {
  id: string;
  projectId: string | null;
  characterId: string | null;
  slot: string | null;
  kind: 'image' | 'audio' | 'video' | 'music';
  path: string;
  mimeType: string;
  sizeBytes: number;
  sourceTaskId: string | null;
  version: number;
  createdAt: string;
};

export type ProjectMeta = {
  id: string;
  name: string;
  description: string;
  exportMode: ExportMode;
  createdAt: string;
  updatedAt: string;
};

/** 一个项目在工作台里的完整快照。 */
export type ProjectBundle = {
  meta: ProjectMeta;
  characters: Character[];
  scenes: Scene[];
  script: Script;
  shots: Shot[];
};

/* -------------------------------------------------------------------------- */
/* 工厂：新增记录一律走这里，字段不靠 UI 临时拼。 */

export const nowIso = (): string => new Date().toISOString();

export const emptyVoice = (): VoiceConfig => ({
  engine: '', voice: '', speed: 1, volume: 1, emotion: '',
});

export const emptyCharacter = (id: string): Character => ({
  id,
  name: '新人物',
  nameTh: '',
  ageSetting: '',
  occupation: '',
  personality: '',
  background: '',
  referenceImages: {
    front: '', side: '', back: '', fullBody: '', halfBody: '', face: '',
    expressions: [], actions: [],
  },
  wardrobe: [],
  accessories: [],
  voices: { zh: emptyVoice(), th: emptyVoice() },
  relations: [],
  identityLock: { enabled: true, coreAppearance: '', notes: '' },
  updatedAt: nowIso(),
});

export const emptyScene = (id: string): Scene => ({
  id, name: '新场景', type: '', location: '', time: '', weather: '',
  lighting: '', backgroundImage: '', cameraAngles: [], keywords: [],
  updatedAt: nowIso(),
});

export const emptyScript = (): Script => ({
  topic: '', inputMode: 'topic', title: '', structure: '', hook: '',
  cast: [], lines: [], zh: '', th: '', narrationZh: '', narrationTh: '',
  emotion: '', actionSuggestion: '', sceneSuggestions: [],
  shotCountEstimate: 0, durationEstimateSec: 0, syncPending: false,
  updatedAt: nowIso(),
});

export const emptyShot = (order: number, id: string): Shot => ({
  id,
  order,
  durationSec: 4,
  sceneId: '',
  sceneSource: 'auto',
  sceneHint: '',
  characterIds: [],
  action: '',
  expression: '自然',
  shotSize: '中景',
  cameraAngle: '平视',
  cameraMove: '固定',
  dialogueZh: '',
  dialogueTh: '',
  narrationZh: '',
  narrationTh: '',
  audioZhPath: '',
  audioThPath: '',
  backgroundImagePath: '',
  generatedImagePath: '',
  generatedVideoPath: '',
  subtitleZh: '',
  subtitleTh: '',
  status: 'draft',
  version: 1,
  locked: false,
  lastTaskId: '',
  updatedAt: nowIso(),
});
