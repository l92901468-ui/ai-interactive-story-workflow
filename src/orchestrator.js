// 编排层：按 route 顺序执行 agent，累计生成路径，记录每一步的耗时与权重。
//
// route 是**可配置的**：编剧反馈指出问题后，路径改进以「推荐路径」的形式提出，
// 人工确认后才写回 route，所以这里的 route 不从代码里写死顺序。

const { AGENTS, DEFAULT_ROUTE } = require('./agents');

function normalizeRoute(route) {
  if (!Array.isArray(route) || !route.length) return DEFAULT_ROUTE.slice();
  return route.filter((id) => AGENTS[id]);
}

function runRoute(input) {
  const route = normalizeRoute(input.route);
  const ctx = { kb: input.kb, learning: input.learning || {} };
  const state = {
    project: input.project,
    context: input.context,
    path: [],
    learningVersion: (input.learning && input.learning.version) || 'baseline'
  };
  const trace = [];

  for (const agentId of route) {
    const definition = AGENTS[agentId];
    const startedAt = Date.now();
    const result = definition.run(state, ctx);
    const elapsedMs = Date.now() - startedAt;

    const record = {
      id: definition.id,
      label: definition.label,
      role: definition.role,
      output: result.output,
      weights: result.weights || {},
      path: result.path || [],
      notes: result.notes || [],
      elapsedMs: elapsedMs
    };

    state[agentId] = record;
    for (const step of record.path) {
      if (state.path.indexOf(step) === -1) state.path.push(step);
    }

    // 把输出里的关键结果提到 state 上，后续 agent 直接取用
    const output = result.output || {};
    if (output.plan) state.plan = output.plan;
    if (output.retrieval) state.retrieval = output.retrieval;
    if (output.draft) state.draft = output.draft;
    if (output.graphReport) state.graphReport = output.graphReport;
    if (output.variableReport) state.variableReport = output.variableReport;
    if (output.quality) state.quality = output.quality;
    if (output.routing) state.routing = output.routing;

    trace.push(record);
  }

  return { state: state, trace: trace, route: route };
}

module.exports = { runRoute: runRoute, normalizeRoute: normalizeRoute };
