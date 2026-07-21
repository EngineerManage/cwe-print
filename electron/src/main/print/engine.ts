import { app, BrowserWindow } from 'electron'
import type { PrintToPDFOptions } from 'electron'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { logger } from '../utils/logger'
import { configManager } from '../utils/config'
import { printQueue } from './queue'
import type { PrintTask } from './queue'
import type { PrintCommand, PrintBlock } from '../socket/tcp-server'
import { getPaperDimensions, toElectronPageSize, DEFAULT_MARGINS } from './paper-sizes'

export async function handlePrintCommand(cmd: PrintCommand): Promise<{ taskId: string; status: string; outputPath?: string; error?: string }> {
  const task = printQueue.enqueue(cmd)

  // 触发队列处理（异步）
  processQueue().catch((err) => {
    logger.error(`打印队列处理异常: ${(err as Error).message}`, 'queue')
  })

  await waitForTaskDone(task)

  return { taskId: task.id, status: task.status, outputPath: task.outputPath, error: task.error }
}

function waitForTaskDone(task: PrintTask): Promise<void> {
  const isDone = (): boolean => {
    return task?.status === 'success' || task?.status === 'failed'
  }

  if (isDone()) return Promise.resolve()

  return new Promise((resolve) => {
    const onChanged = (): void => {
      if (!isDone()) return
      printQueue.off('changed', onChanged)
      resolve()
    }
    printQueue.on('changed', onChanged)
  })
}

async function processQueue(): Promise<void> {
  await printQueue.process(async (task) => {
    switch (task.format) {
      case 'pdf':
        return printPdf(task)
      case 'html':
        return printHtml(task)
      case 'image':
        return printImage(task)
      case 'escpos':
        return printEscpos(task)
      default:
        throw new Error(`不支持的打印格式: ${task.format}`)
    }
  })
}

async function printPdf(task: PrintTask): Promise<string> {
  logger.info(`开始打印 PDF: ${task.id}, 纸张: ${formatPaperSize(task.paperSize)}`, 'engine')
  const pdfPath = task.content
  if (!pdfPath || !existsSync(pdfPath)) {
    throw new Error(`PDF 文件不存在: ${pdfPath || '(空)'}`)
  }
  await printPdfFile(pdfPath, task)
  return pdfPath
}

async function printHtml(task: PrintTask): Promise<string> {
  logger.info(`开始打印 HTML: ${task.id}, 纸张: ${formatPaperSize(task.paperSize)}`, 'engine')

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      offscreen: true
    }
  })

  try {
    // 构建带纸张尺寸和边距控制的包装 HTML
    const wrappedHtml = buildPrintHtml(task)

    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(wrappedHtml)}`)

    await waitForRenderReady(win)

    const pdfPath = await createPdfOutputPath(task)
    const pdfOptions = buildElectronPdfOptions(task)
    const pdf = await win.webContents.printToPDF(pdfOptions)
    await fs.writeFile(pdfPath, pdf)
    logger.info(`HTML 已转换为 PDF: ${pdfPath}`, 'engine')

    await printPdfFile(pdfPath, task)
    return pdfPath
  } finally {
    win.destroy()
  }
}

async function waitForRenderReady(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    Promise.all([
      document.fonts ? document.fonts.ready : Promise.resolve(),
      Promise.all(Array.from(document.images).map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.onload = resolve;
          img.onerror = resolve;
        });
      }))
    ])
  `)
}

async function printImage(task: PrintTask): Promise<string> {
  logger.info(`开始打印图片: ${task.id}, 纸张: ${formatPaperSize(task.paperSize)}`, 'engine')

  const blocks: PrintBlock[] = task.blocks ?? []

  if (task.position) {
    // 单块绝对定位
    blocks.push({
      content: `<img src="${task.content}" style="max-width:100%;display:block;" />`,
      position: task.position
    })
  } else if (blocks.length === 0) {
    // 默认居中
    blocks.push({
      content: `<img src="${task.content}" style="max-width:100%;display:block;" />`,
      position: { top: 0, left: 0 }
    })
  }

  return printHtml({
    ...task,
    format: 'html',
    content: '',
    blocks
  })
}

