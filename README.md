# code-audit

前端项目的**删除排查工具**。删除「看起来没人用」的文件、导出或接口之前，用它回答三个问题：

1. **真的没人用吗？** 从入口做可达性分析，检查文件内调用链，排除动态调用
2. **它是怎么变成没人用的？** 用 git 追溯引入、引用和失去引用的提交
3. **删掉会不会出问题？** 在隔离的 worktree 里实际删掉，再和构建、测试的基线对比

> 状态：开发中。M0（骨架）、M1（history）、M2（report）已完成，M3（scan）第一版完成：scan → history → report 可以完整跑通。M4（规则层）：除「文件内部在用」（`internal`，属于导出维度）外，8 种状态都能判出并写明原因。M5（verify）：能在临时目录里删掉候选、和基线比较。进度见 `docs/progress.md`。

---

## 设计原则

| 原则 | 含义 |
|---|---|
| **默认只读** | 从项目外部分析，不往目标项目里加任何文件。只有 `quarantine` 命令会改动目标项目，且必须显式执行 |
| **插件化** | 核心与框架无关。Vue2 / Vue3 / TS / Vite 等差异放在插件里，按项目配置选用 |
| **数据驱动** | 每一步读写统一格式的 JSON，报告只从 JSON 生成，不手写结论 |
| **核心零依赖** | 核心（数据格式、history、report、规则）只使用 Node 内置模块。采集可以借助外部分析工具：目前 scan 用 knip，作为 code-audit 的可选依赖，安装 code-audit 时自动装上，不装进目标项目。只有 scan 需要它，其他命令没有 knip 也能用 |
| **不碰目标仓库的共享状态** | 不使用 `git stash`，用完的 worktree 一定清理，从不 `push` |
| **通用，不针对某个项目** | 目录、别名、扩展名、文案等项目差异一律放进配置（`profiles/`），代码只放通用逻辑和常见约定的默认值。代码和注释里不写具体项目的名称和路径；具体项目只出现在本机的 `profiles/`、`test/golden/`、`reports/` 里 |

---

## 三个排查维度

| 维度 | 排查单位 | 删错的后果 | 验证方式 |
|---|---|---|---|
| 文件 | 一个文件 | 构建报错，马上会被发现 | 实删后构建、测试，和基线对比 |
| 导出 | 文件里的一个名字 | 构建只报警告，运行时拿到 `undefined` | 对比构建日志里的 `is not exported` 警告 + 开发环境警告观察 |
| 接口 | 一个「方法 + 路径」 | 前端无感知，后端下线后才出问题 | 后端访问日志 |

执行顺序固定为：先文件，再导出，最后接口。

---

## 目录结构

```
code-audit/
├─ bin/
│  └─ code-audit.js          # 命令行入口：解析参数，分发到各子命令
├─ src/
│  ├─ commands/              # 子命令，每个命令一个文件
│  │  ├─ scan.js             #   采集 + 判定，输出候选清单 JSON
│  │  ├─ history.js          #   为候选补充 git 历史
│  │  ├─ verify.js           #   在临时 worktree 里实删验证
│  │  ├─ report.js           #   从 JSON 生成报告
│  │  └─ quarantine.js       #   隔离到 _deprecated/（唯一会改动目标项目的命令）
│  ├─ core/                  # 核心：JSON 数据结构与校验、配置加载、插件机制
│  ├─ collect/               # ① 采集：依赖图、导出名、URL
│  ├─ rules/                 # ② 判定：9 种状态、注释停用、动态调用清单、文件内调用链
│  ├─ history/               # ③ git 追溯：引入、引用时间线、失去引用
│  ├─ verify/                # ⑤ 验证：worktree 实删 + 构建 / 测试 / 警告的基线对比
│  ├─ report/                # ④ 输出：Markdown 报告、README、文件头注释模板
│  ├─ quarantine/            # 隔离：git mv → 加头注释，分两次提交
│  └─ plugins/               # 框架与构建工具插件
│     ├─ vue2-sfc/           #   解析 Vue2 单文件组件
│     ├─ vue3-sfc/           #   解析 Vue3 单文件组件（含 <script setup>）
│     ├─ ts/                 #   TypeScript
│     ├─ vite-alias/         #   Vite 的 alias、import.meta.glob
│     ├─ tsconfig-paths/     #   tsconfig 的 paths
│     └─ vue-router/         #   路由懒加载
├─ profiles/                 # 各项目配置（入口、alias、插件、动态调用基线）
│  └─ example.js             #   示例配置（入库）；真实项目的配置只留在本机
├─ test/
│  ├─ fixtures/              # 每个踩过的坑一个最小样例项目（入库）
│  └─ golden/                # 基于真实项目的标准答案（只留在本机）
├─ reference/                # 排查会话里的原型脚本和分析结果（只留在本机，仅供参考）
├─ reports/                  # 运行时生成的报告（不入库）
├─ .tmp/                     # 运行时的临时 worktree（不入库）
├─ package.json
└─ README.md
```

