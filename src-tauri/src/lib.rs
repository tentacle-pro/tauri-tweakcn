use tauri::{ Manager, Emitter};
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::os::unix::io::FromRawFd;
use std::sync::{Arc, Mutex};

/// 托管状态：持有 gost 子进程句柄，App 退出时由 RunEvent::Exit 负责 kill
struct GostChild(Arc<Mutex<Option<std::process::Child>>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info) // 你可以设置一个全局的默认级别，例如 Info
                .level_for("tao", log::LevelFilter::Warn) // 将 tao crate 的日志级别设为 Warn
                .build()
        )
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_macos_permissions::init())
        .setup(|app| {
            // 获取当前工作目录，用于调试
            let current_dir = std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| "无法获取当前工作目录".to_string());
            println!("当前工作目录: {}", current_dir);
            
            let app_handle = app.handle();
            let window = app_handle.get_webview_window("main").unwrap();

            // 将凭证放在 JSON 配置中通过匿名管道传递，ps(1) 只会看到 `gost -C /dev/fd/3`
            let config_json = serde_json::json!({
                "ServeNodes": ["socks5://admin:dynamic_pass_123@127.0.0.1:17890"],
                "ChainNodes": ["relay+mtls://blackwidow:NqX3zj6wG3rxYwzu@80.251.216.81:65200"]
            }).to_string();

            // 创建匿名管道，并对两端设置 O_CLOEXEC（不泄漏到非预期的子进程）
            let mut pipe_fds = [0i32; 2];
            unsafe {
                if libc::pipe(pipe_fds.as_mut_ptr()) != 0 {
                    return Err("pipe() failed".into());
                }
                libc::fcntl(pipe_fds[0], libc::F_SETFD, libc::FD_CLOEXEC);
                libc::fcntl(pipe_fds[1], libc::F_SETFD, libc::FD_CLOEXEC);
            }
            let (read_fd, write_fd) = (pipe_fds[0], pipe_fds[1]);

            // 写入配置后关闭写端 → 读端收到 EOF，gost 完成配置解析后继续运行
            {
                let mut write_file = unsafe { std::fs::File::from_raw_fd(write_fd) };
                write_file.write_all(config_json.as_bytes())
                    .map_err(|e| format!("failed to write gost config: {e}"))?;
                // write_file 在此 drop → write_fd 关闭
            }

            // 解析 sidecar 二进制路径（与 Tauri sidecar 解析逻辑一致）
            let gost_path = {
                let exe = std::env::current_exe()?;
                let exe_dir = exe.parent().ok_or("cannot resolve exe directory")?;
                if cfg!(debug_assertions) {
                    exe_dir.join("../../bin").join(
                        format!("gost-{}-apple-darwin", std::env::consts::ARCH)
                    )
                } else {
                    // 打包后 externalBin 与主程序同目录（MacOS/）
                    exe_dir.join("gost")
                }
            };
            println!("gost binary: {:?}", gost_path);

            // 启动 gost，命令行仅含 `-C /dev/fd/3`，不暴露任何凭证
            let mut cmd = std::process::Command::new(&gost_path);
            cmd.args(["-C", "/dev/fd/3"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped());

            // fork 后、exec 前：将 read_fd dup2 到 fd 3
            // dup2 的目标 fd 不继承 O_CLOEXEC，exec 后 fd 3 保持打开供 gost 读取
            unsafe {
                cmd.pre_exec(move || {
                    if libc::dup2(read_fd, 3) == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if read_fd != 3 {
                        libc::close(read_fd);
                    }
                    Ok(())
                });
            }

            let child = cmd.spawn()
                .map_err(|e| format!("failed to spawn gost: {e}"))?;

            // 父进程关闭读端（子进程 fork 后已持有自己的副本）
            unsafe { libc::close(read_fd); }

            // 将 gost stdout 转发到 webview；退出处理通过 RunEvent::Exit 统一 kill
            let child_arc = Arc::new(Mutex::new(Some(child)));
            let child_for_thread = child_arc.clone();
            let stdout = child_for_thread.lock().unwrap().as_mut().unwrap().stdout.take().unwrap();
            std::thread::spawn(move || {
                use std::io::BufRead;
                for line in std::io::BufReader::new(stdout).lines().flatten() {
                    window
                        .emit("message", Some(format!("'{}'", line)))
                        .ok();
                }
                // stdout 读完后回收子进程
                if let Some(mut c) = child_for_thread.lock().unwrap().take() {
                    c.wait().ok();
                }
            });

            // 注册到 Tauri 状态，供 RunEvent::Exit 时 kill
            app_handle.manage(GostChild(child_arc));

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<GostChild>() {
                    if let Some(mut c) = state.0.lock().unwrap().take() {
                        let _ = c.kill();
                        let _ = c.wait();
                    }
                }
            }
        });
}
