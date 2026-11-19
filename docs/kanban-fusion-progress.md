# 任务看板融合进度

最后更新：2026-11-18。**F5 已完成隔离 Web 联动、打包升级与恢复验收；尚未发布，原生桌面与实体触屏待验。** 范围与顺序见[融合计划](kanban-fusion-plan.md)，冻结基线见 [F0 契约](kanban-fusion-f0.md)。

## 已核对的基线

| 对象 | 当前状态 | 依据 |
| --- | --- | --- |
| Tavlo 实施底座 | `dsh-plugin-tasks` 0.2.0，Git `HEAD` 为 `ad16cf4`；另冻结当时含未提交的 TaskService、MCP、SQLite 和外观插槽的 40 个文件（含锁文件）。 | [基线清单](../../artifacts/kanban-fusion-f0-20261118/manifest.json)、[服务契约](task-service.md) |
| Tavlo 冻结时的流程 | 三列、菜单改列、居中新建和只读详情、启动与恢复、会话状态及跨页 SSE，支持跟随全局／iOS 圆角／纸面外观。F1 替换新建和详情，不改变原有列和会话语义。 | [F0 契约](kanban-fusion-f0.md)、[当前使用说明](usage.md) |
| dsh-kanban 对照版本 | 1.11.2，提交 `6dc28f1`。已在隔离的同一 DSH Web 0.2.2-rc.1 安装两款插件：上游实际拖拽、刷新后顺序和 PNG 预览通过；Tavlo 仅冒烟旧流程。 | [浏览器结果](../../artifacts/kanban-fusion-f0-20261118/browser-probe.json) |
| F0 回归 | 冻结源码解包并重新安装锁定依赖，97 项通过；加入 SQLite v5 升级夹具后，工作区 **98 项通过，0 失败、0 跳过**。 | [基线日志](../../artifacts/kanban-fusion-f0-20261118/baseline-tests.log)、[新增回归](../tests/fusion-baseline.test.mjs) |

用户提出的方向：新建和详情都改成右侧抽屉，加入卡片拖拽，把标签、时间、截图和时间轴做成任务卡的主要能力。计划建议同时纳入列新增、改名和排序，保留 Tavlo 的执行、同步与接入能力。

## 里程碑进度

| 编号 | 交付 | 状态 | 下一步 |
| --- | --- | --- | --- |
| F0 | 确认融合基线与契约 | 已完成 | 已冻结源码和旧数据夹具、记录后续 v5→v6 回填、重放及 SSE 兼容规则，并确认 D1。 |
| F1 | 新建与详情抽屉 | 已完成（Web） | 三列共用宿主模态层抽屉。复用原创建、更新与启动接口，没有数据库升级。 |
| F2 | 自定义列与卡片拖拽 | 已完成（Web） | 已验证全局列管理、真实拖动、键盘菜单、双页同步、v5 升级与中断恢复。未发布。 |
| F3 | 卡片属性与协作动态 | 已完成（Web） | 标签、优先级、日期、Markdown、评论、活动及组合查找；按反馈整合列入口和组件，三种外观共用边缘拖动抽屉。 |
| F4 | 图片上传与原生预览 | 已完成（Web，卡片内图片） | 隔离 Host 验证选择／粘贴／拖入、单图失败与丢回包重试、宿主预览、双页计数及移除。启动前明确提示图片不随消息发送。 |
| F5 | 执行联动与首发验收 | Web 候选通过；实机待验 | 已验证同一 home 旧包升级、连接器/MCP/看板联动、停机成套备份和独立 home 恢复。发布前补实机验收并确认发布版本。 |

## F1 验证与重跑

