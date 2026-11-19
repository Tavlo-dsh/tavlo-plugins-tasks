# 可选全局纸面主题适配

**当前组件约定（F3）：** 所有任务按钮（包括拖拽把手、选择器触发器）共用 `TaskButton`，使用 DSH `Button`，适配 [UIArc Button](https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/registry/components/button/button.tsx) 的尺寸按压反馈、浮层锚点例外及 loading 语义。只在按压时测宽，减少动态效果时不缩放，不打包第二份 React 或 Motion；许可见 `licenses/uiarc-MIT.txt`。纸面继续使用既有 Looseleaf 移植，iOS/跟随宿主不加载另一套全局皮肤。输入使用宿主 `Input`、`Checkbox`，标签和优先级使用 `Tag`，选项统一用已有 `PaperSelect`。多行文本需要 Enter 换行、显式提交，不能套用 Enter 即保存的 `InlineEditor`。日期/颜色保留 Input 内系统选择器，隐藏表单字段不渲染额外控件。新增界面遵守同一边界，不直接散放原生按钮。

> 本文记录初次接入全局纸面主题时的行为。当前支持在看板工具栏切换「跟随全局 / iOS 圆角 / 纸面主题」，见 [使用说明](usage.md)。

日期：2026-11-17。本记录取代历史验证文档中“纸面为唯一外观”的当前状态描述；旧记录保留当时的测试事实。任务页的「纸面 / 经典」开关仍然不存在。

现在默认使用宿主语义颜色。独立 `@tavlo-dsh/dsh-plugin-paper-theme` 启用时，通过 `body[data-dsh-paper-theme="paper"]` 选择任务纸面装饰，并继承 `--dsh-paper-*` 色板。关闭、禁用或移除主题后，CSS 自动回到宿主外观，无任务状态重建、偏好存储、额外观察器或主题监听。

改动仅限 Client 展示：移除固定 `data-tasks-appearance="paper"`，主题标题通过 CSS 切换；将自定义选择列表的基础布局和输入焦点反馈从纸面规则移入通用规则；移除默认浅色硬编码，使用宿主变量。纸面纹理、胶带、高亮继续限于任务场景。菜单关闭逻辑、选择键盘行为、任务创建/删除/启动/搜索/筛选/同步代码未重构。

Host、schema、store、options、events 与 sessions 文件均未改动。version 4、兼容读取 version 1/2/3 和删除回执语义保持原样。原有 76 项回归测试通过；其中历史的“永远纸面”断言改为可选全局主题约束。

两张 Looseleaf PNG 与种子算法无修改，完整 MIT 许可与固定来源记录仍保留。全局主题插件本身不复制纹理，也不是任务插件的 npm 依赖。

实际浏览器结果、截图及尚未验证范围集中在主题插件 `docs/verification.md`。历史 `looseleaf-baseline.mjs` 的强制外观性能比较属于旧版基线，不代表当前主题；本轮以真实全局设置切换验收。
