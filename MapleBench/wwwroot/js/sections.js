/**
 * The sectioned workspace: one list of day-to-day editors down the left, one
 * stage on the right, and the Explorer left exactly as it was beside it.
 *
 * This is a shell, not a fourth editor. Mobs, Cash Shop and Database are the
 * same instances the app has always held -- they are handed their stage as their
 * host at construction and shown from here, so there is one Mobs mode with one
 * selection and one dirty state, however you reach it.
 *
 * Skills, NPCs and Strings have no backend yet. They are listed, disabled, with
 * the archive they will need and a line saying what they will do. Hiding them
 * would make the shell look finished and leave the user guessing what is
 * planned; faking them would be worse (rule 12).
 */

import { api } from './api.js';
import { el, clear, toast, busyPanel, replayMotion } from './ui.js';
import { emptyState } from './inspector.js';
import { icon } from './icons.js';

const STORE_KEY = 'mb.section';
const NAV_STORE_KEY = 'mb.editorsNavCollapsed';

/**
 * The sections, in the order they are worth reaching for.
 *
 * `probe` answers "is this section's archive open?". Where a capabilities
 * endpoint answers that question it is used; where it does not, the note says
 * so rather than inventing an answer -- see cashShopReady().
 */
const SECTIONS = [
  {
    id: 'mobs',
    label: '怪物',
    icon: 'layers',
    archive: 'Mob.wz',
    blurb: '每个怪物的属性与标记,支持带预览的批量编辑。',
  },
  {
    id: 'items',
    label: '物品',
    icon: 'box',
    archive: 'Item',
    blurb: '物品信息与属性,支持多选批量设置字段。',
  },
  {
    id: 'equipment',
    label: '装备',
    icon: 'shield',
    archive: 'Character',
    blurb: '上衣、裤子、武器等装备属性与穿戴需求,支持多选批量设置字段。',
  },
  {
    id: 'cashshop',
    label: '商城',
    icon: 'cart',
    archive: 'Etc.wz',
    blurb: 'Commodity.img 列表:价格、序列号与在售商品。',
  },
  {
    id: 'database',
    label: '游戏数据搜索',
    icon: 'search',
    archive: 'String.wz',
    blurb: '搜索客户端命名的所有道具、怪物、技能、NPC 与地图。',
  },
  {
    id: 'skills',
    label: '技能',
    icon: 'star',
    archive: 'Skill.wz',
    blurb: '各级数值,编辑前会指出 common/ 公式陷阱。',
  },
  {
    id: 'npcs',
    label: 'NPC',
    icon: 'info',
    archive: 'Npc.wz',
    blurb: '商店库存、对话脚本与 NPC 所在的地图。',
  },
  {
    id: 'quests',
    label: '任务',
    icon: 'star',
    archive: 'Quest.wz',
    blurb: '任务信息、对话、奖励与条件,支持整任务编辑与保存。',
  },
  {
    id: 'strings',
    label: '字符串',
    icon: 'type',
    archive: 'String.wz',
    blurb: '编辑其他所有版块读取的名称,无需在树中翻找。',
  },
  {
    id: 'mapedit',
    label: '地图编辑器',
    icon: 'image',
    archive: 'Map002.wz',
    blurb: '打开地图,查看绘制效果 — 背景、图块、对象、覆盖层 — 进行小而安全的 ' +
           '编辑,并通过逐字节一致的往返模型保存。',
  },
];

const REAL = SECTIONS.filter((section) => !section.soon).map((section) => section.id);

