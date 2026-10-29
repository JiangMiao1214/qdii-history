'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {buildLedger} = require('../site/ledger-model.js');

const row = (id, quota, approvedDate = '2021-01-01', category = '银行类') => ({id, name: id, quota, approvedDate, category});
const report = (date, rows) => ({date, month: date.slice(0, 7), pdfUrl: `https://www.safe.gov.cn/${date}.pdf`, institutions: rows});
const data = reports => ({meta: {rangeStart: reports[0].month, rangeEnd: reports.at(-1).month}, reports});

test('first snapshots and newly observed institutions are baselines, not approvals', () => {
  const result = buildLedger(data([
    report('2021-11-30', [row('A', 100)]),
    report('2021-12-15', [row('A', 100), row('B', 8, '2021-12-10')])
  ]));
  assert.equal(result.summary.positiveTotal, 0);
  assert.equal(result.summary.increaseCount, 0);
  assert.equal(result.summary.appearanceTotal, 8);
  assert.equal(result.summary.endpointNetChange, 8);
  assert.deepEqual(result.quality.map(item => item.problem), ['首次观察']);
});

test('date-only changes and decreases remain separate from positive changes', () => {
  const result = buildLedger(data([
    report('2024-01-31', [row('A', 10), row('B', 10)]),
    report('2024-02-29', [row('A', 10, '2024-02-20'), row('B', 7)]),
    report('2024-03-31', [row('A', 12, '2024-03-20'), row('B', 7)])
  ]));
  assert.deepEqual(result.events.map(event => event.type), ['dateOnly', 'decrease', 'increase']);
  assert.equal(result.summary.increaseCount, 1);
  assert.equal(result.summary.positiveTotal, 2);
  assert.equal(result.summary.decreaseTotal, 3);
  assert.equal(result.annual[0].dateOnlyCount, 1);
  assert.equal(result.summary.endpointNetChange, -1);
});

test('whole-report gaps are identified and differences use detection year', () => {
  const result = buildLedger(data([
    report('2021-12-15', [row('A', 10)]),
    report('2022-03-31', [row('A', 12, '2021-12-20')])
  ]));
  assert.deepEqual(result.summary.missingMonths, ['2022-01', '2022-02']);
  assert.equal(result.events[0].gapMonths, 2);
  assert.equal(result.annual.find(year => year.year === '2021').positiveTotal, 0);
  assert.equal(result.annual.find(year => year.year === '2022').positiveTotal, 2);
  assert.equal(result.annual.find(year => year.year === '2022').gapCount, 1);
});

test('disappearance, reappearance and new names do not become false increases', () => {
  const result = buildLedger(data([
    report('2024-01-31', [row('A', 10), row('Old name', 3)]),
    report('2024-02-29', [row('New name', 3)]),
    report('2024-03-31', [row('A', 30), row('New name', 4, '2024-03-20')])
  ]));
  assert.equal(result.summary.positiveTotal, 1);
  assert.equal(result.summary.increaseCount, 1);
  assert(result.quality.some(item => item.id === 'A' && item.problem === '重新出现'));
  assert.equal(result.institutions.find(item => item.id === 'Old name').currentQuota, null);
  assert.equal(result.institutions.find(item => item.id === 'A').baselineQuota, 10);
  assert.equal(result.summary.endpointNetChange,
    result.summary.positiveTotal - result.summary.decreaseTotal + result.summary.appearanceTotal - result.summary.disappearanceTotal);
});

test('new range resets the baseline and category transfers are membership boundaries', () => {
  const input = data([
    report('2024-01-31', [row('A', 1), row('B', 3, '2021-01-01', '保险类')]),
    report('2024-02-29', [row('A', 5), row('B', 3, '2021-01-01', '银行类')]),
    report('2024-03-31', [row('A', 6), row('B', 3, '2021-01-01', '银行类')])
  ]);
  const narrowed = buildLedger(input, {startMonth: '2024-02', endMonth: '2024-03'});
  assert.equal(narrowed.summary.positiveTotal, 1);
  assert.equal(narrowed.institutions.find(item => item.id === 'A').baselineQuota, 5);
  const filtered = buildLedger(input, {category: '银行类'});
  assert.equal(filtered.summary.positiveTotal, 5);
  assert.equal(filtered.summary.appearanceTotal, 3);
  assert.equal(filtered.summary.endpointNetChange, 8);
  assert(filtered.quality.some(item => item.problem === '进入所选类别'));
  assert.equal(buildLedger(input, {category: '信托类'}).summary.institutionCount, 0);
});

test('small decimal changes are accumulated with exact hundredths', () => {
  const result = buildLedger(data([
    report('2024-01-31', [row('A', .1)]),
    report('2024-02-29', [row('A', .2)]),
    report('2024-03-31', [row('A', .3)])
  ]));
  assert.equal(result.summary.positiveTotal, .2);
  assert.equal(result.institutions[0].positiveTotal, .2);
  assert.equal(result.summary.endpointNetChange, .2);
});

test('unchanged approval dates and backward dates receive explicit flags', () => {
  const result = buildLedger(data([
    report('2024-01-31', [row('A', 1, '2023-10-01')]),
    report('2024-02-29', [row('A', 2, '2023-10-01')]),
    report('2024-03-31', [row('A', 2, '2023-09-01')])
  ]));
  assert(result.events[0].flags.includes('额度增加但批准日期未变'));
  assert(result.events[0].flags.includes('批准日期不在观察区间'));
  assert(result.events[1].flags.includes('批准日期回退'));
  assert.equal(result.summary.increaseCount, 1);
});

test('browser API exposes the same build function without dependencies', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../site/ledger-model.js'), 'utf8'), context);
  assert.equal(typeof context.QDIILedger.buildLedger, 'function');
  assert.equal(context.QDIILedger.buildLedger({reports: []}).summary.reportCount, 0);
});

test('verified seed archive reconciles institution movements with national change', () => {
  const input = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/qdii.json'), 'utf8'));
  const result = buildLedger(input);
  // Use the fixed historical window so future monthly updates do not invalidate this regression.
  const seed = buildLedger(input, {startMonth: '2021-10', endMonth: '2026-09'});
  assert.equal(seed.summary.reportCount, 57);
  assert.equal(seed.summary.increaseCount, 367);
  assert.equal(seed.summary.positiveTotal, 286.64);
  assert.equal(seed.summary.decreaseTotal, 19.34);
  assert.equal(seed.summary.appearanceTotal, 220.4);
  assert.equal(seed.summary.disappearanceTotal, 197.8);
  assert.equal(seed.summary.endpointNetChange, 289.9);
  assert.equal(Math.round((result.summary.positiveTotal - result.summary.decreaseTotal + result.summary.appearanceTotal - result.summary.disappearanceTotal) * 100), Math.round(result.summary.endpointNetChange * 100));
  assert.equal(result.institutions.reduce((count, item) => count + item.increaseCount, 0), result.summary.increaseCount);
  assert.equal(Math.round(result.annual.reduce((sum, year) => sum + year.positiveTotal, 0) * 100), Math.round(result.summary.positiveTotal * 100));
});
