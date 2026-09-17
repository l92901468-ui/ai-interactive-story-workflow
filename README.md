# AI Interactive Story Workflow

> **脱敏重建版 / Privacy-safe reconstruction**  
> 本仓库是使用全新代码与合成数据制作的公开作品集候选。它不包含任何公司或客户名称、真实剧本、内部 Prompt、业务数据、密钥、历史快照、备份或原 Git 历史。

一个仅依赖 Node.js 内置模块的工作流演示。它表达的是一条完整的创作闭环：

`合成输入 → 多 Agent 编排 → 分槽知识库召回 → 起草 → 守卫与质量门 → 复审 → 回执与持久日志`

以及闭环的另一半：

`编剧反馈（好坏 / 意见 / 改好的文章） → 差分 → 人工归因 → 调权与路径改进 → 下一轮生成`

## 我的贡献与边界

- 这是我独立完成的 clean-room 作品集重建：由我重新设计产品范围、工作流和数据结构，并使用全新合成数据表达通用能力。
- 我独立实现了 Node.js 核心工作流、多 Agent 编排、知识库、差分与反馈总账、质量门、哈希回执与原生测试，也独立完成静态 Demo 和全部 SVG 说明图。
- 本仓库不代表原公司的生产代码、真实数据、线上系统或业务指标；它只用于展示本人对问题拆解和工程实现的理解。

![Architecture overview](docs/images/architecture.svg)

## 为什么做这个重建版

互动叙事与 Agent 工作流经常同时面临三类问题：上下文来源难追踪、分支/变量容易失配、修改之后缺少稳定的回归证据。本项目把这些问题压缩成一个可阅读、可运行、可测试的公开演示，同时把所有示例替换为虚构的「雾灯群岛」合成故事。

## 能力概览

- **多 Agent 编排**：九个 agent 各司其职，顺序由可配置的 route 决定，每个 agent 都交代自己的权重、判定路径与耗时。
- **分槽知识库**：资料分 `planning / style / continuity` 三槽召回，每次命中都能解释分数由哪些因子构成。
- **生成期持久日志**：生成当时就把上下文哈希、计划哈希、草稿哈希、召回路由、每个门的权重与路径写进日志，缺任一项就标 `evidence_incomplete`。
- **决策节点到正文的映射**：每个决策节点都能回指到它落在正文的哪几行。
- **质量门与复审**：将上下文、图完整性、失败覆盖、变量与可追溯性组织成独立 gate，并把结论分成「可立即应用」与「待人工处理」两类。
- **编剧反馈闭环**：三种反馈形态统一处理；改好的文章入库成为下一轮语料；差分挂待归因，人工归因后才允许调权；路径改进只提建议，人工确认后才生效。
- **权重安全门**：只有归因到 `input_retrieval` 才产生调权证据，单次调权有上限，禁用需要明确指令或两次独立负面验证。
- **累计不回退清单**：每次改动后重跑，防止新规则把已确认的方向挤掉。
- **无外部依赖**：运行时只使用 Node.js 内置模块，不调用在线模型、数据库或云服务（模型调用为确定性 mock）。

## 产品原型

直接双击打开 [`demo/index.html`](demo/index.html)，即可切换「正常样例」「注入 Bad Case」「修复计划预览」三种状态。计划预览不会修改输入，也不会伪造修复后的通过结果。

![Static workbench prototype](docs/images/workbench.svg)

### 影游交互制作工作台

[`showcase/avg-demo-editor/`](showcase/avg-demo-editor/) 收录一套独立的高保真产品交互原型：用 **14 个可编辑 SVG 画板**覆盖素材导入、改编策略、角色/分支建模、变量触发、Storylet、多人推演、逻辑审校、试玩回放与导出协作。它用于展示复杂 AI 创作产品的信息架构和交互设计，不冒充已上线的商业工作台。

[查看案例说明](showcase/avg-demo-editor/README.md) · [打开响应式画廊](showcase/avg-demo-editor/index.html)

## 快速开始

要求：Node.js 18 或更高版本。

