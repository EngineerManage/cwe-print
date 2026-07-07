use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintPosition {
    pub top: f64,
    pub left: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintMargins {
    pub top: f64,
    pub left: f64,
    pub right: f64,
    pub bottom: f64,
}

impl Default for PrintMargins {
    fn default() -> Self {
        Self {
            top: 10.0,
            left: 10.0,
            right: 10.0,
            bottom: 10.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaperUnit {
    Mm,
    In,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomPaperSize {
    pub width: f64,
    pub height: f64,
    pub unit: PaperUnit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PaperSize {
    Standard(String),
    Custom(CustomPaperSize),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintBlock {
    pub content: String,
    pub position: PrintPosition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrintFormat {
    Pdf,
    Html,
    Image,
    Escpos,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintCommand {
    pub id: String,
    #[serde(rename = "type")]
    pub command_type: String,
    pub format: PrintFormat,
    pub content: String,
    pub printer: Option<String>,
    pub copies: Option<u32>,
    pub paper_size: Option<PaperSize>,
    pub margins: Option<PrintMargins>,
    pub position: Option<PrintPosition>,
    pub blocks: Option<Vec<PrintBlock>>,
    pub options: Option<HashMap<String, Value>>,
}

impl PrintCommand {
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.command_type != "print" {
            anyhow::bail!("未知指令类型");
        }
        if self.id.trim().is_empty() {
            anyhow::bail!("打印任务 id 不能为空");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrintTaskStatus {
    Pending,
    Printing,
    Success,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintTask {
    #[serde(flatten)]
    pub command: PrintCommand,
    pub status: PrintTaskStatus,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
}

impl PrintTask {
    pub fn new(command: PrintCommand) -> Self {
        Self {
            command,
            status: PrintTaskStatus::Pending,
            created_at: Utc::now(),
            started_at: None,
            completed_at: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintResult {
    pub task_id: String,
    pub status: PrintTaskStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<PrintResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl CommandResponse {
    pub fn ok(result: PrintResult) -> Self {
        let success = matches!(result.status, PrintTaskStatus::Success);
        let error = result.error.clone();
        Self {
            success,
            result: Some(result),
            error,
        }
    }

    pub fn err(error: impl Into<String>) -> Self {
        Self {
            success: false,
            result: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStats {
    pub pending: usize,
    pub active: usize,
    pub completed: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub tcp: EndpointStatus,
    pub ws: EndpointStatus,
    pub print_queue: QueueStats,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointStatus {
    pub running: bool,
    pub port: u16,
    pub clients: usize,
}
