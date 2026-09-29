<script setup lang="ts">
import { ref } from 'vue'

type PrintType = 'pdf' | 'html' | 'image' | 'escpos' | 'ecpay'

const printType = ref<PrintType>('pdf')
const printContent = ref('')
const sending = ref(false)
const sendMsg = ref('')

const printTypeOptions = [
  { label: 'pdf', value: 'pdf' },
  { label: '内容', value: 'html' },
  { label: '图片', value: 'image' },
  { label: '小票机', value: 'escpos', disabled: true },
  { label: '绿界', value: 'ecpay' }
]

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
    const result = await window.electronAPI.debugPrint({
      format: printType.value,
      content: printContent.value
    })
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
      <div class="debug-row">
        <label class="debug-label">打印类型</label>
        <a-select
          v-model:value="printType"
          :options="printTypeOptions"
          class="debug-select"
        />
      </div>
      <div class="debug-row">
        <label class="debug-label">打印内容</label>
        <a-textarea
          v-model:value="printContent"
          :rows="8"
          class="debug-textarea"
          placeholder="请输入打印内容"
        />
      </div>
      <div class="debug-actions">
        <a-button
          type="primary"
          :loading="sending"
          :disabled="printType === 'escpos'"
          @click="sendTestPrint"
        >
          测试发送
        </a-button>
        <span v-if="sendMsg" class="send-msg">{{ sendMsg }}</span>
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
}

.debug-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding-top: 14px;
}

.send-msg {
  color: #606266;
  font-size: 13px;
}
</style>
