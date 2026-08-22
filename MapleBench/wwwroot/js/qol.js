/**
 * Quality-of-life layer: the things that turn a working editor into one you can
 * spend a day in.
 *
 * Changes drawer, pinned nodes, find & replace, multi-select bulk edit,
 * resizable + remembered panels, and session restore.
 */

import { api } from './api.js';
import { el, $, clear, toast, toastError, fmt, modal, confirmDialog, humanContext } from './ui.js';
import { emptyState } from './inspector.js';
import { icon } from './icons.js';

const STORE = {
  pins: 'mb.pins',
  layout: 'mb.layout',
  session: 'mb.session',
};

/* ============================================================
   PINNED NODES
   ============================================================ */

export class Pins {
  constructor(app) {
    this.app = app;
    this.items = this.load();
  }

  /**
   * Pins are stored against the archive's absolute path, never the session id.
   *
   * "f1" is assigned in the order files happen to be opened, so a pin saved as
   * "f1/Achievement/1378.img" pointed at whatever archive was opened first next
   * time — usually a different one, occasionally a node that exists in both and
   * holds something else entirely.
   */
  load() {
    let stored;
    try { stored = JSON.parse(localStorage.getItem(STORE.pins) || '[]'); }
    catch { return []; }
    if (!Array.isArray(stored)) return [];

    let migrated = false;
    const items = stored.map((pin) => {
      if (pin.subPath !== undefined) return pin;
      // Legacy shape: {path: "f1/a/b", filePath, label, file}. Drop the session
      // id and keep the rest of the path, which is the part that is stable.
      migrated = true;
      const path = String(pin.path ?? '');
      const cut = path.indexOf('/');
      return {
        filePath: pin.filePath ?? null,
        subPath: cut < 0 ? '' : path.slice(cut + 1),
        label: pin.label ?? '',
        file: pin.file ?? '',
      };
    }).filter((pin) => pin.filePath || pin.subPath);

    this.items = items;
    if (migrated) this.save();
    return items;
  }

  save() { localStorage.setItem(STORE.pins, JSON.stringify(this.items.slice(0, 200))); }

  /** The live session path for a pin, or null when its archive is not open. */
  resolve(pin) {
    const file = this.app.files.find((f) => f.filePath === pin.filePath)
      // A pin saved before the file path was recorded can still be matched by
      // name; it is a guess, but a better one than a positional id.
      ?? (pin.filePath ? null : this.app.files.find((f) => f.name === pin.file));
    if (!file) return null;
    return pin.subPath ? `${file.id}/${pin.subPath}` : file.id;
  }

  /** Splits a live session path into the parts worth persisting. */
  describe(path) {
    const cut = path.indexOf('/');
    const fileId = cut < 0 ? path : path.slice(0, cut);
    const file = this.app.files.find((f) => f.id === fileId);
    return {
      filePath: file?.filePath ?? null,
      subPath: cut < 0 ? '' : path.slice(cut + 1),
      file: file?.name ?? fileId,
    };
  }

  find(path) {
    const { filePath, subPath } = this.describe(path);
    return this.items.find((p) => p.subPath === subPath
      && (p.filePath === filePath || (!p.filePath && !filePath)));
  }

  has(path) { return Boolean(this.find(path)); }

  toggle(path, label) {
    const existing = this.find(path);
    if (existing) {
      this.items = this.items.filter((p) => p !== existing);
      toast('已取消固定。', 'info');
    } else {
      const { filePath, subPath, file } = this.describe(path);
      this.items.unshift({
        filePath,
        subPath,
        label: label || decodeURIComponent(path.split('/').pop()),
        file,
      });
      toast('已固定。', 'success');
    }
    this.save();
    return this.has(path);
  }

