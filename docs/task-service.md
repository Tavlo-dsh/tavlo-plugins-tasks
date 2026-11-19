# 通用任务服务、MCP 与 SQLite

实现版本：`dsh-plugin-tasks 0.2.0` 工作树；服务契约 `contractVersion: 1`；SQLite domain version `8`。DSH 内置工具、HTTP 和 Host 服务共用任务队列、输入校验、版本检查、持久化和公开返回结构。

### 看板列与排序（F2）

- 当 `capabilities.features.boardColumns` 为真，`board({})` 返回全局列和看板版本。`edit-columns` 用 `expectedRevision` 防止覆盖其他页面；动作 `add / rename / reorder / remove` 与输入形状见 [TaskInputs](../task-service.d.ts)。列名可改，列 ID 和阶段不变。
- `move({ taskId, expectedRevision, columnId, anchor? })` 使用卡片版本。提供 `{taskId, side:'before'|'after'}` 指定目标列中的锚点，省略即追加。只提交一行卡片，无多行调序的中间状态。超时先重读；过期任务版本、已移出目标列的锚点均拒绝写入。
- 老 `list` 仍按 `position` 返回。新客户端按 `columnId` 分组，在每列内按 `orderKey` 的字符串顺序排列。未拖动的旧卡按原 `position`、ID 得出初始顺序键。旧 `set-stage` 同阶段保留所在列；跨阶段进默认列并保留 `position`。创建只提供 `stage` 时仍进默认列。
- Web 客户端在原 SSE 路由发送 `X-Tavlo-Board: 1`：初始快照同时含 `board`；列、标签或优先级定义变化时广播 `board` 事件，用 `board.revision` 排序，不增加任务事件 `sequence`。未订阅此扩展的 SSE 与 `TaskService.watch()` 不收到看板定义事件，也不跳号。

任务插件负责看板任务。TAPD、GitHub 等连接器负责认证、远端抓取、拉取周期、字段转换、冲突处理和回写；连接器主动向本服务推送。插件不保存远端凭据，不读取远端项目，也不因改列、删除或启动 AI 自动调用远端 API。

## Host 插件接入

类型从 `@tavlo-dsh/dsh-plugin-tasks/service` 导入，服务通过 Cordis 的 `taskService` 获取。使用可选依赖分支，让任务插件缺失时只暂停任务接入，不影响连接器其他功能。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { CreateTaskInput, TaskService } from '@tavlo-dsh/dsh-plugin-tasks/service'

