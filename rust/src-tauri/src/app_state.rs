use crate::{
    config::AppConfig,
    models::{EndpointStatus, PrintCommand, PrintResult, PrintTask, ServiceStatus},
    printer::PrintEngine,
    queue::PrintQueue,
    tcp::TcpService,
    ws::WsService,
};
use std::sync::{Arc, Mutex};
use tokio::task::JoinHandle;
use tracing::{error, info};

pub struct AppState {
    config: Arc<Mutex<AppConfig>>,
    queue: PrintQueue,
    service: Mutex<ServiceRuntime>,
}

#[derive(Default)]
struct ServiceRuntime {
    tcp: Option<TcpService>,
    ws: Option<WsService>,
    tcp_handle: Option<JoinHandle<()>>,
    ws_handle: Option<JoinHandle<()>>,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        let config = Arc::new(Mutex::new(config));
        let engine = PrintEngine::new(config.clone());
        let queue = PrintQueue::new(engine);
        Self {
            config,
            queue,
            service: Mutex::new(ServiceRuntime::default()),
        }
    }

    pub fn start_queue(&self) {
        self.queue.start();
    }

    pub fn config(&self) -> AppConfig {
        self.config.lock().expect("config state poisoned").clone()
    }

    pub async fn set_config(&self, partial: PartialAppConfig) -> anyhow::Result<AppConfig> {
        let old = self.config();
        let mut changed_ports = false;

        let next = {
            let mut config = self.config.lock().expect("config state poisoned");
            if let Some(port) = partial.tcp_port {
                changed_ports |= port != config.tcp_port;
                config.tcp_port = port;
            }
            if let Some(port) = partial.ws_port {
                changed_ports |= port != config.ws_port;
                config.ws_port = port;
            }
            if let Some(auto_start) = partial.auto_start {
                config.auto_start = auto_start;
            }
            if let Some(default_printer) = partial.default_printer {
                config.default_printer = default_printer;
            }
            if let Some(log_level) = partial.log_level {
                config.log_level = log_level;
            }
            if let Some(dry_run) = partial.dry_run {
                config.dry_run = dry_run;
            }
            config.clone()
        };

        next.save()?;

        if changed_ports && old.auto_start {
            self.restart_services().await?;
        }

        Ok(next)
    }

    pub async fn start_services(&self) -> anyhow::Result<()> {
        self.stop_services().await;

        let config = self.config();
        let tcp = TcpService::new(config.tcp_port);
        let ws = WsService::new(config.ws_port);
        let tcp_for_status = tcp.clone();
        let ws_for_status = ws.clone();
        let tcp_queue = self.queue.clone();
        let ws_queue = self.queue.clone();

        let tcp_handle = tokio::spawn(async move {
            if let Err(err) = tcp.run(tcp_queue).await {
                error!(error = %err, "TCP 服务退出");
            }
        });
        let ws_handle = tokio::spawn(async move {
            if let Err(err) = ws.run(ws_queue).await {
                error!(error = %err, "WebSocket 服务退出");
            }
        });

        {
            let mut service = self.service.lock().expect("service state poisoned");
            service.tcp = Some(tcp_for_status);
            service.ws = Some(ws_for_status);
            service.tcp_handle = Some(tcp_handle);
            service.ws_handle = Some(ws_handle);
        }

        info!("打印服务已启动");
        Ok(())
    }

    pub async fn restart_services(&self) -> anyhow::Result<()> {
        self.start_services().await
    }

    pub async fn stop_services(&self) {
        let (tcp_handle, ws_handle) = {
            let mut service = self.service.lock().expect("service state poisoned");
            (service.tcp_handle.take(), service.ws_handle.take())
        };

        if let Some(handle) = tcp_handle {
            handle.abort();
        }
        if let Some(handle) = ws_handle {
            handle.abort();
        }

        let mut service = self.service.lock().expect("service state poisoned");
        service.tcp = None;
        service.ws = None;
    }

    pub fn status(&self) -> ServiceStatus {
        let config = self.config();
        let service = self.service.lock().expect("service state poisoned");
        ServiceStatus {
            tcp: service
                .tcp
                .as_ref()
                .map(TcpService::status)
                .unwrap_or(EndpointStatus {
                    running: false,
                    port: config.tcp_port,
                    clients: 0,
                }),
            ws: service
                .ws
                .as_ref()
                .map(WsService::status)
                .unwrap_or(EndpointStatus {
                    running: false,
                    port: config.ws_port,
                    clients: 0,
                }),
            print_queue: self.queue.stats(),
        }
    }

    pub async fn enqueue(&self, command: PrintCommand) -> anyhow::Result<PrintResult> {
        command.validate()?;
        self.queue.enqueue(command).await
    }

    pub async fn reprint(&self, task_id: String) -> anyhow::Result<PrintResult> {
        let mut command = self
            .queue
            .task_command(&task_id)
            .ok_or_else(|| anyhow::anyhow!("任务不存在"))?;
        command.id = format!(
            "{}-reprint-{}",
            command.id,
            chrono::Utc::now().timestamp_millis()
        );
        self.enqueue(command).await
    }

    pub fn tasks(&self) -> Vec<PrintTask> {
        self.queue.all_tasks()
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialAppConfig {
    pub tcp_port: Option<u16>,
    pub ws_port: Option<u16>,
    pub auto_start: Option<bool>,
    pub default_printer: Option<String>,
    pub log_level: Option<String>,
    pub dry_run: Option<bool>,
}
