# 项目进度

每完成一步就更新这份文档：勾掉已完成的条目，写上提交号和测试数量。

- 最后更新：2026-11-09
- 测试：422 个，全部通过（`npm test`）

---

## 里程碑总览

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 仓库骨架、命令行入口、JSON 数据格式、fixture | ✅ 完成 |
| M1 | history 模块：引入、引用时间线、失去引用 | ✅ 完成（d4a518a） |
| M2 | report：从 JSON 生成 Markdown 报告、文件头注释 | ✅ 完成（06c07de） |
| M3 | scan：用 knip 采集「从入口走不到」的文件，生成候选清单 | ✅ 第一版完成（待提交） |
| M4 | rules：9 种状态的判定规则，补齐 fixture | ✅ 第一批（306951b～3df184c）；第二批 pending 完成；internal 随导出维度一起做 |
| M5 | verify：临时目录实删，和构建 / 测试基线对比 | ✅ ① 试跑基线（fe163a1）、② 删除对比 + 定位（3a34279） |
| M6 | 接入第二个项目（Vue3 + TS） | ✅ findip-portal-web 全流程跑通 |
| M7 | 接口维度、quarantine、打包成 tgz | ⏳ 未开始 |

---

## M0 仓库骨架 ✅

- [x] README、.gitignore（公司数据不入库）
- [x] 命令行入口 `bin/code-audit.js`，5 个子命令空壳
- [x] 数据格式 `src/core/schema.js`：9 种状态（按优先级排列）、6 个标签、6 种引用方式、完整字段校验
- [x] 完整样例 `test/samples/full.json`
- [x] fixture：basic、commented-import、intra-call

## M1 history ✅

- [x] `findIntroduced`：文件最初加入的提交，跟踪改名（`--follow`）
- [x] `buildTimeline`：主线快照对比，处理合并提交、注释掉的引用
- [x] `findLostRef`：从时间线推出失去引用的提交，拒绝不完整的时间线
- [x] `stripComments`：去掉注释，识别字符串、模板字符串、正则
- [x] 错误处理：只有「没有匹配」才返回空，其他 git 错误都抛出
- [x] `traceHistory`：把三部分组合成 schema 里的 History 结构，不传 pattern 时由文件最初的路径推出
- [x] `code-audit history` 命令：参数解析，输出 JSON
- [x] 用 finicr-web 的 13 个隔离文件实际跑一遍，和手写的头注释对比
  - 26 项中 18 项一致；其余 8 项原因已查明：4 项是规则差异（按主线取合并提交），3 项是工具的已知限制（同目录相对路径），1 项是当初手写有误
  - 详细对照只留在本机：`test/golden/finicr-web-history.md`
  - 实测发现 6 个问题并已修复：非代码文件被当成引用方、没认出来的移动、把复制当成历史、
    删除后重新加入只取到最近一次、引入没统一看主线、默认 pattern 的空格和 /index

**规则约定**：引入、时间线、失去引用都只看主线（first-parent）。文件在分支上写的，
引入会显示为合并进主线的那个提交，而不是分支上的提交。

## M2 report ✅

- [x] 步骤 1：schema 新增可选字段 `notes`（人工补充的风险说明）
- [x] 步骤 2：格式化工具 `src/report/format.js`：提交显示、注释与表格转义、时间线分组
- [x] 步骤 2.5：配置层 `src/core/config.js`：默认值、合并、校验（拼错的配置项会报错）；`profiles/example.js`
- [x] 步骤 2.6：写死的项改为读配置：`sourceRoots`（推 pattern）、`extensions`（找引用）、`shortHashLength`；history 命令支持 `--profile`
- [x] 步骤 3：生成文件头注释（c14750b）
  - 标题、结尾提示、状态文案、各文件类型的注释格式都来自配置；默认文案只陈述事实，不含流程要求
  - JS 类文件用 `/** */`，.vue / .svelte 用 `<!-- -->`；不能写注释的类型（.json、.html 等）直接报错
- [x] 步骤 4：生成隔离清单表格（da4f74d）
  - 显示哪些列、列的顺序（`tableColumns`）、列标题（`columnTitles`）都来自配置
  - 没有 history 的项显示「未查询」，不猜
- [x] 步骤 5：生成排查报告（4e217e0）
  - 概况 → 状态汇总（按优先级、只列出现过的状态）→ 清单表格 → 每项详情（证据、引用、历史、验证、备注）
  - 输入先校验，不符合格式就报错，不生成半成品
- [x] 步骤 6：history 批量模式 `history --in 候选清单 --out 结果.json`
  - 候选清单校验：拼错的字段名、重复文件、带 `..` 的路径都会报错
  - 逐个查历史，组装成符合 schema 的完整数据；任何一个文件失败，整批失败并列出所有错误
  - 提交名换成完整提交号，整批都按这个提交查；history 里记下搜索用的 pattern，报告里显示
- [x] 步骤 7：`report --in 结果.json --out 目录`，生成 report.md、quarantine-table.md、headers/<路径>.txt
  - 先在内存里生成全部内容，成功后才写盘；生成不了头注释的项跳过并说明原因
  - 输出不能写在被分析的仓库里（按真实路径判断，符号链接绕不过去）；输出文件已存在、输出目录不为空时报错，不覆盖、不删除
  - 先写到同级临时位置，全部写完再一次性改名：中途出错不留下半成品
  - 验收：两个目录结构、约定都不同的项目完整跑通（`test/acceptance.test.js`）
  - 真实项目：13 个文件完整跑通，约 34 秒；结果与上一版一致，生成的头注释与手写版关键信息一致
    （本机：`test/golden/finicr-web-run/`）

**新规则**：schema 里的路径不允许出现 `..` 这一级。项目内的路径用不到它，而按路径生成输出文件时它会让文件写到输出目录外面。

## M3 scan ✅

### 试用 knip（2026-11-09）

