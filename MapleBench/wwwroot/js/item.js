import { api } from './api.js';
import { el, clear, toast, toastError, fmt, modal, debounce, runOnce, busyWhile, busyPanel, confirmDialog } from './ui.js';
import { emptyState } from './inspector.js';
import { icon } from './icons.js';
import { fieldLabel } from './fieldLabels.js';

/**
 * Items section, in the same shape as the Mob editor: a card grid over the
 * open client's Item data, and a per-item field editor in a dialog.
 *
 * The editor is exactly the mob's: fields grouped into collapsible sections,
 * an inline commit per field (blur or Enter writes that one field through
 * /api/item/bulk, no "apply" step), a field search, and the missing-field
 * toggle. The category pills replace the mob's Boss/Undead pills, and the
 * card carries the item's shop price and stack cap instead of HP/EXP.
 */

const PAGE_SIZE = 60;

const CATEGORY_LABELS = {
  Cash: '现金', Consume: '消耗', Etc: '其他', Install: '座椅', Pet: '宠物', Special: '特殊',
};
const categoryLabel = (key) => CATEGORY_LABELS[key] ?? key;

/** Fields offered by the bulk editor, mirroring the backend item catalog. */
const BULK_FIELDS = [
  ['incSTR', '力量加成'], ['incDEX', '敏捷加成'], ['incINT', '智力加成'], ['incLUK', '幸运加成'],
  ['incPAD', '物理攻击'], ['incMAD', '魔法攻击'], ['incPDD', '物理防御'], ['incMDD', '魔法防御'],
  ['incSpeed', '移动速度'], ['incJump', '跳跃力'], ['incMHP', '最大HP'], ['incMMP', '最大MP'],
  ['incACC', '命中率'], ['incEVA', '回避率'], ['tuc', '升级次数'], ['reqLevel', '所需等级'],
  ['reqJob', '所需职业'], ['price', '价格'], ['slotMax', '最大堆叠'],
  ['recoveryHP', '恢复HP'], ['recoveryMP', '恢复MP'], ['only', '专属职业'],
  ['cash', '现金道具'], ['tradeBlock', '交易锁定'], ['notSale', '不可出售'],
];

const BOOL_FIELDS = new Set(['cash', 'tradeBlock', 'notSale']);

/**
 * Preset choices for "增加字段". Picking one fills the WZ key and pre-selects
 * the sensible type; "自定义字段…" falls back to a free-text key. Item info
 * fields are flat scalars under info/ — no nested level structure.
 */
const ADD_FIELD_OPTIONS = [
  { key: 'price', label: '出售价格', type: 'Int' },
  { key: 'slotMax', label: '最大堆叠', type: 'Int' },
  { key: 'cash', label: '现金道具（0不是 1是）', type: 'Bool' },
  { key: 'tradeBlock', label: '不可交易', type: 'Bool' },
  { key: 'equipTradeBlock', label: '装备后不可交易', type: 'Bool' },
  { key: 'notSale', label: '无法出售', type: 'Bool' },
  { key: 'only', label: '固有道具', type: 'Bool' },
  { key: 'timeLimited', label: '时间限制', type: 'Bool' },
  { key: 'expireOnLogout', label: '登出后消失', type: 'Bool' },
  { key: 'recoveryHP', label: '恢复HP', type: 'Int' },
  { key: 'recoveryMP', label: '恢复MP', type: 'Int' },
  { key: 'hpR', label: 'HP恢复%', type: 'Int' },
  { key: 'mpR', label: 'MP恢复%', type: 'Int' },
  { key: 'PAD', label: '增加物理攻击', type: 'Int' },
  { key: 'MAD', label: '增加魔法攻击', type: 'Int' },
  { key: 'PDD', label: '增加物理防御', type: 'Int' },
  { key: 'MDD', label: '增加魔法防御', type: 'Int' },
  { key: 'incSTR', label: '增加力量', type: 'Int' },
  { key: 'incDEX', label: '增加敏捷', type: 'Int' },
  { key: 'incINT', label: '增加智力', type: 'Int' },
  { key: 'incLUK', label: '增加幸运', type: 'Int' },
  { key: 'incPAD', label: '增加物理攻击', type: 'Int' },
  { key: 'incMAD', label: '增加魔法攻击', type: 'Int' },
  { key: 'incPDD', label: '增加物理防御', type: 'Int' },
  { key: 'incMDD', label: '增加魔法防御', type: 'Int' },
  { key: 'incSpeed', label: '增加移动速度', type: 'Int' },
  { key: 'incJump', label: '增加跳跃力', type: 'Int' },
  { key: 'incMHP', label: '增加HP总值', type: 'Int' },
  { key: 'incMMP', label: '增加MP总值', type: 'Int' },
  { key: 'incACC', label: '增加命中率', type: 'Int' },
  { key: 'incEVA', label: '增加回避率', type: 'Int' },
  { key: 'tuc', label: '升级次数', type: 'Int' },
  { key: 'reqLevel', label: '所需等级', type: 'Int' },
  { key: 'reqJob', label: '所需职业', type: 'Int' },
  { key: 'reqSTR', label: '力量需求', type: 'Int' },
  { key: 'reqDEX', label: '敏捷需求', type: 'Int' },
  { key: 'reqINT', label: '智力需求', type: 'Int' },
  { key: 'reqLUK', label: '幸运需求', type: 'Int' },
  { key: 'success', label: '成功率', type: 'Int' },
  { key: 'prob', label: '几率（万分之）', type: 'Int' },
  { key: 'count', label: '获得数量', type: 'Int' },
  { key: 'quest', label: '任务道具', type: 'Int' },
  { key: 'name', label: '名称', type: 'String' },
  { key: 'desc', label: '描述', type: 'String' },
];

