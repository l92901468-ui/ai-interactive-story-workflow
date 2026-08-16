const { selectContext } = require('./context-selector');
const { validateGraph, validateVariables } = require('./validators');
const { buildQualityReport } = require('./quality-gates');
const { sha256 } = require('./hash');

function assertSyntheticProject(project) {
  if (!project || typeof project !== 'object') throw new TypeError('Project input must be an object.');
  if (!project.metadata?.synthetic) throw new Error('This public demo only accepts inputs marked metadata.synthetic=true.');
  if (!project.project?.id || !project.project?.title) throw new Error('project.id and project.title are required.');
  if (!Array.isArray(project.evidence) || !Array.isArray(project.graph?.nodes) || !Array.isArray(project.variables)) {
    throw new Error('evidence, graph.nodes, and variables must be arrays.');
  }
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

function runWorkflow(project, options = {}) {
  assertSyntheticProject(project);
  const context = selectContext(project.query, project.evidence, project.settings);
  const graphReport = validateGraph(project.graph.nodes);
  const variableReport = validateVariables(project.variables, project.graph.nodes, graphReport);
  const quality = buildQualityReport({ context, graphReport, variableReport });
  const generationPlan = buildGenerationPlan(quality);
  const generatedAt = options.now || project.metadata.generatedAt || new Date().toISOString();
  const validationSummary = {
    graph: graphReport,
    variables: variableReport,
    quality
  };
  const snapshotBase = {
    schemaVersion: '1.0.0',
    generatedAt,
    privacy: {
      dataClass: 'synthetic-demo',
      sourcePolicy: 'No company, client, private prompt, production data, or repository history.'
    },
    project: project.project,
    query: project.query,
    context,
    generationPlan,
    validation: validationSummary,
    hashes: {
      inputHash: sha256(project),
      contextHash: context.contextHash,
      validationHash: sha256(validationSummary),
      planHash: sha256(generationPlan)
    }
  };
  const snapshotHash = sha256(snapshotBase);
  const receiptSeed = sha256({ projectId: project.project.id, snapshotHash, status: quality.status });
  const receiptBase = {
    schemaVersion: '1.0.0',
    receiptId: `rcpt_${receiptSeed.slice(0, 16)}`,
    projectId: project.project.id,
    generatedAt,
    status: quality.status,
    snapshotHash,
    inputHash: snapshotBase.hashes.inputHash,
    contextHash: snapshotBase.hashes.contextHash,
    validationHash: snapshotBase.hashes.validationHash,
    selectedEvidenceIds: context.selected.map((item) => item.id),
    uncertaintyCount: context.uncertainties.length,
    graphStats: graphReport.stats,
    variableStats: variableReport.stats,
    reviewDecision: quality.autoReview.decision
  };
  return {
    snapshot: { ...snapshotBase, snapshotHash },
    receipt: { ...receiptBase, receiptHash: sha256(receiptBase) }
  };
}

module.exports = { runWorkflow, assertSyntheticProject, buildGenerationPlan };