knip 6.44.2 装在 `.tmp/knip-spike/`（不入库），从外部用 `--directory` 指向目标项目、`--config` 指向外部配置；
入口、别名都由我们在外部配置里写，关掉 vite 等会执行项目代码的插件。跑完目标仓库 `git status` 和提交号都没变。
逐个文件的结果只留在本机：`test/golden/knip-spike.md`。

**真实项目（Vue2 + Vite，约 700 个 js/vue 文件）**

| 检查项 | 结果 |
|---|---|
| 速度 | 文件、导出各一次，每次不到 1 秒 |
| 漏报 | 13 个已隔离文件全部找出 |
| `.vue` 文件 | 内置处理，`<script>` 里的 import 都识别了 |
| `@/` 别名、路由懒加载 `() => import('@/...')` | 正确 |
| 同目录相对引用 | 正确（正好补上 history 的已知缺陷） |
| 注释掉的 import | 正确地当作没引用 |
| 重名文件（不同目录的同名组件） | 正确区分 |
| `import.meta.glob` | **不支持**：49 个被批量加载的文件被误报 |
| 构建配置里的引用（vite 别名指向的文件） | 看不到（插件被我们关了），被误报 |
| 测试入口 | 加不加测试入口各跑一次，结果一减就得到「只被测试用到」的文件（4 个） |

**fixture**：「有没有人用」全部正确，但不区分原因。`dead` 和 `dead-only-ref`、被注释停用的文件、
文件内部在调用的导出（`internal`）和真没人用的导出，knip 都只报「未使用」。

### 结论

knip 适合做**采集**，状态判定仍由我们的规则层做（M4）。knip 不回答的问题：

| 问题 | 由谁补 |
|---|---|
| `import.meta.glob` / `require.context` 批量加载 | scan：把 glob 展开成入口传给 knip |
| 构建配置、index.html 里的引用（`external`） | 规则层：搜构建配置文件 |
| 注释停用（`dormant`） | 规则层：已有的去注释比对 |
| 只被死代码引用（`dead-only-ref`） | 需要引用关系图：knip 的结果里没有「谁引用了谁」，要另想办法 |
| 文件内部在调用（`internal`） | 规则层：文件内调用链 |
| 拼接路径的动态 import（`unknown`） | 规则层：这个项目里没有，用 fixture 覆盖 |

### 方案：knip 作为可选依赖（2026-11-09 确定）

- knip 写进 code-audit 的 `optionalDependencies`，版本固定（6.44.2）：安装 code-audit 时自动装上，同一个项目每次扫描结果稳定
- 不能打包进单文件：knip 有按平台编译的二进制文件（共约 55MB），只能由 npm 按平台安装
- 原则调整：「零运行时依赖」改为「核心零依赖，采集可以借助外部分析工具」。只有 scan 需要 knip
- `--knip <目录>` 可以指定另一个 knip 安装

### 实现

- [x] 配置新增 `entries`、`testEntries`、`aliases`、`scanIgnore`。入口和别名没有默认值：猜错会把在用的文件当成没人用
- [x] `src/collect/knip.js`：查找 knip、生成配置、调用、核对启用的插件、解析结果
  - 配置和结果写在系统临时目录，用完删除；不开缓存（缓存默认写在目标项目的 node_modules 里）
  - 关掉全部插件，只保留解析 `.vue` / `.svelte` / `.astro` 的插件，并且不让它们读配置文件、不加入口
  - 插件列表读 knip 的内部列表（knip 校验配置用的就是它，写了不认识的插件名会拒绝整个配置），读不到时退回 schema.json
  - 跑完从调试输出里核对实际启用的插件，有名单外的就报错、不输出结果
  - 目录传真实路径：经过符号链接的目录（如 macOS 的 /var → /private/var）会让 knip 把所有文件都误报为走不到
- [x] `src/collect/glob-imports.js`：`import.meta.glob` 换算成入口
  - 支持相对路径、`/` 开头、别名、数组、`!` 排除；参数不是字符串字面量时记警告，不猜
  - `.vue` 等只看 `<script>`：模板里的撇号会让去注释把后面的代码当成字符串
  - `require.context` 交给 dynamic-imports（M4）
- [x] `src/collect/scan.js`：只用项目入口跑一次；配置了测试入口时再跑一次，两次一比得到「只有测试用到」
  - 测试文件本身、`scanIgnore` 匹配的文件不列为候选
- [x] `src/collect/snapshot.js`：分析提交里的代码（默认 HEAD，`--rev` 可指定），不看工作区
  - 用临时索引（`GIT_INDEX_FILE`）读入提交，把配置扩展名的文件、入口、根目录的 package.json / tsconfig.json / jsconfig.json 导出到系统临时目录，用完删除
  - 不碰目标仓库的工作区、暂存区和分支；提交里没有 package.json 时在临时目录补一个空的（knip 要求有）
  - 提交号写进候选清单的 `rev`，history 默认查同一个提交；传了 `--rev` 又不一致时报错
  - 证据写 knip 的结论（`knip-unreachable` / `knip-test-only`），状态由规则层判定（M4）
- [x] 候选清单支持 `evidence`：scan 写的证据原样带进报告；人工写的没有证据，照旧是「人工列入候选」
- [x] 候选清单的 `files` 可以是空数组：没有候选也能走完 history → report
- [x] `code-audit scan` 命令：`--profile` 必填，输出安全规则和 history 一致

### 真实项目跑通

- scan 不到 1 秒：从入口走不到 150 个（试用时 199 个，少的 49 个就是 glob 加载的文件），跳过测试 86 个、scanIgnore 6 个，候选 58 个（其中只有测试用到 4 个）
- history 58 个文件约 2 分 46 秒；report 生成 58 个头注释
- 13 个已隔离文件的历史和 M2 时完全一致
- 改成分析提交之后重跑：目标项目工作区有 4 个没提交的改动（含 package.json），候选仍是同样的 58 个、证据相同；目标项目 `git status` 不变，临时目录没有残留
- knip 和 history 结论不一致的 10 个，原因都查明了，大多是 M4 规则层要用的信号：
  只被测试引用 5 个、引用方本身也没人用 1 个（`dead-only-ref`）、构建配置或脚本在用 2 个（`external`）、history 误匹配 2 个（见已知问题）

