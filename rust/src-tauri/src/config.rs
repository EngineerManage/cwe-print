use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub tcp_port: u16,
    pub ws_port: u16,
    pub auto_start: bool,
    pub default_printer: String,
    pub log_level: String,
    pub dry_run: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            tcp_port: 9527,
            ws_port: 9528,
            auto_start: true,
            default_printer: String::new(),
            log_level: "info".to_string(),
            dry_run: true,
        }
    }
}

impl AppConfig {
    pub fn load() -> anyhow::Result<Self> {
        let path = config_path()?;
        if !path.exists() {
            let config = Self::default();
            config.save()?;
            return Ok(config);
        }

        let raw = fs::read_to_string(&path)
            .with_context(|| format!("读取配置失败: {}", path.display()))?;
        let mut config: Self = serde_json::from_str(&raw)
            .with_context(|| format!("解析配置失败: {}", path.display()))?;
        if config.log_level.trim().is_empty() {
            config.log_level = "info".to_string();
        }
        Ok(config)
    }

    pub fn save(&self) -> anyhow::Result<()> {
        let path = config_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("创建配置目录失败: {}", parent.display()))?;
        }
        let raw = serde_json::to_string_pretty(self)?;
        fs::write(&path, raw).with_context(|| format!("保存配置失败: {}", path.display()))?;
        Ok(())
    }
}

pub fn config_path() -> anyhow::Result<PathBuf> {
    let base = dirs::config_dir().context("无法获取系统配置目录")?;
    Ok(base.join("cwe-print-rust").join("app-config.json"))
}
