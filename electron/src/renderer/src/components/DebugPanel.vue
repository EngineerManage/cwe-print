<script setup lang="ts">
import { computed, ref } from 'vue'

type PrintType = 'pdf' | 'html' | 'image' | 'escpos' | 'ecpay'
type DebugPrintPayload = Parameters<typeof window.electronAPI.debugPrint>[0]
const PREVIEW_MAX_WIDTH = 360
const PREVIEW_MAX_HEIGHT = 260

const printType = ref<PrintType>('pdf')
const printContent = ref('')
const sending = ref(false)
const previewing = ref(false)
const sendMsg = ref('')
const previewMsg = ref('')
const previewHtml = ref('')
const previewPageSize = ref<{ width: number; height: number; unit: 'mm' } | null>(null)
const parsedCommand = ref<DebugPrintPayload | null>(null)

const printTypeOptions = [
  { label: 'pdf', value: 'pdf' },
  { label: '内容', value: 'html' },
  { label: '图片', value: 'image' },
  { label: '小票机', value: 'escpos', disabled: true },
  { label: '绿界', value: 'ecpay' }
]

const previewScale = computed(() => {
  const { width, height } = previewFrameSize.value
  if (width <= 0 || height <= 0) return 1
  return Math.min(PREVIEW_MAX_WIDTH / width, PREVIEW_MAX_HEIGHT / height)
})

const previewFrameSize = computed(() => {
  const page = previewPageSize.value
  if (!page) {
    return { width: 640, height: 420 }
  }

  return {
    width: Math.round((page.width / 25.4) * 96),
    height: Math.round((page.height / 25.4) * 96)
  }
})

const previewFrameStyle = computed(() => ({
  width: `${previewFrameSize.value.width}px`,
  height: `${previewFrameSize.value.height}px`,
  transform: `scale(${previewScale.value})`
}))

const previewOuterStyle = computed(() => ({
  width: `${Math.round(previewFrameSize.value.width * previewScale.value)}px`,
  height: `${Math.round(previewFrameSize.value.height * previewScale.value)}px`
}))

const previewMeta = computed(() => {
  if (!parsedCommand.value) return ''
  const page = previewPageSize.value
  const size = page ? ` · ${page.width}×${page.height}${page.unit}` : ''
  return `${parsedCommand.value.format}${size}`
})

function buildDebugPayload(): DebugPrintPayload {
  return {
    format: printType.value,
    content: printContent.value
  }
}

async function generatePreview() {
  previewMsg.value = ''
  sendMsg.value = ''
  previewHtml.value = ''
  previewPageSize.value = null
  parsedCommand.value = null

  if (!printContent.value.trim()) {
    previewMsg.value = '请输入打印内容'
    return
  }

  if (typeof window.electronAPI.debugPreview !== 'function') {
    previewMsg.value = '当前客户端未加载调试预览接口，请重启 Electron dev 客户端后再试'
    return
  }

  previewing.value = true
  try {
    const result = await window.electronAPI.debugPreview(buildDebugPayload())
    if (!result.success || !result.previewHtml || !result.command) {
      previewMsg.value = result.error || '生成预览失败'
      return
    }

    parsedCommand.value = result.command
    printType.value = result.command.format
    previewHtml.value = result.previewHtml
    previewPageSize.value = result.pageSize || null
    previewMsg.value = '预览已生成'
  } catch (err) {
    previewMsg.value = '生成预览失败：' + (err as Error).message
  } finally {
    previewing.value = false
  }
}

