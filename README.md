# 滚动新闻快照采集与归档

本服务面向新闻编辑部和数据运营人员：采集经常刷新的新闻目录页面，规范化标题与链接，并在本地 SQLite 中保留每次采集及文章出现历史。一次短暂的页面缺项不会立刻从归档删除新闻；操作者可以查看快照差异、采集健康、审核记录，并导出 CSV。

## 环境

- Node.js `22.23.4`。
- 仅使用 Node 内置模块和 SQLite，无第三方包，不要求网络连接。

## 验收与演示

```sh
npm test
npm run build
npm run demo
```

演示会读取本地合成页面并在临时目录建立数据库，输出一次采集摘要后清理临时文件。生产数据库由 `ARCHIVE_DB` 指定，默认 `./var/archive.sqlite`。默认 HTTP 监听地址为 `127.0.0.1:8080`，可用 `HOST` 和 `PORT` 调整。

## HTTP 接口

- `POST /v1/feeds`：注册来源，提交 `feedId`、`baseUrl`、`allowedHosts`，以及可选的 `minimumItems`、`missingThreshold`。
- `POST /v1/feeds/:feedId/snapshots`：提交已保存的 HTML 页面；可用 `X-Captured-At` 指定采集时间。
- `POST /v1/feeds/:feedId/refresh`：手动抓取已注册来源；仅访问允许列表中的 DNS 主机。
- `GET /v1/feeds/:feedId`：查看 feed 状态、文章统计和采集健康。
- `GET /v1/feeds/:feedId/items`：分页读取文章；`visibility=visible|quiet` 可过滤状态。
- `GET /v1/feeds/:feedId/runs`：读取近期页面快照接纳/拒绝记录。
- `GET /v1/feeds/:feedId/attempts`：读取抓取请求、重试、失败和响应审计。
- `GET /v1/feeds/:feedId/details`：读取详情补采任务（`pending`、`succeeded`、`failed`、`superseded`）及统计；`status=` 与 `limit=` 可过滤。
- `POST /v1/feeds/:feedId/details/collect`：显式执行一轮详情补采；正文可带 `limit`（默认 20，上限 100），并发受限，逐项返回结果。
- `POST /v1/feeds/:feedId/details/retry`：把失败任务重新置为待补（可按 `articleId` 指定文章），保留累计尝试次数。
- `GET /v1/feeds/:feedId/changes`：比较最近两次已接纳快照；未达到两次时返回 `409`。
- `GET /v1/feeds/:feedId/health`：读取 24 小时抓取成功率、最近成功时间和异常提示。
- `GET /v1/feeds/:feedId/items.csv`：流式导出；限制输出行数并转义表格公式前缀。
- `PATCH /v1/feeds/:feedId/items/:articleId/review`：按修订号更新审核状态，状态为 `unreviewed`、`confirmed` 或 `withdrawn`。
- `GET /v1/feeds/:feedId/items/:articleId/review`：查看审核事件历史。
- `GET /v1/feeds/:feedId/items/:articleId/history`：查看文章在已接纳列表快照中的出现位置和间隔。
- `GET /health`：进程健康检查。

抓取失败、页面异常和正常列表变更有不同记录。相同页面指纹重复提交时不会重复增加文章观察次数。短暂缺失需达到来源配置的连续快照阈值后才转为 `quiet`，重新出现时恢复 `visible`。人工审核状态独立于可见性状态，旧修订号会得到冲突响应而不会覆盖新审核决定。

## 详情补采

已接纳的列表快照会为首次出现或标题发生变化的文章登记详情补采任务（同一事务内完成，列表接纳与详情采集互不影响）。补采任务持久化在 SQLite 中，进程重启后仍是待补状态，由操作者或调度器通过 `details/collect` 显式执行；列表抓取本身从不等待详情页。

- 详情抓取复用与列表相同的来源主机白名单、超时、重试、重定向与响应大小预算。
- 文章行的 `detailAuthor`、`detailSummary` 来自详情页；`detailObtainedAt`、`detailSourceUrl`、`detailListSeenAt` 记录这些字段何时取得、来自哪个页面、对应哪次列表观察。补采失败时旧字段及其出处原样保留，任务记录错误原因。
- 详情在返回途中遇到新一轮列表更新时，旧任务会被取代（`superseded`），其迟到结果直接丢弃，不会覆盖更新后已取得的字段。
- 内容指纹相同的重复结果只推进观察水位，不重复刷新字段与取得时间；补采只写详情列，从不改变可见性、出现次数等列表观察字段，已退出列表的文章不会因此重新出现。
- 失败任务由运营通过 `details/retry` 重新补抓：同一任务行复位为待补，累计尝试次数保留；已有待补任务或当前观察已被覆盖的任务会被跳过并说明原因。

仓库中的 HTML 样本为本地合成数据，仅用于离线演示和测试。实际部署前请配置准确来源域名，并遵守来源站点的使用条件。本服务不在后台隐式启动定时抓取；由操作者或外部调度器显式触发刷新。
