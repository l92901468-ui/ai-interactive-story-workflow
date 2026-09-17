// 编剧反馈总账。
//
// 三条硬规则（来自原项目，不能省）：
//   1. 编剧明确写出的意见、提交的正式正文 —— 立即学习，下一次必须装配。
//   2. 从「AI 稿 vs 编剧改稿」的差分推断出的结论 —— 必须人工归因后才生效，
//      而且只有归因到 input_retrieval 才允许动资料权重。
//   3. 路径（route）不自动改：只生成推荐路径改进，交人工研究后再应用。
//
// 另外：编剧正文只留哈希与存放位置，正文本身不进任何持久化文件或仓库。

const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./hash');
const { diffSummary } = require('./revision-diff');
const { interpretFeedback } = require('./llm-mock');
const {
  PENDING_STATES,
  PENDING_TRANSITIONS,
  PROPOSAL_STATES,
  PROPOSAL_TRANSITIONS,
  transition
} = require('./state-machine');

const KINDS = { VERDICT: 'verdict', COMMENT: 'comment', REVISION: 'revision' };

const ATTRIBUTION_LAYERS = {
  input_retrieval: '召回或参考路由造成',
  overview_interpretation: '错误理解或扩张概述',
  scene_decision: '事件所有权/顺序/阻力设计错误',
  prose_realization: '决策正确但正文表达失败'
};

const SCOPES = {
  writer_scene_choice: '本场选择，只留在场景记录',
  project_pattern: '当前项目中有条件复用',
  generalizable_failure: '可进入通用工作流候选'
};

function normalizeFeedback(input) {
  const kind = input.kind || (input.text && input.parentText ? KINDS.REVISION : KINDS.COMMENT);
  const interpreted = interpretFeedback(input.comment || input.message || '');
  const aspects = interpreted.aspects;

  if (kind === KINDS.VERDICT) {
    const polarity = input.verdict === 'good' ? 1 : input.verdict === 'bad' ? -1 : 0;
    return {
      kind: KINDS.VERDICT,
      polarity: polarity,
      aspects: input.aspect ? [{ aspect: input.aspect, polarity: polarity, matched: 'verdict' }] : [],
      sceneId: input.sceneId || null,
      textHash: null,
      storage: null
    };
  }

  if (kind === KINDS.REVISION) {
    const diff = diffSummary(input.parentText || '', input.text || '');
    return {
      kind: KINDS.REVISION,
      polarity: 0,
      aspects: aspects,
      sceneId: input.sceneId || null,
      revisionId: input.revisionId || null,
      parentDraftId: input.parentDraftId || null,
      textHash: diff.writerTextHash,
      parentTextHash: diff.aiTextHash,
      diff: diff,
      // 正文不落盘：只记存放位置，供人工查阅
      storage: input.storage || null
    };
  }

  return {
    kind: KINDS.COMMENT,
    polarity: interpreted.polarity,
    aspects: aspects,
    sceneId: input.sceneId || null,
    commentHash: sha256(input.comment || input.message || ''),
    textHash: null,
    storage: null
  };
}

// 幂等键：同样的反馈内容提交两次，第二次应当重放而不是重复生效。
// 只取内容本身，不含时间戳——否则换个时间提交就成了新事件。
function contentHashOf(normalized) {
  return sha256(JSON.stringify({
    kind: normalized.kind,
    aspects: normalized.aspects,
    textHash: normalized.textHash || null,
    parentTextHash: normalized.parentTextHash || null,
    sceneId: normalized.sceneId || null,
    revisionId: normalized.revisionId || null
  }));
}

class FeedbackLedger {
  constructor(options) {
    const opts = options || {};
    this.projectId = opts.projectId || 'unknown';
    this.events = opts.events || [];
    this.pending = opts.pending || [];
    this.proposals = opts.proposals || [];
    this.route = opts.route || null;
    this.routeHistory = opts.routeHistory || [];
    this.version = opts.version || 0;
  }

  // ---- 记录一次反馈 ----
  record(input, context) {
    const normalized = normalizeFeedback(input);
    const contentHash = contentHashOf(normalized);

