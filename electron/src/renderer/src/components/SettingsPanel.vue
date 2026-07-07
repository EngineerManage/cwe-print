<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import type { AppConfig } from '../../../preload'

const config = ref<AppConfig>({
  tcpPort: 9527,
  wsPort: 9528,
  autoStart: true,
  defaultPrinter: '',
  logLevel: 'info'
})

const saving = ref(false)
const saveMsg = ref('')
const restarting = ref(false)

let unbindConfig: (() => void) | null = null

async function loadConfig() {
  config.value = await window.electronAPI.getConfig()
}

async function saveConfig() {
  saving.value = true
  saveMsg.value = ''
  try {
    const result = await window.electronAPI.setConfig({
      tcpPort: config.value.tcpPort,
      wsPort: config.value.wsPort,
      autoStart: config.value.autoStart,
      defaultPrinter: config.value.defaultPrinter,
      logLevel: config.value.logLevel
    })
    config.value = result
    saveMsg.value = '配置已保存，服务已自动重启'
    restarting.value = true
    setTimeout(() => {
      saveMsg.value = ''
      restarting.value = false
    }, 3000)
  } catch (err) {
    saveMsg.value = '保存失败: ' + (err as Error).message
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  await loadConfig()
  unbindConfig = window.electronAPI.onConfigChange((c) => {
    config.value = c
  })
})

onUnmounted(() => {
  unbindConfig?.()
})
</script>

<template>
  <div class="settings-panel">
    <div class="section-title">服务配置</div>
    <div class="settings-card">
      <div class="form-row">
        <label class="form-label">TCP Socket 端口</label>
        <div class="form-input-wrap">
          <input
            v-model.number="config.tcpPort"
            type="number"
            min="1024"
            max="65535"
            class="form-input"
            placeholder="9527"
          />
          <span class="form-hint">Web 系统通过 TCP Socket 发送打印指令的端口</span>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label">WebSocket 端口</label>
        <div class="form-input-wrap">
          <input
            v-model.number="config.wsPort"
            type="number"
            min="1024"
            max="65535"
            class="form-input"
            placeholder="9528"
          />
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
    </div>

    <div class="section-title" style="margin-top: 24px">默认打印机</div>
    <div class="settings-card">
      <div class="form-row">
        <label class="form-label">默认打印机</label>
        <div class="form-input-wrap">
          <input
            v-model="config.defaultPrinter"
            class="form-input"
            placeholder="留空则使用系统默认打印机"
          />
          <span class="form-hint">
            打印指令未指定打印机时使用此打印机，留空则使用系统默认
          </span>
        </div>
      </div>
    </div>

    <div class="actions">
      <button
        :class="['save-btn', { saving }]"
        :disabled="saving"
        @click="saveConfig"
      >
        {{ saving ? '保存中...' : '保存配置并重启服务' }}
      </button>
      <span v-if="saveMsg" :class="['save-msg', { error: saveMsg.startsWith('保存失败') }]">
        {{ saveMsg }}
      </span>
    </div>

    <div class="info-box">
      <div class="info-title">配置说明</div>
      <ul class="info-list">
        <li>
          <strong>TCP Socket 端口</strong>：Web 系统通过 TCP 长连接发送 JSON 格式的打印指令，每条指令以换行符分隔
        </li>
        <li>
          <strong>WebSocket 端口</strong>：Web 系统通过 WebSocket 连接发送打印指令，支持双向通信
        </li>
        <li>
          <strong>端口变更自动重启</strong>：修改端口后点击保存，Socket 服务会自动停止旧端口并监听新端口，无需手动重启软件
        </li>
        <li>
          <strong>通信协议</strong>：指令格式为 JSON，包含 id、type、format、content 等字段
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.settings-panel {
  height: 100%;
  overflow-y: auto;
  max-width: 700px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 16px;
}

.settings-card {
  background: #fff;
  border-radius: 8px;
  padding: 24px;
  border: 1px solid #e4e7ed;
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
  transition: border-color 0.2s;
  width: 100%;
  box-sizing: border-box;
}

.form-input:focus {
  outline: none;
  border-color: #409eff;
}

.form-hint {
  font-size: 12px;
  color: #909399;
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
  display: flex;
  align-items: center;
  gap: 16px;
}

.save-btn {
  padding: 10px 28px;
  background: #409eff;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.2s;
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

.info-box {
  margin-top: 24px;
  padding: 16px 20px;
  background: #f4f4f5;
  border-radius: 8px;
  border-left: 4px solid #909399;
}

.info-title {
  font-size: 14px;
  font-weight: 600;
  color: #606266;
  margin-bottom: 10px;
}

.info-list {
  margin: 0;
  padding-left: 18px;
  color: #606266;
  font-size: 13px;
  line-height: 1.8;
}

.info-list li {
  margin-bottom: 4px;
}

.info-list strong {
  color: #303133;
}
</style>
