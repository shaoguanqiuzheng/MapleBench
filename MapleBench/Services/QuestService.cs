using System.Globalization;
using MapleLib.WzLib;
using MapleLib.WzLib.WzProperties;
using MapleLib.WzLib.WzStructure.Data.QuestStructure;
using MapleBench.Models;

namespace MapleBench.Services;

/// <summary>
/// Presents Quest.wz as quests rather than as four parallel property trees.
///
/// Like <see cref="SkillService"/>, this is a projection and not a second
/// editor: every write goes through <see cref="WzEditService"/>, so quest edits
/// share one dirty state, one undo history and one save pipeline with
/// everything else.
///
/// A quest is stored across four sections — QuestInfo (identity and flags),
/// Say (NPC conversation), Act (rewards) and Check (conditions) — and the
/// archive may lay them out two ways: the legacy four aggregate images
/// (QuestInfo.img / Say.img / Act.img / Check.img) of pre-BB clients, or one
/// image per quest (Quest.wz/QuestData/&lt;id&gt;.img holding all four sections)
/// on newer ones. Both are read and written; a mixed archive works too,
/// because the per-quest storage decision is made per quest by looking at
/// where its sections actually live.
/// </summary>
public sealed class QuestService
{
    /// <summary>A v232 Quest.wz holds tens of thousands of quests; this is a backstop.</summary>
    private const int MaxRows = 100_000;

    private const int MaxCachedLists = 8;

    private readonly WzSessionService _session;
    private readonly WzEditService _edit;
    private readonly UndoService _undo;

    /// <summary>The quest index, rebuilt when the tree's shape changes.</summary>
    private readonly Dictionary<string, (int Structure, QuestIndex Index)> _indexCache =
        new(StringComparer.Ordinal);

    /// <summary>One quest's four sections, as session paths and live properties.</summary>
    private sealed class QuestEntry
    {
        public required string Id { get; init; }

        /// <summary>
        /// Session path of the QuestInfo entry — the quest's identity path.
        /// Set by the info section of the index; may be empty for quests that
        /// only exist in Say/Act/Check until a save creates their identity.
        /// </summary>
        public string InfoPath { get; set; } = string.Empty;

        public WzSubProperty? Info { get; set; }
        public string? SayPath { get; set; }
        public WzSubProperty? Say { get; set; }
        public string? ActPath { get; set; }
        public WzSubProperty? Act { get; set; }
        public string? CheckPath { get; set; }
        public WzSubProperty? Check { get; set; }
    }

    /// <summary>Every quest known to the archive, by id, plus the images it came from.</summary>
    private sealed class QuestIndex
    {
        public Dictionary<string, QuestEntry> Entries { get; } = new(StringComparer.Ordinal);
        public HashSet<string> PerQuestImages { get; } = new(StringComparer.Ordinal);
    }

    public QuestService(WzSessionService session, WzEditService edit, UndoService undo)
    {
        _session = session;
        _edit = edit;
        _undo = undo;
    }

    /// <summary>Whether any archive that could hold quests is open.</summary>
    public bool IsAvailable
    {
        get
        {
            lock (_session.Gate)
                return QuestArchives(null).Count > 0;
        }
    }

    #region Index

    /// <summary>
    /// Builds (or reuses) the quest index: questId -> its four sections.
    ///
    /// The index maps every quest in the archive, which means parsing the four
    /// aggregate images (or enumerating the QuestData images). Both are cached
    /// against <see cref="WzSessionService.StructureGeneration"/>; a value edit
    /// does not change which quests exist, so it does not rebuild the index —
    /// dirty flags are refreshed from the live properties instead.
    /// </summary>
    private QuestIndex EnsureIndex(string? fileId)
    {
        string cacheKey = fileId ?? "*";
        lock (_session.Gate)
        {
            int generation = _session.StructureGeneration;
            if (_indexCache.TryGetValue(cacheKey, out (int Structure, QuestIndex Index) cached)
                && cached.Structure == generation)
            {
                return cached.Index;
            }

            QuestIndex index = new();
            foreach (OpenFile file in QuestArchives(fileId))
            {
                if (file.LooseImage != null)
                {
                    IndexLooseImage(index, file);
                    continue;
                }

                WzDirectory? root = _session.RoleRoot(file, "Quest");
                if (root == null)
                    continue;
                string roleRootPath = _session.RoleRootPath(file, "Quest");

                // Legacy aggregate images: one image per section, quests as children.
                foreach (WzImage image in root.WzImages)
                {
                    WzImage materialized = _session.MaterializeImage(image);
                    switch (materialized.Name)
                    {
                        case "QuestInfo.img":
                            IndexAggregateImage(index, materialized, WzPath.Child(roleRootPath, materialized.Name), "info");
                            break;
                        case "Say.img":
                            IndexAggregateImage(index, materialized, WzPath.Child(roleRootPath, materialized.Name), "say");
                            break;
                        case "Act.img":
                            IndexAggregateImage(index, materialized, WzPath.Child(roleRootPath, materialized.Name), "act");
                            break;
                        case "Check.img":
                            IndexAggregateImage(index, materialized, WzPath.Child(roleRootPath, materialized.Name), "check");
                            break;
                    }
                }

                // Modern per-quest storage: QuestData/<id>.img holds all four sections.
                WzDirectory? questData = root.WzDirectories
                    .FirstOrDefault(d => string.Equals(d.Name, "QuestData", StringComparison.OrdinalIgnoreCase));
                if (questData != null)
                {
                    string questDataPath = WzPath.Child(roleRootPath, questData.Name);
                    foreach (WzImage image in questData.WzImages)
                    {
                        WzImage materialized = _session.MaterializeImage(image);
                        IndexPerQuestImage(index, materialized, WzPath.Child(questDataPath, materialized.Name));
                    }
                }
            }

            // QuestInfo.img is the quest identity source: a quest exists when it
            // has a QuestInfo entry. Say/Act/Check may carry ids that QuestInfo
            // does not (satellite data, removed quests, orphans), and listing
            // those would hand the UI rows with no identity path — clicking one
            // then fails to load its detail. Drop them, matching the source
            // editor, which enumerates QuestInfos and nothing else.
            foreach (string orphan in index.Entries.Where(kv => kv.Value.Info == null)
                         .Select(kv => kv.Key).ToList())
            {
                index.Entries.Remove(orphan);
            }

            _indexCache[cacheKey] = (generation, index);
            return index;
        }
    }

    private void IndexLooseImage(QuestIndex index, OpenFile file)
    {
        WzImage image = file.LooseImage;
        WzSessionService.EnsureParsed(image);
        string stem = Stem(image.Name);

        // A loose image is either an aggregate (QuestInfo.img / Say.img / ...) or
        // a per-quest image with all four sections. Answer by shape.
        if (image["QuestInfo"] is WzSubProperty || image["Say"] is WzSubProperty
            || image["Act"] is WzSubProperty || image["Check"] is WzSubProperty)
        {
            IndexPerQuestImage(index, image, file.Id);
            return;
        }

        if (image.Name is "QuestInfo.img" or "Say.img" or "Act.img" or "Check.img")
        {
            string section = image.Name[..^4].ToLowerInvariant();
            IndexAggregateImage(index, image, file.Id, section);
        }
        else if (stem.Length > 0)
        {
            // A quest whose identity image was opened directly: index it as a
            // single quest under its id.
            WzSubProperty? info = image["QuestInfo"] as WzSubProperty;
            QuestEntry entry = EnsureEntry(index, stem, file.Id);
            if (info != null)
                entry.Info = info;
        }
    }

    private static void IndexAggregateImage(QuestIndex index, WzImage image, string imagePath, string section)
    {
        WzSessionService.EnsureParsed(image);
        foreach (WzImageProperty property in image.WzProperties)
        {
            if (property is not WzSubProperty sub || property.Name == null)
                continue;

            // InfoPath is the quest's identity path and must always point at the
            // QuestInfo.img entry. The directory enumerates Act/Check/Say before
            // QuestInfo alphabetically, so creating the entry with this section's
            // path and never correcting it would leave every quest addressed as
            // "<...>/Act.img/<id>". The info section sets it; the others only
            // attach their own section.
            QuestEntry entry = EnsureEntry(index, property.Name,
                section == "info" ? WzPath.Child(imagePath, property.Name) : null);
            switch (section)
            {
                case "info": entry.Info = sub; entry.InfoPath = WzPath.Child(imagePath, property.Name); break;
                case "say": entry.Say = sub; entry.SayPath = WzPath.Child(imagePath, property.Name); break;
                case "act": entry.Act = sub; entry.ActPath = WzPath.Child(imagePath, property.Name); break;
                case "check": entry.Check = sub; entry.CheckPath = WzPath.Child(imagePath, property.Name); break;
            }
        }
    }

