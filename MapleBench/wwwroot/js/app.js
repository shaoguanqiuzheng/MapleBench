/**
 * MapleBench shell: session state, navigation, keyboard, and wiring between
 * the tree, the inspector and Cash Shop mode.
 */

import { api } from './api.js';
import {
  el, $, clear, toast, toastError, fmt, modal, confirmDialog, promptForText, debounce,
  runOnce, isRunning, SORT_MODES, archiveQualifiers, motionIn, motionOut, replayMotion,
} from './ui.js';
import { TreeView } from './tree.js';
import { Inspector, emptyState } from './inspector.js';
import { CashShop } from './cashshop.js';
import { Mobs } from './mob.js';
import { Database } from './database.js';
import { SkillSection } from './skill.js';
import { NpcSection } from './npc.js';
import { StringsSection } from './strings.js';
import { QuestSection } from './quest.js';
import { ItemSection } from './item.js';
import { EquipmentSection } from './equip.js';
import { Sections, SECTION_IDS, sectionLabel } from './sections.js';
import { openPixelEditor } from './pixeleditor.js';
import {
  Pins, renderChanges, openFindReplace, openBulkEdit,
  installPanelResizing, rememberSession, readSession,
} from './qol.js';
import { ResultsPanel } from './results.js';
import { icon, nodeIcon, brandMark } from './icons.js';
import { bustThumb, resetMediaCache, canvasUrl } from './media.js';
import { installTooltips } from './tooltip.js';
import { installHoverPreview } from './preview.js';
import { openPicker } from './picker.js';
import { openImporter } from './import.js';
import { openTwoPane } from './twopane.js';
import { offerMerge, openFamilyPicker, openSplitSheet, familyMenuItems, showShadows } from './family.js';
import { openPortDialog } from './port.js';
import { openExportDialog } from './dump.js';

const STORE = {
  theme: 'mb.theme',
  recents: 'mb.recents',
  lastDir: 'mb.lastDir',
};

/** One key for every write to disk: a save and a save-as must not overlap either. */
const SAVE_KEY = 'save';

/**
 * The fallback for /api/node/types.
 *
 * The endpoint returns WzNodeFactory.CreatableProperties, which is a
 * compile-time constant -- so a copy of it is a safe thing to fall back to when
 * the call fails, and much better than an empty picker. The server validates
 * the choice on the way in either way, and says so if this list has drifted.
 */
const PROPERTY_TYPES = [
  'Int', 'Short', 'Long', 'Float', 'Double', 'String',
  'SubProperty', 'Vector', 'UOL', 'Canvas', 'Convex', 'Null',
];

class App {
  constructor() {
    // Started before anything below it is built.
    //
    // /api/files is the one read the first paint actually needs, and the rest
    // of this constructor is synchronous DOM work -- sixteen icon parses among
    // it -- that the browser can get on with while the server answers. It used
    // to be issued last, and behind a second request for a constant.
    this.pendingFiles = api.files();
    // Only so an early failure is not reported as an unhandled rejection in the
    // window before boot() awaits it; boot() is what actually handles it.
    this.pendingFiles.catch(() => {});

    this.files = [];
    /** Merged archive families, as ArchiveFamilyDto. Empty in the ordinary session. */
    this.families = [];
    /** file id -> the folder that tells it apart from a same-named archive. */
    this.qualifiers = new Map();
    this.mode = 'explorer';
    this.currentPath = null;
    this.history = [];
    this.historyIndex = -1;
    this.dirty = false;
    this.propertyTypes = [];
    this.dualView = null;
    this.dualToken = null;

    this.tree = new TreeView({
      scroller: $('#tree-scroll'),
      rows: $('#tree-rows'),
      sizer: $('#tree-sizer'),
      onSelect: (path) => this.navigate(path, { fromTree: true }),
      onActivate: (path) => this.navigate(path, { fromTree: true }),
      onContext: (path, node, event) => this.showContextMenu(path, node, event),
      onDrop: (plan) => this.applyTreeDrop(plan),
    });

    this.inspector = new Inspector({
      childHost: $('#child-list'),
      inspectorHost: $('#inspector-body'),
      app: this,
    });

    // The sectioned workspace owns the stage the three real sections render
    // into, so it is built first and they are handed that element rather than
    // #child-list. One instance each: reaching Mobs through the section list is
    // the same Mobs mode, with the same selection and the same dirty state.
    this.sections = new Sections({ host: $('#child-list'), app: this });
    this.shop = new CashShop({ host: this.sections.stageFor('cashshop'), app: this });
    this.mobs = new Mobs({ host: this.sections.stageFor('mobs'), app: this });
    this.db = new Database({ host: this.sections.stageFor('database'), app: this });
    // One stage element each, per Sections: a section's first build can take
    // seconds, and a shared stage would let it paint over whichever section
    // the user switched to while waiting.
    this.skills = new SkillSection({ host: this.sections.stageFor('skills'), app: this });
    this.npcs = new NpcSection({ host: this.sections.stageFor('npcs'), app: this });
    this.strings = new StringsSection({ host: this.sections.stageFor('strings'), app: this });
    this.quests = new QuestSection({ host: this.sections.stageFor('quests'), app: this });
    this.items = new ItemSection({ host: this.sections.stageFor('items'), app: this });
    this.equip = new EquipmentSection({ host: this.sections.stageFor('equipment'), app: this });
    // The Map Editor is by far the largest editor frontend. Keep Explorer and
    // the six everyday editors light, then download/parse it on the first visit.
    this.mapedit = null;
    this.mapeditLoad = null;
    this.pins = new Pins(this);
    this.results = new ResultsPanel(this);

    this.panel = 'files';
    /** Where each side panel was scrolled to, so switching away and back returns to it. */
    this.panelScroll = { files: 0, pinned: 0, changes: 0, results: 0 };
    /** Whether the type-filter chips have been opened; see setPanel. */
    this.typesOpen = false;

    installTooltips();
    installHoverPreview();
    this.installContextMenus();
    installPanelResizing();
    this.paintChromeIcons();
    // Neither depends on a request. They used to be built inside the /api/node/
    // types callback, so a failed call to an endpoint they do not read left the
    // tree with no sort control and no type filter.
    this.buildTypeChips();
    this.buildPaneControls();
    this.bindChrome();
    this.bindKeyboard();
    this.bindDragDrop();
    this.restoreTheme();
    this.boot();
  }

  /** Loads the specialist Map Editor once, on demand. Concurrent opens share one import. */
  async ensureMapEditor() {
    if (this.mapedit) return this.mapedit;
    if (!this.mapeditLoad) {
      this.mapeditLoad = import('./mapedit.js').then(({ MapEditSection }) => {
        this.mapedit = new MapEditSection({ host: this.sections.stageFor('mapedit'), app: this });
        return this.mapedit;
      });
    }
    try {
      return await this.mapeditLoad;
    } catch (error) {
      // A transient static-file failure must be retryable on the next visit.
      this.mapeditLoad = null;
      throw error;
    }
  }

  /* ============================================================
     BOOT
     ============================================================ */

  /**
   * One request, already in flight.
   *
   * This used to await /api/node/types and then /api/files, in that order and
   * in series, although they are independent -- and the first of them returns a
   * compile-time constant whose only reader is a dialog that may never be
   * opened. It is read lazily now (ensurePropertyTypes), so boot is one
   * round-trip that was started before the UI was built.
   */
  async boot() {
    this.watchActivity();
    try {
      await this.refreshFiles(this.pendingFiles);
    } catch (error) {
      // Nothing else can be said about a session that could not be read, so say
      // that, and let the welcome screen offer the way out of it.
      toastError(error, '无法读取已打开的文件');
    }
    this.pendingFiles = null;
    if (!this.files.length) this.showWelcome();
  }

  /**
   * The backstop for "no wait is ever silent".
   *
   * api.js counts requests in flight and fires mb:activity when the count
   * crosses zero, with a 200 ms grace so a quick call does not flash a bar.
   * Everything else in the app -- section panels, skeleton rows, busy buttons --
   * says WHAT is loading, which is better and is why those exist. This only has
   * to catch the ones nobody covered, and it catches them all by construction
   * rather than by anyone remembering.
   *
   * The bar sits on the topbar because that is the one element always on
   * screen, in every mode, at every window size.
   */
  watchActivity() {
    const bar = el('div', { class: 'busy-bar', 'data-activity': 'global' });
    window.addEventListener('mb:activity', (event) => {
      const topbar = document.querySelector('.topbar');
      if (!topbar) return;
      if (event.detail.active) topbar.append(bar);
      else bar.remove();
    });
  }

  /**
   * The property types the Add-child dialog offers.
   *
   * Read on first use rather than at boot, and never fatal: an empty picker is
   * the failure the last review found, and it is worse than a stale one.
   */
  async ensurePropertyTypes() {
    if (this.propertyTypes.length) return this.propertyTypes;
    try {
      const types = await api.types();
      this.propertyTypes = Array.isArray(types) && types.length ? types : [...PROPERTY_TYPES];
    } catch {
      this.propertyTypes = [...PROPERTY_TYPES];
    }
    return this.propertyTypes;
  }

  async refreshFiles(pending) {
    const previousIds = this.files.map((file) => file.id).sort().join('|');
    this.files = await (pending ?? api.files());
    const fileSetChanged = previousIds !== this.files.map((file) => file.id).sort().join('|');
    // Merged families, and a failure here is never allowed to cost the file
    // list: a family is a way of *showing* archives that are open either way,
    // so the worst case is four roots instead of one.
    try { this.families = await api.families(); }
    catch { this.families = []; }
    // Computed once here rather than per row: the tree paints it on every
    // scroll frame and the inspector wants the same answer for the same
    // archive. Empty unless two open archives really do share a name.
    this.qualifiers = archiveQualifiers(this.files);
    this.tree.setRoots(this.files, this.families);
    // "These four files are one archive." Fired after the tree has the files,
    // because the offer is about the rows the user is looking at.
    offerMerge(this).catch(() => {});
    this.updateDirtyUi();
    this.updateStatus();
    rememberSession(this.files);
    if (this.panel === 'changes') renderChanges($('#panel-changes'), this);

    // The welcome screen belongs only to an empty session. Select the first
    // archive as soon as a client opens so the stage, breadcrumb and inspector
    // can never contradict the populated Explorer beside them.
    this.applyEmptyState();
    $('#btn-dual').hidden = !this.files.some((file) => !file.readOnly);
    if (this.files.length && !this.currentPath && this.mode === 'explorer')
      await this.navigate(this.files[0].id);
    else if (fileSetChanged && this.mode === 'sections')
      await this.sections.open(this.sections.active);
  }

  /**
   * With nothing open there is no tree and no selection, so the side panel and
   * inspector are empty chrome. Collapsing them gives the welcome the full width.
   */
  applyEmptyState() {
    $('#workspace').dataset.empty = this.files.length ? 'false' : 'true';
  }

  /**
   * Shows one of the three side panels.
   *
   * Each panel owns its own element and the others are hidden, rather than all
   * three sharing #tree-rows. That element belongs to the virtualizer, which
   * keeps a pool of recycled row elements parented to it and re-appends only
   * when the pool needs to *grow* -- so emptying it to draw Pinned detached
   * every row the tree had, and coming back left the file tree blank until
   * something expanded far enough to grow the pool past its stale length. It
   * also stopped a slow renderChanges() from clearing the tree when it landed
   * after the user had already switched away.
   */
  setPanel(panel) {
    if (this.dualToken) this.closeDualView();
    // The rail drives the Explorer's side pane, which every other mode hides.
    // Clicking one of these from the sectioned workspace used to flip its
    // pressed state and rearrange a pane nobody could see, then hand the user
    // the surprise on the way back.
    const wasSections = this.mode !== 'explorer';
    const changedPanel = this.panel !== panel;
    if (wasSections) this.setMode('explorer');

    // Asking again for the panel already on screen means "put it away" -- but
    // never on the way back from the sectioned workspace, where the pane was
    // hidden by the mode rather than by the user, and the click meant "show me
    // the tree again".
    const workspace = $('#workspace');
    const collapse = !wasSections && this.panel === panel && workspace.dataset.panel !== 'hidden';
    if (collapse) workspace.dataset.panel = 'hidden';
    else delete workspace.dataset.panel;

    this.panelScroll[this.panel] = $('#tree-scroll').scrollTop;
    this.panel = panel;
    for (const [id, name] of [['rail-files', 'files'], ['rail-pinned', 'pinned'],
                              ['rail-changes', 'changes'], ['rail-search', 'results']]) {
      // aria-pressed has to mean "this panel is on screen", not "this panel is
      // the chosen one" -- a lit button beside a collapsed pane is the app
      // telling the user something they can see is false.
      $(`#${id}`)?.setAttribute('aria-pressed', panel === name && !collapse ? 'true' : 'false');
    }

    const treeMode = panel === 'files';
    $('#tree-sizer').hidden = !treeMode;
    $('#panel-pinned').hidden = panel !== 'pinned';
    $('#panel-changes').hidden = panel !== 'changes';
    $('#panel-results').hidden = panel !== 'results';

    // The merge offer is about the archive rows underneath it, so it goes when
    // they do -- otherwise it sat above Pinned inviting the user to merge a tree
    // that was not on the screen. Its own hidden flag (set when there is nothing
    // to offer) still wins: this only ever adds a reason to be hidden.
    const offer = $('#family-offer');
    if (offer) offer.style.display = treeMode ? '' : 'none';

    // The wrapper, not the input: hiding only the field left its magnifier
    // floating under the header of a panel with nothing to filter.
    $('#tree-filter').parentElement.style.display = treeMode ? '' : 'none';
    // Restored to what the Types toggle says, not to visible: the chip row is
    // opt-in and starts hidden, so restoring it with '' turned it on for
    // everyone who had never opened it, with the toggle still reading unpressed.
    $('#type-chips').style.display = treeMode && this.typesOpen ? '' : 'none';
    // Sorting and type-filtering act on tree children, which the other two
    // panels are not showing.
    for (const control of document.querySelectorAll('#tree-pane .sort-toggle, #tree-pane .types-toggle')) {
      control.style.display = treeMode ? '' : 'none';
    }
    $('#pane-label').textContent =
      panel === 'files' ? '文件'
      : panel === 'pinned' ? '已固定'
      : panel === 'results' ? '搜索结果'
      : '未保存的更改';

    if (panel === 'pinned') this.pins.render($('#panel-pinned'));
    else if (panel === 'changes') renderChanges($('#panel-changes'), this);
    // Rendered from state it already holds, never re-run: coming back to look
    // at results you already have must not spend the search again.
    else if (panel === 'results') this.results.render();

    // After the show/hide above, so the scroller has its new height to clamp
    // against. The tree is untouched while it is hidden, so returning to it
    // needs a repaint for the window it lands in and nothing else.
    $('#tree-scroll').scrollTop = this.panelScroll[panel] ?? 0;
    if (treeMode) this.tree.scheduleRender();
    if (changedPanel && !collapse) replayMotion($('#tree-scroll'), 'panel-enter');
  }

