/**
 * dsh-search-outline — 宿主侧检索核心（纯 Node，无第三方依赖）。
 *
 * 提供三件事：
 *  - searchNames：在工作区里按**文件名**递归检索（大小写不敏感的子串匹配）。
 *  - searchContent：在工作区里按**文件内容**检索（字面量 / 正则、区分大小写、全词），
 *    返回可直接渲染的「文件 + 行号 + 列号 + 行文本 + 命中区间」。
 *  - readForView：读一个文件（限制在工作区内），并把同一个匹配器跑一遍，
 *    产出「行号 → 命中区间」，供侧边栏做高亮与上一处/下一处跳转。
 *
 * 设计约束：
 *  - 全部搜索结果都有硬上限（条目数 / 文件数 / 命中数 / 单文件大小 / 时间预算），
 *    超限时置 truncated=true，绝不让一次搜索把进程拖死。
 *  - 路径一律经 realpath 归一后校验必须落在工作区内，防止 `..` 或软链接逃逸。
 */

import { open, opendir, realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 带 HTTP 状态码的接口错误。 */
export class ApiError extends Error {
  /**
   * @param {number} status - 建议回给浏览器的 HTTP 状态码。
   * @param {string} message - 给用户看的中文错误信息。
   */
  constructor(status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** 一次检索的预算上限。 */
export const DEFAULT_LIMITS = {
  /** 遍历到的目录项上限（文件 + 目录）。 */
  maxEntries: 120000,
  /** 实际打开读取的文件数上限。 */
  maxFiles: 4000,
  /** 单文件读取上限（字节）；更大的文件直接跳过并计入 skippedLarge。 */
  maxFileBytes: 1024 * 1024,
  /** 命中行上限（内容检索）。 */
  maxMatches: 1000,
  /** 单个文件的命中行上限。 */
  maxFileMatches: 100,
  /** 结果里每行文本的展示窗口（字符）。 */
  maxLineChars: 320,
  /** 整次检索的时间预算（毫秒）。 */
  timeBudgetMs: 8000,
  /** 单个文件预览读取上限（字节）。 */
  maxViewBytes: 2 * 1024 * 1024,
  /** 单文件预览里统计的命中上限（文件内查找用的区间）。 */
  maxViewMatches: 20000,
}

/** 这些目录名在任何层级都跳过（依赖 / 产物 / 版本库内部）。 */
const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components',
  'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.idea', '.vs', '.pnpm-store', '.yarn', '.gradle', '.m2',
])

/** 明显是二进制、无需读内容的扩展名。 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif', '.tif', '.tiff',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war', '.ear',
  '.class', '.so', '.dylib', '.dll', '.exe', '.pdb', '.wasm', '.o', '.a', '.lib',
  '.mp3', '.mp4', '.m4a', '.wav', '.ogg', '.flac', '.avi', '.mov', '.mkv', '.webm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.psd', '.ai', '.sketch', '.fig',
  '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.sqlite', '.db', '.bin',
  '.lockb', '.onnx', '.pt', '.pth', '.npy', '.npz', '.parquet', '.arrow',
])

/** 判定“词字符”：ASCII 字母 / 数字 / 下划线。中文按空界处理（中文本无空格分词）。 */
const WORD_CHAR = /[A-Za-z0-9_]/

/**
 * 把一个查询词编译成可复用的匹配器。正则对象带 `g` 标志、按行复位 lastIndex，
 * 因此同一个 matcher 可以安全地逐行复用。
 * @param {string} query - 用户输入的搜索词（非空）。
 * @param {{caseSensitive?: boolean, regex?: boolean, wholeWord?: boolean}} options - 匹配选项。
 * @returns {{regex: RegExp, ranges: (line: string, limit?: number) => Array<[number, number]>}}
 */
export function buildMatcher(query, options = {}) {
  if (typeof query !== 'string' || query.trim() === '') throw new ApiError(400, '请输入搜索内容')
  if (query.length > 500) throw new ApiError(400, '搜索词过长（最多 500 字符）')
  const caseSensitive = options.caseSensitive === true
  const useRegex = options.regex === true
  const wholeWord = options.wholeWord === true
  const source = useRegex ? query : escapeRegExp(query)
  let regex
  try {
    regex = new RegExp(source, caseSensitive ? 'g' : 'gi')
  } catch (error) {
    throw new ApiError(400, '正则表达式无效：' + (error instanceof Error ? error.message : String(error)))
  }
  const rangesOf = (line, limit = 200) => {
    const out = []
    if (line.length === 0) return out
    regex.lastIndex = 0
    let match
    while (out.length < limit) {
      match = regex.exec(line)
      if (match === null) break
      const start = match.index
      const end = start + match[0].length
      if (match[0].length === 0) {
        // 零宽匹配（^ / \b 等）：推进一位再试，避免死循环。
        regex.lastIndex = start + 1
        if (regex.lastIndex > line.length) break
        continue
      }
      if (!wholeWord || isWholeWord(line, start, end)) out.push([start, end])
    }
    return out
  }
  return { regex, ranges: rangesOf }
}

/**
 * 全词判定：命中区间的左右两侧都不能紧贴 ASCII 词字符。
 * @param {string} line - 整行文本。
 * @param {number} start - 命中起始下标。
 * @param {number} end - 命中结束下标（不含）。
 * @returns {boolean} 是否构成“全词”。
 */
function isWholeWord(line, start, end) {
  const before = start > 0 ? line[start - 1] : ''
  const after = end < line.length ? line[end] : ''
  if (before !== '' && WORD_CHAR.test(before)) return false
  if (after !== '' && WORD_CHAR.test(after)) return false
  return true
}

/**
 * 转义正则元字符，把用户的普通搜索词变成字面量正则。
 * @param {string} text - 原始文本。
 * @returns {string} 可安全嵌进 RegExp 的文本。
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 以工作区根为起点、先浅后深地枚举目录。
 * 生成器会把每个条目连同它相对根的路径一起给出；目录项不递归，交给调用方决定。
 * @param {string} root - 已 realpath 的工作区根。
 * @param {{maxEntries: number, timeBudgetMs: number}} limits - 预算。
 * @returns {AsyncGenerator<{entry: import('node:fs').Dirent, rel: string, abs: string, truncated: boolean}>}
 */
async function* walk(root, limits) {
  const started = Date.now()
  const queue = [{ dir: root, rel: '' }]
  let visited = 0
  while (queue.length > 0) {
    if (Date.now() - started > limits.timeBudgetMs) {
      yield { entry: null, rel: '', abs: '', truncated: true }
      return
    }
    const current = queue.shift()
    let handle
    try {
      handle = await opendir(current.dir)
    } catch {
      continue
    }
    for await (const entry of handle) {
      visited += 1
      if (visited > limits.maxEntries) {
        yield { entry: null, rel: '', abs: '', truncated: true }
        return
      }
      const rel = current.rel === '' ? entry.name : current.rel + '/' + entry.name
      const abs = join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) queue.push({ dir: abs, rel })
        continue
      }
      if (!entry.isFile()) continue
      yield { entry, rel, abs, truncated: false }
    }
  }
}

