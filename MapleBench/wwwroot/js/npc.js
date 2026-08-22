/**
 * NPCs section: a card grid over Npc.wz, plus a per-NPC field editor and a
 * previewed bulk edit.
 *
 * Built from the same parts as Mobs mode -- one class, guard() around every
 * mutation, a head / stats / toolbar / grid / pager stack, and honest empty
 * states -- because two sections that do the same kind of work should not feel
 * like two different applications.
 *
 * What makes NPCs different from mobs, and what most of the extra code below is
 * for, is that half of what a person means by "the NPC" is not in Npc.wz:
 *
 *  - The name and the job line under it live in String.wz/Npc.img/<id>.
 *  - `info/speak/<n>` holds a *key* ("n0"), not a sentence; the words are in
 *    String.wz too. The API joins them, and this shows the joined line -- a
 *    column of "n0" is what makes people conclude chat text is not editable.
 *  - `info/script` and `info/speak` are containers on 3,044 of the 3,057
 *    scripted NPCs in a v232 client. They get a count and a link into the
 *    Explorer, never an empty text box that looks editable.
 *
 * Every write goes through /api/npc/fields, which edits the same session the
 * Explorer edits, so NPC changes share one dirty state, one undo history and one
 * save pipeline.
 */

import { api } from './api.js';
import { el, clear, toast, toastError, fmt, modal, confirmDialog, debounce, runOnce,
         statChip, statRow } from './ui.js';
import { emptyState } from './inspector.js';
import { icon } from './icons.js';
import { thumbUrl, lazySprite } from './media.js';
import { openPortDialog } from './port.js';

const PAGE_SIZE = 60;

/**
 * The filters a private-server dev actually hunts with, with the counts they
 * match in a v232 client beside them: 317 shops, 3,058 scripted, 72 storage or
 * trunk, 336 linked, 298 with no name. "Undead"-style trivia is left out --
 * a filter nobody uses is a filter that hides the ones they do.
 */
const FILTERS = [
  ['all', '全部'],
  ['shops', '商店'],
  ['scripted', '脚本'],
  ['storage', '仓库'],
  ['linked', '链接'],
  ['nameless', '无名'],
];

const SORTS = [
  ['id', 'NPC ID'],
  ['name', '名称（A–Z）'],
  ['script', '脚本处理程序（A–Z）'],
  ['speak-desc', '对话行（多的在前）'],
];

const OPS = [
  ['set', '设置为'],
  ['add', '增加'],
  ['multiply', '乘以'],
  ['percent', '按百分比更改'],
];

const ROUNDING = [
  ['nearest', '四舍五入到最近的整数'],
  ['floor', '向下取整'],
  ['none', '保留小数'],
];

/**
 * Fields the bulk editor offers when it cannot read a real NPC to find out what
 * this Npc.wz actually carries. Chosen from a sweep of a v232 client rather than
 * guessed: these are the numeric keys that appear on enough NPCs for a bulk edit
 * to mean anything.
 */
const FALLBACK_BULK_FIELDS = [
  { key: 'hideName', label: '隐藏名称标签', kind: 'Flag' },
  { key: 'trunkPut', label: '仓库寄存费', kind: 'Int' },
  { key: 'trunkGet', label: '仓库取件费', kind: 'Int' },
  { key: 'speed', label: '移动速度', kind: 'Int' },
  { key: 'distanceForSelect', label: '点击距离', kind: 'Int' },
  { key: 'dcTop', label: '对话框顶部', kind: 'Int' },
];

/**
 * WZ property types that hold a whole number.
 *
 * Used instead of the field's catalog kind, because hideName, forceMove and the
 * dc* offsets each appear as BOTH Int and String in one v232 archive. Refusing
 * "yes" in a field that is genuinely a WzStringProperty -- because the catalog
 * calls the key an Int -- would block an edit the client accepts.
 */
const INTEGER_WZ_TYPES = new Set(['Int', 'Short', 'Long']);

/** Values a checkbox can round-trip without destroying what is in the node. */
const FLAGGABLE = new Set(['', '0', '1']);

export class NpcSection {
  constructor({ host, app }) {
    this.host = host;
    this.app = app;

    /** null means "every open Npc archive", which is what the API does with no fileId. */
    this.fileId = null;
    this.npcs = [];
    this.stats = null;
    this.truncated = false;
    this.capabilities = { available: false, names: false, canEditText: false };
    /** The failure that stopped the last load, so the section can say so instead of showing an empty grid. */
    this.error = null;

    /**
     * The first list costs 4.2s on a v232 Npc.wz (10,742 images) and 7-14ms
     * warm. A four-second blank panel reads as a hang, so the load says it is
     * working -- see buildLoading().
     */
    this.loading = false;

    this.query = '';
    this.filter = localStorage.getItem('mb.npcFilter') || 'all';
    if (!FILTERS.some(([value]) => value === this.filter)) this.filter = 'all';
    this.sort = localStorage.getItem('mb.npcSort') || 'id';
    if (!SORTS.some(([value]) => value === this.sort)) this.sort = 'id';
    this.page = 1;

    /** Session paths of the ticked cards; bulk edit acts on exactly this set. */
    this.selection = new Set();
  }

  /**
   * Runs a mutation at most once at a time, reporting anything it throws.
   *
   * Same rule as Mobs: every write is a POST behind a button that stays live
   * while it is in the air, and a bulk apply issued twice doubles a multiply.
   * The keys are namespaced because the in-flight set is shared with the rest of
   * the app.
   */
  async guard(key, run) {
    try {
      await runOnce(`npc:${key}`, run);
    } catch (error) {
      toastError(error);
    }
  }

  /** `fileId` is optional; the shell calls this with no arguments. */
  async open(fileId = this.fileId) {
    this.fileId = fileId ?? null;
    this.page = 1;
    this.render();          // paints whatever we already have while the load runs
    await this.load();
  }

  /** Re-reads the list after a save, an undo, or an edit made somewhere else. */
  async refresh() {
    // Before the first open() there is nothing on screen to correct, and the
    // list is the expensive call in this section -- paying 4.2s for a panel
    // nobody is looking at is worse than doing nothing.
    if (!this.opened) return;
    await this.load();
  }

  async load() {
    this.error = null;
    this.loading = true;
    this.opened = true;
    this.render();

    // Capabilities first and on its own: it is the one call that distinguishes
    // "no Npc.wz is open" from "the backend is not answering", and those two
    // deserve completely different screens.
    try {
      this.capabilities = await api.npcCapabilities();
    } catch (error) {
      this.capabilities = { available: false, names: false, canEditText: false };
      this.error = error;
      this.loading = false;
      this.render();
      return;
    }

    if (!this.capabilities.available) {
      this.npcs = [];
      this.stats = null;
      this.selection.clear();
      this.loading = false;
      this.render();
      return;
    }

    try {
      const data = await api.npcList(this.fileId, this.capabilities.names);
      this.npcs = data.npcs || [];
      this.stats = data.stats || null;
      this.truncated = Boolean(data.truncated);
      this.namesAvailable = Boolean(data.namesAvailable);
      // A reload can drop NPCs the selection still points at -- scoping to one
      // archive is the common way. Bulk-editing paths that are no longer listed
      // would act on things the user can no longer see.
      this.selection = new Set([...this.selection].filter((path) => this.npcs.some((n) => n.path === path)));
    } catch (error) {
      this.error = error;
      this.npcs = [];
      this.stats = null;
    }
    this.loading = false;
    this.render();
  }

  /* ============================================================
     FILTERING
     ============================================================ */

  matches(npc, filter) {
    switch (filter) {
      case 'shops': return Boolean(npc.isShop);
      case 'scripted': return Boolean(npc.hasScript);
      case 'storage': return Boolean(npc.isStorage || npc.isTrunk);
      case 'linked': return Boolean(npc.linkTarget);
      // Only meaningful when String.wz is open; countFor reports it as unknown
      // otherwise rather than claiming every NPC is nameless.
      case 'nameless': return this.capabilities.names && !npc.name;
      default: return true;
    }
  }

