namespace MapleBench.Models;

#region Browse

/// <summary>One row of the equipment browser.</summary>
public sealed class EquipmentSummaryDto
{
    /// <summary>Session path of the equipment image, e.g. "f1/Character/Coat/01040000.img".</summary>
    public string Path { get; set; } = "";

    public string ItemId { get; set; } = "";
    public string? Name { get; set; }

    /// <summary>The localised part name, e.g. "上衣" for Coat.</summary>
    public string Part { get; set; } = "";

    public bool Dirty { get; set; }

    /// <summary>Session path of the icon canvas (info/iconRaw or info/icon), empty when absent.</summary>
    public string? Icon { get; set; }

    /// <summary>Card statistics: the level and STR the equipment requires, 0 when absent.</summary>
    public int ReqLevel { get; set; }
    public int ReqStr { get; set; }
}

public sealed class EquipmentListDto
{
    public List<EquipmentSummaryDto> Items { get; set; } = new();
    public int Total { get; set; }
    public bool Truncated { get; set; }
    /// <summary>part (English directory name) -> item count, for the filter dropdown.</summary>
    public Dictionary<string, int> Parts { get; set; } = new();
    public int Offset { get; set; }
    public int Limit { get; set; }
}

#endregion

#region Detail

/// <summary>One field of an equipment's info section.</summary>
public sealed class EquipmentFieldDto
{
    public string Key { get; set; } = "";
    /// <summary>Bare key; the client overlays its own Chinese label table.</summary>
    public string Label { get; set; } = "";
    /// <summary>Int | Text | Container | Canvas</summary>
    public string Kind { get; set; } = "Int";
    /// <summary>The section the field is shown under, e.g. 需求 / 加成.</summary>
    public string Group { get; set; } = "其他";
    public string? Value { get; set; }
    public string Path { get; set; } = "";
    /// <summary>
    /// WZ path relative to the image root (e.g. "info/level/info/1/exp").
    /// The bulk writer uses this to target nested fields, not just info/*.
    /// </summary>
    public string RelPath { get; set; } = "";
    public bool Present { get; set; }
    public bool Editable { get; set; }
}

/// <summary>
/// One upgrade level of an equipment: a child of info &gt; level &gt; info.
/// A node named "1" means the equipment can be upgraded to level 1, "2" to
/// level 2, and so on; each node carries that level's stat fields.
/// </summary>
/// <summary>One upgrade level of an equipment: a child of info &gt; level &gt; info.</summary>
public sealed class AddLevelRequest
{
    public string Path { get; set; } = "";
    /// <summary>Explicit level number; when null the service uses max + 1.</summary>
    public int? Level { get; set; }
}

public sealed class EquipmentLevelDto
{
    public int Level { get; set; }
    public List<EquipmentFieldDto> Fields { get; set; } = new();
}

public sealed class EquipmentDetailDto
{
    public string Path { get; set; } = "";
    public string ItemId { get; set; } = "";
    public string? Name { get; set; }
    public string Part { get; set; } = "";
    public bool Dirty { get; set; }
    public string? Icon { get; set; }
    /// <summary>Session path of the iconReward frame, when one exists.</summary>
    public string? IconReward { get; set; }
    /// <summary>Every replaceable icon canvas of this equipment, for the icon editor.</summary>
    public List<ItemIconDto> Icons { get; set; } = new();
    public List<EquipmentFieldDto> Fields { get; set; } = new();
    /// <summary>The upgrade levels under info/level/info, ordered ascending by level.</summary>
    public List<EquipmentLevelDto> Levels { get; set; } = new();
}

#endregion
