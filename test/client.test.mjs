/**
 * 客户端 bundle 的单测：用假的 window.__ModuleLoader__ 捕获工厂，
 * 再用假的 require 提供 react，从而在不碰 DOM 的前提下验证
 * 预览器注册、查找与符号解析、以及 FileView 的初始渲染。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => { captured = definition },
  },
}

/**
 * 迷你 hooks 桩：按调用顺序存状态。setter 写入后**重新调用组件**就能拿到新渲染，
 * 因此可以在无 DOM 的前提下验证「点查找 → 换成高亮视图」这类状态流转。
 */
let slots = []
let cursor = 0
function resetHooks() {
  slots = []
  cursor = 0
}

/** 每次渲染都把 hook 槽位重新从 0 数一遍（React 的语义）；setter 改过状态后重新渲染即可看到新界面。 */
function renderView(component, props) {
  cursor = 0
  return component(props)
}

const fakeReact = {
  createElement: (...args) => ({ args }),
  useState: (initial) => {
    const i = cursor++
    if (i >= slots.length) slots.push({ value: typeof initial === 'function' ? initial() : initial })
    return [slots[i].value, (next) => {
      slots[i].value = typeof next === 'function' ? next(slots[i].value) : next
    }]
  },
  useRef: (initial) => {
    const i = cursor++
    if (i >= slots.length) slots.push({ value: { current: initial } })
    return slots[i].value
  },
  useCallback: (fn) => {
    const i = cursor++
    if (i >= slots.length) slots.push({ value: fn })
    return slots[i].value
  },
  useMemo: (fn) => fn(),
  useEffect: () => undefined,
}

await import('../lib/client.js')

const factory = captured.factory

/** 本插件只 require react（不再 require 宿主基元）。 */
const mod = factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected module: ' + name)
})
const helpers = mod.__test

/** 取假 React 元素的 props。 */
function propsOf(element) {
  return element.args[1]
}

/** 取假 React 元素的子节点（数组子节点摊平一层，和 React 的渲染语义一致）。 */
function childrenOf(element) {
  return element.args.slice(2).flat(1)
}

/** 按 className 在子节点里找第一个匹配的元素。 */
function findByClass(element, className) {
  return childrenOf(element).find((child) => child !== null && typeof child === 'object' && propsOf(child).className === className)
}

/** better-sidebar 的四个内置查看器（全部 fsRead；component 记下收到的 props）。 */
const BUILTIN_VIEWERS = [
  { id: 'markdown', exts: ['md', 'markdown'], fetchStrategy: 'fsRead', component: HostViewer },
  { id: 'html', exts: ['html', 'htm'], fetchStrategy: 'fsRead', component: HostViewer },
  { id: 'jsonl', exts: ['jsonl', 'ndjson'], fetchStrategy: 'fsRead', component: HostViewer },
  { id: 'code', exts: [], priority: -100, fetchStrategy: 'fsRead', component: HostViewer },
]

/**
 * 假 better-sidebar 服务：注册表 + 开关 + subscribe。
 * @param {Array} registered - 收集 registerFileViewer 的规格。
 * @param {{viewers?: Array, disabled?: string[], subscribed?: Array}} options - 注册表与开关。
 * @returns {object} 服务对象。
 */
function fakeService(registered, options) {
  const opts = options || {}
  const viewers = opts.viewers || BUILTIN_VIEWERS
  const disabled = opts.disabled || []
  const subscribed = opts.subscribed || []
  return {
    registerFileViewer(spec) {
      registered.push(spec)
      return () => {}
    },
    getFileViewers() {
      return viewers.slice()
    },
    isViewerEnabled(id) {
      return disabled.indexOf(id) === -1
    },
    subscribe(listener) {
      subscribed.push(listener)
      return () => {}
    },
  }
}

/** 假宿主查看器组件：把收到的 props 记下来，用来断言转发。 */
function HostViewer() {
  return null
}

/** 造一个能被 CodeSearchView 取到服务的假 ctx。 */
function fakeCtx(service) {
  return { get: () => service }
}

test('bundle 形状：name / inject / apply', () => {
  assert.equal(captured.id, 'dsh-search-outline')
  assert.equal(mod.name, 'dsh-search-outline')
  assert.deepEqual(mod.inject, [])
  assert.equal(typeof mod.apply, 'function')
})

test('apply：叠加层注册（优先级高于内置，只认领可委托的文本扩展名）', () => {
  const registered = []
  const pluginCtx = {
    effect(fn) { return fn() },
    inject(names, callback) {
      assert.deepEqual(names, ['betterSidebar'])
      return callback({ get: () => fakeService(registered) })
    },
  }
  mod.apply(pluginCtx)
  assert.equal(registered.length, 1)
  const spec = registered[0]
  assert.equal(spec.id, 'dsh-search-outline:viewer')
  assert.equal(spec.priority, 50)
  assert.equal(spec.fetchStrategy, 'fsRead')
  assert.equal(spec.title(), '大纲预览')
  assert.equal(typeof spec.component, 'function')
  // 内置 code 查看器是 catch-all，所以全部候选扩展名都能委托 → 全部认领
  assert.deepEqual(spec.exts, helpers.TEXT_EXTS)
  for (const ext of ['java', 'js', 'ts', 'py', 'md', 'txt', 'log', 'json', 'css', '']) {
    assert.ok(spec.exts.includes(ext), '应叠加 .' + ext)
  }
  // 二进制类扩展名不在候选里（图片/PDF 仍由 better-sidebar 自己的查看器处理）
  for (const ext of ['png', 'jpg', 'pdf', 'zip', 'docx']) {
    assert.ok(!spec.exts.includes(ext), '不应叠加 .' + ext)
  }
})

test('apply：内置查看器被关掉时，只有它兜底的扩展名让开', () => {
  const registered = []
  const pluginCtx = {
    effect(fn) { return fn() },
    inject(names, callback) {
      return callback({ get: () => fakeService(registered, { disabled: ['code'] }) })
    },
  }
  mod.apply(pluginCtx)
  assert.equal(registered.length, 1)
  assert.deepEqual(registered[0].exts, ['md', 'markdown', 'jsonl', 'ndjson', 'html', 'htm'])
})