export class ItemSection {
  constructor({ host, app }) {
    this.host = host;
    this.app = app;
    this.fileId = null;
    this.page = 1;
    this.query = '';
    this.categoryFilter = '';
    this.dirtyOnly = false;
    this.thumbRev = 0;

    this.capabilities = { available: false };
    this.items = [];
    this.total = 0;
    this.categories = {};
    this.truncated = false;
    this.error = null;
    this.loading = false;
    this.loaded = false;

    this.selection = new Set();
  }

  async guard(key, run) {
    try {
      await runOnce(`item:${key}`, run);
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
        this.capabilities = await api.itemCapabilities();
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
        category: this.categoryFilter || undefined,
        dirtyOnly: this.dirtyOnly ? true : undefined,
      };
      const list = await api.itemList(this.fileId, params);
      this.items = list.items || [];
      this.total = list.total || 0;
      this.categories = list.categories || {};
      this.truncated = Boolean(list.truncated);
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
    return Boolean(this.query || this.categoryFilter || this.dirtyOnly);
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
        'alert', '物品编辑器渲染出错',
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
        'alert', '无法读取物品列表',
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
        title: '正在读取物品…',
        note: '完整的 Item 目录包含上万件物品，首次读取可能需要数秒。之后在数据发生变化前都会瞬时完成。',
        className: 'mob-panel',
      }));
      return;
    }

    if (!this.capabilities.available) {
      this.host.append(emptyState(
        'box', '未打开物品数据',
        '物品编辑会读取 Item 目录中的物品图片（Cash/Consume/Etc/Install/Pet/Special）。请打开整个客户端文件夹。',
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
    const candidates = this.app.files.filter((file) => /^item/i.test(file.name));
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
        el('div', { class: 'mob-head-title', text: '物品' }),
        el('div', { class: 'mob-head-sub' },
          el('span', { text: '正在编辑 ' }),
          el('b', { text: subject }),
          el('span', {
            text: this.loaded
              ? ` · ${fmt.format(this.total)} 个物品`
                + (this.capabilities.names === false ? ' · String.wz 未打开,物品将没有名称' : '')
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
      class: 'btn btn-icon', 'data-tip': '重新加载物品列表',
      onclick: () => this.load(),
    }, icon('refresh', { size: 15 })));

    return head;
  }

  buildToolbar() {
    const search = el('input', {
      type: 'search', value: this.query,
      placeholder: '按物品 ID、名称、分类或系列搜索…',
      'aria-label': '搜索物品',
    });
    search.addEventListener('input', debounce(() => {
      this.query = search.value;
      this.page = 1;
      this.reload();
    }, 160));

    const chips = el('div', { class: 'cat-tabs' },
      [['', '全部'], ...Object.entries(this.categories)].map(([value, count]) => {
        const key = value === '' ? '' : value;
        const label = value === '' ? '全部' : categoryLabel(value);
        return el('button', {
          class: 'cat-tab', 'aria-pressed': this.categoryFilter === key ? 'true' : 'false',
          onclick: () => { this.categoryFilter = key; this.page = 1; this.reload(); },
        }, label, key ? el('span', { class: 'cat-count', text: fmt.format(count) }) : null);
      }));

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
        chips,
        dirty),
      this.buildSelectionBar(),
      this.truncated
        ? el('div', { class: 'notice', 'data-tone': 'warn' }, icon('alert', { size: 14 }),
            el('span', { text: '存档中的物品数量超过单次列表返回的数量，因此这是部分列表。请限定到单个分类，或使用搜索，以确保看到全部内容。' }))
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
      el('span', { text: `${fmt.format(this.total)} 个物品${this.categoryFilter ? ` · ${categoryLabel(this.categoryFilter)}` : ''}` }),
      el('span', { text: `第 ${this.page} 页，共 ${pages} 页` })));

    if (!this.items.length) {
      panel.append(emptyState(
        'search',
        this.filterActive ? `没有匹配“${this.query || this.categoryFilter || '未保存'}”的物品` : '此存档中没有物品',
        this.filterActive
          ? '调整筛选条件后再试。'
          : '存档已打开，但其中没有任何带 info 的物品图片。'));
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
      'aria-label': `选择 ${item.name || `物品 ${item.itemId}`}`,
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
      : el('span', { class: 'mob-sprite', style: 'width:44px;height:44px' }, icon('box', { size: 16 }));

    const badges = el('div', { class: 'mob-badges' },
      el('span', { class: 'mob-badge', 'data-kind': 'undead', text: categoryLabel(item.category) }),
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
            class: 'mob-title', text: item.name || `物品 ${item.itemId}`,
            'data-tip': '打开此物品', onclick: (event) => this.openItemCard(item, event.currentTarget),
          }),
          el('div', { class: 'mob-sub', text: `ID ${item.itemId} · ${item.series}` }))),
      badges.childElementCount ? badges : null,
      item.price ? stat('价格', fmt.format(item.price)) : null,
      item.slotMax ? stat('堆叠上限', fmt.format(item.slotMax)) : null,
      el('div', { class: 'mob-actions' },
        el('button', { class: 'btn btn-sm', style: 'flex:1',
                       onclick: (event) => this.openItemCard(item, event.currentTarget) },
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
      { icon: 'edit', label: '编辑属性…', run: () => this.openItemCard(item) },
      { icon: 'copy', label: `复制物品 ID ${item.itemId}`, run: () => this.app.copyText(String(item.itemId)) },
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
     ITEM CARD (the dialog)
     ============================================================ */

  openItemCard(item, trigger = null) {
    return this.guard(`card:${item.path}`,
      () => busyWhile(trigger, this.buildItemCard(item)));
  }

  async buildItemCard(item) {
    let detail;
    try {
      detail = await api.itemDetail(item.path);
    } catch (error) {
      toastError(error, '无法读取该物品');
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
      'data-tip': '此物品没有的字段。写入一个即可创建它。',
      onclick: () => {
        ctx.showAbsent = !ctx.showAbsent;
        absentToggle.setAttribute('aria-pressed', ctx.showAbsent ? 'true' : 'false');
        paint();
      },
    }, icon('plus', { size: 14 }), '显示缺失字段');

    const addFieldButton = el('button', {
      class: 'btn btn-sm',
      'data-tip': '为此物品添加一个自定义字段（数值 / 文本 / 开关），不必是已有字段',
      onclick: () => this.openAddFieldDialog(ctx),
    }, icon('plus', { size: 14 }), '增加字段');

    const paint = () => {
      clear(headHost);
      headHost.append(this.buildDetailHead(ctx));

      clear(sectionsHost);

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

      if (!shown) {
        sectionsHost.append(emptyState(
          'search',
          ctx.search ? `没有匹配“${ctx.search}”的字段` : '没有可显示的内容',
          ctx.modifiedOnly
            ? '此物品还没有任何更改。请关闭“仅显示已修改”。'
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
      title: ctx.item.name || `物品 ${ctx.item.itemId}`,
      subtitle: ctx.item.path.split('/').slice(1).join('/'),
      width: 'min(96vw, 880px)',
      body,
      actions: [{ label: '完成' }],
    });
    ctx.close = close;

    dialog.addEventListener('close', () => { if (ctx.touched) this.load(); }, { once: true });
  }

  /**
   * Adds a brand-new field to the item's info section. Item info is flat
   * scalars, so no nested path is involved: the bulk writer creates the field
   * (SetOrCreate) with the chosen WZ type.
   */
  openAddFieldDialog(ctx) {
    const keySelect = el('select', { class: 'mob-select', 'aria-label': '字段名' },
      el('option', { value: '', text: '自定义字段…' }),
      ...ADD_FIELD_OPTIONS.map((o) => el('option', { value: o.key, text: `${o.label}（${o.key}）` })));
    const keyInput = el('input', {
      type: 'text', class: 'mob-input', placeholder: '如 customStat', 'aria-label': '自定义字段名',
      spellcheck: 'false', style: 'display:none',
    });
    const typeSelect = el('select', { class: 'mob-select', 'aria-label': '字段类型' },
      el('option', { value: 'Int', text: '整数（数值属性，如 0/1/40）' }),
      el('option', { value: 'String', text: '文本（名称/描述类）' }),
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
      title: '增加物品字段',
      subtitle: `将为此物品（${ctx.detail.itemId}）添加一个字段到 info 段。名称不能与已有字段重复。`,
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
              toastError(new Error('自定义字段名须以字母开头，只能包含字母和数字。'), '无效字段名');
              return false;
            }
            const present = (ctx.detail.fields || []).filter((f) => f.present);
            const existing = present.find((f) => f.key.toLowerCase() === key.toLowerCase());
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
              const result = await api.itemBulk({
                paths: [ctx.detail.path],
                fields: [{ key, value, type }],
              });
              if ((result.skipped ?? 0) > 0) {
                toastError(new Error(result.changes?.[0]?.reason ?? '创建失败'), '无法创建字段');
                return false;
              }
              // Re-fetch so the new field appears under its right group.
              const next = await api.itemDetail(ctx.detail.path);
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

  /** Removes one scalar info field after confirmation. */
  openRemoveFieldDialog(ctx, field) {
    confirmDialog({
      title: `删除字段“${fieldLabel(field.key, field.label)}”？`,
      message: `将从物品（${ctx.detail.itemId}）的 info 段删除 ${field.key}。可通过撤销恢复。`,
      confirmLabel: '删除',
      danger: true,
    }).then(async (ok) => {
      if (!ok) return;
      try {
        await api.itemRemoveField(ctx.detail.path, field.key);
        const next = await api.itemDetail(ctx.detail.path);
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

  buildDetailHead(ctx) {
    const item = ctx.item;
    return el('div', { class: 'mob-detail-head' },
      el('div', {},
        el('div', { class: 'mob-detail-name', text: item.name || `物品 ${item.itemId}` }),
        el('div', { class: 'mob-sub', text: `ID ${item.itemId} · ${categoryLabel(item.category)} / ${item.series}` })),
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
        text: '此物品没有该字段。设置值将创建它。' }));
    }
    return row;
  }

  commitField(ctx, field, value, revert, paint) {
    return this.guard(`field:${ctx.detail.path}:${field.key}`, async () => {
      try {
        await api.itemBulk({ paths: [ctx.detail.path], fields: [{ key: field.key, value }] });
        ctx.touched = true;
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
    const itemPath = ic.path.split('/info/')[0];
    const id = itemPath.split('/').pop()?.replace(/\.img$/, '') ?? 'item';
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
      await api.itemIcon({ path, key: ic.key, pngBase64: base64 });
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

    const pickBool = () => BOOL_FIELDS.has(fieldSelect.value);
    const refreshValueType = () => {
      if (pickBool()) {
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
      title: '批量编辑物品',
      subtitle: `将对勾选的 ${this.selection.size} 个物品设置该字段;缺失的字段会被创建。一次操作可撤销。`,
      width: '420px',
      body,
      actions: [
        { label: '取消', class: 'btn-ghost' },
        {
          label: '应用', class: 'btn-primary', closes: false,
          run: async (closeDialog) => {
            const value = pickBool() ? (valueInput.checked ? '1' : '0') : String(valueInput.value ?? '0');
            try {
              const result = await api.itemBulk({
                paths: [...this.selection],
                fields: [{ key: fieldSelect.value, value }],
              });
              const applied = result.applied ?? 0;
              const skipped = result.skipped ?? 0;
              toast(`已应用到 ${applied} 个物品${skipped ? `,${skipped} 个跳过` : ''}`);
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
