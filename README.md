# QDII 额度观察

国家外汇管理局全国口径 QDII 累计批准额度交互档案。初始档案为 2021-10 至 2026-09 的 60 个月观察窗口，共 57 期官方 PDF、10,585 条机构记录。未取得原件的月份为 2021-10、2022-01、2022-02；不插值或沿用前值。

网站支持全国/分类趋势、两期机构比较、机构历史查询、来源追溯和 CSV 下载。

## 云端运行

- GitHub Actions 每月最后一天北京时间 23:00 采集。UTC cron 在 28–31 日 15:00 唤醒，日期门控只允许真正月末采集。GitHub 排队可能导致延迟，任务创建时间用于避免运行器排队跨日误判。
- `Actions → QDII cloud update and Pages → Run workflow` 可随时手动重跑；修改程序或界面也会运行一次。
- 检查总局最新页及广东分局近期全国口径报告，保留自 2021-10 起全部历史。PDF 截至日决定归属月份，总额不变的新一期也归档。
- 校验 PDF 哈希、机构序号与名称、批准日期、额度、分类及总计；新文件再以 pypdf 独立解析核对。异常会中止发布。
- 成功检查后提交数据和检查时间，即使没有新额度也保存检查记录；使用 GitHub 官方 Pages Actions 发布 `dist/`。
- 每次真正执行后的成功或失败都会创建一条 GitHub Issue 提醒 `@JiangMiao1214`，包含网址、检查结果和运行日志；邮件是否送达由 GitHub 账号通知设置决定。可通过仓库变量 `NOTIFY_LOGIN` 修改收件账号。
- PDF 改版或官方来源结构变化可能需要维护解析器。GitHub 定时服务不提供严格的准点保证。

## 初次部署配置

仓库需启用 Issues；Settings → Pages → Build and deployment → Source 选择 **GitHub Actions**。仓库默认分支为 `main`。不需要外管局账号、API key 或付费服务器。

`update.yml` 每个 job 分开申请最小权限：数据归档使用 `contents: write`；Pages 部署使用 `pages: write` 与 `id-token: write`；提醒使用 `issues: write`。工作流使用 GitHub 自动提供的短期 token，没有持久访问令牌。

## 本地验证

```sh
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
python scripts/collect.py --validate-only
python scripts/collect.py
python scripts/build.py
python -m http.server 8765 --directory dist
```

## 数据与口径

`data/qdii.json` 是当前有效快照；`data/pdf/` 保留原始 PDF；`data/revisions.json` 记录新文件及修订；`data/last-check.json` 保存最近成功采集。`site/` 是无外部依赖的网页，`dist/` 是生成产物，不入库。

累计批准额度不是实际投资余额、资金流量或剩余额度。机构连接只规范空白和中英文括号，未自动合并更名或合并机构。2021-12 原件截至 12 月 15 日，并非月底。历史“证券类”统一为“证券基金类”。2026-08 原表第 87/88 行的跨行名称修正在解析器中明确标记，并已核对原 PDF。

来源：[国家外汇管理局](https://www.safe.gov.cn/safe/2018/0425/16849.html)。本项目是独立整理工具，并非外管局官方网站。