```bash
npm run check
npm test
npm run example
npm run example:badcase
```

将完整结果写入本地文件：

```bash
node src/cli.js run examples/input/synthetic-story.json examples/output/result.local.json
```

`result.local.json` 已被 `.gitignore` 忽略。仓库中提交的 [`examples/output/synthetic-story-result.json`](examples/output/synthetic-story-result.json) 是便于浏览的精简合成输出。

## 一、多 Agent 编排

一次生成按 route 顺序走完这九个 agent：

| Agent | 职责 |
|---|---|
| `planner` | 把概述拆成场景目标与决策节点 |
| `retriever` | 按槽位从知识库召回，记录路由与预算 |
| `drafter` | 生成候选正文，并给出决策节点→正文行区间的链接 |
| `continuityGuard` | 检查正文是否承接已登记事实 |
| `styleGuard` | 检查是否用到文风参考、是否出现库存回应 |
| `graphValidator` | 校验节点、边、可达性 |
| `variableValidator` | 校验变量生命周期与顺序 |
| `qualityGate` | 聚合各守卫，输出每门的权重与判定路径 |
| `reviewer` | 区分可立即生效与必须交人工处理的结论 |

每个 agent 的输出都带三样东西，缺一不可：

```json
{
  "id": "qualityGate",
  "weights": { "gateAggregation": 1 },
  "path": ["graph.validate", "variables.validate", "gate:aggregate"],
  "notes": ["每门的权重和路径已随回执落盘"]
}
```

route 不是写死在代码里的常量，而是可配置项。这正是「路径改进」能落地的前提。

## 二、知识库（RAG）

资料按用途分槽，召回时各槽单独打分：

| 槽 | 用途 |
|---|---|
| `planning` | 概述、目标、路线骨架 |
| `style` | 文风参考、对白样例 |
| `continuity` | 已登记事实、承接关系 |

每次命中都会带上分数解释，而不是只给一个数字：

```
termOverlap=0.5  confidence=0.98  canonicalBoost=0.08  slotBonus=0  learntDelta=0.1
```

其中 `learntDelta` 就是编剧反馈留下的痕迹——它是唯一会随反馈变化的因子，且只能按下面的安全门调整。

**编剧改好的正文会被摄入知识库**，同时进 `style`（正文）和 `continuity`（承接关系）两个槽，成为下一轮生成可用的语料。

## 三、编剧反馈闭环

完整说明见 [`docs/feedback-loop.md`](docs/feedback-loop.md)。核心是三条分级规则：

| 反馈 | 处理方式 |
|---|---|
| 编剧明确写出的意见 | **立即学习**，下一次必须装配 |
| 编剧提交的改好正文 | **立即入库**，成为下一轮语料 |
| 改稿里附带的明确意见 | **立即学习** |
| 从差分推断出的结论 | **挂起待人工归因**，未归因不得调权 |
| 路径该怎么改 | 只生成**推荐路径改进**，人工研究后再应用 |

三种输入形态（只给好坏 / 详细意见 / 直接给改好的文章）在改进权重这件事上没有区别，都是来源；区别只在于改好的文章额外承担「入库成为新知识」这一步。

### 权重安全门

- 只有归因到 `input_retrieval` 才产生调权证据
- 结论范围必须至少是「项目规律」或「可泛化失败」
- 单次调权幅度有上限，只能做条件化 boost/downrank
- 禁用（`avoid`）需要编剧明确禁用，或两次独立负面验证

### 跑一遍闭环

```bash
# 1) 提交编剧改好的文章（正文放本地，不入库）
node src/cli.js feedback --project=examples/input/synthetic-story.json \
  --input=feedback.json --text-file=private/writer-revision.local.txt

# 2) 看有哪些差分等待人工归因
node src/cli.js pending

# 3) 人工给出归因层与结论范围
node src/cli.js attribute --pending=<id> --layer=input_retrieval \
  --scope=project_pattern --direction=up --reason="召回漏了这条"

# 4) 生成推荐路径改进（此时仍是建议）
node src/cli.js propose

# 5) 人工研究后应用
node src/cli.js apply --proposal=<id>

# 6) 用新路径再跑一次
node src/cli.js run examples/input/synthetic-story.json
```

