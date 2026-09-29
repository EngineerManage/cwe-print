import EventEmitter from 'events'
import { logger } from '../utils/logger'
import type { PrintCommand } from '../socket/tcp-server'

export interface PrintTask extends PrintCommand {
  status: 'pending' | 'printing' | 'success' | 'failed'
  createdAt: string
  startedAt?: string
  completedAt?: string
  outputPath?: string
  error?: string
}

class PrintQueue extends EventEmitter {
  private queue: PrintTask[] = []
  private active = false
  private currentTask: PrintTask | null = null

  get stats() {
    return {
      pending: this.queue.filter((t) => t.status === 'pending').length,
      active: this.currentTask ? 1 : 0,
      completed: this.queue.filter((t) => t.status === 'success').length,
      failed: this.queue.filter((t) => t.status === 'failed').length
    }
  }

  get all() {
    return [...this.queue]
  }

  enqueue(cmd: PrintCommand): PrintTask {
    const task: PrintTask = {
      ...cmd,
      status: 'pending',
      createdAt: new Date().toISOString()
    }
    this.queue.push(task)
    logger.info(`收到打印任务，状态: 待打印，任务ID: ${task.id}, 格式: ${task.format}`, 'queue', {
      printCommand: cmd,
      printTask: task
    })
    this.emit('changed')
    return task
  }

  async process(handler: (task: PrintTask) => Promise<string | void>): Promise<void> {
    if (this.active) return
    this.active = true

    try {
      while (true) {
        const task = this.queue.find((t) => t.status === 'pending')
        if (!task) break

        this.currentTask = task
        task.status = 'printing'
        task.startedAt = new Date().toISOString()
        logger.info(`打印任务状态: 打印中，任务ID: ${task.id}, 格式: ${task.format}`, 'queue', {
          printTask: task
        })
        this.emit('changed')

        try {
          const outputPath = await handler(task)
          if (outputPath) {
            task.outputPath = outputPath
          }
          task.status = 'success'
          task.completedAt = new Date().toISOString()
          logger.info(`打印任务状态: 已完成，任务ID: ${task.id}`, 'queue', {
            printTask: task
          })
        } catch (err) {
          task.status = 'failed'
          task.error = (err as Error).message
          task.completedAt = new Date().toISOString()
          logger.error(`打印任务状态: 失败，任务ID: ${task.id}, 失败原因: ${task.error}`, 'queue', {
            error: task.error,
            printTask: task
          })
        } finally {
          this.currentTask = null
          this.emit('changed')
        }
      }
    } finally {
      this.currentTask = null
      this.active = false
    }
  }

  clear(): void {
    this.queue = this.queue.filter((t) => t.status === 'pending')
    this.emit('changed')
  }

  retry(taskId: string): PrintTask | null {
    const task = this.queue.find((t) => t.id === taskId)
    if (!task || task.status !== 'failed') return null
    task.status = 'pending'
    task.error = undefined
    this.emit('changed')
    return task
  }
}

export const printQueue = new PrintQueue()
