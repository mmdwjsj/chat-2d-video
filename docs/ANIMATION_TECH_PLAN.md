# 动画改造技术方案

> 整理时间：2026-11-20
> 目标：在不破坏现有 96 个测试与出片能力的前提下，把「静态贴图 + 4 档口型」升级为数据驱动的逐帧合成，同时消除换人/换景的静默降级。
> 配套：`PRODUCT_FEATURES.md`（现状）、`REQUIREMENTS.md`（需求）。

## 1. 核心思路：有限帧档，不做逐帧截图

现有链路的优点是「只截 4 张口型 PNG，再用硬链接铺成 120 帧」。改造必须保留这个性能特性，否则每帧一次 Edge 无头截图会让导出慢到不可用。

做法是把它从「4 档口型」推广为「有限个帧档」：

- `FrameDirector` 对每个视频帧求值得出一个 `FrameKey`（动作阶段 + 口型档 + 场景层状态）。
- 一个镜头的 `FrameKey` 取值是有限的（通常 8～30 个），**每个不同的 FrameKey 才截一张 PNG**。
- 按 `FrameKey[]` 时间轴用硬链接铺成 `f%05d.png`，交给现有 `renderVideo` 的 `-framerate fps -i` 通道。
- 前端预览同样按 `FrameKey` 切常驻 iframe，与现有 4 档 iframe 机制同构。

这样：截图次数有上限、磁盘不爆、预览与成片同源，且逐帧变化是真实的姿态/位移/视差。

## 2. 分层架构

| 层 | 内容 | 本次落点 |
| --- | --- | --- |
| 资产层 | 人物 rig（姿态图 + 锚点/标定）、场景分层包、动作 clip | `config/animation.json` + 现有 assets |
| 契约层 | 类型定义、注册表加载、显式降级 | `packages/animation` |
| 调度层 | 按 frameIndex 求值 → FrameKey 时间轴 + 帧档定义 | `FrameDirector` |
| 画面层 | 分层场景 HTML + 姿态人物 + 口型 + 字幕 | `video-renderer/animatedFrame.ts` |
| 接线层 | bundle/shot → 帧档、成片与预览共用 | `apps/server/animationWiring.ts` |
| 输出层 | 帧档 PNG 序列 → 现有 FFmpeg 合成 | `render.ts` / `previewFrames.ts` / `FramePlayer.tsx` |

## 3. 数据契约

```ts
// 人物 rig：每个姿态是一张图 + 该图自己的锚点、基线、嘴部标定
type RigPose = {
  key: string;              // sit | stand | walk_1 | walk_2 | turn | back ...
  src: string;              // 相对项目根的图片路径
  anchor: [number, number]; // 归一化脚底/重心锚点
  mouth?: [number, number]; // 归一化嘴部中心
  mouthW?: number;          // 嘴宽（归一化）
  skin?: string;            // 肤色，用于盖掉原嘴
};

type CharacterRig = {
  id: string;               // 对应 Character.id，新人只加注册项
  name: string;
  width: number; height: number;
  defaultPose: string;
  poses: Record<string, RigPose>;
};

// 场景：分层 + 锚点 + 转场；每层可选挂真图
type SceneLayer = {
  key: string; kind: 'sky' | 'far' | 'mid' | 'near' | 'foreground';
  parallax: number;         // 0 = 不动，1 = 跟相机全量位移
  src?: string;             // 相对项目根的真图路径；填了就用图替代该层程序化色块
  fit?: 'cover' | 'contain';// 图片铺法，默认 cover
  opacity?: number;         // 该层不透明度，默认 1
};
type SceneSpec = {
  id: string; palette: string;           // 复用 sceneArt 的 paletteFor
  backgroundImage?: string; // 整张场景底图（垫最下层、不参与视差）；填了则程序化色块层让位
  layers: SceneLayer[];     // 场景自带 layers 优先，缺省才继承 defaults.layers
  anchors: Record<string, [number, number]>; // 沙发 / 门 / 灶台 ...
  baseline: number;         // 人物脚底 y（像素）
};

// 动作：关键帧序列，帧与帧之间线性插值
type ActionClip = {
  id: string;
  poses: string[];          // 依次经过的姿态 key
  from?: string; to?: string;   // 起止锚点（空间移动）
  move?: [number, number];  // 归一化位移
  bob?: number;             // 起伏幅度（像素）
  transition?: 'cut' | 'slide' | 'fade';
};

// 剧本行为指令（结构化，替代单标签 action 字符串）
type ActionCue = {
  actorId: string; verb: string;
  from?: string; to?: string; target?: string;
  startSec: number; durationSec: number;
};

// 逐帧求值结果
type FrameState = {
  frameKey: string;
  sceneOffset: number;
  actors: { id: string; pose: string; x: number; y: number; scale: number; rotate: number; opacity: number }[];
  mouth: MouthShape;
  degradations: string[];
};
```