## 四、生成期持久日志

生成时落盘的不是结果，而是**当时的判定依据**：

```json
{
  "contextHash": "...", "planHash": "...", "draftHash": "...",
  "routing": [{ "slot": "continuity", "id": "EV-CANON-001", "score": 0.64 }],
  "gates": [{ "id": "graph_integrity", "status": "pass", "weights": {}, "path": [] }],
  "evidence": { "state": "complete", "missing": [] }
}
```

事后回推不出来——当时的召回路由、学习版本和决策节点映射都已经变了。缺任一项就标 `evidence_incomplete`，后续改稿学习不得据此调权。

## 五、累计不回退清单

每次改动后自动重跑，八个方向一个都不能退：

来源隔离 · 连续性 · 事件完成度 · 决策所有权 · 失败覆盖 · 变量结算 · 知识边界 · 因果追踪

回执里的 `noRegressionPassed` 就是这张清单的结果。

## 六、隐私与本地文件

- 运行时不联网、不调用任何在线模型
- 编剧正文通过 `--text-file` 从本地读入，建议放 `private/`
- `state/`、`private/`、`*.local.json`、`*.local.txt` 均已被 `.gitignore` 忽略
- 生成日志与知识库快照只写哈希、ID、分数和路径，不写正文

> 换句话说：你可以拿真实剧本在本地跑这套流程，但那些内容不会跟着提交上去。

## 七、数据流

1. 读取带有 `metadata.synthetic=true` 的 JSON；非合成输入会被拒绝。
2. 建知识库，按槽位召回，并显式保留不确定项。
3. 九个 agent 按 route 依次执行，各自记录权重与判定路径。
4. 校验节点、边、可达性、选择失败覆盖与变量生命周期。
5. 聚合质量门；存在失败或复核标记时生成修复计划，但不自动修改输入。
6. 输出 snapshot 与 receipt；回执包含输入、上下文、校验和快照哈希。

![Receipt and audit trail](docs/images/receipt-audit.svg)

## 八、目录结构

```text
src/                  多 Agent、知识库、差分与反馈、质量门、回执
test/                 Node 原生测试（33 个）
examples/input/       合成正常样例与合成 Bad Case
examples/output/      精简合成输出
demo/                 可直接本地打开的静态产品原型
docs/                 架构、数据流、反馈闭环与 GitHub 可渲染 SVG
showcase/             影游交互制作工作台高保真原型
private/              本地私有输入（已忽略，不入库）
state/                本地运行期状态（已忽略，不入库）
LICENSE               作品集专用保留权利声明
```

### 源码导览

| 文件 | 职责 |
|---|---|
| `src/agents.js` | 九个 agent 的定义与默认路径 |
| `src/orchestrator.js` | 按 route 执行并累计生成路径 |
| `src/knowledge-base.js` | 分槽知识库、可解释打分、调权安全门 |
| `src/context-selector.js` | 对外保持历史契约的上下文选择 |
| `src/quality-gates.js` | 质量门，每门记录权重与判定路径 |
| `src/revision-diff.js` | AI 稿与编剧改稿的逐行差分 |
| `src/feedback.js` | 反馈总账：立即学习 / 待归因 / 路径提案 |
| `src/generation-log.js` | 生成期持久日志与证据完整度判定 |
| `src/no-regression.js` | 累计不回退清单 |
| `src/llm-mock.js` | 确定性模拟模型，替换真实 API 时接口不变 |
| `src/workflow.js` | 编排入口，产出 snapshot 与 receipt |

## 九、Bad Case 回归示例

仓库提供一个故意破坏的合成输入，包含悬空边、不可达节点、选择分支数不足、失败分支缺失、死路和变量生命周期缺口。测试会验证这些问题能够被稳定识别并生成可读修复计划；计划需人工确认、修改输入后重新运行。

![Bad case repair comparison](docs/images/badcase-repair.svg)
