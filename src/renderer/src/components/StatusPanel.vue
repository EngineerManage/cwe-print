<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import type { ServiceStatus, PrinterInfo } from '../../preload'

const status = ref<ServiceStatus>({
  tcp: { running: false, port: 0, clients: 0 },
  ws: { running: false, port: 0, clients: 0 },
  printQueue: { pending: 0, active: 0, completed: 0, failed: 0 }
})

const printers = ref<PrinterInfo[]>([])

let unbindStatus: (() => void) | null = null

async function refreshPrinters() {
  printers.value = await window.electronAPI.getPrinters()
}

onMounted(async () => {
  status.value = await window.electronAPI.getServiceStatus()
  unbindStatus = window.electronAPI.onServiceStatusChange((s) => {
    status.value = s
  })
  await refreshPrinters()
})

onUnmounted(() => {
  unbindStatus?.()
})
</script>

<template>
  <div class="status-panel">
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

    <div class="section-title" style="margin-top: 24px">
      打印机列表
      <button class="refresh-btn" @click="refreshPrinters">刷新</button>
    </div>
    <div class="printer-list">
      <div v-if="printers.length === 0" class="empty">暂无打印机</div>
      <div
        v-for="printer in printers"
        :key="printer.name"
        :class="['printer-item', { default: printer.isDefault }]"
      >
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
  </div>
</template>

<style scoped>
.status-panel {
  height: 100%;
  overflow-y: auto;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.status-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}

.status-card {
  background: #fff;
  border-radius: 8px;
  padding: 20px;
  border: 1px solid #e4e7ed;
}

.status-card.wide {
  grid-column: span 2;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.card-title {
  font-size: 14px;
  font-weight: 500;
  color: #606266;
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
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid #f0f2f5;
}

.metric:last-child {
  border-bottom: none;
}

.metric-label {
  color: #909399;
  font-size: 13px;
}

.metric-value {
  font-weight: 600;
  color: #303133;
  font-size: 14px;
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

.queue-label {
  font-size: 12px;
  color: #909399;
}

.refresh-btn {
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

.printer-list {
  background: #fff;
  border-radius: 8px;
  border: 1px solid #e4e7ed;
  overflow: hidden;
}

.empty {
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
  font-weight: 500;
  color: #303133;
  min-width: 200px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.default-tag {
  font-size: 11px;
  background: #ecf5ff;
  color: #409eff;
  padding: 1px 6px;
  border-radius: 3px;
}

.printer-desc {
  flex: 1;
  color: #909399;
  font-size: 13px;
}

.printer-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
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
</style>