/**
 * 按文件名检索。
 * @param {string} root - 工作区绝对路径。
 * @param {string} query - 文件名子串（大小写不敏感）。
 * @param {Partial<typeof DEFAULT_LIMITS>} [overrides] - 预算覆盖。
 * @returns {Promise<{mode: 'name', query: string, files: Array<{path: string, name: string, dir: string}>, stats: object}>}
 */
export async function searchNames(root, query, overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  const trimmed = typeof query === 'string' ? query.trim() : ''
  if (trimmed === '') throw new ApiError(400, '请输入文件名关键字')
  const started = Date.now()
  const needle = trimmed.toLowerCase()
  const files = []
  let truncated = false
  let entries = 0
  for await (const item of walk(root, limits)) {
    if (item.truncated) {
      truncated = true
      break
    }
    entries += 1
    const name = item.entry.name
    if (!name.toLowerCase().includes(needle)) continue
    const slash = item.rel.lastIndexOf('/')
    files.push({
      path: item.rel,
      name,
      dir: slash === -1 ? '' : item.rel.slice(0, slash),
    })
    if (files.length >= limits.maxMatches) {
      truncated = true
      break
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return {
    mode: 'name',
    query: trimmed,
    files,
    stats: {
      entriesVisited: entries,
      matchedFiles: files.length,
      truncated,
      elapsedMs: Date.now() - started,
    },
  }
}

/**
 * 按文件内容检索。
 * @param {string} root - 工作区绝对路径。
 * @param {string} query - 搜索词（字面量或正则，取决于 options.regex）。
 * @param {{caseSensitive?: boolean, regex?: boolean, wholeWord?: boolean, maxMatches?: number}} [options] - 匹配选项。
 * @param {Partial<typeof DEFAULT_LIMITS>} [overrides] - 预算覆盖。
 * @returns {Promise<{mode: 'content', query: string, matches: Array<object>, stats: object}>}
 */
export async function searchContent(root, query, options = {}, overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  const maxMatches = Math.max(1, Math.min(Number(options.maxMatches) || limits.maxMatches, limits.maxMatches))
  const matcher = buildMatcher(query, options)
  const started = Date.now()
  const matches = []
  const perFile = new Map()
  let truncated = false
  let entries = 0
  let filesScanned = 0
  let skippedLarge = 0
  let matchedFiles = 0

  for await (const item of walk(root, limits)) {
    if (item.truncated) {
      truncated = true
      break
    }
    entries += 1
    if (Date.now() - started > limits.timeBudgetMs) {
      truncated = true
      break
    }
    if (filesScanned >= limits.maxFiles) {
      truncated = true
      break
    }
    const ext = extname(item.entry.name).toLowerCase()
    if (BINARY_EXTENSIONS.has(ext)) continue

    let read
    try {
      read = await readCapped(item.abs, limits.maxFileBytes)
    } catch {
      continue
    }
    if (read === null) {
      skippedLarge += 1
      continue
    }
    filesScanned += 1
    if (read.binary) continue

    let fileHits = perFile.get(item.rel)
    const lines = read.text.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index]
      if (line.length === 0) continue
      const ranges = matcher.ranges(line)
      if (ranges.length === 0) continue
      if (fileHits === undefined) {
        fileHits = 0
        perFile.set(item.rel, 0)
        matchedFiles += 1
      }
      for (const [start, end] of ranges) {
        if (fileHits >= limits.maxFileMatches) {
          truncated = true
          break
        }
        if (matches.length >= maxMatches) {
          truncated = true
          break
        }
        const view = windowFor(line, start, end, limits.maxLineChars)
        matches.push({
          path: item.rel,
          line: index + 1,
          column: start + 1,
          lineText: view.text,
          start: view.start,
          end: view.end,
          clippedLeft: view.clippedLeft,
          clippedRight: view.clippedRight,
        })
        fileHits += 1
      }
      perFile.set(item.rel, fileHits)
      if (matches.length >= maxMatches) {
        truncated = true
        break
      }
    }
    if (matches.length >= maxMatches) break
  }

  matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.start - b.start)
  return {
    mode: 'content',
    query: String(query),
    matches,
    stats: {
      entriesVisited: entries,
      filesScanned,
      skippedLarge,
      matchedFiles,
      matchedLines: matches.length,
      truncated,
      elapsedMs: Date.now() - started,
    },
  }
}

