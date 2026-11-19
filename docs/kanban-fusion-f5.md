# F5：发布候选与恢复演练

验收对象是 Tavlo 的本地 `.tgz`，而不是开发目录。F0 旧包和 F5 候选都叫 `dsh-plugin-tasks-0.2.0.tgz`，必须按目录和 **SHA-256** 区分。本次不发布 npm、不操作日用 DSH、不启动真实模型，也不从 dsh-kanban 导入数据。

## 证据与边界

| 路径 | 核对内容 |
| --- | --- |
| [独立安装与恢复报告](../../artifacts/kanban-fusion-f5-20261118/final/release-probe.json) · [看板截图](../../artifacts/kanban-fusion-f5-20261118/final/mcp-browser-image.png) | 在临时 Web profile 离线安装冻结包，两个真实工作区及未分组共三卡。宿主内测试连接器重放相同来源建卡；停机后在**同一 home**改装候选件，不需要安装 dsh-kanban。用 MCP SDK 查旧卡、移列、评论，浏览器接收 SSE，再上传真实 PNG。 |
| [恢复探针](../scripts/kanban-fusion-f5-release.mjs) | `ctx.root.fiber.dispose()` 完成且 Host 正常退出后才复制；在全新 home 安装候选、还原并启动。比对清单哈希、SQLite 完整性、域版本、列表顺序、列与标签、历史、评论重放及图片下载摘要。备份之后另建一张任务，恢复不覆盖这笔写入。 |
| [全量日志](../../artifacts/kanban-fusion-f5-20261118/tests.log) · [执行链](../tests/launch.test.mjs) | 连接器建卡 → 用户启动选模失败 → 恢复绑定会话 → MCP 留言 → 用户手动完成 → 来源重试仍返回同一任务。使用可计数的会话控制器，断言只建一个会话、只接收一条首消息。不是外部模型实跑或 TAPD/GitHub 远端回写。 |
| [旧库兼容](../tests/fusion-baseline.test.mjs) | 单独以含活跃／旧会话、待恢复启动、更新和删除回执的 v5 SQLite 夹具验证 v8；完成时间未知不补造。夹具测试不是在真实旧包里构造了所有故障场景。 |

## 如何重跑

本次环境：Windows、Node 24.18.1、DSH 0.2.2-rc.1、Chrome 157.0.8103.79。已安装的 `dsh-tasks-mcp` stdio 桥用独立 API 身份读取旧卡；MCP HTTP 验证移列及评论。候选包包含 Tavlo、Looseleaf、UIArc、dnd-kit 及上游交互参考的许可文本。宿主配色对照：[浅色](../../artifacts/kanban-fusion-f5-20261118/final/mcp-browser-image.png) / [深色](../../artifacts/kanban-fusion-f5-20261118/final/mcp-browser-dark.png)。

Windows PowerShell，在 `tavlo-plugins-tasks` 下，使用 Node ≥24、DSH 0.2.2-rc.1、已缓存的 DSH profile 依赖、本机 Chromium 和 Playwright Core。先设 `DSH_CLI`（DSH 的 `lib/bin.js`）、`BROWSER_EXE`（浏览器可执行文件）、`PLAYWRIGHT_MODULE`（`playwright-core/index.mjs`）的绝对路径。没有离线缓存时安装应失败，不要为验收改用个人 profile。

```powershell
$out = New-Item -ItemType Directory (Join-Path ../artifacts ('kanban-f5-' + [guid]::NewGuid()))
$env:FUSION_PROBE_OUTPUT = $out.FullName
$env:FUSION_V5_PACKAGE = (Resolve-Path ../artifacts/kanban-fusion-f0-20261118/dsh-plugin-tasks-0.2.0.tgz).Path
npm test *> (Join-Path $out 'tests.log'); if ($LASTEXITCODE) { throw 'Tests failed' }
npm pack --pack-destination $out.FullName; if ($LASTEXITCODE) { throw 'Pack failed' }
$env:FUSION_TAVLO_PACKAGE = (Get-Item (Join-Path $out 'dsh-plugin-tasks-*.tgz')).FullName
node scripts/kanban-fusion-f5-release.mjs; if ($LASTEXITCODE) { throw 'Release probe failed' }
```

报告只在所有断言通过后生成；失败时保留临时合成数据供排查。不要公开临时 Host 日志、登录 URL 或 cookie。F1–F4 的主题和交互场景使用[单独的浏览器探针](../scripts/kanban-fusion-probe.mjs)，各用空 profile 和单独输出目录；其中的上游对照检查不算 Tavlo 验收。

## 面向实际升级的停机与恢复步骤

1. 记录插件与 Host 版本、安装包摘要、实际 DSH home 和存储配置。阻止新写入，安排停机窗口；退出所有使用该库及附件目录的 Host，确认进程已结束。不要用运行时的单文件复制代替快照。
2. 复制任务 SQLite（默认 `storages/tasks.sqlite`）及存在的 `-wal`、`-shm`、`-journal`，**同时**复制完整的宿主附件目录（默认 `attachments/v1/`）。记录文件名、大小与摘要；副本独立存放，不在原备份上启动 Host。需要恢复会话内容、工作区注册、其他插件或自定义附件后端时，要按宿主配置另外成套备份；本探针只证明任务、会话引用及本地任务附件的恢复。
3. 在另一空 home 安装匹配的程序，将备份还原到对应位置，核对摘要、`PRAGMA integrity_check` 和 `tasks` 域版本。打开总看板和详情，抽查顺序、来源、会话引用、回执及实际图片字节；核验通过再决定切换。
4. 若升级后已有写入，先停机另存**最新**成套副本并列出备份时间点以后的差异。可以在另一个 home 用旧包打开**升级前**副本，不能用旧包打开 v8；经业务方确认增量如何保留后才切换，不覆盖当前库，不自行清理可能被会话复用的附件。

## 放行条件

Windows 便携桌面壳、单实例保护、实体触屏签收清单见[实机交接](kanban-fusion-f5-desktop.md)。

Web 自动化、桌面宿主和实体触屏分别记录。桌面／触屏需实机核对手指滚动与拖卡、抽屉边缘拖宽、窄屏操作和预览返回焦点；不可用鼠标拖拽代替。首发按 D2 默认不送图、D3 不跨库导入。发布或安装到日用环境是独立操作，不由演练自动执行。
