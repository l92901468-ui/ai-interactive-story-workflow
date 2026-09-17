#!/usr/bin/env node
// 发布门禁。
//
// 关键点：这里直接复用 src/health.js 的 evaluate()，而不是另写一套阈值。
// 门禁判据必须和运行期判据是同一个，否则会出现「门禁过了但线上不健康」。

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { collectHealth, evaluate, DEFAULT_THRESHOLDS } = require('../src/health');

const ROOT = path.resolve(__dirname, '..');
const REPORTS = path.join(ROOT, 'cd', 'reports');

function parseArgs(argv) {
  const parsed = { times: 1, intervalMs: 0, overrides: {} };
  for (const token of argv) {
    if (token.indexOf('--image=') === 0) parsed.image = token.slice('--image='.length);
    else if (token.indexOf('--project=') === 0) parsed.project = token.slice('--project='.length);
    else if (token.indexOf('--env=') === 0) parsed.env = token.slice('--env='.length);
    else if (token.indexOf('--times=') === 0) parsed.times = Number(token.slice('--times='.length));
    else if (token.indexOf('--interval=') === 0) parsed.intervalMs = Number(token.slice('--interval='.length));
    else if (token.indexOf('--max-awaiting=') === 0) parsed.overrides.maxAwaitingAttribution = Number(token.slice('--max-awaiting='.length));
    else if (token.indexOf('--max-age=') === 0) parsed.overrides.maxOldestPendingAgeSec = Number(token.slice('--max-age='.length));
  }
  return parsed;
}

// 在镜像里跑一次：先跑生成，再取健康指标。容器是 --rm 的，不留存状态。
function sampleFromImage(image, project) {
  const command = 'node src/cli.js run ' + project + ' > /dev/null && node src/cli.js health --project=' + project;
  const stdout = execFileSync('docker', ['run', '--rm', image, 'sh', '-c', command], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  const start = stdout.indexOf('{');
  if (start === -1) throw new Error('镜像内 health 没有输出 JSON');
  return JSON.parse(stdout.slice(start));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.image) {
    console.error('用法: node cd/health_gate.js --image=<image:tag> --project=<input.json> [--env=staging] [--times=3]');
    process.exitCode = 1;
    return;
  }
  const project = args.project || 'examples/input/synthetic-story.json';
  const env = args.env || 'staging';

  const samples = [];
  let healthy = true;
  let lastVerdict = null;

  for (let index = 0; index < args.times; index += 1) {
    const payload = sampleFromImage(args.image, project);
    const health = collectHealth({
      ledger: { projectId: payload.health.projectId, version: payload.health.learningVersion, pending: [], proposals: [], route: payload.health.route.agents, routeHistory: [] },
      knowledgeBase: null,
      result: payload.health.lastRun
        ? { receipt: { status: payload.health.lastRun.status, noRegressionPassed: payload.health.lastRun.noRegressionPassed, evidenceState: payload.health.lastRun.evidenceState, awaitingHuman: payload.health.lastRun.awaitingHuman } }
        : null
    });
    // 用镜像里真实统计到的积压数覆盖（上面只是占位 ledger）
    health.pending = payload.health.pending;
    health.proposals = payload.health.proposals;
    health.knowledge = payload.health.knowledge;
    if (payload.health.lastRun) health.lastRun = payload.health.lastRun;

    const verdict = evaluate(health, args.overrides);
    lastVerdict = verdict;
    samples.push({ index: index + 1, healthy: verdict.healthy, breaches: verdict.breaches, health: health });
    if (!verdict.healthy) healthy = false;
    console.log('  第 ' + (index + 1) + '/' + args.times + ' 次：' + (verdict.healthy ? '健康' : '不健康 ' + JSON.stringify(verdict.breaches)));
    if (!healthy) break;
    if (args.intervalMs && index < args.times - 1) {
      const until = Date.now() + args.intervalMs;
      while (Date.now() < until) { /* 简单等待 */ }
    }
  }

  fs.mkdirSync(REPORTS, { recursive: true });
  const reportPath = path.join(REPORTS, 'gate-' + env + '-' + Date.now() + '.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    env: env,
    image: args.image,
    times: args.times,
    thresholds: Object.assign({}, DEFAULT_THRESHOLDS, args.overrides),
    healthy: healthy,
    verdict: lastVerdict,
    samples: samples
  }, null, 2) + '\n', 'utf8');

  console.log('门禁结果(' + env + ')：' + (healthy ? '通过' : '未通过') + ' | 报告: ' + reportPath);
  process.exitCode = healthy ? 0 : 1;
}

if (require.main === module) main();

module.exports = { parseArgs: parseArgs, sampleFromImage: sampleFromImage };
