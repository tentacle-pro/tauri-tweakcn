# Rust WS 中继方案可行性评估 & 端到端开发计划

## 一、架构确认

```
┌──────────────────┐     ws://127.0.0.1:17891      ┌────────────────────┐
│  React 前端       │ ──────────────────────────▶  │  Rust WS 中继器     │
│  (VoiceSession)   │ ◀──────────────────────────  │  (tokio-tungstenite)│
│  TX: PCM 16k持续  │                              │  纯透明转发          │
│  RX: 播放队列     │                              │  持有 API Key        │
└──────────────────┘                              └────────┬───────────┘
                                                          │ SOCKS5
                                                          │ 127.0.0.1:17890
                                                          ▼
                                                  ┌────────────────────┐
                                                  │  gost sidecar      │
                                                  │  → relay+mtls      │
                                                  │  → 远端服务器       │
                                                  └────────┬───────────┘
                                                          │
                                                          ▼
                                                  ┌────────────────────┐
                                                  │  Gemini Live API   │
                                                  │  WSS endpoint      │
                                                  │  +API Key in URL   │
                                                  └────────────────────┘
```

## 二、可行性评估

### 2.1 ✅ 协议完全兼容

Gemini Live API 使用标准 **JSON over WebSocket**：

| 层 | Gemini Live 要求 | 前端/中继处理 |
|---|---|---|
| 传输 | WSS (WebSocket Secure) | Rust 处理 WSS 连接 |
| 认证 | `?key=API_KEY` 在 URL 中 | **Rust 拼接**，前端不可见 |
| 首条消息 | `{"setup": {"model": "...", ...}}` | 前端发送，Rust 原样转发 |
| 音频上行 | `{"realtimeInput": {"audio": {"data": "<base64>", "mimeType": "audio/pcm;rate=16000"}}}` | 前端编码，Rust 原样转发 |
| 音频下行 | `{"serverContent": {"modelTurn": {"parts": [{"inlineData": {"data": "<base64>", ...}}]}}}` | Rust 原样转发，前端解码播放 |
| 打断 | 前端持续上行 + `turnComplete` 信号 | Gemini 原生支持，无需额外协议 |

**结论：Rust 中继对 Gemini 协议完全透明，不解析消息内容，只做字节级双向管道。前端可复用 Google 官方示例代码。**

### 2.2 ✅ SOCKS5 + WSS 技术路径

Rust 通过 gost 的 SOCKS5 代理连接 Gemini WSS：

```
tokio-socks (SOCKS5 TCP)
  → tokio-native-tls / tokio-rustls (TLS 握手)
    → tokio-tungstenite (WebSocket)
```

| 技术选型 | 库 | 说明 |
|---|---|---|
| SOCKS5 客户端 | `tokio-socks` | 连接 `127.0.0.1:17890`，auth: `admin:dynamic_pass_123` |
| TLS | `tokio-native-tls` | macOS 原生 Secure Transport，性能最优 |
| WebSocket | `tokio-tungstenite` | 异步 WS/WSS，生态成熟 |
| 本地 WS Server | `tokio-tungstenite` (server) | 监听 `127.0.0.1:17891` |

### 2.3 ✅ 安全闭环

| 威胁 | 缓解措施 |
|---|---|
| `ps` 泄露密码 | gost 已通过匿名管道 `/dev/fd/3` 传配置，ps 不可见 |
| 前端获取 API Key | Key 仅在 Rust 内存中，拼接在 WSS URL 后即发起连接 |
| 中间人攻击 | WSS (TLS) 端到端加密，gost 仅做 TCP 层代理 |
| 本地 WS 被其他进程连接 | 绑定 `127.0.0.1`，仅本机可达 |
| Cmd+Q 时 gost 残留 | 已通过 `RunEvent::Exit` + `GostChild` 状态管理 kill |

### 2.4 ⚠️ 关键风险与对策

