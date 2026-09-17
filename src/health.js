// 健康检查与指标。
//
// 对应另一条工程纪律：光有流程不够，得能看出它现在是不是健康的。
// 这里关注的不是 CPU/内存，而是这条闭环特有的积压：
//   - 有多少差分压在人工手上（相当于队列深度）
//   - 最老的一条压了多久（相当于滞留时间）
//   - 有多少路径建议一直没人确认
//   - 上一次生成有没有过不回退清单

const { PENDING_STATES, PROPOSAL_STATES } = require('./state-machine');

const DEFAULT_THRESHOLDS = {
  maxAwaitingAttribution: 50,      // 待归因积压上限
  maxOldestPendingAgeSec: 604800,  // 最老一条最多压 7 天
  maxAwaitingProposals: 10,        // 未确认的路径建议上限
  requireNoRegression: true        // 上一次生成必须过不回退清单
};

function ageSeconds(isoString, now) {
  const parsed = Date.parse(isoString || 0);
  if (!Number.isFinite(parsed)) return null;
  return Math.round((now - parsed) / 1000);
}

function collectHealth(input) {
  const ledger = input.ledger;
  const kb = input.knowledgeBase || null;
  const result = input.result || null;
  const now = Date.now();

  const byState = {};
  for (const item of ledger.pending) byState[item.state] = (byState[item.state] || 0) + 1;

  const ages = ledger.pending
    .filter((item) => item.state === PENDING_STATES.AWAITING || item.state === PENDING_STATES.ESCALATED)
    .map((item) => ageSeconds(item.createdAt, now))
    .filter((value) => value !== null);

  const proposalByState = {};
  for (const item of ledger.proposals) proposalByState[item.status] = (proposalByState[item.status] || 0) + 1;

  const adjustments = kb ? Array.from(kb.adjustments.values()) : [];

  return {
    projectId: ledger.projectId,
    learningVersion: ledger.version,
    pending: {
      awaiting: byState[PENDING_STATES.AWAITING] || 0,
      escalated: byState[PENDING_STATES.ESCALATED] || 0,
      attributed: byState[PENDING_STATES.ATTRIBUTED] || 0,
      dismissed: byState[PENDING_STATES.DISMISSED] || 0,
      total: ledger.pending.length,
      oldestAgeSec: ages.length ? Math.max.apply(null, ages) : 0
    },
    proposals: {
      awaiting: proposalByState[PROPOSAL_STATES.AWAITING] || 0,
      applied: proposalByState[PROPOSAL_STATES.APPLIED] || 0,
      rejected: proposalByState[PROPOSAL_STATES.REJECTED] || 0,
      rolledBack: proposalByState[PROPOSAL_STATES.ROLLED_BACK] || 0,
      total: ledger.proposals.length
    },
    knowledge: kb
      ? {
          documents: kb.stats().documents,
          bySlot: kb.stats().bySlot,
          adjustedDocuments: adjustments.length,
          maxPositiveDelta: adjustments.length ? Math.max.apply(null, adjustments.map((item) => item.delta)) : 0,
          minDelta: adjustments.length ? Math.min.apply(null, adjustments.map((item) => item.delta)) : 0,
          banned: adjustments.filter((item) => item.banned).length
        }
      : null,
    route: { length: ledger.route ? ledger.route.length : 0, agents: ledger.route || [], historyLength: ledger.routeHistory.length },
    lastRun: result
      ? {
          status: result.receipt.status,
          noRegressionPassed: result.receipt.noRegressionPassed,
          evidenceState: result.receipt.evidenceState,
          awaitingHuman: result.receipt.awaitingHuman
        }
      : null
  };
}

function evaluate(health, overrides) {
  const limits = Object.assign({}, DEFAULT_THRESHOLDS, overrides || {});
  const breaches = [];

  if (health.pending.awaiting > limits.maxAwaitingAttribution) {
    breaches.push({ metric: 'pending.awaiting', value: health.pending.awaiting, limit: limits.maxAwaitingAttribution });
  }
  if (health.pending.oldestAgeSec > limits.maxOldestPendingAgeSec) {
    breaches.push({ metric: 'pending.oldestAgeSec', value: health.pending.oldestAgeSec, limit: limits.maxOldestPendingAgeSec });
  }
  if (health.proposals.awaiting > limits.maxAwaitingProposals) {
    breaches.push({ metric: 'proposals.awaiting', value: health.proposals.awaiting, limit: limits.maxAwaitingProposals });
  }
  if (limits.requireNoRegression && health.lastRun && health.lastRun.noRegressionPassed === false) {
    breaches.push({ metric: 'lastRun.noRegressionPassed', value: false, limit: true });
  }

  return { healthy: breaches.length === 0, breaches: breaches, thresholds: limits };
}

module.exports = { collectHealth: collectHealth, evaluate: evaluate, DEFAULT_THRESHOLDS: DEFAULT_THRESHOLDS };
