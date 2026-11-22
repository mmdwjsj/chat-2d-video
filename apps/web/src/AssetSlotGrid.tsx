import React from 'react';
import type { AssetTarget, SlotState } from './animationAssets';
import { slotImage, slotMissing } from './animationAssets';

/**
 * 通用图片槽位网格：人物姿态图与场景真图共用。
 * 每格独立上传/清除；配了路径但文件不存在会显示「缺图」而不是假装正常。
 * 泛型 K 让 buildTarget 收到精确的姿态/层级键，调用方不需要强转。
 */
export function AssetSlotGrid<K extends string>({
  slots, values, buildTarget, onUpload, onClear, busy, columns = 3,
}: {
  slots: { key: K; label: string }[];
  values: Record<string, SlotState>;
  buildTarget: (key: K) => AssetTarget;
  onUpload: (target: AssetTarget, file: File) => Promise<void>;
  onClear: (target: AssetTarget) => Promise<void>;
  busy: boolean;
  columns?: number;
}): React.ReactElement {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {slots.map((slot) => {
        const state = values[slot.key];
        const image = slotImage(state);
        const missing = slotMissing(state);
        const target = buildTarget(slot.key);
        return (
          <div key={slot.key} className="rounded-lg border border-stone-200 p-1.5">
            <label
              className={`relative flex h-20 cursor-pointer items-center justify-center overflow-hidden rounded bg-stone-50 ${busy ? 'pointer-events-none opacity-60' : 'hover:ring-2 hover:ring-warm/50'}`}
              title={`上传或替换「${slot.label}」图片`}
            >
              {image
                ? <img src={image} alt={slot.label} className="h-full w-full object-contain" />
                : <span className="text-[11px] text-stone-400">＋ 上传</span>}
              {state?.src && !missing && (
                <span className="absolute bottom-0 right-0 rounded-tl bg-emerald-600 px-1 text-[9px] text-white">已就绪</span>
              )}
              {missing && (
                <span className="absolute bottom-0 right-0 rounded-tl bg-red-600 px-1 text-[9px] text-white">缺图</span>
              )}
              <input
                type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void onUpload(target, file).catch(() => undefined);
                  e.target.value = '';
                }}
              />
            </label>
            <div className="mt-1 flex items-center justify-between gap-1">
              <span className="truncate text-[11px] text-stone-600" title={slot.label}>{slot.label}</span>
              {state?.src && (
                <button
                  type="button" disabled={busy}
                  className="shrink-0 text-[10px] text-stone-400 hover:text-red-600 hover:underline disabled:opacity-40"
                  onClick={() => void onClear(target)}
                >清除</button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
