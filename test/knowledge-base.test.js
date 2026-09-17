const test = require('node:test');
const assert = require('node:assert/strict');
const { KnowledgeBase, SLOTS } = require('../src/knowledge-base');

function seedKb() {
  return new KnowledgeBase({
    documents: [
      { id: 'EV-CANON-001', slot: SLOTS.CONTINUITY, kind: 'canon', title: '灯塔供电', text: '灯塔用月盐电池', tags: ['lighthouse', 'battery'], confidence: 0.98 },
      { id: 'EV-STYLE-002', slot: SLOTS.STYLE, kind: 'reference', title: '对白样例', text: '短句对白与沉默', tags: ['dialogue'], confidence: 0.8 },
      { id: 'PLAN-001', slot: SLOTS.PLANNING, kind: 'overview', title: '概述', text: '本场目标是恢复供电', tags: ['overview'], confidence: 1 }
    ]
  });
}

test('检索按槽位分开召回', () => {
  const kb = seedKb();
  const style = kb.search('对白', { slots: [SLOTS.STYLE] });
  const planning = kb.search('供电目标', { slots: [SLOTS.PLANNING] });
  assert.ok(style.hits.some((hit) => hit.id === 'EV-STYLE-002'));
  assert.ok(planning.hits.every((hit) => hit.slot === SLOTS.PLANNING));
});

test('每个命中都能解释分数是怎么来的', () => {
  const kb = seedKb();
  const hit = kb.search('lighthouse battery', { slots: [SLOTS.CONTINUITY] }).hits[0];
  assert.equal(hit.id, 'EV-CANON-001');
  const factors = hit.explain.factors.map((item) => item.factor);
  for (const name of ['termOverlap', 'confidence', 'canonicalBoost', 'slotBonus', 'learntDelta']) {
    assert.ok(factors.includes(name), '缺少因子 ' + name);
  }
});

test('派生条目不参与常规打分', () => {
  const kb = seedKb();
  kb.addDocument({ id: 'DERIVED-1', slot: SLOTS.PLANNING, title: '查询本身', text: 'lighthouse battery', derived: true });
  const withDerived = kb.search('lighthouse battery', { slots: [SLOTS.PLANNING] });
  const withoutDerived = kb.search('lighthouse battery', { slots: [SLOTS.PLANNING], includeDerived: false });
  assert.ok(withDerived.hits.some((hit) => hit.id === 'DERIVED-1'));
  assert.ok(!withoutDerived.hits.some((hit) => hit.id === 'DERIVED-1'));
});

test('没有归因不允许调权', () => {
  const kb = seedKb();
  const result = kb.adjust('EV-CANON-001', { delta: 0.1, scope: 'project_pattern' });
  assert.equal(result.applied, false);
  assert.equal(result.blockedBy, 'attribution_required');
});

test('单次调权幅度超过上限会被拦下', () => {
  const kb = seedKb();
  const result = kb.adjust('EV-CANON-001', { delta: 0.5, attribution: { layer: 'input_retrieval' }, scope: 'project_pattern' });
  assert.equal(result.applied, false);
  assert.equal(result.blockedBy, 'delta_too_large');
});

test('归因到召回层且范围够大才允许调权', () => {
  const kb = seedKb();
  const result = kb.adjust('EV-CANON-001', { delta: 0.1, attribution: { layer: 'input_retrieval' }, scope: 'project_pattern', reason: '召回偏弱' });
  assert.equal(result.applied, true);
  assert.equal(result.delta, 0.1);
});

test('归因到其他层不产生调权证据', () => {
  const kb = seedKb();
  kb.adjust('EV-CANON-001', { delta: 0.1, attribution: { layer: 'input_retrieval' }, scope: 'project_pattern' });
  const before = kb.adjustments.get('EV-CANON-001').delta;
  const blocked = kb.adjust('EV-CANON-001', { delta: 0.1, attribution: { layer: 'prose_realization' }, scope: 'project_pattern' });
  assert.equal(blocked.applied, false);
  assert.equal(kb.adjustments.get('EV-CANON-001').delta, before);
});

test('禁用需要明确指令或两次独立负面验证', () => {
  const kb = seedKb();
  assert.equal(kb.ban('EV-CANON-001').applied, false);

  kb.adjust('EV-CANON-001', { delta: -0.1, attribution: { layer: 'input_retrieval' }, scope: 'project_pattern' });
  assert.equal(kb.ban('EV-CANON-001').applied, false, '一次负面还不够');

  kb.adjust('EV-CANON-001', { delta: -0.1, attribution: { layer: 'input_retrieval' }, scope: 'project_pattern' });
  assert.equal(kb.ban('EV-CANON-001').applied, true, '两次独立负面验证后可以禁用');
});

test('编剧改稿进 style 与 continuity 两个槽', () => {
  const kb = seedKb();
  const ingested = kb.ingestWriterRevision({
    revisionId: 'WR-001',
    parentId: 'draft_abc',
    title: '第一场',
    text: '改好的正文内容',
    continuityNotes: ['电池余量已记录']
  });
  assert.equal(ingested.prose.slot, SLOTS.STYLE);
  assert.equal(ingested.continuity.slot, SLOTS.CONTINUITY);
  assert.equal(kb.stats().revisionDocuments, 2);
  // 下一轮检索应该能找到它
  const next = kb.search('改好的正文内容', { slots: [SLOTS.STYLE] });
  assert.ok(next.hits.some((hit) => hit.id === 'WR-001:prose'));
});

test('知识库可以落盘再读回', () => {
  const kb = seedKb();
  kb.adjust('EV-CANON-001', { delta: 0.1, attribution: { layer: 'input_retrieval' }, scope: 'project_pattern' });
  const restored = KnowledgeBase.fromJSON(kb.toJSON());
  assert.equal(restored.stats().documents, kb.stats().documents);
  assert.equal(restored.adjustments.get('EV-CANON-001').delta, 0.1);
});
