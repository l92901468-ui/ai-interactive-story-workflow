const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runWorkflow } = require('../src/workflow');
const { DEFAULT_ROUTE, AGENTS } = require('../src/agents');
const { runNoRegression } = require('../src/no-regression');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'input', name), 'utf8'));
}

test('一次运行走完九个 agent 并留下轨迹', () => {
  const result = runWorkflow(fixture('synthetic-story.json'));
  const ids = result.snapshot.agents.map((item) => item.id);
  assert.deepEqual(ids, DEFAULT_ROUTE);
  for (const agent of result.snapshot.agents) {
    assert.ok(agent.role, agent.id + ' 缺少职责说明');
    assert.ok(Array.isArray(agent.path) && agent.path.length, agent.id + ' 缺少判定路径');
    assert.ok(agent.weights && Object.keys(agent.weights).length, agent.id + ' 缺少权重');
  }
});

test('每个质量门都记下权重与判定路径', () => {
  const result = runWorkflow(fixture('synthetic-badcase.json'));
  for (const gate of result.snapshot.validation.quality.gates) {
    assert.ok(gate.weights && Object.keys(gate.weights).length, gate.id + ' 没记权重');
    assert.ok(Array.isArray(gate.path) && gate.path.length, gate.id + ' 没记路径');
    assert.ok(Array.isArray(gate.contributions) && gate.contributions.length, gate.id + ' 没记贡献项');
    for (const item of gate.contributions) {
      assert.ok(typeof item.factor === 'string' && typeof item.weight === 'number');
    }
  }
});

test('生成记录带齐上下文/计划/草稿哈希与决策链接', () => {
  const result = runWorkflow(fixture('synthetic-story.json'));
  const generation = result.snapshot.generation;
  assert.match(generation.contextHash, /^[a-f0-9]{64}$/);
  assert.match(generation.planHash, /^[a-f0-9]{64}$/);
  assert.match(generation.draftHash, /^[a-f0-9]{64}$/);
  assert.ok(generation.decisionLinks.length, '决策节点没有落到正文行区间');
  assert.ok(generation.routing.length, '没有召回路由记录');
  assert.equal(generation.evidence.state, 'complete');
});

test('草稿里的每个决策节点都能回指到正文行区间', () => {
  const result = runWorkflow(fixture('synthetic-story.json'));
  const plan = result.state.plan;
  const links = result.snapshot.draft.decisionLinks;
  for (const node of plan.decisionNodes) {
    const link = links.find((item) => item.nodeId === node.id);
    assert.ok(link, node.id + ' 没有实现链接');
    assert.ok(link.toLine >= link.fromLine);
  }
});

test('正常样例通过不回退清单，坏样例被点名', () => {
  const good = runWorkflow(fixture('synthetic-story.json'));
  assert.equal(good.snapshot.noRegression.passed, true);

  const bad = runWorkflow(fixture('synthetic-badcase.json'));
  assert.equal(bad.snapshot.noRegression.passed, false);
  assert.ok(bad.snapshot.noRegression.failedIds.includes('decision_ownership'));
});

test('路径可以改：插入复核 agent 后轨迹随之变化', () => {
  const input = fixture('synthetic-story.json');
  const custom = DEFAULT_ROUTE.slice();
  custom.splice(custom.indexOf('retriever') + 1, 0, 'retrievalAuditor');

  const result = runWorkflow(input, { route: custom });
  assert.ok(result.snapshot.agents.some((item) => item.id === 'retrievalAuditor'));
  assert.equal(result.receipt.route.length, DEFAULT_ROUTE.length + 1);
});

test('复审把结论分成可立即应用与待人工两类', () => {
  const result = runWorkflow(fixture('synthetic-badcase.json'));
  const decisions = result.snapshot.decisions;
  assert.ok(Array.isArray(decisions.awaitingHuman));
  assert.ok(decisions.awaitingHuman.length > 0, '坏样例应当有待人工处理项');
  assert.ok(decisions.awaitingHuman.every((item) => item.reason));
});

test('不回退清单可以被单独调用', () => {
  const result = runWorkflow(fixture('synthetic-story.json'));
  const report = runNoRegression({ state: result.state, quality: result.state.quality, generation: result.snapshot.generation });
  assert.ok(report.results.length >= 6);
  assert.equal(typeof report.passed, 'boolean');
});

test('两个可选 agent 默认不在路径里', () => {
  assert.ok(AGENTS.retrievalAuditor);
  assert.ok(AGENTS.proseReviewer);
  assert.ok(!DEFAULT_ROUTE.includes('retrievalAuditor'));
  assert.ok(!DEFAULT_ROUTE.includes('proseReviewer'));
});
