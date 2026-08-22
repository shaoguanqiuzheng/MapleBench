using System.Drawing;
using System.Globalization;
using MapleLib.WzLib;
using MapleLib.WzLib.WzProperties;
using MapleBench.Models;

namespace MapleBench.Services;

/// <summary>
/// Presents an extracted client's equipment (Character.wz) as browsable rows.
///
/// Equips live one-per-image: <c>Character/&lt;part&gt;/&lt;itemId&gt;.img</c>
/// whose root is the item node (the image itself carries <c>info</c> and the
/// animation frames). Unlike Item.wz — a few hundred small aggregate images —
/// a v83 Character set is ~5,000 equips and every one carries animation frames,
/// so holding them all parsed weighs well over a gigabyte (measured). The list
/// is therefore built the way MobService builds its: each image is parsed only
/// long enough to read its summary, then unparsed again; a Detail or an edit
/// re-parses the single image it touches. The summary rows stay cached until
/// the tree's shape changes, and value edits patch just their own rows.
/// </summary>
public sealed class EquipmentService
{
    private const int MaxRows = 50_000;
    private const int ChunkSize = 24;

    private readonly WzSessionService _session;
    private readonly WzEditService _edit;
    private readonly StringPoolService _strings;
    private readonly UndoService _undo;

    /// <summary>Equipment parts this editor knows, keyed by directory name. Face/Hair/Afterimage are appearance data, not stat equipment, and are excluded.</summary>
    private static readonly Dictionary<string, string> PartNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Accessory"] = "饰品",
        ["Cap"] = "帽子",
        ["Cape"] = "披风",
        ["Coat"] = "上衣",
        ["Dragon"] = "龙装备",
        ["Glove"] = "手套",
        ["Longcoat"] = "长袍",
        ["Pants"] = "裤子",
        ["PetEquip"] = "宠物装备",
        ["Ring"] = "戒指",
        ["Shield"] = "盾牌",
        ["Shoes"] = "鞋子",
        ["TamingMob"] = "骑宠",
        ["Weapon"] = "武器",
    };

    /// <summary>One summary row, holding only what the list needs; the image tree is released after reading.</summary>
    private sealed class Row
    {
        public required string Path { get; init; }
        public required string Id { get; init; }
        public required string Part { get; init; }
        public required string PartName { get; init; }
        public string? Name;
        public bool Dirty;
        public string? Icon;
        public int ReqLevel;
        public int ReqStr;
    }

    private sealed class Cache
    {
        public required int Structure { get; init; }
        public required List<Row> Rows { get; init; }
        public required Dictionary<string, int> ByPath { get; init; }
        public required Dictionary<string, int> PartCounts { get; init; }
    }

    private Cache? _cache;

    public EquipmentService(WzSessionService session, WzEditService edit, StringPoolService strings, UndoService undo)
    {
        _session = session;
        _edit = edit;
        _strings = strings;
        _undo = undo;
    }

    /// <summary>Whether any archive that could hold Character equipment is open.</summary>
    public bool IsAvailable
    {
        get
        {
            lock (_session.Gate)
                return EquipmentArchives(null).Count > 0;
        }
    }

    private List<OpenFile> EquipmentArchives(string? fileId)
        => _session.SelectRoleSources("Character", fileId);

    #region Index (summary rows, images released)

    private void EnsureRows(string? fileId, CancellationToken cancel)
    {
        int structure = _session.StructureGeneration;
        if (_cache is { } cached && cached.Structure == structure)
            return;

        for (int attempt = 0; attempt < 3; attempt++)
        {
            Cache? built = TryBuild(fileId, structure, cancel);
            if (built != null)
            {
                _cache = built;
                return;
            }
            cancel.ThrowIfCancellationRequested();
            structure = _session.StructureGeneration;
        }

        // Build never quieted down after three tries (a session being edited
        // continuously). Serve whatever we last had, or an empty list: failing
        // towards the slow answer is the acceptable direction, but so is the
        // stale-yet-true one when the alternative is spinning forever.
        _cache ??= new Cache
        {
            Structure = structure,
            Rows = new List<Row>(),
            ByPath = new Dictionary<string, int>(StringComparer.Ordinal),
            PartCounts = new Dictionary<string, int>(StringComparer.Ordinal),
        };
    }

    private Cache? TryBuild(string? fileId, int structure, CancellationToken cancel)
    {
        List<(WzImage Placeholder, string Path, string Part)> work = new();
        int generation;
        lock (_session.Gate)
        {
            generation = _session.Generation;
            foreach (OpenFile file in EquipmentArchives(fileId))
            {
                WzDirectory? root = _session.RoleRoot(file, "Character");
                if (root == null)
                    continue;
                string rootPath = _session.RoleRootPath(file, "Character");
                foreach (WzDirectory partDir in root.WzDirectories)
                {
                    string part = partDir.Name ?? "";
                    if (!PartNames.ContainsKey(part))
                        continue;
                    string partPath = WzPath.Child(rootPath, part);
                    foreach (WzImage placeholder in partDir.WzImages)
                    {
                        if (work.Count >= MaxRows)
                            break;
                        string id = Path.GetFileNameWithoutExtension(placeholder.Name);
                        if (id.Length == 0 || !id.All(char.IsAsciiDigit))
                            continue;
                        work.Add((placeholder, WzPath.Child(partPath, placeholder.Name), part));
                    }
                }
            }
        }

        List<Row> rows = new(work.Count);
        bool complete = _session.TryRunChunked(generation, work, item =>
        {
            if (rows.Count >= MaxRows)
                return;
            WzImage image = _session.MaterializeImage(item.Placeholder);
            WzSessionService.EnsureParsed(image);
            if (image["info"] is WzSubProperty info)
            {
                string id = Path.GetFileNameWithoutExtension(image.Name);
                bool changed = image.Changed;
                rows.Add(new Row
                {
                    Path = item.Path,
                    Id = id,
                    Part = item.Part,
                    PartName = PartNames[item.Part],
                    Name = _strings.GetItemName(TryEquipId(id)),
                    Dirty = changed,
                    Icon = EquipIconPath(info, item.Path),
                    ReqLevel = IntOf(info, "reqLevel"),
                    ReqStr = IntOf(info, "reqSTR"),
                });
                // Released once the summary is read: holding every equip's full
                // animation tree resident is what makes the index weigh >1 GB.
                // UnparseImage keeps the reader and the Changed flag, so a later
                // Detail or edit re-parses the one image from the same bytes.
                if (!changed)
                    image.UnparseImage();
            }
        }, ChunkSize, interleave: true, cancel);

        if (!complete)
            return null;

        Dictionary<string, int> byPath = new(rows.Count, StringComparer.Ordinal);
        Dictionary<string, int> partCounts = new(PartNames.Count, StringComparer.Ordinal);
        for (int i = 0; i < rows.Count; i++)
        {
            byPath[rows[i].Path] = i;
            partCounts[rows[i].Part] = partCounts.GetValueOrDefault(rows[i].Part) + 1;
        }
        return new Cache { Structure = structure, Rows = rows, ByPath = byPath, PartCounts = partCounts };
    }

    /// <summary>
    /// Re-reads the rows for the named equips after a value edit, so the cached
    /// list reflects the new value/dirty/icon without a full ~5,000-image
    /// rebuild. The edit has set Changed on the images, so they stay parsed.
    /// </summary>
    private void TouchRows(IEnumerable<string> paths)
    {
        if (_cache == null)
            return;
        lock (_session.Gate)
        {
            foreach (string path in paths)
            {
                if (!_cache.ByPath.TryGetValue(path, out int index))
                    continue;
                if (_session.Resolve(path) is not WzImage image)
                    continue;
                WzSessionService.EnsureParsed(image);
                Row row = _cache.Rows[index];
                if (image["info"] is WzSubProperty info)
                {
                    row.Name = _strings.GetItemName(TryEquipId(row.Id));
                    row.Dirty = image.Changed;
                    row.Icon = EquipIconPath(info, path);
                    row.ReqLevel = IntOf(info, "reqLevel");
                    row.ReqStr = IntOf(info, "reqSTR");
                }
            }
        }
    }

    #endregion

    #region Browse

    public EquipmentListDto List(
        string? fileId, int offset, int limit,
        string? part, string? search, bool? dirtyOnly, CancellationToken cancel = default)
    {
        _strings.Warm(cancel, allowExclusiveFallback: true);

        lock (_session.Gate)
        {
            EnsureRows(fileId, cancel);
            Cache cache = _cache!;

            EquipmentListDto result = new() { Offset = offset, Limit = limit };
            foreach ((string key, int count) in cache.PartCounts)
                result.Parts[key] = count;

            List<EquipmentSummaryDto> matched = new(capacity: cache.Rows.Count);
            foreach (Row row in cache.Rows)
            {
                if (cancel.IsCancellationRequested)
                    break;
                if (dirtyOnly == true && !row.Dirty)
                    continue;
                if (part != null && !string.Equals(part, row.Part, StringComparison.OrdinalIgnoreCase))
                    continue;
                if (!string.IsNullOrEmpty(search))
                {
                    bool matches = (row.Name?.Contains(search, StringComparison.OrdinalIgnoreCase) ?? false)
                        || row.Id.Contains(search, StringComparison.OrdinalIgnoreCase)
                        || row.PartName.Contains(search, StringComparison.OrdinalIgnoreCase);
                    if (!matches)
                        continue;
                }
                matched.Add(new EquipmentSummaryDto
                {
                    Path = row.Path,
                    ItemId = row.Id,
                    Name = row.Name,
                    Part = row.PartName,
                    Dirty = row.Dirty,
                    Icon = row.Icon,
                    ReqLevel = row.ReqLevel,
                    ReqStr = row.ReqStr,
                });
            }

            result.Total = matched.Count;
            int pageLimit = limit <= 0 ? 200 : Math.Clamp(limit, 1, 500);
            result.Items = matched.Skip(offset).Take(pageLimit).ToList();
            result.Truncated = matched.Count > offset + result.Items.Count;
            return result;
        }
    }

    public EquipmentDetailDto Detail(string path)
    {
        lock (_session.Gate)
        {
            WzImage image = ResolveEquipImage(path);
            WzSubProperty? info = image["info"] as WzSubProperty;
            if (info == null)
                throw new InvalidOperationException($"'{path}' has no info section.");

            string id = Path.GetFileNameWithoutExtension(path);
            EquipmentDetailDto dto = new()
            {
                Path = path,
                ItemId = id,
                Name = _strings.GetItemName(TryEquipId(id)),
                Part = PartNameOf(path),
                Dirty = image.Changed,
                Icon = EquipIconPath(info, path),
                IconReward = EquipIconRewardPath(info, path),
            };

            foreach (string key in new[] { "iconRaw", "icon", "iconReward" })
            {
                string? iconPath = key == "iconReward"
                    ? EquipIconRewardPath(info, path)
                    : info[key] is WzCanvasProperty or WzUOLProperty
                        ? WzPath.Child(WzPath.Child(path, "info"), key)
                        : null;
                if (iconPath == null)
                    continue;
                dto.Icons.Add(new ItemIconDto
                {
                    Key = key,
                    Label = IconLabel(key),
                    Path = iconPath,
                    Size = CanvasSize(_session.Resolve(iconPath)),
                });
            }

            string infoPath = WzPath.Child(path, "info");
            dto.Fields.AddRange(ScalarFieldsOf(info, infoPath, "info"));

            // info > level > info: each child is one upgrade level. A node named
            // "1" means the equipment can be upgraded to level 1, "2" to level 2,
            // and so on; the node holds that level's stat fields (exp, incPAD…).
            if (info["level"] is WzSubProperty level && level["info"] is WzSubProperty levelInfo)
            {
                foreach (WzImageProperty node in levelInfo.WzProperties)
                {
                    if (node is not WzSubProperty subNode)
                        continue;
                    if (!int.TryParse(node.Name, NumberStyles.None, CultureInfo.InvariantCulture, out int n))
                        continue;
                    string nodeRel = $"info/level/info/{node.Name}";
                    dto.Levels.Add(new EquipmentLevelDto
                    {
                        Level = n,
                        Fields = ScalarFieldsOf(subNode, $"{path}/{nodeRel}", nodeRel),
                    });
                }
                dto.Levels.Sort((a, b) => a.Level.CompareTo(b.Level));
            }
            return dto;
        }
    }

    /// <summary>
    /// Parses the scalar fields of a property container into detail DTOs. Used
    /// for the info section and for every info/level/info upgrade-level node.
    /// </summary>
    private static List<EquipmentFieldDto> ScalarFieldsOf(WzSubProperty container, string containerPath, string relBase)
    {
        List<EquipmentFieldDto> fields = new();
        foreach (WzImageProperty prop in container.WzProperties)
        {
            string key = prop.Name ?? "";
            bool isCanvas = prop is WzCanvasProperty or WzUOLProperty;
            bool isContainer = prop.WzValue is null && (prop.WzProperties?.Count ?? 0) > 0;
            fields.Add(new EquipmentFieldDto
            {
                Key = key,
                Label = key,
                Group = GroupOf(key),
                Kind = isCanvas ? "Canvas" : isContainer ? "Container" : KindOf(prop),
                Value = isCanvas
                    ? null
                    : isContainer
                        ? $"{prop.WzProperties!.Count} entries"
                        : prop.WzValue?.ToString(),
                Path = WzPath.Child(containerPath, key),
                RelPath = $"{relBase}/{key}",
                Present = true,
                Editable = !isContainer && !isCanvas,
            });
        }
        return fields;
    }

    private static string KindOf(WzImageProperty prop) => prop switch
    {
        WzIntProperty or WzShortProperty or WzLongProperty => "Int",
        WzStringProperty => "Text",
        _ => "Text",
    };

    /// <summary>Which collapsible section an equipment field is shown under.</summary>
    private static string GroupOf(string key)
    {
        if (key.StartsWith("req", StringComparison.OrdinalIgnoreCase))
            return "需求";
        if (key.StartsWith("inc", StringComparison.OrdinalIgnoreCase))
            return "加成";
        if (key.EndsWith("Max", StringComparison.OrdinalIgnoreCase)
            || key.EndsWith("Min", StringComparison.OrdinalIgnoreCase))
            return "升级";
        return key switch
        {
            "tuc" or "exp" => "升级",
            "price" or "cash" or "notSale" or "only" or "tradeBlock"
                or "equipTradeBlock" or "timeLimited" => "交易",
            "islot" or "vslot" or "attackSpeed" or "knockback" => "穿戴",
            _ => "其他",
        };
    }

    private static int IntOf(WzSubProperty info, string name) => info[name] switch
    {
        WzIntProperty i => i.Value,
        WzShortProperty s => s.Value,
        WzLongProperty l => (int)l.Value,
        _ => 0,
    };

    private static string PartNameOf(string path)
    {
        // path = f1/Character/<part>/<id>.img — the part is segment 2 (0=f1).
        string[] segments = path.Split('/');
        return segments.Length > 2 && PartNames.TryGetValue(segments[2], out string? name)
            ? name
            : segments.Length > 2 ? segments[2] : "";
    }

    private static string? CanvasSize(WzObject node)
    {
        WzCanvasProperty? canvas = node switch
        {
            WzCanvasProperty c => c,
            WzUOLProperty uol => uol.LinkValue as WzCanvasProperty,
            _ => null,
        };
        return canvas?.PngProperty is { } png ? $"{png.Width} x {png.Height}" : null;
    }

    private static string IconLabel(string key) => key switch
    {
        "iconRaw" => "原始图标",
        "icon" => "图标",
        "iconReward" => "奖励图标",
        _ => key,
    };

    private static int TryEquipId(string id)
        => int.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out int value) ? value : 0;

    #endregion

    #region Read helpers

    private WzImage ResolveEquipImage(string path)
    {
        if (_session.Resolve(path) is not WzImage image)
            throw new InvalidOperationException($"'{path}' is not an equipment image.");
        WzSessionService.EnsureParsed(image);
        return image;
    }

    /// <summary>Walks a relative path (e.g. "info/level/info/1/exp") from the image root.</summary>
    private static WzImageProperty? ResolveByPath(WzImage image, string relPath)
    {
        WzObject current = image;
        foreach (string part in relPath.Split('/'))
        {
            current = current switch
            {
                WzSubProperty sub => sub[part],
                WzImage img => img[part],
                _ => null,
            };
            if (current == null)
                return null;
        }
        return current as WzImageProperty;
    }

    private static string? EquipIconPath(WzSubProperty? info, string equipPath)
    {
        if (info == null)
            return null;
        foreach (string name in new[] { "iconRaw", "icon" })
        {
            if (info[name] is WzCanvasProperty or WzUOLProperty)
                return WzPath.Child(WzPath.Child(equipPath, "info"), name);
        }
        return null;
    }

    private static string? EquipIconRewardPath(WzSubProperty? info, string equipPath)
    {
        if (info == null)
            return null;
        if (info["iconReward"] is WzSubProperty container)
        {
            if (container["0"] is WzCanvasProperty or WzUOLProperty)
                return WzPath.Child(WzPath.Child(equipPath, "info"), "iconReward/0");
        }
        else if (info["iconReward"] is WzCanvasProperty or WzUOLProperty)
        {
            return WzPath.Child(WzPath.Child(equipPath, "info"), "iconReward");
        }
        return null;
    }

    #endregion

    #region Write

    /// <summary>
    /// Applies a set of fields to many equips in one undo batch, creating
    /// missing fields (SetOrCreate, same as the Item editor's bulk).
    /// </summary>
    public ItemBulkResultDto Bulk(ItemBulkRequest request)
    {
        ItemBulkResultDto result = new();
        if (request.Fields is null || request.Fields.Count == 0)
            return result;

        lock (_session.Gate)
        {
            List<(string FieldPath, string Op, string Type, string Value, ItemBulkChangeDto Row)> writes = new();
            List<string> touched = new();

            foreach (string path in request.Paths ?? new List<string>())
            {
                ItemBulkChangeDto change = new() { Path = path };
                result.Changes.Add(change);

                WzImage image;
                try
                {
                    image = ResolveEquipImage(path);
                }
                catch (Exception ex)
                {
                    change.Skipped = true;
                    change.Reason = ex.Message;
                    continue;
                }

                WzSubProperty? info = image["info"] as WzSubProperty;
                if (info == null)
                {
                    change.Skipped = true;
                    change.Reason = "This equipment has no info section.";
                    continue;
                }

                change.ItemId = Path.GetFileNameWithoutExtension(path);
                change.Name = _strings.GetItemName(TryEquipId(change.ItemId));
                touched.Add(path);

                string infoPath = WzPath.Child(path, "info");
                foreach (ItemWriteField field in request.Fields)
                {
                    if (string.IsNullOrWhiteSpace(field.Key))
                        continue;
                    string fieldPath;
                    WzImageProperty? existing;
                    if (!string.IsNullOrWhiteSpace(field.RelPath))
                    {
                        // Nested field (info/level/info/…) — the default info/{Key}
                        // cannot reach it. Join with plain string concatenation:
                        // WzPath.Child escapes slashes.
                        fieldPath = $"{path}/{field.RelPath}";
                        existing = ResolveByPath(image, field.RelPath);
                    }
                    else
                    {
                        fieldPath = WzPath.Child(infoPath, field.Key);
                        existing = info[field.Key];
                    }
                    if (existing is WzSubProperty or WzCanvasProperty or WzUOLProperty)
                    {
                        change.Skipped = true;
                        change.Reason = $"'{field.Key}' is not a scalar on this equipment.";
                        break;
                    }
                    writes.Add((fieldPath, existing != null ? "Set" : "Add",
                        string.IsNullOrWhiteSpace(field.Type) ? "Int" : field.Type, field.Value ?? "0", change));
                }
            }

            if (writes.Count > 0)
            {
                using IDisposable batch = _undo.Batch(
                    $"Edit {request.Fields.Count} fields on {request.Paths?.Count ?? 0} equips");

                foreach ((string fieldPath, string op, string type, string value, ItemBulkChangeDto row) in writes)
                {
                    try
                    {
                        if (op == "Set")
                        {
                            _edit.SetValue(fieldPath, value);
                        }
                        else
                        {
                            string parent = fieldPath[..fieldPath.LastIndexOf('/')];
                            string name = fieldPath[(fieldPath.LastIndexOf('/') + 1)..];
                            _edit.Add(new AddNodeRequest { Path = parent, Name = name, Type = type, Value = value });
                        }
                        result.Applied++;
                    }
                    catch (Exception ex)
                    {
                        row.Skipped = true;
                        row.Reason = ex.Message;
                        result.Skipped++;
                    }
                }
            }

            TouchRows(touched);
            return result;
        }
    }

    /// <summary>
    /// Adds an upgrade-level node under info/level/info (named by the given
    /// level, or max+1 when none is given), seeded with exp = 0. Returns the
    /// level number that was created.
    /// </summary>
    public int AddLevel(string path, int? level)
    {
        lock (_session.Gate)
        {
            WzImage image = ResolveEquipImage(path);
            if (image["info"] is not WzSubProperty info)
                throw new InvalidOperationException("此装备没有 info 段。");
            if (info["level"] is not WzSubProperty levelContainer
                || levelContainer["info"] is not WzSubProperty levelInfo)
                throw new InvalidOperationException("此装备没有升级信息段（info/level/info）。");

            int next = level ?? MaxLevelOf(levelInfo) + 1;
            string name = next.ToString(CultureInfo.InvariantCulture);
            if (levelInfo[name] != null)
                throw new InvalidOperationException($"升级等级 {next} 已存在。");
            string levelInfoPath = $"{path}/info/level/info";

            using IDisposable batch = _undo.Batch($"Add upgrade level {next} to {Path.GetFileNameWithoutExtension(path)}");
            _edit.Add(new AddNodeRequest { Path = levelInfoPath, Name = name, Type = "SubProperty", Value = null });
            _edit.Add(new AddNodeRequest { Path = $"{levelInfoPath}/{name}", Name = "exp", Type = "Int", Value = "0" });
            TouchRows(new[] { path });
            return next;
        }
    }

    /// <summary>Removes one upgrade-level node (info/level/info/{level}).</summary>
    public void RemoveLevel(string path, int level)
    {
        lock (_session.Gate)
        {
            ResolveEquipImage(path);
            string nodePath = $"{path}/info/level/info/{level}";
            using IDisposable batch = _undo.Batch($"Remove upgrade level {level} from {Path.GetFileNameWithoutExtension(path)}");
            _edit.Delete(new[] { nodePath });
            TouchRows(new[] { path });
        }
    }

    /// <summary>
    /// Removes one scalar field by its relative path (e.g. "info/tuc" for a top
    /// level field, or "info/level/info/1/exp" for an upgrade-level field).
    /// Canvas and container nodes are refused.
    /// </summary>
    public void RemoveField(string path, string relPath)
    {
        lock (_session.Gate)
        {
            if (string.IsNullOrWhiteSpace(relPath))
                throw new InvalidOperationException("字段路径不能为空。");
            WzImage image = ResolveEquipImage(path);
            WzImageProperty? existing = ResolveByPath(image, relPath);
            if (existing == null)
                throw new InvalidOperationException($"字段 {relPath} 不存在。");
            if (existing is WzCanvasProperty or WzUOLProperty or WzSubProperty)
                throw new InvalidOperationException($"字段 {relPath} 不是标量字段，无法删除。");

            using IDisposable batch = _undo.Batch($"Remove field {relPath} from {Path.GetFileNameWithoutExtension(path)}");
            _edit.Delete(new[] { $"{path}/{relPath}" });
            TouchRows(new[] { path });
        }
    }

    /// <summary>The highest numeric upgrade level in info/level/info, 0 when none.</summary>
    private static int MaxLevelOf(WzSubProperty levelInfo)
    {
        int max = 0;
        foreach (WzImageProperty node in levelInfo.WzProperties)
        {
            if (int.TryParse(node.Name, NumberStyles.None, CultureInfo.InvariantCulture, out int n)
                && n > max)
                max = n;
        }
        return max;
    }

    /// <summary>
    /// Replaces one of the equipment's icon canvases with a user-supplied PNG.
    /// </summary>
    public EquipmentDetailDto ReplaceIcon(string path, string key, byte[] pngBytes)
    {
        lock (_session.Gate)
        {
            if (key is not ("iconRaw" or "icon" or "iconReward"))
                throw new InvalidOperationException($"'{key}' is not a replaceable icon.");

            WzImage image = ResolveEquipImage(path);
            WzSubProperty? info = image["info"] as WzSubProperty;
            string? canvasPath = key == "iconReward"
                ? EquipIconRewardPath(info, path)
                : info?[key] is WzCanvasProperty or WzUOLProperty
                    ? WzPath.Child(WzPath.Child(path, "info"), key)
                    : null;
            if (canvasPath == null)
                throw new InvalidOperationException($"This equipment has no '{key}' canvas.");

            using var stream = new MemoryStream(pngBytes);
            using var bitmap = new Bitmap(stream);

            _edit.ReplaceCanvasValue(canvasPath, bitmap);
            TouchRows(new[] { path });
            return Detail(path);
        }
    }

    #endregion
}
