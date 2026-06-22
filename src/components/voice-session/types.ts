// ── 状态机枚举 ──
export type VoiceSessionState =
  | "IDLE"           // 初始 / 断开连接
  | "USER_SPEAKING"  // VAD 检测到人声
  | "PROCESSING"     // VAD 判定人声结束，等待 AI
  | "AI_SPEAKING"    // 缓冲队列正在播放
  | "ERROR";         // 异常阻断

// ── Gemini Live API 协议类型 ──

/** 发送：会话配置 */
export interface GeminiSetupMessage {
  setup: {
    model: string;
    generationConfig: {
      responseModalities: string[];
      speechConfig?: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: string };
        };
      };
      temperature?: number;
    };
    systemInstruction?: {
      parts: { text: string }[];
    };
  };
}

/** 发送：实时音频块 */
export interface GeminiAudioInput {
  realtimeInput: {
    mediaChunks: Array<{
      mimeType: string;  // "audio/pcm;rate=16000"
      data: string;       // base64
    }>;
  };
}

/** 发送：文本消息 */
export interface GeminiTextInput {
  // Note: Google's JS SDK uses realtimeInput.text only (no mediaChunks wrapper)
  // But raw WebSocket API also supports this directly
  clientContent?: {
    turns: Array<{
      role: string;
      parts: { text: string }[];
    }>;
    turnComplete: boolean;
  };
}

/** 接收：服务器消息 */
export interface GeminiServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: {
      parts: Array<{
        text?: string;
        inlineData?: {
          mimeType: string;   // "audio/pcm;rate=24000"
          data: string;        // base64
        };
      }>;
    };
    interrupted?: boolean;
    turnComplete?: boolean;
    inputTranscription?: { text: string; finished: boolean };
    outputTranscription?: { text: string; finished: boolean };
  };
  toolCall?: unknown;
}

/** 解析后的回调事件 */
export interface VoiceSessionEvent {
  type: "SETUP_COMPLETE"
      | "AUDIO"
      | "TEXT"
      | "INTERRUPTED"
      | "TURN_COMPLETE"
      | "INPUT_TRANSCRIPTION"
      | "OUTPUT_TRANSCRIPTION"
      | "ERROR";
  data: unknown;
}

// ── 解析 Gemini 响应为事件数组 ──
export function parseServerMessage(msg: GeminiServerMessage): VoiceSessionEvent[] {
  const events: VoiceSessionEvent[] = [];
  const sc = msg.serverContent;

  if (msg.setupComplete) {
    events.push({ type: "SETUP_COMPLETE", data: null });
    return events;
  }

  if (sc?.modelTurn?.parts) {
    for (const part of sc.modelTurn.parts) {
      if (part.inlineData) {
        events.push({ type: "AUDIO", data: part.inlineData.data });
      } else if (part.text) {
        events.push({ type: "TEXT", data: part.text });
      }
    }
  }

  if (sc?.inputTranscription) {
    events.push({ type: "INPUT_TRANSCRIPTION", data: sc.inputTranscription });
  }
  if (sc?.outputTranscription) {
    events.push({ type: "OUTPUT_TRANSCRIPTION", data: sc.outputTranscription });
  }
  if (sc?.interrupted) {
    events.push({ type: "INTERRUPTED", data: null });
  }
  if (sc?.turnComplete) {
    events.push({ type: "TURN_COMPLETE", data: null });
  }

  return events;
}

// ── 常量 ──
export const GEMINI_MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";
export const WS_URL = "ws://localhost:17891";
export const PCM_INPUT_RATE = 16000;  // 前端采集采样率
export const PCM_OUTPUT_RATE = 24000; // Gemini 输出采样率