    // 幂等：内容相同就直接重放上一条，不再入库、不再调权
    const duplicate = this.events.find((item) => item.contentHash === contentHash);
    if (duplicate) {
      return {
        event: duplicate,
        replayed: true,
        learnedImmediately: [],
        knowledgeIngested: [],
        pendingAttribution: []
      };
    }

    const event = {
      eventId: 'fb_' + sha256(JSON.stringify({ normalized: normalized, at: input.receivedAt || null })).slice(0, 12),
      contentHash: contentHash,
      projectId: this.projectId,
      receivedAt: input.receivedAt || new Date().toISOString(),
      feedback: normalized
    };
    this.events.push(event);

    const learnedImmediately = [];
    const knowledgeIngested = [];
    const pendingAttribution = [];

    // 规则 1：明确意见立即学习
    if (normalized.kind === KINDS.COMMENT && normalized.aspects.length) {
      for (const item of normalized.aspects) {
        learnedImmediately.push({
          type: 'explicit_opinion',
          aspect: item.aspect,
          polarity: item.polarity,
          matched: item.matched,
          scope: 'project_pattern',
          eventId: event.eventId
        });
      }
    }
    if (normalized.kind === KINDS.VERDICT && normalized.aspects.length) {
      for (const item of normalized.aspects) {
        learnedImmediately.push({
          type: 'explicit_verdict',
          aspect: item.aspect,
          polarity: item.polarity,
          scope: 'writer_scene_choice',
          eventId: event.eventId
        });
      }
    }

    // 规则 1：改稿**附带**的明确意见同样立即学习（原项目：明确附带意见立即学习）
    if (normalized.kind === KINDS.REVISION && normalized.aspects.length) {
      for (const item of normalized.aspects) {
        learnedImmediately.push({
          type: 'explicit_opinion_on_revision',
          aspect: item.aspect,
          polarity: item.polarity,
          matched: item.matched,
          scope: 'project_pattern',
          eventId: event.eventId
        });
      }
    }

    // 规则 1：编剧改稿正文立即入库（成为下一次的知识库）
    if (normalized.kind === KINDS.REVISION && context && context.kb) {
      const ingested = context.kb.ingestWriterRevision({
        revisionId: input.revisionId,
        parentId: normalized.parentDraftId,
        title: input.title,
        text: input.text,
        continuityNotes: input.continuityNotes,
        tags: input.tags,
        receivedAt: event.receivedAt
      });
      knowledgeIngested.push(ingested.prose.id, ingested.continuity.id);
    }

    // 规则 2：差分只挂待归因，不直接调权
    if (normalized.diff && normalized.diff.changed) {
      for (const hunk of normalized.diff.hunks) {
        pendingAttribution.push({
          pendingId: 'pd_' + sha256(event.eventId + JSON.stringify(hunk)).slice(0, 12),
          eventId: event.eventId,
          hunk: hunk,
          evidenceIds: (input.generationEvidenceIds || []).slice(),
          state: PENDING_STATES.AWAITING,
          createdAt: event.receivedAt
        });
      }
      this.pending = this.pending.concat(pendingAttribution);
    }

    if (learnedImmediately.length) this.version += 1;

    return { event: event, learnedImmediately: learnedImmediately, knowledgeIngested: knowledgeIngested, pendingAttribution: pendingAttribution };
  }

  // ---- 人工归因 ----
  attribute(pendingId, input, context) {
    const item = this.pending.find((entry) => entry.pendingId === pendingId);
    if (!item) throw new Error('没有这条待归因记录：' + pendingId);
    if (!ATTRIBUTION_LAYERS[input.layer]) throw new Error('归因层必须是：' + Object.keys(ATTRIBUTION_LAYERS).join(' / '));
    if (!SCOPES[input.scope]) throw new Error('结论范围必须是：' + Object.keys(SCOPES).join(' / '));

    // 幂等：已经处理过的条目再归因一次，重放结论但不重复调权
    if (item.state === PENDING_STATES.ATTRIBUTED) {
      return { pending: item, adjustments: [], replayed: true, blockedBy: 'already_attributed', reason: '该差分已归因，重复调用不会再次调权' };
    }

    item.attribution = { layer: input.layer, scope: input.scope, reason: input.reason || '', by: input.by || 'human' };
    transition(item, PENDING_STATES.ATTRIBUTED, { table: PENDING_TRANSITIONS, field: 'state' });

    const adjustments = [];
    // 规则 2：只有 input_retrieval 才产生调权证据，且只针对真正进了本次生成包的资料
    if (input.layer === 'input_retrieval' && context && context.kb) {
      const direction = input.direction === 'up' ? 0.1 : -0.1;
      for (const documentId of item.evidenceIds) {
        adjustments.push(Object.assign({ documentId: documentId }, context.kb.adjust(documentId, {
          delta: direction,
          attribution: item.attribution,
          scope: input.scope,
          reason: input.reason || '人工归因到召回层'
        })));
      }
    } else {
      adjustments.push({ documentId: null, applied: false, blockedBy: 'not_retrieval_layer', reason: '只有归因到 input_retrieval 才能产生调权证据' });
    }

    return { pending: item, adjustments: adjustments };
  }

