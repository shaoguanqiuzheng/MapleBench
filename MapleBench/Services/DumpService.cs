using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using MapleLib.WzLib;
using MapleLib.WzLib.WzProperties;

namespace MapleBench.Services;

/// <summary>
/// The dumper: everything a node holds, in the formats the thing outside this
/// program actually reads.
///
/// The tool already moved data between clients and already had two exports
/// bolted to two buttons (<c>/api/export/images</c>, <c>/api/export/json</c>).
/// What it did not have was an answer to "get this out" that depended on what
/// "this" is — and that dependency is the whole feature. A canvas wants a PNG
/// and its untouched stored bytes; a numbered run of canvases with delays wants
/// a GIF or an APNG, and wants them built at the frames' shared origin or every
/// frame jitters; a WzBinaryProperty wants the mp3 that is already sitting
/// inside it; a table of string rows wants CSV. Offering all of those on all
/// nodes would be the same as offering none.
///
/// Three data-safety rules run through every method here:
///
///  1. **A link is not the same as its target.** Nothing here follows an
///     <c>_inlink</c>, <c>_outlink</c> or UOL unless the caller asked for that
///     in so many words, and anything written by following one says so in its
///     sidecar. <see cref="Describe"/> offers both routes on a linking node and
///     names the target, so the choice is made with the facts in view. This is
///     also why the recursion here goes through <see cref="WzWalk"/>:
///     <c>WzUOLProperty.WzProperties</c> hands back the RESOLVED node's
///     children, so a walk that treats it as an ordinary container is not
///     merely following links, it is following them into a loop that ends the
///     process.
///  2. **What did not export is part of the export.** Every entry point returns
///     a <see cref="DumpResultDto"/> with an issue list, every ZIP carries it as
///     <c>dump-report.json</c>, and the HTTP layer copies the count into a
///     header so a browser download can show it. A canvas that will not decode
///     is a normal event in a real client; a dump that hides one is not.
///  3. **Provenance travels with the bytes.** Archive, file on disk, node path,
///     timestamp, and whether the archive had unsaved edits at the time — that
///     last one because a dump taken from a dirty session does not match the
///     file it names.
/// </summary>
public sealed class DumpService
{
    /// <summary>
    /// Frames one animation export will compose. Well past anything in a client
    /// (the longest animations in a v232 Skill.wz run to a few dozen), and low
    /// enough that a mistaken click on a container of a thousand canvases cannot
    /// allocate a thousand full-size ARGB bitmaps.
    /// </summary>
    public const int MaxFrames = 512;

    /// <summary>
    /// Ceiling on a composed frame. 4096x4096 ARGB is 64 MB per frame, which is
    /// already the wrong side of sane for a sprite sheet; map backgrounds are the
    /// only things that come close.
    /// </summary>
    private const int MaxSide = 4096;

    /// <summary>Rows and columns one CSV may hold before it says it stopped.</summary>
    private const int MaxCsvRows = 20_000;
    private const int MaxCsvColumns = 400;

    private readonly WzSessionService _session;
    private readonly WzRenderService _render;
    private readonly AnimationService _animation;
    private readonly ILogger<DumpService> _log;

    public DumpService(
        WzSessionService session, WzRenderService render, AnimationService animation, ILogger<DumpService> log)
    {
        _session = session;
        _render = render;
        _animation = animation;
        _log = log;
    }

    #region What is this node, and what can it produce

    /// <summary>
    /// The node's kind, the facts a chooser needs about it, and the formats it
    /// can actually produce.
    ///
    /// Cheap on purpose: it parses the image it lands in and reads the immediate
    /// children, and does not decode a single pixel. It is called every time a
    /// context menu opens.
    /// </summary>
    public DumpTargetDto Describe(string path)
    {
        DumpTargetDto target = new() { Path = path };

        lock (_session.Gate)
        {
            WzObject node = _session.Resolve(path);
            target.Name = node.Name ?? "";
            target.TypeName = node.GetType().Name;
            target.Link = LinkOf(node, path);

            // An archive's session path is the bare file id, and Resolve hands
            // back the WzFile's root DIRECTORY for it rather than the file — so
            // "is this a whole archive" is a question about the path, not about
            // the type of what came back. Without this an archive is described
            // as a folder and the job that exists for archive-sized work is
            // never the recommended one.
            bool isArchiveRoot = WzPath.SplitRaw(path).Length == 1
                && _session.TryGetFile(WzPath.FileId(path)) != null;

            switch (node)
            {
                case WzDirectory when isArchiveRoot:
                case WzFile:
                    target.Kind = "Archive";
                    target.Note =
                        "整个存档。转储它会遍历其中的每一张图,需要几分钟并占用大量磁盘——"
                        + "它会作为可观察、可取消的任务运行。";
                    break;

                case WzDirectory:
                    target.Kind = "Directory";
                    target.Note = "一个图片文件夹。";
                    break;

                case WzImage:
                    target.Kind = "Image";
                    target.Note = "一个 .img —— 服务端转储和 JSON 导出都以它为单位。";
                    break;

                case WzBinaryProperty sound:
                    target.Kind = "Sound";
                    target.SoundMs = sound.Length;
                    target.SoundExtension = sound.FileExtension;
                    target.Note =
                        $"音频以 {sound.SoundType} ({sound.FileExtension}) 格式存储。"
                        + "它将按原样逐字节导出——不做任何转码。";
                    break;

                case WzCanvasProperty canvas:
                    target.Kind = "Canvas";
                    target.Width = canvas.PngProperty?.Width ?? 0;
                    target.Height = canvas.PngProperty?.Height ?? 0;
                    target.CanvasFormat = canvas.PngProperty?.Format.ToString();
                    target.HasRawBlob = canvas.PngProperty != null && !canvas.ContainsInlinkProperty()
                        && !canvas.ContainsOutlinkProperty();
                    PointF origin = SafeOrigin(canvas);
                    target.Note = target.Link != null
                        ? "一个绘制了其他画布像素的画布。请说明你想要哪一个。"
                        : $"一个 {target.Width}x{target.Height} 画布,原点 ({(int)origin.X},{(int)origin.Y})。";
                    break;

                case WzUOLProperty:
                    target.Kind = "Link";
                    target.Note = "对另一个节点的引用。它本身没有任何内容。";
                    break;

                default:
                    bool hasChildren = node is WzImageProperty p && (p.WzProperties?.Count ?? 0) > 0;
                    target.Kind = hasChildren ? "Container" : "Value";
                    if (!hasChildren)
                    {
                        target.Note =
                            $"一个 {node.GetType().Name.Replace("Wz", "").Replace("Property", "")} 值。"
                            + "单个数值没有文件格式;它父节点的 JSON 导出才是读取它的合理位置。";
                    }
                    break;
            }
        }

        // Outside the gate on purpose: Describe walks the children again and the
        // gate is reentrant, but holding it across two passes for a menu is
        // exactly the kind of thing that makes the tree feel sticky.
        if (target.Kind is "Container" or "Image" or "Canvas")
        {
            AnimationDto animation = _animation.Describe(path);
            if (animation.IsAnimation)
            {
                target.Kind = "Animation";
                target.Frames = animation.Frames.Count;
                target.TotalMs = animation.TotalMs;
                target.Width = animation.Width;
                target.Height = animation.Height;
                target.Note =
                    $"{animation.Frames.Count} 个编号画布带延迟——一段 {animation.TotalMs} ms 的动画,"
                    + $"按共享原点 ({animation.AnchorX},{animation.AnchorY}) 合成,因此不会抖动。";
            }
            else if (target.Kind == "Container")
            {
                target.Note = "一棵子树。";
            }
        }

        target.Formats = FormatsFor(target);
        return target;
    }