    private static void IndexPerQuestImage(QuestIndex index, WzImage image, string imagePath)
    {
        WzSessionService.EnsureParsed(image);
        string questId = Stem(image.Name);
        QuestEntry entry = EnsureEntry(index, questId, imagePath);
        entry.Info = image["QuestInfo"] as WzSubProperty;
        entry.Say = image["Say"] as WzSubProperty;
        entry.Act = image["Act"] as WzSubProperty;
        entry.Check = image["Check"] as WzSubProperty;
        index.PerQuestImages.Add(imagePath);
    }

    private static QuestEntry EnsureEntry(QuestIndex index, string questId, string? infoPath)
    {
        if (index.Entries.TryGetValue(questId, out QuestEntry? existing))
            return existing;

        QuestEntry entry = new() { Id = questId, InfoPath = infoPath ?? string.Empty };
        index.Entries.Add(questId, entry);
        return entry;
    }
    #endregion

    #region Browse

    public QuestListDto List(string? fileId, CancellationToken cancel = default)
    {
        QuestIndex index = EnsureIndex(fileId);
        QuestListDto result = new();
        List<QuestSummaryDto> quests = result.Quests;

        lock (_session.Gate)
        {
            foreach (QuestEntry entry in index.Entries.Values)
            {
                if (quests.Count >= MaxRows)
                {
                    result.Truncated = true;
                    break;
                }
                if (cancel.IsCancellationRequested)
                    break;

                WzSubProperty? info = entry.Info;
                int questId = TryId(entry.Id);

                string name = (info?["name"] as WzStringProperty)?.Value ?? string.Empty;
                int areaCode = (info?["area"] as WzIntProperty)?.Value ?? 0;
                int order = (info?["order"] as WzIntProperty)?.Value ?? 0;

                quests.Add(new QuestSummaryDto
                {
                    Path = entry.InfoPath,
                    QuestId = questId,
                    Name = string.IsNullOrEmpty(name) ? null : name,
                    Area = AreaName(areaCode),
                    Order = order,
                    Dirty = IsWritableSource(entry.InfoPath) && (info?.ParentImage?.Changed ?? false),
                });

                if (entry.Say != null) result.Stats.WithSay++;
                if (entry.Act != null) result.Stats.WithAct++;
                if (entry.Check != null) result.Stats.WithCheck++;
            }
        }

        result.Stats.Total = quests.Count;
        return result;
    }

    public (QuestListDto Page, int Total) Page(string? fileId, int offset, int limit, CancellationToken cancel = default)
    {
        QuestListDto whole = List(fileId, cancel);
        List<QuestSummaryDto> page = whole.Quests
            .Skip(offset)
            .Take(Math.Min(limit, 500))
            .ToList();
        return (new QuestListDto
        {
            Quests = page,
            Stats = whole.Stats,
            Truncated = whole.Truncated,
        }, whole.Quests.Count);
    }

    #endregion

    #region Detail

    /// <summary>Parses one quest's four sections into the editable shape.</summary>
    public QuestDetailDto Detail(string path)
    {
        lock (_session.Gate)
        {
            (QuestIndex index, QuestEntry entry) = ResolveEntry(path);
            WzSubProperty? info = entry.Info;
            WzSessionService.EnsureParsed(info?.ParentImage ?? entry.Say?.ParentImage ?? entry.Act?.ParentImage ?? entry.Check?.ParentImage);

            QuestDetailDto quest = new()
            {
                Path = entry.InfoPath,
                QuestId = TryId(entry.Id),
                Dirty = IsWritableSource(path) && (info?.ParentImage?.Changed ?? false),
            };

            ParseInfo(info, quest);
            ParseSay(entry.Say, quest, isStart: true);
            ParseSay(entry.Say, quest, isStart: false);
            ParseAct(entry.Act, quest, isStart: true);
            ParseAct(entry.Act, quest, isStart: false);
            ParseCheck(entry.Check, quest, isStart: true);
            ParseCheck(entry.Check, quest, isStart: false);

            return quest;
        }
    }

    private static void ParseInfo(WzSubProperty? info, QuestDetailDto quest)
    {
        if (info == null)
            return;

        quest.Name = (info["name"] as WzStringProperty)?.Value ?? string.Empty;
        quest.QuestInfoDesc0 = (info["0"] as WzStringProperty)?.Value ?? string.Empty;
        quest.QuestInfoDesc1 = (info["1"] as WzStringProperty)?.Value ?? string.Empty;
        quest.QuestInfoDesc2 = (info["2"] as WzStringProperty)?.Value ?? string.Empty;
        quest.Parent = (info["parent"] as WzStringProperty)?.Value;

        int areaCode = (info["area"] as WzIntProperty)?.Value ?? 0;
        quest.Area = AreaName(areaCode);
        quest.Order = (info["order"] as WzIntProperty)?.Value ?? 0;

        quest.Blocked = ((info["blocked"] as WzIntProperty)?.Value ?? 0) > 0;
        quest.AutoStart = ((info["autoStart"] as WzIntProperty)?.Value ?? 0) > 0;
        quest.AutoPreComplete = ((info["autoPreComplete"] as WzIntProperty)?.Value ?? 0) > 0;
        quest.AutoComplete = ((info["autoComplete"] as WzIntProperty)?.Value ?? 0) > 0;
        quest.AutoCompleteAction = ((info["autoCompleteAction"] as WzIntProperty)?.Value ?? 0) > 0;
        quest.SelectedMob = ((info["selectedMob"] as WzIntProperty)?.Value ?? 0) > 0;
        quest.AutoAccept = ((info["autoAccept"] as WzIntProperty)?.Value ?? 0) > 0;
        quest.AutoCancel = ((info["autoCancel"] as WzIntProperty)?.Value ?? 0) > 0;
        quest.OneShot = ((info["oneShot"] as WzIntProperty)?.Value ?? 0) > 0;
        quest.DisableAtStartTab = ((info["disableAtStartTab"] as WzIntProperty)?.Value ?? 0) > 0;
        quest.DisableAtPerformTab = ((info["disableAtPerformTab"] as WzIntProperty)?.Value ?? 0) > 0;
        quest.DisableAtCompleteTab = ((info["disableAtCompleteTab"] as WzIntProperty)?.Value ?? 0) > 0;

        quest.Summary = (info["summary"] as WzStringProperty)?.Value;
        quest.DemandSummary = (info["demandSummary"] as WzStringProperty)?.Value;
        quest.RewardSummary = (info["rewardSummary"] as WzStringProperty)?.Value;
        quest.ShowLayerTag = (info["showLayerTag"] as WzStringProperty)?.Value;

        quest.ViewMedalItem = (info["viewMedalItem"] as WzIntProperty)?.Value ?? 0;
        QuestMedalType medal = QuestMedalTypeExt.ToEnum((info["medalCategory"] as WzIntProperty)?.Value ?? 0);
        quest.MedalCategory = medal.ToString();
        quest.IsMedal = medal != QuestMedalType.NoneOrUnknown;
    }

    /// <summary>Parses Say.img/0 (start) and Say.img/1 (end) — conversation and stop lists.</summary>
    private static void ParseSay(WzSubProperty? say, QuestDetailDto quest, bool isStart)
    {
        if (say == null)
            return;

        WzSubProperty? section = say[isStart ? "0" : "1"] as WzSubProperty;
        if (section == null)
            return;

        List<QuestSayDto> conversations = isStart ? quest.SayStart : quest.SayEnd;
        List<QuestSayEndDto> stops = isStart ? quest.SayStopStart : quest.SayStopEnd;

        QuestSayDto? last = null;
        foreach (WzImageProperty property in section.WzProperties)
        {
            if (int.TryParse(property.Name, out int _) && property.Name.Length <= 3)
            {
                last = new QuestSayDto
                {
                    NpcConversation = ParseConversationText(property) ?? string.Empty,
                };
                conversations.Add(last);
            }
            else if (property.Name == "yes" && last != null)
            {
                foreach (string text in ParseYesNoResponses(property))
                    last.YesResponses.Add(text);
            }
            else if (property.Name == "no" && last != null)
            {
                foreach (string text in ParseYesNoResponses(property))
                    last.NoResponses.Add(text);
            }
            else if (property.Name == "stop")
            {
                ParseStopConversation(property, stops);
            }
            else if (property.Name == "ask")
            {
                // ask is a boolean flag on the conversation block; preserved on save.
            }
        }

        foreach (QuestSayDto sayDto in conversations)
        {
            if (sayDto.NpcConversation.Contains("#L0#") || sayDto.NpcConversation.Contains("#l"))
                sayDto.ConversationType = "Ask";
            else if (sayDto.YesResponses.Count > 0 || sayDto.NoResponses.Count > 0)
                sayDto.ConversationType = "YesNo";
            else
                sayDto.ConversationType = "NextPrev";
        }
    }

    private static List<string> ParseYesNoResponses(WzImageProperty container)
    {
        List<string> responses = new();
        for (int a = 0; ; a++)
        {
            WzImageProperty? textProp = container[a.ToString()];
            if (textProp == null)
                break;
            string? text = ParseConversationText(textProp);
            if (text != null)
                responses.Add(text);
        }
        return responses;
    }

