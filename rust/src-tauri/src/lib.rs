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
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
use tauri::{
    App, AppHandle, Manager, State, WebviewWindow, WindowEvent,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tracing_subscriber::{EnvFilter, fmt};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const PRINTER_STATUS_READY: i32 = 0;
const PRINTER_STATUS_UNKNOWN: i32 = 2;
const PRINTER_STATUS_PRINTING: i32 = 4;
#[cfg(target_os = "windows")]
const PRINTER_STATUS_WARMUP: i32 = 5;
const PRINTER_STATUS_STOPPED: i32 = 6;
const PRINTER_STATUS_OFFLINE: i32 = 7;

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
fn get_printers() -> Vec<PrinterInfo> {
    list_system_printers().unwrap_or_default()
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

#[cfg(target_os = "windows")]
fn list_system_printers() -> anyhow::Result<Vec<PrinterInfo>> {
    let mut cmd = Command::new("powershell");
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd
        .arg("-NoProfile")
        .arg("-Command")
        .arg("Get-CimInstance Win32_Printer | Select-Object Name,DriverName,PrinterStatus,Default | ConvertTo-Json -Compress")
        .output()?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(Vec::new());
    }

    let value: serde_json::Value = serde_json::from_str(raw)?;
    let items = match value {
        serde_json::Value::Array(items) => items,
        item => vec![item],
    };

    Ok(items
        .into_iter()
        .filter_map(|item| {
            let name = item.get("Name")?.as_str()?.to_string();
            Some(PrinterInfo {
                description: item
                    .get("DriverName")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("系统打印机")
                    .to_string(),
                status: item
                    .get("PrinterStatus")
                    .and_then(serde_json::Value::as_i64)
                    .map(normalize_windows_printer_status)
                    .unwrap_or(PRINTER_STATUS_UNKNOWN),
                is_default: item
                    .get("Default")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                name,
            })
        })
        .collect())
}

#[cfg(target_os = "windows")]
fn normalize_windows_printer_status(status: i64) -> i32 {
    match status {
        3 => PRINTER_STATUS_READY,
        4 => PRINTER_STATUS_PRINTING,
        5 => PRINTER_STATUS_WARMUP,
        6 => PRINTER_STATUS_STOPPED,
        7 => PRINTER_STATUS_OFFLINE,
        _ => PRINTER_STATUS_UNKNOWN,
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn list_system_printers() -> anyhow::Result<Vec<PrinterInfo>> {
    let output = Command::new("lpstat").arg("-p").arg("-d").output()?;
    if !output.status.success() {
        return Ok(Vec::new());
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let default_name = raw.lines().find_map(|line| {
        line.strip_prefix("system default destination: ")
            .map(str::trim)
            .filter(|name| !name.is_empty())
    });

    Ok(raw
        .lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("printer ")?;
            let (name, _) = rest.split_once(' ')?;
            Some(PrinterInfo {
                name: name.to_string(),
                description: line.to_string(),
                status: if line.contains(" is idle") {
                    PRINTER_STATUS_READY
                } else if line.contains(" now printing") {
                    PRINTER_STATUS_PRINTING
                } else if line.contains(" disabled") {
                    PRINTER_STATUS_STOPPED
                } else if line.contains(" offline") {
                    PRINTER_STATUS_OFFLINE
                } else {
                    PRINTER_STATUS_UNKNOWN
                },
                is_default: default_name == Some(name),
            })
        })
        .collect())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn list_system_printers() -> anyhow::Result<Vec<PrinterInfo>> {
    Ok(Vec::new())
}

fn to_string(err: anyhow::Error) -> String {
    err.to_string()
}
