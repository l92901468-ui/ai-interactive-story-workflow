const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runWorkflow } = require('../src/workflow');

function fixture(name) {
  const file = path.join(__dirname, '..', 'examples', 'input', name);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('synthetic story passes graph, failure, and variable quality gates', () => {
  const result = runWorkflow(fixture('synthetic-story.json'));
  assert.equal(result.snapshot.validation.quality.status, 'passed');
  assert.deepEqual(result.snapshot.validation.graph.issues, []);
  assert.deepEqual(result.snapshot.validation.variables.issues, []);
  assert.ok(result.receipt.selectedEvidenceIds.includes('EV-CANON-001'));
  assert.equal(result.receipt.uncertaintyCount, 1);
});

test('broken fixture exposes bad cases and triggers automatic review', () => {
  const result = runWorkflow(fixture('synthetic-badcase.json'));
  const graphCodes = result.snapshot.validation.graph.issues.map((item) => item.code);
  const variableCodes = result.snapshot.validation.variables.issues.map((item) => item.code);
  assert.equal(result.snapshot.validation.quality.status, 'failed');
  assert.equal(result.snapshot.validation.quality.autoReview.triggered, true);
  assert.ok(graphCodes.includes('DANGLING_EDGE'));
  assert.ok(graphCodes.includes('CHOICE_FAILURE_COVERAGE'));
  assert.ok(graphCodes.includes('UNREACHABLE_NODE'));
  assert.ok(variableCodes.includes('VARIABLE_LIFECYCLE_INCOMPLETE'));
  assert.ok(result.snapshot.validation.quality.autoReview.repairPlan.length >= 3);
});

test('receipt and snapshot hashes are stable for deterministic synthetic input', () => {
  const input = fixture('synthetic-story.json');
  const first = runWorkflow(input);
  const second = runWorkflow(input);
  assert.equal(first.snapshot.snapshotHash, second.snapshot.snapshotHash);
  assert.equal(first.receipt.receiptHash, second.receipt.receiptHash);
  assert.match(first.snapshot.snapshotHash, /^[a-f0-9]{64}$/);
  assert.match(first.receipt.receiptHash, /^[a-f0-9]{64}$/);
});

test('public workflow rejects inputs not explicitly marked synthetic', () => {
  const input = fixture('synthetic-story.json');
  input.metadata.synthetic = false;
  assert.throws(() => runWorkflow(input), /synthetic=true/);
});
