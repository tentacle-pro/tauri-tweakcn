import { useRef, useState, useCallback, useEffect } from "react";
import { PCM_OUTPUT_RATE } from "./types";

interface UseAudioPlayerReturn {
  /** 是否正在播放 */
  isPlaying: boolean;
  /** 当前缓冲队列长度 */
  queueLength: number;
  /** 推入一段 base64 PCM24k 音频到播放队列 */
  enqueue: (base64Data: string) => void;
  /** 立即清空队列并停止播放（打断用） */
  flush: () => void;
  /** 暂停 */
  pause: () => void;
  /** 恢复 */
  resume: () => void;
}

export function useAudioPlayer(): UseAudioPlayerReturn {
  const [isPlaying, setIsPlaying] = useState(false);
  const [queueLength, setQueueLength] = useState(0);
  const ctxRef = useRef<AudioContext | null>(null);
  const queueRef = useRef<AudioBuffer[]>([]);
  const playingRef = useRef(false);
  const flushRef = useRef(false);
  const nextStartRef = useRef(0); // 下一个 buffer 的调度时间

  const ensureCtx = useCallback(() => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext({ sampleRate: PCM_OUTPUT_RATE });
    }
    if (ctxRef.current.state === "suspended") {
      ctxRef.current.resume();
    }
    return ctxRef.current;
  }, []);

  const enqueue = useCallback((base64Data: string) => {
    const ctx = ensureCtx();
    // base64 → Uint8Array → Int16Array
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const buffer = ctx.createBuffer(1, float32.length, PCM_OUTPUT_RATE);
    buffer.getChannelData(0).set(float32);

    queueRef.current.push(buffer);
    setQueueLength(queueRef.current.length);

    // 如果没在播放，启动播放循环
    if (!playingRef.current) {
      playingRef.current = true;
      setIsPlaying(true);
      nextStartRef.current = ctx.currentTime;
      scheduleNext();
    }
  }, [ensureCtx]);

  const scheduleNext = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;

    const next = queueRef.current.shift();
    setQueueLength(queueRef.current.length);

    if (!next || flushRef.current) {
      playingRef.current = false;
      setIsPlaying(false);
      flushRef.current = false;
      return;
    }

    const source = ctx.createBufferSource();
    source.buffer = next;
    source.connect(ctx.destination);
    const startTime = nextStartRef.current;
    source.start(startTime);
    nextStartRef.current = startTime + next.duration;

    source.onended = () => scheduleNext();
  }, []);

  const flush = useCallback(() => {
    flushRef.current = true;
    queueRef.current = [];
    setQueueLength(0);
    ctxRef.current?.close();
    ctxRef.current = null;
    playingRef.current = false;
    setIsPlaying(false);
  }, []);

  const pause = useCallback(() => {
    ctxRef.current?.suspend();
  }, []);

  const resume = useCallback(() => {
    ensureCtx();
  }, [ensureCtx]);

  useEffect(() => () => { ctxRef.current?.close(); }, []);

  return { isPlaying, queueLength, enqueue, flush, pause, resume };
}