数据在各层之间的流向：

```
① collect  →  ② rules  →  ③ history  →  ⑤ verify  →  ④ report
 依赖图        9 种状态      引入/失去引用   实删对比      Markdown / README / 头注释
              + 证据
        └──────────── 全程读写同一份 JSON ────────────┘
```

### 9 种状态

表格顺序就是优先级：同时满足多种情况时，取排在最前面的那个。原则是**越不敢删的越优先**，只有排除了前面所有情况，才会落到 `dead`。

| 状态 | 判定特征 | 处理 |
|---|---|---|
| `unknown` 无法判定 | 有拼接路径的动态 import、`window[name]` 等写法，无法确定是否用到 | 人工确认；工具不猜测为 dead |
| `external` 图外使用 | 被构建配置、index.html、public 或其他项目引用 | 保留 |
| `pending` 其他分支在用 | 当前分支没人用，但未合并的分支引用了它 | 等那个分支合并或关闭后再判断 |
| `dormant` 注释停用 | 引用被注释掉，有恢复的可能 | 保留原位，不隔离 |
| `internal` 内部在用 | 外部没人 import，但被文件内在用的函数调用 | 不能删，只能去掉 `export` |
| `live` 在用 | 从入口能走到 | 保留 |
| `test-only` 仅单测引用 | 只有测试用到 | 确认业务是否还需要；删的话连同测试一起删 |
| `dead-only-ref` 仅死代码引用 | 引用方本身不可达（含互相引用但入口走不到的一组文件） | 跟着引用方一起处理 |
| `dead` 死代码 | 引用已删除，或从未被引用 | 隔离 → 观察 → 删除 |

前 5 种的共同点：只看入口的 import 关系像是没人用，但不能动。

### 标签

处理方式和某种已有状态一样的情况，不新增状态，只在 `evidence` 里加标签说明原因：

| 标签 | 含义 |
|---|---|
| `side-effect` | 只为副作用引入，不使用任何导出（注册全局指令、polyfill） |
| `global-mount` | 通过全局挂载使用（如 `Vue.prototype.$log`），模板里用 `$xxx` 访问 |
| `dev-only` | 只在开发环境或 mock 中使用 |
| `type-only` | 只用作 TS 类型（`import type`），构建后不存在 |
| `replaced-by` | 已被新实现替代 |
| `business-check` | 代码能访问到，但业务入口可能已关闭（路由还在、菜单隐藏），需人工确认 |

状态和标签的定义以 `src/core/schema.js` 为准。

---

## 用法

### 已经可以用的：scan + history + report

**安装**：在 code-audit 目录运行 `npm install`，会连带装上 knip（可选依赖，只有 scan 用到；需要 Node 20.19 或 22.12 以上）。

**1. 写项目配置**（复制 `profiles/example.js`），scan 至少要写入口：

```js
export default {
  entries: ['src/main.js'],
  testEntries: ['src/**/*.test.js'],   // 可选：区分「只有测试用到」
  aliases: { '@': 'src' },             // 照抄构建配置里的 resolve.alias
  scanIgnore: ['src/mock/**']          // 可选：不列为候选的文件
}
```

**2. 扫描**，找出从入口走不到的文件，生成候选清单：

```bash
node bin/code-audit.js scan --root ../my-app --profile profiles/my-app.js --out reports/my-app/candidates.json
```

scan 先找出「从入口走不到」的文件，再由规则层（`src/rules/`）判定状态，写进候选清单；history 只补历史，不改状态。分析的是提交里的代码（默认 HEAD，`--rev` 可指定），工作区没提交的改动不算：文件导出到系统临时目录再分析，不碰目标仓库的工作区和暂存区。提交号写进候选清单的 `rev`，history 默认查同一个提交，两边看到的是同一份代码。没有候选时输出空的 `files`，照样能交给 history、report。代码里的 `import.meta.glob` 会自动换算成入口；参数不是字符串的 glob 换算不了，会在输出里提示。

路径里有变量的动态加载（`import('./views/' + name)`、`require.context('./modules')` 等），按路径里固定的开头和结尾圈出可能加载的文件，落在范围里的候选判为 `unknown`，引用里记下加载的位置。路径开头就是变量（如 `import(path)`、`import(name + '.vue')`）时确定不了目录，范围是整个仓库，只按路径里固定的结尾缩小，圈到的都判 `unknown`。人工确认它不加载本地源码后，写进配置：

