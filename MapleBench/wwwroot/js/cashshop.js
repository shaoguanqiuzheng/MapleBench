/**
 * Cash Shop mode: a card grid over Etc.wz/Commodity.img.
 *
 * Every write goes through the same edit API as the Explorer, so cash shop
 * changes share one dirty state, one undo history and one save pipeline.
 */

import { api } from './api.js';
import { el, clear, toast, toastError, fmt, modal, confirmDialog, debounce, runOnce,
         busyPanel, busyWhile, statChip, statRow, scalePixelArt, motionIn, motionOut } from './ui.js';
import { emptyState } from './inspector.js';
import { iconUrl } from './media.js';
import { icon } from './icons.js';

const PAGE_SIZE = 60;
const GENDERS = [[2, '通用'], [0, '男'], [1, '女']];

export class CashShop {
  constructor({ host, app }) {
    this.host = host;
    this.app = app;

    this.fileId = null;
    this.items = [];
    this.stats = null;
    this.categories = [];
    this.duplicateSerials = [];

    this.category = 'All';
    this.subCategory = null;
    this.query = '';
    this.onSaleOnly = false;
    this.view = localStorage.getItem('mb.shopView') || 'grid';
    this.page = 1;

    this.capabilities = { icons: false, names: false };
    this.popover = null;
    this.popoverTimer = null;
    this.popoverLastClosedAt = 0;

    /**
     * True until the first load settles.
     *
     * open() painted the chrome immediately and its comment claimed that was
     * "a loading body" -- it was not. With items still empty, the results panel
     * reached its empty state and announced "Nothing in this category" over a
     * stats row of zeroes, while the request that would fill it was still in
     * the air. Cheap to read as "this archive has no cash shop data", which is
     * the opposite of what was happening.
     */
    this.loading = false;
  }

  /**
   * Runs a mutation at most once at a time, reporting anything it throws.
   *
   * Every write here is a POST behind a button that stays live while it is in
   * the air, so a double-click issued the request twice -- two items with the
   * same serial, or a delete followed by a delete of whatever took its place.
   * The keys are namespaced because the in-flight set is shared with the rest
   * of the app.
   */
  async guard(key, run) {
    try {
      await runOnce(`shop:${key}`, run);
    } catch (error) {
      toastError(error);
    }
  }

  async open(fileId) {
    this.fileId = fileId;
    this.page = 1;
    this.render();          // paints the chrome with a loading body
    await this.load();
  }

  async load() {
    this.loading = true;
    if (!this.items.length) this.render();
    try {
      const [data, caps] = await Promise.all([
        api.shopItems(this.fileId, true),
        api.shopCapabilities().catch(() => ({ icons: false, names: false })),
      ]);
      this.items = data.items;
      this.stats = data.stats;
      this.categories = data.categories;
      this.duplicateSerials = data.duplicateSerials || [];
      this.capabilities = caps;
      this.loading = false;
      this.render();

      if (this.duplicateSerials.length) {
        toast(
          `${this.duplicateSerials.length} 个序列号${this.duplicateSerials.length === 1 ? '' : ''}被多个道具使用: ` +
          `${this.duplicateSerials.slice(0, 6).join(', ')}${this.duplicateSerials.length > 6 ? '…' : ''}。` +
          '重复的 SN 会导致道具在游戏中无法购买。',
          'warning', { title: '重复的序列号' });
      }
    } catch (error) {
      this.loading = false;
      clear(this.host);
      this.host.append(emptyState(
        'cart', '此处没有商城数据',
        error.message,
        el('button', { class: 'btn btn-primary', onclick: () => this.app.openFilePicker() }, icon('folderOpen', { size: 15 }), '打开 Etc.wz')));
    }
  }

  /* ============================================================
     FILTERING
     ============================================================ */

  get filtered() {
    const needle = this.query.trim().toLowerCase();
    return this.items.filter((item) => {
      if (this.onSaleOnly && !item.onSale) return false;
      if (this.category !== 'All' && item.category !== this.category) return false;
      if (this.subCategory && item.subCategory !== this.subCategory) return false;
      if (!needle) return true;
      return String(item.itemId).includes(needle)
          || String(item.sn).includes(needle)
          || (item.itemName || '').toLowerCase().includes(needle);
    });
  }