/**
 * 读取一个文件用于侧边栏预览，并把同一个匹配器跑一遍，产出逐行命中区间。
 * @param {string} root - 工作区绝对路径。
 * @param {string} target - 文件路径（相对工作区或绝对路径）。
 * @param {string} [query] - 搜索词；为空时只读文件不产生命中。
 * @param {{caseSensitive?: boolean, regex?: boolean, wholeWord?: boolean}} [options] - 匹配选项。
 * @param {Partial<typeof DEFAULT_LIMITS>} [overrides] - 预算覆盖。
 * @returns {Promise<object>} 预览数据（content / matches / truncated / binary / size / 命中总数）。
 */
export async function readForView(root, target, query, options = {}, overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  const abs = await resolveInsideRoot(root, target)
  const handle = await open(abs, 'r')
  try {
    const info = await handle.stat()
    if (info.isDirectory()) throw new ApiError(400, '这是一个目录：' + target)
    const cap = limits.maxViewBytes
    const length = Math.min(info.size, cap)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    const slice = buffer.subarray(0, bytesRead)
    const binary = slice.includes(0)
    let content = ''
    if (!binary) {
      content = slice.toString('utf8')
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
    }
    const matches = []
    let matchCount = 0
    if (!binary && typeof query === 'string' && query.trim() !== '') {
      const matcher = buildMatcher(query, options)
      const lines = content.split('\n')
      for (let index = 0; index < lines.length; index++) {
        if (matchCount >= limits.maxViewMatches) break
        const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index]
        if (line.length === 0) continue
        const ranges = matcher.ranges(line)
        if (ranges.length === 0) continue
        matches.push({ line: index + 1, ranges })
        matchCount += ranges.length
      }
    }
    const rootReal = await realpath(root)
    return {
      path: toPosix(relative(rootReal, abs)),
      content,
      binary,
      size: info.size,
      truncated: info.size > cap,
      lineCount: binary ? 0 : content.split('\n').length,
      matches,
      matchCount,
      maxViewMatchesHit: matchCount >= limits.maxViewMatches,
    }
  } finally {
    await handle.close()
  }
}

