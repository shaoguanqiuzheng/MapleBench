/**
 * Mobs mode: a card grid over Mob.wz, plus a per-mob field editor and a
 * previewed bulk edit.
 *
 * Built in the same shape as Cash Shop mode -- one class, guard() around every
 * mutation, a toolbar / stats / grid / pager stack, and honest empty states --
 * because two modes that do the same kind of work should not feel like two
 * different applications.
 *
 * Every write goes through /api/mob/fields, which edits the same session the
 * Explorer edits, so mob changes share one dirty state, one undo history and
 * one save pipeline.
 */

import { api } from './api.js';
import { el, clear, toast, toastError, fmt, modal, confirmDialog, debounce, runOnce,
         busyPanel, busyBar, busyWhile } from './ui.js';
import { emptyState } from './inspector.js';
import { fieldLabel } from './fieldLabels.js';
import { icon } from './icons.js';
import { thumbUrl, lazySprite } from './media.js';
import { openPortDialog } from './port.js';

const PAGE_SIZE = 60;

const FILTERS = [['all', '全部'], ['bosses', 'Boss'], ['undead', '亡灵']];

const SORTS = [
  ['id', '怪物 ID'],
  ['name', '名称（A 到 Z）'],
  ['level', '等级（从低到高）'],
  ['level-desc', '等级（从高到低）'],
  ['hp-desc', '最大 HP（从高到低）'],
  ['exp-desc', 'EXP（从高到低）'],
];

const OPS = [
  ['set', '设置为'],
  ['add', '增加'],
  ['multiply', '乘以'],
  ['percent', '按百分比调整'],
];

const ROUNDING = [
  ['nearest', '四舍五入到整数'],
  ['floor', '向下取整'],
  ['none', '保留小数'],
];

/**
 * Fields the bulk editor offers when it cannot read a real mob to find out what
 * this Mob.wz actually carries. These are the keys the list endpoint already
 * returns for every mob, so they are the safest possible guess.
 */
const FALLBACK_BULK_FIELDS = [
  ['maxHP', '最大 HP'],
  ['maxMP', '最大 MP'],
  ['exp', 'EXP'],
  ['level', '等级'],
  ['PADamage', '物理攻击'],
  ['MADamage', '魔法攻击'],
];

export class Mobs {
  constructor({ host, app }) {
    this.host = host;
    this.app = app;

    /** null means "every open Mob archive", which is what the API does with no fileId. */
    this.fileId = null;
    this.mobs = [];
    this.stats = null;
    this.truncated = false;
    this.capabilities = { available: false, names: false };
    /** The failure that stopped the last load, so the mode can say so instead of showing an empty grid. */
    this.error = null;

    /**
     * True from the first line of load() until it settles.
     *
     * Without it, render() ran with the constructor's `available: false` and
     * painted "No Mob.wz open" for the ten seconds the list took to build --
     * telling the user their archive was not open while the app was busy
     * reading that exact archive. A wait is acceptable; a wait dressed as a
     * different problem sends people off to fix something that is not broken.
     */
    this.loading = false;

    this.query = '';
    this.filter = 'all';
    this.sort = localStorage.getItem('mb.mobSort') || 'id';
    this.page = 1;

    /** Session paths of the ticked cards; bulk edit acts on exactly this set. */
    this.selection = new Set();
  }

  /**
   * Runs a mutation at most once at a time, reporting anything it throws.
   *
   * Same rule as the cash shop: every write is a POST behind a button that
   * stays live while it is in the air, and a bulk apply issued twice doubles a
   * multiply. The keys are namespaced because the in-flight set is shared with
   * the rest of the app.
   */
  async guard(key, run) {
    try {
      await runOnce(`mob:${key}`, run);
    } catch (error) {
      toastError(error);
    }
  }

  async open(fileId = null) {
    this.fileId = fileId;
    this.page = 1;
    this.render();          // paints whatever we already have while the load runs
    await this.load();
  }

  async load() {
    this.error = null;

    // Set and painted before anything is awaited. Every early return below goes
    // through the finally, so no path can leave the panel spinning forever.
    this.loading = true;
    if (!this.mobs.length) this.render();
    else this.markReloading();

    try {
      // Capabilities first and on its own: it is the one call that distinguishes
      // "no Mob.wz is open" from "the backend is not answering", and those two
      // deserve completely different screens.
      try {
        this.capabilities = await api.mobCapabilities();
      } catch (error) {
        this.capabilities = { available: false, names: false };
        this.error = error;
        return;
      }

      if (!this.capabilities.available) {
        this.mobs = [];
        this.stats = null;
        this.selection.clear();
        return;
      }

      try {
        const data = await api.mobList(this.fileId, this.capabilities.names);
        this.mobs = data.mobs || [];
        this.stats = data.stats || null;
        this.truncated = Boolean(data.truncated);
        // A reload can drop mobs the selection still points at -- scoping to one
        // archive is the common way. Bulk-editing paths that are no longer listed
        // would act on things the user can no longer see.
        this.selection = new Set([...this.selection].filter((path) => this.mobs.some((m) => m.path === path)));
      } catch (error) {
        this.error = error;
        this.mobs = [];
        this.stats = null;
      }
    } finally {
      this.loading = false;
      this.render();
    }
  }

