const { sha256 } = require('./hash');
const { tokenize } = require('./tokenize');

const SLOTS = {
  PLANNING: 'planning',
  STYLE: 'style',
  CONTINUITY: 'continuity'
};

const SLOT_LABELS = {
  planning: '概述/规划',
  style: '文风',
  continuity: '连续性'
};

// 权重安全门：从差分推断出来的结论不能直接改权重，只有人工归因到
// input_retrieval 才可以。单次只做条件化 boost/downrank，不能直接 avoid。
const SAFETY = {
  maxSingleDelta: 0.1,
  negativeVerificationsForAvoid: 2
};

function searchableText(item) {
  return [item.id, item.title, item.slot, item.kind, item.text, ...(item.tags || [])]
    .filter(Boolean)
    .join(' ');
}

class KnowledgeBase {
  constructor(options = {}) {
    this.documents = new Map();
    this.adjustments = new Map();
    this.slotBonus = options.slotBonus || {};
    this.revisionCount = 0;
    for (const document of options.documents || []) this.addDocument(document);
  }

  addDocument(document) {
    if (!document || !document.id) throw new Error('A knowledge document needs a stable id.');
    const record = {
      id: String(document.id),
      slot: document.slot || SLOTS.CONTINUITY,
      kind: document.kind || 'reference',
      title: document.title || document.id,
      text: String(document.text || ''),
      tags: document.tags || [],
      confidence: Number.isFinite(document.confidence) ? document.confidence : 0.8,
      uncertainty: document.uncertainty || null,
      source: document.source || 'seed',
      revisionOf: document.revisionOf || null,
      addedAt: document.addedAt || null,
      // derived：由查询或概述派生出来的条目（例如把 query 本身当成 planning 文档）。
      // 它不参与常规打分，否则会把查询原文当成命中证据。
      derived: document.derived === true,
      tokens: null
    };
    record.tokens = new Set(tokenize(searchableText(record)));
    this.documents.set(record.id, record);
    return record;
  }

  ingestWriterRevision(revision) {
    // 编剧改好的正文同时进两个槽：正文是 style，附带连续性是 continuity。
    // 这是「改好的文章成为下一次的知识库」这一步。
    const suffix = sha256(revision.text || '').slice(0, 12);
    const baseId = revision.revisionId ? String(revision.revisionId) : 'rev_' + suffix;
    const prose = this.addDocument({
      id: baseId + ':prose',
      slot: SLOTS.STYLE,
      kind: 'writer_revision',
      title: revision.title || '编剧改稿正文',
      text: revision.text || '',
      tags: ['writer_revision'].concat(revision.tags || []),
      confidence: 1,
      source: 'writer_revision',
      revisionOf: revision.parentId || null,
      addedAt: revision.receivedAt || null
    });
    const continuityNotes = (revision.continuityNotes || []).join('\n');
    const continuity = this.addDocument({
      id: baseId + ':continuity',
      slot: SLOTS.CONTINUITY,
      kind: 'writer_revision',
      title: revision.title || '编剧改稿连续性',
      text: continuityNotes || String(revision.text || '').slice(0, 400),
      tags: ['writer_revision', 'continuity'].concat(revision.tags || []),
      confidence: 1,
      source: 'writer_revision',
      revisionOf: revision.parentId || null,
      addedAt: revision.receivedAt || null
    });
    this.revisionCount += 2;
    return { prose: prose, continuity: continuity };
  }

  score(queryTokens, document) {
    const overlap = queryTokens.filter((token) => document.tokens.has(token));
    const base = queryTokens.length ? overlap.length / queryTokens.length : 0;
    const confidenceWeight = Math.max(0.4, document.confidence);
    const canonicalBoost = document.kind === 'canon' ? 0.08 : 0;
    const slotBonus = this.slotBonus[document.slot] || 0;
    const adjustment = this.adjustments.get(document.id);
    const learntDelta = adjustment ? adjustment.delta : 0;
    const raw = base * confidenceWeight + canonicalBoost + slotBonus + learntDelta;
    const score = Math.min(1, Math.max(0, Number(raw.toFixed(4))));
    return {
      score: score,
      explain: {
        factors: [
          { factor: 'termOverlap', value: Number(base.toFixed(4)), note: overlap.length + '/' + queryTokens.length + ' 个查询词命中' },
          { factor: 'confidence', value: confidenceWeight, note: '来自资料自身置信度' },
          { factor: 'canonicalBoost', value: canonicalBoost, note: document.kind === 'canon' ? '权威资料加成' : '非权威资料' },
          { factor: 'slotBonus', value: slotBonus, note: SLOT_LABELS[document.slot] || document.slot },
          { factor: 'learntDelta', value: Number(learntDelta.toFixed(4)), note: adjustment ? '来自编剧反馈调权' : '尚无调权' }
        ]
      }
    };
  }

