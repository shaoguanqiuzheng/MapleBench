/**
 * Quests section: a browse list over Quest.wz, plus the full quest editor —
 * identity (QuestInfo), conversation (Say), rewards (Act) and conditions
 * (Check) — modelled after the HaCreator quest editor.
 *
 * Every write goes through /api/quest/save, which replaces the four WZ
 * subtrees in one undo batch, so quest changes share one dirty state, one undo
 * history and one save pipeline with the Explorer.
 */

import { api } from './api.js';
import { el, clear, toast, toastError, fmt, modal, confirmDialog, promptForText, debounce, runOnce,
         statChip, statRow } from './ui.js';
import { emptyState } from './inspector.js';
import { icon } from './icons.js';

const PAGE_SIZE = 60;

const AREAS = [
  ['Unknown', '未知'], ['Maple_Island', '冒险岛'], ['Henesys', '射手村'], ['Ellinia', '魔法密林'],
  ['Perion', '勇士部落'], ['Kerning_City', '废弃都市'], ['Nautilus', '诺特勒斯'], ['Sleepywood', '沉睡森林'],
  ['Orbis', '天空之城'], ['El_Nath', '冰封雪域'], ['Aqua_Road', '水下世界'], ['Ludibrium', '玩具城'],
  ['EOS_Tower', '通天塔'], ['Omega_Sector', '诺特勒斯海域'], ['Korean_Folk_Town', '韩国传统村'], ['Leafre', '神木村'],
  ['Magatia', '玛迦提亚'], ['Mu_Lung', '武陵'], ['WorldTour', '世界旅游'], ['Event', '活动'],
  ['Achievement_Medals', '成就勋章'], ['Pet', '宠物'], ['Job_Quest', '职业任务'], ['Story_Quests', '剧情任务'],
  ['Tutorial_Guide', '新手教程'], ['Character_Aran', '阿兰'], ['Character_Evan', '龙神'],
  ['Character_Mercedes', '双弩'], ['Character_Phantom', '幻影'], ['Character_Dual_Blade', '双刀'],
  ['Character_Cygnus_Knights', '骑士团'], ['Character_Resistance', '反抗者'], ['Character_Xenon', '尖兵'],
  ['Character_Kinesis', '超能力者'], ['Character_Kain', '卡因'], ['Character_Lara', '拉拉'],
  ['Character_Hoyoung', '虎影'], ['Character_Adele', '阿黛尔'], ['Character_Ark', '阿卡'],
  ['Character_Cadena', '卡德娜'], ['Character_Illium', '伊利温'], ['Zero_Storyline', '零故事线'],
  ['Arcane_River', '神秘河'], ['Lachelein', '拉切兰'], ['Arcana', '阿尔卡纳'], ['Morass', '莫拉斯'],
  ['Esfera', '埃斯费拉'], ['Cernium', '塞尔尼乌姆'], ['Hotel_Arcus', '阿尔克斯'], ['Sellas', '塞拉斯'],
  ['Yum_Yum', '呀嘛呀嘛'], ['Ramuramu', '拉姆拉姆'], ['Reverse_City', '反转城市'],
  ['Kerning_Tower', '废弃都市塔'], ['Fox_Valley', '狐狸谷'], ['Fox_Village', '狐狸村'],
  ['Kritias', '克里蒂亚斯'], ['Grand_Athenaeum', '雅典娜神殿'], ['Tower_Of_Oz', '奥兹之塔'],
  ['Mushroom_Castle', '蘑菇城'], ['Friends', '好友'], ['DailySpecial', '每日特别'],
  ['StarPlanet', '星星星球'], ['Blockbuster_BlackHeaven', '黑色天堂'], ['BlackHeaven', '黑色天堂'],
  ['Dark_World_Tree', '黑暗世界树'], ['Tenebris_Limen', '天灭之境'], ['Genesis_Weapon', '创世武器'],
  ['Detective_Storyline', '侦探故事'], ['Ellinel_Fairy_Academy', '妖精学院'], ['Gold_Beach', '黄金海滩'],
  ['Elodin', '艾洛丁'], ['Pathfinder_Partem', '遗迹开拓者'], ['Partem_Ruins', '帕特姆遗迹'],
  ['Lion_Kings_Castle', '狮子王城堡'], ['Particle_Movement_Use', '粒子移动'],
  ['Special_Training', '特别训练'], ['Job_Training', '职业训练'], ['Battle_Mode', '战斗模式'],
  ['Silent_Crusade', '沉默骑士团'], ['Showa_Town', '昭和村'], ['Edelstein', '埃德尔斯坦'],
  ['Riena_Strait', '里纳海峡'], ['Savage_Terminal', '野蛮终点站'], ['Returning_Adventurer', '回归冒险家'],
  ['EvolvingSystem', '进化系统'], ['ThemeDungeon', '主题地下城'], ['Boardgame', '桌游'],
  ['Maple_Rewards', '枫叶奖励'], ['System_Features', '系统功能'], ['Root_Abyss', '根源深渊'],
  ['Mentoring', '师徒'], ['PC_Room_MonsterArena', '网吧怪物竞技场'], ['Crimsonheart', '绯红之心'],
  ['Stone_Colossus', '石巨人'], ['Ursus', '乌尔苏斯'], ['Maplerunner', '枫叶跑者'],
  ['Battle_Monster', '战斗怪物'], ['HOFM_HerosOfMaple', '枫叶英雄'], ['Fifth_Job_V', '五转'],
  ['Daily_Quest', '每日任务'], ['Legion_System', '联盟系统'], ['Maple_Achievements', '枫叶成就'],
  ['Tutorial_And_Job', '教程与职业'],
];

const MEDALS = [
  ['NoneOrUnknown', '无'], ['Job', '职业'], ['Normal', '普通'], ['Challenge', '挑战'], ['Event', '活动'], ['NO', '编号'],
];