  togglePin(path) {
    const pinned = this.pins.toggle(path, decodeURIComponent(path.split('/').pop()));
    if (this.panel === 'pinned') this.pins.render($('#panel-pinned'));
    return pinned;
  }

  /** Icons are built in JS so one icon set serves markup and dynamic UI alike. */
  paintChromeIcons() {
    const set = (id, name, size = 16) => {
      const node = $(`#${id}`);
      if (!node) return;
      clear(node);
      node.append(icon(name, { size }));
    };

    $('#brand-mark').append(brandMark(20));
    set('btn-undo', 'undo');
    set('btn-redo', 'redo');
    const importButton = $('#btn-import');
    clear(importButton);
    importButton.append(icon('download', { size: 15 }), el('span', { text: '导入' }));
    this.paintDualButton();
    set('btn-more', 'more');
    set('insp-icon', 'eye', 13);
    set('rail-files', 'folder', 18);
    set('rail-search', 'search', 18);
    set('rail-pinned', 'pin', 18);
    set('rail-changes', 'edit', 18);
    set('rail-open', 'folderOpen', 18);
    set('pane-icon', 'folder', 13);
    set('filter-icon', 'filter', 14);
    set('palette-icon', 'search', 18);
    set('dropzone-icon', 'upload', 30);

    // Save keeps its text label; the icon sits before it.
    const save = $('#btn-save');
    save.prepend(icon('save', { size: 15 }));

    const omni = $('#omnibox .om-icon');
    if (omni) { clear(omni); omni.append(icon('search', { size: 15 })); }

    this.paintThemeIcon();
  }

  paintThemeIcon() {
    // The theme control lives in the overflow menu now; nothing to repaint.
  }

  paintDualButton() {
    const button = $('#btn-dual');
    const active = !!this.dualToken;
    clear(button);
    button.append(
      icon(active ? 'close' : 'grid', { size: 15 }),
      el('span', { text: active ? '退出双客户端视图' : '双客户端视图' }));
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.dataset.tip = active ? '返回资源管理器' : '在旁边打开另一个客户端';
  }

  showWelcome() {
    const stage = $('#child-list');
    // Editors and Explorer share this host. Sections.render() turns it into a
    // two-column grid and leaves its collapse state on the element; replacing
    // only the children then traps the welcome card in the old 250 px nav
    // column when an empty session returns to Explorer.
    stage.className = 'stage-body';
    delete stage.dataset.navCollapsed;
    clear(stage);

    const previous = readSession();
    const recents = this.recents();

    const mark = el('div', { class: 'welcome-mark' });
    mark.append(brandMark(22));

    const actions = el('div', { class: 'welcome-actions' },
      el('button', {
        class: 'btn btn-primary btn-lg',
        'data-tip': '选择 MapleStory 客户端文件夹或 WZ 存档',
        onclick: () => this.openFilePicker(),
      }, icon('folderOpen', { size: 17 }), '打开客户端'),
      el('button', {
        class: 'btn btn-lg',
        'data-tip': '从经典或拆分客户端导入所选内容,并附带依赖检查',
        onclick: () => this.openImporter(),
      }, icon('archive', { size: 16 }), '从客户端导入'),
      previous.length
        ? el('button', {
            class: 'btn btn-lg',
            'data-tip': previous.map((f) => f.path).join('\n'),
            onclick: () => this.restoreSession(previous),
          }, icon('refresh', { size: 16 }),
            `重新打开上次会话(${previous.length} 个文件)`)
        : null);

    const inner = el('div', { class: 'welcome-inner' },
      mark,
      el('h1', { text: 'MapleBench' }),
      el('p', {
        text: '打开 MapleStory 客户端以浏览和编辑其 WZ 存档,或从另一客户端导入内容并附带依赖检查。更改会保留在会话中,直到你保存。',
      }),
      actions);

    if (recents.length) {
      const list = el('div', { class: 'recents stagger' });
      list.append(el('div', { class: 'recents-title', text: '最近' }));
      for (const path of recents.slice(0, 5)) {
        list.append(el('button', { class: 'recent-item', onclick: () => this.openPath(path) },
          icon('archive', { size: 17 }),
          el('span', { style: 'flex:1;min-width:0' },
            el('div', { class: 'recent-name', text: path.split(/[\\/]/).pop() }),
            el('div', { class: 'recent-path', text: path })),
          icon('arrowRight', { size: 15 })));
      }
      inner.append(list);
    }

    stage.append(el('div', { class: 'welcome' }, inner));

    clear($('#breadcrumb'));
    clear($('#inspector-body'));
    $('#inspector-body').append(emptyState('info', '未选择任何内容',
      '在树中挑选一个节点,其详细信息将显示在此处。'));
  }

  async restoreSession(previous) {
    for (const entry of previous) {
      try { await this.openPath(entry.path, { mapleVersion: entry.mapleVersion }); }
      catch { /* openPath reports its own failures */ }
    }
  }

  recents() {
    try { return JSON.parse(localStorage.getItem(STORE.recents) || '[]'); }
    catch { return []; }
  }

  rememberRecent(path) {
    const list = [path, ...this.recents().filter((p) => p !== path)].slice(0, 10);
    localStorage.setItem(STORE.recents, JSON.stringify(list));
  }

  /* ============================================================
     FILE PICKER
     ============================================================ */

  /** Delegates to the picker module, which can open a whole client folder. */
  openFilePicker(startPath) {
    openPicker(this, startPath);
  }

  /**
   * The importer: open another client read-only, find things in it, take them.
   *
   * Separate from the picker because it answers a different question. The picker
   * opens archives you already have in the layout the app edits; this reaches
   * into a client in the modern split-Data layout, whose archives are
   * directories the ordinary file picker cannot see, and its outcome is content
   * copied into a client you already have open rather than a file on screen.
   */
  async openImporter(startPath) {
    if (!this.files.some((file) => !file.readOnly)) {
      const open = await confirmDialog({
        title: '请先打开要编辑的客户端',
        message: 'MapleBench 会导入到已打开的可写客户端。请先打开该客户端,再从只读来源选择内容。',
        confirmLabel: '打开客户端',
        cancelLabel: '稍后',
        danger: false,
      });
      if (open) this.openFilePicker();
      return;
    }
    openImporter(this, startPath);
  }

  /** Opens a second client beside the writable one for reviewed drag-and-drop imports. */
  async openDualView(startPath) {
    if (this.dualToken) {
      this.closeDualView();
      return;
    }
    if (!this.files.some((file) => !file.readOnly)) {
      const open = await confirmDialog({
        title: '请先打开要编辑的客户端',
        message: '双客户端视图需要先有可写的目标客户端,才能在其旁边打开只读来源。',
        confirmLabel: '打开客户端',
        cancelLabel: '稍后',
        danger: false,
      });
      if (open) this.openFilePicker();
      return;
    }
    openImporter(this, startPath, { dual: true });
  }

  /** Mounts the source and target trees directly into the Explorer workspace. */
  async showDualView(sourceFileId) {
    if (this.dualToken) this.closeDualView({ restore: false });
    if (this.mode !== 'explorer') await this.setMode('explorer');

    const token = Symbol('dual-view');
    this.dualToken = token;
    const workspace = $('#workspace');
    const stage = $('#child-list');
    workspace.dataset.dual = 'true';
    stage.className = 'stage-body dual-stage';
    this.paintDualButton();
    this.updateStatus();

    const handle = await openTwoPane({
      app: this,
      sourceFileId,
      host: stage,
      onClose: () => this.finishDualView(token),
    });

    if (this.dualToken !== token) {
      handle?.close();
      return;
    }
    if (!handle) {
      this.finishDualView(token);
      return;
    }
    this.dualView = handle;
  }

  closeDualView({ restore = true } = {}) {
    if (!this.dualToken) return;
    const handle = this.dualView;
    this.dualView = null;
    this.dualToken = null;
    handle?.close();
    this.restoreExplorerFromDual(restore);
  }

  finishDualView(token) {
    if (this.dualToken !== token) return;
    this.dualView = null;
    this.dualToken = null;
    this.restoreExplorerFromDual(true);
  }

  restoreExplorerFromDual(restore) {
    const workspace = $('#workspace');
    delete workspace.dataset.dual;
    this.paintDualButton();
    if (!restore || this.mode !== 'explorer') return;

    const stage = $('#child-list');
    stage.className = 'stage-body';
    if (this.currentPath) void this.navigate(this.currentPath, { record: false });
    else if (this.files.length) void this.navigate(this.files[0].id, { record: false });
    else this.showWelcome();
  }

  /**
   * Merges an archive family: Skill.wz with its numbered parts, shown as one
   * tree.
   *
   * Not the importer and not the picker. The picker opens files, one root each,
   * which is what leaves the user guessing which of four Skill archives holds
   * 40000.img; the importer reaches into a modern client's Data\ directories.
   * This takes files that are already in the layout this app edits and stops
   * their being four things.
   */
  async openFamilyPicker(startPath) {
    // One door, and the way back for anyone who dismissed the hint above the
    // tree. Families already open are listed first because merging those costs
    // no disk at all; a scan of a folder is what the sheet's own button, and a
    // session with nothing adoptable in it, falls through to.
    if (!startPath) {
      const candidates = await api.familyAdoptable().catch(() => []);
      if (candidates.length) { openSplitSheet(this, candidates); return; }
    }
    openFamilyPicker(this, startPath);
  }

  async openPath(path, options = {}) {
    const busy = toast(`正在打开 ${path.split(/[\\/]/).pop()}…`, 'info');
    try {
      const file = await api.open({ path, ...options });
      busy.remove();
      this.rememberRecent(path);
      await this.refreshFiles();
      toast(`${file.name} 已打开 — ${file.mapleVersion} 加密${file.gameVersion ? `, v${file.gameVersion}` : ''}。`, 'success');
      await this.tree.expand(file.id);
      this.navigate(file.id);
    } catch (error) {
      busy.remove();
      // A parse failure is nearly always the wrong encryption, so offer that fix.
      this.offerEncryptionRetry(path, error);
    }
  }

  offerEncryptionRetry(path, error) {
    const select = el('select', { style: 'width:100%;height:34px;border-radius:var(--r-sm);border:1px solid var(--border);background:var(--bg-field);padding:0 8px' },
      ['GMS', 'EMS', 'BMS', 'CLASSIC'].map((v) => el('option', { value: v, text: v })));
    const iv = el('input', {
      placeholder: '自定义 IV,例如 4D23C72B(可选)',
      style: 'width:100%;height:34px;margin-top:10px;padding:0 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg-field)',
    });

    modal({
      title: '无法打开该文件',
      width: '480px',
      body: el('div', {},
        el('p', { style: 'margin:0 0 14px;color:var(--text-2);line-height:1.5', text: error.message }),
        el('label', { style: 'font-size:var(--fs-11);font-weight:600;color:var(--text-2)', text: '尝试指定加密' }),
        select, iv,
        el('div', { class: 'field-hint', style: 'margin-top:10px',
          text: '无法解析的文件几乎总是因使用了与来源区域不符的加密方式。在认定文件损坏之前,请先尝试其他加密。' })),
      actions: [
        { label: '取消' },
        {
          label: '重试',
          class: 'btn-primary',
          run: () => {
            this.openPath(path, { mapleVersion: select.value, iv: iv.value.trim() || null });
          },
        },
      ],
    });
  }

  /* ============================================================
     NAVIGATION
     ============================================================ */

