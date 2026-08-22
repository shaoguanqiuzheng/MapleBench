/**
 * Skills section: a card grid over Skill.wz, plus the level table that is the
 * whole reason this section exists.
 *
 * Built in the same shape as Mobs and Cash Shop -- one class, guard() around
 * every mutation, a head / stats / toolbar / grid / pager stack, and honest
 * empty states -- because sections that do the same kind of work should not feel
 * like different applications.
 *
 * What is genuinely different here is the storage split. A skill's per-level
 * values live either as literal `level/N/damage` nodes or as formulas over the
 * level variable in a `common` block -- and in a v232 client 3,935 of 4,846
 * skills are the second kind, which no other WZ editor renders as levels at all.
 * The level table draws both as one grid and marks every cell with where its
 * value came from: a computed cell is visually distinct and read-only, because
 * typing into it would edit a node the client does not read (rule 6).
 *
 * Every write goes through /api/skill/*, which edits the same session the
 * Explorer edits, so skill changes share one dirty state, one undo history and
 * one save pipeline.
 */

import { api } from './api.js';
import { el, clear, toast, toastError, fmt, modal, confirmDialog, promptForText, debounce, runOnce,
         scalePixelArt, statChip, statRow } from './ui.js';
import { emptyState } from './inspector.js';
import { fieldLabel } from './fieldLabels.js';
import { icon } from './icons.js';
import { thumbUrl, lazySprite } from './media.js';

const PAGE_SIZE = 60;

/**
 * Rows of the level table drawn at once. 73 skills in a v232 client declare
 * maxLevel 300, and 300 rows times a dozen columns is 3,600 cells of layout for
 * a screen that shows twenty of them.
 */
const LEVEL_PAGE = 40;

const FILTERS = [
  ['all', '全部'],
  ['formula', '公式'],
  ['explicit', '等级'],
  ['mixed', '两者'],
  ['bad', '损坏公式'],
];

const SORTS = [
  ['id', '技能 ID'],
  ['name', '名称(A–Z)'],
  ['book', '技能书,再按 ID'],
  ['level-desc', '最大等级(从高到低)'],
  ['bad-desc', '损坏公式优先'],
];

const OPS = [
  ['set', '设为'],
  ['add', '加'],
  ['multiply', '乘以'],
  ['percent', '按百分比更改'],
];

const ROUNDING = [
  ['nearest', '四舍五入到整数'],
  ['floor', '向下取整'],
  ['none', '保留小数'],
];

/** How the API's storage words read on a badge. */
const STORAGE_LABEL = {
  formula: '公式',
  explicit: '等级',
  mixed: '两者',
  none: '无等级',
};

/** One line saying what each storage shape means, where the badge is not enough. */
const STORAGE_BLURB = {
  formula: '每个等级都由该技能 common 块中的公式计算得出,没有等级节点。',
  explicit: '每个等级都是客户端直接读取的真实 level/N 节点。',
  mixed: '该技能两者都有。客户端读取公式,并在 common 块消失前忽略等级节点。',
  none: '该技能未声明任何等级。',
};

/** The cell sources that are computed rather than stored, so never editable. */
const COMPUTED = new Set(['formula', 'constant', 'container', 'needs', 'error']);

export class SkillSection {
  constructor({ host, app }) {
    this.host = host;
    this.app = app;

    /** null means "every open Skill archive", which is what the API does with no fileId. */
    this.fileId = null;

    /**
     * The book being browsed, as its session path -- /api/skill/list matches
     * `book` against the image's path, not against its id, whatever the id looks
     * like. `bookId` is what gets remembered, because a path carries the session
     * file id (f1, f2...) and that is different every run.
     */
    this.bookPath = null;
    this.bookId = localStorage.getItem('mb.skillBook') || null;

    this.books = [];
    this.skills = [];
    this.stats = null;
    this.truncated = false;
    this.capabilities = { available: false, names: false };

    /** The failure that stopped the last load, so the section can say so instead of showing an empty grid. */
    this.error = null;
    /** True while the list is in the air; the first read of a client takes seconds, so it is drawn. */
    this.loading = false;

    this.query = '';
    this.filter = localStorage.getItem('mb.skillFilter') || 'all';
    if (!FILTERS.some(([value]) => value === this.filter)) this.filter = 'all';
    this.sort = localStorage.getItem('mb.skillSort') || 'id';
    this.page = 1;

    /** Session paths of the ticked cards; bulk edit acts on exactly this set. */
    this.selection = new Set();

    /** The open skill dialog, so an external save or undo can repaint it. */
    this.detail = null;
  }

  /**
   * Runs a mutation at most once at a time, reporting anything it throws.
   *
   * Same rule as the other sections: every write is a POST behind a button that
   * stays live while it is in the air, and a bake issued twice would run the
   * second one against a skill whose common block the first one deleted. The
   * keys are namespaced because the in-flight set is shared with the rest of the
   * app.
   */
  async guard(key, run) {
    try {
      await runOnce(`skill:${key}`, run);
    } catch (error) {
      toastError(error);
    }
  }

  async open(fileId = this.fileId) {
    this.fileId = fileId;
    this.page = 1;
    this.render();          // paints whatever we already have while the load runs
    await this.load();
  }

  /** Called after a save or an undo somewhere else changed what is on screen. */
  async refresh() {
    await this.load();
    // A skill card open over the grid is showing values the undo may have moved.
    if (this.detail) await this.detail.reload();
  }

  async load() {
    this.error = null;

    // Set before the FIRST await, not after it.
    //
    // It used to be raised only once capabilities had answered, which left the
    // "No Skill.wz open" screen up for however long that call took -- and the
    // capabilities call takes the session gate and can queue behind a build, so
    // "however long" reached seconds. Telling someone their archive is not open
    // while the app is reading it is the same bug the Mobs section had, just
    // shorter.
    this.loading = true;
    this.render();

    // Capabilities first and on its own: it is the one call that distinguishes
    // "no Skill.wz is open" from "the backend is not answering", and those two
    // deserve completely different screens.
    try {
      this.capabilities = await api.skillCapabilities();
    } catch (error) {
      this.capabilities = { available: false, names: false };
      this.error = error;
      this.loading = false;
      this.render();
      return;
    }

    if (!this.capabilities.available) {
      this.books = [];
      this.skills = [];
      this.stats = null;
      this.selection.clear();
      this.loading = false;
      this.render();
      return;
    }

    try {
      const [books, list] = await Promise.all([
        api.skillBooks(this.fileId),
        api.skillList(this.fileId, this.resolveBook(), this.capabilities.names),
      ]);

      this.books = books.books || [];
      // Resolved after the books arrive, so a remembered book id that this
      // client does not have falls back to every book rather than to an empty
      // grid with a filter the user cannot see.
      this.bookPath = this.resolveBook();

      this.skills = list.skills || [];
      this.stats = list.stats || null;
      this.truncated = Boolean(list.truncated);

      // A reload can drop skills the selection still points at -- narrowing to
      // one book is the common way. Bulk-editing paths that are no longer listed
      // would act on things the user can no longer see.
      this.selection = new Set([...this.selection].filter((path) => this.skills.some((s) => s.path === path)));
    } catch (error) {
      this.error = error;
      this.skills = [];
      this.stats = null;
    } finally {
      this.loading = false;
    }
    this.render();
  }

  /**
   * The `book` argument for the list call: a path, because that is what the
   * endpoint compares against. Null when nothing is chosen or the remembered
   * book is not in this client.
   */
  resolveBook() {
    if (!this.bookId) return null;
    const match = this.books.find((book) => book.bookId === this.bookId);
    return match ? match.path : null;
  }

  setBook(bookId) {
    this.bookId = bookId || null;
    if (this.bookId) localStorage.setItem('mb.skillBook', this.bookId);
    else localStorage.removeItem('mb.skillBook');
    this.selection.clear();
    this.page = 1;
    this.load();
  }

  /* ============================================================
     FILTERING
     ============================================================ */

  get filtered() {
    const needle = this.query.trim().toLowerCase();
    const rows = this.skills.filter((skill) => {
      if (this.filter === 'bad' && !skill.badFormulas) return false;
      if (['formula', 'explicit', 'mixed'].includes(this.filter) && skill.storage !== this.filter) return false;
      if (!needle) return true;
      return String(skill.skillId).includes(needle)
          || (skill.name || '').toLowerCase().includes(needle)
          || (skill.bookName || '').toLowerCase().includes(needle);
    });
    return this.order(rows);
  }

  order(rows) {
    const sorted = [...rows];
    switch (this.sort) {
      case 'name':
        // Skills String.wz does not name sort last rather than clumping at the
        // top under an empty label, which reads as a bug.
        sorted.sort((a, b) => {
          if (!a.name && !b.name) return a.skillId - b.skillId;
          if (!a.name) return 1;
          if (!b.name) return -1;
          return a.name.localeCompare(b.name) || a.skillId - b.skillId;
        });
        break;
      case 'book':
        sorted.sort((a, b) =>
          (a.bookName || a.bookId || '').localeCompare(b.bookName || b.bookId || '') || a.skillId - b.skillId);
        break;
      case 'level-desc':
        sorted.sort((a, b) => (b.maxLevel ?? 0) - (a.maxLevel ?? 0) || a.skillId - b.skillId);
        break;
      case 'bad-desc':
        sorted.sort((a, b) => (b.badFormulas ?? 0) - (a.badFormulas ?? 0) || a.skillId - b.skillId);
        break;
      default:
        sorted.sort((a, b) => a.skillId - b.skillId);
        break;
    }
    return sorted;
  }

  countFor(filter) {
    if (filter === 'bad') return this.skills.filter((s) => s.badFormulas > 0).length;
    if (filter === 'all') return this.skills.length;
    return this.skills.filter((s) => s.storage === filter).length;
  }

  /* ============================================================
     RENDER
     ============================================================ */