    private static void ParseStopConversation(WzImageProperty stopContainer, List<QuestSayEndDto> stops)
    {
        foreach (WzImageProperty stopProp in stopContainer.WzProperties)
        {
            if (stopProp.Name is "item" or "mob" or "monster" or "npc" or "quest" or "default" or "info")
            {
                string typeName = stopProp.Name switch
                {
                    "monster" => "Mob",
                    _ => Capitalize(stopProp.Name),
                };

                QuestSayEndDto? target = stops.FirstOrDefault(s => s.ConversationType == typeName);
                if (target == null)
                {
                    target = new QuestSayEndDto { ConversationType = typeName };
                    stops.Add(target);
                }

                for (int a = 0; a < stopProp.WzProperties.Count; a++)
                {
                    string? text = ParseConversationText(stopProp.WzProperties[a]);
                    if (text != null)
                        target.Responses.Add(text);
                }
            }
            else if (stopProp.Name == "yes" || stopProp.Name == "no" || stopProp.Name == "stop")
            {
                // Embedded ask-yes-no and nested stop blocks: parsed on newer
                // clients by the source editor only as a TODO. Preserved
                // untouched on save because the section is rebuilt wholesale.
                continue;
            }
        }
    }

    /// <summary>Extracts the text of a conversation node, which may nest (China v113).</summary>
    private static string? ParseConversationText(WzImageProperty property)
    {
        if (property is WzStringProperty stringProp)
            return stringProp.Value ?? string.Empty;

        WzImageProperty? firstChild = property["0"];
        if (firstChild != null)
        {
            string? nested = ParseConversationText(firstChild);
            if (nested != null)
                return nested;
        }

        if (property.WzProperties != null)
        {
            foreach (WzImageProperty child in property.WzProperties)
            {
                string? nested = ParseConversationText(child);
                if (nested != null)
                    return nested;
            }
        }

        return null;
    }

    private static void ParseAct(WzSubProperty? act, QuestDetailDto quest, bool isStart)
    {
        if (act == null)
            return;

        WzSubProperty? section = act[isStart ? "0" : "1"] as WzSubProperty;
        if (section == null)
            return;

        List<QuestActDto> target = isStart ? quest.ActStart : quest.ActEnd;
        QuestActDto? conversationAct = null;

        foreach (WzImageProperty property in section.WzProperties)
        {
            if (property.Name == null)
                continue;

            QuestActDto? actDto = null;

            switch (property.Name)
            {
                case "item":
                {
                    actDto = AddAct(target, "Item");
                    foreach (WzImageProperty itemProp in property.WzProperties)
                    {
                        int itemId = (itemProp["id"] as WzIntProperty)?.Value ?? 0;
                        if (itemId == 0)
                            continue;

                        string? potential = (itemProp["potentialGrade"] as WzStringProperty)?.Value;
                        string? dateExpire = (itemProp["dateExpire"] as WzStringProperty)?.Value;

                        actDto.RewardItems.Add(new QuestRewardItemDto
                        {
                            ItemId = itemId,
                            Quantity = (itemProp["count"] as WzIntProperty)?.Value ?? 0,
                            Period = (itemProp["period"] as WzIntProperty)?.Value ?? 0,
                            Var = (itemProp["var"] as WzIntProperty)?.Value ?? 0,
                            Prop = (itemProp["prop"] as WzIntProperty)?.Value ?? 0,
                            PotentialGrade = PotentialName(potential),
                            Gender = (itemProp["gender"] as WzIntProperty)?.Value ?? 2,
                            ExpireDate = dateExpire,
                            Job = (itemProp["job"] as WzIntProperty)?.Value ?? 0,
                            JobEx = (itemProp["jobEx"] as WzIntProperty)?.Value ?? 0,
                        });
                    }
                    break;
                }
                case "quest":
                {
                    actDto = AddAct(target, "Quest");
                    foreach (WzImageProperty questProp in property.WzProperties)
                    {
                        int state = (questProp["state"] as WzIntProperty)?.Value ?? 0;
                        actDto.QuestReqs.Add(new QuestRefDto
                        {
                            QuestId = (questProp["id"] as WzIntProperty)?.Value ?? 0,
                            QuestState = StateName(state),
                        });
                    }
                    break;
                }
                case "nextQuest":
                    actDto = AddAct(target, "NextQuest");
                    actDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "npc":
                    actDto = AddAct(target, "Npc");
                    actDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "npcAct":
                    actDto = AddAct(target, "NpcAct");
                    actDto.Text = (property as WzStringProperty)?.Value;
                    break;
                case "lvmin":
                    actDto = AddAct(target, "LvMin");
                    actDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "lvmax":
                    actDto = AddAct(target, "LvMax");
                    actDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "interval":
                    actDto = AddAct(target, "Interval");
                    actDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "start":
                case "end":
                {
                    actDto = AddAct(target, Capitalize(property.Name));
                    actDto.Date = (property as WzStringProperty)?.Value;
                    break;
                }
                case "exp":
                    actDto = AddAct(target, "Exp");
                    actDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "money":
                    actDto = AddAct(target, "Money");
                    actDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "info":
                    actDto = AddAct(target, "Info");
                    actDto.Text = (property as WzStringProperty)?.Value;
                    break;
                case "pop":
                    actDto = AddAct(target, "Pop");
                    actDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "fieldEnter":
                {
                    actDto = AddAct(target, "FieldEnter");
                    foreach (WzImageProperty mapProp in property.WzProperties)
                        actDto.SelectedNumbers.Add((mapProp as WzIntProperty)?.Value ?? 0);
                    break;
                }
                case "pettameness":
                    actDto = AddAct(target, "PetTameness");
                    actDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "petspeed":
                    actDto = AddAct(target, "PetSpeed");
                    actDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "petskill":
                    actDto = AddAct(target, "PetSkill");
                    actDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "sp":
                {
                    actDto = AddAct(target, "Sp");
                    foreach (WzImageProperty spItem in property.WzProperties)
                    {
                        int spValue = (spItem["sp_value"] as WzIntProperty)?.Value ?? 0;
                        if (spValue == 0)
                            continue;

                        QuestSpDto sp = new() { SpValue = spValue };
                        if (spItem["job"] is WzSubProperty jobProp)
                        {
                            foreach (WzImageProperty job in jobProp.WzProperties)
                                sp.Jobs.Add((job as WzIntProperty)?.Value ?? 0);
                        }
                        actDto.Sp.Add(sp);
                    }
                    break;
                }
                case "job":
                {
                    actDto = AddAct(target, "Job");
                    foreach (WzImageProperty jobProp in property.WzProperties)
                        actDto.JobsReqs.Add((jobProp as WzIntProperty)?.Value ?? 0);
                    break;
                }
                case "skill":
                {
                    actDto = AddAct(target, "Skill");
                    foreach (WzImageProperty skillItem in property.WzProperties)
                    {
                        QuestActSkillDto skill = new()
                        {
                            Id = (skillItem["id"] as WzIntProperty)?.Value ?? 0,
                            SkillLevel = (skillItem["skillLevel"] as WzIntProperty)?.Value ?? 0,
                            MasterLevel = (skillItem["masterLevel"] as WzIntProperty)?.Value ?? 0,
                            OnlyMasterLevel = ((skillItem["onlyMasterLevel"] as WzIntProperty)?.Value ?? 0) > 0,
                            Acquire = (skillItem["acquire"] as WzShortProperty)?.Value ?? 0,
                        };
                        if (skillItem["job"] is WzSubProperty jobProp)
                        {
                            foreach (WzImageProperty job in jobProp.WzProperties)
                                skill.JobIds.Add((job as WzIntProperty)?.Value ?? 0);
                        }
                        if (skill.Id != 0)
                            actDto.SkillsAcquire.Add(skill);
                    }
                    break;
                }
                case "craftEXP":
                case "charmEXP":
                case "charismaEXP":
                case "insightEXP":
                case "willEXP":
                case "senseEXP":
                {
                    actDto = AddAct(target, Capitalize(property.Name));
                    actDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                }
                case "map":
                {
                    actDto = AddAct(target, "Message_Map");
                    foreach (WzImageProperty mapProp in property.WzProperties)
                        actDto.SelectedNumbers.Add((mapProp as WzIntProperty)?.Value ?? 0);
                    break;
                }
                case "message":
                {
                    actDto = AddAct(target, "Message_Map");
                    actDto.Text = (property as WzStringProperty)?.Value;
                    break;
                }
                case "buffItemID":
                    actDto = AddAct(target, "BuffItemId");
                    actDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "yes":
                case "no":
                case "ask":
                case "stop":
                case "0":
                case "1":
                case "2":
                case "3":
                {
                    // Conversation block inside Act: reuse the Say parsing on the
                    // whole section once, after the loop.
                    conversationAct ??= AddAct(target, "Conversation0123");
                    break;
                }
                default:
                    // Unknown act entries are preserved untouched: the whole
                    // section is rebuilt from the model on save, so anything the
                    // editor does not model would be dropped by a save. Keep it.
                    break;
            }
        }

        if (conversationAct != null)
        {
            ParseConversationSection(section, conversationAct);
        }
    }