  search(query, options = {}) {
    const topK = Math.max(1, Number(options.topK || 3));
    const minScore = Number(options.minScore || 0.08);
    const slots = options.slots || null;
    const queryTokens = tokenize(query);

    const includeDerived = options.includeDerived !== false;
    const ranked = Array.from(this.documents.values())
      .filter((document) => includeDerived || !document.derived)
      .filter((document) => !slots || slots.indexOf(document.slot) !== -1)
      .map((document) => {
        const scored = this.score(queryTokens, document);
        return { document: document, score: scored.score, explain: scored.explain };
      })
      .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id));

    let selected = ranked.filter((item) => item.score >= minScore).slice(0, topK);
    if (!selected.length && ranked.length) selected = ranked.slice(0, 1);

    const self = this;
    return {
      query: query,
      queryTokens: queryTokens,
      hits: selected.map((item) => self.describe(item)),
      excludedIds: ranked
        .filter((item) => !selected.some((choice) => choice.document.id === item.document.id))
        .map((item) => item.document.id),
      candidateCount: ranked.length
    };
  }

  describe(item) {
    const document = item.document;
    const adjustment = this.adjustments.get(document.id);
    return {
      id: document.id,
      slot: document.slot,
      slotLabel: SLOT_LABELS[document.slot] || document.slot,
      kind: document.kind,
      title: document.title,
      score: item.score,
      confidence: document.confidence,
      text: document.text,
      tags: document.tags,
      uncertainty: document.uncertainty || null,
      source: document.source,
      revisionOf: document.revisionOf,
      explain: item.explain,
      adjustment: adjustment
        ? { delta: adjustment.delta, reasons: adjustment.reasons, negativeVerifications: adjustment.negativeVerifications }
        : null
    };
  }

  // ---- 调权安全门 ----
  adjust(documentId, input) {
    const document = this.documents.get(documentId);
    if (!document) throw new Error('未知资料：' + documentId);
    const delta = Number(input.delta || 0);
    const attribution = input.attribution || null;

    // 只有归因到 input_retrieval 才产生调权证据
    if (!attribution || attribution.layer !== 'input_retrieval') {
      return { applied: false, blockedBy: 'attribution_required', reason: '只有归因到 input_retrieval 才能产生调权证据' };
    }
    if (input.scope !== 'project_pattern' && input.scope !== 'generalizable_failure') {
      return { applied: false, blockedBy: 'scope_too_narrow', reason: '结论范围必须至少是项目规律或可泛化失败' };
    }
    if (Math.abs(delta) > SAFETY.maxSingleDelta) {
      return { applied: false, blockedBy: 'delta_too_large', reason: '单次调权不得超过 ' + SAFETY.maxSingleDelta };
    }

    const current = this.adjustments.get(documentId) || { delta: 0, reasons: [], negativeVerifications: 0 };
    const next = {
      delta: Number(Math.min(0.4, Math.max(-0.4, current.delta + delta)).toFixed(4)),
      reasons: current.reasons.concat([input.reason || '未说明原因']).slice(-10),
      negativeVerifications: current.negativeVerifications + (delta < 0 ? 1 : 0)
    };
    this.adjustments.set(documentId, next);
    return { applied: true, delta: next.delta, blockedBy: null };
  }

  ban(documentId, input) {
    // avoid 是重动作：要么编剧明确禁用，要么两次独立负面验证。
    const current = this.adjustments.get(documentId);
    const explicit = input && input.explicit === true;
    const verified = current && current.negativeVerifications >= SAFETY.negativeVerificationsForAvoid;
    if (!explicit && !verified) {
      return {
        applied: false,
        blockedBy: 'avoid_guard',
        reason: '禁用需要编剧明确禁用，或 ' + SAFETY.negativeVerificationsForAvoid + ' 次独立负面验证（当前 ' + (current ? current.negativeVerifications : 0) + ' 次）'
      };
    }
    this.adjustments.set(documentId, {
      delta: -0.4,
      reasons: ((current && current.reasons) || []).concat([(input && input.reason) || (explicit ? '编剧明确禁用' : '两次独立负面验证')]),
      negativeVerifications: (current && current.negativeVerifications) || 0,
      banned: true
    });
    return { applied: true, delta: -0.4, blockedBy: null };
  }

  // ---- 持久化 ----
  // 只落到本地 state/ 目录（已 gitignore），不会进仓库。
  // 调权和编剧改稿必须能跨进程存活，否则「下一次立即生效」就是假的。
  toJSON() {
    return {
      documents: Array.from(this.documents.values()).map((document) => ({
        id: document.id,
        slot: document.slot,
        kind: document.kind,
        title: document.title,
        text: document.text,
        tags: document.tags,
        confidence: document.confidence,
        uncertainty: document.uncertainty,
        source: document.source,
        revisionOf: document.revisionOf,
        addedAt: document.addedAt,
        derived: document.derived
      })),
      adjustments: Array.from(this.adjustments.entries()).map((entry) => Object.assign({ id: entry[0] }, entry[1])),
      slotBonus: this.slotBonus,
      revisionCount: this.revisionCount
    };
  }

  static fromJSON(data) {
    const kb = new KnowledgeBase({ slotBonus: (data && data.slotBonus) || {} });
    for (const document of (data && data.documents) || []) kb.addDocument(document);
    for (const item of (data && data.adjustments) || []) {
      const copy = Object.assign({}, item);
      const id = copy.id;
      delete copy.id;
      kb.adjustments.set(id, copy);
    }
    kb.revisionCount = (data && data.revisionCount) || 0;
    return kb;
  }

  save(dir) {
    const fs = require('node:fs');
    const path = require('node:path');
    const target = path.resolve(dir);
    fs.mkdirSync(target, { recursive: true });
    const file = path.join(target, 'knowledge.json');
    fs.writeFileSync(file, JSON.stringify(this.toJSON(), null, 2) + '\n', 'utf8');
    return file;
  }

  static load(dir) {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = path.resolve(dir, 'knowledge.json');
    if (!fs.existsSync(file)) return null;
    return KnowledgeBase.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  stats() {
    const bySlot = {};
    for (const document of this.documents.values()) {
      bySlot[document.slot] = (bySlot[document.slot] || 0) + 1;
    }
    return {
      documents: this.documents.size,
      bySlot: bySlot,
      adjustments: this.adjustments.size,
      revisionDocuments: this.revisionCount
    };
  }
}

module.exports = { KnowledgeBase: KnowledgeBase, SLOTS: SLOTS, SLOT_LABELS: SLOT_LABELS, SAFETY: SAFETY };
