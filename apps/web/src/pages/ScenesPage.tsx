import React, { useState } from 'react';
import { useWorkbench } from '../store';
import { emptyScene } from '@thai-video/core/types';
import type { Scene } from '@thai-video/core/types';
import { Badge, Banner, Field, InlineBar, Modal, SectionTitle } from '../ui';
import { sceneThumbUrl } from '../sceneThumb';
import { useAnimationAssets, LAYER_SLOTS } from '../animationAssets';
import { AssetSlotGrid } from '../AssetSlotGrid';
import { assetUrl } from '../characterLibrary';
import { SceneStudio } from '../SceneStudio';

/**
 * 场景段：缩略图墙 + 编辑弹窗。
 *
 * 名称/类型/地点/关键词影响场景匹配；场景真图（整张底图或分层图）在这里直接上传，
 * 上传后写回 config/animation.json 注册表，预览与成片立即生效，不需要改代码。
 */
export const ScenesPage: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const bundle = useWorkbench((s) => s.bundle)!;
  const updateScenes = useWorkbench((s) => s.updateScenes);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [studioId, setStudioId] = useState<string | null>(null);
  /** 画板保存后，卡片缩略图直接换成导出的 preview.svg（带时间戳避开缓存）。 */
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const anim = useAnimationAssets();

  const editing = bundle.scenes.find((s) => s.id === editingId) ?? null;

  const update = (id: string, patch: Partial<Scene>): void =>
    updateScenes(bundle.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const add = (): void => {
    const scene = emptyScene(`scene-${Date.now()}`);
    updateScenes([...bundle.scenes, scene]);
    setEditingId(scene.id);
  };

  const remove = (id: string): void => {
    if (window.confirm('删除这个场景？已引用它的镜头会保留 sceneId，但预览会变成默认画面。')) {
      updateScenes(bundle.scenes.filter((s) => s.id !== id));
    }
  };

  const shotCount = (id: string): number => bundle.shots.filter((s) => s.sceneId === id).length;

  return (
    <div>
      {embedded ? (
        <InlineBar
          hint="一天里的光线已经写在场景里（夜市自带夜景、办公室自带白天），不用单独配。关键词决定台词自动落到哪个场景；第 4 段「场景匹配审阅」能看到依据并逐镜头手动换，换过的不怕重新分镜。"
          right={<button className="btn btn-ghost py-1 text-xs" onClick={add}>添加场景</button>}
        />
      ) : (
        <SectionTitle
          title="场景库"
          hint="缩略图就是成片里的画面配色。自动匹配按关键词猜，不准的在第 4 段「场景匹配审阅」里能看到依据并手动换。"
          right={<><Badge tone="blue">{bundle.scenes.length} 个场景</Badge><button className="btn btn-primary" onClick={add}>添加场景</button></>}
        />
      )}

      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {bundle.scenes.map((scene) => {
          const used = shotCount(scene.id);
          return (
            <div key={scene.id} className="card flex gap-3 p-2.5">
              <button
                type="button"
                onClick={() => setEditingId(scene.id)}
                className="relative w-16 shrink-0 self-stretch overflow-hidden rounded-md border border-stone-200 bg-stone-100"
                title="点开编辑名称与关键词"
              >
                {/* 卡片是扁的，默认居中裁切只会露出天空；往下压一点，露出的才是摊位/货架这些识别点 */}
                <img src={previews[scene.id] ?? sceneThumbUrl(scene)} alt={`${scene.name || scene.id} 缩略图`}
                  className="absolute inset-0 h-full w-full object-cover object-[50%_72%]" />
              </button>
              <div className="flex min-w-0 flex-1 flex-col justify-between">
                <div className="min-w-0">
                  <div className="flex items-start justify-between gap-1">
                    <p className="truncate text-sm font-semibold" title={scene.name || scene.id}>
                      {scene.name || '（未命名场景）'}
                    </p>
                    <button className="shrink-0 text-[11px] text-stone-400 hover:text-warm hover:underline"
                      onClick={() => setEditingId(scene.id)}>编辑</button>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-stone-500">
                    {[scene.type, scene.location].filter(Boolean).join(' · ') || '未填写类型与地点'}
                  </p>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <span className={`chip border ${used ? 'border-warm/40 bg-orange-50 text-warm' : 'border-stone-200 text-stone-400'}`}>
                    {used ? `${used} 个镜头在用` : '暂未被使用'}
                  </span>
                  {(scene.keywords ?? []).slice(0, 2).map((key) => (
                    <span key={key} className="chip bg-stone-100 text-stone-500">{key}</span>
                  ))}
                  {(scene.keywords ?? []).length > 2 && (
                    <span className="text-[10px] text-stone-400">+{scene.keywords.length - 2}</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <Modal
          title={`编辑场景 · ${editing.name || '未命名'}`}
          onClose={() => setEditingId(null)}
          footer={
            <>
              <button className="btn btn-ghost text-red-600" onClick={() => { remove(editing.id); setEditingId(null); }}>
                删除这个场景
              </button>
              <button className="btn btn-primary" onClick={() => setEditingId(null)}>完成</button>
            </>
          }
        >
          <div className="space-y-3">
            <div className="flex gap-3">
              <img src={sceneThumbUrl(editing)} alt="场景缩略图"
                className="h-28 w-16 shrink-0 rounded-md border border-stone-200 object-cover" />
              <div className="flex-1 space-y-2">
                <Field label="场景名称" value={editing.name} onChange={(v) => update(editing.id, { name: v })} />
                <Field label="类型（例：居住 / 商业 / 交通）" value={editing.type}
                  onChange={(v) => update(editing.id, { type: v })} />
              </div>
            </div>
            <Field label="地点描述（会注入生成提示）" value={editing.location}
              onChange={(v) => update(editing.id, { location: v })} />
            <Field label="匹配关键词（逗号分隔，决定台词自动分到哪；改完去第 4 段审阅面板看效果）"
              value={(editing.keywords ?? []).join('，')}
              placeholder="夜市，小吃，路边摊"
              onChange={(v) => update(editing.id, {
                keywords: v.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
              })} />

            <div className="rounded-lg border border-warm/40 bg-orange-50/50 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-stone-700">场景画板</p>
                  <p className="mt-0.5 text-[11px] leading-5 text-stone-500">
                    不喜欢程序化生成的画面？进画板自己摆：拖色块改位置、逐层调视差，保存后导出到
                    <code className="mx-0.5 rounded bg-white px-1">assets/scenes/{editing.id}/</code>并立即生效。
                  </p>
                </div>
                <button className="btn btn-primary shrink-0 py-1 text-xs" onClick={() => setStudioId(editing.id)}>
                  打开场景画板
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-stone-200 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold text-stone-600">
                  场景真图 <span className="font-normal text-stone-400">（不传则用程序化色块分层）</span>
                </p>
                <span className="text-[11px] text-stone-400">{anim.busy ? '上传中…' : ''}</span>
              </div>
              <p className="mb-2 text-[11px] leading-5 text-stone-500">
                整张底图 = 一张铺满、不参与视差；分层图 = 按远景/中景/前景各自移动，产生视差和遮挡。
                两种任选其一，挂了分层图会自动让整张底图让位。
              </p>
              <AssetSlotGrid
                slots={[{ key: 'background', label: '整张底图' }]}
                values={{ background: anim.assets.scenes[editing.id]?.backgroundImage ?? { src: '', ready: false } }}
                buildTarget={() => ({ kind: 'sceneBackground', id: editing.id })}
                onUpload={anim.upload}
                onClear={anim.clear}
                busy={anim.busy}
                columns={3}
              />
              <p className="mb-1.5 mt-3 text-[11px] font-semibold text-stone-600">分层真图（可选，逐层叠加）</p>
              <AssetSlotGrid
                slots={anim.assets.layerKeys.length ? anim.assets.layerKeys : LAYER_SLOTS}
                values={anim.assets.scenes[editing.id]?.layers ?? {}}
                buildTarget={(key) => ({ kind: 'sceneLayer', id: editing.id, key })}
                onUpload={anim.upload}
                onClear={anim.clear}
                busy={anim.busy}
                columns={3}
              />
              {anim.error && <Banner tone="warn">动画资产：{anim.error}</Banner>}
            </div>

            <p className="text-[11px] leading-relaxed text-stone-500">
              改完自动保存。时间、天气、光线、镜头角度不再单独配置：
              夜市场景天然是夜景、办公室天然是白天，靠场景本身表达，少填一堆不会生效的框。
              自动匹配不可能百分百准：命中不了关键词的镜头会标成「程序兜底」，在分镜的「场景匹配审阅」里手动选一次即可，之后重新自动分镜也会保留。
            </p>
          </div>
        </Modal>
      )}

      {studioId && (
        <SceneStudio
          sceneId={studioId}
          sceneName={bundle.scenes.find((s) => s.id === studioId)?.name ?? ''}
          onClose={() => setStudioId(null)}
          onSaved={(id, preview) => {
            setPreviews((prev) => ({ ...prev, [id]: `${assetUrl(preview)}?v=${Date.now()}` }));
            void anim.reload();
          }}
        />
      )}
    </div>
  );
};
