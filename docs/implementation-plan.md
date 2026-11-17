# 任务看板通信与持久化实施计划

任务看板采用 DSH 0.2.2-rc.1 已提供的 Connection 通道：Client 调用 `ctx.connection.rpc.call()`，Host 用 `ctx.connection.fetch.register()` 注册 `/api/dsh-plugin-tasks/rpc` 并适配公开的 RPC envelope。任务数据由 Host 的 `ctx.storageDomain` 持久化。保留手写 `index.js` 和 ModuleLoader factory 形式的 `client.js`，所有新增模块也是可直接运行的 JS。

步骤 1 已完成。实测修正：原定独立 `rpc.handle('/dsh-plugin-tasks', ...)` 在真实 Web Loader 中报 `cannot get property "webServer" without inject`，即使任务插件声明了 `webServer`。最终使用 Connection 的精确 Fetch 路由，详见 [步骤 1 验证记录](step-1-verification.md)。

通信与持久化的五个步骤已完成：任务持久化、看板操作、聚合实时同步及独立安装均已验收。记录见 [步骤 2](step-2-verification.md)、[步骤 3](step-3-verification.md)、[步骤 4](step-4-verification.md) 和 [步骤 5](step-5-verification.md)。单任务启动、任务会话关联及派生状态现已接入，见 [M3 验证记录](m3-verification.md)。

当前闭环为“新建任务 → 启动会话 → 实时状态与告警 → 打开对话处理 → 断线和重启后恢复”。一条聚合流提供任务快照、变更和运行状态。列切换仍为手工菜单操作；拖拽、完整详情编辑、子任务、取消与批量启动尚未实施。

## 1. 固定的实现选择

| 项目 | 选择 |
| --- | --- |
| Host 与 Client 的操作通道 | 精确 POST `/api/dsh-plugin-tasks/rpc`，Connection RPC envelope |
| Host 注册 | `ctx.connection.fetch.register({ path, methods: ['POST'], requestBody: 'buffered', fetch })` |
| Client 调用 | `ctx.connection.rpc.call('/api', 'dsh-plugin-tasks/rpc', { operation, input }, signal)` |
| 任务存储 | `ctx.storageDomain.open(taskDomain)`，domain 名 `tasks`，version 3，兼容 version 1、2 |
| 实时同步 | `ctx.connection.fetch.register()` 注册 `/api/dsh-plugin-tasks/events`，返回 SSE 响应 |
| Host 基础注入 | `connection`、`webServer`、`storageDomain` |
| Client 基础注入 | `slots`、`locale`、`connection` |
| 构建 | 保持零构建；不引入 tsc、tsdown 或 typert 生成步骤 |
| 分发 | 声明实际使用的 npm 依赖，验证独立安装和本地 link 两种模式 |

精确 Fetch 路由在官方 Gateway 的唯一 `/api` RPC interceptor 之前分派，无需占用或替换该 interceptor。任务操作与聚合流都经过共享 `/api` 的 HTTP 鉴权、`connection/request` waterfall 和精确路由的 owner 检查。

## 2. 第一轮交付范围

实现任务列表、新建任务、切换 `stage`、基础卡片、加载和错误状态。持久化字段沿用设计中的 `TaskRecord`，已开放 `title`、`brief`、`stage`、可选 `workspaceId` 与模型偏好。工作区和模型来自 Host 现有目录，仅保存后续启动偏好。

三列对应手工分类 `todo / doing / done`。执行中、待审批、待回答等属于会话派生状态，不能通过改列写入任务记录。第一轮的列切换不启动或取消会话。

已有设计中的会话启动、详情、子任务、批量启动、agent 工具和 Schedule 关联，按 M3 至 M7 接续实施。

## 3. 分步实施与验收

### 步骤 1 打通最小 RPC（已完成）

修改 `index.js` 和 `client.js`，声明所需服务，注册 `/api/dsh-plugin-tasks/rpc`，先实现返回空任务列表的 `list` operation。Client 调用服务通过 `apply` 闭包提供给 slot，组件只接收数据入口和回调。

