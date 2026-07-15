use crate::{
    config::AppConfig,
    models::{PrintBlock, PrintCommand, PrintFormat, PrintTask},
    paper,
};
use anyhow::Context;
use std::env;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
};
use tokio::task;
use tracing::{info, warn};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone)]
pub struct PrintEngine {
    config: Arc<Mutex<AppConfig>>,
}

impl PrintEngine {
    pub fn new(config: Arc<Mutex<AppConfig>>) -> Self {
        Self { config }
    }

    pub async fn print(&self, task: &PrintTask) -> anyhow::Result<Option<String>> {
        let engine = self.clone();
        let task = task.clone();
        task::spawn_blocking(move || engine.print_blocking(&task))
            .await
            .context("打印线程执行失败")?
    }

    fn print_blocking(&self, task: &PrintTask) -> anyhow::Result<Option<String>> {
        let config = self.config.lock().expect("config state poisoned").clone();
        info!(
            task_id = %task.command.id,
            format = ?task.command.format,
            dry_run = config.dry_run,
            "开始处理打印任务"
        );

        match task.command.format {
            PrintFormat::Html => self.print_html(&task.command, &config),
            PrintFormat::Image => self.print_image(&task.command, &config),
            PrintFormat::Pdf => self.print_pdf(&task.command, &config),
            PrintFormat::Escpos => {
                warn!("ESC/POS 直写尚未实现，当前按 dry-run 处理");
                Ok(None)
            }
        }
    }

    fn print_html(
        &self,
        command: &PrintCommand,
        config: &AppConfig,
    ) -> anyhow::Result<Option<String>> {
        let html = build_print_html(command)?;
        if config.dry_run {
            let (html_path, pdf_path) = dry_run_paths(command)?;
            fs::write(&html_path, html).context("写入 dry-run HTML 文件失败")?;
            render_html_to_pdf(&html_path, &pdf_path)?;
            info!(
                pdf = %pdf_path.display(),
                "dry-run: 已生成 PDF，跳过真实打印"
            );
            return Ok(Some(pdf_path.display().to_string()));
        }

        let temp_dir = tempfile::Builder::new().prefix("cwe-print-").tempdir()?;
        let html_path = temp_dir.path().join("document.html");
        let pdf_path = temp_dir.path().join("document.pdf");
        fs::write(&html_path, html).context("写入临时 HTML 文件失败")?;

        render_html_to_pdf(&html_path, &pdf_path)?;
        self.print_pdf_file(&pdf_path, command, config)
    }

    fn print_image(
        &self,
        command: &PrintCommand,
        config: &AppConfig,
    ) -> anyhow::Result<Option<String>> {
        let mut image_command = command.clone();
        image_command.format = PrintFormat::Html;
        if image_command.blocks.as_ref().is_none_or(Vec::is_empty) {
            let content = format!(
                r#"<img src="{}" style="max-width:100%;display:block;" />"#,
                escape_attr(&command.content)
            );
            image_command.blocks = Some(vec![PrintBlock {
                content,
                position: command
                    .position
                    .clone()
                    .unwrap_or(crate::models::PrintPosition {
                        top: 0.0,
                        left: 0.0,
                    }),
            }]);
            image_command.content.clear();
        }
        self.print_html(&image_command, config)
    }

    fn print_pdf(
        &self,
        command: &PrintCommand,
        config: &AppConfig,
    ) -> anyhow::Result<Option<String>> {
        let path = Path::new(&command.content);
        if !path.exists() {
            anyhow::bail!("PDF 文件不存在: {}", path.display());
        }
        self.print_pdf_file(path, command, config)
    }

    fn print_pdf_file(
        &self,
        path: &Path,
        command: &PrintCommand,
        config: &AppConfig,
    ) -> anyhow::Result<Option<String>> {
        if config.dry_run {
            info!(
                file = %path.display(),
                printer = ?command.printer.as_deref().or_else(|| default_printer(config)),
                "dry-run: 跳过真实打印"
            );
            return Ok(Some(path.display().to_string()));
        }

        let printer = command
            .printer
            .as_deref()
            .or_else(|| default_printer(config));
        let copies = command.copies.unwrap_or(1).max(1);

        #[cfg(target_os = "macos")]
        {
            let mut cmd = Command::new("lp");
            if let Some(printer) = printer {
                cmd.arg("-d").arg(printer);
            }
            cmd.arg("-n").arg(copies.to_string()).arg(path);
            run_print_command(cmd)?;
        }

        #[cfg(target_os = "linux")]
        {
            let mut cmd = Command::new("lp");
            if let Some(printer) = printer {
                cmd.arg("-d").arg(printer);
            }
            cmd.arg("-n").arg(copies.to_string()).arg(path);
            run_print_command(cmd)?;
        }

        #[cfg(target_os = "windows")]
        {
            print_pdf_windows(path, printer, copies)?;
        }

        Ok(None)
    }
}

