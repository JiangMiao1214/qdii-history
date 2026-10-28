// Called by actions/github-script with the scoped token supplied by GitHub.
module.exports = async ({github, context, core}) => {
  const fs = require('node:fs');
  const result = process.env.DEPLOY_RESULT;
  const success = result === 'success';
  const filename = 'data/last-check.json';
  const status = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : null;
  const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  // Set this repository variable to the verified human owner at initial setup.
  const recipient = process.env.NOTIFY_LOGIN || '';
  if (recipient && !/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(recipient)) throw new Error('Invalid notify login');
  const mention = recipient ? `@${recipient}\n\n` : '';
  const lines = [mention + (success ? 'QDII 统计与网站发布已完成。' : 'QDII 云端任务失败，需要检查；失败阶段不会发布未经校验的数据。')];
  if (success && status) {
    lines.push(`检查时间：${status.checkedAt}`, `最新报告：${status.latestDate}`,
      `累计批准额度：${status.total} 亿美元；机构数：${status.count}`,
      status.newReports.length ? `新增或修订：${status.newReports.map(r=>r.date).join('、')}` : '本次没有新报告。');
    if (status.warnings.length) lines.push(`来源提示：${status.warnings.join('\n')}`);
  }
  if (success && process.env.PAGE_URL) lines.push(`网站：${process.env.PAGE_URL}`);
  lines.push(`运行记录：${runUrl}`, '\n<!-- qdii-cloud-notification -->');
  const body = lines.join('\n\n');
  await core.summary.addRaw(body).write();
  const title = `QDII ${success ? '统计完成' : '任务失败'} · ${new Date().toISOString().slice(0,10)} · #${context.runNumber}`;
  // One durable notification per workflow run. Reruns update the same issue.
  const issues = await github.paginate(github.rest.issues.listForRepo, {...context.repo, state:'all', per_page:100});
  const previous = issues.find(i=>i.user?.login==='github-actions[bot]' && i.body?.includes(runUrl) && i.body?.includes('<!-- qdii-cloud-notification -->'));
  if (previous) await github.rest.issues.update({...context.repo,issue_number:previous.number,title,body});
  else await github.rest.issues.create({...context.repo,title,body});
};
