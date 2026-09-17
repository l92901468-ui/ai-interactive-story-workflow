// 每个质量门除了给出结论，还要把**它是怎么得出结论的**写下来：
//   weights       判定时每个因素各占多少（可被反馈调权）
//   path          这个门的数据经过了哪些步骤（事后回看用）
//   contributions 每个因素的原始值、权重和贡献
// 生成时这些信息会跟着回执一起落持久日志，缺了就只能标 evidence_incomplete。

const DEFAULT_GATE_WEIGHTS = {
  context_relevance: { averageScore: 0.6, selectedCount: 0.2, uncertaintyPenalty: 0.2 },
  graph_integrity: { danglingEdge: 0.4, unreachableNode: 0.3, deadEnd: 0.3 },
  failure_coverage: { choiceArity: 0.5, failureBranch: 0.5 },
  variable_lifecycle: { completeness: 0.6, nodeReference: 0.2, ordering: 0.2 },
  traceability: { contextHash: 0.4, uncertaintyTrace: 0.6 }
};

function mergeWeights(overrides) {
  const merged = {};
  for (const gateId of Object.keys(DEFAULT_GATE_WEIGHTS)) {
    merged[gateId] = Object.assign({}, DEFAULT_GATE_WEIGHTS[gateId], (overrides && overrides[gateId]) || {});
  }
  return merged;
}

function contribution(factor, weight, raw, note) {
  return { factor: factor, weight: weight, raw: raw, note: note };
}

function countCode(issues, code) {
  return issues.filter((item) => item.code === code).length;
}

function makeRepairPlan(context, graphReport, variableReport) {
  const plan = [];
  if (context.confidence === 'low') {
    plan.push({ action: 'context', message: 'Add or retag synthetic evidence, then rerun context selection.' });
  }
  const graphCodes = new Set(graphReport.issues.map((item) => item.code));
  if (graphCodes.has('DANGLING_EDGE')) plan.push({ action: 'graph', message: 'Replace transitions that point to missing node ids.' });
  if (graphCodes.has('UNREACHABLE_NODE')) plan.push({ action: 'graph', message: 'Connect or remove unreachable nodes.' });
  if (graphCodes.has('DEAD_END')) plan.push({ action: 'graph', message: 'Add a transition or mark the node as an ending/failure.' });
  if (graphCodes.has('CHOICE_ARITY') || graphCodes.has('CHOICE_FAILURE_COVERAGE')) {
    plan.push({ action: 'coverage', message: 'Give every choice at least two branches, including one explicit failure path.' });
  }
  if (variableReport.issues.length) {
    plan.push({ action: 'variables', message: 'Complete set/read/payoff/settlement references and rerun lifecycle checks.' });
  }
  return plan;
}

