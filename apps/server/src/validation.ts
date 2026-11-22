import { z } from 'zod';

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional().default(''),
  /** 项目语言类型：与 export_mode 同一个字段，新建时就能定下来。 */
  languageMode: z.enum(['zh', 'th', 'bilingual']).optional(),
});

export const patchProjectSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(1000).optional(),
  exportMode: z.enum(['zh', 'th', 'bilingual']).optional(),
  /** UI 上叫「语言类型」，语义等同 exportMode。 */
  languageMode: z.enum(['zh', 'th', 'bilingual']).optional(),
}).strict();

export const charactersSchema = z.object({
  characters: z.array(z.record(z.unknown())).max(20),
}).strict();

export const scenesSchema = z.object({
  scenes: z.array(z.record(z.unknown())).max(200),
}).strict();

/** 完整剧本：只锁定关键双语字段，其余字段透传给 core。 */
export const scriptSchema = z.object({
  script: z.object({
    zh: z.string(),
    th: z.string(),
    lines: z.array(z.record(z.unknown())).optional().default([]),
  }).passthrough(),
}).strict();

export const generateScriptSchema = z.object({
  topic: z.string().trim().max(200).optional().default(''),
  inputMode: z.enum(['topic', 'zh', 'th', 'import']).optional().default('topic'),
  textZh: z.string().max(8000).optional(),
  textTh: z.string().max(8000).optional(),
  /** 缺省时由服务端按项目当前语言类型决定。 */
  languageMode: z.enum(['zh', 'th', 'bilingual']).optional(),
}).strict();

export const syncScriptSchema = z.object({
  from: z.enum(['zh', 'th']),
}).strict();

/** 单镜头 patch 用白名单，禁止前端改写 id / order / version / lastTaskId。 */
export const shotPatchSchema = z.object({
  durationSec: z.number().min(0.5).max(60).optional(),
  sceneId: z.string().max(120).optional(),
  /** 手动选场景 / 恢复自动时由前端写入；sceneHint 是自动分镜产物，不允许前端改 */
  sceneSource: z.enum(['auto', 'manual']).optional(),
  characterIds: z.array(z.string()).max(6).optional(),
  action: z.string().max(500).optional(),
  expression: z.string().max(120).optional(),
  shotSize: z.string().max(120).optional(),
  cameraAngle: z.string().max(120).optional(),
  cameraMove: z.string().max(120).optional(),
  dialogueZh: z.string().max(2000).optional(),
  dialogueTh: z.string().max(2000).optional(),
  narrationZh: z.string().max(2000).optional(),
  narrationTh: z.string().max(2000).optional(),
  audioZhPath: z.string().max(500).optional(),
  audioThPath: z.string().max(500).optional(),
  backgroundImagePath: z.string().max(500).optional(),
  generatedImagePath: z.string().max(500).optional(),
  generatedVideoPath: z.string().max(500).optional(),
  subtitleZh: z.string().max(2000).optional(),
  subtitleTh: z.string().max(2000).optional(),
  status: z.enum(['draft', 'queued', 'generating', 'ready', 'failed']).optional(),
  locked: z.boolean().optional(),
}).strict();

export const reorderSchema = z.object({
  orderedIds: z.array(z.string()).min(1).max(200),
}).strict();

export const restoreSchema = z.object({
  version: z.number().int().positive(),
}).strict();

export const regenerateSchema = z.object({
  kind: z.enum(['image', 'audio.zh', 'audio.th']),
}).strict();

/** 视频导出：缺省 mode 时以项目语言类型为准。 */
export const renderVideoSchema = z.object({
  mode: z.enum(['zh', 'th', 'bilingual']).optional(),
}).strict();

export const uploadImageSchema = z.object({
  fileName: z.string().max(200).optional(),
  base64: z.string().min(1).max(25_000_000),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
  projectId: z.string().max(120).optional(),
  characterId: z.string().max(120).optional(),
  slot: z.string().max(120).optional(),
}).strict();

/** 动画资产上传：目标槽位用白名单枚举，禁止任意写路径。 */
const assetId = z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/);

export const animationAssetTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('characterPose'), id: assetId,
    key: z.enum(['stand', 'sit', 'walk1', 'walk2', 'turn', 'back']),
  }).strict(),
  z.object({ kind: z.literal('sceneBackground'), id: assetId }).strict(),
  z.object({
    kind: z.literal('sceneLayer'), id: assetId,
    key: z.enum(['sky', 'far', 'mid', 'near', 'foreground']),
  }).strict(),
]);

export const uploadAnimationAssetSchema = z.object({
  fileName: z.string().max(200).optional(),
  base64: z.string().min(1).max(25_000_000),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
  target: animationAssetTargetSchema,
}).strict();

export const clearAnimationAssetSchema = z.object({
  target: animationAssetTargetSchema,
}).strict();

export const parseOrThrow = <T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> => {
  const result = schema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    throw Object.assign(new Error(`参数不合法：${first?.path.join('.') || 'body'} ${first?.message ?? ''}`), {
      statusCode: 400,
    });
  }
  return result.data;
};