fn render_html_to_pdf(html_path: &Path, pdf_path: &Path) -> anyhow::Result<()> {
    let browser = find_pdf_renderer()?;
    let mut cmd = Command::new(&browser);
    cmd.arg("--headless")
        .arg("--disable-gpu")
        .arg("--run-all-compositor-stages-before-draw")
        .arg("--virtual-time-budget=10000")
        .arg(format!("--print-to-pdf={}", pdf_path.display()))
        .arg(path_to_file_url(html_path)?);

    run_print_command(cmd).with_context(|| {
        format!(
            "HTML 转 PDF 失败，渲染器: {}, HTML: {}",
            browser.display(),
            html_path.display()
        )
    })?;

    if !pdf_path.exists() {
        anyhow::bail!("HTML 转 PDF 后未生成文件: {}", pdf_path.display());
    }

    info!(
        html = %html_path.display(),
        pdf = %pdf_path.display(),
        "HTML 已转换为 PDF"
    );
    Ok(())
}

fn dry_run_paths(command: &PrintCommand) -> anyhow::Result<(PathBuf, PathBuf)> {
    let base_dir = dirs::cache_dir()
        .unwrap_or_else(env::temp_dir)
        .join("cwe-print-rust")
        .join("dry-run");
    fs::create_dir_all(&base_dir).context("创建 dry-run 输出目录失败")?;

    let timestamp = chrono::Utc::now().timestamp_millis();
    let task_id = sanitize_filename(&command.id);
    let stem = format!("{timestamp}-{task_id}");

    Ok((
        base_dir.join(format!("{stem}.html")),
        base_dir.join(format!("{stem}.pdf")),
    ))
}

fn sanitize_filename(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .take(80)
        .collect::<String>();

    if sanitized.is_empty() {
        "task".to_string()
    } else {
        sanitized
    }
}

fn find_pdf_renderer() -> anyhow::Result<PathBuf> {
    for candidate in pdf_renderer_candidates() {
        if candidate.components().count() > 1 && !candidate.exists() {
            continue;
        }

        let mut cmd = Command::new(&candidate);
        cmd.arg("--version");
        hide_command_window(&mut cmd);
        if cmd.output().is_ok_and(|output| output.status.success()) {
            return Ok(candidate);
        }
    }

    anyhow::bail!(
        "未找到可用于 HTML 转 PDF 的浏览器，请安装 Microsoft Edge、Google Chrome 或 Chromium"
    )
}

fn pdf_renderer_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if let Some(program_files) = env::var_os("ProgramFiles") {
            let base = PathBuf::from(program_files);
            candidates.push(base.join("Microsoft/Edge/Application/msedge.exe"));
            candidates.push(base.join("Google/Chrome/Application/chrome.exe"));
        }
        if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)") {
            let base = PathBuf::from(program_files_x86);
            candidates.push(base.join("Microsoft/Edge/Application/msedge.exe"));
            candidates.push(base.join("Google/Chrome/Application/chrome.exe"));
        }
        if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
            let base = PathBuf::from(local_app_data);
            candidates.push(base.join("Microsoft/Edge/Application/msedge.exe"));
            candidates.push(base.join("Google/Chrome/Application/chrome.exe"));
        }
        candidates.push(PathBuf::from("msedge.exe"));
        candidates.push(PathBuf::from("chrome.exe"));
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from(
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ));
        candidates.push(PathBuf::from(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ));
        candidates.push(PathBuf::from(
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ));
    }

    #[cfg(target_os = "linux")]
    {
        candidates.push(PathBuf::from("microsoft-edge"));
        candidates.push(PathBuf::from("google-chrome"));
        candidates.push(PathBuf::from("chromium"));
        candidates.push(PathBuf::from("chromium-browser"));
    }

    candidates
}

fn path_to_file_url(path: &Path) -> anyhow::Result<String> {
    let path = path.canonicalize()?;
    let mut raw = path.to_string_lossy().replace('\\', "/");
    if !raw.starts_with('/') {
        raw = format!("/{raw}");
    }

    Ok(format!("file://{}", encode_url_path(&raw)))
}