export class Sections {
  constructor({ host, app }) {
    this.host = host;
    this.app = app;

    /**
     * One stage element per real section, handed to Mobs/CashShop/Database at
     * construction and shown one at a time.
     *
     * Not one shared element, for two reasons. Each mode rewrites its host's
     * className on every render, so the element cannot carry the shell's own
     * layout class. And each mode renders whenever its own load resolves --
     * switching away from Mobs while its list is still in the air would
     * otherwise have that list paint itself over whichever section you switched
     * to. One element each also means a section keeps its scroll position, its
     * selection and its search box when you come back to it.
     */
    this.stages = new Map(REAL.map((id) => [id, el('div', { class: 'stage-body' })]));

    this.listHost = el('nav', { class: 'sec-list', 'aria-label': '编辑器' });
    this.stageHost = el('div', { class: 'sec-main' }, ...this.stages.values());
    this.overview = el('div', { class: 'editors-empty' }, emptyState(
      'folderOpen', '打开客户端以使用编辑器',
      '编辑器将基于你打开的客户端中的存档提供。',
      el('button', { class: 'btn btn-primary', onclick: () => this.app.openFilePicker() },
        icon('folderOpen', { size: 15 }), '打开客户端')));
    this.stageHost.prepend(this.overview);
    this.entries = new Map();
    this.foldButton = null;
    this.listBuilt = false;
    this.navCollapsed = localStorage.getItem(NAV_STORE_KEY) === 'true';

    const remembered = localStorage.getItem(STORE_KEY);
    // Old builds could remember one of the removed specialist workflows.
    // Falling back keeps an upgrade from reopening a section that no longer
    // belongs to the public app.
    this.active = REAL.includes(remembered) ? remembered : REAL[0];

    /** id -> { state: 'unknown' | 'ready' | 'missing' | 'error', note } */
    this.status = new Map();
  }

  /**
   * Shows the workspace at a section, mounting it if it is not already there.
   *
   * Re-entering the same section deliberately re-opens it: coming back from the
   * Explorer after editing a mob should show the edit, and every section's
   * open() is the cheap path (the expensive parse is cached server-side against
   * the session generation).
   */
  async open(id) {
    const previous = this.active;
    let section = SECTIONS.find((s) => s.id === id) ?? SECTIONS.find((s) => s.id === this.active);

    // The list entry for an unbuilt section is a disabled button, so this is
    // only reachable by asking for one by name. It says why and falls back to
    // the section the user was in, rather than leaving the workspace on screen
    // with nothing mounted in it.
    if (section?.soon) {
      toast(`${section.label} 尚未构建完成 — ${section.blurb}`, 'info', { title: '即将推出' });
      section = SECTIONS.find((s) => s.id === this.active);
    }

    this.active = section?.id ?? REAL[0];
    localStorage.setItem(STORE_KEY, this.active);

    this.render({ animate: previous !== this.active });
    if (!this.app.files.length) return;
    // Capabilities are asked once per visit rather than per keystroke: they
    // change only when an archive is opened or closed.
    this.refreshStatus();
    await this.mount();
  }

  /** The element a section renders into; the App hands these out at construction. */
  stageFor(id) {
    return this.stages.get(id);
  }

  render({ animate = false } = {}) {
    // Explorer and Editors share this host, so it may have been repainted while
    // the stable section shell was detached. Reattach the same list, buttons,
    // chevron and stage elements; section-to-section navigation never rebuilds
    // them and therefore keeps focus, scroll, and CSS transition timelines.
    if (this.listHost.parentElement !== this.host || this.stageHost.parentElement !== this.host) {
      clear(this.host);
      this.host.append(this.listHost, this.stageHost);
    }
    this.host.className = 'stage-body sections';
    this.host.dataset.navCollapsed = this.navCollapsed ? 'true' : 'false';

    this.paintList();

    const empty = !this.app.files.length;
    this.stageHost.classList.toggle('editors-empty', empty);
    this.overview.hidden = !empty;
    for (const [id, stage] of this.stages) stage.hidden = empty || id !== this.active;
    if (animate && !empty) replayMotion(this.stages.get(this.active), 'section-enter');
  }

