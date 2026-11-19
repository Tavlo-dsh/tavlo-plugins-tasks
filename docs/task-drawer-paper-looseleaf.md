# 任务编辑抽屉：Looseleaf 纸面适配

## 范围

仅新建和任务详情抽屉接入 Looseleaf `calm` 绘制：标题／描述／选择器共用字段框，截止日期保留已有 DatePicker，按钮／状态／页签／附件空态使用各自的上游 recipe。输入和选择控件不随切换外观重新挂载；原有搜索、草稿、保存、日期、上传和系统文件选择窗口不变。没有更改 DSH 外壳，也没有把 Looseleaf 全局主题或字体加入宿主。

独立纸面主题插件只给显式接入的抽屉提供视觉变量。任务外观「纸面」单独开启时同样生效；任务外观「iOS」优先于全局纸面；「跟随」时使用全局外观。默认和 iOS 不显示新增 Ink 图层。来源与适配见 [Looseleaf 来源说明](looseleaf-source-map.md)。

## 本地验收

1. 在任务面板把外观改成「纸面主题」，分别打开新建和详情。标题、描述、下拉、截止日期的底色和边线应一致；日期图标和清除按钮仍可操作。
2. 试用下拉搜索、日历的「今天／明天」与 Esc、文件选择与详情页签；在浅色和深色下分别核对焦点和弹层。
3. 把任务外观切回「跟随」或「iOS」，确认没有新增 Ink 绘制，已编辑内容仍在。375px 宽度下应保持单列、正文可滚动，主要操作一直可达。

## 自动化

分别在任务插件和纸面主题插件目录运行 `npm test`。任务插件编译产物可用[隔离浏览器探针](../scripts/task-drawer-layout-probe.mjs)验证。它使用真实宿主的 React、UI 和主题样式，任务数据／附件均由内存夹具提供，不访问日用任务库或配置。

```powershell
# 在任务插件目录运行，npm test 已重建任务客户端
$env:TASK_DRAWER_LAYOUT_CLIENT = 'built'
$env:TASK_DRAWER_PAPER_THEME_CLIENT = (Resolve-Path '../tavlo-plugins-paper-theme/client.js').Path
$env:TASK_DRAWER_LAYOUT_OUTPUT = (Join-Path (Resolve-Path '../artifacts').Path 'tasks-looseleaf-drawer')
node scripts/task-drawer-layout-probe.mjs
```
