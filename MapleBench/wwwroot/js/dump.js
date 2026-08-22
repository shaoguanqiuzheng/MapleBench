/**
 * The export dialog: what this node can produce, and what each of those costs.
 *
 * Every other export in this app is a verb on a menu -- "Export as JSON" -- and
 * the user finds out what it left behind by opening the file afterwards. This
 * one asks the server what the node IS first, offers only the formats that node
 * can actually produce, and prints beside each of them the sentence that says
 * what it loses. Those sentences are the feature. A list of formats without them
 * is the old menu with more rows on it.
 *
 * Two things it refuses to blur:
 *
 * A node that is a reference is not the thing it references. Where the server
 * reports a link, "the reference, as text" and "the linked picture" are shown as
 * separate, labelled choices under a heading that says they are different files,
 * because a PNG of the target written out under this node's name is a file that
 * lies about where its pixels came from -- and it is a plausible enough lie to
 * survive being put in a bug report.
 *
 * And what did not come out is always shown. A dump of real client data is
 * partial more often than it is complete -- an undecodable canvas here, a
 * dangling _outlink there -- so the issue list is printed in the summary rather
 * than folded away behind a chevron, and a one-file download that came back with
 * a non-zero X-Dump-Issues says so in a toast instead of saving quietly.
 */

import { api } from './api.js';
import { el, clear, modal, toast, toastError, fmt, skeletonRows, busyButton } from './ui.js';
import { icon } from './icons.js';

/** Remembered so the second dump of a session does not retype the folder. */
const FOLDER_KEY = 'mb.dumpFolder';

/** Fast enough that the node name under "writing" reads as movement, not a slideshow. */
const POLL_MS = 500;

/**
 * The formats whose whole point is which of two nodes they came from, and the
 * words for that. Keyed by the format ids DumpService hands out; anything not in
 * here is an ordinary format and goes in the ordinary list.
 *
 * The order of the keys is the order they are shown in: what the node says
 * first, what it points at second, its own bytes last -- reading down from the
 * least surprising answer to the most.
 */
const REFERENCE_TAGS = {
  link: '引用本身',
  'linked-png': "目标的像素",
  png: "此节点自身的像素",
  raw: "此节点自身的字节",
};

/** How a link is spelled in the file, said in words rather than in a field name. */
const LINK_KINDS = {
  uol: '一个 UOL 属性',
  _inlink: '一个 _inlink,其目标位于同一 .img 中',
  _outlink: '一个 _outlink,其目标位于另一个存档中',
};

/** The server's kind identifiers, shown to the user in Chinese. */
const KIND_LABELS = {
  Archive: '存档',
  Directory: '文件夹',
  Image: '图像',
  Sound: '声音',
  Canvas: '画布',
  Link: '链接',
  Container: '容器',
  Value: '值',
  Animation: '动画',
};

/** Issue kinds reported in a dump summary, shown in Chinese. */
const ISSUE_KIND_LABELS = {
  'canvas.undecodable': '画布无法解码',
  'link.dangling': '链接悬空',
  'link.resolved': '链接已解析',
  'budget.exhausted': '超出预算',
  'write.failed': '写入失败',
  'node.unsupported': '不支持的节点',
  'sound.empty': '声音为空',
  'name.collision': '名称冲突',
  'name.sanitised': '名称已清理',
  'csv.skipped': 'CSV 跳过',
};

/**
 * Whether the "yes, this folder, I mean it" checkbox can answer this refusal.
 *
 * The server says so in a field, because only it knows: a folder that does not
 * exist and a path Windows will not accept are walls, and offering a checkbox
 * beside them would promise a door that is not there. The sentence match is the
 * fallback for an older server only -- reading intent out of English prose is
 * exactly the coupling that breaks the day somebody improves the sentence.
 */
const overridable = (check) =>
  typeof check.overridable === 'boolean'
    ? check.overridable
    : /say explicitly that this one is intended/i.test(check.refusal ?? '');

/** Bytes as a dump is actually measured: a folder of PNGs is MB, a client is GB. */
const bytes = (n) => {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
};

const notice = (tone, glyph, title, ...lines) => el('div', { class: 'notice', 'data-tone': tone },
  icon(glyph, { size: 16 }),
  el('div', {},
    title ? el('b', { text: title }) : null,
    ...lines.filter(Boolean).map((line) => (line.nodeType ? line : el('p', { text: line })))));

