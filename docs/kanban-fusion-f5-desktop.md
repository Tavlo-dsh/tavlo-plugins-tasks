# F5 实机交接：Windows Tavlo 与触屏

**待签收的是 Tavlo 桌面壳（Tauri/WebView2）和实际手指输入。** 用 Chrome 运行 `dsh web` 不是桌面壳验收；CDP 合成触点也不是实体触屏。2026-11-18 检查时，本机日用 Tavlo 已在运行。桌面壳是单实例，第二次启动可能只唤起原窗口，因此没有在日用实例安装候选、导航、退出或发送输入。Windows 报告 `SM_DIGITIZER=193`、`SM_MAXIMUMTOUCHES=10`，说明系统声明支持集成多点触摸，不证明有人操作过屏幕。

## 已通过的模拟检查

同一 F5 候选在独立 DSH Web profile 中用 Chromium 触摸输入验证：从卡片正文滑动时列实际滚动、任务未变；把手拖动再取消无写入，落入空列只增加一个版本，刷新仍在新列；从抽屉左边缘向左滑 60px，抽屉变宽 60px，重开记住宽度；390px 宽时占满屏幕，点按预览关闭回到缩略图焦点。[本次报告](../../artifacts/kanban-fusion-f5-20261118/touch/release-probe.json) · [窄屏预览](../../artifacts/kanban-fusion-f5-20261118/touch/touch-preview-390.png) · [112 项回归](../../artifacts/kanban-fusion-f5-20261118/touch/tests.log)。

重跑时沿用 [F5 探针环境](kanban-fusion-f5.md#如何重跑)，在运行 `node scripts/kanban-fusion-f5-release.mjs` 前设 `$env:FUSION_F5_TOUCH='1'`，输出指向新目录。复核既有候选时直接设置 `FUSION_TAVLO_PACKAGE` 为已验收的包，无需重新打包。触摸探针只在恢复出来的测试副本上新增卡片，不修改恢复来源。

## 启动隔离桌面

在插件仓库的 PowerShell 中运行；仅使用可信的本地便携包和 F5 候选。**准备**可与日用实例同时进行：脚本只在新建的临时目录解出 exe、创建便携标记、使用单独 `DSH_HOME` 离线安装插件，并写入合成任务配置，不启动窗口。不要省略 `DSH_HOME`：便携标记只隔离 WebView 和桌面设置，不能单独隔离宿主数据库。

```powershell
.\scripts\kanban-fusion-f5-desktop.ps1 -PortableZip '<Tavlo 便携压缩包路径>' -Candidate '<F5 候选安装包路径>' -DshCli '<DSH CLI bin.js 的绝对路径>'
.\scripts\kanban-fusion-f5-desktop.ps1 -OpenPrepared '<上一步打印的临时目录>'
```

**打开**前请自行保存工作并从托盘退出日用 Tavlo，或在另一台触屏测试机准备并打开。若桌面进程仍在，脚本会拒绝启动，不会强停。看到 `F5 touch 1` 等 12 张合成卡再开始；若看到个人任务，立即停止。`prepared.json` 记录便携包、exe 和候选包摘要，F5 候选以 `0b7eb6a5…42bcdfb` 识别。勿提交含登录 URL 的 Host 日志。

## 实机判据（均待勾选）

| 操作（用手指，不用触摸板或鼠标替代） | 通过判据 |
| --- | --- |
| 从卡片正文上下滑动，再从标题点开卡片 | 列确实滚动；滑动不打开抽屉、不改卡片顺序；单击才打开右侧详情。 |
| 从点阵把手拖卡到空列，再重启隔离实例 | 只移动选中的卡，重启仍在目标列；普通滑动不被把手抢占。 |
| 在桌面宽度从抽屉左边缘向左拖，再关闭重开 | 宽度跟随手指、重开保宽；在正文上滑动只滚动，不调宽。 |
| 选一张合成 PNG，在详情写未保存描述，点缩略图，再点预览关闭 | 回到同一详情；草稿仍在，焦点回到缩略图（可用 Tab 检查）。 |

桌面壳最小窗口宽为 900px，390px 全宽抽屉单列作 Web 窄屏验收，不强行要求桌面窗口缩到 390px。实测后记录 `日期 / 设备型号 / Tavlo、WebView2 与 DSH 版本 / 候选摘要 / 各项结果及失败步骤`，再更新发布清单。退出从托盘选「退出」；只关闭主窗口可能仍在托盘运行。
