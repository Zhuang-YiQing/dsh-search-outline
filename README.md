# dsh-search-outline

DSH（DeepSeek Harness）右栏 **文件预览增强**插件：形态和 code-nav 一样 ——
**接管 better-sidebar 的文件预览**，在预览内部直接给：

- 🔍 **漂浮查找条**：平时收成左上角一个「查找」小泡泡；点它或按 `Ctrl+F` 唤出并聚焦。
  字面量 / 正则 / 区分大小写，全部命中高亮、当前命中加深、`n/m` 计数、`↑` `↓` / `Enter` / `Shift+Enter` 上下跳；
  `×` 或 `Esc` 收起。查找条是**悬浮**的，只在显示时盖住顶上一条，不占代码区；
- 🧭 **右侧「结构」面板**（IDEA Structure 风格，Java / JavaScript / TypeScript / Python / HTML）：
  停靠在预览区右侧（不覆盖代码，代码区自动让出宽度），**类 / 方法 / 变量三类一直一起显示**
  （类节点下挂成员，可折叠），顶部可按名称筛选；点条目跳到该行并闪烁。
  变量只取**文件级**（Java 类字段、Python 模块变量、JS 顶层变量），方法内的局部变量不列；
  HTML（`.html/.htm/.xhtml/.vue/.svelte`）给**元素大纲**：结构标签 + 带 `id`/`class` 的标签，
  名字形如 `div#app.container`，点一下跳到该标签所在行；
  面板右上 `›` 收起成 24px 窄条，点窄条 `‹` 重新展开；
- 📄 **所有文本格式都能搜**：代码、配置、Markdown、日志、CSV、无扩展名文件……
  不挑扩展名；图片 / PDF / Office 等二进制仍交给 better-sidebar 自己的查看器；
- ✍️ **选中即加入对话**：在代码区选中一段（可跨行）→ 右键 →「添加到对话」，
  选区带「`路径:行号`」标题插进当前会话的输入框；右键菜单里还有「复制选区」。

**没有独立 tab**：不注册「搜索」页，也没有「搜索视图」页 —— 打开文件就是搜索视图。

## 和 code-nav 的关系

| | code-nav | 本插件 |
| --- | --- | --- |
| 接管范围 | 代码 + 常见配置扩展名 | **所有文本扩展名**（含 `.md/.txt/.log/.css/.html`、无扩展名） |
| 查找 | 常驻查找框（无 Ctrl+F、无正则） | 漂浮查找条 + **Ctrl+F** + **正则** |
| 符号 | 多语言（下拉列表） | Java / JS / TS / Python（右侧结构树） |
| 选区入对话 | ✗ | ✓ 右键 →「添加到对话」（引用 chip，带 `路径:行号`） |
| 只读 | 是 | 是 |

两者注册的是同类预览器，本插件优先级更高（50 > 10），所以**同时装也只会有本插件生效**。
装了 code-nav 的话建议在 better-sidebar 设置 →「侧边卡片」→「文件预览」里把「代码预览导航」那张卡片关掉，免得占着开关位看不清谁在生效。

## 安装

前置：DSH Desktop（或 `dsh web`）已在跑，profile 名为 `desktop`，且已装 **dsh-better-sidebar**
（本插件的预览器挂在他的 `ctx.betterSidebar` 服务上，没有它时插件静默不生效）。

### 方式 0：从 GitHub 克隆（推荐）

```powershell
git clone git@github.com:Zhuang-YiQing/dsh-search-outline.git D:/dsh/myplugin/dsh-search-outline
cd D:/dsh/myplugin/dsh-search-outline
pwsh -File scripts/install.ps1
```

### 方式 A：脚本（推荐，幂等）

```powershell
pwsh -File scripts/install.ps1                          # 默认 desktop
pwsh -File scripts/install.ps1 -ProfileName web         # 或指定 profile
```

脚本从 `package.json` 读包名，只做两件事：在 `<profile>/node_modules` 建一个指向本仓库的目录联接，
在 `<profile>/cordis.patch.yml` 追加一段带标记的挂载行。**不改** `package.json` / `pnpm-lock.yaml`。
撤销：`pwsh -File scripts/uninstall.ps1`。

装完**必须重启 DSH**（宿主半要重新加载），然后浏览器硬刷新（Ctrl+Shift+R）。

### 方式 B：官方 CLI

```powershell
dsh plugin --profile desktop add link:D:/dsh/myplugin/dsh-search-outline
```

走这条通道时**不要**再用方式 A 的挂载行（插件自带的 `dsh.bundle.patch` 会挂载，双挂载会报重复 id）。

### 方式 C：手动

1. 建目录联接（同方式 A 的第一步，目录名用 `dsh-search-outline`）；
2. 编辑 `~/.dsh/profiles/desktop/package.json`：`dependencies` 加
   `"dsh-search-outline": "link:D:/dsh/myplugin/dsh-search-outline"`，`dsh.profile.bundles` 末尾加 `"dsh-search-outline"`；
3. 在 profile 目录跑一次 `pnpm install`；
4. 重启 DSH，硬刷新浏览器。

## 使用

