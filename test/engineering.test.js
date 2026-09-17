const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FeedbackLedger } = require('../src/feedback');
const { KnowledgeBase, SLOTS } = require('../src/knowledge-base');
const { DEFAULT_ROUTE } = require('../src/agents');
const { collectHealth, evaluate } = require('../src/health');
const {
  PENDING_STATES,
  PROPOSAL_STATES,
  PENDING_TRANSITIONS,
  PROPOSAL_TRANSITIONS,
  transition
} = require('../src/state-machine');
const { runWorkflow } = require('../src/workflow');

function fresh() {
  const kb = new KnowledgeBase({
    documents: [
      { id: 'EV-CANON-001', slot: SLOTS.CONTINUITY, kind: 'canon', title: '灯塔供电', text: '灯塔用月盐电池', confidence: 0.98 }
    ]
  });
  const ledger = new FeedbackLedger({ projectId: 'demo', route: DEFAULT_ROUTE.slice() });
  return { kb, ledger };
}

function revisionInput(overrides) {
  return Object.assign({
    kind: 'revision',
    revisionId: 'WR-001',
    parentText: 'AI 稿第一行',
    text: '编剧改的第一行',
    generationEvidenceIds: ['EV-CANON-001'],
    receivedAt: '2026-01-01T00:00:00.000Z'
  }, overrides || {});
}

test('同一份反馈重复提交只记一次', () => {
  const { kb, ledger } = fresh();
  const first = ledger.record(revisionInput(), { kb });
  const second = ledger.record(revisionInput(), { kb });

  assert.equal(first.replayed, undefined);
  assert.equal(second.replayed, true);
  assert.equal(ledger.events.length, 1, '不能产生第二条事件');
  assert.equal(ledger.pending.length, first.pendingAttribution.length, '不能重复挂待归因');
  assert.deepEqual(second.knowledgeIngested, [], '重放时不再入库');
  assert.equal(second.event.eventId, first.event.eventId);
});

test('换个时间提交同一份内容仍然幂等', () => {
  const { kb, ledger } = fresh();
  ledger.record(revisionInput(), { kb });
  const later = ledger.record(revisionInput({ receivedAt: '2026-06-01T00:00:00.000Z' }), { kb });
  assert.equal(later.replayed, true);
  assert.equal(ledger.events.length, 1);
});

test('同一条差分重复归因不会重复调权', () => {
  const { kb, ledger } = fresh();
  const recorded = ledger.record(revisionInput(), { kb });
  const pendingId = recorded.pendingAttribution[0].pendingId;

  ledger.attribute(pendingId, { layer: 'input_retrieval', scope: 'project_pattern', direction: 'up' }, { kb });
  const again = ledger.attribute(pendingId, { layer: 'input_retrieval', scope: 'project_pattern', direction: 'up' }, { kb });

  assert.equal(again.replayed, true);
  assert.equal(again.blockedBy, 'already_attributed');
  assert.equal(kb.adjustments.get('EV-CANON-001').delta, 0.1, '权重只能加一次');
});

test('非法状态跳转被拒绝', () => {
  const entity = { state: PENDING_STATES.ATTRIBUTED };
  assert.throws(
    () => transition(entity, PENDING_STATES.AWAITING, { table: PENDING_TRANSITIONS, field: 'state' }),
    /非法状态跳转/
  );
  assert.equal(entity.state, PENDING_STATES.ATTRIBUTED, '被拒绝后状态不能变');
});

test('已归因是终态，不能再改', () => {
  const table = PENDING_TRANSITIONS[PENDING_STATES.ATTRIBUTED];
  assert.deepEqual(table, []);
});

test('否决过的路径建议不能再应用', () => {
  const { kb, ledger } = fresh();
  const recorded = ledger.record(revisionInput(), { kb });
  ledger.attribute(recorded.pendingAttribution[0].pendingId, { layer: 'input_retrieval', scope: 'project_pattern' }, { kb });
  const proposal = ledger.proposeRouteChanges()[0];

  transition(ledger.proposals[0], PROPOSAL_STATES.REJECTED, { table: PROPOSAL_TRANSITIONS, field: 'status' });
  const applied = ledger.applyRouteChange(proposal.proposalId, { by: 'human' });
  assert.equal(applied.applied, false);
  assert.match(applied.reason, /状态/);
});

