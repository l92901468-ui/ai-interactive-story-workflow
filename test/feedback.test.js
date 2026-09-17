const test = require('node:test');
const assert = require('node:assert/strict');
const { FeedbackLedger, normalizeFeedback } = require('../src/feedback');
const { KnowledgeBase, SLOTS } = require('../src/knowledge-base');
const { DEFAULT_ROUTE } = require('../src/agents');

function fresh() {
  const kb = new KnowledgeBase({
    documents: [
      { id: 'EV-CANON-001', slot: SLOTS.CONTINUITY, kind: 'canon', title: '灯塔供电', text: '灯塔用月盐电池', confidence: 0.98 },
      { id: 'EV-STYLE-002', slot: SLOTS.STYLE, kind: 'reference', title: '对白样例', text: '短句对白', confidence: 0.8 }
    ]
  });
  const ledger = new FeedbackLedger({ projectId: 'demo', route: DEFAULT_ROUTE.slice() });
  return { kb, ledger };
}

test('只给好坏也能记成一次反馈', () => {
  const normalized = normalizeFeedback({ kind: 'verdict', verdict: 'bad', aspect: 'dialogue' });
  assert.equal(normalized.kind, 'verdict');
  assert.equal(normalized.polarity, -1);
  assert.equal(normalized.aspects[0].aspect, 'dialogue');
});

test('详细意见里的明确表述立即学习', () => {
  const { kb, ledger } = fresh();
  const result = ledger.record({ kind: 'comment', comment: '对白假，人物扁平', receivedAt: '2026-01-01T00:00:00.000Z' }, { kb });
  assert.ok(result.learnedImmediately.length >= 1, '明确意见应当立即生效');
  assert.ok(result.learnedImmediately.every((item) => item.aspect === 'dialogue'));
  assert.equal(ledger.version, 1, '学习版本应当推进');
});

test('改好的文章既入库又产生待归因差分', () => {
  const { kb, ledger } = fresh();
  const result = ledger.record({
    kind: 'revision',
    revisionId: 'WR-001',
    parentDraftId: 'draft_abc',
    parentText: 'AI 写的第一行\nAI 写的第二行',
    text: '编剧改的第一行\nAI 写的第二行\n编剧新增的第三行',
    generationEvidenceIds: ['EV-CANON-001'],
    receivedAt: '2026-01-01T00:00:00.000Z'
  }, { kb });

  assert.deepEqual(result.knowledgeIngested, ['WR-001:prose', 'WR-001:continuity']);
  assert.ok(result.pendingAttribution.length >= 1, '差分应当挂待归因');
  assert.ok(result.pendingAttribution.every((item) => item.state === 'awaiting_attribution'));
  // 改稿进了知识库，下一轮能检索到
  assert.ok(kb.search('编剧改的第一行', { slots: [SLOTS.STYLE] }).hits.some((hit) => hit.id === 'WR-001:prose'));
});

test('改稿附带的明确意见同样立即学习', () => {
  const { kb, ledger } = fresh();
  const result = ledger.record({
    kind: 'revision',
    revisionId: 'WR-002',
    parentText: '旧',
    text: '新',
    comment: '结构散',
    receivedAt: '2026-01-01T00:00:00.000Z'
  }, { kb });
  assert.ok(result.learnedImmediately.some((item) => item.aspect === 'structure'));
});

test('未归因的差分不允许调权', () => {
  const { kb, ledger } = fresh();
  ledger.record({
    kind: 'revision',
    revisionId: 'WR-003',
    parentText: '旧稿',
    text: '新稿',
    generationEvidenceIds: ['EV-CANON-001'],
    receivedAt: '2026-01-01T00:00:00.000Z'
  }, { kb });
  assert.equal(kb.adjustments.size, 0, '差分本身不能产生调权证据');
});

test('人工归因到召回层才允许调权', () => {
  const { kb, ledger } = fresh();
  const recorded = ledger.record({
    kind: 'revision', revisionId: 'WR-004', parentText: '旧稿', text: '新稿',
    generationEvidenceIds: ['EV-CANON-001'], receivedAt: '2026-01-01T00:00:00.000Z'
  }, { kb });

  const pendingId = recorded.pendingAttribution[0].pendingId;
  const result = ledger.attribute(pendingId, { layer: 'input_retrieval', scope: 'project_pattern', direction: 'up', reason: '召回漏了' }, { kb });
  assert.ok(result.adjustments.every((item) => item.applied), '归因到召回层应当允许调权');
  assert.equal(kb.adjustments.get('EV-CANON-001').delta, 0.1);
});

test('归因到其他层不给调权', () => {
  const { kb, ledger } = fresh();
  const recorded = ledger.record({
    kind: 'revision', revisionId: 'WR-005', parentText: '旧稿', text: '新稿',
    generationEvidenceIds: ['EV-CANON-001'], receivedAt: '2026-01-01T00:00:00.000Z'
  }, { kb });

  const pendingId = recorded.pendingAttribution[0].pendingId;
  const result = ledger.attribute(pendingId, { layer: 'prose_realization', scope: 'project_pattern', reason: '表达问题' }, { kb });
  assert.ok(result.adjustments.every((item) => !item.applied));
  assert.equal(result.adjustments[0].blockedBy, 'not_retrieval_layer');
});

test('归因层与结论范围必须合法', () => {
  const { kb, ledger } = fresh();
  const recorded = ledger.record({
    kind: 'revision', revisionId: 'WR-006', parentText: '旧稿', text: '新稿', receivedAt: '2026-01-01T00:00:00.000Z'
  }, { kb });
  const pendingId = recorded.pendingAttribution[0].pendingId;
  assert.throws(() => ledger.attribute(pendingId, { layer: '瞎写的', scope: 'project_pattern' }, { kb }), /归因层/);
  assert.throws(() => ledger.attribute(pendingId, { layer: 'input_retrieval', scope: '瞎写的' }, { kb }), /结论范围/);
});

test('路径改进先提案，人工确认后才生效', () => {
  const { kb, ledger } = fresh();
  const recorded = ledger.record({
    kind: 'revision', revisionId: 'WR-007', parentText: '旧稿', text: '新稿',
    generationEvidenceIds: ['EV-CANON-001'], receivedAt: '2026-01-01T00:00:00.000Z'
  }, { kb });
  ledger.attribute(recorded.pendingAttribution[0].pendingId, { layer: 'input_retrieval', scope: 'project_pattern', reason: '召回问题' }, { kb });

  const proposals = ledger.proposeRouteChanges();
  assert.ok(proposals.length >= 1);
  assert.ok(proposals.every((item) => item.status === 'awaiting_human'), '提案必须等人确认');
  assert.equal(ledger.route.includes('retrievalAuditor'), false, '未确认前路径不能变');

  const applied = ledger.applyRouteChange(proposals[0].proposalId, { by: 'human' });
  assert.equal(applied.applied, true);
  assert.ok(ledger.route.includes('retrievalAuditor'));
  assert.equal(ledger.proposals[0].status, 'applied');
});

test('总账可以落盘再读回', () => {
  const { kb, ledger } = fresh();
  ledger.record({ kind: 'comment', comment: '结构散', receivedAt: '2026-01-01T00:00:00.000Z' }, { kb });
  const restored = FeedbackLedger.fromJSON(ledger.toJSON());
  assert.equal(restored.events.length, ledger.events.length);
  assert.equal(restored.version, ledger.version);
});