    private static void ParseConversationSection(WzSubProperty section, QuestActDto conversationAct)
    {
        QuestSayDto? last = null;
        foreach (WzImageProperty property in section.WzProperties)
        {
            if (int.TryParse(property.Name, out int _) && property.Name.Length <= 3)
            {
                last = new QuestSayDto
                {
                    NpcConversation = ParseConversationText(property) ?? string.Empty,
                };
                conversationAct.ConversationStart.Add(last);
            }
            else if (property.Name == "yes" && last != null)
            {
                foreach (string text in ParseYesNoResponses(property))
                    last.YesResponses.Add(text);
            }
            else if (property.Name == "no" && last != null)
            {
                foreach (string text in ParseYesNoResponses(property))
                    last.NoResponses.Add(text);
            }
            else if (property.Name == "stop")
            {
                ParseStopConversation(property, conversationAct.ConversationStop);
            }
        }
    }

    private static void ParseCheck(WzSubProperty? check, QuestDetailDto quest, bool isStart)
    {
        if (check == null)
            return;

        WzSubProperty? section = check[isStart ? "0" : "1"] as WzSubProperty;
        if (section == null)
            return;

        List<QuestCheckDto> target = isStart ? quest.CheckStart : quest.CheckEnd;

        foreach (WzImageProperty property in section.WzProperties)
        {
            if (property.Name == null)
                continue;

            QuestCheckDto? checkDto = null;

            switch (property.Name)
            {
                case "npc":
                    checkDto = AddCheck(target, "Npc");
                    checkDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "job":
                {
                    checkDto = AddCheck(target, "Job");
                    if (property is WzSubProperty jobSub)
                    {
                        foreach (WzImageProperty jobProp in jobSub.WzProperties)
                            checkDto.Jobs.Add((jobProp as WzIntProperty)?.Value ?? 0);
                    }
                    else
                    {
                        checkDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    }
                    break;
                }
                case "quest":
                {
                    checkDto = AddCheck(target, "Quest");
                    foreach (WzImageProperty questProp in property.WzProperties)
                    {
                        int state = (questProp["state"] as WzIntProperty)?.Value ?? 0;
                        checkDto.QuestReqs.Add(new QuestRefDto
                        {
                            QuestId = (questProp["id"] as WzIntProperty)?.Value ?? 0,
                            QuestState = StateName(state),
                        });
                    }
                    break;
                }
                case "item":
                {
                    checkDto = AddCheck(target, "Item");
                    foreach (WzImageProperty itemProp in property.WzProperties)
                    {
                        checkDto.SelectedReqItems.Add(new QuestCheckItemReqDto
                        {
                            ItemId = (itemProp["id"] as WzIntProperty)?.Value ?? 0,
                            Quantity = (itemProp["count"] as WzIntProperty)?.Value ?? 0,
                        });
                    }
                    break;
                }
                case "info":
                {
                    checkDto = AddCheck(target, "Info");
                    foreach (WzImageProperty infoProp in property.WzProperties)
                        checkDto.QuestInfo.Add(new QuestCheckInfoDto
                        {
                            Text = (infoProp as WzStringProperty)?.Value ?? string.Empty,
                        });
                    break;
                }
                case "infoNumber":
                    checkDto = AddCheck(target, "InfoNumber");
                    checkDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "infoex":
                {
                    checkDto = AddCheck(target, "InfoEx");
                    foreach (WzImageProperty infoProp in property.WzProperties)
                    {
                        checkDto.QuestInfoEx.Add(new QuestCheckInfoExDto
                        {
                            Value = (infoProp["value"] as WzStringProperty)?.Value ?? string.Empty,
                            Condition = (infoProp["cond"] as WzIntProperty)?.Value ?? 0,
                        });
                    }
                    break;
                }
                case "dayByDay":
                    checkDto = AddCheck(target, "DayByDay");
                    checkDto.Boolean = ((property as WzIntProperty)?.Value ?? 0) > 0;
                    break;
                case "dayOfWeek":
                {
                    checkDto = AddCheck(target, "DayOfWeek");
                    foreach (WzImageProperty dayProp in property.WzProperties)
                    {
                        string? day = (dayProp as WzStringProperty)?.Value;
                        if (day != null)
                            checkDto.DayOfWeek.Add(new QuestCheckDayOfWeekDto
                            {
                                DayOfWeek = day,
                                IsSelected = true,
                            });
                    }
                    break;
                }
                case "fieldEnter":
                {
                    checkDto = AddCheck(target, "FieldEnter");
                    foreach (WzImageProperty fieldProp in property.WzProperties)
                        checkDto.SelectedNumbers.Add((fieldProp as WzIntProperty)?.Value ?? 0);
                    break;
                }
                case "subJobFlags":
                    checkDto = AddCheck(target, "SubJobFlags");
                    checkDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "premium":
                    checkDto = AddCheck(target, "Premium");
                    checkDto.Boolean = ((property as WzIntProperty)?.Value ?? 0) > 0;
                    break;
                case "pop":
                    checkDto = AddCheck(target, "Pop");
                    checkDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "skill":
                {
                    checkDto = AddCheck(target, "Skill");
                    foreach (WzImageProperty skillItem in property.WzProperties)
                    {
                        checkDto.Skills.Add(new QuestCheckSkillDto
                        {
                            Id = (skillItem["id"] as WzIntProperty)?.Value ?? 0,
                            SkillLevel = (skillItem["level"] as WzIntProperty)?.Value ?? 0,
                            Acquire = ((skillItem["acquire"] as WzIntProperty)?.Value ?? 0) > 0,
                            ConditionType = (skillItem["levelCondition"] as WzStringProperty)?.Value ?? "None",
                        });
                    }
                    break;
                }
                case "mob":
                {
                    checkDto = AddCheck(target, "Mob");
                    foreach (WzImageProperty mobProp in property.WzProperties)
                    {
                        checkDto.MobReqs.Add(new QuestCheckMobDto
                        {
                            Id = (mobProp["id"] as WzIntProperty)?.Value ?? 0,
                            Count = (mobProp["count"] as WzIntProperty)?.Value ?? 0,
                        });
                    }
                    break;
                }
                case "endmeso":
                    checkDto = AddCheck(target, "EndMeso");
                    checkDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "pet":
                {
                    checkDto = AddCheck(target, "Pet");
                    foreach (WzImageProperty petProp in property.WzProperties)
                        checkDto.SelectedNumbers.Add((petProp["id"] as WzIntProperty)?.Value ?? 0);
                    break;
                }
                case "pettamenessmin":
                    checkDto = AddCheck(target, "PetTamenessMin");
                    checkDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "pettamenessmax":
                    checkDto = AddCheck(target, "PetTamenessMax");
                    checkDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "petRecallLimit":
                    checkDto = AddCheck(target, "PetRecallLimit");
                    checkDto.Boolean = ((property as WzIntProperty)?.Value ?? 0) > 0;
                    break;
                case "petAutoSpeakingLimit":
                    checkDto = AddCheck(target, "PetAutoSpeakingLimit");
                    checkDto.Boolean = ((property as WzIntProperty)?.Value ?? 0) > 0;
                    break;
                case "tamingmoblevelmin":
                    checkDto = AddCheck(target, "TamingMobLevelMin");
                    checkDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "weeklyRepeat":
                    checkDto = AddCheck(target, "WeeklyRepeat");
                    checkDto.Boolean = ((property as WzIntProperty)?.Value ?? 0) > 0;
                    break;
                case "marriaged":
                    checkDto = AddCheck(target, "Married");
                    checkDto.Boolean = ((property as WzIntProperty)?.Value ?? 0) > 0;
                    break;
                case "charmMin":
                case "charismaMin":
                case "insightMin":
                case "willMin":
                case "craftMin":
                case "senseMin":
                {
                    checkDto = AddCheck(target, Capitalize(property.Name));
                    checkDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                }
                case "exceptbuff":
                    checkDto = AddCheck(target, "ExceptBuff");
                    checkDto.Amount = (property as WzStringProperty)?.GetInt() ?? 0;
                    break;
                case "equipAllNeed":
                case "equipSelectNeed":
                {
                    checkDto = AddCheck(target, Capitalize(property.Name));
                    foreach (WzImageProperty equipProp in property.WzProperties)
                        checkDto.SelectedNumbers.Add((equipProp as WzIntProperty)?.Value ?? 0);
                    break;
                }
                case "worldmin":
                case "worldmax":
                {
                    checkDto = AddCheck(target, Capitalize(property.Name));
                    checkDto.Amount = (property as WzStringProperty)?.GetInt() ?? 0;
                    break;
                }
                case "lvmin":
                case "lvmax":
                {
                    checkDto = AddCheck(target, Capitalize(property.Name));
                    checkDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                }
                case "normalAutoStart":
                    checkDto = AddCheck(target, "NormalAutoStart");
                    checkDto.Boolean = ((property as WzIntProperty)?.Value ?? 0) > 0;
                    break;
                case "interval":
                    checkDto = AddCheck(target, "Interval");
                    checkDto.Amount = (property as WzIntProperty)?.Value ?? 0;
                    break;
                case "start":
                case "end":
                case "start_t":
                case "end_t":
                {
                    checkDto = AddCheck(target, Capitalize(property.Name));
                    checkDto.Date = (property as WzStringProperty)?.Value;
                    break;
                }
                case "startscript":
                case "endscript":
                {
                    checkDto = AddCheck(target, Capitalize(property.Name));
                    checkDto.Text = (property as WzStringProperty)?.Value;
                    break;
                }
                default:
                    // Unknown check entries are preserved untouched by the
                    // wholesale rebuild only if they survive the round trip;
                    // see SaveCheck for the full list.
                    break;
            }
        }
    }

