use crate::{
    models::{CommandResponse, EndpointStatus, PrintCommand},
    queue::PrintQueue,
};
use std::{
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};
use tracing::{error, info};

#[derive(Clone)]
pub struct TcpService {
    port: u16,
    clients: Arc<AtomicUsize>,
    running: Arc<AtomicBool>,
}

impl TcpService {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            clients: Arc::new(AtomicUsize::new(0)),
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn status(&self) -> EndpointStatus {
        EndpointStatus {
            running: self.running.load(Ordering::Relaxed),
            port: self.port,
            clients: self.clients.load(Ordering::Relaxed),
        }
    }

    pub async fn run(self, queue: PrintQueue) -> anyhow::Result<()> {
        let listener = TcpListener::bind(("0.0.0.0", self.port)).await?;
        self.running.store(true, Ordering::Relaxed);
        info!(port = self.port, "TCP Socket 服务已启动");

        loop {
            let (stream, addr) = listener.accept().await?;
            let clients = self.clients.clone();
            clients.fetch_add(1, Ordering::Relaxed);
            let queue = queue.clone();
            tokio::spawn(async move {
                if let Err(err) = handle_client(stream, addr, queue).await {
                    error!(client = %addr, error = %err, "TCP 客户端处理失败");
                }
                clients.fetch_sub(1, Ordering::Relaxed);
            });
        }
    }
}

async fn handle_client(
    stream: TcpStream,
    addr: SocketAddr,
    queue: PrintQueue,
) -> anyhow::Result<()> {
    info!(client = %addr, "TCP 客户端已连接");
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<PrintCommand>(line.trim()) {
            Ok(command) => match command.validate() {
                Ok(()) => match queue.enqueue(command).await {
                    Ok(result) => CommandResponse::ok(result),
                    Err(err) => CommandResponse::err(err.to_string()),
                },
                Err(err) => CommandResponse::err(err.to_string()),
            },
            Err(_) => CommandResponse::err("指令格式错误"),
        };

        let raw = serde_json::to_string(&response)?;
        writer.write_all(raw.as_bytes()).await?;
        writer.write_all(b"\n").await?;
    }

    info!(client = %addr, "TCP 客户端已断开");
    Ok(())
}