Connection 在精确 Fetch 分派前检查 owner principal，并负责 HTTP 鉴权、请求体限额和生命周期。Host 用已发布的 `clientRequestSchema` 验证 envelope，再校验 `{ operation, input }` 和具体操作输入，返回带原 `rpcId` 的 `server-response`。业务失败返回结构化 failure；Client 同时处理 failure 分支和网络、HTTP、取消导致的 Promise rejection。

注册和调用的最小形式：

```js
// Host apply 内
ctx.connection.fetch.register({
  path: '/api/dsh-plugin-tasks/rpc',
  methods: ['POST'],
  requestBody: 'buffered',
  fetch: fetchTasksRpc,
})

// Client apply 的数据访问闭包内
await ctx.connection.rpc.call('/api', 'dsh-plugin-tasks/rpc', {
  operation: 'list', input: {},
}, signal)
```

验收已通过：活 Web 客户端显示空列表和三列零计数；加载、模拟 503 失败及点击重试恢复均已验证。自动测试覆盖缺少凭据 401、不可信 Origin 403、非 owner 403、未知操作、错误输入、Gateway interceptor 共存及卸载后精确路由消失。

### 步骤 2 接入持久化和 Host 业务操作（已完成）

新增 `task-schema.js` 和 `task-store.js`。任务 schema 使用 Zod 普通运行时依赖，domain spec 使用公开的字段声明；通过注入的 `storageDomain` 服务打开存储，不依赖本机 DSH checkout 的模块路径。

当前 version 1 存储基础字段 `id / revision / title / brief / stage / position / createdAt / updatedAt`，以及不对 Client 暴露的 `_create` 元数据。任务完整设计中的会话、父任务和 Schedule 字段按后续里程碑增加。

打开 domain 后完成存量记录验证，再注册任务 RPC Fetch 路由。读取失败必须使插件初始化失败，不能用空列表掩盖损坏数据。插件卸载时调用 `domain.close()`，等待已接纳的写入完成。

Host 创建 `id`、初始 `revision`、排序值和时间戳；请求只接受操作允许的字段。创建使用 `requestId` 去重，将该标识作为内部创建元数据与任务记录一次持久化；创建检查和写入在同一插件操作队列中执行，重试相同请求返回已有记录，参数不一致返回冲突。去重索引在启动时从记录重建。

修改使用 `domain.table('tasks').update()`，在其原子更新回调中比较 `expectedRevision`，成功后递增版本。持久化成功后才返回成功和发布新状态，写入失败保留原记录。

验收已通过：RPC 创建后再次读取和重新打开 Host 均得到已有记录；实际 Web profile 的进程重启恢复；并发旧版本修改得到冲突；相同创建请求不产生重复任务；存储失败不会返回业务成功。Client 表单和卡片仍在步骤 3。

### 步骤 3 接入可操作的看板（已完成）

在步骤 1 已建立的 Client 数据对象上扩展写操作，保持稳定的 `getSnapshot / subscribe` 来源及 RPC 回调。通过 slot 的 `inject` 工厂返回 `hooks: { tasks: source }`，由 renderer 生成组件使用的 `useTasks(selector)` hook。

看板展示三列和真实数量；新建采用居中弹框，可选工作区与模型；标题和描述即时搜索，筛选菜单按工作区过滤。卡片按原型显示标题、两行描述、状态和元信息；列切换收进键盘可用的菜单，拖拽后续接入。列可折叠，完成列默认显示最近更新的 10 条，可展开全部。新建和修改期间禁用对应的重复提交；成功后使用 Host 返回的完整记录更新数据对象。

加载失败、创建失败、版本冲突分别提供可理解的界面反馈。冲突时保留用户输入并提供刷新操作；创建结果未知时复用原请求标识重试。中英文文案都加入现有 locale 字典。

实现保持一个生命周期内的稳定数据来源，包含草稿、搜索和各卡片的操作状态。刷新与写操作不重叠，写响应按 revision 合并，避免迟到的创建重放覆盖较新的任务。创建标识使用浏览器 `crypto.getRandomValues()`，支持 HTTP GUI；单次 RPC 的 Client 等待上限为 30 秒，超时视作结果未知，取消不意味着回滚。

