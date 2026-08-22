import { api } from './api.js';
import { el, clear, toast, toastError, fmt, modal, debounce, runOnce, busyWhile, busyPanel, confirmDialog } from './ui.js';
import { emptyState } from './inspector.js';
import { icon } from './icons.js';
import { fieldLabel, PART_LABELS } from './fieldLabels.js';

/**
 * Equipment section, in the same shape as the Mob editor: a card grid over the
 * open client's Character.wz, and a per-equip field editor in a dialog.
 *
 * The editor is exactly the mob's: fields grouped into collapsible sections,
 * an inline commit per field (blur or Enter writes that one field through
 * /api/equip/bulk, no "apply" step), a field search, and the missing-field
 * toggle. The one thing equipment adds over a mob is its icons: every equip
 * carries iconRaw/icon and sometimes iconReward, shown in the dialog head with
 * download and PNG-replace actions.
 *
 * The list is server-paginated (offset/limit) because the ~5,000-image index is
 * built lazily and unparsed again, exactly as the Mob index is.
 */

const PAGE_SIZE = 60;

/** Fields offered by the bulk editor (mostly Int; String for the slot fields). */
const BULK_FIELDS = [
  ['incSTR', '力量加成'], ['incDEX', '敏捷加成'], ['incINT', '智力加成'], ['incLUK', '幸运加成'],
  ['incPAD', '物理攻击'], ['incMAD', '魔法攻击'], ['incPDD', '物理防御'], ['incMDD', '魔法防御'],
  ['incSpeed', '移动速度'], ['incJump', '跳跃力'], ['incMHP', '最大HP'], ['incMMP', '最大MP'],
  ['incACC', '命中率'], ['incEVA', '回避率'], ['tuc', '升级次数'], ['reqLevel', '所需等级'],
  ['reqJob', '所需职业'], ['reqSTR', '力量需求'], ['reqDEX', '敏捷需求'], ['reqINT', '智力需求'],
  ['reqLUK', '幸运需求'], ['islot', '穿戴槽位'], ['vslot', '可用槽位'], ['price', '价格'],
  ['cash', '现金道具'], ['tradeBlock', '交易锁定'], ['notSale', '不可出售'],
];

const STRING_FIELDS = new Set(['islot', 'vslot']);

/**
 * Preset choices for "增加字段". Picking one fills the WZ key for you and
 * pre-selects the sensible type; "自定义字段…" falls back to a free-text key.
 * `type` (default Int) is the WZ scalar created when the field doesn't exist.
 */
const ADD_FIELD_OPTIONS = [
  { key: 'afterImage', label: '攻击的划痕' },
  { key: 'attack', label: '此处意义不明' },
  { key: 'attackSpeed', label: '攻击速度' },
  { key: 'cash', label: '是否现金道具（0不是 1是）', type: 'Bool' },
  { key: 'incACC', label: '增加命中' },
  { key: 'incDEX', label: '增加敏捷' },
  { key: 'incINT', label: '增加智力' },
  { key: 'incLUK', label: '增加幸运' },
  { key: 'incSTR', label: '增加力量' },
  { key: 'incPAD', label: '增加物理攻击' },
  { key: 'incHP', label: '增加血值' },
  { key: 'incMP', label: '增加魔值' },
  { key: 'incMAD', label: '增加魔法攻击' },
  { key: 'incMDD', label: '增加魔法防御' },
  { key: 'incPDD', label: '增加物理防御' },
  { key: 'reqDEX', label: '装备要求的敏捷' },
  { key: 'reqINT', label: '装备要求的智力' },
  { key: 'reqJob', label: '装备要求的职业' },
  { key: 'reqLevel', label: '装备要求的级别' },
  { key: 'reqLUK', label: '装备要求的幸运' },
  { key: 'reqSTR', label: '装备要求的力量' },
  { key: 'tuc', label: '可升级次数' },
  { key: 'knockback', label: '击退怪物几率' },
  { key: 'notSale', label: '无法出售', type: 'Bool' },
  { key: 'only', label: '固有道具', type: 'Bool' },
  { key: 'price', label: '出售价格（卖到店里的价格＝这个价格的 2 分之 1）' },
  { key: 'timeLimited', label: '时间限制', type: 'Bool' },
  { key: 'tradeBlock', label: '不可交易', type: 'Bool' },
  { key: 'equipTradeBlock', label: '装备后不可交易', type: 'Bool' },
  { key: 'exp', label: '武器升级需要的武器经验值' },
  { key: 'incPADMax', label: '升级时增加的最大攻击' },
  { key: 'incPADMin', label: '升级时增加的最小攻击' },
  { key: 'incMADMax', label: '升级时增加的最大魔法攻击' },
  { key: 'incMADMin', label: '升级时增加的最小魔法攻击' },
  { key: 'incDEXMax', label: '升级时增加的最大敏捷' },
  { key: 'incDEXMin', label: '升级时增加的最小敏捷' },
  { key: 'incSTRMax', label: '升级时增加的最大力量' },
  { key: 'incSTRMin', label: '升级时增加的最小力量' },
  { key: 'incLUKMax', label: '升级时增加的最大幸运' },
  { key: 'incLUKMin', label: '升级时增加的最小幸运' },
  { key: 'incINTMax', label: '升级时增加的最大智力' },
  { key: 'incINTMin', label: '升级时增加的最小智力' },
];

export class EquipmentSection {
  constructor({ host, app }) {
    this.host = host;
    this.app = app;
    this.fileId = null;
    this.page = 1;
    this.query = '';
    this.partFilter = '';
    this.dirtyOnly = false;
    this.thumbRev = 0;

    this.capabilities = { available: false };
    this.items = [];
    this.total = 0;
    this.parts = {};
    this.truncated = false;
    this.error = null;
    this.loading = false;
    this.loaded = false;

    this.selection = new Set();
  }