  paintList() {
    if (!this.listBuilt) {
      this.foldButton = el('button', {
        class: 'btn btn-icon btn-ghost sec-list-fold',
        'data-tip-placement': 'right',
        onclick: () => this.toggleNavigation(),
      }, icon('chevronRight', { size: 15 }));
      this.listHost.append(el('div', { class: 'sec-list-head' },
        el('div', { class: 'sec-list-title', text: '编辑器' }),
        this.foldButton));

      for (const section of SECTIONS) {
        const state = el('span', { class: 'sec-state' });
        const entry = el('button', {
          class: 'sec-item',
          'aria-label': section.label,
          'data-tip-placement': 'right',
          onclick: section.soon ? null : () => this.open(section.id),
        },
          el('span', { class: 'sec-glyph' }, icon(section.icon, { size: 16 })),
          el('span', { class: 'sec-body' },
            el('span', { class: 'sec-head' },
              el('span', { class: 'sec-label', text: section.label }),
              section.soon ? el('span', { class: 'sec-chip', text: '即将推出' }) : null,
              state)));
        this.entries.set(section.id, { entry, state });
        this.listHost.append(entry);
      }
      this.listBuilt = true;
    }

    const hasClient = this.app.files.length > 0;

    for (const section of SECTIONS) {
      const status = this.status.get(section.id) ?? { state: 'unknown' };

      // What this list is for, on the second visit and every visit after it, is
      // getting to a section in one glance. It used to spend three lines per
      // entry -- name, a sentence of prose, and a sentence about which archive
      // is open -- so six sections filled 700px and the blurb you had read on
      // day one was still there on day two hundred, between you and the name
      // you were aiming for. The blurb is now the tooltip: still discoverable,
      // no longer in the way.
      //
      // The archive note stays only when it is news. "String.wz open" under
      // every one of six ready sections is six lines saying nothing is wrong;
      // the green dot says that already, and when something IS wrong the
      // sentence is the only one in the list and impossible to miss.
      const ready = status.state === 'ready' && !section.soon;

      const refs = this.entries.get(section.id);
      const active = hasClient && section.id === this.active && !section.soon;
      refs.entry.dataset.active = active ? 'true' : 'false';
      refs.entry.setAttribute('aria-current', active ? 'true' : 'false');
      refs.entry.setAttribute('data-tip', [
        section.blurb,
        hasClient ? this.noteFor(section, status) : `需要 ${section.archive}`,
      ].filter(Boolean).join(' · '));
      refs.entry.disabled = !!section.soon;
      clear(refs.state);
      if (ready) refs.state.append(el('span', { class: 'sec-dot', 'data-state': 'ready' }));
      else if (status.state === 'error') refs.state.append(el('span', { class: 'sec-dot', 'data-state': 'error' }));
    }

    this.foldButton.setAttribute('aria-label', this.navCollapsed ? '展开编辑器导航' : '折叠编辑器导航');
    this.foldButton.setAttribute('aria-expanded', this.navCollapsed ? 'false' : 'true');
    this.foldButton.setAttribute('data-tip', this.navCollapsed ? '展开编辑器' : '折叠编辑器');
  }
  toggleNavigation() {
    this.navCollapsed = !this.navCollapsed;
    localStorage.setItem(NAV_STORE_KEY, this.navCollapsed ? 'true' : 'false');
    this.host.dataset.navCollapsed = this.navCollapsed ? 'true' : 'false';
    this.paintList();
  }

  /** The one line under a section saying which archive it needs and whether it is open. */
  noteFor(section, status) {
    if (section.soon) return `将需要 ${section.archive}`;
    switch (status.state) {
      case 'ready': return status.note ?? `${section.archive} 已打开`;
      case 'missing': return status.note ?? `需要 ${section.archive} — 未打开`;
      case 'error': return `无法检查 — ${status.note}`;
      default: return `需要 ${section.archive} — 正在检查…`;
    }
  }