    /// <summary>
    /// The menu, in the order it should be read: the format that fits this node
    /// first, the general ones after, and the link options wherever a link is
    /// what the node is.
    /// </summary>
    private static List<DumpFormatDto> FormatsFor(DumpTargetDto target)
    {
        string p = Uri.EscapeDataString(target.Path);
        List<DumpFormatDto> formats = new();

        void Download(string id, string label, string note, string url, bool recommended = false)
            => formats.Add(new DumpFormatDto
            { Id = id, Label = label, Note = note, Url = url, Kind = "download", Recommended = recommended });

        switch (target.Kind)
        {
            case "Canvas" when target.Link != null:
                // A canvas whose pixels are somewhere else has nothing of its
                // own to offer as a PNG, and the link block below offers the
                // two honest choices. Listing "PNG image" here as well would be
                // an entry that only ever produces a refusal.
                break;

            case "Canvas":
                Download("png", "PNG 图片",
                    "解码后的画面。原点与延迟不在 PNG 中——它们位于文件夹和雪碧图导出的附属文件中。",
                    $"/api/dump/canvas?path={p}&format=png", recommended: true);
                if (target.HasRawBlob)
                {
                    Download("raw", "原始存储块 (ZIP)",
                        "画布自身的压缩字节,以及还原它们所需的格式、尺寸和原点。重新编码 PNG 无法还原它们,"
                        + "因此这是唯一无损的副本。",
                        $"/api/dump/canvas?path={p}&format=raw");
                }
                break;

            case "Animation":
                Download("gif", "动画 GIF",
                    "随处可播放。GIF 只有一种透明色、没有半透明,因此柔边会出现硬边,延迟会取整到 10 ms。",
                    $"/api/dump/animation?path={p}&format=gif", recommended: true);
                Download("apng", "动画 PNG",
                    "相同的帧,带真正的 alpha 和精确到毫秒的延迟。浏览器可播放;一些旧图像查看器只显示第一帧。",
                    $"/api/dump/animation?path={p}&format=apng");
                Download("sheet", "雪碧图 + JSON (ZIP)",
                    "一张 PNG 网格,加上引擎所需的元数据:每帧矩形、延迟、原点与共享锚点。",
                    $"/api/dump/animation?path={p}&format=sheet");
                Download("frames", "编号 PNG (ZIP)",
                    "每帧一张 PNG,保持自身尺寸,按播放顺序命名,并附 JSON 索引记录每帧的原点与延迟。",
                    $"/api/dump/animation?path={p}&format=frames");
                break;

            case "Sound":
                Download("audio", "按存储原样的音频",
                    "节点内部的字节,带 MapleLib 报告的扩展名。不做转码。",
                    $"/api/dump/sound?path={p}", recommended: true);
                break;

            case "Link":
                break;
        }

        if (target.Link != null)
        {
            Download("link", "引用本身,作为文本",
                $"导出此节点所记录的内容 —— '{target.Link.Text}' —— 而非它所指向的内容。",
                $"/api/dump/link?path={p}", recommended: target.Kind == "Link");

            if (target.Link.Resolves)
            {
                Download("linked-png", "所链接的图片 (PNG)",
                    $"解析引用并导出 {target.Link.TargetPath} 处的像素。"
                    + "文件是目标的内容,但以此节点的名称命名。",
                    $"/api/dump/canvas?path={p}&format=png&resolve=true");
            }
        }

        if (target.Kind is "Archive" or "Directory" or "Image" or "Container" or "Animation" or "Canvas")
        {
            // The existing /api/export/json, reused rather than reimplemented.
            // Its per-level cap is worth stating here because of where it
            // reports: a level wider than 2,000 children is cut and the cut is
            // written INSIDE the data as "__truncated", while the document's own
            // top-level "truncated" stays false. Measured on String.wz/Mob.img —
            // 9,962 rows in, 2,000 rows out, and the header says nothing.
            Download("json", "JSON",
                "以值的形式导出子树;画布与声音变成描述符而非数据。宽于 2,000 个孩子的层级会被截断,"
                + "并标记在数据内部的 \"__truncated\" 中而非顶部——对于大表格,CSV 才是携带全部行的导出。",
                $"/api/export/json?path={p}&depth=20", recommended: target.Kind == "Container");

            if (target.Kind == "Image")
            {
                Download("img", "独立 WZ 图像 (.img)",
                    "完整的 WZ 图像,包括值、画布、声音与链接。可直接在 MapleBench 或其他兼容 WZ 编辑器中打开。",
                    $"/api/export/img?path={p}", recommended: true);
                Download("xml", "经典 XML (.img.xml)",
                    "v83 服务端模拟器读取的 <imgdir> 结构,而非存档。",
                    $"/api/export/xml?path={p}");
            }

            if (target.Kind is "Archive" or "Directory")
            {
                Download("xml-zip", "经典 XML 树 (ZIP)",
                    "此处下方的每个 .img 都导出为 XML,镜像 WZ 文件夹结构。",
                    $"/api/export/xml-zip?path={p}");
            }

            Download("images", "此处下方的所有图片 (ZIP)",
                "扁平扫描此节点下的画布,附来源与延迟清单。",
                $"/api/export/images?path={p}");

            Download("csv", "CSV 表格",
                "每个孩子一行,其下找到的每个叶子字段一列。专为 String.wz 行与其他表格设计;"
                + "它会说明有多少数据无法放进表格。",
                $"/api/dump/csv?path={p}");

            formats.Add(new DumpFormatDto
            {
                Id = "tree",
                Label = "磁盘上的文件夹 (PNG + 音频 + JSON)",
                Note =
                    "将节点结构镜像为真实文件夹:画布导出为 PNG,声音导出为音频,其余内容按文件夹导出为 JSON 附属文件。"
                    + "带进度显示,可取消。",
                Kind = "job",
                Job = "tree",
                Recommended = target.Kind == "Archive",
            });
        }

        return formats;
    }