## 4. 注册表与显式降级

`config/animation.json` 是唯一真值：

```json
{
  "enabled": true,
  "characters": { "char-a": { ...rig }, "char-b": { ... } },
  "scenes": { "scene-apartment": { ...spec } },
  "actions": { "stand-up": { ...clip } }
}
```

加载规则（`registry.ts`）：

1. 按 `Character.id` / `Scene.id` 查注册表，**不再按 slug 正则或 id 哈希猜**。
2. 校验每个 `src` 指向的文件真实存在；缺失时**记录 degradation**（例如「人物 char-x 缺 stand 姿态，已用 defaultPose 并标注」），不静默换成人物的旧形象。
3. 场景未注册 → 记录降级并回退到 `paletteFor` 的静态配色，但画面与导出结果里都带降级说明。
4. 动作未注册 → 回退到 `idle`（站立 + 口型），同样留痕。
5. 注册表无法解析 / `enabled=false` → 整镜头回退现有 4 档口型链路，并在 `render` 结果 `timelineWarnings` 里写明。

这一条直接对应「换个人物或换个场景生成的视频是残次品」：降级不再是隐式的，而是可观测、可追溯的。

## 5. FrameDirector 算法

输入：`shot`、`bundle`、注册表、`fps`、帧数、`mouthTimeline`、`ActionCue[]`。

1. 把镜头的 `ActionCue[]` 按 `startSec/durationSec` 映射到帧区间；无指令时生成 `idle`。
2. 每个 cue 在其区间内按进度 `p∈[0,1]`：
   - 从 `clip.poses` 取当前阶段姿态（量化到有限档，避免帧档爆炸）；
   - `move` 与 `bob` 按 `p` 插值，得出 actor 的 `x/y/rotate/scale`；
   - `from→to` 锚点差换算成场景层偏移量（视差 = 偏移 × layer.parallax）。
3. 叠加口型：说话人的 `mouth` 取 `mouthTimeline[k]`，其余 actor 固定 `closed`。
4. 生成 `frameKey = pose阶段|mouth|场景档`，去重后得到 `frames: FrameState[]` 与 `timeline: string[]`。
5. 输出降级列表（贯穿全程，非空即在结果里标注）。

帧档数量由「动作阶段数 × 出现的口型档数」决定，天然有上界。

## 6. 画面层

`animatedFrame.ts` 生成 1080×1920 HTML：

- 复用 `paletteFor(scene)` 的配色，把背景拆成独立层（sky / far / mid / near / foreground），每层按 `sceneOffset × parallax` 做 `translateX`。
- **场景真图（本次补齐）**：`backgroundImage` 作为整张底图垫在最下层；任一层填了 `src` 就用 `<img>` 替代该层程序化 SVG，仍按 `parallax` 做视差，`fit`/`opacity` 透传。有整张真底图时，未配 `src` 的程序化色块层自动让位，不盖住真图。真图层左右外扩 `PARALLAX_PX`，视差位移不露白边。`Scene.backgroundImage`（历史死字段）已接通，项目里填路径即生效。
- 场景图片缺失由 `collectMissingSceneAssets` 统一校验，缺图写入 `degradations`，与人物缺资产口径一致，绝不静默退回色块。
- 人物按 `actors[]` 逐个渲染：`<img src=pose>`，外层 `transform: translate/scale/rotate`，`transform-origin` 用 pose 的 anchor；前景层盖在人物之上实现遮挡。
- 口型：按 pose 自带的 `mouth/mouthW/skin` 画肤色补丁 + 4 档嘴型，与原 `calibration.json` 口径一致。
- 字幕、片头信息、进度条沿用现有 `buildShotFrame` 的版式。