  render(host) {
    clear(host);
    if (!this.items.length) {
      host.append(emptyState('star', '未固定任何内容',
        '在节点上按 Ctrl D,或使用其右键菜单,即可一键访问。'));
      return;
    }

    for (const pin of this.items) {
      const target = this.resolve(pin);
      const subtitle = target
        ? pin.file
        : `${pin.file} · 未打开`;

      host.append(el('div', {
        style: 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:var(--r-sm)',
        onmouseenter: (e) => { e.currentTarget.style.background = 'var(--bg-hover)'; },
        onmouseleave: (e) => { e.currentTarget.style.background = 'transparent'; },
      },
        el('button', {
          style: 'flex:1;text-align:left;border:0;background:transparent;font-size:var(--fs-13);overflow:hidden;' +
                 `color:var(--text-${target ? '1' : '3'})`,
          // A pin whose archive is closed says so rather than failing on click.
          title: target ? decodeURIComponent(target) : `打开 ${pin.filePath ?? pin.file} 以使用此固定项。`,
          onclick: () => {
            const live = this.resolve(pin);
            if (live) this.app.navigate(live);
            else toast(`${pin.file} 未打开。`, 'warning');
          },
        },
          el('div', { style: 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: pin.label }),
          el('div', { style: 'font-size:var(--fs-10);color:var(--text-3)', text: subtitle })),
        el('button', {
          class: 'btn btn-sm btn-icon btn-ghost', 'data-tip': '取消固定',
          onclick: () => {
            this.items = this.items.filter((p) => p !== pin);
            this.save();
            toast('已取消固定。', 'info');
            this.render(host);
          },
        }, icon('close', { size: 13 }))));
    }
  }
}

/* ============================================================
   CHANGES DRAWER
   ============================================================ */

export async function renderChanges(host, app) {
  clear(host);
  host.append(el('div', { class: 'skeleton skeleton-row', style: 'width:70%' }));

  let data;
  let history = null;
  try {
    // Asked for together because the two answer different halves of the same
    // question and either alone can be read as "nothing happened" -- see the
    // structural-change note below.
    [data, history] = await Promise.all([api.changes(), api.history().catch(() => null)]);
  } catch (error) {
    clear(host);
    host.append(emptyState('alert', '无法读取更改', error.message));
    return;
  }

  clear(host);
  if (!data.files.length) {
    host.append(emptyState('check', '无未保存的更改',
      '磁盘上的内容与当前显示完全一致。'));
    return;
  }

  // What is pending, in words, above the per-archive rows.
  //
  // This panel used to be able to say only "N images", and an edit that changes
  // an archive's *structure* -- deleting a node, adding one, renaming, moving --
  // dirties no image at all. So deleting a directory produced a drawer headed
  // "Etc.wz  0 images" with a live Save button beside it and nothing listed
  // underneath: the one screen whose entire job is to say what will be written
  // reported a zero, which reads as "nothing will be", next to a button that
  // would have written the deletion. Undo depth is the count that is never zero
  // when something is pending, so it leads.
  if (history?.undoDepth) {
    host.append(el('div', {
      style: 'display:flex;align-items:baseline;gap:6px;padding:8px 8px 2px;font-size:var(--fs-11);color:var(--text-2)',
    },
      el('b', { text: `${fmt.format(history.undoDepth)} 项更改尚未写入` }),
      history.nextUndo
        ? el('span', { style: 'color:var(--text-3)', text: `· 上一步为“${history.nextUndo}”` })
        : null));
  }

  for (const entry of data.files) {
    // The server counts both halves of "unsaved" and says so in changeCount:
    // changed images plus the structural edits no image flag reports. This
    // panel used to count the rows it had -- entry.images -- which is the
    // capped list of one half, so a deleted directory was headed "0 images"
    // beside a live Save button that would have written the deletion.
    const listed = entry.images.length + (entry.nodes?.length ?? 0);
    const count = entry.changeCount ?? listed;
    host.append(el('div', {
      style: 'display:flex;align-items:center;gap:6px;padding:8px;font-weight:700;font-size:var(--fs-12)',
    },
      el('span', { text: entry.file.name }),
      el('span', {
        style: 'color:var(--text-3);font-weight:500',
        title: entry.structuralEdits
          ? `其中 ${entry.structuralEdits} 项为添加、移除、重命名或移动的节点。这些更改位于 `
            + '存档结构中,而非图像内部;无论哪种情况,保存时都会重写整个存档。'
          : null,
        // Never zero while the archive is dirty: unlistedChanges covers the
        // case where the work is real and cannot be enumerated, and it gets a
        // line of its own below rather than a count that reads as "nothing".
        text: entry.unlistedChanges
          ? '未保存的工作'
          : `${fmt.format(count)} 项更改`,
      }),
      el('button', {
        class: 'btn btn-sm btn-primary', style: 'margin-left:auto', text: '保存',
        // Dead for the length of the write: the row stays on screen throughout,
        // and app.runSave drops a second call rather than queueing it, so a
        // live button would just be one that does nothing when clicked.
        onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          button.textContent = '保存中…';
          try { await app.runSave([entry.file], true); }
          finally { renderChanges(host, app); }
        },
      })));

    const row = (title, target, label, glyph) => el('button', {
      style: 'display:flex;align-items:center;gap:7px;width:100%;text-align:left;' +
             'padding:5px 8px 5px 18px;font-size:var(--fs-12);color:var(--text-2);border-radius:var(--r-sm)',
      title,
      // A structural edit with no target is still worth listing -- what it was
      // is the point -- but it must not pretend to be a link to nowhere.
      onclick: target ? () => app.navigate(target) : null,
      onmouseenter: (e) => { e.currentTarget.style.background = 'var(--bg-hover)'; },
      onmouseleave: (e) => { e.currentTarget.style.background = 'transparent'; },
    }, icon(glyph, { size: 9 }), el('span', { text: label }));

    for (const image of entry.images) {
      host.append(row(image.fullPath, image.path, image.name, 'dot'));
    }

    // The other half of unsaved, and the half that was never on screen: edits
    // that changed the archive's shape. Each is one undo entry, labelled as the
    // history labels it, and it navigates to where the edit landed -- after a
    // delete that is the container, which is the only thing left to look at.
    for (const node of entry.nodes ?? []) {
      host.append(row(
        node.paths?.length ? decodeURIComponent(node.paths[0]) : '无可跳转目标',
        node.paths?.[0] || null, node.label, 'edit'));
    }

    if (entry.unlistedChanges) {
      host.append(el('div', {
        style: 'padding:2px 8px 6px 18px;font-size:var(--fs-11);color:var(--text-3)',
        text: '此存档有无法列出的未保存工作——早于撤销历史的编辑,或未记录撤销条目的编辑。保存会写入;关闭会丢失。',
      }));
    }

    // Both lists are capped server-side; the count above them is not.
    if (count > listed) {
      host.append(el('div', {
        style: 'padding:2px 8px 6px 18px;font-size:var(--fs-11);color:var(--text-3)',
        text: `显示前 ${fmt.format(listed)} 项,共 ${fmt.format(count)} 项。`,
      }));
    }
  }
}