fn encode_url_path(path: &str) -> String {
    let mut encoded = String::new();
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(target_os = "windows")]
fn print_pdf_windows(path: &Path, printer: Option<&str>, copies: u32) -> anyhow::Result<()> {
    let sumatra = find_sumatra_pdf().ok_or_else(|| {
        anyhow::anyhow!(
            "未找到 SumatraPDF.exe，无法执行 Windows PDF 静默打印；请将 SumatraPDF.exe 放到应用目录或 resources 目录"
        )
    })?;

    let mut cmd = Command::new(sumatra);
    if let Some(printer) = printer {
        cmd.arg("-print-to").arg(printer);
    } else {
        cmd.arg("-print-to-default");
    }
    cmd.arg("-print-settings")
        .arg(format!("{copies}x"))
        .arg("-silent")
        .arg("-exit-when-done")
        .arg(path);
    run_print_command(cmd)
}

#[cfg(target_os = "windows")]
fn find_sumatra_pdf() -> Option<PathBuf> {
    for candidate in sumatra_pdf_candidates() {
        if candidate.components().count() > 1 && !candidate.exists() {
            continue;
        }

        let mut cmd = Command::new(&candidate);
        cmd.arg("-version");
        hide_command_window(&mut cmd);
        if cmd.output().is_ok_and(|output| output.status.success()) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn sumatra_pdf_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(exe) = env::current_exe()
        && let Some(dir) = exe.parent()
    {
        candidates.push(dir.join("SumatraPDF.exe"));
        candidates.push(dir.join("resources/SumatraPDF.exe"));
    }

    candidates.push(PathBuf::from("resources/SumatraPDF.exe"));
    candidates.push(PathBuf::from("src-tauri/resources/SumatraPDF.exe"));

    if let Some(program_files) = env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("SumatraPDF/SumatraPDF.exe"));
    }
    if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(program_files_x86).join("SumatraPDF/SumatraPDF.exe"));
    }
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local_app_data).join("SumatraPDF/SumatraPDF.exe"));
    }
    candidates.push(PathBuf::from("SumatraPDF.exe"));

    candidates
}

fn run_print_command(mut cmd: Command) -> anyhow::Result<()> {
    hide_command_window(&mut cmd);

    let output = cmd.output().context("执行系统打印命令失败")?;
    if !output.status.success() {
        anyhow::bail!(
            "系统打印命令失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn hide_command_window(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_command_window(_cmd: &mut Command) {}

fn default_printer(config: &AppConfig) -> Option<&str> {
    let printer = config.default_printer.trim();
    (!printer.is_empty()).then_some(printer)
}

fn build_print_html(command: &PrintCommand) -> anyhow::Result<String> {
    let margins = command.margins.clone().unwrap_or_default();
    let (paper_css, body_css) = match &command.paper_size {
        Some(size) => {
            let dim = paper::dimensions(size)?;
            (
                format!(
                    "@page {{ size: {}mm {}mm; margin: {}mm {}mm {}mm {}mm; }}",
                    dim.width_mm,
                    dim.height_mm,
                    margins.top,
                    margins.right,
                    margins.bottom,
                    margins.left
                ),
                format!(
                    "width: {}mm; height: {}mm; position: relative;",
                    dim.width_mm, dim.height_mm
                ),
            )
        }
        None => (
            format!(
                "@page {{ margin: {}mm {}mm {}mm {}mm; }}",
                margins.top, margins.right, margins.bottom, margins.left
            ),
            "position: relative;".to_string(),
        ),
    };

    let blocks = build_blocks(command);
    let blocks_html = blocks
        .iter()
        .enumerate()
        .map(|(index, block)| {
            format!(
                r#"<div class="print-block print-block-{index}" style="position:absolute;top:{}mm;left:{}mm;box-sizing:border-box;">{}</div>"#,
                block.position.top, block.position.left, block.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    Ok(format!(
        r#"<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
{paper_css}
* {{ box-sizing: border-box; }}
html, body {{ margin: 0; padding: 0; }}
body {{ {body_css} overflow: hidden; }}
.print-block {{ overflow: hidden; }}
@media print {{ body {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }} }}
</style>
</head>
<body>
{blocks_html}
</body>
</html>"#
    ))
}

fn build_blocks(command: &PrintCommand) -> Vec<PrintBlock> {
    let mut blocks = command.blocks.clone().unwrap_or_default();
    if !command.content.is_empty()
        && let Some(position) = &command.position
    {
        blocks.push(PrintBlock {
            content: command.content.clone(),
            position: position.clone(),
        });
    } else if !command.content.is_empty() && blocks.is_empty() {
        blocks.push(PrintBlock {
            content: command.content.clone(),
            position: crate::models::PrintPosition {
                top: 0.0,
                left: 0.0,
            },
        });
    }
    blocks
}

fn escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
