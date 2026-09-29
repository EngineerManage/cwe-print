<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import type { LogEntry, PrintTask } from '../../../preload'

type ViewMode = 'log' | 'list'
type QueueStatusFilter = 'all' | 'pending' | 'printing' | 'success' | 'failed'

const props = defineProps<{
  queueStatus?: QueueStatusFilter
}>()

const tasks = ref<PrintTask[]>([])
const logs = ref<LogEntry[]>([])
const logContainer = ref<HTMLElement | null>(null)
const viewMode = ref<ViewMode>('log')
const autoScroll = ref(true)
const filterQueueStatus = ref<QueueStatusFilter>(props.queueStatus || 'all')
const filterLevel = ref<string>('all')
const filterSource = ref<string>('all')
const exportMsg = ref('')

const queueStatusOptions = [
  { label: '全部', value: 'all' },
  { label: '待打印', value: 'pending' },
  { label: '打印中', value: 'printing' },
  { label: '已完成', value: 'success' },
  { label: '失败', value: 'failed' }
]

const levelOptions = [
  { label: '全部级别', value: 'all' },
  { label: 'Debug', value: 'debug' },
  { label: 'Info', value: 'info' },
  { label: 'Warn', value: 'warn' },
  { label: 'Error', value: 'error' }
]

const sourceOptions = [
  { label: '全部来源', value: 'all' },
  { label: 'TCP', value: 'tcp' },
  { label: 'WebSocket', value: 'ws' },
  { label: '队列', value: 'queue' },
  { label: '引擎', value: 'engine' },
  { label: '服务', value: 'service' },
  { label: '崩溃', value: 'crash' },
  { label: '页面', value: 'renderer' }
]

const viewModeOptions = [
  { label: '日志模式', value: 'log' },
  { label: '列表模式', value: 'list' }
]

let unbindQueue: (() => void) | null = null
let unbindLog: (() => void) | null = null

watch(
  () => props.queueStatus,
  (status) => {
    filterQueueStatus.value = status || 'all'
  }
)

onMounted(async () => {
  await refreshAll()
  unbindQueue = window.electronAPI.onPrintQueueChange(() => {
    loadTasks()
  })
  unbindLog = window.electronAPI.onLog((log) => {
    logs.value = [...logs.value, log].slice(-1000)
    scrollLogToBottom()
  })
})

onUnmounted(() => {
  unbindQueue?.()
  unbindLog?.()
})

async function loadTasks() {
  tasks.value = await window.electronAPI.getPrintTasks()
}

async function loadLogs() {
  logs.value = await window.electronAPI.getLogs()
  scrollLogToBottom()
}

async function refreshAll() {
  await Promise.all([loadTasks(), loadLogs()])
}

async function exportLogFile() {
  exportMsg.value = ''
  const result = await window.electronAPI.exportLogs()
  if (result.success) {
    exportMsg.value = `日志已导出：${result.filePath || '-'}`
  } else if (result.error && result.error !== '已取消导出') {
    exportMsg.value = `导出失败：${result.error}`
  }
}

async function scrollLogToBottom() {
  if (!autoScroll.value) return
  await nextTick()
  if (!logContainer.value) return
  logContainer.value.scrollTop = logContainer.value.scrollHeight
}

async function reprint(task: PrintTask) {
  // 点击重打时，把当前任务 ID 发给主进程，主进程会基于原指令生成新任务重新入队
  const result = await window.electronAPI.reprintTask(task.id)
  if (!result.success) {
    console.error('重打失败:', result.error)
  }
}

function formatTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

function formatDateTime(iso: string) {
  const d = new Date(iso)
  return `${d.toLocaleDateString('zh-CN')} ${d.toLocaleTimeString('zh-CN', { hour12: false })}`
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
    crash: '#f56c6c',
    renderer: '#b37feb',
    main: '#606266'
  }
  return colors[source] || '#606266'
}

function statusText(status: string) {
  switch (status) {
    case 'pending':
      return '待打印'
    case 'printing':
      return '打印中'
    case 'success':
      return '已完成'
    case 'failed':
      return '失败'
    default:
      return status
  }
}

function statusClass(status: string) {
  return `status-${status}`
}

function queueStatusLogText(status: QueueStatusFilter) {
  switch (status) {
    case 'pending':
      return '待打印'
    case 'printing':
      return '打印中'
    case 'success':
      return '已完成'
    case 'failed':
      return '失败'
    default:
      return ''
  }
}

