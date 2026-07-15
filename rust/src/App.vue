<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'

type Tab = 'status' | 'settings' | 'logs'
type ViewMode = 'log' | 'list'

type AppConfig = {
  tcpPort: number
  wsPort: number
  autoStart: boolean
  defaultPrinter: string
  logLevel: string
  dryRun: boolean
}

type ServiceStatus = {
  tcp: { running: boolean; port: number; clients: number }
  ws: { running: boolean; port: number; clients: number }
  printQueue: { pending: number; active: number; completed: number; failed: number }
}

type PrinterInfo = {
  name: string
  description: string
  status: number
  isDefault: boolean
}

type PrintTask = {
  id: string
  type: 'print'
  format: 'pdf' | 'html' | 'image' | 'escpos'
  content: string
  printer?: string
  copies?: number
  status: 'pending' | 'printing' | 'success' | 'failed'
  createdAt: string
  completedAt?: string
  outputPath?: string
  error?: string
}

type LogEntry = {
  time: string
  level: 'debug' | 'info' | 'warn' | 'error'
  source: string
  message: string
}

const activeTab = ref<Tab>('status')
const appVersion = '0.1.0'
const config = ref<AppConfig>({
  tcpPort: 9527,
  wsPort: 9528,
  autoStart: true,
  defaultPrinter: '',
  logLevel: 'info',
  dryRun: true
})
const status = ref<ServiceStatus>({
  tcp: { running: false, port: 0, clients: 0 },
  ws: { running: false, port: 0, clients: 0 },
  printQueue: { pending: 0, active: 0, completed: 0, failed: 0 }
})
const printers = ref<PrinterInfo[]>([])
const tasks = ref<PrintTask[]>([])
const logs = ref<LogEntry[]>([])
const viewMode = ref<ViewMode>('list')
const filterLevel = ref<string>('all')
const filterSource = ref<string>('all')
const autoScroll = ref(true)
const saving = ref(false)
const saveMsg = ref('')

const printerOptions = computed(() => {
  const options = [...printers.value]
  const selected = config.value.defaultPrinter.trim()
  if (selected && !options.some((printer) => printer.name === selected)) {
    options.unshift({
      name: selected,
      description: '已保存，当前未在系统打印机列表中',
      status: -1,
      isDefault: false
    })
  }
  return options
})

const filteredLogs = computed(() => {
  return taskLogs.value.filter((log) => {
    if (filterLevel.value !== 'all' && log.level !== filterLevel.value) return false
    if (filterSource.value !== 'all' && log.source !== filterSource.value) return false
    return true
  })
})

const taskLogs = computed<LogEntry[]>(() => {
  return tasks.value.map((task) => {
    const printer = task.printer || '系统默认打印机'
    const time = task.completedAt || task.createdAt
    const level: LogEntry['level'] = task.status === 'failed' ? 'error' : 'info'
    const output = task.outputPath ? `，PDF: ${task.outputPath}` : ''
    const suffix = task.error ? `，错误: ${task.error}` : ''
    return {
      time,
      level,
      source: 'queue',
      message: `${statusText(task.status)}: ${task.id}，格式: ${task.format}，打印机: ${printer}${output}${suffix}`
    }
  })
})

onMounted(async () => {
  await refreshAll()
  window.setInterval(refreshRuntime, 2500)
})

async function refreshAll() {
  await Promise.all([loadConfig(), refreshRuntime(), refreshPrinters()])
}

async function refreshRuntime() {
  status.value = await invoke<ServiceStatus>('get_service_status')
  tasks.value = await invoke<PrintTask[]>('get_print_tasks')
}

async function loadConfig() {
  config.value = await invoke<AppConfig>('get_config')
}

async function refreshPrinters() {
  printers.value = await invoke<PrinterInfo[]>('get_printers')
}

async function saveConfig() {
  saving.value = true
  saveMsg.value = ''
  try {
    config.value = await invoke<AppConfig>('set_config', { partial: config.value })
    await refreshRuntime()
    saveMsg.value = '配置已保存，服务已自动重启'
    pushLog('info', 'settings', saveMsg.value)
    setTimeout(() => {
      saveMsg.value = ''
    }, 3000)
  } catch (err) {
    saveMsg.value = `保存失败: ${String(err)}`
    pushLog('error', 'settings', saveMsg.value)
  } finally {
    saving.value = false
  }
}

