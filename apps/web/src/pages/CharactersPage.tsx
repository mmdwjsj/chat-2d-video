import React, { useState } from 'react';
import { useWorkbench } from '../store';
import type { Character, VoiceConfig } from '@thai-video/core/types';
import { LANGUAGE_LABELS } from '../language';
import { assetUrl, countImages, REFERENCE_SLOTS } from '../characterLibrary';
import type { LibraryCharacter } from '../characterLibrary';
import { useAnimationAssets } from '../animationAssets';
import { AssetSlotGrid } from '../AssetSlotGrid';
import { Badge, Banner, Card, Empty, Field, InlineBar, Modal, SectionTitle, TextArea } from '../ui';

const VoiceFields: React.FC<{
  title: string; voice: VoiceConfig; onChange: (voice: VoiceConfig) => void;
}> = ({ title, voice, onChange }) => (
  <div className="rounded-lg border border-stone-200 p-3">
    <p className="mb-2 text-xs font-semibold text-stone-600">{title}</p>
    <div className="grid gap-2 sm:grid-cols-2">
      <Field label="引擎" value={voice.engine} onChange={(v) => onChange({ ...voice, engine: v })} placeholder="配置 TTS 后填写" />
      <Field label="声音" value={voice.voice} onChange={(v) => onChange({ ...voice, voice: v })} placeholder="voice id" />
      <Field label="语速" type="number" step={0.05} value={voice.speed} onChange={(v) => onChange({ ...voice, speed: Number(v) })} />
      <Field label="音量" type="number" step={0.05} value={voice.volume} onChange={(v) => onChange({ ...voice, volume: Number(v) })} />
    </div>
    <div className="mt-2">
      <Field label="情绪 / 语气" value={voice.emotion} onChange={(v) => onChange({ ...voice, emotion: v })} />
    </div>
  </div>
);

/** 资源库弹窗的两种用法：新增人物（带模板） / 给已有人物换一整套六视图（只换图）。 */
type PickerMode = { kind: 'add' } | { kind: 'replace'; characterId: string };