const CHECK_TYPES = [
  ['Npc', 'NPC'], ['Job', '职业'], ['Quest', '任务'], ['Item', '物品'], ['Info', '信息'],
  ['InfoNumber', '信息编号'], ['InfoEx', '信息Ex'], ['DayByDay', '每日'], ['DayOfWeek', '星期'],
  ['FieldEnter', '进入地图'], ['SubJobFlags', '副职业标志'], ['Premium', '高级'], ['Pop', '人气'],
  ['Skill', '技能'], ['Mob', '怪物'], ['EndMeso', '结束金币'], ['Pet', '宠物'],
  ['PetTamenessMin', '宠物亲密度最小'], ['PetTamenessMax', '宠物亲密度最大'],
  ['PetRecallLimit', '宠物召回限制'], ['PetAutoSpeakingLimit', '宠物自动说话限制'],
  ['TamingMobLevelMin', '驯服怪物等级最小'], ['WeeklyRepeat', '每周重复'], ['Married', '已婚'],
  ['CharmMin', '魅力最小'], ['CharismaMin', '领导力最小'], ['InsightMin', '洞察力最小'],
  ['WillMin', '意志力最小'], ['CraftMin', '手艺最小'], ['SenseMin', '感性最小'],
  ['ExceptBuff', '排除增益'], ['EquipAllNeed', '装备全部需要'], ['EquipSelectNeed', '装备选择需要'],
  ['WorldMin', '世界最小'], ['WorldMax', '世界最大'], ['LvMin', '等级最小'], ['LvMax', '等级最大'],
  ['NormalAutoStart', '普通自动开始'], ['Interval', '间隔'], ['Start', '开始日期'], ['End', '结束日期'],
  ['Start_t', '开始日期_t'], ['End_t', '结束日期_t'], ['Startscript', '开始脚本'], ['Endscript', '结束脚本'],
];

const ACT_TYPES = [
  ['Item', '物品'], ['Exp', '经验'], ['Npc', 'NPC'], ['NpcAct', 'NPC动作'], ['Money', '金币'],
  ['Pop', '人气'], ['BuffItemId', '增益物品'], ['LvMin', '等级最小'], ['LvMax', '等级最大'],
  ['Info', '信息'], ['FieldEnter', '进入地图'], ['Skill', '技能'], ['Job', '职业'], ['Sp', 'SP'],
  ['Message_Map', '消息+地图'], ['Interval', '间隔'], ['Start', '开始日期'], ['End', '结束日期'],
  ['Conversation0123', '对话'], ['Quest', '任务'], ['NextQuest', '下一任务'],
  ['PetSpeed', '宠物速度'], ['PetTameness', '宠物亲密度'], ['PetSkill', '宠物技能'],
  ['CraftEXP', '手艺经验'], ['CharmEXP', '魅力经验'], ['CharismaEXP', '领导力经验'],
  ['InsightEXP', '洞察力经验'], ['WillEXP', '意志力经验'], ['SenseEXP', '感性经验'],
];

const QUEST_STATES = [
  ['0', '未开始'], ['1', '进行中'], ['2', '可完成'], ['3', '已完成'], ['4', '已结束'],
];

const POTENTIALS = [
  ['Normal', '普通'], ['Rare', '稀有'], ['Epic', '史诗'], ['Unique', '唯一'], ['Legendary', '传说'],
  ['NebulitesA', '星岩A'], ['NebulitesB', '星岩B'], ['NebulitesC', '星岩C'], ['NebulitesD', '星岩D'],
];

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_LABELS = { Monday: '周一', Tuesday: '周二', Wednesday: '周三', Thursday: '周四', Friday: '周五', Saturday: '周六', Sunday: '周日' };

const STOP_TYPES = ['Default', 'Item', 'Npc', 'Quest', 'Info', 'Mob'];

/** Check types that store a single integer amount. */
const AMOUNT_CHECK = new Set([
  'Npc', 'InfoNumber', 'SubJobFlags', 'Pop', 'EndMeso', 'PetTamenessMin', 'PetTamenessMax',
  'TamingMobLevelMin', 'CharmMin', 'CharismaMin', 'InsightMin', 'WillMin', 'CraftMin', 'SenseMin',
  'WorldMin', 'WorldMax', 'LvMin', 'LvMax', 'Interval',
]);

/** Check types that store a boolean flag. */
const BOOL_CHECK = new Set([
  'DayByDay', 'Premium', 'PetRecallLimit', 'PetAutoSpeakingLimit', 'WeeklyRepeat', 'Married',
  'NormalAutoStart',
]);

/** Check types that store a list of numbers as 0/1/2 children. */
const NUMBER_LIST_CHECK = new Set(['FieldEnter', 'Pet', 'EquipAllNeed', 'EquipSelectNeed']);

/** Act types that store a single integer amount. */
const AMOUNT_ACT = new Set([
  'Exp', 'Npc', 'Money', 'Pop', 'LvMin', 'LvMax', 'Interval', 'BuffItemId', 'NextQuest',
  'PetSpeed', 'PetTameness', 'PetSkill', 'CraftEXP', 'CharmEXP', 'CharismaEXP', 'InsightEXP',
  'WillEXP', 'SenseEXP',
]);

export class QuestSection {
  constructor({ host, app }) {
    this.host = host;
    this.app = app;
    this.fileId = null;
    this.page = 1;
    this.query = '';
    this.areaFilter = '';
    this.capabilities = { available: false };
    this.quests = [];
    this.stats = null;
    this.truncated = false;
    this.error = null;
    this.loading = false;
    this.selectedPath = null;
    this.detail = null;
    this.detailLoading = false;
    this.detailError = null;
    this.activeTab = 'info';
    this.resultHost = null;
    this.searchInput = null;
  }

  async guard(key, run) {
    try {
      await runOnce(`quest:${key}`, run);
    } catch (error) {
      toastError(error);
    }
  }

  async open(fileId = this.fileId) {
    this.fileId = fileId;
    this.page = 1;
    this.render();
    await this.load();
  }

  async refresh() {
    await this.load();
  }

  async load() {
    this.error = null;
    this.loading = true;
    this.render();

    try {
      this.capabilities = await api.questCapabilities();
    } catch (error) {
      this.capabilities = { available: false };
      this.error = error;
      this.loading = false;
      this.render();
      return;
    }

    if (!this.capabilities.available) {
      this.quests = [];
      this.stats = null;
      this.loading = false;
      this.render();
      return;
    }

    try {
      const list = await api.questList(this.fileId);
      this.quests = list.quests || [];
      this.stats = list.stats || null;
      this.truncated = Boolean(list.truncated);
      // A reload can drop the quest the detail pane points at.
      if (this.selectedPath && !this.quests.some((q) => q.path === this.selectedPath)) {
        this.selectedPath = null;
        this.detail = null;
      }
    } catch (error) {
      this.error = error;
      this.quests = [];
      this.stats = null;
    } finally {
      this.loading = false;
    }
    this.render();
  }

  get filtered() {
    const needle = this.query.trim().toLowerCase();
    return this.quests.filter((quest) => {
      if (this.areaFilter && quest.area !== this.areaFilter) return false;
      if (!needle) return true;
      return String(quest.questId).includes(needle)
          || (quest.name || '').toLowerCase().includes(needle);
    });
  }