  // ---- 规则 3：推荐路径改进，交人工 ----
  proposeRouteChanges() {
    const byLayer = {};
    for (const item of this.pending) {
      if (!item.attribution) continue;
      byLayer[item.attribution.layer] = (byLayer[item.attribution.layer] || 0) + 1;
    }

    const proposals = [];
    const supportFor = (layer) => this.pending.filter((item) => item.attribution && item.attribution.layer === layer).map((item) => item.pendingId);

    if (byLayer.input_retrieval) {
      proposals.push({
        proposalId: 'rp_retrieval_' + sha256('input_retrieval' + this.version).slice(0, 8),
        kind: 'route',
        change: { insertAfter: 'retriever', agentId: 'retrievalAuditor' },
        rationale: '多次归因到召回层，说明召回结果没有被独立复核就进入了起草',
        supportingPendingIds: supportFor('input_retrieval'),
        status: PROPOSAL_STATES.AWAITING
      });
    }
    if (byLayer.prose_realization) {
      proposals.push({
        proposalId: 'rp_prose_' + sha256('prose_realization' + this.version).slice(0, 8),
        kind: 'route',
        change: { insertBefore: 'qualityGate', agentId: 'proseReviewer' },
        rationale: '决策正确但表达失败的归因较多，起草后、质量门前应加一次表达复核',
        supportingPendingIds: supportFor('prose_realization'),
        status: PROPOSAL_STATES.AWAITING
      });
    }
    if (byLayer.scene_decision) {
      proposals.push({
        proposalId: 'rp_scene_' + sha256('scene_decision' + this.version).slice(0, 8),
        kind: 'route',
        change: { moveEarlier: 'planner' },
        rationale: '事件所有权与顺序问题来自规划阶段，规划应更早锁定并复核',
        supportingPendingIds: supportFor('scene_decision'),
        status: PROPOSAL_STATES.AWAITING
      });
    }

    // 去重：同一 proposalId 已经提过就不再重复
    const known = new Set(this.proposals.map((item) => item.proposalId));
    const fresh = proposals.filter((item) => !known.has(item.proposalId));
    this.proposals = this.proposals.concat(fresh);
    return fresh;
  }

  applyRouteChange(proposalId, options) {
    const proposal = this.proposals.find((item) => item.proposalId === proposalId);
    if (!proposal) throw new Error('没有这条路径改进建议：' + proposalId);

    let moved;
    try {
      moved = transition(proposal, PROPOSAL_STATES.APPLIED, { table: PROPOSAL_TRANSITIONS, field: 'status' });
    } catch (error) {
      // 非法跳转不抛给调用方，而是带上原因返回，便于人工判断下一步
      return { applied: false, reason: error.message };
    }
    if (!moved.changed) return { applied: false, reason: moved.reason === 'already_in_state' ? '已经应用过' : '当前状态不允许应用' };

    const base = (options && options.route) || this.route;
    if (!base) return { applied: false, reason: '没有当前 route，无法应用' };

    // 改动前先把当前路径存进历史，回滚时才有得退
    this.routeHistory.push({ route: base.slice(), at: new Date().toISOString(), proposalId: proposalId });

    const next = base.slice();
    const change = proposal.change;
    if (change.insertAfter) {
      const index = next.indexOf(change.insertAfter);
      if (index !== -1) next.splice(index + 1, 0, change.agentId);
    } else if (change.insertBefore) {
      const index = next.indexOf(change.insertBefore);
      if (index !== -1) next.splice(index, 0, change.agentId);
    } else if (change.moveEarlier) {
      const index = next.indexOf(change.moveEarlier);
      if (index > 0) {
        next.splice(index, 1);
        next.unshift(change.moveEarlier);
      }
    }

    this.route = next;
    proposal.appliedAt = new Date().toISOString();
    proposal.appliedBy = (options && options.by) || 'human';
    this.version += 1;
    return { applied: true, route: next };
  }