export const CharactersPage: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const bundle = useWorkbench((s) => s.bundle)!;
  const updateCharacters = useWorkbench((s) => s.updateCharacters);
  const uploadReference = useWorkbench((s) => s.uploadReference);
  const library = useWorkbench((s) => s.library);
  const libraryError = useWorkbench((s) => s.libraryError);
  const loadCharacterLibrary = useWorkbench((s) => s.loadCharacterLibrary);
  const addCharacter = useWorkbench((s) => s.addCharacter);
  const removeCharacter = useWorkbench((s) => s.removeCharacter);
  const replaceCharacterImages = useWorkbench((s) => s.replaceCharacterImages);
  const [picker, setPicker] = useState<PickerMode | null>(null);
  const anim = useAnimationAssets();

  const update = (id: string, patch: Partial<Character>): void => {
    updateCharacters(bundle.characters.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const openPicker = (mode: PickerMode): void => {
    void loadCharacterLibrary();
    setPicker(mode);
  };

  const pick = (entry: LibraryCharacter): void => {
    if (picker?.kind === 'replace') replaceCharacterImages(picker.characterId, entry);
    else addCharacter(entry);
    setPicker(null);
  };

  const actions = (
    <>
      <button className="btn btn-ghost py-1 text-xs" onClick={() => openPicker({ kind: 'add' })}>
        从资源库选人
      </button>
      <button className="btn btn-primary py-1 text-xs" onClick={() => addCharacter()}>
        ＋ 新增人物
      </button>
    </>
  );

  return (
    <div>
      {embedded ? (
        <InlineBar
          hint="剧本里写的人物名要和这里一致；人数按剧本定，随时可增删。资源库选一张全身照会自动带出六视图，手动新增的人物才需要逐张上传。"
          right={actions}
        />
      ) : (
        <SectionTitle
          title="人物管理"
          hint="人物数量不固定：可新增、可删除。参考图既能从 assets 资源库一键带出六视图，也能逐张上传本地图片。"
          right={<><Badge tone="green">{bundle.characters.length} 个人物</Badge>{actions}</>}
        />
      )}
      <Banner tone="info">
        当前语言类型「{LANGUAGE_LABELS[bundle.meta.exportMode]}」：配音时只会用到对应语种的声音配置，另一种可以提前填好，将来切成双语就能直接用。
      </Banner>
      {libraryError && <Banner tone="warn">{libraryError}</Banner>}

      {bundle.characters.length === 0 ? (
        <Empty
          title="还没有人物"
          hint="剧本里有几个人就加几个人：从资源库选人可一次带出六张参考图，也可以新增空白人物后逐张上传。"
          action={<div className="mt-2 flex gap-2">{actions}</div>}
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {bundle.characters.map((character) => (
            <Card key={character.id}>
              <div className="mb-3 flex items-start justify-between gap-2">
                <div>
                  <p className="text-base font-semibold">{character.name} <span className="text-sm font-normal text-stone-500">{character.nameTh}</span></p>
                  <p className="text-[11px] text-stone-400">{character.id} · {character.occupation || '未设置职业'}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  <label className="flex items-center gap-1 text-xs text-stone-600">
                    <input
                      type="checkbox" checked={character.identityLock.enabled}
                      onChange={(e) => update(character.id, {
                        identityLock: { ...character.identityLock, enabled: e.target.checked },
                      })}
                    />
                    形象锁定
                  </label>
                  <button
                    className="btn btn-danger px-2 py-0.5 text-[11px]"
                    onClick={() => {
                      if (window.confirm(
                        `删除人物「${character.name}」？其他人物的关系里指向他/她的项会一并清理；已引用他/她的镜头需要到第 4 段重新指定。`,
                      )) removeCharacter(character.id);
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="姓名（中文）" value={character.name} onChange={(v) => update(character.id, { name: v })} />
                <Field label="姓名（泰文）" value={character.nameTh} onChange={(v) => update(character.id, { nameTh: v })} />
                <Field label="年龄设定" value={character.ageSetting} onChange={(v) => update(character.id, { ageSetting: v })} />
                <Field label="职业" value={character.occupation} onChange={(v) => update(character.id, { occupation: v })} />
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Field label="性格" value={character.personality} onChange={(v) => update(character.id, { personality: v })} />
                <Field label="常用服装（逗号分隔）" value={character.wardrobe.join('，')} onChange={(v) => update(character.id, { wardrobe: v.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })} />
              </div>
              <div className="mt-2">
                <TextArea label="背景设定" rows={2} value={character.background} onChange={(v) => update(character.id, { background: v })} />
              </div>
              <div className="mt-2">
                <TextArea
                  label="核心外貌（不可变，生成任务自动注入）" rows={2}
                  value={character.identityLock.coreAppearance}
                  onChange={(v) => update(character.id, { identityLock: { ...character.identityLock, coreAppearance: v } })}
                />
              </div>

              <div className="mb-2 mt-4 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold text-stone-600">
                  参考图 · 六视图 <span className="font-normal text-stone-400">（{countImages(character.referenceImages)}/6）</span>
                </p>
                <button
                  className="text-[11px] text-warm underline hover:opacity-80"
                  onClick={() => openPicker({ kind: 'replace', characterId: character.id })}
                >
                  从资源库换一套
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {REFERENCE_SLOTS.map((slot) => {
                  const path = character.referenceImages[slot.key] as string;
                  return (
                    <label
                      key={slot.key}
                      title={`上传或替换${slot.label}参考图`}
                      className="cursor-pointer rounded-lg border border-dashed border-stone-300 p-1 text-center hover:border-warm"
                    >
                      <div className="flex h-16 items-center justify-center overflow-hidden rounded bg-stone-50">
                        {path
                          ? <img src={assetUrl(path)} alt={slot.label} className="h-full w-full object-cover" />
                          : <span className="text-[11px] text-stone-400">＋上传</span>}
                      </div>
                      <span className="mt-1 block text-[11px] text-stone-600">{slot.label}</span>
                      <input
                        type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void uploadReference(character.id, slot.key, file);
                          e.target.value = '';
                        }}
                      />
                    </label>
                  );
                })}
              </div>
              <p className="mt-1 text-[11px] leading-5 text-stone-400">
                点任一格可单独上传本地图片替换；从资源库选人时六张会一次带出，不必逐张传。
                表情参考图 {character.referenceImages.expressions.length} 张 · 动作参考图 {character.referenceImages.actions.length} 张
              </p>

              <div className="mb-2 mt-4 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold text-stone-600">
                  动作姿态图 <span className="font-normal text-stone-400">（上传后直接用于动画，未传的姿态沿用六视图近似）</span>
                </p>
                <span className="text-[11px] text-stone-400">{anim.busy ? '上传中…' : ''}</span>
              </div>
              <AssetSlotGrid
                slots={anim.assets.poseKeys.length ? anim.assets.poseKeys : []}
                values={anim.assets.characters[character.id]?.poses ?? {}}
                buildTarget={(key) => ({ kind: 'characterPose', id: character.id, key })}
                onUpload={anim.upload}
                onClear={anim.clear}
                busy={anim.busy}
              />
              <p className="mt-1.5 text-[11px] leading-5 text-stone-400">
                站立 / 坐姿 / 两个迈步帧 / 侧身 / 背面。传了真动作图，走路、起身才会真的换姿态；
                同一人物不同姿态建议用同尺寸透明底图，嘴部标定跟随注册表里该姿态的配置。
              </p>
              {anim.error && <Banner tone="warn">动画资产：{anim.error}</Banner>}

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <VoiceFields title="中文声音" voice={character.voices.zh}
                  onChange={(v) => update(character.id, { voices: { ...character.voices, zh: v } })} />
                <VoiceFields title="泰语声音" voice={character.voices.th}
                  onChange={(v) => update(character.id, { voices: { ...character.voices, th: v } })} />
              </div>

              <p className="mt-3 text-[11px] text-stone-500">
                人物关系：{character.relations.map((r) => `${r.characterId}（${r.label}）`).join('、') || '未设置'}
              </p>
            </Card>
          ))}
        </div>
      )}

      {picker && (
        <Modal
          title={picker.kind === 'add' ? '从资源库选人' : '换一套资源库参考图'}
          onClose={() => setPicker(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => void loadCharacterLibrary()}>刷新资源库</button>
              <button className="btn btn-ghost" onClick={() => setPicker(null)}>取消</button>
            </>
          }
        >
          <p className="mb-3 text-xs leading-5 text-stone-600">
            点一张全身照即可：会自动带出这个人的正面 / 侧面 / 背面 / 全身 / 半身 / 脸部共 6 张
            {picker.kind === 'add'
              ? '，并一起带入姓名、核心外貌与音色设定。'
              : '；姓名与音色保持你现在填的内容不变。'}
            只有手动「＋新增人物」才需要一张一张上传。
          </p>
          {library.length === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-4 text-xs leading-5 text-stone-600">
              资源库里还没有可用人物。把某人的六张图放进
              <code className="mx-1 rounded bg-white px-1">assets/characters/library/&lt;名字&gt;/</code>
              并在同目录的 <code className="mx-1 rounded bg-white px-1">index.json</code> 追加一项，点「刷新资源库」就能选到。
              也可以直接点「＋新增人物」逐张上传。
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {library.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => pick(entry)}
                  className="rounded-lg border border-stone-200 p-1.5 text-left transition-colors hover:border-warm hover:bg-orange-50/40"
                  title={`选择 ${entry.name}，自动带出六张参考图`}
                >
                  <div className="flex h-36 items-center justify-center overflow-hidden rounded bg-stone-50">
                    {entry.cover
                      ? <img src={assetUrl(entry.cover)} alt={`${entry.name} 全身照`} className="h-full w-full object-contain" />
                      : <span className="text-[11px] text-stone-400">暂无全身照</span>}
                  </div>
                  <p className="mt-1.5 truncate text-xs font-semibold text-ink">
                    {entry.name} <span className="font-normal text-stone-400">{entry.nameTh}</span>
                  </p>
                  <p className="text-[11px] text-stone-500">
                    {countImages(entry.images)}/6 张 · 点选自动带出
                  </p>
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
};