  /** Sorted by id, which is the natural order of a quest archive. */
  get ordered() {
    return [...this.filtered].sort((a, b) => a.questId - b.questId);
  }

  get pageRows() {
    const start = (this.page - 1) * PAGE_SIZE;
    return this.ordered.slice(start, start + PAGE_SIZE);
  }

  get pageCount() {
    return Math.max(1, Math.ceil(this.ordered.length / PAGE_SIZE));
  }

  countFor(area) {
    if (!area) return this.quests.length;
    return this.quests.filter((q) => q.area === area).length;
  }

  /* ============================================================
     RENDER
     ============================================================ */

  render() {
    clear(this.host);
    this.host.className = 'stage-body quests';

    if (this.error) {
      this.host.append(emptyState(
        'alert', '无法读取任务列表',
        this.error.message,
        el('div', { class: 'qst-empty-actions' },
          el('button', { class: 'btn btn-primary', onclick: () => this.load() },
            icon('refresh', { size: 15 }), '重试'),
          el('button', { class: 'btn', onclick: () => this.app.openFilePicker() },
            icon('folderOpen', { size: 15 }), '打开文件'))));
      return;
    }

    if (!this.capabilities.available) {
      this.host.append(emptyState(
        'star', '未打开 Quest.wz',
        '任务编辑需要读取 Quest.wz(QuestInfo/Say/Act/Check)。打开客户端文件夹以加载它。',
        el('button', { class: 'btn btn-primary', onclick: () => this.app.openFilePicker() },
          icon('folderOpen', { size: 15 }), '打开客户端')));
      return;
    }

    this.resultHost = el('div', { class: 'qst-layout' });
    this.host.append(...[
      this.buildHead(),
      this.buildToolbar(),
      this.resultHost,
    ].filter(Boolean));

    this.renderResults();
  }

  buildHead() {
    const candidates = this.app.files.filter((file) => /^quest/i.test(file.name));
    const scoped = this.fileId ? this.app.files.find((f) => f.id === this.fileId) : null;
    const subject = scoped
      ? scoped.name
      : candidates.length === 1
        ? candidates[0].name
        : candidates.length > 1
          ? `${candidates.length} 个任务存档`
          : '所有已打开的存档';

    const head = el('div', { class: 'qst-panel qst-head' },
      el('div', { class: 'qst-head-text' },
        el('div', { class: 'qst-head-title', text: '任务' }),
        el('div', { class: 'qst-head-sub' },
          el('span', { text: '正在编辑 ' }),
          el('b', { text: subject }),
          el('span', {
            text: this.stats
              ? ` · 共 ${fmt.format(this.stats.total)} 个任务` +
                (this.stats.withSay ? `,${fmt.format(this.stats.withSay)} 个有对话` : '') +
                (this.stats.withAct ? `,${fmt.format(this.stats.withAct)} 个有奖励` : '') +
                (this.stats.withCheck ? `,${fmt.format(this.stats.withCheck)} 个有条件` : '')
              : '',
          }))));

    if (candidates.length > 1) {
      const select = el('select', { class: 'qst-select', 'aria-label': '选择任务存档' },
        el('option', { value: '', text: `全部任务存档(${candidates.length})`, selected: !this.fileId }),
        candidates.map((file) => el('option', { value: file.id, text: file.name, selected: file.id === this.fileId })));
      select.addEventListener('change', () => {
        this.selectedPath = null;
        this.detail = null;
        this.open(select.value || null);
      });
      head.append(select);
    }

    head.append(el('button', {
      class: 'btn btn-icon', 'data-tip': '重新加载任务列表',
      onclick: () => this.load(),
    }, icon('refresh', { size: 15 })));

    return head;
  }

  buildToolbar() {
    const search = el('input', {
      type: 'search', value: this.query,
      placeholder: '按任务 ID 或名称搜索…',
      'aria-label': '搜索任务',
    });
    search.addEventListener('input', debounce(() => {
      this.query = search.value;
      this.page = 1;
      this.renderResults();
    }, 160));
    this.searchInput = search;

    const areas = el('select', { class: 'qst-select', 'aria-label': '按区域筛选' },
      el('option', { value: '', text: `全部区域(${fmt.format(this.quests.length)})`, selected: !this.areaFilter }),
      AREAS.map(([value, label]) => el('option', {
        value, text: `${label}(${fmt.format(this.countFor(value))})`, selected: this.areaFilter === value,
      })));
    areas.addEventListener('change', () => {
      this.areaFilter = areas.value;
      this.page = 1;
      this.renderResults();
    });

    return el('div', { class: 'qst-panel qst-toolbar' },
      el('div', { class: 'qst-search' }, el('span', { class: 'icon' }, icon('search', { size: 15 })), search),
      areas);
  }

  renderResults() {
    if (!this.resultHost) { this.render(); return; }
    clear(this.resultHost);

    if (this.loading) {
      this.resultHost.append(el('div', { class: 'qst-panel' },
        el('div', { class: 'qst-result-head' }, el('span', { text: '正在读取任务…' })),
        ...Array.from({ length: 6 }, () => el('div', { class: 'skeleton skeleton-row' }))));
      return;
    }

    const rows = this.pageRows;

    const list = el('div', { class: 'qst-panel qst-list' },
      el('div', { class: 'qst-list-head' },
        el('span', { class: 'qst-list-count', text: `${fmt.format(this.ordered.length)} 个任务` }),
        el('span', { class: 'qst-pager' },
          el('button', {
            class: 'btn btn-icon', disabled: this.page <= 1, 'aria-label': '上一页',
            onclick: () => { this.page--; this.renderResults(); },
          }, icon('arrowLeft', { size: 14 })),
          el('span', { text: `${this.page} / ${this.pageCount}` }),
          el('button', {
            class: 'btn btn-icon', disabled: this.page >= this.pageCount, 'aria-label': '下一页',
            onclick: () => { this.page++; this.renderResults(); },
          }, icon('arrowRight', { size: 14 })))));

    if (rows.length === 0) {
      list.append(el('div', { class: 'qst-empty', text: this.query || this.areaFilter
        ? '没有匹配的任务。'
        : '存档中没有可编辑的任务。' }));
    } else {
      for (const quest of rows) {
        const active = quest.path === this.selectedPath;
        list.append(el('button', {
          class: 'qst-item', 'data-active': active ? 'true' : 'false',
          onclick: () => this.selectQuest(quest),
        },
          el('span', { class: 'qst-item-id', text: String(quest.questId) }),
          el('span', { class: 'qst-item-body' },
            el('span', { class: 'qst-item-name', text: quest.name || '(无名称)' }),
            el('span', { class: 'qst-item-sub' },
              el('span', { class: 'qst-item-area', text: areaLabel(quest.area) }),
              quest.order ? el('span', { text: `排序 ${quest.order}` }) : null,
              quest.dirty ? el('span', { class: 'qst-item-dirty', text: '已修改' }) : null)),
          el('span', { class: 'qst-item-arrow' }, icon('chevronRight', { size: 14 }))));
      }
    }

    this.resultHost.append(list);

    // Detail pane: an editor column beside the list.
    const detail = el('div', { class: 'qst-panel qst-detail' });
    if (this.detailLoading) {
      detail.append(el('div', { class: 'qst-detail-busy' },
        el('div', { class: 'skeleton skeleton-row' }),
        el('div', { class: 'skeleton skeleton-row' }),
        el('div', { class: 'skeleton skeleton-row' })));
    } else if (this.detailError) {
      detail.append(emptyState('alert', '无法读取任务详情', this.detailError.message));
    } else if (this.detail) {
      detail.append(this.buildDetail());
    } else {
      detail.append(el('div', { class: 'qst-detail-empty' },
        icon('star', { size: 28 }),
        el('div', { text: this.selectedPath ? '正在加载…' : '选择左侧任务以编辑' })));
    }
    this.resultHost.append(detail);
  }