  get filtered() {
    const needle = this.query.trim().toLowerCase();
    const rows = this.npcs.filter((npc) => {
      if (!this.matches(npc, this.filter)) return false;
      if (!needle) return true;
      // The script handler as well as the name: "Show me every NPC running
      // cygnusJobAdvancement" is the search this section exists to answer.
      return String(npc.npcId).includes(needle)
          || (npc.name || '').toLowerCase().includes(needle)
          || (npc.func || '').toLowerCase().includes(needle)
          || (npc.script || '').toLowerCase().includes(needle);
    });
    return this.order(rows);
  }

  order(rows) {
    const sorted = [...rows];
    switch (this.sort) {
      case 'name':
        // NPCs without a name string sort last rather than clumping at the top
        // under an empty label, which reads as a bug.
        sorted.sort((a, b) => {
          if (!a.name && !b.name) return a.npcId - b.npcId;
          if (!a.name) return 1;
          if (!b.name) return -1;
          return a.name.localeCompare(b.name) || a.npcId - b.npcId;
        });
        break;
      case 'script':
        sorted.sort((a, b) => {
          if (!a.script && !b.script) return a.npcId - b.npcId;
          if (!a.script) return 1;
          if (!b.script) return -1;
          return a.script.localeCompare(b.script) || a.npcId - b.npcId;
        });
        break;
      case 'speak-desc':
        sorted.sort((a, b) => (b.speakLines ?? -1) - (a.speakLines ?? -1) || a.npcId - b.npcId);
        break;
      default:
        sorted.sort((a, b) => a.npcId - b.npcId);
        break;
    }
    return sorted;
  }

  /* ============================================================
     RENDER
     ============================================================ */

  render() {
    clear(this.host);
    this.host.className = 'stage-body npcs';

    if (this.error) {
      this.host.append(emptyState(
        'alert', '无法读取 NPC 列表',
        this.error.message,
        el('div', { class: 'npc-empty-actions' },
          el('button', { class: 'btn btn-primary', onclick: () => this.load() },
            icon('refresh', { size: 15 }), '重试'),
          el('button', { class: 'btn', onclick: () => this.app.openFilePicker() },
            icon('folderOpen', { size: 15 }), '打开文件'))));
      return;
    }

    // Before the first answer we do not know whether Npc.wz is open, so the
    // "open Npc.wz" screen would be a guess. The loading panel is the honest
    // thing to show until capabilities have replied.
    if (this.loading && !this.npcs.length) {
      this.host.append(this.buildLoading());
      return;
    }

    if (!this.capabilities.available) {
      this.host.append(emptyState(
        'info', '未打开 Npc.wz',
        'NPC 编辑读取 Npc.wz，并使用 String.wz 获取名称和对话文本。打开客户端文件夹即可同时启用两者。',
        el('button', { class: 'btn btn-primary', onclick: () => this.app.openFilePicker() },
          icon('folderOpen', { size: 15 }), '打开客户端')));
      return;
    }

    this.resultHost = el('div');

    // Filtered, because this is Element.append rather than el(): append(null)
    // does not skip the child, it puts the word "null" on the page -- and
    // statRow returns null when there is not a single count worth a box.
    this.host.append(...[
      this.buildHead(),
      this.buildStats(),
      this.buildToolbar(),
      this.resultHost,
    ].filter(Boolean));

    this.renderResults();
  }

  /**
   * The first-load screen.
   *
   * The measured number is in the sentence on purpose: "about four seconds" is
   * a wait, and an unexplained four-second blank is a bug report.
   */
  buildLoading() {
    const rows = el('div', { class: 'npc-skeleton' });
    for (let i = 0; i < 8; i++) {
      rows.append(el('div', { class: 'skeleton skeleton-row', style: `width:${45 + ((i * 37) % 40)}%` }));
    }

    return el('div', { class: 'npc-panel npc-loading' },
      el('div', { class: 'busy-bar' }),
      el('div', { class: 'npc-loading-text' },
        el('b', { text: '正在读取 NPC…' }),
        el('span', {
          text: ' 完整的 Npc.wz 含 10,742 张图像，首次加载约需四秒。此后在数据变化前都会即时显示。',
        })),
      rows);
  }

  /**
   * Names the archive being edited.
   *
   * The list endpoint happily spans every open Npc*.wz, so without this the
   * header would be a page of numbers with no clue which file they will be
   * written back into.
   */
  buildHead() {
    const candidates = this.app.files.filter((file) => /^npc/i.test(file.name));
    const scoped = this.fileId ? this.app.files.find((f) => f.id === this.fileId) : null;

    const subject = scoped
      ? scoped.name
      : candidates.length === 1
        ? candidates[0].name
        : candidates.length > 1
          ? `${candidates.length} 个 Npc 存档`
          : '每个已打开的存档';

    const head = el('div', { class: 'npc-panel npc-head' },
      el('div', { class: 'npc-head-text' },
        el('div', { class: 'npc-head-title', text: 'NPC' }),
        el('div', { class: 'npc-head-sub' },
          el('span', { text: '正在编辑 ' }),
          el('b', { text: subject }),
          el('span', {
            text: this.stats
              ? ` · ${fmt.format(this.stats.total)} 个 NPC`
              : '',
          }))));

    // The picker only earns its place when there is a real choice to make.
    if (candidates.length > 1) {
      const select = el('select', { class: 'npc-select', 'aria-label': '要编辑的存档' },
        el('option', { value: '', text: `全部 Npc 存档（${candidates.length}）`, selected: !this.fileId }),
        candidates.map((file) => el('option', { value: file.id, text: file.name, selected: file.id === this.fileId })));
      select.addEventListener('change', () => {
        this.selection.clear();
        this.open(select.value || null);
      });
      head.append(select);
    }

    head.append(el('button', {
      class: 'btn btn-icon', 'data-tip': '重新加载 NPC 列表',
      onclick: () => this.load(),
    }, icon('refresh', { size: 15 })));

    return head;
  }

  /**
   * Six counts, of which only the ones that happened are shown.
   *
   * statChip drops a zero rather than printing it: "Storage 0" and "Linked 0"
   * are two labelled boxes saying nothing happened, and they sit in the same
   * row as the numbers that did -- so the eye pays for six boxes to read two.
   * A null still shows an em dash, because "not read yet" and "none" are
   * different answers and the second one must not be invented.
   */
  buildStats() {
    const s = this.stats || {};

    // Not 0: without String.wz nothing here is named, and a "0" in that box
    // says the archive has no names in it, which is a different claim.
    const named = !this.capabilities.names ? null
      : s.total ? `${fmt.format(s.named)} · ${Math.round((s.named / s.total) * 100)}%`
      : 0;

    return statRow('npc-stats', [
      // The total is the one count worth a box even at zero: an archive that
      // really holds no NPCs is the answer, not the absence of one.
      statChip('NPC 总数', s.total ?? null, { drop: false }),
      statChip('有名称', named, { tone: this.capabilities.names ? undefined : 'muted' }),
      statChip('脚本', s.scripted ?? null, { tone: 'purple' }),
      statChip('商店', s.shops ?? null, { tone: 'green' }),
      statChip('仓库', s.storages ?? null),
      statChip('链接', s.linked ?? null, { tone: 'amber' }),
    ]);
  }

