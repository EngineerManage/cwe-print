import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import EventEmitter from 'events'
import type { AppConfig } from '../../preload'

const CONFIG_FILE = 'app-config.json'
const DEFAULT_CONFIG: AppConfig = {
  tcpPort: 9527,
  wsPort: 9528,
  autoStart: true,
  defaultPrinter: '',
  logLevel: 'info'
}

class ConfigManager extends EventEmitter {
  private config: AppConfig
  private configPath: string

  constructor() {
    super()
    this.configPath = path.join(app.getPath('userData'), CONFIG_FILE)
    this.config = this.load()
  }

  private load(): AppConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8')
        const parsed = JSON.parse(raw) as Partial<AppConfig>
        return { ...DEFAULT_CONFIG, ...parsed }
      }
    } catch (err) {
      console.error('加载配置失败:', err)
    }
    return { ...DEFAULT_CONFIG }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8')
    } catch (err) {
      console.error('保存配置失败:', err)
    }
  }

  get(): AppConfig {
    return { ...this.config }
  }

  set(partial: Partial<AppConfig>): AppConfig {
    const oldPort = this.config.tcpPort
    const oldWsPort = this.config.wsPort

    this.config = { ...this.config, ...partial }
    this.save()

    this.emit('changed', this.get())

    // 端口变更时触发重启事件
    if (partial.tcpPort !== undefined && partial.tcpPort !== oldPort) {
      this.emit('restart:tcp', partial.tcpPort)
    }
    if (partial.wsPort !== undefined && partial.wsPort !== oldWsPort) {
      this.emit('restart:ws', partial.wsPort)
    }

    return this.get()
  }
}

export const configManager = new ConfigManager()
