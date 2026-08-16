function gate(id, label, status, details) {
  return { id, label, status, details };
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

function buildQualityReport({ context, graphReport, variableReport }) {
  const graphIssues = graphReport.issues.filter((item) => !['CHOICE_ARITY', 'CHOICE_FAILURE_COVERAGE'].includes(item.code));
  const failureIssues = graphReport.issues.filter((item) => ['CHOICE_ARITY', 'CHOICE_FAILURE_COVERAGE'].includes(item.code));
  const gates = [
    gate('context_relevance', 'Context relevance', context.selected.length ? (context.confidence === 'low' ? 'review' : 'pass') : 'fail', {
      confidence: context.confidence,
      averageScore: context.averageScore,
      selectedEvidenceIds: context.selected.map((item) => item.id)
    }),
    gate('graph_integrity', 'Node and edge integrity', graphIssues.length ? 'fail' : 'pass', { issues: graphIssues }),
    gate('failure_coverage', 'Choice failure coverage', failureIssues.length ? 'fail' : 'pass', { issues: failureIssues }),
    gate('variable_lifecycle', 'Variable lifecycle', variableReport.issues.length ? 'fail' : 'pass', { issues: variableReport.issues }),
    gate('traceability', 'Evidence and uncertainty traceability', context.selected.length ? 'pass' : 'fail', {
      contextHash: context.contextHash,
      uncertainties: context.uncertainties
    })
  ];
  const failed = gates.filter((item) => item.status === 'fail');
  const review = gates.filter((item) => item.status === 'review');
  const status = failed.length ? 'failed' : review.length ? 'needs_review' : 'passed';
  const repairPlan = makeRepairPlan(context, graphReport, variableReport);
  return {
    status,
    gates,
    hardFailures: failed.map((item) => item.id),
    reviewFlags: review.map((item) => item.id),
    autoReview: {
      triggered: status !== 'passed',
      mode: 'single-pass-policy-review',
      decision: failed.length ? 'blocked' : review.length ? 'human_review' : 'accepted',
      reasons: [...failed, ...review].map((item) => item.id),
      repairPlan
    }
  };
}

module.exports = { buildQualityReport };
