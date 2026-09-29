import { createApp } from 'vue'
import { Button, Checkbox, Input, InputNumber, Radio, Select, Switch } from 'ant-design-vue'
import 'ant-design-vue/dist/reset.css'
import App from './App.vue'

createApp(App)
  .use(Button)
  .use(Checkbox)
  .use(Input)
  .use(InputNumber)
  .use(Radio)
  .use(Select)
  .use(Switch)
  .mount('#app')
