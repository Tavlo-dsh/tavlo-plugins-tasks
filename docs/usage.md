# 使用与实现参考

安装、配置和界面预览见 [项目 README](../README.md)。本页保留完整操作说明、接口约定和验证记录。

## 实现与验证

单任务启动、任务会话关联和派生状态已接入。启动面板选择工作区、模型和智能体预设，编辑一次性首条消息；成功后绑定会话并打开对话。卡片显示执行中、待审批、待回答、出错、空闲，以及会话丢失、归档或状态不可用。告警条汇集未完成任务的审批、回答和错误状态。多个页面共用各自的一条 SSE 连接，自动同步任务和状态，断线后恢复完整快照。

Host 使用 `connection.fetch.register()` 提供 RPC 与 SSE 两条精确路由，Client 操作使用 `connection.rpc.call()`，实时通知使用同源 Fetch 流。直接注册独立 `rpc.handle()` 在 DSH 0.2.2-rc.1 的真实 Loader 中触发注入错误，详见 [步骤 1 验证记录](step-1-verification.md)。持久化验收见 [步骤 2](step-2-verification.md)，界面操作见 [步骤 3](step-3-verification.md)，实时同步与重启恢复见 [步骤 4](step-4-verification.md)，独立安装见 [步骤 5](step-5-verification.md)。单任务启动与恢复的证据和验证范围见 [M3 验证记录](m3-verification.md)。

当前看板和弹框截图、工作区/模型偏好及兼容验证见 [看板与弹框验证](ui-verification.md)。

任务看板默认跟随 DSH 外观。可选安装独立的 `dsh-plugin-paper-theme`，在全局设置启用纸面主题后，看板才显示 Looseleaf 纸纹、胶带与高亮；任务页没有独立主题开关，也不依赖主题插件才能运行。工作区、模型等始终使用同一套自定义选择列表，支持删除任务。当前主题适配见 [全局主题适配](global-theme-adaptation.md)，删除与交互基线见 [任务删除与交互调整](task-controls-verification.md)，此前视觉接入过程见 [纸面接入记录](looseleaf-paper-verification.md)。

## 使用看板

侧栏打开「任务」，点击「新建任务」，在弹框填写标题和可选描述，可选已有工作区和模型偏好。默认未分组、使用默认模型，只有标题必填。列底「新建」预选该列分类。保存成功后任务出现在所选分类；工作区/模型仅作为后续启动任务的偏好保存，本步不创建会话。

卡片标题打开完整详情，右上「任务操作」菜单可改列或删除。详情底部也提供删除入口；确认后移除任务卡片，关联对话会保留并继续运行。尚未结束的启动请求需先恢复或结束，防止删除其恢复入口。删除与其他更新发生版本冲突时，需要刷新并重新确认；结果未知时重试同一次删除。

搜索即时匹配标题和描述，筛选菜单可按工作区过滤；列计数在筛选时显示「匹配数 / 总数」。点击列标题折叠，完成列默认显示最近更新的 10 条，可查看全部。工作区、模型、分类与预设使用自定义列表，外观随全局主题，支持方向键、Home/End、Enter 和文字前缀匹配；菜单点击外部、焦点离开、窗口失焦或 Esc 时关闭。

其他页面新建或改列后，卡片和计数自动更新，当前草稿、搜索和筛选条件保留。底部显示实时连接状态；断线时提示任务可能过期并自动重连，顶部「刷新」也可重新读取 Host。实时通知与当前操作交错产生版本冲突时，会显示原先想要移入的分类；刷新后可按新数据重新选择。

创建期间禁止重复提交。普通业务失败保留可编辑的输入；创建结果未知时锁定原输入，点击「重试」复用同一创建请求，避免重复任务。草稿和待确认请求保存在当前标签页的 `sessionStorage`，页面刷新后可继续；成功后清除。浏览器禁用该存储时只在当前 Client 生命周期内保留，关闭标签页或清除浏览器存储也会丢失草稿。

改列结果未知时先刷新确认已保存的分类，避免盲目重复写入。列表加载失败时保留上次已加载的卡片、提示数据可能过期，并暂停写操作；重试成功后恢复。存储状态不确定时隐藏旧卡片并提示重新启用插件或重启 DSH。

## 启动与恢复

点击卡片「启动任务」。工作区和模型预填任务偏好，预设可选择宿主目录中的可用项；首条消息预填标题和描述，临时修改不回写任务。未指定工作区时使用宿主默认目录并保持未分组。选择具体模型会同时更新 DSH 全局默认模型，面板有明确提示。模型正常执行需要可用的模型配置和凭据。

启动成功后设置 `activeSessionId`，只把 `todo` 自动改为 `doing`；其他手工分类保留。已有会话优先「打开对话」；空闲时可勾选「新开一个对话」，旧引用进入历史。运行、排队或等待输入中的会话禁止替换；状态不可用时界面也不开放替换。改列本身不启动、取消或停止会话。

启动过程先保存请求与预分配的会话 ID，再创建会话、选择模型并投递消息。失败后的「恢复启动」复用同一会话与 DSH 消息请求 ID。浏览器未收到结果时保留原请求，刷新后仍可恢复；Host 已保存的启动也可从其他页面恢复。消息尚未开始投递时可以「结束本次启动」，其会话引用留在任务历史中，然后重新配置启动。进入投递阶段后仅允许恢复，避免把未知结果误当成未执行。

状态不落库。Host 对活跃会话 ID 去重，响应宿主事件并每 `statusRefreshMs`（默认 2000 ms，范围 500–60000）被动采样；该采样补足 DSH `observeState` 不通知独立 pending-input 变化的限制。只在空闲且日志游标改变时读取最近 turn 结果。每个浏览器仍只有一条任务 SSE，增加卡片不会增加浏览器会话连接。待审批和待回答在现有对话中处理。

