/**
 * Strings section: edit the display names in String.wz.
 *
 * Built in the same shape as Mobs, Cash Shop and Database -- one class, guard()
 * around anything that writes or opens a dialog, a head / stats / toolbar /
 * table / pager stack, and honest empty states -- because five sections that do
 * the same kind of work should not feel like five different applications.
 *
 * This is the section the others lean on. String.wz holds every display name the
 * client shows, and its absence is why a newly created item turns up nameless
 * in game: the item exists in Item.wz and nothing names it. Until now the only
 * fix was finding the right path in the Explorer, which means knowing that a
 * skill name lives under Skill.img/0000012 and a map name under
 * Map.img/<region>/<id>. That is what this screen replaces -- ids in, names out,
 * and the backend works out where the entry belongs.
 *
 * Every write goes through /api/string/write or /api/string/bulk, which edit the
 * same session the Explorer edits, so name changes share one dirty state, one
 * undo history and one save pipeline.
 */

import { api } from './api.js';
import { el, clear, toast, toastError, fmt, modal, confirmDialog, debounce, runOnce, scalePixelArt } from './ui.js';
import { emptyState } from './inspector.js';
import { iconUrl } from './media.js';
import { icon } from './icons.js';

const PAGE_SIZE = 40;
const KIND_KEY = 'mb.stringKind';

/** Rule 1: a field key gets a label. Nobody looking for the line under an NPC's name knows it is stored as `func`. */
const FIELD_LABELS = {
  name: '名称',
  desc: '描述',
  func: '职业行',
  mapName: '地图名称',
  streetName: '街道名称',
};

const FIELD_HINTS = {
  desc: '提示文字。换行与客户端自带的 #c 颜色代码按输入原样保留。',
  func: '游戏中 NPC 名称下方的灰色一行——“Rookie Instructor”。',
  streetName: '地图名称上方显示的区域——“Henesys : Market”中的“Henesys”。',
};

/**
 * What a kind is called in a sentence, singular. The capabilities response
 * labels them in the plural ("Items"), which reads wrong in "nothing names item
 * 1302999 yet".
 */
const KIND_NOUN = { item: '道具', mob: '怪物', skill: '技能', npc: 'NPC', map: '地图' };

/**
 * "a" or "an" per kind. A table rather than a vowel test on the first letter:
 * NPC is spelled with a consonant and said with a vowel, so the rule gets it
 * wrong exactly where it is most visible -- in a dialog title.
 */
const KIND_ARTICLE = { item: 'an', mob: 'a', skill: 'a', npc: 'an', map: 'a' };

/** A glyph per kind, for the rows that have no picture to show. */
const KIND_GLYPH = { item: 'image', mob: 'layers', skill: 'star', npc: 'info', map: 'grid4' };

/**
 * Why a row of this kind shows a glyph instead of art, said where the glyph is.
 *
 * Rule 11 asks for the real sprite wherever a thing has one, and rule 12 asks
 * for the edge to be named where the user reaches for it. Both apply here at
 * once, because the answer genuinely differs per kind: an item id resolves to an
 * inventory icon through /api/cashshop/icon, and nothing else does. A mob's
 * `stand/0` lives at a path inside Mob.wz that String.wz does not know, and
 * finding it means a search per row -- 129,496 requests to discover, mostly,
 * that the archive holding the art is not even open. So these rows say what is
 * missing and why rather than showing a grey box that reads as a bug.
 */
const NO_ART = {
  mob: '怪物贴图位于 Mob.wz 内的路径中。String.wz 只存储名称,因此此列表无法仅凭 ID ' +
       '找到图像——请前往怪物分区查看。',
  skill: '技能图标位于 Skill.wz 内,String.wz 未记录其路径。',
  npc: 'NPC 贴图位于 Npc.wz 内,String.wz 未记录其路径。',
  map: '地图没有图标,只有小地图,它位于 Map.wz 中。',
};

/** The archive each kind's *data* lives in, for the "this only names it" warning. */
const KIND_HOME = {
  item: 'Item.wz or Character.wz',
  mob: 'Mob.wz',
  skill: 'Skill.wz',
  npc: 'Npc.wz',
  map: 'Map.wz',
};

export class StringsSection {
  constructor({ host, app }) {
    this.host = host;
    this.app = app;

    /** From /api/string/capabilities; nothing is offered before it answers. */
    this.capabilities = { available: false, maxRows: 200, kinds: [], eqpCategories: [], mapRegions: [], unsupported: [] };
    this.checked = false;

    this.kind = localStorage.getItem(KIND_KEY) || 'item';
    this.query = '';
    this.page = 1;

    this.entries = [];
    this.total = 0;
    this.matched = 0;
    this.truncated = false;

    /**
     * The entry for a numeric query that does not exist yet. This is the whole
     * point of the section, so it gets its own banner rather than being folded
     * into "no results".
     */
    this.missing = null;

    /** What stopped the capabilities call, and what stopped the last list. */
    this.error = null;
    this.listError = null;

    /** The request in the air, so the next keystroke can cancel it. */
    this.searching = null;
    /**
     * The owner of the current search, kept after the request settles.
     * The exact-id probe runs *after* the list has already painted and cannot be
     * aborted (api.stringEntry takes no signal), so it needs a token that
     * outlives `searching` to know whether its answer is still wanted.
     */
    this.token = null;

    this.chipButtons = new Map();
  }

  /**
   * Runs an action at most once at a time, reporting anything it throws.
   *
   * Same rule as the other sections: every write is a POST behind a button that
   * stays live while it is in the air, and a create issued twice would write the
   * same entry twice. The keys are namespaced because the in-flight set is
   * shared with the rest of the app.
   */
  async guard(key, run) {
    try {
      await runOnce(`str:${key}`, run);
    } catch (error) {
      toastError(error);
    }
  }

  /* ============================================================
     LIFECYCLE
     ============================================================ */

  async open() {
    this.render();          // paints the chrome while capabilities are asked
    await this.load();
  }

  /** Called after an external change -- a save, an undo, an edit in the Explorer. */
  async refresh() {
    await this.load();
  }

  async load() {
    try {
      const caps = await api.stringCapabilities();
      this.capabilities = {
        available: Boolean(caps.available),
        maxRows: caps.maxRows || 200,
        kinds: caps.kinds || [],
        eqpCategories: caps.eqpCategories || [],
        mapRegions: caps.mapRegions || [],
        unsupported: caps.unsupported || [],
      };
      this.error = null;

      // A backend that answers but names no kinds is one this UI does not
      // understand. Guessing a column layout from a hardcoded table would put
      // editable boxes over fields that may not be there (rule 10).
      if (!this.capabilities.kinds.length) {
        this.error = new Error('名称编辑器未说明可编辑的类型,因此没有可安全显示的内容。');
      }
    } catch (error) {
      this.capabilities = { ...this.capabilities, available: false };
      this.error = error;
    }
    this.checked = true;

    // A kind the open archive does not offer must not stay selected: its
    // columns would be right for a different String.wz.
    if (this.capabilities.kinds.length && !this.spec) {
      this.kind = this.capabilities.kinds[0].kind;
      localStorage.setItem(KIND_KEY, this.kind);
    }

    // Rows outlive a reload only if they can still be trusted. Closing String.wz
    // mid-session leaves a table of names read out of an archive that is no
    // longer open, which is exactly the "loaded" flag over dropped data that
    // rule 9 exists to stop.
    if (!this.capabilities.available) {
      this.entries = [];
      this.total = 0;
      this.matched = 0;
      this.missing = null;
    }

    this.render();
    if (this.capabilities.available && !this.error) this.runSearch();
  }

