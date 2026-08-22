# MapleBench 界面汉化术语表(zh-glossary)

本文件供汉化子代理统一译名。遇到未列出的词,按下方"翻译规则"处理,并在报告中注明。

## 界面通用词

| 英文 | 中文 |
|---|---|
| Explorer | 资源管理器 |
| Editors | 编辑器 |
| Files | 文件 |
| Search / Find | 搜索 |
| Pinned (nodes) | 已固定(节点) |
| Unsaved changes | 未保存的更改 |
| Save | 保存 |
| Save changes | 保存更改 |
| Undo | 撤销 |
| Redo | 重做 |
| Import | 导入 |
| Export | 导出 |
| Open | 打开 |
| Close | 关闭 |
| Cancel | 取消 |
| OK | 确定 |
| Apply | 应用 |
| Confirm | 确认 |
| Delete | 删除 |
| Rename | 重命名 |
| Add | 添加 |
| Remove | 移除 |
| Edit | 编辑 |
| Copy | 复制 |
| Paste | 粘贴 |
| Cut | 剪切 |
| Name | 名称 |
| Value | 值 |
| Type | 类型 |
| Filter | 筛选 |
| Preview | 预览 |
| Animation | 动画 |
| Frame | 帧 |
| Canvas | 画布(节点类型可保留 "Canvas") |
| Node | 节点 |
| Path | 路径 |
| Archive | 存档 |
| Client | 客户端 |
| Map | 地图 |
| Mob(s) | 怪物 |
| NPC(s) | NPC |
| Skill(s) | 技能 |
| Item(s) | 道具 |
| Cash Shop | 商城 |
| Database | 数据库 |
| Game Data Search | 游戏数据搜索 |
| Strings | 字符串 |
| Map Editor | 地图编辑器 |
| Compose | 合成 |
| Audit | 检查 |
| Repair | 修复 |
| Dump | 转储(导出数据,若 UI 原文是 Export 则用 导出) |
| Port | 迁移 |
| Dual Client View | 双客户端视图 |
| Inspector | 检查器 |
| Theme | 主题 |
| Light / Dark | 浅色 / 深色 |
| Shortcuts | 快捷键 |
| Loading | 加载中 |
| Error | 错误 |
| Warning | 警告 |
| Success | 成功 |
| Failed | 失败 |
| Unknown | 未知 |
| None | 无 |
| All | 全部 |
| Default | 默认 |
| Refresh | 刷新 |
| Reset | 重置 |
| Clear | 清除 |
| Browse | 浏览 |
| Choose | 选择 |
| Search results | 搜索结果 |
| Nothing selected | 未选择任何内容 |
| Change(s) | 更改 |
| About | 关于 |
| Palette | 命令面板 / 调色板(按上下文) |
| Go to a node or command | 跳转到节点或命令 |
| Drop a .wz, .ms or .img to open the file picker | 拖入 .wz、.ms 或 .img 文件以打开文件选择器 |
| Coming soon | 即将推出 |
| Image format changed | 图像格式已更改 |
| Saved and verified | 已保存并通过验证 |
| Copy written | 副本已写入 |
| Keyboard shortcuts | 键盘快捷键 |

## 保留不译(技术/品牌/数据术语)

- 品牌: MapleBench、MapleStory、Nexon、Kiro
- 格式/扩展名: WZ、.wz、.ms、.img、PNG、GIF、APNG、JSON、XML、CSV、BMP
- WZ 数据文件名: String.wz、Mob.wz、Skill.wz、Map.wz、Item.wz、NPC.wz、CashShop.wz、Quest.wz、Base.wz、UI.wz 等
- 数据节点/属性名(info、body、head、origin、link、canvas、anim、effect、sound 等出现在树/数据里的名称,属于游戏数据,保持原样)
- 键盘快捷键: Ctrl P、Ctrl S、Ctrl Z、Ctrl Shift Z、Ctrl 1、Ctrl 2 等,以及 ↑↓、↵、Esc、? 键帽
- 技术词汇可保留或中英混写: WebView2、API、toast、DTO 等;若翻译,如 "toast" → "提示"

## 翻译规则(必须遵守)

1. 只翻译"显示给用户"的字符串:按钮文字、标题、toast 提示、data-tip、aria-label、placeholder、空状态、对话框、模板字符串里的英文文案。
2. 绝不翻译代码标识符、变量名、函数名、CSS 类名、元素 id、data-* 属性值、API 路径、JSON 键名。
3. 绝不翻译用于逻辑比较的字符串(node.name === 'info'、type === 'string' 之类)。不确定时保持原样。
4. 保留模板字符串中的 ${...} 插值、HTML 标签、class/id 属性;保持原引号风格(单/双/反引号)。
5. 不要翻译代码注释(降低误改风险)。
6. 译文简洁,避免 UI 溢出;保持 · 分隔符;中文用全角标点、句尾不加英文句号。
7. 单复数:中文不区分,如 "1 item" / "3 items" 均译 "项";"item(s)" 模板如 `${n} file${n===1?'':'s'}` 保留逻辑,但内部文案按中文习惯处理。
8. 用 read 工具分块读取文件,用 edit 工具精确替换;每次改完用 `node --input-type=module --check < 文件`(PowerShell 里 `cmd /c "node --input-type=module --check < 路径"` 或 bash)校验语法。
9. 翻译后若某固定宽度按钮/标签明显放不下,可在该处 CSS 类不动的前提下尽量用短译名,不要改布局代码。
10. 全部完成后报告:翻译了哪些文件、大致条数、遇到的疑难与未译项。