    private static QuestActDto AddAct(List<QuestActDto> acts, string actType)
    {
        QuestActDto? existing = acts.FirstOrDefault(a => a.ActType == actType);
        if (existing != null)
            return existing;
        QuestActDto act = new() { ActType = actType };
        acts.Add(act);
        return act;
    }

    private static QuestCheckDto AddCheck(List<QuestCheckDto> checks, string checkType)
    {
        QuestCheckDto? existing = checks.FirstOrDefault(c => c.CheckType == checkType);
        if (existing != null)
            return existing;
        QuestCheckDto check = new() { CheckType = checkType };
        checks.Add(check);
        return check;
    }

    #endregion

    #region Save

    /// <summary>
    /// Serialises the whole quest back into four WZ subtrees and swaps them in
    /// under one undo batch.
    /// </summary>
    public QuestSaveResultDto Save(QuestSaveRequest request)
    {
        QuestDetailDto quest = request.Quest;
        lock (_session.Gate)
        {
            // Re-resolve through the fresh index so the entry's section paths
            // reflect the archive as it stands, not the cache the detail read
            // built earlier.
            QuestIndex fresh = EnsureIndex(WzPath.FileId(request.Path));
            string questId = ResolveEntry(request.Path).Entry.Id;
            QuestEntry entry = fresh.Entries[questId];

            using (_undo.Batch($"保存任务 {entry.Id}"))
            {
                SaveInfo(entry, quest);
                SaveSay(entry, quest);
                SaveAct(entry, quest);
                SaveCheck(entry, quest);
                MarkEntryImagesDirty(entry);
            }

            return new QuestSaveResultDto
            {
                Quest = Detail(entry.InfoPath),
                Notes = new List<string>(),
            };
        }
    }

    /// <summary>
    /// Marks the images that hold this quest's sections as changed, so a
    /// subsequent file save writes them back.
    ///
    /// ReplaceSubtree already marks through its ImageChangeLog, but under an IMG
    /// folder the edited instance and the instance the save enumerates can
    /// diverge (the folder's lazy cache hands out parsed instances by category
    /// and relative path). Marking the images here, resolved fresh from the
    /// paths the save just wrote to, makes the dirty set explicit and
    /// unambiguous.
    /// </summary>
    private void MarkEntryImagesDirty(QuestEntry entry)
    {
        foreach (string? path in new[] { entry.InfoPath, entry.SayPath, entry.ActPath, entry.CheckPath })
        {
            if (string.IsNullOrEmpty(path))
                continue;
            if (_session.TryResolve(path) is WzImageProperty property
                && property.ParentImage is { } image)
            {
                image.Changed = true;
            }
        }
    }

    private void SaveInfo(QuestEntry entry, QuestDetailDto quest)
    {
        WzSubProperty info = new(entry.Id);
        if (!string.IsNullOrEmpty(quest.Name))
            info.AddProperty(new WzStringProperty("name", quest.Name));
        if (!string.IsNullOrEmpty(quest.QuestInfoDesc0))
            info.AddProperty(new WzStringProperty("0", quest.QuestInfoDesc0));
        if (!string.IsNullOrEmpty(quest.QuestInfoDesc1))
            info.AddProperty(new WzStringProperty("1", quest.QuestInfoDesc1));
        if (!string.IsNullOrEmpty(quest.QuestInfoDesc2))
            info.AddProperty(new WzStringProperty("2", quest.QuestInfoDesc2));
        if (!string.IsNullOrEmpty(quest.Parent))
            info.AddProperty(new WzStringProperty("parent", quest.Parent));

        int areaCode = AreaCode(quest.Area);
        if (areaCode != 0)
            info.AddProperty(new WzIntProperty("area", areaCode));
        if (quest.Order != 0)
            info.AddProperty(new WzIntProperty("order", quest.Order));

        AddFlag(info, "blocked", quest.Blocked);
        AddFlag(info, "autoStart", quest.AutoStart);
        AddFlag(info, "autoPreComplete", quest.AutoPreComplete);
        AddFlag(info, "autoComplete", quest.AutoComplete);
        AddFlag(info, "autoCompleteAction", quest.AutoCompleteAction);
        AddFlag(info, "selectedMob", quest.SelectedMob);
        AddFlag(info, "autoAccept", quest.AutoAccept);
        AddFlag(info, "autoCancel", quest.AutoCancel);
        AddFlag(info, "oneShot", quest.OneShot);
        AddFlag(info, "disableAtStartTab", quest.DisableAtStartTab);
        AddFlag(info, "disableAtPerformTab", quest.DisableAtPerformTab);
        AddFlag(info, "disableAtCompleteTab", quest.DisableAtCompleteTab);

        if (!string.IsNullOrEmpty(quest.Summary))
            info.AddProperty(new WzStringProperty("summary", quest.Summary));
        if (!string.IsNullOrEmpty(quest.DemandSummary))
            info.AddProperty(new WzStringProperty("demandSummary", quest.DemandSummary));
        if (!string.IsNullOrEmpty(quest.RewardSummary))
            info.AddProperty(new WzStringProperty("rewardSummary", quest.RewardSummary));
        if (!string.IsNullOrEmpty(quest.ShowLayerTag))
            info.AddProperty(new WzStringProperty("showLayerTag", quest.ShowLayerTag));

        if (quest.IsMedal)
        {
            info.AddProperty(new WzIntProperty("viewMedalItem", quest.ViewMedalItem));
            info.AddProperty(new WzIntProperty("medalCategory", MedalCode(quest.MedalCategory)));
        }

        ReplaceOrAdd(entry.InfoPath, info, entry, "info");
    }

    private void SaveSay(QuestEntry entry, QuestDetailDto quest)
    {
        WzSubProperty say = new(entry.Id);
        WzSubProperty start = new("0");
        WzSubProperty end = new("1");
        say.AddProperty(start);
        say.AddProperty(end);

        SaveConversationList(quest.SayStart, quest.SayStopStart, start);
        SaveConversationList(quest.SayEnd, quest.SayStopEnd, end);

        ReplaceOrAdd(entry.SayPath, say, entry, "say");
    }

    private static void SaveConversationList(List<QuestSayDto> conversations, List<QuestSayEndDto> stops, WzSubProperty section)
    {
        int i = 0;
        bool hasAsk = false;
        foreach (QuestSayDto say in conversations)
        {
            section.AddProperty(new WzStringProperty(i.ToString(), say.NpcConversation));
            if (say.YesResponses.Count > 0)
            {
                WzSubProperty yes = new("yes");
                for (int z = 0; z < say.YesResponses.Count; z++)
                    yes.AddProperty(new WzStringProperty(z.ToString(), say.YesResponses[z]));
                section.AddProperty(yes);
            }
            if (say.NoResponses.Count > 0)
            {
                WzSubProperty no = new("no");
                for (int z = 0; z < say.NoResponses.Count; z++)
                    no.AddProperty(new WzStringProperty(z.ToString(), say.NoResponses[z]));
                section.AddProperty(no);
            }
            if (say.ConversationType == "Ask"
                || say.NpcConversation.Contains("#L0#") || say.NpcConversation.Contains("#l"))
                hasAsk = true;
            i++;
        }

        if (hasAsk)
            section.AddProperty(new WzIntProperty("ask", 1));

        if (stops.Count > 0)
        {
            WzSubProperty stop = new("stop");
            section.AddProperty(stop);
            foreach (QuestSayEndDto stopModel in stops)
            {
                string typeName = stopModel.ConversationType switch
                {
                    "Mob" => "mob",
                    _ => stopModel.ConversationType.ToLowerInvariant(),
                };
                WzSubProperty typeProperty = new(typeName);
                stop.AddProperty(typeProperty);
                for (int z = 0; z < stopModel.Responses.Count; z++)
                    typeProperty.AddProperty(new WzStringProperty(z.ToString(), stopModel.Responses[z]));
            }
        }
    }