  /** The capabilities entry for the current kind: its label and its fields. */
  get spec() {
    return this.capabilities.kinds.find((k) => k.kind === this.kind) ?? null;
  }

  /** The fields this kind writes, in the order the backend lists them. */
  get fields() {
    return this.spec?.fields ?? [];
  }

  /* ============================================================
     SEARCHING
     ============================================================ */

  /**
   * Runs the current query, cancelling whatever was already in the air.
   *
   * Debouncing thins the requests out but does not order them: a slow answer for
   * "ab" arriving after a quick one for "abc" repainted the table with results
   * for what the box no longer says. Each run aborts the last, and a late
   * response that is no longer the owner is dropped.
   */
  runSearch() {
    this.searching?.abort();

    const mine = new AbortController();
    this.searching = mine;
    this.token = mine;
    this.listError = null;
    this.missing = null;
    this.renderResults();          // paints the "Searching…" state

    const needle = this.query.trim();

    api.stringList(this.kind, needle, this.capabilities.maxRows, { signal: mine.signal })
      .then((data) => {
        if (this.token !== mine) return;
        this.searching = null;
        this.entries = data.entries || [];
        this.total = data.total ?? 0;
        this.matched = data.matched ?? this.entries.length;
        this.truncated = Boolean(data.truncated);
        this.page = 1;

        // String.wz can be closed mid-session, which changes what the toolbar is
        // allowed to offer -- so that one repaints the whole section, not just
        // the results.
        const available = Boolean(data.available);
        if (available !== this.capabilities.available) {
          this.capabilities = { ...this.capabilities, available };
          this.render();
          return;
        }
        this.renderResults();
        this.probeMissing(needle, mine);
      })
      .catch((error) => {
        if (mine.signal.aborted || this.token !== mine) return;
        this.searching = null;
        this.entries = [];
        this.matched = 0;
        this.listError = error;
        this.renderResults();
      });
  }

  /**
   * Asks whether a typed id has an entry at all.
   *
   * The list can only return entries that exist, so "1302999" matching nothing
   * is ambiguous between "no such id" and "that id has no name" -- and the
   * second is the case this whole section is for. One extra call settles it, and
   * it is cheap: the backend probes a dictionary rather than scanning.
   */
  probeMissing(needle, mine) {
    if (!/^\d+$/.test(needle)) return;
    const id = Number(needle);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    if (this.entries.some((entry) => entry.id === id)) return;

    api.stringEntry(this.kind, id)
      .then((entry) => {
        // Cannot be aborted, so ownership is checked instead: a probe for a
        // query the box no longer holds is thrown away.
        if (this.token !== mine || entry.present) return;
        this.missing = entry;
        this.renderResults();
      })
      .catch(() => { /* the banner is a bonus; the list has already answered */ });
  }

  setKind(kind) {
    if (kind === this.kind) return;
    this.kind = kind;
    localStorage.setItem(KIND_KEY, kind);
    this.page = 1;
    for (const [value, button] of this.chipButtons) {
      button.setAttribute('aria-pressed', value === kind ? 'true' : 'false');
    }
    // The columns are per kind, so the whole section repaints rather than only
    // the rows -- a Map row has no "Description" to put under that header.
    this.render();
    this.runSearch();
  }

  /* ============================================================
     RENDER
     ============================================================ */

  render() {
    clear(this.host);
    this.host.className = 'stage-body strings';
    this.chipButtons.clear();

    if (this.error) {
      this.host.append(emptyState(
        'alert', '无法连接到名称编辑器',
        this.error.message,
        el('div', { class: 'str-empty-actions' },
          el('button', { class: 'btn btn-primary', onclick: () => this.load() },
            icon('refresh', { size: 15 }), '重试'))));
      return;
    }

    // Before the first capabilities answer nothing is known -- not which kinds
    // exist, not which fields they carry, not whether String.wz is open at all.
    // Painting a table with no columns and an empty state saying "nothing of
    // this kind is named" would be three claims made before anything was asked.
    if (!this.checked) {
      const panel = el('div', { class: 'str-panel' });
      for (let i = 0; i < 6; i++) {
        panel.append(el('div', { class: 'skeleton skeleton-row', style: `width:${45 + ((i * 37) % 40)}%` }));
      }
      this.host.append(this.buildHead(), panel);
      return;
    }

    if (!this.capabilities.available) {
      this.host.append(this.buildHead(), emptyState(
        'type', '未打开 String.wz',
        '显示名称存储在 String.wz 中。编辑名称前请先打开 String.wz 或整个客户端文件夹。',
        el('button', { class: 'btn btn-primary', onclick: () => this.app.openFilePicker() },
          icon('folderOpen', { size: 15 }), '打开 String.wz')));
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
   * Names the archive being written to.
   *
   * Every name on this screen is read out of, and written back into, the user's
   * own String.wz at the user's own version. Which one that is decides whether
   * an id resolves to the right thing, so the section says which file it is
   * editing rather than presenting names as facts about MapleStory.
   */
  buildHead() {
    const sources = this.app.files.filter((file) => /^string/i.test(file.name));
    const subject = sources.length === 1
      ? sources[0].name
      : sources.length > 1
        ? `${sources.length} 个 String 存档`
        : '无 String 存档';

    return el('div', { class: 'str-panel str-head' },
      el('div', { class: 'str-head-text' },
        el('div', { class: 'str-head-title', text: '字符串' }),
        el('div', { class: 'str-head-sub' },
          el('span', { text: '正在编辑 ' }),
          el('b', { text: subject }),
          el('span', { text: this.capabilities.available ? '' : ' · 未打开' }))),
      el('button', {
        class: 'btn btn-icon', 'data-tip': '重新检查已打开的存档',
        onclick: () => this.load(),
      }, icon('refresh', { size: 15 })));
  }

  /* There was a row of three counts here: "Items named 81,481", "Listed
     81,481" and "Shown here 500". Two of them were the same number whenever
     there was no query, and all three were restated a hundred pixels below in
     the sentence over the table -- "First 500 of 81,481, by id" -- which says
     it in one line, in the place you are already looking when you wonder how
     much of the list you can see. Three boxes and ninety pixels for a fact the
     result head already carried. */

  buildToolbar() {
    const search = el('input', {
      type: 'search', value: this.query,
      placeholder: `按名称或 ID 搜索 ${(this.spec?.label ?? this.kind).toLowerCase()}——“Blue Sword”、“1302000”…`,
      'aria-label': '搜索名称',
    });
    // Only the results are re-rendered, never the toolbar holding this input:
    // rebuilding it destroys the caret and drops IME composition mid-word.
    search.addEventListener('input', debounce(() => {
      this.query = search.value;
      this.page = 1;
      this.runSearch();
    }, 160));
    // Enter re-runs immediately rather than waiting out the debounce, which is
    // what someone who has just typed an id expects.
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.query = search.value;
      this.page = 1;
      this.runSearch();
    });
    this.searchInput = search;

    const chips = el('div', { class: 'cat-tabs' });
    for (const kind of this.capabilities.kinds) {
      const button = el('button', {
        class: 'cat-tab', 'aria-pressed': this.kind === kind.kind ? 'true' : 'false',
        // The fields are named on the chip: which of them a kind carries is not
        // guessable, and it is the first thing you need to know before picking.
        'data-tip': `${(kind.fields || []).map((f) => FIELD_LABELS[f] ?? f).join(' 和 ')}`,
        onclick: () => this.setKind(kind.kind),
      }, kind.label);
      this.chipButtons.set(kind.kind, button);
      chips.append(button);
    }

    return el('div', { class: 'str-panel' },
      el('div', { class: 'str-toolbar' },
        el('div', { class: 'str-search' }, el('span', { class: 'icon' }, icon('search', { size: 15 })), search),
        chips,
        el('button', {
          class: 'btn btn-primary',
          'data-tip': '为 ID 命名,若无对应条目则创建它',
          onclick: () => this.openWriteDialog(),
        }, icon('plus', { size: 15 }), '为 ID 命名'),
        el('button', {
          class: 'btn', 'data-tip': '从电子表格粘贴一列 ID 与名称',
          onclick: () => this.openBulkDialog(),
        }, icon('list', { size: 15 }), '批量命名')),
      this.truncated
        ? el('div', { class: 'str-note-bar' }, icon('alert', { size: 14 }),
            el('span', {
              text: `${fmt.format(this.matched)} 条匹配,最多显示 ` +
                    `${fmt.format(this.entries.length)} 条。继续输入名称或 ID 以缩小范围。`,
            }))
        : null,
      this.buildUnsupported());
  }

