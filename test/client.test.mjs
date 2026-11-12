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

const fakeReact = {
  createElement: (...args) => ({ args }),
  useState: (value) => [value, () => {}],
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useEffect: () => undefined,
}

await import('../lib/client.js')

const factory = captured.factory

/** 宿主基元取不到时的模块实例（markdown 预览会退化成源码）。 */
const bareMod = factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected module: ' + name)
})

/** 假的 @deepseek-ai/dsh-client-ui-primitives：只需是函数，渲染走假 React。 */
const fakePrimitives = {
  MarkdownText: () => null,
  MarkdownDelegateProvider: () => null,
}

const mod = factory((name) => {
  if (name === 'react') return fakeReact
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return fakePrimitives
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

/** 造一个只带 registerFileViewer 的假 betterSidebar 服务。 */
function fakeService(registered) {
  return {
    registerFileViewer(spec) {
      registered.push(spec)
      return () => {}
    },
  }
}

test('bundle 形状：name / inject / apply', () => {
  assert.equal(captured.id, 'dsh-search-outline')
  assert.equal(mod.name, 'dsh-search-outline')
  assert.deepEqual(mod.inject, [])
  assert.equal(typeof mod.apply, 'function')
})

test('apply：注册文件预览器（接管 better-sidebar 预览）', () => {
  const registered = []
  const fakeCtx = {
    effect(fn) { return fn() },
    inject(names, callback) {
      assert.deepEqual(names, ['betterSidebar'])
      return callback({ get: () => fakeService(registered) })
    },
  }
  mod.apply(fakeCtx)
  assert.equal(registered.length, 1)
  const spec = registered[0]
  assert.equal(spec.id, 'dsh-search-outline:viewer')
  assert.equal(spec.priority, 50)
  assert.equal(spec.fetchStrategy, 'fsRead')
  assert.equal(typeof spec.title(), 'string')
  assert.equal(typeof spec.component, 'function')
  for (const ext of ['java', 'js', 'ts', 'py', 'md', 'txt', 'log', 'json', 'css', '']) {
    assert.ok(spec.exts.includes(ext), '应接管 .' + ext)
  }
  // 二进制类扩展名不能接管（否则图片/PDF 会被当文本渲染）
  for (const ext of ['png', 'jpg', 'pdf', 'zip', 'docx']) {
    assert.ok(!spec.exts.includes(ext), '不应接管 .' + ext)
  }
})

test('apply：better-sidebar 缺失时静默不注册、不抛错', () => {
  const fakeCtx = {
    effect(fn) { return fn() },
    inject(names, callback) {
      return callback({ get: () => undefined })
    },
  }
  assert.doesNotThrow(() => mod.apply(fakeCtx))
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

test('isMarkdownPath / MD_EXTS', () => {
  assert.equal(helpers.isMarkdownPath('a/b.MD'), true)
  assert.equal(helpers.isMarkdownPath('a/b.markdown'), true)
  assert.equal(helpers.isMarkdownPath('a/b.txt'), false)
  assert.equal(helpers.isMarkdownPath('noext'), false)
  assert.deepEqual(helpers.MD_EXTS, ['md', 'markdown'])
})

test('resolveMarkdownTarget：相对路径按当前文件目录展开，去掉片段', () => {
  assert.equal(helpers.resolveMarkdownTarget('./other.md#L24', '/w/docs/a.md', '/w'), '/w/docs/other.md')
  assert.equal(helpers.resolveMarkdownTarget('../b.md', '/w/docs/a.md', '/w'), '/w/b.md')
  assert.equal(helpers.resolveMarkdownTarget('sub/c.md', '/w/docs/a.md', '/w'), '/w/docs/sub/c.md')
  assert.equal(helpers.resolveMarkdownTarget('/abs/c.md', '/w/docs/a.md', '/w'), '/abs/c.md')
  assert.equal(helpers.resolveMarkdownTarget('C:/w/c.md', '/w/docs/a.md', '/w'), 'C:/w/c.md')
  assert.equal(helpers.resolveMarkdownTarget('', '/w/docs/a.md', '/w'), '')
  assert.equal(helpers.resolveMarkdownTarget('x.md', '', '/w'), '/w/x.md')
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

test('预览组件：markdown 文件用宿主 MarkdownText 渲染，并带模式切换按钮', () => {
  const content = '# 一级\n\n正文\n\n## 二级\n'
  const view = helpers.FileView({ path: 'docs/guide.md', content, truncated: false, ctx: {}, sessionId: 's1' })
  const main = childrenOf(view).find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-main')
  const wrap = childrenOf(main).find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-mdwrap')
  assert.ok(wrap !== undefined)
  assert.ok(!childrenOf(main).some((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-body'))

  const md = childrenOf(wrap)[0]
  assert.equal(propsOf(md).className, 'dcs-md')
  assert.equal(typeof propsOf(md).ref, 'function')
  assert.equal(typeof propsOf(md).onContextMenu, 'function')

  const provider = childrenOf(md)[0]
  assert.equal(provider.args[0], fakePrimitives.MarkdownDelegateProvider)
  assert.equal(typeof propsOf(provider).openFile, 'function')
  assert.equal(typeof propsOf(provider).openExternalLink, 'function')
  const renderer = childrenOf(provider)[0]
  assert.equal(renderer.args[0], fakePrimitives.MarkdownText)
  assert.equal(propsOf(renderer).text, content)
  assert.equal(propsOf(renderer).variant, 'body')
  assert.equal(propsOf(renderer).labels.code.copyLabel, '复制')

  // 结构面板出标题（H），且按钮写着「源码」（当前在预览里，按钮是切回去）
  const panel = childrenOf(view).find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-structure')
  assert.ok(panel !== undefined)
  const tree = childrenOf(panel).find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-structure-body')
  assert.equal(childrenOf(tree).length, 2)
  assert.equal(propsOf(childrenOf(childrenOf(tree)[0])[0])['data-kind'], 'heading')

  const pill = childrenOf(main).find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-findpill')
  assert.ok(pill !== undefined)
  const mode = childrenOf(pill).find((child) => child !== null && typeof child === 'object' && propsOf(child).title !== undefined && propsOf(child).title.indexOf('源码') !== -1)
  assert.ok(mode !== undefined)
  assert.equal(childrenOf(mode)[0], '源码')
})

test('预览组件：宿主基元缺失时 markdown 退化成源码行', () => {
  const bare = bareMod.__test
  const view = bare.FileView({ path: 'docs/guide.md', content: '# 一级\n\n正文\n' })
  const main = childrenOf(view).find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-main')
  const body = childrenOf(main).find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-body')
  assert.ok(body !== undefined)
  assert.ok(!childrenOf(main).some((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-mdwrap'))
  assert.equal(propsOf(childrenOf(body)[0])['data-line'], '1')
  const pill = childrenOf(main).find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-findpill')
  assert.equal(childrenOf(pill).filter((child) => child !== null).length, 1)
})

test('预览组件：带内容渲染查找条、右侧结构面板与正文', () => {
  const content = ['public class Demo {', '    private int count;', '    void run() {}', '}', ''].join('\n')
  const view = helpers.CodeSearchView({
    path: 'Demo.java',
    content,
    truncated: false,
    scope: { sessionId: 's1' },
  })
  const inner = view.args[0]
  assert.equal(inner, helpers.FileView)
  const element = inner(view.args[1])
  assert.equal(propsOf(element).className, 'dcs-root')
  const children = childrenOf(element)

  const main = children.find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-main')
  assert.ok(main !== undefined)
  const mainChildren = childrenOf(main)
  assert.ok(mainChildren.some((child) => child !== null && typeof child === 'object' && (propsOf(child).className === 'dcs-findbar' || propsOf(child).className === 'dcs-findpill')))
  const body = mainChildren.find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-body')
  assert.ok(body !== undefined)
  assert.equal(propsOf(childrenOf(body)[0])['data-line'], '1')

  const panel = children.find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-structure')
  assert.ok(panel !== undefined)
  const panelChildren = childrenOf(panel)
  const tree = panelChildren.find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-structure-body')
  assert.ok(tree !== undefined)
  // 类行 + 字段 + 方法 = 3 行
  assert.equal(childrenOf(tree).length, 3)
  assert.equal(propsOf(childrenOf(tree)[0]).className, 'dcs-tree-row')
})

test('预览组件：非 Java/JS/Python 不出结构面板、二进制提示、空文件提示', () => {
  const text = helpers.CodeSearchView({ path: 'a.txt', content: 'hello\nworld\n' })
  const textChildren = childrenOf(text.args[0](text.args[1]))
  assert.ok(!textChildren.some((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-structure'))

  const binary = helpers.FileView({ path: 'a.bin', content: 'a\u0000b' })
  const binaryMain = childrenOf(binary).find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-main')
  const binaryBody = childrenOf(binaryMain).find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-body')
  const binaryEmpty = childrenOf(binaryBody).find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-empty')
  assert.equal(childrenOf(binaryEmpty)[0], '二进制文件，无法预览')

  const blank = helpers.FileView({ path: 'a.txt', content: '' })
  const blankMain = childrenOf(blank).find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-main')
  const blankBody = childrenOf(blankMain).find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-body')
  const blankEmpty = childrenOf(blankBody).find((child) => child !== null && typeof child === 'object' && propsOf(child).className === 'dcs-empty')
  assert.equal(childrenOf(blankEmpty)[0], '空文件')
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











