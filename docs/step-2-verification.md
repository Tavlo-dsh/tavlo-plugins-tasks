# 步骤 2 验证记录

2026-11-16，DSH 0.2.2-rc.1，profile `web`。Host 持久化与任务操作已完成；Client 表单、真实卡片和列切换属于步骤 3。

## 实现

- `task-schema.js` 声明 domain `tasks`、version 1，校验基础 TaskRecord 和内部 `_create` 创建元数据。
- `task-store.js` 提供串行 `list / create / set-stage`，在持久化成功后才更新去重索引、排序值及返回成功。
- 创建默认 `todo`、revision 1。同一 `requestId` 重放返回当前已有记录；参数改变返回冲突。内部创建元数据与任务一次写入，重新打开时重建去重索引。
- `set-stage` 使用 `KvTable.update()` 的原子回调比较 `expectedRevision`，成功后递增 revision，不改变创建时间或其他字段。
- `index.js` 在 domain 和记录关系检查完成后才注册现有 `/api/dsh-plugin-tasks/rpc`；初始化失败不会注册路由或返回空列表。
- 插件卸载先停止接纳新操作，等待插件操作队列完成，再关闭 domain。普通存储失败返回结构化错误；`unknown-state` 隔离后必须重新打开，Client 提供重新启用插件或重启 DSH 的提示。

默认配置为 `maxTitleLength: 200`、`maxBriefLength: 20000`、`maxTasks: 10000`，可在补丁中修改。降低限额不会使旧记录失效，已完成创建请求仍可重放。运行时依赖为发布版 Connection 0.2.2-rc.1、Schemastery 3.19.0、Zod 4.4.3；没有构建或代码生成步骤。

## 自动测试

`npm test`：25 项全部通过。覆盖实际插件、发布版 Storage/Domain/JSON 后端、WebServer、Connection 和签名 cookie，使用隔离的临时存储目录：

- 创建和修改后再次读取；关闭并创建新的 Host 后恢复相同任务与 revision。
- 八个并发创建重试仅产生一条记录；改变参数得到创建请求冲突。
- 两个使用同一 revision 的并发修改仅一个提交，另一个返回当前版本。
- 输入长度、任务容量、未知字段及非法 stage 拒绝；容量满或限额降低后仍可重放已有请求。
- 写入失败后内存和磁盘保持原值，随后可成功重试。
- 已落盘但结果不确定的模拟提交使读取隔离；重新打开后按创建请求恢复且不重复。
- 损坏记录、key/id 不一致和重复创建标识使初始化失败，原文件保持不变；修复后可重新启用。
- 卸载等待已经接纳的操作完成；排队期间取消的创建不写入。
- 继承步骤 1 的鉴权、非 owner 拒绝、Gateway 共存、Client 加载和重试验证，并验证存储不确定的恢复提示。

## 真实 profile 验证

用 `dsh --profile web --patch <storage.overlay.yml> --no-open --port 0` 启动现有本地 link profile，只将 JSON 存储根目录覆盖到临时目录。没有把验证任务写入实际的 `C:/Users/1/.dsh/storages/tasks.json`。

首个进程通过官方 Client Connection caller 完成创建、改为 `doing`、旧 revision 冲突和创建重试；列表中只有一条任务，revision 为 2。所有 RPC 写入完成后停止验证进程，以相同覆盖配置重新启动新的 DSH 进程：读取结果保持相同 id、stage、revision 和时间戳，重放相同创建请求仍只得到一条记录。无凭据请求返回 401。

干净 Web profile 的完整界面安装验收仍在步骤 5。

`npm pack` 已确认包含 `index.js`、`task-schema.js`、`task-store.js`、`client.js`、补丁和文档，不含测试、node_modules 或 checkout 文件。tarball 在独立临时目录通过 `npm install <tarball> --omit=dev --ignore-scripts` 安装；Host 模块可直接导入，Config 默认值校验成功，不需要构建或开发依赖。

## 已确认的存储约束

默认 Web bundle 的 JSON root 为 DSH home 的 `storages`，本机任务文件对应 `C:/Users/1/.dsh/storages/tasks.json`，不是 profile 目录。部署可通过宿主 Storage Domain 路由和 backend root 改变位置；插件只使用注入服务。

JSON 后端单文件原子替换保护同一 Host 内的操作，不提供跨进程写入协调。一个任务文件需由一个 Host 进程写入；跨 profile 或跨进程共享同一文件的并发不在本次保证内。

源码依据（相对于 DSH checkout）：`packages/storage/storage-domain/src/index.ts` 的 `DomainFacility.open()`、`packages/storage/storage-domain/src/domain.ts` 的 `KvTable.update()`/写入队列/`close()`、`packages/storage/storage-json/src/atomic.ts` 的 `writeAtomic()`，以及 `packages/bundle/base/cordis.patch.yml` 的默认 Storage 配置。运行时不依赖源码 checkout。