  /**
   * Rule 12: name the edge where the user reaches for it.
   *
   * The client's own UI text is in String.wz too, sitting right beside the
   * things this screen edits, and it is not keyed by id -- so there is no safe
   * generic write for it. Saying so here beats letting someone search for
   * "Level up!" and conclude the search is broken.
   */
  buildUnsupported() {
    if (!this.capabilities.unsupported.length) return null;
    return el('details', { class: 'str-limits' },
      el('summary', {}, icon('info', { size: 14 }),
        el('span', { text: `此处不可编辑(${this.capabilities.unsupported.length})` })),
      el('ul', {}, this.capabilities.unsupported.map((line) => el('li', { text: line }))),
      el('div', { class: 'str-limits-foot' },
        el('button', {
          class: 'btn btn-sm',
          onclick: () => { this.app.setMode('explorer'); },
        }, icon('externalLink', { size: 14 }), '打开资源管理器')));
  }

  /** Puts the caret in the search box; used by the palette command. */
  focusSearch() {
    this.searchInput?.focus();
    this.searchInput?.select();
  }

  /** Redraws only the result panel, leaving the search box untouched. */
  renderResults() {
    if (!this.resultHost) { this.render(); return; }
    clear(this.resultHost);

    const panel = el('div', { class: 'str-panel' });

    if (this.listError) {
      panel.append(emptyState(
        'alert', '该搜索未能完成',
        this.listError.message,
        el('button', { class: 'btn btn-primary', onclick: () => this.runSearch() },
          icon('refresh', { size: 15 }), '重试')));
      this.resultHost.append(panel);
      return;
    }

    if (this.searching) {
      panel.append(el('div', { class: 'str-result-head' }, el('span', { text: '正在搜索…' })));
      for (let i = 0; i < 6; i++) {
        panel.append(el('div', { class: 'skeleton skeleton-row', style: `width:${45 + ((i * 37) % 40)}%` }));
      }
      this.resultHost.append(panel);
      return;
    }

    // The headline case, above everything else: an id nothing names yet.
    if (this.missing) panel.append(this.buildMissingBanner(this.missing));

    if (!this.total) {
      // The archive is open and holds no entry of this kind at all -- a
      // different fact from "your search matched nothing", and it needs a
      // different sentence.
      panel.append(emptyState(
        'type', `${this.headSubject()} 中尚未命名此类内容`,
        `该 String.wz 没有 ${(this.spec?.label ?? this.kind).toLowerCase()} 条目——要么存放它们的图像缺失,要么其内容为空。你仍然可以创建第一个。`,
        el('div', { class: 'str-empty-actions' },
          el('button', { class: 'btn btn-primary', onclick: () => this.openWriteDialog() },
            icon('plus', { size: 15 }), '为 ID 命名'))));
      this.resultHost.append(panel);
      return;
    }

    const pages = Math.max(1, Math.ceil(this.entries.length / PAGE_SIZE));
    this.page = Math.min(this.page, pages);
    const slice = this.entries.slice((this.page - 1) * PAGE_SIZE, this.page * PAGE_SIZE);

    panel.append(el('div', { class: 'str-result-head' },
      el('span', {
        text: this.query.trim()
          ? `${fmt.format(this.matched)} 条匹配${this.matched === 1 ? '' : ''}` +
            (this.truncated ? `,最多显示 ${fmt.format(this.entries.length)} 条` : '')
          : `按 ID 排序,共 ${fmt.format(this.total)} 条,显示前 ${fmt.format(this.entries.length)} 条`,
      }),
      el('span', { text: `第 ${this.page} 页,共 ${pages} 页` })));

    if (!this.entries.length) {
      const needle = this.query.trim();
      panel.append(emptyState(
        'search', `没有匹配“${needle}”的内容`,
        /^\d+$/.test(needle)
          ? (this.missing
              ? '该 ID 尚无条目——上方横幅可创建它。'
              : '没有该 ID 的条目,也没有包含这些数字的名称。')
          : '名称来自你自己的客户端,因此客户端未命名的内容无法按名称搜索。' +
            '尝试输入 ID(前导零没问题)或名称的一部分。',
        el('div', { class: 'str-empty-actions' },
          el('button', { class: 'btn', text: '清除搜索',
            onclick: () => { this.query = ''; this.render(); this.runSearch(); } }),
          el('button', { class: 'btn btn-primary', onclick: () => this.openWriteDialog(/^\d+$/.test(needle) ? needle : '') },
            icon('plus', { size: 15 }), '为 ID 命名'))));
    } else {
      panel.append(this.buildTable(slice));
      if (pages > 1) panel.append(this.buildPager(pages));
    }

    this.resultHost.append(panel);
  }

  headSubject() {
    const sources = this.app.files.filter((file) => /^string/i.test(file.name));
    return sources.length === 1 ? sources[0].name : '此存档';
  }

  /**
   * The reason this section exists, said plainly.
   *
   * Not a blank row in the table: an empty editable cell where an entry ought to
   * be says "this name is empty", and the true answer is "there is no entry at
   * all, which is why the client shows nothing". Those need different words and
   * different buttons.
   */
  buildMissingBanner(entry) {
    const noun = KIND_NOUN[entry.kind] ?? entry.kind;
    return el('div', { class: 'str-missing' },
      el('span', { class: 'str-missing-glyph' }, icon('alert', { size: 18 })),
      // The item's own icon, where there is one. It is the proof that the id is
      // real and is the thing the user meant: the art is in Item.wz and only the
      // name is missing, which is exactly the state this banner describes. Not
      // shown for the other kinds, where it could only ever be a second grey
      // glyph beside the alert.
      entry.kind === 'item' ? this.buildThumb('item', entry.id, { size: 40 }) : null,
      el('div', { class: 'str-missing-text' },
        el('b', { text: `尚未为 ${noun} ${entry.id} 命名。` }),
        el('span', {
          text: ` 在游戏中它会显示为空白。创建条目后,它将被放入 ${entry.image}` +
                `${entry.group ? ` (${entry.group})` : ''},客户端会从那里查找它。`,
        })),
      el('button', {
        class: 'btn btn-primary',
        onclick: () => this.openWriteDialog(String(entry.id)),
      }, icon('plus', { size: 15 }), `为 ${noun} ${entry.id} 命名`));
  }

