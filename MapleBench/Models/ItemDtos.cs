namespace MapleBench.Models;

#region Browse

/// <summary>One row of the item browser.</summary>
public sealed class ItemSummaryDto
{
    /// <summary>Session path of the item node, e.g. "f1/Item/Consume/0200.img/02000000".</summary>
    public string Path { get; set; } = "";

    public string ItemId { get; set; } = "";
    public string? Name { get; set; }

    /// <summary>Cash | Consume | Etc | Install | Pet | Special (the archive's Item subdirectory).</summary>
    public string Category { get; set; } = "";

    /// <summary>The aggregate image stem the item lives in, e.g. "0200".</summary>
    public string Series { get; set; } = "";

    public bool Dirty { get; set; }

    /// <summary>Session path of the icon canvas (info/iconRaw or info/icon), empty when absent.</summary>
    public string? Icon { get; set; }

    /// <summary>Card statistics: the shop price and the stack cap, 0 when absent.</summary>
    public int Price { get; set; }
    public int SlotMax { get; set; }
}

public sealed class ItemListDto
{
    public List<ItemSummaryDto> Items { get; set; } = new();
    public int Total { get; set; }
    public bool Truncated { get; set; }
    /// <summary>category -> item count, for the filter dropdown.</summary>
    public Dictionary<string, int> Categories { get; set; } = new();
    public int Offset { get; set; }
    public int Limit { get; set; }
}

#endregion

#region Detail

/// <summary>One field of an item's info section.</summary>
public sealed class ItemFieldDto
{
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    /// <summary>Int | Bool | Text | Container | Canvas</summary>
    public string Kind { get; set; } = "Int";
    /// <summary>The section the field is shown under, e.g. 属性加成 / 交易.</summary>
    public string Group { get; set; } = "其他";
    public string? Value { get; set; }
    public string Path { get; set; } = "";
    public bool Present { get; set; }
    public bool Editable { get; set; }
}

/// <summary>One replaceable canvas of an item (icon, iconRaw, iconReward…).</summary>
public sealed class ItemIconDto
{
    /// <summary>Field key under info, e.g. "iconRaw" or "iconReward".</summary>
    public string Key { get; set; } = "";

    public string Label { get; set; } = "";

    /// <summary>Session path of the canvas, e.g. ".../02000009/info/iconRaw".</summary>
    public string Path { get; set; } = "";

    /// <summary>Width x Height of the current canvas.</summary>
    public string? Size { get; set; }
}

public sealed class ItemDetailDto
{
    public string Path { get; set; } = "";
    public string ItemId { get; set; } = "";
    public string? Name { get; set; }
    public string Category { get; set; } = "";
    public string Series { get; set; } = "";
    public bool Dirty { get; set; }
    public string? Icon { get; set; }
    /// <summary>Session path of the iconReward frame, when one exists.</summary>
    public string? IconReward { get; set; }
    /// <summary>Every replaceable icon canvas of this item, for the icon editor.</summary>
    public List<ItemIconDto> Icons { get; set; } = new();
    public List<ItemFieldDto> Fields { get; set; } = new();
}

#endregion

#region Write

/// <summary>One field value to apply in a bulk edit.</summary>
public sealed class ItemWriteField
{
    public string Key { get; set; } = "";
    public string? Value { get; set; }
    /// <summary>
    /// WZ node type used when the field has to be created (SetOrCreate).
    /// Defaults to Int; String/Short/Long/Float are also valid WZ scalars.
    /// </summary>
    public string? Type { get; set; }
    /// <summary>
    /// Optional WZ path relative to the image root, e.g. "info/level/info/1/exp".
    /// When set it targets a nested field (equipment upgrade levels) instead of
    /// the default "info/{Key}".
    /// </summary>
    public string? RelPath { get; set; }
}

/// <summary>
/// Applies a set of fields to many items in one undo batch. Missing fields are
/// created (SetOrCreate, the behaviour the source item editor uses): a batch
/// "set incSTR to 5" on a hundred items that lack it adds the field to all of
/// them, which is the point of a bulk stat edit.
/// </summary>
public sealed class ItemBulkRequest
{
    public List<string> Paths { get; set; } = new();
    public List<ItemWriteField> Fields { get; set; } = new();
}

public sealed class ItemBulkChangeDto
{
    public string Path { get; set; } = "";
    public string ItemId { get; set; } = "";
    public string? Name { get; set; }
    public bool Skipped { get; set; }
    public string? Reason { get; set; }
}

public sealed class ItemBulkResultDto
{
    public List<ItemBulkChangeDto> Changes { get; set; } = new();
    public int Applied { get; set; }
    public int Skipped { get; set; }
}

/// <summary>Replaces one icon canvas of an item with a user-supplied PNG.</summary>
public sealed class ItemIconRequest
{
    /// <summary>Session path of the item, e.g. "f1/Item/Consume/0200.img/02000009".</summary>
    public string Path { get; set; } = "";

    /// <summary>Which canvas: "iconRaw" | "icon" | "iconReward".</summary>
    public string Key { get; set; } = "";

    /// <summary>The PNG file, base64-encoded (no data: prefix).</summary>
    public string PngBase64 { get; set; } = "";
}

#endregion
