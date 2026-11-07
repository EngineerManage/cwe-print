export const HTML_PRINT_BATCH_SIZE = 100

const HTML_PAGE_BREAK = '<div style="break-after: page; page-break-after: always;"></div>'
const PAGE_BREAK_DIV_PATTERN = /<div\b[^>]*\bstyle\s*=\s*(?:"[^"]*(?:break-after\s*:\s*page|page-break-after\s*:\s*always)[^"]*"|'[^']*(?:break-after\s*:\s*page|page-break-after\s*:\s*always)[^']*')[^>]*>\s*<\/div>/gi

export function splitHtmlPrintContent(content: string, batchSize = HTML_PRINT_BATCH_SIZE): string[] {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`HTML 打印批次大小无效: ${batchSize}`)
  }

  if (!content.trim() || /<!doctype\s+html|<html\b/i.test(content)) {
    return [content]
  }

  const pages = content
    .split(PAGE_BREAK_DIV_PATTERN)
    .filter((page) => page.trim().length > 0)

  if (pages.length <= batchSize) {
    return [content]
  }

  const batches: string[] = []
  for (let index = 0; index < pages.length; index += batchSize) {
    batches.push(pages.slice(index, index + batchSize).join(`\n${HTML_PAGE_BREAK}\n`))
  }
  return batches
}