  buildTable(entries) {
    const fields = this.fields;

    const body = el('tbody');
    for (const entry of entries) body.append(this.buildRow(entry));

    return el('div', { class: 'str-table-scroll' },
      el('table', { class: 'str-table' },
        el('thead', {}, el('tr', {},
          el('th', { class: 'str-col-icon' }),
          el('th', { class: 'str-col-id', text: 'ID' }),
          fields.map((field) => el('th', {
            text: FIELD_LABELS[field] ?? field,
            'data-tip': FIELD_HINTS[field] ?? null,
          })),
          el('th', { class: 'str-col-where', text: '位于' }),
          el('th', { class: 'str-col-act' }))),
        body));
  }

  /**
   * The picture for one id, or an honest admission that there is not one.
   *
   * Only items have a source that takes an id and nothing else:
   * /api/cashshop/icon reads the inventory icon out of the user's own
   * Item.wz/Character.wz and follows _inlink/_outlink to get there. Every other
   * kind would need a session path, and this list is keyed by id -- see NO_ART.
   *
   * The URL comes from media.js rather than api.js directly because it carries
   * the session epoch: an item id means nothing without the archive it was read
   * from, and closing Item.wz used to leave its icons rendering over the next
   * session's items.
   */
  buildThumb(kind, id, { size = 34 } = {}) {
    const glyph = KIND_GLYPH[kind] ?? 'file';
    // data-art starts false and is only ever flipped by a load that produced
    // real pixels, so the checkerboard behind it never appears under nothing.
    const box = el('span', { class: 'str-thumb', 'data-art': 'false', style: `--thumb:${size}px` });

    // The glyph goes in first and stays until art actually arrives. Painting the
    // empty box first and filling it on failure meant a row sat blank for the
    // length of a 404 -- which, on a page of forty ids the client has no icon
    // for, is forty boxes that look like images still loading and never do.
    const placeholder = el('span', { class: 'str-thumb-glyph' }, icon(glyph, { size: Math.round(size * 0.47) }));
    box.append(placeholder);

    if (kind !== 'item') {
      box.dataset.tip = NO_ART[kind] ?? '此类型在此处没有图像。';
      return box;
    }

    const img = el('img', { alt: '', loading: 'lazy' });

    // Both listeners are attached BEFORE src is set. A cached image fires
    // `load` synchronously during the assignment, so wiring them afterwards
    // means the handler never runs and the icon is never sized.
    img.addEventListener('error', () => {
      // Nothing to swap in: the glyph never left. An id the client has no icon
      // for answers 404, and that is the common case on a recipe or a hair.
      img.remove();
    });
    img.addEventListener('load', () => {
      // A 204 or an empty body can still resolve as a load; an image with no
      // pixels is not art, and stretching it would draw a smear.
      if (!img.naturalWidth || !img.naturalHeight) { img.remove(); return; }
      // Whole-number upscale inside the fixed box, with room to breathe.
      scalePixelArt(img, size - 6, size - 6);
      box.dataset.art = 'true';
      placeholder.remove();
    });

    // In the document rather than detached, so loading="lazy" has a box to
    // measure against and the rows below the fold cost nothing until scrolled to.
    box.append(img);
    img.src = iconUrl(id);
    return box;
  }

  buildRow(entry) {
    const row = el('tr', { 'data-id': entry.id });

    // Rule 11: a row with a picture is worth three with ids.
    row.append(el('td', { class: 'str-col-icon' }, this.buildThumb(entry.kind ?? this.kind, entry.id)));

    row.append(el('td', { class: 'str-col-id' },
      el('button', {
        class: 'str-idbtn', text: String(entry.id),
        'data-tip': '此条目的操作',
        onclick: (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          this.app.showMenu(this.menuItemsFor(entry), rect.left, rect.bottom + 4);
        },
      })));

    for (const field of this.fields) row.append(this.buildCell(entry, field));

    // Where the entry physically lives. Not decoration: String.wz has four
    // layouts and the same kind of thing sits in different images depending on
    // its id, which is exactly what makes this hard to do by hand.
    const where = el('td', { class: 'str-col-where' },
      el('span', { class: 'str-where-img', text: entry.image || '—' }),
      entry.group ? el('span', { class: 'str-where-group', text: entry.group }) : null);
    row.append(where);

    row.append(el('td', { class: 'str-col-act' },
      el('button', {
        class: 'btn btn-sm btn-icon', 'data-tip': '在资源管理器中显示此条目',
        disabled: !entry.path,
        onclick: () => {
          this.app.setMode('explorer');
          this.app.navigate(entry.path);
        },
      }, icon('externalLink', { size: 14 }))));

    return row;
  }

