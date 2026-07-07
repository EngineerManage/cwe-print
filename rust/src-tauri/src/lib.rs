mod app_state;
mod config;
mod models;
mod paper;
mod printer;
mod queue;
mod tcp;
mod ws;

use app_state::{AppState, PartialAppConfig};
use config::AppConfig;
use models::{PrintCommand, PrintResult, PrintTask, ServiceStatus};
use serde::Serialize;
use tauri::{
    App, AppHandle, Manager, State, WebviewWindow, WindowEvent,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tracing_subscriber::{EnvFilter, fmt};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrinterInfo {
    name: String,
    description: String,
    status: i32,
    is_default: bool,
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> AppConfig {
    state.config()
}

#[tauri::command]
async fn set_config(
    state: State<'_, AppState>,
    partial: PartialAppConfig,
) -> Result<AppConfig, String> {
    state.set_config(partial).await.map_err(to_string)
}

#[tauri::command]
async fn restart_services(state: State<'_, AppState>) -> Result<ServiceStatus, String> {
    state.restart_services().await.map_err(to_string)?;
    Ok(state.status())
}

#[tauri::command]
async fn stop_services(state: State<'_, AppState>) -> Result<ServiceStatus, String> {
    state.stop_services().await;
    Ok(state.status())
}

#[tauri::command]
fn get_service_status(state: State<'_, AppState>) -> ServiceStatus {
    state.status()
}

#[tauri::command]
fn get_print_tasks(state: State<'_, AppState>) -> Vec<PrintTask> {
    state.tasks()
}

#[tauri::command]
async fn submit_print(
    state: State<'_, AppState>,
    command: PrintCommand,
) -> Result<PrintResult, String> {
    state.enqueue(command).await.map_err(to_string)
}

#[tauri::command]
async fn reprint_task(state: State<'_, AppState>, task_id: String) -> Result<PrintResult, String> {
    state.reprint(task_id).await.map_err(to_string)
}

#[tauri::command]
fn get_printers(state: State<'_, AppState>) -> Vec<PrinterInfo> {
    let config = state.config();
    let default_name = config.default_printer.trim().to_string();
    if default_name.is_empty() {
        Vec::new()
    } else {
        vec![PrinterInfo {
            name: default_name.clone(),
            description: "默认打印机配置".to_string(),
            status: 0,
            is_default: true,
        }]
    }
}

pub fn run() {
    init_tracing("info");

    let config = AppConfig::load().unwrap_or_default();
    let auto_start = config.auto_start;
    let state = AppState::new(config);

    tauri::Builder::default()
        .manage(state)
        .setup(move |app| {
            app.state::<AppState>().start_queue();
            setup_tray(app)?;
            if auto_start {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<AppState>();
                    if let Err(err) = state.start_services().await {
                        tracing::error!(error = %err, "自动启动服务失败");
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            restart_services,
            stop_services,
            get_service_status,
            get_print_tasks,
            submit_print,
            reprint_task,
            get_printers
        ])
        .run(tauri::generate_context!())
        .expect("运行 CWE Print Rust 失败");
}

fn setup_tray(app: &mut App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let start_item = MenuItem::with_id(app, "start_services", "启动/重启服务", true, None::<&str>)?;
    let stop_item = MenuItem::with_id(app, "stop_services", "停止服务", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &start_item, &stop_item, &quit_item])?;

    let mut tray = TrayIconBuilder::new()
        .tooltip("CWE Print Rust 打印服务")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "start_services" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    if let Err(err) = state.restart_services().await {
                        tracing::error!(error = %err, "托盘启动服务失败");
                    }
                    show_main_window(&app);
                });
            }
            "stop_services" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    state.stop_services().await;
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)?;
    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        show_window(&window);
    }
}

fn show_window(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn init_tracing(level: &str) {
    let filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new(level))
        .unwrap_or_else(|_| EnvFilter::new("info"));

    let _ = fmt()
        .with_env_filter(filter)
        .with_target(false)
        .compact()
        .try_init();
}

fn to_string(err: anyhow::Error) -> String {
    err.to_string()
}