```js
reviewedDynamicLoads: [
  { from: 'src/utils/loader.js', expr: 'import(url)', reason: '加载的是 CDN 上的脚本' }  // expr 照抄 scan 输出
]
```

之后它不再圈文件，范围里判为 `dead` 的，证据会写上这条理由。

knip 不分析的文件（构建配置、脚本、index.html、package.json，源码目录里的 json 等）里写着候选的路径时，判为 `external`，比如 vite 配置里 `path.resolve(__dirname, 'src/shims/stub.js')`。测试文件里写的不算。

在用的代码、配置文件的注释里有引号括起来的路径（如 `// import { check } from '@/utils/check.js'`），判为 `dormant`：以前用过、以后可能恢复，要留在原位。没人用的文件里的注释不算。

没合并的分支在用的判为 `pending`：分支自己改过的文件 import 了它，或者分支改了它本身（只读本地已有的分支，scan 前可以自己 fetch 一下）。不会再合回来的老版本线可以排除：

```js
branches: { ignore: ['origin/release/**'], maxAgeDays: 180 }  // 默认都查
```

只有测试用到的判为 `test-only`，列出引用它的测试。候选之间的 import 会顺着传递：被要保留的文件（如 external）引用的，跟着保留；只被同样没人用的文件引用的，判为 `dead-only-ref`，跟着引用方一起处理。

Vue 全局注册的组件（unplugin-vue-components 生成的 `components.d.ts` 等，里面有 `interface GlobalComponents`）：模板里写标签就能用，不用 import。scan 读出登记的组件，按模板里的标签（`<BasicTable>`、`<basic-table>`）、写死名字的动态组件（`is="X"`、`:is="'X'"`）和 `resolveComponent('X')` 认出用法，交给 knip；声明文件本身、注释里的不算。名字是变量的（`:is="name"`）认不出。

**盲区兜底：看不准的不判死。** 静态分析有认不出的写法（动态组件名字是变量、全局注册没有声明文件、别名没配置的 glob、自动导入、拼出来的路径等）。scan 会先认出这些盲区，可能受影响的候选判 `unknown`（注释里出现的判 `dormant`），证据写明看到了什么、为什么不能确认。动态加载类的盲区，人工确认后写进 `reviewedDynamicLoads` 才放过。明细见 `docs/progress.md` 的「盲区兜底」。

源码里有 `.vue` 而 package.json 没声明 vue 时（monorepo、没有 package.json），knip 会跳过 .vue 文件。scan 只在临时目录里补上依赖声明，输出里会提示。

knip 的插件会加载项目里的配置文件（等于执行项目代码），所以 scan 关掉了全部插件，只保留解析 `.vue` / `.svelte` / `.astro` 的插件，并且不让它们读配置文件；跑完还会核对实际启用了哪些插件，有漏关的就报错。

也可以不用 scan，手写候选清单：

```json
{
  "project": "my-app",
  "entries": ["src/main.js"],
  "files": [
    { "file": "src/utils/old.js" },
    { "file": "src/_deprecated/math.js", "notes": ["依赖已移除，恢复引用会导致构建失败"] },
    { "file": "src/lib/x.js", "pattern": "lib/x" }
  ]
}
```

`pattern` 可以不写，默认由文件最初的路径推出；`notes` 是人工备注，会原样出现在报告和头注释里。手写时也可以加 `"rev": "<完整提交号>"`，history 就查那个提交；不写就查 HEAD。

**3. 批量查 git 历史**，输出符合 schema 的完整数据：

```bash
node bin/code-audit.js history --root ../my-app --profile profiles/my-app.js --in reports/my-app/candidates.json --out reports/my-app/data.json
```

**4. 生成报告、隔离清单、头注释**：

```bash
node bin/code-audit.js report --in reports/my-app/data.json --out reports/my-app/out --moved-at 2026-11-05
```

输出目录里有：

```
report.md             排查报告：概况、状态汇总、清单、每项详情
quarantine-table.md   隔离清单表格
headers/<路径>.txt    每个文件的头注释（没有历史或不能写注释的文件会跳过，并说明原因）
```

查单个文件：

```bash
node bin/code-audit.js history --root ../my-app --file src/utils/old.js
```

各命令都支持 `--profile profiles/<项目名>.js`，用项目配置覆盖默认值（源码目录、扩展名、文案、表格列等），写法见 `profiles/example.js`。

**安全约定**：输出不能写在被分析的仓库里；输出文件已存在、输出目录不为空时直接报错，工具不覆盖、不删除已有文件。