test('apply：第三方（非 fsRead）查看器不会被委托，仍由内置查看器接手', () => {
  const registered = []
  const viewers = BUILTIN_VIEWERS.concat([
    { id: 'other:viewer', exts: ['md', 'markdown'], priority: 100, fetchStrategy: 'mediaUrl', component: () => null },
  ])
  const pluginCtx = {
    effect(fn) { return fn() },
    inject(names, callback) {
      return callback({ get: () => fakeService(registered, { viewers }) })
    },
  }
  mod.apply(pluginCtx)
  // 第三方查看器不是我们的委托对象（我们只喂 fsRead 的宿主内置查看器），
  // 所以 md/markdown 仍在我们的认领范围内；宿主那边第三方优先级更高，会由它胜出。
  assert.ok(registered[0].exts.includes('md'))
  assert.ok(registered[0].exts.includes('java'))
  assert.equal(helpers.pickDelegate(fakeService([], { viewers }), 'md', helpers.VIEWER_ID).id, 'markdown')
  // 只有第三方能认领、且没有内置兜底的扩展名会让开（不认领，交给那个第三方查看器）
  const imageOnly = fakeService([], { viewers: [{ id: 'img:viewer', exts: ['svg'], priority: 100, fetchStrategy: 'mediaUrl', component: () => null }] })
  assert.equal(helpers.pickDelegate(imageOnly, 'svg', helpers.VIEWER_ID), null)
  assert.deepEqual(helpers.claimableExts(imageOnly, ['svg', 'md'], helpers.VIEWER_ID), [])
})

test('apply：没有任何可委托的查看器时不注册（exts:[] 会被当成 catch-all）', () => {
  const registered = []
  const pluginCtx = {
    effect(fn) { return fn() },
    inject(names, callback) {
      return callback({ get: () => fakeService(registered, { viewers: [] }) })
    },
  }
  mod.apply(pluginCtx)
  assert.equal(registered.length, 0)
})

test('apply：注册表变化时重算认领范围，不变则不重复注册', () => {
  const registered = []
  const subscribed = []
  const disabled = []
  const service = fakeService(registered, { disabled, subscribed })
  const pluginCtx = {
    effect(fn) { return fn() },
    inject(names, callback) {
      return callback({ get: () => service })
    },
  }
  mod.apply(pluginCtx)
  assert.equal(registered.length, 1)
  assert.equal(subscribed.length, 1)
  // 用户关掉 code 内置查看器 → 重算并再注册一次
  disabled.push('code')
  subscribed[0]()
  assert.equal(registered.length, 2)
  assert.deepEqual(registered[1].exts, ['md', 'markdown', 'jsonl', 'ndjson', 'html', 'htm'])
  // 再触发一次（结果没变）不应重复注册
  subscribed[0]()
  assert.equal(registered.length, 2)
})

test('apply：better-sidebar 缺失时静默不注册、不抛错', () => {
  const pluginCtx = {
    effect(fn) { return fn() },
    inject(names, callback) {
      return callback({ get: () => undefined })
    },
  }
  assert.doesNotThrow(() => mod.apply(pluginCtx))
})

test('splitByRanges：命中区间切段', () => {
  assert.deepEqual(helpers.splitByRanges('abcdef', [[2, 4]]), [
    { text: 'ab', hit: false, start: 0, end: 2 },
    { text: 'cd', hit: true, start: 2, end: 4 },
    { text: 'ef', hit: false, start: 4, end: 6 },
  ])
  assert.deepEqual(helpers.splitByRanges('xyz', [[0, 3]]), [
    { text: 'xyz', hit: true, start: 0, end: 3 },
  ])
  assert.deepEqual(helpers.splitByRanges('', []), [])
})

test('findInContent：字面量 / 大小写 / 正则 / 每行多命中', () => {
  const content = 'alpha\nALPHA alpha\nalpha(1) and alpha\n'

  const all = helpers.findInContent(content, 'alpha', {})
  assert.equal(all.error, '')
  assert.equal(all.flat.length, 5)
  assert.deepEqual(all.flat[0], { line: 1, start: 0, end: 5 })
  assert.equal(all.byLine.get(2).length, 2)
  assert.equal(all.byLine.get(3).length, 2)

  const sensitive = helpers.findInContent(content, 'ALPHA', { caseSensitive: true })
  assert.equal(sensitive.flat.length, 1)
  assert.equal(sensitive.flat[0].line, 2)

  const regex = helpers.findInContent(content, 'alpha\\(', { regex: true })
  assert.equal(regex.flat.length, 1)
  assert.equal(regex.flat[0].line, 3)

  assert.equal(helpers.findInContent(content, '', {}).flat.length, 0)
  assert.equal(helpers.findInContent('', 'alpha', {}).flat.length, 0)

  const broken = helpers.findInContent(content, 'alpha(', { regex: true })
  assert.equal(broken.flat.length, 0)
  assert.notEqual(broken.error, '')
})

test('renderCodeLines：当前命中加深、闪烁行带标记', () => {
  const view = { content: 'line one\nconst needle = 1\nconst needleAgain = 2\n', lineCount: 4 }
  const map = new Map([[2, [[6, 12]]], [3, [[6, 12]]]])
  const rows = helpers.renderCodeLines(view, map, { line: 3, start: 6, end: 12 }, false, 2)
  assert.equal(rows.length, 4)
  assert.equal(propsOf(rows[1])['data-line'], '2')
  assert.equal(propsOf(rows[1])['data-active'], undefined)
  assert.match(propsOf(rows[1]).className, /dcs-code-line-flash/)
  assert.equal(propsOf(rows[2])['data-active'], 'true')
  assert.doesNotMatch(propsOf(rows[2]).className, /dcs-code-line-flash/)

  const code3 = childrenOf(rows[2])[1]
  const activeMark = childrenOf(code3).find((child) => typeof child === 'object')
  assert.match(propsOf(activeMark).className, /dcs-mark-active/)
  assert.equal(childrenOf(activeMark)[0], 'needle')
})