- [全量回归](../../artifacts/kanban-fusion-f1-20261118/tests.log)：100 项通过。新增客户端用例通过真实 Host 验证详情更新丢回包后只提交一次，以及版本冲突时保留本地输入；原创建草稿、重试、启动和恢复用例继续运行。
- [Web 验收报告](../../artifacts/kanban-fusion-f1-20261118/browser-probe.json)：4 组 Tavlo 抽屉检查通过，含建卡、编辑、关闭、宽度、键盘焦点、三种外观和双页同步。使用临时 DSH Web profile 和合成任务，不修改个人数据，不调用真实模型。[抽屉探针](../scripts/kanban-fusion-f1-drawers.mjs)可重跑；同批的 4 组上游检查不是 Tavlo 的 F2/F4 验收。原生桌面 Host 未验收。
- 重跑：在插件目录运行 `npm test`。参照 [F0 探针环境](kanban-fusion-f0.md#隔离-web-探针)设置 CLI、浏览器、Playwright 和上游包路径。将 `FUSION_PROBE_OUTPUT` 指向新目录，在该目录中放入 `npm pack` 生成的当前 Tavlo 包并将 `FUSION_TAVLO_PACKAGE` 指向它；额外将 `FUSION_F1_THEME_PACKAGE` 指向含外观选择器的主题包，然后运行 `node scripts/kanban-fusion-probe.mjs`。不设置主题包的默认模式仍用于验证 F0 冻结包。

## F2 验证与重跑

- `@dnd-kit/core@6.3.1` 随 Tavlo 客户端打包，React、ReactDOM 和模态层复用宿主；不需要安装 `dsh-kanban`。看板与管理列抽屉复用同一拖拽组件。拖动时显示浮层和放置目标，仅在放手时提交；以 Host 回执或 SSE 确认结果为准，取消或失败无需回滚其他页面的排序。
- [回归日志](../../artifacts/kanban-fusion-f2-20261118/tests.log)：103 项通过。[F2 服务用例](../tests/board.test.mjs)覆盖旧订阅不跳号、列的删除保护与重排、锚点冲突、重启后的顺序、回填中断后的恢复。原 v5 固定夹具验证除新增列 ID 外，旧记录和回执逐项保持一致。
- [隔离 Web 报告](../../artifacts/kanban-fusion-f2-20261118/browser-probe.json)和[实测截图](../../artifacts/kanban-fusion-f2-20261118/tavlo-f2-board.png)：4 组 Tavlo 检查，验证自定义列建卡、列内／跨列拖动、Esc 取消、键盘菜单、刷新恢复，以及第二页即时看到改名和列排序。其余 4 组是上游对照，不算入 Tavlo。未操作个人数据；原生桌面 Host 和实体触屏不在本轮验收内。
- 用同一个 F2 安装包[复跑 F1 抽屉](../../artifacts/kanban-fusion-f2-20261118/f1-regression/browser-probe.json)，四组 Tavlo 检查均通过，包括默认、iOS、纸面外观、窄屏、焦点恢复和跨页编辑冲突。
- 重跑：在插件目录 `npm ci`、`npm test`，再 `npm pack`（自动执行 `npm run build`）。沿用 F0 的 CLI、浏览器、Playwright 和上游包环境，将 `FUSION_TAVLO_PACKAGE` 指向刚生成的包，设置 `FUSION_F2=1` 和新的 `FUSION_PROBE_OUTPUT`，运行 `node scripts/kanban-fusion-probe.mjs`。

## F3 验证与重跑

- [全量回归](../../artifacts/kanban-fusion-f3-20261118/tests.log)：107 项通过，无跳过。[协作用例](../tests/collaboration.test.mjs)覆盖同阶段异列、完成与重开、今天与逾期边界、标签保护、评论重试、归档中断与跨页游标；旧 v5 夹具不新增历史完成时间。MCP 支持发现列、移卡、评论和查历史，未开放删除或启动。
- [F3 Web 报告](../../artifacts/kanban-fusion-f3-20261118/final/browser-probe.json)：真实新建带属性的任务、安全 Markdown、评论和评论摘要、叠加筛选、刷新后重新打开。[抽屉复测](../../artifacts/kanban-fusion-f3-20261118/ui/browser-probe.json)：实拖左边缘、键盘微调和重开保宽，390px 全宽、焦点往返、双页冲突和三种主题。参见[纸面列管理](../../artifacts/kanban-fusion-f3-20261118/ui/tavlo-columns-paper.png)与[iOS 列管理](../../artifacts/kanban-fusion-f3-20261118/ui/tavlo-columns-ios.png)。同批上游检查不计作 Tavlo 图片验收。
- [列与拖拽复测](../../artifacts/kanban-fusion-f3-20261118/columns/browser-probe.json)：同包验证列管理、真实拖放与取消、筛选态菜单、刷新和双页排序；更换按钮组件没有破坏 dnd-kit 把手。
- 重跑：沿用 F2 的隔离环境，运行 `npm test`、`npm pack`，以 `FUSION_F3=1` 运行 `scripts/kanban-fusion-probe.mjs`。取消该标志并传 `FUSION_F1_THEME_PACKAGE` 可重跑可调宽度和三主题验收。没有迁移个人数据库；原生桌面与实体触屏留待发布前验收。

## F4 验证与重跑

- [全量回归](../../artifacts/kanban-fusion-f4-20261118/tests.log)：111 项通过，无跳过。[附件测试](../tests/images.test.mjs)覆盖 v7→v8、原生服务缺失时文字可用、引用读取范围、大小／格式／数量限制、跨重启重试、旧请求不复活已移除的图片、SQLite 拒写与不确定提交。附件字节不进入任务库，完整引用不进入普通列表或 SSE。
- [DSH Web 报告](../../artifacts/kanban-fusion-f4-20261118/final/browser-probe.json)：Tavlo 三组验收。临时 Host 实际接收 PNG/JPEG/WebP，拒绝伪装成 PNG 的文本；第二张先上传失败，再在重试成功后丢回包，使用相同请求 ID 再试，未重复建卡或添图。验证刷新后图片可读、Esc 从预览回到缩略图且保留未保存描述、移除后另一页计数同步，以及启动不送图提示。另四组上游对照不计入 Tavlo 验收。
- 截图：[宿主原生预览](../../artifacts/kanban-fusion-f4-20261118/final/tavlo-f4-preview.png)、[纸面](../../artifacts/kanban-fusion-f4-20261118/final/tavlo-f4-paper.png)、[iOS](../../artifacts/kanban-fusion-f4-20261118/final/tavlo-f4-ios.png)。重跑：`npm test`、`npm pack`，沿用 F0 的隔离环境和本次安装包，设 `FUSION_F4=1`，传入 `FUSION_F1_THEME_PACKAGE` 后运行 `node scripts/kanban-fusion-probe.mjs`。未替换个人插件、未操作个人数据、未调用模型。

## F5 验证与重跑

- [候选包](../../artifacts/kanban-fusion-f5-20261118/dsh-plugin-tasks-0.2.0.tgz)摘要 `0b7eb6a5a652708a457518791acedd759e1a3dc6829a4d7e813e4825042bcdfb`。[全量回归](../../artifacts/kanban-fusion-f5-20261118/tests.log)：112 项通过，0 失败、0 跳过。用受控会话驱动验证连接器建卡、启动中断、原会话恢复、MCP 评论和手动完成；没有向真实模型发消息。
- 同一包重跑 [F1 抽屉](../../artifacts/kanban-fusion-f5-20261118/web-f1/browser-probe.json)、[F2 拖拽](../../artifacts/kanban-fusion-f5-20261118/web-f2/browser-probe.json)、[F3 协作](../../artifacts/kanban-fusion-f5-20261118/web-f3/browser-probe.json)、[F4 图片](../../artifacts/kanban-fusion-f5-20261118/web-f4/browser-probe.json)。另外在无上游、无主题扩展的 profile 验证共享列和标签、跨两工作区/未分组筛选、断线期间另一页移卡、重连保草稿，以及宿主深浅切换。
- [F5 报告、操作步骤与放行条件](kanban-fusion-f5.md)：实际旧包装入合成数据 → 停机备份 → 同一 home 升 v8 → 写入原生图片并停机备份 → 产生新写入 → 另一个空 home 恢复。核对任务、活动、顺序、回执和图片字节，未覆盖新写入；不等于验证整机灾备或第三方远端同步。

## 已确认事项

- **D1 · 总看板范围：**保留一个 Tavlo 总看板，默认展示所有工作区的任务，也包含未分组任务。列和标签定义全局共用；选择工作区或「未分组」只筛任务，不切换看板，也不改变任务归属。

## 待拍板事项

| 编号 | 需要决定 | 建议默认 | 最晚确认 |
| --- | --- | --- | --- |
| D2 | 卡片截图是否必须随启动任务的首条消息发给 Agent？ | F4 已按默认方案验收：仅在卡片内保存与预览，启动前提示不送图；未将“开始 F4”视为送图授权。 | 如首发必须送图，在 F5 发布前变更范围并独立验收真实收图与中断恢复。 |
| D3 | 是否有正在使用的 `dsh-kanban` 看板需要切换到 Tavlo？ | 没有真实存量则不做导入。有则先确认工作区、卡片与附件范围，再决定是否将一次性导入纳入首发。 | 首版排期前；不影响抽屉和列的开发。 |

## 更新记录

- 2026-11-18（F5 桌面与触屏）：同一候选通过三组 Chromium 触摸模拟及 112 项回归。Tavlo 1.0.0 便携实机环境已隔离准备，核对配置及单实例拒启保护；未接管日用桌面，实体手指操作仍待人工签收。[报告与启动步骤](kanban-fusion-f5-desktop.md)。

- 2026-11-18：完成两款插件的对比与首版范围草案；重跑融合前回归。未改动插件实现，未运行真实用户数据迁移。
- 2026-11-18（F0）：冻结并复跑 Tavlo 源码，加入可复用的 SQLite v5 夹具；两个插件在隔离 Web Host 共存，实际拖拽及预览探针通过。明确 F1 不沿用 `showModal()` 叠加预览，v6 升级留到 F2；未操作个人数据或启动模型。
- 2026-11-18（D1）：用户确认 Tavlo 总看板展示所有工作区的任务。按单看板、共享列和标签、工作区仅作筛选实施，F0 至此完成。
- 2026-11-18（F1）：Tavlo 新建与详情改为右侧抽屉。验证发现看板可能先收到 SSE、随后才收到保存回执；验收脚本等待回执解锁后再关闭。保留三列和 SQLite v5，没有开始 F2。
- 2026-11-18（F2）：以 Tavlo 为唯一写入端交付列管理和 dnd-kit 拖拽；保留原三阶段、旧 SSE 及创建重试语义。v6 已在隔离 SQLite 验证，不在个人库演练升级。
- 后续每个里程碑记录负责人、实际状态和验证证据（变更、命令结果或截图）。区分「已实现待验收」与「已验收」；受阻时记录阻塞原因和解除条件。拍板结论写入本页并同步到融合计划。
