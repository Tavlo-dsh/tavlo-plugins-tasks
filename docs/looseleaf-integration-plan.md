# Looseleaf 视觉接入计划

> 后续用户反馈已实施：经典模式移除，选择框统一为纸面列表，遮罩和焦点样式调整，同时新增任务删除（存储 version 4）。本文中的双外观方案与 version 3 是最初计划背景，当前行为以 [任务删除与交互调整](task-controls-verification.md) 为准。

本计划为 DSH 任务插件引入纸张、手绘边框和墨迹标签的视觉，沿用现有三列布局与任务交互。实施采用小范围源码适配，继续使用手写 JS、共享宿主 React 和零构建发布。2026-11-17 用户提供官网截图后，视觉方向调整为明确的纸质桌面：米色纤维纸页、浅绿色桌面、胶带和荧光笔标记，替代最初偏克制的处理。

阶段 1 的审查与基线已完成。现在 `PaperFrame / TaskButton / StatusBadge` 已接入真实看板，默认纸面外观，顶栏提供纸面/经典切换；新建、启动和详情弹框也使用局部纸面样式。见 [当前接入记录](looseleaf-paper-verification.md)、[源码映射](looseleaf-source-map.md)、[源码锁文件](looseleaf-source-lock.json)；接入前数据仍保留在 [阶段 1 验证记录](looseleaf-verification.md)。完整阶段 5 的独立安装与全部业务场景验收仍按原计划执行。

## 1 接入路线

Looseleaf 官方以 shadcn registry 分发 TSX、Tailwind v4 样式和 Ink 绘制代码。当前插件入口是 `client.js` 的 ModuleLoader factory，使用 `require('react')` 获取宿主 React，并通过 `React.createElement()` 渲染。接入范围确定为 **Looseleaf 视觉适配层**：复用经审查的少量绘制源码及视觉规则，组件交互由现有插件承载；不承诺与上游 React 组件 API 等价。

| 决策 | 实施方式 |
| --- | --- |
| React | 继续共享 DSH 的 React 18；需要转发 ref 的组件使用 `React.forwardRef` |
| JS 与样式 | 手写可运行 JS、局部 CSS 与内嵌纸张纹理；开发及安装流程均保持零构建 |
| 绘制依赖 | 已核对 Button、Badge 和 Card/Paper 的源码依赖；实际只摘取两张原始纹理及稳定 seed 哈希，不带入完整绘制引擎 |
| 组件行为 | 使用原生 button、article、span、input、select、dialog；复用现有事件和操作状态 |
| 资源加载 | 必要资源随 tarball 分发，正常使用时无新增 CDN、字体或源码请求 |
| 上游维护 | 固定源码提交，记录每个复制文件、修改点和许可证，后续更新按差异审查 |
| 业务范围 | RPC、单一 SSE、启动恢复、Storage Domain version 3 继续由现有模块负责 |

