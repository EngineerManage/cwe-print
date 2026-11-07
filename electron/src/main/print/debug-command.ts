import type { PrintCommand } from '../socket/tcp-server'
import { getPaperDimensions } from './paper-sizes'

const DEBUG_PRINT_FORMATS: PrintCommand['format'][] = ['pdf', 'html', 'image', 'escpos', 'ecpay']

export function parseDebugPrintCommand(raw: string, fallback: Partial<PrintCommand> = {}): PrintCommand | null {
  const text = raw.trim()
  const parsed = findPrintCommandCandidate(text)

  if (parsed) {
    return normalizeDebugPrintCommand(parsed, fallback)
  }

  const fallbackFormat = isPrintFormat(fallback.format) ? fallback.format : 'html'
  if (!text) return null

  return normalizeDebugPrintCommand({
    ...fallback,
    format: fallbackFormat,
    content: text
  }, fallback)
}

export function buildPreviewCommand(command: PrintCommand): PrintCommand | null {
  if (command.format === 'html') return command

  if (command.format === 'image') {
    return {
      ...command,
      format: 'html',
      content: `<img src="${escapeHtmlAttribute(command.content)}" style="max-width:100%;display:block;" />`,
      position: command.position || { top: 0, left: 0 }
    }
  }

  return null
}

export function getPreviewPageSize(command: PrintCommand): { width: number; height: number; unit: 'mm' } | undefined {
  if (!command.paperSize) return undefined
  const dim = getPaperDimensions(command.paperSize)
  return { width: dim.width, height: dim.height, unit: 'mm' }
}

function findPrintCommandCandidate(text: string): Partial<PrintCommand> | null {
  if (!text) return null

  const direct = tryParseJson(text)
  const directCandidate = resolvePrintCommandCandidate(direct)
  if (directCandidate) return directCandidate

  const wrapped = tryParseJson(`{${text}}`)
  const wrappedCandidate = resolvePrintCommandCandidate(wrapped)
  if (wrappedCandidate) return wrappedCandidate

  for (const candidateText of extractJsonObjectTexts(text)) {
    const candidate = resolvePrintCommandCandidate(tryParseJson(candidateText))
    if (candidate) return candidate
  }

  return null
}

function resolvePrintCommandCandidate(value: unknown): Partial<PrintCommand> | null {
  if (!isRecord(value)) return null

  const nestedKeys = ['printTask', 'printCommand', 'details', 'result']
  for (const key of nestedKeys) {
    const nested = resolvePrintCommandCandidate(value[key])
    if (nested) return nested
  }

  if (typeof value.content === 'string' && isPrintFormat(value.format)) {
    return value as Partial<PrintCommand>
  }

  return null
}

function normalizeDebugPrintCommand(candidate: Partial<PrintCommand>, fallback: Partial<PrintCommand>): PrintCommand | null {
  const format = isPrintFormat(candidate.format)
    ? candidate.format
    : isPrintFormat(fallback.format)
      ? fallback.format
      : 'html'
  const content = typeof candidate.content === 'string'
    ? candidate.content
    : typeof fallback.content === 'string'
      ? fallback.content
      : ''

  if (!content.trim()) return null

  return {
    id: typeof candidate.id === 'string' && candidate.id.trim()
      ? `debug-${candidate.id.trim()}`
      : `debug-${Date.now()}`,
    type: 'print',
    format,
    content,
    printer: typeof candidate.printer === 'string' ? candidate.printer : fallback.printer,
    copies: typeof candidate.copies === 'number' ? candidate.copies : fallback.copies,
    paperSize: candidate.paperSize || fallback.paperSize,
    margins: candidate.margins || fallback.margins,
    position: candidate.position || fallback.position,
    blocks: candidate.blocks || fallback.blocks,
    options: candidate.options || fallback.options
  } as PrintCommand
}

function extractJsonObjectTexts(text: string): string[] {
  const objects: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      if (depth === 0) start = i
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1))
        start = -1
        if (objects.length >= 20) break
      }
    }
  }

  return objects
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPrintFormat(value: unknown): value is PrintCommand['format'] {
  return typeof value === 'string' && DEBUG_PRINT_FORMATS.includes(value as PrintCommand['format'])
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