  render() {
    clear(this.host);
    this.host.className = 'stage-body skills';

    if (this.error) {
      this.host.append(emptyState(
        'alert', '无法读取技能列表',
        this.error.message,
        el('div', { class: 'sk-empty-actions' },
          el('button', { class: 'btn btn-primary', onclick: () => this.load() },
            icon('refresh', { size: 15 }), '重试'),
          el('button', { class: 'btn', onclick: () => this.app.openFilePicker() },
            icon('folderOpen', { size: 15 }), '打开文件'))));
      return;
    }

    if (!this.capabilities.available) {
      this.host.append(emptyState(
        'star', '未打开 Skill.wz',
        '技能编辑需要读取 Skill.wz,并使用 String.wz 提供名称。打开客户端文件夹以同时启用两者。',
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
   * Names the archive being edited.
   *
   * The list endpoint happily spans every open Skill*.wz, so without this the
   * header would be a page of numbers with no clue which file they will be
   * written back into.
   */
  buildHead() {
    const candidates = this.app.files.filter((file) => /^skill/i.test(file.name));
    const scoped = this.fileId ? this.app.files.find((f) => f.id === this.fileId) : null;

    const subject = scoped
      ? scoped.name
      : candidates.length === 1
        ? candidates[0].name
        : candidates.length > 1
          ? `${candidates.length} 个技能存档`
          : '所有已打开的存档';

    const head = el('div', { class: 'sk-panel sk-head' },
      el('div', { class: 'sk-head-text' },
        el('div', { class: 'sk-head-title', text: '技能' }),
        el('div', { class: 'sk-head-sub' },
          el('span', { text: '正在编辑 ' }),
          el('b', { text: subject }),
          el('span', {
            text: this.stats
              ? ` · 共 ${fmt.format(this.stats.total)} 个技能` +
                `,分属 ${fmt.format(this.stats.books)} 本技能书`
              : '',
          }),
          this.capabilities.names
            ? null
            : el('span', { class: 'sk-head-warn', text: ' · 未打开 String.wz,技能没有名称' }))));

    // The picker only earns its place when there is a real choice to make.
    if (candidates.length > 1) {
      const select = el('select', { class: 'sk-select', 'aria-label': '选择要编辑的存档' },
        el('option', { value: '', text: `全部技能存档(${candidates.length})`, selected: !this.fileId }),
        candidates.map((file) => el('option', { value: file.id, text: file.name, selected: file.id === this.fileId })));
      select.addEventListener('change', () => {
        this.selection.clear();
        this.open(select.value || null);
      });
      head.append(select);
    }

    head.append(el('button', {
      class: 'btn btn-icon', 'data-tip': '重新加载技能列表',
      onclick: () => this.load(),
    }, icon('refresh', { size: 15 })));

    return head;
  }

  /**
   * Six counts, of which only the ones that happened are shown.
   *
   * `null` still prints an em dash -- a row of zeros over a client that has not
   * been read yet reads as corrupt data -- but a real zero now drops the box
   * instead of filling it. On an ordinary client "Both" and "Broken formulas"
   * are both zero, so two of the six boxes were there to report that nothing
   * was wrong, in the same row and the same weight as the four that carry the
   * shape of the archive. When one of them is not zero it now appears, which is
   * the only time it is worth reading.
   */
  buildStats() {
    const s = this.stats;
    const n = (value) => (typeof value === 'number' ? value : null);

    return statRow('sk-stats', [
      statChip('技能', n(s?.total), { drop: false }),
      statChip('技能书', n(s?.books), { drop: false }),
      statChip('纯公式', n(s?.formulaDriven), { tone: 'purple',
        tip: '其逐级数值只以基于等级的表达式存在。大多数客户端都是这种情况。' }),
      statChip('显式等级', n(s?.explicitLevels), { tone: 'green',
        tip: '其数值是客户端直接读取的真实 level/N 节点。' }),
      statChip('两者', n(s?.mixed), { tone: 'amber',
        tip: '同时存在 common 块与等级节点。客户端读取公式而忽略节点。' }),
      statChip('损坏公式', n(s?.badFormulas), { tone: 'red',
        tip: '本次构建无法解析的表达式。会连同错误一并报告,而不是显示为 0。' }),
    ]);
  }

  buildToolbar() {
    const search = el('input', {
      type: 'search', value: this.query,
      placeholder: this.capabilities.names
        ? '按技能 ID、名称或技能书搜索…'
        : '按技能 ID 搜索 — 打开 String.wz 可显示名称',
      'aria-label': '搜索技能',
    });
    // Only the results are re-rendered, never the toolbar holding this input:
    // rebuilding it destroys the caret and drops IME composition mid-word.
    search.addEventListener('input', debounce(() => {
      this.query = search.value;
      this.page = 1;
      this.renderResults();
    }, 160));
    this.searchInput = search;

    const chips = el('div', { class: 'cat-tabs' },
      FILTERS.map(([value, label]) => el('button', {
        class: 'cat-tab', 'aria-pressed': this.filter === value ? 'true' : 'false',
        onclick: () => {
          this.filter = value;
          localStorage.setItem('mb.skillFilter', value);
          this.page = 1;
          this.render();
        },
      }, label, el('span', { class: 'cat-count', text: fmt.format(this.countFor(value)) }))));

    const books = el('select', { class: 'sk-select', 'aria-label': '选择要浏览的技能书' },
      el('option', {
        value: '', selected: !this.bookId,
        text: `全部技能书(${fmt.format(this.books.length)})`,
      }),
      // Named, not numbered: "1100" is meaningless and "The Basics of a Dawn
      // Warrior" is the thing the user is looking for (rule 1). The id stays
      // beside it because that is what the path keys on.
      this.books.map((book) => el('option', {
        value: book.bookId, selected: book.bookId === this.bookId,
        text: `${book.name || `技能书 ${book.bookId}`} · ${book.bookId} · ${fmt.format(book.skillCount)}`,
      })));
    books.addEventListener('change', () => this.setBook(books.value));

    const sort = el('select', { class: 'sk-select', 'aria-label': '技能排序' },
      SORTS.map(([value, label]) => el('option', { value, text: label, selected: value === this.sort })));
    sort.addEventListener('change', () => {
      this.sort = sort.value;
      localStorage.setItem('mb.skillSort', sort.value);
      this.page = 1;
      this.renderResults();
    });

    return el('div', { class: 'sk-panel' },
      el('div', { class: 'sk-toolbar' },
        el('div', { class: 'sk-search' }, el('span', { class: 'icon' }, icon('search', { size: 15 })), search),
        books,
        sort),
      el('div', { class: 'sk-toolbar' }, chips),
      this.buildSelectionBar(),
      this.truncated
        ? el('div', { class: 'sk-note' }, icon('alert', { size: 14 }),
            el('span', { text: '存档中的技能数超过一次列表返回的数量,所以这是部分列表。' +
                               '选择单个技能书或用搜索,以确保看到全部内容。' }))
        : null);
  }

  buildSelectionBar() {
    const shown = this.filtered;
    const count = this.selection.size;

    return el('div', { class: 'sk-selbar', 'data-active': count ? 'true' : 'false' },
      el('span', { class: 'sk-selcount', text: count ? `已选择 ${fmt.format(count)} 个` : '未选择任何内容' }),
      el('button', {
        class: 'btn btn-sm', disabled: !shown.length,
        onclick: () => {
          for (const skill of shown) this.selection.add(skill.path);
          this.render();
        },
      }, icon('check', { size: 14 }), `全选 ${fmt.format(shown.length)} 个`),
      el('button', {
        class: 'btn btn-sm', disabled: !count,
        onclick: () => { this.selection.clear(); this.render(); },
      }, icon('close', { size: 14 }), '清除'),
      el('button', {
        class: 'btn btn-sm btn-primary', disabled: !count,
        onclick: () => this.openBulkDialog(),
      }, icon('sliders', { size: 14 }), count ? `批量编辑 ${fmt.format(count)} 个` : '批量编辑'));
  }

  /** Puts the caret in the search box; for a palette command. */
  focusSearch() {
    this.searchInput?.focus();
    this.searchInput?.select();
  }

  /** Redraws only the result panel, leaving the search box untouched. */
  renderResults() {
    if (!this.resultHost) { this.render(); return; }
    // The icons the outgoing page still has queued belong to nobody now. One
    // scope per repaint; see lazySprite in media.js.
    this.sprites?.abort();
    this.sprites = new AbortController();
    clear(this.resultHost);

    const panel = el('div', { class: 'sk-panel' });

    if (this.loading) {
      panel.append(el('div', { class: 'sk-result-head' },
        el('span', { text: '正在读取全部技能书…' }),
        el('span', { text: '首次约 8 秒,之后即时完成' })));
      for (let i = 0; i < 6; i++) {
        panel.append(el('div', { class: 'skeleton skeleton-row', style: `width:${45 + ((i * 37) % 40)}%` }));
      }
      this.resultHost.append(panel);
      return;
    }

    const results = this.filtered;
    const pages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
    this.page = Math.min(this.page, pages);
    const slice = results.slice((this.page - 1) * PAGE_SIZE, this.page * PAGE_SIZE);

    panel.append(el('div', { class: 'sk-result-head' },
      el('span', { text: `${fmt.format(results.length)} 个技能` +
                         (this.filter === 'all' ? '' : ` · ${FILTERS.find(([v]) => v === this.filter)[1].toLowerCase()}`) }),
      el('span', { text: `第 ${this.page} 页 / 共 ${pages} 页` })));

    if (!this.skills.length) {
      // The archive is open and readable and holds nothing -- a different fact
      // from "your filter hid everything", and it needs a different sentence.
      panel.append(emptyState(
        'star',
        this.bookId ? '此技能书中没有技能' : '此存档中没有技能',
        this.bookId
          ? '该技能书已打开,但其技能节点下没有任何内容。请切回全部技能书。'
          : '存档已打开,但其中没有任何像技能书的内容 — 技能书是内部带有 "skill" 节点的 .img。' +
            '如果你限定到了某个文件,试试其他文件。',
        this.bookId
          ? el('button', { class: 'btn', onclick: () => this.setBook(null) },
              icon('layers', { size: 15 }), '显示全部技能书')
          : el('button', { class: 'btn', onclick: () => this.load() },
              icon('refresh', { size: 15 }), '重新加载')));
    } else if (!results.length) {
      panel.append(emptyState(
        'search',
        this.query ? `没有技能匹配 "${this.query}"` : '此筛选下没有内容',
        this.query
          ? (this.capabilities.names
              ? '试试类似 1001 的技能 ID、名称的一部分,或职业技能书名称。'
              : 'String.wz 未打开,因此这里没有技能名称 — 请改用 ID 搜索。')
          : this.filter === 'bad'
            ? '此存档中的每个公式都解析成功。这是最好的结果。'
            : '此处的所有技能都被筛选掉了。请切回全部。',
        this.query
          ? el('button', { class: 'btn', text: '清除搜索', onclick: () => { this.query = ''; this.render(); } })
          : el('button', { class: 'btn', text: '显示全部技能',
              onclick: () => { this.filter = 'all'; localStorage.setItem('mb.skillFilter', 'all'); this.render(); } })));
    } else {
      const grid = el('div', { class: 'sk-grid' });
      for (const skill of slice) grid.append(this.buildCard(skill));
      panel.append(grid);
      if (pages > 1) panel.append(this.buildPager(pages));
    }

    this.resultHost.append(panel);
  }

  buildCard(skill) {
    const selected = this.selection.has(skill.path);
    const card = el('div', {
      class: 'sk-card', 'data-path': skill.path, 'data-skill-id': skill.skillId,
      'data-selected': selected ? 'true' : 'false',
    });

    const box = el('input', {
      type: 'checkbox', checked: selected,
      'aria-label': `选择 ${skill.name || `技能 ${skill.skillId}`}`,
    });
    box.addEventListener('change', () => {
      if (box.checked) this.selection.add(skill.path); else this.selection.delete(skill.path);
      card.dataset.selected = box.checked ? 'true' : 'false';
      // Only the counter and the bulk button change, so the grid is left alone
      // -- repainting it here would throw away the checkbox that was clicked.
      this.refreshSelectionBar();
    });

    const badges = el('div', { class: 'sk-badges' },
      el('span', { class: 'sk-badge', 'data-kind': skill.storage, text: STORAGE_LABEL[skill.storage] ?? skill.storage }),
      skill.badFormulas
        ? el('span', {
            class: 'sk-badge', 'data-kind': 'bad',
            'data-tip': '此技能中的某个公式无法解析。打开它可查看错误。',
            text: `${fmt.format(skill.badFormulas)} 个损坏`,
          })
        : null,
      skill.passive ? el('span', { class: 'sk-badge', 'data-kind': 'passive', text: '被动' }) : null,
      skill.invisible ? el('span', { class: 'sk-badge', 'data-kind': 'hidden', text: '隐藏' }) : null,
      skill.dirty ? el('span', { class: 'sk-badge', 'data-kind': 'dirty', text: '未保存' }) : null);

    // A formula is shown as the expression it is, in mono. Rounding it into a
    // number would be inventing a level to show it at.
    const expression = (label, value) => (value
      ? el('div', { class: 'sk-row' },
          el('span', { class: 'k', text: label }),
          el('code', { class: 'v', text: value }))
      : null);

    const stored = skill.storage === 'formula' ? '' : ' · 1 级';

    card.append(...[
      el('div', { class: 'sk-card-head' },
        el('label', { class: 'sk-pick' }, box),
        skillIcon(skill.path, 40, this.sprites?.signal),
        el('div', { class: 'sk-card-title' },
          el('button', {
            class: 'sk-title', text: skill.name || `技能 ${skill.skillId}`,
            'data-tip': '打开等级表', onclick: () => this.openSkillCard(skill),
          }),
          el('div', { class: 'sk-sub', text: `ID ${skill.skillId} · ${skill.bookName || `技能书 ${skill.bookId}`}` })),
        el('span', {
          class: 'sk-level', 'data-tip': '此技能声明的等级',
          // Never 0: the API sends null when nothing declares a level count, and
          // "Lv 0" would read as a fact rather than as an absence.
          text: skill.maxLevel ? `Lv 1–${fmt.format(skill.maxLevel)}` : 'Lv —',
        })),
      badges,
      expression(`伤害${stored}`, skill.damage),
      expression(`MP 消耗${stored}`, skill.mpCon),
      expression(`冷却${stored}`, skill.cooltime),
      el('div', { class: 'sk-row' },
        el('span', { class: 'k', text: '已存储的等级' }),
        el('span', { class: 'v', text: skill.levelCount
          ? `${fmt.format(skill.levelCount)} 个节点`
          : '无 — 由公式计算' })),
      el('div', { class: 'sk-actions' },
        el('button', { class: 'btn btn-sm', style: 'flex:1', onclick: () => this.openSkillCard(skill) },
          icon('grid4', { size: 14 }), '等级'),
        el('button', {
          class: 'btn btn-sm btn-icon', 'data-tip': '更多',
          onclick: (event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            this.app.showMenu(this.menuItemsFor(skill), rect.left, rect.bottom + 4);
          },
        }, icon('more', { size: 15 }))),
    ].filter(Boolean));

    return card;
  }

  /** Shared by the card overflow and the app-wide right-click menu. */
  menuItemsFor(skill) {
    return [
      { icon: 'grid4', label: '打开等级表…', run: () => this.openSkillCard(skill) },
      skill.storage === 'formula' || skill.storage === 'mixed'
        ? { icon: 'sliders', label: '将公式烘焙为等级…', run: () => this.openSkillCard(skill, { bake: true }) }
        : null,
      { icon: 'copy', label: `复制技能 ID ${skill.skillId}`, run: () => this.app.copyText(String(skill.skillId)) },
      { icon: 'externalLink', label: '在资源管理器中显示', run: () => {
        this.app.setMode('explorer');
        this.app.navigate(skill.path);
      } },
    ].filter(Boolean);
  }

  /** Repaints the selection bar in place; see buildCard for why not the grid. */
  refreshSelectionBar() {
    const current = this.host.querySelector('.sk-selbar');
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

  /* ============================================================
     THE SKILL CARD
     ============================================================ */

  // Guarded because the detail is fetched *before* modal() runs: two fast clicks
  // would otherwise race, and the second card's commit closures would point at a
  // form the first one had already replaced.
  openSkillCard(skill, options = {}) {
    return this.guard(`card:${skill.path}`, () => this.buildSkillCard(skill, options));
  }

  async buildSkillCard(skill, { bake = false } = {}) {
    let detail;
    try {
      detail = await api.skillDetail(skill.path);
    } catch (error) {
      toastError(error, '无法读取该技能');
      return;
    }

    const ctx = {
      skill,
      detail,
      levelPage: 1,
      touched: false,
      /**
       * Values the user has typed for free variables, by name. Kept on the card
       * rather than in the archive: they are what the client would supply at
       * runtime, so writing them anywhere would be inventing data.
       */
      vars: {},
      /** { level, key } of the cell to put the caret back in after a commit. */
      focus: null,
      close: null,
    };
    this.detail = ctx;

    const body = el('div', { class: 'sk-detail' });

    const paint = () => {
      clear(body);
      body.append(...[
        this.buildDetailHead(ctx),
        ctx.detail.warning ? this.buildTrapStrip(ctx) : null,
        ctx.detail.variables?.length ? this.buildVariableStrip(ctx) : null,
        this.buildFormulaPanel(ctx),
        this.buildLevelTable(ctx),
        this.buildFieldPanel(ctx),
      ].filter(Boolean));

      // A commit repaints the whole body, which would otherwise pull the caret
      // out of the cell the user pressed Enter in.
      if (ctx.focus) {
        const { level, key } = ctx.focus;
        ctx.focus = null;
        const back = body.querySelector(`[data-cell="${CSS.escape(`${level}:${key}`)}"] input`);
        if (back) { back.focus(); back.select?.(); }
      }
    };

    /** Re-reads the skill from the server and repaints. Every write ends here. */
    ctx.reload = async (next) => {
      ctx.detail = next ?? await api.skillDetail(ctx.skill.path, ctx.vars);
      // The card behind the dialog reads the list DTO, and only the detail knows
      // what was just written -- without this, baking a skill leaves "Formulas"
      // on the card until the next full reload.
      ctx.skill.storage = ctx.detail.storage;
      ctx.skill.maxLevel = ctx.detail.maxLevel;
      ctx.skill.levelCount = ctx.detail.levels.filter((row) => row.present).length;
      ctx.skill.dirty = ctx.detail.dirty ?? ctx.skill.dirty;
      paint();
    };

    paint();

    const { dialog, close } = modal({
      title: ctx.detail.name || `技能 ${ctx.detail.skillId}`,
      subtitle: `${ctx.detail.bookName || `技能书 ${ctx.detail.bookId}`} · ${ctx.detail.path.split('/').slice(1).join('/')}`,
      width: 'min(97vw, 1180px)',
      body,
      actions: [{ label: '完成' }],
    });
    // Handed to the head and the strips, all of which are painted before the
    // dialog that owns them exists.
    ctx.close = close;

    dialog.addEventListener('close', () => {
      if (this.detail === ctx) this.detail = null;
      // Committed cells change the numbers on the card behind this dialog, and
      // the list is the only thing that knows them. Reloading once on close
      // beats a reload per keystroke.
      if (ctx.touched) this.load();
    }, { once: true });

    if (bake) this.openBakeDialog(ctx);
  }

  buildDetailHead(ctx) {
    const d = ctx.detail;
    const levels = d.levels.filter((row) => row.present).length;

    return el('div', { class: 'sk-detail-head' },
      skillIcon(d.path, 52),
      el('div', { class: 'sk-detail-id' },
        el('div', { class: 'sk-detail-name', text: d.name || `技能 ${d.skillId}` }),
        el('div', { class: 'sk-sub', text: `ID ${d.skillId} · ${STORAGE_BLURB[d.storage] ?? ''}` })),
      el('span', { class: 'sk-badge', 'data-kind': d.storage, text: STORAGE_LABEL[d.storage] ?? d.storage }),
      el('span', {
        class: 'sk-level',
        text: d.maxLevel ? `Lv 1–${fmt.format(d.maxLevel)}` : 'Lv —',
      }),
      el('span', { class: 'sk-sub', text: `${fmt.format(levels)} 个已存储等级` }),
      el('span', { style: 'margin-left:auto' }),
      d.hasCommon
        ? el('button', {
            class: 'btn btn-sm btn-primary',
            'data-tip': '将公式转换为真实的等级节点',
            onclick: () => this.openBakeDialog(ctx),
          }, icon('sliders', { size: 14 }), '烘焙为等级…')
        : null,
      el('button', {
        class: 'btn btn-sm', 'data-tip': '在资源管理器中打开此技能',
        // Closing first: leaving the card sitting over the Explorer hides the
        // node it just navigated to, which reads as the button doing nothing.
        onclick: () => {
          ctx.close?.();
          this.app.setMode('explorer');
          this.app.navigate(ctx.detail.path);
        },
      }, icon('externalLink', { size: 14 }), '在资源管理器中显示'));
  }

  /**
   * The trap this section exists to stop, stated where it is sprung.
   *
   * While a `common` block exists the client computes every level from the
   * formulas and never looks at `level/`, so adding `level/1/damage` to such a
   * skill writes fine, turns the cell green, and changes precisely nothing in
   * game. The server sends the sentence; this puts it above the table it is
   * about.
   */
  buildTrapStrip(ctx) {
    return el('div', { class: 'sk-trap' },
      icon('alert', { size: 16 }),
      el('div', { class: 'sk-trap-text' },
        el('b', { text: '客户端读取的是公式,而不是等级节点。 ' }),
        el('span', { text: ctx.detail.warning })),
      el('button', {
        class: 'btn btn-sm',
        onclick: () => this.openBakeDialog(ctx),
      }, icon('sliders', { size: 14 }), '烘焙为等级…'));
  }

  /* ============================================================
     FREE VARIABLES
     ============================================================ */

  /**
   * Inputs for the names a formula reads that this skill does not define.
   *
   * MapleStory formulas are not confined to the level variable. Most names
   * resolve inside the skill's own common block -- "damage = 140+y" reads the
   * y sitting next to it -- and those never reach here. What does reach here is
   * a name the archive genuinely does not carry, like the x30 in "200+4*x30",
   * which the client knows from somewhere this editor cannot see.
   *
   * The alternatives were both worse than asking. Refusing the formula calls
   * the game's own data invalid, which it is not. Assuming 0 fills the column
   * with numbers that look computed and are not, and a wrong damage table that
   * looks right is the failure this whole screen is built to avoid.
   *
   * Nothing typed here is written anywhere. It changes what the preview
   * computes and stops when the card closes.
   */
  buildVariableStrip(ctx) {
    const strip = el('div', { class: 'sk-varbar' });

    strip.append(el('div', { class: 'sk-varbar-lead' },
      icon('info', { size: 14 }),
      el('span', {
        text: ctx.detail.variables.length === 1
          ? '这些公式中有一个值来自客户端,而非存档:'
          : '这些公式中的某些值来自客户端,而非存档:',
      })));

    for (const variable of ctx.detail.variables) {
      const input = el('input', {
        class: 'sk-input sk-var-input',
        value: ctx.vars[variable.name] ?? variable.value ?? '',
        placeholder: '?',
        spellcheck: 'false',
        inputmode: 'decimal',
        'aria-label': `${variable.name} 的值`,
      });

      // Committed on blur and Enter rather than on every keystroke: each commit
      // is a round trip that repaints the table, and doing that per character
      // makes the box impossible to type in.
      const commit = () => {
        const text = input.value.trim();
        const next = text === '' ? undefined : Number(text);
        if (text !== '' && !Number.isFinite(next)) {
          toast(`"${text}" 不是数字。`, 'warn');
          input.value = ctx.vars[variable.name] ?? '';
          return;
        }
        if (ctx.vars[variable.name] === next) return;
        if (next === undefined) delete ctx.vars[variable.name];
        else ctx.vars[variable.name] = next;
        ctx.reload().catch((error) => toastError(error, '无法重新计算表格'));
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        if (event.key === 'Escape') { input.value = ctx.vars[variable.name] ?? ''; input.blur(); }
      });

      strip.append(el('label', { class: 'sk-var' },
        el('code', { class: 'sk-var-name', text: variable.name }),
        input));
    }

    return strip;
  }

  /* ============================================================
     FORMULAS
     ============================================================ */

  /**
   * The formulas, readable and editable.
   *
   * For 81% of a client this block *is* the skill's per-level data -- the level
   * table below is a rendering of it. Editing one here changes every level at
   * once, which is both the fast way to retune a skill and the only edit the
   * client will actually read while the common block exists.
   */
  buildFormulaPanel(ctx) {
    const columns = ctx.detail.columns.filter((column) => column.formula != null);
    if (!columns.length) return null;

    const bad = columns.filter((column) => column.source === 'error').length;

    const list = el('div', { class: 'sk-formulas' });
    for (const column of columns) list.append(this.buildFormulaRow(ctx, column));

    // The dialect comes from the capabilities call rather than from a constant
    // here, so the help under the boxes cannot drift from the parser that has
    // to accept what is typed into them.
    const formula = this.capabilities.formula || {};

    const details = el('details', { class: 'sk-section', open: true });
    // Filtered, because this is Element.append rather than el(): append(null)
    // does not skip the child, it stringifies it and puts the word "null" on
    // the panel.
    details.append(...[
      el('summary', {},
        el('span', { class: 'sk-section-name', text: '公式' }),
        el('span', { class: 'sk-section-meta',
          text: `${columns.length} 个条目位于 common · x 表示等级` }),
        bad
          ? el('span', { class: 'sk-section-bad', text: `${bad} 个无法解析` })
          : null),
      list,
      el('div', { class: 'sk-hint',
        text: `表达式基于 ${formula.variable || 'x'}(等级)。运算符 ` +
              `${formula.operators || '+ - * / % ( )'},函数 ` +
              `${(formula.functions || ['u', 'd', 'min', 'max']).join(', ')} ` +
              '(u 向上取整,d 向下取整)。在此编辑一处,每个等级都会同时改变。' }),
      ctx.detail.hasPvpCommon
        ? el('div', { class: 'sk-hint',
            text: '此技能还有一个带独立公式的 PVPcommon 块。它不会在此显示或修改 — 请在资源管理器中打开它。' })
        : null,
    ].filter(Boolean));
    return details;
  }

  buildFormulaRow(ctx, column) {
    const editable = column.formulaPath && column.source !== 'container';

    const row = el('div', { class: 'sk-formula', 'data-source': column.source });
    row.append(el('div', { class: 'sk-formula-label' },
      el('span', { class: 'sk-formula-name', text: fieldLabel(column.key, column.label) }),
      el('code', { class: 'sk-key', text: column.key }),
      column.unit ? el('span', { class: 'sk-unit', text: column.unit }) : null,
      column.source === 'constant'
        ? el('span', { class: 'sk-tag', 'data-tone': 'flat', text: '每个等级相同' })
        : null,
      column.source === 'container'
        ? el('span', { class: 'sk-tag', 'data-tone': 'flat', text: '一组数值' })
        : null));

    if (!editable) {
      row.append(el('code', { class: 'sk-formula-static', text: column.formula ?? '' }));
      row.append(el('div', { class: 'sk-hint',
        text: '这里保存的是一组数值,而不是单个表达式。请在资源管理器中打开它编辑内部内容。' }));
      return row;
    }

    const input = el('input', {
      class: 'sk-input sk-mono', value: column.formula ?? '', spellcheck: 'false',
      'aria-label': `${fieldLabel(column.key, column.label)} 公式`,
    });
    const committed = column.formula ?? '';

    const send = () => {
      if (input.value === committed) return;
      this.commitFormula(ctx, column, input.value, () => { input.value = committed; });
    };
    input.addEventListener('blur', send);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); send(); }
      else if (event.key === 'Escape') { event.preventDefault(); input.value = committed; input.blur(); }
    });

    row.append(input);

    if (column.formulaError) {
      row.append(el('div', { class: 'sk-formula-error' },
        icon('alert', { size: 13 }),
        el('span', { text: column.formulaError })));
    }
    if (column.hint) row.append(el('div', { class: 'sk-hint', text: column.hint }));
    return row;
  }