  /**
   * One inline-editable field.
   *
   * Committed on blur and on Enter, reverted on Escape -- the same contract the
   * mob card uses, so Tab across a row commits each cell and moves on.
   */
  buildCell(entry, field) {
    const current = entry.fields?.[field] ?? null;

    const input = el('input', {
      class: 'str-input', value: current ?? '', spellcheck: 'false',
      'aria-label': `条目 ${entry.id} 的 ${FIELD_LABELS[field] ?? field}`,
      // An unset field reads as "Not set", never as an empty box: the entry
      // exists, this one field of it does not, and typing here creates it.
      placeholder: '未设置——输入即可添加',
      'data-unset': current === null ? 'true' : null,
    });

    const note = el('div', { class: 'str-note', hidden: true });
    let committed = current ?? '';

    const say = (text, tone) => {
      note.textContent = text || '';
      note.hidden = !text;
      if (tone) note.dataset.tone = tone; else delete note.dataset.tone;
    };

    const send = () => {
      const next = input.value;
      if (next === committed) return;

      // A field that was never set and is still blank is not a request to write
      // an empty string node. Clearing one that *did* have text is, and it goes
      // through -- an empty name and a missing name are different states and the
      // backend treats them as such.
      if (current === null && next.trim() === '' && committed === '') {
        input.value = '';
        return;
      }

      this.commitField(entry, field, next, {
        input,
        say,
        accept: (value) => { committed = value; },
        revert: () => { input.value = committed; },
      });
    };

    input.addEventListener('blur', send);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); send(); }
      else if (event.key === 'Escape') { event.preventDefault(); input.value = committed; input.blur(); }
    });

    return el('td', {}, el('div', { class: 'str-cell' }, input, note));
  }

  /**
   * Writes one field of one entry.
   *
   * A single field is one node, so this commits straight through rather than
   * previewing: rule 2's diff-first requirement is about writes that touch more
   * than one node, which is the create flow and the bulk apply below. What it
   * does still do is report a skip -- the backend refuses to overwrite a field
   * that holds a group of values rather than a string, and a silent no-op there
   * is the exact failure this app exists not to have (rule 3).
   */
  commitField(entry, field, value, ui) {
    return this.guard(`field:${this.kind}:${entry.id}:${field}`, async () => {
      ui.input.setAttribute('aria-busy', 'true');
      try {
        const result = await api.stringWrite({ kind: this.kind, id: entry.id, [field]: value });
        const change = (result.changes || []).find((c) => c.field === field);

        if (change?.skipped) {
          // "Already set to this." is a fact, not a failure: keep what is on
          // screen and say why nothing happened.
          ui.accept(value);
          ui.say(change.reason || '已跳过。', change.reason === 'Already set to this.' ? null : 'warn');
          if (change.reason && change.reason !== 'Already set to this.') {
            toast(change.reason, 'warning', { title: `${FIELD_LABELS[field] ?? field} 未写入` });
          }
          return;
        }

        ui.accept(value);
        ui.say(change?.created ? '已添加。' : '已保存。', 'good');
        // The row now knows its own new state, so the table is not reloaded --
        // a reload here would take the caret out of the cell that was just
        // typed in and undo the point of editing inline.
        if (result.entry) {
          entry.fields = result.entry.fields || entry.fields;
          entry.path = result.entry.path ?? entry.path;
          entry.present = true;
        }
        if (value !== '') delete ui.input.dataset.unset;
        this.app.markDirty();
      } catch (error) {
        ui.revert();
        ui.say(error.message, 'bad');
        toastError(error, '无法保存该名称');
      } finally {
        ui.input.removeAttribute('aria-busy');
      }
    });
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

  /** Shared by the id button and the app-wide right-click menu. */
  menuItemsFor(entry) {
    const noun = KIND_NOUN[entry.kind] ?? entry.kind;
    return [
      { icon: 'copy', label: `复制 ID ${entry.id}`, run: () => this.app.copyText(String(entry.id)) },
      entry.fields?.[this.fields[0]]
        ? { icon: 'copy', label: '复制名称', run: () => this.app.copyText(entry.fields[this.fields[0]]) }
        : null,
      entry.path
        ? { icon: 'externalLink', label: '在资源管理器中显示', run: () => {
            this.app.setMode('explorer');
            this.app.navigate(entry.path);
          } }
        : null,
      { icon: 'edit', label: `编辑 ${noun} ${entry.id} 的所有字段…`, run: () => this.openWriteDialog(String(entry.id)) },
    ].filter(Boolean);
  }

  /** Right-click actions for the section; shared with the app-wide context menu. */
  menuItems() {
    return [
      { icon: 'search', label: '聚焦搜索框', run: () => this.focusSearch() },
      { icon: 'plus', label: '为 ID 命名…', run: () => this.openWriteDialog() },
      { icon: 'list', label: '批量命名…', run: () => this.openBulkDialog() },
      this.query
        ? { icon: 'close', label: '清除搜索', run: () => { this.query = ''; this.render(); this.runSearch(); } }
        : null,
      { icon: 'refresh', label: '重新检查已打开的存档', run: () => this.load() },
    ].filter(Boolean);
  }

  /* ============================================================
     NAME AN ID  --  the create-or-update flow
     ============================================================ */

  openWriteDialog(seedId = '') {
    // Guarded because capabilities and the first probe run *before* modal():
    // two fast clicks would otherwise race, and the second dialog's commit
    // closures would point at a form the first one had already replaced.
    return this.guard('write-dialog', () => this.buildWriteDialog(seedId));
  }

  async buildWriteDialog(seedId) {
    const fields = this.fields;
    if (!fields.length) {
      toast('此类型没有可编辑字段,因此没有可写入的内容。', 'warning');
      return;
    }

    const noun = KIND_NOUN[this.kind] ?? this.kind;

    const idInput = el('input', {
      class: 'str-input', type: 'number', min: '1', value: seedId,
      placeholder: `例如 ${this.entries[0]?.id ?? 1302000}`, 'aria-label': `${noun} ID`,
    });

    const inputs = new Map();
    for (const field of fields) {
      const control = field === 'desc'
        ? el('textarea', { class: 'str-input str-area', rows: '3', spellcheck: 'false' })
        : el('input', { class: 'str-input', spellcheck: 'false' });
      control.setAttribute('aria-label', FIELD_LABELS[field] ?? field);
      inputs.set(field, control);
    }

    /* --- where a new entry would be filed --- */
    const groupSelect = el('select', { class: 'str-select', 'aria-label': '新条目的归档位置' });
    const groupWrap = el('div', { class: 'str-field', hidden: true },
      el('label', { text: this.kind === 'map' ? '地区' : '分类' }),
      groupSelect,
      el('div', { class: 'field-hint' }));
    const groupHint = groupWrap.querySelector('.field-hint');

    const fillGroups = (options) => {
      clear(groupSelect);
      groupSelect.append(el('option', { value: '', text: '由存档自动推断' }));
      for (const option of options) groupSelect.append(el('option', { value: option, text: option }));
    };

    const statusHost = el('div', { class: 'str-status' });
    const previewHost = el('div', { class: 'str-preview-host' });

    /** The entry as the backend currently sees it, or null before the first probe. */
    let known = null;
    let preview = null;

    const previewButton = el('button', { class: 'btn' }, icon('eye', { size: 15 }), '预览');
    const writeButton = el('button', {
      class: 'btn btn-primary', disabled: true,
      'data-tip': '请先预览——在确认效果之前不会写入任何内容',
    }, icon('check', { size: 15 }), '写入');

    /**
     * Any change to the form throws the preview away.
     *
     * A write button that stays enabled after the id box changes is a write
     * button that writes something other than what is on screen.
     */
    const invalidate = () => {
      preview = null;
      writeButton.disabled = true;
      clear(previewHost);
      previewHost.append(el('div', { class: 'str-preview-empty' },
        icon('info', { size: 15 }),
        el('span', {
          text: '预览可逐字段查看将要创建或更改的确切内容。' +
                '在此之前不会写入任何内容。',
        })));
    };

    /** Asks the backend what this id currently is, and says so. */
    const probe = async () => {
      const id = Number(idInput.value);
      clear(statusHost);
      invalidate();

      if (!Number.isSafeInteger(id) || id <= 0) {
        known = null;
        groupWrap.hidden = true;
        statusHost.append(el('div', { class: 'str-status-line', 'data-tone': 'idle' },
          el('span', { text: `输入你想要命名的 ${noun} ID。` })));
        return;
      }

      statusHost.append(el('div', { class: 'str-status-line', 'data-tone': 'idle' },
        el('span', { text: '正在查询…' })));

      let entry;
      try {
        entry = await api.stringEntry(this.kind, id);
      } catch (error) {
        known = null;
        clear(statusHost);
        statusHost.append(el('div', { class: 'str-status-line', 'data-tone': 'bad' },
          icon('alert', { size: 15 }), el('span', { text: error.message })));
        return;
      }

      // The box may have moved on while the lookup was in the air.
      if (Number(idInput.value) !== id) return;
      known = entry;

      clear(statusHost);
      // The picture of what is about to be named, where the id resolves to one.
      // Typing 1302000 when you meant 1032000 is the mistake this catches, and
      // it catches it before the write rather than after.
      if (this.kind === 'item') statusHost.append(this.buildThumb('item', id, { size: 44 }));

      if (entry.present) {
        statusHost.append(el('div', { class: 'str-status-line', 'data-tone': 'known' },
          icon('info', { size: 15 }),
          el('span', {
            text: `${entry.image}${entry.group ? ` › ${entry.group}` : ''} 已为此 ${noun} 命名。` +
                  '在此写入会更新该条目,而不是新建一个。',
          })));
        // Prefilled with what is there, so an edit starts from the truth and a
        // field left alone is left alone.
        for (const [field, control] of inputs) control.value = entry.fields?.[field] ?? '';
        groupWrap.hidden = true;
      } else {
        statusHost.append(el('div', { class: 'str-status-line', 'data-tone': 'new' },
          icon('plus', { size: 15 }),
          el('span', {
            text: `尚未为 ${noun} ${id} 命名。条目将被创建于 ${entry.image} 中。`,
          })));
        for (const control of inputs.values()) control.value = '';

        // A new equip needs an Eqp category and a new map needs a region; the
        // other images take the id directly and have nothing to choose.
        const needsGroup = (this.kind === 'item' && entry.image === 'Eqp.img') || this.kind === 'map';
        if (needsGroup) {
          const options = this.kind === 'map' ? this.capabilities.mapRegions : this.capabilities.eqpCategories;
          fillGroups(options);
          groupHint.textContent = options.length
            ? '若不选择,后端会根据周围 ID 已使用的分组自动选择并说明。' +
              '可在此选择以覆盖。'
            : '此存档没有列出任何分组,后端将自行推断。';
          groupWrap.hidden = false;
        } else {
          groupWrap.hidden = true;
        }
      }
    };
    // Deliberately no focus move at the end of a probe: it runs 250 ms after a
    // keystroke, and pulling the caret into the name box while someone is still
    // typing an id sends the rest of the digits into the name.

    idInput.addEventListener('input', debounce(probe, 250));
    idInput.addEventListener('change', () => probe());
    for (const control of inputs.values()) control.addEventListener('input', invalidate);
    groupSelect.addEventListener('change', invalidate);

    /** The row as the bulk endpoint wants it -- one entry, so its preview is this one's. */
    const recipe = () => {
      const entry = { id: Number(idInput.value) };
      for (const [field, control] of inputs) {
        const value = control.value;
        // Null is "leave it alone", "" is "make it empty". Only send a field the
        // user actually put something in, or deliberately cleared on an entry
        // that already had text there.
        const had = known?.present ? (known.fields?.[field] ?? null) : null;
        if (value !== '' || (had !== null && had !== '')) entry[field] = value;
      }
      if (groupSelect.value && !groupWrap.hidden) {
        if (this.kind === 'map') entry.region = groupSelect.value;
        else entry.category = groupSelect.value;
      }
      return entry;
    };

    previewButton.addEventListener('click', () => this.guard('write-preview', async () => {
      const entry = recipe();
      if (!Number.isSafeInteger(entry.id) || entry.id <= 0) {
        toast(`请先输入 ${noun} ID。`, 'warning');
        return;
      }
      if (!this.fields.some((field) => field in entry)) {
        toast(`请至少填写 ${this.fields.map((f) => FIELD_LABELS[f] ?? f).join(' 或 ')} 之一。`, 'warning');
        return;
      }

      clear(previewHost);
      previewHost.append(el('div', { class: 'str-preview-empty' }, el('span', { text: '处理中…' })));
      try {
        // The single write has no dry run of its own, so the bulk endpoint's is
        // used with one row. Both call the same Apply() on the backend, so a
        // preview cannot disagree with the write that follows it.
        const result = await api.stringBulk({ kind: this.kind, entries: [entry], dryRun: true });
        preview = result.rows?.[0] ?? null;
        clear(previewHost);
        previewHost.append(this.buildPreview(result, { single: true }));
        const writes = (preview?.changes || []).filter((c) => !c.skipped).length;
        writeButton.disabled = !preview || preview.skipped || (writes === 0 && !preview.createdEntry);
        writeButton.dataset.tip = writeButton.disabled
          ? (preview?.reason || '此处不会有任何更改')
          : `写入 ${fmt.format(writes)} 个字段${writes === 1 ? '' : ''}`;
      } catch (error) {
        preview = null;
        writeButton.disabled = true;
        clear(previewHost);
        previewHost.append(el('div', { class: 'str-preview-empty', 'data-tone': 'bad' },
          icon('alert', { size: 15 }), el('span', { text: error.message })));
      }
    }));

    invalidate();
    await probe();

    const { close } = modal({
      title: `为 ${noun} 命名`,
      subtitle: `写入 ${this.headSubject()} · 一个撤销步骤`,
      width: 'min(96vw, 760px)',
      body: el('div', { class: 'str-write' },
        el('div', { class: 'str-field' },
          el('label', { text: `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ID` }),
          idInput,
          el('div', { class: 'field-hint',
            text: `前导零没有问题。这里仅为 ID 命名——并不会创建 ${noun} 本身,` +
                  `${noun} 位于 ${KIND_HOME[this.kind] ?? '其自己的存档'} 中。` })),
        statusHost,
        ...fields.map((field) => el('div', { class: 'str-field' },
          el('label', { text: FIELD_LABELS[field] ?? field }),
          inputs.get(field),
          FIELD_HINTS[field] ? el('div', { class: 'field-hint', text: FIELD_HINTS[field] }) : null)),
        groupWrap,
        el('div', { class: 'str-write-actions' }, previewButton, writeButton),
        previewHost),
      actions: [{ label: '关闭' }],
      // With an id already known -- arrived at from the "nothing names this"
      // banner -- the id box is answered and the caret belongs in the name.
      onOpen: () => { (seedId ? inputs.get(fields[0]) : idInput)?.focus(); },
    });

    writeButton.addEventListener('click', () => this.guard('write-apply', async () => {
      if (!preview) return;
      const entry = recipe();
      try {
        const result = await api.stringWrite({ kind: this.kind, id: entry.id, ...entry });
        this.app.markDirty();

        const skipped = (result.changes || []).filter((c) => c.skipped);
        close();

        // The backend's own sentence, verbatim. It is the only thing that knows
        // *why* a category was chosen -- "44 ids in the same range are already
        // in the Taming category" -- and paraphrasing it here would be a guess
        // about someone else's data.
        const because = result.groupReason ? ` ${result.groupReason}` : '';
        toast(
          (result.createdEntry
            ? `已在 ${result.image}${result.group ? ` › ${result.group}` : ''} 中创建 ${noun} ${result.id}。`
            : `已更新 ${noun} ${result.id}。`) +
          because +
          (skipped.length ? ` ${skipped.length} 个字段未更改:${skipped.map((c) => c.reason).join(' ')}` : ''),
          skipped.length ? 'warning' : 'success', {
            title: result.createdEntry ? '条目已创建' : '条目已更新',
            action: { label: '撤销', run: async () => { await this.app.undo(); await this.refresh(); } },
          });

        // Land on the entry that was just written, so the result is on screen
        // rather than somewhere in the list the user has to go and find.
        this.query = String(result.id);
        if (this.searchInput) this.searchInput.value = this.query;
        await this.load();
      } catch (error) {
        toastError(error, '无法写入该名称');
      }
    }));
  }

  /* ============================================================
     BULK NAMES
     ============================================================ */

  openBulkDialog() {
    return this.guard('bulk-dialog', () => this.buildBulkDialog());
  }

  async buildBulkDialog() {
    const fields = this.fields;
    const noun = KIND_NOUN[this.kind] ?? this.kind;
    const max = this.capabilities.maxRows;

    const paste = el('textarea', {
      class: 'str-paste', rows: '10', spellcheck: 'false',
      placeholder: `1302000\tBlue Sword${fields.length > 1 ? `\tA sword forged in Perion.` : ''}\n` +
                   `1302001\tSteel Sword${fields.length > 1 ? `\tHeavier than it looks.` : ''}`,
      'aria-label': '每行一个 ID 与名称',
    });

    const groupSelect = el('select', { class: 'str-select', 'aria-label': '新条目的归档位置' });
    const needsGroup = this.kind === 'item' || this.kind === 'map';
    const groupOptions = this.kind === 'map' ? this.capabilities.mapRegions : this.capabilities.eqpCategories;
    groupSelect.append(el('option', { value: '', text: '根据存档按 ID 自动推断' }));
    for (const option of groupOptions) groupSelect.append(el('option', { value: option, text: option }));

    const parsedHost = el('div', { class: 'str-parsed' });
    const previewHost = el('div', { class: 'str-preview-host' });

    let preview = null;
    let rows = [];

    const applyButton = el('button', {
      class: 'btn btn-primary', disabled: true,
      'data-tip': '请先预览——在确认各行之前不会写入任何内容',
    }, icon('check', { size: 15 }), '应用');

    const previewButton = el('button', { class: 'btn' }, icon('eye', { size: 15 }), '预览(试运行)');

    const invalidate = () => {
      preview = null;
      applyButton.disabled = true;
      clear(previewHost);
      previewHost.append(el('div', { class: 'str-preview-empty' },
        icon('info', { size: 15 }),
        el('span', {
          text: '预览会在服务器上运行整个批次而不写入任何内容,并显示' +
                '每行每个字段的前后对比。',
        })));
    };

    const reparse = () => {
      const result = parseRows(paste.value, fields, max);
      rows = result.rows;
      clear(parsedHost);

      if (!paste.value.trim()) {
        parsedHost.append(el('span', { class: 'str-parsed-idle', text: '尚未粘贴任何内容。' }));
      } else {
        parsedHost.append(el('span', {
          text: `已识别 ${fmt.format(rows.length)} 行${rows.length === 1 ? '' : ''}`,
        }));
        // Rule 3: lines that will not be sent are named, with the reason,
        // before anything runs -- not silently dropped.
        if (result.rejected.length) {
          parsedHost.append(el('span', { class: 'str-parsed-bad' },
            icon('alert', { size: 13 }),
            el('span', {
              text: `${fmt.format(result.rejected.length)} 行被忽略${result.rejected.length === 1 ? '' : ''}:` +
                    result.rejected.slice(0, 3).map((r) => `第 ${r.line} 行(${r.reason})`).join(', ') +
                    (result.rejected.length > 3 ? '…' : ''),
            })));
        }
        if (result.overflow) {
          parsedHost.append(el('span', { class: 'str-parsed-bad' },
            icon('alert', { size: 13 }),
            el('span', {
              text: `仅处理前 ${fmt.format(max)} 行;另有 ${fmt.format(result.overflow)} 行未处理。` +
                    '先应用这些,再粘贴剩余部分。',
            })));
        }
      }
      invalidate();
    };

    paste.addEventListener('input', debounce(reparse, 200));
    groupSelect.addEventListener('change', invalidate);
    reparse();

    const entries = () => rows.map((row) => {
      const entry = { ...row.fields, id: row.id };
      if (groupSelect.value) {
        if (this.kind === 'map') entry.region = groupSelect.value;
        else entry.category = groupSelect.value;
      }
      return entry;
    });

    previewButton.addEventListener('click', () => this.guard('bulk-preview', async () => {
      if (!rows.length) {
        toast('请先粘贴至少一行“ID、名称”。', 'warning');
        return;
      }
      clear(previewHost);
      previewHost.append(el('div', { class: 'str-preview-empty' }, el('span', { text: '处理中…' })));
      try {
        const result = await api.stringBulk({ kind: this.kind, entries: entries(), dryRun: true });
        preview = result;
        clear(previewHost);
        previewHost.append(this.buildPreview(result));
        const writes = countWrites(result);
        applyButton.disabled = writes === 0;
        applyButton.dataset.tip = writes
          ? `写入 ${fmt.format(writes)} 个字段${writes === 1 ? '' : ''}`
          : '此处不会有任何更改';
      } catch (error) {
        preview = null;
        applyButton.disabled = true;
        clear(previewHost);
        previewHost.append(el('div', { class: 'str-preview-empty', 'data-tone': 'bad' },
          icon('alert', { size: 15 }), el('span', { text: error.message })));
      }
    }));

    const { close } = modal({
      title: `批量 ${noun} 命名`,
      subtitle: `写入 ${this.headSubject()} · 整个批次一个撤销步骤`,
      width: 'min(96vw, 1000px)',
      body: el('div', { class: 'str-bulk' },
        el('div', { class: 'str-field' },
          el('label', { text: `ID 与 ${fields.map((f) => (FIELD_LABELS[f] ?? f).toLowerCase()).join(' 和 ')}` }),
          paste,
          el('div', { class: 'field-hint',
            text: `每行一条:id 在前,然后是 ${fields.map((f) => (FIELD_LABELS[f] ?? f).toLowerCase()).join('、')}。` +
                  '使用制表符分隔,因此从电子表格直接粘贴的列也能用;若只需设置一个字段,' +
                  'ID 后跟逗号或空格也可以。' })),
        parsedHost,
        needsGroup
          ? el('div', { class: 'str-field' },
              el('label', { text: this.kind === 'map' ? '新条目的地区' : '新条目的分类' }),
              groupSelect,
              el('div', { class: 'field-hint',
                text: groupOptions.length
                  ? '适用于每个需要新建的行。若不选择,每个 ID 会被归档到其周围 ID 所在的位置。'
                  : '此存档没有列出任何分组,每个 ID 将由后端推断其归属位置。' }))
          : null,
        el('div', { class: 'str-write-actions' }, previewButton, applyButton),
        previewHost,
        el('div', { class: 'tips' },
          el('b', { text: '行为说明' }),
          el('ul', {},
            el('li', { text: '预览在服务器上运行且不写入任何内容,因此你看到的就是实际会发生的结果。' }),
            el('li', { text: '没有条目的 ID 会创建条目;已有条目的 ID 会就地更新,即使其键带有前导零。' }),
            el('li', { text: '已包含相同文本的字段会被跳过并提示——这不是错误。' }),
            el('li', { text: '空白单元格不会改动该字段。若要清空有文本的字段,请在表格中清除。' }),
            el('li', { text: `这里仅为 ID 命名,不会创建 ${noun} 本身——它们位于 ${KIND_HOME[this.kind] ?? '各自的存档'} 中。` }),
            el('li', { text: '在保存之前不会写入磁盘,整个批次是一个撤销步骤。' })))),
      actions: [{ label: '关闭' }],
    });

    applyButton.addEventListener('click', () => this.guard('bulk-apply', async () => {
      if (!preview) return;
      const writes = countWrites(preview);
      const creates = preview.created ?? 0;

      const ok = await confirmDialog({
        title: `在 ${fmt.format(rows.length)} 个 ${noun}${rows.length === 1 ? '' : ''} 上写入 ${fmt.format(writes)} 个字段${writes === 1 ? '' : ''}?`,
        message: (creates ? `${fmt.format(creates)} 个还没有条目,将创建一个。` : '') +
                 '这就是你正在查看的预览。在保存之前不会写入磁盘,' +
                 '整个批次是一个撤销步骤。',
        confirmLabel: '应用这些名称',
        danger: false,
      });
      if (!ok) return;

      try {
        const result = await api.stringBulk({ kind: this.kind, entries: entries(), dryRun: false });
        this.app.markDirty();
        close();

        // Rule 3: if N rows were asked for and M were changed, say so and say
        // why the others were not.
        const skipped = result.skipped ?? 0;
        toast(
          `已写入 ${fmt.format(result.applied ?? 0)} 个字段${result.applied === 1 ? '' : ''}` +
          (result.created ? `,创建了 ${fmt.format(result.created)} 个条目${result.created === 1 ? '' : ''}` : '') +
          (skipped ? `。${fmt.format(skipped)} 行被跳过——请重新打开预览查看原因。` : '。'),
          skipped ? 'warning' : 'success', {
            title: '名称已写入',
            action: { label: '撤销', run: async () => { await this.app.undo(); await this.refresh(); } },
          });
        await this.load();
      } catch (error) {
        toastError(error, '无法写入这些名称');
      }
    }));
  }

  /**
   * The before → after table, shared by the single write's preview and the
   * bulk one.
   *
   * Every row is listed, including the ones that would do nothing, with the
   * server's own reason beside them. A preview that hid its skips would be the
   * silent-skip failure with extra steps.
   */
  buildPreview(result, { single = false } = {}) {
    const rows = result.rows || [];
    const writes = countWrites(result);
    const skippedRows = rows.filter((r) => r.skipped).length;
    const skippedFields = rows.reduce((sum, r) => sum + (r.changes || []).filter((c) => c.skipped).length, 0);

    const body = el('tbody');
    for (const row of rows) {
      if (row.skipped) {
        body.append(el('tr', { 'data-skipped': 'true' },
          el('td', { class: 'str-preview-id', text: String(row.id) }),
          el('td', { text: '—' }),
          el('td', { class: 'str-preview-arrow', text: '' }),
          el('td', { text: '—' }),
          el('td', { class: 'str-preview-note', text: row.reason || '已跳过。' })));
        continue;
      }

      const changes = row.changes || [];
      if (!changes.length) {
        body.append(el('tr', { 'data-skipped': 'true' },
          el('td', { class: 'str-preview-id', text: String(row.id) }),
          el('td', { text: '—' }),
          el('td', { class: 'str-preview-arrow', text: '' }),
          el('td', { text: '—' }),
          el('td', { class: 'str-preview-note', text: '此行没有可写入的内容。' })));
        continue;
      }

      changes.forEach((change, index) => {
        const first = index === 0;
        body.append(el('tr', { 'data-skipped': change.skipped ? 'true' : null },
          el('td', { class: 'str-preview-id' },
            first
              ? el('div', {},
                  el('div', { text: String(row.id) }),
                  row.createdEntry
                    ? el('span', { class: 'str-tag', 'data-kind': 'new',
                        text: row.group ? `新建 · ${row.group}` : '新建条目' })
                    : null)
              : null),
          el('td', {},
            el('span', { class: 'str-preview-field', text: FIELD_LABELS[change.field] ?? change.field }),
            el('span', { class: 'str-preview-text', 'data-empty': change.before == null ? 'true' : null,
              text: change.before == null ? '未设置' : (change.before || '空') })),
          el('td', { class: 'str-preview-arrow', text: change.skipped ? '' : '→' }),
          el('td', {},
            el('span', { class: 'str-preview-text', 'data-empty': change.skipped ? 'true' : null,
              text: change.skipped ? '—' : (change.after === '' ? '空' : (change.after ?? '—')) })),
          el('td', { class: 'str-preview-note', text: change.skipped ? (change.reason || '已跳过。') : (change.created ? '创建此字段' : '') })));
      });
    }

    return el('div', {},
      el('div', { class: 'str-preview-head' },
        el('span', {
          text: `将写入 ${fmt.format(writes)} 个字段${writes === 1 ? '' : ''}` +
                (result.created ? `,创建 ${fmt.format(result.created)} 个条目${result.created === 1 ? '' : ''}` : '') +
                (skippedFields || skippedRows
                  ? `,跳过 ${fmt.format(skippedFields + skippedRows)} 个`
                  : ''),
        }),
        single ? null : el('span', { class: 'str-preview-sub', text: `共 ${fmt.format(rows.length)} 行${rows.length === 1 ? '' : ''}` })),
      el('div', { class: 'str-preview-scroll' },
        el('table', { class: 'str-preview' },
          el('thead', {}, el('tr', {},
            ['ID', '当前', '', '将变为', '备注'].map((h) => el('th', { text: h })))),
          body)));
  }
}