  async selectQuest(quest) {
    this.selectedPath = quest.path;
    this.detail = null;
    this.detailError = null;
    this.detailLoading = true;
    this.activeTab = 'info';
    this.renderResults();
    try {
      this.detail = await api.questDetail(quest.path);
      this.detailError = null;
    } catch (error) {
      this.detailError = error;
    } finally {
      this.detailLoading = false;
      this.renderResults();
    }
  }

  /* ============================================================
     DETAIL EDITOR
     ============================================================ */

  buildDetail() {
    const quest = this.detail;

    const tabs = el('div', { class: 'qst-tabs' },
      [['info', '基本信息'], ['say', '对话'], ['act', '奖励'], ['check', '条件']].map(([id, label]) =>
        el('button', {
          class: 'qst-tab', 'aria-pressed': this.activeTab === id ? 'true' : 'false',
          onclick: () => { this.activeTab = id; this.renderResults(); },
        }, label)));

    const body = el('div', { class: 'qst-tabbody' });
    if (this.activeTab === 'info') body.append(this.buildInfoTab(quest));
    else if (this.activeTab === 'say') body.append(this.buildSayTab(quest));
    else if (this.activeTab === 'act') body.append(this.buildActTab(quest));
    else body.append(this.buildCheckTab(quest));

    return el('div', { class: 'qst-detail-editor' },
      el('div', { class: 'qst-detail-head' },
        el('div', { class: 'qst-detail-title', text: `任务 ${quest.questId}${quest.name ? ` · ${quest.name}` : ''}` }),
        quest.dirty ? el('span', { class: 'qst-item-dirty', text: '已修改' }) : null),
      tabs,
      body,
      el('div', { class: 'qst-detail-actions' },
        el('button', {
          class: 'btn btn-primary', 'data-tip': '将四个区块(QuestInfo/Say/Act/Check)一次性写入存档',
          onclick: () => this.saveQuest(),
        }, icon('save', { size: 15 }), '保存任务')));
  }

  buildInfoTab(quest) {
    const field = (label, control, hint) => el('label', { class: 'qst-field' },
      el('span', { class: 'qst-field-label', text: label }),
      control,
      hint ? el('span', { class: 'qst-field-hint', text: hint }) : null);

    const text = (key, placeholder = '') => {
      const input = el('input', { type: 'text', value: quest[key] ?? '', placeholder });
      input.addEventListener('input', () => { quest[key] = input.value; });
      return input;
    };
    const area = (key) => {
      const select = el('select', {},
        AREAS.map(([value, label]) => el('option', { value, text: label, selected: quest[key] === value })));
      select.addEventListener('change', () => { quest[key] = select.value; });
      return select;
    };
    const bool = (key, label) => {
      const box = el('input', { type: 'checkbox', checked: !!quest[key] });
      box.addEventListener('change', () => { quest[key] = box.checked; });
      return el('label', { class: 'qst-check' }, box, el('span', { text: label }));
    };

    return el('div', { class: 'qst-grid' },
      field('名称', text('name', '任务显示名称')),
      field('任务描述 0', text('questInfoDesc0')),
      field('任务描述 1', text('questInfoDesc1')),
      field('任务描述 2', text('questInfoDesc2')),
      field('父任务 ID', text('parent', '例如 28483')),
      field('区域', area('area')),
      field('排序', text('order')),
      field('摘要', text('summary')),
      field('需求摘要', text('demandSummary')),
      field('奖励摘要', text('rewardSummary')),
      field('显示图层标签', text('showLayerTag')),
      field('勋章物品 ID', text('viewMedalItem', '仅当为勋章任务时')),
      field('勋章类别', (() => {
        const select = el('select', {},
          MEDALS.map(([value, label]) => el('option', { value, text: label, selected: quest.medalCategory === value })));
        select.addEventListener('change', () => {
          quest.medalCategory = select.value;
          quest.isMedal = select.value !== 'NoneOrUnknown';
          this.renderResults();
        });
        return select;
      })()),
      el('div', { class: 'qst-bools' },
        bool('blocked', '已封锁'),
        bool('autoStart', '自动开始'),
        bool('autoPreComplete', '自动预完成'),
        bool('autoComplete', '自动完成'),
        bool('autoCompleteAction', '自动完成动作'),
        bool('selectedMob', '选中怪物'),
        bool('autoAccept', '自动接受'),
        bool('autoCancel', '自动取消'),
        bool('oneShot', '一次性'),
        bool('disableAtStartTab', '禁用开始标签'),
        bool('disableAtPerformTab', '禁用进行标签'),
        bool('disableAtCompleteTab', '禁用完成标签')),
    );
  }

  buildSayTab(quest) {
    return el('div', { class: 'qst-say' },
      this.buildConversationSection('开始对话', quest.sayStart, quest.sayStopStart, 'sayStart', 'sayStopStart'),
      this.buildConversationSection('结束对话', quest.sayEnd, quest.sayStopEnd, 'sayEnd', 'sayStopEnd'));
  }

