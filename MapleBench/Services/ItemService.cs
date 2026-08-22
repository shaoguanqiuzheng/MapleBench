using System.Drawing;
using System.Globalization;
using MapleLib.WzLib;
using MapleLib.WzLib.WzProperties;
using MapleBench.Models;

namespace MapleBench.Services;

/// <summary>
/// Presents an extracted client's Item data as items rather than as property
/// trees.
///
/// The source this models (MapleImgEditor) works over grouped .img files whose
/// shape is <c>&lt;aggregate img&gt;/&lt;itemId&gt;/info</c> — the item's info
/// section holds its icon canvases (<c>info/iconRaw</c>, <c>info/icon</c>) and
/// its stat fields. That is the layout this service indexes, and it is also the
/// one the WZ tree already exposes, so every write goes through
/// <see cref="WzEditService"/> and shares one dirty state, one undo history and
/// one save pipeline with everything else. Nothing here mutates a MapleLib
/// object directly.
///
/// Unlike the Mob editor this keeps the indexed images parsed and resident:
/// there are only a handful of small aggregate images per category (a v83
/// Item set is a few hundred files), so retaining them costs little and keeps
/// the index's live property references valid — an edit lands on the same
/// object the list read from. A memory sweep can still unparse them; when that
/// happens the next read re-parses the one image it touches and re-hooks the
/// entry, so the index never serves a stale tree.
/// </summary>
public sealed class ItemService
{
    private const int MaxRows = 100_000;

    private const int MaxCachedIndexes = 8;

    private readonly WzSessionService _session;
    private readonly WzEditService _edit;
    private readonly StringPoolService _strings;
    private readonly UndoService _undo;

    /// <summary>The item index, rebuilt when the tree's shape changes.</summary>
    private readonly Dictionary<string, (int Structure, ItemIndex Index)> _indexCache =
        new(StringComparer.Ordinal);

    /// <summary>One item, as its session path and its live info section.</summary>
    private sealed class ItemEntry
    {
        public required string Id { get; init; }
        public required string Path { get; init; }
        public required string Category { get; init; }
        public required string Series { get; init; }
        public required string ImagePath { get; init; }

        /// <summary>Live info section; re-hooked if the image is ever unparsed.</summary>
        public WzSubProperty? Info { get; set; }
        public WzImage? Image { get; set; }
    }