async function submitTestPrint() {
  try {
    await invoke('submit_print', {
      command: {
        id: `test-${Date.now()}`,
        type: 'print',
        format: 'html',
        content: '<h2>CWE Print Rust</h2><p>这是一条来自桌面应用的测试打印。</p>',
        printer: config.value.defaultPrinter || undefined,
        copies: 1,
        paperSize: 'A4',
        margins: { top: 10, left: 10, right: 10, bottom: 10 },
        position: { top: 12, left: 12 }
      }
    })
    pushLog('info', 'queue', '测试打印任务已提交')
    await refreshRuntime()
  } catch (err) {
    pushLog('error', 'queue', `测试打印失败: ${String(err)}`)
  }
}

async function reprint(task: PrintTask) {
  try {
    await invoke('reprint_task', { taskId: task.id })
    pushLog('info', 'queue', `已提交重打任务: ${task.id}`)
    await refreshRuntime()
  } catch (err) {
    pushLog('error', 'queue', `重打失败: ${String(err)}`)
  }
}

function refreshLogs() {
  refreshRuntime()
}

function pushLog(level: LogEntry['level'], source: string, message: string) {
  logs.value.push({
    time: new Date().toISOString(),
    level,
    source,
    message
  })
  if (logs.value.length > 500) logs.value.shift()
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false })
}

function formatDateTime(iso?: string) {
  if (!iso) return '-'
  const date = new Date(iso)
  return `${date.toLocaleDateString('zh-CN')} ${date.toLocaleTimeString('zh-CN', { hour12: false })}`
}

function statusText(value: string) {
  switch (value) {
    case 'pending':
      return '待打印'
    case 'printing':
      return '打印中'
    case 'success':
      return '成功'
    case 'failed':
      return '失败'
    default:
      return value
  }
}

function levelColor(level: string) {
  switch (level) {
    case 'error':
      return '#f56c6c'
    case 'warn':
      return '#e6a23c'
    case 'info':
      return '#409eff'
    case 'debug':
      return '#909399'
    default:
      return '#606266'
  }
}

function sourceColor(source: string) {
  const colors: Record<string, string> = {
    tcp: '#409eff',
    ws: '#67c23a',
    queue: '#e6a23c',
    engine: '#f56c6c',
    service: '#909399',
    settings: '#606266'
  }
  return colors[source] || '#606266'
}
</script>

