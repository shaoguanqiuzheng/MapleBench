/**
 * Map editor section: open a map, see it drawn correctly, edit it by direct
 * manipulation, save through the round-trip model.
 *
 * The rules the server enforces are surfaced, not hidden, because they are the
 * point of the tool:
 *  - a map the model refuses is a banner with the model's reason, never a
 *    partial open;
 *  - the layer list comes from the document (749080500 has a layer 8);
 *  - the inspector shows keys verbatim — a trailing space is a different key
 *    and is shown as one;
 *  - a save reports what it verified against the saved-and-reopened archive,
 *    and how many unmodelled nodes it carried through untouched.
 *
 * The interaction layer (mapedit-view.js) owns the canvas; this controller
 * owns the keyboard, the palette (grid-first: every asset shows its picture
 * at rest, detail on hover, a live ghost when armed), the floating property
 * panel, and every commit — all through the typed server ops, each gesture
 * one named undo entry.
 */

import { q } from './api.js';
import {
  el, clear, toast, toastError, fmt, debounce, modal, busyButton,
  motionIn, motionOut,
} from './ui.js';
import { emptyState } from './inspector.js';
import { icon } from './icons.js';
import { MapView } from './mapedit-view.js';

async function call(method, url, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      if (data?.message) message = data.message;
    } catch { /* keep the status line */ }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}
const get = (url) => call('GET', url);
const post = (url, body) => call('POST', url, body ?? {});

const sameAddr = (a, b) => Array.isArray(a) && Array.isArray(b) && a.join() === b.join();

const KIND_LABEL = {
  tile: '图块', obj: '对象', foothold: '立足点', portal: '传送门',
  life: '生物刷新点', reactor: '反应器', ladder: '梯子 / 绳子',
  rect: '区域', back: '背景',
};

const RECENTS_KEY = 'mb-me-recents';
const RECENTS_MAX = 12;

/** Panel layout memory: which panels are open, how wide the palette drawer
 *  is — the editor comes back the way it was left. */
const UI_KEY = 'mb-me-ui';
const UI_DEFAULTS = {
  layers: true,      // left dock: compact layer list
  pal: false,        // palette drawer (slides OVER the canvas)
  inspector: false,  // right raw-node panel
  minimap: true,     // on-canvas minimap
  drawerW: 430,
};