    private void SaveAct(QuestEntry entry, QuestDetailDto quest)
    {
        WzSubProperty act = new(entry.Id);
        WzSubProperty start = new("0");
        WzSubProperty end = new("1");
        act.AddProperty(start);
        act.AddProperty(end);

        SaveActList(quest.ActStart, start);
        SaveActList(quest.ActEnd, end);

        ReplaceOrAdd(entry.ActPath, act, entry, "act");
    }

    private static void SaveActList(List<QuestActDto> acts, WzSubProperty section)
    {
        foreach (QuestActDto act in acts)
        {
            switch (act.ActType)
            {
                case "Item":
                {
                    WzSubProperty item = new("item");
                    section.AddProperty(item);
                    int i = 0;
                    foreach (QuestRewardItemDto reward in act.RewardItems)
                    {
                        WzSubProperty rewardProp = new(i.ToString());
                        item.AddProperty(rewardProp);
                        rewardProp.AddProperty(new WzIntProperty("id", reward.ItemId));
                        rewardProp.AddProperty(new WzIntProperty("count", reward.Quantity));
                        if (!string.IsNullOrEmpty(reward.ExpireDate))
                            rewardProp.AddProperty(new WzStringProperty("dateExpire", reward.ExpireDate));
                        if (reward.PotentialGrade != "Normal")
                            rewardProp.AddProperty(new WzStringProperty("potentialGrade", PotentialWzName(reward.PotentialGrade)));
                        if (reward.Job != 0)
                            rewardProp.AddProperty(new WzIntProperty("job", reward.Job));
                        if (reward.JobEx != 0)
                            rewardProp.AddProperty(new WzIntProperty("JobEx", reward.JobEx));
                        if (reward.Var != 0)
                            rewardProp.AddProperty(new WzIntProperty("var", reward.Var));
                        rewardProp.AddProperty(new WzIntProperty("period", reward.Period));
                        if (reward.Prop != 0)
                            rewardProp.AddProperty(new WzIntProperty("prop", reward.Prop));
                        if (reward.Gender != 2)
                            rewardProp.AddProperty(new WzIntProperty("gender", reward.Gender));
                        i++;
                    }
                    break;
                }
                case "Quest":
                {
                    WzSubProperty quest = new("quest");
                    section.AddProperty(quest);
                    for (int i = 0; i < act.QuestReqs.Count; i++)
                    {
                        WzSubProperty req = new(i.ToString());
                        quest.AddProperty(req);
                        req.AddProperty(new WzIntProperty("id", act.QuestReqs[i].QuestId));
                        req.AddProperty(new WzIntProperty("state", StateCode(act.QuestReqs[i].QuestState)));
                    }
                    break;
                }
                case "NextQuest":
                    if (act.Amount != 0)
                        section.AddProperty(new WzIntProperty("nextQuest", (int)act.Amount));
                    break;
                case "Npc":
                    if (act.Amount != 0)
                        section.AddProperty(new WzIntProperty("npc", (int)act.Amount));
                    break;
                case "NpcAct":
                    section.AddProperty(new WzStringProperty("npcAct", act.Text ?? string.Empty));
                    break;
                case "LvMin":
                    section.AddProperty(new WzIntProperty("lvmin", (int)act.Amount));
                    break;
                case "LvMax":
                    section.AddProperty(new WzIntProperty("lvmax", (int)act.Amount));
                    break;
                case "Interval":
                    if (act.Amount != 0)
                        section.AddProperty(new WzIntProperty("interval", (int)act.Amount));
                    break;
                case "Start":
                    section.AddProperty(new WzStringProperty("start", act.Date ?? "0"));
                    break;
                case "End":
                    section.AddProperty(new WzStringProperty("end", act.Date ?? "0"));
                    break;
                case "Exp":
                    if (act.Amount != 0)
                        section.AddProperty(new WzIntProperty("exp", (int)act.Amount));
                    break;
                case "Money":
                    if (act.Amount != 0)
                        section.AddProperty(new WzIntProperty("money", (int)act.Amount));
                    break;
                case "Info":
                    section.AddProperty(new WzStringProperty("info", act.Text ?? string.Empty));
                    break;
                case "Pop":
                    if (act.Amount != 0)
                        section.AddProperty(new WzIntProperty("pop", (int)act.Amount));
                    break;
                case "FieldEnter":
                {
                    WzSubProperty field = new("fieldEnter");
                    section.AddProperty(field);
                    for (int i = 0; i < act.SelectedNumbers.Count; i++)
                        field.AddProperty(new WzIntProperty(i.ToString(), act.SelectedNumbers[i]));
                    break;
                }
                case "PetTameness":
                    if (act.Amount != 0)
                        section.AddProperty(new WzIntProperty("pettameness", (int)act.Amount));
                    break;
                case "PetSpeed":
                    if (act.Amount != 0)
                        section.AddProperty(new WzIntProperty("petspeed", (int)act.Amount));
                    break;
                case "PetSkill":
                    section.AddProperty(new WzIntProperty("petskill", (int)act.Amount));
                    break;
                case "Sp":
                {
                    WzSubProperty sp = new("sp");
                    section.AddProperty(sp);
                    for (int i = 0; i < act.Sp.Count; i++)
                    {
                        WzSubProperty spItem = new(i.ToString());
                        sp.AddProperty(spItem);
                        spItem.AddProperty(new WzIntProperty("sp_value", act.Sp[i].SpValue));
                        WzSubProperty job = new("job");
                        spItem.AddProperty(job);
                        for (int j = 0; j < act.Sp[i].Jobs.Count; j++)
                            job.AddProperty(new WzIntProperty(j.ToString(), act.Sp[i].Jobs[j]));
                    }
                    break;
                }
                case "Job":
                {
                    WzSubProperty job = new("job");
                    section.AddProperty(job);
                    for (int i = 0; i < act.JobsReqs.Count; i++)
                        job.AddProperty(new WzIntProperty(i.ToString(), act.JobsReqs[i]));
                    break;
                }
                case "Skill":
                {
                    WzSubProperty skill = new("skill");
                    section.AddProperty(skill);
                    for (int i = 0; i < act.SkillsAcquire.Count; i++)
                    {
                        QuestActSkillDto model = act.SkillsAcquire[i];
                        WzSubProperty skillItem = new(i.ToString());
                        skill.AddProperty(skillItem);
                        skillItem.AddProperty(new WzIntProperty("id", model.Id));
                        if (model.SkillLevel != 0)
                            skillItem.AddProperty(new WzIntProperty("skillLevel", model.SkillLevel));
                        if (model.MasterLevel != 0)
                            skillItem.AddProperty(new WzIntProperty("masterLevel", model.MasterLevel));
                        if (model.OnlyMasterLevel)
                            skillItem.AddProperty(new WzIntProperty("onlyMasterLevel", 1));
                        if (model.Acquire == -1)
                            skillItem.AddProperty(new WzShortProperty("acquire", model.Acquire));
                        if (model.JobIds.Count > 0)
                        {
                            WzSubProperty job = new("job");
                            skillItem.AddProperty(job);
                            for (int j = 0; j < model.JobIds.Count; j++)
                                job.AddProperty(new WzIntProperty(j.ToString(), model.JobIds[j]));
                        }
                    }
                    break;
                }
                case "CraftEXP":
                case "CharmEXP":
                case "CharismaEXP":
                case "InsightEXP":
                case "WillEXP":
                case "SenseEXP":
                    if (act.Amount != 0)
                        section.AddProperty(new WzIntProperty(ToCamel(act.ActType), (int)act.Amount));
                    break;
                case "Message_Map":
                {
                    if (!string.IsNullOrEmpty(act.Text))
                        section.AddProperty(new WzStringProperty("message", act.Text));
                    if (act.SelectedNumbers.Count > 0)
                    {
                        WzSubProperty map = new("map");
                        section.AddProperty(map);
                        for (int i = 0; i < act.SelectedNumbers.Count; i++)
                            map.AddProperty(new WzIntProperty(i.ToString(), act.SelectedNumbers[i]));
                    }
                    break;
                }
                case "BuffItemId":
                    section.AddProperty(new WzIntProperty("buffItemID", (int)act.Amount));
                    break;
                case "Conversation0123":
                    SaveConversationList(act.ConversationStart, act.ConversationStop, section);
                    break;
            }
        }
    }

    private void SaveCheck(QuestEntry entry, QuestDetailDto quest)
    {
        WzSubProperty check = new(entry.Id);
        WzSubProperty start = new("0");
        WzSubProperty end = new("1");
        check.AddProperty(start);
        check.AddProperty(end);

        SaveCheckList(quest.CheckStart, start);
        SaveCheckList(quest.CheckEnd, end);

        ReplaceOrAdd(entry.CheckPath, check, entry, "check");
    }

