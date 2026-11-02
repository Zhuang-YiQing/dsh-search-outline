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
  assert.equal(captured.id, 'dsh-code-outline')
  assert.equal(mod.name, 'dsh-code-outline')
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
  assert.equal(spec.id, 'dsh-code-outline:viewer')
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
test('languageOf：识别 java / js / python', () => {
  assert.equal(helpers.languageOf('a/B.java'), 'java')
  assert.equal(helpers.languageOf('a/b.tsx'), 'js')
  assert.equal(helpers.languageOf('x.PY'), 'python')
  assert.equal(helpers.languageOf('index.html'), 'html')
  assert.equal(helpers.languageOf('a.vue'), 'html')
  assert.equal(helpers.languageOf('README.md'), '')
  assert.equal(helpers.languageOf(undefined), '')
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











