# Data flow and validation contract

## 输入契约

最小输入包含：

- `metadata.synthetic=true`
- `project.id` 与 `project.title`
- `query`
- `evidence[]`
- `graph.nodes[]`
- `variables[]`

完整合成样例见 [`examples/input/synthetic-story.json`](../examples/input/synthetic-story.json)。

## 上下文选择

选择器对 query、标题、正文和 tags 做本地词项重合计算，并根据 evidence confidence 做轻量加权。该方案刻意保持透明，便于在作品集中说明每一条证据为什么被选中。

低相关度不会被伪装成高置信结果：质量门会返回 `review`，同时保留不确定项。

## 图校验

检查项包括：

- 唯一 start 节点
- 节点 ID 唯一
- transition 目标存在
- 从 start 可达
- 非 ending/failure 节点不能无出口
- choice 至少两个分支
- choice 至少包含一条显式 failure 分支

## 变量生命周期

每个变量使用四个数组表示生命周期：

```json
{
  "id": "tide_map_verified",
  "setAt": ["N2"],
  "readAt": ["N3"],
  "payoffAt": ["N4"],
  "settleAt": ["N5"]
}
```

校验器检查每一阶段存在、节点引用有效，以及读取/兑现/结算不会出现在最早设置之前。

## 质量门与自动复审

质量门聚合五项结果：

1. Context relevance
2. Node and edge integrity
3. Choice failure coverage
4. Variable lifecycle
5. Evidence and uncertainty traceability

当结果不是 `passed` 时，自动复审模块会触发一次策略审查并输出 repair plan。本地演示只生成计划，不执行 LLM 改写。

## 回执

回执包含 input/context/validation/snapshot 哈希、证据 ID、图与变量统计、状态和复审结论。示例见 [`examples/output/synthetic-story-result.json`](../examples/output/synthetic-story-result.json)。