<template>
  <div class="app">
    <header class="app-header">
      <div class="logo">
        <span class="logo-icon">🖨️</span>
        <span class="logo-text">卡挖易打印系统</span>
        <span class="version">Rust v{{ appVersion }}</span>
      </div>
      <nav class="nav-tabs">
        <button :class="['nav-tab', { active: activeTab === 'status' }]" @click="activeTab = 'status'">
          状态监控
        </button>
        <button :class="['nav-tab', { active: activeTab === 'settings' }]" @click="activeTab = 'settings'">
          服务设置
        </button>
        <button :class="['nav-tab', { active: activeTab === 'logs' }]" @click="activeTab = 'logs'">
          运行日志
        </button>
      </nav>
    </header>

    <main class="app-body">
      <section v-if="activeTab === 'status'" class="status-panel">
        <div class="section-title">服务状态</div>
        <div class="status-grid">
          <div class="status-card">
            <div class="card-header">
              <span class="card-title">TCP Socket</span>
              <span :class="['badge', status.tcp.running ? 'success' : 'error']">
                {{ status.tcp.running ? '运行中' : '已停止' }}
              </span>
            </div>
            <div class="card-body">
              <div class="metric">
                <span class="metric-label">监听端口</span>
                <span class="metric-value">{{ status.tcp.port || '-' }}</span>
              </div>
              <div class="metric">
                <span class="metric-label">在线客户端</span>
                <span class="metric-value">{{ status.tcp.clients }}</span>
              </div>
            </div>
          </div>

          <div class="status-card">
            <div class="card-header">
              <span class="card-title">WebSocket</span>
              <span :class="['badge', status.ws.running ? 'success' : 'error']">
                {{ status.ws.running ? '运行中' : '已停止' }}
              </span>
            </div>
            <div class="card-body">
              <div class="metric">
                <span class="metric-label">监听端口</span>
                <span class="metric-value">{{ status.ws.port || '-' }}</span>
              </div>
              <div class="metric">
                <span class="metric-label">在线客户端</span>
                <span class="metric-value">{{ status.ws.clients }}</span>
              </div>
            </div>
          </div>

          <div class="status-card wide">
            <div class="card-header">
              <span class="card-title">打印队列</span>
            </div>
            <div class="card-body queue-stats">
              <div class="queue-item">
                <span class="queue-count pending">{{ status.printQueue.pending }}</span>
                <span class="queue-label">待打印</span>
              </div>
              <div class="queue-item">
                <span class="queue-count active">{{ status.printQueue.active }}</span>
                <span class="queue-label">打印中</span>
              </div>
              <div class="queue-item">
                <span class="queue-count success">{{ status.printQueue.completed }}</span>
                <span class="queue-label">已完成</span>
              </div>
              <div class="queue-item">
                <span class="queue-count failed">{{ status.printQueue.failed }}</span>
                <span class="queue-label">失败</span>
              </div>
            </div>
          </div>
        </div>

        <div class="section-title printer-title">
          打印机列表
          <button class="refresh-btn" @click="refreshPrinters">刷新</button>
        </div>
        <div class="printer-list">
          <div v-if="printers.length === 0" class="empty">暂无打印机</div>
          <div v-for="printer in printers" :key="printer.name" :class="['printer-item', { default: printer.isDefault }]">
            <div class="printer-name">
              {{ printer.name }}
              <span v-if="printer.isDefault" class="default-tag">默认</span>
            </div>
            <div class="printer-desc">{{ printer.description || '系统打印机' }}</div>
            <div class="printer-status">
              <span :class="['status-dot', printer.status === 0 ? 'ready' : 'offline']" />
              {{ printer.status === 0 ? '就绪' : '离线' }}
            </div>
          </div>
        </div>
      </section>

      <section v-if="activeTab === 'settings'" class="settings-panel">
        <div class="section-title">服务配置</div>
        <div class="settings-card">
          <div class="form-row">
            <label class="form-label">TCP Socket 端口</label>
            <div class="form-input-wrap">
              <input v-model.number="config.tcpPort" type="number" min="1024" max="65535" class="form-input" placeholder="9527" />
              <span class="form-hint">Web 系统通过 TCP Socket 发送打印指令的端口</span>
            </div>
          </div>

          <div class="form-row">
            <label class="form-label">WebSocket 端口</label>
            <div class="form-input-wrap">
              <input v-model.number="config.wsPort" type="number" min="1024" max="65535" class="form-input" placeholder="9528" />
              <span class="form-hint">Web 系统通过 WebSocket 发送打印指令的端口</span>
            </div>
          </div>

          <div class="form-row">
            <label class="form-label">日志级别</label>
            <div class="form-input-wrap">
              <select v-model="config.logLevel" class="form-input">
                <option value="debug">Debug - 调试（最详细）</option>
                <option value="info">Info - 信息（推荐）</option>
                <option value="warn">Warn - 警告</option>
                <option value="error">Error - 错误（最精简）</option>
              </select>
            </div>
          </div>

          <div class="form-row">
            <label class="form-label">开机自启动</label>
            <div class="form-input-wrap">
              <label class="switch">
                <input v-model="config.autoStart" type="checkbox" />
                <span class="slider" />
              </label>
              <span class="form-hint">系统启动时自动运行打印服务</span>
            </div>
          </div>

          <div class="form-row">
            <label class="form-label">Dry-run</label>
            <div class="form-input-wrap">
              <label class="switch">
                <input v-model="config.dryRun" type="checkbox" />
                <span class="slider" />
              </label>
              <span class="form-hint">不执行真实系统打印，仅模拟任务流程并保留历史记录</span>
            </div>
          </div>
        </div>

        <div class="section-title printer-title">默认打印机</div>
        <div class="settings-card">
          <div class="form-row">
            <label class="form-label">默认打印机</label>
            <div class="form-input-wrap">
              <div class="printer-select-row">
                <select v-model="config.defaultPrinter" class="form-input">
                  <option value="">使用系统默认打印机</option>
                  <option v-for="printer in printerOptions" :key="printer.name" :value="printer.name">
                    {{ printer.name }}{{ printer.isDefault ? '（系统默认）' : '' }}
                  </option>
                </select>
                <button class="refresh-btn" @click="refreshPrinters">刷新</button>
              </div>
              <span class="form-hint">打印指令未指定打印机时使用此打印机；选择“使用系统默认打印机”则不指定打印机</span>
            </div>
          </div>
        </div>

        <div class="actions">
          <button :class="['save-btn', { saving }]" :disabled="saving" @click="saveConfig">
            {{ saving ? '保存中...' : '保存配置并重启服务' }}
          </button>
          <button class="test-btn" @click="submitTestPrint">发送测试打印</button>
          <span v-if="saveMsg" :class="['save-msg', { error: saveMsg.startsWith('保存失败') }]">{{ saveMsg }}</span>
        </div>

      </section>

      <section v-if="activeTab === 'logs'" class="log-panel">
        <div class="log-toolbar">
          <div class="log-title">{{ viewMode === 'log' ? '运行日志' : '打印记录' }}</div>
          <div class="log-filters" :class="{ 'filters-hidden': viewMode !== 'log' }">
            <select v-model="filterLevel" class="filter-select">
              <option value="all">全部级别</option>
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error</option>
            </select>
            <select v-model="filterSource" class="filter-select">
              <option value="all">全部来源</option>
              <option value="tcp">TCP</option>
              <option value="ws">WebSocket</option>
              <option value="queue">队列</option>
              <option value="engine">引擎</option>
              <option value="settings">设置</option>
            </select>
            <label class="filter-check">
              <input v-model="autoScroll" type="checkbox" />
              自动滚动
            </label>
            <button class="clear-btn" @click="refreshLogs">刷新</button>
          </div>
          <div class="view-toggle">
            <button :class="['toggle-btn', { active: viewMode === 'log' }]" @click="viewMode = 'log'">日志模式</button>
            <button :class="['toggle-btn', { active: viewMode === 'list' }]" @click="viewMode = 'list'">列表模式</button>
          </div>
        </div>

        <div v-if="viewMode === 'log'" class="log-container">
          <div v-if="filteredLogs.length === 0" class="log-empty">暂无日志</div>
          <div v-for="(log, i) in filteredLogs" :key="i" class="log-row">
            <span class="log-time">{{ formatTime(log.time) }}</span>
            <span class="log-level" :style="{ color: levelColor(log.level) }">{{ log.level.toUpperCase() }}</span>
            <span class="log-source" :style="{ color: sourceColor(log.source) }">[{{ log.source }}]</span>
            <span class="log-message">{{ log.message }}</span>
          </div>
        </div>

        <div v-else class="list-container">
          <div v-if="tasks.length === 0" class="log-empty">暂无打印任务</div>
          <div v-else class="task-list">
            <div v-for="task in tasks" :key="task.id" class="task-item">
              <div class="task-info">
                <div class="task-row">
                  <span class="task-id" :title="task.id">{{ task.id }}</span>
                  <span :class="['task-status', `status-${task.status}`]">{{ statusText(task.status) }}</span>
                </div>
                <div class="task-row meta">
                  <span>格式: {{ task.format }}</span>
                  <span>创建: {{ formatDateTime(task.createdAt) }}</span>
                  <span v-if="task.printer">打印机: {{ task.printer }}</span>
                  <span v-if="task.outputPath" class="task-output" :title="task.outputPath">
                    输出: {{ task.outputPath }}
                  </span>
                </div>
                <div v-if="task.error" class="task-error">{{ task.error }}</div>
              </div>
              <button class="reprint-btn" @click="reprint(task)">重打</button>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #f5f7fa;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  height: 56px;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  flex-shrink: 0;
}

