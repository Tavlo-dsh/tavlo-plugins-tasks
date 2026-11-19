# TaskService、MCP 与 SQLite 验证记录

日期：2026-11-17。实现版本：0.2.0；TaskService 契约 1；存储 domain 5。环境：Windows、Node.js 24.18.1、已发布 DSH 0.2.2-rc.1 存储/Connection/WebServer 包、MCP SDK 1.32.2。

## 已执行

- `npm test`：97 项测试全部通过，无跳过。
- TypeScript 5.9.3 对 `task-service.d.ts` 和 `task-mcp.d.ts` 执行 `--noEmit --strict --module nodenext --target ES2022`：通过。
- 安装包清单包含全部 SQLite/MCP 运行文件、公开类型和 stdio bin；仅安装生产依赖的隔离目录可加载 Host 插件、通过 SDK transport 发现 7 个工具、创建任务，并在重载后命中 SQLite 更新回执。
- 交付包以源码基线 `77958a77910c6be22c549bccfcf8a141b152215f` 加本次服务/存储改动生成；隔离副本重新安装锁定依赖后，97 项测试全部通过。工作区同时进行中的界面修改未纳入此包。
- `git diff --check`：通过。
- `tests/service.test.mjs`：兄弟插件发现/卸载/重载、来源并发唯一性、解绑/删除释放身份、更新字段限制、版本冲突、持久化请求重放、无变化回执、容量限制、降限重放、写入失败与不确定提交恢复。
- `tests/migration.test.mjs`：真实 JSON v1/v2/v3/v4 → SQLite；记录、创建意图、删除回执、会话关联和启动历史保留；源文件字节不变；完成后不重复导入；中断续传；源变更、损坏或重复身份时失败关闭。
- `tests/mcp.test.mjs`：SDK 标准 Streamable HTTP 客户端初始化、工具发现、调用、并发去重、业务错误与降限重放；owner/Origin 认证；关闭路由；真实 stdio 子进程通过 `/connect` 获取独立 API 身份，创建任务并释放 WebSocket。
- 现有看板、搜索/筛选、创建、改列、删除、启动/恢复、实时状态与跨页面同步测试保留并通过。新增外部来源更新的 Host/RPC/SSE/浏览器字段一致性测试。
- Host 集成测试现使用真实 SQLite 文件；存储故障注入通过包装发布版后端完成。底层 store 的部分既有测试保留 JSON 后端以验证业务逻辑与介质无关。

## 边界

- 未安装到用户正在使用的 Host，也未迁移真实用户任务文件；自动迁移在新版插件首次启动时发生。所有验证使用隔离的临时存储。
- stdio 测试使用真实 Connection API 认证与真实 WebSocket 握手；测试中的 Gateway upgrade fixture 仅实现 Peer 准入与释放，不启动完整远端会话协议。真实客户端部署要求宿主 Gateway 已启用。
- 未调用 TAPD 或其他外部平台。同步策略、凭据、远端回写及删除抑制由外部插件实现。
- 未新增统计报表或持久化业务事件历史。SQLite 使用宿主的每行 JSON 文档布局，公开查询仍通过 TaskService。
- 数据库仍由单个 Host 管理；未承诺跨进程写入一致性。迁移是带持久化进度的可恢复复制，不是全部记录的一次性事务。
- 源码依赖审计报告 3 项 high，来源于现有固定版本 Zod 4.4.3 及依赖它的 DSH Connection/Domain 包（GHSA-mrhx-c7xc-m3w5）；将本插件作为依赖安装时，报告还会把本插件列为第 4 个受影响包，仍是同一上游问题。为保持已验证的 DSH rc.1 兼容性，本次未整体升级宿主包；新增 WebSocket 依赖使用 8.23.0。此审计问题仍需在宿主依赖升级时处理。