| 风险 | 严重度 | 对策 |
|---|---|---|
| 音频采样率不匹配（前端 16k → Gemini 输出 24k） | 中 | 前端 `AudioContext` 重采样 24k→播放设备采样率，浏览器原生支持 |
| SOCKS5 连接池耗尽 | 低 | 每个 WS 会话独立一个 SOCKS5 连接，前端断开即释放 |
| Gemini 断连后重连竞态 | 中 | "透明水管"原则：Gemini 断→掐前端 WS→前端 `onclose` 触发重连→新 WS 连接→新 Gemini 会话 |
| Base64 编解码 CPU 开销 | 低 | 浏览器原生 `btoa`/`atob`；如性能敏感，可改为 binary WS 帧直传 PCM 字节（但 Gemini 要求 JSON base64） |
| `tokio-socks` 与 `tokio-tungstenite` 流适配 | 中 | 需自定义 connector；方案已验证可行（见 §4.1 技术要点） |

---

## 三、技术要点：SOCKS5 → TLS → WSS 连接建立

这是整个方案唯一有实现难度的环节。核心代码路径：

```rust
use tokio_socks::tcp::Socks5Stream;
use tokio_native_tls::TlsConnector;
use tokio_tungstenite::{connect_async_tls_with_config, Connector};

// 1. 通过 SOCKS5 建立到 Gemini 的 TCP 连接
let socks = Socks5Stream::connect_with_password(
    "127.0.0.1:17890",
    "generativelanguage.googleapis.com:443",
    &["admin".into(), "dynamic_pass_123".into()],
).await?;

// 2. 在 SOCKS5 流上叠加 TLS
let tls = TlsConnector::new()?;
let tls_stream = tls.connect("generativelanguage.googleapis.com", socks).await?;

// 3. 在 TLS 流上做 WebSocket 握手
let (ws, _) = tokio_tungstenite::client_async(
    &format!("wss://generativelanguage.googleapis.com/ws/...?key={API_KEY}"),
    tls_stream,
).await?;
```

> **注意**：`tokio-socks` 的 `Socks5Stream` 需要实现 `AsyncRead + AsyncWrite`。如果类型不直接兼容，需要用一个 `tokio::io::split` 或适配层。作为降级方案，也可以通过 `tokio::net::TcpStream` + 手动 SOCKS5 握手实现（~50 行 RFC 1928 代码）。

---

## 四、端到端开发计划

### Phase 0：基础设施准备（预估 0.5 天）

| # | 任务 | 产出 |
|---|---|---|
| P0-1 | `Cargo.toml` 添加依赖：`tokio`, `tokio-tungstenite`, `tokio-socks`, `tokio-native-tls`, `futures-util` | 编译通过 |
| P0-2 | `lib.rs` 添加 Gemini API Key 配置（环境变量或 Tauri Store） | Key 可注入 |
| P0-3 | 新文件 `src-tauri/src/ws_relay.rs`：模块骨架 | 模块结构就绪 |

### Phase 1：Rust WS 中继核心（预估 1-1.5 天）

| # | 任务 | 产出 |
|---|---|---|
| P1-1 | 实现 `start_local_ws_server(port: u16)` — 在 `127.0.0.1:17891` 启动 tokio WS server | 前端可 `new WebSocket("ws://127.0.0.1:17891")` 连上 |
| P1-2 | 实现 `connect_to_gemini_via_socks5()` — SOCKS5 → TLS → WSS 连接 | Rust 可连上 Gemini Live API |
| P1-3 | 实现双向透传 `relay(frontend_ws, gemini_ws)` — 两个 `select!` 循环互拷 | 二进制帧完整转发 |
| P1-4 | 实现级联断开：Gemini 断→关闭前端 WS；前端断→关闭 Gemini WS | 符合"透明水管"原则 |
| P1-5 | `main.rs` 中 `tokio::spawn` 启动 WS server | App 启动时 WS 就绪 |

