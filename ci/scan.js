#!/usr/bin/env node
// 扫描与门禁。
//
// 真做的：语法编译、敏感信息、静态规则（禁止联网调用、禁止硬编码密钥）、依赖成分。
// 模拟的：镜像漏洞扫描（本机没有 trivy/漏洞库），明确标注 [模拟]，结论不可信。
//
// 用法：node ci/scan.js [--image=name:tag] [--json]

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sha256 } = require('../src/hash');

const ROOT = path.resolve(__dirname, '..');
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const GATE = { maxCritical: 0, maxHigh: 3 };
const IGNORE = ['node_modules', '.git', 'state', 'private', 'coverage', 'dist', 'showcase'];

function collectFiles(dir, extensions, ignore) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(ROOT, full);
    if (ignore.some((rule) => relative === rule || relative.startsWith(rule + path.sep))) continue;
    if (entry.isDirectory()) {
      found.push.apply(found, collectFiles(full, extensions, ignore));
      continue;
    }
    if (extensions.some((ext) => entry.name.endsWith(ext))) found.push(relative);
  }
  return found;
}

function sourceFiles() {
  return collectFiles(ROOT, ['.js'], IGNORE);
}

function textFiles() {
  return collectFiles(ROOT, ['.js', '.json', '.md', '.yml', '.yaml', '.sh'], IGNORE.concat(['package-lock.json']));
}