### 顺带修复

- history：中文文件名被 git 转义（`"\345\217..."`），拿转义后的字符串去查会失败。git 统一加 `core.quotePath=false`；
  文件名里有引号、反斜杠、控制字符时 git 仍会转义，这种情况明确报错
- `git()` 新增 `raw` 选项：`-z` 列文件时不去首尾空白，以空格开头的文件名保持原样

### 审核后修复

- ~~scan 按工作区分析，history 按提交查询：本地删掉一处 import 时，两边看到的代码不一样~~：scan 改为分析提交里的代码，提交号写进候选清单，history 默认查同一个提交
- ~~没有候选时，scan 输出的 `files: []` 交给 history 会被判为无效~~：空数组合法

---

## M4 规则层 🚧

方案 A：规则在 scan 里跑。scan 手上有提交里的代码、knip 的结果和候选全集，判定要用的数据都在这一步；
候选清单写好状态、证据、引用，history 只补历史，不改结论。

顺序按「越不敢删越先做」：

| 顺序 | 状态 | 做法 | 状态 |
|---|---|---|---|
| ① | `unknown` | 路径里有变量的动态加载，圈出可能加载的文件 | ✅ 306951b |
| ② | `external` | 在 knip 不分析的文件里搜候选的路径 | ✅ 8516d78 |
| ③ | `dormant` | 在用的代码、配置文件的注释里搜引用 | ✅ 7ff1bcb |
| ④ | `test-only` | 用 scan 的 knip 证据，列出直接引用它的测试 | ✅ 完成（待提交） |
| ⑤ | `dead-only-ref` | 候选之间的引用关系，顺着引用传递要保留的状态 | ✅ 完成（待提交） |
| ⑥ | `dead` | 以上都不是；每个 dead 都写明原因 | ✅ 3df184c |
| 第二批 | `pending` | 没合并的分支改过的文件 import 了它，或者分支改了它本身 | ✅ 完成（待提交） |
| 以后 | `internal` | 文件里的导出被同文件调用：属于导出维度，等做导出维度时一起做 | ⏳ |

### 公共部分

- [x] `src/rules/index.js`：每条规则返回命中的状态、证据、引用；命中多条取 STATUSES 里最靠前的，证据和引用都保留
- [x] 一条都没命中的暂时也是 `unknown`，证据 `rules-incomplete` 说明「规则层还没做完」；规则做完后改成 `dead`
- [x] 候选清单新增 `status`、`refs`；history 原样保留，人工写的清单没有就是 `unknown` 和空引用
- [x] `src/collect/source-text.js`：读源码的公共工具（只看 `<script>`、去注释、读字符串），glob-imports 和 dynamic-imports 共用
- [x] fixture 跑 scan：每个 fixture 复制成临时仓库，用真的 knip 跑。已做规则的状态必须和标准答案一致，没做的只检查列为候选、标着未判定

### ① unknown：动态加载

- [x] `src/collect/dynamic-imports.js`：找出拼接路径的 `import()` / `require()` 和 `require.context`
  - 范围按路径里固定的开头和结尾算：`'./views/page-' + x + '.vue'` → views 目录（含子目录）、page- 开头、.vue 结尾
  - 变量里可能有 `/`，一律含子目录；路径省略扩展名时，去掉扩展名再比较。宁可多圈
  - `require.context` 按目录、是否含子目录、正则算；正则写错时不限文件
  - 路径开头就是变量、包名、三元表达式：范围确定不了，记警告
- [x] `src/rules/dynamic-load.js`：落在范围里的候选判为 `unknown`，每处加载一条证据、一条引用（`via: dynamic`）；加载方本身也是候选时在证据里注明
- [x] ~~试验发现：knip 自己能处理模板字符串里的变量~~：**这个结论是错的**（③ 时发现）。当时 fixture 没有 package.json，knip 悄悄跳过了所有 .vue 文件，看起来像「算在用」。补上依赖声明后，模板字符串加载的 .vue 照样是候选，由本规则判为 unknown
- [x] finicr-web：所有 `import()` 都是固定路径，没有动态加载，结果不变（58 个候选）
- [x] 反向检查：逐个撤掉关键逻辑（保留状态和引用、排除自己、非递归、省略扩展名、优先级、参数里的正则），每处都有测试失败

### ② external：图外使用

- [x] `src/collect/external-refs.js`：在 knip 不分析的文件里找候选的路径
  - 搜哪些文件：提交里的文本文件（js 类、json、html、yml、sh），去掉 knip 分析的源码文件；
    即源码目录外的一切（构建配置、脚本、index.html、package.json），加上源码目录里的非源码文件（如 json 菜单配置）
  - 不搜：测试文件（测试里写的路径算「只有测试用到」）、锁文件
  - 匹配：去掉扩展名的路径，可带原扩展名；两侧有边界，`src/a` 不匹配 `src/a.config.js`、`src/a/b.js`、`src/ab.js`；index 文件也认目录写法
  - JS 类文件先去注释：注释掉的引用不算（留给 ③ dormant）；html、json 原样搜
  - 没有新增配置项：搜索范围由 sourceRoots、extensions、testEntries 推出
- [x] `src/rules/external.js`：命中的判为 `external`，每处一条证据、一条引用（`via: config`）
- [x] finicr-web：正好找出 M3 时人工确认的 2 个——`src/shims/fpv-excel-engine-stub.js`（vite-config/resolve.js）、`src/i18n/menu.js`（scripts/generateMenuI18n.js），没有多报
- [x] 反向检查：逐个撤掉 9 处关键逻辑（排除测试文件、去注释、左右边界、index 目录写法、带扩展名、源码目录里的非源码文件、规则注册、导出要搜的文件），每处都有测试失败

### ③ dormant：注释停用