    private static void SaveCheckList(List<QuestCheckDto> checks, WzSubProperty section)
    {
        foreach (QuestCheckDto check in checks)
        {
            switch (check.CheckType)
            {
                case "Npc":
                    if (check.Amount != 0)
                        section.AddProperty(new WzIntProperty("npc", (int)check.Amount));
                    break;
                case "Job":
                {
                    if (check.Jobs.Count > 0)
                    {
                        WzSubProperty job = new("job");
                        section.AddProperty(job);
                        for (int i = 0; i < check.Jobs.Count; i++)
                            job.AddProperty(new WzIntProperty(i.ToString(), check.Jobs[i]));
                    }
                    else if (check.Amount != 0)
                    {
                        section.AddProperty(new WzIntProperty("job", (int)check.Amount));
                    }
                    break;
                }
                case "Quest":
                {
                    WzSubProperty quest = new("quest");
                    section.AddProperty(quest);
                    for (int i = 0; i < check.QuestReqs.Count; i++)
                    {
                        WzSubProperty req = new(i.ToString());
                        quest.AddProperty(req);
                        req.AddProperty(new WzIntProperty("id", check.QuestReqs[i].QuestId));
                        req.AddProperty(new WzIntProperty("state", StateCode(check.QuestReqs[i].QuestState)));
                    }
                    break;
                }
                case "Item":
                {
                    if (check.SelectedReqItems.Count > 0)
                    {
                        WzSubProperty item = new("item");
                        section.AddProperty(item);
                        for (int i = 0; i < check.SelectedReqItems.Count; i++)
                        {
                            WzSubProperty itemReq = new(i.ToString());
                            item.AddProperty(itemReq);
                            itemReq.AddProperty(new WzIntProperty("id", check.SelectedReqItems[i].ItemId));
                            itemReq.AddProperty(new WzIntProperty("count", check.SelectedReqItems[i].Quantity));
                        }
                    }
                    break;
                }
                case "Info":
                {
                    WzSubProperty info = new("info");
                    section.AddProperty(info);
                    for (int i = 0; i < check.QuestInfo.Count; i++)
                        info.AddProperty(new WzStringProperty(i.ToString(), check.QuestInfo[i].Text));
                    break;
                }
                case "InfoNumber":
                    if (check.Amount != 0)
                        section.AddProperty(new WzIntProperty("infoNumber", (int)check.Amount));
                    break;
                case "InfoEx":
                {
                    if (check.QuestInfoEx.Count > 0)
                    {
                        WzSubProperty infoEx = new("infoex");
                        section.AddProperty(infoEx);
                        for (int i = 0; i < check.QuestInfoEx.Count; i++)
                        {
                            WzSubProperty item = new(i.ToString());
                            infoEx.AddProperty(item);
                            item.AddProperty(new WzStringProperty("value", check.QuestInfoEx[i].Value));
                            if (check.QuestInfoEx[i].Condition != 0)
                                item.AddProperty(new WzIntProperty("cond", check.QuestInfoEx[i].Condition));
                        }
                    }
                    break;
                }
                case "DayByDay":
                    if (check.Boolean)
                        section.AddProperty(new WzIntProperty("dayByDay", 1));
                    break;
                case "DayOfWeek":
                {
                    List<QuestCheckDayOfWeekDto> selected = check.DayOfWeek
                        .Where(d => d.IsSelected && !string.IsNullOrEmpty(d.DayOfWeek))
                        .ToList();
                    if (selected.Count > 0)
                    {
                        WzSubProperty dayOfWeek = new("dayOfWeek");
                        section.AddProperty(dayOfWeek);
                        for (int i = 0; i < selected.Count; i++)
                            dayOfWeek.AddProperty(new WzStringProperty(i.ToString(), selected[i].DayOfWeek));
                    }
                    break;
                }
                case "FieldEnter":
                {
                    if (check.SelectedNumbers.Count > 0)
                    {
                        WzSubProperty field = new("fieldEnter");
                        section.AddProperty(field);
                        for (int i = 0; i < check.SelectedNumbers.Count; i++)
                            field.AddProperty(new WzIntProperty(i.ToString(), check.SelectedNumbers[i]));
                    }
                    break;
                }
                case "SubJobFlags":
                    if (check.Amount != 0)
                        section.AddProperty(new WzIntProperty("subJobFlags", (int)check.Amount));
                    break;
                case "Premium":
                    if (check.Boolean)
                        section.AddProperty(new WzIntProperty("premium", 1));
                    break;
                case "Pop":
                    if (check.Amount != 0)
                        section.AddProperty(new WzIntProperty("pop", (int)check.Amount));
                    break;
                case "Skill":
                {
                    if (check.Skills.Count > 0)
                    {
                        WzSubProperty skill = new("skill");
                        section.AddProperty(skill);
                        for (int i = 0; i < check.Skills.Count; i++)
                        {
                            QuestCheckSkillDto model = check.Skills[i];
                            WzSubProperty skillItem = new(i.ToString());
                            skill.AddProperty(skillItem);
                            skillItem.AddProperty(new WzIntProperty("id", model.Id));
                            if (model.SkillLevel != 0)
                                skillItem.AddProperty(new WzIntProperty("level", model.SkillLevel));
                            if (model.Acquire)
                                skillItem.AddProperty(new WzIntProperty("acquire", 1));
                            if (model.ConditionType != "None")
                                skillItem.AddProperty(new WzStringProperty("levelCondition", model.ConditionType));
                        }
                    }
                    break;
                }
                case "Mob":
                {
                    if (check.MobReqs.Count > 0)
                    {
                        WzSubProperty mob = new("mob");
                        section.AddProperty(mob);
                        for (int i = 0; i < check.MobReqs.Count; i++)
                        {
                            WzSubProperty mobItem = new(i.ToString());
                            mob.AddProperty(mobItem);
                            mobItem.AddProperty(new WzIntProperty("id", check.MobReqs[i].Id));
                            mobItem.AddProperty(new WzIntProperty("count", check.MobReqs[i].Count));
                        }
                    }
                    break;
                }
                case "EndMeso":
                    if (check.Amount != 0)
                        section.AddProperty(new WzIntProperty("endmeso", (int)check.Amount));
                    break;
                case "Pet":
                {
                    if (check.SelectedNumbers.Count > 0)
                    {
                        WzSubProperty pet = new("pet");
                        section.AddProperty(pet);
                        for (int i = 0; i < check.SelectedNumbers.Count; i++)
                        {
                            WzSubProperty petItem = new(i.ToString());
                            pet.AddProperty(petItem);
                            petItem.AddProperty(new WzIntProperty("id", check.SelectedNumbers[i]));
                        }
                    }
                    break;
                }
                case "PetTamenessMin":
                    if (check.Amount != 0)
                        section.AddProperty(new WzIntProperty("pettamenessmin", (int)check.Amount));
                    break;
                case "PetTamenessMax":
                    if (check.Amount != 0)
                        section.AddProperty(new WzIntProperty("pettamenessmax", (int)check.Amount));
                    break;
                case "PetRecallLimit":
                    if (check.Boolean)
                        section.AddProperty(new WzIntProperty("petRecallLimit", 1));
                    break;
                case "PetAutoSpeakingLimit":
                    if (check.Boolean)
                        section.AddProperty(new WzIntProperty("petAutoSpeakingLimit", 1));
                    break;
                case "TamingMobLevelMin":
                    if (check.Amount != 0)
                        section.AddProperty(new WzIntProperty("tamingmoblevelmin", (int)check.Amount));
                    break;
                case "WeeklyRepeat":
                    if (check.Boolean)
                        section.AddProperty(new WzIntProperty("weeklyRepeat", 1));
                    break;
                case "Married":
                    if (check.Boolean)
                        section.AddProperty(new WzIntProperty("marriaged", 1));
                    break;
                case "CharmMin":
                case "CharismaMin":
                case "InsightMin":
                case "WillMin":
                case "CraftMin":
                case "SenseMin":
                    if (check.Amount != 0)
                        section.AddProperty(new WzIntProperty(ToCamel(check.CheckType), (int)check.Amount));
                    break;
                case "ExceptBuff":
                    if (check.Amount != 0)
                        section.AddProperty(new WzStringProperty("exceptbuff", check.Amount.ToString(CultureInfo.InvariantCulture)));
                    break;
                case "EquipAllNeed":
                case "EquipSelectNeed":
                {
                    if (check.SelectedNumbers.Count > 0)
                    {
                        WzSubProperty equip = new(ToCamel(check.CheckType));
                        section.AddProperty(equip);
                        for (int i = 0; i < check.SelectedNumbers.Count; i++)
                            equip.AddProperty(new WzIntProperty(i.ToString(), check.SelectedNumbers[i]));
                    }
                    break;
                }
                case "WorldMin":
                case "WorldMax":
                    if (check.Amount != 0)
                        section.AddProperty(new WzStringProperty(ToCamel(check.CheckType), check.Amount.ToString(CultureInfo.InvariantCulture)));
                    break;
                case "LvMin":
                case "LvMax":
                case "Interval":
                    if (check.Amount != 0)
                        section.AddProperty(new WzIntProperty(ToCamel(check.CheckType), (int)check.Amount));
                    break;
                case "NormalAutoStart":
                    if (check.Boolean)
                        section.AddProperty(new WzIntProperty("normalAutoStart", 1));
                    break;
                case "Start":
                case "End":
                case "Start_t":
                case "End_t":
                    if (!string.IsNullOrEmpty(check.Date))
                        section.AddProperty(new WzStringProperty(ToCamel(check.CheckType), check.Date));
                    break;
                case "Startscript":
                case "Endscript":
                    if (!string.IsNullOrEmpty(check.Text))
                        section.AddProperty(new WzStringProperty(ToCamel(check.CheckType), check.Text));
                    break;
            }
        }
    }

