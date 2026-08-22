/**
 * Compose section: build a whole client from a pristine base plus takes from
 * other versions — the end goal this tool exists for.
 *
 * The reframe the engine enforces, and this screen has to keep visible: a
 * composition is a BUILD, not a sequence of edits. The base is never touched;
 * the output folder is produced from it every time; removing a contribution is
 * deleting a take and building again. So the screen is a manifest editor plus a
 * build button, not an editor of the output.
 *
 * Safety rules the screen leans on rather than re-implements (they live in the
 * service and the builder, where a UI bug cannot skip them):
 *   - the output folder is explicit, required, and never defaulted — a build
 *     writes a whole client there;
 *   - building into the base or any source folder is refused by the builder;
 *   - building into a folder holding an archive mounted in this app is refused
 *     by the run service;
 *   - a non-empty folder this tool did not itself build is refused by name.
 *
 * The one thing this screen adds on top of the API: it remembers every build
 * finished while it is open and compares the last two, because "built twice,
 * byte-identical" is the engine's headline claim and a user should be able to
 * see it hold — or fail — without hashing files by hand.
 */

import { api } from './api.js';
import { el, clear, toast, toastError, fmt } from './ui.js';
import { emptyState } from './inspector.js';
import { icon } from './icons.js';

const STORE_KEY = 'mb.compose';
const POLL_MS = 700;

/** Port kinds a take can name. Offered as suggestions, not enforced — the server refuses unknown ones with its own words. */
const KINDS = ['mob', 'npc', 'map', 'item', 'skill', 'morph', 'quest', 'reactor'];

const gb = (bytes) => (bytes >= 1073741824
  ? `${(bytes / 1073741824).toFixed(2)} GB`
  : bytes >= 1048576
    ? `${Math.max(1, Math.round(bytes / 1048576))} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`);

const shortHash = (sha) => (sha ? `${sha.slice(0, 12)}…` : '');

export class ComposeSection {
  constructor({ host, app }) {
    this.host = host;
    this.app = app;

    /** The manifest under construction, as plain editable state. */
    this.m = this.load() ?? {
      name: '',
      base: { folder: '', archives: [] },
      sources: [],
      takes: [],
      output: '',
      hashParts: false,
    };

    /** folder -> { archives: [{name, bytes}], hasLedger } from /compose/archives. */
    this.folders = new Map();

    this.progress = null;
    this.result = null;

    /** Completed builds this visit, newest last: { when, output, digest, archives } — the byte-identical check. */
    this.finished = [];

    this.showJson = false;
    this.timer = null;
  }

  async open() {
    this.render();
    await this.refreshProgress();
  }

  refresh() { return this.open(); }