  async guard(key, run) {
    try {
      await runOnce(`equip:${key}`, run);
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
      try {
        this.capabilities = await api.equipCapabilities();
      } catch (error) {
        this.capabilities = { available: false, names: false };
        this.error = error;
        return;
      }

      if (!this.capabilities.available) {
        this.items = [];
        this.total = 0;
        this.selection.clear();
        return;
      }

      await this.refreshList();
    } finally {
      this.loading = false;
      this.loaded = true;
    }
    this.render();
  }

  /**
   * Re-fetches the current page with the current filters, without rebuilding
   * the toolbar. The list is server-paginated, so every filter change must
   * round-trip to the backend — but the search box and IME composition must
   * survive it, so this only repaints the results panel.
   */
  async refreshList() {
    try {
      const params = {
        offset: (this.page - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
        search: this.query || undefined,
        part: this.partFilter || undefined,
        dirtyOnly: this.dirtyOnly ? true : undefined,
      };
      const list = await api.equipList(this.fileId, params);
      this.items = list.items || [];
      this.total = list.total || 0;
      this.parts = list.parts || {};
      this.truncated = Boolean(list.truncated);
      // A reload can drop equips the selection still points at.
      this.selection = new Set([...this.selection].filter((p) => this.items.some((i) => i.path === p)));
      return true;
    } catch (error) {
      this.error = error;
      this.items = [];
      this.total = 0;
      return false;
    }
  }

  /** Refreshes after a filter or page change: repaint results, fall back to a full render on error. */
  async reload() {
    const ok = await this.refreshList();
    if (ok) this.renderResults();
    else this.render();
  }

  get pageCount() {
    return Math.max(1, Math.ceil(this.total / PAGE_SIZE));
  }

  get filterActive() {
    return Boolean(this.query || this.partFilter || this.dirtyOnly);
  }

  /* ============================================================
     RENDER
     ============================================================ */

  render() {
    clear(this.host);
    this.host.className = 'stage-body mobs';

    try {
      this.renderInner();
    } catch (error) {
      clear(this.host);
      this.host.className = 'stage-body mobs';
      this.host.append(emptyState(
        'alert', '装备编辑器渲染出错',
        (error?.stack ?? error?.message ?? String(error))?.slice(0, 600),
        el('div', { class: 'mob-empty-actions' },
          el('button', { class: 'btn btn-primary', onclick: () => this.load() },
            icon('refresh', { size: 15 }), '重试'))));
      console.error(error);
    }
  }

  renderInner() {
    if (this.error) {
      this.host.append(emptyState(
        'alert', '无法读取装备列表',
        this.error.message,
        el('div', { class: 'mob-empty-actions' },
          el('button', { class: 'btn btn-primary', onclick: () => this.load() },
            icon('refresh', { size: 15 }), '重试'),
          el('button', { class: 'btn', onclick: () => this.app.openFilePicker() },
            icon('folderOpen', { size: 15 }), '打开客户端'))));
      return;
    }

    if (this.loading && !this.loaded) {
      this.host.append(busyPanel({
        title: '正在读取装备…',
        note: '完整的 Character.wz 包含约 5,000 张装备图片，首次读取约需十秒。之后在数据发生变化前都会瞬时完成。',
        className: 'mob-panel',
      }));
      return;
    }

    if (!this.capabilities.available) {
      this.host.append(emptyState(
        'shield', '未打开装备数据',
        '装备编辑会读取 Character.wz 中的装备图片。请打开整个客户端文件夹，或单独打开 Character 目录。',
        el('button', { class: 'btn btn-primary', onclick: () => this.app.openFilePicker() },
          icon('folderOpen', { size: 15 }), '打开客户端')));
      return;
    }

    this.resultHost = el('div');
    this.host.append(
      this.buildHead(),
      this.buildToolbar(),
      this.resultHost);
    this.renderResults();
  }

  buildHead() {
    const candidates = this.app.files.filter((file) => /character/i.test(file.name));
    const scoped = this.fileId ? this.app.files.find((f) => f.id === this.fileId) : null;
    const subject = scoped
      ? scoped.name
      : candidates.length === 1
        ? candidates[0].name
        : candidates.length > 1
          ? `${candidates.length} 个存档`
          : '所有已打开的存档';

    const head = el('div', { class: 'mob-panel mob-head' },
      el('div', { class: 'mob-head-text' },
        el('div', { class: 'mob-head-title', text: '装备' }),
        el('div', { class: 'mob-head-sub' },
          el('span', { text: '正在编辑 ' }),
          el('b', { text: subject }),
          el('span', {
            text: this.loaded
              ? ` · ${fmt.format(this.total)} 件装备`
                + (this.capabilities.names === false ? ' · String.wz 未打开,装备将没有名称' : '')
              : '',
          }))));

    if (candidates.length > 1) {
      const select = el('select', { class: 'mob-select', 'aria-label': '选择要编辑的存档' },
        el('option', { value: '', text: `所有存档（${candidates.length}）`, selected: !this.fileId }),
        candidates.map((file) => el('option', { value: file.id, text: file.name, selected: file.id === this.fileId })));
      select.addEventListener('change', () => {
        this.selection.clear();
        this.open(select.value || null);
      });
      head.append(select);
    }

    head.append(el('button', {
      class: 'btn btn-icon', 'data-tip': '重新加载装备列表',
      onclick: () => this.load(),
    }, icon('refresh', { size: 15 })));

    return head;
  }

  buildToolbar() {
    const search = el('input', {
      type: 'search', value: this.query,
      placeholder: '按装备 ID、名称或部件搜索…',
      'aria-label': '搜索装备',
    });
    search.addEventListener('input', debounce(() => {
      this.query = search.value;
      this.page = 1;
      this.reload();
    }, 160));

    const parts = el('select', { class: 'mob-select', 'aria-label': '按部件筛选' },
      el('option', { value: '', text: '全部部件' }),
      ...Object.entries(this.parts).map(([key, count]) =>
        el('option', { value: key, text: `${PART_LABELS[key] ?? key}(${count})` })));
    parts.value = this.partFilter;
    parts.addEventListener('change', () => {
      this.partFilter = parts.value;
      this.page = 1;
      this.reload();
    });

    const dirtyBox = el('input', { type: 'checkbox', checked: this.dirtyOnly, 'aria-label': '仅未保存' });
    dirtyBox.addEventListener('change', () => {
      this.dirtyOnly = dirtyBox.checked;
      this.page = 1;
      this.reload();
    });
    const dirty = el('label', { class: 'mob-check', style: 'display:flex;align-items:center;gap:6px;color:var(--text-2);font-size:var(--fs-13);cursor:pointer' },
      dirtyBox, el('span', { text: '未保存' }));

    return el('div', { class: 'mob-panel' },
      el('div', { class: 'mob-toolbar' },
        el('div', { class: 'mob-search' }, el('span', { class: 'icon' }, icon('search', { size: 15 })), search),
        parts,
        dirty),
      this.buildSelectionBar(),
      this.truncated
        ? el('div', { class: 'notice', 'data-tone': 'warn' }, icon('alert', { size: 14 }),
            el('span', { text: '存档中的装备数量超过单次列表返回的数量，因此这是部分列表。请限定到单个部件，或使用搜索，以确保看到全部内容。' }))
        : null);
  }

  buildSelectionBar() {
    const count = this.selection.size;
    const shown = this.items.length;

    return el('div', { class: 'mob-selbar', 'data-active': count ? 'true' : 'false' },
      el('span', { class: 'mob-selcount', text: count ? `${fmt.format(count)} 已选` : '未选择任何内容' }),
      el('button', {
        class: 'btn btn-sm', disabled: !shown,
        onclick: () => {
          for (const item of this.items) this.selection.add(item.path);
          this.renderResults();
        },
      }, icon('check', { size: 14 }), `全选本页 ${shown}`),
      el('button', {
        class: 'btn btn-sm', disabled: !count,
        onclick: () => { this.selection.clear(); this.renderResults(); },
      }, icon('close', { size: 14 }), '清除'),
      el('button', {
        class: 'btn btn-sm btn-primary', disabled: !count,
        onclick: () => this.openBulkDialog(),
      }, icon('sliders', { size: 14 }), count ? `批量编辑 ${fmt.format(count)}` : '批量编辑'));
  }

  renderResults() {
    if (!this.resultHost) { this.render(); return; }
    clear(this.resultHost);

    const pages = this.pageCount;
    this.page = Math.min(this.page, pages);

    const panel = el('div', { class: 'mob-panel' });
    panel.append(el('div', { class: 'mob-result-head' },
      el('span', { text: `${fmt.format(this.total)} 件装备${this.partFilter ? ` · ${PART_LABELS[this.partFilter] ?? this.partFilter}` : ''}` }),
      el('span', { text: `第 ${this.page} 页，共 ${pages} 页` })));

    if (!this.items.length) {
      panel.append(emptyState(
        'search',
        this.filterActive ? `没有匹配“${this.query || this.partFilter || '未保存'}”的装备` : '此存档中没有装备',
        this.filterActive
          ? '调整筛选条件后再试。'
          : '存档已打开，但其中没有任何带 info 的装备图片。'));
    } else {
      const grid = el('div', { class: 'mob-grid' });
      for (const item of this.items) grid.append(this.buildCard(item));
      panel.append(grid);
      if (pages > 1) panel.append(this.buildPager(pages));
    }

    this.resultHost.append(panel);
  }

  buildCard(item) {
    const selected = this.selection.has(item.path);
    const card = el('div', {
      class: 'mob-card', 'data-path': item.path, 'data-selected': selected ? 'true' : 'false',
    });

    const box = el('input', {
      type: 'checkbox', checked: selected,
      'aria-label': `选择 ${item.name || `装备 ${item.itemId}`}`,
    });
    box.addEventListener('change', () => {
      if (box.checked) this.selection.add(item.path); else this.selection.delete(item.path);
      card.dataset.selected = box.checked ? 'true' : 'false';
      this.refreshSelectionBar();
    });

    const thumb = item.icon
      ? el('img', {
          class: 'mob-sprite-img', alt: '', loading: 'lazy',
          src: `/api/thumb?path=${encodeURIComponent(item.icon)}&v=${this.thumbRev}`,
          style: 'width:44px;height:44px;object-fit:contain;display:block',
          onerror: (event) => { event.target.style.visibility = 'hidden'; },
        })
      : el('span', { class: 'mob-sprite', style: 'width:44px;height:44px' }, icon('shield', { size: 16 }));

    const badges = el('div', { class: 'mob-badges' },
      el('span', { class: 'mob-badge', 'data-kind': 'undead', text: item.part }),
      item.dirty ? el('span', { class: 'mob-badge', 'data-kind': 'dirty', text: '未保存' }) : null);

    const stat = (key, value) => el('div', { class: 'mob-row' },
      el('span', { class: 'k', text: key }),
      el('span', { class: 'v', text: value }));

    card.append(...[
      el('div', { class: 'mob-card-head' },
        el('label', { class: 'mob-pick' }, box),
        el('div', { class: 'mob-sprite' }, thumb),
        el('div', { class: 'mob-card-title' },
          el('button', {
            class: 'mob-title', text: item.name || `装备 ${item.itemId}`,
            'data-tip': '打开此装备', onclick: (event) => this.openEquipCard(item, event.currentTarget),
          }),
          el('div', { class: 'mob-sub', text: `ID ${item.itemId}` })),
        item.reqLevel
          ? el('span', { class: 'mob-level', 'data-tip': '需求等级', text: `Lv ${fmt.format(item.reqLevel)}` })
          : null),
      badges.childElementCount ? badges : null,
      item.reqStr ? stat('需求 STR', fmt.format(item.reqStr)) : null,
      el('div', { class: 'mob-actions' },
        el('button', { class: 'btn btn-sm', style: 'flex:1',
                       onclick: (event) => this.openEquipCard(item, event.currentTarget) },
          icon('edit', { size: 14 }), '编辑属性'),
        el('button', {
          class: 'btn btn-sm btn-icon', 'data-tip': '更多',
          onclick: (event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            this.app.showMenu(this.menuItemsFor(item), rect.left, rect.bottom + 4);
          },
        }, icon('more', { size: 15 }))),
    ].filter(Boolean));

    return card;
  }

  menuItemsFor(item) {
    return [
      { icon: 'edit', label: '编辑属性…', run: () => this.openEquipCard(item) },
      { icon: 'copy', label: `复制装备 ID ${item.itemId}`, run: () => this.app.copyText(String(item.itemId)) },
      { icon: 'externalLink', label: '在资源管理器中显示', run: () => {
        this.app.setMode('explorer');
        this.app.navigate(item.path);
      } },
    ].filter(Boolean);
  }

  refreshSelectionBar() {
    const current = this.host.querySelector('.mob-selbar');
    if (current) current.replaceWith(this.buildSelectionBar());
  }

  buildPager(pages) {
    const pager = el('div', { class: 'pager' });
    const go = (page) => { this.page = page; this.reload(); this.host.scrollTo?.({ top: 0 }); };

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

  /* ============================================================
     EQUIP CARD (the dialog)
     ============================================================ */

  openEquipCard(item, trigger = null) {
    return this.guard(`card:${item.path}`,
      () => busyWhile(trigger, this.buildEquipCard(item)));
  }

  async buildEquipCard(item) {
    let detail;
    try {
      detail = await api.equipDetail(item.path);
    } catch (error) {
      toastError(error, '无法读取该装备');
      return;
    }

    const ctx = {
      item,
      detail,
      baseline: new Map(),
      search: '',
      modifiedOnly: false,
      showAbsent: false,
      closed: new Set(),
      touched: false,
      focusKey: null,
    };
    for (const field of detail.fields || []) ctx.baseline.set(field.key, field.value ?? '');

    const headHost = el('div', { class: 'mob-detail-topline' });
    const sectionsHost = el('div', { class: 'mob-sections' });
    const counter = el('span', { class: 'mob-modcount' });

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
      'data-tip': '此装备没有的字段。写入一个即可创建它。',
      onclick: () => {
        ctx.showAbsent = !ctx.showAbsent;
        absentToggle.setAttribute('aria-pressed', ctx.showAbsent ? 'true' : 'false');
        paint();
      },
    }, icon('plus', { size: 14 }), '显示缺失字段');

    const addFieldButton = el('button', {
      class: 'btn btn-sm',
      'data-tip': '为此装备添加一个自定义字段（数值 / 文本 / 开关），不必是已有字段',
      onclick: () => this.openAddFieldDialog(ctx),
    }, icon('plus', { size: 14 }), '增加字段');

    const paint = () => {
      clear(headHost);
      headHost.append(this.buildDetailHead(ctx));

      clear(sectionsHost);

      // Group the fields the way the mob editor groups its API sections; the
      // server assigns each equipment field a group (需求 / 加成 / …).
      const groups = new Map();
      for (const field of ctx.detail.fields || []) {
        if (field.kind === 'Canvas') continue;
        if (!groups.has(field.group)) groups.set(field.group, []);
        groups.get(field.group).push(field);
      }

      let shown = 0;
      let modified = 0;
      for (const [group, fields] of groups) {
        const section = this.buildSection(ctx, { group, fields }, commit);
        modified += section.modified;
        if (!section.node) continue;
        shown += section.shown;
        sectionsHost.append(section.node);
      }

      // info > level > info upgrade levels: a node named N means "can be
      // upgraded to level N", carrying that level's stat fields (exp, incPAD…).
      let levelShown = 0;
      const levels = ctx.detail.levels || [];
      if (levels.length) {
        const panel = this.buildLevelsPanel(ctx, commit);
        levelShown = panel.shown;
        if (panel.node) sectionsHost.append(panel.node);
      }

      if (!shown && !levelShown) {
        sectionsHost.append(emptyState(
          'search',
          ctx.search ? `没有匹配“${ctx.search}”的字段` : '没有可显示的内容',
          ctx.modifiedOnly
            ? '此装备还没有任何更改。请关闭“仅显示已修改”。'
            : '搜索会同时匹配标签和原始 WZ 键名。'));
      }

      counter.textContent = modified
        ? `${modified} 个字段${modified === 1 ? '' : ''}已更改`
        : '';
      counter.dataset.active = modified ? 'true' : 'false';

      if (ctx.focusKey) {
        const back = sectionsHost.querySelector(`[data-field-key="${CSS.escape(ctx.focusKey)}"] input`);
        ctx.focusKey = null;
        if (back && back.type !== 'checkbox') { back.focus(); back.select?.(); }
      }
    };

    const commit = (field, value, revert) => this.commitField(ctx, field, value, revert, paint);
    ctx.paint = paint;

    const body = el('div', { class: 'mob-detail' },
      headHost,
      this.buildIconsRow(detail),
      el('div', { class: 'mob-detail-tools' },
        el('div', { class: 'mob-search' }, el('span', { class: 'icon' }, icon('search', { size: 15 })), search),
        modifiedToggle,
        absentToggle,
        addFieldButton,
        counter),
      sectionsHost);

    paint();

    const { dialog, close } = modal({
      title: ctx.item.name || `装备 ${ctx.item.itemId}`,
      subtitle: ctx.item.path.split('/').slice(1).join('/'),
      width: 'min(96vw, 880px)',
      body,
      actions: [{ label: '完成' }],
    });
    ctx.close = close;

    dialog.addEventListener('close', () => { if (ctx.touched) this.load(); }, { once: true });
  }