  /**
   * The reload case: a grid is already on screen and is about to be replaced by
   * a newer one.
   *
   * Deliberately not the skeleton panel. Every bulk edit, undo and save ticks
   * the session generation and throws the cached list away, so a reload is
   * common -- and swapping a full grid for placeholder rows each time reads as
   * the app losing its place. The bar says "working" while the numbers you were
   * looking at stay where they are.
   */
  markReloading() {
    const host = this.resultHost;
    if (!host) return;
    this.clearReloading?.();
    this.clearReloading = busyBar(host);
    host.setAttribute('aria-busy', 'true');
  }

  /* ============================================================
     FILTERING
     ============================================================ */

  get filtered() {
    const needle = this.query.trim().toLowerCase();
    const rows = this.mobs.filter((mob) => {
      if (this.filter === 'bosses' && !mob.isBoss) return false;
      if (this.filter === 'undead' && !mob.undead) return false;
      if (!needle) return true;
      return String(mob.mobId).includes(needle)
          || (mob.name || '').toLowerCase().includes(needle);
    });
    return this.order(rows);
  }

  order(rows) {
    const sorted = [...rows];
    const num = (value) => (typeof value === 'number' ? value : 0);
    switch (this.sort) {
      case 'name':
        // Mobs without a name string sort last rather than clumping at the top
        // under an empty label, which reads as a bug.
        sorted.sort((a, b) => {
          if (!a.name && !b.name) return a.mobId - b.mobId;
          if (!a.name) return 1;
          if (!b.name) return -1;
          return a.name.localeCompare(b.name) || a.mobId - b.mobId;
        });
        break;
      case 'level': sorted.sort((a, b) => num(a.level) - num(b.level) || a.mobId - b.mobId); break;
      case 'level-desc': sorted.sort((a, b) => num(b.level) - num(a.level) || a.mobId - b.mobId); break;
      case 'hp-desc': sorted.sort((a, b) => num(b.maxHP) - num(a.maxHP) || a.mobId - b.mobId); break;
      case 'exp-desc': sorted.sort((a, b) => num(b.exp) - num(a.exp) || a.mobId - b.mobId); break;
      default: sorted.sort((a, b) => a.mobId - b.mobId); break;
    }
    return sorted;
  }

  /* ============================================================
     RENDER
     ============================================================ */

  render() {
    // A repaint replaces resultHost, so the bar and the aria-busy flag on the
    // old one go with it; dropping the remover keeps markReloading honest.
    this.clearReloading = null;
    clear(this.host);
    this.host.className = 'stage-body mobs';

    if (this.error) {
      this.host.append(emptyState(
        'alert', '无法读取怪物列表',
        this.error.message,
        el('div', { class: 'mob-empty-actions' },
          el('button', { class: 'btn btn-primary', onclick: () => this.load() },
            icon('refresh', { size: 15 }), '重试'),
          el('button', { class: 'btn', onclick: () => this.app.openFilePicker() },
            icon('folderOpen', { size: 15 }), '打开文件'))));
      return;
    }

    // Before the first answer we do not know whether Mob.wz is open, so the
    // "open Mob.wz" screen below would be a guess -- and for ten seconds it was
    // a wrong one. The panel is the honest thing to show until the list lands.
    if (this.loading && !this.mobs.length) {
      this.host.append(busyPanel({
        title: '正在读取怪物…',
        note: '完整的 Mob.wz 包含 2,742 张图片，首次读取约需十秒。'
            + '之后在数据发生变化前都会瞬时完成。',
        className: 'mob-panel',
      }));
      return;
    }

    if (!this.capabilities.available) {
      this.host.append(emptyState(
        'layers', '未打开 Mob.wz',
        '怪物编辑会读取 Mob.wz 中的 .img 文件。请打开 Mob.wz 或整个客户端文件夹。',
        el('button', { class: 'btn btn-primary', onclick: () => this.app.openFilePicker() },
          icon('folderOpen', { size: 15 }), '打开 Mob.wz')));
      return;
    }

    this.resultHost = el('div');

    this.host.append(
      this.buildHead(),
      this.buildToolbar(),
      this.resultHost);

    this.renderResults();
  }