  async navigate(path, { fromTree = false, record = true } = {}) {
    if (!path) return;
    if (this.dualToken) this.closeDualView({ restore: false });
    this.currentPath = path;

    if (record) {
      this.history = this.history.slice(0, this.historyIndex + 1);
      if (this.history[this.historyIndex] !== path) {
        this.history.push(path);
        this.historyIndex = this.history.length - 1;
      }
    }

    if (!fromTree) this.tree.reveal(path).catch(() => {});

    // Only the Explorer owns the breadcrumb. Painting it from another mode put
    // a trail with working Back/Forward buttons above a card grid.
    if (this.mode === 'explorer') this.renderBreadcrumb(path);
    this.updateStatus();

    if (this.mode === 'explorer') {
      $('#child-list').className = 'stage-body';
      await this.inspector.show(path);
    }
  }

  back() { if (this.historyIndex > 0) this.navigate(this.history[--this.historyIndex], { record: false }); }
  forward() { if (this.historyIndex < this.history.length - 1) this.navigate(this.history[++this.historyIndex], { record: false }); }

  renderBreadcrumb(path) {
    const bar = $('#breadcrumb');
    clear(bar);

    bar.append(el('div', { class: 'nav-group' },
      el('button', {
        class: 'btn btn-icon btn-sm btn-ghost', 'data-tip': '后退 · Alt ←',
        disabled: this.historyIndex <= 0, onclick: () => this.back(),
      }, icon('arrowLeft', { size: 15 })),
      el('button', {
        class: 'btn btn-icon btn-sm btn-ghost', 'data-tip': '前进 · Alt →',
        disabled: this.historyIndex >= this.history.length - 1, onclick: () => this.forward(),
      }, icon('arrowRight', { size: 15 }))));

    const segments = path.split('/');
    const entries = [];
    let running = '';
    segments.forEach((segment, index) => {
      running = running ? `${running}/${segment}` : segment;
      entries.push({
        target: running,
        isRoot: index === 0,
        // The first segment is the session file id ("f1"); show the archive name.
        label: index === 0
          ? this.rootLabel(segment)
          : decodeURIComponent(segment).replace(/#\d+$/, ''),
      });
    });

    // Deep paths collapse to first / ... / last three; the ellipsis opens the
    // hidden ancestors as a menu.
    let visible = entries;
    let hidden = [];
    if (entries.length > 5) {
      visible = [entries[0], ...entries.slice(-3)];
      hidden = entries.slice(1, -3);
    }

    visible.forEach((entry, index) => {
      if (index > 0) {
        bar.append(el('span', { class: 'crumb-sep' }, icon('chevronRight', { size: 13 })));
        if (index === 1 && hidden.length) {
          bar.append(
            el('button', {
              class: 'crumb', 'data-tip': `还有 ${hidden.length} 层`,
              onclick: (event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                this.showMenu(hidden.map((h) => ({
                  icon: 'folder', label: h.label, run: () => this.navigate(h.target),
                })), rect.left, rect.bottom + 6);
              },
            }, el('span', { text: '\u2026' })),
            el('span', { class: 'crumb-sep' }, icon('chevronRight', { size: 13 })));
        }
      }
      const last = entry === entries[entries.length - 1];
      const crumb = el('button', {
        class: 'crumb', 'aria-current': last ? 'true' : 'false',
        onclick: () => this.navigate(entry.target),
      });
      if (entry.isRoot) crumb.append(icon('archive', { size: 14 }));
      crumb.append(el('span', { text: entry.label }));
      bar.append(crumb);
    });
  }

  updateStatus() {
    if (this.dualToken) {
      $('#status-path').textContent = '双客户端视图';
      $('#status-counts').textContent = '从来源拖到目标';
      $('#status-version').textContent = '';
      return;
    }
    // Outside the Explorer these three fields describe nothing that is on
    // screen. refreshFiles() calls this on every dirty change, so without the
    // guard a cash shop or mob edit repainted a stale Explorer path here.
    if (this.mode !== 'explorer') { this.clearStageChrome(); return; }

    // Show the archive name rather than the internal file id.
    const readable = this.currentPath
      ? decodeURIComponent(this.currentPath).replace(/^([^/]+)/, (id) => this.rootLabel(id))
      : '';
    $('#status-path').textContent = readable;
    const file = this.currentPath ? this.files.find((f) => f.id === this.currentPath.split('/')[0]) : null;
    $('#status-version').textContent = file ? `${file.mapleVersion}${file.gameVersion ? ` v${file.gameVersion}` : ''}${file.is64Bit ? ' 64-bit' : ''}` : '';
    const node = this.currentPath ? this.tree.getNode(this.currentPath) : null;
    $('#status-counts').textContent = node && node.childCount >= 0
      ? `${fmt.format(node.childCount)} 个子节点`
      : '';
  }

  /**
   * What the first segment of a path is called.
   *
   * Three kinds of first segment now: a session file id ("f1" -> "Skill003.wz"),
   * a merged family id ("g1" -> "Skill (4 files)"), and anything else, which is
   * shown as itself rather than hidden. Centralised because the breadcrumb and
   * the status bar answered it separately and only one of them knew about
   * families, which is exactly the kind of drift that makes a merged tree feel
   * like it is lying about where a node lives.
   */
  rootLabel(id) {
    const file = this.files.find((f) => f.id === id);
    if (file) return file.name;
    const family = this.families?.find((f) => f.id === id);
    if (family) return `${family.name}(${family.members.length} 个文件)`;
    return id;
  }

  copyPath(path) {
    navigator.clipboard.writeText(decodeURIComponent(path))
      .then(() => toast('路径已复制。', 'success'))
      .catch(() => toast('无法复制到剪贴板。', 'error'));
  }

  async followUol(node) {
    const link = node.extra?.link;
    if (!link) return;
    // UOL targets are relative to the owning node; '..' walks back up.
    const base = node.path.split('/').slice(0, -1);
    for (const part of link.split('/')) {
      if (part === '..') base.pop();
      else if (part && part !== '.') base.push(part);
    }
    const target = base.join('/');
    try {
      await api.node(target);
      this.navigate(target);
    } catch {
      toast(`无法从此处解析链接目标 "${link}"。`, 'warning');
    }
  }

  /* ============================================================
     EDITING
     ============================================================ */

  markDirty() {
    this.dirty = true;
    this.refreshFiles().catch(() => {});
    this.refreshHistoryButtons();
  }

  updateDirtyUi() {
    const total = this.files.reduce((sum, f) => sum + (f.dirtyNodeCount || 0), 0);
    const anyDirty = this.files.some((f) => f.dirty);
    // Map-editor edits live in editor documents, not the session tree, so the
    // file counters above cannot see them; the section reports its own.
    const mapEdits = this.mapedit?.unsavedEdits || 0;
    const chip = $('#dirty-chip');
    chip.dataset.visible = anyDirty || mapEdits ? 'true' : 'false';
    const combined = total + mapEdits;
    chip.textContent = combined ? `${combined} 处未保存` : '未保存';
    chip.title = mapEdits
      ? `${mapEdits} 处修改来自地图编辑器分区;这里的保存按钮写入会话存档。`
      : '';
    // The Save button saves ARCHIVES; map-editor documents save from their own
    // section, so they light the chip but never this button.
    $('#btn-save').disabled = !anyDirty;
    document.title = anyDirty || mapEdits ? '● MapleBench' : 'MapleBench';
  }

  async refreshHistoryButtons() {
    try {
      const state = await api.history();
      $('#btn-undo').disabled = state.undoDepth === 0;
      $('#btn-redo').disabled = state.redoDepth === 0;
      $('#btn-redo').style.display = state.redoDepth ? '' : 'none';
      $('#btn-undo').dataset.tip = state.nextUndo ? `撤销 ${state.nextUndo} · Ctrl Z` : '撤销 · Ctrl Z';
      $('#btn-redo').dataset.tip = state.nextRedo ? `重做 ${state.nextRedo} · Ctrl Shift Z` : '重做 · Ctrl Shift Z';
    } catch { /* history is advisory */ }
  }

  async undo() {
    try {
      const result = await api.undo();
      if (!result.applied) { toast('没有可撤销的操作。', 'info'); return; }
      toast(`已撤销:${result.applied}`, 'success');
      this.afterStructureChange(...(result.affected || []));
    } catch (error) { toastError(error, '无法撤销'); }
  }

  async redo() {
    try {
      const result = await api.redo();
      if (!result.applied) { toast('没有可重做的操作。', 'info'); return; }
      toast(`已重做:${result.applied}`, 'success');
      this.afterStructureChange(...(result.affected || []));
    } catch (error) { toastError(error, '无法重做'); }
  }

  /** Re-reads anything whose children may have changed. */
  afterStructureChange(...paths) {
    for (const path of paths) {
      if (!path) continue;
      this.tree.invalidate(path);
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (parent) this.tree.invalidate(parent);
    }
    this.tree.rebuild();
    this.markDirty();
    if (this.mode === 'explorer') this.inspector.refresh();
    else this.sections.reload();
  }

  async promptAddChild(parentPath, presetType) {
    const node = this.tree.getNode(parentPath) ?? await api.node(parentPath);
    const isDirectory = node.kind === 'Directory' || node.kind === 'File';

    // 'Image' means a .img container, which is a completely different thing
    // from a Canvas (a picture). Spelling that out stops the usual mix-up.
    const LABELS = {
      Image: 'Image (.img 容器)',
      Directory: 'Directory (文件夹)',
      Canvas: 'Canvas (图片)',
      SubProperty: 'SubProperty (属性文件夹)',
      UOL: 'UOL (指向另一节点的链接)',
      Vector: 'Vector (x, y)',
    };
    const options = isDirectory ? ['Image', 'Directory'] : await this.ensurePropertyTypes();

    const typeSelect = el('select', { class: 'field-input no-icon', name: 'type' },
      options.map((t) => el('option', {
        value: t, text: LABELS[t] ?? t, selected: t === presetType,
      })));
    const nameInput = el('input', { class: 'field-input no-icon', name: 'name', placeholder: '名称' });
    const valueInput = el('input', { class: 'field-input no-icon', name: 'value', placeholder: '值(可选)' });

    /* --- picture picker, shown only for Canvas --- */
    let picked = null;
    const fileInput = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    const pickedLabel = el('span', { class: 'muted', style: 'font-size:var(--fs-12)', text: '未选择图片' });
    const preview = el('div', {
      class: 'preview-stage', style: 'min-height:120px;display:none;margin-top:8px',
    });

    // A blob URL pins the whole file in memory until it is revoked, and nothing
    // revoked these: choosing four 8 MB sheets before settling on one held all
    // four for the rest of the session. Revoked as soon as the picture has been
    // decoded, and again when a different one replaces it.
    let previewUrl = null;
    const dropPreviewUrl = () => {
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    };

    fileInput.addEventListener('change', () => {
      picked = fileInput.files?.[0] ?? null;
      pickedLabel.textContent = picked ? picked.name : '未选择图片';
      clear(preview);
      dropPreviewUrl();
      if (picked) {
        previewUrl = URL.createObjectURL(picked);
        preview.style.display = 'grid';
        preview.append(el('img', {
          src: previewUrl, alt: '',
          style: 'max-height:120px;image-rendering:pixelated',
          // Once it is decoded the element holds the bitmap; the URL is spent.
          onload: dropPreviewUrl,
          onerror: dropPreviewUrl,
        }));
      } else {
        preview.style.display = 'none';
      }
    });

    const pictureRow = el('div', { style: 'display:none;flex-direction:column;gap:8px' },
      el('label', { class: 'muted', style: 'font-size:var(--fs-11);font-weight:700', text: '图片' }),
      el('div', { style: 'display:flex;align-items:center;gap:10px' },
        el('button', {
          class: 'btn', type: 'button', onclick: () => fileInput.click(),
        }, icon('upload', { size: 14 }), '选择图片\u2026'),
        pickedLabel),
      preview,
      el('div', { class: 'field-hint', text: '可选。留空将创建一个空白 1x1 画布,供稍后绘制。' }),
      fileInput);

    const syncType = () => {
      const isCanvas = typeSelect.value === 'Canvas';
      pictureRow.style.display = isCanvas ? 'flex' : 'none';
      // A canvas has no text value; a container has none either.
      valueInput.parentElement.style.display =
        (isCanvas || typeSelect.value === 'SubProperty' || typeSelect.value === 'Convex'
         || typeSelect.value === 'Null' || isDirectory) ? 'none' : '';
    };
    typeSelect.addEventListener('change', syncType);

    const field = (label, control) => el('div', { style: 'display:flex;flex-direction:column;gap:5px' },
      el('label', { class: 'muted', style: 'font-size:var(--fs-11);font-weight:700', text: label }), control);

    const { dialog } = modal({
      title: '添加子节点',
      subtitle: `位于 ${decodeURIComponent(parentPath.split('/').pop())} 内`,
      width: '460px',
      body: el('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        field('类型', typeSelect),
        field('名称', nameInput),
        field('值', valueInput),
        pictureRow),
      actions: [
        { label: '取消' },
        {
          label: '添加',
          class: 'btn-primary',
          run: async (close) => {
            if (!nameInput.value.trim()) { toast('请先为节点命名。', 'warning'); return false; }
            try {
              const created = await api.addNode({
                path: parentPath, type: typeSelect.value,
                name: nameInput.value, value: valueInput.value || null,
              });
              // A picture is a second step: create the canvas, then fill it.
              if (picked && typeSelect.value === 'Canvas') {
                const result = await api.replaceCanvas(created.path, picked);
                bustThumb(created.path);
                if (result?.warning) toast(result.warning, 'warning', { title: '图像格式已更改' });
              }
              close();
              toast(`已添加 ${nameInput.value}。`, 'success');
              this.afterStructureChange(parentPath);
            } catch (error) {
              toastError(error, '无法添加该节点');
            }
            return false;
          },
        },
      ],
      onOpen: () => { syncType(); nameInput.focus(); },
    });

    // Closing before the preview finished decoding is the one path that would
    // otherwise leave a blob URL holding the file.
    dialog.addEventListener('close', dropPreviewUrl, { once: true });
  }

  /**
   * Replaces a canvas's pixels from a file on disk. Shared by the inspector
   * button, the context menus and drag-and-drop.
   */
  replaceCanvasFile(path, file) {
    const send = async (blob) => {
      try {
        const result = await api.replaceCanvas(path, blob);
        // /api/thumb is cached for an hour, so the row thumbnail and every
        // parent's preview would keep showing the old sprite without this.
        bustThumb(path);
        toast('画布图像已替换。保存文件以写入磁盘。', 'success');
        if (result?.warning) toast(result.warning, 'warning', { title: '图像格式已更改' });
        this.markDirty();
        this.inspector.refresh();
      } catch (error) {
        toastError(error, '无法替换画布图像');
      }
    };

    if (file) { send(file); return; }

    const input = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    input.addEventListener('change', () => {
      if (input.files?.length) send(input.files[0]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  }

  async duplicate(paths) {
    try {
      const created = await api.duplicate(paths);
      toast(`已复制 ${created.length} 个节点。`, 'success');
      this.afterStructureChange(...paths.map((p) => p.slice(0, p.lastIndexOf('/'))));
    } catch (error) { toastError(error, '无法复制'); }
  }

  // Del auto-repeats and the confirm is an await away, so a held key opened one
  // confirm per repeat over the same selection.
  deleteNodes(paths) {
    return runOnce(`delete:${paths.join(',')}`, async () => {
      const label = paths.length === 1
        ? decodeURIComponent(paths[0].split('/').pop())
        : `${paths.length} 个节点`;
      const ok = await confirmDialog({
        title: `删除 ${label}?`,
        message: '这将删除该节点及其下所有内容。保存前不会写入磁盘,你可以立即撤销。',
        confirmLabel: '删除',
      });
      if (!ok) return;

      try {
        const result = await api.deleteNodes(paths);
        toast(`已删除 ${result.removed} 个节点。`, 'success',
          { action: { label: '撤销', run: () => this.undo() } });
        this.afterStructureChange(...paths.map((p) => p.slice(0, p.lastIndexOf('/'))));
        const parent = paths[0].slice(0, paths[0].lastIndexOf('/'));
        if (parent) this.navigate(parent);
      } catch (error) { toastError(error, '无法删除'); }
    });
  }

  // Likewise Ctrl+V: two transfers into one parent land two copies of everything.
  paste(targetPath, move = false) {
    if (!this.clipboard?.length) { toast('尚未复制任何内容。', 'info'); return; }
    return runOnce(`paste:${targetPath}`, async () => {
      try {
        const result = await api.transfer({ paths: this.clipboard, targetPath, move, overwrite: false });
        toast(`${move ? '已移动' : '已复制'} ${result.length} 个节点。`, 'success');
        if (move) this.clipboard = null;
        this.afterStructureChange(targetPath);
      } catch (error) { toastError(error, '无法粘贴'); }
    });
  }

  copyNodes(paths, cut = false) {
    this.clipboard = paths;
    this.clipboardCut = cut;
    toast(`${cut ? '已剪切' : '已复制'} ${paths.length} 个节点。`, 'info');
  }

  openPixelEditor(node) {
    openPixelEditor(node, this);
  }

  /** Recursive expand, capped, saying so when it stops short. */
  async expandAll(path) {
    const busy = toast('正在展开…', 'info');
    try {
      const { truncated, opened } = await this.tree.expandAll(path);
      busy.remove();
      if (truncated) {
        toast(
          `已展开 ${fmt.format(opened)} 个节点并在此停止。` +
          '展开整个存档需要数分钟,因此会在安全深度停止。',
          'warning', { title: '部分展开' });
      } else {
        toast(`已展开 ${fmt.format(opened)} 个节点。`, 'success');
      }
    } catch (error) {
      busy.remove();
      toastError(error, '无法展开该节点');
    }
  }

  openFindReplace(path) { openFindReplace(this, path); }

  bulkEdit(paths) { openBulkEdit(this, paths); }

  /** Triggers a browser download without navigating away from the app. */
  download(url) {
    const link = document.createElement('a');
    link.href = url;
    link.download = '';
    document.body.append(link);
    link.click();
    link.remove();
    toast('正在生成下载 — 就绪后会自动保存。', 'info');
  }

  /* ============================================================
     SAVE
     ============================================================ */

  async save() {
    // Ctrl+S during a write used to open the dialog again, and Save now there
    // started a second pass over files the first one was still swapping.
    if (this.saveBusy()) return;

    const dirtyFiles = this.files.filter((f) => f.dirty);
    if (!dirtyFiles.length) { toast('没有需要保存的更改。', 'info'); return; }

    // Both halves of "unsaved", not just the changed images. dirtyNodeCount
    // counts images, and a delete or a rename marks none -- so this list used
    // to offer "Etc.wz — 0 changed images" beside a ticked box that would
    // have written the deletion.
    const summaries = await api.changes()
      .then((data) => new Map(data.files.map((entry) => [entry.file.id, entry])))
      .catch(() => new Map());

    const list = el('div', { style: 'display:flex;flex-direction:column;gap:8px' });
    const checks = new Map();
    for (const file of dirtyFiles) {
      const box = el('input', { type: 'checkbox', checked: true });
      checks.set(file.id, box);
      const pending = summaries.get(file.id);
      const count = pending?.changeCount ?? file.dirtyNodeCount;
      list.append(el('label', { class: 'check-row' }, box,
        el('span', {}, el('b', { text: file.name }),
          el('span', {
            style: 'color:var(--text-3)',
            text: count
              ? ` — ${count} 处未保存更改`
              : ' — 无法列出的未保存工作',
          })),
      ));
    }

    const backup = el('input', { type: 'checkbox', checked: true });

    // Preflight while the dialog is open: a file that cannot serialise is
    // flagged and unticked before the user can commit to writing it.
    for (const file of dirtyFiles) {
      api.preflight(file.id).then((result) => {
        if (result.ok) return;
        const box = checks.get(file.id);
        if (box) { box.checked = false; box.disabled = true; }
        list.append(el('div', {
          style: 'font-size:var(--fs-12);color:var(--red-ink);padding-left:26px;white-space:pre-wrap',
          text: `${file.name} 暂时无法保存:\n` + result.problems.slice(0, 3).join('\n'),
        }));
      }).catch(() => { /* preflight is advisory; the save re-checks */ });
    }

    modal({
      title: '保存更改',
      width: '520px',
      body: el('div', {},
        el('p', { style: 'margin:0 0 14px;color:var(--text-2);line-height:1.5',
          text: '新文件会先写入原文件旁边,仅在完成后才进行替换。请先关闭 MapleStory — 客户端打开文件时,Windows 不允许替换该文件。' }),
        list,
        el('label', { class: 'check-row', style: 'margin-top:14px' }, backup,
          '保留原文件带时间戳的备份'),
        el('p', { style: 'margin:12px 0 0;font-size:var(--fs-12);color:var(--text-3)',
          text: '保存会重新加载文件,并清除撤销历史。' })),
      actions: [
        { label: '取消' },
        {
          label: '立即保存',
          class: 'btn-primary',
          run: (close) => {
            const selected = dirtyFiles.filter((f) => checks.get(f.id).checked);
            close();
            this.runSave(selected, backup.checked);
            return false;
          },
        },
      ],
    });
  }

  /**
   * The one door to /api/files/save, held open for a single caller at a time.
   *
   * The save modal closes before it runs, but the changes drawer's Save, the
   * tree's "Save this file" and Ctrl+S all stay live for the whole write, and
   * two of these against one archive verify and swap the same file.
   */
  runSave(files, backup) {
    if (this.saveBusy()) return Promise.resolve();
    return runOnce(SAVE_KEY, () => this.writeFiles(files, backup));
  }

  /** True when a write is already under way, and says so rather than ignoring the click. */
  saveBusy() {
    if (!isRunning(SAVE_KEY)) return false;
    toast('保存正在进行中 — 请等待完成。', 'info');
    return true;
  }

  async writeFiles(files, backup) {
    const busyBar = el('div', { class: 'busy-bar' });
    document.querySelector('.topbar').append(busyBar);
    for (const file of files) {
      const busy = toast(`正在保存 ${file.name}…`, 'info');
      try {
        const result = await api.save({ fileId: file.id, backup });
        busy.remove();

        const size = `${(result.bytes / 1048576).toFixed(1)} MB`;
        toast(
          `${file.name} 已保存 — ${size},重写了 ${result.imagesRewritten} 张图像` +
          (result.backupPath ? `\n备份:${result.backupPath.split(/[\\/]/).pop()}` : ''),
          'success', { title: '已保存并通过验证' });

        for (const warning of result.warnings || []) toast(warning, 'warning');
      } catch (error) {
        busy.remove();
        toastError(error, `无法保存 ${file.name}`);
      }
    }
    busyBar.remove();
    this.dirty = false;
    await this.refreshFiles();
    this.tree.invalidateAll();
    this.refreshHistoryButtons();
    if (this.mode === 'explorer' && this.currentPath) this.inspector.refresh();
    else this.sections.reload();
  }

  /**
   * Writes a copy to a path the user picks, leaving the original alone.
   *
   * The server already supported this -- SaveRequest.TargetPath and the native
   * save dialog were both implemented and neither had a caller.
   */
  async saveAs(file) {
    if (!file) return;

    const suggested = file.name.replace(/(\.[^.]+)?$/, (ext) => ` copy${ext || ''}`);
    let target = null;

    if (window.mapleBenchDesktop) {
      target = await window.mapleBenchDesktop.savePath(
        `将 ${file.name} 另存为`, suggested, 'WZ 存档|*.wz|所有文件|*.*');
      if (!target) return;   // cancelled
    } else {
      // In a plain browser there is no native dialog, and the path has to be
      // one the *server* can write, so it is typed rather than picked.
      target = await promptForText({
        title: `将 ${file.name} 另存为`,
        message: '要写入的完整路径。原文件保持不变,未经询问不会覆盖任何内容。',
        // Both separators: a Windows path has no forward slashes at all, so
        // matching only '/' would have replaced the entire path.
        value: file.filePath.replace(/[^\\/]+$/, suggested),
        confirmLabel: '保存副本',
      });
      if (!target) return;

      // The native dialog asks about an existing file itself; a typed path had
      // nothing checking it, so the promise above -- nothing is overwritten
      // without asking -- was one this branch did not keep.
      if (!await this.confirmOverwrite(target)) return;
    }

    // Only the write itself takes the save lock -- the dialog above can sit
    // open for as long as the user likes without blocking an ordinary save.
    if (this.saveBusy()) return;
    await runOnce(SAVE_KEY, async () => {
      const busy = toast(`正在将 ${file.name} 保存到 ${target}…`, 'info');
      try {
        // backup:true is what makes an existing destination survive: the server
        // renames it to a timestamped .bak rather than dropping it.
        const result = await api.save({ fileId: file.id, targetPath: target, backup: true });
        busy.remove();
        toast(`已保存到 ${result.savedTo} — ${(result.bytes / 1048576).toFixed(1)} MB,用时 ` +
              `${result.seconds.toFixed(1)} 秒。`, 'success', { title: '副本已写入' });
        for (const warning of result.warnings || []) toast(warning, 'warning');
        await this.refreshFiles();
      } catch (error) {
        busy.remove();
        toastError(error, `无法保存 ${file.name}`);
      }
    });
  }

  /**
   * True unless the user turns down replacing a file that is already there.
   *
   * /api/browse is the only listing the front end has, and it lists archives
   * only -- a target with some other extension goes unseen and the save
   * proceeds. Anything it cannot read is treated the same way: this is a
   * courtesy check in front of a write the server verifies properly.
   */
  async confirmOverwrite(target) {
    const cut = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
    if (cut < 0) return true;

    const name = target.slice(cut + 1);
    let listing;
    try { listing = await api.browse(target.slice(0, cut)); }
    catch { return true; }

    const clash = listing.files?.some((f) => f.name.toLowerCase() === name.toLowerCase());
    if (!clash) return true;

    return confirmDialog({
      title: `替换 ${name}?`,
      message: `${target} 处已存在同名文件。覆盖写入后,原文件会保留为带时间戳的 .bak,但该名称将不再指向原文件。`,
      confirmLabel: '替换',
    });
  }

  /** Opens the OS file manager with the archive selected. Desktop window only. */
  async revealInExplorer(file) {
    if (!file) return;
    if (!window.mapleBenchDesktop) {
      toast('打开文件夹需要桌面窗口;浏览器标签页无法完成此操作。', 'warning');
      return;
    }
    const ok = await window.mapleBenchDesktop.showInExplorer(file.filePath);
    if (!ok) toast(`无法为 ${file.name} 打开文件夹。`, 'error');
  }

  /**
   * Moves a property one place among its siblings.
   *
   * Order is meaningful in WZ -- animation frames play in it -- and until now
   * the only way to change it was delete-and-re-add, which loses the node.
   */
  async moveNode(path, delta) {
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (!parent) return;

    try {
      const siblings = await api.children(parent);
      const index = siblings.findIndex((child) => child.path === path);
      if (index < 0) return;

      const target = index + delta;
      if (target < 0 || target >= siblings.length) {
        toast(delta < 0 ? '已在最前。' : '已在最后。', 'info');
        return;
      }

      await api.reorder(path, target);
      this.afterStructureChange(parent);
      toast(`已${delta < 0 ? '上移' : '下移'}。`, 'success',
        { action: { label: '撤销', run: () => this.undo() } });
    } catch (error) {
      toastError(error, '无法重新排序');
    }
  }

  /**
   * Commits a drag from the tree.
   *
   * tree.js decides what the gesture MEANS and refuses anything illegal while
   * the pointer is still down. This half decides whether it is still true, and
   * that is a separate question: everything the drag knows was read when it
   * started, and a WZ path is only an address for as long as the tree holds
   * still. Nodes may share a name, so paths carry an occurrence suffix
   * ("delay", "delay#1", "delay#2") and every one of those shifts when an
   * earlier sibling is added or removed -- by a save, an undo, another panel,
   * or the auto-expand this very drag performed. A path resolved from the
   * stale listing does not fail; it hits the node that inherited the index.
   * That is the wrong node, edited silently.
   *
   * So both ends are re-read here, the dragged nodes are checked to be the same
   * nodes they were, and the landing index is computed from the listing that
   * came back rather than from anything the drag remembered.
   */
  applyTreeDrop(plan) {
    // A second drop while the first is in flight would compute its index from a
    // tree the first has already moved.
    return runOnce('tree-drop', async () => {
      try {
        if (plan.crossFile && !(await this.confirmCrossFileMove(plan))) return;

        const listings = new Map();
        const listing = async (path) => {
          if (!listings.has(path)) listings.set(path, await api.children(path));
          return listings.get(path);
        };

        const positions = await this.locateDragged(plan, listing);
        const index = await this.landingIndex(plan, positions, listing);

        if (plan.kind === 'reorder') {
          await api.reorder(plan.paths[0], index);
          this.afterStructureChange(plan.targetPath);
          toast(`已将 ${plan.nodes[0].name} 移到第 ${index + 1} 位。`, 'success',
            { action: { label: '撤销', run: () => this.undo() } });
          return;
        }

        const moved = await api.transfer({
          paths: plan.paths,
          targetPath: plan.targetPath,
          move: true,
          // Never true from a drag. Overwrite replaces a same-named node in the
          // target, and although its undo was fixed, a gesture whose whole
          // signal is "the pointer was over this row" is not consent to destroy
          // something else. Without it the backend auto-renames, so the worst
          // case is a node called "delay copy" that the toast below names.
          overwrite: false,
          index,
        });
        this.afterStructureChange(plan.targetPath, ...plan.paths);
        toast(this.describeMove(plan, moved), 'success',
          { action: { label: '撤销', run: () => this.undo() } });
      } catch (error) {
        toastError(error, '无法移动');
      }
    });
  }

  /** Says what actually landed, including a name the backend had to change. */
  describeMove(plan, moved) {
    const renamed = moved.filter((node, i) => node.name !== plan.nodes[i]?.name);
    const base = moved.length === 1
      ? `已将 ${moved[0].name} 移入 ${plan.targetName}。`
      : `已将 ${moved.length} 个节点移入 ${plan.targetName}。`;
    // An auto-rename is the one outcome that differs from what the drag
    // promised, so it is said out loud rather than left to be discovered.
    return renamed.length
      ? `${base} ${renamed.length === 1
          ? `目标中已有同名节点,因此已将其重命名为 ${renamed[0].name}。`
          : `${renamed.length} 个与目标中的名称冲突,已被重命名。`}`
      : base;
  }

  /**
   * Confirms a move that crosses archives.
   *
   * Within one file a drag is cheap to undo and obvious on screen. Across
   * files it is neither: two archives go dirty at once, the node is cloned and
   * the original deleted, and the tree offers no visual join between the two
   * ends. The archives are also routinely two copies of the same client with
   * the same name, which is exactly when a mis-drop is hardest to notice.
   */
  confirmCrossFileMove(plan) {
    const from = this.files.find((f) => f.id === plan.nodes[0].path.split('/')[0]);
    const to = this.files.find((f) => f.id === plan.targetPath.split('/')[0]);
    const what = plan.nodes.length === 1 ? plan.nodes[0].name : `${plan.nodes.length} 个节点`;
    return confirmDialog({
      title: `将 ${what} 移到 ${to?.name ?? '另一存档'}?`,
      message: `${what} 将从 ${from?.name ?? '原存档'} 移除并添加到 ` +
               `${to?.name ?? '另一存档'},两个存档都将带有未保存的更改。` +
               '保存前不会写入磁盘,你可以立即撤销。',
      confirmLabel: '移动',
      danger: false,
    });
  }

  /**
   * Re-reads each dragged node's parent and checks the node is still there.
   *
   * The comparison is name plus kind plus type, not the path alone: the path is
   * what may have come to mean something else, so using it as its own proof
   * would check nothing. Returns each node's current index, which the reorder
   * arithmetic needs.
   */
  async locateDragged(plan, listing) {
    const positions = new Map();
    for (const node of plan.nodes) {
      const parent = node.path.slice(0, node.path.lastIndexOf('/'));
      const siblings = await listing(parent);
      const at = siblings.findIndex((child) => child.path === node.path);
      const found = at < 0 ? null : siblings[at];
      if (!found || found.name !== node.name || found.kind !== node.kind
          || (found.type ?? null) !== node.type) {
        throw new Error(
          `${node.name} 已不在拖拽开始时的位置,因此未移动任何内容。` +
          '拖拽期间有其他操作更改了树 — 请重试拖拽。');
      }
      positions.set(node.path, at);
    }
    return positions;
  }

  /**
   * Where the node lands, counted in the target parent as it is right now.
   *
   * Null for a drop onto a node, which means "last" and needs no arithmetic.
   */
  async landingIndex(plan, positions, listing) {
    if (!plan.anchorPath) return null;

    const siblings = await listing(plan.targetPath);
    const at = siblings.findIndex((child) => child.path === plan.anchorPath);
    const found = at < 0 ? null : siblings[at];
    if (!found || found.name !== plan.anchor.name || (found.type ?? null) !== plan.anchor.type) {
      throw new Error(
        `${plan.anchor.name} 已不在拖拽开始时的位置,因此未移动任何内容。` +
        '拖拽期间有其他操作更改了树 — 请重试拖拽。');
    }

    if (plan.kind !== 'reorder') {
      // Different parents, so removing the source does not shift these indices.
      return plan.position === 'before' ? at : at + 1;
    }

    // Reorder is remove-then-insert in one list, so the anchor's index has
    // already moved by the time the insert happens -- by one, and only if the
    // node came from in front of it. Getting this wrong puts the node one slot
    // off, which for an animation frame list is a bug nobody sees until the
    // sprite plays backwards.
    const from = positions.get(plan.paths[0]);
    const shifted = at - (at > from ? 1 : 0);
    return plan.position === 'before' ? shifted : shifted + 1;
  }

  /* ============================================================
     MODE
     ============================================================ */

  async setMode(mode, { section } = {}) {
    if (this.dualToken) this.closeDualView({ restore: false });
    const changed = this.mode !== mode;
    this.mode = mode;
    const workspace = $('#workspace');
    workspace.dataset.mode = mode;
    for (const [id, name] of [['mode-explorer', 'explorer'], ['mode-sections', 'sections']]) {
      $(`#${id}`)?.setAttribute('aria-pressed', mode === name ? 'true' : 'false');
    }

    // Leaving the Explorer used to leave its chrome behind: Cash Shop showed
    // the breadcrumb of whatever node was last open, with live Back and Forward
    // buttons that navigated a tree nobody could see, and a status bar naming a
    // path and a child count belonging to none of it.
    if (mode !== 'explorer') this.clearStageChrome();

    if (mode === 'sections') {
      const opening = this.sections.open(section);
      if (changed) replayMotion(workspace, 'mode-enter');
      await opening;
      return;
    }

    let opening;
    if (this.currentPath) {
      $('#child-list').className = 'stage-body';
      // Coming back to the Explorer repaints what clearStageChrome() took away.
      this.renderBreadcrumb(this.currentPath);
      this.updateStatus();
      opening = this.inspector.show(this.currentPath);
    } else if (this.files.length) opening = this.navigate(this.files[0].id);
    else this.showWelcome();
    if (changed) replayMotion(workspace, 'mode-enter');
    await opening;
  }

  /** Opens the sectioned workspace at a named section. */
  openSection(id) {
    return this.setMode('sections', { section: id });
  }

  /** Whether a named section is the one currently on screen. */
  inSection(id) {
    return this.mode === 'sections' && this.sections.active === id;
  }

  /**
   * Empties the breadcrumb and the status fields.
   *
   * Both describe the Explorer's selection, and both are shared furniture that
   * every mode is painted into -- so a mode that has no selection has to say
   * nothing rather than leaving the last one on screen.
   */
  clearStageChrome() {
    clear($('#breadcrumb'));
    $('#status-path').textContent = '';
    $('#status-counts').textContent = '';
    $('#status-version').textContent = '';
  }

  /* ============================================================
     CHROME
     ============================================================ */

  bindChrome() {
    $('#btn-save').onclick = () => this.save();
    $('#btn-undo').onclick = () => this.undo();
    $('#btn-redo').onclick = () => this.redo();
    $('#rail-open').onclick = () => this.openFilePicker();
    // Clicking the panel you are already on collapses it, which is what every
    // editor's sidebar button does and what the `[data-panel="hidden"]` rules
    // in app.css were written for and never wired to. Without it the four rail
    // buttons could only ever choose between panels, never close one, so
    // aria-pressed on all four was a claim the layout could not contradict --
    // and at a narrow width, where the CSS took the panel away by itself, the
    // Files button sat lit beside no panel at all.
    $('#rail-files').onclick = () => this.setPanel('files');
    $('#rail-search').onclick = () => this.openSearch();
    $('#rail-pinned').onclick = () => this.setPanel('pinned');
    $('#rail-changes').onclick = () => this.setPanel('changes');
    $('#btn-import').onclick = () => this.openImporter();
    $('#btn-dual').onclick = () => this.openDualView();
    $('#btn-more').onclick = (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      this.showMenu([
        {
          icon: document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon',
          label: '切换主题',
          run: () => this.toggleTheme(),
        },
        { icon: 'help', label: '键盘快捷键', shortcut: '?', run: () => this.showShortcuts() },
        { icon: 'info', label: '关于 MapleBench', run: () => this.showAbout() },
      ], rect.right - 200, rect.bottom + 6);
    };
    $('#mode-explorer').onclick = () => this.setMode('explorer');
    $('#mode-sections').onclick = () => this.setMode('sections');
    $('#status-path').onclick = () => this.currentPath && this.copyPath(this.currentPath);
    $('#status-help').onclick = () => this.showShortcuts();

    $('#tree-filter').addEventListener('input', debounce((e) => {
      this.tree.setNameFilter(e.target.value);
    }, 120));

    $('#omnibox').onclick = () => this.openPalette('');

    window.addEventListener('beforeunload', (event) => {
      if (this.files.some((f) => f.dirty)) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }

  /**
   * The six type-filter chips.
   *
   * The list is written out here rather than taken from /api/node/types: these
   * are the types worth filtering a tree by, which is not the same question as
   * which types can be created.
   */
  buildTypeChips() {
    const host = $('#type-chips');
    clear(host);
    host.style.display = 'none';

    for (const type of ['Int', 'String', 'Canvas', 'SubProperty', 'Vector', 'UOL']) {
      host.append(el('button', {
        class: 'type-chip', 'aria-pressed': 'false', text: type.replace('SubProperty', 'sub'),
        onclick: (event) => {
          const on = this.tree.toggleTypeFilter(type);
          event.target.setAttribute('aria-pressed', on ? 'true' : 'false');
        },
      }));
    }
  }

  /**
   * The sort control and the Types toggle in the tree pane's header.
   *
   * Kept apart from the chips, and from any request: both of these were built
   * inside buildTypeChips(), which ran only if /api/node/types came back, so a
   * failed call to an endpoint neither of them reads silently took the tree's
   * sort order and its type filter with it.
   */
  buildPaneControls() {
    const host = $('#type-chips');
    // Six uppercase pills are not permanent furniture; they open on demand.
    const title = document.querySelector('#tree-pane .pane-title');

    // Sorting the tree is a per-session preference, so it lives in the header
    // rather than behind a menu.
    if (title && !title.querySelector('.sort-toggle')) {
      title.append(el('button', {
        class: 'btn btn-sm btn-icon btn-ghost sort-toggle',
        'data-tip': '更改这些子项的排序方式',
        onclick: (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          this.showMenu(SORT_MODES.map(([value, label]) => ({
            icon: this.tree.sortMode === value ? 'check' : 'list',
            label,
            run: () => {
              this.tree.setSortMode(value);
              this.inspector.sortMode = value;
              this.inspector.renderChildren();
            },
          })), rect.right - 200, rect.bottom + 6);
        },
      }, icon('sliders', { size: 13 })));
    }

    if (title && !title.querySelector('.types-toggle')) {
      const toggle = el('button', {
        class: 'btn btn-sm btn-ghost types-toggle',
        'data-tip': '按属性类型筛选这些子项',
        'aria-pressed': 'false',
        onclick: () => {
          const open = host.style.display === 'none';
          host.style.display = open ? '' : 'none';
          toggle.setAttribute('aria-pressed', open ? 'true' : 'false');
          // Remembered for setPanel, which has to put the row back exactly as
          // it was rather than simply visible.
          this.typesOpen = open;
        },
      }, icon('filter', { size: 12 }), el('span', { text: '类型' }));
      title.append(toggle);
    }
  }

  restoreTheme() {
    const saved = localStorage.getItem(STORE.theme)
      ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = saved;
  }

  toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(STORE.theme, next);
    this.paintThemeIcon();
  }

  /** Anchored flat menu; the shared surface for every overflow in the app. */
  showMenu(items, x, y) {
    return this.buildMenu([items], x, y);
  }

  /**
   * Paints a menu of separated groups at a point, and wires every way out of it.
   *
   * Picking an item, clicking away and Escape all go through one dismiss(), and
   * the listeners hang off one AbortController. They used to be removed only by
   * Escape -- which is the rarest of the three -- so every menu closed the usual
   * way left a document keydown handler behind, holding the detached menu and,
   * through its closures, the App, and running on every later keystroke.
   */
  buildMenu(groups, x, y) {
    // One menu at a time, and the one being replaced takes its listeners with
    // it instead of waiting for a click that may never come: right-clicking
    // twice never fires the click that used to be their only other way out.
    this.dismissMenu?.();

    const menu = el('div', { class: 'ctx-menu' });
    const scope = new AbortController();
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      if (this.dismissMenu === dismiss) this.dismissMenu = null;
      scope.abort();
      motionOut(menu, { remove: true, timeout: 150 });
    };
    this.dismissMenu = dismiss;

    groups.forEach((group, index) => {
      const items = group.filter(Boolean);
      if (!items.length) return;
      if (index > 0 && menu.childElementCount) menu.append(el('div', { class: 'ctx-sep' }));
      for (const item of items) {
        menu.append(el('button', {
          class: 'ctx-item', 'data-danger': item.danger ? 'true' : null,
          onclick: () => { dismiss(); item.run(); },
        },
          icon(item.icon ?? 'dot', { size: 15 }),
          el('span', { text: item.label }),
          item.shortcut ? el('span', { class: 'sc', text: item.shortcut }) : null));
      }
    });

    document.body.append(menu);

    // Keep it on screen when opened near an edge.
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    motionIn(menu, { unhide: false, timeout: 220 });

    // Deferred, or the click that opened the menu would close it again. An
    // item picked before this runs leaves the signal already aborted, and
    // addEventListener does nothing with one of those.
    setTimeout(() => {
      document.addEventListener('click', dismiss, { once: true, signal: scope.signal });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') dismiss();
      }, { signal: scope.signal });
    }, 0);

    return menu;
  }

  /**
   * One right-click handler for the whole app. What appears depends on what
   * was clicked and which mode is active -- a cash shop card offers item
   * actions, a tree row offers node actions, empty space offers the actions
   * for whatever contains it.
   */
  installContextMenus() {
    document.addEventListener('contextmenu', (event) => {
      // Text fields keep the browser's own menu: copy, paste and spellcheck
      // are more useful there than anything we could offer.
      if (event.target.closest('input, textarea, [contenteditable="true"]')) return;

      // The tree runs its own handler so it can fix the selection first.
      if (event.target.closest('#tree-rows')) return;

      const items = this.contextItemsFor(event.target);
      if (!items?.length) return;

      event.preventDefault();
      this.showMenu(items, event.clientX, event.clientY);
    });
  }

  /** Builds the right menu for whatever was right-clicked. */
  contextItemsFor(target) {
    /* ---------- the section list itself ---------- */
    if (target.closest?.('.sec-list')) return this.sections.menuItems();

    /* ---------- cash shop ---------- */
    const card = target.closest?.('.item-card, .item-table tr');
    if (card && this.inSection('cashshop')) {
      const itemId = Number(card.dataset.itemId ?? card.querySelector('[data-item-id]')?.dataset.itemId);
      const item = this.shop.items.find((i) => i.itemId === itemId);
      if (item) {
        return [
          { icon: 'edit', label: '编辑道具…', run: () => this.shop.openItemDialog(item) },
          { icon: 'copy', label: '以新序列号复制', run: () => this.shop.clone(item) },
          { icon: 'copy', label: `复制道具 ID ${item.itemId}`, run: () => this.copyText(String(item.itemId)) },
          { icon: 'copy', label: `复制序列号 ${item.sn}`, run: () => this.copyText(String(item.sn)) },
          { icon: 'externalLink', label: '在资源管理器中显示', run: () => {
            this.setMode('explorer');
            this.navigate(item.path);
          } },
          { icon: 'trash', label: '删除道具', danger: true, run: () => this.shop.remove(item) },
        ];
      }
    }

    if (target.closest?.('.shop') && this.inSection('cashshop')) {
      return [
        { icon: 'plus', label: '添加道具…', run: () => this.shop.openItemDialog() },
        { icon: 'list', label: '批量添加…', run: () => this.shop.openBulkDialog() },
        { icon: 'refresh', label: '重新加载道具列表', run: () => this.shop.load() },
      ];
    }

    /* ---------- database ---------- */
    if (this.inSection('database')) {
      return target.closest?.('.db') ? this.db.menuItems() : null;
    }

    /* ---------- mobs ---------- */
    if (this.inSection('mobs')) {
      const mobCard = target.closest?.('.mob-card');
      const mob = mobCard && this.mobs.mobs.find((m) => m.path === mobCard.dataset.path);
      if (mob) return this.mobs.menuItemsFor(mob);

      if (target.closest?.('.mobs')) {
        return [
          { icon: 'sliders', label: '批量编辑选中的怪物…', run: () => this.mobs.openBulkDialog() },
          { icon: 'close', label: '清除选择',
            run: () => { this.mobs.selection.clear(); this.mobs.render(); } },
          { icon: 'refresh', label: '重新加载怪物列表', run: () => this.mobs.load() },
        ];
      }
    }

    // Everything below acts on an Explorer selection that the sectioned
    // workspace is not showing, so a right-click that reached none of the
    // section handlers above offers nothing rather than node actions for a node
    // that is not on screen.
    if (this.mode !== 'explorer') return null;

    /* ---------- a row in the child table ---------- */
    const row = target.closest?.('[data-path]');
    if (row?.dataset.path) {
      const path = row.dataset.path;
      const child = this.inspector.children.find((c) => c.path === path);
      return this.nodeMenuItems(path, child);
    }

    /* ---------- empty space in the stage: act on the open node ---------- */
    if (target.closest?.('.stage-body, .stage') && this.currentPath) {
      return [
        { icon: 'plus', label: '添加子节点…', run: () => this.promptAddChild(this.currentPath) },
        { icon: 'image', label: '从图片添加画布…',
          run: () => this.promptAddChild(this.currentPath, 'Canvas') },
        this.clipboard?.length
          ? { icon: 'upload', label: `粘贴 ${this.clipboard.length} 个节点`, shortcut: 'Ctrl V',
              run: () => this.paste(this.currentPath, this.clipboardCut) }
          : null,
        { icon: 'replace', label: '在此查找并替换…',
          run: () => openFindReplace(this, this.currentPath) },
        { icon: 'download', label: '导出图像 (ZIP)',
          run: () => this.download(api.exportImagesUrl(this.currentPath)) },
        { icon: 'refresh', label: '重新加载此节点', run: () => {
          this.tree.invalidate(this.currentPath);
          this.inspector.refresh();
        } },
      ].filter(Boolean);
    }

    /* ---------- the inspector ---------- */
    if (target.closest?.('.inspector') && this.currentPath) {
      return this.nodeMenuItems(this.currentPath, this.inspector.node);
    }

    return null;
  }

  /** The node actions shared by the table, the inspector and the tree. */
  nodeMenuItems(path, node) {
    const isCanvas = node?.type === 'Canvas' || node?.kind === 'Canvas';
    return [
      { icon: 'externalLink', label: '打开', run: () => this.navigate(path) },
      node?.hasChildren
        ? { icon: 'chevronDown', label: this.tree.expanded.has(path) ? '折叠' : '展开',
            run: () => this.tree.toggle(path) }
        : null,
      node?.hasChildren
        ? { icon: 'layers', label: '展开下方全部', shortcut: '*',
            run: () => this.expandAll(path) }
        : null,
      node?.hasChildren && this.tree.expanded.has(path)
        ? { icon: 'list', label: '折叠下方全部',
            run: () => this.tree.collapseAll(path) }
        : null,
      isCanvas
        ? { icon: 'upload', label: '替换画布图像…', run: () => this.replaceCanvasFile(path) }
        : null,
      isCanvas
        ? { icon: 'brush', label: '像素编辑…', run: () => this.openPixelEditor(node) }
        : null,
      isCanvas
        ? { icon: 'download', label: '导出此 PNG', run: () => this.download(canvasUrl(path)) }
        : null,
      // The quick items above are the one-click answers for the node kinds that
      // have one. This asks the server what this node is and offers everything
      // it can produce, each with what that format loses.
      { icon: 'download', label: '导出…', run: () => openExportDialog(this, path) },
      node?.kind === 'Image'
        ? { icon: 'download', label: '导出为 .img', run: () => this.download(api.exportImgUrl(path)) }
        : null,
      { icon: 'plus', label: '添加子节点…', run: () => this.promptAddChild(path) },
      { icon: 'copy', label: '创建副本', run: () => this.duplicate([path]) },
      node?.kind === 'Property'
        ? { icon: 'arrowUp', label: '上移', shortcut: 'Alt ↑', run: () => this.moveNode(path, -1) }
        : null,
      node?.kind === 'Property'
        ? { icon: 'arrowDown', label: '下移', shortcut: 'Alt ↓', run: () => this.moveNode(path, 1) }
        : null,
      { icon: 'copy', label: '复制', shortcut: 'Ctrl C', run: () => this.copyNodes([path]) },
      { icon: 'star', label: this.pins.has(path) ? '取消固定' : '固定', shortcut: 'Ctrl D',
        run: () => this.togglePin(path) },
      { icon: 'copy', label: '复制路径', run: () => this.copyPath(path) },
      { icon: 'trash', label: '删除', shortcut: 'Del', danger: true, run: () => this.deleteNodes([path]) },
    ].filter(Boolean);
  }

  copyText(value) {
    navigator.clipboard.writeText(value)
      .then(() => toast(`已复制 ${value}。`, 'success'))
      .catch(() => toast('无法复制到剪贴板。', 'error'));
  }

  /**
   * Closes an archive, warning first if it has unsaved edits. Closing only
   * drops it from this session -- nothing on disk is touched.
   */
  /**
   * Marks an archive reference-only, or releases it.
   *
   * For the case that actually bites: two clients open at once to port a change
   * between them. The archives are named the same and the icon and name pools
   * deliberately merge them, so the only signal that you edited the wrong one is
   * a dirty dot in the wrong place, noticed twenty minutes later. The server
   * refuses every write below a locked file, so this cannot be worked around by
   * a stale UI — the lock is enforced where the edit happens, not here.
   */
  async setReadOnly(file, readOnly) {
    try {
      await api.setReadOnly(file.id, readOnly);
      await this.refreshFiles();
      toast(
        readOnly
          ? `${file.name} 现为只读引用。其下的编辑将被拒绝。`
          : `${file.name} 可以再次编辑了。`,
        'success',
      );
    } catch (error) {
      toastError(error, `无法更改 ${file.name}`);
    }
  }

  async closeFile(fileId) {
    const file = this.files.find((f) => f.id === fileId);
    if (!file) return;

    if (file.dirty) {
      // Asked for rather than read off the file list for the same reason as the
      // save dialog: dirtyNodeCount is images only, so the one dialog that
      // throws work away was announcing "0 images have edits" for a deletion.
      const pending = await api.changes()
        .then((data) => data.files.find((entry) => entry.file.id === fileId))
        .catch(() => null);
      const count = pending?.changeCount ?? file.dirtyNodeCount;
      const ok = await confirmDialog({
        title: `关闭 ${file.name}?其中有未保存的更改`,
        message: count
          ? `${count} 处未保存更改尚未写入磁盘。关闭将丢弃它们,磁盘上的文件不会改变。`
          : '此存档包含尚未写入磁盘的未保存工作。关闭将丢弃它们,磁盘上的文件不会改变。',
        confirmLabel: '放弃并关闭',
      });
      if (!ok) return;
    }

    try {
      await api.close(fileId);
      // Anything selected inside the closed archive no longer exists.
      if (this.currentPath?.split('/')[0] === fileId) {
        this.currentPath = null;
        this.history = this.history.filter((p) => p.split('/')[0] !== fileId);
        this.historyIndex = this.history.length - 1;
        clear($('#breadcrumb'));
        clear($('#child-list'));
        clear($('#inspector-body'));
      }
      this.tree.invalidateAll();
      // Session ids are handed out in open order, so "f1" and item id 5000000
      // will address a different archive after the next open. Every cached
      // thumbnail, sprite and shop icon keyed on them is now wrong.
      resetMediaCache();
      await this.refreshFiles();
      if (!this.files.length) this.showWelcome();
      toast(`${file.name} 已关闭。`, 'success');
    } catch (error) {
      toastError(error, '无法关闭该文件');
    }
  }

  showContextMenu(path, node, event) {
    const selection = [...this.tree.selection];
    const multiple = selection.length > 1;
    // Directories in the selection, for the folder port. Falls back to the
    // clicked node so right-clicking one folder without selecting it works.
    const folders = selection.filter((p) => this.tree.nodes.get(p)?.kind === 'Directory');
    if (!folders.length && node?.kind === 'Directory') folders.push(path);

    // A merged family root is a File-shaped row with no file behind it: there is
    // nothing to save as, nothing to reveal in Explorer and nothing to close,
    // because it is four archives being drawn as one. Its own menu is in
    // family.js, beside the rest of the merge.
    if (node?.familyInfo) {
      event.preventDefault();
      const live = this.families?.find((f) => f.id === path) ?? node.familyInfo;
      this.showMenu(familyMenuItems(this, live), event.clientX, event.clientY);
      return;
    }

    // An archive root is a different object: it has no parent to be deleted
    // from, and the useful actions are save, close and reveal.
    if (node?.kind === 'File') {
      const file = this.files.find((f) => f.id === path);
      event.preventDefault();
      this.showMenu([
        { icon: 'chevronDown', label: this.tree.expanded.has(path) ? '折叠' : '展开',
          run: () => this.tree.toggle(path) },
        { icon: 'layers', label: '展开下方全部', run: () => this.expandAll(path) },
        { icon: 'list', label: '折叠全部', run: () => this.tree.collapseEverything() },
        file?.kind !== 'img-folder'
          ? { icon: 'save', label: '保存此文件', run: () => file && this.runSave([file], true) }
          : null,
        file?.kind !== 'img-folder'
          ? { icon: 'save', label: '另存为…', shortcut: 'Ctrl Shift S', run: () => this.saveAs(file) }
          : null,
        file?.kind === 'img'
          ? { icon: 'download', label: '导出为 .img', run: () => this.download(api.exportImgUrl(path)) }
          : null,
        { icon: 'download', label: '导出为 JSON', run: () => this.download(api.exportJsonUrl(path)) },
        { icon: 'download', label: '导出为服务端 XML', run: () => this.download(api.exportXmlZipUrl(path)) },
        // Everything else this archive can produce, including the dump to a
        // folder on disk -- which for a whole archive is the only one of these
        // that runs as a job you can watch and cancel.
        { icon: 'download', label: '导出…', run: () => openExportDialog(this, path) },
        { icon: 'externalLink', label: '在文件资源管理器中显示', run: () => this.revealInExplorer(file) },
        { icon: 'copy', label: '复制文件路径', run: () => file && this.copyPath(file.filePath) },
        file?.kind !== 'img-folder'
          ? { icon: file?.readOnly ? 'edit' : 'lock',
              label: file?.readOnly ? '允许编辑' : '以只读方式打开',
              run: () => file && this.setReadOnly(file, !file.readOnly) }
          : null,
        { icon: 'close', label: '关闭文件', danger: true, run: () => this.closeFile(path) },
      ], event.clientX, event.clientY);
      return;
    }

    // Grouped so the destructive action is never adjacent to a common one.
    const isCanvas = node?.type === 'Canvas' || node?.kind === 'Canvas';
    const canContainCanvas = node?.kind === 'Image'
      || node?.type === 'SubProperty'
      || node?.type === 'Convex';
    const groups = [
      [
        { icon: 'externalLink', label: '打开', run: () => this.navigate(path) },
        node?.hasChildren
          ? { icon: 'chevronDown', label: this.tree.expanded.has(path) ? '折叠' : '展开',
              run: () => this.tree.toggle(path) }
          : null,
        node?.hasChildren
          ? { icon: 'layers', label: '展开下方全部', shortcut: '*',
              run: () => this.expandAll(path) }
          : null,
        node?.hasChildren && this.tree.expanded.has(path)
          ? { icon: 'list', label: '折叠下方全部',
              run: () => this.tree.collapseAll(path) }
          : null,
        { icon: 'plus', label: '添加子节点…', run: () => this.promptAddChild(path) },
        canContainCanvas
          ? { icon: 'image', label: '从图片添加画布…',
              run: () => this.promptAddChild(path, 'Canvas') }
          : null,
        isCanvas
          ? { icon: 'upload', label: '替换画布图像…', run: () => this.replaceCanvasFile(path) }
          : null,
        isCanvas
          ? { icon: 'brush', label: '像素编辑…', run: () => this.openPixelEditor(node) }
          : null,
        isCanvas
          ? { icon: 'download', label: '导出此 PNG',
              run: () => this.download(canvasUrl(path)) }
          : null,
        multiple
          ? { icon: 'edit', label: `为 ${selection.length} 个节点设置值…`, shortcut: 'Ctrl E',
              run: () => openBulkEdit(this, selection) }
          : null,
      ],
      [
        // The keyboard route to what a drag does. Offered on the tree menu too
        // rather than only on the child table's, because the tree is where the
        // drag lives and a gesture with no menu equivalent is a gesture some
        // people cannot perform at all.
        node?.kind === 'Property'
          ? { icon: 'arrowUp', label: '上移', shortcut: 'Alt ↑', run: () => this.moveNode(path, -1) }
          : null,
        node?.kind === 'Property'
          ? { icon: 'arrowDown', label: '下移', shortcut: 'Alt ↓', run: () => this.moveNode(path, 1) }
          : null,
        { icon: 'copy', label: '创建副本', run: () => this.duplicate(selection) },
        { icon: 'copy', label: '复制', shortcut: 'Ctrl C', run: () => this.copyNodes(selection) },
        { icon: 'replace', label: '剪切', shortcut: 'Ctrl X', run: () => this.copyNodes(selection, true) },
        this.clipboard?.length
          ? { icon: 'upload', label: '粘贴到此处', shortcut: 'Ctrl V',
              run: () => this.paste(path, this.clipboardCut) }
          : null,
      ],
      [
        { icon: 'star', label: this.pins.has(path) ? '取消固定' : '固定', shortcut: 'Ctrl D',
          run: () => this.togglePin(path) },
        // Scoped search. The panel already accepts a root; without a way to
        // set one, "find every maxHP" always meant every open archive.
        // Porting a whole folder -- "all of Accessory", or Cap and Ring
        // together.
        //
        // The server has taken Scope: "folder" since it was written and no
        // screen ever sent it, so the one thing the feature was asked for
        // was unreachable. Here rather than in the port dialog because a
        // folder is something you are looking at in the tree, not something
        // you search for by name.
        //
        // Every selected directory goes in one request: two runs would be two
        // previews, two overwrite decisions and two undo entries for what the
        // user did as one gesture.
        node?.kind === 'Directory'
          ? { icon: 'externalLink',
              label: folders.length > 1
                ? `将 ${folders.length} 个文件夹导入另一个客户端…`
                : '将此文件夹导入另一个客户端…',
              run: () => openPortDialog({
                app: this, kind: 'item', paths: folders, scope: 'folder',
                sourceFileId: path.split('/')[0],
              }) }
          : null,
        { icon: 'search', label: '在此节点内搜索…', run: () => this.openSearch(path) },
        { icon: 'replace', label: '在此查找并替换…', run: () => openFindReplace(this, path) },
        { icon: 'download', label: '导出图像 (ZIP)',
          run: () => this.download(api.exportImagesUrl(path)) },
        { icon: 'download', label: '导出为 JSON', run: () => this.download(api.exportJsonUrl(path)) },
        node?.kind === 'Image'
          ? { icon: 'download', label: '导出为 .img', run: () => this.download(api.exportImgUrl(path)) }
          : null,
        // The two above are shortcuts for the two most common answers. This one
        // asks what the node is first, and says what each format leaves behind.
        { icon: 'download', label: '导出…', run: () => openExportDialog(this, path) },
        { icon: 'copy', label: '复制路径', shortcut: 'Alt C', run: () => this.copyPath(path) },
      ],
      [
        { icon: 'trash', label: '删除', shortcut: 'Del', danger: true,
          run: () => this.deleteNodes(selection) },
      ],
    ];

    this.buildMenu(groups, event.clientX, event.clientY);
  }

  showShortcuts() {
    const rows = [
      ['Ctrl P', '跳转到任意节点'], ['Ctrl Shift P', '命令面板'],
      ['Ctrl Shift F', '搜索所有已打开的文件'], ['Ctrl S', '保存'],
      ['Ctrl Z / Ctrl Shift Z', '撤销 / 重做'],
      ['Ctrl 1 / Ctrl 2', '资源管理器 / 编辑器'],
      ['Ctrl 3 / Ctrl 4 / Ctrl 5', '商城 / 怪物 / 游戏数据搜索'],
      ['Alt ← / Alt →', '后退 / 前进'], ['/', '筛选当前子项'],
      ['↑ ↓', '在树中移动'], ['→ / ←', '展开 / 折叠'],
      ['Alt ↑ / Alt ↓', '在兄弟节点间重排所选节点'],
      ['Drag a row', '行间拖拽可重排;拖到某行上则移入该行'],
      ['a–z', '键入跳转'], ['F2', '重命名'], ['Delete', '删除所选'],
      ['*', '展开下方全部'], ['-', '折叠下方全部'],
      ['Ctrl C / Ctrl X / Ctrl V', '复制 / 剪切 / 粘贴节点'],
      ['Ctrl D', '固定 / 取消固定当前节点'],
      ['Ctrl H', '查找并替换'],
      ['Ctrl E', '更改每个所选值 — *1.5, +50, -10%, clamp 1 999'],
      ['Ctrl A', '在搜索结果面板中:全选所有可编辑结果'],
      ['Ctrl Click / Shift Click', '在树中多选'],
      ['?', '此列表'],
    ];
    const groups = [
      ['常规', rows.slice(0, 7)],
      ['资源管理器', rows.slice(7, 18)],
      ['编辑', rows.slice(18)],
    ];
    modal({
      title: '键盘快捷键',
      width: '520px',
      body: el('div', { class: 'shortcut-groups' }, ...groups.map(([label, shortcuts]) =>
        el('section', { class: 'shortcut-group' },
          el('h3', { text: label }),
          el('div', { class: 'shortcut-grid' }, ...shortcuts.flatMap(([key, what]) => [
            el('kbd', { text: key }), el('span', { text: what }),
          ]))))),
    });
  }

  async showAbout() {
    let about = { version: '1.0.0', license: 'GPL-3.0' };
    try { about = { ...about, ...(await api.about()) }; } catch { /* static details remain useful */ }

    modal({
      title: '关于 MapleBench',
      width: '520px',
      body: el('div', { class: 'about-sheet' },
        el('div', { class: 'about-brand' }, brandMark(24),
          el('div', {}, el('h2', { text: 'MapleBench' }),
            el('p', { text: `版本 ${about.version}` }))),
        el('p', { text: '面向 MapleStory 的 Windows WZ 编辑器与依赖感知的客户端导入工具。' }),
        el('dl', {},
          el('dt', { text: '作者' }), el('dd', { text: 'Kiro' }),
          el('dt', { text: '许可证' }), el('dd', { text: about.license }),
          el('dt', { text: '源格式' }), el('dd', { text: '经典 .wz 与拆分 Data 客户端' })),
        el('p', { class: 'about-note', text: '保存会先写入临时文件,并在替换目标文件前重新打开验证。' }),
        el('a', { class: 'btn', href: 'https://github.com/xkiro-dev/MapleBench', target: '_blank',
          rel: 'noreferrer', text: '在 GitHub 上查看源代码' })),
    });
  }

  /* ============================================================
     PALETTE
     ============================================================ */

  openPalette(seed = '') {
    const palette = $('#palette');
    const input = $('#palette-input');
    const list = $('#palette-list');

    // Reopening seeds the palette that is already there. Opening it a second
    // time added a second set of listeners to the same three elements, and
    // close() only removes its own -- so Enter ran the chosen command once per
    // opening.
    if (palette.dataset.motion === 'closing') {
      palette.dataset.open = 'false';
    } else if (palette.dataset.open === 'true') {
      input.value = seed;
      input.focus();
      input.select();
      input.dispatchEvent(new Event('input'));
      return;
    }

    palette.dataset.open = 'true';
    palette.removeAttribute('aria-hidden');
    motionIn(palette, { unhide: false, timeout: 220 });
    input.value = seed;
    input.focus();

    let results = [];
    let active = 0;

    const commands = [
      { label: '打开客户端或存档…', run: () => this.openFilePicker() },
      { label: '从另一客户端导入…',
        sub: '一个导入器即可处理经典 WZ 与拆分 Data 客户端,并包含依赖',
        run: () => this.openImporter() },
      { label: '将拆分存档作为一棵树浏览…',
        sub: 'Skill.wz 与 Skill001-003.wz 是分四个文件的一个存档',
        run: () => this.openFamilyPicker() },
      ...(this.families ?? []).map((family) => ({
        label: `检查 ${family.name} 是否有重复图像名…`,
        sub: `${family.members.length} 个存档已合并 — 重名时按挂载顺序解析`,
        run: () => showShadows(this, family.id),
      })),
      { label: '保存更改', when: () => !$('#btn-save').disabled, run: () => this.save() },
      { label: '撤销', when: () => !$('#btn-undo').disabled, run: () => this.undo() },
      { label: '重做', when: () => !$('#btn-redo').disabled, run: () => this.redo() },
      { label: '切换到资源管理器', run: () => this.setMode('explorer') },
      { label: '切换到编辑器', sub: '你上次所在的工作区',
        run: () => this.setMode('sections') },
      // One per section, spelled out, because "everything in a context menu is
      // also in the palette" is what makes a collapsed list safe to collapse.
      ...SECTION_IDS.map((id) => ({
        label: `打开${sectionLabel(id)}分区`,
        run: () => this.openSection(id),
      })),
      { label: '搜索客户端数据库…',
        run: async () => { await this.openSection('database'); this.db.focusSearch(); } },
      { label: '批量编辑选中的怪物…',
        run: async () => { await this.openSection('mobs'); this.mobs.openBulkDialog(); } },
      { label: '切换主题', run: () => this.toggleTheme() },
      { label: '键盘快捷键', run: () => this.showShortcuts() },
      { label: '搜索所有已打开的文件…', run: () => this.openSearch(null) },
      { label: '在当前节点内搜索…', when: () => Boolean(this.currentPath),
        run: () => this.currentPath && this.openSearch(this.currentPath) },
      { label: '查找并替换…', when: () => Boolean(this.currentPath),
        run: () => openFindReplace(this, this.currentPath) },
      { label: '显示未保存的更改', when: () => this.files.some((file) => file.dirty),
        run: () => this.setPanel('changes') },
      { label: '显示已固定节点', run: () => this.setPanel('pinned') },
      { label: '固定当前节点', when: () => Boolean(this.currentPath),
        run: () => this.currentPath && this.togglePin(this.currentPath) },
      { label: '导出此节点下的图像 (ZIP)', when: () => Boolean(this.currentPath),
        run: () => this.currentPath && this.download(api.exportImagesUrl(this.currentPath)) },
      { label: '将此节点导出为 JSON', when: () => Boolean(this.currentPath),
        run: () => this.currentPath && this.download(api.exportJsonUrl(this.currentPath)) },
      { label: '复制当前路径', when: () => Boolean(this.currentPath),
        run: () => this.currentPath && this.copyPath(this.currentPath) },
    ];

    // A palette is a list of things the user can do now, not a catalogue of
    // controls that will explain why they did nothing after Enter. Commands
    // whose prerequisite state is absent simply stay out until it exists.
    const availableCommands = () => commands.filter((command) => command.when?.() !== false);

    const paint = () => {
      clear(list);
      if (!results.length) {
        list.append(el('div', { class: 'palette-empty', text: '无匹配项。输入 > 可查看命令。' }));
        return;
      }
      results.forEach((result, index) => {
        list.append(el('div', {
          class: 'palette-item', role: 'option',
          'aria-selected': index === active ? 'true' : 'false',
          onclick: () => { close(); result.run(); },
        },
          el('span', { class: 'p-main', text: result.label }),
          result.sub ? el('span', { class: 'p-sub', text: result.sub }) : null));
      });
    };

    // Debouncing thins the requests out but does not order them: a slow answer
    // for "ab" arriving after a quick one for "abc" repainted the list with
    // results for what the box no longer says. Each run cancels the last.
    let searching = null;

    const search = debounce(async () => {
      searching?.abort();
      const value = input.value.trim();
      if (value.startsWith('>')) {
        const needle = value.slice(1).trim().toLowerCase();
        results = availableCommands().filter((c) => c.label.toLowerCase().includes(needle));
        active = 0;
        paint();
        return;
      }
      if (!value) {
        results = availableCommands().slice(0, 6);
        active = 0;
        paint();
        return;
      }
      const mine = new AbortController();
      searching = mine;
      try {
        const found = await api.search(
          { query: value, matchNames: true, matchValues: false, limit: 40 },
          { signal: mine.signal });
        results = found.hits.map((hit) => ({
          // The String.wz alias on the label, so "0100101.img" reads as
          // "0100101.img · Blue Snail" -- the tree has shown that since round
          // one and the palette was the last place you had to know the number.
          label: hit.displayName ? `${hit.name} · ${hit.displayName}` : hit.name,
          // Archive first. Three open archives produced three identical-looking
          // hits, because the context line drops the file id on purpose.
          sub: hit.file ? `${hit.file} · ${hit.context}` : hit.context,
          run: () => this.navigate(hit.path),
        }));
        active = 0;
        paint();
      } catch { /* keep the previous results */ }
    }, 140);

    const close = () => {
      if (palette.dataset.open !== 'true') return;
      searching?.abort();
      input.blur();
      $('#omnibox').blur();
      input.removeEventListener('input', search);
      input.removeEventListener('keydown', keys);
      palette.removeEventListener('mousedown', backdrop);
      motionOut(palette, { hide: false, timeout: 160 }).then((finished) => {
        if (!finished) return;
        palette.dataset.open = 'false';
        palette.setAttribute('aria-hidden', 'true');
      });
    };

    const keys = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); active = Math.min(active + 1, results.length - 1); paint(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); active = Math.max(active - 1, 0); paint(); }
      else if (event.key === 'Enter') {
        event.preventDefault();
        const chosen = results[active];
        if (chosen) { close(); chosen.run(); }
      }
    };

