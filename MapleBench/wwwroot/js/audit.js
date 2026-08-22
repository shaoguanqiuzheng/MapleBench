/**
 * Audit section: check a whole client on disk before the game disagrees with it.
 *
 * Built in the shape the other sections use -- one class, a head / stats /
 * toolbar / table stack, honest empty states -- with two deliberate departures,
 * both of which are the point of the screen rather than shortcuts.
 *
 * It reads a FOLDER, not the session. What the auditor checks is what a client
 * is once it is mounted: a family of archives resolving links into each other,
 * names that have to match names in a different archive. The session holds
 * whatever the user happened to open, which is usually one archive of a family,
 * and that is exactly the view that hides a shadowed image. A screen that
 * audited "what is open" would answer a different question and answer it
 * reassuringly.
 *
 * It offers to fix exactly one thing, and the shape of that exception is the
 * rule rather than a hole in it. Every other finding here is a fact whose remedy
 * is a judgement (which duplicate is the real one? should the link be repointed
 * or the target restored?) that the auditor is in no position to make and that a
 * wrong guess makes worse, so the screen's job ends at "here it is, here is what
 * it means, here is where to look".
 *
 * `canvas.row_width_zero` is different on all three counts. The damage is this
 * app's own -- a canvas format written split across the format and magnification
 * fields, fixed in the writer at 3cf73c7 and still sitting in every archive
 * written before it. The remedy is not a judgement: the two numbers add back to
 * one number, and which canvases qualify is decided by inflating the blob and
 * seeing which format its pixels are actually in, not by a guess about intent.
 * And it is verifiable -- the repaired archive is reopened and the pixels are
 * decoded before anything claims to have been repaired.
 *
 * Even so, nothing here writes to a client. The repair produces a NEW archive
 * beside the source and prints the command to install it, backup first. Copying
 * it over the archive the user plays from is the user's keystroke, not this
 * screen's button.
 */

import { api } from './api.js';
import { el, clear, toast, toastError, fmt } from './ui.js';
import { emptyState } from './inspector.js';
import { icon } from './icons.js';

const FOLDER_KEY = 'mb.auditFolder';
const POLL_MS = 700;

/** Worst first, and the order the summary chips are laid out in. */
const SEVERITIES = ['Critical', 'Error', 'Warning', 'Info'];

/** Archive sizes, in the unit a client is actually measured in. */
const gb = (bytes) => (bytes >= 1073741824
  ? `${(bytes / 1073741824).toFixed(2)} GB`
  : `${Math.max(1, Math.round(bytes / 1048576))} MB`);

/**
 * What a severity means here, in one line, on hover.
 *
 * Written out rather than left to the word because "warning" in most tools
 * means "probably fine" and half of these are not. The line is the promise the
 * check made when it fired.
 */
const SEVERITY_BLURB = {
  Critical: '客户端不可能正确:某些内容将无法加载、无法绘制,或不是你编辑过的文件。',
  Error: '确实损坏但可继续使用——指向空白的链接,解析不到任何内容的名称。',
  Warning: '可疑,或是客户端恰好容忍的规则。值得一看,以免变成更严重的问题。',
  Info: '不带判断的客观事实,包括故意未解决的问题。',
};

export class AuditSection {
  constructor({ host, app }) {
    this.host = host;
    this.app = app;

    this.folder = localStorage.getItem(FOLDER_KEY) ?? '';
    this.plan = null;
    this.progress = null;
    this.report = null;
    this.expanded = new Set();
    this.timer = null;

    // The repair is its own little machine hanging off one finding. Kept beside
    // the report rather than inside it: it re-measures the archive itself and
    // does not trust the audit's count, so its numbers are allowed to disagree
    // -- and on the client this was built against they do, because the audit
    // check fires on a symptom (a row that shifts to zero) and the repair looks
    // for the cause (a format split across two fields), which is the larger set.
    this.repair = { archive: '', progress: null, scan: null, result: null, busy: false };
    this.repairTimer = null;
  }