  /**
   * Names the archive being edited.
   *
   * The list endpoint happily spans every open Mob*.wz, so without this the
   * header would be a page of numbers with no clue which file they will be
   * written back into.
   */
  buildHead() {
    const candidates = this.app.files.filter((file) => /mob/i.test(file.name));
    const scoped = this.fileId ? this.app.files.find((f) => f.id === this.fileId) : null;

    const subject = scoped
      ? scoped.name
      : candidates.length === 1
        ? candidates[0].name
        : candidates.length > 1
          ? `${candidates.length} 个 Mob 存档`
          : '所有打开的存档';

    const head = el('div', { class: 'mob-panel mob-head' },
      el('div', { class: 'mob-head-text' },
        el('div', { class: 'mob-head-title', text: '怪物' }),
        el('div', { class: 'mob-head-sub' },
          el('span', { text: '正在编辑' }),
          el('b', { text: subject }),
          // The level range used to be a fourth stat tile. It is the only one
          // of the four the filter pills below do not already carry, and it is
          // one short phrase, so it joins the sentence that was already saying
          // what is open and how much of it there is.
          el('span', {
            text: this.stats
              ? ` · ${fmt.format(this.stats.total)} 只怪物${this.stats.total === 1 ? '' : ''}`
                + (this.stats.total
                    ? ` · 等级 ${fmt.format(this.stats.minLevel)}–${fmt.format(this.stats.maxLevel)}`
                    : '')
              : '',
          }))));

    // The picker only earns its place when there is a real choice to make.
    if (candidates.length > 1) {
      const select = el('select', { class: 'mob-select', 'aria-label': '选择要编辑的存档' },
        el('option', { value: '', text: `所有 Mob 存档（${candidates.length}）`, selected: !this.fileId }),
        candidates.map((file) => el('option', { value: file.id, text: file.name, selected: file.id === this.fileId })));
      select.addEventListener('change', () => {
        this.selection.clear();
        this.open(select.value || null);
      });
      head.append(select);
    }

    head.append(el('button', {
      class: 'btn btn-icon', 'data-tip': '重新加载怪物列表',
      onclick: () => this.load(),
    }, icon('refresh', { size: 15 })));

    return head;
  }

  /* There were four stat tiles here -- TOTAL MOBS 6,000, BOSSES 2,734, UNDEAD
     232, LEVEL RANGE 1–300 -- sitting ninety pixels above three filter pills
     reading All 6,000, Bosses 2,734, Undead 232. Three of the four numbers
     appeared twice on one screen, and only the lower copy could be clicked;
     the fourth is now in the header sentence. */

