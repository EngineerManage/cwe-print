import { contextBridge, ipcRenderer } from 'electron'

export interface Api {
  // 应用信息
  getAppVersion: () => Promise<string>

  // 配置相关
  getConfig: () => Promise<AppConfig>
  setConfig: (config: Partial<AppConfig>) => Promise<AppConfig>
  onConfigChange: (callback: (config: AppConfig) => void) => () => void

  // 服务状态
  getServiceStatus: () => Promise<ServiceStatus>
  onServiceStatusChange: (callback: (status: ServiceStatus) => void) => () => void

  // 打印机
  getPrinters: () => Promise<PrinterInfo[]>

  // 打印任务：列表模式展示、重打、以及队列变更通知
  getPrintTasks: () => Promise<PrintTask[]>
  reprintTask: (taskId: string) => Promise<{ success: boolean; error?: string }>
  debugPrint: (payload: DebugPrintPayload) => Promise<DebugPrintResult>
  onPrintQueueChange: (callback: () => void) => () => void

  // 日志
  getLogs: () => Promise<LogEntry[]>
  exportLogs: () => Promise<ExportLogsResult>
  reportRendererError: (payload: RendererErrorPayload) => Promise<{ success: boolean }>
  onLog: (callback: (log: LogEntry) => void) => () => void
}

export interface AppConfig {
  tcpPort: number
  wsPort: number
  autoStart: boolean
  defaultPrinter: string
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export interface ServiceStatus {
  tcp: { running: boolean; port: number; clients: number }
  ws: { running: boolean; port: number; clients: number }
  printQueue: { pending: number; active: number; completed: number; failed: number }
}

export interface PrinterInfo {
  name: string
  description: string
  status: number
  isDefault: boolean
}

export interface PrintTask {
  id: string
  type: 'print'
  format: 'pdf' | 'html' | 'image' | 'escpos' | 'ecpay'
  content: string
  printer?: string
  copies?: number
  paperSize?: unknown
  margins?: unknown
  position?: unknown
  blocks?: unknown
  options?: Record<string, unknown>
  status: 'pending' | 'printing' | 'success' | 'failed'
  createdAt: string
  startedAt?: string
  completedAt?: string
  outputPath?: string
  error?: string
}

export type PrintFormat = 'pdf' | 'html' | 'image' | 'escpos' | 'ecpay'

export interface DebugPrintPayload {
  format: PrintFormat
  content: string
}

export interface DebugPrintResult {
  success: boolean
  taskId?: string
  status?: string
  outputPath?: string
  error?: string
}

export interface LogEntry {
  time: string
  level: string
  message: string
  source: string
  details?: unknown
}

export interface ExportLogsResult {
  success: boolean
  filePath?: string
  error?: string
}

export interface RendererErrorPayload {
  message: string
  stack?: string
  filename?: string
  lineno?: number
  colno?: number
  type: 'error' | 'unhandledrejection'
}

const api: Api = {
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (config) => ipcRenderer.invoke('config:set', config),
  onConfigChange: (callback) => {
    const handler = (_: unknown, config: AppConfig) => callback(config)
    ipcRenderer.on('config:changed', handler)
    return () => ipcRenderer.off('config:changed', handler)
  },

  getServiceStatus: () => ipcRenderer.invoke('service:status'),
  onServiceStatusChange: (callback) => {
    const handler = (_: unknown, status: ServiceStatus) => callback(status)
    ipcRenderer.on('service:statusChanged', handler)
    return () => ipcRenderer.off('service:statusChanged', handler)
  },

  getPrinters: () => ipcRenderer.invoke('printer:list'),

  getPrintTasks: () => ipcRenderer.invoke('queue:tasks'),
  reprintTask: (taskId) => ipcRenderer.invoke('print:reprint', taskId),
  debugPrint: (payload) => ipcRenderer.invoke('print:debug', payload),
  onPrintQueueChange: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('queue:changed', handler)
    return () => ipcRenderer.off('queue:changed', handler)
  },

  getLogs: () => ipcRenderer.invoke('log:get'),
  exportLogs: () => ipcRenderer.invoke('log:export'),
  reportRendererError: (payload) => ipcRenderer.invoke('renderer:error', payload),
  onLog: (callback) => {
    const handler = (_: unknown, log: LogEntry) => callback(log)
    ipcRenderer.on('log:entry', handler)
    return () => ipcRenderer.off('log:entry', handler)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electronAPI', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electronAPI = api
}