/**
 * 把工作区内的相对/绝对路径解析成真实绝对路径，并保证它没有跑出工作区。
 * @param {string} root - 工作区绝对路径。
 * @param {string} target - 相对工作区或绝对路径。
 * @returns {Promise<string>} realpath 后的绝对路径。
 */
export async function resolveInsideRoot(root, target) {
  if (typeof target !== 'string' || target.trim() === '') throw new ApiError(400, '缺少文件路径')
  const rootReal = await realpath(root)
  const candidate = isAbsolute(target) ? target : resolve(rootReal, target)
  let real
  try {
    real = await realpath(candidate)
  } catch {
    throw new ApiError(404, '文件不存在：' + target)
  }
  if (!isInside(real, rootReal)) throw new ApiError(400, '路径超出工作区：' + target)
  return real
}

/**
 * 判断 path 是否落在 root 之内（Windows 下大小写不敏感）。
 * @param {string} path - 候选绝对路径。
 * @param {string} root - 根绝对路径。
 * @returns {boolean} 是否在根之内（含根本身）。
 */
function isInside(path, root) {
  const norm = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const a = norm(path)
  const b = norm(root)
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/**
 * 读取文件的前 N 字节并做二进制探测。
 * @param {string} abs - 文件绝对路径。
 * @param {number} cap - 最多读取的字节数。
 * @returns {Promise<{text: string, binary: boolean, size: number} | null>} 超过 cap 时返回 null。
 */
async function readCapped(abs, cap) {
  const handle = await open(abs, 'r')
  try {
    const info = await handle.stat()
    if (info.size > cap) return null
    const buffer = Buffer.alloc(info.size)
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0)
    const slice = buffer.subarray(0, bytesRead)
    const prefix = slice.subarray(0, 4096)
    const binary = prefix.includes(0)
    let text = ''
    if (!binary) {
      text = slice.toString('utf8')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    }
    return { text, binary, size: info.size }
  } finally {
    await handle.close()
  }
}

/**
 * 为命中位置截取一段展示窗口（长行只显示命中附近）。
 * @param {string} line - 整行文本。
 * @param {number} start - 命中起点。
 * @param {number} end - 命中终点（不含）。
 * @param {number} maxChars - 窗口最大字符数。
 * @returns {{text: string, start: number, end: number, clippedLeft: boolean, clippedRight: boolean}}
 */
function windowFor(line, start, end, maxChars) {
  if (line.length <= maxChars) return { text: line, start, end, clippedLeft: false, clippedRight: false }
  const pad = Math.max(16, Math.floor(maxChars / 3))
  let from = Math.max(0, start - pad)
  const span = Math.max(maxChars, end - start)
  let to = Math.min(line.length, from + span)
  if (to - from < span) from = Math.max(0, to - span)
  return {
    text: line.slice(from, to),
    start: start - from,
    end: end - from,
    clippedLeft: from > 0,
    clippedRight: to < line.length,
  }
}

/**
 * 把路径统一成 `/` 分隔（Windows 下结果与界面显示都更整齐）。
 * @param {string} value - 任意路径。
 * @returns {string} POSIX 风格路径。
 */
function toPosix(value) {
  return value.split(sep).join('/')
}
