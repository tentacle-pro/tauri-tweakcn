/**
 * VoiceSession — 极简版（服务端 VAD 模式）
 *
 * 架构：持续上行 PCM → Gemini 服务端 VAD 判断回合 → 下行 AUDIO 播放
 * 不做任何本地 VAD；状态完全由 Gemini 服务端事件驱动。
 *
 * Phase:
 *   idle        — 麦克风未开启
 *   listening   — 麦克风开启，持续上行音频
 *   ai_speaking — 收到 Gemini AUDIO 帧，正在播放
 */

import React, { useState, useRef, useCallback } from "react";
import { Mic, AlertCircle } from "lucide-react";
import { useGeminiWS } from "./useGeminiWS";
import { useMediaStream } from "./useMediaStream";
import { useAudioPlayer } from "./useAudioPlayer";
import { WaveformDisplay } from "./WaveformDisplay";
import type { VoiceSessionEvent } from "./types";

type Phase = "idle" | "listening" | "ai_speaking";

export function VoiceSession() {
  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const go = useCallback((p: Phase) => {
    if (phaseRef.current === p) return;
    console.log("[Voice] phase:", phaseRef.current, "→", p);
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const { sendAudio, onEvent, bytesSent } = useGeminiWS();
  const {
    error: micError,
    isCapturing,
    start: micStart,
    stop: micStop,
    readChunkBase64,
  } = useMediaStream();
  const player = useAudioPlayer();

  // ── AI 音频块累积（供 WaveformDisplay 使用）──
  const [audioChunks, setAudioChunks] = useState<string[]>([]);

  // ── 处理 Gemini 下行事件 ──
  React.useEffect(() => {
    onEvent((ev: VoiceSessionEvent) => {
      switch (ev.type) {
        case "AUDIO":
          if (typeof ev.data === "string") {
            player.enqueue(ev.data);
            setAudioChunks(prev => [...prev, ev.data as string]);
            go("ai_speaking");
          }
          break;
        case "TURN_COMPLETE":
        case "INTERRUPTED":
          go("listening");
          break;
      }
    });
  }, [onEvent, player, go]);

  // ── 上行音频心跳 ──
  const txRef = useRef<ReturnType<typeof setInterval> | null>(null);
  React.useEffect(() => {
    if (!isCapturing) {
      go("idle");
      return;
    }
    go("listening");
    txRef.current = setInterval(() => {
      const chunk = readChunkBase64();
      if (chunk) sendAudio(chunk);
    }, 100);
    return () => {
      if (txRef.current) clearInterval(txRef.current);
    };
  }, [isCapturing, readChunkBase64, sendAudio, go]);

  // ── 按钮 ──
  const handleToggle = async () => {
    if (isCapturing) {
      micStop();
      player.flush();
      setAudioChunks([]);
    } else {
      await micStart();
    }
  };

  const phaseLabel: Record<Phase, string> = {
    idle: "就绪，点击麦克风开始",
    listening: "🎤 聆听中，请说话...",
    ai_speaking: "🤖 AI 说话中",
  };

  return (
    <div className="flex flex-col items-center gap-5 p-6 w-80 bg-gradient-to-b from-slate-900 to-slate-800 rounded-2xl text-white select-none shadow-xl shadow-black/30 border border-slate-700/50">

      {/* 状态文字 */}
      <div className="text-[10px] uppercase tracking-[.2em] text-slate-500">
        {phaseLabel[phase]}
      </div>

      {/* ── 可视化区 ── */}
      <div className="w-full h-[72px] flex items-center justify-center overflow-hidden">
        {/* idle */}
        {phase === "idle" && (
          <div className="w-3/4 h-px bg-slate-700" />
        )}

        {/* listening — CSS 脉动柱 */}
        {phase === "listening" && (
          <div className="flex items-end justify-center gap-1">
            {[6, 12, 18, 14, 8, 20, 16, 10, 18, 12, 6].map((h, i) => (
              <div
                key={i}
                className="w-1 bg-emerald-500/70 rounded-full animate-pulse"
                style={{ height: h, animationDelay: `${i * 0.07}s` }}
              />
            ))}
          </div>
        )}

        {/* ai_speaking — wavesurfer 真实波形 */}
        <WaveformDisplay
          chunks={audioChunks}
          active={phase === "ai_speaking"}
        />
      </div>

      {/* 麦克风按钮 */}
      <button
        onClick={handleToggle}
        disabled={!!micError}
        className={`
          relative w-14 h-14 rounded-full flex items-center justify-center
          transition-all duration-200
          ${micError
            ? "bg-red-500/30 cursor-not-allowed"
            : isCapturing
              ? "bg-emerald-600 hover:bg-emerald-500 ring-2 ring-emerald-400/40"
              : "bg-slate-700 hover:bg-slate-600"
          }
        `}
      >
        {isCapturing && (
          <span className="absolute inset-0 rounded-full bg-emerald-400/20 animate-ping" />
        )}
        <Mic className="w-5 h-5 text-white relative z-10" />
      </button>

      {/* 错误提示 */}
      {micError && (
        <div className="flex items-center gap-2 text-red-400 text-[11px]">
          <AlertCircle className="w-3.5 h-3.5" />
          {micError}
        </div>
      )}

      {/* 调试栏 */}
      <div className="w-full flex justify-between text-[10px] text-slate-600">
        <span>上行 {((bytesSent / 1024) || 0).toFixed(1)} KB</span>
        <span>队列 {player.queueLength}</span>
      </div>
    </div>
  );
}