  buildToolbar() {
    const search = el('input', {
      type: 'search', value: this.query,
      placeholder: '按 NPC ID、名称、职业行或脚本搜索…',
      'aria-label': '搜索 NPC',
    });
    // Only the results are re-rendered, never the toolbar holding this input:
    // rebuilding it destroys the caret and drops IME composition mid-word.
    search.addEventListener('input', debounce(() => {
      this.query = search.value;
      this.page = 1;
      this.renderResults();
    }, 160));

    const chips = el('div', { class: 'cat-tabs' },
      FILTERS.map(([value, label]) => el('button', {
        class: 'cat-tab', 'aria-pressed': this.filter === value ? 'true' : 'false',
        onclick: () => {
          this.filter = value;
          localStorage.setItem('mb.npcFilter', value);
          this.page = 1;
          this.render();
        },
      }, label, el('span', { class: 'cat-count', text: this.countFor(value) }))));

    const sort = el('select', { class: 'npc-select', 'aria-label': '排序 NPC' },
      SORTS.map(([value, label]) => el('option', { value, text: label, selected: value === this.sort })));
    sort.addEventListener('change', () => {
      this.sort = sort.value;
      localStorage.setItem('mb.npcSort', sort.value);
      this.page = 1;
      this.renderResults();
    });

    return el('div', { class: 'npc-panel' },
      el('div', { class: 'npc-toolbar' },
        el('div', { class: 'npc-search' }, el('span', { class: 'icon' }, icon('search', { size: 15 })), search),
        chips,
        sort),
      this.buildSelectionBar(),
      this.capabilities.names ? null : el('div', { class: 'npc-note' }, icon('info', { size: 14 }),
        el('span', { text: 'String.wz 未打开，因此 NPC 没有名称、职业行和对话文本。' +
                           '打开后每张卡片都会自动补全。' })),
      this.truncated
        ? el('div', { class: 'npc-note' }, icon('alert', { size: 14 }),
            el('span', { text: '存档中的 NPC 数量超过单次列表返回的上限，因此这是部分列表。' +
                               '限定到单个存档或使用搜索，以确保看到全部内容。' }))
        : null);
  }

  /** The count beside a filter chip, or "—" where the answer is not knowable yet. */
  countFor(filter) {
    if (filter === 'nameless' && !this.capabilities.names) return '—';
    if (filter === 'all') return fmt.format(this.npcs.length);
    return fmt.format(this.npcs.filter((npc) => this.matches(npc, filter)).length);
  }

  buildSelectionBar() {
    const shown = this.filtered;
    const count = this.selection.size;

    return el('div', { class: 'npc-selbar', 'data-active': count ? 'true' : 'false' },
      el('span', { class: 'npc-selcount', text: count ? `已选择 ${fmt.format(count)} 个` : '未选择任何内容' }),
      el('button', {
        class: 'btn btn-sm', disabled: !shown.length,
        onclick: () => {
          for (const npc of shown) this.selection.add(npc.path);
          this.render();
        },
      }, icon('check', { size: 14 }), `全选 ${fmt.format(shown.length)} 个`),
      el('button', {
        class: 'btn btn-sm', disabled: !count,
        onclick: () => { this.selection.clear(); this.render(); },
      }, icon('close', { size: 14 }), '清除'),
      // The same port dialog Mobs mode opens, given a different kind. Nothing
      // about it is mob-specific -- an NPC is Npc.wz/<id>.img plus
      // String.wz/Npc.img/<id> plus Sound.wz/Npc.img/<id>, which is the same
      // sentence with three different nouns, and PortService's kind catalog is
      // where that sentence lives.
      el('button', {
        class: 'btn btn-sm', disabled: !count,
        'data-tip': '将这些 NPC 连同名称、声音和关联图像复制到另一个已打开的客户端',
        onclick: () => this.openPortDialog(),
      }, icon('externalLink', { size: 14 }), count ? `迁移 ${fmt.format(count)} 个` : '迁移'),
      el('button', {
        class: 'btn btn-sm btn-primary', disabled: !count,
        onclick: () => this.openBulkDialog(),
      }, icon('sliders', { size: 14 }), count ? `批量编辑 ${fmt.format(count)} 个` : '批量编辑'));
  }

  /** Redraws only the result panel, leaving the search box untouched. */
  renderResults() {
    if (!this.resultHost) { this.render(); return; }
    // The portraits the outgoing page still has queued belong to nobody now.
    // One scope per repaint; see lazySprite in media.js.
    this.sprites?.abort();
    this.sprites = new AbortController();
    clear(this.resultHost);

    const results = this.filtered;
    const pages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
    this.page = Math.min(this.page, pages);
    const slice = results.slice((this.page - 1) * PAGE_SIZE, this.page * PAGE_SIZE);

    const label = FILTERS.find(([value]) => value === this.filter)?.[1];

    const panel = el('div', { class: 'npc-panel' });
    panel.append(el('div', { class: 'npc-result-head' },
      el('span', { text: `${fmt.format(results.length)} 个 NPC` +
                         (this.filter === 'all' ? '' : ` · ${label.toLowerCase()}`) }),
      el('span', { text: `第 ${this.page} 页，共 ${pages} 页` })));

    if (!this.npcs.length) {
      // The archive is open and readable and holds nothing -- a different fact
      // from "your filter hid everything", and it needs a different sentence.
      panel.append(emptyState(
        'info', '此存档中没有 NPC',
        '存档已打开，但其中没有类似 NPC 图像（9000000.img）命名的内容。' +
        '如果您限定到了某个文件，请尝试其他文件。',
        el('button', { class: 'btn', onclick: () => this.load() }, icon('refresh', { size: 15 }), '重新加载')));
    } else if (!results.length) {
      panel.append(emptyState(
        'search',
        this.query ? `没有匹配“${this.query}”的 NPC` : '此筛选下没有内容',
        this.query
          ? (this.capabilities.names
              ? '试试类似 9000000 的 NPC ID、名称的一部分或脚本处理程序。'
              : 'String.wz 未打开，因此此处 NPC 没有名称 — 请改用 ID 或脚本搜索。')
          : '此存档中的所有 NPC 都被筛选掉了。请切回“全部”。',
        this.query
          ? el('button', { class: 'btn', text: '清除搜索', onclick: () => { this.query = ''; this.render(); } })
          : el('button', { class: 'btn', text: '显示全部 NPC', onclick: () => { this.filter = 'all'; this.render(); } })));
    } else {
      const grid = el('div', { class: 'npc-grid' });
      for (const npc of slice) grid.append(this.buildCard(npc));
      panel.append(grid);
      if (pages > 1) panel.append(this.buildPager(pages));
    }

    this.resultHost.append(panel);
  }

