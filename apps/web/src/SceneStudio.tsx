import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/**
 * 场景画板：直接在 9:16 画布上调整场景的每一层（天空/远景/中景/近景/前景），
 * 拖拽改位置、面板改尺寸与颜色、逐层调视差，保存后由服务端导出 SVG 到
 * assets/scenes/<sceneId>/ 并写回注册表，预览与成片立刻按新图渲染。
 */

type El = {
  id: string; type: 'rect' | 'ellipse';
  x: number; y: number; w: number; h: number;
  fill: string; opacity?: number; rx?: number;
};
type LayerKind = 'sky' | 'far' | 'mid' | 'near' | 'foreground';
type Layer = { key: string; kind: LayerKind; parallax: number; elements: El[] };
type Studio = {
  canvas: { w: number; h: number };
  layers: Layer[];
  anchors: Record<string, [number, number]>;
  baseline: number;
};

const KIND_LABEL: Record<LayerKind, string> = {
  sky: '天空 / 背景', far: '远景', mid: '中景（主体）', near: '近景', foreground: '前景遮挡',
};
const SWATCHES = ['#fdf1dc', '#f7e6cc', '#d8c3a6', '#bfd8ea', '#8d6248', '#5c3f2e', '#43764e', '#c98b6b', '#e9dfd0', '#2f3437'];

