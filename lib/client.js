/**
 * dsh-search-outline — 浏览器半（DSH Web GUI 客户端 bundle）。
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
  id: 'dsh-search-outline',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    /**
     * 宿主 UI 基元（`@deepseek-ai/dsh-client-ui-primitives`）。
     * `MarkdownText` 就是 DSH 聊天消息用的那个 GFM 渲染器，`MarkdownDelegateProvider`
     * 给它挂上「文件链接怎么打开」的回调。取不到时（宿主版本不同 / 测试环境）为 null，
     * markdown 预览退化成源码视图，其它功能不受影响。
     */
    var uiPrimitives = null
    try {
      uiPrimitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      uiPrimitives = null
    }
    var MarkdownText = uiPrimitives && uiPrimitives.MarkdownText ? uiPrimitives.MarkdownText : null
    var MarkdownDelegateProvider = uiPrimitives && uiPrimitives.MarkdownDelegateProvider
      ? uiPrimitives.MarkdownDelegateProvider
      : null

    /**
     * MarkdownText 的 labels 必须身份稳定（它的 memo 依赖 labels 引用，
     * 每次新建对象都会让整棵渲染树重建）。
     */
    var MD_LABELS = {
      code: {
        copyLabel: '复制',
        copiedLabel: '已复制',
        toolbarLabels: {
          codeLabel: '代码块',
          wrapLabel: '自动换行',
          unwrapLabel: '取消自动换行',
        },
      },
      footnotes: '',
    }

    /** 插件包名（ModuleLoader id / 样式标记 / 导出名三处一致）。 */
    var PKG_NAME = 'dsh-search-outline'
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
      '.dcs-tree-icon[data-kind=heading]{color:#7a5cc4}',
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
      // Markdown 渲染预览：排版由宿主 MarkdownText 自带样式，这里只管容器与跳转高亮
      '.dcs-md{flex:1;min-height:0;overflow:auto;padding:10px 14px;',
      'font:var(--dsw-font-sm-14,14px/1.6 ui-sans-serif,system-ui)}',
      '.dcs-mdwrap{display:flex;flex-direction:column;flex:1;min-height:0;outline:none}',
      '.dcs-md-flash{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 18%,transparent);',
      'border-radius:4px}',
      '.dcs-modepill{position:absolute;top:8px;right:8px;z-index:6;display:flex;gap:4px;align-items:center;',
      'padding:4px 6px;border-radius:10px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));',
      'background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 92%,transparent);',
      'backdrop-filter:blur(8px);box-shadow:0 6px 20px rgba(0,0,0,.14)}',
      '.dcs-ctxmenu{position:absolute;z-index:50;min-width:184px;padding:5px;border-radius:12px;',
      'border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.18));',
      'background-color:var(--dsw-alias-bg-layer-1,#fff);background-image:none;',
      'backdrop-filter:blur(6px);box-shadow:0 12px 32px rgba(0,0,0,.24),0 2px 8px rgba(0,0,0,.12);',
      'color:var(--dsw-alias-label-primary,#1f2328);opacity:1}',
      '.dcs-ctxmenu-head{padding:3px 8px 6px;color:var(--dsw-alias-label-secondary,#57606a);',
      'font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:10.5px;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}',
      '.dcs-ctxmenu-item{display:flex;width:100%;box-sizing:border-box;align-items:center;gap:6px;',
      'padding:6px 9px;border:none;border-radius:7px;background:transparent;color:inherit;font:inherit;',
      'font-size:12px;text-align:left;cursor:pointer}',
      '.dcs-ctxmenu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.07))}',
      '.dcs-ctxmenu-item[data-accent=true]{color:var(--dsw-alias-state-business-primary,#4d6bfe);font-weight:600}',
      '.dcs-toast{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);z-index:40;',
      'max-width:calc(100% - 24px);padding:6px 12px;border-radius:999px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));',
      'background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 96%,transparent);',
      'box-shadow:0 8px 24px rgba(0,0,0,.16);font-size:11px;color:var(--dsw-alias-label-primary,#1f2328)}',
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
     * @returns {''|'java'|'js'|'python'|'html'|'markdown'} 语言标识。
     */
    function languageOf(path) {
      var text = typeof path === 'string' ? path.toLowerCase() : ''
      var at = text.lastIndexOf('.')
      var ext = at === -1 ? '' : text.slice(at + 1)
      if (ext === 'java') return 'java'
      if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'jsx' || ext === 'ts' || ext === 'tsx') return 'js'
      if (ext === 'py' || ext === 'pyw') return 'python'
      if (ext === 'html' || ext === 'htm' || ext === 'xhtml' || ext === 'vue' || ext === 'svelte') return 'html'
      if (ext === 'md' || ext === 'markdown') return 'markdown'
      return ''
    }

    /**
     * 抹掉标题里的行内语法，让大纲里的名字和渲染出来的标题文本一致
     * （链接 → 锚文本，图片 → alt，行内代码 / 粗体 / 删除线 → 纯文字）。
     * @param {string} raw - 标题正文（不含前导 `#`）。
     * @returns {string} 纯文本标题。
     */
    function headingTitle(raw) {
      var text = String(raw || '').trim().replace(/\s+#+\s*$/, '')
      text = text.replace(/!\[([^\]]*)\](?:\[[^\]]*\]|\([^)]*\))?/g, '$1')
      text = text.replace(/\[([^\]]*)\](?:\[[^\]]*\]|\([^)]*\))?/g, '$1')
      text = text.replace(/`([^`]+)`/g, '$1')
      text = text.replace(/(\*\*|__)([\s\S]+?)\1/g, '$2')
      text = text.replace(/~~([\s\S]+?)~~/g, '$1')
      return text.trim()
    }

    /**
     * Markdown 标题大纲：ATX（`# 标题`，1–6 级）与 setext（正文 + 下一行全是 `=` / `-`）。
     * 代码围栏（``` / ~~~）内部的 `#` 不是标题；YAML front matter（首行 `---`
     * 到下一个 `---`）整段跳过。`index` 是标题的出现顺序，用来在渲染 DOM 里
     * 按位置匹配（文本匹配失配时的兜底）。
     * @param {Array<string>} lines - 按行切开的源码。
     * @returns {Array<object>} {kind:'heading', name, line, level, index}
     */
    function markdownSymbols(lines) {
      var out = []
      var fence = null
      var inFrontMatter = String(lines[0] || '').trim() === '---'
      var index = 0
      for (var i = 0; i < lines.length; i++) {
        var raw = String(lines[i] || '')
        var trimmed = raw.trim()
        if (inFrontMatter) {
          if (i > 0 && trimmed === '---') inFrontMatter = false
          continue
        }
        var fenceStart = /^(?:`{3,}|~{3,})/.exec(trimmed)
        if (fenceStart !== null) {
          var marker = fenceStart[0].charAt(0)
          if (fence === null) fence = marker
          else if (marker === fence) fence = null
          continue
        }
        if (fence !== null) continue
        var atx = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw)
        if (atx !== null) {
          out.push({ kind: 'heading', name: headingTitle(atx[2]), line: i + 1, level: atx[1].length, container: '', index: index++ })
          continue
        }
        if (trimmed === '') continue
        // 列表项 / 引用 / 分隔线本身都不是 setext 标题的正文
        if (/^(?:[-*+]\s|>\s|#{1,6}\s|[-*_]{3,}\s*$)/.test(trimmed)) continue
        var next = lines[i + 1]
        if (next === undefined) continue
        var underline = String(next).trim()
        if (/^=+$/.test(underline)) {
          out.push({ kind: 'heading', name: headingTitle(trimmed), line: i + 1, level: 1, container: '', index: index++ })
        } else if (/^-+$/.test(underline)) {
          out.push({ kind: 'heading', name: headingTitle(trimmed), line: i + 1, level: 2, container: '', index: index++ })
        }
      }
      return out
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
     * 提取符号（Java / JS / TS / Python / HTML / Markdown；其它格式返回空数组，不影响查找）。
     * Markdown 提取的是标题大纲（ATX 与 setext），层级放在 `level` 上。
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
            : lang === 'markdown'
              ? markdownSymbols(lines)
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
      if (kind === 'heading') return 'H'
      return 'V'
    }

    //#endregion

    //#region 纯函数：选区 → 对话

    /**
     * 选区写进对话时正文的字符上限；超过只放「路径:行号」标签，
     * 避免一次把整份文件灌进草稿。
     */
    var SELECTION_LIMIT = 4000

    /** 转成相对路径（统一用 /）；cwd 不匹配时原样返回绝对路径。 */
    function relativePath(cwd, path) {
      var full = String(path === undefined || path === null ? '' : path).replace(/\\/g, '/')
      if (typeof cwd !== 'string' || cwd === '') return full
      var root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
      if (root === '') return full
      if (full === root) return full.split('/').pop()
      if (full.indexOf(root + '/') === 0) return full.slice(root.length + 1)
      return full
    }

    /** 选区标题：`相对路径:起-止`（单行只带起始行号）。 */
    function selectionHeader(path, cwd, startLine, endLine) {
      var rel = relativePath(cwd, path)
      var from = Math.max(1, Math.floor(Number(startLine)) || 1)
      var to = Math.max(from, Math.floor(Number(endLine)) || from)
      return from === to ? rel + ':' + from : rel + ':' + from + '-' + to
    }

    /** 取源码里的某几行（行号从 1 开始，越界自动夹紧，去掉 CRLF 的 \r）。 */
    function selectLines(content, startLine, endLine) {
      var all = String(content === undefined || content === null ? '' : content).split('\n')
      var from = Math.max(1, Math.floor(Number(startLine)) || 1)
      var to = Math.min(all.length, Math.max(from, Math.floor(Number(endLine)) || from))
      var out = []
      for (var i = from - 1; i < to; i++) out.push(all[i].replace(/\r$/, ''))
      return out.join('\n')
    }

    /** 走 markdown 渲染预览的扩展名（小写、无点）。 */
    var MD_EXTS = ['md', 'markdown']

    /** 这个路径是不是 markdown 文件（决定预览模式是否可用）。 */
    function isMarkdownPath(path) {
      var text = typeof path === 'string' ? path : ''
      var at = text.lastIndexOf('.')
      if (at < 0) return false
      return MD_EXTS.indexOf(text.slice(at + 1).toLowerCase()) !== -1
    }

    /** 数一数前缀里有几个换行（用来把字符偏移换算成行号）。 */
    function countNewlines(text) {
      var n = 0
      for (var i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
      return n
    }

    /**
     * 把渲染预览里选中的文本映射回源码行：先按原样找、再按去空白找，
     * 只有在全文唯一出现时才给行号（渲染会丢掉 `#`、`**` 这类行内标记，
     * 也可能出现多处重复，映射不唯一时返回 null）。
     * @param {string} content - 文件源码。
     * @param {string} selected - 渲染视图里的选区文本。
     * @returns {{start: number, end: number}|null} 行范围（1 起）。
     */
    function linesOfText(content, selected) {
      var text = typeof selected === 'string' ? selected : ''
      var source = typeof content === 'string' ? content : ''
      if (source === '' || text === '') return null
      var needles = [text.trim(), text]
      for (var i = 0; i < needles.length; i++) {
        var needle = needles[i]
        if (needle === '') continue
        var first = source.indexOf(needle)
        if (first === -1) continue
        if (source.indexOf(needle, first + 1) !== -1) continue
        var startLine = countNewlines(source.slice(0, first)) + 1
        var endLine = countNewlines(source.slice(0, first + needle.length)) + 1
        if (endLine < startLine) endLine = startLine
        return { start: startLine, end: endLine }
      }
      return null
    }

    /**
     * 把 markdown 链接的目标展开成能打开的路径：绝对路径原样返回，相对路径按
     * 当前文件所在目录（没有文件路径时按会话工作区）展开并归一化 `.` / `..`，
     * `#` 片段去掉。
     * @param {string} destination - 链接目标。
     * @param {string} docPath - 当前 markdown 文件路径。
     * @param {string} cwd - 会话工作区根目录。
     * @returns {string} 展开后的路径；空目标返回 ''。
     */
    function resolveMarkdownTarget(destination, docPath, cwd) {
      var dest = String(destination === undefined || destination === null ? '' : destination)
      var hashAt = dest.indexOf('#')
      if (hashAt !== -1) dest = dest.slice(0, hashAt)
      dest = dest.replace(/\\/g, '/').replace(/\?$/, '')
      if (dest === '') return ''
      if (dest.charAt(0) === '/' || /^[a-z]:\//i.test(dest)) return dest
      var fromDoc = String(docPath === undefined || docPath === null ? '' : docPath)
      var base = fromDoc === '' ? String(cwd === undefined || cwd === null ? '' : cwd) : fromDoc
      if (base === '') return dest
      var dir = base.replace(/\\/g, '/').replace(/\/+$/, '')
      // 相对当前文件：以它所在目录为基准；相对工作区（没有文件路径时）：以工作区根为基准
      var cut = dir.lastIndexOf('/')
      var parent = fromDoc === '' ? dir : (cut === -1 ? '' : dir.slice(0, cut))
      var joined = parent === '' ? dest : parent + '/' + dest
      var segments = joined.split('/')
      var stack = []
      for (var i = 0; i < segments.length; i++) {
        var segment = segments[i]
        if (segment === '' || segment === '.') continue
        if (segment === '..') { stack.pop(); continue }
        stack.push(segment)
      }
      var result = stack.join('/')
      if (result === '') return ''
      return joined.charAt(0) === '/' ? '/' + result : result
    }

    /**
     * 构造要插进对话的选区：代码围栏 + 「路径:行号」标题；
     * 超过 SELECTION_LIMIT 时退化成只有标题。
     * 预览模式下拿不到源码行号（`startLine` 传 0），标题就只带路径，
     * 正文用渲染出来的选区文本。
     * @param {string} path - 文件路径。
     * @param {string} cwd - 会话工作区根目录。
     * @param {string} content - 文件源码。
     * @param {number} startLine - 起始行（0 = 未知）。
     * @param {number} endLine - 结束行。
     * @param {string=} selectedText - 已知选区文本（预览模式用）。
     * @returns {{header: string, label: string, text: string, raw: string, truncated: boolean}} 选区载荷。
     */
    function buildSelectionInsert(path, cwd, content, startLine, endLine, selectedText) {
      var rel = relativePath(cwd, path)
      var hasLines = Number(startLine) > 0
      var header = hasLines ? selectionHeader(path, cwd, startLine, endLine) : rel
      var raw = typeof selectedText === 'string' && selectedText !== ''
        ? selectedText
        : selectLines(content, startLine, endLine)
      if (raw === '') return { header: header, label: header, text: header, raw: '', truncated: false }
      var truncated = raw.length > SELECTION_LIMIT
      return {
        header: header,
        label: header,
        text: truncated ? header : '```' + header + '\n' + raw + '\n```',
        raw: raw,
        truncated: truncated,
      }
    }

    /** 选区边界所在的代码行元素（找不到时返回 null）。 */
    function lineElementOf(node, body) {
      var element = node
      while (element !== null && element !== undefined && element !== body) {
        if (element.nodeType === 1 && typeof element.getAttribute === 'function' &&
          element.getAttribute('data-line') !== null) {
          return element
        }
        element = element.parentElement
      }
      return null
    }

    /**
     * 解析选区一端的行元素；边界落在容器本身（Ctrl+A 全选）时退化成首行 / 末行。
     * @param {Node} node - 选区端点。
     * @param {Element} body - 代码区容器。
     * @param {'start'|'end'} which - 取首行还是末行。
     */
    function boundaryLineElementOf(node, body, which) {
      var element = lineElementOf(node, body)
      if (element !== null) return element
      if (node !== body || typeof body.querySelectorAll !== 'function') return null
      var lines = body.querySelectorAll('[data-line]')
      if (!lines || lines.length === 0) return null
      return which === 'start' ? lines[0] : lines[lines.length - 1]
    }

    /** 选区 → 源码行范围；拖到下一行行首时那一行不算被选中。 */
    function selectionLineRange(body, range) {
      if (body === null || body === undefined || range === null || range === undefined) return null
      var startElement = boundaryLineElementOf(range.startContainer, body, 'start')
      var endElement = boundaryLineElementOf(range.endContainer, body, 'end')
      if (startElement === null || endElement === null) return null
      var startLine = parseInt(startElement.getAttribute('data-line'), 10)
      var endLine = parseInt(endElement.getAttribute('data-line'), 10)
      if (!isFinite(startLine) || !isFinite(endLine)) return null
      if (endLine < startLine) {
        var swap = startLine
        startLine = endLine
        endLine = swap
      }
      if (endLine > startLine && range.endOffset === 0 && range.endContainer !== body) {
        var endCode = endElement.querySelector('.dcs-code')
        if (endCode !== null && endCode !== undefined && endCode.contains(range.endContainer)) endLine -= 1
      }
      return { start: startLine, end: endLine }
    }

    /** 往草稿追加文本时的前导空白：空草稿不加，末尾不是空白时补一个空格。 */
    function leadFor(draft) {
      if (draft === '') return ''
      return /\s$/.test(draft) ? '' : ' '
    }

    /** 追加后的草稿文本。 */
    function appendText(draft, text) {
      return draft + leadFor(draft) + text
    }

    /**
     * 把 clipboard 投影里的偏移折算成 detect 投影（每个 chip / 命令 token 折成 1 个字符）。
     * @param {string} draft - 草稿（clipboard 投影）。
     * @param {Array<{offset: number, length: number}>} occurrences - chip 区间。
     * @param {number} target - clipboard 投影里的插入位置。
     * @returns {number} detect 投影里的位置。
     */
    function foldClipboardOffset(draft, occurrences, target) {
      var list = Array.isArray(occurrences) ? occurrences : []
      var offset = Math.max(0, Math.min(target, draft.length))
      var shrink = 0
      for (var i = 0; i < list.length; i++) {
        var occurrence = list[i]
        if (!occurrence || typeof occurrence.offset !== 'number') continue
        var start = occurrence.offset
        var length = typeof occurrence.length === 'number' && occurrence.length > 0 ? occurrence.length : 0
        if (length === 0) continue
        var end = start + length
        if (offset <= start) continue
        if (offset >= end) {
          shrink += length - 1
          continue
        }
        return start - shrink + 1
      }
      return offset - shrink
    }

    /** 草稿末尾在 detect 投影里的位置（命令 chip `/xxx ` 只占 1 个字符）。 */
    function appendDetectOffset(snapshot) {
      if (snapshot === null || snapshot === undefined) return 0
      var draft = typeof snapshot.draft === 'string' ? snapshot.draft : ''
      var occurrences = Array.isArray(snapshot.occurrences) ? snapshot.occurrences : []
      var claim = snapshot.claim && typeof snapshot.claim.token === 'string' ? snapshot.claim.token : ''
      if (snapshot.phase === 'claimed' && claim !== '' && draft.indexOf(claim) === 0) {
        var rest = draft.slice(claim.length)
        var shifted = []
        for (var i = 0; i < occurrences.length; i++) {
          var item = occurrences[i]
          if (!item || typeof item.offset !== 'number') continue
          var at = item.offset - claim.length
          if (at < 0) continue
          shifted.push({ offset: at, length: typeof item.length === 'number' ? item.length : 0 })
        }
        return 1 + foldClipboardOffset(rest, shifted, rest.length)
      }
      return foldClipboardOffset(draft, occurrences, draft.length)
    }

    /** 取对话服务（没有安装/还没就绪时返回 null）。 */
    function conversationService(ctx) {
      if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return null
      try {
        var service = ctx.get('conversation')
        if (service === null || service === undefined || !service.input) return null
        return typeof service.input.for === 'function' ? service : null
      } catch (error) {
        return null
      }
    }

    /** 取会话服务：优先属性访问，其次走 ctx.get（未声明 inject 时的兜底）。 */
    function sessionsServiceOf(ctx) {
      if (ctx === null || ctx === undefined) return null
      try {
        if (ctx.sessions !== null && ctx.sessions !== undefined) return ctx.sessions
      } catch (error) {
        // 服务代理可能抛错，继续走 ctx.get
      }
      if (typeof ctx.get !== 'function') return null
      try {
        var service = ctx.get('sessions')
        return service === undefined ? null : service
      } catch (error) {
        return null
      }
    }

    /** 会话作用域上下文（composer 的 `input.for()` 需要它）。 */
    function sessionScopeOf(ctx, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return null
      var sessions = sessionsServiceOf(ctx)
      if (sessions === null || typeof sessions.scope !== 'function') return null
      try {
        var actx = sessions.scope(sessionId)
        return actx === undefined ? null : actx
      } catch (error) {
        return null
      }
    }

    /** 会话工作区（拿不到时返回空串，标题退化成绝对路径）。 */
    function cwdOfSession(ctx, sessionId) {
      try {
        var sessions = sessionsServiceOf(ctx)
        var list = sessions === null ? null : sessions.list
        if (list && typeof list.getSnapshot === 'function') {
          var snapshot = list.getSnapshot()
          var entry = snapshot && snapshot.byId ? snapshot.byId[sessionId] : null
          if (entry) {
            if (typeof entry.cwd === 'string') return entry.cwd
            if (entry.header && typeof entry.header.cwd === 'string') return entry.header.cwd
          }
        }
      } catch (error) {
        // 忽略：拿不到工作区就退化成绝对路径
      }
      return ''
    }

    /** 读草稿快照（服务未就绪时返回 null）。 */
    function readDraftSnapshot(input) {
      if (!input || !input.state || typeof input.state.getSnapshot !== 'function') return null
      try {
        return input.state.getSnapshot()
      } catch (error) {
        return null
      }
    }

    /** 读当前 draftRev（成功后宿主一定会推进 revision）。 */
    function draftRevisionOf(input) {
      var snapshot = readDraftSnapshot(input)
      return snapshot !== null && typeof snapshot.draftRev === 'number' ? snapshot.draftRev : undefined
    }

    /** 按更好的插入位置插一个引用 chip；失败返回 false 交给纯文本兜底。 */
    function insertDraftChip(input, actx, snapshot, chip) {
      if (snapshot === null || typeof snapshot.draftRev !== 'number') return false
      if (typeof input.insertReference !== 'function') return false
      var before = snapshot.draftRev
      var at = appendDetectOffset(snapshot)
      var start = at
      if (leadFor(snapshot.draft) !== '') {
        try {
          // insertReference 只在 chip 后面补空格，前面的空格得自己补。
          actx.emit('slash/input-insert-text', { text: ' ', span: { draftRev: before, start: at, end: at } })
          var afterSpace = readDraftSnapshot(input)
          if (afterSpace === null || afterSpace.draftRev === before) return false
          start = at + 1
        } catch (error) {
          start = at
        }
      }
      var current = readDraftSnapshot(input)
      if (current === null || typeof current.draftRev !== 'number') return false
      var beforeChip = current.draftRev
      var inserted = false
      try {
        inserted = input.insertReference(chip, { draftRev: current.draftRev, start: start, end: start }) === true
      } catch (error) {
        inserted = false
      }
      if (inserted) return true
      // 宿主返回假值也可能已经插进去了：只有 revision 没动才算失败。
      var after = draftRevisionOf(input)
      return typeof after === 'number' && after !== beforeChip
    }

    /** 追加纯文本；没有 chip 时直接 setDraft，有 chip 时走宿主 insert-text。 */
    function appendToDraft(input, actx, snapshot, text) {
      if (snapshot === null) return false
      var draft = typeof snapshot.draft === 'string' ? snapshot.draft : ''
      var occurrences = Array.isArray(snapshot.occurrences) ? snapshot.occurrences : []
      var claimed = snapshot.phase === 'claimed' && snapshot.claim && typeof snapshot.claim.token === 'string'
      if (occurrences.length > 0 || claimed) {
        if (typeof snapshot.draftRev !== 'number') return false
        var at = appendDetectOffset(snapshot)
        try {
          actx.emit('slash/input-insert-text', {
            text: leadFor(draft) + text,
            span: { draftRev: snapshot.draftRev, start: at, end: at },
          })
        } catch (error) {
          return false
        }
        var after = draftRevisionOf(input)
        return typeof after === 'number' && after !== snapshot.draftRev
      }
      if (typeof input.setDraft !== 'function') return false
      try {
        input.setDraft(appendText(draft, text))
        return true
      } catch (error) {
        return false
      }
    }

    /**
     * 把选区写进当前会话的对话输入框（追加到末尾；宿主没有 caret API）。
     * 先试引用 chip（带「路径:行号」标签），宿主不认就退化成纯文本。
     * @returns {{ok: boolean, mode: 'chip'|'text'|'none', error: string}} 结果。
     */
    function insertSelectionIntoComposer(ctx, sessionId, payload) {
      var actx = sessionScopeOf(ctx, sessionId)
      if (actx === null) return { ok: false, mode: 'none', error: '没有可用的会话' }
      var service = conversationService(ctx)
      if (service === null) return { ok: false, mode: 'none', error: '对话服务不可用' }
      var input = null
      try {
        input = service.input.for(actx)
      } catch (error) {
        input = null
      }
      if (!input) return { ok: false, mode: 'none', error: '输入框不可用' }
      var snapshot = readDraftSnapshot(input)
      if (snapshot === null) return { ok: false, mode: 'none', error: '输入框状态不可用' }
      if (snapshot.phase === 'adjudicating' || snapshot.phase === 'submitting') {
        return { ok: false, mode: 'none', error: '正在发送，稍后再试' }
      }
      var chip = {
        source: 'reference',
        ref: payload.text,
        label: payload.label,
        clipboardText: payload.label,
      }
      if (insertDraftChip(input, actx, snapshot, chip)) return { ok: true, mode: 'chip', error: '' }
      var fresh = readDraftSnapshot(input)
      if (appendToDraft(input, actx, fresh, payload.text)) return { ok: true, mode: 'text', error: '' }
      return { ok: false, mode: 'none', error: '写入输入框失败' }
    }

    //#endregion

    //#region 预览组件

    /**
     * 预览组件：better-sidebar 通过 `registerFileViewer` 传入文件内容，
     * 这里把内容交给 FileView（查找 + 符号大纲 + markdown 渲染）。
     * @param {object} props - { ctx, scope, path, title, content, truncated, line }。
     * @returns {object} React 元素。
     */
    function CodeSearchView(props) {
      var scope = props !== null && typeof props === 'object' ? props.scope : undefined
      var sessionId = scope !== null && typeof scope === 'object' && typeof scope.sessionId === 'string'
        ? scope.sessionId
        : ''
      return h(FileView, {
        ctx: props.ctx,
        path: typeof props.path === 'string' ? props.path : '',
        content: typeof props.content === 'string' ? props.content : '',
        truncated: props.truncated === true,
        sessionId: sessionId,
        line: typeof props.line === 'number' ? props.line : 0,
      })
    }

    /**
     * 只读文件视图：常驻查找条 + 符号大纲 + 逐行高亮 + markdown 渲染预览。
     * @param {{path?: string, content?: string, truncated?: boolean, sessionId?: string, ctx?: object, line?: number}} props - 视图属性。
     * @returns {object} React 元素。
     */
    function FileView(props) {
      var path = typeof props.path === 'string' ? props.path : ''
      var content = typeof props.content === 'string' ? props.content : ''
      var truncated = props.truncated === true
      var ctx = props.ctx
      var sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      // better-sidebar 打开文件时可以带行号（聊天里的 #L24 链接、markdown 链接）
      var lineHint = typeof props.line === 'number' && props.line > 0 ? Math.floor(props.line) : 0

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

      var menuState = React.useState(null)
      var menu = menuState[0]
      var setMenu = menuState[1]

      var toastState = React.useState('')
      var toast = toastState[0]
      var setToast = toastState[1]

      // markdown 文件默认进渲染预览；宿主基元取不到时（版本差异）只有源码模式；
      // 带行号打开（聊天里的 #L24 链接）时直接进源码并跳到那一行
      var markdown = isMarkdownPath(path)
      var previewState = React.useState(markdown && MarkdownText !== null && lineHint === 0)
      var previewOn = previewState[0]
      var setPreview = previewState[1]
      var preview = markdown && MarkdownText !== null && previewOn

      var bodyRef = React.useRef(null)
      var mainRef = React.useRef(null)
      var findInputRef = React.useRef(null)
      var flashTimerRef = React.useRef(null)
      var wantFindFocusRef = React.useRef(false)
      var menuRef = React.useRef(null)
      var toastTimerRef = React.useRef(null)
      var mdRef = React.useRef(null)

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

      /**
       * 预览模式里跳到某个标题：宿主渲染出来的 DOM 没有行号，所以先按标题文本
       * 匹配（同一文本多次出现时用大纲里的出现顺序 index 兜底），命中后直接给
       * DOM 加一次性高亮 class，不经过 React state。
       */
      var jumpToHeading = React.useCallback(function (symbol) {
        var box = mdRef.current
        if (box === null || typeof box.querySelectorAll !== 'function') return
        var headings = box.querySelectorAll('h1, h2, h3, h4, h5, h6')
        var want = String(symbol.name || '').toLowerCase()
        var target = null
        var matches = []
        for (var i = 0; i < headings.length; i++) {
          var text = String(headings[i].textContent || '').trim().toLowerCase()
          if (text === want) matches.push(headings[i])
        }
        if (matches.length > 0) {
          target = matches[Math.min(Number(symbol.index) || 0, matches.length - 1)]
        } else if (headings.length > 0) {
          // 文本被行内语法改过（链接/代码）时按层级 + 顺序兜底
          var sameLevel = []
          for (var j = 0; j < headings.length; j++) {
            if (Number(headings[j].tagName) === Number(symbol.level)) sameLevel.push(headings[j])
          }
          target = sameLevel.length > 0
            ? sameLevel[Math.min(Number(symbol.index) || 0, sameLevel.length - 1)]
            : headings[0]
        }
        if (target === null) return
        if (typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }
        target.classList.add('dcs-md-flash')
        setTimeout(function () { target.classList.remove('dcs-md-flash') }, 1600)
      }, [])

      /** 大纲点击：预览模式下标题滚到渲染位置，其它符号退回源码再跳行。 */
      var jumpToSymbol = React.useCallback(function (symbol) {
        if (preview && symbol.kind === 'heading') {
          jumpToHeading(symbol)
          return
        }
        if (preview) setPreview(false)
        jumpToLine(symbol.line)
      }, [preview, jumpToHeading, jumpToLine])

      /** markdown 链接点击：本地目标开侧栏文件（会再次进我们的 viewer）。 */
      var openMarkdownFile = React.useCallback(function (destination, options) {
        var target = resolveMarkdownTarget(destination, path, cwdOfSession(ctx, sessionId))
        if (target === '') return
        var line = options && typeof options.line === 'number' ? options.line : undefined
        var service = null
        try {
          service = typeof ctx.get === 'function' ? ctx.get('betterSidebar') : null
        } catch (error) {
          service = null
        }
        if (service === null || typeof service.openTab !== 'function') {
          showToast('打开失败：侧边栏服务不可用')
          return
        }
        var title = target.split('/').pop()
        try {
          service.openTab({
            type: 'editor',
            title: title,
            path: target,
            id: 'editor:' + target,
            line: line === undefined ? undefined : line,
          })
        } catch (error) {
          showToast('打开失败：' + String(error && error.message ? error.message : error))
        }
      }, [ctx, sessionId, path, showToast])

      var openExternalLink = React.useCallback(function (url) {
        if (typeof window === 'undefined' || typeof window.open !== 'function') return
        try {
          window.open(String(url), '_blank', 'noopener')
        } catch (error) {
          showToast('外链打开失败')
        }
      }, [showToast])

      /** 换文件时重新决定模式（md → 预览，其它 → 源码）；带行号就进源码并跳到该行。 */
      React.useEffect(function () {
        setPreview(isMarkdownPath(path) && MarkdownText !== null && lineHint === 0)
        if (lineHint > 0) jumpToLine(lineHint)
        return undefined
      }, [path, lineHint, jumpToLine])

      /** 高亮只在源码行上成立：有查找词就切回源码。 */
      React.useEffect(function () {
        if (findQuery !== '' && preview) setPreview(false)
        return undefined
      }, [findQuery, preview])

      var focusFind = React.useCallback(function () {
        if (findInputRef.current === null) return
        findInputRef.current.focus()
        findInputRef.current.select()
      }, [])

      /** 底部提示（2.2 秒后自动消失）。 */
      var showToast = React.useCallback(function (text) {
        setToast(text)
        if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
        toastTimerRef.current = setTimeout(function () { setToast('') }, 2200)
      }, [])

      /**
       * 在代码区右键：有选区就接管菜单，给出「添加到对话 / 复制选区」。
       * 没有选区时保留浏览器原生菜单（复制、检查等）。
       */
      var openSelectionMenu = React.useCallback(function (event) {
        var body = bodyRef.current
        if (body === null || typeof window === 'undefined' || typeof window.getSelection !== 'function') return
        var selection = window.getSelection()
        if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
          setMenu(null)
          return
        }
        var range = selection.getRangeAt(0)
        if (typeof body.contains !== 'function' || !body.contains(range.commonAncestorContainer)) {
          setMenu(null)
          return
        }
        var span = selectionLineRange(body, range)
        var selected = typeof selection.toString === 'function' ? selection.toString() : ''
        if (span === null && !preview) {
          setMenu(null)
          return
        }
        // 预览模式没有 data-line：把渲染出来的选区文本映射回源码行；
        // 映射不唯一（或渲染改写了行内语法）时标题只带路径，正文用选区文本。
        var mapped = span !== null ? span : linesOfText(content, selected)
        if (typeof event.preventDefault === 'function') event.preventDefault()
        var payload = buildSelectionInsert(
          path,
          cwdOfSession(ctx, sessionId),
          content,
          mapped === null ? 0 : mapped.start,
          mapped === null ? 0 : mapped.end,
          span === null ? selected : undefined,
        )
        if (payload.raw === '') {
          setMenu(null)
          return
        }
        var x = typeof event.clientX === 'number' ? event.clientX : 8
        var y = typeof event.clientY === 'number' ? event.clientY : 8
        // 菜单是 .dcs-main 里的 absolute 元素：把视口坐标换算成本地坐标，
        // 这样即使外层容器带 transform（fixed 会被它劫持）也不会跑偏。
        var main = mainRef.current
        var mainRect = main !== null ? main.getBoundingClientRect() : null
        var offsetLeft = mainRect !== null ? mainRect.left : 0
        var offsetTop = mainRect !== null ? mainRect.top : 0
        var boxWidth = mainRect !== null ? mainRect.width : 320
        var boxHeight = mainRect !== null ? mainRect.height : 400
        // 贴边时把菜单收回容器内，避免被裁掉
        var width = 200
        var height = 96
        x = Math.max(8, Math.min(x - offsetLeft, boxWidth - width - 8))
        y = Math.max(8, Math.min(y - offsetTop, boxHeight - height - 8))
        setMenu({ x: x, y: y, payload: payload })
      }, [ctx, sessionId, path, content])

      /** 把当前选区写进对话输入框（追加在草稿末尾）。 */
      var addSelectionToConversation = React.useCallback(function () {
        var current = menu
        setMenu(null)
        if (current === null) return
        var result = insertSelectionIntoComposer(ctx, sessionId, current.payload)
        if (result.ok) showToast(result.mode === 'chip' ? '已添加到对话输入框' : '已添加到对话输入框（文本）')
        else showToast('添加失败：' + result.error)
      }, [menu, ctx, sessionId, showToast])

      /** 复制选区源码（不带行号，也不带围栏）。 */
      var copySelection = React.useCallback(function () {
        var current = menu
        setMenu(null)
        if (current === null || current.payload.raw === '') return
        var fallback = function () {
          // 菜单的 mousedown 阻止了默认行为，选区还在：可以直接让浏览器复制它
          try {
            if (document.execCommand('copy') === true) {
              showToast('已复制选区')
              return
            }
          } catch (error) {
            // 落到下面的失败提示
          }
          showToast('复制失败')
        }
        if (typeof navigator === 'undefined' || !navigator.clipboard ||
          typeof navigator.clipboard.writeText !== 'function') {
          fallback()
          return
        }
        try {
          navigator.clipboard.writeText(current.payload.raw).then(function () {
            showToast('已复制选区')
          }, fallback)
        } catch (error) {
          fallback()
        }
      }, [menu, showToast])

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
          if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
        }
      }, [])

      // 右键菜单：点外面 / Esc / 文本区滚动 都关掉它。
      React.useEffect(function () {
        if (menu === null) return undefined
        var onDown = function (event) {
          var box = menuRef.current
          if (box !== null && event && event.target && typeof box.contains === 'function' &&
            box.contains(event.target)) return
          setMenu(null)
        }
        var onKey = function (event) {
          if (event.key === 'Escape') setMenu(null)
        }
        var body = bodyRef.current
        var onScroll = function () { setMenu(null) }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey)
        if (body !== null && typeof body.addEventListener === 'function') body.addEventListener('scroll', onScroll)
        return function () {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey)
          if (body !== null && typeof body.removeEventListener === 'function') body.removeEventListener('scroll', onScroll)
        }
      }, [menu])

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
            // 高亮只在源码行上成立：查找前先退回源码模式
            if (preview) setPreview(false)
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
      }, [findOpen, findQuery, goto, focusFind, preview])

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
      var kindOrder = ['heading', 'class', 'method', 'variable', 'element']
      var kindNames = { heading: '标题', class: '类', method: '方法', variable: '变量', element: '元素' }
      var byLine = function (a, b) { return a.line - b.line }
      var byName = function (a, b) { return String(a.name).localeCompare(String(b.name)) }

      var treeRow = function (key, symbol, indented) {
        return h('button', {
          key: key,
          type: 'button',
          className: 'dcs-tree-row',
          style: symbol.kind === 'heading'
            ? { paddingLeft: String(Math.max(0, Number(symbol.level) - 1) * 8 + 4) + 'px' }
            : (indented ? { paddingLeft: '18px' } : undefined),
          title: (symbol.container === '' || symbol.container === undefined ? '' : symbol.container + ' · ') + symbol.name + '（第 ' + symbol.line + ' 行）',
          onClick: function () { jumpToSymbol(symbol) },
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

      /** 预览 ⇄ 源码 切换按钮（只有 markdown 文件且宿主基元可用时才出现）。 */
      var modeButton = markdown && MarkdownText !== null
        ? h('button', {
          className: 'dcs-btn',
          'data-on': preview ? 'true' : 'false',
          title: preview ? '切换到源码（可编辑、按行高亮查找）' : '切换到 markdown 渲染预览',
          onClick: function () { setPreview(!preview) },
        }, preview ? '源码' : '预览')
        : null

      /** 预览容器同时充当选区容器：右键菜单要能在渲染文本上工作。 */
      var attachMdRef = React.useCallback(function (element) {
        mdRef.current = element
        bodyRef.current = element
      }, [])

      var markdownBody = preview && !binary && content !== ''
        ? h('div', { className: 'dcs-md', ref: attachMdRef, tabIndex: 0, onContextMenu: openSelectionMenu },
          MarkdownDelegateProvider !== null
            ? h(MarkdownDelegateProvider, {
              openFile: openMarkdownFile,
              openExternalLink: openExternalLink,
            }, h(MarkdownText, { text: content, labels: MD_LABELS, variant: 'body' }))
            : h(MarkdownText, { text: content, labels: MD_LABELS, variant: 'body' }))
        : null

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
          modeButton,
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
          }, '查找'),
          modeButton)

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

      var menuPanelStyle = {
        position: 'absolute',
        left: menu === null ? 0 : menu.x,
        top: menu === null ? 0 : menu.y,
        zIndex: 50,
        minWidth: '184px',
        padding: '5px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.18))',
        // 用不透明的 surface 色：菜单浮在代码上，半透明会看不清字
        backgroundColor: 'var(--dsw-alias-bg-layer-1, #fff)',
        backgroundImage: 'none',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        boxShadow: '0 12px 32px rgba(0,0,0,.24), 0 2px 8px rgba(0,0,0,.12)',
        // 别被外层的半透明遮罩 / 动画影响
        opacity: 1,
      }
      var menuHeadStyle = {
        padding: '3px 8px 6px',
        color: 'var(--dsw-alias-label-secondary, #57606a)',
        fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
        fontSize: '10.5px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: '260px',
      }
      var menuItemStyle = {
        display: 'flex',
        width: '100%',
        boxSizing: 'border-box',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 9px',
        border: 'none',
        borderRadius: '7px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        textAlign: 'left',
        cursor: 'pointer',
      }

      var menuElement = menu === null
        ? null
        : h('div', {
          className: 'dcs-ctxmenu',
          ref: menuRef,
          style: menuPanelStyle,
          onMouseDown: function (event) {
            // 保住选区，点菜单项时浏览器才不会先清空它
            if (event && typeof event.preventDefault === 'function') event.preventDefault()
          },
        },
        h('div', { className: 'dcs-ctxmenu-head', style: menuHeadStyle, title: menu.payload.header }, menu.payload.header),
        h('button', {
          type: 'button',
          className: 'dcs-ctxmenu-item',
          style: Object.assign({}, menuItemStyle, { color: 'var(--dsw-alias-state-business-primary, #4d6bfe)', fontWeight: 600 }),
          'data-accent': 'true',
          title: '把选区追加到对话输入框末尾',
          onClick: addSelectionToConversation,
        }, menu.payload.truncated ? '添加到对话（仅位置）' : '添加到对话'),
        h('button', {
          type: 'button',
          className: 'dcs-ctxmenu-item',
          style: menuItemStyle,
          title: '复制选区源码',
          onClick: copySelection,
        }, '复制选区'))

      var toastElement = toast === ''
        ? null
        : h('div', { className: 'dcs-toast' }, toast)

      return h('div', { className: 'dcs-root' },
        h('div', { className: 'dcs-main', ref: mainRef },
          findBar,
          markdownBody !== null
            ? h('div', { className: 'dcs-mdwrap', tabIndex: 0 },
              markdownBody,
              truncated
                ? h('div', { className: 'dcs-note' }, '文件较大，仅载入前 500KB，预览也只渲染这部分。')
                : null)
            : h('div', {
            className: 'dcs-body',
            ref: bodyRef,
            tabIndex: 0,
            onContextMenu: openSelectionMenu,
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
            : null),
          menuElement,
          toastElement),
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
        headingTitle: headingTitle,
        markdownSymbols: markdownSymbols,
        isMarkdownPath: isMarkdownPath,
        resolveMarkdownTarget: resolveMarkdownTarget,
        linesOfText: linesOfText,
        MD_EXTS: MD_EXTS,
        relativePath: relativePath,
        selectionHeader: selectionHeader,
        selectLines: selectLines,
        buildSelectionInsert: buildSelectionInsert,
        selectionLineRange: selectionLineRange,
        leadFor: leadFor,
        appendText: appendText,
        foldClipboardOffset: foldClipboardOffset,
        appendDetectOffset: appendDetectOffset,
        insertSelectionIntoComposer: insertSelectionIntoComposer,
        SELECTION_LIMIT: SELECTION_LIMIT,
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


