async function printEscpos(task: PrintTask): Promise<void> {
  logger.info(`开始打印 ESC/POS: ${task.id}`, 'engine')
  // TODO: 通过 serialport/usb 直写小票机
  await simulatePrint(task, 500)
}

async function simulatePrint(task: PrintTask, ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
  logger.info(`模拟打印完成: ${task.id}`, 'engine')
}

async function printPdfFile(pdfPath: string, task: PrintTask): Promise<void> {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    await printPdfWithLp(pdfPath, task)
    return
  }

  if (process.platform === 'win32') {
    await printPdfWithElectron(pdfPath, task)
    return
  }

  throw new Error(`当前系统暂不支持 PDF 打印: ${process.platform}`)
}

async function printPdfWithLp(pdfPath: string, task: PrintTask): Promise<void> {
  const printer = task.printer || configManager.get().defaultPrinter || ''
  const copies = String(task.copies || 1)
  const args: string[] = []

  if (printer) {
    args.push('-d', printer)
  }

  args.push('-n', copies)
  appendCupsPdfOptions(args, task)
  args.push(pdfPath)
  await execFileAsync('lp', args)
}

async function printPdfWithElectron(pdfPath: string, task: PrintTask): Promise<void> {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      offscreen: true
    }
  })

  try {
    await win.loadFile(pdfPath)
    await waitForRenderReady(win)

    await new Promise<void>((resolve, reject) => {
      win.webContents.print(buildElectronPrintOptions(task), (success, errorType) => {
        if (success) {
          resolve()
        } else {
          reject(new Error(`PDF 打印失败: ${errorType}`))
        }
      })
    })
  } finally {
    win.destroy()
  }
}

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) {
        const message = stderr.trim() || stdout.trim() || error.message
        reject(new Error(`系统打印命令失败: ${message}`))
        return
      }
      resolve()
    })
  })
}

function appendCupsPdfOptions(args: string[], task: PrintTask): void {
  args.push(
    '-o',
    'print-scaling=none',
    '-o',
    'fit-to-page=false',
    '-o',
    'scaling=100',
    '-o',
    'natural-scaling=100',
    '-o',
    'page-left=0',
    '-o',
    'page-right=0',
    '-o',
    'page-top=0',
    '-o',
    'page-bottom=0',
    '-o',
    'position=center'
  )

  if (!task.paperSize) return

  const dim = getPaperDimensions(task.paperSize)
  args.push('-o', `media=${toCupsMedia(task.paperSize)}`)
  args.push('-o', `orientation-requested=${dim.width > dim.height ? 4 : 3}`)
}

function toCupsMedia(paperSize: PrintCommand['paperSize']): string {
  if (!paperSize) return 'A4'
  if (typeof paperSize === 'string') return paperSize

  const dim = getPaperDimensions(paperSize)
  return `Custom.${dim.width}x${dim.height}mm`
}

// ========== 辅助函数 ==========

/**
 * 构建打印用的 HTML，注入 @page CSS 和绝对定位
 */