  /**
   * Adds a brand-new field to the equipment, not one the server catalogued.
   * The type follows the WZ scalar rules equipment actually uses: Int for the
   * numeric stats, String for slot/text fields, and Bool for the 0/1 switches
   * (stored as Int, since WZ has no boolean property). The key is validated
   * against the WZ identifier shape and for collisions with existing fields.
   */
  openAddFieldDialog(ctx) {
    const keySelect = el('select', { class: 'mob-select', 'aria-label': '字段名' },
      el('option', { value: '', text: '自定义字段…' }),
      ...ADD_FIELD_OPTIONS.map((o) => el('option', { value: o.key, text: `${o.label}（${o.key}）` })));
    const keyInput = el('input', {
      type: 'text', class: 'mob-input', placeholder: '如 incFury', 'aria-label': '自定义字段名',
      spellcheck: 'false', style: 'display:none',
    });
    const typeSelect = el('select', { class: 'mob-select', 'aria-label': '字段类型' },
      el('option', { value: 'Int', text: '整数（数值属性，如 0/1/40）' }),
      el('option', { value: 'String', text: '文本（槽位/文字类，如 islot）' }),
      el('option', { value: 'Bool', text: '开关（0/1）' }));
    const valueInput = el('input', { type: 'number', class: 'mob-input', value: '0', 'aria-label': '字段值' });

    const refreshValueType = () => {
      if (typeSelect.value === 'String') {
        valueInput.type = 'text';
        if (valueInput.value === '0' || valueInput.value === '') valueInput.value = '';
      } else if (typeSelect.value === 'Bool') {
        valueInput.type = 'checkbox';
      } else {
        valueInput.type = 'number';
        if (valueInput.value === '') valueInput.value = '0';
      }
    };
    const chosen = () => {
      const preset = ADD_FIELD_OPTIONS.find((o) => o.key === keySelect.value);
      keyInput.style.display = preset ? 'none' : '';
      if (preset) {
        typeSelect.value = preset.type || 'Int';
        refreshValueType();
      }
    };
    keySelect.addEventListener('change', chosen);
    typeSelect.addEventListener('change', refreshValueType);
    chosen();
    refreshValueType();

    const body = el('div', { class: 'mob-bulk-form' },
      el('label', { class: 'mob-field' },
        el('span', { class: 'mob-field-label' }, el('span', { class: 'mob-field-name', text: '字段名' })),
        keySelect,
        keyInput),
      el('label', { class: 'mob-field' },
        el('span', { class: 'mob-field-label' }, el('span', { class: 'mob-field-name', text: '类型' })),
        typeSelect),
      el('label', { class: 'mob-field' },
        el('span', { class: 'mob-field-label' }, el('span', { class: 'mob-field-name', text: '值' })),
        valueInput));
    body.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        body.closest('dialog')?.querySelector('.modal-foot .btn-primary')?.click();
      }
    });

    modal({
      title: '增加装备字段',
      subtitle: `将为此装备（${ctx.detail.itemId}）添加一个自定义字段。名称不能与已有字段重复。`,
      width: '420px',
      body,
      actions: [
        { label: '取消', class: 'btn-ghost' },
        {
          label: '创建', class: 'btn-primary', closes: false,
          run: async (closeDialog) => {
            const key = keySelect.value || keyInput.value.trim();
            if (!key) {
              toastError(new Error('请选择或输入一个字段名。'), '无效字段名');
              return false;
            }
            if (!keySelect.value && !/^[A-Za-z][A-Za-z0-9]*$/.test(key)) {
              toastError(new Error('自定义字段名须以字母开头，只能包含字母和数字（如 incFury、customStat）。'), '无效字段名');
              return false;
            }
            const existing = (ctx.detail.fields || []).find((f) => f.key.toLowerCase() === key.toLowerCase());
            if (existing) {
              toastError(new Error(`字段 ${key} 已存在。请直接编辑它，或换一个名称。`), '无法创建');
              return false;
            }
            const isBool = typeSelect.value === 'Bool';
            const type = isBool ? 'Int' : typeSelect.value;
            const value = isBool ? (valueInput.checked ? '1' : '0') : String(valueInput.value ?? '0');
            if (!isBool && type === 'Int' && value.trim() !== '' && !Number.isInteger(Number(value))) {
              toastError(new Error('整数值必须是整数。'), '无效值');
              return false;
            }
            try {
              const result = await api.equipBulk({
                paths: [ctx.detail.path],
                fields: [{ key, value, type }],
              });
              if ((result.skipped ?? 0) > 0) {
                toastError(new Error(result.changes?.[0]?.reason ?? '创建失败'), '无法创建字段');
                return false;
              }
              // Re-fetch so the new field appears under its right group.
              const next = await api.equipDetail(ctx.detail.path);
              ctx.detail = next;
              ctx.baseline.set(key, value);
              ctx.touched = true;
              this.app.markDirty();
              closeDialog();
              ctx.paint?.();
              toast(`已添加字段 ${key}`, 'success');
            } catch (error) {
              toastError(error, '无法创建字段');
            }
            return false;
          },
        },
      ],
    });
  }

  buildDetailHead(ctx) {
    const item = ctx.item;
    const levels = ctx.detail.levels || [];
    return el('div', { class: 'mob-detail-head' },
      el('div', {},
        el('div', { class: 'mob-detail-name', text: item.name || `装备 ${item.itemId}` }),
        el('div', { class: 'mob-sub', text: `ID ${item.itemId} · ${item.part}` +
          (levels.length ? ` · 可升级 ${levels.length} 级` : '') })),
      item.dirty ? el('span', { class: 'mob-badge', 'data-kind': 'dirty', text: '未保存' }) : null,
      el('span', { style: 'margin-left:auto' }),
      el('button', {
        class: 'btn btn-sm', 'data-tip': '在资源管理器中打开此 .img',
        onclick: () => {
          ctx.close?.();
          this.app.setMode('explorer');
          this.app.navigate(item.path);
        },
      }, icon('externalLink', { size: 14 }), '在资源管理器中显示'));
  }

  /** The equipment's replaceable icons, above the field sections. */
  buildIconsRow(detail) {
    const icons = detail.icons || [];
    if (!icons.length) return null;
    return el('div', { class: 'item-icons' }, ...icons.map((ic) => this.buildIconCell(ic)));
  }

  buildSection(ctx, group, commit) {
    const fields = group.fields || [];
    const modified = fields.filter((f) => this.isChanged(ctx, f)).length;

    const visible = fields.filter((field) => {
      if (!field.present && !ctx.showAbsent) return false;
      if (ctx.modifiedOnly && !this.isChanged(ctx, field)) return false;
      if (!ctx.search) return true;
      const needle = ctx.search.trim().toLowerCase();
      return (fieldLabel(field.key, field.label) || '').toLowerCase().includes(needle)
          || (field.key || '').toLowerCase().includes(needle);
    });

    if (!visible.length) return { node: null, shown: 0, modified };

    const open = !ctx.closed.has(group.group);
    const details = el('details', { class: 'mob-section', open });
    details.addEventListener('toggle', () => {
      if (details.open) ctx.closed.delete(group.group);
      else ctx.closed.add(group.group);
    });

    details.append(el('summary', {},
      el('span', { class: 'mob-section-name', text: group.group }),
      el('span', { class: 'mob-section-meta',
        text: `${visible.length} 个字段${visible.length === 1 ? '' : ''}` +
              (visible.length !== fields.length ? `，共 ${fields.length}` : '') }),
      modified
        ? el('span', { class: 'mob-section-mod', text: `${modified} 已修改` })
        : null));

    const grid = el('div', { class: 'mob-field-grid' });
    for (const field of visible) grid.append(this.buildField(ctx, field, commit));
    details.append(grid);

    return { node: details, shown: visible.length, modified };
  }

  /**
   * The info > level > info upgrade levels. Each level is its own collapsible
   * section named after the level it reaches; its fields are edited inline like
   * the info fields, writing back through the nested relPath. Levels can be
   * added (seeded with exp=0) and removed from the panel header.
   */
  buildLevelsPanel(ctx, commit) {
    const levels = ctx.detail.levels || [];
    const wrap = el('div', { class: 'mob-levels' });
    let shown = 0;
    let modified = 0;

    const head = el('div', { class: 'mob-levels-head' },
      el('span', { class: 'mob-levels-title', text: `升级等级（${levels.length} 级）` }),
      el('button', {
        class: 'btn btn-sm',
        'data-tip': '新增一个升级等级（留空等级号则自动比当前最高多 1 级）',
        onclick: () => this.openAddLevelDialog(ctx),
      }, icon('plus', { size: 14 }), '新增等级'));
    wrap.append(head);

    for (const level of levels) {
      const fields = level.fields || [];
      const visible = fields.filter((field) => {
        if (ctx.modifiedOnly && !this.isChanged(ctx, field)) return false;
        if (!ctx.search) return true;
        const needle = ctx.search.trim().toLowerCase();
        return (fieldLabel(field.key, field.label) || '').toLowerCase().includes(needle)
            || (field.key || '').toLowerCase().includes(needle);
      });
      if (!visible.length) continue;
      shown += visible.length;
      modified += visible.filter((f) => this.isChanged(ctx, f)).length;

      const details = el('details', { class: 'mob-section' });
      details.append(el('summary', {},
        el('span', { class: 'mob-section-name', text: `升到 ${level.level} 级` }),
        el('span', { class: 'mob-section-meta', text: `${visible.length} 个字段` }),
        el('button', {
          class: 'btn btn-sm btn-icon level-remove',
          'data-tip': `删除“升到 ${level.level} 级”及它的全部字段`,
          onclick: (event) => {
            event.stopPropagation();
            this.openRemoveLevelDialog(ctx, level);
          },
        }, icon('trash', { size: 14 }))));
      const grid = el('div', { class: 'mob-field-grid' });
      for (const field of visible) grid.append(this.buildField(ctx, field, commit));
      details.append(grid);
      wrap.append(details);
    }

    if (!wrap.childElementCount) return { node: null, shown: 0, modified };
    return { node: wrap, shown, modified };
  }

  /** Adds a brand-new upgrade level (defaults to max + 1), seeded with exp = 0. */
  openAddLevelDialog(ctx) {
    const levelInput = el('input', {
      type: 'number', class: 'mob-input', min: '1',
      placeholder: '留空则自动为最高等级 + 1', 'aria-label': '升级等级号',
    });
    const body = el('div', { class: 'mob-bulk-form' },
      el('label', { class: 'mob-field' },
        el('span', { class: 'mob-field-label' }, el('span', { class: 'mob-field-name', text: '等级' })),
        levelInput));
    body.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        body.closest('dialog')?.querySelector('.modal-foot .btn-primary')?.click();
      }
    });

    modal({
      title: '新增升级等级',
      subtitle: `将为装备（${ctx.detail.itemId}）在升级信息中添加一个等级节点，并预置 exp = 0，之后可自行编辑该等级的字段。`,
      width: '420px',
      body,
      actions: [
        { label: '取消', class: 'btn-ghost' },
        {
          label: '新增', class: 'btn-primary', closes: false,
          run: async (closeDialog) => {
            const raw = levelInput.value.trim();
            let level = null;
            if (raw !== '') {
              level = Number(raw);
              if (!Number.isInteger(level) || level <= 0) {
                toastError(new Error('等级必须是正整数。'), '无效等级');
                return false;
              }
            }
            try {
              const r = await api.equipAddLevel(ctx.detail.path, level);
              const next = await api.equipDetail(ctx.detail.path);
              ctx.detail = next;
              ctx.touched = true;
              this.app.markDirty();
              closeDialog();
              ctx.paint?.();
              toast(`已新增升级等级 ${r.level}`, 'success');
            } catch (error) {
              toastError(error, '无法新增等级');
            }
            return false;
          },
        },
      ],
    });
  }

  /** Removes one upgrade-level node after confirmation. */
  openRemoveLevelDialog(ctx, level) {
    confirmDialog({
      title: `删除“升到 ${level.level} 级”？`,
      message: `将删除升级信息中的 ${level.level} 级节点及其全部字段。可通过撤销恢复。`,
      confirmLabel: '删除',
      danger: true,
    }).then(async (ok) => {
      if (!ok) return;
      try {
        await api.equipRemoveLevel(ctx.detail.path, level.level);
        const next = await api.equipDetail(ctx.detail.path);
        ctx.detail = next;
        ctx.touched = true;
        this.app.markDirty();
        ctx.paint?.();
        toast(`已删除升级等级 ${level.level}`, 'success');
      } catch (error) {
        toastError(error, '无法删除等级');
      }
    });
  }

  /** Removes one scalar field (info or upgrade-level) after confirmation. */
  openRemoveFieldDialog(ctx, field) {
    const where = field.relPath.startsWith('info/level/') ? '升级等级' : 'info';
    confirmDialog({
      title: `删除字段“${fieldLabel(field.key, field.label)}”？`,
      message: `将从装备（${ctx.detail.itemId}）的${where}段删除 ${field.relPath}。可通过撤销恢复。`,
      confirmLabel: '删除',
      danger: true,
    }).then(async (ok) => {
      if (!ok) return;
      try {
        await api.equipRemoveField(ctx.detail.path, field.relPath);
        const next = await api.equipDetail(ctx.detail.path);
        ctx.detail = next;
        ctx.touched = true;
        this.app.markDirty();
        ctx.paint?.();
        toast(`已删除字段 ${field.key}`, 'success');
      } catch (error) {
        toastError(error, '无法删除字段');
      }
    });
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
      class: 'mob-field',
      'data-field-key': field.key,
      'data-absent': field.present ? null : 'true',
      'data-changed': changed ? 'true' : null,
    });

    row.append(el('div', { class: 'mob-field-label' },
      el('span', { class: 'mob-field-name', text: fieldLabel(field.key, field.label) }),
      changed ? el('span', { class: 'mob-was', text: `原为 ${was === '' ? '空' : was}` }) : null,
      !field.present ? el('span', { class: 'mob-absent-tag', text: '未设置' }) : null,
      (field.present && field.editable)
        ? el('button', {
            class: 'btn btn-icon field-remove', 'data-tip': `删除字段 ${field.key}`,
            onclick: () => this.openRemoveFieldDialog(ctx, field),
          }, icon('trash', { size: 13 }))
        : null));

    if (field.kind === 'Bool') {
      const box = el('input', { type: 'checkbox', checked: current === '1' });
      box.addEventListener('change', () => {
        const next = box.checked ? '1' : '0';
        commit(field, next, () => { box.checked = current === '1'; });
      });
      row.append(el('label', { class: 'mob-check' }, box,
        el('span', { text: current === '1' ? '开' : '关' })));
    } else {
      const input = el('input', {
        class: 'mob-input', value: current, spellcheck: 'false',
        inputmode: field.kind === 'Int' ? 'numeric' : undefined,
        'aria-label': fieldLabel(field.key, field.label),
        readOnly: !field.editable,
      });
      let committed = current;

      if (field.kind === 'Int') input.addEventListener('focus', () => input.select());

      const send = () => {
        const next = input.value;
        if (next === committed) return;
        if (!field.editable) return;

        if (field.kind === 'Int' && next.trim() !== '' && !Number.isInteger(Number(next))) {
          input.dataset.invalid = 'true';
          input.title = `${fieldLabel(field.key, field.label)} 必须是整数。`;
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

    if (!field.present) {
      row.append(el('div', { class: 'mob-field-hint',
        text: '此装备没有该字段。设置值将创建它。' }));
    }
    return row;
  }

  commitField(ctx, field, value, revert, paint) {
    return this.guard(`field:${ctx.detail.path}:${field.relPath || field.key}`, async () => {
      try {
        const write = { key: field.key, value };
        if (field.relPath) write.relPath = field.relPath;
        await api.equipBulk({ paths: [ctx.detail.path], fields: [write] });
        ctx.touched = true;
        // Fold the write back into the local detail so the section, the counter
        // and (on close) the list all see it without another round trip.
        field.value = value;
        field.present = true;
        if (!ctx.baseline.has(field.key)) ctx.baseline.set(field.key, '');
        this.app.markDirty();
        paint();
      } catch (error) {
        revert?.();
        toastError(error, '无法保存该字段');
      }
    });
  }

  /* ============================================================
     ICONS
     ============================================================ */

  buildIconCell(ic) {
    const img = el('img', {
      class: 'item-icon-thumb', loading: 'lazy',
      src: `/api/thumb?path=${encodeURIComponent(ic.path)}&v=${this.thumbRev}`, alt: '',
      onerror: (event) => { event.target.style.visibility = 'hidden'; },
    });
    const download = el('button', {
      class: 'btn btn-small',
      'data-tip': `导出${ic.label}为 PNG`,
      onclick: () => this.downloadIcon(ic),
    }, icon('download', { size: 13 }), '下载');
    const replace = el('button', {
      class: 'btn btn-small',
      'data-tip': `用 PNG 替换${ic.label}`,
      onclick: () => this.pickIcon(ic),
    }, icon('upload', { size: 13 }), '替换');
    return el('div', { class: 'item-icon-cell' },
      img,
      el('div', { class: 'item-icon-name', text: ic.label }),
      ic.size ? el('div', { class: 'item-icon-size muted', text: ic.size }) : null,
      el('div', { class: 'item-icon-actions' }, download, replace));
  }

  downloadIcon(ic) {
    const equipPath = ic.path.split('/info/')[0];
    const id = equipPath.split('/').pop()?.replace(/\.img$/, '') ?? 'equip';
    const anchor = document.createElement('a');
    anchor.href = `/api/canvas?path=${encodeURIComponent(ic.path)}&v=${this.thumbRev}`;
    anchor.download = `${id}_${ic.key}.png`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  async pickIcon(ic) {
    const dataUrl = await this.choosePng();
    if (!dataUrl) return;
    const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
    const path = ic.path.split('/info/')[0];
    try {
      await api.equipIcon({ path, key: ic.key, pngBase64: base64 });
      this.app.markDirty?.();
      this.thumbRev += 1;
      toast(`已替换 ${ic.label}`);
    } catch (error) {
      toastError(error, '无法替换图标');
    }
  }

  choosePng() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/*';
      input.onchange = () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) { resolve(null); return; }
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      };
      input.click();
    });
  }

  /* ============================================================
     BULK
     ============================================================ */

  openBulkDialog() {
    if (!this.selection.size) return;

    const fieldSelect = el('select', { class: 'mob-select', 'aria-label': '选择字段' },
      BULK_FIELDS.map(([key, label]) => el('option', { value: key, text: `${label} (${key})` })));
    const valueInput = el('input', {
      type: 'number', class: 'mob-input', value: '0',
      placeholder: '0', 'aria-label': '字段值',
    });

    const pickString = () => STRING_FIELDS.has(fieldSelect.value);
    const pickBool = () => ['cash', 'tradeBlock', 'notSale'].includes(fieldSelect.value);
    const refreshValueType = () => {
      if (pickString()) {
        valueInput.type = 'text';
        valueInput.value = valueInput.value || '';
      } else if (pickBool()) {
        valueInput.type = 'checkbox';
      } else {
        valueInput.type = 'number';
        if (valueInput.value === '' || valueInput.value === undefined) valueInput.value = '0';
      }
    };
    fieldSelect.addEventListener('change', refreshValueType);
    refreshValueType();

    const body = el('div', { class: 'mob-bulk-form' },
      el('label', { class: 'mob-field' },
        el('span', { class: 'mob-field-label' },
          el('span', { class: 'mob-field-name', text: '字段' })),
        fieldSelect),
      el('label', { class: 'mob-field' },
        el('span', { class: 'mob-field-label' },
          el('span', { class: 'mob-field-name', text: '值' })),
        valueInput));
    body.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        body.closest('dialog')?.querySelector('.modal-foot .btn-primary')?.click();
      }
    });

    modal({
      title: '批量编辑装备',
      subtitle: `将对勾选的 ${this.selection.size} 个装备设置该字段;缺失的字段会被创建。一次操作可撤销。`,
      width: '420px',
      body,
      actions: [
        { label: '取消', class: 'btn-ghost' },
        {
          label: '应用', class: 'btn-primary', closes: false,
          run: async (closeDialog) => {
            const value = pickBool() ? (valueInput.checked ? '1' : '0') : String(valueInput.value ?? '0');
            try {
              const result = await api.equipBulk({
                paths: [...this.selection],
                fields: [{ key: fieldSelect.value, value }],
              });
              const applied = result.applied ?? 0;
              const skipped = result.skipped ?? 0;
              toast(`已应用到 ${applied} 个装备${skipped ? `,${skipped} 个跳过` : ''}`);
              this.app.markDirty?.();
              closeDialog();
              this.selection.clear();
              this.load();
            } catch (error) {
              toastError(error);
            }
            return false;
          },
        },
      ],
    });
  }
}