.logo,
.nav-tabs,
.log-filters,
.view-toggle,
.actions {
  display: flex;
  align-items: center;
}

.logo {
  gap: 8px;
}

.logo-icon {
  font-size: 24px;
}

.logo-text {
  font-size: 18px;
  font-weight: 600;
  color: #303133;
}

.version {
  font-size: 12px;
  color: #909399;
  background: #f0f2f5;
  padding: 2px 8px;
  border-radius: 4px;
}

.nav-tabs {
  gap: 4px;
}

.nav-tab {
  padding: 8px 20px;
  border: none;
  background: transparent;
  color: #606266;
  font-size: 14px;
  cursor: pointer;
  border-radius: 6px;
}

.nav-tab:hover {
  background: #f5f7fa;
  color: #409eff;
}

.nav-tab.active {
  background: #ecf5ff;
  color: #409eff;
  font-weight: 500;
}

.app-body {
  flex: 1;
  overflow: hidden;
  padding: 20px;
}

.status-panel,
.settings-panel {
  height: 100%;
  overflow-y: auto;
}

.section-title,
.log-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 16px;
}

.printer-title {
  margin-top: 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.status-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}

.status-card,
.settings-card,
.printer-list,
.list-container {
  background: #fff;
  border-radius: 8px;
  border: 1px solid #e4e7ed;
}