- [x] `strip-comments.js` 新增 `findComments`：和去注释用同一套判断，取出注释和开始的行号
- [x] `src/collect/comment-refs.js`：注释里引号括起来的路径，按写注释的文件解析（相对、别名、`/` 开头、从仓库根目录写起），
  等于候选、去掉扩展名的候选或 index 文件的目录就算引用
  - 搜哪些注释：在用的源码（不是候选、不是测试文件）里的 JS 注释，`.vue` 只看 `<script>`；配置文件、脚本的 JS 注释；html 的 `<!-- -->`
  - 候选文件里的注释不算：写注释的文件本身没人用，恢复那行也用不上
  - 不带引号的说明文字不算
- [x] `src/rules/dormant.js`：命中的判为 `dormant`，引用 `via: comment`
- [x] external 不再把 html 里注释掉的路径算成图外使用，改由 dormant 判定
- [x] finicr-web：正好找出 M3 时人工确认的 2 个——`src/utils/browser-check.js`（main.js:84）、`src/components/ResolutionTip/index.vue`（App.vue:35）
- [x] fixture 支持在 expected.json 里写 `config`（如别名）
- [x] 反向检查：逐个撤掉 11 处关键逻辑，每处都有测试失败

### ④ test-only、⑤ dead-only-ref

- [x] `src/collect/path-refs.js`：代码里 import / export from / import() / require 的路径 → 候选文件（去注释、.vue 只看 script、自己引用自己不算）；③ 的路径解析也挪到这里共用
- [x] `src/rules/test-only.js`：knip 说「只有测试用到」的判为 `test-only`，列出直接 import 它的测试；经过别的文件间接用到的只有 knip 的结论
- [x] `src/rules/graph.js`：顺着候选之间的 import 传递「要保留」的状态
  - 候选 X 只被候选 Y 引用：Y 要保留（unknown、external、dormant、test-only，或者从别处传来的），X 跟着保留，状态和 Y 一样，证据写明跟着谁
  - 一路往上都没有要保留的，X 才是 `dead-only-ref`；互相引用、入口走不到的一组也是
  - 状态只往「更不敢删」的方向变，循环引用也会停下来
- [x] 规则层分两步：先逐个文件跑规则，再顺着引用传递；候选之间的引用记进 refs（`via: static`）
- [x] `SCAN_RULES` 挪到 `src/collect/scan-rules.js`：规则层也要用，避免和 scan.js 循环引用
- [x] fixture `ref-chain`：external → 被它引用的、dormant → 被它引用的、互相引用、只被测试用到（含间接）、没人引用
- [x] finicr-web：test-only 3 个（第 4 个 ResolutionTip 同时是 dormant，dormant 优先）、dead-only-ref 7 个，其中 `mixin.js` 和 M3 时人工确认的一致（只被 EchartsCom.vue 引用）
- [x] scan → history → report 全流程跑通：报告里状态汇总是 unknown 44、external 2、dormant 2、test-only 3、dead-only-ref 7
- [x] 反向检查：逐个撤掉 11 处关键逻辑，每处都有测试失败（「不找测试引用」一开始没抓到，补了测试）

### ⑥ dead，以及确定不了目录的动态加载

规则：什么都没命中、也没被候选引用的，判为 `dead`，证据 `no-ref` 写明排除了哪些情况。去掉了「规则还没做完」的占位。

确定不了目录的动态加载（`import(path)` 这类），按文件逐个判，不是整批一刀切：
- 范围是整个仓库，但用路径里固定的结尾、`require.context` 的正则缩小：`import(name + '.vue')` 只圈 .vue，.js 照常判 dead
- 圈到的判 `unknown`，证据写明是哪一处、怎么缩小的、怎么放过
- 人工确认它不加载本地源码（比如加载 CDN 脚本）后，写进配置 `reviewedDynamicLoads`（`from`、`expr` 照抄 scan 输出、`reason` 必填）：
  不再圈文件，范围里判为 dead / dead-only-ref 的，证据写明确认的理由
- 配置里的确认在当前提交找不到时（代码改了），输出里提示

实现：
- [x] `dynamic-imports.js`：确定不了目录时不再返回 null，返回整个仓库的范围（`wide: true`），保留结尾、正则
- [x] `config.js`：新增 `reviewedDynamicLoads`，校验字段、理由不能空
- [x] `rules/index.js`：没命中、没被引用的判 `dead`；dead / dead-only-ref 附上人工确认的理由
- [x] fixture `wide-dynamic`：`import(name + '.vue')` 只圈 .vue；`dynamic-import` 的 `import(p)` 写进确认，范围外照常判
- [x] finicr-web 全流程：dead 44、dead-only-ref 7、test-only 3、external 2、dormant 2，没有 unknown（这个项目没有路径里有变量的动态加载）；
  人工隔离过的 13 个全部判为 dead 或 dead-only-ref，和人工结论一致
- [x] 反向检查：逐个撤掉 9 处关键逻辑，每处都有测试失败

### 第二批：pending（其他分支在用）

- [x] `src/collect/branch-refs.js`：没合并进分析提交的分支（本地 + 远程跟踪分支，只读本地已有的，不 fetch）
  - 只看分支自己改过的文件（从分叉点到分支最新提交）：分支没动过的文件，合并后用的是当前分支的版本，不会把引用带回来
  - 分支改过 / 新增的源码文件 import 了候选 → pending；分支改了候选本身 → pending（还有人在改，现在删合并会冲突）；分支删了它不算
  - 同一个提交的多个分支名（本地和 origin/ 同名）合成一个；origin/HEAD 这种指向别的分支的名字跳过
- [x] 配置 `branches: { ignore, maxAgeDays }`：**由用户自己配置，不配置就全部查**（宁可多判）；不会再合回来的老版本线可以按名字（glob）排除，或按「多少天没提交」跳过
- [x] scan 输出里列出每个分支导致了几个 pending，并提示怎么排除，方便用户决定
- [x] `src/rules/pending.js`：证据写明分支、最后提交日期、哪个文件哪一行；顺着引用传递，被它引用的候选跟着保留
- [x] finicr-web：5 秒查完 9 个没合并的分支，多出 12 个 pending。其中 10 个原来是 dead（verify 也说删了没问题），
  但 master、hotfix、guangfa 分支上改过的文件还在用它们（如 `src/api/document.js` 被 `LongPromptConversation.vue` 引用）。
  直接删的话，这些分支合回来时构建会报错——verify 只看当前分支，看不出来
  - 分布变为：dead 34、pending 12、dead-only-ref 6、test-only 2、dormant 2、external 2