  buildCard(npc) {
    const selected = this.selection.has(npc.path);
    const card = el('div', {
      class: 'npc-card', 'data-path': npc.path, 'data-npc-id': npc.npcId,
      'data-selected': selected ? 'true' : 'false',
    });

    const box = el('input', {
      type: 'checkbox', checked: selected,
      'aria-label': `选择 ${npc.name || `NPC ${npc.npcId}`}`,
    });
    box.addEventListener('change', () => {
      if (box.checked) this.selection.add(npc.path); else this.selection.delete(npc.path);
      card.dataset.selected = box.checked ? 'true' : 'false';
      // Only the counter and the bulk button change, so the grid is left alone
      // -- repainting it here would throw away the checkbox that was clicked.
      this.refreshSelectionBar();
    });

    const badges = el('div', { class: 'npc-badges' },
      npc.isShop ? el('span', { class: 'npc-badge', 'data-kind': 'shop', text: '商店' }) : null,
      npc.isStorage ? el('span', { class: 'npc-badge', 'data-kind': 'storage', text: '仓库' }) : null,
      npc.isTrunk ? el('span', { class: 'npc-badge', 'data-kind': 'storage', text: '储物箱' }) : null,
      npc.hasScript ? el('span', { class: 'npc-badge', 'data-kind': 'script', text: '脚本' }) : null,
      npc.hideName ? el('span', { class: 'npc-badge', 'data-kind': 'hidden', text: '隐藏名称' }) : null,
      npc.linkTarget ? el('span', { class: 'npc-badge', 'data-kind': 'link', text: '链接' }) : null,
      // Only claimable when String.wz is open; otherwise nothing has a name and
      // the badge would be on all 10,742 cards.
      this.capabilities.names && !npc.name
        ? el('span', { class: 'npc-badge', 'data-kind': 'nameless', text: '无名' })
        : null,
      npc.dirty ? el('span', { class: 'npc-badge', 'data-kind': 'dirty', text: '未保存' }) : null);

    const stat = (key, value, tone) => el('div', { class: 'npc-row' },
      el('span', { class: 'k', text: key }),
      el('span', { class: 'v', 'data-tone': tone, text: value }));

    // Filtered, because this is Element.append rather than el(): append(null)
    // does not skip the child, it stringifies it and puts the word "null" on
    // the card.
    card.append(...[
      el('div', { class: 'npc-card-head' },
        el('label', { class: 'npc-pick' }, box),
        this.buildPortrait(npc),
        el('div', { class: 'npc-card-title' },
          el('button', {
            class: 'npc-title', text: npc.name || `NPC ${npc.npcId}`,
            'data-tip': '打开此 NPC', onclick: () => this.openNpcCard(npc),
          }),
          el('div', { class: 'npc-sub', text: `ID ${npc.npcId}` }),
          // The job line, which is what tells a Henesys shopkeeper from a
          // Henesys guide when both are called "Ms. Tan".
          npc.func ? el('div', { class: 'npc-func', text: npc.func }) : null)),
      badges.childElementCount ? badges : null,
      // "—" rather than "none": an NPC with no script node has no handler, and
      // a grid of zeros and empties reads as data that failed to load.
      stat('脚本', npc.script || (npc.hasScript ? '位于组中' : '—')),
      stat('对话行', npc.speakLines == null ? '—' : fmt.format(npc.speakLines)),
      npc.linkTarget ? stat('链接到', npc.linkTarget, 'amber') : null,
      el('div', { class: 'npc-actions' },
        el('button', { class: 'btn btn-sm', style: 'flex:1', onclick: () => this.openNpcCard(npc) },
          icon('edit', { size: 14 }), '编辑字段'),
        el('button', {
          class: 'btn btn-sm btn-icon', 'data-tip': '更多',
          onclick: (event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            this.app.showMenu(this.menuItemsFor(npc), rect.left, rect.bottom + 4);
          },
        }, icon('more', { size: 15 }))),
    ].filter(Boolean));

    return card;
  }

  /**
   * The NPC's own sprite (rule 11).
   *
   * Asked for at the image root rather than at a guessed `stand/0`: the frame
   * an NPC idles on is not consistently named, and /api/thumb already sweeps
   * down to the first canvas underneath whatever it is given and follows
   * _inlink/_outlink. Measured at 838 B in 5ms for 9400194.img.
   *
   * A sprite-less NPC answers 204, which fires `error` on the <img> -- so the
   * glyph underneath is what stays on screen, and a missing sprite never shows
   * a broken-image icon.
   */
  buildPortrait(npc, size = 'sm', scoped = true) {
    const frame = el('div', { class: 'npc-portrait', 'data-size': size },
      el('span', { class: 'npc-portrait-glyph' }, icon('info', { size: size === 'lg' ? 22 : 16 })));

    // Both listeners before the src is ever assigned, which is what going
    // through the loader guarantees: a cached sprite fires `load` synchronously
    // from the assignment, so a listener attached afterwards never runs and the
    // glyph sits over an image that did arrive.
    const img = el('img', { alt: '', decoding: 'async' });
    img.addEventListener('load', () => { frame.dataset.loaded = 'true'; });
    img.addEventListener('error', () => img.remove());
    frame.append(img);
    // 10,742 rows, one /api/thumb each, all queued on the session's single
    // gate: through the shared loader only what is on screen is asked for, a
    // few at a time, and paging away cancels the rest. thumbUrl carries the
    // revision stamp that keeps an hour-long cache from serving a sprite the
    // user has since replaced.
    // The detail head is unscoped: it is one portrait, inside a dialog that
    // repaints on its own schedule, and cancelling it because the grid behind
    // the dialog repainted would blank it.
    lazySprite(img, thumbUrl(npc.path), { signal: scoped ? this.sprites?.signal : undefined });

    return frame;
  }

  /** Shared by the card overflow and the app-wide right-click menu. */
  menuItemsFor(npc) {
    return [
      { icon: 'edit', label: '编辑字段…', run: () => this.openNpcCard(npc) },
      { icon: 'copy', label: `复制 NPC ID ${npc.npcId}`, run: () => this.app.copyText(String(npc.npcId)) },
      npc.script
        ? { icon: 'copy', label: `复制脚本名称 ${npc.script}`, run: () => this.app.copyText(npc.script) }
        : null,
      npc.linkTarget
        ? { icon: 'externalLink', label: `打开链接的 NPC ${npc.linkTarget}`, run: () => this.openLinked(npc.linkTarget) }
        : null,
      { icon: 'externalLink', label: '在资源管理器中显示', run: () => this.showInExplorer(npc.path) },
    ].filter(Boolean);
  }

  showInExplorer(path) {
    this.app.setMode('explorer');
    this.app.navigate(path);
  }

  /** Repaints the selection bar in place; see buildCard for why not the grid. */
  refreshSelectionBar() {
    const current = this.host.querySelector('.npc-selbar');
    if (current) current.replaceWith(this.buildSelectionBar());
  }

  buildPager(pages) {
    const pager = el('div', { class: 'pager' });
    // Only the rows change when paging, so the toolbar and its search box are
    // left alone.
    const go = (page) => { this.page = page; this.renderResults(); this.host.scrollTo({ top: 0 }); };

    pager.append(el('button', { text: '‹ 上一页', disabled: this.page === 1, onclick: () => go(this.page - 1) }));

    const numbers = new Set([1, pages, this.page, this.page - 1, this.page + 1]);
    let previous = 0;
    for (const page of [...numbers].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b)) {
      if (page - previous > 1) pager.append(el('span', { text: '…', style: 'color:var(--text-3)' }));
      pager.append(el('button', {
        text: String(page), 'aria-current': page === this.page ? 'true' : 'false', onclick: () => go(page),
      }));
      previous = page;
    }

