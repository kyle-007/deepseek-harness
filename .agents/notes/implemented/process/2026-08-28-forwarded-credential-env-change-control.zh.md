# Agent Note：转发凭据豁免集合的变更管控

Status: implemented

[English](2026-08-28-forwarded-credential-env-change-control.md) | 中文

## Problem

`scrubbedParentEnv` 会丢弃每一个匹配 `SENSITIVE_ENV_PATTERN` 的环境名称，使 harness 自身的机密绝不会隐式到达被 spawn 的子进程。转发开发者 CLI 凭据则为一份具名清单 `FORWARDED_CREDENTIAL_ENV` 重新打开了那道边界。硬编码的豁免清单正是那种会悄悄膨胀的界面：往 `Set` 字面量里加一个看起来合理的名称只是两行 diff，却把一份新凭据交给了由模型驱动的子进程，而无论是 diff 还是代码注释，都不会告诉评审者这份凭据能触及什么、又是谁同意的。仓库里没有任何东西把该集合与一份记录关联起来，因此评审者无从区分经过评审的新增与未经评审的新增，而拼错的条目（`NPM_TOKN`）只会静默失效，而不是大声失败。

## Decision

`FORWARDED_CREDENTIAL_ENV` 由一个 `doc-sync` gate 而非约定来做变更管控。集合本身仍是这些名称的唯一来源；逐变量的安全记录——用途、该凭据授予模型所 spawn 的任意进程的访问范围、以及它落地时所依据的评审——存放在[子进程子系统页面](../../../../docs/subsystems/subprocess.zh.md)两个语言侧的同一张表中，并由渲染时不可见的标记 `<!-- forwarded-credential-env -->` 固定位置。理由只有一个归属地：文档，而不是每个条目旁的注释。

[`verify-forwarded-credential-env`](../../../../scripts/verify-forwarded-credential-env.ts) 用 TypeScript AST 从 seam 源码中解析 `FORWARDED_CREDENTIAL_ENV` 与 `SENSITIVE_ENV_PATTERN`——处于源码平面，无需 workspace 解析，也不存在第二份正则副本——并从原始表格行解析每份记录表，因此尽管列标题被翻译，两个语言侧的判定完全一致。以下情形会失败：某个被转发的名称没有对应行、集合中已不存在的行、记录顺序与声明顺序不一致、用途/风险/评审单元格为空，以及条目非全大写或不匹配 `SENSITIVE_ENV_PATTERN`。后两项是拼写检查：`scrubbedParentEnv` 只会针对已被该正则匹配、且转为大写后的名称查询该集合，因此未通过其中任一检查的条目都是死代码，而读者仍会把它读作一条生效中的豁免。

该 gate 已加入 [scripts/run-gates.ts](../../../../scripts/run-gates.ts) 的 `docSyncLeafGates`，因此会在 `doc-sync`、`check-all` 以及阻断 pull request 的 `ci-primary` 聚合中运行。它的各条接受路径在 [scripts/verify-forwarded-credential-env.spec.ts](../../../../scripts/verify-forwarded-credential-env.spec.ts) 中被证明确实会拒绝，该测试同时也对仓库现存记录进行判定。

## Alternatives considered

- **用 `CODEOWNERS` 条目要求安全团队审批 seam 文件** —— GitHub 会静默忽略无法解析的 owner，因此虚构一个团队 handle 等于装上一个看似生效、实则无效的控制。评审路由属于仓库管理决策，不是本次变更可以断言的；无论由谁评审，该 gate 都会阻断合并。
- **在 pull request 模板里加一条清单项** —— 对每个 pull request 都是无条件的噪音，而且勾选框是自证的。只有集合真的发生变化时，该 gate 才会发声。
- **在每个 `Set` 成员旁写逐条理由注释** —— 一旦文档也描述该集合，安全记录就有了两个归属地；而且对浏览子系统页面的读者来说注释是不可见的。该 gate 转而让唯一的归属地保持诚实。
- **在 gate 中直接 import 该常量而非解析源码** —— `@deepseek-ai/dsh-subprocess` 既不是根依赖，也不在 `tsconfig.base.json` 的 path 别名中，因此 import 它就意味着为了跑一项文档检查而新增一个根依赖；而且在每个同类文档 gate 都判定源码时，它判定的却是产物平面。
- **单独建一个 `docs/credentials.md` 页面** —— 为了一张表而新增一个双语页面、配套 sidecar 与站点投影，还把环境清除这件事从拥有它的 seam 边上拆开。

## Consequences

- 新增、重命名或移除一个被转发的凭据，如今都需要在两个语言侧各写一行记录，在此之前 `doc-sync` 与 CI 都会失败；评审引用是必填单元格，因此未经评审的新增会明显地不完整，而不是隐形。
- `FORWARDED_CREDENTIAL_ENV` 必须保持为对普通字符串字面量的 `new Set([...])`，`SENSITIVE_ENV_PATTERN` 必须保持为正则字面量；若其中之一被重构或改名，该 gate 会抛出命名诊断，而不是报告一个空集合。
- 记录的顺序被固定为声明顺序，因此代码与表格的评审 diff 能逐行对齐。
- 强制的是文档的完整性与有效性，而不是某项豁免是否*合理*。某份凭据究竟该不该进入该集合，仍是评审判断，只是如今有了 gate 保证必然存在的访问范围一列作为依据。