export function apply(ctx: Context) {
  ctx.inject(['taskService'], async branch => {
    const tasks: TaskService = branch.get('taskService')
    const capabilities = await tasks.capabilities()
    if (capabilities.contractVersion !== 1 || !capabilities.features.externalRefUnique) {
      throw new Error('Upgrade the tasks plugin before enabling task delivery')
    }

    // 此示例的接收端由连接器自己的同步代码调用。
    // 调用前先持久化 input；超时重试必须复用原始 input。
    branch.provide('exampleTaskSink', {
      push(input: CreateTaskInput, signal?: AbortSignal) {
        return tasks.execute('create', input, signal)
      },
    })
  })
}
```

同宿主服务只供可信插件调用；不要直接打开 `tasks` domain 或操作 SQLite 文件。服务仅在存储校验和迁移成功后公开。卸载撤销服务，旧引用返回 `tasks/unavailable`；重载后依赖分支重新激活。不要比较 Cordis 服务代理的对象身份来判断服务是否仍可用。

`watch(observer, signal?)` 返回 `Promise<unsubscribe>`，注册与完整 `snapshot` 在同一队列中完成，然后提供已提交的 `upsert`、`remove` 和派生 `status`。`unavailable` 表示停止使用该实例；AbortSignal、unsubscribe、插件关闭都会释放订阅。观察者是同步通知回调，不要在回调中做阻塞工作。订阅者应在自己的 `branch.effect(() => tasks.watch(...))` 中管理释放。

订阅是当前状态同步，不是可重放的业务命令或统计历史。断线后以新的完整快照恢复，不以 `upsert` 推断用户授权执行远端状态转换。

## 操作契约

`execute(operation, input, signal?)` 返回 `{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`。Host 直接调用的成功结果还可包含 `streamId`、`sequence`。`capabilities()` 是能力查询的便捷方法；服务不可用时抛出带 `code` 的错误。其他操作的业务失败通过 `ok: false` 返回。

| operation | input | value |
| --- | --- | --- |
| `capabilities` | `{}` | `{ contractVersion, operations, features, limits }` |
| `options` | `{}` | 当前工作区、模型、预设目录及可用状态 |
| `list` | `{ query?, labelId?, priority?, dueDate?, due?, today?, stage?, workspaceId?, provider?, externalRef?, limit?, offset? }` | `{ tasks, total? }` |
| `get` | `{ taskId }` | `{ task }`；不存在或删除返回 `tasks/not-found` |
| `create` | `{ requestId, title, brief?, stage?, columnId?, labelId?, priority?, dueDate?, workspaceId?, model?, externalRef? }` | `{ task }` |
| `board` | `{}` | `{ board }`；含共享看板版本、列、标签和有序优先级目录 |
| `edit-labels` / `edit-priorities` | `expectedRevision`（看板版本）和操作字段，见下文 | `{ board }` |
| `update` | `{ requestId, taskId, expectedRevision, patch }` | `{ task, mutation: { requestId, appliedRevision, replayed } }` |
| `set-stage` | `{ taskId, expectedRevision, stage }` | `{ task }` |
| `delete` | `{ taskId, expectedRevision }` | `{ taskId, revision }` |
| `launch` / `resume-launch` / `abandon-launch` | `launch` 可传 `includeImages: true` 将当前任务图片随首条消息发送；省略时仅发送文字。恢复时沿用首次请求。其余见[原操作输入](usage.md#存储与操作)。 | 原返回结构保持兼容 |

### 任务文件

Web RPC `files({ taskId? })` 返回 `{ files, limits, revision? }`。省略 `taskId` 只读取限制；`files` 列出图片与普通文件，含 `attachmentId`、`bytes`、可选 `name` 和 `mediaType`。可预览图片另含 `width` 与 `height`。`limits` 为 `null` 时宿主不支持任务文件服务；否则包含 `maxFiles`、`maxFileBytes`、`maxImageBytes` 和可预览的 `mediaTypes`。任务记录的 `fileCount` 为两类文件的总数，`imageCount` 仍只计图片。

在已认证的 Web 宿主上，`POST /api/dsh-plugin-tasks/file/upload?taskId=…&requestId=…&name=…` 接收原始文件字节，`GET /api/dsh-plugin-tasks/file?taskId=…&attachmentId=…&download=1` 下载任务中仍存在的附件。普通文件不支持内嵌；仅验证通过的图片可在省略 `download` 时内嵌。`remove-file` 接受 `{ taskId, attachmentId, requestId, expectedRevision }`，同时支持两类附件。已有图片接口与启动图片快照继续可用。

### 从当前任务会话 Fork

通过 `options({})` 的 `canFork` 判断当前宿主是否提供 Fork。不传 `forkFromSessionId` 时，`launch` 保持空白启动语义；要继承历史，传 `replaceActive: true` 和任务当前的 `activeSessionId` 作为 `forkFromSessionId`，并沿用当前 `expectedRevision`。Fork 继承父会话的目录与预设，不传 `workspaceId` 或 `agentPreset`。会话 ID 可能是裸 UUID，也可能是宿主分配的 `session-<UUID>`；请保留完整 ID。

客户端只使用同一个 `requestId` 恢复操作，不要创建一个新的请求来探测旧请求是否成功。`forking` 阶段尚无子 `sessionId`；此时不能向父会话发送首条消息，也不能根据会话列表推断子会话。若服务端不能确定目标，可显式 `abandon-launch` 结束本次操作，原绑定保持不变。已记录子 ID 时才可继续对该目标投递，启动完成后才切换绑定。

`list({})` 保持返回全部存活任务。指定 `limit` 或 `offset` 时增加匹配总数 `total`；`limit` 为 1–1000，`offset` 为非负整数。筛选条件按 AND 组合，结果保持原任务排序。分页不是跨请求的事务快照，拉取期间列表可能变化；需要完整一致基线时使用 `watch`。`externalRef` 筛选只接受下文五项身份字段，不包含 URL。

创建默认 `brief: ''`、`stage: 'todo'`；标题去除首尾空白。`requestId` 长度 1–128，字符为字母、数字和 `._~-`。创建请求 ID 在整个看板内唯一，建议使用带连接器/连接前缀的 UUID。更新请求 ID 在单个任务内唯一。不要用 TAPD 事项 ID 直接代替每次更新的请求 ID。

### 外部来源

```json
{
  "provider": "tapd",
  "connectionId": "22222222-2222-4222-8222-222222222222",
  "scopeId": "12345678",
  "objectType": "story",
  "objectId": "1123456789000000123",
  "url": "https://www.tapd.cn/your-canonical-item-url"
}
```

前五项构成来源唯一身份，`url` 不参与。`provider` 和 `objectType` 长度 1–64；`scopeId`、`objectId` 长度 1–128；`connectionId` 为连接器稳定 UUID。ID 必须为字符串。URL 可选，最多 2048 字符，仅允许 HTTP(S)，拒绝用户名/密码；连接器还需确保 URL 不含临时签名或凭据。

同一身份只能绑定一个存活任务，检查和写入位于同一队列。冲突返回 `tasks/external-conflict`，details 为 `{ taskId, reason: 'duplicate' }`。`connectionId` 参与身份，因此两个不同连接导入同一个远端对象可以产生两条任务；需要跨连接去重的连接器必须统一连接身份或先协调映射。

可以补充来源、更新同一来源的 URL、或通过 `externalRef: null` 解绑。非空身份直接换为另一身份返回 `reason: 'rebind-required'`，需先明确解绑。解绑后公开记录省略 `externalRef`。删除任务释放来源占用，但保留原创建请求的最小删除回执。

### 内容更新与重试

```js
const latest = await tasks.execute('get', { taskId })
if (!latest.ok) return latest

const input = {
  requestId: 'tapd.update.04d082e3',
  taskId,
  expectedRevision: latest.value.task.revision,
  patch: { title: '最新标题', brief: '转换后的普通文本描述' },
}
// 连接器在调用前持久化 input，未知结果时复用它。
return tasks.execute('update', input)
```

patch 至少包含一项，支持 `title`、`brief`、`externalRef`、`labelId`、`priority`、`dueDate`、`workspaceId` 和 `model`。缺省保持不变，`brief: ''` 清除描述。工作区和模型传 `null` 可恢复未分组或默认模型，选择具体值时校验宿主目录。修改的是以后启动任务的偏好，不迁移已绑定的会话。位置、会话、时间、revision 和私有回执不可直接修改；分类通过 `set-stage` 修改。

新请求检查 `expectedRevision`，冲突返回 `currentRevision`，由调用方重新读取和比较，不能自动覆盖。内容变化时增加 revision；完全同值时不增加版本、不发事件，但仍保存回执。

任务内容和 `_updates` 回执在同一 SQLite 行中提交。相同 `(taskId, requestId)`、相同标准化输入重试，先命中回执，不再检查当前版本或应用旧 patch。返回当前 task、原 `appliedRevision`、`replayed: true`。相同键却改变 patch 或原 expectedRevision 返回 `tasks/request-conflict`。回执存输入指纹，不重复保存整份正文，不出现在 RPC、Host 或 SSE 的公开记录中。

重启后重放仍有效；降低长度/回执容量限制不会拒绝已成功请求的重放。`maxUpdatesPerTask` 默认 10000，不静默淘汰回执。连接器应比较内容，避免轮询时反复提交无变化更新。删除后更新返回 `tasks/deleted`，不能恢复已删任务。

创建重试同样必须保持原始全部输入，包括初始 externalRef；后续更新不会修改初始创建意图。取消请求不保证副作用回滚。

连接器负责记录本地删除/解绑后的导入抑制状态，避免下一次同步立即重建；负责比较远端变更与上次同步基线，避免覆盖本地修改。任务插件不提供隐式 upsert。

## HTTP 与错误

RPC：`POST /api/dsh-plugin-tasks/rpc`；SSE：`GET /api/dsh-plugin-tasks/events`。RPC 保持原 `client-request` 信封：

```json
{
  "type": "client-request",
  "rpcId": "transport-id",
  "method": "dsh-plugin-tasks/rpc",
  "payload": {
    "operation": "create",
    "input": { "requestId": "connector.intent.001", "title": "来自外部插件的任务" }
  }
}
```

`rpcId` 只关联传输，不能代替持久化 `requestId`。合法信封下业务错误仍是 HTTP 200 / `result.ok: false`。业务码包括 `tasks/bad-request`、`tasks/not-found`、`tasks/deleted`、`tasks/revision-conflict`、`tasks/request-conflict`、`tasks/external-conflict`、`tasks/limit-reached`、`tasks/persistence-failed`、`tasks/persistence-unknown`、`tasks/unavailable`；原会话/选项目录错误保持不变。401/403 仍来自宿主认证及 owner/Host/Origin 策略。

## DSH 内置工具与 MCP 服务

DSH Host 提供工具注册表时，任务插件自动注册原生 `tasks_*` 工具，不写入 MCP 客户端配置、不需要本机密钥，遵守 DSH 的工具访问策略。停用插件会撤销注册。外部客户端仍通过显式配置连接 MCP；两种方式使用同一份共享看板。

HTTP 端点为 `POST /api/dsh-plugin-tasks/mcp`，使用标准 Streamable HTTP、无会话 ID、JSON 响应。GET 和 DELETE 返回 405；没有 MCP SSE 历史回放。服务支持初始化、工具发现和工具调用，关闭任务插件时撤销路由并释放运输实例。

| 工具 | TaskService 操作 |
| --- | --- |
| `tasks_capabilities` | `capabilities` |
| `tasks_options` | `options` |
| `tasks_list` | `list`；默认 limit 100 |
| `tasks_get` | `get` |
| `tasks_create` | `create` |
| `tasks_update` | `update` |
| `tasks_set_stage` | `set-stage` |
| `tasks_board` / `tasks_move` | 读取看板版本、列、标签与优先级 / 按列移动 |
| `tasks_edit_labels` / `tasks_edit_priorities` | 通过看板版本维护标签与优先级目录 |
| `tasks_comment` / `tasks_history` | 用同一 requestId 重试纯文本评论 / 按游标读详情动态 |

### 设置任务属性及维护目录

- 创建时调用 `tasks_create` 并传 `labelId`（从 `tasks_board` 查 UUID）、`priority`（目录里的键，例如 `P1`，不是显示名）、`dueDate`（用户本地日历日期，格式 `YYYY-MM-DD`，不带时间或时区）。三项均可省略。更新时在 `tasks_update.patch` 传对应字段，`null` 表示清除。
- `tasks_edit_labels`：`action: 'add'` 传 `name`、`color`（`#RRGGBB`）；`'edit'` 还需传 `labelId`；`'remove'` 只需 `labelId`。改名和改色不会修改任务中保存的 ID。
- `tasks_edit_priorities`：`action: 'add'` 或 `'edit'` 传 `key`、`name`；`'remove'` 只传 `key`；`'reorder'` 传 `key`、`before`（目标键或 `null`，表示放末尾）。键区分大小写、1–32 字符，显示名 1–80 字符。初始目录为 P0/P1/P2，自定义后按目录顺序显示。改名不改变任务中的键；为了兼容旧任务和连接器，任务字段仍接受目录之外的优先级值。
- 两个维护工具都要求 `expectedRevision: board.revision`，不是任务版本；操作成功后使用返回的新看板版本。遇到冲突或结果不明，先读 `tasks_board` 再决定是否重试。若标签或优先级仍被任务引用，移除返回 `tasks/label-in-use` 或 `tasks/priority-in-use`，不会清空现有任务。
- 优先级目录无须迁移已有任务。首次持久化自定义目录后，旧版插件的严格看板 Schema 不认识新字段，不要用旧版本直接打开已写入新目录的数据库。

**F3 / SQLite v7。** 可选 `labelId`、`priority`（P0/P1/P2）、`dueDate`（ISO 日历日期）支持 create/update；patch 传 null 清除。`completedAt` 仅由 Host 在进入 done 时记录，重开清空。`edit-labels` 校验看板 revision；修改定义不改任务。`list` 接受 `query/labelId/priority/due/today`；`due` 为 today 或 overdue，`today` 可显式指定查看者的本地日期。`comment-matches` 只返回命中评论的摘要。`history({taskId,limit?,before?})` 返回倒序 events 与下一页 before，不走 SSE。source 表示 Host 实际可见的调用通道（rpc/service/agent），不是经验证的人名；stdio 经普通 RPC 时不冒充可识别的用户。`comment({taskId,requestId,text})` 重试不重复，text 限 4000 字符。同一任务记录保存已提交的动态尾页；下一次写先把已提交的满页按稳定键归档，再原子替换任务和尾页。归档后若任务写失败，读取仍以旧尾页为准，重试覆盖同一归档页。删除后不可查动态，重启会补清已删除任务的归档。旧卡不合成历史。

每项工具都有独立输入 Schema。成功结果的 `structuredContent` 为 TaskResult，同时提供 JSON 文本；业务失败包含 `isError: true` 和原错误码。工具结构校验之外，所有业务规则由 TaskService 再次检查。第一版 MCP 不公开删除或启动会话。

宿主端点 `/api/dsh-plugin-tasks/mcp` 沿用 DSH 的 Cookie 认证，不接受任务密钥。独立的本机 MCP 监听器只绑定 `127.0.0.1`，使用任务专用 Bearer 密钥验证每次请求，拒绝浏览器 Origin 和常见转发标头。不要发布或转发本机端口。已通过验证并开始执行的操作不会因撤销而回滚。密钥的摘要保存在 DSH 凭据存储中，不写入任务记录、导出或日志；签发、更新和撤销要求宿主 owner 认证。设置方法见 [本机外部 MCP 客户端](../README.md#本机外部-mcp-客户端)。

旧的 stdio 桥接继续用 owner 方式：

1. 通过环境变量设置干净 Host base URL 和本次启动令牌。
2. 桥接使用 `/connect?token=...&interactions=none` 获取独立 API Cookie，连接宿主返回的 WebSocket 并保持它存活。
3. stdio 工具通过认证 HTTP RPC 调用同一 TaskService。stdout 仅用于 MCP 协议，不输出令牌。
4. 客户端退出时关闭 WebSocket，宿主撤销该 API Peer。Host 重启/连接失效时重启桥接，不自动重试未知写入。

`tasks/transport-unknown` 表示桥接未取得确认结果；带 `requestId` 的写入用原输入重试，只有版本检查的写入需先重读任务或看板。桥接不创建第二份任务存储。关闭 `mcpEnabled` 会关闭 DSH 内置工具和 HTTP MCP（含本机密钥接入）；已获 owner 权限的调用方仍可使用原 RPC，包括通过已有的 stdio 桥接。

同宿主的 Agent 插件也可导入 `createTaskMcpServer` from `dsh-plugin-tasks/mcp`，传入本次依赖分支的 TaskService，再连接自己拥有的 SDK transport。必须随分支释放 server，不保留卸载后的引用。

## SQLite 迁移与运维

**F4 / SQLite v8。** `images({})` 探测 `limits`（宿主不支持时为 `null`），`images({taskId})` 另返回该卡的原生图片引用与 `revision`。普通 `list/get/watch` 和 SSE 只在有图时携带 `imageCount`。通过已认证的 `POST /api/dsh-plugin-tasks/image/upload?taskId=…&requestId=…` 逐张发送二进制正文，Content-Type 为实际图片类型；不接受客户端填报的附件引用、文件路径或 URL。`GET /api/dsh-plugin-tasks/image?taskId=…&attachmentId=…` 只读取仍在该卡上的引用，不缓存。`remove-image({taskId,attachmentId,expectedRevision,requestId})` 解除关联，不删除共享对象。未知结果复用完全相同的请求重试；已变更的删除请求重新读取版本后用新的 requestId。以上不新增 MCP 工具，不向会话送图。

图片由宿主解码和内容寻址存储；只有原生对象成功保存后，卡片引用、回执和业务动态才在 SQLite 同一任务写中提交。若此时 SQLite 写失败，宿主可能保留未引用对象，不能凭卡片数自行删除（其他卡或会话可能共用）。停 Host 后同时备份 SQLite 和宿主附件目录；恢复时使用同一时间点的两份数据。v7→v8 不回填旧卡、不合成图片动态。

升级前停 Host 并备份数据库。v5→v6 先记下不含列 ID 的原记录摘要，再按原阶段补列 ID，最后一次写入全局列定义和版本。域版本戳即使已经是 6，中断后仍按摘要恢复，全部验证后才发布服务。不直接把 v6 数据交还 v5；恢复备份前先保留升级后的新写入。

使用发布版 `@deepseek-ai/dsh-storage-sqlite` 和 `DomainFacility`，不更改宿主默认 domain 路由。默认文件 `$DSH_HOME/storages/tasks.sqlite`，后端注册名 `tavlo-tasks-sqlite`。SQLite 内每任务是一行 JSON 文档（`u_tasks_tasks` 的 key/value），更新一行不再重写全部任务文件。当前仍使用 KV 查询接口，尚未增加历史统计或任意 SQL API。

首次打开目标 SQLite 时，通过宿主原 `storageDomain.open(tasks)` 读取已有来源，所以自定义过 JSON 根目录的部署也沿用原路由。新安装无旧记录时标记空迁移完成。

迁移先校验全部记录与跨记录身份，再保存来源快照指纹及 copying 标记，逐行复制，最后保存 complete 标记。完成之前不公开服务或路由。进程中断可从同一快照续传；已复制行不重复写入。来源或部分目标数据发生变化时拒绝继续，不猜测覆盖。恢复原来源快照后可重试；原文件不会被删除、改写或改名。

完成标记存在后，旧 JSON 不再读取；新任务、更新、启动进度和回执只写 SQLite。任务正文、排序、revision、工作区/模型、会话关联、完整启动回执与删除回执都保留。

- 升级和迁移期间停止旧插件写入；同一数据库只允许一个 Host 管理。
- 默认 WAL 适合本地磁盘；数据库运行时可能有 `-wal` / `-shm` 文件。备份或移动时先正常关闭 Host，再复制数据库；不要在运行时只拷贝主文件。
- 更换 `databasePath` 前应移动完整的当前 SQLite 数据。指向一个空路径会触发首次导入，旧 JSON 只代表升级时状态。
- 不支持直接降级到 0.1.x。它可能继续读取保留的旧 JSON，导致看不到迁移后的数据；保留该文件不意味着可以自动回滚。
- 损坏记录、重复来源、版本不兼容或结果未知都明确失败，不清库重建。结果未知时重启插件，重新读取已提交状态后用原请求重放。
- 更新回执与任务同一行原子提交；迁移采取可恢复的分阶段复制，不声称提供跨全部记录的一次性事务。