    /// <summary>Every item in the archive, plus the aggregate images they came from.</summary>
    private sealed class ItemIndex
    {
        public List<ItemEntry> Entries { get; } = new();
        public Dictionary<string, ItemEntry> ByPath { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, int> Categories { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, WzImage> Images { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, List<ItemEntry>> ByImage { get; } = new(StringComparer.Ordinal);
    }

    public ItemService(WzSessionService session, WzEditService edit, StringPoolService strings, UndoService undo)
    {
        _session = session;
        _edit = edit;
        _strings = strings;
        _undo = undo;
    }

    /// <summary>Whether any archive that could hold items is open.</summary>
    public bool IsAvailable
    {
        get
        {
            lock (_session.Gate)
                return ItemArchives(null).Count > 0;
        }
    }

    #region Index

    private ItemIndex EnsureIndex(string? fileId)
    {
        string cacheKey = fileId ?? "*";
        lock (_session.Gate)
        {
            int generation = _session.StructureGeneration;
            if (_indexCache.TryGetValue(cacheKey, out (int Structure, ItemIndex Index) cached)
                && cached.Structure == generation)
            {
                RehookIfNeeded(cached.Index);
                return cached.Index;
            }

            ItemIndex index = new();
            foreach (OpenFile file in ItemArchives(fileId))
            {
                WzDirectory? root = _session.RoleRoot(file, "Item");
                if (root == null)
                    continue;
                string roleRootPath = _session.RoleRootPath(file, "Item");

                // Item/<category>/<series>.img/<itemId> — the category is the
                // directory under Item, the image is a small aggregate, the
                // children are the items.
                foreach (WzDirectory categoryDir in root.WzDirectories)
                {
                    string category = categoryDir.Name ?? "";
                    string categoryPath = WzPath.Child(roleRootPath, category);
                    foreach (WzImage placeholder in categoryDir.WzImages)
                    {
                        WzImage image = _session.MaterializeImage(placeholder);
                        WzSessionService.EnsureParsed(image);
                        string imagePath = WzPath.Child(categoryPath, image.Name);
                        List<ItemEntry> group = new();

                        foreach (WzImageProperty prop in image.WzProperties)
                        {
                            if (prop is not WzSubProperty itemNode)
                                continue;
                            string id = prop.Name ?? "";
                            if (id.Length == 0 || !id.All(char.IsAsciiDigit))
                                continue;
                            if (itemNode["info"] is not WzSubProperty info)
                                continue;

                            string itemPath = WzPath.Child(imagePath, id);
                            ItemEntry entry = new()
                            {
                                Id = id,
                                Path = itemPath,
                                Category = category,
                                Series = SeriesOf(image.Name),
                                ImagePath = imagePath,
                                Info = info,
                                Image = image,
                            };
                            group.Add(entry);
                            index.Entries.Add(entry);
                            index.ByPath[itemPath] = entry;
                        }

                        index.Images[imagePath] = image;
                        index.ByImage[imagePath] = group;
                        index.Categories[category] = index.Categories.GetValueOrDefault(category) + group.Count;
                    }
                }
            }

            _indexCache[cacheKey] = (generation, index);
            return index;
        }
    }

    /// <summary>
    /// A memory sweep unparses images to release their trees. The index holds
    /// live references into those trees, so when one is unparsed the next read
    /// re-parses the single aggregate image and re-hooks every entry under it —
    /// never serving a stale tree, and never re-parsing the whole category.
    /// </summary>
    private void RehookIfNeeded(ItemIndex index)
    {
        foreach (string imagePath in index.Images.Keys.ToList())
        {
            WzImage image = index.Images[imagePath];
            if (image.Parsed)
                continue;

            if (_session.Resolve(imagePath) is not WzImage fresh)
                continue;
            WzSessionService.EnsureParsed(fresh);
            index.Images[imagePath] = fresh;

            if (index.ByImage.TryGetValue(imagePath, out List<ItemEntry>? group))
            {
                foreach (ItemEntry entry in group)
                {
                    WzSubProperty? itemNode = fresh[entry.Id] as WzSubProperty;
                    entry.Info = itemNode?["info"] as WzSubProperty;
                    entry.Image = fresh;
                }
            }
        }
    }

    private ItemEntry FindEntry(string path)
    {
        // Callers hold the session gate; EnsureIndex re-takes it (re-entrant).
        ItemIndex index = EnsureIndex(WzPath.FileId(path));
        if (index.ByPath.TryGetValue(path, out ItemEntry? entry))
            return entry;
        throw new InvalidOperationException($"'{path}' is not an item.");
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

    private List<OpenFile> ItemArchives(string? fileId)
        => _session.SelectRoleSources("Item", fileId);

    private static string SeriesOf(string? imageName)
    {
        if (string.IsNullOrEmpty(imageName))
            return "";
        string stem = Path.GetFileNameWithoutExtension(imageName);
        return stem.EndsWith(".img", StringComparison.OrdinalIgnoreCase) ? stem[..^4] : stem;
    }

    #endregion

    #region Browse

    public ItemListDto List(
        string? fileId, int offset, int limit,
        string? search, string? category, bool? cash, bool? tradeBlock,
        int? minReq, int? maxReq, bool? dirtyOnly, CancellationToken cancel = default)
    {
        // Names come from String.wz; warming may take seconds and must not run
        // under the session gate (it takes the gate itself while building).
        _strings.Warm(cancel, allowExclusiveFallback: true);

        lock (_session.Gate)
        {
            ItemIndex index = EnsureIndex(fileId);
            ItemListDto result = new() { Offset = offset, Limit = limit };
            foreach ((string cat, int count) in index.Categories)
                result.Categories[cat] = count;

            List<ItemSummaryDto> rows = new(capacity: index.Entries.Count);
            foreach (ItemEntry entry in index.Entries)
            {
                if (cancel.IsCancellationRequested)
                    break;

                int itemId = TryItemId(entry.Id);
                string? name = _strings.GetItemName(itemId);
                bool dirty = entry.Image?.Changed ?? false;

                if (dirtyOnly == true && !dirty)
                    continue;
                if (category != null
                    && !string.Equals(category, entry.Category, StringComparison.OrdinalIgnoreCase))
                    continue;
                if (cash == true && GetInfoInt(entry.Info, "cash") != 1)
                    continue;
                if (tradeBlock == true && GetInfoInt(entry.Info, "tradeBlock") != 1)
                    continue;

                int reqLevel = GetInfoInt(entry.Info, "reqLevel");
                if (minReq.HasValue && reqLevel < minReq.Value)
                    continue;
                if (maxReq.HasValue && reqLevel > maxReq.Value)
                    continue;

                if (!string.IsNullOrEmpty(search))
                {
                    bool matches = (name?.Contains(search, StringComparison.OrdinalIgnoreCase) ?? false)
                        || entry.Id.Contains(search, StringComparison.OrdinalIgnoreCase)
                        || entry.Category.Contains(search, StringComparison.OrdinalIgnoreCase)
                        || entry.Series.Contains(search, StringComparison.OrdinalIgnoreCase);
                    if (!matches)
                        continue;
                }

                rows.Add(new ItemSummaryDto
                {
                    Path = entry.Path,
                    ItemId = entry.Id,
                    Name = name,
                    Category = entry.Category,
                    Series = entry.Series,
                    Dirty = dirty,
                    Icon = IconPath(entry.Info, entry.Path),
                    Price = GetInfoInt(entry.Info, "price"),
                    SlotMax = GetInfoInt(entry.Info, "slotMax"),
                });
            }

            result.Total = rows.Count;
            int pageLimit = limit <= 0 ? 200 : Math.Clamp(limit, 1, 500);
            result.Items = rows.Skip(offset).Take(pageLimit).ToList();
            result.Truncated = rows.Count > offset + result.Items.Count;
            return result;
        }
    }

    public ItemDetailDto Detail(string path)
    {
        lock (_session.Gate)
        {
            ItemEntry entry = FindEntry(path);
            int itemId = TryItemId(entry.Id);
            WzSubProperty? info = entry.Info;

            ItemDetailDto dto = new()
            {
                Path = entry.Path,
                ItemId = entry.Id,
                Name = _strings.GetItemName(itemId),
                Category = entry.Category,
                Series = entry.Series,
                Dirty = entry.Image?.Changed ?? false,
                Icon = IconPath(info, entry.Path),
                IconReward = IconRewardPath(info, entry.Path),
            };

            foreach (string key in new[] { "iconRaw", "icon", "iconReward" })
            {
                string? iconPath = key == "iconReward"
                    ? IconRewardPath(info, entry.Path)
                    : info?[key] is WzCanvasProperty or WzUOLProperty
                        ? WzPath.Child(WzPath.Child(path, "info"), key)
                        : null;
                if (iconPath == null)
                    continue;
                string? size = CanvasSize(_session.Resolve(iconPath));
                dto.Icons.Add(new ItemIconDto
                {
                    Key = key,
                    Label = IconLabel(key),
                    Path = iconPath,
                    Size = size,
                });
            }

            // Present fields first, keyed by what the item actually carries, then
            // the catalog entries it does not — the UI hides those behind a
            // toggle. An uncatalogued key is still shown.
            Dictionary<string, WzImageProperty> present = new(StringComparer.OrdinalIgnoreCase);
            if (info?.WzProperties != null)
            {
                foreach (WzImageProperty property in info.WzProperties)
                    present.TryAdd(property.Name ?? "", property);
            }

            foreach (ItemFieldSpec spec in ItemFieldCatalog.Fields)
            {
                present.TryGetValue(spec.Key, out WzImageProperty? property);
                dto.Fields.Add(Field(spec, property, WzPath.Child(WzPath.Child(path, "info"), spec.Key)));
            }

            foreach ((string key, WzImageProperty property) in present)
            {
                if (ItemFieldCatalog.Find(key) != null)
                    continue;
                dto.Fields.Add(Field(ItemFieldCatalog.Unknown(key), property,
                    WzPath.Child(WzPath.Child(path, "info"), key), known: false));
            }

            return dto;
        }
    }

    private static ItemFieldDto Field(ItemFieldSpec spec, WzImageProperty? property, string fieldPath, bool known = true)
    {
        bool isContainer = property is not null
            && property.WzValue is null
            && property.WzProperties?.Count > 0;
        bool isCanvas = property is WzCanvasProperty or WzUOLProperty;

        // Catalogued fields keep the catalog's kind (so Bool stays a switch even
        // though WZ stores it as Int). Unfamiliar fields reflect their real WZ
        // scalar type, otherwise a new String field would render as an Int box.
        string kind = isCanvas ? "Canvas" : isContainer ? "Container" : spec.Kind;
        if (!known && !isCanvas && !isContainer)
        {
            kind = property switch
            {
                WzStringProperty => "Text",
                WzIntProperty or WzShortProperty or WzLongProperty => "Int",
                _ => spec.Kind,
            };
        }

        return new ItemFieldDto
        {
            Key = spec.Key,
            Label = spec.Label,
            Group = spec.Group,
            Kind = kind,
            Value = isCanvas
                ? null
                : isContainer
                    ? $"{property!.WzProperties!.Count} entries"
                    : property?.WzValue?.ToString(),
            Path = fieldPath,
            Present = property != null,
            Editable = !isContainer && !isCanvas,
        };
    }

    private static int GetInfoInt(WzSubProperty? info, string name)
    {
        return info?[name] switch
        {
            WzIntProperty i => i.Value,
            WzShortProperty s => s.Value,
            WzLongProperty l => (int)Math.Clamp(l.Value, int.MinValue, int.MaxValue),
            _ => 0,
        };
    }

    private static int TryItemId(string id)
        => int.TryParse(id, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value) ? value : 0;

    /// <summary>
    /// The item's icon canvas. This data's layout keeps the icons inside the
    /// info section (info/iconRaw preferred, then info/icon), so that is where
    /// the path points; a UOL is resolved to its canvas for the check but the
    /// path returned is the UOL's own, which /api/thumb renders.
    /// </summary>
    private static string? IconPath(WzSubProperty? info, string itemPath)
    {
        if (info == null)
            return null;
        string infoPath = WzPath.Child(itemPath, "info");
        foreach (string name in new[] { "iconRaw", "icon" })
        {
            if (info[name] is WzCanvasProperty or WzUOLProperty)
                return WzPath.Child(infoPath, name);
        }
        return null;
    }

    private static string? IconRewardPath(WzSubProperty? info, string itemPath)
    {
        if (info == null)
            return null;
        if (info["iconReward"] is WzSubProperty container)
        {
            if (container["0"] is WzCanvasProperty or WzUOLProperty)
                return WzPath.Child(WzPath.Child(itemPath, "info"), "iconReward/0");
        }
        else if (info["iconReward"] is WzCanvasProperty or WzUOLProperty)
        {
            return WzPath.Child(WzPath.Child(itemPath, "info"), "iconReward");
        }
        return null;
    }

    private static string IconLabel(string key) => key switch
    {
        "iconRaw" => "原始图标",
        "icon" => "图标",
        "iconReward" => "奖励图标",
        _ => key,
    };

    private static string? CanvasSize(WzObject node)
    {
        WzCanvasProperty? canvas = node switch
        {
            WzCanvasProperty c => c,
            WzUOLProperty uol => _unfoldCanvas(uol),
            _ => null,
        };
        return canvas?.PngProperty is { } png ? $"{png.Width} x {png.Height}" : null;

        static WzCanvasProperty? _unfoldCanvas(WzUOLProperty uol)
        {
            WzObject? target = uol.LinkValue;
            return target as WzCanvasProperty;
        }
    }

    #endregion

    #region Write

    /// <summary>
    /// Applies a set of fields to many items in one undo batch, creating fields
    /// that are missing (the SetOrCreate behaviour the source editor uses).
    /// </summary>
    public ItemBulkResultDto Bulk(ItemBulkRequest request)
    {
        ItemBulkResultDto result = new();
        if (request.Fields is null || request.Fields.Count == 0)
            return result;

        lock (_session.Gate)
        {
            List<(string FieldPath, string Op, string Type, string Value, ItemBulkChangeDto Row)> writes = new();
            HashSet<ItemEntry> touched = new();

            foreach (string path in request.Paths ?? new List<string>())
            {
                ItemBulkChangeDto change = new() { Path = path };
                result.Changes.Add(change);

                ItemEntry entry;
                try
                {
                    entry = FindEntry(path);
                }
                catch (Exception ex)
                {
                    change.Skipped = true;
                    change.Reason = ex.Message;
                    continue;
                }

                change.ItemId = entry.Id;
                change.Name = _strings.GetItemName(TryItemId(entry.Id));
                WzSubProperty? info = entry.Info;
                if (info == null)
                {
                    change.Skipped = true;
                    change.Reason = "Item has no info section.";
                    continue;
                }
                touched.Add(entry);

                string infoPath = WzPath.Child(path, "info");
                foreach (ItemWriteField field in request.Fields)
                {
                    if (string.IsNullOrWhiteSpace(field.Key))
                        continue;
                    string fieldPath;
                    WzImageProperty? existing;
                    if (!string.IsNullOrWhiteSpace(field.RelPath))
                    {
                        if (_session.Resolve(path) is not WzImage image)
                            throw new InvalidOperationException($"'{path}' is not an item image.");
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
                        change.Reason = $"'{field.Key}' is not a scalar on this item.";
                        break;
                    }
                    writes.Add((fieldPath, existing != null ? "Set" : "Add",
                        string.IsNullOrWhiteSpace(field.Type) ? "Int" : field.Type, field.Value ?? "0", change));
                }
            }

            if (writes.Count > 0)
            {
                using IDisposable batch = _undo.Batch(
                    $"Edit {request.Fields.Count} fields on {request.Paths?.Count ?? 0} items");

                // Per row, so one failure cannot leave a half-applied batch that
                // 500s the request — the write response reports what landed.
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
                            _edit.Add(new AddNodeRequest
                            {
                                Path = fieldPath[..fieldPath.LastIndexOf('/')],
                                Name = fieldPath[(fieldPath.LastIndexOf('/') + 1)..],
                                Type = type,
                                Value = value,
                            });
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

                // An edit lands on the manager's current instance of the image
                // (the LRU cache may have evicted the one the index held, so the
                // write re-loaded the file and edited a fresh instance). Re-point
                // every touched entry at that instance so a follow-up read shows
                // the value that was just written rather than the stale tree.
                foreach (ItemEntry entry in touched)
                {
                    if (_session.Resolve(entry.ImagePath) is WzImage fresh)
                    {
                        WzSessionService.EnsureParsed(fresh);
                        entry.Image = fresh;
                        entry.Info = fresh[entry.Id]?["info"] as WzSubProperty;
                    }
                }
            }

            return result;
        }
    }

    /// <summary>
    /// Removes one scalar field from the item's info section (info/{key}).
    /// Canvas and container fields are refused — the icon editor is the safe
    /// place to touch those.
    /// </summary>
    public void RemoveField(string path, string key)
    {
        lock (_session.Gate)
        {
            if (string.IsNullOrWhiteSpace(key))
                throw new InvalidOperationException("字段名不能为空。");
            ItemEntry entry = FindEntry(path);
            WzSubProperty? info = entry.Info ?? throw new InvalidOperationException("此物品没有 info 段。");
            if (info[key] is not WzImageProperty existing)
                throw new InvalidOperationException($"字段 {key} 不存在。");
            if (existing is WzCanvasProperty or WzUOLProperty or WzSubProperty)
                throw new InvalidOperationException($"字段 {key} 不是标量字段，无法删除。");

            string fieldPath = WzPath.Child(WzPath.Child(path, "info"), key);
            using IDisposable batch = _undo.Batch($"Remove field {key} from item {entry.Id}");
            _edit.Delete(new[] { fieldPath });

            // Re-point the entry at the freshly edited instance, like the bulk
            // writer, so the next read no longer shows the deleted field.
            if (_session.Resolve(entry.ImagePath) is WzImage fresh)
            {
                WzSessionService.EnsureParsed(fresh);
                entry.Image = fresh;
                entry.Info = fresh[entry.Id]?["info"] as WzSubProperty;
            }
        }
    }

    /// <summary>
    /// Replaces one of the item's icon canvases (iconRaw / icon / iconReward)
    /// with a user-supplied PNG. The PNG is decoded, recompressed into the
    /// canvas and recorded as one reversible edit; then the entry is re-pointed
    /// at the freshly edited instance (same re-hook the bulk writer does) so the
    /// returned detail shows the new image.
    /// </summary>
    public ItemDetailDto ReplaceIcon(string path, string key, byte[] pngBytes)
    {
        lock (_session.Gate)
        {
            if (key is not ("iconRaw" or "icon" or "iconReward"))
                throw new InvalidOperationException($"'{key}' is not a replaceable icon.");

            ItemEntry entry = FindEntry(path);
            string? canvasPath = key == "iconReward"
                ? IconRewardPath(entry.Info, entry.Path)
                : entry.Info?[key] is WzCanvasProperty or WzUOLProperty
                    ? WzPath.Child(WzPath.Child(path, "info"), key)
                    : null;
            if (canvasPath == null)
                throw new InvalidOperationException($"This item has no '{key}' canvas.");

            using var stream = new MemoryStream(pngBytes);
            using var bitmap = new Bitmap(stream);

            _edit.ReplaceCanvasValue(canvasPath, bitmap);

            if (_session.Resolve(entry.ImagePath) is WzImage fresh)
            {
                WzSessionService.EnsureParsed(fresh);
                entry.Image = fresh;
                entry.Info = fresh[entry.Id]?["info"] as WzSubProperty;
            }

            return Detail(path);
        }
    }

    #endregion
}

/// <summary>One catalogued item field: key, label, edit kind and display group.</summary>
public sealed class ItemFieldSpec
{
    public ItemFieldSpec(string key, string label, string kind = "Int", string group = "其他")
    {
        Key = key;
        Label = label;
        Kind = kind;
        Group = group;
    }

    public string Key { get; }
    public string Label { get; }
    /// <summary>Int | Bool | Text</summary>
    public string Kind { get; }
    /// <summary>The section the field is shown under, e.g. 属性加成 / 交易.</summary>
    public string Group { get; }
}

/// <summary>
/// The item fields worth editing, in display order. This is the stat set of the
/// source item editor plus the fields a v83 Item set actually carries; anything
/// else an item holds is still shown, under an Unknown label.
/// </summary>
public static class ItemFieldCatalog
{
    public static readonly ItemFieldSpec[] Fields =
    {
        new("incSTR", "力量加成", group: "属性加成"),
        new("incDEX", "敏捷加成", group: "属性加成"),
        new("incINT", "智力加成", group: "属性加成"),
        new("incLUK", "幸运加成", group: "属性加成"),
        new("incPAD", "物理攻击", group: "属性加成"),
        new("incMAD", "魔法攻击", group: "属性加成"),
        new("incPDD", "物理防御", group: "属性加成"),
        new("incMDD", "魔法防御", group: "属性加成"),
        new("incSpeed", "移动速度", group: "属性加成"),
        new("incJump", "跳跃力", group: "属性加成"),
        new("incMHP", "最大HP", group: "属性加成"),
        new("incMMP", "最大MP", group: "属性加成"),
        new("incACC", "命中率", group: "属性加成"),
        new("incEVA", "回避率", group: "属性加成"),
        new("tuc", "升级次数", group: "限制"),
        new("reqLevel", "所需等级", group: "限制"),
        new("reqJob", "所需职业", group: "限制"),
        new("only", "专属职业", group: "限制"),
        new("cash", "现金道具", "Bool", "交易"),
        new("tradeBlock", "交易锁定", "Bool", "交易"),
        new("notSale", "不可出售", "Bool", "交易"),
        new("price", "价格", group: "交易"),
        new("slotMax", "最大堆叠", group: "使用"),
        new("recoveryHP", "恢复HP", group: "使用"),
        new("recoveryMP", "恢复MP", group: "使用"),
    };

    public static ItemFieldSpec Find(string key)
        => Array.Find(Fields, spec => string.Equals(spec.Key, key, StringComparison.OrdinalIgnoreCase));

    public static ItemFieldSpec Unknown(string key)
        => new(key, key);
}
