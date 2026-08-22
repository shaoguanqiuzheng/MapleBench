using MapleLib.WzLib.WzStructure.Data.QuestStructure;

namespace MapleBench.Models;

#region Browse

/// <summary>One row of the quest browser.</summary>
public sealed class QuestSummaryDto
{
    /// <summary>Session path of the QuestInfo entry, e.g. "f1/Quest.wz/QuestInfo.img/28483".</summary>
    public string Path { get; set; } = "";

    public int QuestId { get; set; }
    public string? Name { get; set; }

    /// <summary>QuestAreaCodeType name, or the raw number when it is not a known area.</summary>
    public string Area { get; set; } = "";

    public int Order { get; set; }
    public bool Dirty { get; set; }
}

public sealed class QuestStatsDto
{
    public int Total { get; set; }
    public int WithSay { get; set; }
    public int WithAct { get; set; }
    public int WithCheck { get; set; }
}

public sealed class QuestListDto
{
    public List<QuestSummaryDto> Quests { get; set; } = new();
    public QuestStatsDto Stats { get; set; } = new();
    public bool Truncated { get; set; }
}

#endregion

#region Detail

/// <summary>One NPC conversation line of a quest (Say.img).</summary>
public sealed class QuestSayDto
{
    public string NpcConversation { get; set; } = "";

    /// <summary>NextPrev | YesNo | Ask</summary>
    public string ConversationType { get; set; } = "NextPrev";

    public List<string> YesResponses { get; set; } = new();
    public List<string> NoResponses { get; set; } = new();
}

/// <summary>One "stop" conversation of a quest (Say.img/stop).</summary>
public sealed class QuestSayEndDto
{
    /// <summary>Default | Item | Npc | Quest | Info | Stop | Mob</summary>
    public string ConversationType { get; set; } = "Default";

    public List<string> Responses { get; set; } = new();
}

/// <summary>One reward item entry under an Act item block.</summary>
public sealed class QuestRewardItemDto
{
    public int ItemId { get; set; }
    public int Quantity { get; set; }
    public int Period { get; set; }
    public int Var { get; set; }

    /// <summary>AlwaysGiven=0 | RandomlySelected=1 | PlayerSelection=-1</summary>
    public int Prop { get; set; }

    /// <summary>Normal | Rare | Epic | Unique | Legendary | NebulitesA..D</summary>
    public string PotentialGrade { get; set; } = "Normal";

    /// <summary>0 = Male, 1 = Female, 2 = both</summary>
    public int Gender { get; set; } = 2;

    /// <summary>yyyyMMddHH(MM) string; empty when the item never expires.</summary>
    public string? ExpireDate { get; set; }

    public int Job { get; set; }
    public int JobEx { get; set; }
}

/// <summary>One SP award entry (Act sp), mostly for Evan.</summary>
public sealed class QuestSpDto
{
    public int SpValue { get; set; }
    public List<int> Jobs { get; set; } = new();
}

/// <summary>One skill award entry (Act skill).</summary>
public sealed class QuestActSkillDto
{
    public int Id { get; set; }
    public int SkillLevel { get; set; }
    public int MasterLevel { get; set; }
    public bool OnlyMasterLevel { get; set; }

    /// <summary>0 normally, -1 means "remove this skill".</summary>
    public short Acquire { get; set; }

    public List<int> JobIds { get; set; } = new();
}

/// <summary>One quest prerequisite reference, used by both Act quest and Check quest.</summary>
public sealed class QuestRefDto
{
    public int QuestId { get; set; }

    /// <summary>QuestStateType name; see the enum for the numeric meanings.</summary>
    public string QuestState { get; set; } = "0";
}

/// <summary>One Act entry (Act.img).</summary>
public sealed class QuestActDto
{
    /// <summary>Item | Exp | Npc | NpcAct | Money | Pop | BuffItemId | LvMin | LvMax |
    /// Info | FieldEnter | Skill | Job | Sp | Message_Map | Interval | Start | End |
    /// Conversation0123 | Quest | NextQuest | PetSpeed | PetTameness | PetSkill |
    /// CraftEXP | CharmEXP | CharismaEXP | InsightEXP | WillEXP | SenseEXP</summary>
    public string ActType { get; set; } = "Exp";

    public long Amount { get; set; }
    public string? Text { get; set; }

    /// <summary>For Start/End; string form of the date, empty when unset.</summary>
    public string? Date { get; set; }

    public List<int> SelectedNumbers { get; set; } = new();
    public List<QuestRewardItemDto> RewardItems { get; set; } = new();
    public List<QuestSpDto> Sp { get; set; } = new();
    public List<QuestActSkillDto> SkillsAcquire { get; set; } = new();
    public List<int> JobsReqs { get; set; } = new();
    public List<QuestRefDto> QuestReqs { get; set; } = new();
    public List<QuestSayDto> ConversationStart { get; set; } = new();
    public List<QuestSayEndDto> ConversationStop { get; set; } = new();
}

/// <summary>One required item under a Check item block.</summary>
public sealed class QuestCheckItemReqDto
{
    public int ItemId { get; set; }
    public int Quantity { get; set; }
}

/// <summary>One required skill under a Check skill block.</summary>
public sealed class QuestCheckSkillDto
{
    public int Id { get; set; }
    public int SkillLevel { get; set; }
    public bool Acquire { get; set; }

    /// <summary>None | OrGreater | Equal</summary>
    public string ConditionType { get; set; } = "None";
}