创建草稿和待确认请求写入当前标签页的 `sessionStorage`，包含分类、工作区和模型，刷新后可继续；存储不可用时只保留内存状态。创建结果未知时锁定输入并重放同一标识和全部参数，成功后清除草稿。改列冲突或结果未知时保留目标分类，刷新后重新选择。列表失败保留已加载卡片并暂停写入，持久化状态不确定时隐藏旧记录。

视觉与弹框调整验收见 [看板与弹框验证](ui-verification.md)。存储升级到 version 2 并声明兼容 version 1；新增字段为可选，旧记录与原创建去重不丢失。`options` 操作读取 `ctx.get('workspaceRegistry').list()` 和 `ctx.get('sessionController').modelCatalog()`；显式偏好在新创建时校验，引用失效不阻止已有任务读取或原请求重放。此版本的 Cordis 会等待 inject 中的全部服务，可选目录通过公开的 `ctx.get()` 在请求时读取。

验收已通过：“新建 → 显示卡片 → 改列 → 刷新与进程重启恢复”；真实页面的响应丢失重试只产生一个任务；两个浏览器页面的版本冲突可刷新恢复且保留草稿；503 列表失败暂停修改并可重试。反复进入看板共享同一数据来源，只有插件 apply 注册和卸载创建/释放服务。

### 步骤 4 接入任务聚合实时同步（已完成）

Host 用 `connection.fetch.register()` 注册一个 GET endpoint：

```js
ctx.connection.fetch.register({
  path: '/api/dsh-plugin-tasks/events',
  methods: ['GET'],
  requestBody: 'buffered',
  fetch: openTaskEvents,
})
```

`task-events.js` 返回 `text/event-stream` 的 `Response`。`task-store.js` 的 `watch()` 在业务队列中读取完整任务快照并登记订阅，写入落盘后才发布变更。每帧携带 `streamId` 和递增的 `sequence`；连接以 `snapshot` 开始，再发送 `upsert`，创建重放不重复发布。存储结果不确定时发送 `unavailable` 并关闭订阅，不能继续广播旧数据。

Client 使用同源、文档相对 URL 打开流，所有卡片共享一个数据对象和一条连接。序号缺口、错误帧、连接结束或超时均终止旧流，以 1、2、4、8、15 秒退避重连；稳定 30 秒后重置。首次快照上限 30 秒，连接连续 90 秒无数据时重连。RPC 列表响应不能覆盖请求期间已到达的流事件；同一 Host 的快照与写响应按 revision 合并，新 Host 的完整快照作为恢复依据。草稿、搜索、筛选及待确认写操作独立保留。

本步骤验收时会话状态延后到单任务启动阶段。现已由 M3 补齐 `activeSessionId`、启动操作和状态聚合，复用同一 SSE；当时的任务同步验收范围保持不变。

每个连接限制待发字节（`eventBufferBytes` 默认 32 MiB），慢消费者超限时关闭并解除订阅，由完整快照重连恢复。初始快照超过队列上限返回 503、`tasks/events-too-large`。心跳由 `eventHeartbeatMs` 配置，默认 15 秒。请求取消、流取消和 Host 卸载都释放订阅和定时器；Client 页面离开时暂停、返回时恢复，卸载时停止流和重连。

任务同步验收已通过：两个真实 DSH 页面自动同步新建和改列，断开单页连接后恢复，Host 进程重启后自动重连、记录一致且可继续同步。自动测试覆盖队列、版本竞态、慢客户端和卸载清理，详见 [步骤 4 验证记录](step-4-verification.md)。会话状态和告警层的后续验证见 M3 记录。

### 步骤 5 验证独立安装并整理文档（已完成）

`package.json` 已包含全部运行模块、bundle patch 和 `/client` 导出。实测发现干净 profile 的 `autoInstallPeers: false` 不会安装 Connection 的 Cordis/Scope peer 依赖，现已将二者明确声明为运行时依赖。`engines.dsh` 固定为已验证的 `0.2.2-rc.1`。

