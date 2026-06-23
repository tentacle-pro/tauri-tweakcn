/**
 * WaveformDisplay — wavesurfer.js 封装
 *
 * ⚠️ macOS WKWebView AudioSession 注意事项：
 *    不在 mount 时创建 AudioContext / WaveSurfer，
 *    延迟到 active=true（AI 开始说话，getUserMedia 已成功后）才初始化，
 *    避免提前占用 AudioSession 导致 getUserMedia 失败。
 *
 * 纯 Float32 数组累积 → 无需额外 AudioContext → 转 WAV Blob → loadBlob()
 */

import { useEffect, useRef } from "react";
import WaveSurfer from "wavesurfer.js";
import { PCM_OUTPUT_RATE } from "./types";

interface WaveformDisplayProps {
  chunks: string[];
  active: boolean;
}

export function WaveformDisplay({ chunks, active }: WaveformDisplayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const allSamplesRef = useRef<Float32Array[]>([]);
  const prevLenRef = useRef(0);

  // ── 懒初始化：仅在 active=true 时创建 WaveSurfer ──
  useEffect(() => {
    if (!active || !containerRef.current || wsRef.current) return;
    wsRef.current = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "rgba(74, 222, 128, 0.55)",
      progressColor: "rgba(34, 197, 94, 0.9)",
      cursorColor: "transparent",
      height: 72,
      barWidth: 2,
      barGap: 1.5,
      barRadius: 3,
      interact: false,
      normalize: true,
    });
  }, [active]);

  // ── 组件卸载时销毁 ──
  useEffect(() => {
    return () => {
      wsRef.current?.destroy();
      wsRef.current = null;
    };
  }, []);

  // ── 增量处理新 chunk ──
  useEffect(() => {
    if (!active || !wsRef.current) return;
    const newChunks = chunks.slice(prevLenRef.current);
    if (newChunks.length === 0) return;
    prevLenRef.current = chunks.length;

    for (const b64 of newChunks) {
      const f32 = b64ToFloat32(b64);
      if (f32) allSamplesRef.current.push(f32);
    }

    const combined = concatFloat32(allSamplesRef.current);
    if (combined && combined.length > 0) {
      wsRef.current.loadBlob(float32ToWavBlob(combined));
    }
  }, [chunks, active]);

  // ── 清空（active → false）──
  useEffect(() => {
    if (!active) {
      allSamplesRef.current = [];
      prevLenRef.current = 0;
      wsRef.current?.empty();
    }
  }, [active]);

  return (
    <div
      ref={containerRef}
      className="w-full transition-opacity duration-300"
      style={{ opacity: active ? 1 : 0 }}
    />
  );
}

// ── helpers ──

function b64ToFloat32(b64: string): Float32Array | null {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
    return f32;
  } catch {
    return null;
  }
}

function concatFloat32(arrays: Float32Array[]): Float32Array | null {
  if (arrays.length === 0) return null;
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function float32ToWavBlob(data: Float32Array): Blob {
  const length = data.length;
  const dataSize = length * 2; // 16-bit mono

  const pcm = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767)));
  }

  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const s = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  s(0, "RIFF"); v.setUint32(4, 36 + dataSize, true);
  s(8, "WAVE"); s(12, "fmt ");
  v.setUint32(16, 16, true);                        // PCM chunk size
  v.setUint16(20, 1, true);                          // PCM format
  v.setUint16(22, 1, true);                          // mono
  v.setUint32(24, PCM_OUTPUT_RATE, true);
  v.setUint32(28, PCM_OUTPUT_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  s(36, "data"); v.setUint32(40, dataSize, true);

  return new Blob(
    [new Uint8Array(header), new Uint8Array(pcm.buffer, 0, dataSize)],
    { type: "audio/wav" },
  );
}