  /* ============================================================
     RENDER
     ============================================================ */

  render() {
    clear(this.host);
    this.host.className = 'stage-body shop';

    // Nothing to show yet and nothing known about the archive. Anything drawn
    // here would be a claim about data that has not arrived.
    if (this.loading && !this.items.length) {
      this.host.append(busyPanel({
        title: '正在读取商城…',
        note: '读取 Commodity.img 以及 String.wz 中的道具名称 — 只需一两秒，'
            + '之后即可瞬时完成。',
      }));
      return;
    }

    this.statsHost = el('div');
    this.categoryHost = el('div');
    this.resultHost = el('div');

    // statRow returns null when nothing has been read yet, and Element.append
    // stringifies a null into the word "null" rather than skipping it.
    const stats = this.buildStats();
    if (stats) this.statsHost.append(stats);
    this.categoryHost.append(this.buildCategories());
    this.host.append(this.statsHost, this.categoryHost, this.buildToolbar(), this.resultHost);

    this.renderResults();
  }

  /** Redraws only the result panel, leaving the search box untouched. */
  renderResults() {
    if (!this.resultHost) { this.render(); return; }

    // The popover is anchored to a card but lives on document.body, so throwing
    // the cards away detaches the anchor without any mouseleave firing. Left
    // alone, a pending timer then measured a detached node (all zeros) and
    // stranded a preview at the top-left of the window with nothing able to
    // dismiss it.
    clearTimeout(this.popoverTimer);
    this.hidePopover();

    clear(this.resultHost);

    const results = this.filtered;
    const pages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
    this.page = Math.min(this.page, pages);
    const slice = results.slice((this.page - 1) * PAGE_SIZE, this.page * PAGE_SIZE);

    const panel = el('div', { class: 'shop-panel' });
    panel.append(el('div', { class: 'shop-result-head' },
      el('span', { text: `${fmt.format(results.length)} 项${results.length === 1 ? '' : ''}` +
                          (this.onSaleOnly ? ' 在售' : '') }),
      el('span', { text: `第 ${this.page} 页，共 ${pages} 页` })));

    if (!results.length) {
      panel.append(emptyState(
        'search',
        this.query ? `没有匹配“${this.query}”的道具` : '此分类中没有道具',
        this.query ? '试试道具 ID、序列号或名称的一部分。' : '添加道具以开始。',
        this.query
          ? el('button', { class: 'btn', text: '清除搜索', onclick: () => { this.query = ''; this.render(); } })
          : el('button', { class: 'btn btn-primary', onclick: () => this.openItemDialog() }, icon('plus', { size: 15 }), '添加道具')));
    } else {
      panel.append(this.view === 'grid' ? this.buildGrid(slice) : this.buildTable(slice));
      if (pages > 1) panel.append(this.buildPager(pages));
    }

    this.resultHost.append(panel);
  }

  buildStats() {
    const s = this.stats || {};
    return statRow('shop-stats', [
      // The total earns a box even at zero -- a Commodity.img with nothing in
      // it is the answer, not the absence of one. "On sale 0" and a mean price
      // of nothing are not: they are boxes reporting that nothing happened.
      statChip('道具总数', s.total ?? null, { drop: false }),
      statChip('在售', s.onSale ?? null, { tone: 'green' }),
      statChip('平均价格', s.averagePrice ?? null, { tone: 'purple',
        text: s.averagePrice ? `${fmt.format(s.averagePrice)} NX` : undefined }),
    ]);
  }

