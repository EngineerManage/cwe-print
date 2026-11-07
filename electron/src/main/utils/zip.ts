import fs from 'fs'
import path from 'path'
import { deflateRawSync } from 'zlib'

interface ZipSourceFile {
  absolutePath: string
  archivePath: string
}

interface ZipMemoryFile {
  archivePath: string
  content: Buffer | string
}

interface ZipDirectory {
  archivePath: string
}

export type ZipEntry = ZipSourceFile | ZipMemoryFile | ZipDirectory

interface CentralDirectoryRecord {
  archivePath: string
  crc: number
  compressedSize: number
  uncompressedSize: number
  compressionMethod: number
  localHeaderOffset: number
  modDate: Date
}

const CRC_TABLE = new Uint32Array(256)

for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  CRC_TABLE[i] = c >>> 0
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function normalizeArchivePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .join('/')
}

function directoryPath(value: string): string {
  const normalized = normalizeArchivePath(value)
  return normalized.endsWith('/') ? normalized : `${normalized}/`
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(date.getFullYear(), 1980)
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2)
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: dosDate }
}

function createLocalHeader(record: CentralDirectoryRecord): Buffer {
  const name = Buffer.from(record.archivePath, 'utf-8')
  const { time, date } = dosDateTime(record.modDate)
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0x0800, 6)
  header.writeUInt16LE(record.compressionMethod, 8)
  header.writeUInt16LE(time, 10)
  header.writeUInt16LE(date, 12)
  header.writeUInt32LE(record.crc, 14)
  header.writeUInt32LE(record.compressedSize, 18)
  header.writeUInt32LE(record.uncompressedSize, 22)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(0, 28)
  return Buffer.concat([header, name])
}

function createCentralDirectoryHeader(record: CentralDirectoryRecord): Buffer {
  const name = Buffer.from(record.archivePath, 'utf-8')
  const { time, date } = dosDateTime(record.modDate)
  const header = Buffer.alloc(46)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(0x0800, 8)
  header.writeUInt16LE(record.compressionMethod, 10)
  header.writeUInt16LE(time, 12)
  header.writeUInt16LE(date, 14)
  header.writeUInt32LE(record.crc, 16)
  header.writeUInt32LE(record.compressedSize, 20)
  header.writeUInt32LE(record.uncompressedSize, 24)
  header.writeUInt16LE(name.length, 28)
  header.writeUInt16LE(0, 30)
  header.writeUInt16LE(0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(0, 36)
  header.writeUInt32LE(record.archivePath.endsWith('/') ? 0x10 : 0, 38)
  header.writeUInt32LE(record.localHeaderOffset, 42)
  return Buffer.concat([header, name])
}

function createEndOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number): Buffer {
  const footer = Buffer.alloc(22)
  footer.writeUInt32LE(0x06054b50, 0)
  footer.writeUInt16LE(0, 4)
  footer.writeUInt16LE(0, 6)
  footer.writeUInt16LE(entryCount, 8)
  footer.writeUInt16LE(entryCount, 10)
  footer.writeUInt32LE(centralSize, 12)
  footer.writeUInt32LE(centralOffset, 16)
  footer.writeUInt16LE(0, 20)
  return footer
}

function entryBuffer(entry: ZipEntry): { content: Buffer; archivePath: string; modDate: Date; method: number } {
  if ('absolutePath' in entry) {
    const stat = fs.statSync(entry.absolutePath)
    const content = fs.readFileSync(entry.absolutePath)
    return {
      content,
      archivePath: normalizeArchivePath(entry.archivePath),
      modDate: stat.mtime,
      method: content.length === 0 ? 0 : 8
    }
  }

  if ('content' in entry) {
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf-8')
    return {
      content,
      archivePath: normalizeArchivePath(entry.archivePath),
      modDate: new Date(),
      method: content.length === 0 ? 0 : 8
    }
  }

  return {
    content: Buffer.alloc(0),
    archivePath: directoryPath(entry.archivePath),
    modDate: new Date(),
    method: 0
  }
}

export function collectDirectoryEntries(rootPath: string, archiveRoot: string): ZipEntry[] {
  if (!fs.existsSync(rootPath)) return []

  const entries: ZipEntry[] = [{ archivePath: archiveRoot }]

  function walk(currentPath: string, relativePath = ''): void {
    const names = fs.readdirSync(currentPath).sort((a, b) => a.localeCompare(b))
    for (const name of names) {
      const absolutePath = path.join(currentPath, name)
      const childRelativePath = relativePath ? `${relativePath}/${name}` : name
      const archivePath = `${archiveRoot}/${childRelativePath}`
      const stat = fs.lstatSync(absolutePath)

      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        entries.push({ archivePath })
        walk(absolutePath, childRelativePath)
      } else if (stat.isFile()) {
        entries.push({ absolutePath, archivePath })
      }
    }
  }

  walk(rootPath)
  return entries
}

export function writeZipFile(outputPath: string, entries: ZipEntry[]): void {
  const chunks: Buffer[] = []
  const records: CentralDirectoryRecord[] = []
  let offset = 0
  const seen = new Set<string>()

  for (const entry of entries) {
    const prepared = entryBuffer(entry)
    if (!prepared.archivePath || seen.has(prepared.archivePath)) continue
    seen.add(prepared.archivePath)

    const compressed =
      prepared.method === 8 ? deflateRawSync(prepared.content, { level: 9 }) : prepared.content
    const record: CentralDirectoryRecord = {
      archivePath: prepared.archivePath,
      crc: crc32(prepared.content),
      compressedSize: compressed.length,
      uncompressedSize: prepared.content.length,
      compressionMethod: prepared.method,
      localHeaderOffset: offset,
      modDate: prepared.modDate
    }

    const localHeader = createLocalHeader(record)
    chunks.push(localHeader, compressed)
    records.push(record)
    offset += localHeader.length + compressed.length
  }

  const centralOffset = offset
  const centralChunks = records.map(createCentralDirectoryHeader)
  const centralSize = centralChunks.reduce((size, chunk) => size + chunk.length, 0)
  chunks.push(...centralChunks, createEndOfCentralDirectory(records.length, centralSize, centralOffset))

  fs.writeFileSync(outputPath, Buffer.concat(chunks))
}
