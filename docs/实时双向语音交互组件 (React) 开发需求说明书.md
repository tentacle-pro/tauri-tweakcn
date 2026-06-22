# 实时双向语音交互组件 (React) 开发需求说明书

## 1. 架构与定位

* **运行环境：** Tauri 桌面端应用前端 (WebView2 / WKWebView)。
* **技术栈：** React, TypeScript, WebRTC API, Wavesurfer.js。
* **后端依赖：** 通过本地 WebSocket (`ws://127.0.0.1:9090`) 连接至 Rust 主进程。Rust 进程负责统一管理真实 API Key，并通过本地的透明 Gost SOCKS5 代理通道与 Google Gemini Live API 进行全双工通信。
* **核心交互原则：** 全双工（Full-Duplex）对话。摒弃传统的“对讲机”模式与“实时字幕”，支持用户随时打断（Barge-in），通过纯波形动效提供自然的人机交互体验。

---

## 2. 视觉与 UI 设计规范

组件采用“双轨状态反馈”设计，物理分离用户的输入反馈与 AI 的输出反馈。

### 2.1 用户输入区 (The Mic)

作为底层背景或独立小模块，实时反映用户的麦克风状态。

* **常态 (Idle)：** 静止的麦克风图标。
* **聆听态 (Active)：** 伴随底层持续上传音频流，当 VAD（Voice Activity Detection）检测到音量时，图标周围产生涟漪扩散或内部填充起伏动效。
* **禁用态 (Disabled)：** 置灰并显示斜杠（用于无网络、未授权或强制阻断输入的特殊场景）。

### 2.2 模型输出区 (The AI Waveform)

基于 `Wavesurfer.js`（或定制 Canvas 波形）作为主视觉中心。

* **沉寂态 (Silent)：** 一条平静的直线，或极细微的呼吸波纹（表明连接正常但 AI 未发声）。
* **思考态 (Processing)：** 用户发言结束后的停顿期，波浪线匀速流转或跑马灯特效，缓解等待焦虑。
* **输出态 (Speaking)：** 接收到 AI 下发的 PCM/Base64 数据块并进行播放时，渲染动态跳跃的频谱柱或柔体波纹。

---

## 3. 硬件控制与媒体流规范

必须在前端显式声明硬件级别的**回声消除 (AEC)** 和降噪，防止扬声器播放的 AI 声音重新录入麦克风导致死循环。

### 3.1 麦克风约束配置 (MediaStreamConstraints)

```typescript
{
    audio: {
        echoCancellation: true, 
        noiseSuppression: true, 
        autoGainControl: true,  
        channelCount: 1,        // 单声道
        sampleRate: 16000       // 16kHz 采样率
    }
}

```

### 3.2 缓冲队列控制

* **接收队列：** 建立一个基于 `AudioContext` 的缓冲队列（Buffer Queue）。从 WebSocket 收到的音频块（Chunks）必须排队按序播放，禁止并发重叠播放。

---

## 4. 状态机 (FSM) 与并发流控制

本组件的核心逻辑为“数据流常开，UI 状态受控”。不要拦截上行数据，而是通过状态机控制本地的播放队列和视觉呈现。

### 4.1 数据流定义 (并发执行)

* **TX (上行流)：** 只要 WebSocket 连接建立且获得麦克风权限，前端按照固定时间片（如每 100ms）持续向 Rust 推送音频数据块。**无论处于什么业务状态，上行流不断开。**
* **RX (下行流)：** 持续监听 WebSocket 消息，收到音频块即推入缓冲队列。

### 4.2 核心 UI 状态枚举

```typescript
type VoiceSessionState = 
  | "IDLE"          // 初始/断开连接
  | "USER_SPEAKING" // VAD 检测到人声超过阈值
  | "PROCESSING"    // VAD 判定人声结束，等待 AI 响应包
  | "AI_SPEAKING"   // 缓冲队列正在播放音频，Wavesurfer 活跃
  | "ERROR";        // 异常阻断态

```

### 4.3 核心跃迁与“打断 (Barge-in)”机制

打断是本组件最高优先级的交互动作。

* **触发条件：** 当前状态为 `AI_SPEAKING`，同时前端本地的 `AnalyserNode` / VAD 判定麦克风输入音量突然超过人声阈值（用户插嘴）。
* **前端执行动作：**
1. 立即清空当前的音频缓冲队列。
2. 调用 `wavesurfer.stop()` 或 `audioContext.suspend()` 强行终止当前播放。
3. UI 状态强制跃迁为 `USER_SPEAKING`。


* **后端协同：** 因为 TX 上行流是常开的，用户的“插嘴”音频已自然发送至后端。Gemini 服务端接收到新音频后，会自动下发 `turnComplete` 信号或中断当前音频流的下发。

---

## 5. 异常处理与兜底机制

* **权限异常：** 如果 `getUserMedia` 抛出 `NotAllowedError` 或 `NotFoundError`，组件进入 `ERROR` 状态，麦克风图标置灰变红，提示用户检查系统权限。
* **网络断开：** 监听到 WebSocket `onclose` 事件时：
1. 停止 `MediaRecorder` 采集。
2. 销毁 `AudioContext`。
3. 触发重连逻辑（可复用社区标准重连 Hook）。
4. 重连期间组件强制进入 `Disabled` 态。