  buildConversationSection(title, conversations, stops, convKey, stopKey) {
    const section = el('div', { class: 'qst-say-section' },
      el('div', { class: 'qst-section-title', text: title }));

    for (let i = 0; i < conversations.length; i++) {
      const say = conversations[i];
      const textarea = el('textarea', { rows: 3, value: say.npcConversation,
        placeholder: 'NPC 对话文本(支持 #b/#k/#L0#/#l 等代码)' });
      textarea.addEventListener('input', () => { say.npcConversation = textarea.value; });

      const convType = el('select', { class: 'qst-select' },
        ['NextPrev', 'YesNo', 'Ask'].map((t) => el('option', { value: t, text: t, selected: say.conversationType === t })));
      convType.addEventListener('change', () => { say.conversationType = convType.value; });

      const yesBox = this.buildResponseList(say.yesResponses, '是(Yes)');
      const noBox = this.buildResponseList(say.noResponses, '否(No)');

      section.append(el('div', { class: 'qst-conv' },
        el('div', { class: 'qst-conv-head' },
          el('span', { class: 'qst-conv-index', text: `#${i + 1}` }),
          convType,
          el('button', {
            class: 'btn btn-icon', 'data-tip': '删除这条对话',
            onclick: () => { conversations.splice(i, 1); this.renderResults(); },
          }, icon('trash', { size: 14 }))),
        textarea,
        el('div', { class: 'qst-resp-row' }, yesBox, noBox)));
    }

    const addBtn = el('button', {
      class: 'btn btn-sm', onclick: () => {
        conversations.push({ npcConversation: '', conversationType: 'NextPrev', yesResponses: [], noResponses: [] });
        this.renderResults();
      },
    }, icon('plus', { size: 14 }), '添加对话');
    section.append(addBtn);

    if (stops.length > 0) {
      section.append(el('div', { class: 'qst-stop-head', text: '停止对话(条件不满足时的提示)' }));
      for (const stop of stops) {
        const box = this.buildResponseList(stop.responses, stop.conversationType);
        section.append(el('div', { class: 'qst-conv' },
          el('div', { class: 'qst-conv-head' },
            el('span', { class: 'qst-stop-type', text: stopTypeLabel(stop.conversationType) }),
            el('button', {
              class: 'btn btn-icon', 'data-tip': '删除这组停止对话',
              onclick: () => { stops.splice(stops.indexOf(stop), 1); this.renderResults(); },
            }, icon('trash', { size: 14 }))),
          box));
      }
    }

    const addStop = el('button', {
      class: 'btn btn-sm', onclick: () => {
        stops.push({ conversationType: 'Default', responses: [] });
        this.renderResults();
      },
    }, icon('plus', { size: 14 }), '添加停止对话');
    section.append(addStop);

    return section;
  }

  buildResponseList(responses, label) {
    const box = el('div', { class: 'qst-resp-list' },
      el('div', { class: 'qst-resp-label', text: label }));
    for (let i = 0; i < responses.length; i++) {
      const input = el('input', { type: 'text', value: responses[i], placeholder: '回应文本' });
      input.addEventListener('input', () => { responses[i] = input.value; });
      box.append(el('div', { class: 'qst-resp-item' },
        input,
        el('button', {
          class: 'btn btn-icon', 'data-tip': '删除',
          onclick: () => { responses.splice(i, 1); this.renderResults(); },
        }, icon('close', { size: 12 }))));
    }
    box.append(el('button', {
      class: 'btn btn-sm', onclick: () => { responses.push(''); this.renderResults(); },
    }, icon('plus', { size: 12 }), '添加'));
    return box;
  }

  buildActTab(quest) {
    return el('div', { class: 'qst-act' },
      this.buildActSection('开始奖励(Act 0)', quest.actStart),
      this.buildActSection('完成奖励(Act 1)', quest.actEnd));
  }

  buildActSection(title, acts) {
    const section = el('div', { class: 'qst-act-section' },
      el('div', { class: 'qst-section-title', text: title }));

    for (const act of acts) {
      const card = el('div', { class: 'qst-card' });
      const typeSelect = el('select', { class: 'qst-select' },
        ACT_TYPES.map(([value, label]) => el('option', { value, text: label, selected: act.actType === value })));
      typeSelect.addEventListener('change', () => {
        const oldType = act.actType;
        act.actType = typeSelect.value;
        // Rebuild the card for the new type's fields.
        this.renderResults();
      });

      card.append(el('div', { class: 'qst-card-head' },
        typeSelect,
        el('button', {
          class: 'btn btn-icon', 'data-tip': '删除这条奖励',
          onclick: () => { acts.splice(acts.indexOf(act), 1); this.renderResults(); },
        }, icon('trash', { size: 14 }))));

      card.append(this.buildActFields(act));
      section.append(card);
    }

    section.append(el('button', {
      class: 'btn btn-sm', onclick: () => {
        acts.push({ actType: 'Exp', amount: 0, text: '', date: '', selectedNumbers: [], rewardItems: [],
                     sp: [], skillsAcquire: [], jobsReqs: [], questReqs: [], conversationStart: [], conversationStop: [] });
        this.renderResults();
      },
    }, icon('plus', { size: 14 }), '添加奖励'));
    return section;
  }

  buildActFields(act) {
    const fields = el('div', { class: 'qst-card-fields' });
    const num = (key, label) => {
      const input = el('input', { type: 'number', value: act[key] || '', 'aria-label': label });
      input.addEventListener('input', () => { act[key] = input.value === '' ? 0 : Number(input.value); });
      return input;
    };

    if (AMOUNT_ACT.has(act.actType)) {
      fields.append(this.labeled('数值', num('amount', '数值')));
    }
    if (act.actType === 'Start' || act.actType === 'End') {
      const input = el('input', { type: 'text', value: act.date || '', placeholder: 'yyyyMMddHH 或 yyyyMMddHHmm' });
      input.addEventListener('input', () => { act.date = input.value; });
      fields.append(this.labeled('日期', input));
    }
    if (act.actType === 'NpcAct' || act.actType === 'Info') {
      const input = el('input', { type: 'text', value: act.text || '' });
      input.addEventListener('input', () => { act.text = input.value; });
      fields.append(this.labeled('文本', input));
    }
    if (act.actType === 'Message_Map') {
      const input = el('input', { type: 'text', value: act.text || '' });
      input.addEventListener('input', () => { act.text = input.value; });
      fields.append(this.labeled('消息文本', input));
      fields.append(this.buildNumberList(act.selectedNumbers, '地图 ID'));
    }
    if (act.actType === 'FieldEnter') {
      fields.append(this.buildNumberList(act.selectedNumbers, '地图 ID'));
    }
    if (act.actType === 'Item') {
      fields.append(this.buildRewardItems(act));
    }
    if (act.actType === 'Quest') {
      fields.append(this.buildQuestRefs(act.questReqs, '前置任务'));
    }
    if (act.actType === 'Job') {
      fields.append(this.buildNumberList(act.jobsReqs, '职业 ID'));
    }
    if (act.actType === 'Sp') {
      fields.append(this.buildSpList(act));
    }
    if (act.actType === 'Skill') {
      fields.append(this.buildActSkillList(act));
    }
    if (act.actType === 'Conversation0123') {
      fields.append(this.buildConversationSection('嵌入对话', act.conversationStart, act.conversationStop, 'conversationStart', 'conversationStop'));
    }

    return fields;
  }