    const backdrop = (event) => { if (event.target === palette) close(); };

    input.addEventListener('input', search);
    input.addEventListener('keydown', keys);
    palette.addEventListener('mousedown', backdrop);
    search();
  }

  /**
   * Opens the search results panel, scoped to a path when one is given.
   *
   * This used to be a modal whose first result click closed it, so looking at a
   * second hit meant running the whole search again -- measured at 6.8 s for a
   * value search over three open archives. The results are a panel now; see
   * js/results.js.
   */
  openSearch(scope = undefined) {
    this.results.open({ scope });
  }

  /* ============================================================
     KEYBOARD + DRAG/DROP
     ============================================================ */

  bindKeyboard() {
    document.addEventListener('keydown', (event) => {
      // An open dialog or palette owns the keyboard. The typing guard below is
      // not enough: confirmDialog focuses the Cancel *button*, so Delete used to
      // start a second delete, Ctrl+S opened the save dialog and Ctrl+Z rolled
      // back a WZ edit -- all while a confirm sat on screen asking about the
      // first one. Escape is left alone; the dialog and the palette close on it.
      if (event.key !== 'Escape'
          && (document.querySelector('dialog[open]') || $('#palette').dataset.open === 'true')) {
        // The two combos the browser would otherwise claim are still swallowed:
        // handing Ctrl+S to "save this page" and Ctrl+P to the printer is not an
        // improvement on running them.
        if ((event.ctrlKey || event.metaKey) && /^[sp]$/.test(event.key.toLowerCase())) {
          event.preventDefault();
        }
        return;
      }

      const mod = event.ctrlKey || event.metaKey;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);

      if (mod && event.key.toLowerCase() === 'p') { event.preventDefault(); this.openPalette(event.shiftKey ? '>' : ''); return; }
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        // Shift means "somewhere else": the current file, to a path you pick.
        if (event.shiftKey) {
          const current = this.files.find((f) => f.id === this.currentPath?.split('/')[0])
            ?? this.files.find((f) => f.dirty)
            ?? this.files[0];
          this.saveAs(current);
        } else {
          this.save();
        }
        return;
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); this.openSearch(); return; }
      // Import is reachable while editing, not only from the welcome screen.
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'i' && !typing) {
        event.preventDefault(); this.openImporter(); return;
      }

      // Undo/redo must not pre-empt a text field: inside an input, Ctrl+Z means
      // "undo my typing", and stealing it here would silently roll back the
      // last WZ edit instead.
      if (mod && event.key.toLowerCase() === 'z' && !typing) {
        event.preventDefault();
        event.shiftKey ? this.redo() : this.undo();
        return;
      }
      // The rail has advertised "Files · Ctrl B" since it was written and
      // nothing was ever listening for it. Now that the button can also put the
      // pane away, the shortcut it promised does the same thing.
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault(); this.setPanel('files'); return;
      }
      if (mod && event.key === '1') { event.preventDefault(); this.setMode('explorer'); return; }
      if (mod && event.key === '2') { event.preventDefault(); this.setMode('sections'); return; }
      // 3, 4, 5 jump straight to a section. Ctrl 2 is the shell itself, which
      // opens on whichever section you were last in.
      if (mod && event.key === '3') { event.preventDefault(); this.openSection('cashshop'); return; }
      if (mod && event.key === '4') { event.preventDefault(); this.openSection('mobs'); return; }
      if (mod && event.key === '5') { event.preventDefault(); this.openSection('database'); return; }
      if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); this.back(); return; }
      if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); this.forward(); return; }

      if (typing) return;

      // The keyboard half of a reorder drag, and the only half a touch or
      // screen-reader user has. tree.js hands Alt+arrow through untouched for
      // exactly this; without that it would collapse the node instead.
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && this.tree.focusPath) {
        event.preventDefault();
        this.moveNode(this.tree.focusPath, event.key === 'ArrowUp' ? -1 : 1);
        return;
      }

      if (event.key === '?') { event.preventDefault(); this.showShortcuts(); return; }
      if (event.key === '/') { event.preventDefault(); $('#tree-filter').focus(); return; }
      if (event.key === '*' && this.tree.focusPath) {
        event.preventDefault(); this.expandAll(this.tree.focusPath); return;
      }
      if (event.key === '-' && this.tree.focusPath) {
        event.preventDefault(); this.tree.collapseAll(this.tree.focusPath); return;
      }
      if (event.key === 'Delete' && this.tree.selection.size) {
        event.preventDefault(); this.deleteNodes([...this.tree.selection]); return;
      }
      if (event.key === 'F2' && this.currentPath) {
        event.preventDefault();
        $('#inspector-body input')?.focus();
        return;
      }
      if (mod && event.key.toLowerCase() === 'd' && this.currentPath) {
        event.preventDefault(); this.togglePin(this.currentPath); return;
      }
      if (mod && event.key.toLowerCase() === 'h') {
        event.preventDefault(); openFindReplace(this, this.currentPath); return;
      }
      // Below the typing guard on purpose: inside the results panel's own search
      // box, Ctrl A must still mean "select this text".
      if (mod && event.key.toLowerCase() === 'a' && this.panel === 'results' && this.results.hits.length) {
        event.preventDefault();
        this.results.selectAll(this.results.selected.size === 0);
        return;
      }
      // Ctrl E acts on whichever set the user is actually looking at. Gating it
      // on the tree selection alone meant search -- the one thing in the app
      // that can *find* a set of 300 nodes -- could not hand that set to the one
      // dialog that can change them all.
      if (mod && event.key.toLowerCase() === 'e') {
        const chosen = this.panel === 'results' && this.results.selected.size
          ? this.results.selectedPaths()
          : (this.tree.selection.size > 1 ? [...this.tree.selection] : null);
        if (chosen) { event.preventDefault(); openBulkEdit(this, chosen); return; }
      }
      if (mod && event.key.toLowerCase() === 'c' && this.tree.selection.size) { this.copyNodes([...this.tree.selection]); return; }
      if (mod && event.key.toLowerCase() === 'x' && this.tree.selection.size) { this.copyNodes([...this.tree.selection], true); return; }
      if (mod && event.key.toLowerCase() === 'v' && this.currentPath) { this.paste(this.currentPath, this.clipboardCut); return; }
    });
  }

  bindDragDrop() {
    const zone = $('#dropzone');
    let depth = 0;

    window.addEventListener('dragenter', (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      depth++;
      zone.dataset.open = 'true';
    });
    window.addEventListener('dragleave', () => {
      if (--depth <= 0) { depth = 0; zone.dataset.open = 'false'; }
    });
    window.addEventListener('dragover', (event) => { if (zone.dataset.open === 'true') event.preventDefault(); });
    window.addEventListener('drop', (event) => {
      if (zone.dataset.open !== 'true') return;
      event.preventDefault();
      depth = 0;
      zone.dataset.open = 'false';

      // The browser only exposes the file name, not the full path, so ask for it.
      const names = [...(event.dataTransfer?.files ?? [])].map((f) => f.name);
      if (!names.length) return;
      toast(
        `拖入的文件不包含其来源文件夹,因此无法直接打开。` +
        `请改为在此选择 "${names[0]}" — 你上次浏览的文件夹已打开。`,
        'info', { title: '拖放将打开文件选择器' });
      this.openFilePicker();
    });
  }
}

const inputStyle = () =>
  'width:100%;height:36px;padding:0 12px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg-field);color:var(--text-1)';

window.app = new App();
