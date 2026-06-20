use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use tauri::path::BaseDirectory;
use tauri::{ Manager, Emitter};

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
            
            // According to dev/production environment, choose different venv_parent_path: ../api or /path/to/app/app_data_dir
            let venv_parent_path = if cfg!(debug_assertions) {
                // 在当前工作目录的上一级目录中寻找api文件夹
                let mut path = std::env::current_dir().map_err(|e| e.to_string())?;
                path.pop(); // 移动到上一级目录
                path.push("api");
                path
            } else {
                app_handle
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
            };
            println!("venv_parent_path: {:?}", venv_parent_path);
            
            // 如果是生产环境，复制BaseDirectory::Resource/api/pyproject.toml到app_data_dir
            if !cfg!(debug_assertions) {
                let resource_api_path = app_handle.path().resolve("api", BaseDirectory::Resource)?;
                let pyproject_src_path = resource_api_path.join("pyproject.toml");
                let pyproject_dest_path = venv_parent_path.join("pyproject.toml");
                println!("pyproject_src_path: {:?}", pyproject_src_path);
                println!("pyproject_dest_path: {:?}", pyproject_dest_path);
                // 总是复制文件，以便在部署新版本后能自动更新虚拟环境
                std::fs::copy(&pyproject_src_path, &pyproject_dest_path).map_err(|e| e.to_string())?;
        
            }
            
            // 创建或更新虚拟环境
            let sidecar_command = app
            .shell()
            .sidecar("uv")
            .unwrap()
            .args(["sync", "--directory", venv_parent_path.to_str().unwrap()]);
            println!("Running command: {:?}", sidecar_command);
            sidecar_command
            .spawn()
            .expect("Failed to spawn sidecar");

            // 通过uv运行app.py
            // 如果是开发环境app.py在../api/app.py，否则在BaseDirectory::Resource/api/app.py
            let app_py_path = if cfg!(debug_assertions) {
                venv_parent_path.join("app.py")
            } else {
                app_handle.path().resolve("api/app.py", BaseDirectory::Resource)?
            };
            println!("app_py_path: {:?}", app_py_path);
            let sidecar_command = app
            .shell()
            .sidecar("uv")
            .unwrap()
            .args([
                "run", 
                "--directory", venv_parent_path.to_str().unwrap(),
                app_py_path.to_str().unwrap(), 
                "--host", "127.0.0.1", 
                "--port", "60316"]);
            println!("Running command: {:?}", sidecar_command);
            let (mut rx, mut child) = sidecar_command
            .spawn()
            .expect("Failed to spawn sidecar");

            tauri::async_runtime::spawn(async move {
            // read events such as stdout
            while let Some(event) = rx.recv().await {
                if let CommandEvent::Stdout(line_bytes) = event {
                let line = String::from_utf8_lossy(&line_bytes);
                window
                    .emit("message", Some(format!("'{}'", line)))
                    .expect("failed to emit event");
                // write to stdin
                child.write("message from Rust\n".as_bytes()).unwrap();
                }
            }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