  /**
   * Asks each real section whether it can work right now.
   *
   * Mobs and Database have a capabilities endpoint that answers exactly this.
   * The cash shop's reports its icon and name sources rather than whether
   * Commodity.img is open, so that one is answered by the same file test the
   * mode itself uses to decide it can open -- reading `icons: false` as "Etc.wz
   * is not open" would be a different question with a plausible wrong answer.
   */
  async refreshStatus() {
    const set = (id, state, note) => this.status.set(id, { state, note });

    const [mobs, database, skills, npcs, strings, mapedit, shop, quests, items, equipment] = await Promise.allSettled([
      api.mobCapabilities(),
      api.dbCapabilities(),
      api.skillCapabilities(),
      api.npcCapabilities(),
      api.stringCapabilities(),
      api.mapeditCapabilities(),
      api.shopCapabilities(),
      api.questCapabilities(),
      api.itemCapabilities(),
      api.equipCapabilities(),
    ]);

    if (mobs.status === 'fulfilled') {
      const named = this.openArchive(/^mob/i);
      set('mobs', mobs.value.available ? 'ready' : 'missing',
        mobs.value.available
          ? `${named} 已打开${mobs.value.names ? '' : ' · String.wz 未打开,怪物将没有名称'}`
          : undefined);
    } else {
      set('mobs', 'error', mobs.reason?.message ?? '无响应');
    }

    if (database.status === 'fulfilled') {
      set('database', database.value.available ? 'ready' : 'missing',
        database.value.available ? `${this.openArchive(/^string/i)} 已打开` : undefined);
    } else {
      set('database', 'error', database.reason?.message ?? '无响应');
    }

    // Each of these answers exactly "can this section work right now?", so the
    // note repeats the archive's real filename rather than the one the section
    // asks for -- a split String001.wz should not be reported as "String.wz".
    const capability = (id, settled, pattern, extra) => {
      if (settled.status !== 'fulfilled') {
        set(id, 'error', settled.reason?.message ?? '无响应');
        return;
      }
      const available = settled.value?.available === true;
      const source = id === 'mapedit' && settled.value?.mapArchives?.length
        ? (settled.value.mapArchives.length === 1
          ? settled.value.mapArchives[0]
          : `${settled.value.mapArchives.length} 个存档`)
        : this.openArchive(pattern);
      set(id, available ? 'ready' : 'missing',
        available ? `${source} 已打开${extra?.(settled.value) ?? ''}` : undefined);
    };

    capability('skills', skills, /^skill/i,
      // Skill names live in String.wz, so a skill list without it is numbers.
      (value) => (value.names ? '' : ' · String.wz 未打开,技能将没有名称'));
    capability('npcs', npcs, /^npc/i,
      (value) => (value.names ? '' : ' · String.wz 未打开,NPC 将没有名称'));
    capability('quests', quests, /^quest/i);
    capability('items', items, /^item/i,
      (value) => (value.names ? '' : ' · String.wz 未打开,物品将没有名称'));
    capability('equipment', equipment, /^character/i,
      (value) => (value.names ? '' : ' · String.wz 未打开,装备将没有名称'));
    capability('strings', strings, /^string/i);
    capability('mapedit', mapedit, /^map/i,
      // Map names live in String.wz; the map picker shows bare ids without it.
      (value) => (value.names ? '' : ' · String.wz 未打开,地图将没有名称'));

    if (shop.status === 'fulfilled') {
      this.cashShopSourceId = shop.value.source?.id ?? null;
      const source = this.cashShopFile();
      set('cashshop', source ? 'ready' : 'missing', source ? `${source.name} 已打开` : undefined);
    } else {
      this.cashShopSourceId = null;
      set('cashshop', 'error', shop.reason?.message ?? '无响应');
    }

    this.paintList();
  }

  /**
   * What to call the archive a section is reading.
   *
   * The real filename, not the family name: a split client opens String_000.wz
   * and a repack opens Mob001.wz, and "String.wz open" beside neither of them is
   * the kind of small lie that makes a user doubt the rest of the screen.
   */
  openArchive(pattern) {
    const matches = this.app.files.filter((file) => pattern.test(file.name));
    if (!matches.length) return '它';
    return matches.length === 1 ? matches[0].name : `${matches.length} 个存档`;
  }

  /** The archive Cash Shop mode would read, by the same test the mode uses. */
  cashShopFile() {
    return this.app.files.find((file) => file.id === this.cashShopSourceId) ?? null;
  }