  buildCategories() {
    const panel = el('div', { class: 'shop-panel' });
    panel.append(el('div', { class: 'shop-panel-title' },
      el('span', { text: '分类' }),
      this.subCategory
        ? el('span', {
            style: 'margin-left:auto;color:var(--blue-ink);font-weight:600;text-transform:none;letter-spacing:0',
            text: `${this.category} › ${this.subCategory}`,
          })
        : null));

    const tabs = el('div', { class: 'cat-tabs' });
    const makeTab = (name, count, active, onclick) => el('button', {
      class: 'cat-tab', 'aria-pressed': active ? 'true' : 'false', onclick,
    }, name, count != null ? el('span', { class: 'cat-count', text: fmt.format(count) }) : null);

    tabs.append(makeTab('全部道具', this.items.length, this.category === 'All', () => {
      this.category = 'All'; this.subCategory = null; this.page = 1; this.render();
    }));

    for (const category of this.categories) {
      tabs.append(makeTab(category.name, category.count, this.category === category.name, () => {
        this.category = category.name;
        this.subCategory = null;
        this.page = 1;
        this.render();
      }));
    }
    panel.append(tabs);

    // Sub-categories only appear once a parent is chosen, so the row stays short.
    const current = this.categories.find((c) => c.name === this.category);
    if (current?.subCategories?.length) {
      const subs = el('div', { class: 'cat-tabs', style: 'margin-top:10px' });
      subs.append(makeTab('全部', current.count, !this.subCategory, () => {
        this.subCategory = null; this.page = 1; this.render();
      }));
      for (const sub of current.subCategories) {
        subs.append(makeTab(sub.name, sub.count, this.subCategory === sub.name, () => {
          this.subCategory = sub.name; this.page = 1; this.render();
        }));
      }
      panel.append(subs);
    }
    return panel;
  }

  buildToolbar() {
    const search = el('input', {
      type: 'search', value: this.query,
      placeholder: '按道具 ID、序列号或名称搜索…',
      'aria-label': '搜索道具',
    });
    // Only the results are re-rendered, never the toolbar holding this input.
    // Re-creating it destroyed the caret position, dropped IME composition
    // outright (unusable for Korean/Japanese/Chinese input, which is most of
    // this user base), and lost characters typed during the debounce.
    search.addEventListener('input', debounce(() => {
      this.query = search.value;
      this.page = 1;
      this.renderResults();
    }, 160));

    const viewButton = (mode, iconName, label) => el('button', {
      'aria-pressed': this.view === mode ? 'true' : 'false',
      'data-tip': label, 'aria-label': label,
      onclick: () => { this.view = mode; localStorage.setItem('mb.shopView', mode); this.render(); },
    }, icon(iconName, { size: 15 }));

    return el('div', { class: 'shop-panel' },
      el('div', { class: 'shop-toolbar' },
        el('div', { class: 'shop-search' }, el('span', { class: 'icon' }, icon('search', { size: 15 })), search),
        el('button', {
          class: 'btn',
          text: '仅在售',
          'aria-pressed': this.onSaleOnly ? 'true' : 'false',
          onclick: () => { this.onSaleOnly = !this.onSaleOnly; this.page = 1; this.render(); },
        }),
        el('div', { class: 'view-toggle' }, viewButton('grid', 'grid', '网格视图'), viewButton('list', 'list', '列表视图')),
        el('button', { class: 'btn btn-primary', onclick: () => this.openItemDialog() }, icon('plus', { size: 15 }), '添加道具'),
        el('button', { class: 'btn', onclick: () => this.openBulkDialog() }, icon('list', { size: 15 }), '批量添加')));
  }

  buildGrid(items) {
    const grid = el('div', { class: 'item-grid' });
    for (const item of items) grid.append(this.buildCard(item));
    return grid;
  }

