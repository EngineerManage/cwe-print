<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { LogEntry } from '../../preload'

const logs = ref<LogEntry[]>([])
const autoScroll = ref(true)
const filterLevel = ref<string>('all')
const filterSource = ref<string>('all')

let unbindLog: (() => void) | null = null

onMounted(() => {
  unbindLog = window.electronAPI.onLog((entry) => {
    logs.value.push(entry)
    if (logs.value.length > 500) {
      logs.value.shift()
    }
  })
})

onUnmounted(() => {
  unbindLog?.()
})

function clearLogs() {
  logs.value = []
}

function formatTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleTimeString('zh-CN', { hour12: false })
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
      <div class="log-title">运行日志</div>
      <div class="log-filters">
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
    </div>
    <div class="log-container">
      <div v-if="filteredLogs.length === 0" class="log-empty">暂无日志</div>
      <div
        v-for="(log, i) in filteredLogs"
        :key="i"
        class="log-row"
      >
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
</style>