/* ============================================================
   FIND & REPLACE
   ============================================================ */

export function openFindReplace(app, scopePath) {
  const style = 'width:100%;height:34px;padding:0 10px;border:1px solid var(--border);' +
                'border-radius:var(--r-sm);background:var(--bg-field);color:var(--text-1)';

  const find = el('input', { placeholder: '搜索', style });
  const replace = el('input', { placeholder: '替换为', style });
  const scope = el('input', {
    value: scopePath ? decodeURIComponent(scopePath) : '',
    placeholder: '所有已打开的文件',
    style: style + ';font-family:var(--font-mono);font-size:var(--fs-12)',
    readonly: true,
  });
  const inValues = el('input', { type: 'checkbox', checked: true });
  const inNames = el('input', { type: 'checkbox' });
  const useRegex = el('input', { type: 'checkbox' });
  const caseSensitive = el('input', { type: 'checkbox' });
  const results = el('div', { style: 'margin-top:14px;max-height:38vh;overflow:auto' });

  let lastPreview = null;
  let previewButton = null;
  let applyButton = null;

  // One ceiling for both the preview and the apply. They used to differ (2 000
  // vs 20 000), so the confirmation asked you to approve one number and the
  // toast afterwards reported a larger one.
  const LIMIT = 5000;

  // Any change to the terms invalidates the preview. Without this you could
  // preview one replace, retype the search, and then be asked to confirm the
  // old count for a completely different operation.
  const invalidate = () => { lastPreview = null; syncApplyButton(); };
  for (const control of [find, replace, inValues, inNames, useRegex, caseSensitive]) {
    control.addEventListener('input', invalidate);
    control.addEventListener('change', invalidate);
  }

  const body = () => ({
    path: scopePath || null,
    find: find.value,
    replace: replace.value,
    inValues: inValues.checked,
    inNames: inNames.checked,
    regex: useRegex.checked,
    caseSensitive: caseSensitive.checked,
  });

  // Both actions are async and both used to be clickable throughout, so a
  // double-click sent a second replace while the first was still running.
  let busy = false;
  const setBusy = (state, label) => {
    busy = state;
    if (previewButton) {
      previewButton.disabled = state;
      previewButton.textContent = state && label === 'preview' ? '预览中…' : '预览';
    }
    syncApplyButton();
  };

  // "Replace all" stays disabled until there is something to apply, rather
  // than accepting the click and answering with "preview first".
  const syncApplyButton = () => {
    if (!applyButton) return;
    const ready = !busy && Boolean(lastPreview?.changed.length);
    applyButton.disabled = !ready;
    applyButton.title = ready
      ? ''
      : (busy ? '处理中…' : '请先预览,以查看将要更改的内容。');
  };

  const preview = async () => {
    if (busy) return;
    if (!find.value) { toast('请输入要搜索的内容。', 'warning'); return; }
    setBusy(true, 'preview');
    clear(results);
    results.append(el('div', { class: 'skeleton skeleton-row', style: 'width:60%' }));
    try {
      const data = await api.replace({ ...body(), dryRun: true, limit: LIMIT });
      lastPreview = data;
      clear(results);

      if (!data.changed.length) {
        results.append(el('div', {
          style: 'padding:20px;text-align:center;color:var(--text-3);font-size:var(--fs-13)',
          text: `没有与“${find.value}”匹配的内容。`,
        }));
        return;
      }

      results.append(el('div', {
        style: 'font-size:var(--fs-12);color:var(--text-2);margin-bottom:8px;font-weight:600',
        text: `${fmt.format(data.changed.length)} 项更改将被执行`,
      }));

      // The ceiling, said before the write rather than discovered after it.
      //
      // "(list truncated)" was doing two jobs badly. The limit is not a display
      // cap -- the apply passes the same LIMIT -- so a truncated preview means
      // the replace itself stops at 5,000 and leaves every later match alone,
      // and the toast afterwards says "Replaced 5000 values" with no hint that
      // it is a partial job. A replace you believe finished and did not is the
      // worst outcome this dialog has, so it is stated here, in the preview,
      // where the decision is actually made.
      if (data.truncated) {
        results.append(el('div', {
          style: 'margin-bottom:10px;padding:8px 10px;border-radius:var(--r-sm);' +
                 'border:1px solid var(--warn-border,var(--border));background:var(--warn-bg,var(--bg-subtle));' +
                 'font-size:var(--fs-11);line-height:1.5;color:var(--text-2)',
        },
          el('b', { text: `匹配结果超过 ${fmt.format(LIMIT)} 项。` }),
          ' 现在替换会更改前 ',
          el('b', { text: fmt.format(data.changed.length) }),
          ' 项,其余保持原样。请将范围缩小到一个存档或一个分支后重试,' +
          '或重复运行,直到数量回落到上限以下。'));
      }

      for (const hit of data.changed.slice(0, 300)) {
        results.append(el('div', {
          style: 'padding:5px 8px;border-bottom:1px solid var(--border-subtle);font-size:var(--fs-12);cursor:pointer',
          onclick: () => { dialog.close(); app.navigate(hit.path); },
        },
          el('div', { style: 'font-weight:600', text: hit.name }),
          el('div', { style: 'color:var(--text-3);font-family:var(--font-mono);font-size:var(--fs-11)', text: hit.value }),
          el('div', { style: 'color:var(--text-3);font-size:var(--fs-10)', text: humanContext(hit.context) })));
      }
      if (data.changed.length > 300) {
        results.append(el('div', {
          style: 'padding:8px;font-size:var(--fs-11);color:var(--text-3)',
          // A list that silently stops at 300 of 4,000 invites the reading that
          // 300 is the whole job.
          text: `显示前 300 项,共 ${fmt.format(data.changed.length)} 项。全部 ${fmt.format(data.changed.length)} 项都会被替换。`,
        }));
      }
    } catch (error) {
      clear(results);
      results.append(el('div', { style: 'padding:16px;color:var(--red-ink)', text: error.message }));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (busy || !lastPreview?.changed.length) return;

    const ok = await confirmDialog({
      title: `应用 ${fmt.format(lastPreview.changed.length)} 项更改?`,
      message: (lastPreview.truncated
        ? `这是超出上限的匹配中的前 ${fmt.format(lastPreview.changed.length)} 项。` +
          '其余保持原样,此对话框无法告知其数量。'
        : '') +
        '保存之前不会写入磁盘。整个替换将记录为单步撤销。',
      confirmLabel: '全部替换',
      danger: Boolean(lastPreview.truncated),
    });
    if (!ok) return;

    setBusy(true, 'apply');
    try {
      const data = await api.replace({ ...body(), dryRun: false, limit: LIMIT });
      dialog.close();
      // Reported as what happened, including the part that did not: a bare
      // "Replaced 5000 values." after a capped run is a success message for a
      // job that stopped half-way.
      if (data.truncated) {
        toast(`已替换 ${fmt.format(data.changed.length)} 个值——已达上限。` +
              '仍有更多匹配未处理;再次运行以继续。',
        'warning', { title: '部分替换' });
      } else {
        toast(`已替换 ${fmt.format(data.changed.length)} 个值。`, 'success');
      }
      if (scopePath) {
        app.afterStructureChange(scopePath);
      } else {
        // Session-wide replace has no single path to invalidate, and without
        // this the tree kept rendering the pre-replace values.
        app.tree.invalidateAll();
        app.markDirty();
        if (app.mode === 'explorer') app.inspector.refresh();
        else app.shop.load();
      }
    } catch (error) {
      toastError(error, '替换失败');
    } finally {
      setBusy(false);
    }
  };

  find.addEventListener('keydown', (e) => { if (e.key === 'Enter') preview(); });

  const { dialog } = modal({
    title: '搜索和替换',
    width: '640px',
    body: el('div', {},
      el('label', { style: 'font-size:var(--fs-11);font-weight:600;color:var(--text-2)', text: '范围' }),
      scope,
      el('div', { style: 'height:10px' }),
      find,
      el('div', { style: 'height:8px' }),
      replace,
      el('div', { style: 'display:flex;gap:16px;flex-wrap:wrap;margin-top:12px' },
        el('label', { class: 'check-row' }, inValues, '值'),
        el('label', { class: 'check-row' }, inNames, '名称'),
        el('label', { class: 'check-row' }, useRegex, '正则'),
        el('label', { class: 'check-row' }, caseSensitive, '区分大小写')),
      results),
    actions: [
      { label: '取消' },
      { label: '预览', run: () => { preview(); return false; }, closes: false },
      { label: '全部替换', class: 'btn-primary', run: () => { apply(); return false; }, closes: false },
    ],
    // The dialog argument, not the `dialog` const below: onOpen runs inside
    // modal(), before the destructuring assignment has happened.
    onOpen: (host) => {
      find.focus();
      const buttons = [...host.querySelectorAll('.modal-foot button')];
      previewButton = buttons.find((b) => b.textContent.startsWith('预览')) ?? null;
      applyButton = buttons.find((b) => b.classList.contains('btn-primary')) ?? null;
      syncApplyButton();
    },
  });
}

/* ============================================================
   MULTI-SELECT BULK EDIT
   ============================================================ */

/**
 * Bulk edit as an *operation*, not a literal.
 *
 * The dialog this replaces wrote one typed string to every selected node, which
 * is the wrong shape for the job it is reached for. Rebalancing is the most
 * repeated numeric task in WZ work and it is almost never "make these all the
 * same"; it is "make this range 15% stronger", which has to preserve the spread
 * the original data has. See MapleBench/Services/ValueMath.cs for the grammar.
 *
 * A literal typed into this box still means exactly what it always meant, so
 * nobody's habit breaks — "150" is still "set them all to 150".
 *
 * The preview is a real dry run against the server, not a client-side guess.
 * Both buttons hit POST /api/node/compute and differ only in `dryRun`, so the
 * before -> after table you approve is produced by the code that does the
 * writing. Computing it twice, in two languages, is how an editor ends up
 * showing "15 -> 23" and storing something else — and this one writes to files
 * people cannot get back.
 */
export function openBulkEdit(app, paths) {
  const expression = el('input', {
    placeholder: '*1.5   +50   -10%   clamp 1 999   =150',
    style: 'width:100%;height:36px;padding:0 12px;border:1px solid var(--border);' +
           'border-radius:var(--r-sm);background:var(--bg-field);color:var(--text-1);' +
           'font-family:var(--font-mono)',
  });

  const preview = el('div', { style: 'margin-top:12px;max-height:34vh;overflow:auto' });
  let planned = null;      // the dry run the Apply button is allowed to commit
  let applyButton = null;
  let busy = false;

  // Any edit to the expression invalidates the plan. Without this you could
  // preview "*2", retype "*10", and be shown one set of numbers while applying
  // another — the same trap openFindReplace guards above.
  const invalidate = () => { planned = null; syncApply(); };
  expression.addEventListener('input', invalidate);

  const syncApply = () => {
    if (!applyButton) return;
    const ready = !busy && planned !== null && planned.changed > 0;
    applyButton.disabled = !ready;
    applyButton.textContent = ready ? `应用到 ${planned.changed}` : '应用';
    applyButton.title = ready
      ? planned.description
      : (busy ? '处理中…' : '请先预览,以查看将要更改的内容。');
  };

  const rowStyle = 'display:flex;align-items:baseline;gap:8px;padding:3px 6px;' +
                   'font-size:var(--fs-11);border-bottom:1px solid var(--border-subtle)';

  const renderPlan = (result) => {
    clear(preview);

    preview.append(el('div', {
      style: 'font-size:var(--fs-12);font-weight:600;margin-bottom:6px;color:var(--text-2)',
      // The count is the plan's, never the selection's. Saying "312" over 40
      // actual writes is the failure this whole path is shaped to avoid.
      text: `${result.description} · ${result.changed}/${paths.length} 项将被更改` +
            (result.skipped ? ` · 跳过 ${result.skipped} 项` : ''),
    }));

    // Changed rows first: the skipped ones are diagnostics and the changed ones
    // are the decision.
    const ordered = [...result.results].sort((a, b) => (a.skipped ? 1 : 0) - (b.skipped ? 1 : 0));

    for (const row of ordered.slice(0, 400)) {
      preview.append(el('div', { style: rowStyle, title: decodeURIComponent(row.path) },
        el('span', {
          style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
          text: row.displayName ? `${row.name} · ${row.displayName}` : row.name,
        }),
        row.skipped
          ? el('span', { style: 'color:var(--text-3)', text: row.skipped })
          : el('span', { style: 'font-family:var(--font-mono)' },
              el('span', { style: 'color:var(--text-3)', text: row.before ?? '—' }),
              el('span', { style: 'color:var(--text-3)', text: '  →  ' }),
              el('b', { text: row.after ?? '' }))));
    }

    if (ordered.length > 400) {
      preview.append(el('div', {
        style: 'padding:6px;font-size:var(--fs-11);color:var(--text-3)',
        text: `…还有 ${ordered.length - 400} 项。全部包含在内。`,
      }));
    }
  };

  const runPreview = async () => {
    if (busy) return;
    busy = true; syncApply();
    clear(preview);
    preview.append(el('div', { class: 'skeleton skeleton-row', style: 'width:60%' }));
    try {
      const result = await api.computeValues(paths, expression.value, true);
      planned = result;
      renderPlan(result);
    } catch (error) {
      planned = null;
      clear(preview);
      preview.append(el('div', { style: 'padding:12px;color:var(--red-ink)', text: error.message }));
    } finally {
      busy = false; syncApply();
    }
  };

  const apply = async () => {
    if (busy || !planned?.changed) return;
    busy = true; syncApply();
    try {
      const result = await api.computeValues(paths, expression.value, false);
      dialog.close();

      // Reported from what came back, not from what was asked for.
      if (!result.applied) {
        toast('未更改任何内容。', 'warning');
      } else if (result.skipped) {
        toast(`已更改 ${result.changed} 个值。` +
              `${result.skipped} 项未能更改,保持原样。`,
              'warning', { action: { label: '撤销', run: () => app.undo() } });
      } else {
        toast(`已更改 ${result.changed} 个值 — ${result.description}。`,
              'success', { action: { label: '撤销', run: () => app.undo() } });
      }

      app.markDirty();
      app.inspector.refresh();
      // The results panel is very often where this selection came from, and its
      // rows show the old numbers until it re-reads them.
      if (app.panel === 'results') app.results.refreshValues();
    } catch (error) {
      toastError(error, '批量编辑失败');
    } finally {
      busy = false; syncApply();
    }
  };

  expression.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    // Enter previews, then Enter applies. One key runs the whole loop without
    // ever confirming something that has not been shown first.
    if (planned?.changed) apply(); else runPreview();
  });

  const { dialog } = modal({
    title: `更改 ${paths.length} 个值`,
    width: '560px',
    body: el('div', {},
      el('p', {
        style: 'margin:0 0 10px;color:var(--text-2);font-size:var(--fs-13);line-height:1.5',
        text: '输入要对每个值执行的操作,或输入一个普通值将它们全部设为相同。' +
              '应用之前不会写入任何内容,整个更改是一个撤销步骤。',
      }),
      expression,
      el('div', {
        style: 'margin-top:8px;font-size:var(--fs-11);color:var(--text-3);line-height:1.6',
        html: '<code>+50</code> <code>-10</code> <code>*1.5</code> <code>/2</code> ' +
              '<code>+15%</code> <code>round</code> <code>floor</code> <code>ceil</code> ' +
              '<code>min 1</code> <code>max 999</code> <code>clamp 1 999</code> ' +
              '<code>=150</code> 设置字面值',
      }),
      preview),
    actions: [
      { label: '取消' },
      { label: '预览', run: () => { runPreview(); return false; }, closes: false },
      { label: '应用', class: 'btn-primary', run: () => { apply(); return false; }, closes: false },
    ],
    onOpen: (host) => {
      expression.focus();
      applyButton = [...host.querySelectorAll('.modal-foot button')]
        .find((b) => b.classList.contains('btn-primary')) ?? null;
      syncApply();
    },
  });
}