  /**
   * Writes one `common/<key>` expression.
   *
   * Through /api/node/value rather than a skill-shaped endpoint because a
   * formula is one WZ string and the detail hands over its exact path for
   * precisely this. It is still WzEditService underneath, so it shares the one
   * dirty state and one undo history like everything else (rule 5).
   */
  commitFormula(ctx, column, value, revert) {
    return this.guard(`formula:${column.formulaPath}`, async () => {
      try {
        await api.setValue(column.formulaPath, value);
        ctx.touched = true;
        this.app.markDirty();
        // Re-read rather than patch: one formula decides a whole column of the
        // table below, and maxLevel decides how many rows there are.
        await ctx.reload();
        toast(`已将 ${fieldLabel(column.key, column.label)} 设为 ${value || '空'},对所有等级生效。`, 'success', {
          action: { label: '撤销', run: async () => { await this.app.undo(); await this.refresh(); } },
        });
      } catch (error) {
        revert?.();
        toastError(error, '无法保存该公式');
      }
    });
  }

  /* ============================================================
     THE LEVEL TABLE
     ============================================================ */

  buildLevelTable(ctx) {
    const d = ctx.detail;
    const section = el('div', { class: 'sk-section' });
    // Held, so paging can replace exactly this node. Finding it by selector
    // would pick the wrong table the moment a second dialog is open over it.
    ctx.tableHost = section;

    if (!d.columns.length || !d.levels.length) {
      section.append(el('div', { class: 'sk-section-bar' },
        el('span', { class: 'sk-section-name', text: '等级' })));
      section.append(emptyState(
        'grid4', '此技能没有等级',
        '没有声明 maxLevel,也没有等级节点,因此没有可绘制的表格。' +
        '添加等级 1 即可创建第一个。',
        el('button', {
          class: 'btn btn-primary',
          onclick: () => this.levelOp(ctx, { op: 'add', level: 1 }, '已添加等级 1'),
        }, icon('plus', { size: 15 }), '添加等级 1')));
      return section;
    }

    const pages = Math.max(1, Math.ceil(d.levels.length / LEVEL_PAGE));
    ctx.levelPage = Math.min(Math.max(1, ctx.levelPage), pages);
    const slice = d.levels.slice((ctx.levelPage - 1) * LEVEL_PAGE, ctx.levelPage * LEVEL_PAGE);

    const jump = el('input', {
      class: 'sk-input sk-jump', type: 'number', min: '1', placeholder: '等级…',
      'aria-label': '跳转到某个等级',
    });
    jump.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const wanted = Number(jump.value);
      const index = d.levels.findIndex((row) => row.level === wanted);
      if (index < 0) { toast(`此技能没有等级 ${jump.value}。`, 'warning'); return; }
      ctx.levelPage = Math.floor(index / LEVEL_PAGE) + 1;
      this.repaintTable(ctx);
    });

    section.append(el('div', { class: 'sk-section-bar' },
      el('span', { class: 'sk-section-name', text: '等级' }),
      el('span', { class: 'sk-section-meta',
        text: `${fmt.format(d.levels.length)} 行 · ` +
              `${fmt.format(d.columns.length)} 个字段` +
              (pages > 1 ? ` · 显示 ${slice[0].level}–${slice[slice.length - 1].level}` : '') }),
      el('span', { style: 'margin-left:auto' }),
      jump,
      el('button', {
        class: 'btn btn-sm',
        'data-tip': '创建下一个等级节点',
        onclick: () => this.addNextLevel(ctx),
      }, icon('plus', { size: 14 }), '添加等级')));

    if (d.truncated) {
      section.append(el('div', { class: 'sk-note' }, icon('alert', { size: 14 }),
        el('span', { text: `此技能声明的等级数超过服务器会构建的表格范围。` +
                           '下面的行在其 maxLevel 之前停止。' })));
    }

    section.append(this.buildTable(ctx, slice));

    if (pages > 1) {
      const pager = el('div', { class: 'pager' });
      const go = (page) => { ctx.levelPage = page; this.repaintTable(ctx); };
      pager.append(el('button', { text: '‹ 上一页', disabled: ctx.levelPage === 1, onclick: () => go(ctx.levelPage - 1) }));
      const numbers = new Set([1, pages, ctx.levelPage, ctx.levelPage - 1, ctx.levelPage + 1]);
      let previous = 0;
      for (const page of [...numbers].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b)) {
        if (page - previous > 1) pager.append(el('span', { text: '…', style: 'color:var(--text-3)' }));
        const first = d.levels[(page - 1) * LEVEL_PAGE].level;
        const last = d.levels[Math.min(page * LEVEL_PAGE, d.levels.length) - 1].level;
        pager.append(el('button', {
          text: `${first}–${last}`, 'aria-current': page === ctx.levelPage ? 'true' : 'false',
          onclick: () => go(page),
        }));
        previous = page;
      }
      pager.append(el('button', { text: '下一页 ›', disabled: ctx.levelPage === pages, onclick: () => go(ctx.levelPage + 1) }));
      section.append(pager);
    }

    section.append(el('div', { class: 'sk-legend' },
      el('span', { class: 'sk-legend-item' },
        el('span', { class: 'sk-swatch', 'data-source': 'explicit' }), '已存储 — 可编辑'),
      el('span', { class: 'sk-legend-item' },
        el('span', { class: 'sk-swatch', 'data-source': 'formula' }), '由公式计算 — 只读'),
      el('span', { class: 'sk-legend-item' },
        el('span', { class: 'sk-swatch', 'data-source': 'constant' }), '每个等级都相同'),
      el('span', { class: 'sk-legend-item' },
        el('span', { class: 'sk-swatch', 'data-source': 'missing' }), '未设置 — 输入即可创建'),
      el('span', { class: 'sk-legend-item' },
        el('span', { class: 'sk-swatch', 'data-source': 'needs' }), '等待客户端提供数值'),
      el('span', { class: 'sk-legend-item' },
        el('span', { class: 'sk-swatch', 'data-source': 'error' }), '无法读取的公式')));

    return section;
  }

  /** Repaints only the table, so paging does not disturb the formula boxes. */
  repaintTable(ctx) {
    const current = ctx.tableHost;
    if (!current?.isConnected) return;
    current.replaceWith(this.buildLevelTable(ctx));
  }

  buildTable(ctx, rows) {
    const columns = ctx.detail.columns;

    const head = el('tr', {},
      el('th', { class: 'sk-th-level', text: '等级' }),
      columns.map((column) => el('th', { 'data-source': column.source },
        el('span', { class: 'sk-th-label', text: fieldLabel(column.key, column.label) }),
        // The raw key under the label: a write has to match that spelling, and
        // someone who knows the WZ needs to see it (rule 1, both halves).
        el('code', { class: 'sk-th-key', text: column.key + (column.unit ? ` (${column.unit})` : '') }),
        column.formula != null
          ? el('code', {
              class: 'sk-th-formula',
              'data-tip': column.source === 'error'
                ? `无法解析此公式: ${column.formulaError}`
                : `common/${column.key} = ${column.formula}`,
              text: column.formula,
            })
          : null)));

    const body = el('tbody');
    for (const row of rows) {
      const tr = el('tr', { 'data-present': row.present ? 'true' : 'false' });
      tr.append(el('th', { class: 'sk-th-level', scope: 'row' },
        el('button', {
          class: 'sk-level-btn',
          'data-tip': row.present
            ? `level/${row.level} 已存在。可复制、移除或重编号。`
            : `没有 level/${row.level} 节点 — 此行由公式计算。等级操作。`,
          onclick: (event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            this.app.showMenu(this.levelMenu(ctx, row), rect.left, rect.bottom + 4);
          },
        }, String(row.level)),
        row.present ? null : el('span', { class: 'sk-ghost', 'data-tip': '此等级没有节点', text: '·' })));

      for (const column of columns) {
        const cell = row.cells.find((c) => c.key === column.key);
        tr.append(this.buildCell(ctx, row, column, cell));
      }
      body.append(tr);
    }

    return el('div', { class: 'sk-table-scroll' },
      el('table', { class: 'sk-table' }, el('thead', {}, head), body));
  }

  /**
   * One cell.
   *
   * The whole point of the screen is in the branch: a computed cell is a
   * rendering of an expression, not a stored value, so it is drawn as text with
   * the expression behind it and there is no input to type into. Making it an
   * input that silently discarded the edit -- or worse, wrote a level node the
   * client ignores -- is the failure this section exists to prevent.
   */
  buildCell(ctx, row, column, cell) {
    const source = cell?.source ?? 'missing';
    const td = el('td', { 'data-source': source, 'data-cell': `${row.level}:${column.key}` });

    if (COMPUTED.has(source)) {
      // Waiting on a value, not broken. Drawn quietly and pointing at the box
      // that fixes it, because a red cell down thirty rows reads as "this skill
      // is damaged" when the formula is perfectly good.
      if (source === 'needs') {
        td.append(el('span', {
          class: 'sk-cell-needs',
          'data-tip': cell?.error
            || `此公式读取 ${(column.needs || []).join(', ')},而存档中没有这些值。`
               + '在卡片顶部输入数值,该列就会填上。',
          text: (column.needs || []).join(', ') || '?',
        }));
        return td;
      }

      if (source === 'error') {
        td.append(el('span', {
          class: 'sk-cell-bad', 'data-tip': cell?.error || column.formulaError || '无法读取此公式。',
          // No number at all. A 0 here is indistinguishable from a real 0, and
          // the one skill in a stock v232 client that lands here (65000003,
          // y = "140+y") would read as a working skill with no effect.
          text: '—',
        }, icon('alert', { size: 12 })));
        return td;
      }

      td.append(el('span', {
        class: 'sk-cell-computed',
        'data-tip': source === 'container'
          ? `${column.key} 保存一组数值。请在资源管理器中打开。`
          : `由 common/${column.key} = ${column.formula} 计算得出。可编辑公式,或烘焙为等级。`,
        text: cell?.value ?? '—',
      }));
      return td;
    }

    const value = cell?.value ?? '';
    const input = el('input', {
      class: 'sk-input sk-cell-input', value, spellcheck: 'false',
      'aria-label': `等级 ${row.level} 的 ${fieldLabel(column.key, column.label)}`,
      placeholder: source === 'missing' ? '—' : null,
      inputmode: column.kind === 'Int' ? 'numeric' : null,
    });
    let committed = value;

    if (column.kind === 'Int') input.addEventListener('focus', () => input.select());

    const send = () => {
      const next = input.value;
      if (next === committed) return;

      if (column.kind === 'Int' && next.trim() !== '' && !Number.isFinite(Number(next))) {
        input.dataset.invalid = 'true';
        input.title = `${fieldLabel(column.key, column.label)} 必须是数字。`;
        return;
      }
      delete input.dataset.invalid;
      input.title = '';
      // Recorded before the request, so a blur that follows the Enter that
      // started it does not send the same edit twice.
      committed = next;
      ctx.focus = { level: row.level, key: column.key };
      this.commitCell(ctx, row, column, next, () => { input.value = committed = value; });
    };

    input.addEventListener('blur', send);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); send(); }
      else if (event.key === 'Escape') { event.preventDefault(); input.value = committed; input.blur(); }
      // Down and up move to the same field one level away, which is how anyone
      // filling in a table actually works (rule 8).
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const target = this.neighbourCell(td, step);
        if (!target) return;
        event.preventDefault();
        send();
        target.focus();
        target.select?.();
      }
    });

    td.append(input);
    return td;
  }

  /** The input in the same column, `step` rows away, if it is editable. */
  neighbourCell(td, step) {
    const tr = td.parentElement;
    const index = [...tr.children].indexOf(td);
    const next = step > 0 ? tr.nextElementSibling : tr.previousElementSibling;
    return next?.children[index]?.querySelector('input') ?? null;
  }

  commitCell(ctx, row, column, value, revert) {
    return this.guard(`cell:${ctx.detail.path}:${row.level}:${column.key}`, async () => {
      try {
        const next = await api.skillWriteLevels(ctx.detail.path, [
          { level: row.level, key: column.key, value },
        ]);
        ctx.touched = true;
        this.app.markDirty();
        await ctx.reload(next);
        // Said once per commit rather than as a toast per cell: the cell turns
        // green and that is the receipt. The trap is what needs saying.
        if (ctx.detail.hasCommon) {
          toast(
            `已写入 level/${row.level}/${column.key} — 但此技能仍有 common 块,因此 ` +
            '客户端会继续从公式计算此值,并忽略你刚刚写入的内容。',
            'warning', { title: '已保存,但客户端不会读取它' });
        }
      } catch (error) {
        revert?.();
        toastError(error, '无法保存该值');
      }
    });
  }

  /* ============================================================
     LEVEL OPERATIONS
     ============================================================ */

  levelMenu(ctx, row) {
    const level = row.level;
    return [
      row.present
        ? null
        : { icon: 'plus', label: `创建等级 ${level} 为真实节点`,
            run: () => this.levelOp(ctx, { op: 'add', level }, `已添加等级 ${level}`) },
      row.present
        ? { icon: 'copy', label: `复制等级 ${level} 到新等级…`, run: () => this.cloneLevel(ctx, level) }
        : null,
      row.present
        ? { icon: 'edit', label: `重编号等级 ${level}…`, run: () => this.renameLevel(ctx, level) }
        : null,
      row.present
        ? { icon: 'trash', label: `移除等级 ${level}`, run: () => this.removeLevel(ctx, level) }
        : null,
      { icon: 'externalLink', label: '在资源管理器中显示此等级', run: () => {
        ctx.close?.();
        this.app.setMode('explorer');
        this.app.navigate(row.path);
      } },
    ].filter(Boolean);
  }

  addNextLevel(ctx) {
    // The first gap, not maxLevel+1: a skill missing level 7 wants level 7 far
    // more often than it wants level 31.
    const present = new Set(ctx.detail.levels.filter((row) => row.present).map((row) => row.level));
    let level = 1;
    while (present.has(level)) level++;
    return this.levelOp(ctx, { op: 'add', level }, `已添加等级 ${level}`);
  }

  async cloneLevel(ctx, from) {
    const answer = await promptForText({
      title: `复制等级 ${from}`,
      message: '副本应成为哪个等级编号?该等级必须尚不存在。',
      value: String(from + 1),
      confirmLabel: '复制该等级',
    });
    if (!answer) return;
    const level = Number(answer);
    if (!Number.isInteger(level) || level < 1) { toast('等级是从 1 开始的正整数。', 'warning'); return; }
    return this.levelOp(ctx, { op: 'clone', from, level }, `已将等级 ${from} 复制到 ${level}`);
  }

  async renameLevel(ctx, level) {
    const answer = await promptForText({
      title: `重编号等级 ${level}`,
      message: '此等级应变成多少?目标编号必须空闲。',
      value: String(level + 1),
      confirmLabel: '重编号',
    });
    if (!answer) return;
    const to = Number(answer);
    if (!Number.isInteger(to) || to < 1) { toast('等级是从 1 开始的正整数。', 'warning'); return; }
    return this.levelOp(ctx, { op: 'rename', level, to }, `等级 ${level} 现在是等级 ${to}`);
  }

  async removeLevel(ctx, level) {
    const ok = await confirmDialog({
      title: `移除等级 ${level}?`,
      message: `level/${level} 下存储的所有内容都会一并删除。保存前不会写入磁盘,` +
               '而且这只是一次 Ctrl+Z。',
      confirmLabel: '移除该等级',
    });
    if (!ok) return;
    return this.levelOp(ctx, { op: 'remove', level }, `已移除等级 ${level}`);
  }

  levelOp(ctx, request, success) {
    return this.guard(`level:${ctx.detail.path}:${request.op}:${request.level}`, async () => {
      try {
        const next = await api.skillLevelOp({ path: ctx.detail.path, ...request });
        ctx.touched = true;
        this.app.markDirty();
        await ctx.reload(next);
        toast(success, 'success', {
          action: { label: '撤销', run: async () => { await this.app.undo(); await this.refresh(); } },
        });
      } catch (error) {
        toastError(error, '无法更改该等级');
      }
    });
  }

  /* ============================================================
     SKILL-WIDE FIELDS
     ============================================================ */

  /** masterLevel, weapon, elemAttr and the rest of info/ — one value per skill, not per level. */
  buildFieldPanel(ctx) {
    const groups = ctx.detail.groups || [];
    if (!groups.length) return null;

    const details = el('details', { class: 'sk-section' });
    details.append(el('summary', {},
      el('span', { class: 'sk-section-name', text: '技能级字段' }),
      el('span', { class: 'sk-section-meta',
        text: groups.reduce((total, group) => total + group.fields.length, 0) + ' 个等级表之外的字段' })));

    for (const group of groups) {
      details.append(el('div', { class: 'sk-group-name', text: group.group }));
      const grid = el('div', { class: 'sk-field-grid' });
      for (const field of group.fields) grid.append(this.buildField(ctx, field));
      details.append(grid);
    }
    return details;
  }

  buildField(ctx, field) {
    const row = el('div', { class: 'sk-field' });
    row.append(el('div', { class: 'sk-field-label' },
      el('span', { class: 'sk-field-name', text: fieldLabel(field.key, field.label) }),
      el('code', { class: 'sk-key', text: field.key }),
      field.unit ? el('span', { class: 'sk-unit', text: field.unit }) : null));

    if (!field.editable) {
      // A container: shown, never faked into an editable box. Rule 12 asks for
      // the edge to be visible with a reason beside it.
      row.append(el('div', { class: 'sk-field-static', text: field.value ?? '—' }));
      row.append(el('div', { class: 'sk-hint' },
        el('span', { text: '一组数值 — ' }),
        el('button', {
          class: 'sk-link',
          onclick: () => { ctx.close?.(); this.app.setMode('explorer'); this.app.navigate(field.path); },
        }, '在资源管理器中编辑')));
      return row;
    }

    const value = field.value ?? '';

    if (field.kind === 'Flag') {
      const box = el('input', { type: 'checkbox', checked: value === '1' });
      box.addEventListener('change', () => {
        this.commitField(ctx, field, box.checked ? '1' : '0', () => { box.checked = value === '1'; });
      });
      row.append(el('label', { class: 'sk-check' }, box, el('span', { text: value === '1' ? '开' : '关' })));
      if (field.hint) row.append(el('div', { class: 'sk-hint', text: field.hint }));
      return row;
    }

    const input = el('input', {
      class: 'sk-input', value, spellcheck: 'false',
      inputmode: field.kind === 'Int' ? 'numeric' : null,
      'aria-label': fieldLabel(field.key, field.label),
    });
    const send = () => {
      if (input.value === value) return;
      this.commitField(ctx, field, input.value, () => { input.value = value; });
    };
    input.addEventListener('blur', send);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); send(); }
      else if (event.key === 'Escape') { event.preventDefault(); input.value = value; input.blur(); }
    });
    row.append(input);
    if (field.hint) row.append(el('div', { class: 'sk-hint', text: field.hint }));
    return row;
  }

  /** Same reasoning as commitFormula: one WZ node, its own path, WzEditService underneath. */
  commitField(ctx, field, value, revert) {
    return this.guard(`field:${field.path}`, async () => {
      try {
        await api.setValue(field.path, value);
        ctx.touched = true;
        this.app.markDirty();
        await ctx.reload();
      } catch (error) {
        revert?.();
        toastError(error, '无法保存该字段');
      }
    });
  }

  /* ============================================================
     BAKE (expand-common)
     ============================================================ */

  openBakeDialog(ctx) {
    return this.guard(`bake-dialog:${ctx.detail.path}`, () => this.buildBakeDialog(ctx));
  }

  /**
   * The headline action, and the dangerous one.
   *
   * It writes hundreds of nodes from one click -- 272 cells for skill 5221017,
   * as one undo entry -- and then deletes the common block. The deletion is not
   * tidying: while the block exists the client computes from the formulas and
   * never reads level/, so a bake that kept it would produce a perfectly correct
   * level table that changes nothing in game. That sentence is in the dialog,
   * next to the switch that turns it off, because it is the one thing a user
   * needs to understand before pressing the button (rules 2 and 6).
   */
  async buildBakeDialog(ctx) {
    const d = ctx.detail;
    if (!d.hasCommon) {
      toast('此技能没有 common 块,因此没有可烘焙的公式。', 'info');
      return;
    }

    const levelsInput = el('input', {
      class: 'sk-input', type: 'number', min: '1', value: String(d.maxLevel ?? 1),
      'aria-label': '要写入多少个等级',
    });
    const overwrite = el('input', { type: 'checkbox' });
    const removeCommon = el('input', { type: 'checkbox', checked: true });

    const removeWarn = el('div', { class: 'sk-bake-warn' });
    const paintRemoveWarn = () => {
      clear(removeWarn);
      removeWarn.dataset.tone = removeCommon.checked ? 'ok' : 'bad';
      removeWarn.append(
        icon(removeCommon.checked ? 'info' : 'alert', { size: 14 }),
        el('span', {
          text: removeCommon.checked
            ? '正确。客户端优先读取 common 块而不是等级节点,因此必须删除它,下面的等级才会生效。' +
              'maxLevel 也会一并删除,这正是原版客户端中每个基于等级的技能的存储方式。'
            : '此烘焙在游戏中不会生效。客户端会继续从公式计算每个等级,并忽略这里写入的一切。' +
              '只有在你打算保留公式时,才应关闭此选项。',
        }));
    };
    paintRemoveWarn();

    const previewHost = el('div', { class: 'sk-preview-host' });
    let preview = null;

    const applyButton = el('button', {
      class: 'btn btn-red', disabled: true,
      'data-tip': '先预览 — 在你看到效果之前不会写入任何内容',
    }, icon('check', { size: 15 }), '烘焙');

    const previewButton = el('button', { class: 'btn' }, icon('eye', { size: 15 }), '预览烘焙');

    /**
     * Any change to the recipe throws the preview away.
     *
     * An Apply that stays enabled after the level count changes is an Apply that
     * writes something other than what is on screen.
     */
    const invalidate = () => {
      preview = null;
      applyButton.disabled = true;
      applyButton.textContent = '';
      applyButton.append(icon('check', { size: 15 }), '烘焙');
      clear(previewHost);
      previewHost.append(el('div', { class: 'sk-preview-empty' },
        icon('info', { size: 15 }),
        el('span', { text: '预览以查看将创建的每个节点以及将删除的所有内容。' +
                           '在那之前不会写入任何内容。' })));
    };
    levelsInput.addEventListener('input', invalidate);
    for (const box of [overwrite, removeCommon]) {
      box.addEventListener('change', () => { paintRemoveWarn(); invalidate(); });
    }
    invalidate();

    const recipe = () => ({
      path: d.path,
      levels: Number(levelsInput.value) || undefined,
      overwrite: overwrite.checked,
      removeCommon: removeCommon.checked,
    });

    previewButton.addEventListener('click', () => this.guard('bake-preview', async () => {
      clear(previewHost);
      previewHost.append(el('div', { class: 'sk-preview-empty' }, el('span', { text: '处理中…' })));
      try {
        const result = await api.skillExpandCommon({ ...recipe(), dryRun: true });
        preview = result;
        clear(previewHost);
        previewHost.append(this.buildBakePreview(ctx, result, removeCommon.checked));
        const writing = (result.changes || []).filter((c) => !c.skipped).length;
        applyButton.disabled = writing === 0;
        applyButton.textContent = '';
        applyButton.append(icon('check', { size: 15 }),
          writing ? `写入 ${fmt.format(writing)} 个数值并删除 common 块` : '没有可写入的内容');
        if (!removeCommon.checked && writing) {
          applyButton.textContent = '';
          applyButton.append(icon('check', { size: 15 }), `写入 ${fmt.format(writing)} 个数值`);
        }
      } catch (error) {
        preview = null;
        applyButton.disabled = true;
        clear(previewHost);
        previewHost.append(el('div', { class: 'sk-preview-empty', 'data-tone': 'bad' },
          icon('alert', { size: 15 }),
          el('span', { text: error.message })));
      }
    }));

    const { close } = modal({
      title: '将公式烘焙为显式等级',
      subtitle: d.name || `技能 ${d.skillId}`,
      width: 'min(96vw, 940px)',
      body: el('div', { class: 'sk-bake' },
        el('p', { class: 'sk-bake-lede',
          text: '该技能 common 块中的每个公式都会在每个等级上求值,并写成真实的 level/N 节点。' +
                '此后数值被存储,可逐级编辑,彼此独立 — 如果你希望等级不再遵循同一条曲线,这正是你想要的。' }),
        el('div', { class: 'sk-bake-grid' },
          bakeField('要写入的等级数', levelsInput,
            `该技能声明了 ${d.maxLevel ?? '无'} 个等级。写入更少则生成更少行;其余在块被删除时丢失。`),
          bakeField('替换已存在的数值',
            el('label', { class: 'sk-check' }, overwrite, el('span', { text: '覆盖' })),
            '关闭时,已保存字面值的等级会被跳过并列为已跳过。'),
          bakeField('随后删除 common 块',
            el('label', { class: 'sk-check' }, removeCommon, el('span', { text: '删除它' })),
            null)),
        removeWarn,
        el('div', { class: 'sk-bake-actions' }, previewButton, applyButton),
        previewHost,
        el('div', { class: 'tips' },
          el('b', { text: '行为说明' }),
          el('ul', {},
            el('li', { text: '预览在服务器端运行,因此你看到的就是将要写入的内容。' }),
            el('li', { text: '无法解析的公式会连同错误一起被跳过 — 绝不会写成 0。' }),
            el('li', { text: '无论创建多少节点,整个烘焙都只算一次撤销。' }),
            el('li', { text: '如有 PVPcommon 块,它会保持原样不动。' }),
            el('li', { text: '保存之前不会写入磁盘。' })))),
      actions: [{ label: '关闭' }],
    });

    applyButton.addEventListener('click', () => this.guard('bake-apply', async () => {
      if (!preview) return;
      const writing = (preview.changes || []).filter((c) => !c.skipped);
      const levels = new Set(writing.map((c) => c.level)).size;

      const ok = await confirmDialog({
        title: `烘焙 ${fmt.format(writing.length)} 个数值,涉及 ${fmt.format(levels)} 个等级?`,
        message: (removeCommon.checked
          ? 'common 块及其公式将被删除。这正是烘焙生效的原因 — ' +
            '不删除它,客户端就会继续读取公式。 '
          : 'common 块被保留,因此客户端将继续读取公式,此操作在游戏中不会生效。 ') +
          '这是一次 Ctrl+Z,保存之前不会写入磁盘。',
        confirmLabel: removeCommon.checked ? '烘焙并删除该块' : '仍然烘焙',
        danger: true,
      });
      if (!ok) return;

      try {
        const result = await api.skillExpandCommon({ ...recipe(), dryRun: false });
        const skipped = (result.changes || []).filter((c) => c.skipped).length;
        close();
        toast(
          `已写入 ${fmt.format(result.applied ?? 0)} 个数值,跨越 ` +
          `${fmt.format(result.levelsWritten ?? 0)} 个等级` +
          (result.removedCommon ? ',并删除了 common 块' : '') +
          (skipped ? `。跳过 ${fmt.format(skipped)} 个 — 原因见预览。` : '.'),
          'success', {
            action: { label: '撤销', run: async () => { await this.app.undo(); await this.refresh(); } },
          });
        // Notes are the things that are not per row -- a dropped maxLevel, an
        // untouched PVPcommon. They are not decoration and they do not belong in
        // a toast that disappears.
        for (const note of result.notes || []) toast(note, 'info', { title: '关于此次烘焙' });
        ctx.touched = true;
        this.app.markDirty();
        await ctx.reload(result.detail ?? undefined);
        await this.load();
      } catch (error) {
        toastError(error, '无法烘焙此技能');
      }
    }));
  }

  buildBakePreview(ctx, result, removingCommon) {
    const changes = result.changes || [];
    const writing = changes.filter((c) => !c.skipped);
    const skipped = changes.filter((c) => c.skipped);
    const levels = new Set(writing.map((c) => c.level));

    const body = el('tbody');
    for (const change of changes) {
      body.append(el('tr', { 'data-skipped': change.skipped ? 'true' : null },
        el('td', { class: 'num', text: String(change.level) }),
        el('td', {}, el('code', { text: change.key })),
        el('td', { class: 'num', text: change.before ?? '—' }),
        el('td', { class: 'sk-preview-arrow', text: change.skipped ? '' : '→' }),
        el('td', { class: 'num', text: change.skipped ? '—' : (change.after ?? '—') }),
        el('td', { class: 'sk-preview-note', text: change.skipped ? (change.reason || '已跳过') : (change.wzType || '') })));
    }

    // What gets deleted, spelled out. "The common block will be removed" is not
    // enough when the block is the only copy of the formulas.
    const doomed = ctx.detail.columns.filter((column) => column.formula != null);

    return el('div', {},
      el('div', { class: 'sk-preview-summary' },
        el('div', { class: 'sk-preview-stat' },
          el('span', { class: 'k', text: '创建的数值' }),
          el('span', { class: 'v', text: fmt.format(writing.length) })),
        el('div', { class: 'sk-preview-stat' },
          el('span', { class: 'k', text: '涉及的等级' }),
          el('span', { class: 'v', text: fmt.format(levels.size) })),
        el('div', { class: 'sk-preview-stat', 'data-tone': skipped.length ? 'warn' : null },
          el('span', { class: 'k', text: '已跳过' }),
          el('span', { class: 'v', text: fmt.format(skipped.length) })),
        el('div', { class: 'sk-preview-stat' },
          el('span', { class: 'k', text: '撤销步骤' }),
          el('span', { class: 'v', text: '1' }))),

      removingCommon
        ? el('div', { class: 'sk-delete-box' },
            el('div', { class: 'sk-delete-head' },
              icon('trash', { size: 14 }),
              el('b', { text: `以下 ${doomed.length + 1} 个节点将被删除` })),
            el('div', { class: 'sk-delete-list' },
              doomed.map((column) => el('div', {},
                el('code', { text: `common/${column.key}` }),
                el('span', { class: 'sk-delete-value', text: ` = ${column.formula}` }))),
              ctx.detail.maxLevel
                ? el('div', {},
                    el('code', { text: 'common/maxLevel' }),
                    el('span', { class: 'sk-delete-value', text: ` = ${ctx.detail.maxLevel}` }))
                : null),
            el('div', { class: 'sk-hint',
              text: '公式是曲线的唯一副本。此后,上面这些等级数值就是它的全部 — 这正是目的,但除撤销外无法还原。' }))
        : null,

      (result.notes || []).length
        ? el('ul', { class: 'sk-notes' }, (result.notes || []).map((note) => el('li', { text: note })))
        : null,

      el('div', { class: 'sk-preview-head' },
        el('span', { text: `将写入 ${fmt.format(writing.length)} 个` +
                           (skipped.length ? `,跳过 ${fmt.format(skipped.length)} 个` : '') })),
      el('div', { class: 'sk-preview-scroll' },
        el('table', { class: 'sk-preview' },
          el('thead', {}, el('tr', {}, ['等级', '字段', '之前', '', '之后', '类型 / 原因']
            .map((h) => el('th', { text: h })))),
          body)));
  }

  /* ============================================================
     BULK EDIT
     ============================================================ */

  openBulkDialog() {
    return this.guard('bulk-dialog', () => this.buildBulkDialog());
  }

  /**
   * The field list comes from a real skill in the selection, because which
   * fields exist depends on the client. A hardcoded list would offer keys this
   * Skill.wz does not have and hide the ones it does.
   */
  async bulkFieldOptions(path) {
    try {
      const detail = await api.skillDetail(path);
      const found = (detail.columns || [])
        .filter((column) => column.kind !== 'Point' && column.source !== 'container')
        .map((column) => [column.key, `${column.group} · ${fieldLabel(column.key, column.label)}`]);
      if (found.length) return found;
    } catch {
      /* fall through rather than blocking the dialog */
    }
    // Every skill that has a common block at all has damage or mpCon; this is
    // the safest possible guess when the probe failed.
    return [['damage', '伤害'], ['mpCon', 'MP 消耗'], ['cooltime', '冷却'], ['time', '持续时间']];
  }

  async buildBulkDialog() {
    const paths = [...this.selection];
    if (!paths.length) {
      toast('请先勾选几个技能 — 每张卡片角落都有复选框。', 'info');
      return;
    }

    const fields = await this.bulkFieldOptions(paths[0]);

    const fieldSelect = el('select', { class: 'sk-select', 'aria-label': '要更改的字段' },
      fields.map(([key, label]) => el('option', { value: key, text: label })));
    const levelInput = el('input', { class: 'sk-input', type: 'number', min: '0', value: '0' });
    const opSelect = el('select', { class: 'sk-select', 'aria-label': '执行的操作' },
      OPS.map(([value, label]) => el('option', { value, text: label })));
    const valueInput = el('input', { class: 'sk-input', type: 'number', step: 'any', value: '1' });
    const roundSelect = el('select', { class: 'sk-select', 'aria-label': '舍入方式' },
      ROUNDING.map(([value, label]) => el('option', { value, text: label })));

    const previewHost = el('div', { class: 'sk-preview-host' });
    let preview = null;

    const applyButton = el('button', {
      class: 'btn btn-primary', disabled: true,
      'data-tip': '先预览 — 在你看到具体数值之前不会写入任何内容',
    }, icon('check', { size: 15 }), `应用到 ${fmt.format(paths.length)} 个技能`);

    const previewButton = el('button', { class: 'btn' }, icon('eye', { size: 15 }), '预览更改');

    const invalidate = () => {
      preview = null;
      applyButton.disabled = true;
      clear(previewHost);
      previewHost.append(el('div', { class: 'sk-preview-empty' },
        icon('info', { size: 15 }),
        el('span', { text: '预览更改,可查看每个技能的精确前后数值,以及每个被跳过项的原因。' +
                           '在那之前不会写入任何内容。' })));
    };
    for (const control of [fieldSelect, opSelect, roundSelect]) control.addEventListener('change', invalidate);
    for (const control of [valueInput, levelInput]) control.addEventListener('input', invalidate);
    invalidate();

    const recipe = () => ({
      paths,
      field: fieldSelect.value,
      level: Number(levelInput.value) || 0,
      op: opSelect.value,
      value: Number(valueInput.value),
      round: roundSelect.value,
    });

    previewButton.addEventListener('click', () => this.guard('bulk-preview', async () => {
      const body = recipe();
      if (!Number.isFinite(body.value)) {
        toast('请输入一个数字作为字段的更改量。', 'warning');
        return;
      }
      clear(previewHost);
      previewHost.append(el('div', { class: 'sk-preview-empty' }, el('span', { text: '处理中…' })));
      try {
        const result = await api.skillBulk({ ...body, dryRun: true });
        preview = result;
        clear(previewHost);
        previewHost.append(this.buildBulkPreview(result));
        const changing = (result.changes || []).filter((c) => !c.skipped).length;
        applyButton.disabled = changing === 0;
        applyButton.dataset.tip = changing
          ? `写入这 ${fmt.format(changing)} 项更改`
          : '这里不会发生任何更改';
      } catch (error) {
        preview = null;
        applyButton.disabled = true;
        clear(previewHost);
        previewHost.append(el('div', { class: 'sk-preview-empty', 'data-tone': 'bad' },
          icon('alert', { size: 15 }),
          el('span', { text: error.message })));
      }
    }));

    const { close } = modal({
      title: '批量编辑技能',
      subtitle: `已选择 ${fmt.format(paths.length)} 个技能`,
      width: 'min(96vw, 940px)',
      body: el('div', { class: 'sk-bulk' },
        el('div', { class: 'sk-bulk-grid' },
          bakeField('字段', fieldSelect),
          bakeField('位置', levelInput,
            '0 表示 common 块 — 即公式。任何其他数字表示该等级已存储的节点。'),
          bakeField('操作', opSelect),
          bakeField('数值', valueInput),
          bakeField('舍入', roundSelect,
            '乘以和按百分比会产生小数;WZ 整数无法保存小数。')),
        el('div', { class: 'sk-bulk-actions' }, previewButton, applyButton),
        previewHost,
        el('div', { class: 'tips' },
          el('b', { text: '行为说明' }),
          el('ul', {},
            el('li', { text: '预览在服务器端运行,因此你看到的就是将要写入的内容。' }),
            el('li', { text: '基于等级的公式值 — "235+3*x" — 会被拒绝,而不会被篡改。' +
                             '请先烘焙该技能,或直接编辑其公式。' }),
            el('li', { text: '没有该字段的技能会连同原因一起被跳过;此处绝不会创建它。' }),
            el('li', { text: '点 (x, y) 会被跳过:它是两个数字,而不是一个。' }),
            el('li', { text: '整个批次只算一次撤销,保存之前不会写入磁盘。' })))),
      actions: [{ label: '关闭' }],
    });

    applyButton.addEventListener('click', () => this.guard('bulk-apply', async () => {
      if (!preview) return;
      const changing = (preview.changes || []).filter((c) => !c.skipped);
      const where = Number(levelInput.value) > 0 ? `等级 ${levelInput.value}` : 'common 块';
      const ok = await confirmDialog({
        title: `在 ${fmt.format(changing.length)} 个技能上更改 ${fieldSelect.value}?`,
        message: `${OPS.find(([v]) => v === opSelect.value)?.[1]} ${valueInput.value},作用于 ${where} — ` +
                 '这就是你正在查看的预览。保存前不会写入磁盘,并且可以撤销。',
        confirmLabel: '应用更改',
        danger: false,
      });
      if (!ok) return;

      try {
        const result = await api.skillBulk({ ...recipe(), dryRun: false });
        const skipped = (result.changes || []).filter((c) => c.skipped).length;
        close();
        toast(
          `已更新 ${fmt.format(result.applied ?? 0)} 个技能` +
          (skipped ? `,跳过 ${fmt.format(skipped)} 个 — 原因见预览。` : '.'),
          'success', {
            action: { label: '撤销', run: async () => { await this.app.undo(); await this.refresh(); } },
          });
        this.app.markDirty();
        await this.load();
      } catch (error) {
        toastError(error, '无法应用这些更改');
      }
    }));
  }

  buildBulkPreview(result) {
    const changes = result.changes || [];
    const skipped = changes.filter((c) => c.skipped).length;

    const body = el('tbody');
    for (const change of changes) {
      body.append(el('tr', { 'data-skipped': change.skipped ? 'true' : null },
        el('td', {},
          el('div', { class: 'sk-preview-name', text: change.name || `技能 ${change.skillId}` }),
          el('div', { class: 'sk-sub', text: String(change.skillId) })),
        el('td', { class: 'num', text: change.before ?? '—' }),
        el('td', { class: 'sk-preview-arrow', text: change.skipped ? '' : '→' }),
        el('td', { class: 'num', text: change.skipped ? '—' : (change.after ?? '—') }),
        el('td', { class: 'sk-preview-note', text: change.skipped ? (change.reason || '已跳过') : '' })));
    }

    return el('div', {},
      el('div', { class: 'sk-preview-head' },
        el('span', { text: `${fmt.format(changes.length - skipped)} 个将被更改` +
                           (skipped ? `,跳过 ${fmt.format(skipped)} 个` : '') }),
        result.truncated
          ? el('span', { class: 'sk-preview-trunc',
              text: '服务器提前停止了列表 — 受影响的技能比显示的更多。' })
          : null),
      el('div', { class: 'sk-preview-scroll' },
        el('table', { class: 'sk-preview' },
          el('thead', {}, el('tr', {}, ['技能', '之前', '', '之后', ''].map((h) => el('th', { text: h })))),
          body)));
  }

  /** Right-click actions for the section itself; shared with the app-wide menu. */
  menuItems() {
    return [
      { icon: 'search', label: '聚焦搜索框', run: () => this.focusSearch() },
      this.selection.size
        ? { icon: 'sliders', label: `批量编辑已选的 ${this.selection.size} 个技能…`,
            run: () => this.openBulkDialog() }
        : null,
      this.selection.size
        ? { icon: 'close', label: '清除选择', run: () => { this.selection.clear(); this.render(); } }
        : null,
      this.bookId
        ? { icon: 'layers', label: '浏览全部技能书', run: () => this.setBook(null) }
        : null,
      { icon: 'refresh', label: '重新加载技能列表', run: () => this.load() },
    ].filter(Boolean);
  }
}