  /* ============================================================
     MOUNTING
     ============================================================ */

  async mount() {
    if (this.active === 'mobs') {
      await this.app.mobs.open(this.app.mobs.fileId);
      return;
    }

    if (this.active === 'database') {
      await this.app.db.open();
      return;
    }

    // Each of these owns its own stage element, so a slow first build cannot
    // paint itself over whichever section the user switched to meanwhile.
    if (this.active === 'skills') {
      await this.app.skills.open();
      return;
    }

    if (this.active === 'npcs') {
      await this.app.npcs.open();
      return;
    }

    if (this.active === 'quests') {
      await this.app.quests.open();
      return;
    }

    if (this.active === 'items') {
      await this.app.items.open();
      return;
    }

    if (this.active === 'equipment') {
      await this.app.equip.open();
      return;
    }

    if (this.active === 'strings') {
      await this.app.strings.open();
      return;
    }

    if (this.active === 'mapedit') {
      const stage = this.stageFor('mapedit');
      if (!this.app.mapedit) {
        clear(stage);
        stage.className = 'stage-body';
        stage.setAttribute('aria-busy', 'true');
        stage.append(busyPanel({
          title: '正在打开地图编辑器',
          note: '正在准备画布与资源目录。',
          rows: 4,
        }));
      }
      try {
        const mapedit = await this.app.ensureMapEditor();
        stage.removeAttribute('aria-busy');
        await mapedit.open();
      } catch (error) {
        stage.removeAttribute('aria-busy');
        clear(stage);
        stage.className = 'stage-body';
        stage.append(emptyState(
          'alert', '地图编辑器加载失败',
          error?.message ?? '无法读取编辑器文件。',
          el('button', { class: 'btn btn-primary', onclick: () => this.open('mapedit') },
            icon('refresh', { size: 15 }), '重试')));
      }
      return;
    }

    if (this.active === 'cashshop') {
      const candidate = this.cashShopFile() ?? this.app.files[0];
      if (!candidate) {
        const stage = this.stageFor('cashshop');
        clear(stage);
        stage.className = 'stage-body';
        stage.append(emptyState(
          'cart', '请先打开 Etc.wz',
          '商城编辑需要从 Etc.wz 读取 Commodity.img。你也可以单独打开 Commodity.img。',
          el('button', { class: 'btn btn-primary', onclick: () => this.app.openFilePicker() },
            icon('folderOpen', { size: 15 }), '打开文件')));
        return;
      }
      await this.app.shop.open(candidate.id);
    }
  }

  /** Re-reads whatever is on screen after an edit somewhere else changed it. */
  reload() {
    if (this.active === 'mobs') return this.app.mobs.load();
    if (this.active === 'cashshop') return this.app.shop.load();
    if (this.active === 'database') return this.app.db.load();
    if (this.active === 'skills') return this.app.skills.refresh();
    if (this.active === 'npcs') return this.app.npcs.refresh();
    if (this.active === 'quests') return this.app.quests.refresh();
    if (this.active === 'items') return this.app.items.refresh();
    if (this.active === 'equipment') return this.app.equip.refresh();
    if (this.active === 'strings') return this.app.strings.refresh();
    // The map editor deliberately does NOT reload on outside edits: its
    // document is its own unsaved state, and re-fetching would not lose it but
    // would repaint mid-drag. Its own edits drive its own refreshes.
    return undefined;
  }

  /** Right-click actions for the section list itself. */
  menuItems() {
    return [
      ...REAL.map((id) => ({
        icon: SECTIONS.find((s) => s.id === id).icon,
        label: `打开 ${SECTIONS.find((s) => s.id === id).label}`,
        run: () => this.open(id),
      })),
      { icon: 'refresh', label: '检查哪些存档已打开', run: () => this.refreshStatus() },
    ];
  }
}

/** The section ids the palette and the shortcuts can address. */
export const SECTION_IDS = REAL;

/** Label lookup, for palette entries built outside this module. */
export const sectionLabel = (id) => SECTIONS.find((s) => s.id === id)?.label ?? id;