  buildRewardItems(act) {
    const box = el('div', { class: 'qst-sub-block' },
      el('div', { class: 'qst-sub-title', text: '奖励物品' }));
    for (let i = 0; i < act.rewardItems.length; i++) {
      const item = act.rewardItems[i];
      const idInput = el('input', { type: 'number', value: item.itemId, 'aria-label': '物品 ID' });
      idInput.addEventListener('input', () => { item.itemId = Number(idInput.value) || 0; });
      const countInput = el('input', { type: 'number', value: item.quantity, 'aria-label': '数量' });
      countInput.addEventListener('input', () => { item.quantity = Number(countInput.value) || 0; });
      const periodInput = el('input', { type: 'number', value: item.period, 'aria-label': '期限(分钟)' });
      periodInput.addEventListener('input', () => { item.period = Number(periodInput.value) || 0; });
      const potSelect = el('select', {},
        POTENTIALS.map(([value, label]) => el('option', { value, text: label, selected: item.potentialGrade === value })));
      potSelect.addEventListener('change', () => { item.potentialGrade = potSelect.value; });

      box.append(el('div', { class: 'qst-reward-row' },
        idInput, countInput, periodInput, potSelect,
        el('button', {
          class: 'btn btn-icon', 'data-tip': '删除物品',
          onclick: () => { act.rewardItems.splice(i, 1); this.renderResults(); },
        }, icon('close', { size: 12 }))));
    }
    box.append(el('button', {
      class: 'btn btn-sm', onclick: () => {
        act.rewardItems.push({ itemId: 0, quantity: 1, period: 0, var: 0, prop: 0, potentialGrade: 'Normal', gender: 2, expireDate: '', job: 0, jobEx: 0 });
        this.renderResults();
      },
    }, icon('plus', { size: 12 }), '添加物品'));
    return box;
  }