该文件自包含，不改动 `sceneArt.ts` 的 `buildFrame`，因此现有渲染与测试零回归。

## 7. 接线与降级路径

```
render.ts  ── 若 enabled 且注册表可用 ──> animationWiring.buildShotFrames()
                                          ├─ FrameDirector → frameKey 时间轴
                                          ├─ 每个 frameKey 截一张 PNG
                                          └─ writeKeyedFrameSequence() 硬链接铺帧
           ── 否则 ──────────────────────> 现有 mouthTimeline 4 档链路
```

- 预览：`previewFrames.ts` 新增可选 `framesByKey` / `frameTimeline` / `degradations`；`FramePlayer.tsx` 优先用新通道，否则走原 4 档。旧字段全部保留。
- 动画链路用 `CharacterRig` 自带的姿态图标定（锚点 / 嘴位 / 肤色），完全不经过 `calibrationSlug` 的三人白名单；`frameData.ts` 与原 `characterArtOf` 保持不动，只在注册表关闭时的回退链路生效。
- 剧本：`core/actionCues.ts` 把对白行的 `action` 解析为 `ActionCue[]`，`Shot` 增加可选 `actionCues` 字段；解析器不认识的描述保留原文并记降级。

## 8. 分期与本次落地范围

| 阶段 | 内容 | 本次 |
| --- | --- | --- |
| P0 | 契约 + 注册表 + 显式降级 | 完成 |
| P1 | 资产：用现有六视图/cutout 构造 rig 与分层场景 | 完成（可替换为真序列帧） |
| P2 | FrameDirector + 有限帧档 + 画面层 + 成片接入 | 完成 |
| P3 | 剧本 Action 结构化、预览同源 | 完成 |
| P3+ | 场景真图：整张底图 + 分层真图 + 视差/遮挡、修 parseScene 忽略自定义 layers、缺图留痕 | 完成（本轮补齐） |
| P4 | 上传 UI（人物姿态图 / 场景真图，界面放图即生效） | 完成（本轮补齐） |
| P5 | 真序列帧素材替换六视图近似、AI 视频 Provider | 后续 |

本次交付后：改完即可导出带姿态变化、位移与视差的成片；换人物/换场景/挂场景真图只需改 `config/animation.json` 与资产，渲染代码零改动；缺素材会在导出结果里明确告警。

> 场景真图放法见 `config/animation.json` 的 `_sceneImageExample`：把分层 `src` 或整张 `backgroundImage` 指向 `assets/` 下的图片即可；也可直接填项目的 `Scene.backgroundImage`。文件不存在时画面仍能出，但会在导出结果里留下「场景 xxx 的图片缺失」告警。

## 8.1 界面上传链路（P4）

不用手改 JSON：人物页六视图下方有「动作姿态图」6 格，场景编辑弹窗有「场景真图」区（整张底图 1 格 + 分层 5 格），每格独立上传/清除，实时显示「已就绪 / 缺图」。

```
前端 AssetSlotGrid  →  POST /api/animation-assets      (base64 + target)
                     ├─ wb.assets.saveImage 落盘 → 相对路径 assets/images/...
                     ├─ setSlotSrc 写回 config/animation.json（保留 note/模板/其它注册项）
                     ├─ invalidateAnimationRegistry 清 mtime 缓存
                     └─ 返回全量槽位状态 → 界面刷新
        GET  /api/animation-assets       读回槽位状态（含文件是否真实存在）
        POST /api/animation-assets/clear 清除槽位，回到程序化生成
```