test('renderCodeLines：大文件按锚点行渲染窗口（结构跳转可达）', () => {
  const content = Array.from({ length: 3000 }, (_, i) => 'line ' + (i + 1)).join('\n')
  const rows = helpers.renderCodeLines({ content, lineCount: 3000 }, new Map(), null, false, 0, 2500)
  assert.ok(rows.length <= 800)
  assert.ok(rows.some((row) => propsOf(row)['data-line'] === '2500'))
  const first = propsOf(rows[0])['data-line']
  assert.ok(Number(first) < 2500 && Number(first) >= 2100)
})
test('languageOf：识别 java / js / python / html / markdown', () => {
  assert.equal(helpers.languageOf('a/B.java'), 'java')
  assert.equal(helpers.languageOf('a/b.tsx'), 'js')
  assert.equal(helpers.languageOf('x.PY'), 'python')
  assert.equal(helpers.languageOf('index.html'), 'html')
  assert.equal(helpers.languageOf('a.vue'), 'html')
  assert.equal(helpers.languageOf('README.md'), 'markdown')
  assert.equal(helpers.languageOf('notes.MARKDOWN'), 'markdown')
  assert.equal(helpers.languageOf(undefined), '')
})

test('markdown 大纲：ATX / setext，跳过代码围栏与 front matter', () => {
  const md = [
    '---',
    'title: 手册',
    '---',
    '',
    '# 顶部标题',
    '',
    '正文段落',
    '==========',
    '',
    '二级标题',
    '------',
    '',
    '### 三级 ###',
    '',
    '```',
    '# 围栏里的注释不是标题',
    '```',
    '',
    '- 列表项',
    '  不是标题',
    '',
    '#### `带行内代码` 的标题',
    '',
  ].join('\n')
  const symbols = helpers.extractSymbols(md, 'guide.md')
  assert.deepEqual(symbols.map((s) => s.name + ':' + s.level + ':' + s.line), [
    '顶部标题:1:5',
    '正文段落:1:7',
    '二级标题:2:10',
    '三级:3:13',
    '带行内代码 的标题:4:22',
  ])
  assert.ok(symbols.every((s) => s.kind === 'heading'))
  assert.equal(symbols[0].index, 0)
  assert.equal(symbols[4].index, 4)
  assert.equal(helpers.symbolKindBadge('heading'), 'H')
})

test('headingTitle：去掉链接 / 图片 / 行内代码 / 粗体 / 删除线', () => {
  assert.equal(helpers.headingTitle('[指南](docs/a.md) 用法'), '指南 用法')
  assert.equal(helpers.headingTitle('![徽标](badge.png) 项目'), '徽标 项目')
  assert.equal(helpers.headingTitle('**加粗** 与 `代码`'), '加粗 与 代码')
  assert.equal(helpers.headingTitle('~~旧~~ 新 ~~更旧~~'), '旧 新 更旧')
  assert.equal(helpers.headingTitle('标题 ##'), '标题')
})

test('extOf：与 better-sidebar 同构的扩展名解析', () => {
  assert.equal(helpers.extOf('a/b.MD'), 'md')
  assert.equal(helpers.extOf('a.b.jsonl'), 'jsonl')
  assert.equal(helpers.extOf('Makefile'), '')
  assert.equal(helpers.extOf('.hidden'), '')
  assert.equal(helpers.extOf(''), '')
  assert.equal(helpers.extOf(undefined), '')
})

test('pickDelegate：选中「没有本插件时宿主会用的那个内置查看器」', () => {
  const service = fakeService([])
  assert.equal(helpers.pickDelegate(service, 'md', helpers.VIEWER_ID).id, 'markdown')
  assert.equal(helpers.pickDelegate(service, 'html', helpers.VIEWER_ID).id, 'html')
  assert.equal(helpers.pickDelegate(service, 'jsonl', helpers.VIEWER_ID).id, 'jsonl')
  // 其它文本扩展名走内置 code（catch-all，priority -100）
  assert.equal(helpers.pickDelegate(service, 'java', helpers.VIEWER_ID).id, 'code')
  assert.equal(helpers.pickDelegate(service, '', helpers.VIEWER_ID).id, 'code')
  // 排除自己
  assert.equal(helpers.pickDelegate(service, 'md', helpers.VIEWER_ID) && helpers.pickDelegate(service, 'md', 'markdown').id, 'code')
})

test('pickDelegate：不委托第三方插件的查看器，也不委托非 fsRead 的查看器', () => {
  const thirdParty = fakeService([], {
    viewers: [
      { id: 'other:viewer', exts: ['md'], priority: 10, fetchStrategy: 'fsRead', component: () => null },
      { id: 'code', exts: [], priority: -100, fetchStrategy: 'fsRead', component: () => null },
    ],
  })
  assert.equal(helpers.pickDelegate(thirdParty, 'md', helpers.VIEWER_ID).id, 'code')
  const media = fakeService([], {
    viewers: [{ id: 'image', exts: ['svg'], fetchStrategy: 'mediaUrl', component: () => null }],
  })
  assert.equal(helpers.pickDelegate(media, 'svg', helpers.VIEWER_ID), null)
})

test('pickDelegate：用户在侧边卡片里关掉的内置查看器不委托', () => {
  const service = fakeService([], { disabled: ['code'] })
  assert.equal(helpers.pickDelegate(service, 'java', helpers.VIEWER_ID), null)
  assert.equal(helpers.pickDelegate(service, 'md', helpers.VIEWER_ID).id, 'markdown')
})

test('pickDelegate：服务缺失 / 注册表异常时返回 null 而不是抛错', () => {
  assert.equal(helpers.pickDelegate(null, 'md', helpers.VIEWER_ID), null)
  assert.equal(helpers.pickDelegate({ getFileViewers: () => { throw new Error('boom') } }, 'md', helpers.VIEWER_ID), null)
  assert.equal(helpers.pickDelegate({ getFileViewers: () => null }, 'md', helpers.VIEWER_ID), null)
})

test('claimableExts：只认领能委托的扩展名', () => {
  assert.deepEqual(helpers.claimableExts(fakeService([]), ['md', 'java', 'txt'], helpers.VIEWER_ID), ['md', 'java', 'txt'])
  assert.deepEqual(helpers.claimableExts(fakeService([], { disabled: ['code'] }), ['md', 'java', 'txt'], helpers.VIEWER_ID), ['md'])
  assert.deepEqual(helpers.claimableExts(null, ['js'], helpers.VIEWER_ID), [])
})