1. 右栏「文件」树里点开任意文件（或从聊天里的文件链接打开）；
2. 代码区始终是主体：
   - 左上角默认只有一个「查找」小泡泡；点它或按 `Ctrl+F` 展开为漂浮查找条
     （文件名 + 输入框 + `n/m` + `Aa` + `.*` + ↑ ↓ + `×`）；
   - 右侧停靠结构面板（Java / JS / TS / Python / HTML），代码区自动让出 210px 宽度，**不覆盖代码**；
3. `Ctrl+F` 展开并聚焦查找条，`Esc` 收起；输入框内 `Enter` / `Shift+Enter` 上下跳；
4. 结构面板：类行可折叠（`▸/▾`），点类或成员 → 跳到该行并闪烁 1.6 秒；
   顶部输入框按名称筛选；右上 `›` 收起成窄条，点窄条 `‹` 重新展开。
5. 结构面板标题栏的排序按钮可在三种模式间循环（与筛选叠加）：
   - **位置**（默认）：源码顺序，类下挂成员；
   - **类型**：分成「类 / 方法 / 变量 / 元素」几段（HTML 只有「元素」），段内按行号；
     每个段标题左侧的 `▾/▸` 可以单独展开 / 收起该段（默认展开，`结构 (N)` 只统计当前可见行）；
   - **名称**：类与成员都按名称字母序。

### 把选区加进对话

1. 在代码区**拖选**要用的片段（可以跨行；行号列不会被带进去）；
2. 在选区上**右键** → 菜单顶部显示这次的 `路径:起-止`，下面两项：
   - **添加到对话**：把选区追加到当前会话输入框的**末尾**（草稿已有内容时自动补一个空格）；
   - **复制选区**：只复制源码，不带行号和围栏。
3. 插入成功后代码区底部会闪一条「已添加到对话输入框」提示。

插入形态与 better-sidebar 自带的「加入对话」一致：输入框里是一个引用 chip，
标签是 `src/a.js:12-15`，发送时展开为带围栏的代码块：

````text
```src/a.js:12-15
…选中的源码…
```
````

行为细节：

| 情况 | 结果 |
| --- | --- |
| 选区超过 4000 字符 | 只插「`路径:起-止`」这一行位置标签（菜单项会显示「仅位置」），避免把整份文件灌进草稿 |
| 宿主没有引用 chip 通道 | 自动退化成纯文本（同样的围栏内容），提示会写明「（文本）」 |
| 输入框里已经挂了 chip | 走宿主的插入通道，不会把已有 chip 拍平成文本 |
| 正在发送消息 | 拒绝插入并提示「正在发送，稍后再试」 |

> 插入位置固定在**草稿末尾**：宿主 composer 没有暴露 caret API，无法插到光标处。

## 开关与回退

预览器在 better-sidebar 设置页 **「侧边卡片」→「文件预览」→「大纲预览」** 里有独立开关：

- 关掉它 → 这些文件回退到 better-sidebar 自带查看器（代码文件是可编辑的 CodeMirror）；
- 想看 Markdown / HTML 的**渲染**效果（而不是源码）时，也可以临时关掉本插件。

> 本插件是**只读**预览：它接管后这些文件不能在右栏里编辑。要编辑就关掉「大纲预览」。

## 已知边界

- 结构面板是**逐行启发式解析**（不是编译器精度），只覆盖 Java / JS / TS / Python / HTML；
  HTML 给元素级大纲（结构标签 + 带 `id`/`class` 的标签），内联 `<script>` 里的 JS 额外展开为方法 / 变量，
  行号与原文一一对应；
  Java 支持注解、多行参数列表、带空格的泛型返回类型；变量只取类级字段（方法内局部变量不列）；
- 大文件只显示前 500KB（better-sidebar 的读取上限），超出部分不参与查找；
- 超过 1200 行时默认只渲染当前命中附近，可点「显示全文」；
- 单次查找最多统计 20000 处命中；
- 二进制文件（含 NUL 字节）显示提示，不渲染；
- 「添加到对话」只能追加到**草稿末尾**（宿主未暴露 caret API）；选区上限 4000 字符，超过只放位置标签；
- 宿主半 `lib/index.js` 的工作区搜索接口（`/api/code-search/*`）目前**保留但未使用**，
  供以后做「文件名/内容全局搜索」时复用；它仅接受回环请求，路径经 realpath 校验限制在会话工作区内。

## 目录结构

```
lib/client.js   浏览器半：文件预览器（查找条 + 右侧结构面板 + 高亮 + 选区入对话），手写 ModuleLoader bundle
lib/index.js    宿主半：/api/code-search/*（当前未使用，保留）
lib/search.js   宿主半检索核心（当前未使用，保留）
scripts/        install.ps1 / uninstall.ps1（包名自动取自 package.json，幂等）
test/           单测：浏览器半 30 项 + 宿主 16 项（search 8 / plugin 8）
```

## 测试

```powershell
node test/client.test.mjs
node test/search.test.mjs
node test/plugin.test.mjs
```

> 在 DSH 沙箱里请**直接跑这几个文件**，不要用 `node --test`：测试运行器会 spawn 子进程并用管道收输出，
> 沙箱下会 `EPERM`。普通终端里 `npm test` 也可以。
