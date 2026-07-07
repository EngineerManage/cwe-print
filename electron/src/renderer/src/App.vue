<script setup lang="ts">
import { ref } from 'vue'
import StatusPanel from './components/StatusPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import LogPanel from './components/LogPanel.vue'

const activeTab = ref<'status' | 'settings' | 'logs'>('status')
const appVersion = '1.0.0'
</script>

<template>
  <div class="app">
    <header class="app-header">
      <div class="logo">
        <span class="logo-icon">🖨️</span>
        <span class="logo-text">卡挖易打印系统</span>
        <span class="version">v{{ appVersion }}</span>
      </div>
      <nav class="nav-tabs">
        <button
          :class="['nav-tab', { active: activeTab === 'status' }]"
          @click="activeTab = 'status'"
        >
          状态监控
        </button>
        <button
          :class="['nav-tab', { active: activeTab === 'settings' }]"
          @click="activeTab = 'settings'"
        >
          服务设置
        </button>
        <button
          :class="['nav-tab', { active: activeTab === 'logs' }]"
          @click="activeTab = 'logs'"
        >
          运行日志
        </button>
      </nav>
    </header>

    <main class="app-body">
      <StatusPanel v-if="activeTab === 'status'" />
      <SettingsPanel v-if="activeTab === 'settings'" />
      <LogPanel v-if="activeTab === 'logs'" />
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

.logo {
  display: flex;
  align-items: center;
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
  display: flex;
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
  transition: all 0.2s;
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
</style>
