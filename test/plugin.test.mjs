/**
 * 路由接线测试：用假的 ctx / req / res 跑一遍 lib/index.js 的 apply()，
 * 验证 /api/code-search/* 的围栏、分发与错误映射（不需要真的启动 DSH）。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { apply } from '../lib/index.js'

let base = ''
let root = ''
let route = null
let sessionCwd = ''

/** 记录 apply() 注册的路由。 */
const ctx = {
  webServer: {
    register(spec) {
      route = spec
      return () => { route = null }
    },
  },
  sessions: {
    get(sessionId) {
      return sessionId === 'sess-1' && sessionCwd !== '' ? { header: { cwd: sessionCwd } } : undefined
    },
  },
  effect(fn) {
    return fn()
  },
}

/** 造一个异步可迭代的假请求。 */
function makeReq({ method = 'POST', url, body, raw, remote = '127.0.0.1' } = {}) {
  const payload = raw !== undefined
    ? Buffer.from(raw, 'utf8')
    : body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8')
  return {
    method,
    url,
    socket: { remoteAddress: remote },
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) yield payload
    },
  }
}

/** 造一个记录响应的假响应。 */
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(value) { this.body = value ?? '' },
  }
}

/** 跑一次请求并解析 JSON 响应。 */
async function call(options) {
  const res = makeRes()
  await route.handler(makeReq(options), res)
  return { status: res.statusCode, data: JSON.parse(res.body), headers: res.headers }
}

before(async () => {
  base = await mkdtemp(join(process.cwd(), 'test', 'tmp-route-'))
  root = join(base, 'workspace')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'util.js'), 'export const needle = 1\n', 'utf8')
  await writeFile(join(root, 'README.md'), '# demo\nneedle appears here\n', 'utf8')
  sessionCwd = root
  apply(ctx)
})

after(async () => {
  await rm(base, { recursive: true, force: true })
})

test('apply 注册了 /api/code-search 前缀路由', () => {
  assert.ok(route !== null)
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/api/code-search')
})

test('GET /ping 返回存活信息', async () => {
  const result = await call({ method: 'GET', url: '/api/code-search/ping' })
  assert.equal(result.status, 200)
  assert.equal(result.data.ok, true)
  assert.equal(result.data.plugin, 'dsh-code-outline')
})

test('POST /search 文件名模式', async () => {
  const result = await call({
    url: '/api/code-search/search',
    body: { sessionId: 'sess-1', mode: 'name', query: 'UTIL' },
  })
  assert.equal(result.status, 200)
  assert.equal(result.data.mode, 'name')
  assert.deepEqual(result.data.files.map((f) => f.path), ['src/util.js'])
  assert.equal(result.data.cwd, root)
  assert.equal(result.headers['content-type'], 'application/json; charset=utf-8')
})

test('POST /search 内容模式', async () => {
  const result = await call({
    url: '/api/code-search/search',
    body: { sessionId: 'sess-1', mode: 'content', query: 'needle', caseSensitive: true },
  })
  assert.equal(result.status, 200)
  assert.equal(result.data.mode, 'content')
  assert.equal(result.data.matches.length, 2)
  assert.deepEqual(result.data.matches.map((m) => m.path), ['README.md', 'src/util.js'])
})

test('POST /read 返回文件内容与命中区间', async () => {
  const result = await call({
    url: '/api/code-search/read',
    body: { sessionId: 'sess-1', path: 'src/util.js', query: 'needle' },
  })
  assert.equal(result.status, 200)
  assert.equal(result.data.path, 'src/util.js')
  assert.ok(result.data.content.includes('needle'))
  assert.deepEqual(result.data.matches, [{ line: 1, ranges: [[13, 19]] }])
})

test('围栏：非回环请求 403、未知路由 404、非法 JSON 400', async () => {
  const forbidden = await call({ method: 'GET', url: '/api/code-search/ping', remote: '192.168.1.20' })
  assert.equal(forbidden.status, 403)

  const missing = await call({ method: 'GET', url: '/api/code-search/nope' })
  assert.equal(missing.status, 404)

  const res = makeRes()
  await route.handler(makeReq({
    url: '/api/code-search/search',
    raw: '{not json',
  }), res)
  assert.equal(res.statusCode, 400)
  assert.match(JSON.parse(res.body).error, /JSON/)
})

test('会话工作区：未知 sessionId 回 409，缺 sessionId 回 400', async () => {
  const notReady = await call({
    url: '/api/code-search/search',
    body: { sessionId: 'unknown', mode: 'content', query: 'needle' },
  })
  assert.equal(notReady.status, 409)

  const missing = await call({
    url: '/api/code-search/search',
    body: { mode: 'content', query: 'needle' },
  })
  assert.equal(missing.status, 400)
})

test('路径围栏：跨出工作区的读取被拒', async () => {
  await writeFile(join(base, 'outside.txt'), 'secret\n', 'utf8')
  const result = await call({
    url: '/api/code-search/read',
    body: { sessionId: 'sess-1', path: '../outside.txt', query: '' },
  })
  assert.equal(result.status, 400)
  assert.match(result.data.error, /超出工作区/)
})



