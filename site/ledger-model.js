/* Snapshot differences describe observed quota changes, not approval decisions. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QDIILedger = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const cents = value => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || !Number.isSafeInteger(Math.round(number * 100))) {
      throw new TypeError('Invalid quota value');
    }
    return Math.round(number * 100);
  };
  const amount = value => value / 100;
  const monthIndex = value => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
  function monthList(start, end) {
    if (!start || !end) return [];
    const result = [];
    for (let index = monthIndex(start); index <= monthIndex(end); index++) {
      result.push(`${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`);
    }
    return result;
  }

  /**
   * Range endpoints are months. The first available selected report is a baseline.
   * Category filters compare membership in that category in each report; crossing
   * its boundary is an appearance/disappearance, not an inferred quota increase.
   * Annual values use the detection report's cutoff year, not approval dates.
   * Decrease/disappearance totals are positive magnitudes. All arithmetic is in
   * integer hundredths of USD 100 million before converting output values.
   */
  function buildLedger(data, options = {}) {
    const all = (data?.reports || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    let start = options.startMonth || data?.meta?.rangeStart || all[0]?.month;
    let end = options.endMonth || data?.meta?.rangeEnd || all.at(-1)?.month;
    if (start && end && start > end) [start, end] = [end, start];
    const category = options.category || 'all';
    const accepts = row => category === 'all' || row.category === category;
    const reports = all.filter(report => report.month >= start && report.month <= end);
    const expected = monthList(start, end);
    const available = new Set(reports.map(report => report.month));
    const missingMonths = expected.filter(month => !available.has(month));
    const annualMap = new Map();
    for (const month of expected) {
      const year = month.slice(0, 4);
      if (!annualMap.has(year)) annualMap.set(year, {
        year, positiveTotal: 0, increaseCount: 0, decreaseTotal: 0,
        dateOnlyCount: 0, reportCount: 0, expectedMonths: 0, gapCount: 0
      });
      annualMap.get(year).expectedMonths++;
    }
    const institutions = new Map(), seen = new Set(), events = [], quality = [];
    let positive = 0, decrease = 0, appearances = 0, disappearances = 0;
    const rowMaps = reports.map(report => new Map(report.institutions.filter(accepts).map(row => [row.id, row])));
    const globalMaps = reports.map(report => new Map(report.institutions.map(row => [row.id, row])));
    const total = rows => [...rows.values()].reduce((sum, row) => sum + cents(row.quota), 0);

    function addQuality(row, previous, before, report, problem, detail, delta = null) {
      quality.push({
        id: row.id, name: row.name, category: row.category,
        fromDate: before?.date || null, toDate: report.date,
        previous: previous == null ? null : amount(cents(previous.quota)),
        current: rowMaps[reports.indexOf(report)].has(row.id) ? amount(cents(row.quota)) : null,
        delta, problem, detail,
        fromPdfUrl: before?.pdfUrl || null, toPdfUrl: report.pdfUrl
      });
    }

    reports.forEach((report, reportIndex) => {
      const currentMap = rowMaps[reportIndex];
      const previousReport = reports[reportIndex - 1];
      const previousMap = rowMaps[reportIndex - 1];
      const year = annualMap.get(report.month.slice(0, 4));
      year.reportCount++;
      const gapMonths = previousReport ? Math.max(0, monthIndex(report.month) - monthIndex(previousReport.month) - 1) : 0;
      if (gapMonths) year.gapCount++;

      for (const row of currentMap.values()) {
        let institution = institutions.get(row.id);
        if (!institution) {
          institution = {
            id: row.id, name: row.name, category: row.category,
            baselineDate: report.date, baselineQuota: amount(cents(row.quota)),
            lastDate: report.date, lastQuota: amount(cents(row.quota)), currentQuota: null,
            latestApprovedDate: row.approvedDate,
            positiveTotal: 0, increaseCount: 0, firstIncreaseDate: null, lastIncreaseDate: null,
            qualityCount: 0, events: [], snapshots: []
          };
          institutions.set(row.id, institution);
        }
        institution.name = row.name;
        institution.category = row.category;
        institution.lastDate = report.date;
        institution.lastQuota = amount(cents(row.quota));
        institution.latestApprovedDate = row.approvedDate;
        institution.snapshots.push({date: report.date, quota: amount(cents(row.quota)), approvedDate: row.approvedDate, pdfUrl: report.pdfUrl, category: row.category});
        if (reportIndex === reports.length - 1) institution.currentQuota = amount(cents(row.quota));
        if (!previousReport) continue;

        const previous = previousMap.get(row.id);
        if (!previous) {
          appearances += cents(row.quota);
          const movedCategory = globalMaps[reportIndex - 1].has(row.id);
          const returning = seen.has(row.id);
          addQuality(row, null, previousReport, report,
            movedCategory ? '进入所选类别' : returning ? '重新出现' : '首次观察',
            movedCategory ? '上期已列示于其他类别，本期进入所选类别；按类别边界记录，不计正向变动。' :
              returning ? '机构在前一可用报告中未列示，本次重新建立观察基线，不跨缺席记录推算额度变化。' :
                '此前可用快照未找到同名机构。本期额度作为观察基线，不等于本期新批额度；也可能涉及更名或承接。');
          continue;
        }

        const deltaCents = cents(row.quota) - cents(previous.quota);
        const dateChanged = row.approvedDate !== previous.approvedDate;
        const categoryChanged = row.category !== previous.category;
        if (!deltaCents && !dateChanged) {
          if (categoryChanged) addQuality(row, previous, previousReport, report, '类别变化', '同名机构类别发生变化，额度未变；不计正向变动。', 0);
          continue;
        }
        const type = deltaCents > 0 ? 'increase' : deltaCents < 0 ? 'decrease' : 'dateOnly';
        const flags = [];
        const details = [];
        if (gapMonths) {
          flags.push(`跨缺档 ${gapMonths} 个月`);
          details.push('此差额覆盖缺档区间，不能拆分到缺失月份，也不能据此确定实际获批次数。');
        }
        if (deltaCents > 0 && !dateChanged) {
          flags.push('额度增加但批准日期未变');
          details.push('额度增加但原表最新批准日期未变，可能涉及调整、承接或修订，不能直接认定新获批。');
        }
        if (deltaCents < 0) {
          flags.push('额度减少');
          details.push('仅确认累计额度下降；不直接推断撤销、额度使用或资金流出。');
        }
        if (type === 'dateOnly') {
          flags.push('仅批准日期变化');
          details.push('累计额度未变，仅原表批准日期变化；不计入正向变动金额或次数。');
        }
        if (row.approvedDate < previous.approvedDate) {
          flags.push('批准日期回退');
          details.push('原表最新批准日期早于上一快照，需结合两份原件解释。');
        }
        if (row.approvedDate > report.date) {
          flags.push('批准日期晚于报告截至日');
          details.push('批准日期晚于本期报告截至日，需复核原表日期。');
        } else if (deltaCents > 0 && row.approvedDate <= previousReport.date) {
          flags.push('批准日期不在观察区间');
          details.push('批准日期早于或等于上一快照截至日，不能将该差额归为这一日期的新获批金额。');
        }
        if (categoryChanged) {
          flags.push('类别变化');
          details.push('同名机构类别在两份报告间变化，请结合原表理解。');
        }
        const event = {
          id: row.id, name: row.name, category: row.category, type,
          fromDate: previousReport.date, toDate: report.date,
          previous: amount(cents(previous.quota)), current: amount(cents(row.quota)), delta: amount(deltaCents),
          previousApprovedDate: previous.approvedDate, approvedDate: row.approvedDate,
          gapMonths, flags, fromPdfUrl: previousReport.pdfUrl, toPdfUrl: report.pdfUrl
        };
        events.push(event);
        institution.events.push(event);
        flags.forEach((flag, index) => addQuality(row, previous, previousReport, report, flag, details[index], event.delta));
        if (type === 'increase') {
          positive += deltaCents;
          year.positiveTotal += deltaCents;
          year.increaseCount++;
          institution.positiveTotal += deltaCents;
          institution.increaseCount++;
          institution.firstIncreaseDate ||= report.date;
          institution.lastIncreaseDate = report.date;
        } else if (type === 'decrease') {
          decrease -= deltaCents;
          year.decreaseTotal -= deltaCents;
        } else year.dateOnlyCount++;
      }

      if (previousMap) {
        for (const previous of previousMap.values()) {
          if (currentMap.has(previous.id)) continue;
          disappearances += cents(previous.quota);
          const movedCategory = globalMaps[reportIndex].has(previous.id);
          addQuality(previous, previous, previousReport, report,
            movedCategory ? '退出所选类别' : '本期未列示',
            movedCategory ? '本期仍在全国报告中，但归属其他类别；类别名单退出不等于额度减少或撤销。' :
              '前一期有同名记录，本期未列示；可能涉及更名或承接，不将其额度自动计为撤销。');
        }
      }
      for (const id of currentMap.keys()) seen.add(id);
    });

    const qualityCounts = new Map();
    quality.forEach(item => qualityCounts.set(item.id, (qualityCounts.get(item.id) || 0) + 1));
    for (const institution of institutions.values()) {
      institution.positiveTotal = amount(institution.positiveTotal);
      institution.qualityCount = qualityCounts.get(institution.id) || 0;
    }
    const annual = [...annualMap.values()].map(year => ({...year,
      positiveTotal: amount(year.positiveTotal), decreaseTotal: amount(year.decreaseTotal)
    }));
    return {
      reports, startDate: reports[0]?.date || null, endDate: reports.at(-1)?.date || null,
      institutions: [...institutions.values()], events, quality, annual,
      summary: {
        institutionCount: institutions.size, increaseCount: events.filter(event => event.type === 'increase').length,
        positiveTotal: amount(positive), decreaseTotal: amount(decrease),
        appearanceTotal: amount(appearances), disappearanceTotal: amount(disappearances),
        endpointNetChange: reports.length ? amount(total(rowMaps.at(-1)) - total(rowMaps[0])) : 0,
        qualityCount: quality.length, reportCount: reports.length, missingMonths
      }
    };
  }
  return {buildLedger};
});
