const { sha256 } = require('./hash');

function tokenize(value) {
  const source = String(value || '').toLowerCase();
  const latin = source.match(/[a-z0-9][a-z0-9_-]{1,}/g) || [];
  const hanRuns = source.match(/[\p{Script=Han}]+/gu) || [];
  const han = [];
  for (const run of hanRuns) {
    if (run.length === 1) han.push(run);
    for (let index = 0; index < run.length - 1; index += 1) han.push(run.slice(index, index + 2));
  }
  return [...new Set([...latin, ...han])];
}

function searchableText(item) {
  return [item.id, item.title, item.kind, item.text, ...(item.tags || [])].filter(Boolean).join(' ');
}

function scoreEvidence(queryTokens, item) {
  const evidenceTokens = new Set(tokenize(searchableText(item)));
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

function selectContext(query, evidence, settings = {}) {
  const topK = Math.max(1, Number(settings.topK || 3));
  const minScore = Number(settings.minContextScore || 0.08);
  const queryTokens = tokenize(query);
  const ranked = (evidence || [])
    .map((item) => ({ ...item, score: scoreEvidence(queryTokens, item) }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  let selected = ranked.filter((item) => item.score >= minScore).slice(0, topK);
  if (!selected.length && ranked.length) selected = ranked.slice(0, 1);
  const averageScore = selected.length
    ? selected.reduce((sum, item) => sum + item.score, 0) / selected.length
    : 0;
  const uncertainties = selected
    .filter((item) => item.uncertainty)
    .map((item) => ({ evidenceId: item.id, note: item.uncertainty, needsHumanReview: true }));
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
    query,
    queryTokens,
    selected: compactSelection,
    excludedIds: ranked.filter((item) => !selected.some((choice) => choice.id === item.id)).map((item) => item.id),
    averageScore: Number(averageScore.toFixed(4)),
    confidence: confidenceLabel(averageScore),
    uncertainties,
    contextHash: sha256(compactSelection)
  };
}

module.exports = { tokenize, scoreEvidence, selectContext };