.status-card {
  padding: 20px;
}

.status-card.wide {
  grid-column: span 2;
}

.card-header,
.metric,
.log-toolbar,
.task-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-header {
  margin-bottom: 16px;
}

.card-title,
.metric-value,
.printer-name,
.task-id {
  font-weight: 500;
  color: #303133;
}

.card-title,
.metric-value {
  font-size: 14px;
}

.badge {
  padding: 2px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.badge.success {
  background: #f0f9eb;
  color: #67c23a;
}

.badge.error {
  background: #fef0f0;
  color: #f56c6c;
}

.metric {
  padding: 8px 0;
  border-bottom: 1px solid #f0f2f5;
}

.metric:last-child {
  border-bottom: none;
}

.metric-label,
.queue-label,
.printer-desc,
.form-hint,
.task-row.meta {
  color: #909399;
  font-size: 12px;
}

.metric-label,
.printer-status {
  font-size: 13px;
}

.queue-stats {
  display: flex;
  gap: 32px;
}

.queue-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.queue-count {
  font-size: 28px;
  font-weight: 700;
}

.queue-count.pending {
  color: #e6a23c;
}

.queue-count.active {
  color: #409eff;
}

.queue-count.success {
  color: #67c23a;
}

.queue-count.failed {
  color: #f56c6c;
}

.refresh-btn,
.clear-btn {
  padding: 4px 12px;
  font-size: 12px;
  border: 1px solid #dcdfe6;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
  color: #606266;
}

.refresh-btn:hover {
  color: #409eff;
  border-color: #409eff;
}

.printer-select-row {
  display: flex;
  gap: 8px;
}

.printer-select-row .form-input {
  min-width: 0;
}

.printer-select-row .refresh-btn {
  height: 32px;
  flex-shrink: 0;
}

.printer-list {
  overflow: hidden;
}

.empty,
.log-empty {
  padding: 40px;
  text-align: center;
  color: #909399;
}

.printer-item {
  padding: 14px 20px;
  border-bottom: 1px solid #f0f2f5;
  display: flex;
  align-items: center;
  gap: 16px;
}

.printer-item:last-child {
  border-bottom: none;
}

.printer-item.default {
  background: #f5f7fa;
}

.printer-name {
  min-width: 200px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.default-tag,
.task-status {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
}

.default-tag {
  background: #ecf5ff;
  color: #409eff;
}

.printer-desc {
  flex: 1;
}

.printer-status {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #606266;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-dot.ready {
  background: #67c23a;
}

.status-dot.offline {
  background: #c0c4cc;
}

.settings-card {
  padding: 24px;
}

.form-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 20px;
}

.form-row:last-child {
  margin-bottom: 0;
}

.form-label {
  width: 130px;
  flex-shrink: 0;
  font-size: 14px;
  color: #606266;
  line-height: 32px;
}

.form-input-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-input {
  height: 32px;
  padding: 0 12px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  font-size: 14px;
  color: #303133;
  background: #fff;
  width: 100%;
  box-sizing: border-box;
}

.form-input:focus {
  outline: none;
  border-color: #409eff;
}

.switch {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 20px;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: #dcdfe6;
  border-radius: 20px;
  transition: 0.3s;
}

.slider::before {
  content: '';
  position: absolute;
  height: 16px;
  width: 16px;
  left: 2px;
  bottom: 2px;
  background: #fff;
  border-radius: 50%;
  transition: 0.3s;
}

input:checked + .slider {
  background: #409eff;
}

input:checked + .slider::before {
  transform: translateX(20px);
}

.actions {
  margin-top: 24px;
  gap: 16px;
}

.save-btn,
.test-btn {
  min-width: 160px;
  height: 40px;
  padding: 10px 28px;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
}

.save-btn {
  background: #409eff;
  color: #fff;
  border: none;
}

.test-btn {
  border: 1px solid #409eff;
  background: #fff;
  color: #409eff;
}

.test-btn:hover {
  background: #ecf5ff;
}

.save-btn:hover {
  background: #66b1ff;
}

.save-btn:disabled {
  background: #a0cfff;
  cursor: not-allowed;
}

.save-msg {
  font-size: 13px;
  color: #67c23a;
}

.save-msg.error {
  color: #f56c6c;
}

.log-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.log-toolbar {
  margin-bottom: 12px;
  flex-shrink: 0;
}

.log-title {
  margin-bottom: 0;
}

.log-filters {
  gap: 8px;
}

.log-filters.filters-hidden {
  visibility: hidden;
}

.filter-select {
  height: 28px;
  padding: 0 8px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  font-size: 12px;
  color: #606266;
  background: #fff;
}

.filter-check {
  font-size: 12px;
  color: #606266;
  display: flex;
  align-items: center;
  gap: 4px;
}

.view-toggle {
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  overflow: hidden;
}

.toggle-btn {
  padding: 4px 12px;
  font-size: 12px;
  border: none;
  background: #fff;
  cursor: pointer;
  color: #606266;
}

.toggle-btn.active {
  background: #409eff;
  color: #fff;
}

.clear-btn:hover {
  color: #409eff;
  border-color: #409eff;
}

.log-container {
  flex: 1;
  background: #1e1e1e;
  border-radius: 8px;
  padding: 12px;
  overflow-y: auto;
  font-family: 'SF Mono', Monaco, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
}

.log-row {
  display: flex;
  gap: 10px;
  padding: 2px 0;
  white-space: nowrap;
}

.log-time {
  color: #858585;
  min-width: 64px;
  flex-shrink: 0;
}

.log-level {
  min-width: 42px;
  flex-shrink: 0;
  font-weight: 600;
}

.log-source {
  min-width: 56px;
  flex-shrink: 0;
}

.log-message {
  color: #d4d4d4;
  white-space: pre-wrap;
  word-break: break-all;
}

.list-container {
  flex: 1;
  overflow-y: auto;
}

.task-list {
  display: flex;
  flex-direction: column;
}

.task-item {
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid #f0f2f5;
}

.task-item:last-child {
  border-bottom: none;
}

.task-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.task-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.task-row.meta {
  flex-wrap: wrap;
}

.task-id {
  font-size: 13px;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-pending {
  background: #fdf6ec;
  color: #e6a23c;
}

.status-printing {
  background: #ecf5ff;
  color: #409eff;
}

.status-success {
  background: #f0f9eb;
  color: #67c23a;
}

.status-failed {
  background: #fef0f0;
  color: #f56c6c;
}

.task-error {
  font-size: 12px;
  color: #f56c6c;
}

.task-output {
  max-width: 520px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reprint-btn {
  padding: 5px 14px;
  font-size: 12px;
  border: 1px solid #409eff;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
  color: #409eff;
  flex-shrink: 0;
}

.reprint-btn:hover {
  background: #409eff;
  color: #fff;
}
</style>
