// 编排入口。
//
// 之前这里是「几行函数调用」，流程顺序写死在代码里。现在它只做三件事：
//   1. 建知识库（含已入库的编剧改稿）
//   2. 交给 orchestrator 按 route 跑一遍多 agent
//   3. 把生成期的权重/路径/哈希写进持久日志，跑一遍不回退清单，产出回执
//
// 对外契约（snapshot / receipt）保持不变，历史快照仍可比对。

const { selectContext } = require('./context-selector');
const { validateGraph, validateVariables } = require('./validators');
const { buildQualityReport } = require('./quality-gates');
const { sha256 } = require('./hash');
const { KnowledgeBase, SLOTS } = require('./knowledge-base');
const { runRoute, normalizeRoute } = require('./orchestrator');
const { DEFAULT_ROUTE } = require('./agents');
const { buildGenerationRecord, GenerationLog, evidenceCompleteness } = require('./generation-log');
const { runNoRegression } = require('./no-regression');

const KIND_TO_SLOT = {
  canon: SLOTS.CONTINUITY,
  draft: SLOTS.STYLE,
  reference: SLOTS.CONTINUITY
};

function assertSyntheticProject(project) {
  if (!project || typeof project !== 'object') throw new TypeError('Project input must be an object.');
  if (!project.metadata || !project.metadata.synthetic) throw new Error('This public demo only accepts inputs marked metadata.synthetic=true.');
  if (!project.project || !project.project.id || !project.project.title) throw new Error('project.id and project.title are required.');
  if (!Array.isArray(project.evidence) || !Array.isArray(project.graph && project.graph.nodes) || !Array.isArray(project.variables)) {
    throw new Error('evidence, graph.nodes, and variables must be arrays.');
  }
}

function buildKnowledgeBase(project) {
  const kb = new KnowledgeBase();
  for (const item of project.evidence) {
    kb.addDocument({
      id: item.id,
      slot: item.slot || KIND_TO_SLOT[item.kind] || SLOTS.CONTINUITY,
      kind: item.kind,
      title: item.title,
      text: item.text,
      tags: item.tags,
      confidence: item.confidence,
      uncertainty: item.uncertainty,
      source: 'seed'
    });
  }
  // 概述单独进 planning 槽，并且标记为 derived，不参与常规打分
  kb.addDocument({
    id: 'PLAN:' + project.project.id,
    slot: SLOTS.PLANNING,
    kind: 'overview',
    title: project.project.title + ' 概述',
    text: project.query || '',
    tags: ['overview', 'planning'],
    confidence: 1,
    source: 'project_overview',
    derived: true
  });
  return kb;
}

function buildGenerationPlan(quality) {
  const validationPassed = quality.status !== 'failed';
  return {
    promptStrategy: 'High-level staged concept only; no proprietary prompts are included.',
    stages: [
      { id: 'identify', label: 'Identify source facts and uncertainties', status: 'complete' },
      { id: 'generate', label: 'Assemble a branch-aware generation plan', status: 'complete' },
      { id: 'validate', label: 'Validate graph, failures, variables, and traceability', status: validationPassed ? 'complete' : 'failed' },
      { id: 'repair', label: 'Create a repair plan and trigger policy review', status: quality.autoReview.triggered ? 'planned' : 'not_needed' }
    ]
  };
}

