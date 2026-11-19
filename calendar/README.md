# Looseleaf 截止日期选择器

`vendor/looseleaf` 是 [Looseleaf](https://github.com/kevintngo/looseleaf/tree/4bdb647940e2fefb3cebb394f3bad25c766a27d2) 的 MIT 源码子集，包含 DatePicker、Calendar 及其墨线绘制逻辑。正常构建不访问上游。可用 `node scripts/vendor-calendar.mjs <固定提交的本地检出目录>` 刷新源码。

面板复用宿主 React 18。构建别名把基础控件适配到宿主字体、主题色及抽屉内的 Radix 弹层，不加载 Looseleaf 的站点样式或远程字体。日期始终按本地日历日读写，不转换成 UTC 时间戳。
