import { useRef, useState, useCallback, useEffect } from "react";
import {
  WS_URL,
  GEMINI_MODEL,
  type GeminiAudioInput,
  type GeminiServerMessage,
  type VoiceSessionEvent,
  parseServerMessage,
} from "./types";

interface UseGeminiWSReturn {
  /** 当前 WS readyState (0-3) */
  readyState: number;
  /** 累计上行字节数 */
  bytesSent: number;
  /** 发送 PCM base64 音频块 */
  sendAudio: (base64Data: string) => void;
  /** 收到 Gemini 事件的回调注册 */
  onEvent: (cb: (e: VoiceSessionEvent) => void) => void;
  /** 主动关闭连接 */
  disconnect: () => void;
}

export function useGeminiWS(
  model: string = GEMINI_MODEL,
  onStateChange?: (s: "IDLE" | "ERROR") => void,
): UseGeminiWSReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const [readyState, setReadyState] = useState<number>(WebSocket.CLOSED);
  const bytesSentRef = useRef(0);
  const [bytesSent, setBytesSent] = useState(0);
  const eventCbRef = useRef<((e: VoiceSessionEvent) => void) | null>(null);

  const retryCountRef = useRef(0);
  const MAX_RETRIES = 5;

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (retryCountRef.current >= MAX_RETRIES) {
      console.error(`[GeminiWS] 已达最大重试次数 ${MAX_RETRIES}，放弃连接`);
      onStateChange?.("ERROR");
      return;
    }

    console.log(`[GeminiWS] 正在连接 ${WS_URL} (尝试 ${retryCountRef.current + 1}/${MAX_RETRIES})...`);
    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer"; // Gemini 下行是 Binary 帧，需 arraybuffer 才能 TextDecoder
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[GeminiWS] 已连接，发送 setup...");
      retryCountRef.current = 0;
      setReadyState(WebSocket.OPEN);
      ws.send(JSON.stringify({
        setup: {
          model,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: "Puck" },
              },
            },
          },
        },
      }));
    };

    ws.onmessage = (ev: MessageEvent) => {
      try {
        // ev.data 可能是 string（Text 帧）或 ArrayBuffer（Binary 帧）
        const raw = typeof ev.data === "string"
          ? ev.data
          : new TextDecoder().decode(new Uint8Array(ev.data as ArrayBuffer));
        const data: GeminiServerMessage = JSON.parse(raw);
        const events = parseServerMessage(data);
        for (const e of events) {
          eventCbRef.current?.(e);
        }
      } catch (err) {
        console.warn("[GeminiWS] onmessage parse error:", err);
      }
    };

    ws.onclose = (ev) => {
      console.warn(`[GeminiWS] 连接关闭 (code=${ev.code}, reason=${ev.reason})`);
      setReadyState(WebSocket.CLOSED);
      onStateChange?.("IDLE");
    };

    ws.onerror = () => {
      console.error(`[GeminiWS] 连接错误（尝试 ${retryCountRef.current + 1}/${MAX_RETRIES}），1s 后重试...`);
      retryCountRef.current++;
      setReadyState(WebSocket.CLOSED);
      wsRef.current = null;
      setTimeout(connect, 1000);
    };
  }, [model, onStateChange]);

  // auto-connect on mount
  useEffect(() => {
    connect();
    return () => { wsRef.current?.close(); };
  }, [connect]);

  const sendAudio = useCallback((base64Data: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    const msg: GeminiAudioInput = {
      realtimeInput: {
        mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64Data }],
      },
    };
    wsRef.current.send(JSON.stringify(msg));
    bytesSentRef.current += base64Data.length;
    setBytesSent(bytesSentRef.current);
  }, []);

  const onEvent = useCallback((cb: (e: VoiceSessionEvent) => void) => {
    eventCbRef.current = cb;
  }, []);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  return { readyState, bytesSent, sendAudio, onEvent, disconnect };
}