// ---- 1. 语法扫描（真） ----
function scanSyntax() {
  const findings = [];
  for (const file of sourceFiles()) {
    try {
      execFileSync('node', ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
    } catch (error) {
      findings.push({
        id: 'SYNTAX',
        severity: 'CRITICAL',
        target: file,
        detail: String(error.stderr || error.message).split('\n').slice(0, 3).join(' ').trim(),
        simulated: false
      });
    }
  }
  return findings;
}

// ---- 2. 敏感信息扫描（真） ----
const SECRET_PATTERNS = [
  { id: 'SECRET_VOLC_AK', severity: 'CRITICAL', pattern: /VOLC_(AK|SK)\s*[:=]\s*["'][A-Za-z0-9_-]{8,}["']/ },
  { id: 'SECRET_PRIVATE_KEY', severity: 'CRITICAL', pattern: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
  { id: 'SECRET_GENERIC_TOKEN', severity: 'HIGH', pattern: /(api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/i }
];

function scanSecrets() {
  const findings = [];
  for (const file of textFiles()) {
    const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
    content.split('\n').forEach((line, index) => {
      if (line.indexOf('nosec') !== -1) return;
      for (const rule of SECRET_PATTERNS) {
        if (rule.pattern.test(line)) {
          findings.push({ id: rule.id, severity: rule.severity, target: file, detail: '第 ' + (index + 1) + ' 行', simulated: false });
        }
      }
    });
  }
  return findings;
}

// ---- 3. 静态规则扫描（真） ----
// 本项目对外承诺「运行时不联网、不调用在线模型」，所以联网调用算违规。
const STATIC_RULES = [
  {
    id: 'RULE_NO_NETWORK',
    severity: 'HIGH',
    pattern: /require\(["'](https?|node:https?)["']\)/,
    message: '运行时不得联网，本项目承诺只使用 Node.js 内置模块且不调用在线服务'
  },
  {
    id: 'RULE_NO_FETCH',
    severity: 'HIGH',
    pattern: /\bfetch\s*\(/,
    message: '不得发起网络请求；模型调用请走 src/llm-mock.js 的确定性替代'
  },
  {
    id: 'RULE_NO_CHILD_PROCESS',
    severity: 'MEDIUM',
    pattern: /\b(exec|execSync|spawn)\s*\(/,
    message: '避免执行外部命令，降低运行期不确定性'
  }
];

function scanStaticRules() {
  const findings = [];
  for (const file of sourceFiles()) {
    const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
    content.split('\n').forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || line.indexOf('nosec') !== -1) return;
      for (const rule of STATIC_RULES) {
        if (rule.pattern.test(line)) {
          findings.push({ id: rule.id, severity: rule.severity, target: file, detail: '第 ' + (index + 1) + ' 行：' + rule.message, simulated: false });
        }
      }
    });
  }
  return findings;
}

// ---- 4. 依赖成分扫描（真；本项目零依赖所以必然为空） ----
function scanDependencies() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies || {});
  return {
    dependencies: deps,
    findings: deps.length
      ? [{ id: 'SCA_DEPENDENCY', severity: 'LOW', target: 'package.json', detail: '存在第三方依赖：' + deps.join(', '), simulated: false }]
      : []
  };
}

// ---- 5. 镜像漏洞扫描（模拟） ----
function scanImage(image) {
  if (!image) return [];
  const digest = sha256(image).slice(0, 12);
  return [
    { id: 'CVE-2025-0001-sim', severity: 'MEDIUM', target: 'image:' + image + ':' + digest, detail: 'node:22-slim 基础镜像中的 zlib（模拟条目）', simulated: true },
    { id: 'CVE-2025-0002-sim', severity: 'LOW', target: 'image:' + image + ':' + digest, detail: 'node:22-slim 基础镜像中的 glibc（模拟条目）', simulated: true }
  ];
}

function main() {
  const args = process.argv.slice(2);
  const imageFlag = args.find((item) => item.indexOf('--image=') === 0);
  const image = imageFlag ? imageFlag.slice('--image='.length) : null;
  const asJson = args.indexOf('--json') !== -1;

  const sections = [
    { name: '语法扫描', findings: scanSyntax() },
    { name: '敏感信息扫描', findings: scanSecrets() },
    { name: '静态规则扫描', findings: scanStaticRules() },
    { name: '依赖成分扫描', findings: scanDependencies().findings },
    { name: '镜像漏洞扫描（模拟）', findings: scanImage(image) }
  ];

  const all = sections.reduce((sum, section) => sum.concat(section.findings), []);
  const counts = {};
  for (const level of SEVERITIES) counts[level] = all.filter((item) => item.severity === level).length;
  const passed = counts.CRITICAL <= GATE.maxCritical && counts.HIGH <= GATE.maxHigh;

  if (asJson) {
    process.stdout.write(JSON.stringify({
      scannedAt: new Date().toISOString(),
      image: image,
      sections: sections.map((section) => ({ name: section.name, count: section.findings.length })),
      counts: counts,
      gate: GATE,
      passed: passed,
      findings: all
    }, null, 2) + '\n');
    process.exitCode = passed ? 0 : 1;
    return;
  }

  process.stdout.write('=== 扫描明细 ===\n');
  for (const section of sections) {
    process.stdout.write('  ' + section.name + '：发现 ' + section.findings.length + ' 条\n');
  }
  process.stdout.write('\n=== 问题清单 ===\n');
  if (!all.length) {
    process.stdout.write('  （无）\n');
  } else {
    for (const item of all) {
      process.stdout.write('  [' + item.severity + (item.simulated ? ' 模拟' : '') + '] ' + item.id + ' ' + item.target + '：' + item.detail + '\n');
    }
  }
  process.stdout.write('\n=== 门禁 ===\n');
  process.stdout.write('  CRITICAL=' + counts.CRITICAL + '(上限' + GATE.maxCritical + ')  HIGH=' + counts.HIGH + '(上限' + GATE.maxHigh + ')\n');
  process.stdout.write('  结果：' + (passed ? 'PASSED' : 'BLOCKED') + '\n');
  process.exitCode = passed ? 0 : 1;
}

if (require.main === module) main();

module.exports = { scanSyntax: scanSyntax, scanSecrets: scanSecrets, scanStaticRules: scanStaticRules, scanDependencies: scanDependencies, scanImage: scanImage, GATE: GATE, SEVERITIES: SEVERITIES };
