/**
 * File and folder picker for .wz, .ms and standalone .img files.
 *
 * The important behaviour: point it at a MapleStory folder and it opens every
 * archive in one go. Numbered siblings (Map.wz, Map001.wz, Map002.wz) are
 * grouped into one row, because they are one thing as far as the user is
 * concerned and ticking them individually is busywork.
 *
 * A browser cannot show a native folder dialog that returns a server-side path,
 * so this browses the machine through the backend instead.
 */

import { api } from './api.js';
import { el, clear, toast, toastError, modal, fmt } from './ui.js';
import { icon } from './icons.js';

const LAST_DIR = 'mb.lastDir';

/** Sub-megabyte files are common (a loose .img is often a few KB) and used to read "0.0 MB". */
const bytes = (n) => {
  if (!Number.isFinite(n) || n < 0) return '';
  const kb = n / 1024;
  if (kb < 1) return `${n} B`;
  const mb = kb / 1024;
  if (mb < 1) return `${kb.toFixed(0)} KB`;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
};

export function openPicker(app, startPath) {
  const selected = new Set();          // family names ticked for opening
  let scan = null;                     // last /api/scan result

  // Two quick folder clicks race two /api/scan calls, and without this the
  // slower response wins: you would see folder A's rows, tick them, and open
  // folder B's archives. For a tool whose job is pointing at the right client
  // folder, that has to be impossible.
  let generation = 0;

  const pathBar = el('div', { class: 'picker-path' });
  const banner = el('div', { class: 'picker-banner' });
  const list = el('div', { class: 'picker-list' });
  const summary = el('div', {
    style: 'display:flex;align-items:center;gap:10px;margin-top:10px;font-size:var(--fs-12);color:var(--text-2)',
  });

  // Memory headroom, shown while the selection is being made rather than
  // discovered when the process gets into trouble. Read once when the dialog
  // opens; it is a scale, not a live gauge.
  const headroom = el('div', { class: 'picker-headroom', hidden: true });
  let memory = null;
  // Fetched directly because this optional memory hint needs only one GET and
  // has no shared API state.
  fetch('/api/session/memory')
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => { if (m) { memory = m; updateSummary(); } })
    .catch(() => {});

  const openSelected = el('button', {
    class: 'btn btn-primary', disabled: true,
    onclick: () => commit(),
  }, icon('folderOpen', { size: 15 }), el('span', { id: 'picker-open-label' }, '打开所选'));

  const openImgFolder = el('button', {
    class: 'btn', hidden: true,
    onclick: () => commitImgFolder(),
  }, icon('folderOpen', { size: 15 }), '打开此 IMG 文件夹');

  /* ---------- rendering ---------- */

  // Every caller is a click handler that cannot await this, so a rejection here
  // would be an unhandled one and a click that silently did nothing.
  const render = (path) => paint(path).catch((error) => {
    clear(list);
    list.append(errorRow(error.message));
  });

  const paint = async (path) => {
    const mine = ++generation;
    const stale = () => mine !== generation;
    clear(list);
    list.append(el('div', { class: 'skeleton skeleton-row', style: 'width:55%' }),
                el('div', { class: 'skeleton skeleton-row', style: 'width:72%' }),
                el('div', { class: 'skeleton skeleton-row', style: 'width:63%' }));

    // Root view: list drives, since there is no folder above them.
    if (!path) {
      try {
        const drives = await api.browse(null);
        if (stale()) return;
        clear(list); clear(banner); clear(pathBar);
        pathBar.append(icon('folder', { size: 14 }), el('span', { text: '此电脑' }));
        for (const drive of drives.directories) {
          list.append(row('folder', drive.name, '', () => render(drive.path)));
        }
      } catch (error) {
        clear(list);
        list.append(errorRow(error.message));
      }
      updateSummary();
      return;
    }

    try {
      const scanned = await api.scan(path);
      if (stale()) return;
      scan = scanned;
      selected.clear();
      openImgFolder.hidden = !scan.looseImageCount;
      // Pre-tick everything in a folder that looks like a game client: opening
      // all of it is the overwhelmingly common intent.
      if (scan.looksLikeClient) scan.groups.forEach((g) => selected.add(g.family));

      localStorage.setItem(LAST_DIR, scan.path);

      clear(pathBar);
      pathBar.append(icon('folder', { size: 14 }), el('span', { text: scan.path }));

      clear(banner);
      if (scan.looksLikeClient) {
        banner.append(el('div', { class: 'notice anim-rise', 'data-tone': 'good' },
          icon('check', { size: 16 }),
          el('span', {
            text: `检测到 MapleStory 客户端 — ${scan.archiveCount} 个存档，${bytes(scan.totalSize)}。` +
                  '已全部选中。',
          })));
      }

      clear(list);

      if (scan.parent) {
        list.append(row('arrowUp', '..', '上一级文件夹', () => render(scan.parent)));
      }
      for (const dir of scan.subdirectories) {
        list.append(row('folder', dir.name, '', () => render(dir.path)));
      }
      for (const group of scan.groups) {
        list.append(archiveRow(group));
      }

      if (!scan.groups.length && !scan.subdirectories.length) {
        list.append(el('div', {
          style: 'padding:28px;text-align:center;color:var(--text-3);font-size:var(--fs-13)',
          text: '此处没有 .wz、.ms 或 .img 文件或文件夹。',
        }));
      }
    } catch (error) {
      if (stale()) return;
      clear(list);
      list.append(errorRow(error.message));
    }
    if (stale()) return;
    updateSummary();
  };

  const row = (iconName, name, meta, onclick) =>
    el('button', { class: 'picker-row', onclick },
      icon(iconName, { size: 16 }),
      el('span', { class: 'name', text: name }),
      meta ? el('span', { class: 'size', text: meta }) : null);

  /** One archive family, or one standalone .img file. */
  const archiveRow = (group) => {
    const box = el('input', {
      type: 'checkbox',
      checked: selected.has(group.family),
      onclick: (event) => event.stopPropagation(),
      onchange: (event) => {
        if (event.target.checked) selected.add(group.family);
        else selected.delete(group.family);
        node.dataset.selected = event.target.checked ? 'true' : 'false';
        updateSummary();
      },
    });

    const label = group.files.length > 1
      ? `${group.family}（${group.files.length} 个分卷）`
      : group.files[0].name;

    const node = el('div', {
      class: 'picker-row',
      'data-family': group.family,
      'data-selected': selected.has(group.family) ? 'true' : 'false',
      'data-tip': group.files.map((f) => f.name).join('\n'),
      style: 'cursor:pointer',
      onclick: () => { box.checked = !box.checked; box.dispatchEvent(new Event('change')); },
    },
      box,
      icon(group.kind === 'img' ? 'image' : 'archive', { size: 16 }),
      el('span', { class: 'name', text: label }),
      el('span', { class: 'size', text: bytes(group.totalSize) }));

    return node;
  };

  const errorRow = (message) => el('div', {
    style: 'padding:20px;color:var(--red-ink);font-size:var(--fs-13)', text: message,
  });

  const updateSummary = () => {
    clear(summary);
    if (!scan?.groups.length) {
      openSelected.disabled = true;
      paintHeadroom(0);
      return;
    }

    const chosen = scan.groups.filter((g) => selected.has(g.family));
    const files = chosen.reduce((sum, g) => sum + g.files.length, 0);
    const size = chosen.reduce((sum, g) => sum + g.totalSize, 0);

    openSelected.disabled = files === 0;
    $label(openSelected).textContent = files === 0
      ? '打开所选'
      : `打开 ${files} 个文件`;

    summary.append(
      el('button', {
        class: 'btn btn-sm',
        onclick: () => { scan.groups.forEach((g) => selected.add(g.family)); refreshChecks(); },
      }, '全选'),
      el('button', {
        class: 'btn btn-sm',
        onclick: () => { selected.clear(); refreshChecks(); },
      }, '清除'),
      el('span', {
        style: 'margin-left:auto',
        text: files ? `${files} 个文件 · ${bytes(size)}` : '未选择任何内容',
      }));

    paintHeadroom(size);
  };

  /**
   * What this selection costs against what the process has, before the click.
   *
   * "Opening several 1 GB archives used to kill the process; it now refuses, but
   * the user should see the ceiling coming." This is where the ceiling is
   * visible for free: the one screen in the app that already knows how many
   * bytes are about to be asked for. The reading is the live working set from
   * /api/session/memory, so a second client opened on top of a first is measured
   * against what the first is *already* using rather than against nothing.
   *
   * Deliberately not a blocker. The archives are memory-mapped and parsed lazily,
   * so selected bytes are an upper bound and a generous one; turning a rough
   * upper bound into a refusal would stop work that would have been fine. It
   * earns its place by being a number that was previously only discoverable by
   * watching the process die.
   */
  const paintHeadroom = (selectedBytes) => {
    if (!headroom) return;
    clear(headroom);
    if (!selectedBytes || !memory) { headroom.hidden = true; return; }

    const inUseMB = memory.workingSetMB ?? 0;
    const selectedMB = selectedBytes / (1024 * 1024);
    // Not a hardware reading -- nothing in the browser can see installed RAM.
    // It is the point past which this process has historically become unhappy,
    // and it is stated as that rather than dressed up as a system fact.
    const COMFORTABLE_MB = 6000;
    const projected = inUseMB + selectedMB;
    if (projected < COMFORTABLE_MB * 0.6) { headroom.hidden = true; return; }

    headroom.hidden = false;
    headroom.dataset.tone = projected > COMFORTABLE_MB ? 'warn' : 'note';
    headroom.append(
      el('b', { text: projected > COMFORTABLE_MB ? '一次载入这么多会占用大量内存。' : '内存占用正在变大。' }),
      el('span', {
        text: `${Math.round(inUseMB).toLocaleString()} MB 已占用，` +
              `已选择 ${Math.round(selectedMB).toLocaleString()} MB。` +
              '存档按需读取，实际开销更低 — 但如果工具开始拒绝操作，请关闭存档而不是重启。',
      }));
  };

  const refreshChecks = () => {
    // Matched by the family recorded on the row. Reconstructing the label text
    // and comparing it back silently skipped anything that did not round-trip.
    [...list.querySelectorAll('.picker-row[data-family]')].forEach((node) => {
      const box = node.querySelector('input[type="checkbox"]');
      if (!box) return;
      box.checked = selected.has(node.dataset.family);
      node.dataset.selected = box.checked ? 'true' : 'false';
    });
    updateSummary();
  };

  const $label = (button) => button.querySelector('span:last-child');

  /* ---------- opening ---------- */

  const commit = async () => {
    const paths = (scan?.groups ?? [])
      .filter((g) => selected.has(g.family))
      .flatMap((g) => g.files.map((f) => f.path));

    if (!paths.length) return;
    dialog.close();

    const busy = toast(`正在打开 ${paths.length} 个文件…`, 'info');

    // Only the open itself is allowed to report "could not be opened". A throw
    // from the refresh afterwards used to claim the archives had failed when
    // they were already open.
    let result;
    try {
      result = await api.openMany(paths);
    } catch (error) {
      busy.remove();
      toastError(error, '无法打开这些文件');
      return;
    }
    busy.remove();

    for (const file of result.opened) app.rememberRecent(file.filePath);

    // One toast for every failure: the host keeps only three, so three separate
    // error toasts pushed the summary of what did open off the screen.
    if (result.failed.length) {
      toast(result.failed.map((f) => `${f.name}: ${f.message}`).join('\n'),
        'error', { title: `${result.failed.length} 个文件无法打开` });
    }

    try {
      await app.refreshFiles();
      if (result.opened.length) {
        toast(
          `已打开 ${result.opened.length} 个文件。`,
          result.failed.length ? 'warning' : 'success');
        const first = result.opened[0];
        await app.tree.expand(first.id);
        app.navigate(first.id);
      }
    } catch (error) {
      toastError(error, '文件已打开，但树无法刷新');
    }
  };

  const commitImgFolder = async () => {
    if (!scan?.path) return;
    dialog.close();
    const busy = toast('正在打开 IMG 文件夹…', 'info');
    try {
      const file = await api.openImgFolder(scan.path);
      busy.remove();
      app.rememberRecent(file.filePath);
      await app.refreshFiles();
      await app.tree.expand(file.id);
      app.navigate(file.id);
      toast(`已打开 IMG 文件夹 ${file.name}（可编辑，改动在保存时写回原文件）。`, 'success');
    } catch (error) {
      busy.remove();
      toastError(error, '无法打开该 IMG 文件夹');
    }
  };

  // In the desktop build we can offer the real Windows folder dialog, which
  // beats browsing the machine through a list every time.
  const native = window.mapleBenchDesktop
    ? el('button', {
        class: 'btn btn-primary', style: 'margin-top:10px;width:100%',
        onclick: async () => {
          try {
            const chosen = await window.mapleBenchDesktop.pickFolder('选择您的 MapleStory 文件夹');
            if (chosen) await render(chosen);
          } catch (error) {
            toastError(error, '无法打开文件夹对话框');
          }
        },
      }, icon('folderOpen', { size: 15 }), '浏览 Windows 文件夹')
    : null;

  const manual = el('input', {
    class: 'field-input no-icon',
    placeholder: '或粘贴完整路径后按 Enter',
    style: 'margin-top:10px',
  });
  manual.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !manual.value.trim()) return;
    const value = manual.value.trim();
    // A folder browses; a file opens.
    if (/\.(wz|ms|img)$/i.test(value)) { dialog.close(); app.openPath(value); }
    else render(value);
  });

  const { dialog } = modal({
    title: '打开客户端或存档',
    subtitle: '选择客户端文件夹、存档系列、独立的 .img，或挂载 IMG 文件夹。',
    width: 'min(94vw, 680px)',
    body: el('div', {}, pathBar, banner, list, summary, openImgFolder, headroom, native, manual),
    actions: [
      { label: '取消' },
      { label: '', class: 'hidden', closes: false },
    ],
    onOpen: (node) => {
      // Swap the placeholder action for the live button so its label can update.
      const foot = node.querySelector('.modal-foot');
      foot.lastChild.replaceWith(openSelected);
    },
  });

  render(startPath ?? localStorage.getItem(LAST_DIR) ?? null);
}