function buildPrintHtml(task: PrintTask): string {
  const paperSize = task.paperSize
  const margins = task.margins ?? DEFAULT_MARGINS

  let paperCss = ''
  let bodyCss = ''

  if (paperSize) {
    const dim = getPaperDimensions(paperSize)
    paperCss = `@page { size: ${dim.width}mm ${dim.height}mm; margin: ${margins.top}mm ${margins.right}mm ${margins.bottom}mm ${margins.left}mm; }`
    bodyCss = `width: ${dim.width}mm; height: ${dim.height}mm; position: relative;`
  } else {
    paperCss = `@page { margin: ${margins.top}mm ${margins.right}mm ${margins.bottom}mm ${margins.left}mm; }`
    bodyCss = `position: relative;`
  }

  // 构建内容块
  const blocks: PrintBlock[] = []

  if (task.blocks && task.blocks.length > 0) {
    blocks.push(...task.blocks)
  }

  if (task.content && task.position) {
    blocks.push({ content: task.content, position: task.position })
  } else if (task.content && blocks.length === 0) {
    // 无定位时默认填充
    blocks.push({ content: task.content, position: { top: 0, left: 0 } })
  }

  const blocksHtml = blocks.map((block, index) => {
    const top = block.position.top
    const left = block.position.left
    return `
      <div class="print-block print-block-${index}" style="
        position: absolute;
        top: ${top}mm;
        left: ${left}mm;
        box-sizing: border-box;
      ">
        ${block.content}
      </div>
    `
  }).join('\n')

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
${paperCss}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  ${bodyCss}
  overflow: hidden;
}
.print-block {
  overflow: hidden;
}
@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
</style>
</head>
<body>
${blocksHtml}
</body>
</html>`
}

/**
 * 构建 Electron webContents.print() 选项
 */
function buildElectronPrintOptions(task: PrintTask): Record<string, unknown> {
  const options: Record<string, unknown> = {
    silent: true,
    printBackground: true,
    deviceName: task.printer || configManager.get().defaultPrinter || '',
    copies: task.copies || 1
  }

  if (task.paperSize) {
    options.pageSize = toElectronPageSize(task.paperSize)
  }

  if (task.margins) {
    options.margins = {
      marginType: 'custom',
      top: task.margins.top,
      bottom: task.margins.bottom,
      left: task.margins.left,
      right: task.margins.right
    }
  }

  // 合并用户额外选项（优先级最高，可覆盖）
  Object.assign(options, task.options || {})

  return options
}

function buildElectronPdfOptions(task: PrintTask): PrintToPDFOptions {
  const options: PrintToPDFOptions = {
    printBackground: true,
    preferCSSPageSize: true
  }

  if (task.paperSize) {
    options.pageSize = toElectronPdfPageSize(task.paperSize)
  }

  if (task.margins) {
    options.margins = {
      marginType: 'custom',
      top: mmToPixels(task.margins.top),
      bottom: mmToPixels(task.margins.bottom),
      left: mmToPixels(task.margins.left),
      right: mmToPixels(task.margins.right)
    }
  }

  return options
}

function toElectronPdfPageSize(paperSize: PrintCommand['paperSize']): PrintToPDFOptions['pageSize'] {
  if (!paperSize) return undefined
  if (typeof paperSize === 'string' && ['A3', 'A4', 'A5', 'A6', 'Letter', 'Legal', 'Tabloid'].includes(paperSize)) {
    return paperSize as PrintToPDFOptions['pageSize']
  }

  const dim = getPaperDimensions(paperSize)
  return {
    width: dim.width / 25.4,
    height: dim.height / 25.4
  }
}

function mmToPixels(value: number): number {
  return Math.round((value / 25.4) * 96)
}

async function createPdfOutputPath(task: PrintTask): Promise<string> {
  const dir = path.join(app.getPath('userData'), 'generated-pdf')
  await fs.mkdir(dir, { recursive: true })

  const timestamp = Date.now()
  const taskId = sanitizeFilename(task.id)
  return path.join(dir, `${timestamp}-${taskId}.pdf`)
}

function sanitizeFilename(value: string): string {
  const sanitized = value
    .split('')
    .map((char) => (/^[a-zA-Z0-9._-]$/.test(char) ? char : '_'))
    .join('')
    .slice(0, 80)

  return sanitized || 'task'
}

/**
 * 格式化纸张尺寸用于日志
 */
function formatPaperSize(paperSize: PrintCommand['paperSize']): string {
  if (!paperSize) return '默认'
  if (typeof paperSize === 'string') return paperSize
  return `${paperSize.width}${paperSize.unit}`
}
