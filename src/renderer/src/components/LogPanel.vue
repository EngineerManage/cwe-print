<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { LogEntry, PrintTask } from '../../../preload'

type ViewMode = 'log' | 'list'

const logs = ref<LogEntry[]>([])
const tasks = ref<PrintTask[]>([])
const viewMode = ref<ViewMode>('log')
const autoScroll = ref(true)
const filterLevel = ref<string>('all')
const filterSource = ref<string>('all')

let unbindLog: (() => void) | null = null
let unbindQueue: (() => void) | null = null

onMounted(() => {
  // 日志模式：实时追加运行日志
  unbindLog = window.electronAPI.onLog((entry) => {
    logs.value.push(entry)
    // 限制内存占用，只保留最近 500 条
    if (logs.value.length > 500) {
      logs.value.shift()
    }
  })

  // 列表模式：初始化加载一次任务，并订阅队列变更事件做增量刷新
  loadTasks()
  unbindQueue = window.electronAPI.onPrintQueueChange(() => {
    loadTasks()
  })
})

onUnmounted(() => {
  unbindLog?.()
  unbindQueue?.()
})

async function loadTasks() {
  tasks.value = await window.electronAPI.getPrintTasks()
}

async function reprint(task: PrintTask) {
  // 点击重打时，把当前任务 ID 发给主进程，主进程会基于原指令生成新任务重新入队
  const result = await window.electronAPI.reprintTask(task.id)
  if (!result.success) {
    console.error('重打失败:', result.error)
  }
}

function clearLogs() {
  logs.value = []
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
      return '成功'
    case 'failed':
      return '失败'
    default:
      return status
  }
}

function statusClass(status: string) {
  return `status-${status}`
}

const filteredLogs = computed(() => {
  return logs.value.filter((log) => {
    if (filterLevel.value !== 'all' && log.level !== filterLevel.value) return false
    if (filterSource.value !== 'all' && log.source !== filterSource.value) return false
    return true
  })
})
</script>

<template>
  <div class="log-panel">
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
          <option value="service">服务</option>
        </select>
        <label class="filter-check">
          <input v-model="autoScroll" type="checkbox" />
          自动滚动
        </label>
        <button class="clear-btn" @click="clearLogs">清空</button>
      </div>
      <!-- 日志/列表模式切换：独立块，与 filters 分开，避免 filters 显隐导致布局抖动 -->
      <div class="view-toggle">
        <button
          :class="['toggle-btn', { active: viewMode === 'log' }]"
          @click="viewMode = 'log'"
        >
          日志模式
        </button>
        <button
          :class="['toggle-btn', { active: viewMode === 'list' }]"
          @click="viewMode = 'list'"
        >
          列表模式
        </button>
      </div>
    </div>

    <div v-if="viewMode === 'log'" class="log-container">
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
      <div v-if="tasks.length === 0" class="log-empty">暂无打印任务</div>
      <div v-else class="task-list">
        <div v-for="task in tasks" :key="task.id" class="task-item">
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
          <button class="reprint-btn" @click="reprint(task)">重打</button>
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

.log-filters {
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-filters.filters-hidden {
  /* 保留占位空间，避免切换模式时右侧布局抖动；隐藏后元素不可交互 */
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
  display: flex;
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

.clear-btn {
  padding: 4px 12px;
  font-size: 12px;
  border: 1px solid #dcdfe6;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
  color: #606266;
}

.clear-btn:hover {
  color: #f56c6c;
  border-color: #f56c6c;
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
