# MapleBench

MapleBench 是一款面向冒险岛（MapleStory）的 Windows WZ 编辑器，带依赖感知的客户端导入功能。你可以浏览和编辑存档数据、预览视觉资源、处理常见游戏数据区块，并在经过验证的保存流程下在客户端版本之间移动内容。

作者：Kiro。

> [!IMPORTANT]
> 请务必在游戏数据的**副本**上工作，并保留**独立的备份**。MapleBench 会在替换目标之前验证其输出，并且通常会创建带时间戳的备份，但没有任何编辑器能防范损坏的源文件、存储故障或中断的写入。

## 功能特性

- 浏览和编辑 WZ 存档树。
- 预览画布数据、像素、链接图片与动画。
- 跨已加载的存档搜索并替换数值。
- 处理怪物、NPC、技能、字符串、商城数据与游戏数据搜索。
- 在核对名称、效果、声音、套装数据与引用素材之后，从经典 WZ 或拆分 Data 客户端导入所选内容。
- 通过临时候选文件保存——该文件会被刷写、重新打开并验证，之后才替换目标。

## 环境要求

- Windows 10 或 Windows 11
- 从源码构建时需要 [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0)
- Microsoft Edge WebView2 运行时（通常随当前 Windows 安装自带）

## 从源码运行

```powershell
dotnet restore MapleBench.sln
dotnet run --project MapleBench
```

若要在默认浏览器而非桌面窗口中打开界面：

```powershell
dotnet run --project MapleBench -- --browser
```

## 构建

```powershell
dotnet build MapleBench.sln -c Release
```

在 `dist/standalone` 中创建自包含的 Windows 构建：

```powershell
dotnet publish MapleBench/MapleBench.csproj `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:IncludeAllContentForSelfExtract=true `
  -p:StaticWebAssetsEnabled=false `
  -p:EnableCompressionInSingleFile=true `
  -p:PublishReadyToRun=true `
  -p:PublishReadyToRunComposite=false `
  -p:SatelliteResourceLanguages=en `
  -o dist/standalone
```

## 保存与数据安全

编辑会保留在内存中，直到你保存。对于受支持的 WZ 保存，MapleBench 会写入一个同级候选文件、将其刷写到磁盘、重新打开并验证，然后才替换到位。替换目标时，默认会保留带时间戳的备份。拆分客户端的引用文件按只读处理，`.ms` 容器不会被覆盖。

这些检查能降低风险，但不能替代独立的备份。请将原始存档保留在工作目录之外，直到你测试过编辑后的客户端。

## 仓库结构

- `MapleBench` —— 桌面宿主、Web 界面、应用服务与内嵌资源
- `dependencies/MapleLib` —— WZ 解析、序列化、加密与数据包依赖

NuGet 包依赖由 .NET SDK 自动还原。

MapleBench 基于 [MapleLib](https://github.com/lastbattle/MapleLib) 构建。完整的贡献记录请参见仓库历史。

## 许可证

本项目基于 [GNU 通用公共许可证 v3.0](LICENSE) 授权。

MapleStory 及相关名称和素材是 Nexon 及其各自所有者的商标或受版权保护的作品。MapleBench 是一个独立项目，与 Nexon 无关联，也未获得其认可。