    pager.append(el('button', { text: '下一页 ›', disabled: this.page === pages, onclick: () => go(this.page + 1) }));
    return pager;
  }

  /** Jumps to the NPC a link points at, if it is in the open archives. */
  openLinked(linkTarget) {
    const target = this.npcs.find((n) => n.path.endsWith(`/${linkTarget}.img`))
      ?? this.npcs.find((n) => n.path.endsWith(`/${linkTarget}`))
      ?? this.npcs.find((n) => n.npcId === Number(linkTarget));
    if (!target) {
      toast(`NPC ${linkTarget} 不在您已打开的存档中，因此无法在此打开。`, 'warning');
      return;
    }
    this.openNpcCard(target);
  }

  /* ============================================================
     NPC CARD
     ============================================================ */

  // Guarded because the detail is fetched *before* modal() runs: two fast
  // clicks would otherwise race, and the second card's commit closures would
  // point at a form the first one had already replaced.
  openNpcCard(npc) {
    return this.guard(`card:${npc.path}`, () => this.buildNpcCard(npc));
  }

  async buildNpcCard(npc) {
    let detail;
    try {
      detail = await api.npcDetail(npc.path);
    } catch (error) {
      toastError(error, '无法读取该 NPC');
      return;
    }

    /**
     * `baseline` is what each field held when this card was opened, which is
     * what "(was X)" reports. It is deliberately not the on-disk value: the
     * server does not send one, and inventing it would put a number beside the
     * field that no one can verify.
     */
    const ctx = {
      npc,
      detail,
      baseline: new Map(),
      search: '',
      modifiedOnly: false,
      showAbsent: false,
      closed: new Set(),
      touched: false,
      focusKey: null,
    };
    for (const group of detail.groups || []) {
      for (const field of group.fields || []) ctx.baseline.set(field.key, field.value ?? '');
    }

    // The head and the warning strips are repainted with the sections: editing
    // `link` changes whether the link warning applies at all, and editing a
    // field changes the unsaved pill in the header.
    const headHost = el('div', { class: 'npc-detail-topline' });
    const sectionsHost = el('div', { class: 'npc-sections' });
    const counter = el('span', { class: 'npc-modcount' });

    /* --- the parts that must survive a repaint --- */
    const search = el('input', {
      type: 'search', placeholder: '按名称查找字段…', 'aria-label': '查找字段',
    });
    search.addEventListener('input', debounce(() => {
      ctx.search = search.value;
      paint();
    }, 120));

    const modifiedToggle = el('button', {
      class: 'btn btn-sm', 'aria-pressed': 'false',
      onclick: () => {
        ctx.modifiedOnly = !ctx.modifiedOnly;
        modifiedToggle.setAttribute('aria-pressed', ctx.modifiedOnly ? 'true' : 'false');
        paint();
      },
    }, icon('filter', { size: 14 }), '仅显示已修改');

    const absentToggle = el('button', {
      class: 'btn btn-sm', 'aria-pressed': 'false',
      'data-tip': '此 NPC 没有的字段。写入一个即可创建。',
      onclick: () => {
        ctx.showAbsent = !ctx.showAbsent;
        absentToggle.setAttribute('aria-pressed', ctx.showAbsent ? 'true' : 'false');
        paint();
      },
    }, icon('plus', { size: 14 }), '显示缺失字段');

    const paint = () => {
      clear(headHost);
      headHost.append(this.buildDetailHead(ctx));
      for (const strip of this.buildWarnings(ctx)) headHost.append(strip);

      clear(sectionsHost);

      let shown = 0;
      let modified = 0;
      for (const group of ctx.detail.groups || []) {
        const section = this.buildSection(ctx, group, commit);
        modified += section.modified;
        if (!section.node) continue;
        shown += section.shown;
        sectionsHost.append(section.node);
      }

      // The two things that are not fields, after the fields: a script binding
      // and a chat line are both groups of values, and the only way to show
      // them honestly is on their own terms.
      const scripts = this.buildScriptSection(ctx);
      if (scripts) { sectionsHost.append(scripts); shown++; }
      const speak = this.buildSpeakSection(ctx);
      if (speak) { sectionsHost.append(speak); shown++; }

      if (!shown) {
        sectionsHost.append(emptyState(
          'search',
          ctx.search ? `没有匹配“${ctx.search}”的字段` : '没有可显示的内容',
          ctx.modifiedOnly
            ? '此 NPC 上还没有任何修改。请关闭“仅显示已修改”。'
            : '搜索同时匹配字段标签和原始 WZ 键。' +
              '大多数 NPC 只有少量字段 — 试试“显示缺失字段”。'));
      }

      counter.textContent = modified
        ? `${modified} 个字段已在本会话中修改`
        : '';
      counter.dataset.active = modified ? 'true' : 'false';

      // A commit repaints the whole body, which would otherwise pull the caret
      // out of the field the user pressed Enter in.
      if (ctx.focusKey) {
        const back = sectionsHost.querySelector(`[data-field-key="${CSS.escape(ctx.focusKey)}"] input`);
        ctx.focusKey = null;
        if (back && back.type !== 'checkbox') { back.focus(); back.select?.(); }
      }
    };

    const commit = (field, value, revert) => this.commitField(ctx, field, value, revert, paint);

    const body = el('div', { class: 'npc-detail' },
      headHost,
      el('div', { class: 'npc-detail-tools' },
        el('div', { class: 'npc-search' }, el('span', { class: 'icon' }, icon('search', { size: 15 })), search),
        modifiedToggle,
        absentToggle,
        counter),
      sectionsHost);

    paint();

    const { dialog, close } = modal({
      title: ctx.detail.name || ctx.npc.name || `NPC ${ctx.npc.npcId}`,
      subtitle: ctx.npc.path.split('/').slice(1).join('/'),
      width: 'min(96vw, 880px)',
      body,
      actions: [{ label: '完成' }],
    });
    // Handed to the head and the warning strips, both of which are painted
    // before the dialog that owns them exists.
    ctx.close = close;

    // Committed fields change what the card behind this dialog says, and the
    // list is the only thing that knows it. Reloading once on close beats a
    // reload per keystroke.
    dialog.addEventListener('close', () => { if (ctx.touched) this.load(); }, { once: true });
  }

  buildDetailHead(ctx) {
    const detail = ctx.detail;
    const name = detail.name || ctx.npc.name;

    return el('div', { class: 'npc-detail-head' },
      // Rebuilt on every paint along with the rest of the head, which is cheap:
      // the browser has the sprite cached from the card behind this dialog.
      this.buildPortrait(detail, 'lg', false),
      el('div', { class: 'npc-detail-id' },
        el('div', { class: 'npc-detail-name', text: name || `NPC ${detail.npcId}` }),
        el('div', { class: 'npc-sub', text: `ID ${detail.npcId}` }),
        detail.func ? el('div', { class: 'npc-func', text: detail.func }) : null),
      detail.dirty ? el('span', { class: 'npc-badge', 'data-kind': 'dirty', text: '未保存' }) : null,
      el('span', { style: 'margin-left:auto' }),
      // The String.wz entry is a second archive and a second place to edit, so
      // it gets its own way in rather than being buried in a warning.
      detail.stringPath
        ? el('button', {
            class: 'btn btn-sm', 'data-tip': '名称、职业行和对话文本都保存在这里',
            onclick: () => { ctx.close?.(); this.showInExplorer(detail.stringPath); },
          }, icon('type', { size: 14 }), '打开 String.wz 条目')
        : null,
      el('button', {
        class: 'btn btn-sm', 'data-tip': '在资源管理器中打开此 .img',
        // Closing first: leaving the card sitting over the Explorer hides the
        // node it just navigated to, which reads as the button doing nothing.
        onclick: () => { ctx.close?.(); this.showInExplorer(detail.path); },
      }, icon('externalLink', { size: 14 }), '在资源管理器中显示'));
  }

  /**
   * The traps, before they are sprung (rule 6).
   *
   * The server decides what is worth saying -- it is the side that can see both
   * archives -- and this only decides how loud each one is and whether it comes
   * with a way out. A link warning gets a button to the real image; the
   * "appears blank in game" warning is the bug-finder this section exists for,
   * so it gets a button into String.wz rather than a shrug.
   */
  buildWarnings(ctx) {
    const detail = ctx.detail;
    return (detail.warnings || []).map((text) => {
      const strip = el('div', { class: 'npc-warn' },
        icon('alert', { size: 16 }),
        el('div', { class: 'npc-warn-text', text }));

      if (detail.linkTarget && text.includes(detail.linkTarget)) {
        strip.append(el('button', {
          class: 'btn btn-sm',
          // One NPC card at a time: stacking the target over the NPC that links
          // to it makes it very easy to lose track of which one you are editing.
          onclick: () => { ctx.close?.(); this.openLinked(detail.linkTarget); },
        }, icon('externalLink', { size: 14 }), `打开 ${detail.linkTarget}`));
      } else if (text.includes('blank in game') && detail.stringPath) {
        strip.append(el('button', {
          class: 'btn btn-sm',
          onclick: () => { ctx.close?.(); this.showInExplorer(detail.stringPath); },
        }, icon('type', { size: 14 }), '打开 String.wz 条目'));
      }

      return strip;
    });
  }

  /**
   * One collapsible section per API group.
   *
   * Returns the node plus its counts: `modified` is counted over the whole
   * group so the total in the header stays honest while a filter is on, and
   * `shown` is what survived the filters.
   */
  buildSection(ctx, group, commit) {
    const fields = group.fields || [];
    const modified = fields.filter((f) => this.isChanged(ctx, f)).length;

    const visible = fields.filter((field) => {
      if (!field.present && !ctx.showAbsent) return false;
      if (ctx.modifiedOnly && !this.isChanged(ctx, field)) return false;
      return this.fieldMatches(ctx, field.label, field.key);
    });

    if (!visible.length) return { node: null, shown: 0, modified };

    const open = !ctx.closed.has(group.group);
    const details = el('details', { class: 'npc-section', open });
    details.addEventListener('toggle', () => {
      if (details.open) ctx.closed.delete(group.group);
      else ctx.closed.add(group.group);
    });

    details.append(el('summary', {},
      el('span', { class: 'npc-section-name', text: group.group }),
      el('span', { class: 'npc-section-meta',
        text: `${visible.length} 个字段` +
              (visible.length !== fields.length ? `，共 ${fields.length} 个` : '') }),
      modified
        ? el('span', { class: 'npc-section-mod', text: `${modified} 项已修改` })
        : null));

    const grid = el('div', { class: 'npc-field-grid' });
    for (const field of visible) grid.append(this.buildField(ctx, field, commit));
    details.append(grid);

    return { node: details, shown: visible.length, modified };
  }

  /**
   * The label as well as the raw key: nobody looking for "Hide name tag" knows
   * it is stored as `hideName`, and nobody reading a server script for
   * `trunkPut` knows we call it "Storage deposit fee".
   */
  fieldMatches(ctx, ...haystack) {
    if (!ctx.search) return true;
    const needle = ctx.search.trim().toLowerCase();
    return haystack.some((text) => (text || '').toLowerCase().includes(needle));
  }

  isChanged(ctx, field) {
    if (!ctx.baseline.has(field.key)) return false;
    return (field.value ?? '') !== ctx.baseline.get(field.key);
  }

  buildField(ctx, field, commit) {
    const current = field.value ?? '';
    const changed = this.isChanged(ctx, field);
    const was = ctx.baseline.get(field.key);

    const row = el('div', {
      class: 'npc-field',
      'data-field-key': field.key,
      'data-absent': field.present ? null : 'true',
      'data-changed': changed ? 'true' : null,
    });

    row.append(el('div', { class: 'npc-field-label' },
      el('span', { class: 'npc-field-name', text: field.label || field.key }),
      field.unit ? el('span', { class: 'npc-unit', text: field.unit }) : null,
      // "(was X)" inline, so a changed value carries its own history and does
      // not need a diff view to be readable.
      changed ? el('span', { class: 'npc-was', text: `原值 ${was === '' ? '空' : was}` }) : null,
      !field.present ? el('span', { class: 'npc-absent-tag', text: '未设置' }) : null,
      // The raw type, because this archive stores hideName as an Int on some
      // NPCs and a String on others, and which one you are looking at decides
      // what you can safely type into it.
      field.present && field.wzType
        ? el('span', { class: 'npc-type-tag', text: field.wzType })
        : null));

    if (field.kind === 'Container' || field.editable === false) {
      row.append(this.buildContainerRow(ctx, field));
      return row;
    }

    if (field.kind === 'Flag' && FLAGGABLE.has(current)) {
      const box = el('input', { type: 'checkbox', checked: current === '1' });
      box.addEventListener('change', () => {
        const next = box.checked ? '1' : '0';
        commit(field, next, () => { box.checked = current === '1'; });
      });
      row.append(el('label', { class: 'npc-check' }, box,
        el('span', { text: current === '1' ? '开' : '关' })));
    } else {
      /**
       * Whole-number validation follows the *node*, not the key.
       *
       * A field the NPC already carries is checked against its real WzType --
       * this client stores hideName, forceMove and the dc* offsets as both Int
       * and String, so refusing text in one that is genuinely a WzStringProperty
       * would block an edit the client accepts. A field that does not exist yet
       * follows the catalog, because that is what the server will create it as.
       */
      const numeric = field.present
        ? INTEGER_WZ_TYPES.has(field.wzType)
        : field.kind === 'Int' || field.kind === 'Flag';

      const input = el('input', {
        class: 'npc-input', value: current, spellcheck: 'false',
        inputmode: numeric ? 'numeric' : undefined,
        'aria-label': field.label || field.key,
      });
      let committed = current;

      if (numeric) input.addEventListener('focus', () => input.select());

      const send = () => {
        const next = input.value;
        if (next === committed) return;

        if (numeric && next.trim() !== '' && !Number.isInteger(Number(next))) {
          input.dataset.invalid = 'true';
          input.title = `${field.label || field.key} 在此以整数形式存储。`;
          return;
        }
        delete input.dataset.invalid;
        input.title = '';
        ctx.focusKey = field.key;
        commit(field, next, () => { input.value = committed; });
      };

      input.addEventListener('blur', send);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); send(); }
        else if (event.key === 'Escape') { event.preventDefault(); input.value = committed; input.blur(); }
      });

      row.append(input);
    }

    if (field.hint) row.append(el('div', { class: 'npc-field-hint', text: field.hint }));
    if (field.kind === 'Flag' && !FLAGGABLE.has(current)) {
      row.append(el('div', { class: 'npc-field-hint',
        text: `这通常是一个 0/1 标志，但此 NPC 持有“${current}”。` +
              '以文本显示，以免勾选复选框时丢失该值。' }));
    }
    if (!field.present) {
      row.append(el('div', { class: 'npc-field-hint',
        text: '此 NPC 没有此字段。设置值将创建该字段。' }));
    }
    return row;
  }

  /**
   * A field that is a group of values rather than one.
   *
   * `info/script` and `info/speak` are containers on almost every NPC that has
   * them -- 3,044 of 3,057 -- and drawing the usual input for them puts an empty
   * box on screen that looks editable, accepts typing, and is refused by the
   * server on blur. A count and a way in is the truth.
   */
  buildContainerRow(ctx, field) {
    // The server counts in the value ("1 entries"). Rewritten rather than
    // printed: a plural on a count of one is the kind of small wrongness that
    // makes a user distrust the numbers beside it.
    const count = /^(\d+) entries$/.exec(field.value || '');
    const label = count
      ? `${fmt.format(Number(count[1]))} 个条目`
      : field.value || '一组值';

    return el('div', { class: 'npc-container' },
      el('span', { class: 'npc-container-count', text: label }),
      el('button', {
        class: 'btn btn-sm',
        'data-tip': '这里保存一组值，因此在树中编辑',
        onclick: () => { ctx.close?.(); this.showInExplorer(field.path); },
      }, icon('externalLink', { size: 14 }), '在资源管理器中打开'));
  }

  /**
   * The script bindings, spelled out.
   *
   * `info/script/0/script` is the handler name the server looks up when the NPC
   * is clicked, and it is the single most useful string on the whole image --
   * worth a row of its own rather than a "4 entries" chip.
   */
  buildScriptSection(ctx) {
    const scripts = ctx.detail.scripts || [];
    if (!scripts.length || ctx.modifiedOnly) return null;
    if (!this.fieldMatches(ctx, 'script', 'scripts', 'handler', ...scripts.map((s) => s.script))) return null;

    const list = el('div', { class: 'npc-binding-list' });
    for (const entry of scripts) {
      const extra = Object.entries(entry.extra || {});
      list.append(el('div', { class: 'npc-binding' },
        el('span', { class: 'npc-binding-index', text: entry.index === '' ? 'script' : `#${entry.index}` }),
        el('div', { class: 'npc-binding-body' },
          el('div', { class: 'npc-binding-main', text: entry.script || '此条目中没有处理程序名称' }),
          extra.length
            ? el('div', { class: 'npc-binding-extra',
                text: extra.map(([key, value]) => `${key}: ${value ?? '—'}`).join(' · ') })
            : null),
        el('button', {
          class: 'btn btn-sm btn-icon', 'data-tip': '在资源管理器中显示此绑定',
          onclick: () => { ctx.close?.(); this.showInExplorer(entry.path); },
        }, icon('externalLink', { size: 14 }))));
    }

    return el('details', { class: 'npc-section', open: true },
      el('summary', {},
        el('span', { class: 'npc-section-name', text: '脚本绑定' }),
        el('span', { class: 'npc-section-meta',
          text: `${scripts.length} 项 · 服务器运行的处理器` })),
      list);
  }

  /**
   * The idle chat, resolved.
   *
   * `info/speak/<n>` holds "n0", not a sentence; the words are at
   * String.wz/Npc.img/<id>/n0 and the API joins them. Showing the key alone is
   * what makes people conclude the chat text is not editable, so the line is the
   * heading and the key is the footnote.
   */
  buildSpeakSection(ctx) {
    const lines = ctx.detail.speak || [];
    if (!lines.length || ctx.modifiedOnly) return null;
    if (!this.fieldMatches(ctx, 'speak', 'chat', 'dialogue', 'lines',
      ...lines.map((line) => line.text), ...lines.map((line) => line.key))) return null;

    const list = el('div', { class: 'npc-binding-list' });
    for (const line of lines) {
      const resolved = line.text != null && line.text !== '';
      list.append(el('div', { class: 'npc-binding', 'data-tone': resolved ? null : 'bad' },
        el('span', { class: 'npc-binding-index', text: `#${line.index}` }),
        el('div', { class: 'npc-binding-body' },
          el('div', { class: 'npc-binding-main', 'data-quoted': resolved ? 'true' : null,
            text: resolved
              ? line.text
              : this.capabilities.names
                ? `String.wz 中没有与“${line.key ?? '此键'}”对应的内容，因此该行在游戏中没有声音。`
                : 'String.wz 未打开，因此无法解析此行。' }),
          el('div', { class: 'npc-binding-extra' },
            el('span', { class: 'npc-key-chip', text: line.key ?? '无键' }),
            el('span', { text: ' 位于 String.wz' }))),
        // Two ways in, because they are two different edits: the WZ node
        // decides *which* line is shown, the String.wz entry holds the words.
        el('button', {
          class: 'btn btn-sm btn-icon', 'data-tip': '在资源管理器中显示此键',
          onclick: () => { ctx.close?.(); this.showInExplorer(line.path); },
        }, icon('hash', { size: 14 })),
        line.stringPath
          ? el('button', {
              class: 'btn btn-sm btn-icon', 'data-tip': '在 String.wz 中编辑文本',
              onclick: () => { ctx.close?.(); this.showInExplorer(line.stringPath); },
            }, icon('type', { size: 14 }))
          : null));
    }

    return el('details', { class: 'npc-section', open: true },
      el('summary', {},
        el('span', { class: 'npc-section-name', text: '对话行' }),
        el('span', { class: 'npc-section-meta',
          text: `${lines.length} 行 · 文本保存在 String.wz` })),
      list,
      // Rule 12: the limit named where the user reaches for it.
      el('div', { class: 'npc-section-foot',
        text: this.capabilities.canEditText
          ? '文本在 String.wz 中编辑，不在此处 — 上方按钮会打开对应的节点。'
          : 'String.wz 当前未以写入方式打开，因此现在无法从此应用修改文本。' }));
  }

  /**
   * Folds a fresh detail back into the list row it came from.
   *
   * The badges and the card behind the dialog all read the list DTO, and only
   * the detail knows what was just written -- so without this, ticking "Opens a
   * shop" left the card without its Shop badge until the next reload. Keys are
   * matched case-insensitively because the list DTO and the WZ nodes do not
   * always agree on capitalisation.
   */
  syncSummary(ctx) {
    const values = new Map();
    for (const group of ctx.detail.groups || []) {
      for (const field of group.fields || []) {
        if (field.present) values.set((field.key || '').toLowerCase(), field.value);
      }
    }
    const on = (key) => {
      const value = values.get(key);
      return value != null && value !== '' && value !== '0';
    };

    const npc = ctx.npc;
    npc.name = ctx.detail.name ?? npc.name;
    npc.func = ctx.detail.func ?? npc.func;
    npc.linkTarget = ctx.detail.linkTarget ?? null;
    npc.hideName = values.has('hidename') ? on('hidename') : npc.hideName;
    npc.isShop = values.has('shop') || values.has('scriptnpcshop')
      ? on('shop') || on('scriptnpcshop')
      : npc.isShop;
    npc.isStorage = values.has('storebank') ? on('storebank') : npc.isStorage;
    npc.isTrunk = values.has('trunkput') || values.has('trunkget') ? true : npc.isTrunk;
    npc.speakLines = (ctx.detail.speak || []).length || npc.speakLines;
    npc.script = ctx.detail.scripts?.find((s) => s.script)?.script ?? npc.script;
    npc.hasScript = (ctx.detail.scripts || []).length > 0 || npc.hasScript;
    npc.dirty = ctx.detail.dirty ?? true;
  }

  commitField(ctx, field, value, revert, paint) {
    return this.guard(`field:${ctx.detail.path}:${field.key}`, async () => {
      try {
        const next = await api.npcFields(ctx.detail.path, [{ key: field.key, value }]);
        ctx.detail = next;
        ctx.touched = true;
        // Fields the server has never reported before -- an absent one that was
        // just created -- have no baseline, so record the empty they came from.
        for (const group of next.groups || []) {
          for (const item of group.fields || []) {
            if (!ctx.baseline.has(item.key)) ctx.baseline.set(item.key, '');
          }
        }
        this.syncSummary(ctx);
        this.app.markDirty();
        paint();
      } catch (error) {
        revert?.();
        toastError(error, '无法保存该字段');
      }
    });
  }

  /* ============================================================
     BULK EDIT
     ============================================================ */

  openBulkDialog() {
    return this.guard('bulk-dialog', () => this.buildBulkDialog());
  }

  /**
   * Hands the ticked NPCs to the cross-client port dialog.
   *
   * Reloaded on close because a port that replaced an NPC changes rows in this
   * grid when the target archive is one it is showing — and it usually is, since
   * the list spans every open Npc archive by default.
   */
  openPortDialog() {
    return this.guard('port-dialog', async () => {
      await openPortDialog({ app: this.app, kind: 'npc', paths: [...this.selection] });
      await this.load();
    });
  }

  /**
   * The field list comes from a real NPC in the selection, because which fields
   * exist depends on the archive. A hardcoded list would offer keys this Npc.wz
   * does not have and hide the ones it does.
   *
   * Containers are excluded -- the server refuses them anyway, and offering
   * `script` in a dropdown that cannot write it is a trap. Text and flag fields
   * are kept, because "set" accepts text; the op list narrows instead.
   */
  async bulkFieldOptions(path) {
    try {
      const detail = await api.npcDetail(path);
      const found = [];
      for (const group of detail.groups || []) {
        for (const field of group.fields || []) {
          if (!field.present) continue;             // bulk never creates a field; see NpcService.Bulk
          if (field.kind === 'Container' || field.editable === false) continue;
          found.push({
            key: field.key,
            label: `${group.group} · ${field.label || field.key}`,
            // The node's real type decides which operations make sense, not the
            // catalog's opinion of the key -- the same reason buildField uses it.
            kind: INTEGER_WZ_TYPES.has(field.wzType) ? 'Int' : field.kind,
          });
        }
      }
      if (found.length) return found;
    } catch {
      /* fall through to the safe list rather than blocking the dialog */
    }
    return FALLBACK_BULK_FIELDS.map((f) => ({ ...f, label: f.label }));
  }

  async buildBulkDialog() {
    const paths = [...this.selection];
    if (!paths.length) {
      toast('请先勾选几个 NPC — 每张卡片的角落都有复选框。', 'info');
      return;
    }

    const fields = await this.bulkFieldOptions(paths[0]);

    const fieldSelect = el('select', { class: 'npc-select', 'aria-label': '要更改的字段' },
      fields.map((field) => el('option', { value: field.key, text: field.label })));
    const opSelect = el('select', { class: 'npc-select', 'aria-label': '操作' });
    // Text rather than number: "set" writes its operand verbatim, and an NPC
    // field is as likely to hold a script name as a count.
    const valueInput = el('input', { class: 'npc-input', value: '1', spellcheck: 'false' });
    const roundSelect = el('select', { class: 'npc-select', 'aria-label': '取整方式' },
      ROUNDING.map(([value, label]) => el('option', { value, text: label })));

    const kindOf = (key) => fields.find((f) => f.key === key)?.kind ?? 'Text';

    /**
     * Arithmetic is offered only where it means something.
     *
     * "Multiply by 2" on a field holding "cygnusJobAdvancement" is not a thing
     * the server will do, and a dropdown that offers it makes the refusal look
     * like a bug rather than a choice.
     */
    const paintOps = () => {
      const numeric = kindOf(fieldSelect.value) === 'Int';
      const wanted = numeric ? OPS : OPS.slice(0, 1);
      const keep = wanted.some(([value]) => value === opSelect.value) ? opSelect.value : 'set';
      clear(opSelect);
      opSelect.append(...wanted.map(([value, label]) => el('option', { value, text: label, selected: value === keep })));
      opSelect.disabled = !numeric;
      roundSelect.disabled = !numeric || keep === 'set';
    };

    const previewHost = el('div', { class: 'npc-preview-host' });
    let preview = null;

    const applyButton = el('button', {
      class: 'btn btn-primary', disabled: true,
      'data-tip': '先预览 — 看到数值之前不会写入任何内容',
    }, icon('check', { size: 15 }), `应用到 ${fmt.format(paths.length)} 个 NPC`);

    const previewButton = el('button', { class: 'btn' }, icon('eye', { size: 15 }), '预览更改');

    /**
     * Any change to the recipe throws the preview away.
     *
     * An Apply that stays enabled after the value box changes is an Apply that
     * writes something other than what is on screen.
     */
    const invalidate = () => {
      preview = null;
      applyButton.disabled = true;
      clear(previewHost);
      previewHost.append(el('div', { class: 'npc-preview-empty' },
        icon('info', { size: 15 }),
        el('span', { text: '预览更改可查看每个 NPC 的精确前后对比。' +
                           '在此之前不会写入任何内容。' })));
    };
    fieldSelect.addEventListener('change', () => { paintOps(); invalidate(); });
    for (const control of [opSelect, roundSelect]) {
      control.addEventListener('change', () => { paintOps(); invalidate(); });
    }
    valueInput.addEventListener('input', invalidate);
    paintOps();
    invalidate();

    const recipe = () => ({
      paths,
      field: fieldSelect.value,
      op: opSelect.value,
      // A string, because NpcBulkRequest takes one: the server parses arithmetic
      // operands with InvariantCulture and writes "set" values verbatim.
      value: valueInput.value,
      round: roundSelect.value,
    });

    previewButton.addEventListener('click', () => this.guard('bulk-preview', async () => {
      const body = recipe();
      if (body.op !== 'set' && !Number.isFinite(Number(body.value))) {
        toast('请输入一个数字来更改该字段。', 'warning');
        return;
      }
      clear(previewHost);
      previewHost.append(el('div', { class: 'npc-preview-empty' }, el('span', { text: '正在处理…' })));
      try {
        const result = await api.npcBulk({ ...body, dryRun: true });
        preview = result;
        clear(previewHost);
        previewHost.append(this.buildPreviewTable(result));
        const changing = (result.changes || []).filter((c) => !c.skipped).length;
        applyButton.disabled = changing === 0;
        applyButton.dataset.tip = changing
          ? `写入这 ${fmt.format(changing)} 处更改`
          : '这里不会有任何更改';
      } catch (error) {
        preview = null;
        applyButton.disabled = true;
        clear(previewHost);
        previewHost.append(el('div', { class: 'npc-preview-empty', 'data-tone': 'bad' },
          icon('alert', { size: 15 }),
          el('span', { text: error.message })));
      }
    }));

    const { close } = modal({
      title: '批量编辑 NPC',
      subtitle: `已选择 ${fmt.format(paths.length)} 个 NPC`,
      width: 'min(96vw, 900px)',
      body: el('div', { class: 'npc-bulk' },
        el('div', { class: 'npc-bulk-grid' },
          bulkField('字段', fieldSelect, '仅包含第一个所选 NPC 已拥有的字段 — 批量编辑不会创建新字段。'),
          bulkField('操作', opSelect),
          bulkField('值', valueInput),
          bulkField('取整', roundSelect, '乘法和百分比可能产生小数；WZ 整数无法保存小数。')),
        el('div', { class: 'npc-bulk-actions' }, previewButton, applyButton),
        previewHost,
        el('div', { class: 'tips' },
          el('b', { text: '行为说明' }),
          el('ul', {},
            el('li', { text: '预览在服务器端执行，因此您看到的就是将要写入的内容。' }),
            el('li', { text: '没有该字段的 NPC 会被跳过并显示原因 — 此处不会创建字段。' +
                             '请先从 NPC 卡片添加。' }),
            el('li', { text: '保存一组值的字段（如 script、speak）会被跳过并提示。' }),
            el('li', { text: '保存之前不会写入磁盘，整个批次都可以撤销。' })))),
      actions: [{ label: '关闭' }],
    });

    applyButton.addEventListener('click', () => this.guard('bulk-apply', async () => {
      if (!preview) return;
      const changing = (preview.changes || []).filter((c) => !c.skipped);
      const ok = await confirmDialog({
        title: `在 ${fmt.format(changing.length)} 个 NPC 上更改 ${fieldSelect.value}？`,
        message: `${OPS.find(([v]) => v === opSelect.value)?.[1]} ${valueInput.value} — 这就是您正在查看的预览。` +
                 '保存前不会写入磁盘，之后也可以撤销。',
        confirmLabel: '应用更改',
        danger: false,
      });
      if (!ok) return;

      try {
        const result = await api.npcBulk({ ...recipe(), dryRun: false });
        const skipped = (result.changes || []).filter((c) => c.skipped).length;
        close();
        toast(
          `已更新 ${fmt.format(result.applied ?? 0)} 个 NPC` +
          (skipped ? `，跳过 ${fmt.format(skipped)} 个。` : '。'),
          'success', {
            action: { label: '撤销', run: async () => { await this.app.undo(); await this.load(); } },
          });
        this.app.markDirty();
        await this.load();
      } catch (error) {
        toastError(error, '无法应用这些更改');
      }
    }));
  }

  buildPreviewTable(result) {
    const changes = result.changes || [];
    const skipped = changes.filter((c) => c.skipped).length;

    const body = el('tbody');
    for (const change of changes) {
      body.append(el('tr', { 'data-skipped': change.skipped ? 'true' : null },
        el('td', {},
          el('div', { class: 'npc-preview-name', text: change.name || `NPC ${change.npcId}` }),
          // The id only when it is not already the whole label: an unnamed NPC
          // read "NPC 9901521" over "9901521", which looks like a rendering bug.
          change.name ? el('div', { class: 'npc-sub', text: String(change.npcId) }) : null),
        el('td', { class: 'num', text: change.before ?? '—' }),
        el('td', { class: 'npc-preview-arrow' }, change.skipped ? '' : '→'),
        el('td', { class: 'num', text: change.skipped ? '—' : (change.after ?? '—') }),
        el('td', { class: 'npc-preview-note',
          text: change.skipped ? (change.reason || '已跳过') : '' })));
    }

    return el('div', {},
      el('div', { class: 'npc-preview-head' },
        el('span', { text: `${fmt.format(changes.length - skipped)} 处将更改` +
                           (skipped ? `，${fmt.format(skipped)} 处跳过` : '') })),
      el('div', { class: 'npc-preview-scroll' },
        el('table', { class: 'npc-preview' },
          el('thead', {}, el('tr', {},
            ['NPC', '原值', '', '新值', ''].map((h) => el('th', { text: h })))),
          body)));
  }
}

/** One labelled control in the bulk recipe. */
function bulkField(label, control, hint) {
  return el('div', { class: 'npc-bulk-field' },
    el('label', { text: label }), control,
    hint ? el('div', { class: 'npc-field-hint', text: hint }) : null);
}