/// <summary>One required mob kill under a Check mob block.</summary>
public sealed class QuestCheckMobDto
{
    public int Id { get; set; }
    public int Count { get; set; }
}

/// <summary>One day-of-week selection under a Check dayOfWeek block.</summary>
public sealed class QuestCheckDayOfWeekDto
{
    public string DayOfWeek { get; set; } = "";
    public bool IsSelected { get; set; }
}

/// <summary>One info string under a Check info block.</summary>
public sealed class QuestCheckInfoDto
{
    public string Text { get; set; } = "";
}

/// <summary>One infoEx entry under a Check infoex block.</summary>
public sealed class QuestCheckInfoExDto
{
    public string Value { get; set; } = "";
    public int Condition { get; set; }
}

/// <summary>One Check entry (Check.img).</summary>
public sealed class QuestCheckDto
{
    /// <summary>Npc | Job | Quest | Item | Info | InfoNumber | InfoEx | DayByDay |
    /// DayOfWeek | FieldEnter | SubJobFlags | Premium | Pop | Skill | Mob | EndMeso |
    /// Pet | PetTamenessMin | PetTamenessMax | PetRecallLimit | PetAutoSpeakingLimit |
    /// TamingMobLevelMin | WeeklyRepeat | Married | CharmMin | CharismaMin | InsightMin |
    /// WillMin | CraftMin | SenseMin | ExceptBuff | EquipAllNeed | EquipSelectNeed |
    /// WorldMin | WorldMax | LvMin | LvMax | NormalAutoStart | Interval | Start | End |
    /// Start_t | End_t | Startscript | Endscript</summary>
    public string CheckType { get; set; } = "Npc";

    public long Amount { get; set; }
    public string? Text { get; set; }
    public bool Boolean { get; set; }

    /// <summary>For Start/End/Start_t/End_t; string form of the date, empty when unset.</summary>
    public string? Date { get; set; }

    public List<int> SelectedNumbers { get; set; } = new();
    public List<QuestCheckItemReqDto> SelectedReqItems { get; set; } = new();
    public List<QuestCheckSkillDto> Skills { get; set; } = new();
    public List<int> Jobs { get; set; } = new();
    public List<QuestRefDto> QuestReqs { get; set; } = new();
    public List<QuestCheckDayOfWeekDto> DayOfWeek { get; set; } = new();
    public List<QuestCheckMobDto> MobReqs { get; set; } = new();
    public List<QuestCheckInfoDto> QuestInfo { get; set; } = new();
    public List<QuestCheckInfoExDto> QuestInfoEx { get; set; } = new();
}

/// <summary>The full editable shape of one quest, spanning QuestInfo/Say/Act/Check.</summary>
public sealed class QuestDetailDto
{
    public string Path { get; set; } = "";
    public int QuestId { get; set; }
    public bool Dirty { get; set; }

    // ---- QuestInfo.img ----
    public string Name { get; set; } = "";
    public string QuestInfoDesc0 { get; set; } = "";
    public string QuestInfoDesc1 { get; set; } = "";
    public string QuestInfoDesc2 { get; set; } = "";
    public string? Parent { get; set; }

    /// <summary>QuestAreaCodeType name.</summary>
    public string Area { get; set; } = "Unknown";

    public int Order { get; set; }

    public bool Blocked { get; set; }
    public bool AutoStart { get; set; }
    public bool AutoPreComplete { get; set; }
    public bool AutoComplete { get; set; }
    public bool AutoCompleteAction { get; set; }
    public bool SelectedMob { get; set; }
    public bool AutoAccept { get; set; }
    public bool AutoCancel { get; set; }
    public bool OneShot { get; set; }
    public bool DisableAtStartTab { get; set; }
    public bool DisableAtPerformTab { get; set; }
    public bool DisableAtCompleteTab { get; set; }

    public string? Summary { get; set; }
    public string? DemandSummary { get; set; }
    public string? RewardSummary { get; set; }
    public string? ShowLayerTag { get; set; }

    public bool IsMedal { get; set; }
    public int ViewMedalItem { get; set; }

    /// <summary>QuestMedalType name.</summary>
    public string MedalCategory { get; set; } = "NoneOrUnknown";

    // ---- Say.img ----
    public List<QuestSayDto> SayStart { get; set; } = new();
    public List<QuestSayDto> SayEnd { get; set; } = new();
    public List<QuestSayEndDto> SayStopStart { get; set; } = new();
    public List<QuestSayEndDto> SayStopEnd { get; set; } = new();

    // ---- Act.img ----
    public List<QuestActDto> ActStart { get; set; } = new();
    public List<QuestActDto> ActEnd { get; set; } = new();

    // ---- Check.img ----
    public List<QuestCheckDto> CheckStart { get; set; } = new();
    public List<QuestCheckDto> CheckEnd { get; set; } = new();
}

#endregion

#region Writes

/// <summary>
/// A whole-quest save. The editor works on the full shape and writes the whole
/// thing back, so the request carries every section; the service replaces the
/// four WZ subtrees (QuestInfo/Say/Act/Check) in one undo batch.
/// </summary>
public sealed class QuestSaveRequest
{
    public string Path { get; set; } = "";
    public QuestDetailDto Quest { get; set; } = new();
}

public sealed class QuestSaveResultDto
{
    public QuestDetailDto Quest { get; set; } = new();
    public List<string> Notes { get; set; } = new();
}

#endregion
