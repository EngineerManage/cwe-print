# CWE Print

跨平台打印客户端，支持接收 Web 系统通过 Socket 发送的打印指令，执行本地打印任务。

## 技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 桌面框架 | **Electron** | 跨平台桌面应用，原生打印 API 完善 |
| 开发语言 | TypeScript | 前后端统一类型安全 |
| 构建工具 | Vite + electron-vite | 快速热更新，开发体验好 |
| UI 框架 | Vue 3 | 状态面板、设置界面 |
| Socket 通信 | Node.js `net` + `ws` | 同时支持 TCP Socket 和 WebSocket |
| 打印核心 | Electron `webContents.print()` | 原生打印，支持静默打印 |
| 打包发布 | electron-builder | 一键打包 Windows / macOS |

## 项目结构

```
cwe-print/
├── src/
│   ├── main/              # 主进程（Node.js）
│   │   ├── index.ts       # 入口：窗口、托盘、IPC
│   │   ├── socket/
│   │   │   ├── tcp-server.ts   # TCP Socket 服务端
│   │   │   └── ws-server.ts    # WebSocket 服务端
│   │   ├── print/
│   │   │   ├── engine.ts       # 打印引擎（HTML / PDF / 图片 / ESC-POS）
│   │   │   ├── queue.ts        # 打印任务队列
│   │   │   └── paper-sizes.ts  # 纸张尺寸数据库（A4/A3/Letter 等）
│   │   └── utils/
│   │       ├── config.ts       # 配置管理（持久化到 userData）
│   │       ├── logger.ts       # 结构化日志
│   │       └── service-manager.ts  # 服务管理器（含自动重启）
│   ├── preload/           # 预加载脚本（安全 IPC 桥接）
│   └── renderer/          # 渲染进程（Vue3 UI）
│       └── src/
│           ├── App.vue
│           ├── components/
│           │   ├── StatusPanel.vue    # 服务状态 + 打印机列表
│           │   ├── SettingsPanel.vue  # 端口配置 + 保存
│           │   └── LogPanel.vue       # 实时日志
│           └── main.ts
├── build/icon.png
├── package.json
├── electron.vite.config.ts
└── electron-builder.yml
```

## 核心功能

### 1. 可配置端口 + 服务自动重启

- **TCP Socket 端口**：默认 `9527`，Web 系统通过 TCP 长连接发送 JSON 打印指令
- **WebSocket 端口**：默认 `9528`，支持浏览器端双向通信
- **自动重启**：在设置页面修改端口后点击保存，`ConfigManager` 触发 `restart:tcp` / `restart:ws` 事件，`ServiceManager` 自动**先停止旧服务，再启动新端口监听**，无需关闭软件

相关代码：
- `src/main/utils/config.ts:43`
- `src/main/utils/service-manager.ts:28`

### 2. 通信协议

Web 系统通过 TCP 或 WebSocket 发送 JSON 格式的打印指令：

```json
{
  "id": "uuid",
  "type": "print",
  "format": "html",
  "content": "<h1>测试内容</h1>",
  "printer": "打印机名称",
  "copies": 1,
  "paperSize": "A4",
  "margins": { "top": 10, "left": 10, "right": 10, "bottom": 10 },
  "position": { "top": 0, "left": 0 }
}
```

- **TCP**：每条 JSON 以换行符 `\n` 分隔
- **WebSocket**：直接发送 JSON 字符串
- **响应**：`{"success": true, "result": {"taskId": "xxx", "status": "pending"}}`

### 3. 打印引擎

| 格式 | 状态 | 实现方式 |
|------|------|---------|
| HTML | 已实现 | 创建隐藏 BrowserWindow，注入 `@page` CSS 控制纸张/边距/定位 → `webContents.print()` |
| PDF | 骨架 | 预留接口，待接入系统打印或 `pdf-to-printer` |
| 图片 | 已实现 | 嵌入 HTML 复用打印逻辑，支持绝对定位 |
| ESC/POS | 预留 | 预留接口，后续接入 `serialport` / `usb` 直写 USB/串口 |

### 4. 纸张尺寸与边距控制

打印引擎支持精确控制：

- **纸张尺寸**：A4 / A3 / A5 / Letter / Legal / B5 / 自定义尺寸（宽 x 高 mm 或 in）
- **打印边距**：上下左右独立设置（单位 mm）
- **绝对定位**：内容在纸张上的精确位置偏移（单位 mm），支持分块打印
- **组合打印**：同一张纸上打印多个内容块，每个块独立定位

实现方式：在 HTML 中注入 CSS `@page { size: 210mm 297mm; margin: 10mm; }`，内容块使用 `position: absolute` 定位。同时传递 `pageSize` 和 `margins` 给 Electron `webContents.print()` 作为双重保障。

相关代码：
- `src/main/print/paper-sizes.ts` — 纸张尺寸数据库
- `src/main/print/engine.ts:buildPrintHtml()` — HTML 包装与 CSS 注入

任务队列：入队 → 异步处理 → 状态追踪（pending / printing / success / failed）

### 5. 桌面界面

- **状态监控**：TCP / WebSocket 服务状态、在线客户端数、打印队列统计、系统打印机列表
- **服务设置**：端口配置、日志级别、开机自启动、默认打印机
- **运行日志**：实时滚动日志，支持按级别/来源过滤，深色终端风格

### 6. 系统托盘

- 最小化到托盘后台运行
- 右键菜单：显示窗口 / 暂停服务 / 退出

## 运行方式

```bash
# 安装依赖（国内网络建议使用镜像）
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install

# 开发模式
npm run dev

# 构建
npm run build

# 打包
npm run build:mac    # macOS
npm run build:win    # Windows
npm run build:linux  # Linux
```

## 后续扩展建议

| 功能 | 优先级 | 实现思路 |
|------|--------|---------|
| ESC/POS 小票机直打 | 高 | 安装 `serialport` / `usb` 库，直接写 USB/串口 |
| PDF 打印完善 | 高 | 使用 `pdf-to-printer` 或系统 `lp` 命令 |
| 打印模板引擎 | 中 | 支持传入模板 ID + 数据，本地渲染后打印 |
| 打印预览 | 中 | 渲染进程打开预览窗口，确认后再发送主进程 |
| 自动更新 | 低 | 集成 `electron-updater` + GitHub Releases |
| 多门店管理 | 低 | 增加设备 ID 标识，支持 Web 系统按门店下发指令 |
