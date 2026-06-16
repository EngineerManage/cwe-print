/**
 * 标准纸张尺寸数据库（单位：毫米 mm）
 *
 * 来源：ISO 216 (A系列) / ISO 269 (B系列) / 北美标准
 */
export interface PaperDimensions {
  /** 宽度 mm */
  width: number
  /** 高度 mm */
  height: number
  /** 标准名称 */
  name: string
}

export const PAPER_SIZE_MAP: Record<string, PaperDimensions> = {
  A3: { width: 297, height: 420, name: 'A3' },
  A4: { width: 210, height: 297, name: 'A4' },
  A5: { width: 148, height: 210, name: 'A5' },
  A6: { width: 105, height: 148, name: 'A6' },
  B4: { width: 250, height: 353, name: 'B4' },
  B5: { width: 176, height: 250, name: 'B5' },
  Letter: { width: 216, height: 279, name: 'Letter (US)' },
  Legal: { width: 216, height: 356, name: 'Legal (US)' },
  Tabloid: { width: 279, height: 432, name: 'Tabloid (US)' },
  '4x6': { width: 102, height: 152, name: '4x6 英寸' },
  '5x7': { width: 127, height: 178, name: '5x7 英寸' },
  '6x8': { width: 152, height: 203, name: '6x8 英寸' }
}

/**
 * 获取纸张尺寸的毫米尺寸
 */
export function getPaperDimensions(paperSize: string | { width: number; height: number; unit: 'mm' | 'in' }): PaperDimensions {
  if (typeof paperSize === 'string') {
    const standard = PAPER_SIZE_MAP[paperSize]
    if (standard) return standard
    throw new Error(`不支持的纸张尺寸: ${paperSize}，支持的尺寸: ${Object.keys(PAPER_SIZE_MAP).join(', ')}`)
  }

  // 自定义尺寸
  if (paperSize.unit === 'in') {
    return {
      width: Math.round(paperSize.width * 25.4),
      height: Math.round(paperSize.height * 25.4),
      name: `${paperSize.width}x${paperSize.height}in`
    }
  }

  return {
    width: paperSize.width,
    height: paperSize.height,
    name: `${paperSize.width}x${paperSize.height}mm`
  }
}

/**
 * 将纸张尺寸转换为 Electron pageSize 格式
 */
export function toElectronPageSize(paperSize: string | { width: number; height: number; unit: 'mm' | 'in' }): string | { width: number; height: number } {
  if (typeof paperSize === 'string') {
    // Electron 原生支持 A0-A6, Letter, Legal, Tabloid 等
    if (['A3', 'A4', 'A5', 'A6', 'Letter', 'Legal', 'Tabloid'].includes(paperSize)) {
      return paperSize
    }
    // 其他标准尺寸转为 mm
    const dim = getPaperDimensions(paperSize)
    return { width: dim.width * 1000, height: dim.height * 1000 } // microns
  }

  // 自定义尺寸转为 microns
  const dim = getPaperDimensions(paperSize)
  return { width: dim.width * 1000, height: dim.height * 1000 }
}

/**
 * 获取所有支持的纸张尺寸列表
 */
export function getSupportedPaperSizes(): Array<{ key: string; name: string; width: number; height: number }> {
  return Object.entries(PAPER_SIZE_MAP).map(([key, dim]) => ({
    key,
    name: dim.name,
    width: dim.width,
    height: dim.height
  }))
}

/**
 * 默认边距（单位 mm）
 */
export const DEFAULT_MARGINS = { top: 10, left: 10, right: 10, bottom: 10 }