- [x] 反向检查：逐个撤掉 8 处关键逻辑，每处都有测试失败（「不从分叉点算」一开始没抓到，补了「主线后来去掉引用」的场景）

### ③ 时发现并修复：没声明 vue 依赖时 knip 跳过 .vue 文件

- knip 只在 package.json 声明了 vue（svelte、astro 同理）时才解析 .vue，否则悄悄跳过，插件列表里照样显示 Vue，核对插件看不出来
- 后果：.vue 文件不会列为候选；.vue 里的 import 也不跟进，**只被组件用到的 js 会被误报为没人用**（会导致误删的方向）
- 会遇到的情况：monorepo 里 vue 写在子包、没有 package.json
- 修复：scan 在临时目录的 package.json 里补上缺的依赖声明（源码里有 .vue 才补），不碰目标仓库；输出里会提示补了什么
- finicr-web 声明了 vue，不受影响；fixture 之前没有 package.json，所以 ① 的「knip 能处理模板字符串」是误判

---

## M5 verify 🚧

在临时目录里实际删掉 dead / dead-only-ref，跑项目的构建、测试，和不删时（基线）比较。是静态分析的兜底：
比如 external 认不出的相对路径写法，删掉后构建会报错。

分三次做：

| 顺序 | 内容 | 状态 |
|---|---|---|
| ① | 工作目录（导出代码、克隆依赖）、跑命令、试跑基线 | ✅ fe163a1 |
| ② | 删掉候选后跑、和基线比较；先从报错里认出文件，认不出再对半找；结果写进 verify 字段 | ✅ 3a34279 |
| ③ | finicr-web 实测，根据结果调整 | ✅ 一次全部通过，暂时没有要调整的；等 M6 第二个项目再看 |

### 决定

- 不用 git worktree：worktree 会在目标仓库的 .git 里留记录。和 scan 一样用临时索引导出到系统临时目录
- 依赖：克隆目标项目的 node_modules（macOS 用 clonefile，几秒、不占额外磁盘；Linux 试 reflink，不行就普通复制）。
  不用软链接：构建工具会往 node_modules 里写缓存，软链接会写进原项目。monorepo 里每个 package.json 旁边的都克隆
- 命令写在 profile 的 `verify` 里（`build`、`test`、`timeoutSeconds`），没有默认值：各项目不同，猜错了就是乱跑。
  没写时报错，并列出 package.json 里像构建、测试的脚本供挑选
- 命令必须能无人值守跑完：设 `CI=1`；超时连同子进程一起结束（进程组）
- 会执行项目自己的代码（构建脚本）：verify 的目的就是真的构建，只在临时拷贝里跑

### ① 工作目录 + 试跑基线

- [x] `src/verify/workspace.js`：导出提交里的全部文件，克隆 node_modules；node_modules 本身是软链接时克隆它指向的目录；出错时清掉临时目录
- [x] `src/verify/run-command.js`：按 shell 命令执行，stdout / stderr 按时间顺序合并、去颜色、过长只留结尾；超时结束整个进程组
- [x] `src/verify/baseline.js`：按 build、test 的顺序跑配置了的步骤，完整输出写进日志目录（不截断，见下面「已知问题排查」）
- [x] `code-audit verify --root --profile [--rev] [--keep]`：试跑基线，确认命令能在临时目录里跑通；失败时打印最后 30 行，退出码为 1
- [x] 配置新增 `verify`，按字段合并（只写 build 也行）
- [x] finicr-web 实测（build: `pnpm run build:ci`，test: `pnpm test`）：
  - 准备临时目录 5 秒（1225 个文件，node_modules 克隆，不占额外磁盘）；构建成功 32 秒；测试 14 秒
  - **基线测试本来就有失败**：HEAD 上 728 个测试里 10 个失败（6 个文件）。② 不能只看退出码，要按「哪些测试失败」比较
  - 原项目 `git status`、node_modules 不变；构建产物、缓存都在临时目录里

### ② 删除对比 + 定位

- [x] `src/verify/signals.js`：和基线比较，只看新增
  - 构建：基线成功、删后失败 / 超时算问题；新增的警告列出来给人看，不算失败
  - 测试：按「失败的测试」比较（认 `FAIL  文件 > 用例`、`✗ × ✕` 开头的行），基线本来就失败的不算；认不出是哪些测试时按成功 / 失败比较
  - 归一化：去掉临时目录路径（macOS 的 /var 和 /private/var 两种写法）、耗时、文件大小
- [x] `src/verify/locate.js`：从新增的报错里认出被删的文件
  - 报错里直接写着路径（ENOENT 等）
  - 引号里的 import 路径，按同一行的引用方解析（rollup / vite / webpack 的 resolve 报错）
  - 新失败的测试 import 了哪些被删的文件
- [x] `src/verify/search.js`：以「组」为单位（有 import 关系的候选绑在一起，引用方和被引用的一起删）
  - 全部删掉跑一轮，通过就结束（含基线共 2 轮）
  - 不通过：从报错认出嫌疑，先放回去，剩下的再跑；认不出的对半找；嫌疑逐组单独确认（报错也可能冤枉人）
  - 每轮都是「已确认能删的 + 这轮要试的」一起删：一起删才出问题的组合过程中就会发现；最后一次通过的那一轮就是最终结果，不用再跑
  - 最多 40 轮，用完还没确认的记为未验证
- [x] `src/verify/index.js`：用数据里记录的提交；基线构建失败时报错；结果写进每项的 verify 字段。
  删了会出问题的：状态改为 unknown，证据 `verify-failed` 写上问题和几行报错
