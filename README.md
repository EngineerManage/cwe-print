# CWE Print

本仓库现在按实现技术栈拆分为两个同级项目：

- `electron/`：原 Electron + Vite + Vue 打印客户端。
- `rust/`：新的 Tauri + Vue + Rust 桌面打印客户端。

## Electron 版本

```bash
cd electron
npm install
npm run dev
```

## Rust / Tauri 版本

```bash
cd rust
npm install
npm run tauri:dev
```

Rust 版本默认开启 dry-run，不会真实提交系统打印任务。需要真实打印时，在应用设置中关闭 dry-run。