/**
 * The skill's own icon out of the open client, or the section's glyph when
 * there is not one.
 *
 * `<path>/icon` rather than the bare skill path: /api/thumb walks down to the
 * first canvas beneath whatever it is handed, and naming the node skips that
 * search -- measured at 2ms against 15ms, which is the difference between a
 * sixty-card page painting at once and painting in waves. The bare path is kept
 * as the fallback for a skill that keeps its art somewhere else.
 *
 * Both requests go through the shared loader, so a page of sixty asks for the
 * dozen on screen, a few at a time, and paging away cancels the rest. `signal`
 * is the grid's repaint scope; the detail head passes none, because it is one
 * icon inside a dialog with its own paint schedule.
 */
function skillIcon(path, box = 40, signal) {
  const thumb = el('div', { class: 'sk-icon', style: `width:${box}px;height:${box}px` });
  const img = el('img', { alt: '', decoding: 'async' });
  let walked = false;

  const glyph = () => {
    img.remove();
    if (!thumb.querySelector('.placeholder')) {
      thumb.append(el('span', { class: 'placeholder' }, icon('star', { size: Math.round(box * 0.45) })));
    }
  };

  // Both listeners are attached before src is set, always -- which is what the
  // loader guarantees, since it assigns the src itself. A cached image fires
  // load synchronously from the assignment, so a listener added after it never
  // runs and the icon stays at its natural size for ever.
  img.addEventListener('load', () => {
    // 204 means the client has no art for this skill. Most browsers report it
    // as an error, but a zero-sized decode is the same fact and must fall back
    // rather than leave an empty box.
    if (!img.naturalWidth) { glyph(); return; }
    scalePixelArt(img, box - 6, box - 6);
  });
  img.addEventListener('error', () => {
    if (walked) { glyph(); return; }
    walked = true;
    // Still queued and still deduped: the fallback is the expensive one, since
    // it is the walk that naming `/icon` was avoiding.
    lazySprite(img, thumbUrl(path), { signal });
  });

  thumb.append(img);
  lazySprite(img, thumbUrl(`${path}/icon`), { signal });
  return thumb;
}

/** One labelled control in the bake or bulk recipe. */
function bakeField(label, control, hint) {
  return el('div', { class: 'sk-bulk-field' },
    el('label', { text: label }), control,
    hint ? el('div', { class: 'sk-hint', text: hint }) : null);
}
