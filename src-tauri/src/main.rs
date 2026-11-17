#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use launcher_core::{
    config::Config,
    engine::{self, Progress, Reporter},
    servers::{self, Server},
};
use serde::Serialize;
use std::{path::PathBuf, sync::Arc};
use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex;

struct AppState {
    directory: PathBuf,
    config: Mutex<Config>,
    load_error: Mutex<Option<String>>,
    running: Mutex<Option<launcher_core::launch::EngineChild>>,
    operation: Mutex<()>,
}
fn message(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn reporter(app: &tauri::AppHandle) -> Reporter {
    let app = app.clone();
    Arc::new(move |progress| {
        let _ = app.emit("launcher-progress", progress);
    })
}
#[tauri::command]
async fn get_config(state: State<'_, AppState>) -> Result<Config, String> {
    if let Some(error) = &*state.load_error.lock().await {
        return Err(error.clone());
    }
    Ok(state.config.lock().await.clone())
}
#[tauri::command]
async fn save_config(mut config: Config, state: State<'_, AppState>) -> Result<Config, String> {
    let mut current = state.config.lock().await;
    config
        .save(&state.directory.join("config.json"))
        .map_err(message)?;
    *current = config.clone();
    *state.load_error.lock().await = None;
    Ok(config)
}
#[derive(Serialize)]
struct CatalogResponse {
    servers: Vec<Server>,
    stale: bool,
    warning: Option<String>,
}
#[tauri::command]
async fn get_arizona_servers(state: State<'_, AppState>) -> Result<CatalogResponse, String> {
    let cache = state.directory.join("arizona-cache.json");
    match servers::arizona_catalog().await {
        Ok(servers) => {
            let _ = launcher_core::config::atomic_json(&cache, &servers);
            Ok(CatalogResponse {
                servers,
                stale: false,
                warning: None,
            })
        }
        Err(error) => {
            let cached = std::fs::read(cache)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Vec<Server>>(&bytes).ok());
            cached
                .map(|servers| CatalogResponse {
                    servers,
                    stale: true,
                    warning: Some(format!(
                        "Каталог недоступен, показана сохранённая копия: {error}"
                    )),
                })
                .ok_or_else(|| format!("Не удалось загрузить каталог Arizona: {error:#}"))
        }
    }
}
#[tauri::command]
async fn query_server(address: String) -> Result<Server, String> {
    servers::query_server(&address).await.map_err(message)
}
#[tauri::command]
async fn server_details(address: String) -> servers::Details {
    servers::details(&address).await
}
#[tauri::command]
async fn engine_status(state: State<'_, AppState>) -> Result<Option<engine::Installed>, String> {
    engine::installed(&state.directory.join("engine")).map_err(message)
}
#[tauri::command]
async fn update_engine(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<engine::Installed, String> {
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "Уже выполняется другая операция")?;
    engine::ensure_engine(&state.directory.join("engine"), true, reporter(&app))
        .await
        .map_err(|e| format!("{e:#}"))
}
#[tauri::command]
async fn launch_game(
    app: tauri::AppHandle,
    address: String,
    arz_mode: bool,
    password: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "Уже выполняется запуск или обновление")?;
    {
        let mut running = state.running.lock().await;
        if let Some(child) = running.as_mut() {
            if child.try_wait().map_err(message)?.is_none() {
                return Err("NoveraMP уже запущен".into());
            }
        }
        *running = None;
    }
    let config = state.config.lock().await.clone();
    let report = reporter(&app);
    let args = launcher_core::launch::arguments(&config, &address, arz_mode, password.as_deref())
        .map_err(message)?;
    engine::report(&report, "checking", 2, "Подготовка к запуску…");
    let executable = match launcher_core::launch::executable_override(&config).map_err(message)? {
        Some(path) => path,
        None => engine::ensure_engine(
            &state.directory.join("engine"),
            config.auto_update_engine,
            report.clone(),
        )
        .await
        .map_err(|e| format!("{e:#}"))?
        .directory
        .join(engine::executable_name()),
    };
    if arz_mode {
        engine::report(
            &report,
            "preflight",
            93,
            "Предварительный HTTP-пинг Arizona…",
        );
        if let Err(error) = servers::preflight(&address).await {
            engine::report(
                &report,
                "preflight",
                94,
                format!("HTTP-пинг не ответил ({error}); движок повторит запрос при подключении"),
            );
        }
    }
    let child = launcher_core::launch::spawn(&executable, args, &state.directory.join("logs"))
        .map_err(|e| format!("{e:#}"))?;
    *state.running.lock().await = Some(child);
    {
        let mut config = state.config.lock().await;
        config.recent.retain(|s| s != &address);
        config.recent.insert(0, address);
        let _ = config.save(&state.directory.join("config.json"));
    }
    engine::report(&report, "launched", 100, "NoveraMP запущен");
    let _ = app.emit("engine-running", true);
    if config.hide_after_launch {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
    }
    Ok(())
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let (config, load_error) = match Config::load(&directory.join("config.json")) {
                Ok(c) => (c, None),
                Err(e) => (Config::default(), Some(format!("{e:#}"))),
            };
            app.manage(AppState {
                directory,
                config: Mutex::new(config),
                load_error: Mutex::new(load_error),
                running: Mutex::new(None),
                operation: Mutex::new(()),
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    let state = handle.state::<AppState>();
                    let mut running = state.running.lock().await;
                    let status = running
                        .as_mut()
                        .and_then(|child| child.try_wait().ok().flatten());
                    if let Some(status) = status {
                        *running = None;
                        let _ = handle.emit("engine-running", false);
                        let _ = handle.emit(
                            "launcher-progress",
                            Progress {
                                stage: "exited".into(),
                                percent: 0,
                                message: format!(
                                    "Игра завершена ({status}). Журнал: {}",
                                    state.directory.join("logs/engine.log").display()
                                ),
                            },
                        );
                        if let Some(window) = handle.get_webview_window("main") {
                            let _ = window.show();
                        }
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            get_arizona_servers,
            query_server,
            server_details,
            engine_status,
            update_engine,
            launch_game
        ])
        .run(tauri::generate_context!())
        .expect("Не удалось запустить NoveraMP Launcher");
}