什么都没命中、也没被候选引用的，判为 `dead`，证据写明排除了哪些情况。其余候选暂时也是 `unknown`，证据里写着「规则层还没做完」，和真正「无法判定」的可以区分开。

**5. 试跑基线**（verify 第一部分）：在 profile 里写上构建、测试命令，确认它们能在临时目录里无人值守跑通：

```js
verify: { build: 'npm run build', test: 'npm test', timeoutSeconds: 1800 }  // 命令没有默认值；不能停下来等人输入
```

```bash
node bin/code-audit.js verify --root ../my-app --profile profiles/my-app.js [--keep]
```

代码从提交里导出到系统临时目录，`node_modules` 克隆一份（macOS 上几秒、不占额外磁盘），构建、测试都在那里跑，原项目不写任何东西。`--keep` 保留临时目录和完整日志，排查用。

**6. 实删验证**：把 `dead`、`dead-only-ref` 实际删掉，跑构建、测试，和基线比较：

```bash
node bin/code-audit.js verify --root ../my-app --profile profiles/my-app.js --in reports/my-app/data.json --out reports/my-app/verified.json
node bin/code-audit.js report --profile profiles/my-app.js --in reports/my-app/verified.json --out reports/my-app/out
```

- 只看新增的问题：基线本来就失败的测试、本来就有的警告不算。基线本来就有失败时，还会比退出码、通过的用例数，测试整个崩了也能发现
- 完整输出写进日志（不截断）；比较用整个输出里的关键行（失败、警告、通过、汇总、报错），输出再长也不漏
- 全部删掉没问题，一般 2 轮就结束；有问题时先从报错里认出是哪些文件，认不出再对半找（最多 40 轮）
- 有 import 关系的候选绑在一起删（引用方和被引用的），不会冤枉被引用的
- 删了会出问题的，状态改为 `unknown`，证据写上出了什么问题；新增的构建警告列出来给人看，不算失败

**7. 隔离**：把 dead / dead-only-ref、并且实删验证通过的文件移进隔离区。**唯一会改动目标项目的命令**：

```bash
node bin/code-audit.js quarantine --root ../my-app --profile profiles/my-app.js --in reports/my-app/verified.json           # 只打印计划
node bin/code-audit.js quarantine --root ../my-app --profile profiles/my-app.js --in reports/my-app/verified.json --apply   # 执行
```

- 隔离区在 profile 里配置 `quarantine: { dir: 'src/utils/_deprecated', base: 'src/utils' }`，默认 `<源码目录>/_deprecated`；子目录结构不变
- `--apply` 前检查：工作区干净、当前提交就是分析的提交、新分支名没被占用
- 新建分支（默认 `code-audit/quarantine-<日期>`），分两次提交：第一次只移动（git 认得出改名），第二次加头注释、修正相对路径（优先改成别名）、更新隔离区 README。不 push
- git 钩子照常执行；任何一步出错都整体撤回，目标项目回到执行前的样子
- lint 配置不自动改，计划里列出要手动加的那一行

---

## 开发

```bash
node -v        # 核心需要 Node 18 及以上；scan（knip）需要 20.19 或 22.12 以上
npm install    # 装上 knip（可选依赖）
npm test       # 使用 Node 内置的 node --test
```

没装 knip 时，真正调用 knip 的测试会自动跳过，其余测试照常运行。`test/golden/` 依赖本机有对应的真实项目；找不到时，相关测试会自动跳过，不会失败。

---

## ⚠️ 数据安全

本仓库只存放与公司无关的工具代码和自己编写的小样例。以下内容**只留在本机，不入库**，已在 `.gitignore` 中排除：

| 目录 | 内容 |
|---|---|
| `reference/` | 排查会话里的原型脚本和分析结果 |
| `test/golden/` | 基于真实项目的标准答案 |
| `profiles/*`（`example.js` 除外） | 真实项目的配置 |
| `reports/` | 分析报告 |

提交前养成习惯：

```bash
git add <具体文件>        # 尽量指定文件名，少用 git add -A
git status --short       # 确认列表里没有上面这些目录
```

---

## 路线图

| 里程碑 | 内容 |
|---|---|
| M0 | 仓库骨架、JSON 数据结构、命令行框架、标准答案 |
| M1 | history 模块 |
| M2 | report 模块 |
| M3 | 分析引擎选型（knip 试验）+ scan |
| M4 | 规则层：注释停用、动态调用、文件内调用链 |
| M5 | verify 模块 |
| M6 | 接入第二个项目（Vue3 + TS） |
| M7 | 接口维度、quarantine、打包成 tgz |
