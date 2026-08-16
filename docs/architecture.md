# Architecture

## 设计目标

这个最小实现优先追求三件事：可解释、可回归、可公开。

```text
Synthetic JSON
    │
    ▼
Context Selector ── evidence IDs / scores / uncertainties
    │
    ├───────────────┐
    ▼               ▼
Graph Validator   Variable Validator
    │               │
    └───────┬───────┘
            ▼
        Quality Gates
            │
      pass / review / fail
            │
            ▼
 Review Plan + Snapshot + SHA-256 Receipt
```

## 模块职责

### `src/context-selector.js`

使用本地关键词和标签做可解释排序。它不是生产级向量数据库，但会保留：

- 被选证据 ID 与分数
- 被排除证据 ID
- 置信度等级
- 需要人工确认的不确定项
- 上下文快照哈希

### `src/validators.js`

图校验器覆盖节点/边、唯一入口、可达性、非终点死路、选择分支数和失败覆盖。变量校验器检查 `setAt/readAt/payoffAt/settleAt` 的完整性、节点引用与基本顺序。

### `src/quality-gates.js`

把上下文、图、失败覆盖、变量和追溯性拆成独立 gate。每个 gate 的结果为 `pass`、`review` 或 `fail`，并生成结构化修复计划。

### `src/workflow.js`

编排全流程，生成高层阶段计划、验证摘要、snapshot 和 receipt。它不会调用模型，也不包含真实 Prompt。

### `src/hash.js`

对对象键排序后再计算 SHA-256，从而让相同合成输入获得稳定回执，便于回归比较。

## 安全边界

输入必须显式标记为合成数据。仓库没有上传、网络请求、密钥读取、数据库或云服务代码。
