# F0：融合基线与兼容契约

日期：2026-11-18。F0 已完成。本文记录融合前验证和后续实施规则，不代表抽屉、拖拽或升级已在 Tavlo 实现。

## 冻结基线

| 项目 | 冻结内容 |
| --- | --- |
| Tavlo | `dsh-plugin-tasks` 0.2.0，`HEAD` 为 `ad16cf4a7e3fd1915951e74b715011849d722c4e`，以当时工作区的 40 个文件为准。包含未提交的 TaskService、MCP、SQLite、锁文件，也包含 `tavlo-tasks.appearance` 插槽及现有跟随全局／iOS 圆角／纸面外观。不是旧发布包。 |
| 上游 | `@alpacachen/dsh-kanban` 1.11.2，源码对照 `6dc28f10587b7b0d38c93b380fa3077b8ac3304e`；浏览器验证使用本地已有的 1.11.2 安装包。 |
| 环境 | Windows、Node.js 24.18.1、npm 11.16.0、DSH 0.2.2-rc.1 Web。桌面端尚未验证。 |
| 回归 | 从冻结归档解出并逐文件校验 SHA-256，使用 `npm ci --no-audit --no-fund` 安装，`npm test` 97 项通过。加入 F0 升级样本后，工作区 [98 项通过](../../artifacts/kanban-fusion-f0-20261118/f0-regression.log)，0 失败、0 跳过。 |

本地证据目录：[artifacts/kanban-fusion-f0-20261118](../../artifacts/kanban-fusion-f0-20261118/)。`manifest.json` 记录源码、锁文件和上游安装包摘要；`tavlo-source.tar.gz` 可解到空目录复跑基线，`baseline-tests.log` 保留结果。归档只含源码、脚本、测试和许可，不含旧截图、原型、`.git`、`node_modules` 或 DSH 用户数据。由归档生成的 `dsh-plugin-tasks-0.2.0.tgz` 仅用于探针，不是发布包。整个过程不需要提交、重置或覆盖现有工作区。

冻结后工作区 `client.js` 另有一行样式过渡变更。归档与浏览器结果保留原冻结版本；并行变更未被覆盖，工作区回归已重跑。F1 从届时的工作区继续，不用归档覆盖源文件。

## 已确认的看板范围（D1）

Tavlo 保留一个总看板，默认展示所有工作区的任务，包含未分组任务。列和标签定义全局共用；工作区选择仅筛选当前视图，不切换看板、改变任务归属或影响 `list({})` 的全量读取。

## 旧入口的兼容规则

| 边界 | 必须保留的行为 |
| --- | --- |
| 数据与入口 | `taskService` 仍是唯一写入口，继续提供契约 1；现有 RPC 路径、7 个 MCP 工具、参数与返回的既有字段不变。`list({})` 仍读全量，不按看板范围隐式过滤；MCP `tasks_list` 的默认分页仍为 100。新增读写能力先声明能力再调用，不向旧入口加入必填项。 |
| `stage`、`columnId`、会话 | `stage` 只有 `todo / doing / done`；`columnId` 独立且必须指向该阶段的列。会话待审批、待回答、运行或空闲不改变列。老 `create` 只指定 `stage` 时选对应默认列；老 `set-stage` 同阶段不挪列，保留现有版本递增语义；跨阶段进目标默认列，继续保留原 `position`。新拖拽操作才显式更新列内位置。 |
| 启动与恢复 | 仅当首条消息成功提交且卡仍在 `todo` 时，自动移到默认 `doing` 列；保留活动／历史会话、待恢复阶段、原会话 ID 和消息请求 ID。拖动、编辑、删卡不启动或停止会话。 |
| 回执与连接器 | 创建重放仍比较原始意图，返回同一任务的当前状态；更新重放保持原指纹与 `appliedRevision`；删除回执不能复活任务。来源唯一键仍为 `provider / connectionId / scopeId / objectType / objectId`，长 ID 继续是字符串。迁移不更改 `revision`、`createdAt`、`updatedAt`，也不重算任何回执。 |
| 并发与排序 | 新移动提交任务版本、目标列和卡片锚点（要么在锚点前／后，要么明确放到末尾）。Host 校验锚点仍在目标列；冲突读最新状态，不按筛选下标硬写。取消不写入，写入成功才广播；需要重排多行时，先验证原子提交或可恢复方案。 |