test('lineTargetInStage：行数对得上按 .cm-line 索引取，对不上退回行号栏文本', () => {
  const rows = [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]
  const gutter = [{ textContent: ' 1 ' }, { textContent: '2' }, { textContent: '3' }]
  const stage = (content, cells) => ({
    querySelector: (sel) => sel === '.cm-content'
      ? (content ? { querySelectorAll: () => content } : null)
      : (sel === '.cm-lineNumbers' ? (cells ? { querySelectorAll: () => cells } : null) : null),
  })
  assert.equal(helpers.lineTargetInStage(stage(rows, gutter), 2, 3), rows[1])
  // 源码 5 行但 DOM 只有 3 行（发生了折叠/换行）→ 不可靠，改用行号栏
  assert.equal(helpers.lineTargetInStage(stage(rows, gutter), 3, 5), gutter[2])
  assert.equal(helpers.lineTargetInStage(stage(null, null), 1, 3), null)
  assert.equal(helpers.lineTargetInStage(null, 1, 3), null)
})

test('headingTargetInStage：按文本匹配（同名用 index），失配按层级兜底', () => {
  const headings = [
    { tagName: 'H1', textContent: ' 顶部 ' },
    { tagName: 'H2', textContent: '小节' },
    { tagName: 'H2', textContent: '小节' },
  ]
  const stage = { querySelectorAll: () => headings }
  assert.equal(helpers.headingTargetInStage(stage, { name: '顶部', level: 1, index: 0 }), headings[0])
  assert.equal(helpers.headingTargetInStage(stage, { name: '小节', level: 2, index: 1 }), headings[2])
  assert.equal(helpers.headingTargetInStage(stage, { name: '不存在', level: 2, index: 0 }), headings[1])
  assert.equal(helpers.headingTargetInStage({ querySelectorAll: () => [] }, { name: 'x', level: 1, index: 0 }), null)
})

test('formatSize：字节数转可读字符串', () => {
  assert.equal(helpers.formatSize(512), '512 B')
  assert.equal(helpers.formatSize(2048), '2 KB')
  assert.equal(helpers.formatSize(1536 * 1024), '1.5 MB')
  assert.equal(helpers.formatSize(undefined), '未知大小')
  assert.equal(helpers.formatSize(0), '未知大小')
})

test('linesOfText：渲染选区文本映射回源码行（唯一才给行号）', () => {
  const md = '# 标题\n\n正文 one\n\n# 标题\n\n正文 two\n'
  assert.deepEqual(helpers.linesOfText(md, '正文 one'), { start: 3, end: 3 })
  assert.deepEqual(helpers.linesOfText(md, '正文 one\n\n# 标题'), { start: 3, end: 5 })
  assert.equal(helpers.linesOfText(md, '标题'), null)
  assert.equal(helpers.linesOfText(md, '不存在的文本'), null)
  assert.equal(helpers.linesOfText(md, ''), null)
})

test('选区载荷：预览模式没有行号时标题只带路径，正文用选区文本', () => {
  const payload = helpers.buildSelectionInsert('/w/docs/a.md', '/w', '# t\nx\n', 0, 0, '渲染出来的文字')
  assert.equal(payload.header, 'docs/a.md')
  assert.equal(payload.label, 'docs/a.md')
  assert.equal(payload.raw, '渲染出来的文字')
  assert.equal(payload.text, '```docs/a.md\n渲染出来的文字\n```')
  assert.equal(payload.truncated, false)
})

test('extractSymbols：Java 的类 / 方法 / 字段', () => {
  const src = [
    'package demo;',
    '',
    'public class OrderService {',
    '    private static final int MAX = 10;',
    '    private final UserRepo repo;',
    '',
    '    public OrderService(UserRepo repo) {',
    '        this.repo = repo;',
    '    }',
    '',
    '    public Order create(String id) {',
    '        return null;',
    '    }',
    '',
    '    private void helper() {}',
    '}',
  ].join('\n')
  const symbols = helpers.extractSymbols(src, 'OrderService.java')
  assert.deepEqual(symbols.map((s) => [s.kind, s.name, s.line]), [
    ['class', 'OrderService', 3],
    ['variable', 'MAX', 4],
    ['variable', 'repo', 5],
    ['method', 'OrderService', 7],
    ['method', 'create', 11],
    ['method', 'helper', 15],
  ])
})

test('extractSymbols：Java 注解 / 多行参数 / 泛型返回 / 只取类级字段', () => {
  const src = [
    '@RestController',
    '@RequestMapping("/so")',
    'public class MfeSoWebhookController {',
    '',
    '    private final MfeSoEventProcessor processor;',
    '    private static final Logger LOG = LoggerFactory.getLogger(MfeSoWebhookController.class);',
    '',
    '    public MfeSoWebhookController(MfeSoEventProcessor processor) {',
    '        this.processor = processor;',
    '        String local = "x";',
    '    }',
    '',
    '    @PostMapping("/so")',
    '    public ResponseEntity<Map<String, Object>> receive(',
    '            @RequestBody MfeSoWebhookRequest request,',
    '            @RequestHeader("X-Signature") String signature) throws IOException {',
    '        Map<String, Object> result = new HashMap<>();',
    '        return ResponseEntity.ok(result);',
    '    }',
    '}',
  ].join('\n')
  const symbols = helpers.extractSymbols(src, 'MfeSoWebhookController.java')
  assert.deepEqual(symbols.map((s) => [s.kind, s.name, s.line]), [
    ['class', 'MfeSoWebhookController', 3],
    ['variable', 'processor', 5],
    ['variable', 'LOG', 6],
    ['method', 'MfeSoWebhookController', 8],
    ['method', 'receive', 14],
  ])
})

test('extractSymbols：类体大括号另起一行时成员不丢（JobHistoryController 形态）', () => {
  const src = [
    '@Controller',
    '@RequestMapping("/acs/jobmanage/jobHistory")',
    'public class JobHistoryController extends BaseController',
    '{',
    '    private static final String PREFIX = "acs/jobmanage/";',
    '',
    '    @Autowired',
    '    private MfeJobService jobService;',
    '',
    '    @GetMapping("")',
    '    public String page()',
    '    {',
    '        return PREFIX + "history";',
    '    }',
    '}',
  ].join('\n')
  const symbols = helpers.extractSymbols(src, 'JobHistoryController.java')
  assert.deepEqual(symbols.map((s) => [s.kind, s.name, s.line]), [
    ['class', 'JobHistoryController', 3],
    ['variable', 'PREFIX', 5],
    ['variable', 'jobService', 8],
    ['method', 'page', 11],
  ])
})
test('extractSymbols：JS 的类 / 方法 / 函数 / 变量', () => {
  const src = [
    'export class Panel {',
    '  constructor(opts) {',
    '    this.opts = opts',
    '  }',
    '  render() {',
    '    return null',
    '  }',
    '}',
    'export function build(opts) {}',
    'const handler = (event) => {}',
    'let count = 0',
  ].join('\n')
  const symbols = helpers.extractSymbols(src, 'panel.ts')
  assert.deepEqual(symbols.map((s) => [s.kind, s.name, s.line]), [
    ['class', 'Panel', 1],
    ['method', 'constructor', 2],
    ['method', 'render', 5],
    ['method', 'build', 9],
    ['method', 'handler', 10],
    ['variable', 'count', 11],
  ])
})

