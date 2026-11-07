import { createApp } from 'vue'
import { Button, Checkbox, Input, InputNumber, Radio, Select, Switch } from 'ant-design-vue'
import 'ant-design-vue/dist/reset.css'
import App from './App.vue'

function reportRendererError(payload: Parameters<typeof window.electronAPI.reportRendererError>[0]) {
  window.electronAPI.reportRendererError?.(payload).catch((err) => {
    console.error('上报渲染进程错误失败:', err)
  })
}

window.addEventListener('error', (event) => {
  reportRendererError({
    type: 'error',
    message: event.message,
    stack: event.error instanceof Error ? event.error.stack : undefined,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  reportRendererError({
    type: 'unhandledrejection',
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined
  })
})

createApp(App)
  .use(Button)
  .use(Checkbox)
  .use(Input)
  .use(InputNumber)
  .use(Radio)
  .use(Select)
  .use(Switch)
  .mount('#app')
