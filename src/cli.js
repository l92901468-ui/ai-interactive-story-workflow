#!/usr/bin/env node
// 命令行入口。
//
//   run          跑一次生成（默认，兼容旧用法：node src/cli.js <input> [output]）
//   feedback     记录编剧反馈（意见 / 好坏 / 改好的文章）
//   pending      列出等待人工归因的差分
//   attribute    人工给出归因层与结论范围
//   propose      生成推荐路径改进（交人工）
//   apply        人工确认后应用路径改进
//   audit        查看总账与不回退清单
//
// 编剧正文一律通过 --text-file 从本地文件读入，该文件默认放在 private/ 下，
// 已被 .gitignore 忽略，正文本身不会进仓库。

const fs = require('node:fs');
const path = require('node:path');

const { runWorkflow } = require('./workflow');
const { stableStringify } = require('./hash');
const { FeedbackLedger } = require('./feedback');
const { KnowledgeBase } = require('./knowledge-base');
const { DEFAULT_ROUTE } = require('./agents');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const token of argv) {
    if (token.startsWith('--')) {
      const [key, ...rest] = token.slice(2).split('=');
      flags[key] = rest.length ? rest.join('=') : true;
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function stateDir(flags) {
  return String(flags.state || 'state');
}

function loadLedger(flags) {
  const dir = stateDir(flags);
  const ledger = FeedbackLedger.load(dir);
  if (ledger) return ledger;
  const projectId = flags['project-id'] === true ? 'lantern-isles-demo' : String(flags['project-id'] || 'lantern-isles-demo');
  return new FeedbackLedger({ projectId: projectId, route: DEFAULT_ROUTE.slice() });
}

function out(payload) {
  process.stdout.write(stableStringify(payload) + '\n');
}

// 知识库优先从 state/ 读回（含上一次的调权与编剧改稿），
// 没有再用项目输入重建一份。改动后统一写回，否则「下一次生效」是假的。
function loadKnowledge(flags, project) {
  const dir = stateDir(flags);
  const persisted = KnowledgeBase.load(dir);
  if (persisted) return persisted;
  if (!project) return null;
  return runWorkflow(project, {}).knowledgeBase;
}

function commandRun(args) {
  const [inputPath, outputPath] = args.positional;
  if (!inputPath) {
    console.error('Usage: node src/cli.js run <input.json> [output.json] [--state=state] [--log=state/generations]');
    process.exitCode = 1;
    return null;
  }
  const input = readJson(inputPath);
  const kb = loadKnowledge(args.flags, input);
  // 路径以人工确认后的 ledger.route 为准——改动过的路径必须真的用上
  const ledger = FeedbackLedger.load(stateDir(args.flags));
  const result = runWorkflow(input, {
    logDir: args.flags.log || null,
    knowledgeBase: kb || undefined,
    route: ledger && ledger.route ? ledger.route : null
  });
  if (kb) kb.save(stateDir(args.flags));
  const serialized = stableStringify({ snapshot: result.snapshot, receipt: result.receipt, timings: result.timings }) + '\n';
  if (outputPath) {
    const destination = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, serialized, 'utf8');
    console.error('已写入 ' + destination);
  } else {
    process.stdout.write(serialized);
  }
  return result;
}

function commandFeedback(args) {
  const ledger = loadLedger(args.flags);
  const payload = args.flags.input ? readJson(args.flags.input) : {};
  const project = args.flags.project ? readJson(args.flags.project) : null;

  const kb = loadKnowledge(args.flags, project);

  const input = {
    kind: payload.kind || null,
    verdict: payload.verdict || null,
    aspect: payload.aspect || null,
    comment: payload.comment || payload.message || '',
    text: payload.text || (args.flags['text-file'] ? fs.readFileSync(path.resolve(args.flags['text-file']), 'utf8') : null),
    parentText: payload.parentText || null,
    parentDraftId: payload.parentDraftId || null,
    revisionId: payload.revisionId || null,
    sceneId: payload.sceneId || null,
    title: payload.title || null,
    tags: payload.tags || null,
    continuityNotes: payload.continuityNotes || null,
    generationEvidenceIds: payload.generationEvidenceIds || [],
    storage: args.flags['text-file'] ? path.resolve(args.flags['text-file']) : null,
    receivedAt: payload.receivedAt || new Date().toISOString()
  };

  const result = ledger.record(input, { kb: kb });
  ledger.save(stateDir(args.flags));
  if (kb) kb.save(stateDir(args.flags));
  out({
    recorded: { eventId: result.event.eventId, kind: result.event.feedback.kind },
    learnedImmediately: result.learnedImmediately,
    knowledgeIngested: result.knowledgeIngested,
    pendingAttribution: result.pendingAttribution.map((item) => item.pendingId),
    ledger: ledger.summary()
  });
  return result;
}

function commandPending(args) {
  const ledger = loadLedger(args.flags);
  const items = ledger.pending.filter((item) => item.state === 'awaiting_attribution');
  out({
    count: items.length,
    items: items.map((item) => ({
      pendingId: item.pendingId,
      eventId: item.eventId,
      hunkType: item.hunk.type,
      beforeLines: item.hunk.beforeLines,
      afterLines: item.hunk.afterLines,
      evidenceIds: item.evidenceIds
    }))
  });
}

function commandAttribute(args) {
  const ledger = loadLedger(args.flags);
  const project = args.flags.project ? readJson(args.flags.project) : null;
  const kb = loadKnowledge(args.flags, project);

  const result = ledger.attribute(String(args.flags.pending || ''), {
    layer: String(args.flags.layer || ''),
    scope: String(args.flags.scope || ''),
    reason: args.flags.reason === true ? '' : String(args.flags.reason || ''),
    direction: args.flags.direction === true ? 'up' : String(args.flags.direction || 'up'),
    by: 'human'
  }, { kb: kb });

  ledger.proposeRouteChanges();
  ledger.save(stateDir(args.flags));
  if (kb) kb.save(stateDir(args.flags));
  out({ pending: result.pending.pendingId, attribution: result.pending.attribution, adjustments: result.adjustments, ledger: ledger.summary() });
}

function commandPropose(args) {
  const ledger = loadLedger(args.flags);
  const fresh = ledger.proposeRouteChanges();
  ledger.save(stateDir(args.flags));
  out({
    proposals: ledger.proposals.map((item) => ({
      proposalId: item.proposalId,
      change: item.change,
      rationale: item.rationale,
      supportingPendingIds: item.supportingPendingIds,
      status: item.status
    })),
    fresh: fresh.map((item) => item.proposalId)
  });
}

function commandApply(args) {
  const ledger = loadLedger(args.flags);
  const result = ledger.applyRouteChange(String(args.flags.proposal || ''), { by: 'human' });
  ledger.save(stateDir(args.flags));
  out({ applied: result.applied, route: result.route || ledger.route, reason: result.reason || null, ledger: ledger.summary() });
}

function commandAudit(args) {
  const ledger = loadLedger(args.flags);
  out({
    ledger: ledger.summary(),
    pendingDetail: ledger.pending.map((item) => ({ pendingId: item.pendingId, state: item.state, layer: item.attribution ? item.attribution.layer : null })),
    proposals: ledger.proposals.map((item) => ({ proposalId: item.proposalId, status: item.status }))
  });
}

const COMMANDS = {
  run: commandRun,
  feedback: commandFeedback,
  pending: commandPending,
  attribute: commandAttribute,
  propose: commandPropose,
  apply: commandApply,
  audit: commandAudit
};

function main(argv) {
  const args = parseArgs(argv);
  const name = args.positional[0];
  // 兼容旧用法：第一个位置参数是文件路径时就当 run
  const isLegacy = name && !COMMANDS[name];
  const commandName = isLegacy ? 'run' : name || 'run';
  const rest = isLegacy ? args.positional : args.positional.slice(1);
  const command = COMMANDS[commandName];
  if (!command) {
    console.error('未知命令：' + commandName + '，可用：' + Object.keys(COMMANDS).join(' / '));
    process.exitCode = 1;
    return;
  }
  command({ positional: rest, flags: args.flags });
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { main, parseArgs, COMMANDS };