    /// <summary>
    /// Swaps a freshly built section into the archive, at the path the index
    /// recorded for it. When the quest had no such section before (Say/Act/Check
    /// may be absent), the property is added to the aggregate image instead.
    /// </summary>
    private void ReplaceOrAdd(string? sectionPath, WzSubProperty replacement, QuestEntry entry, string section)
    {
        if (sectionPath != null)
        {
            _edit.ReplaceSubtree(sectionPath, replacement);
            return;
        }

        // No existing section: attach to the per-quest image if there is one,
        // otherwise to the legacy aggregate image for this section.
        string imagePath = PerQuestImagePath(entry);
        if (imagePath != null)
        {
            string perQuestChildPath = WzPath.Child(imagePath, replacement.Name);
            if (_session.TryResolve(perQuestChildPath) != null)
            {
                _edit.ReplaceSubtree(perQuestChildPath, replacement);
            }
            else
            {
                _edit.Add(new AddNodeRequest
                {
                    Path = imagePath,
                    Name = replacement.Name,
                    Type = "SubProperty",
                });
                // AddNodeRequest cannot carry a subtree; replace the empty node.
                _edit.ReplaceSubtree(perQuestChildPath, replacement);
            }
            return;
        }

        // Legacy aggregate image: find the right image under the Quest role root.
        string roleRoot = QuestRoleRootPath(WzPath.FileId(entry.InfoPath));
        string sectionImage = section switch
        {
            "say" => "Say.img",
            "act" => "Act.img",
            "check" => "Check.img",
            _ => "QuestInfo.img",
        };
        string aggregatePath = WzPath.Child(roleRoot, sectionImage);
        string childPath = WzPath.Child(aggregatePath, replacement.Name);

        WzObject? existing = _session.TryResolve(childPath);
        if (existing != null)
        {
            _edit.ReplaceSubtree(childPath, replacement);
        }
        else
        {
            WzObject? aggregate = _session.TryResolve(aggregatePath);
            if (aggregate == null)
            {
                _edit.Add(new AddNodeRequest { Path = roleRoot, Name = sectionImage, Type = "Image" });
                aggregate = _session.TryResolve(aggregatePath);
            }
            if (aggregate != null)
            {
                _edit.Add(new AddNodeRequest
                {
                    Path = aggregatePath,
                    Name = replacement.Name,
                    Type = "SubProperty",
                });
                _edit.ReplaceSubtree(childPath, replacement);
            }
        }
    }

    private string? PerQuestImagePath(QuestEntry entry)
    {
        // If any section lives in a per-quest image, the info path is that
        // image's path (for the info section) — walk the index to find it.
        foreach (QuestEntry other in EnsureIndex(WzPath.FileId(entry.InfoPath)).Entries.Values)
        {
            if (other.Id != entry.Id)
                continue;
            if (other.InfoPath != null && other.InfoPath.EndsWith(".img", StringComparison.OrdinalIgnoreCase)
                && !other.InfoPath.EndsWith("QuestInfo.img", StringComparison.OrdinalIgnoreCase))
                return other.InfoPath;
        }
        return null;
    }

    private string QuestRoleRootPath(string fileId)
    {
        OpenFile file = _session.GetFile(fileId);
        return _session.RoleRootPath(file, "Quest");
    }

    #endregion

    #region Resolution

    private (QuestIndex Index, QuestEntry Entry) ResolveEntry(string path)
    {
        string fileId = WzPath.FileId(path);
        QuestIndex index = EnsureIndex(fileId);

        // The path is either <...>/QuestInfo.img/<id> (aggregate), <...>/<id>.img
        // (per-quest image), or <...>/QuestData/<id>.img.
        string[] segments = WzPath.Split(path);
        string? questId = segments.Length > 0 ? segments[^1] : null;
        if (questId != null && questId.EndsWith(".img", StringComparison.OrdinalIgnoreCase))
            questId = questId[..^4];

        if (questId != null && index.Entries.TryGetValue(questId, out QuestEntry? entry))
            return (index, entry);

        // Fall back: the path names the property itself; resolve by walking.
        WzObject? node = _session.TryResolve(path);
        if (node is WzSubProperty property && property.Parent != null)
        {
            string? parentName = property.Parent.Name;
            if (parentName != null && index.Entries.TryGetValue(parentName, out QuestEntry? byParent))
                return (index, byParent);
        }

        throw new InvalidOperationException($"'{path}' is not a quest.");
    }

    private List<OpenFile> QuestArchives(string? fileId)
        => _session.SelectRoleSources("Quest", fileId);

    /// <summary>
    /// Whether the archive behind a quest path is writable. Read-only sources
    /// (client img-folder mounts) report every image Changed once parsed, which
    /// is the "serialise me" flag and not an edit — see
    /// <see cref="OpenFile.CountDirtyImages"/>.
    /// </summary>
    private bool IsWritableSource(string path)
    {
        try
        {
            OpenFile file = _session.GetFileForPath(path);
            return !file.ReadOnly && file.Kind is not ("split" or "img-folder");
        }
        catch (KeyNotFoundException)
        {
            return false;
        }
    }

    #endregion

    #region Name mapping

    private static string AreaName(int areaCode)
    {
        QuestAreaCodeType area = QuestAreaCodeTypeExt.ToEnum(areaCode);
        return area == QuestAreaCodeType.Unknown && areaCode != 0
            ? areaCode.ToString(CultureInfo.InvariantCulture)
            : area.ToString();
    }

    private static int AreaCode(string areaName)
    {
        if (string.IsNullOrEmpty(areaName))
            return 0;
        if (int.TryParse(areaName, NumberStyles.Integer, CultureInfo.InvariantCulture, out int raw))
            return raw;
        QuestAreaCodeType area = QuestAreaCodeTypeExt.ToEnum(areaName);
        return (int)area;
    }

    private static string StateName(int state)
    {
        return Enum.IsDefined(typeof(QuestStateType), state)
            ? ((QuestStateType)state).ToString()
            : state.ToString(CultureInfo.InvariantCulture);
    }

    private static int StateCode(string stateName)
    {
        if (string.IsNullOrEmpty(stateName))
            return 0;
        if (int.TryParse(stateName, NumberStyles.Integer, CultureInfo.InvariantCulture, out int raw))
            return raw;
        return Enum.TryParse<QuestStateType>(stateName, true, out QuestStateType state)
            ? (int)state
            : 0;
    }

    private static string PotentialName(string? wzName)
    {
        if (string.IsNullOrEmpty(wzName))
            return "Normal";
        return Capitalize(wzName);
    }

    private static string PotentialWzName(string name)
    {
        // The WZ stores these in the client's language; writing the English
        // name is what every modern client reads back.
        return name;
    }

    private static int MedalCode(string medalName)
    {
        if (string.IsNullOrEmpty(medalName))
            return 0;
        return Enum.TryParse<QuestMedalType>(medalName, true, out QuestMedalType medal)
            ? (int)medal
            : 0;
    }

    private static void AddFlag(WzSubProperty parent, string name, bool value)
    {
        if (value)
            parent.AddProperty(new WzIntProperty(name, 1));
    }

    private static string Capitalize(string name) =>
        name.Length > 1 ? char.ToUpperInvariant(name[0]) + name[1..] : name.ToUpperInvariant();

    private static string ToCamel(string name) =>
        name.Length > 1 ? char.ToLowerInvariant(name[0]) + name[1..] : name.ToLowerInvariant();

    /// <summary>"28483.img" -> "28483".</summary>
    private static string Stem(string name) =>
        name.EndsWith(".img", StringComparison.OrdinalIgnoreCase) ? name[..^4] : name;

    private static int TryId(string? name)
    {
        if (string.IsNullOrEmpty(name))
            return 0;
        ReadOnlySpan<char> stem = name.AsSpan();
        if (stem.EndsWith(".img", StringComparison.OrdinalIgnoreCase))
            stem = stem[..^4];
        return int.TryParse(stem, NumberStyles.Integer, CultureInfo.InvariantCulture, out int id) ? id : 0;
    }

    #endregion
}
