# 在 CI 里用 code-audit

两类任务：

1. **合并请求检查**（每个合并请求）：`code-audit check` 对比目标分支和当前分支的接口变化，结果写进 CI 日志和产物，可以按等级让流水线失败
2. **定时生成结果**（每天或合并后）：`code-audit api` / `exports` 生成各项目的结果，存成产物，给合并请求检查当 `--index`（判断别的项目还用不用）、给 `query` / `mcp` 查

code-audit 只读：两个提交都导出到临时目录分析，不改仓库、不提交、不推送。

## 准备

- 把 code-audit 打成 tgz（`npm pack`），放到 CI 能取到的地方（制品库、内网文件服务等），任务里 `npm install -g ./code-audit-<版本>.tgz`
- 项目配置（profile）放在 CI 能读到的地方。profile 里有项目的路径、接口规则，按团队约定决定放不放进仓库
- 需要完整历史：`GIT_DEPTH: 0`（check 要取目标分支；history 要查提交）
- Node 20.19 / 22.12 以上（knip 的要求）

## GitLab CI 示例

```yaml
variables:
  GIT_DEPTH: 0

# 合并请求：接口变化检查
api-check:
  stage: test
  image: node:22
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - npm install -g ./tools/code-audit-0.1.0.tgz          # 或从制品库下载
    - git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - mkdir -p out
    # --index：定时任务存下来的其他项目结果（没有可以不写，只是看不出别的项目用不用）
    - >
      code-audit check --root . --profile ci/code-audit.profile.js
      --base "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
      --index results/other-project.json
      --markdown out/api-check.md --out out/api-check.json
      --fail-on risk
    - cat out/api-check.md
  artifacts:
    when: always
    paths: [out/]
    expire_in: 2 weeks

# 定时：生成结果（给 check 的 --index、query、mcp 用）
api-results:
  stage: test
  image: node:22
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
  script:
    - npm install -g ./tools/code-audit-0.1.0.tgz
    - mkdir -p results
    - code-audit api --root . --profile ci/code-audit.profile.js --history --out results/$CI_PROJECT_NAME.json
    - code-audit exports --root . --profile ci/code-audit.profile.js --history --out results/$CI_PROJECT_NAME.exports.json
  artifacts:
    paths: [results/]
    expire_in: 30 days
```

说明：

- `--fail-on risk`：只有「要处理」（同一个函数调用的接口地址改了）时让流水线失败；想更严可以 `--fail-on warn`。刚接入时建议先不加，看几周结果再定
- 想把结果贴到合并请求的评论里，需要一个有评论权限的令牌（项目访问令牌等）调 GitLab API；code-audit 本身不发评论
- 规则认不出的新写法会出现在「要确认」里：补规则（profile 的 api）后结论才准。规则可以让模型读项目后生成、人审核

## 给 AI 编码工具用（MCP）

把定时任务的产物（results 目录）同步到本机或共享目录，登记 MCP 服务：

```bash
claude mcp add code-audit -- node <code-audit 目录>/bin/code-audit.js mcp --dir <results 目录> --check <仓库目录>::<profile>
```

AI 改接口、删函数、新增接口前，可以调 `api_impact`、`file_info`、`similar_apis` 查影响；`check_change` 对比两个提交，只能检查 `--check` 登记过的项目
（profile 是会被加载执行的 JS，不能让模型随意传路径）。