test('extractSymbols：Python 的类 / 方法 / 模块变量', () => {
  const src = [
    'import os',
    '',
    'MAX = 10',
    '',
    'class Order:',
    '    total = 0',
    '',
    '    def __init__(self, id):',
    '        self.id = id',
    '',
    '    def total_price(self):',
    '        return self.total',
    '',
    'def helper():',
    '    pass',
  ].join('\n')
  const symbols = helpers.extractSymbols(src, 'order.py')
  assert.deepEqual(symbols.map((s) => [s.kind, s.name, s.line, s.container]), [
    ['variable', 'MAX', 3, ''],
    ['class', 'Order', 5, ''],
    ['method', '__init__', 8, 'Order'],
    ['method', 'total_price', 11, 'Order'],
    ['method', 'helper', 14, ''],
  ])
})

test('extractSymbols：HTML 里 &lt;script&gt; 的 JS 也能出类/方法/变量', () => {
  const src = [
    '<!DOCTYPE html>',
    '<html>',
    '<body>',
    '  <div id="app"></div>',
    '  <script>',
    '    const API = "/api";',
    '    function load(id) {',
    '      return fetch(API + id);',
    '    }',
    '    class Panel {',
    '      render() {}',
    '    }',
    '  </script>',
    '  <script>let counter = 0;</script>',
    '</body>',
    '</html>',
  ].join('\n')
  const symbols = helpers.extractSymbols(src, 'page.html')
  assert.deepEqual(symbols.map((s) => [s.kind, s.name, s.line]), [
    ['element', 'html', 2],
    ['element', 'body', 3],
    ['element', 'div#app', 4],
    ['element', 'script', 5],
    ['variable', 'API', 6],
    ['method', 'load', 7],
    ['class', 'Panel', 10],
    ['method', 'render', 11],
    ['element', 'script', 14],
    ['variable', 'counter', 14],
  ])
})
test('extractSymbols：HTML 元素大纲（结构标签 + 带 id/class 的标签）', () => {
  const src = [
    '<!DOCTYPE html>',
    '<html lang="zh">',
    '<head>',
    '  <title>Demo</title>',
    '</head>',
    '<body>',
    '  <div id="app" class="root container">',
    '    <span>plain</span>',
    '    <button class="btn primary">Go</button>',
    '  </div>',
    '  <script>const x = 1</script>',
    '</body>',
    '</html>',
  ].join('\n')
  const symbols = helpers.extractSymbols(src, 'index.html')
  const elements = symbols.filter((s) => s.kind === 'element')
  assert.deepEqual(elements.map((s) => [s.name, s.line]), [
    ['html', 2],
    ['head', 3],
    ['title', 4],
    ['body', 6],
    ['div#app.root.container', 7],
    ['button.btn.primary', 9],
    ['script', 11],
  ])
  // <script>const x = 1</script> 里的变量也要能解析出来
  assert.deepEqual(symbols.filter((s) => s.kind !== 'element').map((s) => [s.kind, s.name, s.line]), [
    ['variable', 'x', 11],
  ])
  assert.equal(helpers.symbolKindBadge('element'), 'E')
})
test('extractSymbols：不支持的格式返回空；filterSymbols 按类型与关键词筛选', () => {
  assert.deepEqual(helpers.extractSymbols('class X {}', 'README.md'), [])
  assert.deepEqual(helpers.extractSymbols('', 'a.java'), [])

  const symbols = [
    { kind: 'class', name: 'OrderService', line: 3, container: '' },
    { kind: 'method', name: 'create', line: 11, container: 'OrderService' },
    { kind: 'variable', name: 'MAX', line: 4, container: 'OrderService' },
  ]
  assert.deepEqual(helpers.filterSymbols(symbols, 'all', '').map((s) => s.name), ['OrderService', 'create', 'MAX'])
  assert.deepEqual(helpers.filterSymbols(symbols, 'method', '').map((s) => s.name), ['create'])
  assert.deepEqual(helpers.filterSymbols(symbols, 'all', 'order').map((s) => s.name), ['OrderService', 'create', 'MAX'])
  assert.deepEqual(helpers.filterSymbols(symbols, 'variable', 'ord').map((s) => s.name), ['MAX'])
  assert.equal(helpers.symbolKindBadge('class'), 'C')
  assert.equal(helpers.symbolKindBadge('method'), 'M')
  assert.equal(helpers.symbolKindBadge('variable'), 'V')
})

test('symbolsOfKind：按类型取出符号并保持顺序', () => {
  const symbols = [
    { kind: 'class', name: 'A', line: 1 },
    { kind: 'method', name: 'm1', line: 2 },
    { kind: 'variable', name: 'v', line: 3 },
    { kind: 'method', name: 'm2', line: 4 },
  ]
  assert.deepEqual(helpers.symbolsOfKind(symbols, 'method').map((s) => s.name), ['m1', 'm2'])
  assert.deepEqual(helpers.symbolsOfKind(symbols, 'class').map((s) => s.name), ['A'])
  assert.deepEqual(helpers.symbolsOfKind(symbols, 'variable').map((s) => s.name), ['v'])
})
test('buildStructure：类节点带成员，未归属的进顶层', () => {
  const tree = helpers.buildStructure([
    { kind: 'class', name: 'A', line: 1, container: '' },
    { kind: 'method', name: 'm', line: 2, container: 'A' },
    { kind: 'variable', name: 'v', line: 3, container: 'A' },
    { kind: 'method', name: 'free', line: 4, container: '' },
  ])
  assert.deepEqual(tree.classes.map((c) => [c.name, c.members.map((m) => m.name)]), [['A', ['m', 'v']]])
  assert.deepEqual(tree.top.map((s) => s.name), ['free'])
})