  async open() {
    // A sensible default the first time: the folder the session's first archive
    // came from. Guessed once and then never again -- once the user has typed a
    // folder, the remembered one wins, because a client being audited is often
    // not the client being edited.
    if (!this.folder) {
      const first = this.app.files?.[0]?.path ?? '';
      const cut = Math.max(first.lastIndexOf('\\'), first.lastIndexOf('/'));
      if (cut > 0) this.folder = first.slice(0, cut);
    }
    this.render();
    await this.refreshProgress();
    if (!this.plan && this.folder) await this.loadPlan();
  }

  refresh() { return this.open(); }

  /* ============================================================
     TALKING TO THE SERVER
     ============================================================ */

  async loadPlan() {
    try {
      this.plan = await api.auditPlan(this.folder);
      localStorage.setItem(FOLDER_KEY, this.folder);
    } catch (error) {
      this.plan = null;
      toastError(error, '无法读取该文件夹');
    }
    this.render();
  }

  async start() {
    try {
      this.report = null;
      this.progress = await api.auditStart({ folder: this.folder, maxPerCheck: 300 });
      this.poll();
    } catch (error) {
      toastError(error, '无法启动检查');
    }
    this.render();
  }

  async cancel() {
    try { this.progress = await api.auditCancel(); } catch { /* the poll re-reads it */ }
    this.render();
  }

