import { useRef, useState, useCallback, useEffect } from "react";
import { PCM_INPUT_RATE } from "./types";

interface UseMediaStreamReturn {
  /** 浏览器麦克风流 */
  stream: MediaStream | null;
  /** 错误信息 */
  error: string | null;
  /** 当前是否在采集 */
  isCapturing: boolean;
  /** 开始采集 */
  start: () => Promise<void>;
  /** 停止采集 */
  stop: () => void;
  /** 读取一块 PCM 数据（Int16, 16kHz, mono），返回 base64 */
  readChunkBase64: () => string | null;
}

export function useMediaStream(): UseMediaStreamReturn {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const bufferRef = useRef<Int16Array[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const start = useCallback(async () => {
    console.log("[MediaStream] 请求麦克风权限...");
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          // 不强制 sampleRate：macOS 设备固定 48kHz，约束会被忽略或造成静音
        },
      });
      console.log("[MediaStream] getUserMedia 成功, tracks:", s.getAudioTracks().length);

      const ctx = new AudioContext(); // 不强制 sampleRate，用设备原生率（macOS 通常 48kHz）
      // WKWebView 下 AudioContext 初始为 suspended，必须显式 resume
      await ctx.resume();
      const nativeRate = ctx.sampleRate;
      console.log("[MediaStream] AudioContext state=", ctx.state, "nativeRate=", nativeRate);
      const source = ctx.createMediaStreamSource(s);

      // ScriptProcessorNode: 4096 帧/回调，nativeRate 下约每 85ms 一次
      // 单一路径：source → proc → gainNode(0) → destination
      // 注意：不可从 source 开两条并行路径 —— WKWebView 下会导致其中一路全零
      const proc = ctx.createScriptProcessor(4096, 1, 1);

      proc.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        // 降采样：nativeRate → 16kHz，最近邻插值
        const targetLen = Math.floor(input.length * PCM_INPUT_RATE / nativeRate);
        const int16 = new Int16Array(targetLen);
        for (let i = 0; i < targetLen; i++) {
          const srcIdx = Math.min(
            Math.round(i * nativeRate / PCM_INPUT_RATE),
            input.length - 1,
          );
          int16[i] = Math.max(-32768, Math.min(32767, Math.round(input[srcIdx] * 32767)));
        }
        bufferRef.current.push(int16);
      };

      source.connect(proc);
      const gainNode = ctx.createGain();
      gainNode.gain.value = 0;
      proc.connect(gainNode);
      gainNode.connect(ctx.destination);

      audioCtxRef.current = ctx;
      sourceRef.current = source;
      processorRef.current = proc;
      streamRef.current = s;
      setStream(s);
      setIsCapturing(true);
      setError(null);
      console.log("[MediaStream] 采集已启动, isCapturing=true");
    } catch (e) {
      const err = e as DOMException;
      console.error("[MediaStream] getUserMedia 失败:", err.name, err.message);
      if (err.name === "NotAllowedError") {
        setError("麦克风权限被拒绝，请在系统设置中允许");
      } else if (err.name === "NotFoundError") {
        setError("未找到麦克风设备");
      } else {
        setError(`麦克风错误: ${err.message}`);
      }
    }
  }, []);

  const stop = useCallback(() => {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    audioCtxRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
    setIsCapturing(false);
  }, []);

  // 清理 — 仅组件卸载时执行
  useEffect(() => {
    return () => {
      processorRef.current?.disconnect();
      audioCtxRef.current?.close();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const readChunkBase64 = useCallback((): string | null => {
    const bufs = bufferRef.current;
    if (bufs.length === 0) return null;

    // 合并所有缓冲块
    let totalLen = 0;
    for (const b of bufs) totalLen += b.length;
    const merged = new Int16Array(totalLen);
    let offset = 0;
    for (const b of bufs) {
      merged.set(b, offset);
      offset += b.length;
    }
    bufferRef.current = [];

    // Int16 → base64
    const bytes = new Uint8Array(merged.buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }, []);

  return {
    stream,
    error,
    isCapturing,
    start,
    stop,
    readChunkBase64,
  };
}