    /// <summary>
    /// Whether this node is a reference, and where to.
    ///
    /// Covers both spellings, because they are the same fact wearing different
    /// clothes: a <c>WzUOLProperty</c> IS the reference, while a canvas with an
    /// <c>_inlink</c>/<c>_outlink</c> child is a canvas whose pixels live
    /// elsewhere. Either way the node's own bytes are not what a naive export
    /// would produce, and either way the user has to be told before choosing.
    /// </summary>
    private DumpLinkDto? LinkOf(WzObject node, string path)
    {
        switch (node)
        {
            case WzUOLProperty uol:
            {
                DumpLinkDto link = new() { Kind = "uol", Text = uol.Value ?? "" };
                WzObject? target = null;
                try { target = uol.LinkValue as WzObject; }
                catch (Exception ex) { link.Note = ex.Message; }

                link.Resolves = target != null;
                link.TargetKind = target?.GetType().Name;
                link.TargetPath = target?.FullPath;
                if (!link.Resolves && link.Note == null)
                {
                    link.Note =
                        "It does not resolve from here. Either the archive holding the target is not open, or " +
                        "the reference is broken in the client itself.";
                }
                return link;
            }

            case WzCanvasProperty canvas when canvas.ContainsInlinkProperty() || canvas.ContainsOutlinkProperty():
            {
                bool inlink = canvas.ContainsInlinkProperty();
                string kind = inlink ? "_inlink" : "_outlink";
                string text = (canvas[kind] as WzStringProperty)?.Value ?? "";
                DumpLinkDto link = new() { Kind = kind, Text = text };

                try
                {
                    WzImageProperty? resolved = canvas.GetLinkedWzImageProperty();
                    // A canvas with a link always resolves to *something* — itself
                    // when the link is broken, which is not a resolution.
                    link.Resolves = resolved != null && !ReferenceEquals(resolved, canvas);
                    link.TargetPath = link.Resolves ? resolved!.FullPath : null;
                    link.TargetKind = link.Resolves ? resolved!.GetType().Name : null;
                }
                catch (Exception ex)
                {
                    link.Note = ex.Message;
                }

                if (!link.Resolves)
                {
                    link.Note ??=
                        inlink
                            ? "The _inlink names a path inside this same .img that is not there."
                            : "The _outlink names an archive path that this session cannot reach — the archive " +
                              "holding it may not be open.";
                }
                _ = path;
                return link;
            }

            default:
                return null;
        }
    }

    #endregion

    #region Canvas

    /// <summary>
    /// One canvas as a PNG.
    ///
    /// <paramref name="resolve"/> is the whole link question in one flag. False
    /// — the default — renders this node, and a link canvas holding no pixels of
    /// its own comes back as a refusal naming the link rather than as the
    /// target's picture wearing this node's name.
    /// </summary>
    public (byte[] Data, string FileName, DumpResultDto Result) ExportCanvasPng(string path, bool resolve)
    {
        DumpResultDto result = NewResult(path, "png");

        DumpLinkDto? link;
        lock (_session.Gate)
        {
            WzObject node = _session.Resolve(path);
            link = LinkOf(node, path);

            if (link != null && !resolve && !HasOwnPixels(node))
            {
                throw new InvalidOperationException(
                    $"This node is a {link.Kind} to '{link.Text}' and holds no pixels of its own. " +
                    (link.Resolves
                        ? $"Export the reference as text, or ask for the linked picture at {link.TargetPath}."
                        : "The reference does not resolve from here, so there is nothing to draw either."));
            }
        }

        byte[]? png = _render.RenderCanvasPng(path);
        if (png == null)
        {
            throw new InvalidOperationException(
                "This canvas did not decode. It may be one of the malformed ones the integrity auditor " +
                "reports — try the raw stored blob, which does not go through a decoder.");
        }

        if (link != null && resolve)
        {
            result.LinksRecorded = 1;
            result.Issues.Add(new DumpIssueDto
            {
                Path = path,
                Kind = "link.resolved",
                Reason = $"这些像素来自 {link.TargetPath ?? link.Text},而非此节点。",
            });
        }

        result.Files = 1;
        result.Bytes = png.Length;
        result.Canvases = 1;
        return (png, ExportService.Sanitise(NameOf(path)) + ".png", result);
    }