## F2 升级路线：SQLite domain 5 → 6

1. **保留原导入路径。** v1–v4 JSON 仍按原任务 schema 校验与复制，原文件和既有 `migration: copying/complete` 语义不变。SQLite 已标记导入完成则不再读旧 JSON；切勿把两份数据重新合并。
2. **增加看板升级标记。** 建议 SQLite domain v6 兼容打开 v5，在启动、发布服务前完成校验和回填。旧任务按 `stage` 映射到固定列 ID `stage:todo`、`stage:doing`、`stage:done`；显示名与 ID 分离。保留全部 `position`（包括间隔、并列时的 ID 次序）和删除墓碑，不回填历史完成时间，不生成虚假时间轴。
3. **中断可续。** rc.1 的公用存储接口不提供任意多行事务，第一次有效写入就可能升级版本戳。先记录回填中与基线摘要，再逐条写入可重复的映射，最终校验原字段、列和阶段后标记 `complete`；不能仅看版本戳判断完成。中间状态不开放 RPC、MCP 或 SSE；发现缺行、字段不符、坏数据则拒绝打开，不清库重建。
4. **备份与恢复。** 停 Host 后备份 SQLite 及附件存储，先用隔离副本演练。v6 不直接交回 v5 读取；有新版写入时先保留新版库并明确恢复范围。旧库、旧 JSON 和备份均不作为新 Host 的第二写入源。

升级夹具：[fusion-v5.fixture.mjs](../tests/fusion-v5.fixture.mjs)。固定 ID 的四张有效卡覆盖三个阶段、非连续排序、未知完成时间、工作区／模型、外部来源、当前与历史会话、处于 `sending` 的待恢复启动；另含一个删除墓碑。用[基线测试](../tests/fusion-baseline.test.mjs)写入真实临时 SQLite，已验证重开、创建／更新／删除重放、来源去重、按原会话与消息请求 ID 恢复。会话服务用测试替身，无模型调用。F2 用同一 v5 数据重跑「回填、中断重启、重复启动、旧调用」；本轮只验证 v5，不宣称 v6 迁移通过。

```powershell
node --test tests/fusion-baseline.test.mjs tests/migration.test.mjs
npm test
```

## 同步与业务时间轴

- **旧 SSE 不变。** 现有 `/api/dsh-plugin-tasks/events` 和 `watch` 仍先给 `snapshot`，再给连续 `sequence` 的 `upsert / remove / status / unavailable`。旧客户端会拒绝未知事件和序号缺口，不能给它推 `board` 增量，也不能只过滤该事件却跳号。
- **新看板订阅显式协商。** 建议通过能力声明选择看板版 SSE，每页仍只连一条。初始快照在同一串行队列读任务、会话状态和列配置；卡片写入沿用已提交的任务序号，列／标签定义有独立 `boardRevision`。纯定义变更只推给新订阅，不消耗旧任务序号。保留 RPC 回执与任务 `streamId / sequence` 的对应关系；断线或重启以新快照重建，两套读者均需回归测试。
- **业务活动独立持久化。** F3 只记录已提交的创建、字段变更、跨列、完成／重开、评论、附件及启动绑定，不把 SSE 持久化成历史。同列排序、瞬时会话状态、迁移、重放不刷活动。rc.1 下优先将待归档活动与任务变更一起写入同一记录，再按稳定事件 ID 幂等归档；详情读取须涵盖尚未归档的已提交事件。历史分页，不进入普通 `list` 或 SSE 快照。归档故障和重放必须纳入验收。
- **完成时间不是更新时间。** 迁移的 `done` 卡未知留空；之后首次进入 `done` 写入实际时间，在 `done` 列之间移动不重记。重开清空当前完成时间，不删历史完成事件。

