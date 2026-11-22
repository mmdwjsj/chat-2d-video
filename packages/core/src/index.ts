export * from './types.js';
export * from './actionCues.js';
export { Db } from './db.js';
export { TaskQueue } from './tasks.js';
export type { TaskHandler, EnqueueInput } from './tasks.js';
export { ProjectService } from './projects.js';
export { ScriptService } from './script.js';
export { StoryboardService } from './storyboard.js';
export { AssetService } from './assets.js';
export { appConfig, providerConfig, defaultCharacters, defaultScenes } from './defaults.js';
export type { AppConfig, ProviderConfig } from './defaults.js';
export { P, PROJECT_ROOT, toRelative, fromRelative } from './paths.js';
export { readJson, writeJsonAtomic } from './jsonStore.js';
export { makeId } from './ids.js';

import { Db } from './db.js';
import { TaskQueue } from './tasks.js';
import { ProjectService } from './projects.js';
import { ScriptService } from './script.js';
import { StoryboardService } from './storyboard.js';
import { AssetService } from './assets.js';
import { appConfig, providerConfig } from './defaults.js';
import { P } from './paths.js';

/** 工作台容器：server 启动时创建一次，所有路由共享同一份状态。 */
export const createWorkbench = (opts: { pollIntervalMs?: number } = {}) => {
  const db = new Db(P.database());
  const queue = new TaskQueue(db, { pollIntervalMs: opts.pollIntervalMs });
  const projects = new ProjectService(db, queue);
  const script = new ScriptService(db);
  const storyboard = new StoryboardService(db, queue);
  const assets = new AssetService(db);
  return {
    db, queue, projects, script, storyboard, assets,
    config: appConfig(),
    providers: providerConfig(),
  };
};

export type Workbench = ReturnType<typeof createWorkbench>;
