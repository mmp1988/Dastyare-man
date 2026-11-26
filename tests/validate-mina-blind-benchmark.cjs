const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const benchmarkPath = path.join(__dirname, 'fixtures', 'mina-blind-conversations.json');
const benchmark = JSON.parse(fs.readFileSync(benchmarkPath, 'utf8'));
assert.equal(benchmark.blind, true, 'Benchmark must be marked blind');
assert.equal(benchmark.language, 'fa-IR', 'Benchmark language must be Persian');
assert.ok(benchmark.cases.length >= 50, 'At least 50 unseen Persian cases are required');
assert.equal(benchmark.caseCount, benchmark.cases.length, 'Declared case count must match the fixture');

const ids = new Set();
const utterances = new Set();
const categories = new Map();
for (const item of benchmark.cases) {
  assert.ok(item.id && !ids.has(item.id), 'Every case needs a unique id');
  ids.add(item.id);
  assert.ok(Array.isArray(item.conversation) && item.conversation.length > 0, item.id + ': conversation is missing');
  assert.ok(item.conversation.every(turn => ['user','assistant'].includes(turn.role) && typeof turn.text === 'string' && turn.text.trim()), item.id + ': invalid conversation turn');
  assert.ok(item.expected && item.expected.goal && item.expected.operation, item.id + ': expected outcome is incomplete');
  assert.equal(item.isolation?.synthetic_data_only, true, item.id + ': test data must be synthetic');
  assert.equal(item.isolation?.allow_production_mutation, false, item.id + ': production mutations must be disabled');
  const key = item.conversation.map(turn => turn.role + ':' + turn.text.trim()).join('|');
  assert.ok(!utterances.has(key), item.id + ': duplicate conversation');
  utterances.add(key);
  categories.set(item.category, (categories.get(item.category) || 0) + 1);
}
assert.equal(categories.size, 6, 'Expected six distinct capability groups');
for (const [category, count] of categories) assert.ok(count >= 8, category + ': too few cases');
console.log('Blind Persian benchmark fixture: PASS', JSON.stringify({
  cases: benchmark.cases.length,
  categories: Object.fromEntries(categories),
  scorePerCase: benchmark.scoringTotal,
  maximumScore: benchmark.cases.length * benchmark.scoringTotal
}));