const filteredLogs = computed(() => {
  return logs.value.filter((log) => {
    if (filterLevel.value !== 'all' && log.level !== filterLevel.value) return false
    if (filterSource.value !== 'all' && log.source !== filterSource.value) return false
    if (
      filterQueueStatus.value !== 'all' &&
      (log.source !== 'queue' || !log.message.includes(queueStatusLogText(filterQueueStatus.value)))
    ) {
      return false
    }
    return true
  })
})

const filteredTasks = computed(() => {
  if (filterQueueStatus.value === 'all') return tasks.value
  return tasks.value.filter((task) => task.status === filterQueueStatus.value)
})
</script>

<template>
  <div class="log-panel">
    <div class="log-toolbar">
      <div class="log-title">{{ viewMode === 'log' ? '运行日志' : '打印记录' }}</div>
      <div class="toolbar-left">
        <a-select
          v-model:value="filterQueueStatus"
          :options="queueStatusOptions"
          class="queue-filter-select"
        />
        <div class="log-filters" :class="{ 'filters-hidden': viewMode !== 'log' }">
          <a-select
            v-model:value="filterLevel"
            :options="levelOptions"
            class="filter-select"
          />
          <a-select
            v-model:value="filterSource"
            :options="sourceOptions"
            class="filter-select"
          />
          <a-checkbox v-model:checked="autoScroll">自动滚动</a-checkbox>
          <a-button html-type="button" @click="refreshAll">刷新</a-button>
          <a-button html-type="button" @click="exportLogFile">导出日志</a-button>
        </div>
      </div>
      <!-- 日志/列表模式切换：独立块，与 filters 分开，避免 filters 显隐导致布局抖动 -->
      <a-radio-group
        v-model:value="viewMode"
        :options="viewModeOptions"
        option-type="button"
        button-style="solid"
      />
    </div>

    <div v-if="viewMode === 'log'" ref="logContainer" class="log-container">
      <div v-if="exportMsg" class="export-msg">{{ exportMsg }}</div>
      <div v-if="filteredLogs.length === 0" class="log-empty">暂无日志</div>
      <div v-for="(log, i) in filteredLogs" :key="i" class="log-row">
        <span class="log-time">{{ formatTime(log.time) }}</span>
        <span class="log-level" :style="{ color: levelColor(log.level) }">
          {{ log.level.toUpperCase() }}
        </span>
        <span class="log-source" :style="{ color: sourceColor(log.source) }">
          [{{ log.source }}]
        </span>
        <span class="log-message">{{ log.message }}</span>
      </div>
    </div>

    <div v-else class="list-container">
      <div v-if="filteredTasks.length === 0" class="log-empty">暂无打印任务</div>
      <div v-else class="task-list">
        <div v-for="task in filteredTasks" :key="task.id" class="task-item">
          <div class="task-info">
            <div class="task-row">
              <span class="task-id" :title="task.id">{{ task.id }}</span>
              <span :class="['task-status', statusClass(task.status)]">
                {{ statusText(task.status) }}
              </span>
            </div>
            <div class="task-row meta">
              <span>格式: {{ task.format }}</span>
              <span>创建: {{ formatDateTime(task.createdAt) }}</span>
              <span v-if="task.printer">打印机: {{ task.printer }}</span>
            </div>
            <div v-if="task.error" class="task-error">{{ task.error }}</div>
          </div>
          <a-button html-type="button" size="small" @click="reprint(task)">重打</a-button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.log-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.log-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  flex-shrink: 0;
}

.log-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.toolbar-left,
.log-filters {
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-filters.filters-hidden {
  /* 保留占位空间，避免切换模式时右侧布局抖动；隐藏后元素不可交互 */
  visibility: hidden;
}

.queue-filter-select {
  width: 120px;
}

.filter-select {
  width: 120px;
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

.export-msg {
  color: #67c23a;
  margin-bottom: 8px;
  white-space: pre-wrap;
  word-break: break-all;
}

.log-empty {
  color: #606266;
  text-align: center;
  padding: 40px;
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
  background: #fff;
  border-radius: 8px;
  border: 1px solid #e4e7ed;
  overflow-y: auto;
}

.task-list {
  display: flex;
  flex-direction: column;
}

.task-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
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
  font-size: 12px;
  color: #909399;
}

.task-id {
  font-size: 13px;
  font-weight: 500;
  color: #303133;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-status {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
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

</style>
