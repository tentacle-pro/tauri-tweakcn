import { useRef, useState, useCallback, useEffect } from "react";

interface UseVADOptions {
  /** 人声阈值 (RMS, 0-1)，超过此值认为在说话 */
  threshold?: number;
  /** 静音持续多久(ms)后判定发言结束 */
  silenceTimeout?: number;
  /** 定时检测间隔(ms) */
  interval?: number;
}

interface UseVADReturn {
  /** 当前音量 (RMS) */
  volume: number;
  /** 是否正在说话 */
  isSpeaking: boolean;
  /** 连接 AnalyserNode */
  connect: (analyser: AnalyserNode) => void;
  /** 断开 */
  disconnect: () => void;
  /** 注册说话结束回调 */
  onSpeechEnd: (cb: () => void) => void;
}

export function useVAD({
  threshold = 0.03,
  silenceTimeout = 800,
  interval = 100,
}: UseVADOptions = {}): UseVADReturn {
  const [volume, setVolume] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const analyserRef = useRef<AnalyserNode | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSpeakingRef = useRef(false);
  const onSpeechEndRef = useRef<(() => void) | null>(null);

  const connect = useCallback((analyser: AnalyserNode) => {
    analyserRef.current = analyser;
    analyser.fftSize = 256;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    // ── 自动校准：先采集 15 个静音样本（约 1.5s），计算底噪基准 ──
    const CALIB_COUNT = 5; // 5 × 100ms = 0.5s 校准
    let calibBuf: number[] = [];
    let calibratedThreshold = threshold; // 校准完成前用默认值

    let tickCount = 0; // 诊断用（仅前3次）
    timerRef.current = setInterval(() => {
      analyser.getByteTimeDomainData(dataArray);
      tickCount++;
      if (tickCount <= 3) {
        const raws = Array.from(dataArray.slice(0, 8));
        console.log("[VAD] tick#" + tickCount + " raw:", raws);
      }
      let sumSq = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const norm = (dataArray[i] - 128) / 128;
        sumSq += norm * norm;
      }
      const rms = Math.sqrt(sumSq / dataArray.length);
      setVolume(rms);

      // 校准阶段：静默采样，不触发 VAD
      if (calibBuf.length < CALIB_COUNT) {
        calibBuf.push(rms);
        if (calibBuf.length === CALIB_COUNT) {
          const avg = calibBuf.reduce((a, b) => a + b, 0) / CALIB_COUNT;
          calibratedThreshold = Math.max(avg * 4, 0.02);
          console.log(
            "[VAD] ✅ 校准完成: 底噪=", avg.toFixed(4),
            "→ 阈值=", calibratedThreshold.toFixed(4),
          );
        }
        return;
      }

      // ── VAD 检测（用校准后阈值）──
      if (rms > calibratedThreshold) {
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
        if (!isSpeakingRef.current) {
          console.log("[VAD] 🔊 人声, rms=", rms.toFixed(4), "thr=", calibratedThreshold.toFixed(4));
          isSpeakingRef.current = true;
          setIsSpeaking(true);
        }
      } else {
        if (isSpeakingRef.current && !silenceTimerRef.current) {
          console.log("[VAD] 🔕 静音计时开始, rms=", rms.toFixed(4));
          silenceTimerRef.current = setTimeout(() => {
            console.log("[VAD] 🔇 静音超时 → onSpeechEnd");
            isSpeakingRef.current = false;
            setIsSpeaking(false);
            onSpeechEndRef.current?.();
            silenceTimerRef.current = null;
          }, silenceTimeout);
        }
      }
    }, interval);
  }, [threshold, silenceTimeout, interval]);

  const disconnect = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    analyserRef.current = null;
    isSpeakingRef.current = false;
    setIsSpeaking(false);
  }, []);

  // 注册说话结束回调
  const onSpeechEnd = useCallback((cb: () => void) => {
    onSpeechEndRef.current = cb;
  }, []);

  useEffect(() => () => disconnect(), [disconnect]);

  return { volume, isSpeaking, connect, disconnect, onSpeechEnd };
}