async function sendTestPrint() {
  sendMsg.value = ''

  if (!printContent.value.trim()) {
    sendMsg.value = '请输入打印内容'
    return
  }

  if (typeof window.electronAPI.debugPrint !== 'function') {
    sendMsg.value = '当前客户端未加载调试打印接口，请重启 Electron dev 客户端后再试'
    return
  }

  sending.value = true
  try {
    const result = await window.electronAPI.debugPrint(buildDebugPayload())
    sendMsg.value = result.success
      ? `发送成功，任务ID：${result.taskId || '-'}`
      : `发送失败：${result.error || '未知错误'}`
  } catch (err) {
    sendMsg.value = '发送失败：' + (err as Error).message
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div class="debug-panel">
    <div class="section-title">调试模式</div>
    <div class="debug-card">
      <div class="debug-layout">
        <div class="debug-form">
          <div class="debug-row">
            <label class="debug-label">打印类型</label>
            <a-select
              v-model:value="printType"
              :options="printTypeOptions"
              class="debug-select"
            />
          </div>
          <div class="debug-row content-row">
            <label class="debug-label">打印内容</label>
            <a-textarea
              v-model:value="printContent"
              :rows="12"
              class="debug-textarea"
              placeholder="可粘贴 HTML，或日志里的 Details / printTask / printCommand JSON"
            />
          </div>
          <div class="debug-actions">
            <a-button
              :loading="previewing"
              :disabled="printType === 'escpos'"
              @click="generatePreview"
            >
              生成预览
            </a-button>
            <a-button
              type="primary"
              :loading="sending"
              :disabled="printType === 'escpos'"
              @click="sendTestPrint"
            >
              测试发送
            </a-button>
          </div>
          <div v-if="previewMsg || sendMsg" class="debug-messages">
            <span v-if="previewMsg" class="send-msg">{{ previewMsg }}</span>
            <span v-if="sendMsg" class="send-msg">{{ sendMsg }}</span>
          </div>
        </div>

        <div class="preview-panel">
          <div class="preview-header">
            <span>效果预览</span>
            <span v-if="previewMeta" class="preview-meta">{{ previewMeta }}</span>
          </div>
          <div class="preview-stage">
            <div v-if="previewHtml" class="preview-page" :style="previewOuterStyle">
              <iframe
                class="preview-frame"
                sandbox=""
                :srcdoc="previewHtml"
                :style="previewFrameStyle"
              />
            </div>
            <div v-else class="preview-empty">暂无预览</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.debug-panel {
  min-height: 100%;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 16px;
}

.debug-card {
  background: #fff;
  border-radius: 8px;
  padding: 20px;
  border: 1px solid #e4e7ed;
}

.debug-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 420px;
  gap: 20px;
  align-items: stretch;
}

.debug-form {
  min-width: 0;
}

.debug-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 10px 0;
}

.debug-label {
  width: 130px;
  flex-shrink: 0;
  color: #606266;
  font-size: 13px;
  line-height: 32px;
}

.debug-select {
  width: 240px;
}

.debug-textarea {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}

.debug-actions {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding-top: 14px;
}

.debug-messages {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
  min-height: 20px;
  padding-top: 8px;
}

.send-msg {
  color: #606266;
  font-size: 13px;
}

.preview-panel {
  min-width: 0;
  border-left: 1px solid #ebeef5;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 32px;
  color: #303133;
  font-size: 13px;
  font-weight: 600;
}

.preview-meta {
  color: #909399;
  font-weight: 400;
}

.preview-stage {
  flex: 1;
  min-height: 360px;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  background:
    linear-gradient(45deg, #f5f7fa 25%, transparent 25%),
    linear-gradient(-45deg, #f5f7fa 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #f5f7fa 75%),
    linear-gradient(-45deg, transparent 75%, #f5f7fa 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: 16px;
}

.preview-page {
  background: #fff;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.12);
  flex: 0 0 auto;
}

.preview-frame {
  display: block;
  border: 0;
  transform-origin: top left;
  background: #fff;
  pointer-events: none;
}

.preview-empty {
  color: #909399;
  font-size: 13px;
}

@media (max-width: 1100px) {
  .debug-layout {
    grid-template-columns: 1fr;
  }

  .preview-panel {
    border-left: 0;
    border-top: 1px solid #ebeef5;
    padding-left: 0;
    padding-top: 16px;
  }
}
</style>