test('预览外壳：文件本体交回宿主内置 code 查看器，只叠加查找条与结构面板', () => {
  resetHooks()
  const content = ['public class Demo {', '    private int count;', '    void run() {}', '}', ''].join('\n')
  const onReload = () => {}
  const view = renderView(helpers.CodeSearchView, {
    path: 'Demo.java',
    content,
    title: 'Demo.java',
    store: { tag: 'host-store' },
    toolbar: 'host',
    onReload,
    scope: { sessionId: 's1' },
    ctx: fakeCtx(fakeService([])),
  })
  assert.equal(view.args[0], helpers.FileView)
  assert.equal(view.args[1].delegate.id, 'code')
  assert.equal(view.args[1].largeFile, null)

  const element = renderView(helpers.FileView, view.args[1])
  assert.equal(propsOf(element).className, 'dcs-root')
  const main = findByClass(element, 'dcs-main')
  const stage = findByClass(main, 'dcs-stage')
  assert.ok(stage !== undefined)
  assert.equal(typeof propsOf(stage).onContextMenu, 'function')
  assert.equal(typeof propsOf(stage).ref, 'function')
  // 默认状态下不该出现我们自己的高亮视图（编辑 / 保存 / 预览还是宿主的）
  assert.ok(!childrenOf(main).some((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-body'))

  const host = childrenOf(stage)[0]
  assert.equal(host.args[0], HostViewer) // 文件本体交回宿主内置查看器渲染
  const received = host.args[1]
  assert.equal(received.viewerId, 'code') // 覆盖成被委托查看器的 id
  assert.notEqual(received.viewerId, helpers.VIEWER_ID)
  assert.equal(received.path, 'Demo.java')
  assert.equal(received.content, content)
  assert.equal(received.title, 'Demo.java')
  assert.equal(received.store, view.args[1].viewerProps.store)
  assert.equal(received.toolbar, 'host')
  assert.equal(received.onReload, onReload)

  assert.ok(findByClass(main, 'dcs-findbar') !== undefined || findByClass(main, 'dcs-findpill') !== undefined)
  // 叠加层用内联 top（宿主查看器自带工具条，挂载后会量出高度往下挪；没量到时兜底 8px）
  assert.equal(propsOf(findByClass(main, 'dcs-findpill')).style.top, '8px')
  const panel = findByClass(element, 'dcs-structure')
  const tree = findByClass(panel, 'dcs-structure-body')
  assert.equal(childrenOf(tree).length, 3)
  assert.equal(propsOf(childrenOf(tree)[0]).className, 'dcs-tree-row')
})

test('预览外壳：markdown 交回内置 markdown 查看器（渲染预览由宿主负责）', () => {
  resetHooks()
  const content = '# 一级\n\n正文\n\n## 二级\n'
  const view = renderView(helpers.CodeSearchView, {
    path: 'docs/guide.md',
    content,
    scope: { sessionId: 's1' },
    ctx: fakeCtx(fakeService([])),
  })
  assert.equal(view.args[1].delegate.id, 'markdown')
  const element = renderView(helpers.FileView, view.args[1])
  const stage = findByClass(findByClass(element, 'dcs-main'), 'dcs-stage')
  assert.equal(childrenOf(stage)[0].args[1].viewerId, 'markdown')
  assert.equal(childrenOf(stage)[0].args[0], HostViewer)

  // 结构面板仍然出标题大纲（H）
  const panel = findByClass(element, 'dcs-structure')
  const tree = findByClass(panel, 'dcs-structure-body')
  assert.equal(childrenOf(tree).length, 2)
  assert.equal(propsOf(childrenOf(childrenOf(tree)[0])[0])['data-kind'], 'heading')
  assert.equal(helpers.symbolKindBadge('heading'), 'H')
})


test('预览外壳：带行号打开（聊天里的 #L24 链接）把 line 交给宿主查看器', () => {
  resetHooks()
  const view = renderView(helpers.CodeSearchView, {
    path: 'docs/guide.md',
    content: '# 一级\n\n正文\n',
    line: 3,
    scope: { sessionId: 's1' },
    ctx: fakeCtx(fakeService([])),
  })
  assert.equal(view.args[1].line, 3)
  const element = renderView(helpers.FileView, view.args[1])
  const main = findByClass(element, 'dcs-main')
  assert.ok(findByClass(main, 'dcs-stage') !== undefined)
  assert.ok(!findByClass(main, 'dcs-body'))
  assert.equal(childrenOf(findByClass(main, 'dcs-stage'))[0].args[1].line, 3)
  assert.equal(childrenOf(findByClass(main, 'dcs-stage'))[0].args[1].onLineConsumed, undefined)
})

test('预览外壳：没有可委托的查看器时给提示，而不是空白', () => {
  resetHooks()
  const view = renderView(helpers.CodeSearchView, {
    path: 'a.java',
    content: 'class A {}\n',
    scope: { sessionId: 's1' },
    ctx: fakeCtx(fakeService([], { viewers: [] })),
  })
  assert.equal(view.args[1].delegate, null)
  const main = findByClass(renderView(helpers.FileView, view.args[1]), 'dcs-main')
  const stage = findByClass(main, 'dcs-stage')
  const empty = findByClass(stage, 'dcs-empty')
  assert.ok(empty !== undefined)
  assert.ok(String(childrenOf(empty)[0]).indexOf('没有可委托的宿主查看器') === 0)
})

test('预览外壳：点「查找」才换成我们自己的只读高亮视图，× 退回宿主查看器', () => {
  resetHooks()
  const props = {
    path: 'a.js',
    content: 'one\ntwo\nthree\n',
    scope: { sessionId: 's1' },
    ctx: fakeCtx(fakeService([])),
  }
  const first = renderView(helpers.FileView, props)
  const pill = findByClass(findByClass(first, 'dcs-main'), 'dcs-findpill')
  const pillButton = childrenOf(pill)[0]
  assert.equal(childrenOf(pillButton)[0], '查找')
  assert.ok(String(propsOf(pillButton).title).indexOf('打开高亮查找') !== -1)
  propsOf(pillButton).onClick()

  const second = renderView(helpers.FileView, props)
  const main = findByClass(second, 'dcs-main')
  const body = findByClass(main, 'dcs-body')
  assert.ok(body !== undefined)
  assert.ok(!findByClass(main, 'dcs-stage'))
  assert.equal(propsOf(childrenOf(body)[0])['data-line'], '1')
  assert.equal(propsOf(body).tabIndex, 0)
  assert.equal(typeof propsOf(body).onContextMenu, 'function')
  const note = findByClass(body, 'dcs-note')
  assert.equal(childrenOf(note)[0], '高亮查找是只读视图；按 × 或 Esc 回到编辑 / 预览。')

  const bar = findByClass(main, 'dcs-findbar')
  const close = childrenOf(bar).find((child) => child !== null && typeof child === 'object' && String(child.args[1].title || '').indexOf('退出高亮查找') !== -1)
  assert.ok(close !== undefined)
  propsOf(close).onClick()

  const third = renderView(helpers.FileView, props)
  const back = findByClass(third, 'dcs-main')
  assert.ok(findByClass(back, 'dcs-stage') !== undefined)
  assert.ok(!findByClass(back, 'dcs-body'))
})

test('预览外壳：查找视图里超大文件与二进制给出提示', () => {
  resetHooks()
  const bigProps = {
    path: 'big.log',
    content: '',
    largeFile: { size: 2048 },
    scope: { sessionId: 's1' },
    ctx: fakeCtx(fakeService([])),
  }
  propsOf(childrenOf(findByClass(findByClass(renderView(helpers.FileView, bigProps), 'dcs-main'), 'dcs-findpill'))[0]).onClick()
  const bigBody = findByClass(findByClass(renderView(helpers.FileView, bigProps), 'dcs-main'), 'dcs-body')
  assert.equal(childrenOf(findByClass(bigBody, 'dcs-empty'))[0],
    '超大文件（2 KB）：宿主只加载分页片段，高亮查找不可用，请在编辑器里用 CodeMirror 自带的搜索。')
  assert.ok(!findByClass(bigBody, 'dcs-note'))

  resetHooks()
  const binProps = { path: 'a.bin', content: 'a' + String.fromCharCode(0) + 'b', scope: { sessionId: 's1' }, ctx: fakeCtx(fakeService([])) }
  propsOf(childrenOf(findByClass(findByClass(renderView(helpers.FileView, binProps), 'dcs-main'), 'dcs-findpill'))[0]).onClick()
  const binBody = findByClass(findByClass(renderView(helpers.FileView, binProps), 'dcs-main'), 'dcs-body')
  assert.equal(childrenOf(findByClass(binBody, 'dcs-empty'))[0], '二进制文件，无法预览')
})

test('预览外壳：空文件在查找视图里给提示（编辑交回宿主）', () => {
  resetHooks()
  const props = { path: 'a.txt', content: '', scope: { sessionId: 's1' }, ctx: fakeCtx(fakeService([])) }
  propsOf(childrenOf(findByClass(findByClass(renderView(helpers.FileView, props), 'dcs-main'), 'dcs-findpill'))[0]).onClick()
  const body = findByClass(findByClass(renderView(helpers.FileView, props), 'dcs-main'), 'dcs-body')
  assert.equal(childrenOf(findByClass(body, 'dcs-empty'))[0], '空文件')
})

test('预览外壳：非 Java/JS/Python/HTML/Markdown 不出结构面板', () => {
  resetHooks()
  const view = renderView(helpers.FileView, {
    path: 'a.txt',
    content: 'hello\nworld\n',
    scope: { sessionId: 's1' },
    ctx: fakeCtx(fakeService([])),
  })
  assert.ok(!childrenOf(view).some((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-structure'))
  assert.ok(findByClass(findByClass(view, 'dcs-main'), 'dcs-stage') !== undefined)
})

test('选区标题：工作区相对路径 + 行范围', () => {
  assert.equal(helpers.relativePath('/work/app', '/work/app/src/a.js'), 'src/a.js')
  assert.equal(helpers.relativePath('D:\\work\\app', 'D:\\work\\app\\src\\a.js'), 'src/a.js')
  assert.equal(helpers.relativePath('', '/absolute/a.js'), '/absolute/a.js')
  assert.equal(helpers.relativePath('/work/app', '/other/a.js'), '/other/a.js')
  assert.equal(helpers.selectionHeader('/w/a.js', '/w', 12, 15), 'a.js:12-15')
  assert.equal(helpers.selectionHeader('/w/a.js', '/w', 12, 12), 'a.js:12')
})

test('选区载荷：代码围栏 + 行号标题，超长退化成位置标签', () => {
  const content = 'line1\nline2\r\nline3\nline4'
  assert.equal(helpers.selectLines(content, 2, 3), 'line2\nline3')

  const payload = helpers.buildSelectionInsert('/w/src/a.js', '/w', content, 2, 3)
  assert.equal(payload.label, 'src/a.js:2-3')
  assert.equal(payload.raw, 'line2\nline3')
  assert.equal(payload.text, '```src/a.js:2-3\nline2\nline3\n```')
  assert.equal(payload.truncated, false)

  const big = 'x'.repeat(helpers.SELECTION_LIMIT + 1)
  const clipped = helpers.buildSelectionInsert('/w/big.txt', '/w', big + '\n', 1, 1)
  assert.equal(clipped.text, 'big.txt:1')
  assert.equal(clipped.truncated, true)
})

test('选区行范围：按 data-line 反查，拖到下一行行首不多算一行', () => {
  const makeLine = (line) => ({
    nodeType: 1,
    getAttribute: (name) => (name === 'data-line' ? String(line) : null),
    querySelector: () => ({ contains: () => true }),
    parentElement: null,
  })
  const line1 = makeLine(1)
  const line3 = makeLine(3)
  const body = { nodeType: 1 }

  assert.deepEqual(
    helpers.selectionLineRange(body, { startContainer: line1, endContainer: line3, endOffset: 4 }),
    { start: 1, end: 3 },
  )
  assert.deepEqual(
    helpers.selectionLineRange(body, { startContainer: line1, endContainer: line3, endOffset: 0 }),
    { start: 1, end: 2 },
  )
  // 反向拖选（从下往上）仍然给正序区间
  assert.deepEqual(
    helpers.selectionLineRange(body, { startContainer: line3, endContainer: line1, endOffset: 3 }),
    { start: 1, end: 3 },
  )
  assert.equal(helpers.selectionLineRange(body, { startContainer: {}, endContainer: {}, endOffset: 0 }), null)
})

test('选区行范围：Ctrl+A 全选（边界落在容器本身）退化成首行到末行', () => {
  const makeLine = (line) => ({
    nodeType: 1,
    getAttribute: (name) => (name === 'data-line' ? String(line) : null),
    querySelector: () => ({ contains: () => true }),
    parentElement: null,
  })
  const lines = [makeLine(1), makeLine(2)]
  const body = {
    nodeType: 1,
    querySelectorAll: (selector) => (selector === '[data-line]' ? lines : []),
  }
  assert.deepEqual(
    helpers.selectionLineRange(body, { startContainer: body, endContainer: body, endOffset: 0 }),
    { start: 1, end: 2 },
  )
  // 空容器说明还没有渲染任何行，不该凭空造出选区
  assert.equal(helpers.selectionLineRange(
    { nodeType: 1, querySelectorAll: () => [] },
    { startContainer: {}, endContainer: {}, endOffset: 0 },
  ), null)
})

test('草稿插入位置：chip 在 detect 投影里折成 1 个字符', () => {
  assert.equal(helpers.leadFor(''), '')
  assert.equal(helpers.leadFor('abc'), ' ')
  assert.equal(helpers.leadFor('abc '), '')
  assert.equal(helpers.appendText('abc', 'X'), 'abc X')

  const draft = 'aa[CHIP01]bb'
  const occurrences = [{ offset: 2, length: 8 }]
  assert.equal(helpers.foldClipboardOffset(draft, occurrences, draft.length), draft.length - 7)
  assert.equal(helpers.foldClipboardOffset(draft, occurrences, 2), 2)
  assert.equal(helpers.foldClipboardOffset(draft, occurrences, 4), 3)
  assert.equal(helpers.appendDetectOffset({ draft: 'abc', occurrences: [] }), 3)
})

test('appendDetectOffset：命令 chip（/goal ）只占 1 个字符', () => {
  assert.equal(helpers.appendDetectOffset({
    draft: '/goal hi', phase: 'claimed', claim: { token: '/goal ' }, occurrences: [],
  }), 3)
  assert.equal(helpers.appendDetectOffset({
    draft: '/goal x[CHIP]y',
    phase: 'claimed',
    claim: { token: '/goal ' },
    occurrences: [{ offset: 7, length: 6 }],
  }), 4)
})

test('insertSelectionIntoComposer：插引用 chip，并补前置空格', () => {
  const emitted = []
  const chips = []
  let revision = 3
  let draft = 'hello'
  const input = {
    state: { getSnapshot: () => ({ draft: draft, draftRev: revision, occurrences: [] }) },
    insertReference(chip, span) {
      chips.push({ chip: chip, span: span })
      revision += 1
      return true
    },
    setDraft() { throw new Error('chip 通道可用时不该走 setDraft') },
  }
  const actx = {
    emit(name, payload) {
      emitted.push({ name: name, payload: payload })
      revision += 1
      draft += ' '
    },
  }
  const ctx = {
    get: (name) => (name === 'conversation' ? { input: { for: () => input } } : undefined),
    sessions: { scope: () => actx },
  }
  const payload = helpers.buildSelectionInsert('/w/a.js', '/w', 'one\ntwo', 1, 2)
  const result = helpers.insertSelectionIntoComposer(ctx, 's1', payload)

  assert.deepEqual(result, { ok: true, mode: 'chip', error: '' })
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].name, 'slash/input-insert-text')
  assert.equal(emitted[0].payload.text, ' ')
  assert.deepEqual(emitted[0].payload.span, { draftRev: 3, start: 5, end: 5 })
  assert.equal(chips.length, 1)
  assert.equal(chips[0].span.draftRev, 4)
  assert.equal(chips[0].span.start, 6)
  assert.equal(chips[0].chip.source, 'reference')
  assert.equal(chips[0].chip.label, 'a.js:1-2')
  assert.equal(chips[0].chip.ref, '```a.js:1-2\none\ntwo\n```')
})

test('insertSelectionIntoComposer：没有 chip 通道时退回纯文本', () => {
  const drafts = []
  const input = {
    state: { getSnapshot: () => ({ draft: 'hi', draftRev: 9, occurrences: [] }) },
    setDraft(text) { drafts.push(text) },
  }
  const ctx = {
    get: () => ({ input: { for: () => input } }),
    sessions: { scope: () => ({}) },
  }
  const payload = helpers.buildSelectionInsert('/w/a.js', '/w', 'one', 1, 1)
  assert.deepEqual(helpers.insertSelectionIntoComposer(ctx, 's1', payload), { ok: true, mode: 'text', error: '' })
  assert.deepEqual(drafts, ['hi ```a.js:1\none\n```'])
})

test('insertSelectionIntoComposer：没有会话 / 对话服务时报错而不是抛错', () => {
  const payload = helpers.buildSelectionInsert('/w/a.js', '/w', 'x', 1, 1)
  assert.deepEqual(helpers.insertSelectionIntoComposer(undefined, 's1', payload),
    { ok: false, mode: 'none', error: '没有可用的会话' })
  const noService = { get: () => undefined, sessions: { scope: () => ({}) } }
  assert.deepEqual(helpers.insertSelectionIntoComposer(noService, 's1', payload),
    { ok: false, mode: 'none', error: '对话服务不可用' })
})

test('insertSelectionIntoComposer：insertReference 返回假值但 revision 前进算成功（不重复插）', () => {
  let revision = 1
  const input = {
    state: { getSnapshot: () => ({ draft: 'd', draftRev: revision, occurrences: [] }) },
    insertReference() {
      revision += 1
      return false
    },
    setDraft() { throw new Error('revision 已前进，不该再走纯文本兜底') },
  }
  const ctx = {
    get: () => ({ input: { for: () => input } }),
    sessions: { scope: () => ({ emit: () => { revision += 1 } }) },
  }
  const payload = helpers.buildSelectionInsert('/w/a.js', '/w', 'x', 1, 1)
  assert.deepEqual(helpers.insertSelectionIntoComposer(ctx, 's1', payload), { ok: true, mode: 'chip', error: '' })
})