在隔离的 DSH home 中按官方默认模板创建 Web profile，仅安装 tarball 及生产依赖。关闭 Node 全局搜索后，Host 模块直接导入成功，全部运行依赖解析到该 profile 内，`pnpm peers check` 无问题。真实页面完成新建、查询、改列、双页同步、断线与进程重启恢复；移除包后入口与路由消失，重装恢复完整记录。另在隔离 profile 中切换到源码的本地 link，页面、记录和实时连接均通过。

README 已补充 tarball 安装、卸载与恢复、运行版本、首次启动引导及故障处理。保持零构建；55 项自动测试通过。后续 DSH 版本逐一验证后再声明兼容。

验收结果与安装修复见 [步骤 5 验证记录](step-5-verification.md)。卸载后的基础会话页曾出现一次 DSH `session-maybe` adapter 错误，重装和重新加载页面后未复现，已记录。原有正式 profile 和任务文件保持不变。

## 4. RPC 协议

M3 新增 `launch`、`resume-launch` 和 `abandon-launch`；完整现行输入见 [README 的操作表](../README.md#存储与操作)。`task-sessions.js` 通过已发布 SessionController 创建、选模型和投递，Client 通过 `uiWorkspace.openSession()` 导航。状态通过 `state()`、`sessionQuery.observeSession()` 及宿主事件和周期采样聚合，不落入任务记录。`launch` 进度与任务同库持久化；完成前保留候选会话，投递成功后绑定活跃指针。自动恢复发送需要用户操作。

所有操作共用 `connection.rpc.call('/api', 'dsh-plugin-tasks/rpc', { operation, input }, signal)`；下表的操作输入是 wrapper 中的 `input`。

| Operation | Input | 成功 value |
| --- | --- | --- |
| `list` | `{}` | `{ tasks: TaskRecord[] }` |
| `create` | `{ requestId, title, brief?, stage?, workspaceId?, model? }` | `{ task: TaskRecord }` |
| `set-stage` | `{ taskId, expectedRevision, stage }` | `{ task: TaskRecord }` |
| `options` | `{}` | `{ workspaces, groups, presets, workspaceStatus, modelStatus, modelFailures }` |
| `launch` | `{ taskId, expectedRevision, requestId, content, workspaceId?, model?, agentPreset?, replaceActive? }` | `{ task, sessionId }` |
| `resume-launch` | `{ taskId, requestId }` | `{ task, sessionId }` |
| `abandon-launch` | `{ taskId, requestId, expectedRevision }` | `{ task }` |

创建默认进入 `todo`，也可指定其他分类。`model` 为 `{ provider, model, reasoningEffort? }`；不指定时不写显式偏好。`set-stage` 只改变手工分类，其他记录字段保持完整。RPC 参数中不开放时间戳、revision、任意文件路径或存储位置。

统一业务失败：

```js
{
  ok: false,
  error: {
    code: 'tasks/revision-conflict',
    message: 'Task changed since it was loaded',
    details: { taskId, currentRevision },
  },
}
```

已实现业务代码：`tasks/bad-request`、`tasks/not-found`、`tasks/revision-conflict`、`tasks/request-conflict`、`tasks/limit-reached`、`tasks/persistence-failed`、`tasks/persistence-unknown`、`tasks/unavailable`。鉴权和非 owner 拒绝由 Connection 返回 HTTP 401/403。取消在队列开始前返回 `gateway/cancelled`。Client 使用 code 选择本地化文案，不依赖 Host 的 message 展示。

连接层的 300 MiB 默认 cap 不是任务的业务限额。当前插件配置为 `maxTitleLength: 200`、`maxBriefLength: 20000`、`maxTasks: 10000`，并严格拒绝操作未声明的输入字段。已有创建请求可在容量已满或配置降低后重放。取消请求不等于回滚已经持久化的操作；结果未知时复用创建请求标识。后端报告 `unknown-state` 时 domain 隔离，需重新打开存储后再恢复，不能继续显示旧内存数据。

默认 Web JSON 后端把 domain 放在 DSH home 的 `storages/tasks.json`，路径由宿主配置决定。版本检查和队列针对同一 Host；JSON 后端没有跨进程写入协调。

## 5. 文件改动安排

| 文件 | 工作 |
| --- | --- |
| `index.js` | 声明注入、打开存储、注册 RPC 和聚合流、绑定卸载清理 |
| `task-schema.js` | 持久化记录与各操作 payload 的验证规则 |
| `task-store.js` | 列表、新建、CAS 更新、创建去重及持久化错误转换 |
| `task-options.js` | Host 工作区与模型目录读取及新请求的显式绑定检查 |
| `task-events.js` | SSE 队列上限、心跳、请求取消和卸载清理 |
| `task-sessions.js` | Session 启动接口适配、恢复和 Host 状态采样 |
| `client.js` | RPC 调用、任务数据对象、三列卡片、表单、错误反馈和单一聚合流 |
| `package.json` | 依赖、发布文件和兼容范围 |
| `cordis.patch.yml` | 必要的插件配置默认值 |
| `README.md` | 安装、存储、当前能力和使用说明 |
| `tests/*.test.mjs` | 有意义的持久化、RPC、并发和清理验证，使用 Node 测试运行器 |

## 6. 验证清单

- [x] 活客户端的 ModuleLoader factory 能取得注入的 Connection 并调用 RPC。
- [x] Host RPC 创建、修改 stage、重启和重新启用均得到一致的持久化结果。
- [x] 两个并发更新只允许匹配当前 revision 的写入成功。
- [x] 创建响应丢失后的同请求重试不会产生重复任务。
- [x] 看板表单和真实卡片完成新建、改列及刷新恢复。
- [x] 未登录、不可信 Origin 和非 owner 的请求不能执行任务操作。
- [x] 列表加载失败、重试恢复、未知操作及插件卸载清理已通过步骤 1 验证。
- [x] RPC 列表/写入失败及未知操作都有可处理的结果。
- [x] 两个客户端通过聚合流收敛到同一状态，断线后完整恢复。
- [x] 插件卸载移除任务 RPC 路由、等待已接纳操作并关闭 domain。
- [x] 插件卸载停止 SSE 重连并释放任务流和订阅。
- [x] 单任务启动、任务会话关联、派生状态和告警层；验证范围见 M3 记录。
- [x] npm tarball 可独立安装到干净 Web profile，全过程无需构建。

## 7. 已确认依据与开工检查

步骤 1 已通过任务插件自身的 11 项自动测试和活 Web 客户端验证。测试使用已发布的 0.2.2-rc.1 Connection、真实 WebServer、签名 cookie 和 HTTP；不依赖源码 checkout 或生成代码。此前临时测试把 WebServer 直接提供在 root，未覆盖真实 Loader 的兄弟 provider 结构；独立 RPC 注册的结论已据此修正。

相关源码：

- [Host 注册和共享 Fetch 分派](../../.refs/dsh-src/packages/client/connection/src/rpc-host.ts)：`HostConnectionService.register`（直接 RPC 的注入问题）、`registerFetchRoute`、`createSharedFetchHandler`。
- [Client RPC caller](../../.refs/dsh-src/packages/client/connection/src/client/rpc.ts)：`createWebConnectionRpc`。
- [Connection Fetch route](../../.refs/dsh-src/packages/client/connection/src/rpc.ts)：`ConnectionFetchRoute`、`HostConnectionFetch`。
- [Domain 持久化](../../.refs/dsh-src/packages/storage/storage-domain/src/domain.ts)：`KvTable.update`、domain 写入队列和 `close`。
- [Slot 数据注入](../../.refs/dsh-src/docs/subsystems/slots.md)：`inject` 工厂及保留的 `hooks` 字段。

步骤 2 已核对 `storageDomain`、默认 JSON 路由和依赖解析。步骤 4 已验证 SSE 在真实 Web 客户端上的行为、自动重连和进程重启恢复；反向代理的缓冲配置及 Session 状态订阅尚未验证。