  // ---- 回滚：改完路径发现不回退清单过不了，能退回上一条 ----
  rollbackRoute(options) {
    const opts = options || {};
    const history = this.routeHistory || [];
    let entry = null;
    if (opts.proposalId) {
      const index = history.map((item) => item.proposalId).lastIndexOf(opts.proposalId);
      if (index !== -1) entry = history.splice(index, 1)[0];
    } else {
      entry = history.pop() || null;
    }
    if (!entry) return { rolledBack: false, reason: '没有可回滚的路径记录' };

    this.route = entry.route.slice();
    const proposal = this.proposals.find((item) => item.proposalId === entry.proposalId);
    if (proposal) transition(proposal, PROPOSAL_STATES.ROLLED_BACK, { table: PROPOSAL_TRANSITIONS, field: 'status' });
    this.version += 1;
    return { rolledBack: true, route: this.route, proposalId: entry.proposalId };
  }

  // ---- 挂起过久的差分升级，避免一直没人处理 ----
  escalateStalePending(maxAgeMs) {
    const now = Date.now();
    const escalated = [];
    for (const item of this.pending) {
      if (item.state !== PENDING_STATES.AWAITING) continue;
      const created = Date.parse(item.createdAt || 0);
      if (!Number.isFinite(created) || now - created <= maxAgeMs) continue;
      transition(item, PENDING_STATES.ESCALATED, { table: PENDING_TRANSITIONS, field: 'state' });
      escalated.push(item.pendingId);
    }
    return escalated;
  }

  summary() {
    const awaiting = this.pending.filter((item) => item.state === 'awaiting_attribution').length;
    return {
      projectId: this.projectId,
      version: this.version,
      events: this.events.length,
      pendingAttribution: awaiting,
      attributed: this.pending.filter((item) => item.state === 'attributed').length,
      proposals: this.proposals.length,
      awaitingHumanProposals: this.proposals.filter((item) => item.status === PROPOSAL_STATES.AWAITING).length,
      appliedProposals: this.proposals.filter((item) => item.status === PROPOSAL_STATES.APPLIED).length,
      rolledBackProposals: this.proposals.filter((item) => item.status === PROPOSAL_STATES.ROLLED_BACK).length,
      escalated: this.pending.filter((item) => item.state === PENDING_STATES.ESCALATED).length,
      routeHistoryLength: this.routeHistory.length,
      route: this.route
    };
  }

  toJSON() {
    return {
      projectId: this.projectId,
      version: this.version,
      route: this.route,
      routeHistory: this.routeHistory,
      events: this.events,
      pending: this.pending,
      proposals: this.proposals
    };
  }

  static fromJSON(data) {
    return new FeedbackLedger(data || {});
  }

  // ---- 持久化（显式调用才落盘，默认纯内存，保证测试可复现） ----
  save(dir) {
    const target = path.resolve(dir);
    fs.mkdirSync(target, { recursive: true });
    const file = path.join(target, 'feedback-ledger.json');
    fs.writeFileSync(file, JSON.stringify(this.toJSON(), null, 2) + '\n', 'utf8');
    return file;
  }

  static load(dir) {
    const file = path.resolve(dir, 'feedback-ledger.json');
    if (!fs.existsSync(file)) return null;
    return FeedbackLedger.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
}

module.exports = {
  FeedbackLedger: FeedbackLedger,
  normalizeFeedback: normalizeFeedback,
  KINDS: KINDS,
  ATTRIBUTION_LAYERS: ATTRIBUTION_LAYERS,
  SCOPES: SCOPES
};