- [x] `code-audit verify --in <data.json> --out <结果.json>`：输出位置检查和 history 一致；打印每轮结果和汇总
- [x] 端到端测试：真实的 node 脚本当构建、测试命令。6 个文件里 3 个删不得（构建按文件名读取、测试在用、报错看不出是谁），6 轮全部判对
- [x] 反向检查：逐个撤掉 10 处关键逻辑，每处都有测试失败
- [x] finicr-web 实测：51 个（dead 44、dead-only-ref 7，绑成 44 组）一次全删，第 1 轮就和基线一致，总共 1 分半（准备 5 秒 + 基线 + 1 轮）。
  构建通过、没有新增警告、没有新增失败的测试（基线本来失败的 10 个不变）；目标项目 `git status` 不变、临时目录没有残留。
  报告里 51 个显示「删除后与基线一致」，其余 7 个（external、dormant、test-only）不验证

## M6 接入第二个项目 ✅

findip-portal-web：Vue3 + TypeScript，453 个文件，没有测试脚本，用 unplugin-vue-components 自动注册组件。
配置只写了入口、别名、构建命令（本机 profile，不入库）：

```js
{ entries: ['src/main.ts'], aliases: { '@': 'src' }, verify: { build: 'pnpm run build:ci' } }
```

### 发现并修复：Vue 全局注册的组件

- 现象：第一次 scan 只找出 3 个候选。`KatexRender`、`BasicModal` 全项目没人用，却没被找出来
- 原因：tsconfig 把 `src/components.d.ts`（unplugin-vue-components 生成的声明文件）列为源文件，
  knip 把里面的 `typeof import('./components/X/index.vue')` 当成引用：登记过的组件一律算在用。
  对照实验：不导出声明文件，或者不导出 tsconfig.json，结果都变成 8 个
- 只拿掉声明文件也不对：`BasicSearch` 等组件只在模板里写标签（`<BasicSearch>`），knip 看不到，会被误报为没人用
- 修复（`src/collect/global-components.js`，通用：只认 Vue 的 `interface GlobalComponents` 声明）：
  - 读出声明文件里登记的本地组件（第三方组件、提交里不存在的不算）
  - scan 的临时目录里不放声明文件
  - 在各 .vue 的模板里找标签（大驼峰、短横线写法），在临时目录的拷贝里给用到的文件补 import（插在 `<script>` 那一行，行号不变），knip 顺着真实的引用关系走
  - 候选之间的标签用法也算引用（只被没人用的页面用到的组件判 dead-only-ref）；测试文件里的标签算测试引用
- 结果：候选 5 个（dead 4、pending 1）：`BasicModal`、`KatexRender`、`GuideSteps`、`refreshToken.ts`，grep 交叉核对全部没人用；
  `src/api/auth.ts` 被 `origin/dev_2.6.0.guangfa` 分支改过、还在用，判 pending
- 声明文件里登记了 16 个组件，9 个是按模板标签用的

### 发现并修复：history 把 .d.ts 算成引用方

- 现象：`KatexRender` 的历史显示「仍被引用」，引用方是 `src/components.d.ts`
- 修复：history 找引用方时排除 `*.d.ts`：类型声明构建后不存在，里面的路径不是运行时的使用

### 全流程结果

- scan 2 秒、history 1 秒、report 生成 5 个头注释
- verify（build: `pnpm run build:ci`，含 lint 和 TS 编译；没有测试命令）：4 个 dead 一次全删，和基线一致，用时 1 分钟
- 目标项目 `git status` 不变，临时目录没有残留
- 注意：全局注册的组件删错了，构建不会报错（Vue 运行时才警告），verify 兜不住，只能靠 scan 认准标签用法

## M7 quarantine（隔离）🚧

唯一会改动目标项目的命令。默认只打印计划，加 `--apply` 才执行。

决定（2026-11-09 和用户确认）：
- 执行时新建分支，分两次提交：第一次只 `git mv`（git 认得出改名，历史接得上），第二次加头注释、改路径、更新清单。不 push
- 只隔离 dead / dead-only-ref 并且实删验证通过的；没跑 verify 的不隔离
- 隔离区可配置 `quarantine: { dir, base }`，默认 `<第一个源码目录>/_deprecated`；文件按相对 base 的路径放进去，子目录结构不变
- lint 等工具配置不自动改，计划里列出要手动加的那一行

实现：
- [x] `src/quarantine/plan.js`：挑文件、算新位置、要改的路径、头注释；不隔离的写明原因
  - 有 import 关系的绑成一组，一组里有一个不能移，整组都不移（免得留下的那个引用指空）
  - 已经在隔离区里、不在 base 下、隔离区里已有同名文件、不能写注释的（.json 只移动不加头注释）
- [x] `src/quarantine/rewrite.js`：被移走的文件里的相对路径（import / require / 样式 @import、url() / 模板 src、href）
  - 优先改成别名（`../api/x` → `@/api/x`）：别名不随位置变，移回原路径也不用再改
  - 没有别名时按新位置算相对路径；指向同一批移走的按它们的新位置；注释行、找不到的不改
- [x] `src/quarantine/apply.js`：新建分支、两次提交；README 已有的原样保留，在最后追加这一批（表格：新路径、原路径、状态、引入、失去引用）
  - git 钩子照常执行；任何一步出错（包括钩子没通过）整体撤回：reset 到开始的提交、切回原分支、删掉新分支
- [x] `code-audit quarantine --root --profile --in [--apply] [--branch] [--moved-at]`：
  执行前检查工作区干净、HEAD 就是分析的提交（中间有新提交要重新分析）、新分支名没被占用
- [x] 测试：临时仓库里跑完整流程，检查第一次提交全是 R100（纯改名）、`git log --follow` 接得上；钩子失败时整体撤回
- [x] 反向检查：逐个撤掉 12 处关键逻辑，每处都有测试失败
- [x] finicr-web 试跑（只打印计划，不 --apply）：重新 scan → history → verify，40 个 dead / dead-only-ref 一次实删通过
  - **发现并修复**：人工隔离区 `src/utils/_deprecated/` 里的 13 个文件，被计划再移进默认隔离区，变成 `src/_deprecated/utils/_deprecated/…`（隔离区套隔离区）。
    现在路径里有一段和隔离区目录同名的（如 `_deprecated`）都算已经隔离，不再移
  - 默认隔离区 `src/_deprecated`：隔离 27 个，改 12 处相对路径（都改成 `@/…`）；沿用现有的 `src/utils/_deprecated`（base `src/utils`）：0 个——剩下的 27 个都不在 utils 下
  - 目标项目的提交、分支、工作区都没变