## 隔离 Web 探针

[kanban-fusion-probe.mjs](../scripts/kanban-fusion-probe.mjs) 安装两个插件包到临时 `DSH_HOME`，使用回环地址、测试工作区和无真实模型的配置；仅在临时配置关闭账号和模型引导，避免遮挡看板。原版 Tavlo 只做加载、SSE 和新建弹框冒烟；拖拽、抽屉和 PNG 上传走上游真正的界面和 Host 路由，不拦截业务响应。探针只写测试数据，报告和截图不含授权 URL 或个人任务。

**实测结果：** DSH Web 0.2.2-rc.1、Chrome 157.0.8103.79、Playwright Core 1.58.2，5 项检查通过。详见 [browser-probe.json](../../artifacts/kanban-fusion-f0-20261118/browser-probe.json)。

| 验证项 | 结果及对融合的影响 |
| --- | --- |
| 原版 Tavlo | 冻结包在同一 Host 加载，实际 SSE 已连接，原有新建弹框可开关。 |
| 上游拖拽 | 真实鼠标操作完成同列重排、拖进空列，两次刷新均保持结果；取消未写入，也未误开详情。用 API 与 `.dsh-kanban.json` 核对已提交状态。[拖拽结果](../../artifacts/kanban-fusion-f0-20261118/upstream-drag-persisted.png) |
| 上游抽屉与图片 | 从详情上传合成 PNG，通过认证读取并验证字节长度、摘要和五字段引用。一次 Esc 只关宿主原图预览，焦点回缩略图且保留未保存标题；再关闭抽屉，焦点回原卡片。[抽屉](../../artifacts/kanban-fusion-f0-20261118/upstream-drawer.png) · [原图](../../artifacts/kanban-fusion-f0-20261118/upstream-native-preview.png) |
| 原生弹框冲突 | 在同页对照：临时原生 `showModal()` 打开后，挂在 `body` 的宿主预览关闭键无法获得焦点。F1 采用宿主 `useModalLayer` 处理抽屉和焦点，不以现有原生弹框直接套预览。 |

这些是宿主和上游方案的可行性证据，不是 Tavlo 新抽屉或拖拽已验收。未验收新版 Tavlo 排序、真实数据升级、键盘／触屏拖拽、桌面 Host 或带图启动。

从 `tavlo-plugins-tasks` 目录执行，先准备 DSH 0.2.2-rc.1、Chrome 或 Edge，以及临时安装的 `playwright-core@1.58.2`：

```powershell
$artifacts = (Resolve-Path ../artifacts).Path
$baseline = Join-Path $artifacts 'kanban-fusion-f0-20261118'
$env:DSH_CLI = '<DSH 安装目录>/lib/bin.js'
$env:PLAYWRIGHT_MODULE = '<测试工具目录>/node_modules/playwright-core/index.mjs'
$env:BROWSER_EXE = '<Chrome 或 Edge 可执行文件的绝对路径>'
$env:FUSION_TAVLO_PACKAGE = Join-Path $baseline 'dsh-plugin-tasks-0.2.0.tgz'
$env:FUSION_KANBAN_PACKAGE = Join-Path $artifacts 'alpacachen-dsh-kanban-1.11.2.tgz'
$env:FUSION_PROBE_OUTPUT = Join-Path $baseline 'rerun'
node scripts/kanban-fusion-probe.mjs
```

通过时写 `browser-probe.json` 和三张截图，临时 Host 关闭并回收。失败日志只留在终端提示的临时目录，不要发布其中的 `host.log`。现有上游包的 `dnd-kit` 随客户端编译，React／ReactDOM 和宿主原语保持外置；F2 采用这个加载方向，不直接把上游的 JSON 看板、路由或数据写入逻辑移进 Tavlo。