    /// <summary>
    /// A canvas's stored bytes, exactly as the archive holds them, plus the
    /// metadata needed to put them back.
    ///
    /// This exists because a PNG round trip is not lossless in the direction
    /// that matters here. The archive stores DXT and 4444/565 surfaces; decoding
    /// one to RGBA and re-encoding it produces different bytes and, for the
    /// block formats, different pixels. Anyone diffing two clients' art, or
    /// putting a canvas back after editing something else, needs the original.
    ///
    /// The blob is <c>GetCompressedBytesForExtraction</c> — standard zlib rather
    /// than the archive's list-WZ variant — so it is readable without knowing
    /// the archive's key.
    /// </summary>
    public (byte[] Data, string FileName, DumpResultDto Result) ExportCanvasRaw(string path)
    {
        DumpResultDto result = NewResult(path, "raw");
        byte[] blob;
        object meta;

        lock (_session.Gate)
        {
            if (_session.Resolve(path) is not WzCanvasProperty canvas || canvas.PngProperty == null)
                throw new InvalidOperationException("This node is not a canvas, so it has no stored image bytes.");

            if (canvas.ContainsInlinkProperty() || canvas.ContainsOutlinkProperty())
            {
                throw new InvalidOperationException(
                    "This canvas has no stored bytes of its own — it is a link, and its pixels belong to the " +
                    "node it names. Export the reference as text, or export the linked picture as PNG.");
            }

            WzPngProperty png = canvas.PngProperty;
            blob = png.GetCompressedBytesForExtraction(false)
                ?? throw new InvalidOperationException("The archive returned no bytes for this canvas.");

            PointF origin = SafeOrigin(canvas);
            meta = new
            {
                node = Uri.UnescapeDataString(path),
                width = png.Width,
                height = png.Height,
                format = (int)png.Format,
                formatName = png.Format.ToString(),
                origin = new { x = (int)origin.X, y = (int)origin.Y },
                delay = ReadDelay(canvas),
                encoding = "zlib (GetCompressedBytesForExtraction) — inflate to get the raw surface",
                note =
                    "These are the archive's own bytes for this canvas. The surface layout is the one named by " +
                    "format; it is not a PNG and not a bitmap. Measured on a real client: the stream inflates to " +
                    "exactly the surface size but often carries no end-of-stream marker, so inflate with a " +
                    "streaming decompressor and stop at the expected byte count rather than waiting for the end " +
                    "— a one-shot call will report a truncated stream on data that is complete.",
            };
        }

        string stem = ExportService.Sanitise(NameOf(path));
        MemoryStream buffer = new();
        using (ZipArchive zip = new(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            Write(zip, stem + ".canvas.bin", blob);
            WriteJson(zip, stem + ".canvas.json", meta);
            WriteJson(zip, "dump-report.json", Report(result));
        }

        result.Files = 2;
        result.Bytes = blob.Length;
        result.Canvases = 1;
        return (buffer.ToArray(), stem + "-canvas.zip", result);
    }

    #endregion

    #region Sound

    /// <summary>
    /// A sound as it is stored. Not transcoded, not re-wrapped: whatever
    /// MapleLib hands back, under the extension it reports for it.
    /// </summary>
    public (byte[] Data, string FileName, string ContentType, DumpResultDto Result) ExportSound(string path)
    {
        DumpResultDto result = NewResult(path, "audio");

        (byte[] Data, string ContentType, string Extension)? audio = _render.GetAudio(path);
        if (audio == null)
        {
            lock (_session.Gate)
            {
                WzObject node = _session.Resolve(path);
                throw new InvalidOperationException(
                    node is WzBinaryProperty
                        ? "This sound node holds zero bytes. There is nothing to export, and that is a defect " +
                          "in the archive rather than in the export."
                        : "This node is not a sound.");
            }
        }

        result.Files = 1;
        result.Sounds = 1;
        result.Bytes = audio.Value.Data.Length;
        return (audio.Value.Data,
                ExportService.Sanitise(NameOf(path)) + audio.Value.Extension,
                audio.Value.ContentType,
                result);
    }

    #endregion

    #region Animation

    /// <summary>
    /// A numbered run of canvases as something that moves.
    ///
    /// <paramref name="format"/> is "gif", "apng", "sheet" or "frames". The
    /// first two go through the composed frames; the last two keep the frames
    /// separate and carry the timing in JSON beside them.
    ///
    /// Every route composes at the shared origin. MapleStory frames are cropped
    /// individually and positioned by their own <c>origin</c> vector, so playing
    /// them from a common top-left makes the sprite hop around its own feet —
    /// which is why <see cref="AnimationService"/> computes an anchor and a
    /// per-frame offset and why nothing here blits at (0,0).
    /// </summary>
    public (byte[] Data, string FileName, string ContentType, DumpResultDto Result) ExportAnimation(
        string path, string format)
    {
        DumpResultDto result = NewResult(path, format);
        AnimationDto animation = _animation.Describe(path);

        if (!animation.IsAnimation)
        {
            throw new InvalidOperationException(
                "This node is not an animation: an animation is a container whose children are numbered " +
                "canvases, and this one has fewer than two of those. A single canvas exports as a PNG.");
        }

        List<AnimationFrameDto> frames = animation.Frames;
        if (frames.Count > MaxFrames)
        {
            result.Truncated = true;
            result.TruncatedReason = $"Only the first {MaxFrames} of {frames.Count} frames were composed.";
            result.Issues.Add(new DumpIssueDto
            { Path = path, Kind = "budget.exhausted", Reason = result.TruncatedReason });
            frames = frames.Take(MaxFrames).ToList();
        }

        if (animation.Width <= 0 || animation.Height <= 0 ||
            animation.Width > MaxSide || animation.Height > MaxSide)
        {
            throw new InvalidOperationException(
                $"合成后的动画将是 {animation.Width}x{animation.Height},"
                + "这不是本程序能渲染的尺寸。请改为导出编号 PNG。");
        }

        string stem = ExportService.Sanitise(NameOf(path));

        switch (format)
        {
            case "frames":
                return (FramesZip(path, animation, frames, result), stem + "-frames.zip", "application/zip", result);

            case "sheet":
                return (SheetZip(path, animation, frames, result), stem + "-sheet.zip", "application/zip", result);

            case "gif":
            case "apng":
            {
                List<AnimationFrameImage> composed = ComposeFrames(animation, frames, result);
                if (composed.Count == 0)
                {
                    throw new InvalidOperationException(
                        "Not one frame of this animation decoded, so there is nothing to animate.");
                }

                byte[] data = format == "gif"
                    ? GifWriter.Write(animation.Width, animation.Height, composed)
                    : ApngWriter.Write(animation.Width, animation.Height, composed);

                result.Files = 1;
                result.Bytes = data.Length;
                result.Canvases = composed.Count;
                return (data,
                        stem + (format == "gif" ? ".gif" : ".apng.png"),
                        format == "gif" ? "image/gif" : "image/png",
                        result);
            }

            default:
                throw new ArgumentException($"'{format}' 不是本程序导出的动画格式。");
        }
    }

    /// <summary>
    /// Each frame drawn into the animation's own canvas at its offset, as RGBA.
    ///
    /// A frame that will not decode is not dropped — it becomes a transparent
    /// frame of the same duration and an issue in the report. Dropping it would
    /// silently shorten the animation, which is the same class of lie as a
    /// counter that reports what was intended.
    /// </summary>
    private List<AnimationFrameImage> ComposeFrames(
        AnimationDto animation, List<AnimationFrameDto> frames, DumpResultDto result)
    {
        List<AnimationFrameImage> composed = new(frames.Count);
        int decoded = 0;

        foreach (AnimationFrameDto frame in frames)
        {
            using Bitmap canvas = new(animation.Width, animation.Height, PixelFormat.Format32bppArgb);
            byte[]? png = null;
            try { png = _render.RenderCanvasPng(frame.Path); }
            catch (Exception ex) { _log.LogDebug(ex, "Frame {Path} did not decode", frame.Path); }

            if (png == null)
            {
                result.Issues.Add(new DumpIssueDto
                {
                    Path = frame.Path,
                    Kind = "canvas.undecodable",
                    Reason = $"帧 {frame.Name} 解码失败;此处显示为透明,其 {frame.Delay} ms 仍计入时序。",
                });
            }
            else
            {
                Draw(canvas, png, frame.OffsetX, frame.OffsetY);
                decoded++;
            }

            composed.Add(new AnimationFrameImage(ToRgba(canvas), Math.Max(frame.Delay, 1)));
        }

        return decoded == 0 ? new List<AnimationFrameImage>() : composed;
    }

    private byte[] FramesZip(
        string path, AnimationDto animation, List<AnimationFrameDto> frames, DumpResultDto result)
    {
        MemoryStream buffer = new();
        DumpNames names = new();
        List<object> index = new();

        using (ZipArchive zip = new(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            int order = 0;
            foreach (AnimationFrameDto frame in frames)
            {
                byte[]? png = null;
                try { png = _render.RenderCanvasPng(frame.Path); }
                catch (Exception ex) { _log.LogDebug(ex, "Frame {Path} did not decode", frame.Path); }

                // Named by play order, not by the WZ name: WZ frame names are
                // numbers but they are not always dense or zero-padded, and a
                // folder that sorts wrong is a folder somebody assembles wrong.
                string file = $"{order:D3}_{ExportService.Sanitise(frame.Name)}.png";
                _ = names.For(file, "", out _);

                if (png == null)
                {
                    result.Issues.Add(new DumpIssueDto
                    {
                        Path = frame.Path,
                        Kind = "canvas.undecodable",
                        Reason = $"帧 {frame.Name} 解码失败;未写入 {file}。",
                    });
                }
                else
                {
                    Write(zip, file, png);
                    result.Files++;
                    result.Bytes += png.Length;
                    result.Canvases++;
                }

                index.Add(new
                {
                    order,
                    file = png == null ? null : file,
                    name = frame.Name,
                    node = Uri.UnescapeDataString(frame.Path),
                    width = frame.Width,
                    height = frame.Height,
                    origin = new { x = frame.OriginX, y = frame.OriginY },
                    offset = new { x = frame.OffsetX, y = frame.OffsetY },
                    delayMs = frame.Delay,
                    decoded = png != null,
                });
                order++;
            }

            WriteJson(zip, "frames.json", new
            {
                provenance = Provenance(path),
                anchor = new { x = animation.AnchorX, y = animation.AnchorY },
                composedSize = new { width = animation.Width, height = animation.Height },
                totalMs = animation.TotalMs,
                note =
                    "Each PNG is the frame at its own size. To play it, draw frame at " +
                    "(anchor.x - origin.x, anchor.y - origin.y) — that is the offset already computed here. " +
                    "Drawing them all at (0,0) makes the sprite jitter.",
                frames = index,
            });
            WriteJson(zip, "dump-report.json", Report(result));
        }

        return buffer.ToArray();
    }

    private byte[] SheetZip(
        string path, AnimationDto animation, List<AnimationFrameDto> frames, DumpResultDto result)
    {
        int columns = (int)Math.Ceiling(Math.Sqrt(frames.Count));
        int rows = (int)Math.Ceiling(frames.Count / (double)columns);
        long width = (long)columns * animation.Width;
        long height = (long)rows * animation.Height;

        if (width > MaxSide || height > MaxSide)
        {
            throw new InvalidOperationException(
                $"A sheet of these {frames.Count} frames would be {width}x{height}, past the {MaxSide} px limit. " +
                "Export the frames as numbered PNGs instead.");
        }

        List<object> index = new();
        byte[] sheetPng;

        using (Bitmap sheet = new((int)width, (int)height, PixelFormat.Format32bppArgb))
        {
            int order = 0;
            foreach (AnimationFrameDto frame in frames)
            {
                int cellX = order % columns * animation.Width;
                int cellY = order / columns * animation.Height;

                byte[]? png = null;
                try { png = _render.RenderCanvasPng(frame.Path); }
                catch (Exception ex) { _log.LogDebug(ex, "Frame {Path} did not decode", frame.Path); }

                if (png == null)
                {
                    result.Issues.Add(new DumpIssueDto
                    {
                        Path = frame.Path,
                        Kind = "canvas.undecodable",
                        Reason = $"帧 {frame.Name} 解码失败;其在雪碧图中的单元格为空。",
                    });
                }
                else
                {
                    Draw(sheet, png, cellX + frame.OffsetX, cellY + frame.OffsetY);
                    result.Canvases++;
                }

                index.Add(new
                {
                    order,
                    name = frame.Name,
                    node = Uri.UnescapeDataString(frame.Path),
                    // The cell, and the frame's real pixels inside it. Both,
                    // because an engine that packs by cell and one that packs by
                    // tight rect each need a different one of these.
                    cell = new { x = cellX, y = cellY, width = animation.Width, height = animation.Height },
                    frame = new
                    {
                        x = cellX + frame.OffsetX,
                        y = cellY + frame.OffsetY,
                        width = frame.Width,
                        height = frame.Height,
                    },
                    origin = new { x = frame.OriginX, y = frame.OriginY },
                    delayMs = frame.Delay,
                    decoded = png != null,
                });
                order++;
            }

            using MemoryStream encoded = new();
            sheet.Save(encoded, ImageFormat.Png);
            sheetPng = encoded.ToArray();
        }

        string stem = ExportService.Sanitise(NameOf(path));
        MemoryStream buffer = new();
        using (ZipArchive zip = new(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            Write(zip, stem + "-sheet.png", sheetPng);
            WriteJson(zip, stem + "-sheet.json", new
            {
                provenance = Provenance(path),
                image = stem + "-sheet.png",
                columns,
                rows,
                cell = new { width = animation.Width, height = animation.Height },
                anchor = new { x = animation.AnchorX, y = animation.AnchorY },
                totalMs = animation.TotalMs,
                note =
                    "每个单元格大小相同,且每帧都已按动画的共享原点放置在其单元格内,"
                    + "因此按顺序整格绘制即可正确播放。",
                frames = index,
            });
            WriteJson(zip, "dump-report.json", Report(result));
        }

        result.Files = 2;
        result.Bytes = sheetPng.Length;
        return buffer.ToArray();
    }

    #endregion

    #region Reference as text

    /// <summary>
    /// What a linking node says, rather than what it points at.
    ///
    /// The other half of the pair the menu offers. It is the only export that is
    /// correct for a dangling link, and the only one that answers "what does
    /// this node actually contain" for a node whose contents are a sentence.
    /// </summary>
    public (byte[] Data, string FileName, DumpResultDto Result) ExportLink(string path)
    {
        DumpResultDto result = NewResult(path, "link");
        DumpLinkDto? link;

        lock (_session.Gate)
        {
            WzObject node = _session.Resolve(path);
            link = LinkOf(node, path);
        }

        if (link == null)
        {
            throw new InvalidOperationException(
                "This node is not a link — it has no _inlink, no _outlink and is not a UOL — so there is no " +
                "reference to export. Export its own contents instead.");
        }

        result.LinksRecorded = 1;
        if (!link.Resolves)
        {
            result.Issues.Add(new DumpIssueDto
            {
                Path = path,
                Kind = "link.dangling",
                Reason = link.Note ?? $"'{link.Text}' 无法在此会话中解析。",
            });
        }

        byte[] json = JsonSerializer.SerializeToUtf8Bytes(new
        {
            provenance = Provenance(path),
            reference = new
            {
                kind = link.Kind,
                text = link.Text,
                resolves = link.Resolves,
                targetPath = link.TargetPath,
                targetKind = link.TargetKind,
                note = link.Note,
            },
            note =
                "This is the reference itself, not its target. A UOL is parent-relative and an _outlink is " +
                "archive-relative, so this text only means what it means from the node it was read at.",
            issues = result.Issues,
        }, Indented);

        result.Files = 1;
        result.Bytes = json.Length;
        return (json, ExportService.Sanitise(NameOf(path)) + "-link.json", result);
    }

    #endregion

    #region CSV

    /// <summary>
    /// A container's children as a table: one row per child, one column per leaf
    /// field found beneath it.
    ///
    /// Made for the shapes that really are tabular — String.wz rows, drop lists,
    /// per-level skill values, Commodity rows — and honest about the shapes that
    /// are not. A WZ container is not a relation: children have different fields,
    /// some have canvases, some nest four levels deep. So the header is the union
    /// of the leaf paths seen, a cell that has no value is empty rather than
    /// zero, and the count of fields that could not be flattened (canvases,
    /// sounds, sub-tables past the depth limit) is reported rather than dropped.
    /// </summary>
    public (byte[] Data, string FileName, DumpResultDto Result) ExportCsv(string path, int depth)
    {
        DumpResultDto result = NewResult(path, "csv");
        depth = Math.Clamp(depth, 1, 8);

        List<string> columns = new();
        Dictionary<string, int> columnIndex = new(StringComparer.Ordinal);
        List<(string Name, Dictionary<int, string> Cells)> rows = new();
        int skipped = 0;

        lock (_session.Gate)
        {
            WzObject root = _session.Resolve(path);
            int rowCount = 0;
            Dictionary<string, int> seen = new(StringComparer.OrdinalIgnoreCase);

            foreach (WzObject child in _session.EnumerateChildren(root))
            {
                if (rowCount >= MaxCsvRows)
                {
                    result.Truncated = true;
                    result.TruncatedReason = $"在第 {MaxCsvRows} 行处停止。";
                    break;
                }

                string name = child.Name ?? "";
                seen.TryGetValue(name, out int occurrence);
                seen[name] = occurrence + 1;

                Dictionary<int, string> cells = new();
                WzWalk walk = new();
                Flatten(child, "", cells, columns, columnIndex, walk, depth, ref skipped);
                // The row's name as the WZ has it, with the duplicate marker the
                // rest of the tool uses, so a table of a container holding two
                // children called "0" still has two distinguishable rows.
                rows.Add((occurrence > 0 ? $"{name}#{occurrence}" : name, cells));
                rowCount++;
            }
        }

        if (rows.Count == 0)
            throw new InvalidOperationException("This node has no children, so there are no rows to write.");

        if (columns.Count == 0)
        {
            throw new InvalidOperationException(
                $"None of the {rows.Count} children below this node hold a scalar field, so a table of them " +
                "would have a column of names and nothing else. This shape is not tabular — JSON keeps it.");
        }

        if (skipped > 0)
        {
            result.Issues.Add(new DumpIssueDto
            {
                Path = path,
                Kind = "node.unsupported",
                Reason = $"这些行下方有 {skipped} 个节点是画布、声音、链接或深于 "
                         + $"{depth} 层,没有单元格能容纳它们。它们都在 JSON 导出中。",
            });
        }

        // The key column's header has to be one no field claimed, or the table
        // has two columns called "name" and no reader can tell which is the row
        // key. String.wz/Mob.img is exactly that case: every row HAS a field
        // called name.
        string keyColumn = "name";
        if (columns.Contains(keyColumn, StringComparer.OrdinalIgnoreCase))
        {
            int suffix = 0;
            do { keyColumn = suffix == 0 ? "#name" : $"#name{suffix}"; suffix++; }
            while (columns.Contains(keyColumn, StringComparer.OrdinalIgnoreCase));

            result.Issues.Add(new DumpIssueDto
            {
                Path = path,
                Kind = "name.collision",
                Reason = $"这些行自带名为 'name' 的字段,因此保存每行键的列改用 '{keyColumn}' 作为标题。",
            });
        }

        StringBuilder csv = new();
        csv.Append(Csv(keyColumn));
        foreach (string column in columns)
        {
            csv.Append(',');
            csv.Append(Csv(column));
        }
        csv.Append("\r\n");

        foreach ((string name, Dictionary<int, string> cells) in rows)
        {
            csv.Append(Csv(name));
            for (int i = 0; i < columns.Count; i++)
            {
                csv.Append(',');
                if (cells.TryGetValue(i, out string? value))
                    csv.Append(Csv(value));
            }
            csv.Append("\r\n");
        }

        // UTF-8 with a BOM: Excel reads a BOM-less UTF-8 CSV as the system
        // codepage and turns every non-ASCII item name into mojibake, and these
        // tables are full of Korean and Japanese names.
        byte[] data = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes(csv.ToString())).ToArray();
        result.Files = 1;
        result.Bytes = data.Length;
        result.Nodes = rows.Count;
        return (data, ExportService.Sanitise(NameOf(path)) + ".csv", result);
    }

    /// <summary>
    /// One row's scalar leaves, keyed by their path below the row.
    ///
    /// Through <see cref="WzWalk"/>, so a row holding a UOL that points back at
    /// its own parent flattens into a cell rather than into a stack overflow.
    /// </summary>
    private void Flatten(
        WzObject node, string prefix, Dictionary<int, string> cells,
        List<string> columns, Dictionary<string, int> columnIndex,
        WzWalk walk, int maxDepth, ref int skipped)
    {
        string? scalar = ScalarText(node);
        if (scalar != null)
        {
            if (prefix.Length == 0)
                prefix = "value";

            if (!columnIndex.TryGetValue(prefix, out int index))
            {
                if (columns.Count >= MaxCsvColumns)
                {
                    skipped++;
                    return;
                }
                index = columns.Count;
                columns.Add(prefix);
                columnIndex[prefix] = index;
            }
            cells[index] = scalar;
            return;
        }

        if (node is WzCanvasProperty or WzBinaryProperty)
        {
            skipped++;
            return;
        }

        int depth = prefix.Length == 0 ? 0 : prefix.Count(c => c == '/') + 1;
        if (depth >= maxDepth)
        {
            skipped++;
            return;
        }

        WzPropertyCollection? children = node is WzImageProperty property
            ? walk.Into(property, depth)
            : walk.From(node);

        if (children == null)
        {
            skipped++;
            return;
        }

        foreach (WzImageProperty child in children)
        {
            string name = child.Name ?? "";
            Flatten(child, prefix.Length == 0 ? name : prefix + "/" + name,
                    cells, columns, columnIndex, walk, maxDepth, ref skipped);
        }
    }

    /// <summary>
    /// The value of a leaf as text, or null when the node is not a leaf.
    ///
    /// A UOL counts as a leaf and its text is the reference, unresolved. That is
    /// the honest cell: following it would put another row's data in this row.
    /// </summary>
    internal static string? ScalarText(WzObject node) => node switch
    {
        WzIntProperty p => p.Value.ToString(CultureInfo.InvariantCulture),
        WzShortProperty p => p.Value.ToString(CultureInfo.InvariantCulture),
        WzLongProperty p => p.Value.ToString(CultureInfo.InvariantCulture),
        WzFloatProperty p => p.Value.ToString(CultureInfo.InvariantCulture),
        WzDoubleProperty p => p.Value.ToString(CultureInfo.InvariantCulture),
        WzStringProperty p => p.Value ?? "",
        WzUOLProperty p => p.Value ?? "",
        WzVectorProperty p => $"{p.X?.Value ?? 0},{p.Y?.Value ?? 0}",
        WzNullProperty => "",
        _ => null,
    };

    private static string Csv(string value)
    {
        bool needsQuotes = value.IndexOfAny(new[] { ',', '"', '\r', '\n' }) >= 0
            || value.StartsWith(' ') || value.EndsWith(' ');
        return needsQuotes ? "\"" + value.Replace("\"", "\"\"") + "\"" : value;
    }

    #endregion

    #region Shared

    /// <summary>
    /// One writer for every sidecar, manifest and report this feature produces.
    ///
    /// camelCase because the API's own serialiser is configured that way: a
    /// dump's <c>dump-report.json</c> and the same report fetched from
    /// <c>/api/dump/report</c> are the same object, and a script that reads one
    /// should not have to know which one it got.
    /// </summary>
    internal static readonly JsonSerializerOptions Indented = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    /// <summary>Where this came from, in a shape every export embeds.</summary>
    internal DumpProvenanceDto Provenance(string path)
    {
        DumpProvenanceDto provenance = new()
        {
            Node = Uri.UnescapeDataString(path),
            Exported = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
        };

        OpenFile? file = _session.TryGetFile(WzPath.FileId(path));
        if (file != null)
        {
            provenance.Archive = file.Name;
            provenance.ArchiveFile = file.FilePath;
            // A dump taken while the session holds unsaved edits does not match
            // the file it names, and six months later nothing else will say so.
            provenance.ArchiveHadUnsavedEdits = file.Dirty || file.CountDirtyImages() > 0;
        }
        return provenance;
    }

    internal DumpResultDto NewResult(string path, string format)
        => new() { Provenance = Provenance(path), Format = format };

    /// <summary>The report as it is written into a ZIP or returned from a job.</summary>
    internal static object Report(DumpResultDto result) => new
    {
        result.Provenance,
        result.Format,
        result.Files,
        result.Bytes,
        result.Canvases,
        result.Sounds,
        result.Nodes,
        result.LinksRecorded,
        result.Truncated,
        result.TruncatedReason,
        issueCount = result.Issues.Count,
        issues = result.Issues,
        note = result.Issues.Count == 0 && !result.Truncated
            ? "Everything under this node exported."
            : "Some of what is under this node did not export. Each case is listed above.",
    };

    private static string NameOf(string path)
    {
        string[] segments = WzPath.Split(path);
        string last = segments.Length == 0 ? "export" : segments[^1];
        int hash = last.LastIndexOf('#');
        if (hash > 0 && int.TryParse(last.AsSpan(hash + 1), out _))
            last = last[..hash];
        return last.Length == 0 ? "export" : last;
    }

    private static bool HasOwnPixels(WzObject node)
        => node is WzCanvasProperty canvas
           && canvas.PngProperty != null
           && !canvas.ContainsInlinkProperty()
           && !canvas.ContainsOutlinkProperty();

    internal static PointF SafeOrigin(WzCanvasProperty canvas)
    {
        try { return canvas.GetCanvasOriginPosition(); }
        catch { return new PointF(0, 0); }
    }

    internal static int ReadDelay(WzCanvasProperty canvas)
    {
        try
        {
            return canvas[WzCanvasProperty.AnimationDelayPropertyName] is { } delay
                && int.TryParse(delay.WzValue?.ToString(), out int ms)
                ? ms
                : 0;
        }
        catch { return 0; }
    }

    /// <summary>
    /// Blits a decoded PNG into a composed canvas without blending.
    ///
    /// <see cref="CompositingMode.SourceCopy"/> rather than the default: drawing
    /// a straight-alpha sprite over transparent black with source-over
    /// multiplies the colour by its own alpha, which turns every semi-transparent
    /// pixel darker on every export. Frames do not overlap inside a cell, so
    /// copying is both correct and exact.
    /// </summary>
    private static void Draw(Bitmap target, byte[] png, int x, int y)
    {
        using MemoryStream stream = new(png);
        using Image image = Image.FromStream(stream);
        using Graphics graphics = Graphics.FromImage(target);
        graphics.CompositingMode = CompositingMode.SourceCopy;
        graphics.InterpolationMode = InterpolationMode.NearestNeighbor;
        graphics.PixelOffsetMode = PixelOffsetMode.Half;
        graphics.DrawImage(image, new Rectangle(x, y, image.Width, image.Height));
    }

    /// <summary>
    /// A bitmap as straight-alpha RGBA, the layout both encoders take.
    ///
    /// GDI+ stores 32bppArgb as BGRA in little-endian memory order, so the two
    /// colour channels are swapped on the way out. Not premultiplied — the
    /// format is Format32bppArgb, not Format32bppPArgb — which is what lets the
    /// APNG carry the alpha through unchanged.
    /// </summary>
    internal static byte[] ToRgba(Bitmap bitmap)
    {
        Rectangle rect = new(0, 0, bitmap.Width, bitmap.Height);
        BitmapData data = bitmap.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            byte[] rgba = new byte[bitmap.Width * bitmap.Height * 4];
            byte[] row = new byte[bitmap.Width * 4];
            for (int y = 0; y < bitmap.Height; y++)
            {
                System.Runtime.InteropServices.Marshal.Copy(
                    data.Scan0 + y * data.Stride, row, 0, row.Length);
                int target = y * bitmap.Width * 4;
                for (int x = 0; x < row.Length; x += 4)
                {
                    rgba[target + x] = row[x + 2];
                    rgba[target + x + 1] = row[x + 1];
                    rgba[target + x + 2] = row[x];
                    rgba[target + x + 3] = row[x + 3];
                }
            }
            return rgba;
        }
        finally
        {
            bitmap.UnlockBits(data);
        }
    }

    internal static void Write(ZipArchive zip, string entryName, byte[] data)
    {
        ZipArchiveEntry entry = zip.CreateEntry(entryName, CompressionLevel.Fastest);
        using Stream stream = entry.Open();
        stream.Write(data, 0, data.Length);
    }

    internal static void WriteJson(ZipArchive zip, string entryName, object payload)
    {
        ZipArchiveEntry entry = zip.CreateEntry(entryName, CompressionLevel.Optimal);
        using Stream stream = entry.Open();
        JsonSerializer.Serialize(stream, payload, Indented);
    }

    #endregion
}