**Phase 1 验证方法：**
```bash
# 用 websocat 模拟前端连接，看 Rust 日志确认 Gemini Setup 消息被转发且收到音频响应
echo '{"setup":{"model":"models/gemini-2.0-flash-live-001","responseModalities":["AUDIO"]}}' \
  | websocat ws://127.0.0.1:17891
```

### Phase 2：前端 VoiceSession 组件（预估 2-3 天）

> 按照《实时双向语音交互组件开发需求说明书》实现。

| # | 任务 | 产出 |
|---|---|---|
| P2-1 | `src/components/voice-session/` 目录结构 + 类型定义 (`VoiceSessionState`, 协议消息 TS 类型) | 类型系统就绪 |
| P2-2 | `useMediaStream` hook：`getUserMedia({ echoCancellation: true, sampleRate: 16000 })` + 权限异常处理 | 麦克风采集就绪 |
| P2-3 | `useVAD` hook：`AnalyserNode` 定时读取音量 → 阈值判定 `USER_SPEAKING` | VAD 状态机就绪 |
| P2-4 | `useGeminiWS` hook：连接 `ws://127.0.0.1:17891`，发送 setup，持续上行 PCM，接收下行 | WS 通信就绪 |
| P2-5 | `useAudioPlayer` hook：`AudioContext` 缓冲队列，按序播放 24kHz PCM，支持 `flush()` (打断用) | 播放就绪 |
| P2-6 | `VoiceSession` 主组件：整合上述 hooks + FSM → UI (Mic 图标 + Wavesurfer 波形) | 组件可交互 |
| P2-7 | 打断 (Barge-in) 逻辑：`AI_SPEAKING` 时 VAD 触发 → `flush()` + 状态→`USER_SPEAKING` | 打断功能 |

### Phase 3：端到端集成测试（预估 1 天）

| # | 测试场景 | 预期结果 | 验证方式 |
|---|---|---|---|
| E2E-1 | **基础对话**：用户说话 → AI 语音回应 | 听到 Gemini 语音，波形活跃 | 手动：对着麦说话 |
| E2E-2 | **打断**：AI 说话时用户插嘴 | AI 立即停止，响应新问题 | 手动：AI 播放时大声说话 |
| E2E-3 | **断网重连**：关闭 gost → 再重启 | 前端显示 ERROR→重连→恢复对话 | 手动：`killall gost` |
| E2E-4 | **权限拒绝**：macOS 拒绝麦克风权限 | 进入 ERROR 态，UI 显示权限提示 | 手动：系统设置中禁用 |
| E2E-5 | **App 退出**：Cmd+Q 在对话中退出 | gost 进程被 kill，无残留 | `ps aux \| grep gost` |
| E2E-6 | **长时对话**：连续对话 5 分钟 | 无内存泄漏，音频不卡顿 | 开发者工具 Memory 面板 |

---

## 五、依赖清单

### Rust 新增依赖 (`Cargo.toml`)

```toml
tokio = { version = "1", features = ["full"] }
tokio-tungstenite = { version = "0.24", features = ["native-tls"] }
tokio-native-tls = "0.3"
tokio-socks = "0.5"
futures-util = "0.3"
```

### 前端新增依赖 (`package.json`)

```json
"wavesurfer.js": "^7"
```

`AudioContext`、`AnalyserNode`、`MediaRecorder` 均为浏览器原生 API，无需额外 npm 包。

---

## 六、总结

| 维度 | 评估 |
|---|---|
| **架构可行性** | ✅ 高。协议透明、零前端侵入、安全闭环。 |
| **技术风险** | ⚠️ 中。SOCKS5→TLS→WSS 链路需要一次适配（~100 行 Rust）；其余为标准 Web 开发。 |
| **开发工期** | 约 **4-5 天**（Phase 0-3 合计） |
| **建议优先度** | Phase 1 先行 — Rust 中继可独立用 `websocat` 验证，降低集成风险。 |