test('应用路径后可以回滚', () => {
  const { kb, ledger } = fresh();
  const recorded = ledger.record(revisionInput(), { kb });
  ledger.attribute(recorded.pendingAttribution[0].pendingId, { layer: 'input_retrieval', scope: 'project_pattern' }, { kb });
  const proposal = ledger.proposeRouteChanges()[0];
  const before = ledger.route.slice();

  ledger.applyRouteChange(proposal.proposalId, { by: 'human' });
  assert.notDeepEqual(ledger.route, before, '应用后路径应该变了');

  const rolled = ledger.rollbackRoute({ proposalId: proposal.proposalId });
  assert.equal(rolled.rolledBack, true);
  assert.deepEqual(ledger.route, before, '回滚后路径要回到原样');
  assert.equal(ledger.proposals[0].status, PROPOSAL_STATES.ROLLED_BACK);
});

test('没有历史时回滚要如实说明', () => {
  const { ledger } = fresh();
  const rolled = ledger.rollbackRoute({});
  assert.equal(rolled.rolledBack, false);
  assert.match(rolled.reason, /没有可回滚/);
});

test('挂太久的差分会被升级', () => {
  const { kb, ledger } = fresh();
  ledger.record(revisionInput(), { kb });
  const stale = ledger.pending[0];
  stale.createdAt = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  const escalated = ledger.escalateStalePending(7 * 24 * 3600 * 1000);
  assert.deepEqual(escalated, [stale.pendingId]);
  assert.equal(stale.state, PENDING_STATES.ESCALATED);
});

test('没超期的差分不会被升级', () => {
  const { kb, ledger } = fresh();
  ledger.record(revisionInput(), { kb });
  // 样例里的 receivedAt 是固定日期，这里显式改成「刚刚」才是真的没超期
  ledger.pending[0].createdAt = new Date().toISOString();
  const escalated = ledger.escalateStalePending(7 * 24 * 3600 * 1000);
  assert.deepEqual(escalated, []);
});

test('健康检查给出积压与账龄', () => {
  const { kb, ledger } = fresh();
  ledger.record(revisionInput(), { kb });
  const health = collectHealth({ ledger: ledger, knowledgeBase: kb, result: null });

  assert.equal(health.pending.awaiting, 1);
  assert.ok(typeof health.pending.oldestAgeSec === 'number');
  // 种子 1 条 + 改稿正文/连续性各 1 条
  assert.equal(health.knowledge.documents, 3);
  assert.equal(health.knowledge.adjustedDocuments, 0);
  assert.equal(health.route.length, DEFAULT_ROUTE.length);
  assert.equal(health.lastRun, null, '没跑生成时不应编造结果');
});

test('积压超阈值时健康检查判定为不健康', () => {
  const { kb, ledger } = fresh();
  ledger.record(revisionInput(), { kb });
  // 样例里的固定日期距今很久，先放到「刚刚」，否则账龄阈值本身就会触发
  ledger.pending[0].createdAt = new Date().toISOString();
  const health = collectHealth({ ledger: ledger, knowledgeBase: kb, result: null });

  assert.equal(evaluate(health, null).healthy, true);
  const strict = evaluate(health, { maxAwaitingAttribution: 0 });
  assert.equal(strict.healthy, false);
  assert.equal(strict.breaches[0].metric, 'pending.awaiting');
});

test('上一次生成没过不回退清单会被记为越界', () => {
  const { kb, ledger } = fresh();
  const badInput = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'input', 'synthetic-badcase.json'), 'utf8'));
  const result = runWorkflow(badInput);
  const health = collectHealth({ ledger: ledger, knowledgeBase: kb, result: result });

  assert.equal(health.lastRun.noRegressionPassed, false);
  const verdict = evaluate(health, null);
  assert.equal(verdict.healthy, false);
  assert.ok(verdict.breaches.some((item) => item.metric === 'lastRun.noRegressionPassed'));
});

test('正常生成下健康检查通过', () => {
  const { kb, ledger } = fresh();
  const goodInput = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'input', 'synthetic-story.json'), 'utf8'));
  const result = runWorkflow(goodInput);
  const health = collectHealth({ ledger: ledger, knowledgeBase: kb, result: result });

  assert.equal(health.lastRun.noRegressionPassed, true);
  assert.equal(evaluate(health, null).healthy, true);
});
