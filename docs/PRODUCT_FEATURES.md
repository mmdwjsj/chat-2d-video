# 产品功能细节清单

> 项目：`thai-daily-life-ai-video`（泰国本地生活 AI 双语短视频系统）
> 整理时间：2026-11-20
> 口径：只写当前代码已实装的能力，规划中/未接通的单独标注。

## 1. 定位

Windows 本地运行的模块化单体工作台：主题或粘贴的中/泰文案 → 双语剧本 → 自动分镜 → 逐镜头编辑 → 合成 1080×1920 / 30fps / H.264+AAC 竖屏 MP4。文本生成、场景匹配、画面、口型、字幕全在本地；唯一联网点是 edge-tts 配音（可退回字幕 + 氛围音）。

## 2. 系统形态

| 包 | 职责 | 入口 |
| --- | --- | --- |
| apps/web | React + Zustand 工作台，三个工作区 | src/App.tsx |
| apps/server | Express + Zod REST API，静态托管 dist | src/index.ts |
| packages/core | 领域模型、SQLite、JSON 剧本/分镜、任务队列 | src/index.ts |
| packages/ai-providers | 文本/图像/视频 Provider 契约与本地规则 | src/local.ts |
| packages/tts-providers | 可替换命令式 TTS、诊断 | src/index.ts |
| packages/animation | 动作/表情/嘴型参数契约（当前无调用方） | src/index.ts |
| packages/video-renderer | HTML/SVG 帧、Edge 截图、时间轴、FFmpeg | src/index.ts |

## 3. 端到端数据流

1. 新建项目，选语言类型（中文 / 泰语 / 双语），默认带入 3 个人物与 12 个场景。
2. 制作页四段：人物 → 场景 → 剧本 → 分镜，改完自动保存。
3. 剧本：主题生成（本地规则模板，非在线模型）或粘贴规范正文；`parseScriptLines` 解析成「说话人 / 台词 / 情绪 / 动作 / 场景提示」对白行。
4. 自动分镜：`splitShots` 逐行切镜，场景由 `sceneMatch` 按关键词打分匹配，可在「场景匹配审阅」里手动改（`sceneSource: manual` 不会被重新分镜覆盖）。
5. 出片：点导出 → `video.render` 后台任务 → TTS 逐句合成 → `computeTimeline` 按 ffprobe 实测撑开镜头 → 生成画面帧 → Edge 无头截图 → FFmpeg 拼接混音 → `output/<项目ID>/`。

## 4. 三个工作区的功能细节

**项目库**：新建（项目名 + 语言类型）、打开示例项目、项目列表、删除。语言类型是全项目唯一真值（`projects.export_mode`），切换只改显示与导出目标，不删另一语种内容。

**制作**（一页四段，段头吸顶 + 段导航）：
- 人物：按剧本增删人数；「从资源库选人」点一张全身照带出六视图与设定模板；手动新增逐张上传 6 槽；可改姓名、核心外貌、音色、身份锁。
- 场景：12 个泰国场景缩略图墙（缩略图即成片配色）；可改名称/类型/地点/匹配关键词；**只读缩略图墙，不能上传背景图**（`ScenesPage.tsx`）。
- 剧本：规范卡片 + 填入示例；中/泰双栏独立编辑（互不自动覆盖）；对白行表格逐行校对说话人/台词/情绪/动作，情绪与动作支持下拉 + 自定义；改对白行写回正文对应行，改正文可「重新解析正文」。
- 分镜：提交自动分镜；场景匹配审阅（命中词/依据/把握程度/只看待确认/手动选场景/恢复自动/重新匹配/清除手动）；逐镜头改人物/动作/台词/时长；排序、锁定（409 保护）、版本历史与恢复、单镜头重生成。

**出片**：
- ① 成片预览：与成片同源的 `buildFrame` + 同一条 `mouthTimeline`，9:16 逐帧播放、暂停、拖进度、试听配音。
- ② 导出 MP4：按语言类型出对应版本，进度轮询，可播放/下载；另两种语言版本可额外生成。
- ③ 任务记录：状态、失败原因、重试/取消，SQLite 持久化跨重启。

## 5. 数据模型（`packages/core/src/types.ts`）

