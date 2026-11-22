import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createWorkbench, P } from '@thai-video/core';
import { renderEnvironment } from '@thai-video/video-renderer';
import type { Character, ExportMode, Scene, Script, Shot } from '@thai-video/core/types';
import { registerHandlers } from './handlers.js';
import { buildPreviewFrames } from './previewFrames.js';
import * as V from './validation.js';
import {
  applyUpload, clearSlot, loadSlots,
} from './animationAssets.js';
import type { AssetTarget } from './animationAssets.js';
import { loadStudio, saveStudio } from './sceneStudio.js';

export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const wrap = (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).catch(next);
  };

const inferStatus = (message: string): number => {
  if (message.includes('锁定')) return 409;
  if (message.includes('不存在') || message.includes('丢失')) return 404;
  if (message.includes('不合法') || message.includes('不能')) return 400;
  return 500;
};

type OutputFile = {
  path: string;
  url: string;
  sizeBytes: number;
  modifiedAt: string;
  kind: 'video' | 'audio' | 'image' | 'other';
  projectId: string;
};

const outputKind = (name: string): OutputFile['kind'] => {
  if (/\.(mp4|webm|mov|mkv)$/i.test(name)) return 'video';
  if (/\.(wav|mp3|m4a|aac)$/i.test(name)) return 'audio';
  if (/\.(png|jpe?g|webp|gif)$/i.test(name)) return 'image';
  return 'other';
};

/** 成片目录清单：只扫描 output/，不接收外部路径，供导出页直接播放/下载。 */
const listOutputs = (): OutputFile[] => {
  const root = P.outputDir();
  if (!fs.existsSync(root)) return [];
  const files: OutputFile[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || files.length >= 200) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= 200) return;
      const full = path.join(dir, entry.name);
      // 渲染中间产物、系统隐藏目录不出现在成片列表里
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(full);
      const rel = path.relative(root, full).split(path.sep).join('/');
      const first = rel.split('/')[0] ?? '';
      files.push({
        path: rel,
        url: `/output/${rel.split('/').map(encodeURIComponent).join('/')}`,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        kind: outputKind(entry.name),
        projectId: /^proj-/.test(first) ? first : '',
      });
    }
  };
  walk(root, 0);
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
};

