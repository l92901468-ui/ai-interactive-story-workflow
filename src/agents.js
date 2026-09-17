// 多 agent 层。每个 agent 只做一件事，并且必须交代三件事：
//   output 它产出的东西
//   path   它的数据经过哪些步骤（累计进生成路径，事后回看用）
//   weights 它判定时各因素的权重（可被反馈调权）
//
// 之前这些全是普通函数调用，顺序散在 runWorkflow 里；现在显式登记成 agent，
// 编排顺序变成可配置的 route，路径改进也才有东西可改。

const { validateGraph, validateVariables } = require('./validators');
const { buildQualityReport } = require('./quality-gates');
const { SLOTS } = require('./knowledge-base');
const { generateDraft } = require('./llm-mock');
const { sha256 } = require('./hash');

const BAD_HABITS = ['我知道', '我明白', '至少', '不是'];

function agent(id, label, role, run) {
  return { id: id, label: label, role: role, run: run };
}

const planners = agent('planner', '概述规划', '把编剧概述拆成场景目标与决策节点', (state) => {
  const nodes = state.project.graph && Array.isArray(state.project.graph.nodes) ? state.project.graph.nodes : [];
  const decisionNodes = nodes
    .filter((node) => node.type === 'choice' || node.type === 'payoff')
    .map((node) => ({ id: node.id, type: node.type, label: node.label || node.id }));
  const plan = {
    projectId: state.project.project.id,
    overview: state.project.query,
    startId: (nodes.find((node) => node.type === 'start') || {}).id || null,
    decisionNodes: decisionNodes,
    targets: decisionNodes.map((node) => node.id)
  };
  return {
    output: { plan: plan, planHash: sha256(plan) },
    path: ['agent:planner', 'graph.extractDecisionNodes'],
    weights: { decisionNodeCoverage: 1 },
    notes: ['概述只用于 planning，不进入文风槽位']
  };
});

const retrievers = agent('retriever', '知识召回', '按槽位从知识库召回资料并记录路由', (state, ctx) => {
  const settings = state.project.settings || {};
  const topK = Number(settings.topK || 3);
  const minScore = Number(settings.minScore || 0.08);
  const routing = [];
  const hits = [];
  for (const slot of [SLOTS.PLANNING, SLOTS.STYLE, SLOTS.CONTINUITY]) {
    const result = ctx.kb.search(state.project.query, { topK: topK, minScore: minScore, slots: [slot] });
    for (const hit of result.hits) {
      routing.push({ slot: slot, id: hit.id, score: hit.score, explain: hit.explain });
      hits.push(hit);
    }
  }
  return {
    output: { retrieval: { routing: routing, hits: hits, budget: { topK: topK, minScore: minScore } } },
    path: ['agent:retriever', 'kb.search:planning', 'kb.search:style', 'kb.search:continuity'],
    weights: { slotPriority: 1 },
    notes: ['每个槽位单独召回，便于事后判断是哪个槽位出问题']
  };
});

const drafters = agent('drafter', '正文起草', '按决策节点生成候选正文与实现链接', (state) => {
  const evidenceIds = (state.retrieval ? state.retrieval.hits : []).map((hit) => hit.id);
  const draft = generateDraft({ plan: state.plan, evidenceIds: evidenceIds });
  return {
    output: { draft: draft },
    path: ['agent:drafter', 'llm.generateDraft'],
    weights: { decisionNodeFidelity: 1 },
    notes: ['候选稿始终是候选，不自动成为正史']
  };
});

const continuityGuard = agent('continuityGuard', '连续性守卫', '检查候选正文是否承接了连续性事实', (state) => {
  const draftText = state.draft ? state.draft.text : '';
  const continuityHits = (state.retrieval ? state.retrieval.hits : []).filter((hit) => hit.slot === SLOTS.CONTINUITY);
  const matched = continuityHits.filter((hit) => draftText.indexOf(hit.text.slice(0, 6)) !== -1);
  const weights = { overlap: 0.6, coverage: 0.4 };
  return {
    output: {
      status: matched.length ? 'pass' : 'review',
      matchedIds: matched.map((hit) => hit.id),
      expectedIds: continuityHits.map((hit) => hit.id)
    },
    path: ['agent:continuityGuard', 'kb.search:continuity', 'draft.match'],
    weights: weights,
    notes: ['连续性只沿已登记事实，不按标题相似自动承接']
  };
});

const styleGuard = agent('styleGuard', '文风守卫', '检查候选正文是否用到文风参考并避开库存回应', (state) => {
  const draftText = state.draft ? state.draft.text : '';
  const styleHits = (state.retrieval ? state.retrieval.hits : []).filter((hit) => hit.slot === SLOTS.STYLE);
  const used = styleHits.filter((hit) => draftText.indexOf(hit.text.slice(0, 6)) !== -1);
  const badHabits = BAD_HABITS.filter((word) => draftText.indexOf(word) !== -1);
  return {
    output: {
      status: badHabits.length ? 'review' : 'pass',
      usedStyleIds: used.map((hit) => hit.id),
      badHabits: badHabits
    },
    path: ['agent:styleGuard', 'kb.search:style', 'draft.badHabitScan'],
    weights: { referenceUse: 0.5, badHabitPenalty: 0.5 },
    notes: ['文风来自编剧原文，不来自上一轮 AI 稿']
  };
});

