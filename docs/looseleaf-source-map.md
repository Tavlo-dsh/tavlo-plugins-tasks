# Looseleaf 源码范围与移植映射

审查及适配日期：2026-11-17。上游固定为 [`kevintngo/looseleaf@4bdb647940e2fefb3cebb394f3bad25c766a27d2`](https://github.com/kevintngo/looseleaf/tree/4bdb647940e2fefb3cebb394f3bad25c766a27d2)。阶段 1 完成来源与基线审查后，用户明确要求接近官网截图的纸质感；本轮据此扩大到两张原始纸张纹理、胶带纸签和荧光笔列头，已接入真实看板。组件仍为本地 React 18 适配。

## 固定快照与许可

[机器可读清单](looseleaf-source-lock.json) 记录 60 个审查文件的原路径、字节数、完整 SHA-256 和 Git blob SHA-1，包含三个入口的 42 个源码模块（含类型与 barrel 导出）及 13 个 registry 条目。下载内容逐个与该提交的 Git tree blob 校验；没有使用线上可变 registry 作为源码快照。registry 中的 URL 仅用于解析依赖名称，审查内容取自同一提交的 `public/r/*.json`。

实际复制清单：

| 上游文件 | 本地文件 | 修改 | SHA-256 |
| --- | --- | --- | --- |
| `LICENSE` | `licenses/looseleaf-MIT.txt` | 无，保留完整原文与换行 | `5a7c48962dbd30f330cba18a0f39c28b1e7be566f8d7786f3db148b326b44b38` |
| `src/lib/ink/textures-paper.generated.ts` | `client.js` 的 `PAPER_SLIP / PAPER_FIBRE` | 仅摘取两个 PNG data URI，字节及平铺尺寸不变 | 原文件完整哈希见锁文件，两个 PNG 哈希见下文 |
| `src/lib/ink/rng.ts` | `client.js` 的 `avalanche / paperSeed` | `hashSeed` 改名，限定字符串输入，去除 TS；保留哈希运算及回退值 | `aadd28b9a9430a127238668d584ebbd600a73d26311ca2c4a908835bdc5f6251` |

许可为 MIT，署名为 `Copyright (c) 2026 Looseleaf contributors`。适配段已标注提交与许可，复制范围和修改同步记录在锁文件。没有复制字体或上游 TSX，也没有引入纹理生成器。字体包各自的许可不被 MIT 通知替代；本轮不分发它们。

## 三组件的实际依赖

| 上游入口 | 直接源码依赖 | 递归引入的主要内容 | 本地实现决定 |
| --- | --- | --- | --- |
| `src/components/ui/button.tsx` | React、CVA、Radix Slot、`useInk / useMergedRef / IconSizeContext`、`buttonRecipe`、`cn` | recipe → fills / geom / shapes / rng → builder / pen / pens / paint / textures；React hook → cache / defs / SVG | 原生 button；只借用静态轮廓、填充层次与 calm 规则，保留当前事件、disabled、pending、type 和焦点 |
| `src/components/ui/badge.tsx` | 同上，改用 `badgeRecipe / tallyWidth` | 同一绘制引擎；tally、hover、focus 多图层 | 原生 span，文字与状态色来自现有状态；首轮不移植 tally、asChild 或交互标签 |
| `src/components/ui/card.tsx` | `Paper`、`useInk / useMergedRef`、`cardRuleRecipe`、`cn` | Paper → edges / faces / props / sheet-layers / shadows / stocks / Tape；再进入 Ink、生成纹理及 recipe 引擎 | `PaperFrame` 保留 article，复用两张静态纸张纹理；胶带与荧光笔由本地 CSS 伪元素实现，不移植 Tape 或 Ink |

`cn` 继续引入 `clsx` 与 `tailwind-merge`。源码闭包共发现 React、`class-variance-authority`、`radix-ui`、`clsx`、`tailwind-merge` 五个外部 import；它们是上游完整组件的依赖，不是本插件要新增的依赖。

固定提交中 registry 的完整关系为：

```text
button / badge → ink + looseleaf-theme
card → ink + looseleaf-theme + paper
paper → ink + ink-paper + looseleaf-theme + tape
tape → ink + ink-paper + looseleaf-theme
ink-paper → ink
ink → ink-grain-textures + ink-paper-textures
looseleaf-theme → font-kevin-sans + font-ibm-plex-mono
utils → clsx + tailwind-merge
```

这 13 个条目含 44 个去重源码文件、522,013 字节内嵌源码；此数不包含 theme 的 CSS 对象、npm 包及字体，也不是浏览器产物或 gzip 大小。theme 另声明开发依赖 `tw-animate-css`，IBM Plex 条目声明 `@fontsource/ibm-plex-mono`。完整路径、依赖与哈希见清单，不能用两个组件 TSX 的大小估算直接安装成本。

## 已确认的兼容边界

- 上游 `package.json` 明确使用 React 19；Button/Badge 将 `ref` 当 props，使用 `<IconSizeContext value={...}>`；`useInkBox` 的 ref callback 返回观察器清理函数。当前 DSH 的 React 18 不接受这些写法作为同等替代。本地需要 ref 时使用宿主 `React.forwardRef`，不带入上游 hook。
- `src/lib/ink/react/defs.tsx:94` 的 `ensureInkDefs()` 首先调用 `ensureInkFonts()`，后者会向 head 加入 `https://kevintngo.github.io/looseleaf/fonts/kevin-sans.css`。因此仅移除页面字体声明仍不能确保零 CDN；本轮完全不使用该路径，也不向 body 注入全局 SVG defs。
- `useInkBox` 使用共享 ResizeObserver 和逐宿主尺寸读取，Provider 使用 MutationObserver，cache/defs 维护模块级状态。本地静态纹理 + CSS 无需引入这些生命周期所有者。
- `src/styles/looseleaf.css` 含 Tailwind、动画、字体 import、全局 `:root` 与主题规则。不能直接作为普通 CSS 导入现有页面。纸面装饰限定到 `body[data-dsh-paper-theme="paper"] .dsh-tasks-root`，从全局主题继承语义颜色，并保持宿主字体。

## 已实施的限定移植

纸面装饰现在由可选的全局主题控制，任务页内原“纸面 / 经典”切换仍保持移除。任务纸面 CSS 作用域改为 `body[data-dsh-paper-theme="paper"] .dsh-tasks-root`，颜色读取全局主题的 `--dsh-paper-*`；没有新增复制范围。以下内容已复制进 `client.js`，其余源码 import、类型与导出均未引入。原计划中的完整 makeRng 与几何点列没有实际需要，因此未复制。后续自定义选择列表与菜单关闭逻辑为本地实现，没有新增复制上游源码。

| 原文件 / 完整 SHA-256 | 摘取范围与真实运行依赖 | 本地位置与修改 |
| --- | --- | --- |
| `src/lib/ink/rng.ts`<br>`aadd28b9a9430a127238668d584ebbd600a73d26311ca2c4a908835bdc5f6251` | `avalanche` 与 `hashSeed` 的字符串分支，只依赖 Math | 本地 `paperSeed(task.id + ':paper')` 生成稳定背景偏移；无时间、随机挂载 ID、缓存或观察器 |
| `src/lib/ink/textures-paper.generated.ts` 的 `PAPER_SLIP.uri` | PNG 20,322 字节，256×256，CSS 平铺 128×128 | 原 URI 直接内嵌；当前只应用于纸页与卡片，通过共享 wash token 降低强度，工具栏、弹框和选择浮层保持干净底色；PNG SHA-256：`d482ca23ac111d544bb6b6fb7803cee88e25d7c72d93d94482991d6dc96f1694` |
| 同文件的 `PAPER_FIBRE.uri` | PNG 3,525 字节，480×480，CSS 平铺 240×240 | 原 URI 直接内嵌，作为纤维层；PNG SHA-256：`62e0029469c1f1523a6682d0a56e8e44a02de9ba00bdb197882806185958bcd9` |

配合全局主题 0.1.2 的展示调整仅改变 CSS 叠层、纸边和色板，不修改 PNG 内容、平铺尺寸与复制范围。移除看板全幅纤维和深色统一 soft-light 混合，深色通过更亮的卡纸与纸边体现层次，详见 [配色与材质更新](paper-material-refinement.md)。

其余文件仅作为视觉规则参考，不能误记为已经移植：

| 参考文件 | 可用规则 | 本地改写边界 |
| --- | --- | --- |
| `recipes/button-ink.ts` | default/outline/secondary 的层次，小圆角、calm 单层填充和细描边，disabled 弱化 | 用局部主题 token、CSS 原生状态和边框适配；不复制 recipe、focusRing、hover/pressed 多层引擎 |
| `recipes/badge-ink.ts` | pill 轮廓、文字加底色、calm 细边 | 本地明确映射全部任务状态；颜色只辅助文字，不复制固定色板、tally 或绘制对象 |
| `components/ui/paper.tsx`、`paper/stocks.ts`、`paper/shadows.ts` | 纸面与轻阴影层次 | 使用局部 CSS 实现，不倾斜可交互内容；不复制纸材全集、阴影生成器、胶带组件 |
| `styles/looseleaf.css` | 纸面/墨迹/边框的语义分层 | 以 `--dsh-tasks-*` 声明本地 token，不直接复制全局规则或固定字体 |

展示组件只接收 props，不访问 Connection、Session 或 Storage。三个组件继续共享 `require('react')` 的宿主实例；新增运行时 npm 依赖、CDN、字体和编译步骤均为零。胶带和高亮伪元素使用 `pointer-events: none`，不新增可聚焦节点。后续按用户要求移除外观偏好与切换，所有表单继续保留稳定的组件类型。删除功能另将任务数据升级为 version 4，并增加 remove 事件；每个 Client 仍只有一条任务 SSE，详见 [交互调整记录](task-controls-verification.md)。

## 详情确认与启动对话框

两个纸面弹框在 `client.js` 中共用 `Modal`、`DialogSticker` 和已有的 `PAPER_SLIP` 标题纸纹。以同一固定提交的 `src/components/ui/alert-dialog.tsx`（危险提示、标题/描述、取消与确认分区）和 `src/components/ui/dialog.tsx`（纸张内容框）为参考，用原生 `dialog.showModal()` 与宿主 React 18 实现；未引入 Radix、Ink hooks、字体或远程资源。

`DialogSticker` 的五条 SVG 路径摘自 `src/lib/ink/art/stickers/office-desk.ts` 的 `notebook.small`（源文件 SHA-256：`c9bde0121f52074853ffbb2148a4161c227ecc232f7baa8b85f98ea5a6a89029`）。保留 64 × 64 画布与路径，用本地主题色和静态线宽替代上游画笔；贴纸仅装饰，不进入焦点顺序或无障碍名称。署名及完整 MIT 许可见 [`licenses/looseleaf-MIT.txt`](../licenses/looseleaf-MIT.txt)。

## 第一批：纸面主题下的任务编辑控件

仅新建和详情抽屉声明 `.dsh-tasks-editor-drawer`。当有效任务外观为「纸面」时，[任务端适配器](../calendar/task-paper-ink.jsx)复用 Looseleaf `calm` 绘制 recipe。标题、描述、标签、优先级、工作区、模型共用上游 `drawFieldFrame`；日期继续使用 `DatePicker` / `drawSelectFrame`，与其他字段共用描边、纸色与焦点规范。按钮、状态、页签和空附件框使用下表中的上游 recipe；下拉和日期浮层共用主题色、边框、圆角和阴影。DSH `Input`、宿主按钮、原生 `textarea` 和文件输入，以及插件原有的可搜索选择器保留交互与焦点。没有引入上游 React 19 组件壳、全局 `InkProvider`、Tailwind 或字体。

新增 recipe 原样取自同一个固定提交，位于 [本地 Looseleaf recipe 目录](../calendar/vendor/looseleaf/lib/ink/recipes/)；沿用其 [MIT 许可](../calendar/vendor/looseleaf/LICENSE)。历史审查清单另保留，不代表本轮新增文件均在旧清单中。

| 上游 `src/lib/ink/recipes/` 下的文件 | SHA-256 |
| --- | --- |
| `button-ink.ts` | `230529cd7990a295f6c4b0ad4a5b0e345e9489d0031c5d7c8bfa3d5e41ec9e53` |
| `badge-ink.ts` | `45676fc2300f7b07d1c9cf59b43192fa34bbb35bf5e76da08a1904967e99b1d9` |
| `tabs-ink.ts` | `29d569eb6c646d78abecb7628df3f853efad828fd45c18abb4814624486cb169` |
| `empty-ink.ts` | `d189ab41359c099259ce1fb7acbce90ebb948da2b46bb953fe017069579c1b01` |

绘制层不接收鼠标和键盘事件，也不参与控件的可访问名称。非纸面时隐藏绘制层，强制色彩下用系统边框和高亮代替绘制层。切换外观只改变样式，不重挂载输入框、选择器或抽屉。独立纸面主题提供 `--dsh-looseleaf-*` 变量，仅发给这两个抽屉；任务端保留旧主题版本的变量回退。详见[主题契约](../../tavlo-plugins-paper-theme/docs/host-adapter.md)。

## 复核与更新

运行 `node scripts/looseleaf-audit.mjs <上游快照目录>` 可离线复核全部哈希及本地许可证；省略目录则从锁定提交下载后校验，只用于开发审查。脚本无需第三方依赖，不参与安装或运行流程。

以后更新提交时先比较上述摘取符号及其依赖，再更新锁文件、许可和映射；如果扩大到字体、纹理、React hook 或 recipe 引擎，需要重新审查范围。当前基线与后续比较方法见 [阶段 1 验证](looseleaf-verification.md)。