  buildCard(item) {
    const thumb = el('div', { class: 'item-thumb' });
    if (this.capabilities.icons) {
      const img = el('img', { alt: '', loading: 'lazy' });
      img.addEventListener('error', () => {
        img.remove();
        thumb.append(el('span', { class: 'placeholder' }, icon('image', { size: 22 })));
      });
      img.addEventListener('load', () => scalePixelArt(img, 96, 72));
      thumb.append(img);
      img.src = iconUrl(item.itemId);
    } else {
      thumb.append(el('span', { class: 'placeholder' }, icon('image', { size: 22 })));
    }

    const card = el('div', { class: 'item-card', 'data-item-id': item.itemId, 'data-sn': item.sn });

    card.append(
      thumb,
      el('div', { class: 'item-head' },
        el('div', {},
          el('div', { class: 'item-title', text: item.itemName || `道具 ${item.itemId}` }),
          el('div', { class: 'item-sub', text: `ID ${item.itemId} · SN ${item.sn}` })),
        el('span', { class: `pill ${item.onSale ? 'pill-sale' : 'pill-off'}`, text: item.onSale ? '在售' : '未上架' })),
      el('div', { class: 'item-row' }, el('span', { class: 'k', text: '$' }),
        el('span', { class: 'v', text: `${fmt.format(item.price)} NX` })),
      el('div', { class: 'item-row' }, el('span', { class: 'k', text: '数量' }),
        el('span', { class: 'v', text: fmt.format(item.count) })),
      item.period > 0
        ? el('div', { class: 'item-row', 'data-tone': 'warn' }, `${item.period} 天限时`)
        : el('div', { class: 'item-row' }, el('span', { class: 'k', text: '时限' }),
            el('span', { class: 'v', text: '永久' })),
      el('div', { class: 'item-actions' },
        el('button', { class: 'btn btn-sm', style: 'flex:1', onclick: () => this.openItemDialog(item) },
          icon('edit', { size: 14 }), '编辑'),
        el('button', {
          class: 'btn btn-sm btn-icon', 'data-tip': '更多',
          onclick: (event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            this.app.showMenu([
              { icon: 'copy', label: '以新序列号复制', run: () => this.clone(item) },
              { icon: 'trash', label: '删除道具', danger: true, run: () => this.remove(item) },
            ], rect.left, rect.bottom + 4);
          },
        }, icon('more', { size: 15 }))));

    // Hover preview, with the delay that stops a flood while scanning the grid.
    card.addEventListener('mouseenter', () => {
      if (!this.capabilities.icons) return;
      clearTimeout(this.popoverTimer);
      const warm = Date.now() - this.popoverLastClosedAt < 600;
      this.popoverTimer = setTimeout(() => this.showPopover(card, item), warm ? 100 : 400);
    });
    card.addEventListener('mouseleave', () => {
      clearTimeout(this.popoverTimer);
      this.popoverTimer = setTimeout(() => this.hidePopover(), 120);
    });

    return card;
  }

