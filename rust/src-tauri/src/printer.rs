use crate::{
    config::AppConfig,
    models::{PrintBlock, PrintCommand, PrintFormat, PrintTask},
    paper,
};
use anyhow::Context;
use std::{
    path::Path,
    process::Command,
    sync::{Arc, Mutex},
};
use tokio::task;
use tracing::{info, warn};

#[derive(Clone)]
pub struct PrintEngine {
    config: Arc<Mutex<AppConfig>>,
}

impl PrintEngine {
    pub fn new(config: Arc<Mutex<AppConfig>>) -> Self {
        Self { config }
    }

    pub async fn print(&self, task: &PrintTask) -> anyhow::Result<()> {
        let engine = self.clone();
        let task = task.clone();
        task::spawn_blocking(move || engine.print_blocking(&task))
            .await
            .context("打印线程执行失败")?
    }

    fn print_blocking(&self, task: &PrintTask) -> anyhow::Result<()> {
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
                Ok(())
            }
        }
    }

    fn print_html(&self, command: &PrintCommand, config: &AppConfig) -> anyhow::Result<()> {
        let html = build_print_html(command)?;
        let mut file = tempfile::Builder::new().suffix(".html").tempfile()?;
        std::io::Write::write_all(&mut file, html.as_bytes())?;
        self.print_file(file.path(), command, config)
    }

    fn print_image(&self, command: &PrintCommand, config: &AppConfig) -> anyhow::Result<()> {
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

    fn print_pdf(&self, command: &PrintCommand, config: &AppConfig) -> anyhow::Result<()> {
        let path = Path::new(&command.content);
        if !path.exists() {
            anyhow::bail!("PDF 文件不存在: {}", path.display());
        }
        self.print_file(path, command, config)
    }

    fn print_file(
        &self,
        path: &Path,
        command: &PrintCommand,
        config: &AppConfig,
    ) -> anyhow::Result<()> {
        if config.dry_run {
            info!(
                file = %path.display(),
                printer = ?command.printer.as_deref().or_else(|| default_printer(config)),
                "dry-run: 跳过真实打印"
            );
            return Ok(());
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
            run_print_command(cmd)
        }

        #[cfg(target_os = "linux")]
        {
            let mut cmd = Command::new("lp");
            if let Some(printer) = printer {
                cmd.arg("-d").arg(printer);
            }
            cmd.arg("-n").arg(copies.to_string()).arg(path);
            run_print_command(cmd)
        }

        #[cfg(target_os = "windows")]
        {
            let mut cmd = Command::new("powershell");
            cmd.arg("-NoProfile")
                .arg("-Command")
                .arg("Start-Process")
                .arg("-FilePath")
                .arg(path)
                .arg("-Verb")
                .arg("Print");
            let _ = printer;
            let _ = copies;
            run_print_command(cmd)
        }
    }
}

fn run_print_command(mut cmd: Command) -> anyhow::Result<()> {
    let output = cmd.output().context("执行系统打印命令失败")?;
    if !output.status.success() {
        anyhow::bail!(
            "系统打印命令失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

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
