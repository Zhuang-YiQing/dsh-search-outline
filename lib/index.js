/**
 * dsh-code-search — 宿主半（Node 侧）。
 *
 * 只做一件事：把 `/api/code-search/*` 这一族回环路由挂到 DSH 的 webServer 上，
 * 给浏览器半（lib/client.js 注册的右栏「搜索」Tab）提供：
 *
 *   GET  /api/code-search/ping    存活探测（安装后可用它确认插件已挂载）
 *   POST /api/code-search/search  { sessionId, mode, query, caseSensitive, regex, wholeWord }
 *                                 mode = 'name' | 'content'
 *   POST /api/code-search/read    { sessionId, path, query, caseSensitive, regex, wholeWord }
 *
 * 工作区根一律由宿主按 sessionId 从 session.header.cwd 解析，**不接受客户端传目录**，
 * 于是浏览器半最多只能读到当前会话工作区里的东西。
 */

import { stat } from 'node:fs/promises'
import { ApiError, DEFAULT_LIMITS, readForView, searchContent, searchNames } from './search.js'

/** cordis 插件名（与 cordis.patch.yml 里的 insert id 对应）。 */
export const name = 'code-outline'

/** 依赖的宿主服务：HTTP 路由 + 会话（用来把 sessionId 解析成工作区）。 */
export const inject = ['webServer', 'sessions']

/** 本插件的 API 根路径。 */
const API_ROOT = '/api/code-search'

/** JSON 请求体上限（字节）。 */
const MAX_BODY_BYTES = 256 * 1024

/**
 * 挂载路由。
 * @param {object} ctx - 宿主插件上下文（含 webServer / sessions）。
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_ROOT,
    handler: (req, res) => handleRequest(ctx, req, res),
  }), 'dsh-code-search: /api/code-search routes')
}

/**
 * 路由总入口：围栏（回环）→ 方法 → 分发 → 统一错误映射。
 * @param {object} ctx - 宿主插件上下文。
 * @param {import('node:http').IncomingMessage} req - HTTP 请求。
 * @param {import('node:http').ServerResponse} res - HTTP 响应。
 */
async function handleRequest(ctx, req, res) {
  if (!isLoopback(req)) {
    sendJson(res, 403, { error: 'forbidden: loopback-only' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    if (url.pathname === API_ROOT + '/ping') {
      if (req.method !== 'GET') throw new ApiError(405, 'method not allowed')
      sendJson(res, 200, { ok: true, plugin: 'dsh-code-outline', version: '0.1.0' })
      return
    }
    if (url.pathname === API_ROOT + '/search') {
      if (req.method !== 'POST') throw new ApiError(405, 'method not allowed')
      const body = await readJsonBody(req)
      const root = await workspaceOf(ctx, body)
      const mode = body.mode === 'name' ? 'name' : 'content'
      const query = typeof body.query === 'string' ? body.query : ''
      const options = {
        caseSensitive: body.caseSensitive === true,
        regex: body.regex === true,
        wholeWord: body.wholeWord === true,
      }
      const result = mode === 'name'
        ? await searchNames(root, query, pickLimits(body.limits))
        : await searchContent(root, query, options, pickLimits(body.limits))
      sendJson(res, 200, { ...result, cwd: root })
      return
    }
    if (url.pathname === API_ROOT + '/read') {
      if (req.method !== 'POST') throw new ApiError(405, 'method not allowed')
      const body = await readJsonBody(req)
      const root = await workspaceOf(ctx, body)
      const target = typeof body.path === 'string' ? body.path : ''
      const query = typeof body.query === 'string' ? body.query : ''
      const options = {
        caseSensitive: body.caseSensitive === true,
        regex: body.regex === true,
        wholeWord: body.wholeWord === true,
      }
      const result = await readForView(root, target, query, options, pickLimits(body.limits))
      sendJson(res, 200, { ...result, cwd: root })
      return
    }
    throw new ApiError(404, 'unknown route: ' + url.pathname)
  } catch (error) {
    if (error instanceof ApiError) {
      sendJson(res, error.status, { error: error.message })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res, 500, { error: '搜索失败：' + message })
  }
}

/**
 * 把请求里的 sessionId 解析成会话工作区绝对路径。
 * 会话头还没挂上时（页面刚打开、客户端先发了请求）回 409，让浏览器半稍后重试，
 * 绝不用宿主进程 cwd 冒充工作区。
 * @param {object} ctx - 宿主插件上下文。
 * @param {Record<string, unknown>} body - 已解析的请求体。
 * @returns {Promise<string>} 工作区绝对路径。
 */
async function workspaceOf(ctx, body) {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (sessionId === '') throw new ApiError(400, '缺少 sessionId')
  const record = ctx.sessions?.get?.(sessionId)
  const cwd = record?.header?.cwd
  if (typeof cwd !== 'string' || cwd === '') {
    throw new ApiError(409, '会话工作区尚未就绪，请稍后重试')
  }
  const info = await stat(cwd).catch(() => null)
  if (info === null || !info.isDirectory()) throw new ApiError(404, '工作区目录不存在：' + cwd)
  return cwd
}

/**
 * 允许调用方在小范围内收紧预算（只能更小，不能更大）。
 * @param {unknown} raw - 请求里的 limits 字段。
 * @returns {object} 合法的预算覆盖。
 */
function pickLimits(raw) {
  if (typeof raw !== 'object' || raw === null) return {}
  const out = {}
  const keys = ['maxMatches', 'maxFiles', 'maxFileBytes', 'timeBudgetMs']
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      out[key] = Math.min(value, DEFAULT_LIMITS[key])
    }
  }
  return out
}

/**
 * 判定请求是否来自回环地址。
 * @param {import('node:http').IncomingMessage} req - HTTP 请求。
 * @returns {boolean} 是否回环。
 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 读取并解析 JSON 请求体（带大小上限）。
 * @param {import('node:http').IncomingMessage} req - HTTP 请求。
 * @returns {Promise<Record<string, unknown>>} 解析后的对象。
 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new ApiError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    return parsed
  } catch {
    throw new ApiError(400, '请求体不是合法 JSON')
  }
}

/**
 * 输出 JSON 响应。
 * @param {import('node:http').ServerResponse} res - HTTP 响应。
 * @param {number} status - 状态码。
 * @param {unknown} payload - 响应体。
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}