function buildQualityReport(input) {
  const context = input.context;
  const graphReport = input.graphReport;
  const variableReport = input.variableReport;
  const upstreamPath = input.upstreamPath || [];
  const weights = mergeWeights(input.gateWeights);

  const graphIssues = graphReport.issues.filter((item) => item.code !== 'CHOICE_ARITY' && item.code !== 'CHOICE_FAILURE_COVERAGE');
  const failureIssues = graphReport.issues.filter((item) => item.code === 'CHOICE_ARITY' || item.code === 'CHOICE_FAILURE_COVERAGE');

  const contextWeights = weights.context_relevance;
  const uncertaintyCount = (context.uncertainties || []).length;
  const contextRaw = {
    averageScore: context.averageScore || 0,
    selectedCount: (context.selected || []).length,
    uncertaintyPenalty: uncertaintyCount ? 1 : 0
  };
  const contextGates = [
    { id: 'context_relevance', label: 'Context relevance',
      status: contextRaw.selectedCount ? (context.confidence === 'low' ? 'review' : 'pass') : 'fail',
      details: { confidence: context.confidence, averageScore: context.averageScore, selectedEvidenceIds: (context.selected || []).map((item) => item.id) },
      weights: contextWeights,
      path: upstreamPath.concat(['kb.search', 'gate:context_relevance']),
      contributions: [
        contribution('averageScore', contextWeights.averageScore, contextRaw.averageScore, '选中资料的平均分'),
        contribution('selectedCount', contextWeights.selectedCount, contextRaw.selectedCount, '命中条数，为 0 直接判失败'),
        contribution('uncertaintyPenalty', contextWeights.uncertaintyPenalty, contextRaw.uncertaintyPenalty, '存在待人工确认的不确定项')
      ] }
  ];

  const graphWeights = weights.graph_integrity;
  const graphGates = [{
    id: 'graph_integrity', label: 'Node and edge integrity',
    status: graphIssues.length ? 'fail' : 'pass',
    details: { issues: graphIssues },
    weights: graphWeights,
    path: upstreamPath.concat(['graph.validate', 'graph.distances', 'gate:graph_integrity']),
    contributions: [
      contribution('danglingEdge', graphWeights.danglingEdge, countCode(graphReport.issues, 'DANGLING_EDGE'), '指向不存在节点的边'),
      contribution('unreachableNode', graphWeights.unreachableNode, countCode(graphReport.issues, 'UNREACHABLE_NODE'), '起点不可达的节点'),
      contribution('deadEnd', graphWeights.deadEnd, countCode(graphReport.issues, 'DEAD_END'), '非终点却没有出边')
    ]
  }];

  const coverageWeights = weights.failure_coverage;
  const coverageGates = [{
    id: 'failure_coverage', label: 'Choice failure coverage',
    status: failureIssues.length ? 'fail' : 'pass',
    details: { issues: failureIssues },
    weights: coverageWeights,
    path: upstreamPath.concat(['graph.validate', 'gate:failure_coverage']),
    contributions: [
      contribution('choiceArity', coverageWeights.choiceArity, countCode(graphReport.issues, 'CHOICE_ARITY'), '选择节点分支不足'),
      contribution('failureBranch', coverageWeights.failureBranch, countCode(graphReport.issues, 'CHOICE_FAILURE_COVERAGE'), '选择节点缺少明确失败分支')
    ]
  }];

  const variableWeights = weights.variable_lifecycle;
  const variableGates = [{
    id: 'variable_lifecycle', label: 'Variable lifecycle',
    status: variableReport.issues.length ? 'fail' : 'pass',
    details: { issues: variableReport.issues },
    weights: variableWeights,
    path: upstreamPath.concat(['graph.validate', 'variables.validate', 'gate:variable_lifecycle']),
    contributions: [
      contribution('completeness', variableWeights.completeness, countCode(variableReport.issues, 'VARIABLE_LIFECYCLE_INCOMPLETE'), '生命周期阶段缺失'),
      contribution('nodeReference', variableWeights.nodeReference, countCode(variableReport.issues, 'VARIABLE_NODE_MISSING'), '引用了不存在的节点'),
      contribution('ordering', variableWeights.ordering, countCode(variableReport.issues, 'VARIABLE_ORDER'), '在赋值之前就被读取')
    ]
  }];

  const traceWeights = weights.traceability;
  const traceGates = [{
    id: 'traceability', label: 'Evidence and uncertainty traceability',
    status: (context.selected || []).length ? 'pass' : 'fail',
    details: { contextHash: context.contextHash, uncertainties: context.uncertainties || [] },
    weights: traceWeights,
    path: upstreamPath.concat(['kb.search', 'gate:traceability']),
    contributions: [
      contribution('contextHash', traceWeights.contextHash, context.contextHash ? 1 : 0, '上下文是否有可比对哈希'),
      contribution('uncertaintyTrace', traceWeights.uncertaintyTrace, uncertaintyCount, '不确定项是否留痕待人工确认')
    ]
  }];

  const gates = contextGates.concat(graphGates, coverageGates, variableGates, traceGates);
  const failed = gates.filter((item) => item.status === 'fail');
  const review = gates.filter((item) => item.status === 'review');
  const status = failed.length ? 'failed' : review.length ? 'needs_review' : 'passed';
  const repairPlan = makeRepairPlan(context, graphReport, variableReport);

  return {
    status: status,
    gates: gates,
    hardFailures: failed.map((item) => item.id),
    reviewFlags: review.map((item) => item.id),
    gateWeights: weights,
    autoReview: {
      triggered: status !== 'passed',
      mode: 'single-pass-policy-review',
      decision: failed.length ? 'blocked' : review.length ? 'human_review' : 'accepted',
      reasons: failed.concat(review).map((item) => item.id),
      repairPlan: repairPlan
    }
  };
}

module.exports = { buildQualityReport: buildQualityReport, DEFAULT_GATE_WEIGHTS: DEFAULT_GATE_WEIGHTS, mergeWeights: mergeWeights };
