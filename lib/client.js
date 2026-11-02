/**
 * dsh-code-outline — 浏览器半（DSH Web GUI 客户端 bundle）。
 *
 * 形态与 code-nav 一致：**接管 better-sidebar 的文件预览**，在预览内部提供
 *  - 常驻查找条（Ctrl+F 聚焦）：字面量 / 正则 / 区分大小写，全部命中高亮、
 *    当前命中加深、`n/m` 计数、↑ / ↓ / Enter / Shift+Enter 上下跳；
 *  - 符号大纲（仅 Java / JavaScript / TypeScript / Python）：类 / 方法 / 变量的
 *    解析、按类型筛选、按名称过滤、点击跳转（行闪烁）；
 *  - 其它任何文本格式照样打开、照样查找（不挑扩展名），二进制显示提示。
 *
 * 它不注册任何独立 tab：没有「搜索」页，也没有「搜索视图」页。
 *
 * 数据来源：better-sidebar 的预览器契约（`registerFileViewer` + `fetchStrategy:
 * 'fsRead'`）已经把文件内容通过 `content` 传进来，所以查找与符号解析全部在
 * 浏览器内完成，零请求。
 */

window.__ModuleLoader__.load({
  id: 'dsh-code-outline',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    /** 插件包名（ModuleLoader id / 样式标记 / 导出名三处一致）。 */
    var PKG_NAME = 'dsh-code-outline'
    /** 预览器 id（better-sidebar 侧边卡片里按这个 id 记忆开关）。 */
    var VIEWER_ID = PKG_NAME + ':viewer'
    /** 预览器优先级：高于 code-nav（10）与内置 markdown/html（0）。 */
    var VIEWER_PRIORITY = 50
    /** 超过这个行数时默认只渲染命中附近（可点「显示全文」）。 */
    var WINDOW_THRESHOLD = 1200
    /** 单次查找的命中上限。 */
    var FIND_LIMIT = 20000

    /**
     * 本预览器接管的扩展名（小写、无点）。
     * 覆盖常见代码、配置与纯文本格式；图片 / PDF / Office 等二进制不在此列，
     * 仍交给 better-sidebar 自己的查看器。空字符串代表「无扩展名」（Makefile 等）。
     */
    var TEXT_EXTS = [
      '', 'txt', 'text', 'log', 'md', 'markdown', 'rst', 'adoc',
      'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
      'py', 'pyw', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle',
      'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'm', 'mm',
      'cs', 'go', 'rs', 'php', 'rb', 'swift', 'lua', 'dart',
      'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
      'sql', 'proto', 'graphql', 'gql', 'vue', 'svelte', 'astro',
      'json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'geojson',
      'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
      'xml', 'xsd', 'xsl', 'xslt', 'plist', 'csproj', 'props', 'targets',
      'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl',
      'csv', 'tsv', 'tex', 'erl', 'hrl', 'ex', 'exs', 'clj', 'cljs',
      'r', 'jl', 'nim', 'zig', 'sol', 'v', 'sv', 'vhd', 'asm', 's',
    ]

    //#region 样式（注入一次；变量跟随 DSH 主题）

    var CSS = [
      '.dcs-root{display:flex;flex-direction:row;height:100%;min-height:0;overflow:hidden;',
      'color:var(--dsw-alias-label-primary,#1f2328);background:transparent;',
      'font:var(--dsw-font-xxs-12,12px/1.5 ui-sans-serif,system-ui)}',
      '.dcs-main{position:relative;flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;overflow:hidden}',
      '.dcs-file-name{flex:none;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;',
      'color:var(--dsw-alias-label-secondary,#57606a)}',
      '.dcs-pos{flex:none;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px;',
      'font-variant-numeric:tabular-nums}',
      '.dcs-btn{height:26px;display:inline-flex;align-items:center;justify-content:center;gap:4px;',
      'padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));',
      'background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font:inherit;cursor:pointer;white-space:nowrap}',
      '.dcs-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));',
      'color:var(--dsw-alias-label-primary,#1f2328)}',
      '.dcs-btn[data-on=true]{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);',
      'color:var(--dsw-alias-state-business-primary,#4d6bfe);',
      'background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 10%,transparent)}',
      '.dcs-btn[disabled]{opacity:.45;cursor:default}',
      '.dcs-spacer{flex:1}',
      '.dcs-findbar{position:absolute;top:8px;left:8px;z-index:6;display:flex;gap:6px;align-items:center;',
      'max-width:calc(100% - 16px);padding:4px 6px;border-radius:10px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));',
      'background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 92%,transparent);',
      'backdrop-filter:blur(8px);box-shadow:0 6px 20px rgba(0,0,0,.14)}',
      '.dcs-findpill{position:absolute;top:8px;left:8px;z-index:6;display:flex;gap:4px;align-items:center;',
      'padding:3px 4px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));',
      'background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 92%,transparent);',
      'backdrop-filter:blur(8px);box-shadow:0 6px 20px rgba(0,0,0,.14)}',
      '.dcs-input{flex:1;min-width:0;height:26px;box-sizing:border-box;padding:0 8px;border-radius:6px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-base,#fff);',
      'color:inherit;font:inherit;outline:none}',
      '.dcs-input:focus{border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.dcs-input[data-invalid=true]{border-color:var(--dsw-alias-state-error-primary,#d1242f)}',
      '.dcs-structure{flex:none;width:210px;min-width:150px;min-height:0;display:flex;flex-direction:column;',
      'border-left:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));',
      'background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#fff))}',
      '.dcs-structure-collapsed{flex:none;width:24px;min-height:0;display:flex;align-items:flex-start;',
      'justify-content:center;padding-top:8px;border:none;border-left:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));',
      'background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#fff));',
      'color:var(--dsw-alias-label-tertiary,#8b949e);font:inherit;cursor:pointer}',
      '.dcs-structure-collapsed:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dcs-structure-head{display:flex;align-items:center;gap:4px;padding:5px 6px;flex:none;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05))}',
      '.dcs-structure-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#57606a)}',
      '.dcs-structure-filter{padding:5px 6px;flex:none;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05))}',

      '.dcs-structure-body{flex:1;min-height:0;overflow:auto;padding:3px 4px}',
      '.dcs-tree-section{display:flex;align-items:center;gap:3px;padding:6px 6px 2px;',
      'font-size:10px;font-weight:600;color:var(--dsw-alias-label-tertiary,#8b949e);',
      'letter-spacing:.02em;cursor:pointer;user-select:none}',
      '.dcs-tree-section:hover{color:var(--dsw-alias-label-secondary,#57606a)}',
      '.dcs-tree-row{display:flex;align-items:center;gap:3px;width:100%;box-sizing:border-box;',
      'padding:2px 4px;border:none;border-radius:4px;background:transparent;color:inherit;font:inherit;',
      'text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden}',
      '.dcs-tree-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dcs-tree-chevron{flex:none;width:12px;text-align:center;font-size:9px;',
      'color:var(--dsw-alias-label-tertiary,#8b949e)}',
      '.dcs-tree-icon{flex:none;width:14px;text-align:center;font-size:9.5px;font-weight:600;',
      'font-family:var(--ds-font-family-code,ui-monospace,monospace)}',
      '.dcs-tree-icon[data-kind=class]{color:#4d6bfe}',
      '.dcs-tree-icon[data-kind=method]{color:#b07d2b}',
      '.dcs-tree-icon[data-kind=variable]{color:var(--dsw-alias-label-tertiary,#8b949e)}',
      '.dcs-tree-icon[data-kind=element]{color:#2f8f5b}',
      '.dcs-tree-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;',
      'font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px}',
      '.dcs-tree-name[data-kind=class]{font-weight:600}',
      '.dcs-tree-line{flex:none;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:9.5px;',
      'font-variant-numeric:tabular-nums}',
      '.dcs-body{flex:1;min-height:0;overflow:auto;outline:none}',
      '.dcs-code-line{display:flex;gap:8px;padding:0 10px 0 0;min-height:18px;line-height:18px}',
      '.dcs-code-line[data-active=true]{background:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.1))}',
      '.dcs-code-line-flash{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 18%,transparent)}',
      '.dcs-ln{flex:none;width:46px;text-align:right;color:var(--dsw-alias-label-tertiary,#8b949e);',
      'font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px}',
      '.dcs-code{flex:1;min-width:0;white-space:pre;overflow:hidden;text-overflow:ellipsis;',
      'font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px}',
      'mark.dcs-mark{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 22%,transparent);',
      'color:inherit;border-radius:2px;padding:0 1px}',
      'mark.dcs-mark-active{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 55%,transparent);',
      'outline:1px solid var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.dcs-empty{padding:24px 16px;text-align:center;color:var(--dsw-alias-label-tertiary,#8b949e)}',
      '.dcs-note{padding:6px 10px;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px}',
    ].join('')

    /** 把样式标签插进文档一次（插件热重载时不重复插）。 */
    function injectStyles() {
      if (typeof document === 'undefined') return
      var existing = document.querySelector('style[data-plugin="' + PKG_NAME + '"]')
      if (existing !== null) {
        // 热重载时复用同一个标签，但必须刷新内容，否则旧版本的样式会一直生效。
        existing.textContent = CSS
        return
      }
      var tag = document.createElement('style')
      tag.dataset.plugin = PKG_NAME
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    //#endregion

    //#region 纯函数：查找

    /**
     * 转义正则元字符。
     * @param {string} text - 原始文本。
     * @returns {string} 可安全嵌进 RegExp 的文本。
     */
    function escapeRegExp(text) {
      return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }

    /**
     * 把一行文本按命中区间切成片段。
     * @param {string} text - 行文本。
     * @param {Array<[number, number]>} ranges - 命中区间（相对 text）。
     * @returns {Array<{text: string, hit: boolean, start: number, end: number}>} 片段序列。
     */
    function splitByRanges(text, ranges) {
      var out = []
      var pos = 0
      for (var i = 0; i < ranges.length; i++) {
        var start = ranges[i][0]
        var end = ranges[i][1]
        if (start < pos) continue
        if (start > pos) out.push({ text: text.slice(pos, start), hit: false, start: pos, end: start })
        out.push({ text: text.slice(start, end), hit: true, start: start, end: end })
        pos = end
      }
      if (pos < text.length) out.push({ text: text.slice(pos), hit: false, start: pos, end: text.length })
      return out
    }

    /**
     * 在全文里查找（字面量 / 正则、区分大小写），产出逐行区间与扁平命中序列。
     * @param {string} content - 文件全文。
     * @param {string} query - 查询词。
     * @param {{caseSensitive?: boolean, regex?: boolean}} [options] - 匹配选项。
     * @returns {{flat: Array<{line: number, start: number, end: number}>, byLine: Map<number, Array<[number, number]>>, error: string, truncated: boolean}}
     */
    function findInContent(content, query, options) {
      var result = { flat: [], byLine: new Map(), error: '', truncated: false }
      if (typeof content !== 'string' || content === '') return result
      if (typeof query !== 'string' || query === '') return result
      var opts = options || {}
      var regex
      try {
        regex = new RegExp(
          opts.regex === true ? query : escapeRegExp(query),
          opts.caseSensitive === true ? 'g' : 'gi',
        )
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error)
        return result
      }
      var lines = content.split('\n')
      for (var index = 0; index < lines.length; index++) {
        if (result.flat.length >= FIND_LIMIT) {
          result.truncated = true
          break
        }
        var line = lines[index]
        if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1)
        if (line.length === 0) continue
        regex.lastIndex = 0
        var ranges = []
        var match
        while (ranges.length < 200) {
          match = regex.exec(line)
          if (match === null) break
          if (match[0].length === 0) {
            regex.lastIndex = match.index + 1
            if (regex.lastIndex > line.length) break
            continue
          }
          ranges.push([match.index, match.index + match[0].length])
        }
        if (ranges.length === 0) continue
        result.byLine.set(index + 1, ranges)
        for (var k = 0; k < ranges.length; k++) {
          if (result.flat.length >= FIND_LIMIT) {
            result.truncated = true
            break
          }
          result.flat.push({ line: index + 1, start: ranges[k][0], end: ranges[k][1] })
        }
      }
      return result
    }

    /**
     * 把一行文本渲染成「普通 / 命中 / 当前命中」的片段。
     * @param {string} text - 行文本。
     * @param {Array<[number, number]>} ranges - 命中区间。
     * @param {[number, number]|null} activeRange - 当前命中的区间。
     * @returns {Array} React 子节点数组。
     */
    function highlightText(text, ranges, activeRange) {
      var parts = splitByRanges(text, ranges)
      return parts.map(function (part, index) {
        if (!part.hit) return part.text
        var isActive = activeRange !== null && activeRange[0] === part.start && activeRange[1] === part.end
        return h('mark', {
          key: 'm' + index,
          className: isActive ? 'dcs-mark dcs-mark-active' : 'dcs-mark',
        }, part.text)
      })
    }

    /**
     * 渲染代码行（长文件默认只渲染当前命中附近；current 所在行加深；flashLine 闪烁）。
     * @param {{content: string, lineCount: number}} view - 视图数据。
     * @param {Map<number, Array<[number, number]>>} rangeMap - 行号 → 命中区间。
     * @param {{line: number, start: number, end: number}|null} current - 当前命中。
     * @param {boolean} showAll - 是否渲染全部行。
     * @param {number} flashLine - 需要闪烁的行号（0 表示无）。
     * @param {number} [anchorLine] - 结构面板跳转的锚点行（大文件渲染窗口以它为中心）。
     * @returns {Array} React 行元素。
     */
    function renderCodeLines(view, rangeMap, current, showAll, flashLine, anchorLine) {
      var lines = view.content.split('\n')
      var start = 0
      var end = lines.length
      if (!showAll && lines.length > WINDOW_THRESHOLD) {
        var focus = current !== null
          ? current.line
          : (anchorLine > 0 ? anchorLine : (flashLine > 0 ? flashLine : 1))
        start = Math.max(0, focus - 400)
        end = Math.min(lines.length, start + 800)
        if (end - start < 800) start = Math.max(0, end - 800)
      }
      var rows = []
      for (var index = start; index < end; index++) {
        var lineNo = index + 1
        var ranges = rangeMap.get(lineNo) || []
        var isActiveLine = current !== null && current.line === lineNo
        var isFlashLine = flashLine === lineNo
        rows.push(h('div', {
          key: 'l' + lineNo,
          className: 'dcs-code-line' + (isFlashLine ? ' dcs-code-line-flash' : ''),
          'data-line': String(lineNo),
          'data-active': isActiveLine ? 'true' : undefined,
        },
        h('span', { className: 'dcs-ln' }, String(lineNo)),
        h('span', { className: 'dcs-code' }, highlightText(lines[index], ranges, isActiveLine ? [current.start, current.end] : null))))
      }
      return rows
    }

    //#endregion

    //#region 纯函数：符号大纲

    /**
     * 由扩展名判断语言（只用于符号大纲；不认识返回空串）。
     * @param {string} path - 文件路径。
     * @returns {''|'java'|'js'|'python'|'html'} 语言标识。
     */
    function languageOf(path) {
      var text = typeof path === 'string' ? path.toLowerCase() : ''
      var at = text.lastIndexOf('.')
      var ext = at === -1 ? '' : text.slice(at + 1)
      if (ext === 'java') return 'java'
      if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'jsx' || ext === 'ts' || ext === 'tsx') return 'js'
      if (ext === 'py' || ext === 'pyw') return 'python'
      if (ext === 'html' || ext === 'htm' || ext === 'xhtml' || ext === 'vue' || ext === 'svelte') return 'html'
      return ''
    }

    /**
     * 去掉字符串字面量内容（保留引号），避免把字符串里的 `{` `}` 当成代码结构。
     * @param {string} line - 单行源码。
     * @returns {string} 处理后的行。
     */
    function stripQuoted(line) {
      return line
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/`(?:\\.|[^`\\])*`/g, '``')
    }

    /**
     * 去掉行注释（从标记起到行尾）。
     * @param {string} line - 单行源码。
     * @param {string} marker - 注释标记。
     * @returns {string} 去注释后的行。
     */
    function stripLineComment(line, marker) {
      var at = line.indexOf(marker)
      return at === -1 ? line : line.slice(0, at)
    }

    /**
     * 一行里花括号的净增量。
     * @param {string} line - 单行源码。
     * @returns {number} `{` 数量减 `}` 数量。
     */
    function braceDelta(line) {
      return (line.split('{').length - 1) - (line.split('}').length - 1)
    }

    /**
     * Java 符号：类 / 接口 / 枚举 / record、构造器与方法、字段。
     * @param {string[]} lines - 源码行。
     * @returns {Array<object>} 符号。
     */
    /**
     * 把 Java 源码里的注释替换成空格（保留字符串字面量与换行，行号不变）。
     * @param {string[]} lines - 源码行。
     * @returns {string[]} 去注释后的行。
     */
    function maskJavaComments(lines) {
      var out = []
      var inBlock = false
      for (var i = 0; i < lines.length; i++) {
        var raw = lines[i]
        var result = ''
        for (var j = 0; j < raw.length; j++) {
          var ch = raw.charAt(j)
          var next = raw.charAt(j + 1)
          if (inBlock) {
            if (ch === '*' && next === '/') {
              inBlock = false
              result += '  '
              j += 1
            } else {
              result += ' '
            }
            continue
          }
          if (ch === '/' && next === '*') {
            inBlock = true
            result += '  '
            j += 1
            continue
          }
          if (ch === '/' && next === '/') break
          if (ch === '"' || ch === "'") {
            var quote = ch
            result += ch
            j += 1
            while (j < raw.length) {
              var c = raw.charAt(j)
              result += c
              if (c === '\\') {
                j += 1
                if (j < raw.length) result += raw.charAt(j)
              } else if (c === quote) {
                break
              }
              j += 1
            }
            continue
          }
          result += ch
        }
        out.push(result)
      }
      return out
    }

    /**
     * 括号净增量（`(` 数量减 `)` 数量）。
     * @param {string} text - 单行文本。
     * @returns {number} 净增量。
     */
    function parenDelta(text) {
      return (text.split('(').length - 1) - (text.split(')').length - 1)
    }

    /**
     * 去掉行首的注解（`@Foo` / `@Foo(...)`）。
     * @param {string} text - 声明文本。
     * @returns {string} 去注解后的文本。
     */
    function stripAnnotations(text) {
      return text.replace(/^\s*(?:@[A-Za-z_$][\w$.]*(?:\([^()]*\))?\s*)+/, '')
    }

    /**
     * Java 符号：类 / 接口 / 枚举 / record、构造器与方法、**类级字段**（方法内的局部变量不算）。
     * 支持注解、同一行多个注解、多行参数列表、带空格的泛型返回类型。
     * @param {string[]} lines - 源码行。
     * @returns {Array<object>} 符号。
     */
    function javaSymbols(lines) {
      var code = maskJavaComments(lines)
      var out = []
      var depth = 0
      var classes = []
      var modifiers = '(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp|volatile|transient)\\s+)*'
      var control = { if: 1, for: 1, while: 1, switch: 1, catch: 1, return: 1, new: 1, do: 1, try: 1, else: 1, throw: 1 }
      var i = 0
      while (i < code.length) {
        var start = i
        var text = code[i]
        var parens = parenDelta(text)
        while (parens > 0 && i + 1 < code.length) {
          i += 1
          text += ' ' + code[i]
          parens += parenDelta(code[i])
        }
        var delta = 0
        for (var j = start; j <= i; j++) delta += braceDelta(code[j])

        var bodyDepth = classes.length > 0 ? classes[classes.length - 1].bodyDepth : 0
        var current = classes.length > 0 ? classes[classes.length - 1].name : ''
        var decl = text.match(/\b(class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)/)
        if (decl !== null) {
          out.push({ kind: 'class', name: decl[2], line: start + 1, container: current })
          classes.push({ name: decl[2], bodyDepth: depth + 1, opened: false })
        } else if (depth >= 1 && classes.length > 0) {
          var cleaned = stripAnnotations(text).trim()
          if (depth === bodyDepth && /;\s*$/.test(cleaned)) {
            // 只在类体这一层取字段/常量；方法体里的局部变量在更深的层级，天然被排除。
            var field = cleaned.match(new RegExp('^' + modifiers + '(.+?)\\s+([A-Za-z_$][\\w$]*)\\s*(?:=.*)?;$'))
            if (field !== null && field[1].trim() !== '') {
              out.push({ kind: 'variable', name: field[2], line: start + 1, container: current, detail: field[1].trim() })
            }
          } else {
            var sig = cleaned.match(new RegExp('^' + modifiers + '(?:([^=()]*?[\\w$>\\]])\\s+)?([A-Za-z_$][\\w$]*)\\s*\\(([\\s\\S]*)\\)\\s*(?:throws[^{;]*)?\\{?\\s*\\}?\\s*$'))
            if (sig !== null) {
              var name = sig[2]
              var returnType = sig[1] === undefined ? '' : sig[1].trim()
              if (returnType === '' && name === current) {
                out.push({ kind: 'method', name: name, line: start + 1, container: current })
              } else if (returnType !== '' && control[returnType] !== 1) {
                out.push({ kind: 'method', name: name, line: start + 1, container: current, detail: returnType })
              }
            }
          }
        }

        depth += delta
        // 类体可能在声明的下一行才用 `{` 打开：只有真正进过类体（depth 达到 bodyDepth）才允许出栈，
        // 否则 `class Foo` 后紧跟一行的 `{` 会把类立刻弹掉，导致成员全部解析不到。
        if (classes.length > 0 && depth >= classes[classes.length - 1].bodyDepth) {
          classes[classes.length - 1].opened = true
        }
        while (classes.length > 0 && classes[classes.length - 1].opened && depth < classes[classes.length - 1].bodyDepth) classes.pop()
        i += 1
      }
      return out
    }

    /**
     * JavaScript / TypeScript 符号：类、函数与函数值、类方法、顶层变量。
     * @param {string[]} lines - 源码行。
     * @returns {Array<object>} 符号。
     */
    function jsSymbols(lines) {
      var out = []
      var depth = 0
      var classes = []
      var control = { if: 1, for: 1, while: 1, switch: 1, catch: 1, function: 1, return: 1, do: 1, else: 1, try: 1 }
      for (var i = 0; i < lines.length; i++) {
        var line = stripQuoted(stripLineComment(lines[i], '//'))
        var delta = braceDelta(line)
        var current = classes.length > 0 ? classes[classes.length - 1].name : ''
        var cls = line.match(/\bclass\s+([A-Za-z_$][\w$]*)/)
        if (cls !== null) {
          out.push({ kind: 'class', name: cls[1], line: i + 1, container: current })
          if (delta > 0) classes.push({ name: cls[1], depth: depth + 1 })
        } else {
          var fn = line.match(/^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/)
          var arrow = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/)
          var variable = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/)
          var method = line.match(/^\s*(?:(?:static|async|get|set|public|private|protected|readonly|\*)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{?\s*\}?\s*$/)
          if (fn !== null) out.push({ kind: 'method', name: fn[1], line: i + 1, container: current })
          else if (arrow !== null) out.push({ kind: 'method', name: arrow[1], line: i + 1, container: current })
          else if (variable !== null) out.push({ kind: 'variable', name: variable[1], line: i + 1, container: current })
          else if (classes.length > 0 && method !== null && control[method[1]] !== 1) {
            out.push({ kind: 'method', name: method[1], line: i + 1, container: current })
          }
        }
        depth += delta
        if (classes.length > 0 && depth >= classes[classes.length - 1].bodyDepth) {
          classes[classes.length - 1].opened = true
        }
        while (classes.length > 0 && classes[classes.length - 1].opened && depth < classes[classes.length - 1].bodyDepth) classes.pop()
      }
      return out
    }

    /**
     * Python 符号：类、函数/方法（按缩进判断所属类）、模块级变量。
     * @param {string[]} lines - 源码行。
     * @returns {Array<object>} 符号。
     */
    function pythonSymbols(lines) {
      var out = []
      var classes = []
      for (var i = 0; i < lines.length; i++) {
        var raw = lines[i]
        var trimmed = raw.trim()
        if (trimmed === '' || trimmed.charAt(0) === '#') continue
        var indent = raw.length - raw.replace(/^\s+/, '').length
        var cls = raw.match(/^(\s*)class\s+([A-Za-z_]\w*)/)
        if (cls !== null) {
          while (classes.length > 0 && classes[classes.length - 1].indent >= indent) classes.pop()
          out.push({ kind: 'class', name: cls[2], line: i + 1, container: classes.length > 0 ? classes[classes.length - 1].name : '' })
          classes.push({ name: cls[2], indent: indent })
          continue
        }
        var def = raw.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/)
        if (def !== null) {
          var defIndent = def[1].length
          while (classes.length > 0 && classes[classes.length - 1].indent >= defIndent) classes.pop()
          out.push({ kind: 'method', name: def[2], line: i + 1, container: classes.length > 0 ? classes[classes.length - 1].name : '' })
          continue
        }
        var assign = raw.match(/^([A-Za-z_]\w*)\s*(?::[^=]+)?=/)
        if (assign !== null && indent === 0) {
          out.push({ kind: 'variable', name: assign[1], line: i + 1, container: '' })
        }
      }
      return out
    }

    /** HTML 里值得列进大纲的标签（其余标签只在带 id/class 时才收录）。 */
    var HTML_NOTABLE = {
      html: 1, head: 1, body: 1, header: 1, footer: 1, nav: 1, main: 1, section: 1, article: 1,
      aside: 1, form: 1, table: 1, script: 1, style: 1, title: 1, template: 1, dialog: 1, iframe: 1,
    }

    /**
     * 解析 HTML 开标签里的 id / class 属性。
     * @param {string} attrs - 标签属性文本（不含标签名）。
     * @returns {{id: string, classes: string[]}} id 与 class 列表。
     */
    function htmlIdClass(attrs) {
      var idValue = ''
      var classValue = ''
      var idMatch = attrs.match(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
      if (idMatch !== null) idValue = idMatch[1] || idMatch[2] || idMatch[3] || ''
      var classMatch = attrs.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
      if (classMatch !== null) classValue = classMatch[1] || classMatch[2] || classMatch[3] || ''
      var classes = classValue.split(/\s+/)
      var kept = []
      for (var i = 0; i < classes.length; i++) {
        if (classes[i] !== '') kept.push(classes[i])
      }
      return { id: idValue.trim(), classes: kept }
    }

    /**
     * 把 HTML 拆成两份等长行数组：
     *  - elementLines：`<script>` 内部内容被抹成空格（避免 JS 里的 `<` 被当成标签）；
     *  - scriptLines：只有 `<script>` 内部内容，其余行留空（行号与原文一一对应）。
     * @param {string[]} lines - 源码行。
     * @returns {{elementLines: string[], scriptLines: string[]}} 两份掩码行。
     */
    function maskHtmlScripts(lines) {
      var elementLines = []
      var scriptLines = []
      var inScript = false
      for (var i = 0; i < lines.length; i++) {
        var raw = lines[i]
        if (!inScript) {
          var open = raw.search(/<script\b/i)
          if (open === -1) {
            elementLines.push(raw)
            scriptLines.push('')
            continue
          }
          var rest = raw.slice(open)
          var gt = rest.indexOf('>')
          if (gt === -1) {
            elementLines.push(raw)
            scriptLines.push('')
            inScript = true
            continue
          }
          var contentStart = open + gt + 1
          var afterOpen = raw.slice(contentStart)
          var closeAt = afterOpen.search(/<\/script>/i)
          var content = closeAt === -1 ? afterOpen : afterOpen.slice(0, closeAt)
          elementLines.push(raw.slice(0, contentStart))
          scriptLines.push(' '.repeat(contentStart) + content)
          if (closeAt === -1) inScript = true
          continue
        }
        var closeIndex = raw.search(/<\/script>/i)
        if (closeIndex === -1) {
          elementLines.push('')
          scriptLines.push(raw)
          continue
        }
        elementLines.push('')
        scriptLines.push(raw.slice(0, closeIndex))
        inScript = false
      }
      return { elementLines: elementLines, scriptLines: scriptLines }
    }

    /**
     * HTML / Vue / Svelte 大纲：元素（结构标签 + 带 id/class 的标签）+ `<script>` 里的 JS 类/函数/变量。
     * @param {string[]} lines - 源码行。
     * @returns {Array<object>} 符号（按行号排序）。
     */
    function htmlSymbols(lines) {
      var masked = maskHtmlScripts(lines)
      var out = []
      var seen = 0
      for (var i = 0; i < masked.elementLines.length; i++) {
        var text = masked.elementLines[i]
        if (text.indexOf('<') === -1) continue
        var re = /<([A-Za-z][\w:-]*)((?:\s+[^<>]*?)?)\s*\/?>/g
        var match
        while ((match = re.exec(text)) !== null) {
          if (seen >= 800) break
          var tag = match[1].toLowerCase()
          var parsed = htmlIdClass(match[2] || '')
          var notable = HTML_NOTABLE[tag] === 1 || parsed.id !== '' || parsed.classes.length > 0
          if (!notable) continue
          var name = tag
          if (parsed.id !== '') name += '#' + parsed.id
          if (parsed.classes.length > 0) name += '.' + parsed.classes.slice(0, 3).join('.')
          out.push({ kind: 'element', name: name, line: i + 1, container: '', detail: tag })
          seen += 1
        }
      }
      var scripts = jsSymbols(masked.scriptLines)
      for (var j = 0; j < scripts.length; j++) {
        out.push(scripts[j])
      }
      out.sort(function (a, b) { return a.line - b.line })
      return out
    }

    /**
     * 提取符号（Java / JS / TS / Python / HTML；其它格式返回空数组，不影响查找）。
     * @param {string} content - 文件全文。
     * @param {string} path - 文件路径（用于判断语言）。
     * @returns {Array<object>} 符号（最多 500 个）。
     */
    function extractSymbols(content, path) {
      var lang = languageOf(path)
      if (lang === '' || typeof content !== 'string' || content === '') return []
      var lines = content.split('\n')
      var symbols = lang === 'java'
        ? javaSymbols(lines)
        : lang === 'js'
          ? jsSymbols(lines)
          : lang === 'html'
            ? htmlSymbols(lines)
            : pythonSymbols(lines)
      return symbols.length > 500 ? symbols.slice(0, 500) : symbols
    }

    /**
     * 按类型与关键词筛选符号。
     * @param {Array<object>} symbols - 全部符号。
     * @param {string} kind - 'all' | 'class' | 'method' | 'variable'。
     * @param {string} query - 名称 / 所属类关键词。
     * @returns {Array<object>} 命中符号。
     */
    function filterSymbols(symbols, kind, query) {
      var needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
      var out = []
      for (var i = 0; i < symbols.length; i++) {
        var symbol = symbols[i]
        if (kind !== 'all' && symbol.kind !== kind) continue
        if (needle !== '') {
          var name = String(symbol.name || '').toLowerCase()
          var container = String(symbol.container || '').toLowerCase()
          if (name.indexOf(needle) === -1 && container.indexOf(needle) === -1) continue
        }
        out.push(symbol)
      }
      return out
    }

    /**
     * 取出某一类符号（类 / 方法 / 变量），保持原有顺序。
     * @param {Array<object>} symbols - 符号列表。
     * @param {string} kind - 'class' | 'method' | 'variable'。
     * @returns {Array<object>} 该类型的符号。
     */
    function symbolsOfKind(symbols, kind) {
      var out = []
      for (var i = 0; i < symbols.length; i++) {
        if (symbols[i].kind === kind) out.push(symbols[i])
      }
      return out
    }

    /**
     * 把扁平符号列表整理成 IDEA Structure 风格的两层结构：
     * 类节点（成员挂在下面）+ 顶层函数/变量。
     * @param {Array<object>} symbols - 符号列表。
     * @returns {{classes: Array<object>, top: Array<object>}} 结构树。
     */
    function buildStructure(symbols) {
      var classes = []
      var byName = Object.create(null)
      var top = []
      for (var i = 0; i < symbols.length; i++) {
        var symbol = symbols[i]
        if (symbol.kind === 'class') {
          var node = { kind: 'class', name: symbol.name, line: symbol.line, container: symbol.container || '', members: [] }
          classes.push(node)
          if (byName[symbol.name] === undefined) byName[symbol.name] = node
          continue
        }
        var owner = symbol.container === '' || symbol.container === undefined ? undefined : byName[symbol.container]
        if (owner !== undefined) owner.members.push(symbol)
        else top.push(symbol)
      }
      return { classes: classes, top: top }
    }

    /**
     * 符号类型的单字母标记（C 类 / M 方法 / V 变量）。
     * @param {string} kind - 符号类型。
     * @returns {string} 标记字符。
     */
    function symbolKindBadge(kind) {
      if (kind === 'class') return 'C'
      if (kind === 'method') return 'M'
      if (kind === 'element') return 'E'
      return 'V'
    }

    //#endregion

    //#region 预览组件

    /**
     * 预览组件：better-sidebar 通过 `registerFileViewer` 传入文件内容，
     * 这里把内容交给 FileView（查找 + 符号大纲）。
     * @param {object} props - { ctx, scope, path, title, content, truncated }。
     * @returns {object} React 元素。
     */
    function CodeSearchView(props) {
      var scope = props !== null && typeof props === 'object' ? props.scope : undefined
      var sessionId = scope !== null && typeof scope === 'object' && typeof scope.sessionId === 'string'
        ? scope.sessionId
        : ''
      return h(FileView, {
        path: typeof props.path === 'string' ? props.path : '',
        content: typeof props.content === 'string' ? props.content : '',
        truncated: props.truncated === true,
        sessionId: sessionId,
      })
    }

    /**
     * 只读文件视图：常驻查找条 + 符号大纲 + 逐行高亮。
     * @param {{path?: string, content?: string, truncated?: boolean}} props - 视图属性。
     * @returns {object} React 元素。
     */
    function FileView(props) {
      var path = typeof props.path === 'string' ? props.path : ''
      var content = typeof props.content === 'string' ? props.content : ''
      var truncated = props.truncated === true

      var findQueryState = React.useState('')
      var findQuery = findQueryState[0]
      var setFindQuery = findQueryState[1]

      var findCaseState = React.useState(false)
      var findCase = findCaseState[0]
      var setFindCase = findCaseState[1]

      var findRegexState = React.useState(false)
      var findRegex = findRegexState[0]
      var setFindRegex = findRegexState[1]

      var findActiveState = React.useState(0)
      var findActive = findActiveState[0]
      var setFindActive = findActiveState[1]

      var structureOpenState = React.useState(true)
      var structureOpen = structureOpenState[0]
      var setStructureOpen = structureOpenState[1]

      var collapsedState = React.useState({})
      var collapsed = collapsedState[0]
      var setCollapsed = collapsedState[1]

      var structureSortState = React.useState('position')
      var structureSort = structureSortState[0]
      var setStructureSort = structureSortState[1]

      var collapsedKindsState = React.useState({})
      var collapsedKinds = collapsedKindsState[0]
      var setCollapsedKinds = collapsedKindsState[1]

      var findOpenState = React.useState(false)
      var findOpen = findOpenState[0]
      var setFindOpen = findOpenState[1]

      var symbolQueryState = React.useState('')
      var symbolQuery = symbolQueryState[0]
      var setSymbolQuery = symbolQueryState[1]

      var flashLineState = React.useState(0)
      var flashLine = flashLineState[0]
      var setFlashLine = flashLineState[1]

      var anchorLineState = React.useState(0)
      var anchorLine = anchorLineState[0]
      var setAnchorLine = anchorLineState[1]

      var showAllState = React.useState(false)
      var showAll = showAllState[0]
      var setShowAll = showAllState[1]

      var bodyRef = React.useRef(null)
      var findInputRef = React.useRef(null)
      var flashTimerRef = React.useRef(null)
      var wantFindFocusRef = React.useRef(false)

      var binary = content.indexOf('\u0000') !== -1
      var lineCount = content === '' ? 0 : content.split('\n').length

      var findResult = React.useMemo(function () {
        return findInContent(content, findQuery, { caseSensitive: findCase, regex: findRegex })
      }, [content, findQuery, findCase, findRegex])

      var symbols = React.useMemo(function () {
        return extractSymbols(content, path)
      }, [content, path])
      var structure = React.useMemo(function () {
        return buildStructure(symbols)
      }, [symbols])

      var total = findResult.flat.length
      var current = total === 0 ? null : findResult.flat[Math.min(findActive, total - 1)]
      var currentKey = current === null ? '' : current.line + ':' + current.start + ':' + current.end

      var goto = React.useCallback(function (delta) {
        setFindActive(function (previous) {
          var count = findResult.flat.length
          if (count === 0) return previous
          var next = previous + delta
          if (next < 0) next = count - 1
          if (next >= count) next = 0
          return next
        })
      }, [findResult])

      var jumpToLine = React.useCallback(function (line) {
        // 大文件只渲染命中附近的行：先设置锚点让目标行进入渲染窗口，
        // 真正的滚动交给渲染后的 effect（此时目标行一定已经在 DOM 里）。
        setAnchorLine(line)
        setFlashLine(line)
        if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
        flashTimerRef.current = setTimeout(function () { setFlashLine(0) }, 1600)
      }, [])

      var focusFind = React.useCallback(function () {
        if (findInputRef.current === null) return
        findInputRef.current.focus()
        findInputRef.current.select()
      }, [])

      React.useEffect(function () {
        var box = bodyRef.current
        if (box === null) return undefined
        var element = flashLine > 0
          ? box.querySelector('[data-line="' + flashLine + '"]')
          : box.querySelector('[data-active="true"]')
        if (element === null) return undefined
        var rect = element.getBoundingClientRect()
        var boxRect = box.getBoundingClientRect()
        if (flashLine > 0 || rect.top < boxRect.top + 16 || rect.bottom > boxRect.bottom - 16) {
          box.scrollTop += rect.top - boxRect.top - box.clientHeight / 2 + rect.height / 2
        }
        return undefined
      }, [currentKey, showAll, flashLine, anchorLine])

      React.useEffect(function () {
        if (findOpen && wantFindFocusRef.current) {
          wantFindFocusRef.current = false
          focusFind()
        }
        return undefined
      }, [findOpen, focusFind])

      React.useEffect(function () {
        return function () {
          if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
        }
      }, [])

      React.useEffect(function () {
        var onKey = function (event) {
          var mod = event.ctrlKey || event.metaKey
          if (mod && !event.altKey && !event.shiftKey && (event.key === 'f' || event.key === 'F')) {
            event.preventDefault()
            wantFindFocusRef.current = true
            if (!findOpen) setFindOpen(true)
            else {
              wantFindFocusRef.current = false
              focusFind()
            }
            return
          }
          if (event.key === 'F3') {
            event.preventDefault()
            goto(event.shiftKey ? -1 : 1)
            return
          }
          if (event.key === 'Escape') {
            if (findOpen) {
              event.preventDefault()
              setFindOpen(false)
              return
            }
            if (findQuery !== '') {
              event.preventDefault()
              setFindQuery('')
              setFindActive(0)
            }
          }
        }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      }, [findOpen, findQuery, goto, focusFind])

      var name = path === '' ? '文件' : path.split('/').pop()
      var pos = total === 0
        ? (findQuery === '' ? '' : '无匹配')
        : ((Math.min(findActive, total - 1) + 1) + '/' + total)

      // 结构面板：三种排序 —— 位置（源码顺序）/ 类型（类 → 方法 → 变量）/ 名称。
      var needle = symbolQuery.trim().toLowerCase()
      var textOk = function (symbol) {
        if (needle === '') return true
        var symbolName = String(symbol.name || '').toLowerCase()
        var container = String(symbol.container || '').toLowerCase()
        return symbolName.indexOf(needle) !== -1 || container.indexOf(needle) !== -1
      }
      var sortMode = structureSort
      var sortLabel = sortMode === 'kind' ? '类型' : (sortMode === 'name' ? '名称' : '位置')
      var kindOrder = ['class', 'method', 'variable', 'element']
      var kindNames = { class: '类', method: '方法', variable: '变量', element: '元素' }
      var byLine = function (a, b) { return a.line - b.line }
      var byName = function (a, b) { return String(a.name).localeCompare(String(b.name)) }

      var treeRow = function (key, symbol, indented) {
        return h('button', {
          key: key,
          type: 'button',
          className: 'dcs-tree-row',
          style: indented ? { paddingLeft: '18px' } : undefined,
          title: (symbol.container === '' || symbol.container === undefined ? '' : symbol.container + ' · ') + symbol.name + '（第 ' + symbol.line + ' 行）',
          onClick: function () { jumpToLine(symbol.line) },
        },
        h('span', { className: 'dcs-tree-icon', 'data-kind': symbol.kind }, symbolKindBadge(symbol.kind)),
        h('span', { className: 'dcs-tree-name', 'data-kind': symbol.kind }, symbol.name),
        h('span', { className: 'dcs-tree-line' }, String(symbol.line)))
      }

      var structureRows = []
      var rowCount = 0

      if (sortMode === 'kind') {
        // 分类型：类 → 方法 → 变量，组内按行号；每一段都能单独展开 / 收起。
        for (var kindIndex = 0; kindIndex < kindOrder.length; kindIndex++) {
          var kind = kindOrder[kindIndex]
          var items = symbolsOfKind(symbols, kind).filter(textOk).sort(byLine)
          if (items.length === 0) continue
          var kindCollapsed = collapsedKinds[kind] === true
          structureRows.push(h('div', {
            key: 'sec-' + kind,
            className: 'dcs-tree-section',
            title: (kindCollapsed ? '展开「' : '收起「') + kindNames[kind] + '」',
            onClick: function (targetKind) {
              return function () {
                setCollapsedKinds(function (previous) {
                  var next = Object.assign({}, previous)
                  if (next[targetKind] === true) delete next[targetKind]
                  else next[targetKind] = true
                  return next
                })
              }
            }(kind),
          },
          h('span', { className: 'dcs-tree-chevron' }, kindCollapsed ? '▸' : '▾'),
          h('span', null, kindNames[kind] + ' (' + items.length + ')')))
          rowCount += 1
          if (kindCollapsed) continue
          for (var itemIndex = 0; itemIndex < items.length; itemIndex++) {
            structureRows.push(treeRow('k' + kind + itemIndex, items[itemIndex], true))
            rowCount += 1
          }
        }
      } else {
        // 位置 / 名称：保持「类 → 成员」的树。
        var classes = structure.classes.slice()
        if (sortMode === 'name') classes.sort(byName)
        for (var nodeIndex = 0; nodeIndex < classes.length; nodeIndex++) {
          var classNode = classes[nodeIndex]
          var members = classNode.members.filter(textOk)
          if (sortMode === 'name') members.sort(byName)
          if (!textOk(classNode) && members.length === 0) continue
          var entry = { node: classNode, members: members }
          var nodeKey = 'c' + nodeIndex
          var isCollapsed = collapsed[entry.node.name] === true
          structureRows.push(h('div', {
            key: nodeKey,
            className: 'dcs-tree-row',
            title: entry.node.name + '（第 ' + entry.node.line + ' 行）',
            onClick: function (target) {
              return function () { jumpToLine(target.line) }
            }(entry.node),
          },
          h('span', {
            className: 'dcs-tree-chevron',
            onClick: function (targetName) {
              return function (event) {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                setCollapsed(function (previous) {
                  var next = Object.assign({}, previous)
                  if (next[targetName] === true) delete next[targetName]
                  else next[targetName] = true
                  return next
                })
              }
            }(entry.node.name),
          }, isCollapsed ? '▸' : '▾'),
          h('span', { className: 'dcs-tree-icon', 'data-kind': 'class' }, 'C'),
          h('span', { className: 'dcs-tree-name', 'data-kind': 'class' }, entry.node.name),
          h('span', { className: 'dcs-tree-line' }, String(entry.node.line))))
          rowCount += 1
          if (!isCollapsed) {
            for (var memberIndex = 0; memberIndex < entry.members.length; memberIndex++) {
              structureRows.push(treeRow(nodeKey + ':' + memberIndex, entry.members[memberIndex], true))
              rowCount += 1
            }
          }
        }
        var topRows = structure.top.filter(textOk)
        topRows.sort(sortMode === 'name' ? byName : byLine)
        for (var topIndex = 0; topIndex < topRows.length; topIndex++) {
          structureRows.push(treeRow('t' + topIndex, topRows[topIndex], false))
          rowCount += 1
        }
      }

      var findBar = findOpen
        ? h('div', { className: 'dcs-findbar' },
          h('span', { className: 'dcs-file-name', title: path }, name),
          h('input', {
            className: 'dcs-input',
            ref: findInputRef,
            value: findQuery,
            spellCheck: false,
            autoComplete: 'off',
            'data-invalid': findResult.error !== '' ? 'true' : 'false',
            placeholder: '在文件中查找…',
            onChange: function (event) {
              setFindQuery(event.target.value)
              setFindActive(0)
            },
            onKeyDown: function (event) {
              if (event.key === 'Enter') {
                event.preventDefault()
                goto(event.shiftKey ? -1 : 1)
              }
            },
          }),
          h('span', { className: 'dcs-pos' }, pos),
          h('button', {
            className: 'dcs-btn',
            'data-on': findCase ? 'true' : 'false',
            title: '区分大小写',
            onClick: function () { setFindCase(!findCase); setFindActive(0) },
          }, 'Aa'),
          h('button', {
            className: 'dcs-btn',
            'data-on': findRegex ? 'true' : 'false',
            title: '正则表达式',
            onClick: function () { setFindRegex(!findRegex); setFindActive(0) },
          }, '.*'),
          h('button', {
            className: 'dcs-btn',
            onClick: function () { goto(-1) },
            disabled: total === 0,
            title: '上一处 (Shift+F3)',
          }, '↑'),
          h('button', {
            className: 'dcs-btn',
            onClick: function () { goto(1) },
            disabled: total === 0,
            title: '下一处 (F3)',
          }, '↓'),
          h('button', {
            className: 'dcs-btn',
            title: '收起查找条 (Esc)',
            onClick: function () { setFindOpen(false) },
          }, '×'))
        : h('div', { className: 'dcs-findpill' },
          h('button', {
            className: 'dcs-btn',
            title: '查找 (Ctrl+F)',
            onClick: function () {
              wantFindFocusRef.current = true
              setFindOpen(true)
            },
          }, '查找'))

      var structurePanel = structureOpen && symbols.length > 0
        ? h('div', { className: 'dcs-structure' },
          h('div', { className: 'dcs-structure-head' },
            h('span', { className: 'dcs-structure-title' }, '结构 (' + rowCount + ')'),
            h('button', {
              className: 'dcs-btn',
              title: '切换排序：位置（源码顺序）→ 类型（类 / 方法 / 变量）→ 名称',
              onClick: function () {
                setStructureSort(sortMode === 'position' ? 'kind' : (sortMode === 'kind' ? 'name' : 'position'))
              },
            }, sortLabel),
            h('button', {
              className: 'dcs-btn',
              title: '收起结构面板',
              onClick: function () { setStructureOpen(false) },
            }, '›')),
          h('div', { className: 'dcs-structure-filter' },
            h('input', {
              className: 'dcs-input',
              value: symbolQuery,
              spellCheck: false,
              autoComplete: 'off',
              placeholder: '筛选结构…',
              onChange: function (event) { setSymbolQuery(event.target.value) },
            })),
          h('div', { className: 'dcs-structure-body' },
            structureRows.length === 0
              ? h('div', { className: 'dcs-note' }, '没有匹配的符号')
              : structureRows))
        : null

      var structureStrip = !structureOpen && symbols.length > 0
        ? h('button', {
          className: 'dcs-structure-collapsed',
          title: '展开结构面板',
          onClick: function () { setStructureOpen(true) },
        }, '‹')
        : null

      return h('div', { className: 'dcs-root' },
        h('div', { className: 'dcs-main' },
          findBar,
          h('div', {
            className: 'dcs-body',
            ref: bodyRef,
            tabIndex: 0,
            onKeyDown: function (event) {
              if (event.key === 'Enter' && total > 0) {
                event.preventDefault()
                goto(event.shiftKey ? -1 : 1)
              }
            },
          },
          binary
            ? h('div', { className: 'dcs-empty' }, '二进制文件，无法预览')
            : (content === ''
              ? h('div', { className: 'dcs-empty' }, '空文件')
              : renderCodeLines({ content: content, lineCount: lineCount }, findResult.byLine, current, showAll, flashLine, anchorLine)),
          binary ? null : (truncated ? h('div', { className: 'dcs-note' }, '文件较大，仅载入前 500KB。') : null),
          findResult.error !== '' ? h('div', { className: 'dcs-note' }, '正则表达式无效：' + findResult.error) : null,
          findResult.truncated ? h('div', { className: 'dcs-note' }, '命中过多，仅统计前 ' + FIND_LIMIT + ' 处。') : null,
          lineCount > WINDOW_THRESHOLD && !showAll
            ? h('div', { className: 'dcs-note' },
              h('button', { className: 'dcs-btn', onClick: function () { setShowAll(true) } }, '显示全文（' + lineCount + ' 行）'))
            : null)),
        structurePanel,
        structureStrip)
    }

    //#endregion

    //#region 注册

    /** 浏览器半的依赖走 deferred inject：没有 better-sidebar 时整个插件静默不生效。 */
    var inject = []

    /**
     * 注册文件预览器（接管 better-sidebar 的预览）。
     * @param {object} ctx - 客户端插件上下文。
     */
    function apply(ctx) {
      injectStyles()
      ctx.effect(function () {
        var handle = ctx.inject(['betterSidebar'], function (injected) {
          var service = null
          try {
            service = injected.get('betterSidebar')
          } catch (error) {
            service = null
          }
          if (!service || typeof service.registerFileViewer !== 'function') return undefined
          var dispose = service.registerFileViewer({
            id: VIEWER_ID,
            title: function () { return '大纲预览' },
            exts: TEXT_EXTS,
            priority: VIEWER_PRIORITY,
            fetchStrategy: 'fsRead',
            component: CodeSearchView,
          })
          return function () {
            if (typeof dispose === 'function') dispose()
          }
        })
        return function () {
          if (handle && typeof handle.dispose === 'function') handle.dispose()
        }
      }, PKG_NAME + ': file viewer')
    }

    //#endregion

    module.exports = {
      name: PKG_NAME,
      inject: inject,
      apply: apply,
      // 测试钩子：纯函数 / 组件，可在无 DOM 环境下用假 React 调用。
      __test: {
        splitByRanges: splitByRanges,
        findInContent: findInContent,
        highlightText: highlightText,
        renderCodeLines: renderCodeLines,
        languageOf: languageOf,
        extractSymbols: extractSymbols,
        filterSymbols: filterSymbols,
        symbolsOfKind: symbolsOfKind,
        buildStructure: buildStructure,
        symbolKindBadge: symbolKindBadge,
        FileView: FileView,
        CodeSearchView: CodeSearchView,
        TEXT_EXTS: TEXT_EXTS,
        VIEWER_ID: VIEWER_ID,
        VIEWER_PRIORITY: VIEWER_PRIORITY,
      },
    }
    return module.exports
  },
})


