  buildQuestRefs(refs, label) {
    const box = el('div', { class: 'qst-sub-block' },
      el('div', { class: 'qst-sub-title', text: label }));
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const idInput = el('input', { type: 'number', value: ref.questId, 'aria-label': '任务 ID' });
      idInput.addEventListener('input', () => { ref.questId = Number(idInput.value) || 0; });
      const stateSelect = el('select', {},
        QUEST_STATES.map(([value, labelText]) => el('option', { value, text: labelText, selected: String(ref.questState) === value })));
      stateSelect.addEventListener('change', () => { ref.questState = stateSelect.value; });

      box.append(el('div', { class: 'qst-reward-row' },
        idInput, stateSelect,
        el('button', {
          class: 'btn btn-icon', 'data-tip': '删除',
          onclick: () => { refs.splice(i, 1); this.renderResults(); },
        }, icon('close', { size: 12 }))));
    }
    box.append(el('button', {
      class: 'btn btn-sm', onclick: () => { refs.push({ questId: 0, questState: '0' }); this.renderResults(); },
    }, icon('plus', { size: 12 }), '添加'));
    return box;
  }

  buildSpList(act) {
    const box = el('div', { class: 'qst-sub-block' },
      el('div', { class: 'qst-sub-title', text: 'SP 奖励(艾文等)' }));
    for (let i = 0; i < act.sp.length; i++) {
      const sp = act.sp[i];
      const valueInput = el('input', { type: 'number', value: sp.spValue, 'aria-label': 'SP 值' });
      valueInput.addEventListener('input', () => { sp.spValue = Number(valueInput.value) || 0; });
      const jobsInput = el('input', { type: 'text', value: sp.jobs.join(','), placeholder: '职业 ID,逗号分隔' });
      jobsInput.addEventListener('input', () => {
        sp.jobs = jobsInput.value.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
      });
      box.append(el('div', { class: 'qst-reward-row' },
        valueInput, jobsInput,
        el('button', {
          class: 'btn btn-icon', 'data-tip': '删除',
          onclick: () => { act.sp.splice(i, 1); this.renderResults(); },
        }, icon('close', { size: 12 }))));
    }
    box.append(el('button', {
      class: 'btn btn-sm', onclick: () => { act.sp.push({ spValue: 1, jobs: [] }); this.renderResults(); },
    }, icon('plus', { size: 12 }), '添加 SP'));
    return box;
  }

  buildActSkillList(act) {
    const box = el('div', { class: 'qst-sub-block' },
      el('div', { class: 'qst-sub-title', text: '技能奖励' }));
    for (let i = 0; i < act.skillsAcquire.length; i++) {
      const skill = act.skillsAcquire[i];
      const idInput = el('input', { type: 'number', value: skill.id, 'aria-label': '技能 ID' });
      idInput.addEventListener('input', () => { skill.id = Number(idInput.value) || 0; });
      const levelInput = el('input', { type: 'number', value: skill.skillLevel, 'aria-label': '技能等级' });
      levelInput.addEventListener('input', () => { skill.skillLevel = Number(levelInput.value) || 0; });
      const masterInput = el('input', { type: 'number', value: skill.masterLevel, 'aria-label': '精通等级' });
      masterInput.addEventListener('input', () => { skill.masterLevel = Number(masterInput.value) || 0; });
      const acquireInput = el('input', { type: 'number', value: skill.acquire, 'aria-label': 'acquire(-1 移除)' });
      acquireInput.addEventListener('input', () => { skill.acquire = Number(acquireInput.value) || 0; });
      const jobsInput = el('input', { type: 'text', value: skill.jobIds.join(','), placeholder: '职业 ID,逗号分隔' });
      jobsInput.addEventListener('input', () => {
        skill.jobIds = jobsInput.value.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
      });
      box.append(el('div', { class: 'qst-skill-row' },
        idInput, levelInput, masterInput, acquireInput, jobsInput,
        el('button', {
          class: 'btn btn-icon', 'data-tip': '删除',
          onclick: () => { act.skillsAcquire.splice(i, 1); this.renderResults(); },
        }, icon('close', { size: 12 }))));
    }
    box.append(el('button', {
      class: 'btn btn-sm', onclick: () => {
        act.skillsAcquire.push({ id: 0, skillLevel: 0, masterLevel: 0, onlyMasterLevel: false, acquire: 0, jobIds: [] });
        this.renderResults();
      },
    }, icon('plus', { size: 12 }), '添加技能'));
    return box;
  }

  buildCheckTab(quest) {
    return el('div', { class: 'qst-check' },
      this.buildCheckSection('开始条件(Check 0)', quest.checkStart),
      this.buildCheckSection('完成条件(Check 1)', quest.checkEnd));
  }

  buildCheckSection(title, checks) {
    const section = el('div', { class: 'qst-check-section' },
      el('div', { class: 'qst-section-title', text: title }));

    for (const check of checks) {
      const card = el('div', { class: 'qst-card' });
      const typeSelect = el('select', { class: 'qst-select' },
        CHECK_TYPES.map(([value, label]) => el('option', { value, text: label, selected: check.checkType === value })));
      typeSelect.addEventListener('change', () => {
        check.checkType = typeSelect.value;
        this.renderResults();
      });

      card.append(el('div', { class: 'qst-card-head' },
        typeSelect,
        el('button', {
          class: 'btn btn-icon', 'data-tip': '删除这条条件',
          onclick: () => { checks.splice(checks.indexOf(check), 1); this.renderResults(); },
        }, icon('trash', { size: 14 }))));

      card.append(this.buildCheckFields(check));
      section.append(card);
    }

    section.append(el('button', {
      class: 'btn btn-sm', onclick: () => {
        checks.push({ checkType: 'Npc', amount: 0, text: '', boolean: false, date: '', selectedNumbers: [],
                       selectedReqItems: [], skills: [], jobs: [], questReqs: [], dayOfWeek: [],
                       mobReqs: [], questInfo: [], questInfoEx: [] });
        this.renderResults();
      },
    }, icon('plus', { size: 14 }), '添加条件'));
    return section;
  }

  buildCheckFields(check) {
    const fields = el('div', { class: 'qst-card-fields' });

    if (AMOUNT_CHECK.has(check.checkType)) {
      const input = el('input', { type: 'number', value: check.amount || '', 'aria-label': '数值' });
      input.addEventListener('input', () => { check.amount = input.value === '' ? 0 : Number(input.value); });
      fields.append(this.labeled('数值', input));
    }
    if (BOOL_CHECK.has(check.checkType)) {
      const input = el('input', { type: 'checkbox', checked: !!check.boolean,
        onchange: () => { check.boolean = input.checked; } });
      fields.append(this.labeled('启用', input));
    }
    if (check.checkType === 'Start' || check.checkType === 'End'
        || check.checkType === 'Start_t' || check.checkType === 'End_t') {
      const input = el('input', { type: 'text', value: check.date || '', placeholder: 'yyyyMMddHH 或 yyyyMMddHHmm' });
      input.addEventListener('input', () => { check.date = input.value; });
      fields.append(this.labeled('日期', input));
    }
    if (check.checkType === 'Startscript' || check.checkType === 'Endscript') {
      const input = el('input', { type: 'text', value: check.text || '' });
      input.addEventListener('input', () => { check.text = input.value; });
      fields.append(this.labeled('脚本', input));
    }
    if (NUMBER_LIST_CHECK.has(check.checkType)) {
      fields.append(this.buildNumberList(check.selectedNumbers, '数值'));
    }
    if (check.checkType === 'Job') {
      fields.append(this.buildNumberList(check.jobs, '职业 ID'));
    }
    if (check.checkType === 'Item') {
      fields.append(this.buildCheckItems(check));
    }
    if (check.checkType === 'Mob') {
      fields.append(this.buildMobReqs(check));
    }
    if (check.checkType === 'Skill') {
      fields.append(this.buildCheckSkills(check));
    }
    if (check.checkType === 'Quest') {
      fields.append(this.buildQuestRefs(check.questReqs, '前置任务'));
    }
    if (check.checkType === 'Info') {
      fields.append(this.buildInfoList(check));
    }
    if (check.checkType === 'InfoEx') {
      fields.append(this.buildInfoExList(check));
    }
    if (check.checkType === 'DayOfWeek') {
      fields.append(this.buildDayOfWeek(check));
    }

    return fields;
  }

  buildNumberList(numbers, label) {
    const box = el('div', { class: 'qst-sub-block' },
      el('div', { class: 'qst-sub-title', text: label }));
    for (let i = 0; i < numbers.length; i++) {
      const input = el('input', { type: 'number', value: numbers[i] });
      input.addEventListener('input', () => { numbers[i] = Number(input.value) || 0; });
      box.append(el('div', { class: 'qst-reward-row' },
        input,
        el('button', {
          class: 'btn btn-icon', 'data-tip': '删除',
          onclick: () => { numbers.splice(i, 1); this.renderResults(); },
        }, icon('close', { size: 12 }))));
    }
    box.append(el('button', {
      class: 'btn btn-sm', onclick: () => { numbers.push(0); this.renderResults(); },
    }, icon('plus', { size: 12 }), '添加'));
    return box;
  }

  buildCheckItems(check) {
    const box = el('div', { class: 'qst-sub-block' },
      el('div', { class: 'qst-sub-title', text: '需求物品' }));
    for (let i = 0; i < check.selectedReqItems.length; i++) {
      const item = check.selectedReqItems[i];
      const idInput = el('input', { type: 'number', value: item.itemId, 'aria-label': '物品 ID' });
      idInput.addEventListener('input', () => { item.itemId = Number(idInput.value) || 0; });
      const countInput = el('input', { type: 'number', value: item.quantity, 'aria-label': '数量' });
      countInput.addEventListener('input', () => { item.quantity = Number(countInput.value) || 0; });
      box.append(el('div', { class: 'qst-reward-row' },
        idInput, countInput,
        el('button', {
          class: 'btn btn-icon', 'data-tip': '删除',
          onclick: () => { check.selectedReqItems.splice(i, 1); this.renderResults(); },
        }, icon('close', { size: 12 }))));
    }
    box.append(el('button', {
      class: 'btn btn-sm', onclick: () => { check.selectedReqItems.push({ itemId: 0, quantity: 1 }); this.renderResults(); },
    }, icon('plus', { size: 12 }), '添加物品'));
    return box;
  }

  buildMobReqs(check) {
    const box = el('div', { class: 'qst-sub-block' },
      el('div', { class: 'qst-sub-title', text: '需求怪物' }));
    for (let i = 0; i < check.mobReqs.length; i++) {
      const mob = check.mobReqs[i];
      const idInput = el('input', { type: 'number', value: mob.id, 'aria-label': '怪物 ID' });
      idInput.addEventListener('input', () => { mob.id = Number(idInput.value) || 0; });
      const countInput = el('input', { type: 'number', value: mob.count, 'aria-label': '数量' });
      countInput.addEventListener('input', () => { mob.count = Number(countInput.value) || 0; });
      box.append(el('div', { class: 'qst-reward-row' },
        idInput, countInput,
        el('button', {
          class: 'btn btn-icon', 'data-tip': '删除',
          onclick: () => { check.mobReqs.splice(i, 1); this.renderResults(); },
        }, icon('close', { size: 12 }))));
    }
    box.append(el('button', {
      class: 'btn btn-sm', onclick: () => { check.mobReqs.push({ id: 0, count: 1 }); this.renderResults(); },
    }, icon('plus', { size: 12 }), '添加怪物'));
    return box;
  }

  buildCheckSkills(check) {
    const box = el('div', { class: 'qst-sub-block' },
      el('div', { class: 'qst-sub-title', text: '需求技能' }));
    for (let i = 0; i < check.skills.length; i++) {
      const skill = check.skills[i];
      const idInput = el('input', { type: 'number', value: skill.id, 'aria-label': '技能 ID' });
      idInput.addEventListener('input', () => { skill.id = Number(idInput.value) || 0; });
      const levelInput = el('input', { type: 'number', value: skill.skillLevel, 'aria-label': '技能等级' });
      levelInput.addEventListener('input', () => { skill.skillLevel = Number(levelInput.value) || 0; });
      const acquireInput = el('input', { type: 'checkbox', checked: !!skill.acquire,
        onchange: () => { skill.acquire = acquireInput.checked; } });
      const condSelect = el('select', {},
        ['None', 'OrGreater', 'Equal'].map((t) => el('option', { value: t, text: t, selected: skill.conditionType === t })));
      condSelect.addEventListener('change', () => { skill.conditionType = condSelect.value; });
      box.append(el('div', { class: 'qst-skill-row' },
        idInput, levelInput, el('label', { class: 'qst-check' }, acquireInput, el('span', { text: '获取' })), condSelect,
        el('button', {
          class: 'btn btn-icon', 'data-tip': '删除',
          onclick: () => { check.skills.splice(i, 1); this.renderResults(); },
        }, icon('close', { size: 12 }))));
    }
    box.append(el('button', {
      class: 'btn btn-sm', onclick: () => {
        check.skills.push({ id: 0, skillLevel: 0, acquire: false, conditionType: 'None' });
        this.renderResults();
      },
    }, icon('plus', { size: 12 }), '添加技能'));
    return box;
  }

  buildInfoList(check) {
    const box = el('div', { class: 'qst-sub-block' },
      el('div', { class: 'qst-sub-title', text: '信息文本' }));
    for (let i = 0; i < check.questInfo.length; i++) {
      const input = el('input', { type: 'text', value: check.questInfo[i].text });
      input.addEventListener('input', () => { check.questInfo[i].text = input.value; });
      box.append(el('div', { class: 'qst-reward-row' },
        input,
        el('button', {
          class: 'btn btn-icon', 'data-tip': '删除',
          onclick: () => { check.questInfo.splice(i, 1); this.renderResults(); },
        }, icon('close', { size: 12 }))));
    }
    box.append(el('button', {
      class: 'btn btn-sm', onclick: () => { check.questInfo.push({ text: '' }); this.renderResults(); },
    }, icon('plus', { size: 12 }), '添加'));
    return box;
  }

  buildInfoExList(check) {
    const box = el('div', { class: 'qst-sub-block' },
      el('div', { class: 'qst-sub-title', text: 'InfoEx 条目' }));
    for (let i = 0; i < check.questInfoEx.length; i++) {
      const infoEx = check.questInfoEx[i];
      const valueInput = el('input', { type: 'text', value: infoEx.value, 'aria-label': '值' });
      valueInput.addEventListener('input', () => { infoEx.value = valueInput.value; });
      const condInput = el('input', { type: 'number', value: infoEx.condition, 'aria-label': '条件(0/1/2)' });
      condInput.addEventListener('input', () => { infoEx.condition = Number(condInput.value) || 0; });
      box.append(el('div', { class: 'qst-reward-row' },
        valueInput, condInput,
        el('button', {
          class: 'btn btn-icon', 'data-tip': '删除',
          onclick: () => { check.questInfoEx.splice(i, 1); this.renderResults(); },
        }, icon('close', { size: 12 }))));
    }
    box.append(el('button', {
      class: 'btn btn-sm', onclick: () => { check.questInfoEx.push({ value: '', condition: 0 }); this.renderResults(); },
    }, icon('plus', { size: 12 }), '添加'));
    return box;
  }

  buildDayOfWeek(check) {
    const box = el('div', { class: 'qst-sub-block' },
      el('div', { class: 'qst-sub-title', text: '星期' }));
    const row = el('div', { class: 'qst-days' });
    for (const day of DAYS) {
      const selected = check.dayOfWeek.some((d) => d.dayOfWeek === day && d.isSelected);
      const input = el('input', { type: 'checkbox', checked: selected,
        onchange: () => {
          const existing = check.dayOfWeek.find((d) => d.dayOfWeek === day);
          if (input.checked) {
            if (existing) existing.isSelected = true;
            else check.dayOfWeek.push({ dayOfWeek: day, isSelected: true });
          } else if (existing) {
            existing.isSelected = false;
          }
        } });
      row.append(el('label', { class: 'qst-check' }, input, el('span', { text: DAY_LABELS[day] })));
    }
    box.append(row);
    return box;
  }

  labeled(label, control) {
    return el('label', { class: 'qst-field' },
      el('span', { class: 'qst-field-label', text: label }),
      control);
  }

  /* ============================================================
     SAVE
     ============================================================ */

  async saveQuest() {
    if (!this.detail) return;
    const quest = this.detail;
    await this.guard('save', async () => {
      const result = await api.questSave({ path: quest.path, quest });
      this.detail = result.quest;
      for (const note of result.notes || []) toast(note, 'info');
      toast('任务已保存。', 'success');
      this.renderResults();
      this.app?.sections?.reload?.();
    });
  }

  /** Puts the caret in the search box; for a palette command. */
  focusSearch() {
    this.searchInput?.focus();
    this.searchInput?.select();
  }
}

/* ============================================================
   Helpers
   ============================================================ */

function areaLabel(area) {
  const match = AREAS.find(([value]) => value === area);
  return match ? match[1] : (area || '未知');
}

function stopTypeLabel(type) {
  const labels = { Default: '默认', Item: '物品不足', Npc: 'NPC', Quest: '任务', Info: '信息', Mob: '怪物', Monster: '怪物' };
  return labels[type] || type;
}