/** Fields the server said it would write, across every row of a result. */
function countWrites(result) {
  return (result.rows || []).reduce(
    (sum, row) => sum + (row.skipped ? 0 : (row.changes || []).filter((c) => !c.skipped).length),
    0);
}

/**
 * Turns a pasted block into bulk rows.
 *
 * Tab-separated first, because that is what a spreadsheet column actually puts
 * on the clipboard and it is the only separator that survives a name containing
 * a comma ("Roger, the Instructor"). Only when a line has no tab at all does it
 * fall back to splitting on the first comma or run of spaces after the id, which
 * is what someone typing by hand writes.
 *
 * Lines it cannot read are returned rather than dropped -- the caller says how
 * many and why before anything is sent.
 */
function parseRows(text, fields, max) {
  const rows = [];
  const rejected = [];
  let overflow = 0;

  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;

    const cells = line.includes('\t')
      ? raw.split('\t')
      : (line.match(/^(\d+)\s*[,|]?\s*(.*)$/) ?? []).slice(1);

    if (!cells.length) {
      rejected.push({ line: index + 1, reason: '开头没有 ID' });
      return;
    }

    const id = Number(String(cells[0]).trim());
    if (!Number.isSafeInteger(id) || id <= 0) {
      rejected.push({ line: index + 1, reason: `"${String(cells[0]).trim().slice(0, 12)}" 不是有效的 ID` });
      return;
    }

    const values = {};
    fields.forEach((field, position) => {
      const cell = cells[position + 1];
      if (cell == null) return;
      const value = cell.trim();
      // Blank leaves the field alone; there is deliberately no way to empty a
      // field from here, because a stray trailing tab would otherwise wipe one.
      if (value !== '') values[field] = value;
    });

    if (!Object.keys(values).length) {
      rejected.push({ line: index + 1, reason: 'ID 后没有文本' });
      return;
    }

    if (rows.length >= max) { overflow++; return; }
    rows.push({ id, fields: values });
  });

  return { rows, rejected, overflow };
}
