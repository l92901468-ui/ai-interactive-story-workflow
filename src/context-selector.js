// 轻量上下文选择。
//
// 这一版把打分搬到了 KnowledgeBase 里（见 knowledge-base.js），这里只保留
// 对外契约：输入 query + evidence，输出选中项、排除项、平均分、置信度与不确定项。
// 输出结构与之前完全一致，历史快照仍可比对。

const { sha256 } = require('./hash');
const { tokenize } = require('./tokenize');
const { KnowledgeBase } = require('./knowledge-base');

function scoreEvidence(queryTokens, item) {
  const evidenceTokens = new Set(tokenize([item.id, item.title, item.kind, item.text].concat(item.tags || []).filter(Boolean).join(' ')));
  const overlap = queryTokens.filter((token) => evidenceTokens.has(token));
  const base = queryTokens.length ? overlap.length / queryTokens.length : 0;
  const confidenceWeight = Number.isFinite(item.confidence) ? Math.max(0.4, item.confidence) : 0.8;
  const canonicalBoost = item.kind === 'canon' ? 0.08 : 0;
  return Math.min(1, Number((base * confidenceWeight + canonicalBoost).toFixed(4)));
}

function confidenceLabel(score) {
  if (score >= 0.5) return 'high';
  if (score >= 0.2) return 'medium';
  return 'low';
}

function selectContext(query, evidence, settings, options) {
  const opts = options || {};
  const topK = Math.max(1, Number((settings || {}).topK || 3));
  const minScore = Number((settings || {}).minContextScore || 0.08);
  const queryTokens = tokenize(query);

  // 复用调用方已有的知识库（含编剧改稿），否则临时建一个。
  // includeDerived=false：由查询本身派生出来的概述条目不参与打分。
  const kb = opts.knowledgeBase || new KnowledgeBase({ documents: evidence || [] });
  const result = kb.search(query, { topK: topK, minScore: minScore, includeDerived: false });
  const selected = result.hits;

  const averageScore = selected.length
    ? selected.reduce((sum, item) => sum + item.score, 0) / selected.length
    : 0;

  const uncertainties = selected
    .filter((item) => item.uncertainty)
    .map((item) => ({ evidenceId: item.id, note: item.uncertainty, needsHumanReview: true }));

  // 保持历史输出结构，避免既有快照与回执失效
  const compactSelection = selected.map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    score: item.score,
    confidence: item.confidence,
    text: item.text,
    tags: item.tags || [],
    uncertainty: item.uncertainty || null
  }));

  return {
    query: query,
    queryTokens: queryTokens,
    selected: compactSelection,
    hits: selected,
    excludedIds: result.excludedIds,
    averageScore: Number(averageScore.toFixed(4)),
    confidence: confidenceLabel(averageScore),
    uncertainties: uncertainties,
    contextHash: sha256(compactSelection)
  };
}

module.exports = { tokenize: tokenize, scoreEvidence: scoreEvidence, selectContext: selectContext, confidenceLabel: confidenceLabel };
