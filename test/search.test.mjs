/**
 * 宿主侧检索核心的单测：文件名 / 内容 / 文件预览 / 路径围栏 / 选项语义。
 * 全部在仓库内临时目录跑，结束后清理。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  ApiError,
  readForView,
  searchContent,
  searchNames,
} from '../lib/search.js'

let base = ''
let root = ''

/** 写入一个测试文件（自动建目录）。 */
async function write(rel, content) {
  const abs = join(root, rel)
  await mkdir(resolve(abs, '..'), { recursive: true })
  await writeFile(abs, content, 'utf8')
}

before(async () => {
  base = await mkdtemp(join(process.cwd(), 'test', 'tmp-'))
  root = join(base, 'fixture')
  await mkdir(root, { recursive: true })
  await write('src/alpha.js', [
    'const needle = 1',
    'const NEEDLE = 2',
    'const needleNeedle = 3',
    'function concatenate() {}',
    '',
  ].join('\n'))
  await write('src/beta.md', '# Beta\n\ncontains needle here\n')
  await write('docs/readme.md', 'no match at all\n')
  await write('node_modules/pkg/hidden.js', 'needle inside node_modules\n')
  await write('binary.dat', Buffer.from([0x00, 0x01, 0x02, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]))
  await writeFile(join(base, 'secret.txt'), 'needle outside the workspace\n', 'utf8')
})

after(async () => {
  await rm(base, { recursive: true, force: true })
})

test('文件名检索：大小写不敏感、跳过 node_modules', async () => {
  const result = await searchNames(root, 'ALPHA')
  assert.equal(result.mode, 'name')
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].path, 'src/alpha.js')
  assert.equal(result.files[0].name, 'alpha.js')
  assert.equal(result.files[0].dir, 'src')
  assert.equal(result.stats.truncated, false)

  const hidden = await searchNames(root, 'hidden')
  assert.equal(hidden.files.length, 0, 'node_modules 应被忽略')
})

test('内容检索：逐行命中、行列号与行文本', async () => {
  const result = await searchContent(root, 'needle')
  assert.equal(result.mode, 'content')
  const alpha = result.matches.filter((m) => m.path === 'src/alpha.js')
  assert.equal(alpha.length, 4, '三行共 4 处命中')
  const first = alpha[0]
  assert.equal(first.line, 1)
  assert.equal(first.column, 7)
  assert.equal(first.lineText, 'const needle = 1')
  assert.deepEqual([first.start, first.end], [6, 12])
  const beta = result.matches.filter((m) => m.path === 'src/beta.md')
  assert.equal(beta.length, 1)
  assert.equal(beta[0].line, 3)
  assert.equal(result.matches.some((m) => m.path === 'node_modules/pkg/hidden.js'), false)
  assert.equal(result.matches.some((m) => m.path === 'binary.dat'), false, '含 NUL 的文件应跳过')
})

test('内容检索：区分大小写与正则', async () => {
  const sensitive = await searchContent(root, 'NEEDLE', { caseSensitive: true })
  assert.equal(sensitive.matches.length, 1, '只有第 2 行写的是大写 NEEDLE')
  assert.equal(sensitive.matches[0].line, 2)

  const regex = await searchContent(root, 'N[E]+DLE', { caseSensitive: true, regex: true })
  assert.equal(regex.matches.length, 1)
  assert.equal(regex.matches[0].line, 2)

  await assert.rejects(() => searchContent(root, '(', { regex: true }), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 400)
    return true
  })
})

test('内容检索：全词匹配不吞 concatenate', async () => {
  const plain = await searchContent(root, 'cat')
  const alphaPlain = plain.matches.filter((m) => m.path === 'src/alpha.js')
  assert.equal(alphaPlain.length, 1, '"cat" 命中的是 concatenate 里的 cat')
  assert.equal(alphaPlain[0].line, 4)

  const whole = await searchContent(root, 'cat', { wholeWord: true })
  assert.equal(whole.matches.filter((m) => m.path === 'src/alpha.js').length, 0)
})

test('内容检索：命中上限触发截断', async () => {
  const result = await searchContent(root, 'needle', {}, { maxMatches: 2 })
  assert.equal(result.matches.length, 2)
  assert.equal(result.stats.truncated, true)
})

test('文件预览：返回内容与逐行命中区间', async () => {
  const view = await readForView(root, 'src/alpha.js', 'needle')
  assert.equal(view.path, 'src/alpha.js')
  assert.equal(view.binary, false)
  assert.equal(view.truncated, false)
  assert.equal(view.lineCount, 5)
  assert.deepEqual(view.matches[0], { line: 1, ranges: [[6, 12]] })
  assert.equal(view.matchCount, 4)

  const plain = await readForView(root, 'src/alpha.js', '')
  assert.equal(plain.matches.length, 0)
  assert.equal(plain.matchCount, 0)
  assert.ok(plain.content.includes('function concatenate'))
})

test('文件预览：绝对路径可用、越界路径被拒', async () => {
  const view = await readForView(root, join(root, 'src/alpha.js'), '')
  assert.equal(view.path, 'src/alpha.js')

  await assert.rejects(() => readForView(root, '../secret.txt', ''), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 400)
    assert.match(error.message, /超出工作区/)
    return true
  })

  await assert.rejects(() => readForView(root, 'nope.js', ''), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 404)
    return true
  })
})

test('二进制文件：预览标记为 binary', async () => {
  const view = await readForView(root, 'binary.dat', '')
  assert.equal(view.binary, true)
  assert.equal(view.content, '')
})