## 盲区兜底

原则：**看不准的不判死**。先认出「这里有盲区」，可能受影响的候选判 unknown（或 dormant），证据写明看到了什么、为什么不能确认、怎么放过；
不是只在已知问题里记一笔。

| 盲区 | 兜底 | 怎么放过 |
|---|---|---|
| ① 动态组件名字是变量：`:is="name"`、`resolveComponent(name)` | 项目有全局注册的组件时，当成范围确定不了的动态加载：全局组件里的候选判 unknown（装了自动注册插件却没有声明文件时，所有 .vue 都算） | 人工确认后写进 `reviewedDynamicLoads`（from + expr） |
| ② 全局注册没声明文件、手写注册、别处同名组件 | 在用的模板里有和候选同名的标签（文件名推组件名，index.vue 用目录名），又不是那个文件 import 进来的 → unknown；只在模板注释里出现 → dormant | 看证据人工处理 |
| ③ glob 换算不了（别名没配置） | 按 glob 的模式在全仓库里圈（`~/views/**/*.vue` → 任何 …/views/…/*.vue），圈到的判 unknown；参数不是字符串的整个仓库 | profile 里补上别名，或写进 `reviewedDynamicLoads` |
| ④ 自动导入的本地函数（unplugin-auto-import） | 精确处理：读出声明文件里登记的本地函数，按名字找用法补成引用；声明文件不算引用。装了插件却没有声明文件时兜底：候选导出的名字在用的代码里被直接用到、又没 import → unknown | 看证据人工处理 |
| ⑤ external：相对配置文件目录的路径、`path.join` 拼的路径 | 能算的算出来（按文件所在目录解析；path.join / resolve 各段是字面量、__dirname、process.cwd()、变量时拼起来）；算不出来的，出现了同名文件名（带扩展名，index.* 除外）→ unknown | 看证据人工处理 |
| ⑥ yml、sh 的 `#` 注释 | 认 # 注释里的路径（不带引号也认），判 dormant | — |
| ⑦ 远程分支以上次 fetch 为准 | 工具不 fetch；上次 fetch 超过 7 天或找不到记录时，输出里提醒 | 先 git fetch 再 scan |

实现：`src/rules/blind-spots.js`（同名标签、注释里的同名标签、疑似自动导入、疑似拼出来的路径）、`src/collect/auto-imports.js`，
`global-components.js`、`glob-imports.js`、`external-refs.js`、`comment-refs.js`、`branch-refs.js` 各自补上对应的部分。

实测：
- finicr-web：状态分布不变；`ResolutionTip` 多一条证据（`App.vue:12` 的模板注释里有 `<ResolutionTip>`）
- findip-portal-web：项目里有 12 处 `:is="变量"`，`BasicModal`、`KatexRender` 从 dead 变为 unknown（它们是全局组件，排除不了某个变量的值正好是它）。
  人工确认这 12 处都只会是图标、路由组件后，写进 `reviewedDynamicLoads` 才会回到 dead
- 反向检查：逐个撤掉 18 处关键逻辑，每处都有测试失败

## 已知问题

修好一个就划掉，并写上提交号。

| 问题 | 影响 | 危险程度 |
|---|---|---|
| pattern 按字面搜索，同目录下的相对路径引用（`import './x.js'`）搜不到 | 可能漏掉引用 | 中。等 scan 完成后改用精确引用 |
| 除号 / 正则的判断在 `a++ / b / c` 这类写法下会出错 | 最多少去掉一段注释 | 低 |
| history：`.vue` 模板里的 `<!-- -->` 不处理（只去 JS 注释） | 被注释掉的组件仍算作引用 | 低。不会误删 |
| 引用方文件改名，记成一次 remove 加一次 add | 时间线多两条记录 | 低。不影响失去引用的判断 |
| 引用按完整路径匹配，但 `utils/math` 仍会匹配 `utils/math.config`（点号后面无法区分扩展名和文件名） | 可能多算引用 | 低。不会误删 |
| 表格里合并提交的说明很长（带仓库地址），会把「失去引用」列撑得很宽 | 只影响阅读 | 低。以后可以加配置截断提交说明 |
| 引入取的是合并提交时，看不到分支上真正写代码的人 | 报告里作者显示为合并的人 | 低。可以以后在报告里展开合并提交 |
| history 的 pattern 会匹配到同名目录下的其他文件：`config/field`（指 field/index.js）也匹配 `config/field/xxx` | 多算引用，显示「仍被引用」 | 低。不会误删；以后可以改用 scan 的引用关系 |
| history 的 pattern 会匹配到接口地址等字符串：`api/document` 匹配 `'/api/document/stream'` | 多算引用 | 低。不会误删 |
| scan：写 import.meta.glob 的文件本身没人用时，被它加载的文件也当成在用 | 少报 | 低。不会误删 |
| 字符串里出现 `import(`、`require(` 字样时也会当成调用 | 多圈文件、多发警告 | 低。不会误删 |
| external：省略扩展名的路径同时也是目录名时（`'src/i18n/menu'` 指目录），也算引用了 `src/i18n/menu.js` | 多一条证据 | 低。模块解析本来也是文件优先 |
| pending：hotfix 用 cherry-pick 合回主线时，git 仍认为分支没合并，已经摘过来的改动也会判 pending | 多判 pending | 低。不会误删；不会再合回来的分支在 branches.ignore 里排除 |
| pending：远程分支以上次 fetch 为准，scan 不 fetch | 别人新推的分支看不到 | 中。上次 fetch 超过 7 天时输出里提醒（兜底 ⑦） |
| 兜底是按名字的：同名标签、导出名、文件名都可能撞名，会多判 unknown | 多判 unknown，要人工看 | 低。不会误删；证据里写明是哪个文件哪一行 |
| 动态组件的名字是变量时只能整批放过（reviewedDynamicLoads 按 from + expr 逐处确认），处数多时要写很多条 | 配置繁琐 | 低 |

已确认不是问题：

- ~~`refsAt` 对每个候选文件执行一次 `git show`，大仓库可能慢~~：finicr-web 实测每个文件约 3 秒，13 个共 34 秒

已修复：

- ~~全局组件的名字是变量时认不出~~、~~自动注册没有声明文件时模板用法看不到~~、~~自动导入的本地函数看不到~~、
  ~~external 只认从仓库根目录写起的路径~~、~~dormant 不认模板里注释掉的标签和 yml 注释~~：都改为兜底（见「盲区兜底」），看不准的判 unknown / dormant，不判死
- ~~verify：基线测试本来就有失败时，只比「新增失败的用例」~~：实测测试整个崩掉（一条 FAIL 都没打）、退出码变了、通过的用例从 99 降到 50，都被判为通过。
  只比退出码也不够（基线本来就是 1，崩了也是 1）。现在还比：退出码变了；基线认得出失败的用例、删后一个都认不出又没成功；通过的用例变少（读汇总行，没有时数 ✓ / PASS）
- ~~verify：命令输出超过 2 MB 只留结尾~~：不只影响排查——jest 这类工具一开始就打印失败的用例，截掉后比较时认不出。
  现在完整输出边跑边写进日志文件（不截断）；内存里留开头 256 KB 和结尾 1.75 MB，中间注明省略了多少；
  关键行（失败、警告、通过、汇总、报错）整个输出一行不漏地另外收着，比较只用它们。stdout、stderr 的半行各自拼接
- ~~全局组件的标签扫描没先去掉模板里的 HTML 注释~~：去掉注释（行号不变），注释里的标签不算使用
- ~~全局组件只认显式标签~~：还认写死名字的动态组件（`is="X"`、`is="vue:X"`、`:is="'X'"`、`v-bind:is="'X'"`）和脚本里的 `resolveComponent('X')`；名字是变量的仍认不出（见上表）
- ~~动态加载的路径开头就是变量（`import(path)`）时范围确定不了，只发警告~~：圈整个仓库（按结尾、正则缩小），范围里的判 unknown；人工确认后写进 `reviewedDynamicLoads` 放过
- ~~符号链接能绕过「输出不能写进目标仓库」的检查~~：两边都换成真实路径再比较；输出位置还不存在时按最近一级存在的父目录解析；失效的符号链接直接报错
- ~~输出文件逐个写入，中途出错会留下半成品~~：目录先写到同级临时目录再改名；单个文件先写临时文件再用硬链接放到位（目标已存在时会失败，不会覆盖）
- ~~报告状态汇总表里的状态文案没有转义~~：和其他表格单元格一样转义 `|` 和换行
- ~~行内代码的围栏固定为两个反引号，内容里有连续反引号时会提前结束~~：围栏比内容里最长的一串反引号多一个；开头或结尾有空格时两侧补空格，保留原样
- ~~表格转义没有先处理反斜杠，原文里的 `\|` 会变成列分隔符~~：先转义反斜杠，再转义 `|`
- ~~按键合并的配置项（headerStyles / statusLabels / columnTitles）写成 null 时被悄悄忽略~~：写了就必须是对象

- ~~默认头注释包含「观察期后删除」「恢复时更新清单」等流程要求~~：默认只写「排查记录」，流程文案放进项目配置
- ~~头注释固定用 JS 块注释，.json 等文件也会生成~~：按扩展名选择注释格式，不支持的类型报错
- ~~状态文案写死在 schema~~：改为配置 `statusLabels`，可只覆盖部分状态
- ~~`history.paths` 不检查顺序和重复~~：第一项必须是当前路径，不能有重复
- ~~引用按子串匹配，`utils/math` 会把引用 `utils/mathHelper` 的文件也算进来~~：改为按完整路径匹配
- ~~schema 注释里引用了具体项目的文件名~~：换成通用说法

- ~~`defaultPattern` 固定去掉 `src/`~~：改为读配置 `sourceRoots`，文件不在源码根目录下时报错要求指定 pattern，不猜
- ~~扩展名列表写死~~：改为读配置 `extensions`
- ~~推断移动只看文件名，可能把不相干的同名文件（index.js、config.js）当成移动~~：还要求旧文件的内容至少 60% 保留在新文件里；旧文件为空时，要求新文件去掉注释后也为空
- ~~`shortHash` 不校验长度（负数会悄悄返回去掉末位的字符串）~~：长度必须是 4～40 的整数
- ~~`groupTimeline` 把不认识的 change 当成去掉~~：改为报错

- ~~validate 遇到非法 evidence 抛异常、字段校验不完整~~（53fc34e）
- ~~stripComments 不识别正则字面量和模板字符串 `${}`~~（53fc34e）
- ~~refsAt 吞掉所有 git 错误~~（53fc34e）
- ~~目标文件改名后，旧路径被当成引用方~~（53fc34e）
- ~~findLostRef 对不完整时间线得出错误结论~~（53fc34e）

---

## 提交记录

| 提交 | 内容 |
|---|---|
| f7da5be | 初始化仓库 |
| 4a67a43 | README 与 .gitignore |
| feaa6ac | 命令行入口与子命令空壳 |
| e26f605 | 命令行入口的自动化测试 |
| 77657cf | 数据格式，状态扩展为 9 种并新增标签 |
| eb8de10 | 补全 JSON 字段定义与完整样例 |
| 2b516eb | 3 个 fixture |
| c3d399c | history：查找引入提交 |
| fc0491a | history：引用时间线与失去引用；去掉注释后判断引用 |
| 53fc34e | 补全数据格式校验，修复注释剥离、git 错误处理与改名排除 |
| d4a518a | history 命令接入命令行；修复 finicr-web 实测发现的 6 个问题 |
