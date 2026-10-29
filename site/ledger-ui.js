(() => {
  'use strict';
  const data = window.QDII_DATA;
  if (!data?.reports?.length || !window.QDIILedger) return;
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = value => value == null ? '—' : Number(value).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  const sign = value => `${value > 0 ? '+' : ''}${fmt(value)}`;
  const typeName = {increase:'额度增加', decrease:'额度减少', dateOnly:'仅批准日期变化'};
  const months = [];
  let [year, month] = data.meta.rangeStart.split('-').map(Number);
  while (`${year}-${String(month).padStart(2, '0')}` <= data.meta.rangeEnd) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    if (++month > 12) {month = 1; year++;}
  }
  const options = (values, selected) => values.map(value => `<option value="${escape(value)}"${value === selected ? ' selected' : ''}>${escape(value)}</option>`).join('');
  $('ledger-start').innerHTML = options(months, months[0]);
  $('ledger-end').innerHTML = options(months, months.at(-1));
  let ledger, page = 1, qualityPage = 1, expanded = new Set();
  const pageSize = 12, qualityPageSize = 15;

  function sourceLinks(before, after) {
    const link = (url, label) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || !['www.safe.gov.cn','m.safe.gov.cn'].includes(parsed.hostname)) return '';
        return `<a href="${escape(url)}" target="_blank" rel="noopener">${label} ↗</a>`;
      } catch {return '';}
    };
    return `<span class="ledger-source-links">${link(before, '前期 PDF')}${link(after, '本期 PDF')}</span>`;
  }
  function hasYear(event) {return $('ledger-year').value === 'all' || event.toDate.startsWith($('ledger-year').value);}
  function hasName(item) {return item.name.toLocaleLowerCase().includes($('ledger-search').value.trim().toLocaleLowerCase());}
  function visibleEvents(institution) {return institution.events.filter(hasYear);}
  function centsSum(items, field) {return items.reduce((sum, item) => sum + Math.round(item[field] * 100), 0) / 100;}

  function institutions() {
    return ledger.institutions.filter(hasName).map(item => {
      const events = visibleEvents(item), increases = events.filter(event => event.type === 'increase');
      const observations = item.snapshots.filter(snapshot => $('ledger-year').value === 'all' || snapshot.date.startsWith($('ledger-year').value));
      return {...item, displayedEvents:events, visibleCount:increases.length, visibleTotal:centsSum(increases, 'delta'),
        visibleFirst:increases[0]?.toDate, visibleLast:increases.at(-1)?.toDate, hasObservations:observations.length > 0,
        visibleQuality:ledger.quality.filter(q => q.id === item.id && hasYear(q)).length};
    }).filter(item => item.hasObservations && (!$('ledger-only').checked || item.visibleCount > 0))
      .sort((a,b) => {
        const sort = $('ledger-sort').value;
        if (sort === 'name') return a.name.localeCompare(b.name, 'zh-CN');
        const field = sort === 'positiveTotal' ? 'visibleTotal' : sort === 'increaseCount' ? 'visibleCount' : 'currentQuota';
        return (b[field] ?? -1) - (a[field] ?? -1) || a.name.localeCompare(b.name, 'zh-CN');
      });
  }

  function renderSummary() {
    const summary = ledger.summary;
    const cards = [
      ['收录历史名称', summary.institutionCount, '个', '更名分别统计，不自动合并'],
      ['正向变动次数', summary.increaseCount, '次', '一条＝同名机构一次区间差额'],
      ['正向变动合计', fmt(summary.positiveTotal), '亿美元', '不含首次收录基线'],
      ['负向变动合计', fmt(summary.decreaseTotal), '亿美元', '下降单列，不直接视为撤销']
    ];
    $('ledger-kpis').innerHTML = cards.map((card,index) => `<div class="kpi"><div class="label">${card[0]}</div><div class="number ${index === 2 ? 'positive' : index === 3 ? 'negative' : ''}">${card[1]}<small>${card[2]}</small></div><div class="subtitle">${card[3]}</div></div>`).join('');
    $('ledger-range-note').textContent = ledger.reports.length
      ? `统计快照 ${ledger.startDate} → ${ledger.endDate} · ${summary.reportCount} 期原件 · 范围内缺档 ${summary.missingMonths.length} 个月${summary.missingMonths.length ? `（${summary.missingMonths.join('、')}）` : ''}。范围内第一份报告建立基线；年份和机构搜索仅筛选下方明细。`
      : '所选范围没有可用原始快照，请调整起止月份。';
    const parts = [['正向变化', summary.positiveTotal], ['− 负向变化', summary.decreaseTotal], ['＋ 名单出现值', summary.appearanceTotal], ['− 名单未列示值', summary.disappearanceTotal], ['＝ 首末净变化', summary.endpointNetChange]];
    $('ledger-reconcile').innerHTML = parts.map(([label,value]) => `<div><span>${label} / 亿美元</span><strong>${fmt(value)}</strong></div>`).join('');
  }

  function renderAnnual() {
    const metric = $('ledger-metric').value, maximum = Math.max(...ledger.annual.map(row => row[metric]), 1);
    $('ledger-annual').innerHTML = ledger.annual.length ? ledger.annual.map(row => {
      const value = row[metric], unit = metric === 'positiveTotal' ? '亿美元' : '次';
      const selected = $('ledger-year').value === row.year;
      const coverage = row.expectedMonths < 12 ? '部分年度' : row.reportCount < 12 ? '年度有缺档' : '12 期报告';
      return `<button class="ledger-year" data-ledger-year="${escape(row.year)}" aria-pressed="${selected}" aria-label="筛选 ${row.year} 年，正向变化 ${fmt(row.positiveTotal)} 亿美元，${row.increaseCount} 次" title="${row.year} 年：${fmt(row.positiveTotal)} 亿美元 / ${row.increaseCount} 次；报告 ${row.reportCount}/${row.expectedMonths} 期；跨缺档区间 ${row.gapCount} 个"><span class="ledger-year-value">${metric === 'positiveTotal' ? fmt(value) : value}<span class="help"> ${unit}</span></span><span class="ledger-year-track"><span class="ledger-year-bar" style="height:${Math.max(1, value/maximum*100)}%"></span></span><span class="ledger-year-label">${row.year}</span><span class="ledger-year-meta">${coverage}<br>${row.reportCount}/${row.expectedMonths} 期 · ${row.increaseCount} 次</span></button>`;
    }).join('') : '<p class="ledger-empty">此范围没有可展示的年度数据</p>';
  }

  function detailRow(item, index) {
    const events = item.displayedEvents.slice().reverse();
    const rows = events.map(event => `<tr><td class="ledger-event-date">${escape(event.fromDate)}<br>→ ${escape(event.toDate)}</td><td>${escape(event.approvedDate)}<small>前次 ${escape(event.previousApprovedDate)}</small></td><td class="num ${event.delta > 0 ? 'positive' : event.delta < 0 ? 'negative' : ''}">${sign(event.delta)}<small>${typeName[event.type]}</small></td><td class="num">${fmt(event.previous)} → ${fmt(event.current)}</td><td class="ledger-flags">${event.flags.length ? event.flags.map(flag => `<span class="ledger-chip warn">${escape(flag)}</span>`).join('') : '<span class="help">相邻已归档快照差分</span>'}</td><td>${sourceLinks(event.fromPdfUrl, event.toPdfUrl)}</td></tr>`).join('');
    return `<tr class="ledger-detail-row" id="ledger-details-${index}"${expanded.has(item.id) ? '' : ' hidden'}><td colspan="7"><div class="ledger-detail-title"><div><strong>${escape(item.name)} · 变动明细</strong><p>首次收录 ${escape(item.baselineDate)}：${fmt(item.baselineQuota)} 亿美元；最近同名快照 ${escape(item.lastDate)}：${fmt(item.lastQuota)} 亿美元。</p></div><span class="tag">${events.length} 条变动记录</span></div>${events.length ? `<div class="tablewrap"><table class="ledger-detail-table"><thead><tr><th>观察区间（截至日）</th><th>原表最新批准日</th><th class="num">区间差额 / 亿美元</th><th class="num">前值 → 后值</th><th>标注</th><th>原始报告</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="ledger-empty">当前筛选内未观察到额度或批准日期变化。首次收录只建立基线，不计作新增批准。</div>'}<div class="ledger-detail-note">最新批准日可能早于观察区间；一个区间可能包含多次变化。未列示后的重新出现另建基线，不跨机构缺席期续算。</div></td></tr>`;
  }

  function renderInstitutions() {
    const list = institutions();
    page = Math.max(1, Math.min(page, Math.ceil(list.length/pageSize)));
    const chosenYear = $('ledger-year').value;
    $('ledger-table-subtitle').textContent = `${chosenYear === 'all' ? '全部观测年份' : `${chosenYear} 年检出的变动`} · ${list.length} 个历史名称 · 合计与次数跟随下方筛选，基线与末期累计额度保持所选台账范围。`;
    $('ledger-body').innerHTML = list.length ? list.slice((page-1)*pageSize, page*pageSize).map((item,index) => `<tr class="${expanded.has(item.id) ? 'is-open' : ''}"><td><button class="namebtn ledger-expand" data-ledger-id="${escape(item.id)}" aria-expanded="${expanded.has(item.id)}" aria-controls="ledger-details-${index}">${expanded.has(item.id) ? '−' : '+'} ${escape(item.name)}</button><small>${escape(item.category)}</small></td><td>${escape(item.baselineDate)}<small>${fmt(item.baselineQuota)} 亿美元</small></td><td class="num"><strong class="${item.visibleTotal > 0 ? 'positive' : ''}">${fmt(item.visibleTotal)}</strong></td><td class="num">${item.visibleCount}</td><td class="num">${fmt(item.currentQuota)}${item.currentQuota == null ? '<small>末期未列示</small>' : ''}</td><td class="latest-date">${escape(item.visibleFirst || '—')}<small>${escape(item.visibleLast || '未观察到正向变化')}</small></td><td>${item.visibleQuality ? `<span class="ledger-chip warn">${item.visibleQuality} 条标注</span>` : '<span class="ledger-chip">无额外标注</span>'}</td></tr>${detailRow(item,index)}`).join('') : '<tr><td colspan="7" class="ledger-empty">没有匹配记录。请调整机构名称、年份或“仅看有正向变动”。</td></tr>';
    $('ledger-page-info').textContent = `${list.length} 个历史名称 · 第 ${page} / ${Math.max(1,Math.ceil(list.length/pageSize))} 页 · 每页 ${pageSize} 个`;
    $('ledger-prev').disabled = page === 1;
    $('ledger-next').disabled = page*pageSize >= list.length;
  }

  function qualities() {
    return ledger.quality.filter(item => hasName(item) && hasYear(item) && ($('ledger-quality-type').value === 'all' || item.problem === $('ledger-quality-type').value))
      .sort((a,b) => b.toDate.localeCompare(a.toDate) || a.name.localeCompare(b.name,'zh-CN'));
  }
  function renderQuality() {
    const list = qualities();
    qualityPage = Math.max(1,Math.min(qualityPage,Math.ceil(list.length/qualityPageSize)));
    $('ledger-quality-count').textContent = `${list.length} 条标注`;
    $('ledger-quality-body').innerHTML = list.length ? list.slice((qualityPage-1)*qualityPageSize,qualityPage*qualityPageSize).map(item => `<tr><td class="quality-name">${escape(item.name)}<small>${escape(item.category)}</small></td><td class="ledger-event-date">${escape(item.fromDate || '—')}<br>→ ${escape(item.toDate)}</td><td><span class="ledger-chip warn">${escape(item.problem)}</span></td><td class="num">${fmt(item.previous)} → ${fmt(item.current)}</td><td class="quality-description">${escape(item.detail)}</td><td>${sourceLinks(item.fromPdfUrl,item.toPdfUrl)}</td></tr>`).join('') : '<tr><td colspan="6" class="ledger-empty">当前筛选内没有额外质量标注</td></tr>';
    $('ledger-quality-page').textContent = `第 ${qualityPage} / ${Math.max(1,Math.ceil(list.length/qualityPageSize))} 页 · 同一记录可有多个标注`;
    $('ledger-quality-prev').disabled = qualityPage === 1;
    $('ledger-quality-next').disabled = qualityPage*qualityPageSize >= list.length;
  }

  function rebuild() {
    let startMonth = $('ledger-start').value, endMonth = $('ledger-end').value;
    if (startMonth > endMonth) {
      [startMonth,endMonth] = [endMonth,startMonth];
      $('ledger-start').value = startMonth;
      $('ledger-end').value = endMonth;
    }
    ledger = window.QDIILedger.buildLedger(data,{startMonth,endMonth,category:$('ledger-category').value});
    const selectedYear = $('ledger-year').value, years = ledger.annual.map(item => item.year);
    $('ledger-year').innerHTML = '<option value="all">全部年份</option>' + options(years,selectedYear);
    if (!years.includes(selectedYear)) $('ledger-year').value = 'all';
    const selectedProblem = $('ledger-quality-type').value;
    $('ledger-quality-type').innerHTML = '<option value="all">全部标注</option>' + options([...new Set(ledger.quality.map(item => item.problem))].sort(),selectedProblem);
    page = 1; qualityPage = 1; expanded.clear();
    renderSummary(); renderAnnual(); renderInstitutions(); renderQuality();
  }
  function filterChanged() {page = 1; qualityPage = 1; expanded.clear(); renderAnnual(); renderInstitutions(); renderQuality();}
  function download(filename, headers, rows) {
    // Neutralize spreadsheet formulas when a name is opened in Excel.
    const cell = value => {const text = String(value ?? ''); return '"' + (/^[=+@\t\r]/.test(text) ? "'" + text : text).replace(/"/g,'""') + '"';};
    const blob = new Blob(['\ufeff' + [headers,...rows].map(row => row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url),1000);
    $('ledger-status').textContent = `已导出 ${rows.length} 条记录。金额为亿美元；观察截至日与原表最新批准日分别列示。`;
  }
  ['ledger-start','ledger-end','ledger-category'].forEach(id => $(id).addEventListener('change',rebuild));
  ['ledger-year','ledger-sort','ledger-only'].forEach(id => $(id).addEventListener('change',filterChanged));
  $('ledger-search').addEventListener('input',filterChanged);
  $('ledger-metric').addEventListener('change',renderAnnual);
  $('ledger-annual').addEventListener('click',event => {
    const button = event.target.closest('[data-ledger-year]'); if (!button) return;
    $('ledger-year').value = $('ledger-year').value === button.dataset.ledgerYear ? 'all' : button.dataset.ledgerYear;
    filterChanged();
  });
  $('ledger-body').addEventListener('click',event => {
    const button = event.target.closest('[data-ledger-id]'); if (!button) return;
    const id = button.dataset.ledgerId;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    button.setAttribute('aria-expanded',String(expanded.has(id)));
    button.textContent = `${expanded.has(id) ? '−' : '+'} ${ledger.institutions.find(item => item.id === id).name}`;
    $(button.getAttribute('aria-controls')).hidden = !expanded.has(id);
    button.closest('tr').classList.toggle('is-open',expanded.has(id));
  });
  $('ledger-prev').addEventListener('click',() => {page--; renderInstitutions();});
  $('ledger-next').addEventListener('click',() => {page++; renderInstitutions();});
  $('ledger-quality-prev').addEventListener('click',() => {qualityPage--; renderQuality();});
  $('ledger-quality-next').addEventListener('click',() => {qualityPage++; renderQuality();});
  $('ledger-quality-type').addEventListener('change',() => {qualityPage = 1; renderQuality();});
  $('ledger-reset').addEventListener('click',() => {
    $('ledger-start').value = months[0]; $('ledger-end').value = months.at(-1);
    $('ledger-category').value = 'all'; $('ledger-year').value = 'all'; $('ledger-sort').value = 'positiveTotal';
    $('ledger-search').value = ''; $('ledger-only').checked = false; $('ledger-quality-type').value = 'all';
    $('ledger-status').textContent = ''; rebuild();
  });
  $('ledger-export').addEventListener('click',() => {
    const events = institutions().flatMap(item => item.displayedEvents).sort((a,b) => b.toDate.localeCompare(a.toDate) || a.name.localeCompare(b.name,'zh-CN'));
    download(`QDII_变动明细_${$('ledger-start').value}_${$('ledger-end').value}.csv`,['机构名称','类别','记录类型','前期截至日','本期截至日','前期累计额度_亿美元','本期累计额度_亿美元','差额_亿美元','前期最新批准日','本期最新批准日','缺失月份数','质量标注','前期官方PDF','本期官方PDF'],events.map(item => [item.name,item.category,typeName[item.type],item.fromDate,item.toDate,item.previous,item.current,item.delta,item.previousApprovedDate,item.approvedDate,item.gapMonths,item.flags.join('；'),item.fromPdfUrl,item.toPdfUrl]));
  });
  $('ledger-quality-export').addEventListener('click',() => download(`QDII_质量标注_${$('ledger-start').value}_${$('ledger-end').value}.csv`,['机构名称','类别','前期截至日','本期截至日','标注','前值_亿美元','后值_亿美元','说明','前期官方PDF','本期官方PDF'],qualities().map(item => [item.name,item.category,item.fromDate,item.toDate,item.problem,item.previous,item.current,item.detail,item.fromPdfUrl,item.toPdfUrl])));
  rebuild();
  $('ledger-teaser').textContent = `${ledger.summary.increaseCount} 次同名机构正向变化 · 合计 ${fmt(ledger.summary.positiveTotal)} 亿美元。按年查看、展开明细，并核对前后两份原始报告。`;
})();
