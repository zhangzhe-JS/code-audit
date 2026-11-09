# code-audit

前端项目的**删除排查工具**。删除「看起来没人用」的文件、导出或接口之前，用它回答三个问题：

1. **真的没人用吗？** 从入口做可达性分析，检查文件内调用链，排除动态调用
2. **它是怎么变成没人用的？** 用 git 追溯引入、引用和失去引用的提交
3. **删掉会不会出问题？** 在隔离的 worktree 里实际删掉，再和构建、测试的基线对比

> 状态：开发中。M0（骨架）、M1（history）、M2（report）已完成，可以用 history + report 生成排查报告和头注释；scan、rules、verify 还没做。进度见 `docs/progress.md`。

---

## 设计原则

| 原则 | 含义 |
|---|---|
| **默认只读** | 从项目外部分析，不往目标项目里加任何文件。只有 `quarantine` 命令会改动目标项目，且必须显式执行 |
| **插件化** | 核心与框架无关。Vue2 / Vue3 / TS / Vite 等差异放在插件里，按项目配置选用 |
| **数据驱动** | 每一步读写统一格式的 JSON，报告只从 JSON 生成，不手写结论 |
| **零运行时依赖** | 只使用 Node 内置模块；发布时打包成单文件 tgz，不影响目标项目的依赖 |
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

### 已经可以用的：history + report

**1. 写候选清单**（以后由 scan 自动生成），放在被分析的仓库外面：

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

`pattern` 可以不写，默认由文件最初的路径推出；`notes` 是人工备注，会原样出现在报告和头注释里。

**2. 批量查 git 历史**，输出符合 schema 的完整数据：

```bash
node bin/code-audit.js history --root ../my-app --in candidates.json --out reports/my-app/data.json
```

**3. 生成报告、隔离清单、头注释**：

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

两个命令都支持 `--profile profiles/<项目名>.js`，用项目配置覆盖默认值（源码目录、扩展名、文案、表格列等），写法见 `profiles/example.js`。

**安全约定**：输出不能写在被分析的仓库里；输出文件已存在、输出目录不为空时直接报错，工具不覆盖、不删除已有文件。

现阶段候选清单是人工写的，还没有经过规则判定，所以每一项的状态都是 `unknown`。

### 规划中

```bash
node bin/code-audit.js scan       --root ../my-app --profile profiles/my-app.js   # M3：自动找出候选
node bin/code-audit.js verify     --root ../my-app --in data.json                 # M5：实删验证
node bin/code-audit.js quarantine --root ../my-app --in data.json                 # M7：隔离（会改动目标项目）
```

---

## 开发

```bash
node -v        # 需要 Node 18 及以上
npm test       # 使用 Node 内置的 node --test，无需安装依赖
```

`test/golden/` 依赖本机有对应的真实项目；找不到时，相关测试会自动跳过，不会失败。

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
