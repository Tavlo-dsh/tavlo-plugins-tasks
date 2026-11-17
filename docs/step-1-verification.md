# 步骤 1 验证记录

2026-11-16，DSH 0.2.2-rc.1，profile `web`。步骤 1 交付时 Host 只返回 `{ tasks: [] }`；后续持久化和任务操作见 [步骤 2 验证记录](step-2-verification.md)。

## 最终调用方式

Host 注入 `connection`、`webServer`，通过 `connection.fetch.register()` 注册精确 POST `/api/dsh-plugin-tasks/rpc`，请求体模式为 `buffered`。Connection 自身处理 HTTP 鉴权、共享请求 waterfall、owner 检查、请求体上限和路由卸载。

Client 注入 `connection`，调用：

```js
await ctx.connection.rpc.call('/api', 'dsh-plugin-tasks/rpc', {
  operation: 'list', input: {},
}, signal)
```

Host 使用已发布的 `clientRequestSchema` 验证请求 envelope，校验操作输入，并返回：

```js
{
  type: 'server-response',
  rpcId: request.rpcId,
  result: { ok: true, value: { tasks: [] } },
}
```

Client Connection 负责响应 envelope 与 `rpcId` 验证。插件的列表数据源处理业务 failure 和传输 rejection，通过 slot `hooks: { tasks }` 提供 `useTasks(selector)`，并在卸载时取消请求和清空订阅。

## 原计划的实测修正

直接调用 `ctx.connection.rpc.handle('/dsh-plugin-tasks', handler)` 在真实 Web profile 和使用真实兄弟 WebServer provider 的自动测试中均失败，错误为：

```text
tavlo-tasks (dsh-plugin-tasks): Error: cannot get property "webServer" without inject
```

任务插件已声明 `inject = ['connection', 'webServer']`。Connection 的 `rpc` getter 捕获的上下文保留了 provider 的 shadow；`HostConnectionService.register()` 在 effect 回调中读取 `owner.webServer`，触发 Cordis 的定义侧服务检查。此前把 WebServer 提供在 root 的临时测试没有覆盖这个问题。

最终方案使用已有的精确 Fetch 扩展点，继续使用 Client 的官方 RPC caller。该路由先于 Gateway 的 `/api` RPC interceptor 分派，经过同一 Connection 鉴权和 owner 检查。没有修改内核，没有访问私有成员，也没有增加生成或构建步骤。

相关源码符号：

- `packages/client/connection/src/rpc-host.ts`：`rpc` getter、`register`、`registerFetchRoute`、`createSharedFetchHandler`。
- `packages/client/connection/src/index.ts`：`apply` 的 `/api` 鉴权与 `connection/request` waterfall。
- `packages/client/connection/src/client/rpc.ts`：`createWebConnectionRpc` 的请求封装、文档相对 URL 和响应验证。
- `docs/subsystems/slots.md`：`hooks` 注入生成 `useTasks(selector)`，selector 必须提供。

上述路径相对于 DSH 源码；运行时不依赖这个 checkout。

## 验证结果

`npm test`：11 项全部通过，使用发布版 Cordis 4.1.0、Connection/WebServer 0.2.2-rc.1 和真实 HTTP。测试覆盖：

- 实际插件 Host 与实际浏览器 ModuleLoader factory 读取空列表。
- 无 cookie 返回 401；不可信 Origin 返回 403；非 owner 的在进程调用返回 403。
- 未知操作、非法业务输入和非法 envelope 返回结构化 failure。
- 与占用 `/api` 的 RPC interceptor 共存；卸载后任务 Fetch 路由移除。
- 加载中不重复请求；业务失败、HTTP 失败和非法成功数据进入错误状态；重试恢复。
- Client 卸载取消未完成请求，并阻止迟到响应发布状态。

活 Web profile 验证：

- 现有本地 link 安装成功加载，侧栏入口可用。
- 三列均显示零计数和空状态，底部显示“暂无任务。”。
- 浏览器临时延迟任务请求时显示“正在加载任务…”；临时模拟 503 时显示错误及“重试”；恢复实际 fetch 后点击重试成功。
- 浏览器测试中的临时 fetch 覆盖已清除。

运行时依赖为 `@deepseek-ai/dsh-client-connection@0.2.2-rc.1`；Node 测试依赖只用于开发。npm 发布清单包含直接运行的 JS、补丁、资源和文档，不含测试、node_modules 或构建产物。干净 Web profile 的完整安装验收仍安排在步骤 5。

发布包已在临时独立目录用 `npm install <tarball> --omit=dev --ignore-scripts` 安装，Host 模块可直接导入，运行时依赖无需 checkout、开发依赖或构建步骤。此检查覆盖生产依赖解析；不等同于步骤 5 的完整 Web profile 验收。