  buildToolbar() {
    const search = el('input', {
      type: 'search', value: this.query,
      placeholder: '按怪物 ID 或名称搜索…',
      'aria-label': '搜索怪物',
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
        onclick: () => { this.filter = value; this.page = 1; this.render(); },
      }, label, el('span', { class: 'cat-count', text: fmt.format(this.countFor(value)) }))));

    const sort = el('select', { class: 'mob-select', 'aria-label': '怪物排序' },
      SORTS.map(([value, label]) => el('option', { value, text: label, selected: value === this.sort })));
    sort.addEventListener('change', () => {
      this.sort = sort.value;
      localStorage.setItem('mb.mobSort', sort.value);
      this.page = 1;
      this.renderResults();
    });

    return el('div', { class: 'mob-panel' },
      el('div', { class: 'mob-toolbar' },
        el('div', { class: 'mob-search' }, el('span', { class: 'icon' }, icon('search', { size: 15 })), search),
        chips,
        sort),
      this.buildSelectionBar(),
      this.truncated
        ? el('div', { class: 'notice', 'data-tone': 'warn' }, icon('alert', { size: 14 }),
            el('span', { text: '存档中的怪物数量超过单次列表返回的数量，因此这是部分列表。' +
                               '请限定到单个存档，或使用搜索，以确保看到全部内容。' }))
        : null);
  }

  countFor(filter) {
    if (filter === 'bosses') return this.mobs.filter((m) => m.isBoss).length;
    if (filter === 'undead') return this.mobs.filter((m) => m.undead).length;
    return this.mobs.length;
  }

  buildSelectionBar() {
    const shown = this.filtered;
    const count = this.selection.size;

    return el('div', { class: 'mob-selbar', 'data-active': count ? 'true' : 'false' },
      el('span', { class: 'mob-selcount', text: count ? `${fmt.format(count)} 已选` : '未选择任何内容' }),
      el('button', {
        class: 'btn btn-sm', disabled: !shown.length,
        onclick: () => {
          for (const mob of shown) this.selection.add(mob.path);
          this.render();
        },
      }, icon('check', { size: 14 }), `全选 ${fmt.format(shown.length)}`),
      el('button', {
        class: 'btn btn-sm', disabled: !count,
        onclick: () => { this.selection.clear(); this.render(); },
      }, icon('close', { size: 14 }), '清除'),
      // The one-click port. Beside Bulk edit rather than in the overflow menu
      // because it acts on exactly the same selection and is reached the same
      // way -- tick the cards, press the button. It opens a preview, never a
      // write, so it is safe to have next to a destructive-sounding one.
      el('button', {
        class: 'btn btn-sm', disabled: !count,
        'data-tip': '将这些怪物复制到另一个已打开的客户端，包含名称、声音和链接美术资源',
        onclick: () => this.openPortDialog(),
      }, icon('externalLink', { size: 14 }), count ? `迁移 ${fmt.format(count)}` : '迁移'),
      el('button', {
        class: 'btn btn-sm btn-primary', disabled: !count,
        onclick: () => this.openBulkDialog(),
      }, icon('sliders', { size: 14 }), count ? `批量编辑 ${fmt.format(count)}` : '批量编辑'));
  }

  /** Redraws only the result panel, leaving the search box untouched. */
  renderResults() {
    if (!this.resultHost) { this.render(); return; }
    // Every card about to be thrown away may still have a sprite queued, and it
    // belongs to a page nobody is looking at any more. One scope per repaint;
    // see lazySprite in media.js for what it cancels.
    this.sprites?.abort();
    this.sprites = new AbortController();
    clear(this.resultHost);

    const results = this.filtered;
    const pages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
    this.page = Math.min(this.page, pages);
    const slice = results.slice((this.page - 1) * PAGE_SIZE, this.page * PAGE_SIZE);

    const panel = el('div', { class: 'mob-panel' });
    panel.append(el('div', { class: 'mob-result-head' },
      el('span', { text: `${fmt.format(results.length)} 只怪物${results.length === 1 ? '' : ''}` +
                         (this.filter === 'bosses' ? ' · Boss' : this.filter === 'undead' ? ' · 亡灵' : '') }),
      el('span', { text: `第 ${this.page} 页，共 ${pages} 页` })));

    if (!this.mobs.length) {
      // The archive is open and readable and holds nothing -- a different fact
      // from "your filter hid everything", and it needs a different sentence.
      panel.append(emptyState(
        'layers', '此存档中没有怪物',
        '存档已打开，但其中没有任何看起来像怪物图片的内容。如果你限定到了单个文件，' +
        '请尝试其他文件。',
        el('button', { class: 'btn', onclick: () => this.load() }, icon('refresh', { size: 15 }), '重新加载')));
    } else if (!results.length) {
      panel.append(emptyState(
        'search',
        this.query ? `没有匹配“${this.query}”的怪物` : '此筛选中没有内容',
        this.query
          ? (this.capabilities.names
              ? '试试类似 100100 的怪物 ID，或名称的一部分。'
              : 'String.wz 未打开，因此这里没有怪物名称 — 请改用 ID 搜索。')
          : '此存档中的怪物全部被筛掉了。切换回“全部”。',
        this.query
          ? el('button', { class: 'btn', text: '清除搜索', onclick: () => { this.query = ''; this.render(); } })
          : el('button', { class: 'btn', text: '显示所有怪物', onclick: () => { this.filter = 'all'; this.render(); } })));
    } else {
      const grid = el('div', { class: 'mob-grid' });
      for (const mob of slice) grid.append(this.buildCard(mob));
      panel.append(grid);
      if (pages > 1) panel.append(this.buildPager(pages));
    }

    this.resultHost.append(panel);
  }

  /**
   * The mob's own sprite, straight out of the open archive.
   *
   * /api/thumb walks down to the first canvas under the .img and follows
   * _inlink/_outlink, so the frame layout does not have to be known here -- and
   * a linked mob shows the art it actually renders with rather than its 1x1
   * placeholder. A 204 means there is nothing to draw, which is ordinary, so it
   * falls back to the kind glyph instead of leaving a broken image.
   *
   * Requested through the shared loader: 2,742 rows at a measured 4.6-24.4 ms
   * each, all on the session's single gate, is a scroll pass that blocks
   * everything else in the app. That also means the <img> has to live inside
   * this box from the start rather than being put there on load -- the loader
   * watches the frame around the picture to decide when the row is worth
   * requesting, and an <img> that is not in it yet has no frame.
   */
  buildSprite(mob) {
    const glyph = icon('layers', { size: 16 });
    const box = el('div', { class: 'mob-sprite' }, glyph);

    const img = el('img', {
      alt: '', decoding: 'async',
      class: 'mob-sprite-img', 'data-ready': 'false',
      // Inline rather than in mob.css: it is the loader's business, not the
      // card's, and it must be gone the instant the sprite arrives.
      style: 'display:none',
    });
    // Listener before src: a cached image can fire load synchronously, so the
    // opposite order may silently fail to render.
    img.addEventListener('load', () => {
      if (!img.naturalWidth) return;
      glyph.remove();
      img.style.display = '';
      img.dataset.ready = 'true';
    });
    img.addEventListener('error', () => { /* keep the glyph */ });
    box.append(img);
    // media.js's thumbUrl, not api.thumbUrl: the response is cached for an
    // hour, so without the revision stamp a replaced sprite kept showing the
    // old bitmap here long after the Explorer had moved on.
    lazySprite(img, thumbUrl(mob.path), { signal: this.sprites?.signal });

    return box;
  }

  buildCard(mob) {
    const selected = this.selection.has(mob.path);
    const card = el('div', {
      class: 'mob-card', 'data-path': mob.path, 'data-mob-id': mob.mobId,
      'data-selected': selected ? 'true' : 'false',
    });

    const box = el('input', {
      type: 'checkbox', checked: selected,
      'aria-label': `选择 ${mob.name || `怪物 ${mob.mobId}`}`,
    });
    box.addEventListener('change', () => {
      if (box.checked) this.selection.add(mob.path); else this.selection.delete(mob.path);
      card.dataset.selected = box.checked ? 'true' : 'false';
      // Only the counter and the bulk button change, so the grid is left alone
      // -- repainting it here would throw away the checkbox that was clicked.
      this.refreshSelectionBar();
    });

    const badges = el('div', { class: 'mob-badges' },
      mob.isBoss ? el('span', { class: 'mob-badge', 'data-kind': 'boss', text: 'Boss' }) : null,
      mob.undead ? el('span', { class: 'mob-badge', 'data-kind': 'undead', text: '亡灵' }) : null,
      mob.linkTarget ? el('span', { class: 'mob-badge', 'data-kind': 'link', text: '已链接' }) : null,
      mob.dirty ? el('span', { class: 'mob-badge', 'data-kind': 'dirty', text: '未保存' }) : null);

    const stat = (key, value) => el('div', { class: 'mob-row' },
      el('span', { class: 'k', text: key }),
      el('span', { class: 'v', text: value }));

    // Filtered, because this is Element.append rather than el(): append(null)
    // does not skip the child, it stringifies it and puts the word "null" on
    // the card.
    card.append(...[
      el('div', { class: 'mob-card-head' },
        el('label', { class: 'mob-pick' }, box),
        this.buildSprite(mob),
        el('div', { class: 'mob-card-title' },
          el('button', {
            class: 'mob-title', text: mob.name || `怪物 ${mob.mobId}`,
            'data-tip': '打开此怪物', onclick: (event) => this.openMobCard(mob, event.currentTarget),
          }),
          el('div', { class: 'mob-sub', text: `ID ${mob.mobId}` })),
        el('span', { class: 'mob-level', 'data-tip': '等级', text: `Lv ${fmt.format(mob.level ?? 0)}` })),
      badges.childElementCount ? badges : null,
      stat('HP', fmt.format(mob.maxHP ?? 0)),
      // Only when it has one. Nearly every mob in a client has no MP at all, so
      // this row was a labelled zero on card after card -- and a card is read by
      // running the eye down four rows, which means four rows is the budget and
      // one of them was reliably worthless. A mob that does have MP now stands
      // out by having the row at all.
      mob.maxMP ? stat('MP', fmt.format(mob.maxMP)) : null,
      stat('EXP', fmt.format(mob.exp ?? 0)),
      stat('攻击', `${fmt.format(mob.padamage ?? 0)} 物理 · ${fmt.format(mob.madamage ?? 0)} 魔法`),
      mob.elemAttr ? stat('属性', mob.elemAttr) : null,
      el('div', { class: 'mob-actions' },
        el('button', { class: 'btn btn-sm', style: 'flex:1',
                       onclick: (event) => this.openMobCard(mob, event.currentTarget) },
          icon('edit', { size: 14 }), '编辑属性'),
        el('button', {
          class: 'btn btn-sm btn-icon', 'data-tip': '更多',
          onclick: (event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            this.app.showMenu(this.menuItemsFor(mob), rect.left, rect.bottom + 4);
          },
        }, icon('more', { size: 15 }))),
    ].filter(Boolean));

    return card;
  }

  /** Shared by the card overflow and the app-wide right-click menu. */
  menuItemsFor(mob) {
    return [
      { icon: 'edit', label: '编辑属性…', run: () => this.openMobCard(mob) },
      { icon: 'copy', label: `复制怪物 ID ${mob.mobId}`, run: () => this.app.copyText(String(mob.mobId)) },
      mob.linkTarget
        ? { icon: 'externalLink', label: `打开链接的怪物 ${mob.linkTarget}`, run: () => this.openLinked(mob.linkTarget) }
        : null,
      { icon: 'externalLink', label: '在资源管理器中显示', run: () => {
        this.app.setMode('explorer');
        this.app.navigate(mob.path);
      } },
    ].filter(Boolean);
  }

  /** Repaints the selection bar in place; see buildCard for why not the grid. */
  refreshSelectionBar() {
    const current = this.host.querySelector('.mob-selbar');
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

  /** Jumps to the mob a link points at, if it is in the open archives. */
  openLinked(linkTarget) {
    const target = this.mobs.find((m) => m.path.endsWith(`/${linkTarget}.img`))
      ?? this.mobs.find((m) => m.mobId === Number(linkTarget));
    if (!target) {
      toast(`怪物 ${linkTarget} 不在你打开的存档中，因此无法在此打开。`, 'warning');
      return;
    }
    this.openMobCard(target);
  }

  /* ============================================================
     MOB CARD
     ============================================================ */

  // Guarded because the detail is fetched *before* modal() runs: two fast
  // clicks would otherwise race, and the second card's commit closures would
  // point at a form the first one had already replaced.
  /**
   * @param trigger the element that was clicked, if any. It is marked busy for
   * the length of the fetch, because the card is only opened once the detail
   * arrives — so until then a click produced nothing at all on screen, and
   * guard() silently drops the second one. Two clicks, no feedback, then a
   * dialog: it reads as the app ignoring you.
   */
  openMobCard(mob, trigger = null) {
    return this.guard(`card:${mob.path}`,
      () => busyWhile(trigger, this.buildMobCard(mob)));
  }

  async buildMobCard(mob) {
    let detail;
    try {
      detail = await api.mobDetail(mob.path);
    } catch (error) {
      toastError(error, '无法读取该怪物');
      return;
    }

    /**
     * `baseline` is what each field held when this card was opened, which is
     * what "(was X)" reports. It is deliberately not the on-disk value: the
     * server does not send one, and inventing it would put a number beside the
     * field that no one can verify.
     */
    const ctx = {
      mob,
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

    // The head and the link strip are repainted with the sections: editing
    // `level` changes the pill in the header, and editing `link` changes
    // whether the warning strip applies at all.
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
      'data-tip': '此怪物没有的字段。写入一个即可创建它。',
      onclick: () => {
        ctx.showAbsent = !ctx.showAbsent;
        absentToggle.setAttribute('aria-pressed', ctx.showAbsent ? 'true' : 'false');
        paint();
      },
    }, icon('plus', { size: 14 }), '显示缺失字段');

    const paint = () => {
      clear(headHost);
      headHost.append(this.buildDetailHead(ctx));
      if (ctx.detail.linkTarget) headHost.append(this.buildLinkStrip(ctx));

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

      const extra = this.buildExtraSection(ctx);
      if (extra) sectionsHost.append(extra);

      if (!shown) {
        sectionsHost.append(emptyState(
          'search',
          ctx.search ? `没有匹配“${ctx.search}”的字段` : '没有可显示的内容',
          ctx.modifiedOnly
            ? '此怪物还没有任何更改。请关闭“仅显示已修改”。'
            : '搜索会同时匹配标签和原始 WZ 键名。'));
      }

      counter.textContent = modified
        ? `${modified} 个字段${modified === 1 ? '' : ''}已更改`
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

    const body = el('div', { class: 'mob-detail' },
      headHost,
      el('div', { class: 'mob-detail-tools' },
        el('div', { class: 'mob-search' }, el('span', { class: 'icon' }, icon('search', { size: 15 })), search),
        modifiedToggle,
        absentToggle,
        counter),
      sectionsHost);

    paint();

    const { dialog, close } = modal({
      title: ctx.mob.name || `怪物 ${ctx.mob.mobId}`,
      subtitle: ctx.mob.path.split('/').slice(1).join('/'),
      width: 'min(96vw, 880px)',
      body,
      actions: [{ label: '完成' }],
    });
    // Handed to the head and the link strip, both of which are painted before
    // the dialog that owns them exists.
    ctx.close = close;

    // Committed fields change the numbers on the card behind this dialog, and
    // the list is the only thing that knows them. Reloading once on close beats
    // a reload per keystroke.
    dialog.addEventListener('close', () => { if (ctx.touched) this.load(); }, { once: true });
  }

  buildDetailHead(ctx) {
    const mob = ctx.mob;
    return el('div', { class: 'mob-detail-head' },
      el('div', {},
        el('div', { class: 'mob-detail-name', text: mob.name || `怪物 ${mob.mobId}` }),
        el('div', { class: 'mob-sub', text: `ID ${mob.mobId}` })),
      el('span', { class: 'mob-level', text: `Lv ${fmt.format(mob.level ?? 0)}` }),
      mob.isBoss ? el('span', { class: 'mob-badge', 'data-kind': 'boss', text: 'Boss' }) : null,
      mob.undead ? el('span', { class: 'mob-badge', 'data-kind': 'undead', text: '亡灵' }) : null,
      el('span', { style: 'margin-left:auto' }),
      el('button', {
        class: 'btn btn-sm', 'data-tip': '在资源管理器中打开此 .img',
        // Closing first: leaving the card sitting over the Explorer hides the
        // node it just navigated to, which reads as the button doing nothing.
        onclick: () => {
          ctx.close?.();
          this.app.setMode('explorer');
          this.app.navigate(mob.path);
        },
      }, icon('externalLink', { size: 14 }), '在资源管理器中显示'));
  }

  /**
   * The trap this editor exists to stop.
   *
   * A linked mob keeps its stats in another image, so everything below is a
   * copy the game never reads. Editing it looks like it worked -- the write
   * succeeds, the field turns amber -- and nothing changes in-game.
   */
  buildLinkStrip(ctx) {
    const target = ctx.detail.linkTarget;
    return el('div', { class: 'mob-link-strip' },
      icon('alert', { size: 16 }),
      el('div', { class: 'mob-link-text' },
        el('b', { text: `此怪物链接到 ${target}。` }),
        el('span', {
          text: ' 它的真实属性位于该图片中，因此在此处所做的编辑会被写入，但不会' +
                '改变游戏内的任何内容。请改为编辑目标。',
        })),
      el('button', {
        class: 'btn btn-sm',
        // One mob card at a time: stacking the target over the mob that links
        // to it makes it very easy to lose track of which one you are editing.
        onclick: () => { ctx.close?.(); this.openLinked(target); },
      }, icon('externalLink', { size: 14 }), `打开 ${target}`));
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
      if (!ctx.search) return true;
      const needle = ctx.search.trim().toLowerCase();
      // The label as well as the raw key: nobody looking for "Knockback
      // resistance" knows it is stored as "pushed".
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
      field.unit ? el('span', { class: 'mob-unit', text: field.unit }) : null,
      // "(was X)" inline, so a changed value carries its own history and does
      // not need a diff view to be readable.
      changed ? el('span', { class: 'mob-was', text: `原为 ${was === '' ? '空' : was}` }) : null,
      !field.present ? el('span', { class: 'mob-absent-tag', text: '未设置' }) : null));

    if (field.kind === 'Flag') {
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
      });
      let committed = current;

      if (field.kind === 'Int') input.addEventListener('focus', () => input.select());

      const send = () => {
        const next = input.value;
        if (next === committed) return;

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

    if (field.hint) row.append(el('div', { class: 'mob-field-hint', text: field.hint }));
    if (!field.present) {
      row.append(el('div', { class: 'mob-field-hint',
        text: '此怪物没有该字段。设置值将创建它。' }));
    }
    return row;
  }

  /**
   * Keys the server did not model. They are shown read-only rather than hidden:
   * a mob carrying an unexpected key is worth knowing about, and pretending it
   * is not there is how an editor quietly loses data.
   */
  buildExtraSection(ctx) {
    const entries = Object.entries(ctx.detail.extra || {});
    if (!entries.length) return null;
    if (ctx.modifiedOnly) return null;

    const list = el('dl', { class: 'mob-extra' });
    for (const [key, value] of entries) {
      list.append(el('dt', { text: key }), el('dd', { text: String(value ?? '') }));
    }

    return el('details', { class: 'mob-section' },
      el('summary', {},
        el('span', { class: 'mob-section-name', text: '其他键' }),
        el('span', { class: 'mob-section-meta', text: `${entries.length} 项在此不可编辑` })),
      list);
  }

  /**
   * Folds a fresh detail back into the list row it came from.
   *
   * The header pill, the badges and the card behind the dialog all read the
   * list DTO, and only the detail knows what was just written -- so without
   * this, setting level to 200 left "Lv 5" on screen until the next reload.
   * Keys are matched case-insensitively because the list DTO and the WZ nodes
   * do not agree on capitalisation (padamage vs PADamage).
   */
  syncSummary(ctx) {
    const values = new Map();
    for (const group of ctx.detail.groups || []) {
      for (const field of group.fields || []) {
        if (field.present) values.set((field.key || '').toLowerCase(), field.value);
      }
    }

    const number = (key, fallback) => {
      const parsed = Number(values.get(key));
      return values.has(key) && Number.isFinite(parsed) ? parsed : fallback;
    };

    const mob = ctx.mob;
    mob.level = number('level', mob.level);
    mob.maxHP = number('maxhp', mob.maxHP);
    mob.maxMP = number('maxmp', mob.maxMP);
    mob.exp = number('exp', mob.exp);
    mob.padamage = number('padamage', mob.padamage);
    mob.madamage = number('madamage', mob.madamage);
    if (values.has('boss')) mob.isBoss = values.get('boss') === '1';
    if (values.has('undead')) mob.undead = values.get('undead') === '1';
    if (values.has('elemattr')) mob.elemAttr = values.get('elemattr');
    mob.linkTarget = ctx.detail.linkTarget ?? mob.linkTarget;
    mob.dirty = ctx.detail.dirty ?? true;
  }

  commitField(ctx, field, value, revert, paint) {
    return this.guard(`field:${ctx.detail.path}:${field.key}`, async () => {
      try {
        const next = await api.mobFields(ctx.detail.path, [{ key: field.key, value }]);
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
   * Hands the ticked mobs to the cross-client port dialog.
   *
   * Nothing about the port is mob-specific beyond the `kind` passed here, which
   * is the point: the same dialog serves NPCs from npc.js the moment that mode
   * grows the same button.
   *
   * Reloaded on close because a port that replaced a target mob changes rows in
   * this grid when the target archive is one of the ones it is showing -- and
   * it usually is, since the list spans every open Mob archive by default.
   */
  openPortDialog() {
    return this.guard('port-dialog', async () => {
      await openPortDialog({ app: this.app, kind: 'mob', paths: [...this.selection] });
      await this.load();
    });
  }

  /**
   * The field list comes from a real mob in the selection, because which fields
   * exist depends on the archive. A hardcoded list would offer keys this
   * Mob.wz does not have and hide the ones it does.
   */
  async bulkFieldOptions(path) {
    try {
      const detail = await api.mobDetail(path);
      const found = [];
      for (const group of detail.groups || []) {
        for (const field of group.fields || []) {
          if (field.kind !== 'Int') continue;      // add/multiply mean nothing on a flag or a string
          found.push([field.key, `${group.group} · ${fieldLabel(field.key, field.label)}`]);
        }
      }
      if (found.length) return found;
    } catch {
      /* fall through to the safe list rather than blocking the dialog */
    }
    return FALLBACK_BULK_FIELDS;
  }

  async buildBulkDialog() {
    const paths = [...this.selection];
    if (!paths.length) {
      toast('请先勾选几只怪物 — 每张卡片角落都有复选框。', 'info');
      return;
    }

    const fields = await this.bulkFieldOptions(paths[0]);

    const fieldSelect = el('select', { class: 'mob-select', 'aria-label': '要更改的字段' },
      fields.map(([key, label]) => el('option', { value: key, text: label })));
    const opSelect = el('select', { class: 'mob-select', 'aria-label': '要执行的操作' },
      OPS.map(([value, label]) => el('option', { value, text: label })));
    const valueInput = el('input', { class: 'mob-input', type: 'number', step: 'any', value: '1' });
    const roundSelect = el('select', { class: 'mob-select', 'aria-label': '取整方式' },
      ROUNDING.map(([value, label]) => el('option', { value, text: label })));

    const previewHost = el('div', { class: 'mob-preview-host' });
    let preview = null;

    const applyButton = el('button', {
      class: 'btn btn-primary', disabled: true,
      'data-tip': '先预览 — 看到数字之前不会写入任何内容',
    }, icon('check', { size: 15 }), `应用到 ${fmt.format(paths.length)} 只怪物${paths.length === 1 ? '' : ''}`);

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
      previewHost.append(el('div', { class: 'mob-preview-empty' },
        icon('info', { size: 15 }),
        el('span', { text: '预览更改可查看每只怪物的精确前后对比。' +
                           '在此之前不会写入任何内容。' })));
    };
    for (const control of [fieldSelect, opSelect, roundSelect]) control.addEventListener('change', invalidate);
    valueInput.addEventListener('input', invalidate);
    invalidate();

    const recipe = () => ({
      paths,
      field: fieldSelect.value,
      op: opSelect.value,
      value: Number(valueInput.value),
      round: roundSelect.value,
    });

    previewButton.addEventListener('click', () => this.guard('bulk-preview', async () => {
      const body = recipe();
      if (!Number.isFinite(body.value)) {
        toast('请输入数字以更改字段。', 'warning');
        return;
      }
      clear(previewHost);
      previewHost.append(el('div', { class: 'mob-preview-empty' }, el('span', { text: '处理中…' })));
      try {
        const result = await api.mobBulk({ ...body, dryRun: true });
        preview = result;
        clear(previewHost);
        previewHost.append(this.buildPreviewTable(result));
        const changing = (result.changes || []).filter((c) => !c.skipped).length;
        applyButton.disabled = changing === 0;
        applyButton.dataset.tip = changing
          ? `写入这 ${fmt.format(changing)} 项更改`
          : '此处不会有任何更改';
      } catch (error) {
        preview = null;
        applyButton.disabled = true;
        clear(previewHost);
        previewHost.append(el('div', { class: 'mob-preview-empty', 'data-tone': 'bad' },
          icon('alert', { size: 15 }),
          el('span', { text: error.message })));
      }
    }));

    const { close } = modal({
      title: '批量编辑怪物',
      subtitle: `${fmt.format(paths.length)} 只怪物${paths.length === 1 ? '' : ''}已选`,
      width: 'min(96vw, 900px)',
      body: el('div', { class: 'mob-bulk' },
        el('div', { class: 'mob-bulk-grid' },
          field('字段', fieldSelect),
          field('更改', opSelect),
          field('值', valueInput),
          field('取整', roundSelect, '乘法和百分比可能产生小数；WZ 整数无法存储小数。')),
        el('div', { class: 'mob-bulk-actions' }, previewButton, applyButton),
        previewHost,
        el('div', { class: 'tips' },
          el('b', { text: '行为说明' }),
          el('ul', {},
            el('li', { text: '预览在服务器端执行，因此你看到的就是将要写入的内容。' }),
            el('li', { text: '没有该字段的怪物会被跳过并显示原因 — 此处不会创建字段。' }),
            el('li', { text: '百分比由服务器计算；请查看预览，不要自行推断正负号。' }),
            el('li', { text: '保存前不会写入磁盘，整个批次都可以撤销。' })))),
      actions: [{ label: '关闭' }],
    });

    applyButton.addEventListener('click', () => this.guard('bulk-apply', async () => {
      if (!preview) return;
      const changing = (preview.changes || []).filter((c) => !c.skipped);
      const ok = await confirmDialog({
        title: `在 ${fmt.format(changing.length)} 只怪物${changing.length === 1 ? '' : ''}上更改 ${fieldSelect.value}？`,
        message: `${OPS.find(([v]) => v === opSelect.value)?.[1]} ${valueInput.value} — 这就是你正在查看的预览。` +
                 '保存前不会写入磁盘，且可以撤销。',
        confirmLabel: '应用更改',
        danger: false,
      });
      if (!ok) return;

      try {
        const result = await api.mobBulk({ ...recipe(), dryRun: false });
        const skipped = (result.changes || []).filter((c) => c.skipped).length;
        close();
        toast(
          `已更新 ${fmt.format(result.applied ?? 0)} 只怪物${result.applied === 1 ? '' : ''}` +
          (skipped ? `，跳过 ${fmt.format(skipped)} 只。` : '。'),
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
          el('div', { class: 'mob-preview-name', text: change.name || `怪物 ${change.mobId}` }),
          el('div', { class: 'mob-sub', text: String(change.mobId) })),
        el('td', { class: 'num', text: change.before ?? '—' }),
        el('td', { class: 'mob-preview-arrow' }, change.skipped ? '' : '→'),
        el('td', { class: 'num', text: change.skipped ? '—' : (change.after ?? '—') }),
        el('td', { class: 'mob-preview-note',
          text: change.skipped ? (change.reason || '已跳过') : '' })));
    }

    return el('div', {},
      el('div', { class: 'mob-preview-head' },
        el('span', { text: `${fmt.format(changes.length - skipped)} 项将更改` +
                           (skipped ? `，${fmt.format(skipped)} 项跳过` : '') }),
        result.truncated
          ? el('span', { class: 'mob-preview-trunc',
              text: '服务器提前停止列出 — 受影响的怪物比显示的更多。' })
          : null),
      el('div', { class: 'mob-preview-scroll' },
        el('table', { class: 'mob-preview' },
          el('thead', {}, el('tr', {},
            ['怪物', '之前', '', '之后', ''].map((h) => el('th', { text: h })))),
          body)));
  }
}

/** One labelled control in the bulk recipe. */
function field(label, control, hint) {
  return el('div', { class: 'mob-bulk-field' },
    el('label', { text: label }), control,
    hint ? el('div', { class: 'mob-field-hint', text: hint }) : null);
}
