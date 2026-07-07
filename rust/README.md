# CWE Print Rust Desktop

基于 Tauri + Vue + Rust 的桌面打印应用，目标是替代现有 Electron 版本，同时保留端口配置、服务状态、打印历史和本地打印服务能力。

## 已实现

- Tauri 桌面窗口
- 服务状态面板
- TCP / WebSocket 端口配置
- 打印历史记录和重打入口
- 测试打印入口
- TCP Socket 服务，默认端口 `9527`
- WebSocket 服务，默认端口 `9528`
- 兼容原 Electron 版 JSON 打印指令
- 打印任务队列串行处理
- HTML / 图片 / PDF / ESC/POS 打印分流
- 纸张尺寸、边距、绝对定位 HTML 包装
- 配置文件持久化到系统配置目录
- 默认 dry-run，避免开发阶段误触发真实打印

## 运行

```bash
npm install
npm run tauri:dev
```

## 构建

```bash
npm run tauri:build
```

## 真实打印

应用默认开启 dry-run，不会真实提交系统打印任务。需要真实打印时，在桌面设置里关闭 dry-run。

## 协议

TCP 每条 JSON 以换行符分隔，WebSocket 直接发送 JSON 字符串。

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

## 真实打印说明

- macOS / Linux：使用系统 `lp` 命令提交打印任务。
- Windows：使用 PowerShell `Start-Process -Verb Print`。
- ESC/POS 直写暂未实现，后续可接入 USB / serialport 设备库。
