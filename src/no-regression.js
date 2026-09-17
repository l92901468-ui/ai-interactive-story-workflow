// 累计不回退清单。
//
// 每加一条新规则、每次改路径，都要重跑这张清单：新改进不能让已经确认的方向
// 悄悄失效。原项目踩过的坑就是「加了新审核板块，把来源隔离挤掉了」。

function gateStatus(quality, id) {
  if (!quality) return 'missing';
  const gate = quality.gates.find((item) => item.id === id);
  return gate ? gate.status : 'missing';
}

const NO_REGRESSION = [
  {
    id: 'source_isolation',
    label: '来源隔离：概述不进文风槽',
    check: (context) => {
      const routing = (context.state && context.state.retrieval && context.state.retrieval.routing) || [];
      const planningIds = new Set(routing.filter((item) => item.slot === 'planning').map((item) => item.id));
      const styleIds = routing.filter((item) => item.slot === 'style').map((item) => item.id);
      const leaked = styleIds.filter((id) => planningIds.has(id));
      return { status: leaked.length ? 'fail' : 'pass', detail: leaked.length ? '概述资料混进文风槽：' + leaked.join(', ') : '两个槽位无重叠' };
    }
  },
  {
    id: 'continuity',
    label: '连续性：正文承接已登记事实',
    check: (context) => {
      const guard = context.state && context.state.continuityGuard;
      if (!guard) return { status: 'missing', detail: '没有连续性守卫结果' };
      const output = guard.output;
      if (!output.expectedIds.length) return { status: 'pass', detail: '本轮没有期望的连续性事实' };
      return { status: output.status === 'pass' ? 'pass' : 'review', detail: '命中 ' + output.matchedIds.length + '/' + output.expectedIds.length };
    }
  },
  {
    id: 'event_completion',
    label: '事件完成度：每个决策节点都有正文实现',
    check: (context) => {
      const draft = context.state && context.state.draft;
      const plan = context.state && context.state.plan;
      if (!draft || !plan) return { status: 'missing', detail: '缺少草稿或规划' };
      const linked = new Set(draft.decisionLinks.map((link) => link.nodeId));
      const missing = plan.decisionNodes.filter((node) => !linked.has(node.id)).map((node) => node.id);
      return { status: missing.length ? 'fail' : 'pass', detail: missing.length ? '未落正文的决策节点：' + missing.join(', ') : '全部决策节点都有实现链接' };
    }
  },
  {
    id: 'decision_ownership',
    label: '决策所有权：图与失败覆盖完整',
    check: (context) => {
      const status = gateStatus(context.quality, 'graph_integrity');
      return { status: status === 'pass' ? 'pass' : 'fail', detail: 'graph_integrity=' + status };
    }
  },
  {
    id: 'failure_coverage',
    label: '失败覆盖：选择节点都有明确失败分支',
    check: (context) => {
      const status = gateStatus(context.quality, 'failure_coverage');
      return { status: status === 'pass' ? 'pass' : 'fail', detail: 'failure_coverage=' + status };
    }
  },
  {
    id: 'variable_settlement',
    label: '变量结算：生命周期完整',
    check: (context) => {
      const status = gateStatus(context.quality, 'variable_lifecycle');
      return { status: status === 'pass' ? 'pass' : 'fail', detail: 'variable_lifecycle=' + status };
    }
  },
  {
    id: 'knowledge_boundary',
    label: '知识边界：召回与不确定项可追溯',
    check: (context) => {
      const status = gateStatus(context.quality, 'traceability');
      return { status: status === 'pass' ? 'pass' : 'fail', detail: 'traceability=' + status };
    }
  },
  {
    id: 'causal_trace',
    label: '因果追踪：上下文/草稿/请求哈希齐备',
    check: (context) => {
      const generation = context.generation || {};
      const missing = ['contextHash', 'planHash', 'draftHash', 'requestHash'].filter((key) => !generation[key]);
      return { status: missing.length ? 'fail' : 'pass', detail: missing.length ? '缺少：' + missing.join(', ') : '四类哈希齐备' };
    }
  }
];

function runNoRegression(context) {
  const results = NO_REGRESSION.map((item) => {
    const outcome = item.check(context);
    return { id: item.id, label: item.label, status: outcome.status, detail: outcome.detail };
  });
  const failed = results.filter((item) => item.status === 'fail');
  return { passed: failed.length === 0, results: results, failedIds: failed.map((item) => item.id) };
}

module.exports = { NO_REGRESSION: NO_REGRESSION, runNoRegression: runNoRegression };