const graphValidator = agent('graphValidator', '图校验', '校验节点、边、可达性与失败覆盖', (state) => {
  const report = validateGraph(state.project.graph.nodes);
  return {
    output: { graphReport: report },
    path: ['agent:graphValidator', 'graph.validate', 'graph.distances'],
    weights: { structural: 1 },
    notes: []
  };
});

const variableValidator = agent('variableValidator', '变量校验', '校验变量生命周期与顺序', (state) => {
  const report = validateVariables(state.project.variables, state.project.graph.nodes, state.graphReport);
  return {
    output: { variableReport: report },
    path: ['agent:variableValidator', 'variables.validate'],
    weights: { lifecycle: 1 },
    notes: []
  };
});

const qualityGate = agent('qualityGate', '质量门', '聚合各守卫结果，输出每门的权重与判定路径', (state, ctx) => {
  const context = state.context;
  const quality = buildQualityReport({
    context: context,
    graphReport: state.graphReport,
    variableReport: state.variableReport,
    upstreamPath: state.path.slice(),
    gateWeights: ctx.learning.gateWeights
  });
  return {
    output: { quality: quality },
    path: ['agent:qualityGate', 'gates.aggregate'],
    weights: { gateAggregation: 1 },
    notes: ['每门的权重和路径已随回执落盘']
  };
});

const reviewer = agent('reviewer', '复审', '区分可立即生效的改进与必须交人工归因的改进', (state) => {
  const quality = state.quality;
  const guards = [state.continuityGuard, state.styleGuard].filter(Boolean);
  const guardReviews = guards.filter((item) => item.output.status === 'review').map((item) => item.id);
  const autoApply = [];
  const awaitingHuman = [];

  for (const item of quality.autoReview.repairPlan) {
    // 结构化硬门问题可以直接给修复建议，但改动输入仍需人工确认
    awaitingHuman.push({ action: item.action, message: item.message, reason: '需要人工确认后再改输入' });
  }
  for (const guardId of guardReviews) {
    awaitingHuman.push({ action: guardId, message: '守卫标记为待复核，需要人工归因后才能调权或改路径', reason: 'guard_review' });
  }
  if (!quality.autoReview.triggered && !guardReviews.length) {
    autoApply.push({ action: 'none', message: '无需修复' });
  }

  return {
    output: {
      triggered: quality.autoReview.triggered || guardReviews.length > 0,
      autoApply: autoApply,
      awaitingHuman: awaitingHuman
    },
    path: ['agent:reviewer'],
    weights: { autoVsHuman: 1 },
    notes: ['从差分推断出的结论一律进 awaitingHuman，等人工归因']
  };
});

// 这两个 agent 不在默认路径里，只有当人工确认了「推荐路径改进」之后才会被插入。
// 它们是路径改进真正落地的地方——否则建议只是一句空话。
const retrievalAuditor = agent('retrievalAuditor', '召回复核', '独立复核召回结果是否覆盖各槽位与预算', (state) => {
  const routing = (state.retrieval && state.retrieval.routing) || [];
  const budget = (state.retrieval && state.retrieval.budget) || {};
  const coveredSlots = {};
  for (const item of routing) coveredSlots[item.slot] = (coveredSlots[item.slot] || 0) + 1;
  const missingSlots = [SLOTS.PLANNING, SLOTS.STYLE, SLOTS.CONTINUITY].filter((slot) => !coveredSlots[slot]);
  const minScore = Number(budget.minScore || 0.08);
  const lowScoreIds = routing.filter((item) => item.score < minScore).map((item) => item.id);
  return {
    output: {
      status: missingSlots.length || lowScoreIds.length ? 'review' : 'pass',
      coveredSlots: coveredSlots,
      missingSlots: missingSlots,
      lowScoreIds: lowScoreIds
    },
    path: ['agent:retrievalAuditor', 'kb.audit'],
    weights: { slotCoverage: 0.6, scoreFloor: 0.4 },
    notes: ['这是人工确认「召回层归因」后插入的复核环节']
  };
});

const proseReviewer = agent('proseReviewer', '表达复核', '复核正文表达是否成立（不含结构性问题）', (state) => {
  const text = state.draft ? state.draft.text : '';
  const lines = text.split('\n').filter((line) => line.trim());
  const longLines = lines.filter((line) => line.length > 60).map((line) => line.slice(0, 20));
  const repeated = lines.filter((line, index) => lines.indexOf(line) !== index);
  return {
    output: {
      status: longLines.length || repeated.length ? 'review' : 'pass',
      longLines: longLines,
      repeatedLines: repeated
    },
    path: ['agent:proseReviewer', 'draft.proseScan'],
    weights: { lineLength: 0.5, repetition: 0.5 },
    notes: ['这是人工确认「表达层归因」后插入的复核环节']
  };
});

const AGENTS = {
  planner: planners,
  retriever: retrievers,
  drafter: drafters,
  continuityGuard: continuityGuard,
  styleGuard: styleGuard,
  graphValidator: graphValidator,
  variableValidator: variableValidator,
  qualityGate: qualityGate,
  reviewer: reviewer,
  retrievalAuditor: retrievalAuditor,
  proseReviewer: proseReviewer
};

const AGENT_IDS = Object.keys(AGENTS);

const DEFAULT_ROUTE = [
  'planner',
  'retriever',
  'drafter',
  'continuityGuard',
  'styleGuard',
  'graphValidator',
  'variableValidator',
  'qualityGate',
  'reviewer'
];

module.exports = { AGENTS: AGENTS, AGENT_IDS: AGENT_IDS, DEFAULT_ROUTE: DEFAULT_ROUTE, agent: agent };