  poll() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refreshProgress(), POLL_MS);
  }

  /* ---- canvas format repair ------------------------------------------- */

  /** Read-only. Opens the archive, measures, writes nothing. */
  async repairScan(archive) {
    this.repair.archive = archive;
    this.repair.scan = null;
    this.repair.result = null;
    try {
      this.repair.progress = await api.repairScanStart({ path: archive, maxCases: 400 });
      this.pollRepair();
    } catch (error) {
      toastError(error, '无法扫描该存档');
    }
    this.render();
  }

  /**
   * Writes. Behind a confirm() as well as the server's own confirm flag,
   * because the two guards answer different questions: the server's is "did a
   * caller mean this?" and this one is "does the person reading the screen
   * know how big it is?".
   */
  async repairApply() {
    const archive = this.repair.archive;
    if (!archive) return;
    const ok = window.confirm(
      `要写入 ${archive} 的修复副本吗?\n\n` +
      '这会在其旁创建一个新文件,不会改动原文件或你的客户端。' +
      '它需要的磁盘空间与存档大小相当,耗时大约与一次保存相同。');
    if (!ok) return;

    try {
      this.repair.result = null;
      this.repair.progress = await api.repairApply({ path: archive, confirm: true });
      this.pollRepair();
    } catch (error) {
      toastError(error, '无法启动修复');
    }
    this.render();
  }

  pollRepair() {
    clearTimeout(this.repairTimer);
    this.repairTimer = setTimeout(() => this.refreshRepair(), POLL_MS);
  }

  async refreshRepair() {
    let state;
    try {
      this.repair.progress = await api.repairProgress();
      state = this.repair.progress.state;
    } catch {
      return;   // the server going away is the app's problem to report
    }
    if (state === 'scanning' || state === 'repairing' || state === 'saving' || state === 'verifying') {
      this.pollRepair();
      this.render();
      return;
    }
    if (state === 'done') {
      try { this.repair.scan = await api.repairScan(); } catch { /* 404 until one finishes */ }
      try { this.repair.result = await api.repairResult(); } catch { /* only after an apply */ }
    }
    this.render();
  }

  async refreshProgress() {
    try {
      this.progress = await api.auditProgress();
    } catch {
      return;   // the server going away is the app's problem to report, not this screen's
    }
    if (this.progress.state === 'running') { this.poll(); this.render(); return; }
    if (this.progress.state === 'done' && !this.report) {
      try { this.report = await api.auditReport(); } catch { /* 404 until one finishes */ }
    }
    this.render();
  }

  /* ============================================================
     RENDER
     ============================================================ */

  render() {
    clear(this.host);
    this.host.className = 'stage-body audit';
    this.host.append(this.head());

    if (this.progress?.state === 'running') { this.host.append(this.running()); return; }
    if (this.progress?.state === 'failed') this.host.append(this.failure());
    if (this.report) { this.host.append(...this.reportView()); return; }
    if (this.plan) { this.host.append(this.planView()); return; }

    this.host.append(emptyState(
      'search', '指定一个客户端文件夹',
      '检查器会读取客户端挂载的每个 .wz,并报告它们挂载在一起后哪些内容无法解析。' +
      '它以只读方式打开文件,不会写入任何内容。'));
  }

  head() {
    const input = el('input', {
      class: 'input audit-folder',
      type: 'text',
      value: this.folder,
      placeholder: 'C:\\MapleStory\\232',
      spellcheck: 'false',
      oninput: (event) => { this.folder = event.target.value.trim(); },
      onkeydown: (event) => { if (event.key === 'Enter') this.loadPlan(); },
    });

    return el('div', { class: 'audit-head' },
      el('div', { class: 'audit-title' },
        el('h2', { text: '客户端完整性' }),
        el('p', {
          class: 'audit-sub',
          text: '这里的每项检查回答的都是单个存档无法回答的问题:它们全部挂载在一起后会发生什么。' +
                '只读——不会写入、移动或修复任何内容。',
        })),
      el('div', { class: 'audit-controls' },
        input,
        el('button', {
          class: 'btn',
          onclick: () => this.loadPlan(),
          'data-tip': '列出客户端将从该文件夹挂载的存档。不会打开任何内容。',
        }, icon('folderOpen', { size: 15 }), '读取文件夹'),
        el('button', {
          class: 'btn btn-primary',
          disabled: !this.plan,
          onclick: () => this.start(),
          'data-tip': this.plan ? '完整客户端需要几分钟。下方显示进度;可随时取消。' : '请先读取文件夹',
        }, icon('search', { size: 15 }), '运行检查')));
  }

  planView() {
    const rows = this.plan.families.flatMap((family) =>
      family.archives.map((archive, index) => el('tr', {},
        el('td', { text: index === 0 ? family.family : '' }),
        el('td', {}, el('code', { text: archive.name })),
        el('td', { class: 'num', text: archive.mountOrder === 0 ? '最先' : `#${archive.mountOrder}` }),
        el('td', { class: 'num', text: gb(archive.bytes) }))));

    const skipped = this.plan.skipped ?? [];

    return el('div', { class: 'audit-plan' },
      el('div', { class: 'audit-card' },
        el('h3', { text: `${rows.length} 个存档,分属 ${this.plan.families.length} 个族` }),
        el('table', { class: 'table audit-table' },
          el('thead', {}, el('tr', {},
            el('th', { text: '族' }), el('th', { text: '存档' }),
            el('th', { class: 'num', text: '挂载' }), el('th', { class: 'num', text: '大小' }))),
          el('tbody', {}, ...rows))),
      // Shown, not hidden. A backup sitting beside the live archive is the most
      // common reason a folder audits differently from the client that runs, and
      // the user is the only one who knows which of them they meant.
      skipped.length
        ? el('div', { class: 'audit-card audit-muted' },
            el('h3', { text: `已跳过 ${skipped.length} 个文件` }),
            el('ul', {}, ...skipped.map((file) =>
              el('li', {},
                el('code', { text: file.name }),
                el('span', { text: `${file.bytes ? ` (${gb(file.bytes)})` : ''} — ${file.why}` })))))
        : null,
      this.notes(this.plan.assumptions, '本次运行的前提假设'));
  }

  running() {
    const p = this.progress;
    const share = p.archivesTotal ? Math.round((p.archivesDone / p.archivesTotal) * 100) : 0;

    return el('div', { class: 'audit-card audit-running' },
      el('h3', { text: `${p.phase}${p.archive ? ` — ${p.archive}` : ''}` }),
      el('div', { class: 'audit-bar' }, el('div', { class: 'audit-bar-fill', style: `width:${share}%` })),
      el('p', {
        class: 'audit-sub',
        text: `${p.archivesDone} / ${p.archivesTotal} 个存档 · ${fmt.format(p.imagesDone)} 张图像 ` +
              `· 目前 ${fmt.format(p.findings)} 条发现`,
      }),
      el('button', { class: 'btn', onclick: () => this.cancel() }, '停止'));
  }

  failure() {
    return el('div', { class: 'audit-card audit-failed' },
      el('h3', { text: '检查已停止' }),
      el('p', { text: this.progress.error ?? '未报告原因。' }));
  }

  reportView() {
    const report = this.report;
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
    for (const finding of report.findings) counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;

    // The chips count what the CHECKS found, not what the list holds: a check
    // that fired 40,000 times keeps 300 rows, and a summary that said 300 would
    // be quietly wrong about the size of the problem.
    const totals = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
    for (const check of report.checks) totals[check.severity] = (totals[check.severity] ?? 0) + check.found;

    const summary = el('div', { class: 'audit-chips' },
      ...SEVERITIES.map((severity) => el('div', {
        class: 'audit-chip',
        'data-severity': severity,
        'data-tip': SEVERITY_BLURB[severity],
      },
        el('span', { class: 'audit-chip-n', text: fmt.format(totals[severity]) }),
        el('span', { class: 'audit-chip-l', text: severity }))));

    const fired = report.checks.filter((check) => check.found > 0)
      .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || b.found - a.found);
    const quiet = report.checks.filter((check) => check.found === 0);

    const images = report.archives.reduce((n, a) => n + (a.images || 0), 0);
    const canvases = report.archives.reduce((n, a) => n + (a.canvases || 0), 0);

    return [
      el('div', { class: 'audit-card' },
        el('h3', {
          text: `${report.archives.length} 个存档 · ${fmt.format(images)} 张图像 · ` +
                `${fmt.format(canvases)} 个画布 · ${report.seconds.toFixed(0)}s`,
        }),
        summary),

      ...fired.flatMap((check) => (check.id === 'canvas.row_width_zero'
        ? [this.checkCard(check, report), this.repairCard(report)]
        : [this.checkCard(check, report)])),

      this.stringCoverage(report),

      // The checks that found nothing, listed with what they looked at. Without
      // this the report is unfalsifiable: a clean screen and a check that never
      // ran look identical, and the number beside each one is the difference.
      el('div', { class: 'audit-card audit-muted' },
        el('h3', { text: `${quiet.length} 项检查未发现问题` }),
        el('ul', { class: 'audit-quiet' }, ...quiet.map((check) =>
          el('li', {},
            el('span', { text: check.title }),
            el('span', { class: 'audit-dim', text: ` — 检查了 ${fmt.format(check.examined)} 项` }),
            // A zero beside a zero is the one thing this screen must never leave
            // ambiguous: "found nothing" and "looked at nothing" read the same,
            // and only the examined count and the limit tell them apart.
            check.examined === 0
              ? el('span', { class: 'audit-none', text: ' — 未检查任何内容' })
              : null,
            check.notChecked
              ? el('div', { class: 'audit-dim audit-limit', text: check.notChecked })
              : null)))),

      this.notes(report.notChecked, '故意未检查的内容'),
      this.notes(report.assumptions, '本次运行的前提假设'),
      this.skipped(report),
      this.archives(report),
    ];
  }

  /**
   * String.wz against the data, per kind.
   *
   * These two checks fire tens of thousands of times and the report keeps a few
   * hundred rows of each, so the findings list cannot be counted or grouped by
   * kind. The counts can, and they are the shape of the answer: which kind is
   * out of step, and in which direction. A kind whose data archive was absent
   * says so in words rather than showing four zeroes, because a row of zeroes
   * and "nothing was compared" are the same picture and opposite facts.
   */
  stringCoverage(report) {
    const rows = report.stringCoverage ?? [];
    if (!rows.length) return null;

    return el('div', { class: 'audit-card' },
      el('h3', { text: 'String.wz 与定义其名称的存档对比' }),
      el('table', { class: 'table audit-table' },
        el('thead', {}, el('tr', {},
          el('th', { text: '类别' }),
          el('th', { text: 'String.wz 图像' }),
          el('th', { class: 'num', text: '已命名' }),
          el('th', { class: 'num', text: '已定义' }),
          el('th', { class: 'num', text: '已命名但未定义' }),
          el('th', { class: 'num', text: '已定义但未命名' }))),
        el('tbody', {}, ...rows.map((row) => el('tr', {},
          el('td', { text: row.kind }),
          el('td', {}, el('code', { text: row.stringImage })),
          ...(row.compared
            ? [
                el('td', { class: 'num', text: fmt.format(row.named) }),
                el('td', { class: 'num', text: fmt.format(row.defined) }),
                el('td', { class: 'num', text: fmt.format(row.orphans) }),
                el('td', { class: 'num', text: fmt.format(row.unnamed) }),
              ]
            : [el('td', { class: 'audit-dim', colspan: 4, text: `未对比 — ${row.why}` })]))))));
  }

  /**
   * Every .wz in the folder the run did not audit, with the reason.
   *
   * Shown because a backup sitting beside the live archive is the most common
   * reason a folder audits differently from the client that runs, and because
   * "what was not looked at" is half of what makes the rest of this checkable.
   */
  skipped(report) {
    const rows = report.skipped ?? [];
    if (!rows.length) return null;

    return el('div', { class: 'audit-card audit-muted' },
      el('h3', { text: `文件夹中有 ${rows.length} 个文件未检查` }),
      el('ul', {}, ...rows.map((file) => el('li', {},
        el('code', { text: file.name }),
        el('span', { text: ` (${gb(file.bytes)}) — ${file.why}` })))));
  }

  /**
   * The archives, last, because it is reference rather than news. The status
   * column is the load-bearing one: an archive that did not open, or that was
   * deliberately never opened, is the reason a check above it found nothing.
   */
  archives(report) {
    return el('div', { class: 'audit-card audit-muted' },
      el('h3', { text: '按客户端挂载顺序读取的内容' }),
      el('table', { class: 'table audit-table' },
        el('thead', {}, el('tr', {},
          el('th', { text: '存档' }),
          el('th', { text: '命名空间' }),
          el('th', { class: 'num', text: '挂载' }),
          el('th', { class: 'num', text: '大小' }),
          el('th', { text: '状态' }),
          el('th', { class: 'num', text: '图像' }),
          el('th', { class: 'num', text: '画布' }),
          el('th', { class: 'num', text: '秒' }))),
        el('tbody', {}, ...report.archives.map((archive) => el('tr', {},
          el('td', {}, el('code', { text: archive.name })),
          el('td', { text: archive.family }),
          el('td', { class: 'num', text: archive.mountOrder === 0 ? '最先' : `#${archive.mountOrder}` }),
          el('td', { class: 'num', text: gb(archive.bytes) }),
          el('td', {
            class: archive.parseStatus === 'Success' ? '' : 'audit-dim',
            text: archive.parseStatus,
          }),
          el('td', { class: 'num', text: fmt.format(archive.images) }),
          el('td', { class: 'num', text: fmt.format(archive.canvases) }),
          el('td', { class: 'num', text: archive.seconds.toFixed(1) }))))));
  }

  checkCard(check, report) {
    const open = this.expanded.has(check.id);
    const rows = open
      ? report.findings.filter((finding) => finding.check === check.id)
      : [];

    return el('div', { class: 'audit-card audit-check', 'data-severity': check.severity },
      el('button', {
        class: 'audit-check-head',
        onclick: () => {
          if (open) this.expanded.delete(check.id); else this.expanded.add(check.id);
          this.render();
        },
      },
        el('span', { class: 'audit-sev', 'data-severity': check.severity, text: check.severity }),
        el('span', { class: 'audit-check-title', text: check.title }),
        el('span', { class: 'audit-check-n', text: fmt.format(check.found) }),
        el('code', { class: 'audit-dim', text: check.id })),

      open
        ? el('div', {},
            // The check's own limits, verbatim and inside the check they belong
            // to. A report that carries them only in a global footer invites the
            // reader to take a row at face value and go looking for the caveat
            // afterwards, which nobody does.
            check.notChecked
              ? el('p', { class: 'audit-sub audit-limit', text: `此检查的限制:${check.notChecked}` })
              : null,
            check.truncated
              ? el('p', {
                  class: 'audit-sub',
                  text: `正在显示 ${fmt.format(rows.length)} 条,共 ${fmt.format(check.found)} 条。` +
                        '计数是完整的;列表有上限,以免某条嘈杂的检查淹没其余内容。',
                })
              : null,
            el('table', { class: 'table audit-table' },
              el('thead', {}, el('tr', {},
                el('th', { text: '位置' }), el('th', { text: '内容' }), el('th', { text: '目标' }))),
              el('tbody', {}, ...rows.map((finding) => el('tr', {},
                // The path is selectable text rather than a link into the tree:
                // the archive it names is usually not open, and a link that
                // silently does nothing is worse than one that is not offered.
                el('td', {}, el('code', { text: finding.path })),
                el('td', { text: finding.detail }),
                el('td', {}, finding.target ? el('code', { text: finding.target }) : null))))))
        : null);
  }

  /**
   * The repair for the check above it.
   *
   * Deliberately placed under the finding rather than in a toolbar: it is not a
   * general "fix my client" button and must never read as one. It repairs one
   * defect, with a stated rule, on one archive at a time.
   */
  repairCard(report) {
    const state = this.repair.progress?.state ?? 'idle';
    const running = ['scanning', 'repairing', 'saving', 'verifying'].includes(state);

    // Which archives the finding is actually in, taken from the finding paths
    // rather than from the folder listing -- repairing an archive the check
    // never fired on would be work with no reason attached to it.
    const archives = [...new Set(report.findings
      .filter((f) => f.check === 'canvas.row_width_zero')
      .map((f) => f.path.split('/')[0]))];
    const sep = this.folder.includes('/') && !this.folder.includes('\\') ? '/' : '\\';
    const full = (name) => `${this.folder.replace(/[\\/]+$/, '')}${sep}${name}`;

    const scan = this.repair.scan;
    const result = this.repair.result;

    return el('div', { class: 'audit-card audit-check', 'data-severity': 'Critical' },
      el('h3', { text: '修复:重新合并被拆分的格式值' }),
      el('p', {
        class: 'audit-sub',
        text: '这些画布的格式被拆分写入两个字段——低字节在 format 中,其余部分在旁边的 ' +
              'magnification 中。此应用在写入器修复之前就是这样写入的;客户端把第二个数字当作 ' +
              'magnification,导致精灵被压缩到几像素高,甚至完全消失。',
      }),
      el('p', {
        class: 'audit-sub',
        text: '真实数据中的 magnification 通常是 1、2 或 4,每一个都对应一个真实的 format ' +
              '(257、513、1026),因此单看这对数字说明不了什么。起决定作用的是数据内容:真正缩放 ' +
              '的画布以缩小后的尺寸存储像素,被拆分的值则以完整尺寸按合并后的格式存储。只有后者会被处理。',
      }),

      running
        ? el('div', {},
            el('p', { class: 'audit-sub', text: `${state} — ${this.repair.progress.phase || ''} ` +
              `${this.repair.progress.archive || ''} · ` +
              `${fmt.format(this.repair.progress.canvasesDone)} 个画布 · ` +
              `${fmt.format(this.repair.progress.found)} 处发现` }),
            el('button', { class: 'btn', onclick: () => api.repairCancel().catch(() => {}) }, '停止'))
        : el('div', { class: 'audit-controls' },
            ...archives.map((name) => el('button', {
              class: 'btn',
              onclick: () => this.repairScan(full(name)),
              'data-tip': `以只读方式打开 ${name} 并测量每个画布。不会写入任何内容。`,
            }, icon('search', { size: 15 }), `扫描 ${name}`))),

      state === 'failed'
        ? el('p', { class: 'audit-sub', text: this.repair.progress.error ?? '运行已停止。' })
        : null,

      scan && !running
        ? el('div', {},
            el('p', { class: 'audit-sub', text:
              `已检查 ${fmt.format(scan.canvases)} 个画布 · ` +
              `${fmt.format(scan.canvasesWithMag)} 个带有 magnification · ` +
              `${fmt.format(scan.split)} 个是拆分值 · ` +
              `${fmt.format(scan.genuine)} 个是真实的 magnification · ` +
              `${fmt.format(scan.undecidable)} 个无法判定,将保持原样` }),
            el('table', { class: 'table audit-table' },
              el('thead', {}, el('tr', {},
                el('th', { text: 'format' }), el('th', { text: 'mag' }),
                el('th', { class: 'num', text: '画布数' }), el('th', { text: '示例' }))),
              el('tbody', {}, ...scan.pairs.map((pair) => el('tr', {},
                el('td', { text: String(pair.format) }),
                el('td', { text: String(pair.mag) }),
                el('td', { class: 'num', text: fmt.format(pair.count) }),
                el('td', {}, el('code', { text: pair.example })))))),
            scan.split > 0
              ? el('button', {
                  class: 'btn btn-primary',
                  onclick: () => this.repairApply(),
                  'data-tip': '在此存档旁写入一个新存档。原文件不会被改动。',
                }, icon('save', { size: 15 }), `写入修复副本(${fmt.format(scan.split)})`)
              : el('p', { class: 'audit-sub', text: '此存档中没有拆分值。' }),
            this.notes(scan.notes, '扫描得出的结论'))
        : null,

      result && result.output && !running
        ? el('div', { class: 'audit-card audit-muted' },
            el('h3', { text: `已修复 ${fmt.format(result.repaired)} 处 · ` +
                             `从保存的文件中解码出 ${fmt.format(result.decoded)} 处` }),
            result.failedToDecode
              ? el('p', { class: 'audit-sub', text:
                  `${fmt.format(result.failedToDecode)} 处无法解码。请勿安装此文件。` })
              : null,
            ...(result.failures ?? []).map((line) => el('p', { class: 'audit-sub', text: line })),
            el('p', { class: 'audit-sub', text: '写入位置:' }),
            el('code', { text: result.output }),
            // The command, not a button. Copying a repaired archive over a live
            // client is the one step this app will not take on the user's
            // behalf -- and the command takes the backup first, in the same
            // line, so there is no ordering to get wrong.
            el('p', { class: 'audit-sub', text:
              '要安装它,请在 PowerShell 中运行以下命令。它会先备份当前存档,' +
              '并且仅在备份成功时才进行复制:' }),
            el('pre', {}, el('code', { text: result.installCommand })),
            el('button', {
              class: 'btn',
              onclick: () => {
                navigator.clipboard?.writeText(result.installCommand);
                toast('命令已复制');
              },
            }, '复制命令'),
            this.notes(result.notes, '修复完成的操作'))
        : null);
  }

  notes(lines, title) {
    if (!lines?.length) return null;
    return el('div', { class: 'audit-card audit-muted' },
      el('h3', { text: title }),
      el('ul', {}, ...lines.map((line) => el('li', { text: line }))));
  }
}