export const createApp = () => {
  const wb = createWorkbench();
  const runtime = registerHandlers(wb);
  const renderEnv = renderEnvironment();
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  const runTask = async (taskId: string) => {
    const done = await wb.queue.runNow(taskId);
    if (done.status !== 'completed') {
      throw new HttpError(400, done.error || '生成任务未完成，请到任务页查看或重试');
    }
    return done;
  };

  /* ---------------------------- 基础 ---------------------------- */
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, product: 'thai-daily-life-ai-video', phase: 1 });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      app: wb.config,
      providers: wb.providers,
      capabilities: {
        text: runtime.providers.text.id,
        image: runtime.providers.image.available,
        video: runtime.providers.video.available,
        tts: runtime.tts.available,
        videoExport: renderEnv.available,
        renderer: {
          browser: renderEnv.browser,
          ffmpeg: renderEnv.ffmpeg,
          ffprobe: renderEnv.ffprobe,
          reason: renderEnv.reason,
        },
      },
      notes: [
        '文本用本地规则 Provider，无需密钥。',
        '项目语言类型（中文 / 泰语 / 双语）决定剧本框、台词、配音与成片版本。',
        'MP4 导出已启用：HTML/SVG 画面 → Edge 截图 → FFmpeg H.264/AAC 合成，无需密钥。',
        '未配置 TTS 时不伪造人声：成片为字幕 + 本地合成氛围音，结果里会如实标注。',
      ],
    });
  });

  /**
   * 人物六视图资源库：清单本体是 assets/characters/library/index.json。
   * 前端「从资源库选人」只认这里返回的路径；缺图或越界路径一律置空，
   * 免得选完出现一堆裂图。往 library/ 里加人只要改 index.json，不用动代码。
   */
  const LIBRARY_SLOTS = ['front', 'side', 'back', 'fullBody', 'halfBody', 'face'] as const;
  type RawLibraryEntry = {
    id: string; slug: string; name: string; nameTh?: string;
    cover?: string; images?: Record<string, unknown>; template?: Record<string, unknown>;
  };
  app.get('/api/character-library', (_req, res) => {
    const file = path.join(P.root, 'assets', 'characters', 'library', 'index.json');
    if (!fs.existsSync(file)) { res.json({ slots: [], characters: [] }); return; }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      slots?: { key: string; label: string }[];
      characters?: RawLibraryEntry[];
    };
    const safeImage = (value: unknown): string => {
      if (typeof value !== 'string') return '';
      if (!/^assets\/characters\/library\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.(png|jpe?g|webp)$/i.test(value)) return '';
      return fs.existsSync(path.join(P.root, value)) ? value : '';
    };
    const characters = (raw.characters ?? []).map((entry) => {
      const images: Record<string, string> = {};
      for (const slot of LIBRARY_SLOTS) images[slot] = safeImage(entry.images?.[slot]);
      return {
        id: entry.id,
        slug: entry.slug,
        name: entry.name,
        nameTh: entry.nameTh ?? '',
        cover: safeImage(entry.cover) || images.fullBody || images.front,
        images,
        template: entry.template ?? {},
      };
    });
    res.json({ slots: raw.slots ?? [], characters });
  });

  /** 成片在哪看：返回 output 绝对路径与该目录下已有的文件清单。 */
  app.get('/api/outputs', (_req, res) => {
    res.json({ dir: P.outputDir(), files: listOutputs() });
  });

  /**
   * 成片下载：强制 attachment，文件名保留中文原名。
   * 只接受 output/ 目录内的相对路径；缺失或越界返回 404 JSON，绝不回退成 HTML 页面。
   */
  app.get('/api/outputs/download', (req, res) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    const root = P.outputDir();
    const full = path.resolve(root, rel);
    const inside = path.relative(root, full);
    const segments = rel.split(/[\\/]/);
    const unsafe = !rel
      || path.isAbsolute(rel)
      || inside.startsWith('..')
      || path.isAbsolute(inside)
      || segments.some((part) => !part || part.startsWith('.'));
    if (unsafe || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.status(404).json({ error: `成片不存在或路径不合法：${rel || '(未指定 path)'}` });
      return;
    }
    res.download(full, path.basename(full), (error) => {
      if (error && !res.headersSent) {
        res.status(500).json({ error: `读取成片失败：${error.message}` });
      }
    });
  });

  /* ---------------------------- 项目 ---------------------------- */
  app.get('/api/projects', (_req, res) => res.json({ projects: wb.projects.list() }));

  app.post('/api/projects', wrap((req, res) => {
    const input = V.parseOrThrow(V.createProjectSchema, req.body);
    res.status(201).json({ project: wb.projects.create(input.name, input.description, input.languageMode) });
  }));

  app.get('/api/projects/:id', wrap((req, res) => {
    res.json({ project: wb.projects.get(req.params.id) });
  }));

  app.patch('/api/projects/:id', wrap((req, res) => {
    const patch = V.parseOrThrow(V.patchProjectSchema, req.body);
    const { languageMode, ...rest } = patch;
    res.json({ meta: wb.projects.patch(req.params.id, {
      ...rest, ...(languageMode ? { exportMode: languageMode } : {}),
    }) });
  }));

  app.post('/api/projects/:id/duplicate', wrap((req, res) => {
    res.status(201).json({ project: wb.projects.duplicate(req.params.id) });
  }));

  app.delete('/api/projects/:id', wrap((req, res) => {
    wb.projects.remove(req.params.id);
    res.json({ ok: true });
  }));

  app.put('/api/projects/:id/characters', wrap((req, res) => {
    const input = V.parseOrThrow(V.charactersSchema, req.body);
    res.json({ characters: wb.projects.saveCharacters(req.params.id, input.characters as unknown as Character[]) });
  }));

  app.put('/api/projects/:id/scenes', wrap((req, res) => {
    const input = V.parseOrThrow(V.scenesSchema, req.body);
    res.json({ scenes: wb.projects.saveScenes(req.params.id, input.scenes as unknown as Scene[]) });
  }));

  /* ---------------------------- 剧本 ---------------------------- */
  app.get('/api/projects/:id/script', wrap((req, res) => {
    res.json({ script: wb.script.get(req.params.id) });
  }));

  app.put('/api/projects/:id/script', wrap((req, res) => {
    const input = V.parseOrThrow(V.scriptSchema, req.body);
    res.json({ script: wb.script.save(req.params.id, input.script as unknown as Script) });
  }));

  app.post('/api/projects/:id/script/sync', wrap((req, res) => {
    const input = V.parseOrThrow(V.syncScriptSchema, req.body);
    res.json({ script: wb.script.sync(req.params.id, input.from) });
  }));

  app.post('/api/projects/:id/script/dismiss-sync', wrap((req, res) => {
    res.json({ script: wb.script.dismissSync(req.params.id) });
  }));

  app.post('/api/projects/:id/script/generate', wrap(async (req, res) => {
    const input = V.parseOrThrow(V.generateScriptSchema, req.body);
    const task = wb.queue.enqueue({
      projectId: req.params.id, type: 'script.generate',
      payload: input as unknown as Record<string, unknown>,
      provider: runtime.providers.text.id,
    });
    const done = await runTask(task.id);
    res.json({ task: done, script: wb.script.get(req.params.id) });
  }));

  /* ---------------------------- 分镜 ---------------------------- */
  app.get('/api/projects/:id/shots', wrap((req, res) => {
    res.json({ shots: wb.storyboard.list(req.params.id) });
  }));

  /**
   * 界面预览的画面（预览页 + 分镜页共用）：
   * 服务端用成片同一个 buildFrame 生成四档口型 HTML 和逐帧时间轴，
   * 前端只负责按时切换，不再自己画背景/人物/字幕，避免预览与成片两套画面。
   * 图片用 /assets URL，不内联 base64，响应很小；不写盘、不启动浏览器。
   */
  app.get('/api/projects/:id/preview-frames', wrap((req, res) => {
    const bundle = wb.projects.get(req.params.id);
    const meta = wb.projects.meta(req.params.id);
    const rawMode = typeof req.query.mode === 'string' ? req.query.mode : '';
    const mode: ExportMode = (['zh', 'th', 'bilingual'].includes(rawMode)
      ? rawMode : meta.exportMode) as ExportMode;
    res.json(buildPreviewFrames({
      bundle, mode, fps: wb.config.video.fps, projectTitle: meta.name,
    }));
  }));

  app.post('/api/projects/:id/storyboard/split', wrap(async (req, res) => {
    const task = wb.queue.enqueue({
      projectId: req.params.id, type: 'storyboard.split',
      provider: runtime.providers.text.id,
    });
    const done = await runTask(task.id);
    res.json({ task: done, shots: wb.storyboard.list(req.params.id) });
  }));

  app.put('/api/projects/:id/shots', wrap((req, res) => {
    const body = req.body as { shots?: unknown };
    if (!Array.isArray(body.shots)) throw new HttpError(400, 'shots 必须是数组');
    res.json({ shots: wb.storyboard.replaceAll(req.params.id, body.shots as Shot[]) });
  }));

  app.post('/api/projects/:id/shots', wrap((req, res) => {
    const body = req.body as { atOrder?: number };
    res.status(201).json({ shot: wb.storyboard.addShot(req.params.id, body.atOrder) });
  }));

  app.post('/api/projects/:id/shots/reorder', wrap((req, res) => {
    const input = V.parseOrThrow(V.reorderSchema, req.body);
    res.json({ shots: wb.storyboard.reorder(req.params.id, input.orderedIds) });
  }));

  app.patch('/api/projects/:id/shots/:shotId', wrap((req, res) => {
    const patch = V.parseOrThrow(V.shotPatchSchema, req.body);
    res.json({ shot: wb.storyboard.patchShot(req.params.id, req.params.shotId, patch) });
  }));

  app.delete('/api/projects/:id/shots/:shotId', wrap((req, res) => {
    res.json({ shots: wb.storyboard.removeShot(req.params.id, req.params.shotId) });
  }));

  app.get('/api/projects/:id/shots/:shotId/versions', wrap((req, res) => {
    res.json({ versions: wb.storyboard.versions(req.params.id, req.params.shotId) });
  }));

  app.post('/api/projects/:id/shots/:shotId/restore', wrap((req, res) => {
    const input = V.parseOrThrow(V.restoreSchema, req.body);
    res.json({ shot: wb.storyboard.restore(req.params.id, req.params.shotId, input.version) });
  }));

  app.post('/api/projects/:id/shots/:shotId/regenerate', wrap(async (req, res) => {
    const input = V.parseOrThrow(V.regenerateSchema, req.body);
    const task = wb.storyboard.enqueueRegenerate(req.params.id, req.params.shotId, input.kind);
    const done = await runTask(task.id);
    const shot = wb.storyboard.list(req.params.id).find((s) => s.id === req.params.shotId);
    res.json({ task: done, shot });
  }));

  /* ---------------------------- 任务 / 素材 / 导出 ---------------------------- */
  app.get('/api/projects/:id/tasks', wrap((req, res) => {
    res.json({ tasks: wb.queue.list(req.params.id) });
  }));

  app.get('/api/tasks', wrap((req, res) => {
    res.json({ tasks: wb.queue.list() });
  }));

  /** 单个任务状态：导出页轮询渲染进度用。 */
  app.get('/api/tasks/:taskId', wrap((req, res) => {
    const task = wb.queue.get(req.params.taskId);
    if (!task) throw new HttpError(404, `任务不存在：${req.params.taskId}`);
    res.json({ task });
  }));

  app.post('/api/tasks/:taskId/cancel', wrap((req, res) => {
    res.json({ task: wb.queue.cancel(req.params.taskId) });
  }));

  app.post('/api/tasks/:taskId/retry', wrap(async (req, res) => {
    const task = wb.queue.retry(req.params.taskId);
    const done = await runTask(task.id);
    res.json({ task: done });
  }));

  app.post('/api/assets/images', wrap((req, res) => {
    const input = V.parseOrThrow(V.uploadImageSchema, req.body);
    res.status(201).json({ asset: wb.assets.saveImage(input) });
  }));

  /**
   * 动画资产（人物姿态图 / 场景真图）：上传后把路径写回 config/animation.json。
   * 注册表是唯一真值，写文件即触发 animationWiring 的 mtime 重载，界面传图立刻生效。
   */
  app.get('/api/animation-assets', wrap((_req, res) => {
    res.json({ assets: loadSlots() });
  }));

  app.post('/api/animation-assets', wrap((req, res) => {
    const input = V.parseOrThrow(V.uploadAnimationAssetSchema, req.body);
    const target = input.target as AssetTarget;
    const slot = target.kind === 'characterPose'
      ? `pose-${target.key}` : target.kind === 'sceneBackground'
        ? 'scene-bg' : `layer-${target.key}`;
    const ownerId = target.kind === 'characterPose'
      ? target.id : `scene-${target.id.replace(/^scene-/, '')}`;
    const asset = wb.assets.saveImage({
      base64: input.base64,
      mimeType: input.mimeType,
      fileName: input.fileName,
      characterId: ownerId,
      slot,
    });
    res.status(201).json({ asset, assets: applyUpload(target, asset.path) });
  }));

  app.post('/api/animation-assets/clear', wrap((req, res) => {
    const input = V.parseOrThrow(V.clearAnimationAssetSchema, req.body);
    res.json({ assets: clearSlot(input.target as AssetTarget) });
  }));

  /**
   * 场景工程：可编辑的分层画板。
   * GET 返回元素数据（注册表里有 studio 就用它，否则给默认模板）；
   * POST 保存时把每层导出成 SVG 落到 assets/scenes/<id>/，并写回 layers[].src，渲染立即生效。
   */
  app.get('/api/scene-studio/:sceneId', wrap((req, res) => {
    res.json(loadStudio(req.params.sceneId));
  }));

  app.post('/api/scene-studio/:sceneId', wrap((req, res) => {
    try {
      res.json({ ok: true, ...saveStudio(req.params.sceneId, req.body) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : '保存失败' });
    }
  }));

  app.get('/api/assets', wrap((req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const characterId = typeof req.query.characterId === 'string' ? req.query.characterId : undefined;
    res.json({ assets: wb.assets.list(projectId, characterId) });
  }));

  /**
   * 视频导出：入队即返回，后台任务队列接管（渲染通常几十秒）。
   * 前端轮询 GET /api/tasks/:taskId 拿进度，完成后 result 里带成片 URL。
   * 同一项目已有在跑的渲染任务时直接复用，避免重复生成。
   */
  app.post('/api/projects/:id/render', wrap((req, res) => {
    const input = V.parseOrThrow(V.renderVideoSchema, req.body ?? {});
    const running = wb.queue.list(req.params.id).find((task) =>
      task.type === 'video.render'
      && ['pending', 'analyzing', 'generating', 'processing'].includes(task.status));
    if (running) {
      res.status(202).json({ task: running, reused: true });
      return;
    }
    if (!renderEnv.available) {
      throw new HttpError(400, `本机渲染环境未就绪：${renderEnv.reason}`);
    }
    const mode = input.mode ?? wb.projects.meta(req.params.id).exportMode;
    const task = wb.queue.enqueue({
      projectId: req.params.id,
      type: 'video.render',
      payload: { mode },
      provider: 'local-renderer',
      model: 'edge-headless+ffmpeg',
    });
    res.status(202).json({ task, reused: false });
  }));

  app.get('/api/projects/:id/export', wrap((req, res) => {
    const bundle = wb.projects.exportJson(req.params.id);
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}.json"`);
    res.type('application/json').send(JSON.stringify(bundle, null, 2));
  }));

  /* ---------------------------- 静态与错误 ---------------------------- */
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API 不存在' }));
  // 人物参考图等本地素材：URL /assets/... 直接对应 assets/ 目录。
  app.use('/assets', express.static(path.join(P.root, 'assets')));
  app.use('/assets', (_req, res) => res.status(404).type('text/plain').send('素材不存在'));
  // 成片：导出页 <video> 播放用静态托管；找不到必须 404，不能落到 SPA 回退变成 index.html。
  app.use('/output', express.static(P.outputDir()));
  app.use('/output', (_req, res) => res.status(404).type('text/plain')
    .send('成片不存在或已被删除：请回导出页刷新文件列表，或重新导出 MP4'));
  app.use(express.static(P.webDist()));
  app.get('*', (req, res) => {
    // 带扩展名的请求一律不回退成前端页面（防止把 HTML 当 MP4 / JSON 下载）
    if (/\.[a-z0-9]{1,8}$/i.test(req.path)) {
      res.status(404).type('text/plain').send(`资源不存在：${req.path}`);
      return;
    }
    const index = path.join(P.webDist(), 'index.html');
    if (fs.existsSync(index)) {
      res.sendFile(index);
    } else {
      res.type('html').send(
        '<meta charset="utf-8"><h1>工作台前端尚未构建</h1>' +
        '<p>开发模式：npm run dev:web（http://localhost:5173）；单端口：npm run build 后 npm start。</p>',
      );
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof HttpError
      ? error.statusCode
      : (error as { statusCode?: number })?.statusCode ?? inferStatus(message);
    if (status >= 500) console.error('[server]', error);
    res.status(status).json({ error: message });
  });

  return {
    app,
    wb,
    stop: () => { wb.queue.stop(); wb.db.close(); },
  };
};
