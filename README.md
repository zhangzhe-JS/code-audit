# code-audit

前端项目的**删除排查工具**。删除「看起来没人用」的文件、导出或接口之前，用它回答三个问题：

1. **真的没人用吗？** 从入口做可达性分析，检查文件内调用链，排除动态调用
2. **它是怎么变成没人用的？** 用 git 追溯引入、引用和失去引用的提交
3. **删掉会不会出问题？** 在隔离的 worktree 里实际删掉，再和构建、测试的基线对比

> 状态：开发中（M0 仓库骨架）。下文的命令是规划中的用法，尚未全部实现。

---

## 设计原则

| 原则 | 含义 |
|---|---|
| **默认只读** | 从项目外部分析，不往目标项目里加任何文件。只有 `quarantine` 命令会改动目标项目，且必须显式执行 |
| **插件化** | 核心与框架无关。Vue2 / Vue3 / TS / Vite 等差异放在插件里，按项目配置选用 |
| **数据驱动** | 每一步读写统一格式的 JSON，报告只从 JSON 生成，不手写结论 |
| **零运行时依赖** | 只使用 Node 内置模块；发布时打包成单文件 tgz，不影响目标项目的依赖 |
| **不碰目标仓库的共享状态** | 不使用 `git stash`，用完的 worktree 一定清理，从不 `push` |

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
│  └─ fin-audit.js           # 命令行入口：解析参数，分发到各子命令
├─ src/
│  ├─ commands/              # 子命令，每个命令一个文件
│  │  ├─ scan.js             #   采集 + 判定，输出候选清单 JSON
│  │  ├─ history.js          #   为候选补充 git 历史
│  │  ├─ verify.js           #   在临时 worktree 里实删验证
│  │  ├─ report.js           #   从 JSON 生成报告
│  │  └─ quarantine.js       #   隔离到 _deprecated/（唯一会改动目标项目的命令）
│  ├─ core/                  # 核心：JSON 数据结构与校验、配置加载、插件机制
│  ├─ collect/               # ① 采集：依赖图、导出名、URL
│  ├─ rules/                 # ② 判定：6 种状态、注释停用、动态调用清单、文件内调用链
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
 依赖图        6 种状态      引入/失去引用   实删对比      Markdown / README / 头注释
              + 证据
        └──────────── 全程读写同一份 JSON ────────────┘
```

### 6 种状态

| 状态 | 判定特征 | 处理 |
|---|---|---|
| `live` 在用 | 从入口能走到 | 保留 |
| `test-only` 仅单测引用 | 只有测试用到 | 确认业务是否还需要；删的话连同测试一起删 |
| `dead-only-ref` 仅死代码引用 | 引用方本身不可达 | 跟着引用方一起处理 |
| `internal` 内部在用 | 外部没人 import，但被文件内在用的函数调用 | 不能删，只能去掉 `export` |
| `dormant` 注释停用 | 引用被注释掉，有恢复的可能 | 保留原位，不隔离 |
| `dead` 死代码 | 引用已删除，或从未被引用 | 隔离 → 观察 → 删除 |

---

## 用法（规划中）

```bash
# 分析：只读
node bin/fin-audit.js scan    --root ../path/to/project --profile <项目名>
node bin/fin-audit.js history --root ../path/to/project --in scan.json
node bin/fin-audit.js verify  --root ../path/to/project --in scan.json
node bin/fin-audit.js report  --in scan.json --out reports/<项目名>/

# 单个文件的 git 历史
node bin/fin-audit.js history --root ../path/to/project \
  --file src/utils/xxx.js --pattern "utils/xxx" --rev <提交号>

# 隔离：会改动目标项目，需要显式执行
node bin/fin-audit.js quarantine --root ../path/to/project --in scan.json
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
