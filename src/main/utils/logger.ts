import { ipcMain, BrowserWindow } from 'electron'
import { configManager } from './config'

export interface LogEntry {
  time: string
  level: string
  message: string
  source: string
}

const logs: LogEntry[] = []
const MAX_LOGS = 1000

function broadcastLog(entry: LogEntry): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('log:entry', entry)
  })
}

function shouldLog(level: string): boolean {
  const levels = ['debug', 'info', 'warn', 'error']
  const current = levels.indexOf(configManager.get().logLevel)
  const target = levels.indexOf(level)
  return target >= current
}

function pushLog(level: string, message: string, source: string): void {
  if (!shouldLog(level)) return
  const entry: LogEntry = {
    time: new Date().toISOString(),
    level,
    message,
    source
  }
  logs.push(entry)
  if (logs.length > MAX_LOGS) logs.shift()
  broadcastLog(entry)
}

export const logger = {
  debug: (msg: string, source = 'main') => pushLog('debug', msg, source),
  info: (msg: string, source = 'main') => pushLog('info', msg, source),
  warn: (msg: string, source = 'main') => pushLog('warn', msg, source),
  error: (msg: string, source = 'main') => pushLog('error', msg, source),
  getLogs: () => [...logs]
}

ipcMain.handle('log:get', () => logger.getLogs())