  /* ============================================================
     STATE
     ============================================================ */

  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.m)); } catch { /* full/blocked storage is cosmetic here */ }
  }

  /** The manifest as the server reads it. */
  manifest() {
    return {
      schema: 'maplebench/composition@1',
      name: this.m.name || 'composition',
      base: {
        id: 'base',
        label: 'Base client',
        folder: this.m.base.folder,
        archives: this.m.base.archives.map((name) => ({ name })),
      },
      sources: this.m.sources.map((source) => ({
        id: source.id,
        label: source.label || source.id,
        folder: source.folder,
        archives: source.archives.map((name) => ({ name })),
      })),
      takes: this.m.takes.map((take) => ({
        from: take.from,
        kind: take.kind,
        scope: 'selection',
        into: take.into,
        take: (take.paths || '').split('\n').map((line) => line.trim()).filter(Boolean),
        options: { overwrite: !!take.overwrite, match: false },
        note: take.note || null,
      })),
    };
  }

  /** Loads a pasted manifest back into the editable state. */
  fromManifest(json) {
    const read = JSON.parse(json);
    if (read.schema !== 'maplebench/composition@1') {
      throw new Error(`'${read.schema ?? '(no schema)'}' 不是此界面可识别的合成清单。`);
    }
    this.m.name = read.name ?? '';
    this.m.base = {
      folder: read.base?.folder ?? '',
      archives: (read.base?.archives ?? []).map((archive) => archive.name),
    };
    this.m.sources = (read.sources ?? []).map((source) => ({
      id: source.id,
      label: source.label ?? source.id,
      folder: source.folder ?? '',
      archives: (source.archives ?? []).map((archive) => archive.name),
    }));
    this.m.takes = (read.takes ?? []).map((take) => ({
      from: take.from,
      kind: take.kind,
      into: take.into,
      paths: (take.take ?? []).join('\n'),
      overwrite: !!take.options?.overwrite,
      note: take.note ?? '',
    }));
    this.save();
  }

  /* ============================================================
     TALKING TO THE SERVER
     ============================================================ */

  async readFolder(folder, assign) {
    if (!folder) return;
    try {
      const info = await api.composeArchives(folder);
      this.folders.set(folder, info);
      // First read of a base folder: everything the folder holds is the
      // sensible starting list, unticked down from rather than built up to.
      if (assign) assign(info);
      this.save();
    } catch (error) {
      toastError(error, '无法读取该文件夹');
    }
    this.render();
  }

  async build() {
    const problems = this.problems();
    if (problems.length) {
      toast(problems[0], 'warn', { title: '未构建' });
      this.render();
      return;
    }

    try {
      this.result = null;
      this.progress = await api.composeBuild({
        manifest: this.manifest(),
        outputFolder: this.m.output,
        hashParts: this.m.hashParts,
        stopOnRefusal: true,
      });
      this.poll();
    } catch (error) {
      // A 409 is another build already running — its message says so.
      toastError(error, '无法开始构建');
    }
    this.render();
  }

  async cancel() {
    try { this.progress = await api.composeCancel(); } catch { /* the poll re-reads it */ }
    this.render();
  }

  poll() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refreshProgress(), POLL_MS);
  }

  async refreshProgress() {
    try {
      this.progress = await api.composeProgress();
    } catch {
      return; // the server going away is the app's problem to report
    }
    if (this.progress.state === 'running') { this.poll(); this.render(); return; }
    if (this.progress.state === 'done' && !this.result) {
      try {
        this.result = await api.composeResult();
        this.recordFinished(this.result);
      } catch { /* 404 until one finishes */ }
    }
    this.render();
  }

  recordFinished(result) {
    if (!result || result.outcome !== 'Complete') return;
    const verified = result.ledger?.verification?.archives ?? [];
    const record = {
      when: new Date().toLocaleTimeString(),
      output: result.outputFolder,
      digest: result.digest,
      archives: verified.map((archive) => ({ name: archive.name, sha256: archive.sha256, bytes: archive.bytes })),
    };
    // The same finished build re-read on a later visit must not count twice.
    const last = this.finished[this.finished.length - 1];
    if (last && last.digest === record.digest && last.output === record.output) return;
    this.finished.push(record);
  }

  /* ============================================================
     WHAT WOULD STOP A BUILD, SAID BEFORE THE BUTTON
     ============================================================ */

  problems() {
    const problems = [];
    const m = this.m;
    if (!m.base.folder) problems.push('基础客户端文件夹为空。');
    if (!m.base.archives.length) problems.push('基础未列出任何存档,因此无从构建。');
    if (!m.takes.length) problems.push('没有任何取用。无可取之物的构建只是复制,不是合成。');
    for (const [i, take] of m.takes.entries()) {
      if (!take.from) problems.push(`取用 ${i + 1} 未指明来源。`);
      if (!take.kind) problems.push(`取用 ${i + 1} 未指定种类。`);
      if (!take.into) problems.push(`取用 ${i + 1} 未指明落入的存档。`);
      if (!(take.paths || '').trim()) problems.push(`取用 ${i + 1} 未列出任何内容。`);
    }
    if (!m.output) {
      problems.push('输出文件夹为空。它从不使用默认值:构建会在此写入整个客户端。');
    }
    const same = (a, b) => a && b && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
    if (same(m.output, m.base.folder)) {
      problems.push('输出文件夹就是基础本身。基础必须保持纯净——请选择一个空文件夹。');
    }
    for (const source of m.sources) {
      if (same(m.output, source.folder)) problems.push(`输出文件夹就是源 '${source.id}' 本身。`);
    }
    return problems;
  }

  /* ============================================================
     RENDER
     ============================================================ */

  render() {
    clear(this.host);
    this.host.className = 'stage-body compose';
    this.host.append(this.head());

    if (this.progress?.state === 'running') {
      this.host.append(this.running());
      return;
    }
    if (this.progress?.state === 'failed') this.host.append(this.failure());
    if (this.progress?.state === 'cancelled') this.host.append(this.cancelled());

    if (this.result) this.host.append(...this.resultView());
    if (this.finished.length >= 2) this.host.append(this.identicalCard());

    this.host.append(
      this.baseCard(),
      this.sourcesCard(),
      this.takesCard(),
      this.jsonCard(),
      this.outputCard());
  }

  head() {
    return el('div', { class: 'compose-head' },
      el('div', {},
        el('h2', { text: '合成客户端' }),
        el('p', {
          class: 'compose-sub',
          text: '一个纯净的基础,加上从其他版本按顺序取用的列表,构建到新文件夹中,并附带一份来源台账。' +
              '重新运行会从基础重建——绝不会叠加——且基础与所有源均以只读方式打开。',
        })));
  }

  /* ---- base ----------------------------------------------------------- */

  baseCard() {
    const m = this.m;
    const info = this.folders.get(m.base.folder);

    return el('div', { class: 'compose-card' },
      el('h3', { text: '1 · 基础客户端' }),
      el('p', {
        class: 'compose-sub',
        text: '每次构建都从这些存档的字节副本开始。该文件夹只读,绝不写入。',
      }),
      el('div', { class: 'compose-controls' },
        el('input', {
          class: 'input compose-folder',
          type: 'text',
          value: m.base.folder,
          placeholder: 'C:\\clients\\my-base-copy',
          spellcheck: 'false',
          oninput: (event) => { m.base.folder = event.target.value.trim(); this.save(); },
          onkeydown: (event) => { if (event.key === 'Enter') this.readBase(); },
        }),
        el('button', {
          class: 'btn',
          onclick: () => this.readBase(),
          'data-tip': '列出此文件夹中的 .wz 存档。不会打开任何内容。',
        }, icon('folderOpen', { size: 15 }), '读取文件夹')),
      info ? this.archivePicker(info, m.base.archives, (names) => { m.base.archives = names; this.save(); }) : null,
      info?.hasLedger
        ? el('p', { class: 'compose-note', text: '此文件夹带有合成台账——它本身就是一个构建输出。' })
        : null,
      m.base.archives.length
        ? el('p', { class: 'compose-dim', text: `基础中有 ${m.base.archives.length} 个存档——输出将包含这些存档。` })
        : null);
  }

  readBase() {
    return this.readFolder(this.m.base.folder, (info) => {
      if (!this.m.base.archives.length) this.m.base.archives = info.archives.map((archive) => archive.name);
    });
  }

  /** A checkbox per archive the folder holds, with sizes — ticked means listed in the manifest. */
  archivePicker(info, selected, onChange) {
    const set = new Set(selected);
    return el('div', { class: 'compose-archives' },
      ...info.archives.map((archive) => el('label', { class: 'compose-archive' },
        el('input', {
          type: 'checkbox',
          checked: set.has(archive.name) ? 'checked' : undefined,
          onchange: (event) => {
            if (event.target.checked) set.add(archive.name); else set.delete(archive.name);
            onChange(info.archives.map((a) => a.name).filter((name) => set.has(name)));
            this.render();
          },
        }),
        el('code', { text: archive.name }),
        el('span', { class: 'compose-dim', text: gb(archive.bytes) }))),
      info.archives.length === 0
        ? el('p', { class: 'compose-dim', text: '此文件夹中没有 .wz 存档。' })
        : null);
  }

  /* ---- sources -------------------------------------------------------- */

  sourcesCard() {
    const m = this.m;

    return el('div', { class: 'compose-card' },
      el('h3', { text: '2 · 提供方' }),
      el('p', {
        class: 'compose-sub',
        text: '从中取用内容的客户端。每个都有个简短句柄,取用以它来命名。',
      }),
      ...m.sources.map((source, index) => this.sourceRow(source, index)),
      el('button', {
        class: 'btn',
        onclick: () => {
          m.sources.push({ id: `v${m.sources.length + 1}`, label: '', folder: '', archives: [] });
          this.save();
          this.render();
        },
      }, icon('plus', { size: 15 }), '添加提供方'));
  }

  sourceRow(source, index) {
    const info = this.folders.get(source.folder);

    return el('div', { class: 'compose-source' },
      el('div', { class: 'compose-controls' },
        el('input', {
          class: 'input compose-id', type: 'text', value: source.id, placeholder: 'v233',
          'data-tip': '取用使用的句柄。在清单内唯一。',
          oninput: (event) => { source.id = event.target.value.trim(); this.save(); },
        }),
        el('input', {
          class: 'input compose-label', type: 'text', value: source.label, placeholder: '标签(可选)',
          oninput: (event) => { source.label = event.target.value; this.save(); },
        }),
        el('input', {
          class: 'input compose-folder', type: 'text', value: source.folder,
          placeholder: 'C:\\clients\\donor-copy', spellcheck: 'false',
          oninput: (event) => { source.folder = event.target.value.trim(); this.save(); },
          onkeydown: (event) => { if (event.key === 'Enter') this.readSource(source); },
        }),
        el('button', { class: 'btn', onclick: () => this.readSource(source) },
          icon('folderOpen', { size: 15 }), '读取'),
        el('button', {
          class: 'btn', 'data-tip': '从清单中移除此提供方。',
          onclick: () => { this.m.sources.splice(index, 1); this.save(); this.render(); },
        }, icon('trash', { size: 15 }))),
      info ? this.archivePicker(info, source.archives, (names) => { source.archives = names; this.save(); }) : null);
  }

  readSource(source) {
    return this.readFolder(source.folder, (info) => {
      if (!source.archives.length) source.archives = info.archives.map((archive) => archive.name);
    });
  }

  /* ---- takes ---------------------------------------------------------- */

  takesCard() {
    const m = this.m;

    return el('div', { class: 'compose-card' },
      el('h3', { text: '3 · 取用(按顺序)' }),
      el('p', {
        class: 'compose-sub',
        text: '每次取用一项贡献:取什么、从哪个提供方、进入哪个存档。顺序有意义——' +
            '后面的取用可能覆盖前面的,台账会记录这一覆盖。',
      }),
      el('datalist', { id: 'compose-kinds' }, ...KINDS.map((kind) => el('option', { value: kind }))),
      ...m.takes.map((take, index) => this.takeRow(take, index)),
      el('button', {
        class: 'btn',
        onclick: () => {
          m.takes.push({
            from: m.sources[0]?.id ?? '', kind: '', into: m.base.archives[0] ?? '',
            paths: '', overwrite: false, note: '',
          });
          this.save();
          this.render();
        },
      }, icon('plus', { size: 15 }), '添加取用'));
  }

  takeRow(take, index) {
    const select = (value, entries, onchange, tip) => el('select', {
      class: 'input compose-select', 'data-tip': tip, onchange,
    }, ...entries.map(([v, label]) => {
      const option = el('option', { value: v, text: label });
      if (v === value) option.selected = true;
      return option;
    }));

    return el('div', { class: 'compose-take' },
      el('div', { class: 'compose-take-head' },
        el('span', { class: 'compose-take-n', text: `#${index + 1}` }),
        select(take.from,
          [['', '(选择来源…)'], ...this.m.sources.map((source) => [source.id, source.id])],
          (event) => { take.from = event.target.value; this.save(); this.renderProblems(); },
          '此取用来自哪个提供方'),
        el('input', {
          class: 'input compose-kind', type: 'text', value: take.kind, placeholder: '种类(mob、map…)',
          list: 'compose-kinds',
          oninput: (event) => { take.kind = event.target.value.trim(); this.save(); this.renderProblems(); },
        }),
        el('span', { class: 'compose-dim', text: '到' }),
        select(take.into,
          [['', '(选择存档…)'], ...this.m.base.archives.map((name) => [name, name])],
          (event) => { take.into = event.target.value; this.save(); this.renderProblems(); },
          '此取用落入的输出存档'),
        el('label', { class: 'compose-flag', 'data-tip': '替换目标在这些名称下已有的内容。关闭时,目标自身内容优先,并记录拒绝。' },
          el('input', {
            type: 'checkbox', checked: take.overwrite ? 'checked' : undefined,
            onchange: (event) => { take.overwrite = event.target.checked; this.save(); },
          }),
          el('span', { text: '覆盖' })),
        el('button', {
          class: 'btn', 'data-tip': '移除此取用。不带它重新构建就是撤销。',
          onclick: () => { this.m.takes.splice(index, 1); this.save(); this.render(); },
        }, icon('trash', { size: 15 }))),
      el('textarea', {
        class: 'input compose-paths',
        rows: Math.max(2, (take.paths || '').split('\n').length),
        placeholder: '存档相对路径,每行一个:\nMob.wz/8800100.img',
        spellcheck: 'false',
        oninput: (event) => { take.paths = event.target.value; this.save(); this.renderProblems(); },
      }, take.paths || ''),
      el('input', {
        class: 'input compose-note-input', type: 'text', value: take.note,
        placeholder: '此取用存在的原因(记入台账)',
        oninput: (event) => { take.note = event.target.value; this.save(); },
      }));
  }

  /* ---- manifest as a document ----------------------------------------- */

  jsonCard() {
    if (!this.showJson) {
      return el('div', { class: 'compose-card compose-muted' },
        el('button', { class: 'btn', onclick: () => { this.showJson = true; this.render(); } },
          icon('file', { size: 15 }), '以 JSON 显示清单'));
    }

    const area = el('textarea', {
      class: 'input compose-json', rows: 16, spellcheck: 'false',
    }, JSON.stringify(this.manifest(), null, 2));

    return el('div', { class: 'compose-card compose-muted' },
      el('h3', { text: '清单(即文档本身)' }),
      el('p', {
        class: 'compose-sub',
        text: '可编辑。"使用此 JSON"会用粘贴的内容替换上方表单——清单是事实来源,表单只是其视图。',
      }),
      area,
      el('div', { class: 'compose-controls' },
        el('button', {
          class: 'btn',
          onclick: () => {
            try { this.fromManifest(area.value); toast('清单已加载'); this.render(); }
            catch (error) { toastError(error, '此界面无法识别的清单'); }
          },
        }, '使用此 JSON'),
        el('button', {
          class: 'btn',
          onclick: () => { navigator.clipboard?.writeText(area.value); toast('清单已复制'); },
        }, '复制'),
        el('button', { class: 'btn', onclick: () => { this.showJson = false; this.render(); } }, '隐藏')));
  }

  /* ---- output + build -------------------------------------------------- */

  outputCard() {
    // The list is a live element updated in place on every keystroke, because a
    // full render would steal the focus mid-word — and a DISABLED build button
    // fed by a stale render is worse than an enabled one that refuses with the
    // reason: the first is a silent no-op, the failure mode this project keeps
    // paying for.
    this.problemsHost = el('ul', { class: 'compose-problems' });
    this.renderProblems();

    return el('div', { class: 'compose-card' },
      el('h3', { text: '4 · 构建' }),
      el('p', {
        class: 'compose-sub',
        text: '输出文件夹将获得应用了取用的每个基础存档的完整副本,外加说明来源的 composition-ledger.json。' +
            '它必须为空,或为本工具先前构建过的文件夹。它刻意从不使用默认值。',
      }),
      el('div', { class: 'compose-controls' },
        el('input', {
          class: 'input compose-folder',
          type: 'text',
          value: this.m.output,
          placeholder: '用于合成客户端的空文件夹',
          spellcheck: 'false',
          oninput: (event) => { this.m.output = event.target.value.trim(); this.save(); this.renderProblems(); },
        }),
        el('label', { class: 'compose-flag', 'data-tip': '为每个落地的节点记录内容哈希。对所有变动内容进行第二次完整解析——更慢,但台账更可靠。' },
          el('input', {
            type: 'checkbox', checked: this.m.hashParts ? 'checked' : undefined,
            onchange: (event) => { this.m.hashParts = event.target.checked; this.save(); },
          }),
          el('span', { text: '内容哈希' })),
        el('button', {
          class: 'btn btn-primary',
          'data-tip': '复制基础、应用取用、保存,然后验证已保存的文件。清单未就绪时会说明原因并拒绝。',
          onclick: () => this.build(),
        }, icon('play', { size: 15 }), '构建')),
      this.problemsHost);
  }

  /** Refreshes the problem list in place, without a render that would steal focus. */
  renderProblems() {
    if (!this.problemsHost) return;
    clear(this.problemsHost);
    this.problemsHost.append(...this.problems().map((problem) => el('li', { text: problem })));
  }

  /* ---- progress / terminal states -------------------------------------- */

  running() {
    const p = this.progress;
    const share = p.takesTotal ? Math.round((p.takesDone / p.takesTotal) * 100) : 0;

    return el('div', { class: 'compose-card compose-running' },
      el('h3', { text: `${p.phase}${p.detail ? ` — ${p.detail}` : ''}` }),
      el('div', { class: 'compose-bar' }, el('div', { class: 'compose-bar-fill', style: `width:${share}%` })),
      el('p', {
        class: 'compose-sub',
        text: `取用 ${p.takesDone}/${p.takesTotal} · ${p.seconds.toFixed(0)}s · 正在构建到 ${p.output ?? ''}`,
      }),
      el('button', {
        class: 'btn',
        onclick: () => this.cancel(),
        'data-tip': '停止构建并丢弃构建到一半的输出。基础与来源均不受影响。',
      }, '停止'));
  }

  failure() {
    return el('div', { class: 'compose-card compose-failed' },
      el('h3', { text: '构建已停止' }),
      el('p', { class: 'compose-sub', text: this.progress.error ?? '未报告原因。' }));
  }

  cancelled() {
    return el('div', { class: 'compose-card compose-muted' },
      el('h3', { text: '已取消' }),
      el('p', { class: 'compose-sub', text: this.progress.detail ?? '构建已停止。' }));
  }

  /* ---- the finished build ---------------------------------------------- */

  resultView() {
    const result = this.result;
    const ledger = result.ledger ?? {};
    const verification = ledger.verification ?? {};
    const outcome = result.outcome;

    const banner = el('div', {
      class: 'compose-card compose-outcome',
      'data-outcome': outcome,
    },
      el('h3', {
        text: outcome === 'Complete'
          ? `完成 — ${result.outputFolder}`
          : outcome === 'Refused'
            ? '已拒绝 — 未写入任何内容'
            : `部分完成 — ${result.outputFolder} 缺少一项贡献`,
      }),
      outcome === 'Refused'
        ? el('pre', { class: 'compose-refusal' }, el('code', { text: result.refusal ?? '' }))
        : el('p', {
            class: 'compose-sub',
            text: `取用 ${(ledger.takes ?? []).length} 项 · 台账摘要 ${shortHash(result.digest)} · ${result.seconds.toFixed(1)}s`,
          }));

    if (outcome === 'Refused') return [banner];

    const archives = el('div', { class: 'compose-card' },
      el('h3', {
        text: verification.ran
          ? '已在保存的文件上验证,从磁盘读回'
          : '未验证 — 请将输出视为未经证实',
      }),
      el('table', { class: 'table compose-table' },
        el('thead', {}, el('tr', {},
          el('th', { text: '存档' }), el('th', { text: 'SHA-256' }),
          el('th', { class: 'num', text: '字节' }),
          el('th', { class: 'num', text: '已检查落点数' }),
          el('th', { class: 'num', text: '缺失' }))),
        el('tbody', {}, ...(verification.archives ?? []).map((archive) => el('tr', {},
          el('td', {}, el('code', { text: archive.name })),
          el('td', {}, el('code', { 'data-tip': archive.sha256, text: shortHash(archive.sha256) })),
          el('td', { class: 'num', text: fmt.format(archive.bytes) }),
          el('td', { class: 'num', text: String(archive.checked) }),
          el('td', {
            class: `num${archive.missing?.length ? ' compose-bad' : ''}`,
            text: String(archive.missing?.length ?? 0),
          }))))));

    const takes = (ledger.takes ?? []).map((take) => this.takeReport(take));

    const notes = (ledger.notes ?? []).length
      ? el('div', { class: 'compose-card compose-muted' },
          el('h3', { text: '整个构建的备注' }),
          el('ul', {}, ...ledger.notes.map((note) => el('li', { text: note }))))
      : null;

    return [banner, archives, ...takes, notes].filter(Boolean);
  }

  takeReport(take) {
    const cap = 40;
    const took = take.took ?? [];
    const refused = take.refused ?? [];
    const renamed = take.renamed ?? [];

    return el('div', { class: 'compose-card compose-muted' },
      el('h3', {
        text: `取用 ${take.sequence} · ${take.kind} 从 ${take.source?.label ?? take.source?.id ?? '?'} `
            + `到 ${take.into} — 写入 ${take.written},失败 ${take.failed},跳过 ${take.skipped}`,
      }),
      took.length
        ? el('details', {},
            el('summary', { text: `${took.length} 项已落地` }),
            el('ul', { class: 'compose-parts' },
              ...took.slice(0, cap).map((part) => el('li', {},
                el('code', { text: part.from ?? '' }),
                el('span', { text: ' → ' }),
                el('code', { text: part.to ?? '' }),
                part.contentHash ? el('span', { class: 'compose-dim', text: ` ${shortHash(part.contentHash)}` }) : null)),
              took.length > cap
                ? el('li', { class: 'compose-dim', text: `…还有 ${took.length - cap} 项。完整列表位于输出旁的 composition-ledger.json 中。` })
                : null))
        : el('p', { class: 'compose-dim', text: '没有内容落地——此取用想要的都已存在。' }),
      renamed.length
        ? el('details', {},
            el('summary', { text: `${renamed.length} 项以不同名称落地` }),
            el('ul', { class: 'compose-parts' }, ...renamed.map((rename) => el('li', {},
              el('code', { text: rename.from }), el('span', { text: ' → ' }),
              el('code', { text: rename.to }), el('span', { class: 'compose-dim', text: ` — ${rename.why}` })))))
        : null,
      refused.length
        ? el('details', {},
            el('summary', { text: `${refused.length} 项未携带,各有原因` }),
            el('ul', { class: 'compose-parts' }, ...refused.slice(0, cap).map((refusal) => el('li', {},
              el('span', { class: 'compose-refclass', text: refusal.class }),
              el('code', { text: ` ${refusal.what}` }),
              el('span', { class: 'compose-dim', text: ` — ${refusal.why}` }))),
              refused.length > cap ? el('li', { class: 'compose-dim', text: `…还有 ${refused.length - cap} 项,见台账文件。` }) : null))
        : null);
  }

  /* ---- built twice, compared ------------------------------------------- */

  identicalCard() {
    const a = this.finished[this.finished.length - 2];
    const b = this.finished[this.finished.length - 1];

    const ledgersMatch = a.digest === b.digest;
    const names = new Set([...a.archives.map((x) => x.name), ...b.archives.map((x) => x.name)]);
    const rows = [...names].map((name) => {
      const left = a.archives.find((x) => x.name === name);
      const right = b.archives.find((x) => x.name === name);
      return { name, left, right, same: !!left && !!right && left.sha256 === right.sha256 };
    });
    const allSame = ledgersMatch && rows.every((row) => row.same);

    return el('div', { class: 'compose-card compose-compare', 'data-same': allSame ? 'true' : 'false' },
      el('h3', {
        text: allSame
          ? '构建两次,字节完全一致'
          : '最近两次构建不一致',
      }),
      el('p', {
        class: 'compose-sub',
        text: allSame
          ? `最近两次完成的构建(${a.output} · ${b.output})生成了 SHA-256 完全一致的存档,` +
            '台账摘要也相同。相同输入,相同字节——可复现性声明成立。'
          : '重建结果不同,意味着有东西把时钟、哈希种子或字典顺序读入了文件——' +
            '或者输入发生了变化。下表说明哪些存档发生了变动。',
      }),
      el('table', { class: 'table compose-table' },
        el('thead', {}, el('tr', {},
          el('th', { text: '存档' }),
          el('th', { text: `构建 @ ${a.when}` }),
          el('th', { text: `构建 @ ${b.when}` }),
          el('th', { text: '字节相同' }))),
        el('tbody', {}, ...rows.map((row) => el('tr', {},
          el('td', {}, el('code', { text: row.name })),
          el('td', {}, el('code', { 'data-tip': row.left?.sha256, text: shortHash(row.left?.sha256) || '(缺失)' })),
          el('td', {}, el('code', { 'data-tip': row.right?.sha256, text: shortHash(row.right?.sha256) || '(缺失)' })),
          el('td', { class: row.same ? 'compose-good' : 'compose-bad', text: row.same ? '相同' : '不同' }))))),
      el('p', {
        class: 'compose-dim',
        text: `台账摘要:${shortHash(a.digest)} 对比 ${shortHash(b.digest)} — ${ledgersMatch ? '一致' : '不一致'}。`,
      }));
  }
}