function runWorkflow(project, options) {
  const opts = options || {};
  assertSyntheticProject(project);

  const kb = opts.knowledgeBase || buildKnowledgeBase(project);
  const learning = opts.learning || { version: 'baseline', gateWeights: null };
  const route = normalizeRoute(opts.route || (opts.ledger && opts.ledger.route) || DEFAULT_ROUTE);

  const context = selectContext(project.query, project.evidence, project.settings, { knowledgeBase: kb });
  const run = runRoute({ project: project, kb: kb, learning: learning, context: context, route: route });
  const state = run.state;

  const generatedAt = opts.now || project.metadata.generatedAt || new Date().toISOString();
  const generation = buildGenerationRecord({
    state: state,
    route: run.route,
    projectId: project.project.id,
    generatedAt: generatedAt,
    contextHash: context.contextHash,
    knowledgeStats: kb.stats()
  });

  const noRegression = runNoRegression({ state: state, quality: state.quality, generation: generation });

  // 生成期持久日志：只有显式给了 logDir 才落盘，默认纯内存，保证测试可复现
  let logEntry = null;
  if (opts.logDir) {
    logEntry = new GenerationLog(opts.logDir).append(generation);
  } else {
    logEntry = Object.assign({}, generation, { evidence: evidenceCompleteness(generation) });
  }

  const quality = state.quality;
  const generationPlan = buildGenerationPlan(quality);
  const validationSummary = {
    graph: state.graphReport,
    variables: state.variableReport,
    quality: quality
  };

  const review = state.reviewer ? state.reviewer.output : { triggered: false, autoApply: [], awaitingHuman: [] };
  const draft = state.draft || null;

  const snapshotBase = {
    schemaVersion: '1.1.0',
    generatedAt: generatedAt,
    privacy: {
      dataClass: 'synthetic-demo',
      sourcePolicy: 'No company, client, private prompt, production data, or repository history.'
    },
    project: project.project,
    query: project.query,
    context: context,
    knowledge: {
      stats: kb.stats(),
      routing: state.retrieval ? state.retrieval.routing : [],
      budget: state.retrieval ? state.retrieval.budget : {}
    },
    generationPlan: generationPlan,
    validation: validationSummary,
    // 注意：这里刻意不含 elapsedMs。耗时每次都不一样，混进快照会让
    // 「同输入同结果」这件事失效，回执也就没法做回归比对了。
    agents: run.trace.map((item) => ({
      id: item.id,
      label: item.label,
      role: item.role,
      weights: item.weights,
      path: item.path,
      notes: item.notes
    })),
    draft: draft ? { draftId: draft.draftId, model: draft.model, textHash: sha256(draft.text), decisionLinks: draft.decisionLinks } : null,
    generation: logEntry,
    decisions: review,
    noRegression: noRegression,
    hashes: {
      inputHash: sha256(project),
      contextHash: context.contextHash,
      validationHash: sha256(validationSummary),
      planHash: sha256(generationPlan)
    }
  };
  const snapshotHash = sha256(snapshotBase);
  const receiptSeed = sha256({ projectId: project.project.id, snapshotHash: snapshotHash, status: quality.status });
  const receiptBase = {
    schemaVersion: '1.1.0',
    receiptId: 'rcpt_' + receiptSeed.slice(0, 16),
    projectId: project.project.id,
    generatedAt: generatedAt,
    status: quality.status,
    snapshotHash: snapshotHash,
    inputHash: snapshotBase.hashes.inputHash,
    contextHash: snapshotBase.hashes.contextHash,
    validationHash: snapshotBase.hashes.validationHash,
    selectedEvidenceIds: context.selected.map((item) => item.id),
    uncertaintyCount: context.uncertainties.length,
    graphStats: state.graphReport.stats,
    variableStats: state.variableReport.stats,
    learningVersion: state.learningVersion,
    route: run.route,
    evidenceState: logEntry.evidence.state,
    awaitingHuman: review.awaitingHuman.length,
    noRegressionPassed: noRegression.passed,
    reviewDecision: quality.autoReview.decision
  };

  const timings = {};
  for (const item of run.trace) timings[item.id] = item.elapsedMs;

  return {
    snapshot: Object.assign({}, snapshotBase, { snapshotHash: snapshotHash }),
    receipt: Object.assign({}, receiptBase, { receiptHash: sha256(receiptBase) }),
    // 耗时只在这里给出，不进快照
    timings: timings,
    state: state,
    knowledgeBase: kb
  };
}

module.exports = { runWorkflow: runWorkflow, assertSyntheticProject: assertSyntheticProject, buildGenerationPlan: buildGenerationPlan, buildKnowledgeBase: buildKnowledgeBase };