  showPopover(anchor, item) {
    this.hidePopover(true);
    // The card may have been re-rendered away during the hover delay.
    if (!anchor.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    const node = el('div', { class: 'item-popover' },
      el('div', { class: 'cap', text: '预览' }),
      el('div', { class: 'stage checker' }, (() => {
        const big = el('img', { alt: '' });
        big.addEventListener('load', () => scalePixelArt(big, 168, 112));
        big.src = iconUrl(item.itemId);
        return big;
      })()),
      el('div', { style: 'margin-top:8px;text-align:center' },
        el('div', { style: 'font-weight:700;font-size:var(--fs-13)', text: item.itemName || `道具 ${item.itemId}` }),
        el('div', { style: 'font-size:var(--fs-11);color:var(--text-3)',
          text: `${item.itemId} · ${item.category}${item.subCategory ? ' › ' + item.subCategory : ''}` })));

    node.style.left = `${Math.min(rect.right + 12, window.innerWidth - 216)}px`;
    node.style.top = `${Math.min(rect.top, window.innerHeight - 240)}px`;
    document.body.append(node);
    this.popover = node;
    motionIn(node, { unhide: false, timeout: 220 });
  }

  hidePopover(immediate = false) {
    const node = this.popover;
    this.popover = null;
    if (!node) return;
    this.popoverLastClosedAt = Date.now();
    if (immediate) node.remove();
    else motionOut(node, { remove: true, timeout: 150 });
  }

  buildTable(items) {
    const body = el('tbody');
    for (const item of items) {
      body.append(el('tr', { 'data-item-id': item.itemId },
        el('td', { text: item.sn }),
        el('td', { text: item.itemId }),
        el('td', { text: item.itemName || '—', style: 'font-variant-numeric:normal' }),
        el('td', { text: fmt.format(item.price) }),
        el('td', { text: item.count }),
        el('td', { text: item.period || '∞' }),
        el('td', {}, el('span', {
          class: `pill ${item.onSale ? 'pill-sale' : 'pill-off'}`,
          text: item.onSale ? '是' : '否',
        })),
        el('td', {},
          el('button', { class: 'btn btn-sm btn-ghost', onclick: () => this.openItemDialog(item) }, icon('edit', { size: 14 }), '编辑'),
          el('button', { class: 'btn btn-sm btn-icon btn-danger-ghost', 'data-tip': '删除',
            onclick: () => this.remove(item) }, icon('trash', { size: 14 })))));
    }

    return el('div', { style: 'overflow-x:auto' },
      el('table', { class: 'item-table' },
        el('thead', {}, el('tr', {},
          ['SN', '道具 ID', '名称', '价格', '数量', '时限', '在售', ''].map((h) => el('th', { text: h })))),
        body));
  }

  buildPager(pages) {
    const pager = el('div', { class: 'pager' });
    // Only the rows change when paging, so the toolbar and its search box
    // are left alone.
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

  /* ============================================================
     MUTATIONS
     ============================================================ */

  clone(item) {
    return this.guard(`clone:${item.key}`, async () => {
      try {
        const created = await api.shopClone(this.fileId, item.key, null);
        toast(`已复制为 SN ${created.sn}。`, 'success');
        this.app.markDirty();
        await this.load();
      } catch (error) {
        toastError(error, '无法复制该道具');
      }
    });
  }

  remove(item) {
    return this.guard(`remove:${item.key}`, async () => {
      const ok = await confirmDialog({
        title: '删除此商城道具？',
        message: `道具 ${item.itemId}（SN ${item.sn}）将从 Commodity.img 中移除。` +
                 '在保存前不会写入磁盘，且你可以撤销此操作。',
        confirmLabel: '删除道具',
      });
      if (!ok) return;

      try {
        await api.shopDelete(this.fileId, [item.key]);
        toast('道具已删除。', 'success', {
          // The undo restores the entry server-side; without the reload the grid
          // kept showing it as gone.
          action: { label: '撤销', run: async () => { await this.app.undo(); await this.load(); } },
        });
        this.app.markDirty();
        await this.load();
      } catch (error) {
        toastError(error, '无法删除该道具');
      }
    });
  }

  /* ============================================================
     ADD / EDIT DIALOG
     ============================================================ */

  openItemDialog(existing) {
    // Guarded because the serial is fetched *before* modal() runs: two fast
    // clicks raced for the single shared <dialog>, the second wiping the first
    // form while its submit closure still pointed at it, and both got the same
    // serial.
    return this.guard('item-dialog', () => this.buildItemDialog(existing));
  }

  async buildItemDialog(existing) {
    const editing = Boolean(existing);
    let defaultSn = existing?.sn;
    if (!editing) {
      try { defaultSn = (await api.shopNextSn(this.fileId)).sn; } catch { defaultSn = ''; }
    }

    const field = (name, label, value, opts = {}) => {
      const input = el('input', {
        name, value: value ?? '', type: opts.type || 'text',
        placeholder: opts.placeholder || '', inputmode: opts.type === 'number' ? 'numeric' : undefined,
      });
      input.addEventListener('focus', () => input.select());
      return el('div', { class: `field ${opts.span ? 'span-2' : ''}` },
        el('label', { text: label }), input,
        opts.hint ? el('div', { class: 'field-hint', text: opts.hint }) : null);
    };

    const genderSelect = el('select', { name: 'gender' },
      GENDERS.map(([v, label]) => el('option', { value: v, text: label, selected: (existing?.gender ?? 2) === v })));

    const form = el('form', { id: 'shop-item-form' },
      el('div', { class: 'form-grid' },
        field('itemId', '道具 ID *', existing?.itemId, { type: 'number', placeholder: '例如 5000000' }),
        field('sn', '序列号 (SN) *', defaultSn, { type: 'number', placeholder: '例如 10000001' }),
        field('price', '价格 (NX)', existing?.price ?? 0, { type: 'number' }),
        field('count', '数量', existing?.count ?? 1, { type: 'number' }),
        field('period', '时限（天）', existing?.period ?? 0, { type: 'number', hint: '0 = 永久' }),
        field('bonus', '奖励', existing?.bonus ?? 0, { type: 'number' }),
        field('priority', '优先级', existing?.priority ?? 0, { type: 'number' }),
        el('div', { class: 'field' }, el('label', { text: '性别' }), genderSelect)),

      el('div', { style: 'display:flex;gap:20px;margin:14px 0' },
        el('label', { class: 'check-row' },
          el('input', { type: 'checkbox', name: 'onSale', checked: existing ? existing.onSale : true }), '在售'),
        el('label', { class: 'check-row' },
          el('input', { type: 'checkbox', name: 'pbGift', checked: (existing?.pbGift ?? 0) !== 0 }), '可赠送')),

      el('details', {},
        el('summary', {
          style: 'cursor:pointer;color:var(--coral-ink);font-weight:600;font-size:var(--fs-13);margin-bottom:10px',
          text: '高级设置',
        }),
        el('div', { class: 'form-grid' },
          field('reqPop', '所需人气', existing?.reqPop ?? 0, { type: 'number' }),
          field('reqLev', '所需等级', existing?.reqLev ?? 0, { type: 'number' }),
          field('class', '职业', existing?.class ?? 0, { type: 'number' }),
          field('limit', '购买限制', existing?.limit ?? 0, { type: 'number' }),
          field('pbCash', 'PbCash', existing?.pbCash ?? 0, { type: 'number' }),
          field('pbPoint', 'PbPoint', existing?.pbPoint ?? 0, { type: 'number' }))));

    modal({
      title: editing ? `编辑道具 ${existing.itemId}` : '添加新道具',
      width: '520px',
      body: form,
      actions: [
        { label: '取消' },
        {
          label: editing ? '保存道具' : '添加道具',
          class: 'btn-primary',
          run: (close) => { this.submitItem(form, existing, close); return false; },
        },
      ],
      onOpen: () => form.querySelector('input[name="itemId"]')?.focus(),
    });
  }

  // Guarded and wrapped whole: reading the form and confirming a duplicate
  // serial used to sit outside the try, so a throw there was an unhandled
  // rejection with no toast at all, and the button stayed live across the
  // confirm so a second click could post the same item twice.
  submitItem(form, existing, close) {
    return this.guard('item-submit', () => this.sendItem(form, existing, close));
  }

  async sendItem(form, existing, close) {
    const data = new FormData(form);
    const num = (name) => Number(data.get(name) || 0);

    const itemId = num('itemId');
    const sn = num('sn');
    if (!itemId || !sn) {
      toast('道具 ID 和序列号均为必填项。', 'warning');
      return;
    }

    // A duplicate SN makes the item unbuyable, so it is worth a hard stop.
    const clash = this.items.find((i) => i.sn === sn && i.key !== existing?.key);
    if (clash) {
      const ok = await confirmDialog({
        title: '该序列号已被使用',
        message: `SN ${sn} 已属于道具 ${clash.itemId}。两个条目共用同一序列号` +
                 '通常会导致两者在游戏中都无法购买。仍然使用吗？',
        confirmLabel: '仍然使用',
      });
      if (!ok) return;
    }

    try {
      await api.shopUpsert({
        fileId: this.fileId,
        key: existing?.key ?? null,
        itemId, sn,
        price: num('price'),
        count: num('count') || 1,
        period: num('period'),
        bonus: num('bonus'),
        priority: num('priority'),
        gender: num('gender'),
        onSale: data.get('onSale') === 'on',
        reqPop: num('reqPop'),
        reqLev: num('reqLev'),
        class: num('class'),
        limit: num('limit'),
        pbCash: num('pbCash'),
        pbPoint: num('pbPoint'),
        // PbGift is a number in the WZ, shown here as a tickbox. Leaving it
        // ticked hands back whatever the item already had, so editing only the
        // price of an item with PbGift = 5 no longer quietly narrows it to 1.
        pbGift: data.get('pbGift') === 'on' ? (existing?.pbGift || 1) : 0,
      });
      close();
      toast(existing ? '道具已更新。' : `道具 ${itemId} 已添加。`, 'success');
      this.app.markDirty();
      await this.load();
    } catch (error) {
      toastError(error, '无法保存该道具');
    }
  }

  /* ============================================================
     BULK ADD
     ============================================================ */

  openBulkDialog() {
    return this.guard('bulk-dialog', () => this.buildBulkDialog());
  }

  async buildBulkDialog() {
    let nextSn = 10000000;
    try { nextSn = (await api.shopNextSn(this.fileId)).sn; } catch { /* keep the default */ }

    // Handed out strictly in sequence rather than derived from the row count:
    // removing a row used to hand the same serial out twice, and could collide
    // with one already sitting in the table.
    const takeSn = () => nextSn++;

    const body = el('tbody');
    const table = el('table', { class: 'bulk-table' },
      el('thead', {}, el('tr', {},
        ['#', '道具 ID *', '序列号 *', '价格', '数量', '时限', '奖励', '优先级', '性别', '在售', '']
          .map((h) => el('th', { text: h })))),
      body);

    const addRow = (seed = {}, after = null) => {
      const cell = (name, value, width = '') => el('td', {},
        el('input', {
          type: 'number', name, value: value ?? '', style: width ? `width:${width}` : '',
          'data-required': name === 'itemId' || name === 'sn' ? 'true' : null,
          placeholder: name === 'itemId' || name === 'sn' ? '必填' : '',
        }));

      const row = el('tr', {},
        el('td', { class: 'bulk-row-num' }),
        cell('itemId', seed.itemId, '92px'),
        cell('sn', seed.sn ?? takeSn(), '96px'),
        cell('price', seed.price ?? 0, '80px'),
        cell('count', seed.count ?? 1, '62px'),
        cell('period', seed.period ?? 0, '62px'),
        cell('bonus', seed.bonus ?? 0, '62px'),
        cell('priority', seed.priority ?? 0, '62px'),
        el('td', {}, el('select', { name: 'gender' },
          GENDERS.map(([v, label]) => el('option', { value: v, text: label, selected: v === 2 })))),
        el('td', { style: 'text-align:center' }, el('input', { type: 'checkbox', name: 'onSale', checked: true })),
        el('td', {},
          el('button', {
            class: 'btn btn-sm btn-icon', type: 'button', 'data-tip': '复制此行',
            onclick: () => {
              const values = readRow(row);
              values.sn = takeSn();
              addRow(values, row);
            },
          }),
          el('button', {
            class: 'btn btn-sm btn-icon btn-danger-ghost', type: 'button', 'data-tip': '删除此行',
            onclick: () => { row.remove(); renumber(); },
          })));

      if (after) after.after(row); else body.append(row);
      // Renumber on every insertion, not only on removal: numbering from the
      // row count meant deleting row 2 and adding one produced two "5"s.
      renumber();
      wirePaste(row.querySelector('input[name="itemId"]'), addRow);
      return row;
    };

    const renumber = () => {
      [...body.children].forEach((row, i) => { row.firstChild.textContent = String(i + 1); });
    };

    for (let i = 0; i < 5; i++) addRow();

    const content = el('div', {}, table,
      el('div', { style: 'margin-top:12px' },
        el('button', {
          class: 'btn', type: 'button', text: '再添加 5 行',
          onclick: () => { for (let i = 0; i < 5; i++) addRow(); },
        })),
      el('div', { class: 'tips' },
        el('b', { text: '提示' }),
        el('ul', {},
          el('li', { text: '只有同时填写了道具 ID 和序列号的行才会被添加；空行会被忽略。' }),
          el('li', { text: '序列号已预填为接下来的空闲编号 — 如有需要可自行修改。' }),
          el('li', { text: '使用复制按钮可复制已填好的行。' }),
          el('li', { text: '可直接将电子表格中的一列粘贴到第一个道具 ID 单元格。' }))));

    modal({
      title: '批量添加道具',
      width: 'min(96vw, 1180px)',
      body: content,
      actions: [
        { label: '取消' },
        {
          label: '添加全部',
          class: 'btn-primary',
          run: (close) => { this.submitBulk(body, close); return false; },
        },
      ],
      onOpen: () => body.querySelector('input[name="itemId"]')?.focus(),
    });
  }

  submitBulk(body, close) {
    return this.guard('bulk-submit', () => this.sendBulk(body, close));
  }

  async sendBulk(body, close) {
    const items = [...body.children]
      .map(readRow)
      .filter((row) => row.itemId && row.sn)
      .map((row) => ({ fileId: this.fileId, ...row }));

    if (!items.length) {
      toast('没有可添加的内容 — 请至少填写一个道具 ID 和序列号。', 'warning');
      return;
    }

    const serials = items.map((i) => i.sn);
    const duplicates = serials.filter((sn, i) => serials.indexOf(sn) !== i);
    if (duplicates.length) {
      toast(`你的行中重复出现这些序列号: ${[...new Set(duplicates)].join(', ')}`, 'warning');
      return;
    }

    // The same rule as the single-item path, which treats a collision with an
    // existing entry as a hard stop. Checking the rows only against each other
    // let a bulk add walk straight into an SN that is already in the shop.
    const taken = items.filter((row) => this.items.some((existing) => existing.sn === row.sn));
    if (taken.length) {
      const ok = await confirmDialog({
        title: `${taken.length} 个序列号${taken.length === 1 ? '' : ''}已被占用`,
        message: `${taken.map((r) => r.sn).slice(0, 8).join(', ')} 已属于本商城的道具。` +
                 '两个条目共用同一序列号通常会导致两者在游戏中都无法购买。仍然添加吗？',
        confirmLabel: '仍然添加',
      });
      if (!ok) return;
    }

    try {
      const created = await api.shopBulk(this.fileId, items);
      close();
      toast(`已添加 ${created.length} 项${created.length === 1 ? '' : ''}。`, 'success');
      this.app.markDirty();
      await this.load();
    } catch (error) {
      toastError(error, '无法添加这些道具');
    }
  }
}

function readRow(row) {
  const value = (name) => {
    const input = row.querySelector(`[name="${name}"]`);
    if (!input) return 0;
    if (input.type === 'checkbox') return input.checked;
    return Number(input.value || 0);
  };
  return {
    itemId: value('itemId'), sn: value('sn'), price: value('price'),
    count: value('count') || 1, period: value('period'), bonus: value('bonus'),
    priority: value('priority'), gender: value('gender'), onSale: value('onSale'),
  };
}

/**
 * Pasting a column of IDs copied from a spreadsheet fills down, adding rows as
 * needed -- this is how people actually assemble a cash shop update.
 */
function wirePaste(input, addRow) {
  const NAMES = ['itemId', 'sn', 'price', 'count', 'period', 'bonus', 'priority'];

  input.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!text.includes('\n') && !text.includes('\t')) return;
    event.preventDefault();

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let row = input.closest('tr');
    let previous = row;

    for (const line of lines) {
      // Running off the end grows the table *after* the row being filled.
      // Appending to the bottom scattered the values when you pasted into a
      // row that was not the last one.
      if (!row) row = addRow({}, previous);

      line.split('\t').forEach((cell, i) => {
        const field = row.querySelector(`[name="${NAMES[i]}"]`);
        if (!field) return;
        // Spreadsheet cells arrive as "1,234" or "1 234"; strip the grouping but
        // leave a cell with no digits at all alone rather than blanking it.
        const digits = cell.replace(/[^0-9-]/g, '');
        if (digits !== '') field.value = digits;
      });

      previous = row;
      row = row.nextElementSibling;
    }
    toast(`已粘贴 ${lines.length} 行${lines.length === 1 ? '' : ''}。`, 'info');
  });
}