const uid = () => `el-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export const SceneStudio: React.FC<{
  sceneId: string;
  sceneName: string;
  onClose: () => void;
  onSaved: (sceneId: string, previewSrc: string) => void;
}> = ({ sceneId, sceneName, onClose, onSaved }) => {
  const [studio, setStudio] = useState<Studio | null>(null);
  const [activeKey, setActiveKey] = useState('mid');
  const [selId, setSelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scaleRef = useRef(0.6);
  const dragRef = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const [viewW, setViewW] = useState(300);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ studio: Studio }>(`/api/scene-studio/${sceneId}`);
        setStudio(res.studio);
        setActiveKey(res.studio.layers.find((l) => l.elements.length)?.key ?? 'mid');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [sceneId]);

  useEffect(() => {
    const onResize = () => setViewW(Math.min(320, Math.max(220, Math.round(window.innerHeight * 0.42 * 9 / 16))));
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const scale = studio ? viewW / studio.canvas.w : 0.6;
  scaleRef.current = scale;

  const patchElement = useCallback((id: string, patch: Partial<El>) => {
    setStudio((prev) => prev ? {
      ...prev,
      layers: prev.layers.map((l) => ({ ...l, elements: l.elements.map((e) => e.id === id ? { ...e, ...patch } : e) })),
    } : prev);
  }, []);

  useEffect(() => {
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const s = scaleRef.current || 1;
      patchElement(d.id, {
        x: Math.round(d.ox + (ev.clientX - d.sx) / s),
        y: Math.round(d.oy + (ev.clientY - d.sy) / s),
      });
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [patchElement]);

  const activeLayer = studio?.layers.find((l) => l.key === activeKey) ?? null;
  const selected = activeLayer?.elements.find((e) => e.id === selId) ?? null;

  const addElement = (type: El['type']) => {
    if (!studio || !activeLayer) return;
    const el: El = {
      id: uid(), type,
      x: Math.round(studio.canvas.w * 0.3), y: Math.round(studio.canvas.h * 0.45),
      w: type === 'rect' ? 140 : 100, h: type === 'rect' ? 90 : 100,
      fill: type === 'rect' ? '#c98b6b' : '#43764e',
      ...(type === 'rect' ? { rx: 4 } : {}),
    };
    setStudio({
      ...studio,
      layers: studio.layers.map((l) => l.key === activeLayer.key ? { ...l, elements: [...l.elements, el] } : l),
    });
    setSelId(el.id);
  };

  const removeSelected = () => {
    if (!studio || !activeLayer || !selId) return;
    setStudio({
      ...studio,
      layers: studio.layers.map((l) => l.key === activeLayer.key
        ? { ...l, elements: l.elements.filter((e) => e.id !== selId) } : l),
    });
    setSelId(null);
  };

  const save = async () => {
    if (!studio) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const res = await api.post<{ preview: string }>(`/api/scene-studio/${sceneId}`, studio);
      setMessage(`已保存到 assets/scenes/${sceneId}/（${studio.layers.length} 层 SVG）`);
      onSaved(sceneId, res.preview);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-3" onClick={onClose}>
      <div
        className="flex max-h-[94vh] w-[min(1060px,97vw)] flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-stone-200 px-4 py-2.5">
          <div>
            <p className="text-sm font-semibold text-ink">场景画板 · {sceneName || sceneId}</p>
            <p className="text-[11px] text-stone-500">拖动画布里的色块改位置；保存后导出 SVG 到 assets/scenes/{sceneId}/，成片立刻按新图渲染</p>
          </div>
          <button className="btn btn-ghost text-xs" onClick={onClose}>关闭</button>
        </div>

        <div className="flex min-h-0 flex-1 gap-3 overflow-auto p-3">
          {/* 层列表 */}
          <div className="w-52 shrink-0 space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">图层（从远到近）</p>
            {studio?.layers.map((l) => (
              <button
                key={l.key}
                onClick={() => { setActiveKey(l.key); setSelId(null); }}
                className={`w-full rounded-md border px-2 py-1.5 text-left text-xs ${activeKey === l.key ? 'border-warm bg-orange-50 text-warm' : 'border-stone-200 text-stone-600 hover:bg-stone-50'}`}
              >
                <span className="flex items-center justify-between">
                  <span className="font-medium">{KIND_LABEL[l.kind]}</span>
                  <span className="text-[10px] text-stone-400">{l.elements.length} 个</span>
                </span>
                <span className="mt-1 flex items-center gap-1 text-[10px] text-stone-400">
                  视差
                  <input
                    type="range" min={0} max={1} step={0.02} value={l.parallax}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setStudio((prev) => prev ? { ...prev, layers: prev.layers.map((x) => x.key === l.key ? { ...x, parallax: v } : x) } : prev);
                    }}
                    className="h-1 flex-1"
                  />
                  {l.parallax.toFixed(2)}
                </span>
              </button>
            ))}
            <div className="pt-2">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-stone-400">加到「{activeLayer ? KIND_LABEL[activeLayer.kind] : '-'}」</p>
              <div className="flex gap-1.5">
                <button className="btn btn-ghost flex-1 py-1 text-xs" onClick={() => addElement('rect')}>＋ 矩形</button>
                <button className="btn btn-ghost flex-1 py-1 text-xs" onClick={() => addElement('ellipse')}>＋ 圆形</button>
              </div>
            </div>
          </div>

          {/* 画布 */}
          <div className="flex min-w-0 flex-1 flex-col items-center">
            {!studio ? (
              <p className="mt-10 text-xs text-stone-400">{error ?? '加载中…'}</p>
            ) : (
              <div
                className="relative overflow-hidden rounded-md border border-stone-300 bg-white shadow-inner"
                style={{ width: viewW, height: studio.canvas.h * scale }}
                onPointerDown={() => setSelId(null)}
              >
                {studio.layers.map((l) => (
                  <div key={l.key} style={{ opacity: activeKey === l.key ? 1 : 0.92 }}>
                    {l.elements.map((e) => (
                      <div
                        key={e.id}
                        onPointerDown={(ev) => {
                          ev.stopPropagation();
                          setActiveKey(l.key);
                          setSelId(e.id);
                          dragRef.current = { id: e.id, sx: ev.clientX, sy: ev.clientY, ox: e.x, oy: e.y };
                        }}
                        style={{
                          position: 'absolute',
                          left: e.x * scale, top: e.y * scale,
                          width: Math.max(2, e.w * scale), height: Math.max(2, e.h * scale),
                          background: e.fill,
                          opacity: e.opacity ?? 1,
                          borderRadius: e.type === 'ellipse' ? '50%' : (e.rx ?? 0) * scale,
                          outline: selId === e.id ? '2px solid #e07a3f' : 'none',
                          cursor: 'move',
                        }}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 text-[10px] text-stone-400">画布 {studio?.canvas.w}×{studio?.canvas.h} · 显示比例 {scale.toFixed(2)}</p>
          </div>

          {/* 属性面板 */}
          <div className="w-60 shrink-0 space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">选中图元</p>
            {!selected ? (
              <p className="rounded-md bg-stone-50 px-2 py-3 text-[11px] leading-5 text-stone-400">
                点画布里的色块选中，或点左侧「＋ 矩形 / ＋ 圆形」新加一个。
              </p>
            ) : (
              <div className="space-y-2 rounded-md border border-stone-200 p-2">
                <div className="grid grid-cols-2 gap-1.5">
                  {(['x', 'y', 'w', 'h'] as const).map((k) => (
                    <label key={k} className="text-[10px] text-stone-500">
                      {k.toUpperCase()}
                      <input
                        type="number"
                        value={Math.round(selected[k])}
                        onChange={(e) => patchElement(selected.id, { [k]: Number(e.target.value) } as Partial<El>)}
                        className="mt-0.5 w-full rounded border border-stone-200 px-1 py-0.5 text-xs"
                      />
                    </label>
                  ))}
                </div>
                <div>
                  <p className="mb-1 text-[10px] text-stone-500">颜色</p>
                  <div className="flex flex-wrap gap-1">
                    {SWATCHES.map((c) => (
                      <button
                        key={c}
                        onClick={() => patchElement(selected.id, { fill: c })}
                        style={{ background: c }}
                        className={`h-5 w-5 rounded border ${selected.fill === c ? 'border-warm ring-1 ring-warm' : 'border-stone-300'}`}
                        title={c}
                      />
                    ))}
                  </div>
                  <input
                    value={selected.fill}
                    onChange={(e) => patchElement(selected.id, { fill: e.target.value })}
                    className="mt-1 w-full rounded border border-stone-200 px-1 py-0.5 text-xs"
                  />
                </div>
                <button className="btn btn-ghost w-full py-1 text-xs text-red-600" onClick={removeSelected}>删除这个图元</button>
              </div>
            )}
            <p className="text-[10px] leading-4 text-stone-400">
              小技巧：先调中景的地板/门，再调前景遮挡；视差越大移动越明显，前景通常设 1.0。
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-stone-200 px-4 py-2.5">
          <div className="min-w-0 text-[11px]">
            {error && <span className="text-red-600">{error}</span>}
            {message && <span className="text-emerald-700">{message}</span>}
            {!error && !message && <span className="text-stone-400">改完点右侧保存，导出到资源路径并立即生效</span>}
          </div>
          <div className="flex shrink-0 gap-2">
            <button className="btn btn-ghost text-xs" onClick={onClose}>取消</button>
            <button className="btn btn-primary text-xs" disabled={busy || !studio} onClick={() => void save()}>
              {busy ? '保存中…' : '保存到资源路径'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SceneStudio;