export class MapEditSection {
  constructor({ host, app }) {
    this.host = host;
    this.app = app;
    this.doc = null;
    this.view = null;
    this.selection = [];            // array of { kind, entry, item?, vertex? }
    this.caps = null;
    this.portalIconsLoaded = false;
    this.built = false;

    try {
      this.ui = { ...UI_DEFAULTS, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') };
    } catch { this.ui = { ...UI_DEFAULTS }; }
    this.foldSnapshot = null;        // Tab fold-all remembers what to restore
    this.lastSpaceDown = 0;          // double-space = fit map
    this.floatManual = null;         // property panel dragged somewhere by hand

    // Per-kind palette memory: last set, last query — coming back to Tiles
    // finds it where it was left.
    this.palette = { kind: 'Tile', mem: {}, global: '' };
    this.placing = null;
    this.portalIconList = null;
    this.allSets = null;            // { Tile, Obj, Back } cached set lists
    this.previewCache = new Map();  // leaf path -> art dto (hover flyout)
    this.tileVariantCache = new Map(); // "setPath" -> entries
    this.clipboard = null;          // { items: [{addr, kind}], cx, cy }
    this.pendingNudge = null;       // accumulated arrow-key delta
    this.snapTiles = false;
    this.flyoutOpenTimer = null;
    this.flyoutCloseTimer = null;
    this.flyoutLastClosedAt = 0;

    try {
      this.recents = JSON.parse(localStorage.getItem(RECENTS_KEY) || '{}');
    } catch { this.recents = {}; }

    this.unsavedEdits = 0;
    this.unsavedDocs = 0;

    this.commitNudgeDebounced = debounce(() => this.commitNudge(), 350);
  }

  async refreshUnsaved() {
    try {
      const changes = await get('/api/mapedit/changes');
      this.unsavedEdits = changes.editCount;
      this.unsavedDocs = changes.dirtyDocs;
    } catch {
      this.unsavedEdits = this.doc?.dirty ? 1 : 0;
      this.unsavedDocs = this.doc?.dirty ? 1 : 0;
    }
    this.app.updateDirtyUi?.();
  }

  async open() {
    try {
      this.caps = await get('/api/mapedit/capabilities');
    } catch (err) {
      this.caps = null;
      toastError(err, '地图编辑器');
    }

    if (!this.caps?.available) {
      clear(this.host);
      this.host.className = 'stage-body';
      this.built = false;
      this.host.append(emptyState(
        'layers', '请先打开地图存档',
        '地图编辑器从 Map002.wz 读取地图,从 Map.wz、Map001.wz 和 Map2.wz 读取美术资源。' +
        '请打开客户端的 Map 系列存档(副本,而非正在运行的客户端)后再回来。',
        el('button', { class: 'btn btn-primary', onclick: () => this.app.openFilePicker() },
          icon('folderOpen', { size: 15 }), '打开文件')));
      return;
    }

    if (!this.built) this.buildLayout();
    if (!this.doc) this.showIdle();
    else await this.refetchDoc();
  }

  /* ============================================================ layout */

  buildLayout() {
    clear(this.host);
    this.host.className = 'stage-body me-root';
    this.host.__section = this;   // reachable from devtools for live debugging
    this.built = true;

    this.toolbar = el('div', { class: 'me-toolbar' });

    // The canvas is the app. Everything else is a rail icon until asked for:
    // a thin rail, a collapsible layer dock, a palette drawer that slides
    // OVER the canvas, an inspector that only exists for a selection.
    this.rail = el('div', { class: 'me-rail' });
    this.dock = el('div', { class: 'me-dock' });
    this.canvasWrap = el('div', {
      class: 'me-canvas-wrap', tabindex: '0', 'aria-label': '地图画布',
    });
    this.canvas = el('canvas', { class: 'me-canvas' });
    this.banner = el('div', { class: 'me-banner', hidden: true });
    this.float = el('div', { class: 'me-float', hidden: true });
    this.picker = el('div', { class: 'me-picker-pop', hidden: true });
    this.inspector = el('div', { class: 'me-inspector', hidden: true });

    // Palette drawer: header + scrollable body + a resize handle on its right
    // edge. this.side stays the name of the container the palette renders
    // into — the drawer body IS the old side panel, grown up.
    this.side = el('div', { class: 'me-drawer-body' });
    this.drawerTitle = el('strong', { text: '调色板' });
    this.drawer = el('div', { class: 'me-drawer', hidden: true },
      el('div', { class: 'me-drawer-head' },
        this.drawerTitle,
        el('span', { class: 'me-toolbar-spacer' }),
        el('button', {
          class: 'btn btn-ghost btn-icon', 'data-tip': '关闭 (P 或 Esc)',
          'aria-label': '关闭调色板', onclick: () => this.togglePanel('pal', false),
        }, icon('close', { size: 14 }))),
      this.side);
    this.drawerGrip = el('div', { class: 'me-drawer-grip',
      'data-tip': '拖动调整大小 — 双击关闭' });
    this.drawer.append(this.drawerGrip);
    this.installDrawerResize();

    // On-canvas furniture: overlay strip (top), zoom cluster (bottom right),
    // minimap (bottom left), one-line status bar (bottom).
    this.overlayStrip = el('div', { class: 'me-ovstrip' });
    this.zoomCtl = el('div', { class: 'me-zoomctl' });
    this.minimapBox = el('div', { class: 'me-mmbox', hidden: true });
    this.statusText = el('span', { class: 'me-statusbar-text', text: '' });
    this.keyChip = el('button', {
      class: 'me-keychip',
      'data-tip': '地图获得焦点时,所有快捷键都归地图使用,不会传给应用。点击查看列表。',
      onclick: () => this.showKeysHelp(),
    }, '地图按键 · ?');
    this.statusBar = el('div', { class: 'me-statusbar' }, this.statusText,
      el('span', { class: 'me-toolbar-spacer' }), this.keyChip);

    this.canvasWrap.append(
      this.canvas, this.banner, this.overlayStrip, this.zoomCtl, this.minimapBox,
      this.statusBar, this.drawer, this.float, this.picker);
    this.canvas.addEventListener('pointerdown', () => this.canvasWrap.focus());

    this.host.append(
      this.toolbar,
      el('div', { class: 'me-body' }, this.rail, this.dock, this.canvasWrap, this.inspector));

    // The keyboard is scoped at the document, capture phase: while this
    // section is on screen and the user is not typing in a field, EVERY key
    // belongs to the editor and never reaches the app's global handlers —
    // Ctrl+Z here undoes map edits, not WZ tree edits underneath.
    if (!this._keysBound) {
      this._keysBound = true;
      document.addEventListener('keydown', (e) => this.captureKey(e), true);
      document.addEventListener('keyup', (e) => {
        if (e.code === 'Space' && this.editorActive()) this.view?.setSpaceHeld(false);
      }, true);
      window.addEventListener('blur', () => this.view?.setSpaceHeld(false));
    }

    this.view = new MapView(this.canvas, {
      onSelect: (sel) => {
        this.selection = sel ?? [];
        this.floatManual = null;
        this.closePicker();
        this.renderFloat();
        this.renderInspector();
      },
      onStatus: (text) => this.setStatus(text),
      onHover: () => { /* the status readout carries the hover info */ },
      onViewChanged: () => {
        this.positionFloat();
        this.updateZoomLabel();
        this.updateMinimapView();
      },
      onModeChanged: () => this.renderFloat(),
      onMoveMany: (items, dx, dy) => this.commitMoveMany(items, dx, dy),
      onMoveFoothold: (entry, vertex) => this.commitFootholdMove(entry, vertex),
      onMoveLadder: (entry) => this.commitLadderMove(entry),
      onRectResize: (entry) => this.commitRectResize(entry),
      onInsertVertex: (entry, x, y) => this.commitInsertVertex(entry, x, y),
      onExtendFoothold: (entry, vertex, x, y) => this.commitExtendFoothold(entry, vertex, x, y),
      onPlace: (x, y) => this.commitPlacement(x, y),
      onPlaceLadder: (x, y1, y2) => this.commitLadder(x, y1, y2),
      onFootholdChain: (layer, points) => this.commitFootholdChain(layer, points),
      onTilePicker: (sel, sx, sy) => this.openTilePicker(sel, sx, sy),
    });

    this.renderToolbar();
    this.renderSide();
  }

  /* ============================================================ keyboard */

  /** Whether the editor section is what the user is looking at — the focus
   *  boundary of every editor shortcut. */
  editorActive() {
    if (!this.built || !this.host.isConnected) return false;
    if (this.host.offsetParent === null) return false;   // another section is up
    if (document.querySelector('dialog[open]')) return false;
    const palette = document.getElementById('palette');
    if (palette && palette.dataset.open === 'true') return false;
    return true;
  }

  /**
   * Document capture-phase router. While the editor is on screen:
   *  - typing in a field keeps its keys (Esc blurs back to the canvas), and
   *    nothing leaks past the field to app-level handlers;
   *  - everything else is offered to handleKey; a consumed key stops dead —
   *    the app's Ctrl+Z (WZ tree undo) never sees it;
   *  - unclaimed keys are ALSO fenced off from the app's single-key global
   *    shortcuts, except an explicit pass list (section switching, history).
   */
  captureKey(e) {
    if (!this.editorActive()) return;
    const target = e.target;
    const typing = target instanceof Element
      && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);

    if (typing) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        target.blur();
        this.canvasWrap?.focus();
      } else {
        e.stopPropagation();   // the field owns its keys; the app gets none
      }
      return;
    }

    // The app keeps window-level navigation — nothing the editor uses.
    const mod = e.ctrlKey || e.metaKey;
    if ((mod && /^[1-5]$/.test(e.key)) || (e.altKey && /^Arrow/.test(e.key))) return;

    if (this.handleKey(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // Not an editor key, but the editor is focused: single-key app shortcuts
    // ('/', '?', '*', '-', Delete, F2, Ctrl+S…) must not fire underneath.
    e.stopPropagation();
  }

  /** Runs an editor shortcut. Returns true when the key was consumed. */
  handleKey(e) {
    if (!this.view) return false;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (e.code === 'Space') {
      if (!e.repeat) {
        const now = performance.now();
        if (now - this.lastSpaceDown < 350 && this.doc) {
          // Double-space: fit the whole map, like Home.
          this.view.fitToBounds();
          this.view.invalidate();
        }
        this.lastSpaceDown = now;
      }
      this.view.setSpaceHeld(true);
      return true;
    }

    if (key === 'escape') {
      if (!this.picker.hidden) { this.closePicker(); return true; }
      if (this.view.cancelMode()) { this.syncArmedUi(); return true; }
      if (this.placing) { this.cancelPlacement(); return true; }
      if (this.ui.pal) { this.togglePanel('pal', false); return true; }
      if (this.selection.length) {
        this.view.select([]);
        this.selection = [];
        this.renderFloat();
        this.renderInspector();
        return true;
      }
      return false;   // nothing of ours to close — the app may close things
    }

    if (key === 'enter') {
      if (this.view.fhDraw) { this.view.finishFootholdDraw(); return true; }
      if (this.view.fhExtend) { this.view.cancelExtend(); this.setStatus('链条延伸完成。'); return true; }
      return false;
    }

    if (key === 'tab' && !ctrl && !e.altKey) { this.foldAll(); return true; }

    if (ctrl && key === 's' && !e.shiftKey) {
      if (this.doc?.dirty) this.save();
      return true;   // claimed either way — never the app's WZ save
    }
    if (ctrl && key === 'z' && !e.shiftKey) { this.undo(false); return true; }
    if (ctrl && (key === 'y' || (e.shiftKey && key === 'z'))) { this.undo(true); return true; }
    if (ctrl && key === 'a') { this.view.selectAll(); return true; }
    if (ctrl && key === 'c') { this.copySelection(); return true; }
    if (ctrl && key === 'v') { this.pasteClipboard(); return true; }
    if (ctrl && key === 'd') { this.duplicateSelection(24, 0); return true; }
    if (ctrl) return false;

    if (key === 'delete' || key === 'backspace') {
      if (this.selection.length) this.deleteSelection();
      return true;
    }

    if (key === 'arrowleft' || key === 'arrowright' || key === 'arrowup' || key === 'arrowdown') {
      const step = e.shiftKey ? 10 : 1;
      const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
      const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
      if (this.selection.length) {
        this.view.nudgeSelection(dx, dy);
        if (!this.pendingNudge) this.pendingNudge = { dx: 0, dy: 0, items: this.view.selectionItems() };
        this.pendingNudge.dx += dx;
        this.pendingNudge.dy += dy;
        this.commitNudgeDebounced();
        this.renderFloat();
      } else {
        this.view.panBy(dx * 40, dy * 40);
      }
      return true;
    }

    if (key === '+' || key === '=') { this.view.zoomBy(1.15); return true; }
    if (key === '-' || key === '_') { this.view.zoomBy(1 / 1.15); return true; }
    if (key === '0' || key === 'home') { this.view.fitToBounds(); this.view.invalidate(); return true; }
    if (key === '1') { this.view.zoomTo(1); return true; }
    if (key === '?') { this.showKeysHelp(); return true; }
    if (key === 'p') { this.togglePanel('pal'); return true; }
    if (key === 'l') { this.togglePanel('layers'); return true; }
    if (key === 'm') { this.togglePanel('minimap'); return true; }
    if (key === 'i') { this.togglePanel('inspector'); return true; }

    if ((key === '[' || key === ']') && this.single('tile')) {
      this.cycleTileVariant(key === ']' ? 1 : -1);
      return true;
    }
    if (key === 'f') {
      const sel = this.selection.length === 1 ? this.selection[0] : null;
      if (sel && ['obj', 'life', 'reactor', 'back'].includes(sel.kind)) {
        const flip = Number(sel.entry.f ?? 0) === 1 ? '0' : '1';
        this.commitSetField(sel.entry.addr, 'f', flip);
        return true;
      }
      return false;
    }
    return false;
  }

  /* ==================================================== panels + folding */

  saveUi() {
    try { localStorage.setItem(UI_KEY, JSON.stringify(this.ui)); } catch { /* full */ }
  }

  /** Opens/closes one panel (or toggles it), remembers the choice. */
  togglePanel(name, force) {
    const next = force !== undefined ? !!force : !this.ui[name];
    if (this.ui[name] === next) return;
    this.ui[name] = next;
    this.saveUi();
    this.applyPanels();
  }

  /** Tab: everything folds away; Tab again brings back what was open —
   *  the art-tool gesture for "just let me see the map". */
  foldAll() {
    const anyOpen = this.ui.layers || this.ui.pal || this.ui.inspector;
    if (anyOpen) {
      this.foldSnapshot = { layers: this.ui.layers, pal: this.ui.pal, inspector: this.ui.inspector };
      this.ui.layers = false; this.ui.pal = false; this.ui.inspector = false;
    } else {
      const back = this.foldSnapshot ?? { layers: true, pal: false, inspector: false };
      this.ui.layers = back.layers; this.ui.pal = back.pal; this.ui.inspector = back.inspector;
    }
    this.saveUi();
    this.applyPanels();
  }

  /** Keeps a panel mounted through its exit so opening and closing feel like
   *  the same gesture. Direct canvas work stays immediate; only the chrome
   *  around it receives motion. */
  setPanelVisible(node, visible, { enter = 260, exit = 180 } = {}) {
    if (!node) return;
    if (visible) {
      if (node.hidden || node.dataset.motion === 'closing') motionIn(node, { timeout: enter });
      return;
    }
    if (!node.hidden && node.dataset.motion !== 'closing') {
      motionOut(node, { hide: true, timeout: exit }).then(() => this.view?.resize());
    }
  }

  /** Makes the DOM agree with this.ui, then re-renders what is visible. */
  applyPanels() {
    const showDock = Boolean(this.ui.layers && this.doc);
    const showDrawer = Boolean(this.ui.pal && this.doc);
    const showMinimap = Boolean(this.ui.minimap && this.doc);
    const showInspector = Boolean(this.ui.inspector && this.doc && this.selection.length);

    this.drawer.style.width = `${Math.max(280, this.ui.drawerW)}px`;
    this.setPanelVisible(this.dock, showDock, { enter: 240 });
    this.setPanelVisible(this.drawer, showDrawer, { enter: 280, exit: 200 });
    this.setPanelVisible(this.minimapBox, showMinimap);
    this.setPanelVisible(this.inspector, showInspector, { enter: 240 });
    this.renderRail();
    if (showDock) this.renderDock();
    if (showDrawer) this.renderPaletteBody();
    if (showMinimap) this.renderMinimapBox();
    if (showInspector) this.renderInspector();
    // The canvas may have resized under the drawerless layout.
    this.view?.resize();
  }

  installDrawerResize() {
    let start = null;
    this.drawerGrip.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, w: this.drawer.offsetWidth };
      this.drawerGrip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.drawerGrip.addEventListener('pointermove', (e) => {
      if (!start) return;
      const max = Math.max(320, this.canvasWrap.clientWidth * 0.85);
      this.ui.drawerW = Math.round(Math.min(max, Math.max(280, start.w + (e.clientX - start.x))));
      this.drawer.style.width = `${this.ui.drawerW}px`;
    });
    this.drawerGrip.addEventListener('pointerup', () => { start = null; this.saveUi(); });
    this.drawerGrip.addEventListener('dblclick', () => this.togglePanel('pal', false));
  }

  setStatus(text) {
    this.statusText.textContent = text;
  }

  showKeysHelp() {
    const row = (keys, what) => el('div', { class: 'me-keys-row' },
      el('span', { class: 'me-keys-combo num', text: keys }),
      el('span', { text: what }));
    modal({
      title: '地图编辑器快捷键',
      subtitle: '地图编辑器在屏幕上时,这些按键归它所有 — 底层应用不会收到任何按键。',
      width: '520px',
      body: el('div', { class: 'me-keys-grid' },
        row('Space + drag', '平移 — 按住 Space 时不会选择或移动任何内容'),
        row('Space ×2 / Home / 0', '适配整张地图'),
        row('Wheel', '在光标处缩放 · 1 = 100% · + / −'),
        row('Click / drag', '选择 / 移动 (选中的 N 个一起移动)'),
        row('Shift-click · drag on empty', '加入选择 · 框选'),
        row('Arrows (Shift = 10px)', '微调所选,未选择时平移'),
        row('Ctrl+Z / Ctrl+Y', '撤销 / 重做地图编辑'),
        row('Ctrl+C / V / D', '复制 · 粘贴到光标处 · 复制'),
        row('Delete', '移除所选 (一次撤销记录)'),
        row('Ctrl+S', '保存地图'),
        row('[ ]', '切换所选图块的变体'),
        row('F', '翻转所选对象 / 生物 / 背景'),
        row('Double-click', '图块:变体选择器 · 立足点:插入顶点 · 自由端:延伸'),
        row('Esc', '逐级退出:手势、放置、抽屉、选择 — 由内而外'),
        row('Tab', '折叠所有面板 / 恢复显示'),
        row('P · L · I · M', '调色板 · 图层 · 检查器 · 小地图'),
        row('Enter', '完成立足点链')),
      actions: [{ label: '关闭' }],
    });
  }

  single(kind) {
    return this.selection.length === 1 && this.selection[0].kind === kind
      ? this.selection[0] : null;
  }

  async commitNudge() {
    const pending = this.pendingNudge;
    this.pendingNudge = null;
    if (!pending || (!pending.dx && !pending.dy) || !this.doc) return;
    await this.commitMoveMany(pending.items, pending.dx, pending.dy, { alreadyApplied: true });
  }

  showIdle() {
    clear(this.banner);
    this.banner.append(
      el('div', { class: 'me-banner-card' },
        el('h3', { text: '未打开地图' }),
        el('p', { text: `${fmt.format(this.caps.mapCount)} 张地图可从 ` +
          `${this.caps.mapArchives.join(', ')} 打开。` }),
        el('p', { class: 'muted', text:
          '打开地图后:悬停显示所指内容,单击选择,拖动移动,空格拖动平移,滚轮在光标处缩放,双击就地编辑。' }),
        el('button', { class: 'btn btn-primary', onclick: () => this.openPicker() },
          icon('search', { size: 15 }), '打开地图…')));
    motionIn(this.banner, { timeout: 240 });
  }

  renderToolbar() {
    clear(this.toolbar);
    const d = this.doc;
    this.toolbar.append(...[
      el('button', { class: 'btn', onclick: () => this.openPicker(), 'data-tip': '按 ID 或名称选择地图' },
        icon('search', { size: 14 }), '打开地图…'),
      el('button', { class: 'btn', onclick: () => this.newMapDialog(),
        'data-tip': '从零创建地图:9 位 ID、实测最小结构、String.wz 记录行' },
        icon('plus', { size: 14 }), '新建地图…'),
      d ? el('button', { class: 'btn', onclick: () => this.minimapDialog(),
          'data-tip': '根据地图美术重新生成小地图 — 需先经计划确认共享者' },
          '小地图…') : null,
      this.animToggle(),
      d ? el('span', { class: 'me-title' },
          el('strong', { text: d.name ?? '(String.wz 中无名称)' }),
          el('span', { class: 'muted num', text: ` ${d.imageName}` }),
          d.dirty ? el('span', { class: 'me-dirty', 'data-tip': '未保存的地图编辑' }) : null)
        : el('span', { class: 'me-title muted', text: '未打开地图' }),
      ...this.lifeArtActions(),
      el('span', { class: 'me-toolbar-spacer' }),
      d ? el('span', {
          class: 'me-chip', 'data-tip':
            '编辑器词汇表之外的顶级节点,已逐字节原样保留: ' +
            (d.unmodelledNames.length ? d.unmodelledNames.join(', ') : '无'),
          text: `未建模节点保留: ${d.unmodelledCount}`,
        }) : null,
      d ? el('button', { class: 'btn btn-icon btn-ghost', 'data-tip': '撤销地图编辑 (Ctrl+Z)',
          'aria-label': '撤销地图编辑',
          disabled: !d.undoDepth, onclick: () => this.undo(false) }, icon('undo', { size: 15 })) : null,
      d ? el('button', { class: 'btn btn-icon btn-ghost', 'data-tip': '重做地图编辑 (Ctrl+Y)',
          'aria-label': '重做地图编辑',
          disabled: !d.redoDepth, onclick: () => this.undo(true) }, icon('redo', { size: 15 })) : null,
      d ? el('button', { class: 'btn btn-ghost', 'data-tip': '每次编辑的名称,最新在前',
          onclick: (e) => this.toggleHistory(e.currentTarget) }, '历史记录') : null,
      d ? el('button', { class: 'btn btn-primary', disabled: !d.dirty,
          onclick: () => this.save() }, icon('save', { size: 15 }), '保存地图') : null,
    ].filter(Boolean));
  }

  /** A map knows which NPCs/mobs stand on it, but their pixels live in the
   * separate Npc/Mob archives. Never leave a name-only fallback unexplained:
   * make the missing archive one click away, or name genuinely missing art. */
  lifeArtActions() {
    if (!this.doc) return [];
    const actions = [];
    for (const spec of [
      { type: 'n', label: 'NPC', archive: 'Npc.wz', open: this.caps?.npcSprites },
      { type: 'm', label: '怪物', archive: 'Mob.wz', open: this.caps?.mobSprites },
    ]) {
      const life = this.doc.life.filter((entry) => (entry.type || '').toLowerCase() === spec.type);
      if (!life.length) continue;
      const missing = life.filter((entry) => !entry.art || this.doc.art?.[entry.art]?.missing).length;
      if (!missing) continue;

      if (!spec.open) {
        actions.push(el('button', {
          class: 'btn',
          'data-tip': `${missing} 个 ${spec.label} 精灵图${missing === 1 ? '' : ''}无法绘制,因为 ` +
            `${spec.archive} 未打开。名称和位置来自地图;像素来自 ${spec.archive}。`,
          onclick: () => this.app.openFilePicker(),
        }, icon('folderOpen', { size: 14 }), `打开 ${spec.archive} 查看精灵图`));
      } else {
        actions.push(el('span', {
          class: 'me-chip',
          'data-tip': `${spec.archive} 已打开,但引用的 ${missing} 个 ${spec.label} ` +
            `精灵图${missing === 1 ? '' : ''}中没有可绘制的站立/待机状态。`,
          text: `${missing} 个 ${spec.label} 精灵图${missing === 1 ? '' : ''}不可用`,
        }));
      }
    }
    return actions;
  }

  animToggle() {
    const d = this.doc;
    if (!d || !this.view) return null;
    const animArt = this.view.animatedArtCount();
    const movingBacks = d.backs.filter((b) => b.type >= 4 && b.type <= 7).length;
    const spine = d.backs.filter((b) => b.spine).length
      + d.layers.reduce((n, l) => n + l.objs.filter((o) => o.spine).length, 0);
    if (!animArt && !movingBacks) return null;

    const playing = this.view.anim.playing;
    const parts = [];
    if (animArt) parts.push(`${animArt} 个动画素材${animArt === 1 ? '' : ''},按各自帧延迟播放`);
    if (movingBacks) parts.push(`${movingBacks} 个滚动背景${movingBacks === 1 ? '' : ''}`);
    let tip = `${playing ? '暂停' : '播放'}: ${parts.join(' 和 ')}。暂停时显示第 0 帧。`;
    if (spine) tip += ` ${spine} 个 Spine 骨骼条目,保持静态并带徽标 — 骨骼不是帧列表。`;

    return el('button', {
      class: `btn${playing ? ' btn-primary' : ''}`,
      'data-tip': tip,
      onclick: () => {
        this.view.setPlaying(!this.view.anim.playing);
        this.renderToolbar();
      },
    }, icon(playing ? 'pause' : 'play', { size: 14 }), playing ? '暂停' : '播放');
  }

  /* ============================================================ history */

  async toggleHistory(button) {
    if (this.histPop) { this.closeHistory(); return; }
    let history;
    try {
      history = await get(`/api/mapedit/history?path=${q(this.doc.path)}`);
    } catch (err) { toastError(err, '历史记录'); return; }

    const pop = el('div', { class: 'me-hist-pop' });
    pop.append(el('h5', { text: `撤销 — ${history.undo.length}` }));
    if (!history.undo.length) pop.append(el('p', { class: 'muted', text: '没有可撤销的内容。' }));
    history.undo.slice(0, 30).forEach((label, i) => {
      pop.append(el('div', { class: 'me-hist-row', text: label,
        'data-tip': i === 0 ? 'Ctrl+Z 下一步会撤销此操作' : undefined }));
    });
    if (history.redo.length) {
      pop.append(el('h5', { text: `重做 — ${history.redo.length}` }));
      history.redo.slice(0, 10).forEach((label) => {
        pop.append(el('div', { class: 'me-hist-row me-hist-redo', text: label }));
      });
    }
    const rect = button.getBoundingClientRect();
    pop.style.top = `${rect.bottom + 4}px`;
    pop.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    document.body.append(pop);
    this.histPop = pop;
    motionIn(pop, { timeout: 220 });
    const close = (e) => {
      if (!pop.contains(e.target) && e.target !== button) this.closeHistory();
    };
    this._histClose = close;
    setTimeout(() => document.addEventListener('pointerdown', close), 0);
  }

  closeHistory() {
    if (this.histPop) {
      const pop = this.histPop;
      this.histPop = null;
      document.removeEventListener('pointerdown', this._histClose);
      motionOut(pop, { remove: true, timeout: 160 });
    }
  }

  /* ============================================================ picker */

  openPicker() {
    const list = el('div', { class: 'me-picker-list' });
    const note = el('p', { class: 'muted', text: '' });
    const input = el('input', {
      class: 'field-input', type: 'search', placeholder: '地图 ID 或名称 — 例如 100000000 或 Henesys',
      autocomplete: 'off',
    });

    let closeModal = null;
    const load = async () => {
      const query = input.value.trim();
      try {
        const result = await get(`/api/mapedit/maps?q=${q(query)}&limit=200`);
        clear(list);
        note.textContent = result.truncated
          ? `显示 ${result.maps.length} / ${fmt.format(result.total)} — 请缩小搜索范围。`
          : `${fmt.format(result.total)} 张地图${result.total === 1 ? '' : ''}。`;
        for (const row of result.maps) {
          list.append(el('button', { class: 'me-picker-row', onclick: () => {
            closeModal?.();
            this.openMap(row.path);
          } },
            el('span', { class: 'num me-picker-id', text: String(row.id).padStart(9, '0') }),
            el('span', { class: 'me-picker-name', text: row.name ?? '(String.wz 中无名称)' }),
            el('span', { class: 'muted', text: row.source })));
        }
        if (!result.maps.length) list.append(el('p', { class: 'muted', text: '无匹配结果。' }));
      } catch (err) {
        toastError(err, '地图列表');
      }
    };
    input.addEventListener('input', debounce(load, 250));

    modal({
      title: '打开地图',
      subtitle: this.caps.names
        ? '名称来自 String.wz — 这才是真正正确的来源。'
        : 'String.wz 未打开,因此地图仅显示 ID。',
      body: el('div', { class: 'me-picker' }, input, note, list),
      actions: [{ label: '取消' }],
      width: '560px',
      onOpen: (dialog) => {
        closeModal = () => dialog.close();
        input.focus();
        load();
      },
    });
  }

  /* ============================================================ document */

  async openMap(path) {
    this.hideBanner();
    try {
      const doc = await post('/api/mapedit/open', { path });
      this.adoptDoc(doc, { fit: true });
      if (doc.link) {
        this.showNotice(
          `此地图是链接存根 — info/link 指向 ${doc.link}。您看到的是存根本身携带的 ` +
          '内容(传送门、刷新点、区域),这些真实存在且会被保留;' +
          '几何数据位于目标地图中。');
      } else if (doc.boundsComputed) {
        this.showNotice('此地图没有 VR 边界;视口是根据其几何数据计算的。');
      }
      this.canvasWrap.focus();
    } catch (err) {
      this.doc = null;
      this.renderToolbar();
      this.showRefusal(err.message);
    }
  }

  adoptDoc(doc, { fit = false } = {}) {
    this.doc = doc;
    if (!this.portalIconsLoaded) {
      this.portalIconsLoaded = true;
      get('/api/mapedit/portal-icons')
        .then((icons) => this.view.setPortalIcons(icons))
        .catch(() => { /* markers fall back to dots */ });
    }
    const cam = this.view.cam && !fit ? { ...this.view.cam } : null;
    this.floatManual = null;
    this.view.setDoc(doc);
    if (cam) this.view.cam = cam;
    this.view.invalidate();
    this.setStatus('悬停显示所指内容 · 单击选择 · 拖动移动 · 空格拖动平移 · ? 查看全部按键');
    this.reselect();
    this.renderToolbar();
    this.renderSide();
    this.renderFloat();
    this.renderInspector();
    this.refreshUnsaved();
  }

  async refetchDoc() {
    if (!this.doc) return;
    try {
      const doc = await get(`/api/mapedit/doc?path=${q(this.doc.path)}`);
      this.adoptDoc(doc);
    } catch (err) {
      toastError(err, '地图文档');
    }
  }

  pools() {
    return {
      tile: this.doc.layers.flatMap((l) => l.tiles),
      obj: this.doc.layers.flatMap((l) => l.objs),
      foothold: this.doc.footholds,
      portal: this.doc.portals,
      life: this.doc.life,
      reactor: this.doc.reactors,
      ladder: this.doc.ladders,
      rect: this.doc.rects ?? [],
      back: this.doc.backs,
    };
  }

  /** Finds an entry (any kind) again after a re-fetch, by address. */
  findByAddr(addr) {
    const pools = this.pools();
    for (const [kind, pool] of Object.entries(pools)) {
      const entry = pool.find((e) => sameAddr(e.addr, addr));
      if (entry) return { kind, entry };
    }
    return null;
  }

  reselect() {
    if (!this.doc) { this.selection = []; return; }
    const kept = [];
    for (const sel of this.selection) {
      const addr = sel.entry?.addr;
      if (!addr) continue;
      const pools = this.pools();
      const entry = (pools[sel.kind] ?? []).find((e) => sameAddr(e.addr, addr));
      if (entry) kept.push({ ...sel, entry, item: undefined });
    }
    this.selection = kept;
    this.view.select(this.selection);
  }

  selectAddrs(addrs) {
    if (!this.doc || !addrs?.length) return;
    const picked = [];
    for (const addr of addrs) {
      const found = this.findByAddr(addr);
      if (found) picked.push(found);
    }
    this.selection = picked;
    this.view.select(this.selection);
    this.renderFloat();
    this.renderInspector();
  }

  /* ============================================================ banners */

  showRefusal(reason) {
    clear(this.banner);
    this.banner.append(el('div', { class: 'me-banner-card me-refusal' },
      el('h3', {}, icon('alert', { size: 16 }), ' 此地图被拒绝,未打开'),
      el('p', { text: reason }),
      el('p', { class: 'muted', text:
        '编辑器只打开能够逐字节原样写回的地图。强行打开此地图,只会在无人要求改动的地方保存出差异。' }),
      el('button', { class: 'btn', onclick: () => this.openPicker() }, '打开另一张地图')));
    motionIn(this.banner, { timeout: 240 });
  }

  showNotice(text) {
    clear(this.banner);
    const card = el('div', { class: 'me-banner-card me-notice' },
      el('p', { text }),
      el('button', { class: 'btn btn-ghost', onclick: () => this.hideBanner() }, '关闭'));
    this.banner.append(card);
    motionIn(this.banner, { timeout: 240 });
  }

  hideBanner() {
    if (this.banner.hidden) return;
    motionOut(this.banner, { hide: true, timeout: 180 }).then((closed) => {
      if (closed && this.banner.hidden) clear(this.banner);
    });
  }

  /* ================================================ rail, dock, on-canvas */

  /** Everything panel-shaped, re-rendered to match this.ui and the doc. */
  renderSide() {
    this.renderOverlayStrip();
    this.renderZoomCtl();
    this.applyPanels();
  }

  renderRail() {
    clear(this.rail);
    const d = this.doc;
    const btn = (name, label, tip, key) => el('button', {
      class: `me-rail-btn${this.ui[name] ? ' active' : ''}`,
      'data-tip': `${tip} (${key})`,
      'aria-label': `${tip} (${key})`,
      'aria-pressed': this.ui[name] ? 'true' : 'false',
      disabled: d ? null : 'disabled',
      onclick: () => this.togglePanel(name),
    }, el('span', { class: 'me-rail-ic' }, label));
    this.rail.append(
      btn('pal', icon('image', { size: 17 }), '调色板 — 放置图块、对象、怪物…', 'P'),
      btn('layers', icon('layers', { size: 17 }), '图层', 'L'),
      btn('inspector', icon('info', { size: 17 }), '所选内容的原始检查器', 'I'),
      btn('minimap', icon('search', { size: 17 }), '小地图', 'M'),
      el('span', { class: 'me-rail-spacer' }),
      el('button', { class: 'me-rail-btn', 'data-tip': '按键 — 编辑器监听的全部按键 (?)',
        'aria-label': '地图编辑器键盘快捷键',
        onclick: () => this.showKeysHelp() }, el('span', { class: 'me-rail-ic', text: '?' })));
  }

  /** The layer dock: compact, eyes first, numbers kept quiet. */
  renderDock() {
    clear(this.dock);
    const d = this.doc;
    if (!d) return;
    this.dock.append(el('div', { class: 'me-dock-head' },
      el('h4', { text: '图层' }),
      el('button', {
        class: 'btn btn-ghost btn-icon me-dock-close', 'data-tip': '折叠 (L)',
        'aria-label': '折叠图层', onclick: () => this.togglePanel('layers', false),
      }, icon('close', { size: 13 }))));
    const layers = el('div', { class: 'me-layer-list' });
    for (const layer of d.layers) {
      const visible = this.view.layerVisible.get(layer.index) !== false;
      layers.append(el('div', { class: 'me-layer-row' },
        el('button', {
          class: 'me-eye', 'aria-pressed': visible ? 'true' : 'false',
          'aria-label': `${visible ? '隐藏' : '显示'} 图层 ${layer.index}`,
          'data-tip': visible ? '隐藏图层' : '显示图层',
          onclick: (e) => {
            const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
            e.currentTarget.setAttribute('aria-pressed', on ? 'true' : 'false');
            e.currentTarget.setAttribute('aria-label', `${on ? '隐藏' : '显示'} 图层 ${layer.index}`);
            e.currentTarget.dataset.tip = on ? '隐藏图层' : '显示图层';
            this.view.setLayerVisible(layer.index, on);
          },
        }, icon('eye', { size: 15 })),
        el('span', { class: 'me-layer-name', text: `图层 ${layer.index}` }),
        layer.ts ? el('span', {
          class: 'me-chip',
          'data-tip': '整个图层的图块素材集 — tS 按图层设置,因此更改它会为该图层上的所有图块重新换肤。',
          text: layer.ts + (layer.tsMag ? ` ×${layer.tsMag}` : ''),
        }) : null,
        el('span', { class: 'muted num me-layer-counts', text:
          `${layer.tiles.length ? `${fmt.format(layer.tiles.length)}t` : ''}` +
          `${layer.tiles.length && layer.objs.length ? ' · ' : ''}` +
          `${layer.objs.length ? `${fmt.format(layer.objs.length)}o` : ''}` }),
        layer.layerBackCount ? el('span', {
          class: 'me-chip', text: `${layer.layerBackCount} 个背景`,
          'data-tip': '此图层自带一个背景列表 — 一种实测到的异常情况 ' +
            '(954090400)。与其他内容一同渲染,保存时保留。',
        }) : null));
    }
    if (!d.layers.length)
      layers.append(el('p', { class: 'muted', text: d.link ? '链接存根没有自己的图层。' : '无图层。' }));
    this.dock.append(layers);
  }

  /** Overlay toggles as an icon strip on the canvas — progressive disclosure
   *  instead of a checkbox column. */
  renderOverlayStrip() {
    clear(this.overlayStrip);
    const d = this.doc;
    if (!d) return;
    const defs = [
      ['back', 'BG', `背景 (${d.backs.length})`],
      ['foothold', 'FH', `立足点 (${fmt.format(d.footholds.length)})`],
      ['ladder', 'LD', `梯子和绳子 (${d.ladders.length})`],
      ['portal', 'PT', `传送门 (${d.portals.length})`],
      ['life', 'NPC', `生物刷新点 (${d.life.length})`],
      ['reactor', 'RC', `反应器 (${d.reactors.length})`],
      ['rect', 'ZN', `区域 (${(d.rects ?? []).length})`],
      ['vr', 'VR', d.boundsComputed ? '边界 (已计算)' : 'VR 边界'],
    ];
    for (const [key, label, tip] of defs) {
      this.overlayStrip.append(el('button', {
        class: 'me-ov-btn', 'aria-pressed': this.view.overlays[key] ? 'true' : 'false',
        'data-tip': `${tip} — 点击${this.view.overlays[key] ? '隐藏' : '显示'}`,
        onclick: (e) => {
          const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
          e.currentTarget.setAttribute('aria-pressed', on ? 'true' : 'false');
          this.view.setOverlay(key, on);
          this.renderOverlayStrip();
        },
      }, label));
    }
  }

  /** Zoom cluster in the canvas corner: −  %  +  ·  fit  1:1 */
  renderZoomCtl() {
    clear(this.zoomCtl);
    if (!this.doc) return;
    this.zoomLabel = el('button', { class: 'me-zoom-pct num', 'data-tip': '点击 = 100%',
      'aria-label': '将缩放重置为 100%',
      onclick: () => this.view.zoomTo(1) }, '100%');
    this.zoomCtl.append(
      el('button', { class: 'me-zoom-btn', 'data-tip': '缩小 (−)', 'aria-label': '缩小',
        onclick: () => this.view.zoomBy(1 / 1.25) }, icon('zoomOut', { size: 14 })),
      this.zoomLabel,
      el('button', { class: 'me-zoom-btn', 'data-tip': '放大 (+)', 'aria-label': '放大',
        onclick: () => this.view.zoomBy(1.25) }, icon('zoomIn', { size: 14 })),
      el('button', { class: 'me-zoom-btn me-zoom-fit', 'data-tip': '适配整张地图 (0、Home、双击空格)',
        'aria-label': '适配整张地图',
        onclick: () => { this.view.fitToBounds(); this.view.invalidate(); } }, '⛶'));
    this.updateZoomLabel();
  }

  updateZoomLabel() {
    if (this.zoomLabel && this.view) {
      const percent = Math.round(this.view.cam.scale * 100);
      this.zoomLabel.textContent = `${percent}%`;
      this.zoomLabel.setAttribute('aria-label', `将缩放从 ${percent} 重置为 100%`);
    }
  }

  /* ------------------------------------------------ minimap: click to jump */

  renderMinimapBox() {
    clear(this.minimapBox);
    const d = this.doc;
    if (!d) return;
    this.mmCanvas = el('canvas', { class: 'me-mm-canvas' });
    this.minimapBox.append(this.mmCanvas);
    this.mmImage = null;
    this.mmMap = null;   // world<->mini transform, set by drawMinimap

    if (d.miniMap?.canvasPath) {
      const img = new Image();
      img.onload = () => { this.mmImage = img; this.drawMinimap(); };
      img.onerror = () => this.drawMinimap();
      img.src = `/api/canvas?path=${q(d.miniMap.canvasPath)}&v=me`;
    }

    const jump = (e) => {
      const m = this.mmMap;
      if (!m) return;
      const rect = this.mmCanvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (this.mmCanvas.width / rect.width);
      const py = (e.clientY - rect.top) * (this.mmCanvas.height / rect.height);
      this.view.centerOn(m.wx0 + (px - m.ox) / m.k, m.wy0 + (py - m.oy) / m.k);
    };
    let down = false;
    this.mmCanvas.addEventListener('pointerdown', (e) => {
      down = true;
      this.mmCanvas.setPointerCapture(e.pointerId);
      jump(e);
    });
    this.mmCanvas.addEventListener('pointermove', (e) => { if (down) jump(e); });
    this.mmCanvas.addEventListener('pointerup', () => { down = false; });
    this.drawMinimap();
  }

  /** The minimap picture + the viewport rectangle. Redrawn on every camera
   *  change — it is a canvas blit, cheap. */
  drawMinimap() {
    const c = this.mmCanvas;
    const d = this.doc;
    if (!c || !d) return;
    const W = 208; const H = 140;
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#141a24';
    g.fillRect(0, 0, W, H);

    // World rect the minimap stands for.
    let wx0; let wy0; let ww; let wh;
    const mm = d.miniMap;
    if (this.mmImage && mm?.width && mm?.height) {
      wx0 = -(mm.centerX ?? 0);
      wy0 = -(mm.centerY ?? 0);
      ww = Number(mm.width);
      wh = Number(mm.height);
    } else if (d.bounds) {
      wx0 = d.bounds.left; wy0 = d.bounds.top;
      ww = Math.max(1, d.bounds.right - d.bounds.left);
      wh = Math.max(1, d.bounds.bottom - d.bounds.top);
    } else {
      this.mmMap = null;
      g.fillStyle = 'rgba(255,255,255,0.4)';
      g.font = '11px system-ui';
      g.fillText('无小地图', 8, 20);
      return;
    }
    const k = Math.min((W - 8) / ww, (H - 8) / wh);
    const ox = (W - ww * k) / 2;
    const oy = (H - wh * k) / 2;
    this.mmMap = { wx0, wy0, k, ox, oy };

    if (this.mmImage) {
      g.imageSmoothingEnabled = true;
      g.drawImage(this.mmImage, ox, oy, ww * k, wh * k);
    } else {
      // No minimap picture: a foothold sketch is the honest layout view.
      g.strokeStyle = '#61d872';
      g.lineWidth = 1;
      g.beginPath();
      for (const fh of d.footholds) {
        g.moveTo(ox + (fh.x1 - wx0) * k, oy + (fh.y1 - wy0) * k);
        g.lineTo(ox + (fh.x2 - wx0) * k, oy + (fh.y2 - wy0) * k);
      }
      g.stroke();
    }

    // The viewport, as a draggable-feeling rectangle.
    const vp = this.view.viewportWorld();
    const rx = ox + (vp.x0 - wx0) * k;
    const ry = oy + (vp.y0 - wy0) * k;
    g.strokeStyle = '#7fd0ff';
    g.lineWidth = 1.5;
    g.strokeRect(rx, ry, (vp.x1 - vp.x0) * k, (vp.y1 - vp.y0) * k);
  }

  updateMinimapView() {
    if (!this.minimapBox.hidden) this.drawMinimap();
  }

  /* ============================================================ palette */

  mem() {
    const p = this.palette;
    if (!p.mem[p.kind]) p.mem[p.kind] = { set: null, entries: null, query: '', layer: 0 };
    return p.mem[p.kind];
  }

  /** One set in the set grid: its representative picture with its name under
   *  it. A set with no resolvable art says so on its face. */
  setCell(set, before) {
    const face = el('div', { class: 'me-pal-setface' });
    if (set.thumbPath) {
      const img = el('img', { src: `/api/mapedit/thumb?path=${q(set.thumbPath)}`, loading: 'lazy', alt: '' });
      img.addEventListener('error', () => {
        img.remove();
        face.append(el('span', { class: 'me-pal-brokenmark', text: '✕',
          'data-tip': `${set.name} — 其代表美术未能解码。` }));
      });
      face.append(img);
    } else {
      face.append(el('span', { class: 'me-pal-brokenmark muted', text: '∅',
        'data-tip': `${set.name} — 该素材集中没有可绘制的美术。` }));
    }
    return el('button', {
      class: 'me-pal-setcell', 'data-tip': `${set.name} — ${set.source}`,
      onclick: () => { before?.(); this.openPaletteSet(set); },
    }, face, el('span', { class: 'me-pal-setname', text: set.name }));
  }

  /** Clears and re-renders the palette drawer's body. */
  renderPaletteBody() {
    if (!this.doc) return;
    const scroll = this.side.scrollTop;
    clear(this.side);
    this.renderPalette();
    this.side.scrollTop = scroll;
  }

  renderPalette() {
    const p = this.palette;

    // Search everything: one box across every kind at once. The input stays
    // mounted while the content below it changes. Rebuilding the whole drawer
    // here used to destroy focus after the first debounced keystroke; the next
    // letter then became a map shortcut (P opened/closed the palette, arrows
    // panned, and so on) instead of part of the query.
    const global = el('input', {
      class: 'field-input me-pal-global', type: 'search',
      'aria-label': '搜索调色板目录',
      placeholder: '搜索全部 — 素材集、怪物、NPC、反应器…', value: p.global,
    });
    const refresh = debounce(() => {
      if (!global.isConnected || !this.ui.pal) return;
      while (global.nextSibling) global.nextSibling.remove();
      const query = p.global.trim();
      if (query.length >= 2) this.renderGlobalSearch(query);
      else this.renderPaletteCatalog();
    }, 250);
    global.addEventListener('input', () => {
      p.global = global.value;
      refresh();
    });
    this.side.append(global);

    if (p.global.trim().length >= 2) {
      this.renderGlobalSearch(p.global.trim());
      return;
    }

    this.renderPaletteCatalog();
  }

  /** The ordinary kind browser below the persistent global-search field. */
  renderPaletteCatalog() {
    const p = this.palette;

    const kinds = [
      ['Tile', '图块'], ['Obj', '对象'], ['Back', '背景'],
      ['mob', '怪物'], ['npc', 'NPC'], ['reactor', '反应器'], ['portal', '传送门'],
      ['fh', '立足点'], ['ladder', '梯子'],
    ];
    const chips = el('div', { class: 'me-pal-kinds' });
    for (const [key, label] of kinds) {
      chips.append(el('button', {
        class: `me-chip me-pal-kind${p.kind === key ? ' active' : ''}`, text: label,
        'aria-pressed': p.kind === key ? 'true' : 'false',
        onclick: () => { p.kind = key; this.renderPaletteBody(); },
      }));
    }
    this.side.append(chips);

    if (this.placing) {
      this.side.append(el('div', { class: 'me-pal-armed' },
        el('span', { text: `放置中: ${this.placing.label}` }),
        el('button', { class: 'btn btn-ghost', text: 'Esc', onclick: () => this.cancelPlacement() })));
    }

    this.renderRecents();

    if (p.kind === 'Tile' || p.kind === 'Obj' || p.kind === 'Back') this.renderArtPalette();
    else if (p.kind === 'mob' || p.kind === 'npc') this.renderLifePalette();
    else if (p.kind === 'reactor') this.renderReactorPalette();
    else if (p.kind === 'portal') this.renderPortalPalette();
    else if (p.kind === 'fh') this.renderFootholdTools();
    else if (p.kind === 'ladder') this.renderLadderTools();
  }

  /* -------- recents: the last assets used, pictures first */

  renderRecents() {
    const rows = this.recents[this.palette.kind];
    if (!rows?.length) return;
    this.side.append(el('h5', { class: 'me-pal-group', text: '最近使用' }));
    const grid = el('div', { class: 'me-pal-grid' });
    for (const row of rows) {
      const cell = this.paletteCell({
        thumbPath: row.thumb, label: row.label, frames: row.frames,
        onclick: () => this.armRecent(row),
        previewLeaf: row.previewLeaf,
      });
      grid.append(cell);
    }
    this.side.append(grid);
  }

  pushRecent(kind, row) {
    const list = this.recents[kind] ?? [];
    const without = list.filter((r) => r.label !== row.label);
    without.unshift(row);
    this.recents[kind] = without.slice(0, RECENTS_MAX);
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(this.recents)); } catch { /* full */ }
  }

  armRecent(row) {
    if (row.arm.kind === 'life') {
      this.armLife(row.arm.lifeType, row.arm.id, row.label, row.thumb, { silent: true });
    } else if (row.arm.kind === 'reactor') {
      this.armReactor(row.arm.id, row.thumb, { silent: true });
    } else {
      this.armArt(row.arm.paletteKind, row.arm.set, row.arm.setPath, row.arm.entry, { silent: true });
    }
  }

  /* -------- one palette cell: picture at rest, badge for animation,
     placeholder while loading, broken marker on failure, flyout on hover */

  paletteCell({ thumbPath, label, caption, frames, hasFoothold, onclick, previewLeaf, w, h }) {
    const cell = el('button', {
      class: `me-pal-cell${caption ? ' me-pal-cell-tall' : ''}`,
      onclick, 'data-tip': label, 'aria-label': label,
    });
    if (thumbPath) {
      const img = el('img', {
        src: `/api/mapedit/thumb?path=${q(thumbPath)}`, loading: 'lazy', alt: '',
      });
      img.addEventListener('error', () => {
        img.remove();
        cell.classList.add('me-pal-broken');
        cell.append(el('span', { class: 'me-pal-brokenmark', text: '✕',
          'data-tip': `${label} — 美术未能解码;引用真实存在,但像素未能渲染。` }));
      });
      cell.append(img);
    } else {
      cell.classList.add('me-pal-broken');
      cell.append(el('span', { class: 'muted', text: '∅',
        'data-tip': `${label} — 此处无可绘制的美术。` }));
    }
    if (frames > 1) cell.append(el('span', { class: 'me-pal-frames', text: `${frames}f` }));
    if (hasFoothold) cell.append(el('span', { class: 'me-pal-fh', text: 'fh' }));
    if (caption) cell.append(el('span', { class: 'me-pal-caption', text: caption }));
    this.attachFlyout(cell, { label, thumbPath, frames, previewLeaf, w, h });
    return cell;
  }

  /* -------- hover flyout: bigger, animated where animated */

  attachFlyout(cell, info) {
    cell.addEventListener('mouseenter', () => {
      clearTimeout(this.flyoutCloseTimer);
      clearTimeout(this.flyoutOpenTimer);
      const warm = Date.now() - this.flyoutLastClosedAt < 500;
      this.flyoutOpenTimer = setTimeout(() => this.showFlyout(cell, info), warm ? 75 : 180);
    });
    cell.addEventListener('mouseleave', () => {
      clearTimeout(this.flyoutOpenTimer);
      clearTimeout(this.flyoutCloseTimer);
      this.flyoutCloseTimer = setTimeout(() => this.hideFlyout(), 100);
    });
  }

  hideFlyout({ immediate = false } = {}) {
    clearTimeout(this.flyoutOpenTimer);
    clearTimeout(this.flyoutCloseTimer);
    if (this.flyout) {
      const fly = this.flyout;
      fly.stop?.();
      this.flyout = null;
      this.flyoutLastClosedAt = Date.now();
      if (immediate) fly.remove();
      else motionOut(fly, { remove: true, timeout: 150 });
    }
  }

  async showFlyout(cell, info) {
    this.hideFlyout({ immediate: true });
    if (!info.thumbPath && !info.previewLeaf) return;
    const fly = el('div', { class: 'me-flyout' });
    fly.append(el('div', { class: 'me-flyout-title', text: info.label ?? '' }));
    const stage = el('div', { class: 'me-flyout-stage' });
    fly.append(stage);
    const meta = el('div', { class: 'me-flyout-meta muted' });
    fly.append(meta);

    const rect = cell.getBoundingClientRect();
    fly.style.left = `${Math.min(rect.right + 8, window.innerWidth - 280)}px`;
    fly.style.top = `${Math.min(rect.top, window.innerHeight - 300)}px`;
    document.body.append(fly);
    this.flyout = fly;
    motionIn(fly, { timeout: 200 });

    // Animated: fetch the composed frame list once, play it on the flyout's
    // own clock. Still: the full-size picture. Either way the canvas thread
    // never blocks — everything here is async.
    let art = null;
    if (info.previewLeaf && (info.frames ?? 1) > 1) {
      art = this.previewCache.get(info.previewLeaf);
      if (!art) {
        try {
          art = await get(`/api/mapedit/palette/preview?path=${q(info.previewLeaf)}`);
          this.previewCache.set(info.previewLeaf, art);
        } catch { art = null; }
      }
    }
    if (this.flyout !== fly) return; // pointer moved on

    if (art?.frames?.length > 1) {
      const canvas = el('canvas', { class: 'me-flyout-canvas' });
      const scale = Math.min(1, 220 / Math.max(art.w, 1), 220 / Math.max(art.h, 1));
      canvas.width = Math.max(1, Math.round(art.w * scale));
      canvas.height = Math.max(1, Math.round(art.h * scale));
      stage.append(canvas);
      meta.textContent = `${art.w}×${art.h} · ${art.frames.length} 帧 · ${art.totalMs} ms 循环`;

      const images = art.frames.map((f) => {
        const img = new Image();
        img.src = `/api/canvas?path=${q(f.path)}&v=me`;
        return img;
      });
      const g = canvas.getContext('2d');
      const start = performance.now();
      let raf = 0;
      const tick = () => {
        let t = (performance.now() - start) % Math.max(1, art.totalMs);
        let index = 0;
        for (let i = 0; i < art.frames.length; i++) {
          t -= art.frames[i].delay;
          if (t < 0) { index = i; break; }
        }
        const frame = art.frames[index];
        const img = images[index];
        g.clearRect(0, 0, canvas.width, canvas.height);
        if (img.complete && img.naturalWidth) {
          g.drawImage(img, frame.dx * scale, frame.dy * scale,
            frame.w * scale, frame.h * scale);
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      fly.stop = () => cancelAnimationFrame(raf);
    } else if (info.thumbPath) {
      const img = el('img', { src: `/api/mapedit/thumb?path=${q(info.thumbPath)}`, alt: '' });
      stage.append(img);
      img.addEventListener('load', () => {
        meta.textContent = `${img.naturalWidth}×${img.naturalHeight}`;
      });
    }
  }

  /* -------- cross-kind instant search */

  async ensureAllSets() {
    if (this.allSets) return this.allSets;
    const [tile, obj, back] = await Promise.all([
      get('/api/mapedit/palette/sets?kind=Tile').catch(() => []),
      get('/api/mapedit/palette/sets?kind=Obj').catch(() => []),
      get('/api/mapedit/palette/sets?kind=Back').catch(() => []),
    ]);
    this.allSets = { Tile: tile, Obj: obj, Back: back };
    return this.allSets;
  }

  renderGlobalSearch(query) {
    const host = el('div', { class: 'me-pal-globalresults' });
    this.side.append(host);
    host.append(el('p', { class: 'muted', text: '搜索中…' }));
    const stamp = query;
    (async () => {
      const [sets, mobs, npcs, reactors] = await Promise.all([
        this.ensureAllSets(),
        get(`/api/mapedit/palette/life?q=${q(query)}&type=m&limit=12`).catch(() => null),
        get(`/api/mapedit/palette/life?q=${q(query)}&type=n&limit=12`).catch(() => null),
        get(`/api/mapedit/palette/reactors?q=${q(query)}&limit=12`).catch(() => null),
      ]);
      if (this.palette.global.trim() !== stamp || !this.ui.pal) return;
      clear(host);
      const lower = query.toLowerCase();
      let any = false;

      for (const kind of ['Tile', 'Obj', 'Back']) {
        const matches = (sets[kind] ?? []).filter((s) => s.name.toLowerCase().includes(lower)).slice(0, 12);
        if (!matches.length) continue;
        any = true;
        host.append(el('h5', { class: 'me-pal-group', text: `${kind} 素材集` }));
        const setGrid = el('div', { class: 'me-pal-setgrid' });
        for (const set of matches) {
          setGrid.append(this.setCell(set, () => {
            this.palette.global = '';
            this.palette.kind = kind;
          }));
        }
        host.append(setGrid);
      }

      for (const [label, result, type] of [['怪物', mobs, 'm'], ['NPC', npcs, 'n']]) {
        if (!result?.rows?.length) continue;
        any = true;
        host.append(el('h5', { class: 'me-pal-group', text: label }));
        const grid = el('div', { class: 'me-pal-lifegrid' });
        for (const row of result.rows) grid.append(this.lifeCell(row, type));
        host.append(grid);
      }

      if (reactors?.rows?.length) {
        any = true;
        host.append(el('h5', { class: 'me-pal-group', text: '反应器' }));
        const grid = el('div', { class: 'me-pal-grid' });
        for (const row of reactors.rows) {
          grid.append(this.paletteCell({
            thumbPath: row.iconPath, label: `反应器 ${row.id}`, caption: String(row.id),
            previewLeaf: row.iconPath?.replace(/\/0$/, ''),
            frames: 2, // reactor state 0 often animates; the flyout will know
            onclick: () => this.armReactor(row.id, row.iconPath),
          }));
        }
        host.append(grid);
      }

      if (!any) host.append(el('p', { class: 'muted', text: '任何地方都无匹配。' }));
    })();
  }

  /* -------- art palettes (Tile / Obj / Back) */

  layerPicker() {
    const mem = this.mem();
    const select = el('select', { class: 'field-input me-pal-layer' });
    for (const layer of this.doc.layers) {
      select.append(el('option', {
        value: String(layer.index),
        text: `图层 ${layer.index}${layer.ts ? ` — ${layer.ts}` : ' — 无 tS'}`,
        selected: layer.index === mem.layer ? 'selected' : null,
      }));
    }
    select.addEventListener('change', () => { mem.layer = Number(select.value); });
    return select;
  }

  targetLayer() { return this.mem().layer ?? 0; }

  renderArtPalette() {
    const p = this.palette;
    const mem = this.mem();
    if ((p.kind === 'Tile' || p.kind === 'Obj') && this.doc.layers.length) {
      this.side.append(el('label', { class: 'me-pal-row' },
        el('span', { class: 'muted', text: '图层' }), this.layerPicker()));
    }
    if (p.kind === 'Tile') {
      this.side.append(el('label', { class: 'me-overlay-row' },
        el('input', {
          type: 'checkbox', checked: this.snapTiles ? 'checked' : null,
          onchange: (e) => { this.snapTiles = e.currentTarget.checked; },
        }),
        el('span', {
          text: '吸附到图块网格',
          'data-tip': '将放置吸附到所选图块自身的美术尺寸;目标图层上若已有同一变体,则与之对齐。' +
            '这是放置辅助 — 图块按美术尺寸模块化 — 并非实测的客户端网格。',
        })));
    }

    if (!mem.sets || mem.sets.kind !== p.kind) {
      mem.sets = { kind: p.kind, list: null };
      get(`/api/mapedit/palette/sets?kind=${q(p.kind)}`)
        .then((list) => { mem.sets.list = list; if (this.ui.pal) this.renderPaletteBody(); })
        .catch((err) => toastError(err, '调色板'));
      this.side.append(el('p', { class: 'muted', text: '素材集加载中…' }));
      return;
    }
    if (!mem.sets.list) { this.side.append(el('p', { class: 'muted', text: '素材集加载中…' })); return; }

    if (!mem.set) {
      const input = el('input', {
        class: 'field-input', type: 'search', placeholder: `搜索 ${mem.sets.list.length} 个素材集…`,
        value: mem.query,
      });
      // Sets are pictures too: each cell shows the set's first drawable, so
      // browsing reads as art, not as a list of file names.
      const list = el('div', { class: 'me-pal-setgrid' });
      const renderSets = () => {
        if (!input.isConnected || !list.isConnected) return;
        clear(list);
        const query = mem.query.trim().toLowerCase();
        let shown = 0;
        for (const set of mem.sets.list) {
          if (query && !set.name.toLowerCase().includes(query)) continue;
          if (++shown > 200) {
            list.append(el('p', { class: 'muted', text: '还有更多 — 请缩小搜索范围。' }));
            break;
          }
          list.append(this.setCell(set));
        }
        if (!shown) list.append(el('p', { class: 'muted', text: '没有匹配的素材集。' }));
      };
      const refresh = debounce(renderSets, 120);
      input.addEventListener('input', () => {
        // Keep the search field mounted while its results change. Rebuilding
        // the whole palette here destroyed focus after every letter, sending
        // the next keystroke to the map editor's shortcuts instead.
        mem.query = input.value;
        refresh();
      });
      this.side.append(input, list);
      renderSets();
      return;
    }

    this.side.append(el('div', { class: 'me-pal-row' },
      el('button', { class: 'btn btn-ghost', text: '‹ 素材集', onclick: () => { mem.set = null; mem.entries = null; this.renderPaletteBody(); } }),
      el('strong', { text: mem.set.name })));

    if (!mem.entries) { this.side.append(el('p', { class: 'muted', text: '条目加载中…' })); return; }
    if (mem.entries.truncated) {
      this.side.append(el('p', { class: 'muted', text:
        `显示 ${mem.entries.entries.length} / ${fmt.format(mem.entries.total)} 条。` }));
    }

    const groups = new Map();
    for (const entry of mem.entries.entries) {
      const key = p.kind === 'Tile' ? entry.u
        : p.kind === 'Obj' ? `${entry.l0}/${entry.l1}`
        : entry.ani === 0 ? '静态' : entry.ani === 1 ? '动画' : 'Spine';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    for (const [group, entries] of groups) {
      this.side.append(el('h5', { class: 'me-pal-group', text: group }));
      const grid = el('div', { class: 'me-pal-grid' });
      for (const entry of entries) {
        grid.append(this.paletteCell({
          thumbPath: entry.thumbPath,
          label: this.entryTip(entry),
          frames: entry.frames,
          hasFoothold: entry.hasFoothold,
          previewLeaf: this.entryLeafPath(mem.set, entry),
          onclick: () => this.armArt(p.kind, mem.set.name, mem.set.path, entry),
        }));
      }
      this.side.append(grid);
    }
  }

  entryLeafPath(set, entry) {
    const p = this.palette;
    if (p.kind === 'Obj' || (entry.l0 != null)) {
      const segs = [entry.l0, entry.l1, entry.l2, entry.l3].filter((s) => s != null && s !== '');
      return `${set.path}/${segs.join('/')}`;
    }
    if (p.kind === 'Back' || entry.ani != null) {
      if (entry.u == null && entry.l0 == null) {
        const branch = entry.ani === 1 ? 'ani' : entry.ani === 2 ? 'spine' : 'back';
        return `${set.path}/${branch}/${entry.no}`;
      }
    }
    return `${set.path}/${entry.u}/${entry.no}`;
  }

  entryTip(entry) {
    const p = this.palette;
    const mem = this.mem();
    if (p.kind === 'Tile') return `${mem.set.name}/${entry.u}/${entry.no}${entry.hasFoothold ? ' — 含立足点几何' : ''}`;
    if (p.kind === 'Obj') {
      return `${mem.set.name}/${entry.l0}/${entry.l1}/${entry.l2}${entry.l3 ? `/${entry.l3}` : ''}` +
        `${entry.frames > 1 ? ` — ${entry.frames} 帧` : ''}` +
        `${entry.hasFoothold ? ' — 含立足点几何' : ''}`;
    }
    return `${mem.set.name}/${entry.ani ? 'ani' : 'back'}/${entry.no}`;
  }

  openPaletteSet(set) {
    const mem = this.mem();
    mem.set = set;
    mem.entries = null;
    if (!this.ui.pal) { this.ui.pal = true; this.saveUi(); this.applyPanels(); }
    this.renderPaletteBody();
    get(`/api/mapedit/palette/entries?kind=${q(this.palette.kind)}&path=${q(set.path)}`)
      .then((entries) => { mem.entries = entries; if (this.ui.pal) this.renderPaletteBody(); })
      .catch((err) => { toastError(err, '调色板'); mem.set = null; this.renderPaletteBody(); });
  }

  armArt(paletteKind, setName, setPath, entry, { silent } = {}) {
    if (paletteKind === 'Tile') {
      this.placing = {
        kind: 'tile', set: setName, u: entry.u, no: entry.no,
        label: `图块 ${setName}/${entry.u}/${entry.no}`,
        art: entry,
        getSnap: () => {
          if (!this.snapTiles) return null;
          const layer = this.doc.layers.find((l) => l.index === this.targetLayer());
          const mag = Number(layer?.tsMag ?? 1) || 1;
          const pw = entry.w * mag; const ph = entry.h * mag;
          if (!(pw > 0) || !(ph > 0)) return null;
          const anchor = layer?.tiles.find((t) => t.u === entry.u) ?? layer?.tiles[0];
          return { pw, ph, ax: anchor?.x ?? 0, ay: anchor?.y ?? 0 };
        },
      };
    } else if (paletteKind === 'Obj') {
      this.placing = {
        kind: 'obj', set: setName, l0: entry.l0, l1: entry.l1, l2: entry.l2, l3: entry.l3,
        label: `对象 ${setName}/${entry.l0}/${entry.l1}/${entry.l2}`,
        art: entry,
      };
    } else {
      this.placing = {
        kind: 'back', set: setName, no: entry.no, ani: entry.ani,
        label: `背景 ${setName}/${entry.no}`,
        art: entry, backType: 0, front: 0,
      };
    }
    this.pushRecent(paletteKind, {
      label: this.placing.label,
      thumb: entry.thumbPath,
      frames: entry.frames,
      previewLeaf: setPath ? this.entryLeafPath({ path: setPath, name: setName }, entry) : null,
      arm: { paletteKind, set: setName, setPath, entry },
    });
    this.view.setPlacing(this.placing);
    this.setStatus(`点击地图放置 ${this.placing.label};Esc 取消。幽灵预览会显示确切落点。`);
    if (!silent && this.ui.pal) this.renderPaletteBody();
  }

  /* -------- life palette: a grid of sprites, names under them */

  lifeCell(row, type) {
    return this.paletteCell({
      thumbPath: row.iconPath,
      caption: row.name ?? String(row.id),
      label: `${row.name ?? '(无名称)'} · ${row.id}`,
      frames: 2, // stand animations play in the flyout when they exist
      previewLeaf: row.iconPath?.replace(/\/0$/, ''),
      onclick: () => this.armLife(type, String(row.id), `${type === 'n' ? 'NPC' : '怪物'} ${row.name ?? row.id}`, row.iconPath),
    });
  }

  armLife(type, id, label, iconPath, { silent } = {}) {
    this.placing = { kind: 'life', lifeType: type, id, label };
    this.pushRecent(type === 'n' ? 'npc' : 'mob', {
      label, thumb: iconPath, previewLeaf: iconPath?.replace(/\/0$/, ''), frames: 2,
      arm: { kind: 'life', lifeType: type, id },
    });
    this.view.setPlacing(this.placing);
    this.setStatus(`点击地图放置 ${label} — 它会锚定到点击位置下方的立足点。`);
    if (!silent && this.ui.pal) this.renderPaletteBody();
  }

  renderLifePalette() {
    const p = this.palette;
    const mem = this.mem();
    const type = p.kind === 'npc' ? 'n' : 'm';
    const input = el('input', {
      class: 'field-input', type: 'search',
      placeholder: `按名称或 ID 搜索 ${p.kind === 'npc' ? 'NPC' : '怪物'}…`, value: mem.query ?? '',
    });
    const list = el('div', { class: 'me-pal-lifegrid' });
    const load = async () => {
      mem.query = input.value;
      try {
        const result = await get(`/api/mapedit/palette/life?q=${q(input.value)}&type=${type}&limit=60`);
        clear(list);
        // Missing prerequisites are said out loud, on the palette's face —
        // a silent fallback to a bare name list is how this reads as broken.
        if (!result.namesAvailable) {
          list.append(el('div', { class: 'me-pal-warn', text:
            'String.wz 未打开,因此这里没有可搜索的名称 — 打开客户端的 ' +
            'String.wz(副本)后,这里就会变成可搜索的图片网格。' }));
        }
        if (!result.iconsAvailable) {
          list.append(el('div', { class: 'me-pal-warn', text:
            `${type === 'n' ? 'Npc.wz' : 'Mob.wz'} 未打开,因此这些行没有图片 — ` +
            '打开它(副本)即可查看这里的每个精灵图。' }));
        }
        for (const row of result.rows) list.append(this.lifeCell(row, type));
        if (!result.rows.length && result.namesAvailable) {
          list.append(el('p', { class: 'muted', text: input.value.trim()
            ? '无匹配结果。'
            : `输入名称或 ID — 例如 ${type === 'n' ? '“Maple Administrator”或 9010000' : '“snail”或 100100'} — 匹配项将以精灵图形式出现。` }));
        }
      } catch (err) { toastError(err, '生物调色板'); }
    };
    input.addEventListener('input', debounce(load, 250));
    this.side.append(input, list);
    load();
  }

  armReactor(id, iconPath, { silent } = {}) {
    this.placing = { kind: 'reactor', id, label: `反应器 ${id}` };
    this.pushRecent('reactor', {
      label: `反应器 ${id}`, thumb: iconPath, previewLeaf: iconPath?.replace(/\/0$/, ''), frames: 2,
      arm: { kind: 'reactor', id },
    });
    this.view.setPlacing(this.placing);
    this.setStatus(`点击地图放置反应器 ${id};Esc 取消。`);
    if (!silent && this.ui.pal) this.renderPaletteBody();
  }

  renderReactorPalette() {
    const grid = el('div', { class: 'me-pal-grid' });
    this.side.append(grid);
    get('/api/mapedit/palette/reactors?limit=200').then((result) => {
      if (!result.available) {
        grid.replaceWith(el('div', {},
          el('p', { class: 'muted', text: result.reason ?? 'Reactor.wz 未打开。' }),
          (() => {
            const manual = el('input', { class: 'field-input', placeholder: '输入反应器 ID… 回车后即可放置' });
            manual.addEventListener('keydown', (e) => {
              if (e.key === 'Enter' && manual.value.trim()) this.armReactor(manual.value.trim(), null);
            });
            return manual;
          })()));
        return;
      }
      for (const row of result.rows) {
        grid.append(this.paletteCell({
          thumbPath: row.iconPath, label: `反应器 ${row.id}`, caption: String(row.id), frames: 2,
          previewLeaf: row.iconPath?.replace(/\/0$/, ''),
          onclick: () => this.armReactor(row.id, row.iconPath),
        }));
      }
    }).catch((err) => toastError(err, '反应器调色板'));
  }

  renderPortalPalette() {
    const pnInput = el('input', { class: 'field-input', placeholder: 'pn — 传送门名称 (sp/tp 可重复)' });
    const tnInput = el('input', { class: 'field-input', placeholder: 'tn — 目标传送门名称' });
    const tmInput = el('input', { class: 'field-input num', placeholder: 'tm — 目标地图 ID (999999999 = 无)' });
    this.side.append(
      el('p', { class: 'muted me-pal-note', text:
        '选择图标以准备放置。pt 来自 MapHelper 编辑器表格 — 实测顺序,而非字母顺序。两个相连的传送门:' +
        '先放置一个 pn=a、tn=b 的,再放置一个 pn=b、tn=a 的。' }),
      pnInput, tnInput, tmInput);

    const grid = el('div', { class: 'me-pal-grid' });
    this.side.append(grid);
    const fill = (icons) => {
      for (const row of icons) {
        grid.append(this.paletteCell({
          thumbPath: row.path, label: `pt ${row.pt} — ${row.name}`, caption: row.name,
          onclick: () => {
            this.placing = {
              kind: 'portal', pt: row.pt,
              pn: () => pnInput.value.trim(), tn: () => tnInput.value.trim(),
              tm: () => tmInput.value.trim(),
              label: `传送门 ${row.name} (pt ${row.pt})`,
            };
            this.view.setPlacing(this.placing);
            this.setStatus(`点击地图放置 ${this.placing.label}。`);
            this.renderPaletteBody();
          },
        }));
      }
    };
    if (this.portalIconList) fill(this.portalIconList);
    else {
      get('/api/mapedit/portal-icons').then((icons) => {
        this.portalIconList = icons;
        fill(icons);
      }).catch(() => grid.append(el('p', { class: 'muted', text: 'MapHelper.img 未打开。' })));
    }
  }

  renderFootholdTools() {
    this.side.append(el('label', { class: 'me-pal-row' },
      el('span', { class: 'muted', text: '图层' }), this.layerPicker()));
    this.side.append(
      el('button', { class: 'btn btn-primary me-pal-draw', onclick: () => {
        this.cancelPlacement();
        this.view.beginFootholdDraw(this.targetLayer());
        this.setStatus('点击放置顶点;回车或双击完成链条;Esc 取消。');
      } }, '绘制立足点链'),
      el('p', { class: 'muted me-pal-note', text:
        '顶点会成为 prev/next 相连的立足点,端点重合,形成新组,ID 在本地图内唯一。在画布上:' +
        '双击线段插入顶点,双击空闲链端继续绘制,拖动顶点调整形状 — ' +
        '相连端点一起移动。已有立足点不会被重新连接;分叉保持分叉。' }));
  }

  renderLadderTools() {
    const lSelect = el('select', { class: 'field-input me-pal-layer' },
      el('option', { value: '1', text: '梯子 (l = 1)' }),
      el('option', { value: '0', text: '绳子 (l = 0)' }));
    const uf = el('input', { type: 'checkbox', checked: 'checked' });
    this.side.append(
      el('label', { class: 'me-pal-row' },
        el('span', { class: 'muted', text: '类型' }), lSelect),
      el('label', { class: 'me-overlay-row' }, uf,
        el('span', { text: 'uf — 可从顶端爬出', 'data-tip':
          'uf = 1 时角色可从顶端爬出;0 则不能。' })),
      el('label', { class: 'me-pal-row' },
        el('span', { class: 'muted', text: '页 (图层)' }), this.layerPicker()),
      el('button', { class: 'btn btn-primary me-pal-draw', onclick: () => {
        this.view.cancelFootholdDraw();
        this.placing = {
          kind: 'ladder',
          get l() { return Number(lSelect.value); },
          get uf() { return uf.checked ? 1 : 0; },
          label: '梯子 / 绳子',
        };
        this.view.setPlacing(this.placing);
        this.setStatus('先点击梯子顶端,再点击底端 — 两次点击,同一个 x。Esc 取消。');
        this.renderPaletteBody();
      } }, '放置梯子 / 绳子'),
      el('p', { class: 'muted me-pal-note', text:
        '按采样到的正式版结构与顺序写入 — l、uf、x、y1、y2、page,均为 Int。' +
        '已放置的梯子在画布上可整体拖动或按端点拖动。' }));
  }

  /* ============================================================ placement */

  syncArmedUi() {
    if (this.ui.pal) this.renderPaletteBody();
  }

  cancelPlacement() {
    if (this.placing) {
      this.placing = null;
      this.view.setPlacing(null);
      if (this.ui.pal) this.renderPaletteBody();
    }
    this.view.cancelFootholdDraw();
    this.view.cancelExtend();
    this.renderFloat();
  }

  async commitPlacement(x, y) {
    const arm = this.placing;
    if (!arm || !this.doc) return;
    const body = { path: this.doc.path, kind: arm.kind, x, y };

    if (arm.kind === 'tile' || arm.kind === 'obj') {
      body.layer = this.targetLayer();
      body.set = arm.set;
      if (arm.kind === 'tile') { body.u = arm.u; body.no = arm.no; }
      else { body.l0 = arm.l0; body.l1 = arm.l1; body.l2 = arm.l2; body.l3 = arm.l3; }

      if (arm.kind === 'tile') {
        const layer = this.doc.layers.find((l) => l.index === this.targetLayer());
        if (layer && !layer.ts) {
          const ok = await this.confirmDialog('采用此图块素材集?',
            `图层 ${layer.index} 还没有图块素材集。放置此图块会在图层上写入 tS = '${arm.set}' ` +
            '— 之后该图层的所有图块都将来自此素材集。');
          if (!ok) return;
          body.adoptLayerTs = true;
        } else if (layer && layer.ts !== arm.set) {
          this.offerTsChoices(layer, arm, x, y);
          return;
        }
      }
    } else if (arm.kind === 'back') {
      body.set = arm.set; body.no = arm.no; body.ani = arm.ani;
      body.backType = arm.backType ?? 0; body.front = arm.front ?? 0;
    } else if (arm.kind === 'portal') {
      body.pn = arm.pn(); body.tn = arm.tn(); body.pt = arm.pt;
      const tm = arm.tm();
      if (tm) body.tm = Number(tm);
    } else if (arm.kind === 'life') {
      body.lifeType = arm.lifeType; body.id = arm.id;
    } else if (arm.kind === 'reactor') {
      body.id = arm.id;
    }

    try {
      const result = await post('/api/mapedit/place', body);
      for (const note of result.notes ?? []) toast(note);
      this.applyPlaceResult(result);
      await this.refetchDoc();     // structural: addresses and art may be new
      // Forgiveness: the just-placed thing is selected — a mis-drop drags
      // again immediately. The armed placement stays armed.
      if (result.placed?.length) this.selectAddrs([result.placed]);
    } catch (err) {
      toastError(err, '放置');
    }
  }

  /** Two-click ladder placement: the server writes the sampled shipping
   *  shape (l, uf, x, y1, y2, page) and swaps the ys if the bottom came first. */
  async commitLadder(x, y1, y2) {
    const arm = this.placing;
    if (!arm || arm.kind !== 'ladder' || !this.doc) return;
    try {
      const result = await post('/api/mapedit/place', {
        path: this.doc.path, kind: 'ladderRope',
        x, y: y1, y2, l: arm.l, uf: arm.uf, layer: this.targetLayer(),
      });
      for (const note of result.notes ?? []) toast(note);
      this.applyPlaceResult(result);
      await this.refetchDoc();
      if (result.placed?.length) this.selectAddrs([result.placed]);
    } catch (err) {
      toastError(err, '梯子');
    }
  }

  applyPlaceResult(result) {
    if (this.doc) {
      this.doc.undoDepth = result.undoDepth;
      this.doc.redoDepth = result.redoDepth;
      this.doc.dirty = result.dirty;
    }
    this.renderToolbar();
    this.refreshUnsaved();
  }

  offerTsChoices(layer, arm, x, y) {
    const carriers = this.doc.layers.filter((l) => l.ts === arm.set);
    const body = el('div', {},
      el('p', { text:
        `图层 ${layer.index} 的图块来自 '${layer.ts}',而每个图层只能有一个 ` +
        `图块素材集。此图块来自 '${arm.set}'。` }),
      carriers.length
        ? el('p', { text: `使用 '${arm.set}' 的图层: ${carriers.map((l) => l.index).join(', ')}。` })
        : el('p', { class: 'muted', text: `还没有图层使用 '${arm.set}' — 空图层可以采用它。` }),
      el('p', { class: 'me-refusal-text', text:
        `重新换肤会将图层 ${layer.index} 上已有的全部 ${fmt.format(layer.tiles.length)} 个图块 ` +
        `更改为 '${arm.set}' 图片 — 相同的 u/no,不同的美术。` }));

    const actions = [{ label: '取消' }];
    if (carriers.length) {
      actions.push({
        label: `放置到图层 ${carriers[0].index}`,
        run: () => {
          this.mem().layer = carriers[0].index;
          this.commitPlacement(x, y);
        },
      });
    }
    actions.push({
      label: `为图层 ${layer.index} 重新换肤`, class: 'btn-danger',
      run: async () => {
        try {
          const result = await post('/api/mapedit/set-layer-ts', {
            path: this.doc.path, layer: layer.index, ts: arm.set, confirmReskin: true,
          });
          for (const note of result.notes ?? []) toast(note);
          await this.refetchDoc();
          this.commitPlacement(x, y);
        } catch (err) { toastError(err, '重新换肤'); }
      },
    });
    modal({ title: '图块素材集冲突', body, width: '460px', actions });
  }

  confirmDialog(title, text) {
    return new Promise((resolve) => {
      modal({
        title,
        body: el('p', { text }),
        width: '420px',
        actions: [
          { label: '取消', run: () => resolve(false) },
          { label: '继续', class: 'btn-primary', run: () => resolve(true) },
        ],
        onOpen: (dialog) => dialog.addEventListener('close', () => resolve(false), { once: true }),
      });
    });
  }

  async commitFootholdChain(layer, points) {
    if (!this.doc || points.length < 2) return;
    try {
      const result = await post('/api/mapedit/foothold-chain', {
        path: this.doc.path, layer, points,
      });
      for (const note of result.notes ?? []) toast(note);
      await this.refetchDoc();
    } catch (err) {
      toastError(err, '立足点链');
    }
  }

  async autoFoothold() {
    const sel = this.selection[0];
    if (!sel?.entry?.addr) return;
    try {
      const result = await post('/api/mapedit/auto-foothold', {
        path: this.doc.path, addr: sel.entry.addr,
      });
      for (const note of result.notes ?? []) toast(note);
      await this.refetchDoc();
    } catch (err) {
      toastError(err, '自动立足点');
    }
  }

  /* ============================================================ minimap */

  async minimapDialog() {
    if (!this.doc) return;
    const body = el('div', {}, el('p', { class: 'muted', text:
      '正在规划… 共享者扫描会遍历会话中的每张地图图片,因此可能需要几秒钟。' }));
    const handle = modal({ title: '重新生成小地图', body, width: '520px', actions: [{ label: '关闭' }] });

    let plan;
    try {
      plan = await get(`/api/mapedit/minimap/plan?path=${q(this.doc.path)}`);
    } catch (err) {
      toastError(err, '小地图规划');
      return;
    }

    clear(body);
    body.append(el('p', { text:
      `将写入:宽度 ${fmt.format(plan.width)},高度 ${fmt.format(plan.height)}, ` +
      `centerX ${plan.centerX}, centerY ${plan.centerY},mag ${plan.mag}, ` +
      `画布 ${plan.canvasW}×${plan.canvasH} px(实测 floor(dim/16))。` }));
    body.append(el('p', { class: 'muted', text:
      '渲染内容是缩放后的小地图地图美术(图块 + 对象,第 0 帧) — 忠实呈现布局,' +
      '并非客户端样式的像素复制。不绘制背景。' }));
    if (!plan.hasMiniMap) {
      body.append(el('p', { text: '此地图尚无小地图(939 几何类型的地图出厂时没有小地图)。' }));
    }

    const detach = el('input', { type: 'checkbox' });
    const shared = el('input', { type: 'checkbox' });
    if (plan.canvasIsLink) {
      body.append(el('label', { class: 'me-minimap-confirm' }, detach,
        el('span', { text:
          `此小地图是指向 ${plan.linkTarget} 的链接。重新生成将解除链接,并为这张 ` +
          '地图生成自己的图片。我了解。' })));
    }
    if (plan.sharerCount > 0) {
      body.append(el('label', { class: 'me-minimap-confirm' }, shared,
        el('span', { class: 'me-refusal-text', text:
          `${plan.sharerCount} 张其他地图通过 _outlink 引用此地图的小地图: ` +
          `${plan.sharers.join(', ')}${plan.sharerCount > plan.sharers.length ? ' …' : ''}。` +
          '覆盖会改变它们各自显示的内容。我了解。' })));
    }

    body.append(el('div', { class: 'me-insp-actions' },
      el('button', { class: 'btn btn-primary', onclick: async (e) => {
        try {
          busyButton(e.currentTarget, true);
          const result = await post('/api/mapedit/minimap/regenerate', {
            path: this.doc.path,
            confirmDetachLink: detach.checked,
            confirmSharedOverwrite: shared.checked,
          });
          for (const note of result.notes ?? []) toast(note);
          toast(`小地图已重新生成: ${result.canvasW}×${result.canvasH}。保存地图以使其生效。`);
          handle.close();
          await this.refetchDoc();
        } catch (err) {
          busyButton(e.currentTarget, false);
          toastError(err, '小地图');
        }
      } }, '重新生成')));
  }

  /* ============================================================ new map */

  newMapDialog() {
    const idInput = el('input', { class: 'field-input num', placeholder: '9 位 ID,例如 900000001' });
    const nameInput = el('input', { class: 'field-input', placeholder: '地图名称 (String.wz 记录)' });
    const streetInput = el('input', { class: 'field-input', placeholder: '街道名称' });
    const body = el('div', { class: 'me-newmap' },
      el('p', { class: 'muted', text:
        'ID 会在所有打开的 Map 存档中进行冲突检查。地图按实测的最小结构搭建' +
        '(图层 0-7、正式地图自带的空容器、合理的 info 默认值),保存到存放客户端地图的存档,并在 String.wz 中命名。' }),
      idInput, nameInput, streetInput);

    modal({
      title: '从零创建地图',
      body,
      width: '460px',
      actions: [
        { label: '取消' },
        {
          label: '创建并打开', class: 'btn-primary',
          run: async () => {
            const id = Number(idInput.value.trim());
            try {
              const result = await post('/api/mapedit/create', {
                id, name: nameInput.value.trim(), streetName: streetInput.value.trim(),
              });
              for (const note of result.notes ?? []) toast(note);
              toast(`已创建 ${result.path},位于 ${result.archive}` +
                (result.stringRowWritten ? `;字符串记录位于 ${result.stringRegion}。` : '。'));
              await this.openMap(result.path);
            } catch (err) {
              toastError(err, '创建地图');
            }
          },
        },
      ],
      onOpen: () => idInput.focus(),
    });
  }

  /* ============================================================ edits */

  editOp(op) {
    return post('/api/mapedit/edit', { path: this.doc.path, op });
  }

  /** Applies the server's authoritative geometry to the local model. */
  applyMoved(result) {
    const pools = this.pools();
    for (const moved of result.moved ?? []) {
      const found = this.findByAddrIn(pools, moved.addr);
      if (!found) continue;
      const e = found.entry;
      if (found.kind === 'foothold') {
        e.x1 = moved.x1; e.y1 = moved.y1; e.x2 = moved.x2; e.y2 = moved.y2;
      } else if (found.kind === 'ladder') {
        e.x = moved.x1; e.y1 = moved.y1; e.y2 = moved.y2;
      } else if (found.kind === 'rect') {
        e.x1 = moved.x1; e.y1 = moved.y1; e.x2 = moved.x2; e.y2 = moved.y2;
      } else if (found.kind === 'life') {
        e.x = moved.x1; e.y = moved.y1; e.cy = moved.y1;
      } else {
        e.x = moved.x1; e.y = moved.y1;
      }
    }
  }

  findByAddrIn(pools, addr) {
    for (const [kind, pool] of Object.entries(pools)) {
      const entry = pool.find((e) => sameAddr(e.addr, addr));
      if (entry) return { kind, entry };
    }
    return null;
  }

  async commitMoveMany(items, dx, dy) {
    if (!this.doc || !items.length || (dx === 0 && dy === 0)) {
      this.view.refreshStatic();
      return;
    }
    try {
      const result = await this.editOp({
        kind: 'moveMany',
        dx, dy,
        items: items.map((i) => ({ addr: i.entry.addr, kind: this.opKind(i.kind) })),
      });
      this.applyMoved(result);
      for (const note of result.notes ?? []) toast(note);
      this.applyEditResult(result);
      this.view.refreshStatic();
      this.renderFloat();
      this.renderInspector();
    } catch (err) {
      toastError(err, '移动');
      this.refetchDoc();
    }
  }

  /** Selection kinds → server batch kinds. */
  opKind(kind) {
    if (kind === 'tile' || kind === 'obj' || kind === 'portal' || kind === 'reactor' || kind === 'back')
      return kind;
    return kind; // life, foothold, ladder, rect map 1:1
  }

  async commitFootholdMove(entry, vertex) {
    try {
      const result = await this.editOp({
        kind: 'moveFoothold', addr: entry.addr, vertex,
        x: vertex === 1 ? entry.x1 : entry.x2,
        y: vertex === 1 ? entry.y1 : entry.y2,
      });
      this.applyMoved(result);
      if ((result.moved?.length ?? 0) > 1)
        toast(`${result.moved.length} 个立足点共享此顶点;已全部一起移动。`);
      this.applyEditResult(result);
      this.view.refreshStatic();
      this.renderFloat();
      this.renderInspector();
    } catch (err) {
      toastError(err, '立足点');
      this.refetchDoc();
    }
  }

  async commitLadderMove(entry) {
    try {
      const result = await this.editOp({
        kind: 'moveLadder', addr: entry.addr, x: entry.x, y1: entry.y1, y2: entry.y2,
      });
      this.applyMoved(result);
      this.applyEditResult(result);
      this.view.refreshStatic();
      this.renderFloat();
    } catch (err) {
      toastError(err, '梯子');
      this.refetchDoc();
    }
  }

  async commitRectResize(entry) {
    try {
      const result = await this.editOp({
        kind: 'setRect', addr: entry.addr,
        x1: entry.x1, y1: entry.y1, x2: entry.x2, y2: entry.y2,
      });
      this.applyMoved(result);
      this.applyEditResult(result);
      this.view.refreshStatic();
      this.renderFloat();
    } catch (err) {
      toastError(err, '区域');
      this.refetchDoc();
    }
  }

  async commitInsertVertex(entry, x, y) {
    try {
      const result = await this.editOp({
        kind: 'insertFootholdVertex', addr: entry.addr, x, y,
      });
      for (const note of result.notes ?? []) toast(note);
      this.applyEditResult(result, { skipRefetch: true });
      await this.refetchDoc();
      if (result.placed?.length) this.selectAddrs(result.placed);
      toast('顶点已插入 — 将其拖动到位。');
    } catch (err) {
      toastError(err, '插入顶点');
    }
  }

  async commitExtendFoothold(entry, vertex, x, y) {
    try {
      const result = await this.editOp({
        kind: 'extendFoothold', addr: entry.addr, vertex, x, y,
      });
      this.applyEditResult(result, { skipRefetch: true });
      await this.refetchDoc();
      // Keep drawing: re-arm extension from the NEW segment's free end.
      const placedAddr = result.placed?.[0];
      const found = placedAddr ? this.findByAddr(placedAddr) : null;
      if (found?.kind === 'foothold') {
        this.selection = [{ kind: 'foothold', entry: found.entry }];
        this.view.select(this.selection);
        this.view.beginExtend(found.entry, vertex);
        this.renderFloat();
        this.setStatus('链条已延伸 — 点击继续绘制,Enter/Esc 停止。');
      }
    } catch (err) {
      toastError(err, '延伸链条');
      this.view.cancelExtend();
    }
  }

  async deleteSelection() {
    const items = this.selection.filter((s) => s.entry?.addr);
    if (!items.length) return;
    try {
      const result = await this.editOp({
        kind: 'deleteMany',
        items: items.map((s) => ({ addr: s.entry.addr, kind: s.kind })),
      });
      for (const note of result.notes ?? []) toast(note);
      toast(items.length === 1
        ? `已删除 ${KIND_LABEL[items[0].kind] ?? '节点'} — Ctrl+Z 可恢复。`
        : `已删除 ${items.length} 个项 — 一次 Ctrl+Z 全部恢复。`);
      this.selection = [];
      this.view.select([]);
      this.renderFloat();
      this.applyEditResult(result);
    } catch (err) {
      toastError(err, '删除');
    }
  }

  copySelection() {
    const items = this.selection.filter((s) => s.entry?.addr && s.kind !== 'foothold');
    if (!items.length) {
      if (this.selection.length) toast('立足点按链条复制 — 请改用延伸/绘制。');
      return;
    }
    let cx = 0; let cy = 0;
    for (const s of items) {
      cx += s.entry.x ?? s.entry.x1 ?? 0;
      cy += s.entry.y ?? s.entry.y1 ?? 0;
    }
    this.clipboard = {
      items: items.map((s) => ({ addr: s.entry.addr, kind: s.kind })),
      cx: Math.round(cx / items.length),
      cy: Math.round(cy / items.length),
    };
    toast(`已复制 ${items.length} 个项${items.length === 1 ? '' : ''} — Ctrl+V 在光标处粘贴。`);
  }

  pasteClipboard() {
    if (!this.clipboard) return;
    const mouse = this.view.mouse;
    const dx = mouse ? Math.round(mouse[0]) - this.clipboard.cx : 24;
    const dy = mouse ? Math.round(mouse[1]) - this.clipboard.cy : 24;
    this.duplicateItems(this.clipboard.items, dx, dy);
  }

  duplicateSelection(dx, dy) {
    const items = this.selection
      .filter((s) => s.entry?.addr)
      .map((s) => ({ addr: s.entry.addr, kind: s.kind }));
    if (!items.length) return;
    this.duplicateItems(items, dx, dy);
  }

  async duplicateItems(items, dx, dy) {
    try {
      const result = await this.editOp({ kind: 'duplicate', items, dx, dy });
      for (const note of result.notes ?? []) toast(note);
      this.applyEditResult(result, { skipRefetch: true });
      await this.refetchDoc();
      if (result.placed?.length) {
        this.selectAddrs(result.placed);
        toast(`已选择 ${result.placed.length} 个副本${result.placed.length === 1 ? '' : ''} — 拖动到位。`);
      }
    } catch (err) {
      toastError(err, '复制');
    }
  }

  async commitSetField(addr, name, value) {
    try {
      const result = await this.editOp({ kind: 'setField', addr, name, value: String(value) });
      this.applyEditResult(result);
      if (!result.structural) {
        // Update the local copy so the panel and canvas agree immediately.
        const found = this.findByAddr(addr);
        if (found && name in found.entry) {
          const n = Number(value);
          found.entry[name] = Number.isNaN(n) ? value : n;
        }
        this.view.refreshStatic();
        this.renderFloat();
      }
      return true;
    } catch (err) {
      toastError(err, '编辑');
      return false;
    }
  }

  async setNodeValue(addr, value) {
    const result = await this.editOp({ kind: 'setValue', addr, value });
    this.applyEditResult(result, { refetchAlways: true });
  }

  applyEditResult(result, { refetchAlways = false, skipRefetch = false } = {}) {
    if (this.doc) {
      this.doc.undoDepth = result.undoDepth;
      this.doc.redoDepth = result.redoDepth;
      this.doc.dirty = result.dirty;
    }
    this.renderToolbar();
    this.refreshUnsaved();
    if (!skipRefetch && (result.structural || refetchAlways)) this.refetchDoc();
  }

  async undo(redo) {
    if (!this.doc) return;
    try {
      const result = await post(`/api/mapedit/${redo ? 'redo' : 'undo'}`, { path: this.doc.path });
      if (result.applied) toast(`${redo ? '已重做' : '已撤销'}: ${result.applied}`);
      await this.refetchDoc();
    } catch (err) {
      toastError(err, redo ? '重做' : '撤销');
    }
  }

  /* ==================================================== tile variant picker */

  async tileVariants(sel) {
    const layer = this.doc.layers.find((l) => l.index === sel.item?.layer)
      ?? this.doc.layers.find((l) => l.tiles.includes(sel.entry));
    const ts = layer?.ts;
    if (!ts) return null;
    let entries = this.tileVariantCache.get(ts);
    if (!entries) {
      const sets = await this.ensureAllSets();
      const set = (sets.Tile ?? []).find((s) => s.name.toLowerCase() === ts.toLowerCase());
      if (!set) return null;
      const result = await get(`/api/mapedit/palette/entries?kind=Tile&path=${q(set.path)}`);
      entries = result.entries;
      this.tileVariantCache.set(ts, entries);
    }
    return entries.filter((e) => e.u === sel.entry.u);
  }

  async openTilePicker(sel, sx, sy) {
    this.closePicker();
    let variants;
    try {
      variants = await this.tileVariants(sel);
    } catch (err) { toastError(err, '图块变体'); return; }
    if (!variants?.length) { toast('此图块的素材集没有可用的变体列表。'); return; }

    const pop = this.picker;
    clear(pop);
    pop.append(el('h5', { text: `${sel.entry.u} — 选择变体(或使用 [ ] 按键)` }));
    const grid = el('div', { class: 'me-pal-grid' });
    for (const v of variants) {
      const cell = el('button', {
        class: `me-pal-cell${Number(v.no) === Number(sel.entry.no) ? ' me-pal-current' : ''}`,
        'data-tip': `no ${v.no}`,
        onclick: async () => {
          this.closePicker();
          if (Number(v.no) !== Number(sel.entry.no))
            await this.commitSetField(sel.entry.addr, 'no', v.no);
        },
      });
      if (v.thumbPath) cell.append(el('img', { src: `/api/mapedit/thumb?path=${q(v.thumbPath)}`, loading: 'lazy', alt: '' }));
      grid.append(cell);
    }
    pop.append(grid);

    const wrap = this.canvasWrap.getBoundingClientRect();
    pop.style.left = `${Math.min(sx, wrap.width - 280)}px`;
    pop.style.top = `${Math.min(sy + 12, wrap.height - 240)}px`;
    motionIn(pop, { timeout: 220 });
  }

  closePicker() {
    if (this.picker.hidden) return;
    motionOut(this.picker, { hide: true, timeout: 160 }).then((closed) => {
      if (closed && this.picker.hidden) clear(this.picker);
    });
  }

  async cycleTileVariant(step) {
    const sel = this.single('tile');
    if (!sel) return;
    let variants;
    try { variants = await this.tileVariants(sel); } catch { return; }
    if (!variants?.length) return;
    const index = variants.findIndex((v) => Number(v.no) === Number(sel.entry.no));
    const next = variants[(index + step + variants.length) % variants.length];
    if (next && Number(next.no) !== Number(sel.entry.no)) {
      await this.commitSetField(sel.entry.addr, 'no', next.no);
    }
  }

  /* ==================================================== floating panel */

  positionFloat() {
    if (this.float.hidden) return;
    const wrap = this.canvasWrap.getBoundingClientRect();
    const width = this.float.offsetWidth || 260;
    const height = this.float.offsetHeight || 40;
    if (this.floatManual) {
      // Dragged by hand: it stays where it was put, clamped on screen.
      this.float.style.left = `${Math.max(6, Math.min(this.floatManual.x, wrap.width - width - 6))}px`;
      this.float.style.top = `${Math.max(6, Math.min(this.floatManual.y, wrap.height - height - 6))}px`;
      return;
    }
    const box = this.view.selectionScreenBox();
    if (!box) { this.float.hidden = true; return; }
    let x = (box.x0 + box.x1) / 2 - width / 2;
    let y = box.y0 - height - 10;
    if (y < 6) y = Math.min(box.y1 + 10, wrap.height - height - 6);
    x = Math.max(6, Math.min(x, wrap.width - width - 6));
    this.float.style.left = `${x}px`;
    this.float.style.top = `${y}px`;
  }

  /** The property panel drags by its title bar — put it where it does not
   *  cover the work and it stays there for this selection. */
  makeFloatDraggable(title) {
    title.classList.add('me-float-grab');
    title.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startX = e.clientX; const startY = e.clientY;
      const baseX = this.float.offsetLeft; const baseY = this.float.offsetTop;
      title.setPointerCapture(e.pointerId);
      const move = (ev) => {
        this.floatManual = { x: baseX + (ev.clientX - startX), y: baseY + (ev.clientY - startY) };
        this.positionFloat();
      };
      const up = () => {
        title.removeEventListener('pointermove', move);
        title.removeEventListener('pointerup', up);
      };
      title.addEventListener('pointermove', move);
      title.addEventListener('pointerup', up);
    });
  }

  renderFloat() {
    const panel = this.float;
    clear(panel);
    const sel = this.selection;
    // Authoring modes own the canvas — the panel must never sit between the
    // cursor and the next click of a chain draw or an armed placement.
    const authoring = this.placing || this.view?.fhDraw || this.view?.fhExtend;
    if (!sel.length || !this.doc || authoring) { panel.hidden = true; return; }
    panel.hidden = false;

    if (sel.length > 1) {
      const byKind = new Map();
      for (const s of sel) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
      const multiTitle = el('div', { class: 'me-float-title', text:
        `${sel.length} 个已选 — ` +
        [...byKind].map(([k, n]) => `${n} ${KIND_LABEL[k]?.toLowerCase() ?? k}${n > 1 ? '' : ''}`).join(', ') });
      this.makeFloatDraggable(multiTitle);
      panel.append(multiTitle);
      panel.append(el('div', { class: 'me-float-actions' },
        el('button', { class: 'btn btn-ghost', text: '复制', 'data-tip': 'Ctrl+D',
          onclick: () => this.duplicateSelection(24, 0) }),
        el('button', { class: 'btn btn-danger-ghost', text: '删除', 'data-tip': '一次撤销记录',
          onclick: () => this.deleteSelection() })));
      this.positionFloat();
      return;
    }

    const s = sel[0];
    const e = s.entry;
    const title = {
      tile: () => `图块 ${e.u}/${e.no}`,
      obj: () => `对象 ${e.l0 ?? ''}/${e.l1 ?? ''}/${e.l2 ?? ''}`,
      foothold: () => `立足点 ${e.id} · prev ${e.prev} next ${e.next}`,
      ladder: () => e.l === 1 ? '梯子' : '绳子',
      portal: () => `传送门 ${e.pn || '(未命名)'}`,
      life: () => `${(e.type || '').toLowerCase() === 'n' ? 'NPC' : '怪物'} ${e.name ?? e.id}`,
      reactor: () => `反应器 ${e.id ?? ''}`,
      rect: () => `${e.kind}/${e.name}`,
      back: () => `背景 ${e.no}`,
    }[s.kind]?.() ?? s.kind;
    const titleBar = el('div', { class: 'me-float-title', text: title });
    this.makeFloatDraggable(titleBar);
    panel.append(titleBar);

    const fields = el('div', { class: 'me-float-fields' });
    panel.append(fields);

    const num = (label, value, commit, tip) => {
      const input = el('input', { class: 'me-float-num num', value: String(value), 'data-tip': tip });
      const fire = async () => {
        const n = Number(input.value.trim());
        if (Number.isNaN(n) || n === Number(value)) { input.value = String(value); return; }
        await commit(n);
      };
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); ev.stopPropagation(); });
      input.addEventListener('blur', fire);
      fields.append(el('label', { class: 'me-float-field' },
        el('span', { text: label }), input));
    };
    const text = (label, value, name) => {
      const input = el('input', { class: 'me-float-num', value: value ?? '' });
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); ev.stopPropagation(); });
      input.addEventListener('blur', async () => {
        if (input.value !== (value ?? '')) await this.commitSetField(e.addr, name, input.value);
      });
      fields.append(el('label', { class: 'me-float-field' },
        el('span', { text: label }), input));
    };
    const field = (label, name, tip) => num(label, e[name] ?? e[name.toLowerCase()] ?? 0,
      (n) => this.commitSetField(e.addr, name, n), tip);
    const flip = () => {
      const box = el('input', { type: 'checkbox', checked: Number(e.f ?? 0) === 1 ? 'checked' : null });
      box.addEventListener('change', () => this.commitSetField(e.addr, 'f', box.checked ? '1' : '0'));
      fields.append(el('label', { class: 'me-float-field me-float-check' },
        el('span', { text: '翻转' }), box));
    };
    const moveXY = () => {
      num('x', e.x, (n) => this.commitMoveMany([{ kind: s.kind, entry: e }], n - e.x, 0));
      num('y', e.y, (n) => this.commitMoveMany([{ kind: s.kind, entry: e }], 0, n - e.y));
    };

    if (s.kind === 'tile') {
      moveXY();
      field('zM', 'zM');
      fields.append(el('button', { class: 'btn btn-ghost me-float-btn', text: '变体…',
        'data-tip': '切换此图块显示的图片 — 相同的 u,不同的 no。也可以双击图块,或使用 [ ] 按键。',
        onclick: () => {
          const box = this.view.selectionScreenBox();
          this.openTilePicker(s, box ? (box.x0 + box.x1) / 2 : 40, box ? box.y1 : 40);
        } }));
    } else if (s.kind === 'obj') {
      moveXY();
      field('z', 'z');
      field('zM', 'zM');
      flip();
    } else if (s.kind === 'foothold') {
      num('x1', e.x1, async (n) => { e.x1 = n; await this.commitFootholdMove(e, 1); });
      num('y1', e.y1, async (n) => { e.y1 = n; await this.commitFootholdMove(e, 1); });
      num('x2', e.x2, async (n) => { e.x2 = n; await this.commitFootholdMove(e, 2); });
      num('y2', e.y2, async (n) => { e.y2 = n; await this.commitFootholdMove(e, 2); });
    } else if (s.kind === 'ladder') {
      num('x', e.x, async (n) => { e.x = n; await this.commitLadderMove(e); });
      num('y1', e.y1, async (n) => { e.y1 = n; await this.commitLadderMove(e); });
      num('y2', e.y2, async (n) => { e.y2 = n; await this.commitLadderMove(e); });
      field('l', 'l', '1 梯子,0 绳子');
      field('uf', 'uf', '1 = 可从顶端爬出');
    } else if (s.kind === 'portal') {
      moveXY();
      text('pn', e.pn, 'pn');
      text('tn', e.tn, 'tn');
      field('tm', 'tm', '999999999 = 无目标地图');
      field('pt', 'pt');
    } else if (s.kind === 'life') {
      num('x', e.x, (n) => this.commitMoveMany([{ kind: 'life', entry: e }], n - e.x, 0));
      num('cy', e.cy || e.y, (n) => this.commitMoveMany([{ kind: 'life', entry: e }], 0, n - (e.cy || e.y)),
        '移动会重新锚定:刷新点落在立足点上,y/cy 保持配对。');
      field('mobTime', 'mobTime', '-1 = 永不重生');
      field('hide', 'hide');
      flip();
    } else if (s.kind === 'reactor') {
      moveXY();
      text('id', e.id, 'id');
      text('name', e.reactorName, 'name');
      flip();
    } else if (s.kind === 'rect') {
      num('x1', e.x1, async (n) => { e.x1 = n; await this.commitRectResize(e); });
      num('y1', e.y1, async (n) => { e.y1 = n; await this.commitRectResize(e); });
      num('x2', e.x2, async (n) => { e.x2 = n; await this.commitRectResize(e); });
      num('y2', e.y2, async (n) => { e.y2 = n; await this.commitRectResize(e); });
    } else if (s.kind === 'back') {
      moveXY();
      field('rx', 'rx', '视差;类型 4-7 时为滚动速度');
      field('ry', 'ry');
      field('type', 'type', '0-7:静止、平铺、滚动');
      field('front', 'front');
      field('a', 'a', '不透明度 0-255');
      flip();
    }

    panel.append(el('div', { class: 'me-float-actions' },
      el('button', { class: 'btn btn-ghost', text: '复制', 'data-tip': 'Ctrl+D',
        onclick: () => this.duplicateSelection(24, 0) }),
      el('button', { class: 'btn btn-danger-ghost', text: '删除', 'data-tip': 'Delete 键 — 可撤销',
        onclick: () => this.deleteSelection() })));

    this.positionFloat();
  }

  /* ============================================================ save */

  save() {
    const d = this.doc;
    if (!d) return;
    const body = el('div', {},
      el('p', { text: `${d.imageName} 将根据模型重建并写入其 ` +
        '存档。写入后会从保存的文件读回,并与模型逐字节比对 — ' +
        '与往返测试框架执行的检查相同。' }),
      el('p', { class: 'muted', text:
        `未改动原样保留: ${d.unmodelledCount} 个未建模顶级节点` +
        `${d.unmodelledCount === 1 ? '' : ''}` +
        (d.unmodelledNames.length ? ` (${d.unmodelledNames.join(', ')})` : '') + '。' }),
      el('p', { class: 'muted', text: '撤销历史在保存后仍然保留:保存的文件成为新的干净基线,' +
        '继续撤销只会让地图再次变为未保存状态。' }));

    modal({
      title: '保存此地图?',
      body,
      width: '480px',
      actions: [
        { label: '取消' },
        {
          label: '保存并验证', class: 'btn-primary',
          run: () => { this.runSave(); },
        },
      ],
    });
  }

  async runSave() {
    try {
      const result = await post('/api/mapedit/save', { path: this.doc.path });
      await this.refetchDoc();
      const lines = [
        el('p', {}, result.verified
          ? el('strong', { text: '已验证:保存图片的字节与模型的字节完全一致。' })
          : el('strong', { class: 'me-refusal-text', text: '未通过验证 — 保存的图片与模型不一致:' })),
        ...(result.differences ?? []).map((line) => el('p', { class: 'muted', text: line })),
        el('p', { class: 'muted', text: `已写入 ${result.savedTo} ` +
          `(${fmt.format(result.archiveBytes)} 字节,${result.seconds.toFixed(1)} 秒)。` }),
        result.backupPath ? el('p', { class: 'muted', text: `备份: ${result.backupPath}` }) : null,
        el('p', { class: 'muted', text:
          `保留的未建模节点: ${result.unmodelledCarried}。` }),
        result.historyKept
          ? null
          : el('p', { class: 'me-refusal-text', text:
              result.historyNote ?? '此保存已清除撤销历史。' }),
      ];
      modal({ title: result.verified ? '地图已保存' : '已保存,但验证失败',
        body: el('div', {}, ...lines), width: '520px', actions: [{ label: '关闭' }] });
    } catch (err) {
      toastError(err, '保存地图');
    }
  }

  /* ============================================================ inspector */

  renderInspector() {
    const sel = this.selection;
    const show = Boolean(this.ui.inspector && this.doc && sel.length);
    this.setPanelVisible(this.inspector, show, { enter: 240 });
    if (!show) return;
    clear(this.inspector);

    if (sel.length > 1) {
      this.inspector.append(el('h4', { text: `${sel.length} 个项已选` }));
      this.inspector.append(el('p', { class: 'muted', text:
        '它们一起拖动,方向键微调,Delete 删除 — 每个操作都是一次撤销记录。' +
        '原始检查器仅显示单个选择。' }));
      return;
    }

    const one = sel[0];
    const entry = one.entry;
    this.inspector.append(el('h4', {},
      el('span', { text: KIND_LABEL[one.kind] ?? one.kind }),
      el('span', { class: 'muted num', text: ` @ ${entry.addr.join('/')}` })));

    if (one.kind === 'life' && entry.name)
      this.inspector.append(el('p', { class: 'me-insp-name', text: entry.name }));
    if (one.kind === 'foothold')
      this.inspector.append(el('p', { class: 'muted', text:
        `id ${entry.id} · 图层 ${entry.layer} · 组 ${entry.group} · ` +
        `prev ${entry.prev} · next ${entry.next} — prev/next 从不被重写;` +
        '分叉合法且会被保留。双击线段插入顶点;' +
        '双击空闲端延伸链条。' }));
    if (one.kind === 'tile' || one.kind === 'obj') {
      this.inspector.append(el('button', {
        class: 'btn me-auto-fh',
        'data-tip': '读取美术自带的立足点 Convex(Tile/<set>/<u>/<no>/foothold;obj ' +
          '帧也携带)并在该放置处写入相连链条。若美术未携带则不执行 — ' +
          '不会凭空生成。',
        onclick: () => this.autoFoothold(),
      }, '根据美术生成立足点'));
    }

    const table = el('div', { class: 'me-node-table' });
    this.inspector.append(table);
    this.loadNode(table, entry.addr);
  }

  async loadNode(table, addr) {
    let node;
    try {
      node = await get(`/api/mapedit/node?path=${q(this.doc.path)}&addr=${addr.join(',')}`);
    } catch (err) {
      table.append(el('p', { class: 'muted', text: err.message }));
      return;
    }
    clear(table);

    for (const child of node.children) {
      const editable = ['Short', 'Int', 'Long', 'Float', 'Double', 'String', 'UOL']
        .includes(child.type);
      const row = el('div', { class: 'me-node-row' },
        nameLabel(child.name),
        el('span', { class: 'me-node-type muted', text: child.type }));

      if (editable) {
        const input = el('input', {
          class: 'field-input me-node-value', value: child.value ?? '',
          'data-tip': `以 ${child.type} 类型存储;写入时保留类型。`,
        });
        const commit = async () => {
          if (input.value === (child.value ?? '')) return;
          try {
            await this.setNodeValue(child.addr, input.value);
            child.value = input.value;
            toast(`${child.name} = ${input.value}`);
          } catch (err) {
            input.value = child.value ?? '';
            toastError(err, '编辑值');
          }
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
        input.addEventListener('blur', commit);
        row.append(input);
      } else if (child.hasChildren) {
        row.append(el('button', {
          class: 'btn btn-ghost me-node-open', text: `${child.childCount} ▸`,
          onclick: () => this.loadNode(table, child.addr),
        }));
      } else {
        row.append(el('span', { class: 'me-node-value muted', text: child.value ?? '—' }));
      }
      table.append(row);
    }

    if (addr.length >= 2) {
      table.append(el('div', { class: 'me-insp-actions' },
        el('button', { class: 'btn btn-danger-ghost', onclick: () => this.deleteSelection() },
          icon('trash', { size: 14 }), '删除 (可撤销)')));
    }
  }
}

/**
 * A node name, shown faithfully. A trailing space is a DIFFERENT KEY from its
 * trimmed namesake — rendered visibly instead of being trimmed by HTML
 * collapsing.
 */
function nameLabel(name) {
  const match = /^(.*?)( +)$/.exec(name);
  const label = el('span', { class: 'me-node-name' });
  if (!match) {
    label.textContent = name;
    return label;
  }
  label.append(
    el('span', { text: match[1] }),
    el('span', {
      class: 'me-trailing-space',
      text: '·'.repeat(match[2].length),
      'data-tip': `此键以 ${match[2].length} 个空格${match[2].length === 1 ? '' : ''} 结尾 — ` +
        '与去除空格后的键是不同的键,精确保留。',
    }));
  return label;
}
