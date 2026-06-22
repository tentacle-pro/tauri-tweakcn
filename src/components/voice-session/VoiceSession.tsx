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

import React, { useState, useRef } from "react";
import { Mic, AlertCircle } from "lucide-react";
import { useGeminiWS } from "./useGeminiWS";
import { useMediaStream } from "./useMediaStream";
import { useAudioPlayer } from "./useAudioPlayer";
import type { VoiceSessionEvent } from "./types";

type Phase = "idle" | "listening" | "ai_speaking";

export function VoiceSession() {
  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const go = (p: Phase) => {
    if (phaseRef.current === p) return;
    console.log("[Voice] phase:", phaseRef.current, "→", p);
    phaseRef.current = p;
    setPhase(p);
  };

  const { sendAudio, onEvent, bytesSent } = useGeminiWS();
  const {
    error: micError,
    isCapturing,
    start: micStart,
    stop: micStop,
    readChunkBase64,
  } = useMediaStream();
  const player = useAudioPlayer();

  // ── 处理 Gemini 下行事件 ──
  React.useEffect(() => {
    onEvent((ev: VoiceSessionEvent) => {
      console.log("[Voice] Gemini ev:", ev.type);
      switch (ev.type) {
        case "AUDIO":
          if (typeof ev.data === "string") {
            player.enqueue(ev.data);
            go("ai_speaking");
          }
          break;
        case "TURN_COMPLETE":
        case "INTERRUPTED":
          go("listening");
          break;
      }
    });
  }, [onEvent, player]);

  // ── 上行音频心跳（isCapturing 期间每 100ms 发一帧）──
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
      if (txRef.current) {
        clearInterval(txRef.current);
        txRef.current = null;
      }
    };
  }, [isCapturing, readChunkBase64, sendAudio]);

  // ── 按钮 ──
  const handleToggle = async () => {
    if (isCapturing) {
      micStop();
      player.flush();
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
    <div className="flex flex-col items-center gap-6 p-8 min-h-[280px] bg-gradient-to-b from-slate-900 to-slate-800 rounded-2xl text-white select-none">

      {/* 状态文字 */}
      <div className="text-xs uppercase tracking-widest text-slate-400 h-4">
        {phaseLabel[phase]}
      </div>

      {/* 动效区 */}
      <div className="w-64 h-20 flex items-center justify-center">
        {phase === "idle" && (
          <div className="w-full h-px bg-slate-600" />
        )}
        {phase === "listening" && (
          <div className="flex gap-1.5 items-end">
            {[8, 14, 20, 14, 8, 14, 20, 14, 8].map((h, i) => (
              <div
                key={i}
                className="w-1.5 bg-emerald-500/60 rounded-full animate-pulse"
                style={{ height: h, animationDelay: `${i * 0.08}s` }}
              />
            ))}
          </div>
        )}
        {phase === "ai_speaking" && (
          <div className="flex gap-1 items-end">
            {Array.from({ length: 20 }).map((_, i) => (
              <div
                key={i}
                className="w-1.5 bg-emerald-400 rounded-full"
                style={{
                  height: 4 + Math.abs(Math.sin(i * 0.55 + Date.now() / 200)) * 44,
                  transition: "height 80ms ease",
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* 麦克风按钮 */}
      <button
        onClick={handleToggle}
        className={`
          relative w-16 h-16 rounded-full flex items-center justify-center
          transition-all duration-200
          ${isCapturing
            ? "bg-emerald-600 hover:bg-emerald-500 ring-2 ring-emerald-400/50"
            : "bg-slate-700 hover:bg-slate-600"
          }
        `}
      >
        {isCapturing && (
          <span className="absolute inset-0 rounded-full bg-emerald-400/20 animate-ping" />
        )}
        <Mic className="w-6 h-6 text-white relative z-10" />
      </button>

      {/* 错误提示 */}
      {micError && (
        <div className="flex items-center gap-2 text-red-400 text-xs">
          <AlertCircle className="w-4 h-4" />
          {micError}
        </div>
      )}

      {/* 调试信息 */}
      <div className="text-[10px] text-slate-600">
        上行 {((bytesSent / 1024) || 0).toFixed(1)} KB · 播放队列 {player.queueLength}
      </div>
    </div>
  );
}
