use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use tokio::net::TcpListener;
use tokio_native_tls::TlsConnector;
use tokio_socks::tcp::Socks5Stream;

/// Gemini Live API WSS 端点（不含 key，由本模块动态拼接）
const GEMINI_WSS_BASE: &str = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/// SOCKS5 代理地址（gost sidecar）
const SOCKS5_PROXY: &str = "127.0.0.1:17890";
const SOCKS5_USER: &str = "admin";
const SOCKS5_PASS: &str = "dynamic_pass_123";

/// 本地 WS server 监听端口
const LOCAL_WS_PORT: u16 = 17891;

pub async fn start_local_ws_relay(api_key: Arc<str>) {
    let addr = format!("127.0.0.1:{LOCAL_WS_PORT}");
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => {
            info!("WS 中继器已启动: ws://{addr}");
            l
        }
        Err(e) => {
            error!("WS 中继器绑定 {} 失败: {e}", addr);
            return;
        }
    };

    loop {
        let (tcp_stream, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                error!("accept 失败: {e}");
                continue;
            }
        };
        info!("前端连接: {peer}");

        let key = Arc::clone(&api_key);
        tokio::spawn(async move {
            if let Err(e) = handle_frontend_connection(tcp_stream, &key).await {
                warn!("中继会话结束 (peer={peer}): {e}");
            }
        });
    }
}

async fn handle_frontend_connection(
    tcp_stream: tokio::net::TcpStream,
    api_key: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // 1. WebSocket 握手（前端 → 本地 server）
    let mut frontend_ws = tokio_tungstenite::accept_async(tcp_stream).await?;
    info!("前端 WS 握手完成，开始连接 Gemini ...");

    // 2. SOCKS5 → TLS → WSS 连接 Gemini
    let gemini_ws = match connect_to_gemini(api_key).await {
        Ok(ws) => ws,
        Err(e) => {
            // Gemini 连接失败时先正常关闭前端 WS，避免 websocat 报 I/O failure
            let _ = frontend_ws.close(None).await;
            return Err(e);
        }
    };
    info!("Gemini WSS 已连接，开始中继");

    // 3. 双向透传
    relay(frontend_ws, gemini_ws).await;

    info!("中继会话结束");
    Ok(())
}

async fn connect_to_gemini(
    api_key: &str,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_native_tls::TlsStream<Socks5Stream<tokio::net::TcpStream>>>,
    Box<dyn std::error::Error + Send + Sync>,
> {
    let target = "generativelanguage.googleapis.com:443";

    // Step A: 通过 SOCKS5 代理建立到 Gemini 的 TCP 连接
    info!("SOCKS5: 正在通过 {} 连接 {}", SOCKS5_PROXY, target);
    let socks = Socks5Stream::connect_with_password(
        SOCKS5_PROXY,
        target,
        SOCKS5_USER,
        SOCKS5_PASS,
    )
    .await
    .map_err(|e| {
        error!("SOCKS5 连接失败: {e}");
        format!("SOCKS5 连接失败: {e}")
    })?;
    info!("SOCKS5: 连接成功");

    // Step B: 在 SOCKS5 流上叠加 TLS
    info!("TLS: 正在与 generativelanguage.googleapis.com 握手...");
    let native_connector = tokio_native_tls::native_tls::TlsConnector::builder()
        .build()
        .map_err(|e| {
            error!("TLS Connector 构建失败: {e}");
            format!("TLS Connector 构建失败: {e}")
        })?;
    let tls_connector = TlsConnector::from(native_connector);
    let tls_stream = tls_connector
        .connect("generativelanguage.googleapis.com", socks)
        .await
        .map_err(|e| {
            error!("TLS 握手失败: {e}");
            format!("TLS 握手失败: {e}")
        })?;
    info!("TLS: 握手成功");

    // Step C: WebSocket 握手 — 显式构建 HTTP Upgrade 请求，确保 Sec-WebSocket-Key 等头部正确
    let wss_url = format!("{GEMINI_WSS_BASE}?key={api_key}");
    let uri: http::Uri = wss_url
        .parse()
        .map_err(|e| format!("WSS URL 解析失败: {e}"))?;
    let host = uri
        .authority()
        .map(|a| a.as_str())
        .unwrap_or("generativelanguage.googleapis.com");
    let ws_key = tokio_tungstenite::tungstenite::handshake::client::generate_key();

    let request = http::Request::builder()
        .method("GET")
        .uri(&wss_url)
        .header("Host", host)
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", ws_key.as_str())
        .body(())
        .map_err(|e| format!("构建 WebSocket 请求失败: {e}"))?;

    info!("WSS: 正在向 Gemini 发起 WebSocket 握手 (key={}...)", &ws_key[..8]);
    let (ws, resp) = tokio_tungstenite::client_async(request, tls_stream)
        .await
        .map_err(|e| {
            error!("Gemini WSS 握手失败: {e}");
            format!("Gemini WSS 握手失败: {e}")
        })?;
    info!("WSS: Gemini 握手成功，HTTP status = {}", resp.status());

    Ok(ws)
}

/// 双向透传：前端 ↔ Gemini，任一端断开即关闭另一端
async fn relay(
    mut frontend: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    mut gemini: tokio_tungstenite::WebSocketStream<
        tokio_native_tls::TlsStream<Socks5Stream<tokio::net::TcpStream>>,
    >,
) {
    let mut up_count: u64 = 0;
    let mut down_count: u64 = 0;
    loop {
        tokio::select! {
            // 前端 → Gemini
            msg = frontend.next() => {
                match msg {
                    Some(Ok(m)) => {
                        up_count += 1;
                        if up_count == 1 {
                            info!("[RELAY] 上行 #1 (setup)");
                        } else if up_count == 2 {
                            info!("[RELAY] 上行 #2 (首块 PCM)");
                        }
                        if gemini.send(m).await.is_err() {
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        warn!("前端 WS 读错误: {e}");
                        break;
                    }
                    None => {
                        info!("前端 WS 已关闭 (上行共 {up_count} 条)");
                        break;
                    }
                }
            }
            // Gemini → 前端
            msg = gemini.next() => {
                match msg {
                    Some(Ok(m)) => {
                        down_count += 1;
                        if down_count <= 2 {
                            info!("[RELAY] 下行 #{down_count} (Gemini 响应)");
                        }
                        if frontend.send(m).await.is_err() {
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        warn!("Gemini WS 读错误: {e}");
                        break;
                    }
                    None => {
                        info!("Gemini WS 已关闭 (下行共 {down_count} 条)");
                        break;
                    }
                }
            }
        }
    }

    // 级联关闭
    let _ = frontend.close(None).await;
    let _ = gemini.close(None).await;
}