| 对象 | 关键字段 |
| --- | --- |
| Character | 六视图 `front/side/back/fullBody/halfBody/face`、`expressions[]`、`actions[]`、双语音色、身份锁 |
| Scene | 名称/类型/地点/时间/天气/光线、`backgroundImage`、`cameraAngles[]`、`keywords[]` |
| ScriptLine | speakerId、textZh/Th、emotion、action、sceneSuggestion、sourceIndex |
| Shot | sceneId/sceneSource/sceneHint、characterIds、action、expression、shotSize、cameraAngle、cameraMove、双语台词/字幕/音频、`backgroundImagePath`、`generatedImagePath`、`generatedVideoPath`、status/version/locked |

存储：`data/workbench.sqlite`（项目/素材/任务/版本索引）、`data/projects/<id>/{script,shots,characters,scenes}.json`、`data/projects/<id>/history/shots/<shotId>/vN.json`，素材本体在 `assets/`。

## 6. 资产清单

- `assets/characters/library/<slug>/`：每人 6 张视图（nina / aton / dundun），清单 `index.json` 固定 6 槽。
- `assets/characters/cutout/`：3 张透明底立绘（`*-cutout.png` / `*-clean.png`），仅供 Python 样片链路使用。
- `assets/characters/calibration.json`：仅 3 人的实测嘴位、嘴宽、原嘴高、肤色 RGB。
- `assets/audio/tts/`：逐句配音缓存 + 整镜头配音缓存 `shot-<id>-<mode>.wav`。
- `data/actions/`、`data/expressions/`：空目录（仅 `.gitkeep`）。
- `config/scenes.json` 12 个场景，`backgroundImage` 全为空。

## 7. 渲染管线（现状）

1. `frameData.ts` 统一算 `FrameInput`：字幕取法、出场人物、场景、说话人、人物图与嘴部标定。
2. `sceneArt.ts` 的 `paletteFor(scene)` 按场景选 12 套硬编码配色之一；`backgroundSvg()` 输出单张静态插画（渐变天空 + 建筑剪影 + 场景标志元素 + 地面）；`characterSvg()` 贴一张 `fullBody` 图并叠 4 档口型 SVG。
3. 对白镜头：`mouthTimeline` 按配音 RMS 能量（无配音按台词节奏）产出 `MouthShape[]`；只截实际用到的几档 PNG，`writeFrameSequence` 用硬链接铺成 `f%05d.png`。
4. `renderVideo`：`zoompan` 对整帧做 1→1.05 缓慢推近 + 淡入，逐段拼接，配音与氛围音按帧数裁齐，封装 MP4。
5. 预览：`previewFrames.ts` 返回四档 HTML，`FramePlayer.tsx` 用 4 个常驻 iframe 按时间轴切 visibility，音频时钟驱动。

## 8. 现有「动效」的真实边界

| 能生成 | 不能生成 |
| --- | --- |
| 4 档口型同步、字幕、片头片尾 | 任何肢体/姿态变化 |
| 静态插画 + 整帧推近 + 淡入 | 部件级运动、遮挡关系 |
| 镜头硬切 | 人物与场景的空间交互 |
| 样片链路：整图推移/淡入、单张立绘平移 + sin 起伏 | 跨镜头状态连续（坐→站→走） |

`scripts/demo_animation.py` 是独立 Python 验证链路，其「走路」是 `dx=-250+500*prog` 加 `bob=10*abs(sin(local*9))` 的仿射变换，不是步态帧。README 第 126 行明确：走路、场景推移等动作层仍只在样片链路，尚未合并。

## 9. 配置与运行

- `config/app.json`（视频规格 / 版本上限）、`config/providers.json`（text/tts/image/video 的 active 与命令模板）、`config/characters.json`、`config/scenes.json`。
- 命令：`npm run dev:server`（4173）、`npm run dev:web`（5173）、`npm run build && npm start`、`npm run typecheck`、`npm test`、`npm run example`、`npm run demo`。
- 环境要求：Node >= 22.5、FFmpeg/ffprobe、Edge 或 Chrome、edge-tts（配音）。

## 10. 已留接口但未接通

`ReferenceImages.actions/expressions`、`data/actions` 与 `data/expressions`、`packages/animation` 的 `AnimationPlan`、`remotion/Composition.tsx.example`、`shot.generatedImagePath` / `generatedVideoPath`、`Scene.backgroundImage`。这些字段在 types / validation / config / examples 中都有，但渲染代码不读取。
