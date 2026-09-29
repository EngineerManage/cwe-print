import { BrowserWindow, app, dialog, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import { logger } from './logger'
import { serviceManager } from './service-manager'

let updatePromptVisible = false
let isDownloadingUpdate = false
let isInstallingUpdate = false

function getMainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()[0]
}

function showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const mainWindow = getMainWindow()
  return mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options)
}

function formatReleaseNotes(info: UpdateInfo): string {
  const notes = info.releaseNotes
  if (!notes) return ''
  if (typeof notes === 'string') return notes

  return notes
    .map((note) => {
      if (typeof note === 'string') return note
      return note.note
    })
    .filter(Boolean)
    .join('\n')
}

function getUpdateErrorMessage(error: Error): string {
  const message = error.message || String(error)

  if (
    /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|net::ERR|network|timeout/i.test(message)
  ) {
    return `网络异常，无法连接到 GitHub Releases。请检查网络或代理后重试。\n\n${message}`
  }

  if (/404|Not Found/i.test(message)) {
    return `没有找到更新文件。请确认 GitHub Release 中已上传当前平台的安装包和 latest 更新信息。\n\n${message}`
  }

  if (/sha512|checksum|signature/i.test(message)) {
    return `更新包校验失败。请重新发布 Release 或检查上传的安装包是否完整。\n\n${message}`
  }

  return message
}

async function showUpdateError(error: Error): Promise<void> {
  const message = getUpdateErrorMessage(error)
  logger.error(`自动更新失败: ${message}`, 'updater')

  await showMessageBox({
    type: 'error',
    title: '更新失败',
    message: '更新失败',
    detail: message,
    buttons: ['知道了']
  })
}

async function promptForUpdate(info: UpdateInfo): Promise<void> {
  if (updatePromptVisible || isDownloadingUpdate) return
  updatePromptVisible = true

  const releaseNotes = formatReleaseNotes(info)
  const detail = [
    `当前版本：${app.getVersion()}`,
    `最新版本：${info.version}`,
    releaseNotes ? `\n更新说明：\n${releaseNotes}` : ''
  ].join('\n')

  try {
    const result = await showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 ${info.version}，是否立即更新？`,
      detail,
      buttons: ['立即更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })

    if (result.response !== 0) {
      logger.info(`用户暂不更新到 ${info.version}`, 'updater')
      return
    }

    isDownloadingUpdate = true
    logger.info(`开始下载更新 ${info.version}`, 'updater')
    await autoUpdater.downloadUpdate()
  } finally {
    updatePromptVisible = false
  }
}

async function installDownloadedUpdate(): Promise<void> {
  if (isInstallingUpdate) return
  isInstallingUpdate = true

  logger.info('更新已下载，准备退出并安装', 'updater')

  try {
    await serviceManager.stop()
  } catch (error) {
    logger.warn(`安装更新前停止服务失败: ${(error as Error).message}`, 'updater')
  }

  autoUpdater.quitAndInstall(false, true)
}

async function promptForInstall(info: UpdateInfo): Promise<void> {
  const result = await showMessageBox({
    type: 'info',
    title: '更新已就绪',
    message: `新版本 ${info.version} 已下载完成，是否立即重启并安装？`,
    detail: '应用会自动重启，正在处理的打印任务请先确认完成。',
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })

  if (result.response === 0) {
    await installDownloadedUpdate()
  } else {
    logger.info(`用户延后安装更新 ${info.version}`, 'updater')
  }
}

function setupUpdaterEvents(): void {
  autoUpdater.on('checking-for-update', () => {
    logger.info('正在检查更新...', 'updater')
  })

  autoUpdater.on('update-available', (info) => {
    logger.info(`发现新版本 ${info.version}`, 'updater')
    void promptForUpdate(info)
  })

  autoUpdater.on('update-not-available', (info) => {
    logger.info(`当前已是最新版本 ${info.version}`, 'updater')
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    logger.info(`更新下载进度 ${progress.percent.toFixed(1)}%`, 'updater')
  })

  autoUpdater.on('update-downloaded', (info) => {
    isDownloadingUpdate = false
    logger.info(`新版本 ${info.version} 下载完成`, 'updater')
    void promptForInstall(info)
  })

  autoUpdater.on('error', (error) => {
    isDownloadingUpdate = false
    void showUpdateError(error)
  })
}

export function initAutoUpdater(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false

  setupUpdaterEvents()
}

export function checkForUpdatesOnStartup(): void {
  if (is.dev || !app.isPackaged) {
    logger.info('开发环境跳过自动更新检查', 'updater')
    return
  }

  void autoUpdater.checkForUpdates()
}

export function isUpdateInstalling(): boolean {
  return isInstallingUpdate
}
