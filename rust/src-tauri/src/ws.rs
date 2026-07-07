use crate::{
    models::{CommandResponse, EndpointStatus, PrintCommand},
    queue::PrintQueue,
};
use futures_util::{SinkExt, StreamExt};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};
use tracing::{error, info};

#[derive(Clone)]
pub struct WsService {
    port: u16,
    clients: Arc<AtomicUsize>,
    running: Arc<AtomicBool>,
}

impl WsService {
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
        info!(port = self.port, "WebSocket 服务已启动");

        loop {
            let (stream, addr) = listener.accept().await?;
            let clients = self.clients.clone();
            clients.fetch_add(1, Ordering::Relaxed);
            let queue = queue.clone();
            tokio::spawn(async move {
                let result = async {
                    let ws = accept_async(stream).await?;
                    let (mut sink, mut stream) = ws.split();
                    info!(client = %addr, "WebSocket 客户端已连接");

                    while let Some(message) = stream.next().await {
                        let message = message?;
                        if !message.is_text() {
                            continue;
                        }

                        let response =
                            match serde_json::from_str::<PrintCommand>(message.to_text()?) {
                                Ok(command) => match command.validate() {
                                    Ok(()) => match queue.enqueue(command).await {
                                        Ok(result) => CommandResponse::ok(result),
                                        Err(err) => CommandResponse::err(err.to_string()),
                                    },
                                    Err(err) => CommandResponse::err(err.to_string()),
                                },
                                Err(_) => CommandResponse::err("指令格式错误"),
                            };

                        sink.send(Message::Text(serde_json::to_string(&response)?))
                            .await?;
                    }

                    anyhow::Ok(())
                }
                .await;

                if let Err(err) = result {
                    error!(client = %addr, error = %err, "WebSocket 客户端处理失败");
                }
                clients.fetch_sub(1, Ordering::Relaxed);
                info!(client = %addr, "WebSocket 客户端已断开");
            });
        }
    }
}
