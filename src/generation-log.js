// 生成期持久日志。
//
// 关键：这些信息是**生成的时候**写下的，不是事后回推的。事后回推不出来，
// 因为当时的召回路由、学习版本和决策节点映射都已经变了。
//
// 日志只写哈希、ID、分数和路径，不写任何正文。

const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./hash');

const REQUIRED_EVIDENCE = ['contextHash', 'planHash', 'draftHash', 'decisionLinks', 'routing'];

function evidenceCompleteness(record) {
  const missing = REQUIRED_EVIDENCE.filter((key) => {
    const value = record[key];
    if (key === 'decisionLinks') return !Array.isArray(value) || !value.length;
    if (key === 'routing') return !Array.isArray(value) || !value.length;
    return !value;
  });
  return missing.length ? { state: 'evidence_incomplete', missing: missing } : { state: 'complete', missing: [] };
}

class GenerationLog {
  constructor(dir) {
    this.dir = path.resolve(dir || 'state/generations');
    this.file = path.join(this.dir, 'generations.jsonl');
  }

  append(record) {
    fs.mkdirSync(this.dir, { recursive: true });
    const entry = Object.assign({ loggedAt: new Date().toISOString() }, record);
    entry.logId = 'gen_' + sha256(JSON.stringify(entry)).slice(0, 12);
    entry.evidence = evidenceCompleteness(entry);
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  }

  read() {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }

  latest() {
    const entries = this.read();
    return entries.length ? entries[entries.length - 1] : null;
  }
}

// 把一次运行整理成一条生成记录
function buildGenerationRecord(input) {
  const state = input.state;
  const draft = state.draft || null;
  const retrieval = state.retrieval || { routing: [], hits: [], budget: {} };
  const quality = state.quality || null;

  return {
    generatedAt: input.generatedAt,
    projectId: input.projectId,
    learningVersion: state.learningVersion,
    route: input.route,
    path: state.path,
    contextHash: input.contextHash,
    planHash: state.plan ? sha256(state.plan) : null,
    draftHash: draft ? sha256(draft.text) : null,
    draftId: draft ? draft.draftId : null,
    model: draft ? draft.model : null,
    requestHash: draft ? draft.requestHash : null,
    decisionLinks: draft ? draft.decisionLinks : [],
    routing: retrieval.routing.map((item) => ({ slot: item.slot, id: item.id, score: item.score })),
    budget: retrieval.budget,
    knowledgeStats: input.knowledgeStats || null,
    gates: quality
      ? quality.gates.map((gate) => ({ id: gate.id, status: gate.status, weights: gate.weights, path: gate.path }))
      : [],
    qualityStatus: quality ? quality.status : null,
    receiptHash: input.receiptHash || null
  };
}

module.exports = { GenerationLog: GenerationLog, buildGenerationRecord: buildGenerationRecord, evidenceCompleteness: evidenceCompleteness, REQUIRED_EVIDENCE: REQUIRED_EVIDENCE };