- `target` 是判别联合：`characterPose(id,key)` / `sceneBackground(id)` / `sceneLayer(id,key)`；键用白名单枚举、`id` 限 `[A-Za-z0-9_-]`，拒绝路径穿越。
- 未注册的人物/场景上传时**自动登记最小注册项**：`defaultPose` 指向真实存在的姿态、场景 `palette` 用自身 id，绝不套用已有三人的形象或街边餐馆配色；缺的其它姿态由 director 走显式降级。
- 人物姿态与场景真图都写进注册表 `src`，`animatedFrame.ts` 直接读，因此预览与成片同源、代码零改动。
- 上传后清缓存是必要步骤：注册表按 mtime 缓存，同一毫秒内连续写入可能读不到新值。

## 9. 回归策略

- 基线：`npm run typecheck` 通过、`npm test` 96/96 通过（改造前已确认）。
- 新增测试：注册表（换第 4 人不冒用他人）、显式降级（人物/场景缺资产必留痕）、FrameDirector（同一镜头首尾帧状态不同、帧档数有上界）、ActionCue 解析、场景真图（自定义 layers 不再被忽略、真图渲染成 img、程序化层让位、视差位移、fit/opacity 透传）、上传链路（写回保留原字段、自动登记、清除、白名单拒绝路径穿越）。
- 当前：`npm run typecheck` 通过、`npm test` 121/121 通过。
- 端到端：隔离临时根目录起服务，走 GET/POST/clear 三个接口，验证「图片落盘 → 注册表写回 → 渲染链路画面真出现该图」，人物姿态图、场景分层图、场景整张底图三条路径均通过。
- 不改任何既有测试文件；新增用例加入 `package.json` 的 `test` 列表。
- 保留自动回退：`enabled=false` 或异常时成片链路与改造前逐字节一致。

## 10. 涉及文件

| 动作 | 路径 |
| --- | --- |
| 新增文档 | docs/PRODUCT_FEATURES.md、REQUIREMENTS.md、ANIMATION_TECH_PLAN.md |
| 新增注册数据 | config/animation.json |
| 新增契约/调度 | packages/animation/src/{contracts,registry,director}.ts |
| 新增画面/帧序列 | packages/video-renderer/src/{animatedFrame,frameSequence}.ts |
| 新增测试 | packages/animation/src/animation.test.ts、packages/core/src/actionCues.test.ts、packages/video-renderer/src/animatedFrame.test.ts、apps/server/src/animationAssets.test.ts |
| 新增接线 | apps/server/src/animationWiring.ts |
| 新增上传链路 | apps/server/src/animationAssets.ts、apps/web/src/{animationAssets.ts,AssetSlotGrid.tsx} |
| 新增剧本指令 | packages/core/src/actionCues.ts |
| 修改（仅增量） | core/{types,index}.ts、animation/index.ts、video-renderer/index.ts、apps/server/{render,previewFrames,app,validation,animationWiring}.ts、apps/web/{FramePlayer,previewFrames}.ts(x)、apps/web/src/pages/{CharactersPage,ScenesPage}.tsx、package.json |

## 11. 人物部件化（新增）

`scripts/build_character_parts.mjs` 对三人全身立绘做两件事：

1. **去背**：四边漫水填充，只把「与边界连通且接近底色」的像素置透明。不用全图色差阈值，是因为米白 T 恤与浅灰底色很接近，阈值法会把衣服挖穿。
2. **按关节掩膜切割**：用逐行宽度剖面自动定位脖子最窄处与髋部宽度骤降处，切出 4 个部件。

只切 4 块而不是 8+，是因为这批立绘**手臂完全贴身**（躯干行宽连续变化、手臂与身体间无像素缝隙），右臂还被挎包压住；硬切手臂必然带走一片躯干，旋转即穿帮。等有「双臂离身」的立绘，只需在脚本里加掩膜框。

产物：`assets/characters/cutout/<slug>/{head,torso,legL,legR}.png`（统一 1024×1536 画布，部件外透明）+ `parts.json`（枢轴、包围盒、来源）。