## 存储与操作

任务使用 Host 的 `storageDomain` 服务，domain 名 `tasks`、version 4，`compatibleVersions: [1, 2, 3]` 接受旧记录，写入时由后端更新版本标记；不清空或重建旧记录。删除会用同一次持久化写入移除任务正文、绑定和启动历史，仅保留任务 ID、创建请求 ID、删除版本与时间的最小回执，防止旧创建请求重试使任务复活；回执不计入 `maxTasks`。旧版插件不能读取 version 4，升级后不要直接降级。默认 Web 配置使用 JSON 后端，文件位于 `$DSH_HOME/storages/tasks.json`；实际位置由宿主存储后端配置决定，不是 profile 目录。插件不接受客户端指定文件路径。

各操作均通过 `{ operation, input }` 调用现有 RPC endpoint：

| operation | input | 成功 value |
| --- | --- | --- |
| `list` | `{}` | `{ tasks }` |
| `create` | `{ requestId, title, brief?, stage?, workspaceId?, model? }` | `{ task }` |
| `set-stage` | `{ taskId, expectedRevision, stage }` | `{ task }` |
| `delete` | `{ taskId, expectedRevision }` | `{ taskId, revision }`，重复删除返回同一回执 |
| `options` | `{}` | `{ workspaces, groups, presets, workspaceStatus, modelStatus, modelFailures }` |
| `launch` | `{ taskId, expectedRevision, requestId, content, workspaceId?, model?, agentPreset?, replaceActive? }` | `{ task, sessionId }` |
| `resume-launch` | `{ taskId, requestId }` | `{ task, sessionId }` |
| `abandon-launch` | `{ taskId, requestId, expectedRevision }` | `{ task }` |

创建默认进入 `todo`，`revision` 为 1；`set-stage` 接受 `todo / doing / done`，成功后递增版本。`model` 为 `{ provider, model, reasoningEffort? }`，空偏好不写入记录。工作区与模型是弱引用，新创建时校验当前目录是否存在；已有记录的引用失效不影响列表和原请求重试。

工作区通过 `ctx.get('workspaceRegistry').list()`、模型通过 `ctx.get('sessionController').modelCatalog()` 读取。目录服务可选，没有服务时仍允许不绑定创建。`requestId` 是 1–128 字符的标识，接受字母、数字及 `._~-`；创建结果未知时必须复用同一标识和全部相同参数重试，包含初始分类、工作区和模型。相同请求返回当前已有任务，参数不同返回 `tasks/request-conflict`。创建请求元数据与任务一同持久化，不出现在 RPC 的 TaskRecord 中。

`cordis.patch.yml` 可配置 `maxTitleLength`（默认 200）、`maxBriefLength`（默认 20000）和 `maxTasks`（默认 10000）。降低限额不会使已有记录失效，也不阻止重放已完成的创建请求。

`maxLaunchesPerTask` 默认 1000，限制新启动的历史条数；已有请求仍可恢复或重放。任务公开当前 `launch` 的请求与进度，完整 `_launches` 去重历史只保存在 Host。启动响应只表示消息已被 DSH 接收，执行成功与否由会话状态显示。请求取消不意味着已执行操作回滚；插件重新加载后不会自动发送未完成请求，需用户点「恢复启动」。

实时通道为 GET `/api/dsh-plugin-tasks/events`，复用 Connection 的鉴权与 owner 检查。每次连接从完整快照开始，再发送已持久化的任务变更。`eventBufferBytes` 限制每个连接的待发队列（默认 32 MiB，范围 64 KiB–256 MiB）；慢客户端超限后断开并通过快照恢复。完整快照超过该上限时返回 HTTP 503、`tasks/events-too-large`，需要提高限额才能恢复实时流；RPC 读取仍可用。`eventHeartbeatMs` 默认 15000，范围 1000–60000，代理需要允许流式响应并保持连接超过心跳间隔。

Client 以 1、2、4、8、15 秒退避重连，上限 15 秒；稳定连接 30 秒后恢复初始退避。首次快照等待上限 30 秒，已建立连接连续 90 秒没有收到数据时重新连接。完整页面离开时暂停，返回时恢复；看板内的卡片和视图切换不增加连接。插件卸载关闭流并停止重连。

普通写入失败返回 `tasks/persistence-failed`；后端报告结果不确定时返回 `tasks/persistence-unknown`，停止返回可能过期的数据，需重新启用插件或重启 Host 后恢复。损坏记录会使插件初始化失败，不能用空列表掩盖。插件卸载会等待已经接纳的操作完成，再关闭 domain。

JSON 后端的版本检查和操作队列保护同一 Host 内的并发；同一任务文件需要由一个 Host 进程写入，未提供跨进程写入协调。

## 结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包清单；`dsh.bundle.patch` 声明 Loader 补丁，`dsh.client` 声明浏览器半边 |
| `cordis.patch.yml` | 插入 `tavlo-tasks` 这一行 |
| `index.js` | Host 半边，打开存储并注册鉴权 RPC 和 SSE 路由 |
| `task-schema.js` | 持久化字段、创建元数据和输入校验 |
| `task-store.js` | 列表、创建去重、版本更新与操作清理 |
| `task-options.js` | Host 工作区/模型目录读取、显式偏好存在性检查 |
| `task-events.js` | 有队列上限的实时事件流、心跳、取消和卸载清理 |
| `task-sessions.js` | Session 创建、模型选择、消息去重重放和状态聚合 |
| `client.js` | 浏览器半边，看板与操作、共享实时流和断线恢复 |
| `locale/*.json` | 插件管理里显示的标题与描述 |
