import fs from 'fs/promises'
import path from 'path'

export interface RetentionOptions {
  maxAgeMs: number
  maxFiles: number
  now?: number
  keepPaths?: string[]
}

interface FileEntry {
  path: string
  mtimeMs: number
}

export async function cleanupDirectoryFiles(dir: string, options: RetentionOptions): Promise<number> {
  const now = options.now ?? Date.now()
  const maxAgeMs = Math.max(0, options.maxAgeMs)
  const maxFiles = Math.max(0, options.maxFiles)
  const keepPaths = new Set((options.keepPaths ?? []).map((filePath) => path.resolve(filePath)))
  const entries = await listFiles(dir)
  const pathsToDelete = new Set<string>()
  const keptEntries = entries.filter((entry) => keepPaths.has(path.resolve(entry.path)))
  const maxRemainingFiles = Math.max(0, maxFiles - keptEntries.length)

  for (const entry of entries) {
    if (keepPaths.has(path.resolve(entry.path))) continue
    if (now - entry.mtimeMs > maxAgeMs) {
      pathsToDelete.add(entry.path)
    }
  }

  const remaining = entries
    .filter((entry) => !pathsToDelete.has(entry.path) && !keepPaths.has(path.resolve(entry.path)))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  for (const entry of remaining.slice(maxRemainingFiles)) {
    pathsToDelete.add(entry.path)
  }

  let deleted = 0
  for (const filePath of pathsToDelete) {
    try {
      await fs.unlink(filePath)
      deleted += 1
    } catch {
      // Ignore files that disappeared between listing and cleanup.
    }
  }

  return deleted
}

async function listFiles(dir: string): Promise<FileEntry[]> {
  let names: string[]

  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }

  const files: FileEntry[] = []

  for (const name of names) {
    const filePath = path.join(dir, name)
    try {
      const stat = await fs.lstat(filePath)
      if (!stat.isFile()) continue
      files.push({ path: filePath, mtimeMs: stat.mtimeMs })
    } catch {
      // Ignore entries that disappeared between readdir and stat.
    }
  }

  return files
}
