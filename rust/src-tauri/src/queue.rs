use crate::{
    models::{PrintResult, PrintTask, PrintTaskStatus, QueueStats},
    printer::PrintEngine,
};
use chrono::Utc;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, oneshot};
use tracing::{error, info};

#[derive(Clone)]
pub struct PrintQueue {
    sender: mpsc::Sender<QueueMessage>,
    receiver: Arc<Mutex<Option<mpsc::Receiver<QueueMessage>>>>,
    state: Arc<Mutex<QueueState>>,
    engine: PrintEngine,
}

struct QueueMessage {
    task: PrintTask,
    response: oneshot::Sender<PrintResult>,
}

#[derive(Default)]
struct QueueState {
    pending: VecDeque<String>,
    active: Option<String>,
    completed: usize,
    failed: usize,
    tasks: Vec<PrintTask>,
}

impl PrintQueue {
    pub fn new(engine: PrintEngine) -> Self {
        let (sender, receiver) = mpsc::channel(128);
        let state = Arc::new(Mutex::new(QueueState::default()));
        Self {
            sender,
            receiver: Arc::new(Mutex::new(Some(receiver))),
            state,
            engine,
        }
    }

    pub fn start(&self) {
        let receiver = {
            let mut receiver = self.receiver.lock().expect("queue receiver poisoned");
            receiver.take()
        };
        if let Some(receiver) = receiver {
            tauri::async_runtime::spawn(worker(receiver, self.state.clone(), self.engine.clone()));
        }
    }

    pub async fn enqueue(
        &self,
        command: crate::models::PrintCommand,
    ) -> anyhow::Result<PrintResult> {
        let task = PrintTask::new(command);
        let task_id = task.command.id.clone();
        let (response_tx, response_rx) = oneshot::channel();

        {
            let mut state = self.state.lock().expect("queue state poisoned");
            state.pending.push_back(task_id.clone());
            state.tasks.push(task.clone());
        }

        info!(task_id = %task_id, "打印任务已入队");
        self.sender
            .send(QueueMessage {
                task,
                response: response_tx,
            })
            .await?;
        Ok(response_rx.await?)
    }

    pub fn stats(&self) -> QueueStats {
        let state = self.state.lock().expect("queue state poisoned");
        QueueStats {
            pending: state.pending.len(),
            active: usize::from(state.active.is_some()),
            completed: state.completed,
            failed: state.failed,
        }
    }

    pub fn all_tasks(&self) -> Vec<PrintTask> {
        let state = self.state.lock().expect("queue state poisoned");
        state.tasks.clone()
    }

    pub fn task_command(&self, task_id: &str) -> Option<crate::models::PrintCommand> {
        let state = self.state.lock().expect("queue state poisoned");
        state
            .tasks
            .iter()
            .find(|task| task.command.id == task_id)
            .map(|task| task.command.clone())
    }
}

async fn worker(
    mut receiver: mpsc::Receiver<QueueMessage>,
    state: Arc<Mutex<QueueState>>,
    engine: PrintEngine,
) {
    while let Some(message) = receiver.recv().await {
        let mut task = message.task;
        let task_id = task.command.id.clone();

        {
            let mut state = state.lock().expect("queue state poisoned");
            state.pending.retain(|id| id != &task_id);
            state.active = Some(task_id.clone());
        }

        task.status = PrintTaskStatus::Printing;
        task.started_at = Some(Utc::now());
        update_task(&state, &task);

        let result = match engine.print(&task).await {
            Ok(()) => {
                task.status = PrintTaskStatus::Success;
                task.completed_at = Some(Utc::now());
                info!(task_id = %task_id, "打印任务成功");
                PrintResult {
                    task_id: task_id.clone(),
                    status: PrintTaskStatus::Success,
                    error: None,
                }
            }
            Err(err) => {
                let error = err.to_string();
                task.status = PrintTaskStatus::Failed;
                task.completed_at = Some(Utc::now());
                task.error = Some(error.clone());
                error!(task_id = %task_id, error = %error, "打印任务失败");
                PrintResult {
                    task_id: task_id.clone(),
                    status: PrintTaskStatus::Failed,
                    error: Some(error),
                }
            }
        };
        update_task(&state, &task);

        {
            let mut state = state.lock().expect("queue state poisoned");
            state.active = None;
            if matches!(result.status, PrintTaskStatus::Success) {
                state.completed += 1;
            } else {
                state.failed += 1;
            }
        }

        let _ = message.response.send(result);
    }
}

fn update_task(state: &Arc<Mutex<QueueState>>, task: &PrintTask) {
    let mut state = state.lock().expect("queue state poisoned");
    if let Some(stored) = state
        .tasks
        .iter_mut()
        .find(|stored| stored.command.id == task.command.id)
    {
        *stored = task.clone();
    }
}