`scripts/render_live_demo.mjs <slug>` 用 `parts.json` 做**旋转贴图**（逐目标像素反算源坐标 + 双线性采样 + alpha 混合），按关节角插值出「站立 → 起步 → 连续迈步 → 停步」并交 ffmpeg 出 MP4。三人共用同一套驱动，只换 `parts.json`，用于验证「换人不崩」。

> 边界说明：素材是站立像，坐着无法凭空生成（没有坐姿素材）。所以样片只表达站、走、起伏、前倾，不假装做坐姿。

### 11.1 走路驱动改版：切部件 → 连续网格蒙皮

`render_live_demo.mjs` 这一版被废弃，产物归档到 `output/demo/archive/`。原因是**方案本身有物理缺陷**，不是参数没调好：

1. 这批立绘双腿**并拢贴合**，按中线硬切后，每条腿的内侧就是一条竖直切面。腿绕髋旋转时切面直接外露，屏幕上就是一条深色直线 —— 即「腿像被锯掉」。
2. 腿的上端切在枢轴上方 16px，旋转时这一截反向甩出，裤腰与大腿之间出现楔形透明缺口。
3. 只有一个髋关节，整条腿是刚体，脚跟随腿一起倾斜、悬空或插进地面。
4. 更根本：立绘是**正面**视角，用侧视骨骼做「前后劈腿」，屏幕投影变成左右张开 —— 那是劈叉，不是走路。

新方案 `scripts/render_walk_mesh.mjs`：**不切图**，整张去背人物作为一张连续网格，做线性混合蒙皮（LBS）。

- 网格：按包围盒铺 21×66 左右的控制点，每点绑定 `torso / thigh / shin / foot / arm` 权重，权重用 smoothstep 过渡并归一化，保证是凸组合。
- 权重边界：脚部过渡带整体压在鞋口以上（鞋 100% 刚体，否则鞋面会被小腿拉成拖尾）；左右腿过渡带 ±26px，让分腿位移平缓过渡，不产生深色假裂缝。
- 正面步态（这是关键判断）：真实走路的**前后**位移在正面是深度方向，屏幕上只该有极小横向漂移。所以动作由四件事表达 —— 摆动腿整条骨链外展 2.9°+3°，膝下小腿透视缩短 32%、大腿缩短 12%，骨盆双频起伏 4.2px + 重心左右转移 8px，以及对侧摆臂 4.9°。前进感交给背景滚动（132px/s）。
- 旋转一律用绕关节的刚体变换：髋部锚点位移为 0，所以裤腰不会被撕开。
- 刚体化处理：鞋只平移不旋转。一转鞋口就和裤腿错开，立刻出现「截断」折角。

产物：`output/demo/网格走路-{nina,aton,dundun}.mp4`，`node scripts/render_walk_mesh.mjs <slug>`；加 `--stills` 只出 6 张静帧调参。

> 已知边界：双腿并拢的正面临绘做不出「前后错落」的经典走路姿态，只能做到交替抬脚 + 身体起伏 + 摆臂 + 滚动。要拿到侧身迈步，需要侧视/三视角素材。
> 该脚本目前是独立样片，尚未并入 `FrameDirector` 主链路。

## 12. 场景画板（新增）

场景长什么样不再由代码里的色块字典决定，改为用户可编辑的数据。

- 接口：`GET /api/scene-studio/:sceneId`（无记录时返回默认模板）、`POST /api/scene-studio/:sceneId`（保存）。
- 前端：`apps/web/src/SceneStudio.tsx`，入口在「场景库 → 编辑 → 打开场景画板」。
- 数据：元素列表存在注册表 `scenes[<id>].studio`，下次打开可继续编辑。
- 产物：保存时每层导出 `assets/scenes/<id>/<layer>.svg`，另生成 `preview.svg` 供卡片缩略图；同时把 `layers[].src` 指过去并清注册表缓存，渲染链路立即按新图出画。
- 只写 `layers[].src`，不写 `backgroundImage`：整张底图会让分层视差失效。
- 元素仅 `rect` / `ellipse`（够表达墙面、地板、门窗、家具、遮挡），因此导出无需图形库，SVG 由服务端字符串拼装。