/**
 * The name the server gave the file, so a blob download lands under it.
 *
 * Without this a fetch-and-save export is named after the object URL, which is a
 * GUID with no extension -- and the whole reason this path exists rather than a
 * plain navigation is to keep the download identical while reading its headers.
 */
function filenameFrom(response, fallback) {
  const header = response.headers.get('Content-Disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try { return decodeURIComponent(encoded[1]); } catch { /* fall through to the plain one */ }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : fallback;
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked late rather than immediately: a browser that has not started
  // reading the URL by the time it is revoked cancels the save outright.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Opens the export dialog for one node.
 *
 * `app` is the shell, for its download() and copyText(); `path` is the session
 * path of the node the menu was opened on.
 */
export function openExportDialog(app, path) {
  const body = el('div', { class: 'dump' });

  /** The DumpTargetDto, once /api/dump/options has answered. */
  let target = null;
  let closed = false;
  let timer = null;

  /** Where the job form, the progress bar and the summary all get painted. */
  const jobHost = el('div', { class: 'dump-job-host' });

  const job = {
    open: false,
    format: null,          // the DumpFormatDto with kind "job"
    resolveLinks: true,
    allowNonEmpty: false,
    // Only after a refusal that the checkbox can actually answer. Offering it up
    // front invites ticking it before there is anything to override.
    offerAllowNonEmpty: false,
    refusal: '',
    outputPath: '',
    progress: null,        // the last DumpProgressDto, once one has been asked for
  };

  const folderInput = el('input', {
    class: 'field-input no-icon',
    placeholder: 'C:\\dumps  — 一个空文件夹,不是你的客户端文件夹',
    spellcheck: 'false',
    value: localStorage.getItem(FOLDER_KEY) ?? '',
  });

  const { dialog } = modal({
    title: '导出',
    subtitle: path,
    width: 'min(96vw, 780px)',
    body,
    actions: [{ label: '关闭' }],
  });

  // The poll has to stop, but the dump does not: /dump/start deliberately does
  // not take the request's cancellation token, so a job survives this dialog and
  // reopening it picks the run back up where it got to.
  dialog.addEventListener('close', () => { closed = true; clearTimeout(timer); });

  body.append(skeletonRows(5));

  api.dumpOptions(path)
    .then((result) => {
      if (closed) return;
      target = result;
      job.format = result.formats.find((format) => format.kind === 'job') ?? null;
      render();
      // A dump already running from an earlier dialog, or from before a reload.
      // Only worth the extra request where this node could have started one.
      if (job.format) adoptRunningJob();
    })
    .catch((error) => {
      if (closed) return;
      clear(body);
      body.append(notice('bad', 'alert', '无法描述此节点',
        error.message, error.detail));
    });

  /* ============================================================
     THE STATIC HALF -- painted once, when the options land
     ============================================================ */

  function render() {
    clear(body);
    body.append(head());
    if (target.link) body.append(linkNotice(target.link));

    const referenced = target.link
      ? Object.keys(REFERENCE_TAGS)
          .map((id) => target.formats.find((format) => format.id === id))
          .filter(Boolean)
      : [];
    const rest = target.formats.filter((format) => !referenced.includes(format));

    if (referenced.length) {
      body.append(group(
        '这些不是同一个文件',
        '每一项都会在此节点的名称下导出不同的内容。请选择你真正想要的那一项。',
        referenced.map((format) => formatRow(format, REFERENCE_TAGS[format.id]))));
    }

    // Recommended first, and otherwise the order the server chose -- it puts the
    // format that fits this node kind ahead of the general ones already.
    const ordered = [...rest].sort((a, b) => Number(b.recommended) - Number(a.recommended));
    if (ordered.length) {
      body.append(group(
        referenced.length ? '其他格式' : null, null,
        ordered.map((format) => formatRow(format))));
    }

    renderJob();
  }

  function head() {
    const facts = [];
    if (target.width || target.height) facts.push(`${target.width}x${target.height}`);
    if (target.frames) facts.push(`${target.frames} 帧`);
    if (target.totalMs) facts.push(`${fmt.format(target.totalMs)} ms`);
    if (target.canvasFormat) facts.push(target.canvasFormat);
    if (target.soundMs) facts.push(`${(target.soundMs / 1000).toFixed(1)} 秒音频`);
    if (target.soundExtension) facts.push(target.soundExtension);
    facts.push(KIND_LABELS[target.typeName] ?? target.typeName);

    return el('div', { class: 'dump-head' },
      el('div', { class: 'dump-head-top' },
        el('span', { class: 'dump-kind', text: KIND_LABELS[target.kind] ?? target.kind }),
        el('code', { class: 'dump-path', text: target.path })),
      target.note ? el('p', { class: 'dump-note', text: target.note }) : null,
      el('div', { class: 'dump-facts' },
        facts.map((fact) => el('span', { class: 'dump-fact', text: fact }))));
  }

  function linkNotice(link) {
    const where = link.resolves
      ? el('p', {},
          el('span', { text: '它解析到 ' }),
          el('code', { text: link.targetPath ?? '' }),
          el('span', {
            text: `${link.targetKind ? ` (${link.targetKind})` : ''}。导出该目标会作为单独选项列在下方——`
                + '生成的文件会将目标的内容保存在此节点的名称下,在它作为证据出现在某处之前,'
                + '这一点值得了解。',
          }))
      : el('p', {
          text: link.note
            ? `它无法解析:${link.note} 没有可导出的像素,因此只能写出引用本身。`
            : '它无法解析,因此其后没有像素。只能写出引用本身。',
        });

    return el('div', { class: 'notice dump-link', 'data-tone': link.resolves ? 'warn' : 'bad' },
      icon('externalLink', { size: 16 }),
      el('div', {},
        el('b', {
          text: link.resolves
            ? '此节点是引用,而非其指向的对象。'
            : '此节点是引用,但它不指向任何内容。',
        }),
        el('p', {},
          el('span', { text: `存储为 ${LINK_KINDS[link.kind] ?? link.kind}。它记录 ` }),
          el('code', { text: link.text }),
          el('span', { text: '。' })),
        where));
  }

  const group = (title, sub, rows) => el('div', { class: 'dump-group' },
    title ? el('h3', { class: 'dump-group-title', text: title }) : null,
    sub ? el('p', { class: 'dump-group-sub', text: sub }) : null,
    ...rows);

  function formatRow(format, tag) {
    const isJob = format.kind === 'job';

    const button = el('button', {
      class: `btn btn-sm ${format.recommended ? 'btn-primary' : ''}`.trim(),
      onclick: () => {
        if (isJob) { job.open = !job.open; renderJob(); return; }
        startDownload(format, button);
      },
    },
      icon(isJob ? 'folderOpen' : 'download', { size: 14 }),
      el('span', { text: isJob ? '设置…' : '下载' }));

    const row = el('div', {
      class: 'dump-format',
      'data-recommended': format.recommended ? 'true' : null,
      'data-tagged': tag ? 'true' : null,
    },
      el('div', { class: 'dump-format-text' },
        el('div', { class: 'dump-format-label' },
          el('span', { text: format.label }),
          format.recommended ? el('span', { class: 'dump-tag dump-tag-rec', text: '推荐' }) : null,
          tag ? el('span', { class: 'dump-tag', text: tag }) : null),
        format.note ? el('p', { class: 'dump-format-note', text: format.note }) : null),
      button);

    // The job's form, progress and summary live under its own row rather than
    // replacing the list, so the other formats stay readable while it runs.
    return isJob ? el('div', {}, row, jobHost) : row;
  }

  /* ============================================================
     ONE-FILE DOWNLOADS
     ============================================================ */

  /**
   * Saves one format, and says what it left out.
   *
   * The /api/dump/* endpoints put the outcome in X-Dump-Issues and friends,
   * which a plain navigation cannot read -- so those are fetched and saved from
   * a blob. Everything else (the /api/export/* ZIPs, which can be a whole
   * archive) goes to the browser untouched, because holding a multi-gigabyte ZIP
   * in a tab to read three headers off it is not a trade worth making.
   */
  async function startDownload(format, button) {
    if (!format.url) return;

    if (!format.url.startsWith('/api/dump/')) {
      app.download(format.url);
      return;
    }

    const restore = busyButton(button, '导出中…');
    try {
      const response = await api.dumpDownload(format.url);
      const issues = Number(response.headers.get('X-Dump-Issues') ?? '0');
      const truncated = response.headers.get('X-Dump-Truncated') === 'true';
      const note = response.headers.get('X-Dump-Note') ?? '';
      const name = filenameFrom(response, `${target.name || 'export'}`);

      saveBlob(await response.blob(), name);

      if (issues > 0) {
        toast(
          `${name} 已保存,但其中有 ${fmt.format(issues)} ${issues === 1 ? '项' : '项'}未能导出。${note ? ` ${note}` : ''}`,
          'warning', { title: '已保存,但不完整' });
      } else if (truncated) {
        toast(`${name} 已保存,但它提前停止了——这不是完整的节点。`, 'warning');
      } else {
        toast(`已保存 ${name}。`, 'success');
      }
    } catch (error) {
      toastError(error, '该导出未能执行');
    } finally {
      restore();
    }
  }

  /* ============================================================
     THE JOB -- a whole subtree onto disk
     ============================================================ */

  /**
   * Picks a dump back up if one is already running for THIS node.
   *
   * One dump runs at a time and it outlives the dialog that started it, so
   * reopening this must not present an empty form for a job already underway.
   * A run for a different node is deliberately not adopted: showing another
   * node's progress under this node's heading is the same substitution the rest
   * of this screen is built to refuse, and /dump/start says so plainly enough
   * when the user presses the button anyway.
   */
  async function adoptRunningJob() {
    let snapshot;
    try { snapshot = await api.dumpProgress(); } catch { return; }
    if (closed || snapshot.state !== 'running' || snapshot.node !== path) return;
    job.open = true;
    job.progress = snapshot;
    renderJob();
    poll();
  }

  function renderJob() {
    clear(jobHost);
    if (!job.open || !job.format) return;

    const state = job.progress?.state;
    if (state === 'running') { jobHost.append(runningView()); return; }
    if (state === 'done' || state === 'cancelled') { jobHost.append(summaryView()); return; }
    if (state === 'failed') { jobHost.append(failedView()); return; }
    jobHost.append(formView());
  }

  function formView() {
    // No separate "already submitting" flag: busyButton disables this one for
    // the life of the call, and a flag that outlives the render it disabled is
    // how a button ends up permanently dead after a refusal.
    const start = el('button', {
      class: 'btn btn-primary',
      onclick: () => submit(start),
    }, icon('download', { size: 15 }), el('span', { text: '开始转储' }));

    const resolve = el('input', {
      type: 'checkbox', checked: job.resolveLinks,
      onchange: (event) => { job.resolveLinks = event.target.checked; },
    });

    const allow = el('input', {
      type: 'checkbox', checked: job.allowNonEmpty,
      onchange: (event) => { job.allowNonEmpty = event.target.checked; },
    });

    // The desktop build can open the real Windows folder dialog. In a browser
    // there is no way to turn a picked folder into a server-side path, so the
    // field is the whole answer and the button is not offered at all.
    const browse = window.mapleBenchDesktop
      ? el('button', {
          class: 'btn btn-sm',
          onclick: async () => {
            try {
              const chosen = await window.mapleBenchDesktop.pickFolder('转储文件要放到哪里?');
              if (chosen) folderInput.value = chosen;
            } catch (error) {
              toastError(error, '无法打开文件夹对话框');
            }
          },
        }, icon('folder', { size: 14 }), '浏览')
      : null;

    return el('div', { class: 'dump-form' },
      el('div', { class: 'dump-field' },
        el('label', { class: 'dump-label', text: '转储文件夹的创建位置' }),
        el('div', { class: 'dump-row' }, folderInput, browse),
        el('p', { class: 'dump-hint',
          text: '其中会创建一个以此节点命名的子文件夹。你指定的文件夹不会被清空,'
              + '新子文件夹之外的任何内容都不会被改动。' })),

      el('div', { class: 'dump-field' },
        el('label', { class: 'check-row' }, resolve,
          el('span', { text: '跟随 _inlink、_outlink 和 UOL 并写入目标的像素' })),
        el('p', { class: 'dump-hint',
          text: '以这种方式写入的每个文件都会在文件夹的 JSON 附属文件中标记为已解析,'
              + '因此来自其他位置的图片仍可追溯到它的真实来源。关闭此选项后,引用将按引用记录,'
              + '不会为其写入像素。' })),

      job.offerAllowNonEmpty
        ? el('div', { class: 'dump-field' },
            el('label', { class: 'check-row' }, allow,
              el('span', { text: '我知道该文件夹不为空——仍然写入其中' })),
            el('p', { class: 'dump-hint',
              text: '其中已有的同名文件将被覆盖。其余内容保持不变,与转储内容混在一起。' }))
        : null,

      job.refusal
        ? notice('warn', 'alert', '该目标被拒绝', job.refusal)
        : null,

      el('div', { class: 'dump-actions' }, start));
  }

  /**
   * Preflight, then start. Two calls rather than one so a refusal lands next to
   * the folder that caused it instead of after the button has already been
   * pressed on something that was never going to run.
   */
  async function submit(button) {
    const outputDir = folderInput.value.trim();
    if (!outputDir) {
      job.refusal = '未指定目标文件夹。';
      renderJob();
      return;
    }

    const request = {
      path,
      outputDir,
      format: job.format.job ?? 'tree',
      resolveLinks: job.resolveLinks,
      allowNonEmpty: job.allowNonEmpty,
      // 0 means "the server's own limit", which is 400,000 nodes. A dump that
      // hits it stops and says so in the result rather than ending quietly.
      maxNodes: 0,
    };

    const restore = busyButton(button, '正在检查文件夹…');
    try {
      const check = await api.dumpPreflight(request);
      if (closed) return;

      if (!check.ok) {
        job.refusal = check.refusal ?? '该目标被拒绝。';
        // Grown only by a refusal the checkbox can actually answer; the rest
        // are walls, not doors.
        if (overridable(check)) job.offerAllowNonEmpty = true;
        renderJob();
        return;
      }

      job.refusal = '';
      job.outputPath = check.outputPath ?? '';
      localStorage.setItem(FOLDER_KEY, outputDir);

      job.progress = await api.dumpStart(request);
      if (closed) return;
      renderJob();
      poll();
    } catch (error) {
      if (closed) return;
      // A rejected start is a sentence worth reading twice -- "a dump of X is
      // already running" is the common one -- so it goes inline as well as in a
      // toast, where the next render will not eat it.
      job.refusal = error.detail ? `${error.message} ${error.detail}` : error.message;
      renderJob();
      toastError(error, '转储未能启动');
    } finally {
      restore();
    }
  }

  function poll() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (closed) return;
      try {
        job.progress = await api.dumpProgress();
      } catch {
        // One failed poll is not a reason to abandon a run that may be minutes
        // long; the app's own error handling reports a server that has gone.
        poll();
        return;
      }
      if (closed) return;
      if (job.progress.state === 'running') poll();
      renderJob();
    }, POLL_MS);
  }

  async function cancel(button) {
    const restore = busyButton(button, '正在停止…');
    try {
      job.progress = await api.dumpCancel();
    } catch (error) {
      toastError(error, '无法请求停止转储');
    } finally {
      restore();
      renderJob();
    }
  }

  function runningView() {
    const p = job.progress;
    // Total is 0 until the walk has counted the tree, which for an archive is
    // most of the run -- so the bar says "moving" rather than inventing a share.
    const known = p.total > 0;
    const share = known ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;

    const stop = el('button', {
      class: 'btn', disabled: p.cancelling,
      onclick: () => cancel(stop),
    }, icon('close', { size: 14 }),
       el('span', { text: p.cancelling ? '正在停止…' : '停止' }));

    return el('div', { class: 'dump-progress' },
      el('div', { class: 'dump-progress-head' },
        el('b', { text: p.stage || '处理中' }),
        el('span', { class: 'dump-secs', text: `${p.seconds.toFixed(0)} 秒` })),
      el('div', { class: 'dump-bar', 'data-unknown': known ? null : 'true' },
        el('div', { class: 'dump-bar-fill', style: known ? `width:${share}%` : null })),
      el('code', { class: 'dump-current', text: p.current || p.node || '' }),
      el('p', { class: 'dump-hint',
        text: known
          ? `已写入 ${fmt.format(p.done)} 个节点,共 ${fmt.format(p.total)} 个。`
          : `目前已完成 ${fmt.format(p.done)} 个节点。没有百分比,因为服务器在遍历 WZ 树之前不会计数——`
            + '编造一个百分比比没有更糟。' }),
      p.cancelling
        ? el('p', { class: 'dump-hint',
            text: '正在节点之间停止。已写入的内容会保留,摘要将说明进展到哪里。' })
        : null,
      el('div', { class: 'dump-actions' }, stop),
      el('p', { class: 'dump-hint',
        text: '关闭此窗口不会停止转储。重新打开此对话框可再次查看。' }));
  }

  function failedView() {
    return el('div', { class: 'dump-progress' },
      notice('bad', 'alert', '转储已停止',
        job.progress.message || '未报告原因。'),
      el('div', { class: 'dump-actions' }, againButton()));
  }

  /**
   * What landed, and what did not.
   *
   * The issue list is the reason this screen exists, so it is printed rather
   * than summarised: a count on its own ("3 issues") is a number the reader
   * cannot act on, and the three lines behind it name the exact nodes to go and
   * look at. It only collapses when there are enough of them to bury the counts
   * above it, and even then it says how many and of what kind.
   */
  function summaryView() {
    const p = job.progress;
    const result = p.result;
    const cancelled = p.state === 'cancelled';

    if (!result) {
      return el('div', { class: 'dump-progress' },
        notice(cancelled ? 'warn' : 'info', 'info',
          cancelled ? '转储已停止' : '转储已完成',
          p.message || '未生成报告。'),
        el('div', { class: 'dump-actions' }, againButton()));
    }

    const where = result.outputPath ?? job.outputPath;
    const counts = [
      ['文件', fmt.format(result.files)],
      ['磁盘占用', bytes(result.bytes)],
      ['画布', fmt.format(result.canvases)],
      ['声音', fmt.format(result.sounds)],
      ['节点', fmt.format(result.nodes)],
      // Named the long way round because the short way ("Links 812") reads as
      // 812 links exported, which is the opposite of what happened to them.
      ['未跟随的链接', fmt.format(result.linksRecorded)],
    ];

    return el('div', { class: 'dump-progress' },
      notice(cancelled ? 'warn' : 'good', cancelled ? 'alert' : 'check',
        cancelled ? '中途停止——已写入的内容仍然存在' : '已写入',
        where ? el('p', {}, el('code', { text: where })) : null,
        cancelled
          ? '这是部分转储。以下内容都是它在停止前完成的。'
          : null),

      el('div', { class: 'dump-counts' },
        counts.map(([label, value]) => el('div', { class: 'dump-count' },
          el('span', { class: 'dump-count-n', text: value }),
          el('span', { class: 'dump-count-l', text: label })))),

      result.truncated
        ? notice('warn', 'alert', '此转储不是完整的节点',
            result.truncatedReason || '它在节点耗尽之前因达到限制而停止。')
        : null,

      issuesView(result.issues ?? []),

      el('div', { class: 'dump-actions' },
        where
          ? el('button', { class: 'btn btn-sm', onclick: () => app.copyText(where) },
              icon('copy', { size: 14 }), '复制文件夹路径')
          : null,
        againButton()));
  }

  function issuesView(issues) {
    if (!issues.length) {
      return el('p', { class: 'dump-hint dump-clean',
        text: '没有跳过任何内容:此处的每个节点都生成了一个文件或附属条目。' });
    }

    const kinds = new Map();
    for (const issue of issues) kinds.set(issue.kind, (kinds.get(issue.kind) ?? 0) + 1);
    const breakdown = [...kinds].map(([kind, n]) => `${ISSUE_KIND_LABELS[kind] ?? kind} ${n}`).join(' · ');

    const details = el('details', { class: 'dump-issues' },
      el('summary', {},
        el('span', { class: 'dump-issues-n', text: fmt.format(issues.length) }),
        el('span', {
          text: `${issues.length === 1 ? '项' : '项'}未能导出`
              + `${breakdown ? ` — ${breakdown}` : ''}`,
        })),
      el('table', { class: 'table dump-issue-table' },
        el('tbody', {}, issues.map((issue) => el('tr', {},
          el('td', {}, el('span', { class: 'dump-issue-kind', text: ISSUE_KIND_LABELS[issue.kind] ?? issue.kind })),
          el('td', {}, el('code', { text: issue.path })),
          el('td', { text: issue.reason }))))));

    // Open unless the list is long enough to push the counts and the folder path
    // off the top of a modal that is already scrolling.
    if (issues.length <= 25) details.open = true;
    return details;
  }

  const againButton = () => el('button', {
    class: 'btn btn-sm',
    onclick: () => { job.progress = null; job.refusal = ''; renderJob(); },
  }, icon('refresh', { size: 14 }), '在此转储其他内容');
}
