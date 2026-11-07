#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const root = path.resolve(process.argv[2] || 'artifacts')

function walk(dir) {
  if (!fs.existsSync(dir)) return []

  const entries = []
  for (const name of fs.readdirSync(dir)) {
    const absolutePath = path.join(dir, name)
    const stat = fs.statSync(absolutePath)
    if (stat.isDirectory()) {
      entries.push(...walk(absolutePath))
    } else if (stat.isFile()) {
      entries.push(absolutePath)
    }
  }
  return entries
}

function normalizeAssetName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function unquote(value) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function quoteLike(original, value) {
  const trimmed = original.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.stringify(value)
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return `'${value.replace(/'/g, "''")}'`
  return value
}

function resolveAssetName(expectedName, assetNames) {
  if (assetNames.includes(expectedName)) return expectedName

  const normalized = normalizeAssetName(expectedName)
  const candidates = assetNames.filter((name) => normalizeAssetName(name) === normalized)

  if (candidates.length === 1) {
    return candidates[0]
  }

  if (candidates.length > 1) {
    throw new Error(
      `更新元数据引用 ${expectedName}，但匹配到多个可能文件：${candidates.join(', ')}`
    )
  }

  throw new Error(`更新元数据引用 ${expectedName}，但构建产物中找不到对应文件`)
}

function replaceAssetReferences(content, assetNames, metadataPath) {
  let changed = false

  const next = content.replace(/^(\s*(?:-\s*)?(?:url|path):\s*)(.+?)\s*$/gm, (line, prefix, rawValue) => {
    const value = unquote(rawValue)
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return line

    const expectedName = path.posix.basename(value)
    const resolvedName = resolveAssetName(expectedName, assetNames)
    if (resolvedName === expectedName) return line

    changed = true
    const resolvedValue = value.slice(0, value.length - expectedName.length) + resolvedName
    console.log(
      `${path.relative(process.cwd(), metadataPath)}: ${expectedName} -> ${resolvedName}`
    )
    return `${prefix}${quoteLike(rawValue, resolvedValue)}`
  })

  return { content: next, changed }
}

const files = walk(root)
const assetNames = files.map((file) => path.basename(file))
const metadataFiles = files.filter((file) => /^latest.*\.ya?ml$/i.test(path.basename(file)))

if (metadataFiles.length === 0) {
  throw new Error(`未找到 latest.yml/latest-mac.yml：${root}`)
}

for (const metadataPath of metadataFiles) {
  const original = fs.readFileSync(metadataPath, 'utf-8')
  const result = replaceAssetReferences(original, assetNames, metadataPath)

  if (result.changed) {
    fs.writeFileSync(metadataPath, result.content, 'utf-8')
  }

  replaceAssetReferences(result.content, assetNames, metadataPath)
}

console.log(`已校验 ${metadataFiles.length} 个更新元数据文件`)