首轮源码审查参考提交为 [`4bdb647940e2fefb3cebb394f3bad25c766a27d2`](https://github.com/kevintngo/looseleaf/commit/4bdb647940e2fefb3cebb394f3bad25c766a27d2)。正式复制源码时记录同一提交下的文件与哈希；线上 registry 是可变地址，不能与该提交默认视为同一快照。

若希望完整采用上游 InkProvider、Radix 组件和主题，则需要另行采用 TSX/Tailwind 构建与 React 兼容适配。该路线改变当前开发约束，不作为本轮实施前提。

## 2 视觉与组件范围

整体采用用户指定的官网纸质风格：两张原始纸张纹理提供纤维与纸面颗粒，局部 CSS 实现绿色桌面、胶带和荧光笔高亮。标题、描述和状态仍保持中文可读性，暗色主题降低纹理的视觉强度，不把原版 InkProvider 当作运行依赖。

| 当前位置 | 目标组件或样式 | 首轮要求 |
| --- | --- | --- |
| `TaskCard` | `PaperFrame` | 保留 article、两行描述和元信息；装饰放在文字与操作后方 |
| 新建、开始、恢复、打开对话 | `TaskButton` | 主次操作层级明确；原生 disabled、pending、焦点和按钮类型保持有效 |
| `data-task-status` 状态行 | `StatusBadge` | 文字配合颜色，覆盖全部运行状态；样式不改变状态判断 |
| 三列标题与计数 | 局部纸签样式 | 保留分类、折叠、计数和完成列最近 10 条逻辑 |
| 告警条 | 轻量提示纸条 | 展示任务名、原因和打开入口，易于扫描和键盘操作 |
| `CreateForm`、`LaunchForm` | 纸面表单与弹框外观 | 已同步实施，继续使用现有 `Modal` 与原生表单控件 |
| 搜索、筛选和操作菜单 | 输入框与菜单样式 | 已同步实施，保留既有搜索、筛选、菜单与焦点行为 |

正文、中文标题和控件文字继承 DSH 字体。首轮不增加字体包；手绘辨识度主要由边框、底色和标签提供。装饰 SVG 使用 `aria-hidden`、`focusable="false"` 和 `pointer-events: none`，避免截获点击或进入键盘顺序。

运行中、待审批、待回答、出错、空闲、未启动、丢失、归档、未知状态均有明确文字。审批与回答使用高关注色，错误使用警示色；这些颜色在亮暗主题中分别校验，不能仅凭颜色区分状态。

## 3 客户端组织与样式隔离

首轮在现有 `client.js` factory 内划分视觉 token、纹理与 seed、展示组件三个局部区域，避免引入新的客户端模块加载方式。`TaskCard`、表单和看板组合这些组件；展示组件只接收 props，不访问 Connection、Session 或存储服务。

```text
现有任务数据对象和操作回调
        ↓ props
TaskBoard / TaskCard / CreateForm / LaunchForm
        ↓ 组合
PaperFrame / TaskButton / StatusBadge
        ↓
局部 CSS token + 内嵌纹理 + 稳定背景偏移
```

所有新样式以 `.dsh-tasks-root[data-tasks-appearance="paper"]` 为作用域，变量采用 `--dsh-tasks-*` 命名。优先映射宿主的背景、文字、边框和状态色；若适配代码必须使用 `--ll-*`，仅在该根节点内声明别名。

DSH 已通过根节点 `color-scheme` 和 `body[data-ds-dark-theme]` 应用主题。纸面样式从宿主继承亮暗模式；必要时用该属性限定局部覆盖。接入过程不写宿主主题属性，不引入全局 `:root` token、Tailwind preflight 或 body 字体样式。

原生 dialog 虽进入浏览器 top layer，仍保留原 DOM 继承关系；继续放在任务根节点下，可沿用局部 token。验收应覆盖 `::backdrop`、焦点恢复、Esc、提交中关闭和长表单滚动。以后若引入 Portal，需为 Portal 容器单独传递同一局部主题。

为避免看板状态更新引起装饰跳动，绘制 seed 来自稳定的任务 ID 与组件角色。相同尺寸、seed 和样式参数应产生相同结果。优先使用可缩放 SVG 与 CSS，不引入每张卡的轮询、动画循环或布局测量；确需尺寸观察时，明确所有者、缓存与卸载清理，并在性能验收中单独测量。

预览阶段提供任务看板内的“纸面 / 经典”外观切换，标签页使用独立的 sessionStorage 键保存选择。该选择只影响展示，不写入任务记录，也不依赖 Host RPC；存储不可用时保留内存选择。经典外观作为即时回退入口。

外观切换主要改变根节点属性和样式，保持组件类型、key 与表单 DOM 稳定，避免重新挂载 dialog、丢失输入选区或打断待确认操作。

## 4 分阶段实施

| 阶段 | 工作与产物 | 进入下一阶段的条件 |
| --- | --- | --- |
| 1 源码范围与基线（已完成） | 已固定 60 个审查文件与完整 MIT 许可；明确无外部依赖的限定函数移植范围；留存经典亮暗截图、85,050 字节客户端及 100/500 卡片实测基线 | 已满足；详见 [阶段 1 验证](looseleaf-verification.md)，无新增运行依赖或构建步骤 |
| 2 三组件预览（已实现） | `PaperFrame`、`TaskButton`、`StatusBadge` 与外观切换已运行在隔离 Web profile；保存亮暗截图 | 已检查全部状态样本、装饰稳定性、焦点与窄屏；量化对比度仍列入最终验收 |
| 3 接入真实看板（已实现，完整业务验收待补） | 三组件已用于实际 Client，保持既有 props、操作回调和状态 | 68 项自动化测试通过；本轮浏览器使用内存 RPC/SSE 样本，双页真实写入与完整启动流程仍需最终验收 |
| 4 表单与弹框（已实现，完整场景验收待补） | 新建、启动、恢复、详情、搜索和菜单外观统一；保留 native dialog 与表单语义 | 已检查输入/选区/DOM 保留、Tab、Esc、焦点恢复、窄屏弹框；全部失败提示及长表单场景仍需最终验收 |
| 5 回归与独立安装（部分完成） | 本轮完成单元回归、隔离宿主视觉检查、性能对比与包内容核验，见当前接入记录 | 200% 缩放、量化对比度、独立 tarball 运行及完整业务场景未作为本轮通过项 |

第一批交付阶段 1–3：可在真实看板切换的三组件视觉。第二批完成阶段 4–5：表单统一与完整分发验收。每批都保持可运行，不把新增业务功能混入视觉接入。

## 5 验收标准

以下性能数字为实施预算；本轮实测及尚未通过的项目见 [当前接入记录](looseleaf-paper-verification.md)，不能把预算视为已达标结果。

| 方面 | 验收要求 |
| --- | --- |
| 阅读与主题 | 中文正文及普通控件文字对比度至少 4.5:1，必要边框与焦点标识至少 3:1；浅色、深色及宿主主题切换均清晰 |
| 布局 | 在 1366 和 1024 px 桌面视口验证完整任务流程；另测 768/375 px 窄屏和 200% 缩放。任务根节点内可控滚动，页面不新增不可操作的横向溢出；弹框操作始终可达 |
| 键盘与触控 | 操作可用 Tab、Enter/Space；弹框焦点限制与恢复有效；桌面交互目标至少 24×24 CSS px，粗指针场景优先 44×44；视觉不靠 hover 才能发现 |
| 动态效果 | 遵循 `prefers-reduced-motion`；强制色彩模式保留可见边框和焦点；状态更新和主题切换不改变卡片排布或装饰 seed |
| 功能 | 现有 64 项测试继续通过；新增测试只覆盖实际增加的外观切换、装饰稳定性、焦点或生命周期行为，避免为纯颜色值增加测试 |
| 恢复 | 覆盖模型失败、响应丢失、投递后绑定失败的界面；切换外观、断线、重连和刷新不丢失已保留的启动请求 |
| 宿主隔离 | 对话页、设置页、侧栏和宿主按钮样式保持基线；没有第二份 React 或 Hook/Ref 警告；每个 Client 仍只有一条任务 SSE |
| 包体预算 | 首批新增 JS 与 CSS 的 gzip 合计目标不超过 30 KiB；首轮不计入任何新增字体，因为首轮不引入字体 |
| 渲染预算 | 100/500 张卡片分别测挂载、搜索和连续状态更新；相同环境预热后各测 5 次取中位数，目标相对经典外观退化不超过 15%；超预算先减少装饰复杂度 |
| 生命周期 | 新增监听、缓存和观察器均有明确上限或清理；反复进入看板和卸载插件后不继续绘制或观察 |
| 安装 | tarball 包含适配代码、资源和许可；隔离 DSH home 仅安装生产依赖即可运行，控制台无新增错误 |

## 6 文件安排与回退

| 文件 | 计划改动 |
| --- | --- |
| `client.js` | 局部视觉 token、展示组件、外观状态、现有看板与弹框组合 |
| `licenses/looseleaf-MIT.txt` | 实际复用上游源码时保留完整 MIT 许可 |
| `docs/looseleaf-source-map.md` | 记录上游提交、原文件路径、哈希、移植范围与本地修改 |
| `package.json` | 将许可及实际新增资源纳入发布文件清单；根据实际需要核对依赖 |
| `tests/client.test.mjs` 及必要的视觉适配测试 | 保留功能回归，覆盖新增外观选择与生命周期行为 |
| `docs/screenshots/`、`docs/looseleaf-verification.md` | 亮暗效果、表单与状态截图、性能对比、独立安装证据 |
| `README.md` | 外观选择、适配范围和维护说明 |

运行中可直接切回经典外观。若需要撤回整批视觉改动，仅撤回展示代码与相关资源，任务数据和启动记录继续使用原 schema。撤回时不得降级到不识别 version 3 的旧任务插件。

## 7 依据

- [Looseleaf 官方介绍与许可说明](https://github.com/kevintngo/looseleaf/blob/4bdb647940e2fefb3cebb394f3bad25c766a27d2/README.md)：源码分发、React/Tailwind/Radix 技术栈、MIT 与字体许可。
- [官方安装与 registry 说明](https://github.com/kevintngo/looseleaf/blob/4bdb647940e2fefb3cebb394f3bad25c766a27d2/notes/registry.md)：Tailwind v4 前提、安装时的源码依赖规模及非 TSX/Windows 验证限制。源码大小不等于最终浏览器包大小。
- [组件注册表](https://kevintngo.github.io/looseleaf/r/card.json)：Card 依赖 Paper、Ink 与主题；[Button](https://kevintngo.github.io/looseleaf/r/button.json) 和 [Badge](https://kevintngo.github.io/looseleaf/r/badge.json) 还带有 Radix/CVA 源码依赖。
- [当前 Client](../client.js)、[现有实施约束](implementation-plan.md)、[当前功能验收](m3-verification.md)：接入方式、业务基线与零构建要求。
