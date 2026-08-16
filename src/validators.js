function issue(code, message, details = {}) {
  return { code, severity: 'error', message, details };
}

function transitionsOf(node) {
  return Array.isArray(node.transitions) ? node.transitions : [];
}

function buildDistances(nodes, startId) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const distance = new Map();
  if (!startId || !byId.has(startId)) return distance;
  const queue = [startId];
  distance.set(startId, 0);
  while (queue.length) {
    const current = queue.shift();
    for (const transition of transitionsOf(byId.get(current))) {
      if (!byId.has(transition.to) || distance.has(transition.to)) continue;
      distance.set(transition.to, distance.get(current) + 1);
      queue.push(transition.to);
    }
  }
  return distance;
}

function validateGraph(nodes = []) {
  const issues = [];
  const seen = new Set();
  for (const node of nodes) {
    if (!node.id) issues.push(issue('NODE_ID_MISSING', 'Every node needs a stable id.'));
    else if (seen.has(node.id)) issues.push(issue('NODE_ID_DUPLICATE', `Duplicate node id: ${node.id}`, { nodeId: node.id }));
    else seen.add(node.id);
  }

  const byId = new Map(nodes.filter((node) => node.id).map((node) => [node.id, node]));
  const starts = nodes.filter((node) => node.type === 'start');
  if (starts.length !== 1) issues.push(issue('GRAPH_START_COUNT', `Expected exactly one start node, found ${starts.length}.`));

  const edgeCount = nodes.reduce((sum, node) => sum + transitionsOf(node).length, 0);
  for (const node of nodes) {
    const transitions = transitionsOf(node);
    for (const transition of transitions) {
      if (!byId.has(transition.to)) {
        issues.push(issue('DANGLING_EDGE', `${node.id} points to missing node ${transition.to}.`, { from: node.id, to: transition.to }));
      }
    }
    if (!['ending', 'failure'].includes(node.type) && transitions.length === 0) {
      issues.push(issue('DEAD_END', `Non-terminal node ${node.id} has no outgoing transition.`, { nodeId: node.id }));
    }
    if (node.type === 'choice') {
      if (transitions.length < 2) issues.push(issue('CHOICE_ARITY', `Choice node ${node.id} needs at least two branches.`, { nodeId: node.id }));
      if (!transitions.some((transition) => transition.kind === 'failure')) {
        issues.push(issue('CHOICE_FAILURE_COVERAGE', `Choice node ${node.id} has no explicit failure branch.`, { nodeId: node.id }));
      }
    }
  }

  const startId = starts.length === 1 ? starts[0].id : null;
  const distances = buildDistances(nodes, startId);
  if (startId) {
    for (const node of nodes) {
      if (node.id && !distances.has(node.id)) issues.push(issue('UNREACHABLE_NODE', `Node ${node.id} is unreachable from ${startId}.`, { nodeId: node.id }));
    }
  }

  return {
    issues,
    startId,
    distances: Object.fromEntries([...distances.entries()]),
    stats: {
      nodes: nodes.length,
      edges: edgeCount,
      choices: nodes.filter((node) => node.type === 'choice').length,
      failures: nodes.filter((node) => node.type === 'failure').length,
      endings: nodes.filter((node) => node.type === 'ending').length,
      reachable: distances.size
    }
  };
}

function validateVariables(variables = [], nodes = [], graphReport = validateGraph(nodes)) {
  const issues = [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const seen = new Set();
  const requiredStages = ['setAt', 'readAt', 'payoffAt', 'settleAt'];
  const distance = graphReport.distances || {};

  for (const variable of variables) {
    if (!variable.id) {
      issues.push(issue('VARIABLE_ID_MISSING', 'Every variable needs a stable id.'));
      continue;
    }
    if (seen.has(variable.id)) issues.push(issue('VARIABLE_ID_DUPLICATE', `Duplicate variable id: ${variable.id}`, { variableId: variable.id }));
    seen.add(variable.id);
    for (const stage of requiredStages) {
      const references = Array.isArray(variable[stage]) ? variable[stage] : [];
      if (!references.length) {
        issues.push(issue('VARIABLE_LIFECYCLE_INCOMPLETE', `${variable.id} is missing ${stage}.`, { variableId: variable.id, stage }));
      }
      for (const nodeId of references) {
        if (!nodeIds.has(nodeId)) issues.push(issue('VARIABLE_NODE_MISSING', `${variable.id}.${stage} references missing node ${nodeId}.`, { variableId: variable.id, stage, nodeId }));
      }
    }
    const setDistances = (variable.setAt || []).map((nodeId) => distance[nodeId]).filter(Number.isFinite);
    if (setDistances.length) {
      const earliestSet = Math.min(...setDistances);
      for (const stage of ['readAt', 'payoffAt', 'settleAt']) {
        for (const nodeId of variable[stage] || []) {
          if (Number.isFinite(distance[nodeId]) && distance[nodeId] < earliestSet) {
            issues.push(issue('VARIABLE_ORDER', `${variable.id}.${stage} occurs before the variable is set.`, { variableId: variable.id, stage, nodeId }));
          }
        }
      }
    }
  }

  return {
    issues,
    stats: {
      variables: variables.length,
      complete: variables.filter((variable) => requiredStages.every((stage) => Array.isArray(variable[stage]) && variable[stage].length)).length
    }
  };
}

module.exports = { validateGraph, validateVariables, buildDistances };
