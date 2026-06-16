import { BrowserWindow } from 'electron'
import { logger } from '../utils/logger'
import { printQueue } from './queue'
import type { PrintTask } from './queue'
import type { PrintCommand, PrintBlock } from '../socket/tcp-server'
import { getPaperDimensions, toElectronPageSize, DEFAULT_MARGINS } from './paper-sizes'

export async function handlePrintCommand(cmd: PrintCommand): Promise<{ taskId: string; status: string }> {
  const task = printQueue.enqueue(cmd)

  // 触发队列处理（异步）
  processQueue()

  return { taskId: task.id, status: task.status }
}

async function processQueue(): Promise<void> {
  await printQueue.process(async (task) => {
    switch (task.format) {
      case 'pdf':
        await printPdf(task)
        break
      case 'html':
        await printHtml(task)
        break
      case 'image':
        await printImage(task)
        break
      case 'escpos':
        await printEscpos(task)
        break
      default:
        throw new Error(`不支持的打印格式: ${task.format}`)
    }
  })
}

async function printPdf(task: PrintTask): Promise<void> {
  logger.info(`开始打印 PDF: ${task.id}, 纸张: ${formatPaperSize(task.paperSize)}`, 'engine')
  // TODO: 实现 PDF 打印逻辑
  await simulatePrint(task, 1000)
}

async function printHtml(task: PrintTask): Promise<void> {
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

    // 等待内容渲染完成
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500)
    })

    // 构建 Electron print 选项
    const printOptions = buildElectronPrintOptions(task)

    await new Promise<void>((resolve, reject) => {
      win.webContents.print(
        printOptions,
        (success, errorType) => {
          if (success) {
            resolve()
          } else {
            reject(new Error(`打印失败: ${errorType}`))
          }
        }
      )
    })
  } finally {
    win.destroy()
  }
}

async function printImage(task: PrintTask): Promise<void> {
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

  await printHtml({
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
    deviceName: task.printer || '',
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

/**
 * 格式化纸张尺寸用于日志
 */
function formatPaperSize(paperSize: PrintCommand['paperSize']): string {
  if (!paperSize) return '默认'
  if (typeof paperSize === 'string') return paperSize
  return `${paperSize.width}${paperSize.unit}`
}