/* ============================================================
   RESIZABLE PANELS
   ============================================================ */

export function installPanelResizing() {
  const workspace = $('#workspace');
  const saved = readLayout();
  if (saved.tree) workspace.style.setProperty('--tree-w', `${saved.tree}px`);
  if (saved.inspector) workspace.style.setProperty('--inspector-w', `${saved.inspector}px`);

  addHandle($('#tree-pane'), 'right', (width) => {
    const clamped = Math.max(200, Math.min(520, width));
    workspace.style.setProperty('--tree-w', `${clamped}px`);
    writeLayout({ ...readLayout(), tree: clamped });
  });

  addHandle($('#inspector'), 'left', (width) => {
    const clamped = Math.max(300, Math.min(640, width));
    workspace.style.setProperty('--inspector-w', `${clamped}px`);
    writeLayout({ ...readLayout(), inspector: clamped });
  });
}

function addHandle(panel, side, onResize) {
  if (!panel) return;
  const handle = el('div', {
    class: 'resize-handle',
    style: `${side}:0`,
    role: 'separator',
    tabindex: '0',
    'aria-orientation': 'vertical',
    'aria-label': side === 'right' ? '调整文件面板大小' : '调整检查器面板大小',
    'data-tip': '拖动以调整大小 · 方向键同样有效',
  });
  panel.style.position = 'relative';
  panel.append(handle);

  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = panel.getBoundingClientRect().width;

    const move = (e) => {
      const delta = side === 'right' ? e.clientX - startX : startX - e.clientX;
      onResize(startWidth + delta);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });

  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const step = event.shiftKey ? 50 : 10;
    const width = panel.getBoundingClientRect().width;
    // The inspector's handle is on its left edge, so moving that edge right
    // makes the pane smaller; the tree handle on the right behaves opposite.
    onResize(width + direction * step * (side === 'right' ? 1 : -1));
  });
}

function readLayout() {
  try { return JSON.parse(localStorage.getItem(STORE.layout) || '{}'); }
  catch { return {}; }
}

function writeLayout(layout) {
  localStorage.setItem(STORE.layout, JSON.stringify(layout));
}

/* ============================================================
   SESSION RESTORE
   ============================================================ */

export function rememberSession(files) {
  localStorage.setItem(STORE.session, JSON.stringify(files.map((f) => ({
    path: f.filePath,
    mapleVersion: f.mapleVersion,
  }))));
}

export function readSession() {
  try { return JSON.parse(localStorage.getItem(STORE.session) || '[]'); }
  catch { return []; }
}

/**
 * Offers to reopen last session's files rather than doing it silently — opening
 * several large archives is slow enough that it should be the user's choice.
 */
export function offerSessionRestore(app) {
  const previous = readSession();
  if (!previous.length) return null;

  return el('button', {
    class: 'btn',
    title: previous.map((f) => f.path).join('\n'),
    text: `重新打开上次会话(${previous.length} 个文件)`,
    onclick: async () => {
      for (const entry of previous) {
        try {
          await app.openPath(entry.path, { mapleVersion: entry.mapleVersion });
        } catch { /* openPath already surfaced the failure */ }
      }
    },
  });
}
