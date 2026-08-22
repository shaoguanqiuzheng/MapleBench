/**
 * Generation chooser: the per-skill answer to the donor restore's 261
 * conflicted cases.
 *
 * The judgement it presents, exactly as the scan measured it: restoring one of
 * these skills makes its dangling links draw again AND puts the donor's older
 * art beside newer art the client still has for the same skill. Rejecting
 * keeps the skill's look consistent AND leaves its canvases silent. Neither is
 * a repair; both are looks. So each skill shows BOTH — the donor art that
 * would be restored, and the surviving newer-generation art it would land
 * beside — animated the way the client draws them (frames at the shared
 * origin, each frame's own delay; the dumper's composition rule, served by the
 * same backend that would export the GIF).
 *
 * What this screen never does:
 *   - decide for you: undecided is undecided, visibly, and the build dialog
 *     says what undecided will mean (not restored, still reported) before
 *     anything is written;
 *   - lose a half-made choice: decisions persist per client folder in
 *     localStorage and export as JSON, so a reload or another machine can
 *     carry on;
 *   - install anything: the build writes new archives beside the source and
 *     hands back the backup-first install command as text to copy.
 */

import { api } from './api.js';
import { el, clear, toast, toastError, fmt, modal } from './ui.js';
import { emptyState } from './inspector.js';
import { icon } from './icons.js';

const STORE_KEY = 'mb.genchoice';
const POLL_MS = 700;

/** Largest edge a preview box takes on screen; art scales down, never up. */
const PREVIEW_EDGE = 200;

export class GenChoiceSection {
  constructor({ host, app }) {
    this.host = host;
    this.app = app;

    this.s = this.load() ?? {
      folder: '',
      donors: '',
      family: 'Skill',
      output: '',
      // Preselected because the recorded history of THIS client is that other
      // whole-archive repairs were already built from the same pristine input;
      // the ledger's refusal text is shown verbatim if it fires anyway.
      acceptSeparateRepairs: true,
    };

    /** skillId -> 'accept' | 'reject'. Keyed per client folder. */
    this.decisions = {};

    this.report = null;
    this.progress = null;
    this.result = null;
    this.mode = null;       // 'prepare' | 'build' — what the last started run was
    this.timer = null;
    /** Cancel functions for running frame animations, cleared on each render. */
    this.players = [];

    this.loadDecisions();
  }

  async open() {
    this.render();
    await this.refreshAll();
  }

  refresh() { return this.open(); }

  /* ============================================================
     STATE
     ============================================================ */

  load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; }
  }

  save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.s)); } catch { /* cosmetic */ }
  }

  decisionsKey() { return `${STORE_KEY}.decisions|${(this.s.folder || '').toLowerCase()}`; }

  loadDecisions() {
    try { this.decisions = JSON.parse(localStorage.getItem(this.decisionsKey())) ?? {}; }
    catch { this.decisions = {}; }
  }

  saveDecisions() {
    try { localStorage.setItem(this.decisionsKey(), JSON.stringify(this.decisions)); }
    catch { /* cosmetic */ }
  }

  donorList() {
    return (this.s.donors || '').split('\n').map((line) => line.trim()).filter(Boolean);
  }

  counts() {
    const groups = this.report?.groups ?? [];
    let accepted = 0; let rejected = 0;
    for (const group of groups) {
      const d = this.decisions[group.skillId];
      if (d === 'accept') accepted++;
      else if (d === 'reject') rejected++;
    }
    return { accepted, rejected, undecided: groups.length - accepted - rejected, total: groups.length };
  }

  /* ============================================================
     SERVER
     ============================================================ */

  async refreshAll() {
    try { this.report = await api.genchoiceReport(); } catch { /* 404 until prepared */ }
    try { this.result = await api.genchoiceResult(); } catch { /* 404 until built */ }
    await this.refreshProgress();
  }

  async prepare() {
    const donors = this.donorList();
    if (!this.s.folder) { toast('请先填写客户端文件夹——必须是副本文件夹。', 'warn'); return; }
    if (!donors.length) {
      toast('请至少填写一个供体存档——没有它就无法显示旧代内容。', 'warn');
      return;
    }
    try {
      this.mode = 'prepare';
      this.report = null;
      this.progress = await api.genchoicePrepare({
        folder: this.s.folder,
        donors,
        family: this.s.family || 'Skill',
      });
      this.loadDecisions();
      this.poll();
    } catch (error) {
      toastError(error, '无法开始预处理');
    }
    this.render();
  }

  async build() {
    const { accepted, rejected, undecided, total } = this.counts();
    const acceptedIds = Object.entries(this.decisions)
      .filter(([, d]) => d === 'accept').map(([id]) => id);

    const go = await new Promise((resolve) => {
      let settled = false;
      const finish = (answer) => { if (!settled) { settled = true; resolve(answer); } };
      const { dialog } = modal({
        title: '按此选择构建存档',
        subtitle: '按记录顺序执行两轮：先使用已接受的技能进行供体恢复，然后对其输出'
                + '进行画布格式修复。新文件位于源文件旁边；不会安装任何内容。',
        body: el('div', { class: 'gc-confirm' },
          el('p', { text: `${accepted} / ${total} 个冲突技能已接受——其供体图像将被恢复，`
                        + '这些技能会混合两代内容，这正是所做的选择。' }),
          el('p', { text: `${rejected} 个已拒绝，${undecided} 个未决定——处理方式相同：不恢复。`
                        + '它们的链接保持悬空，并继续由审计器报告；拒绝绝不会删除链接。' }),
          el('p', { text: '每次无代际分歧的干净恢复都会始终包含，'
                        + '所有画布格式修复同样如此。' })),
        actions: [
          { label: '取消', run: () => finish(false) },
          { label: `构建（已接受 ${accepted}）`, class: 'btn-primary', run: () => finish(true) },
        ],
      });
      // Esc and the corner close both land here; without it the promise hangs.
      dialog.addEventListener('close', () => finish(false), { once: true });
    });
    if (!go) return;

    try {
      this.mode = 'build';
      this.result = null;
      this.progress = await api.genchoiceBuild({
        folder: this.s.folder,
        donors: this.donorList(),
        family: this.s.family || 'Skill',
        acceptedSkillIds: acceptedIds,
        output: this.s.output || null,
        acceptSeparateRepairs: !!this.s.acceptSeparateRepairs,
        confirm: true,
      });
      this.poll();
    } catch (error) {
      toastError(error, '无法开始构建');
    }
    this.render();
  }

  async cancel() {
    try { await api.genchoiceCancel(); } catch { /* the poll re-reads it */ }
    await this.refreshProgress();
  }

  poll() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refreshProgress(), POLL_MS);
  }

  running() {
    const state = this.progress?.chooser?.state;
    return state === 'preparing' || state === 'building';
  }

  async refreshProgress() {
    try {
      this.progress = await api.genchoiceProgress();
    } catch {
      return; // the server going away is the app's problem to report
    }
    if (this.running()) { this.poll(); this.render(); return; }

    const state = this.progress?.chooser?.state;
    if (state === 'done') {
      if (this.mode === 'prepare' && !this.report) {
        try { this.report = await api.genchoiceReport(); } catch { /* stays a 404 */ }
      }
      if (this.mode === 'build' && !this.result) {
        try { this.result = await api.genchoiceResult(); } catch { /* stays a 404 */ }
      }
      // Re-entering the section with runs long finished: pick up whatever exists.
      if (!this.mode) {
        if (!this.report) { try { this.report = await api.genchoiceReport(); } catch { /* none */ } }
        if (!this.result) { try { this.result = await api.genchoiceResult(); } catch { /* none */ } }
      }
    }
    this.render();
  }

  /* ============================================================
     DECISIONS
     ============================================================ */

  decide(skillId, decision) {
    if (this.decisions[skillId] === decision) delete this.decisions[skillId];
    else this.decisions[skillId] = decision;
    this.saveDecisions();
    this.render();
  }

  decideAll(decision) {
    for (const group of this.report?.groups ?? []) this.decisions[group.skillId] = decision;
    this.saveDecisions();
    this.render();
  }

  clearAll() {
    this.decisions = {};
    this.saveDecisions();
    this.render();
  }

  exportDecisions() {
    const payload = {
      schema: 'maplebench/genchoice-decisions@1',
      folder: this.s.folder,
      donors: this.donorList(),
      exportedUtc: new Date().toISOString(),
      decisions: this.decisions,
      accepted: Object.entries(this.decisions).filter(([, d]) => d === 'accept').map(([id]) => id),
      rejected: Object.entries(this.decisions).filter(([, d]) => d === 'reject').map(([id]) => id),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const link = el('a', {
      href: URL.createObjectURL(blob),
      download: 'genchoice-decisions.json',
    });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  }

  importDecisions(json) {
    const read = JSON.parse(json);
    if (read.schema !== 'maplebench/genchoice-decisions@1') {
      throw new Error(`'${read.schema ?? '(无 schema)'}' 不是此界面可识别的决定导出。`);
    }
    this.decisions = read.decisions ?? {};
    this.saveDecisions();
  }

  /* ============================================================
     RENDER
     ============================================================ */

  render() {
    // Stop every animation the previous render started; their elements are gone.
    for (const stop of this.players) stop();
    this.players = [];

    clear(this.host);
    this.host.className = 'stage-body genchoice';
    this.host.append(this.head());

    if (this.running()) {
      this.host.append(this.runningCard());
      return;
    }

    const state = this.progress?.chooser?.state;
    if (state === 'failed') this.host.append(this.failureCard());
    if (state === 'cancelled') {
      this.host.append(el('div', { class: 'gc-card gc-note' },
        el('p', { text: '上次运行已取消。尚未完成的内容均未写入。' })));
    }

    if (this.result) this.host.append(this.resultCard());

    this.host.append(this.setupCard());

    if (this.report) {
      this.host.append(this.choiceBar());
      for (const group of this.report.groups) this.host.append(this.groupCard(group));
      this.host.append(this.reportNotes());
    } else if (!this.result && state !== 'failed') {
      this.host.append(emptyState(
        'replace', '尚未准备任何内容',
        '将其指向 Skill 家族的副本文件夹及其供体，点击“预处理”将解码'
        + '每个冲突技能的两代内容，以便逐个技能进行选择。'));
    }
  }

  head() {
    return el('div', { class: 'gc-head' },
      el('div', {},
        el('h2', { text: '在两代内容之间选择' }),
        el('p', {
          class: 'gc-sub',
          text: '恢复的供体图像将与较新的现存图像并排，一次一个技能：'
              + '观看两者的动画、逐个接受或拒绝，并完全按该选择构建存档。'
              + '已拒绝和未决定的技能保留其悬空链接——仅报告，绝不删除。',
        })));
  }

  /* ---- setup ---------------------------------------------------------- */

  setupCard() {
    const running = this.running();
    return el('div', { class: 'gc-card' },
      el('h3', { text: this.report ? '此选择读取的内容' : '1 · 要读取的内容' }),
      el('div', { class: 'gc-controls' },
        el('label', { class: 'gc-label', text: '客户端文件夹（Skill 家族的副本，只读）' }),
        el('input', {
          class: 'input', type: 'text', value: this.s.folder, spellcheck: 'false',
          placeholder: 'C:\\MapleStory\\_genchoice_work\\client',
          oninput: (event) => {
            this.s.folder = event.target.value.trim();
            this.save();
            this.loadDecisions();
          },
        }),
        el('label', { class: 'gc-label', text: '供体存档，每行一个，按偏好顺序' }),
        el('textarea', {
          class: 'input gc-donors', rows: '2', spellcheck: 'false',
          placeholder: 'C:\\MapleStory\\_genchoice_work\\donors\\Skill_old.wz',
          oninput: (event) => { this.s.donors = event.target.value; this.save(); },
        }, this.s.donors || ''),
        el('div', { class: 'gc-row' },
          el('label', { class: 'gc-label', text: '家族' }),
          el('input', {
            class: 'input gc-family', type: 'text', value: this.s.family, spellcheck: 'false',
            oninput: (event) => { this.s.family = event.target.value.trim(); this.save(); },
          }),
          el('label', { class: 'gc-label', text: '最终输出（留空 = 源文件旁）' }),
          el('input', {
            class: 'input gc-output', type: 'text', value: this.s.output, spellcheck: 'false',
            placeholder: 'C:\\MapleStory\\_genchoice_work\\client\\Skill.genchoice.wz',
            oninput: (event) => { this.s.output = event.target.value.trim(); this.save(); },
          })),
        el('label', {
          class: 'gc-check',
          'data-tip': '此客户端原始 Skill.wz 已用于构建过其他整档修复；除非此处明确要求单独的变体，'
                    + '否则记录册会拒绝从相同输入生成第二种输出。任何时候只能安装一个变体。',
        },
          el('input', {
            type: 'checkbox',
            checked: this.s.acceptSeparateRepairs ? 'checked' : null,
            onchange: (event) => { this.s.acceptSeparateRepairs = event.target.checked; this.save(); },
          }),
          el('span', { text: '当记录册表明此输入已修复时，允许单独的变体' })),
        el('div', { class: 'gc-actions' },
          el('button', {
            class: 'btn btn-primary', disabled: running ? 'disabled' : null,
            onclick: () => this.prepare(),
          }, icon('search', { size: 15 }), this.report ? '重新预处理' : '预处理选择'),
          el('span', {
            class: 'gc-hint',
            text: '只读：扫描并解码两代内容。处理 5 GB 家族需几分钟。',
          }))));
  }

  /* ---- running / failed ----------------------------------------------- */

  runningCard() {
    const chooser = this.progress?.chooser ?? {};
    const inner = chooser.state === 'building'
      ? (this.progress?.restore?.state !== 'idle' && this.progress?.restore?.state !== 'done'
          ? this.progress?.restore : this.progress?.format)
      : this.progress?.restore;
    const innerLine = inner && inner.state !== 'idle'
      ? `${inner.state}${inner.phase ? ` — ${inner.phase}` : ''}`
        + (inner.imagesDone ? ` · ${fmt.format(inner.imagesDone)} 图像` : '')
        + (inner.canvasesDone ? ` · ${fmt.format(inner.canvasesDone)} 画布` : '')
      : '';
    return el('div', { class: 'gc-card' },
      el('h3', { text: chooser.state === 'building' ? '正在按选择构建…' : '正在预处理选择…' }),
      el('p', { class: 'gc-sub', text: chooser.phase || '启动中' }),
      chooser.groupsTotal
        ? el('p', { class: 'gc-sub', text: `已解码 ${chooser.groupsDone} / ${chooser.groupsTotal} 个技能` })
        : null,
      innerLine ? el('p', { class: 'gc-sub gc-inner', text: innerLine }) : null,
      el('p', { class: 'gc-sub', text: `${(chooser.seconds ?? 0).toFixed(0)}s` }),
      el('button', { class: 'btn', onclick: () => this.cancel() }, '取消'));
  }

  failureCard() {
    return el('div', { class: 'gc-card gc-failed' },
      el('h3', { text: '上次运行失败' }),
      el('p', { text: this.progress?.chooser?.error ?? '未报告原因。' }));
  }

  /* ---- the choice bar -------------------------------------------------- */

  choiceBar() {
    const { accepted, rejected, undecided, total } = this.counts();
    return el('div', { class: 'gc-bar' },
      el('div', { class: 'gc-bar-counts' },
        el('span', { class: 'gc-chip gc-chip-accept', text: `${accepted} 已接受` }),
        el('span', { class: 'gc-chip gc-chip-reject', text: `${rejected} 已拒绝` }),
        el('span', { class: 'gc-chip', text: `${undecided} / ${total} 未决定` })),
      el('div', { class: 'gc-bar-actions' },
        el('button', { class: 'btn', onclick: () => this.decideAll('accept') }, '全部接受'),
        el('button', { class: 'btn', onclick: () => this.decideAll('reject') }, '全部拒绝'),
        el('button', { class: 'btn', onclick: () => this.clearAll() }, '清除'),
        el('button', {
          class: 'btn', onclick: () => this.exportDecisions(),
          'data-tip': '将决定集下载为 JSON——与 localStorage 在重新加载之间保存的集合相同。',
        }, icon('download', { size: 14 }), '导出'),
        el('button', {
          class: 'btn btn-primary', disabled: this.running() ? 'disabled' : null,
          onclick: () => this.build(),
          'data-tip': '使用已接受的技能进行供体恢复，然后对其输出进行画布格式修复。'
                    + '在源文件旁写入新文件；不安装任何内容。',
        }, icon('save', { size: 14 }), '构建存档')));
  }

  /* ---- one skill ------------------------------------------------------- */

  groupCard(group) {
    const decision = this.decisions[group.skillId];
    return el('div', { class: 'gc-group', 'data-decision': decision ?? 'none' },
      el('div', { class: 'gc-group-head' },
        el('div', { class: 'gc-group-title' },
          el('span', { class: 'gc-skill-id', text: group.skillId }),
          group.skillName ? el('span', { class: 'gc-skill-name', text: group.skillName }) : null,
          el('span', {
            class: 'gc-skill-meta',
            text: `${group.links} 个链接 · ${fmt.format(group.canvases)} 个静默画布 · 落入 `
                + `${group.targetArchive}.wz/${group.imagePath}（${group.landsUnder} 下） · 供体 `
                + `${group.donors.join(', ')}`,
          })),
        el('div', { class: 'gc-group-buttons' },
          el('button', {
            class: 'btn gc-accept', 'data-on': decision === 'accept' ? 'true' : 'false',
            onclick: () => this.decide(group.skillId, 'accept'),
            'data-tip': '恢复此技能的供体图像。其链接将重新绘制；该技能将混合'
                      + '此处显示的两代内容。',
          }, icon('check', { size: 14 }), '接受'),
          el('button', {
            class: 'btn gc-reject', 'data-on': decision === 'reject' ? 'true' : 'false',
            onclick: () => this.decide(group.skillId, 'reject'),
            'data-tip': '保持此技能不变。其外观保持一致；这些链接保持悬空'
                      + '并继续被报告。',
          }, icon('close', { size: 14 }), '拒绝'))),
      el('div', { class: 'gc-panes' },
        this.pane('将被恢复 — 供体（旧代）',
          '悬空链接所指向的图像。恢复它正是“接受”的含义。',
          group.donorSets),
        this.pane('已存在 — 现存（新代）',
          '经受住迁移且无论选择如何都会保留。恢复的图像将与之并排。',
          group.liveSets)),
      group.notes?.length
        ? el('div', { class: 'gc-group-notes' },
            ...group.notes.map((note) => el('p', { text: note })))
        : null);
  }

  pane(title, sub, sets) {
    return el('div', { class: 'gc-pane' },
      el('h4', { text: title }),
      el('p', { class: 'gc-pane-sub', text: sub }),
      sets.length
        ? el('div', { class: 'gc-sets' }, ...sets.map((set) => this.setView(set)))
        : el('p', { class: 'gc-pane-empty', text: '此侧未解码任何内容——下方注释说明了原因。' }));
  }

  /**
   * One composed node: the frames absolutely positioned at their shared-origin
   * offsets inside the composed box, shown one at a time on each frame's own
   * delay. The placement numbers come from the server — the dumper's rule —
   * so this element only obeys them.
   */
  setView(set) {
    const scale = Math.min(1, PREVIEW_EDGE / Math.max(set.width, 1), PREVIEW_EDGE / Math.max(set.height, 1));
    const px = (n) => `${Math.round(n * scale)}px`;

    const frames = set.frames.map((frame) => {
      if (frame.id < 0) {
        return el('div', {
          class: 'gc-frame gc-frame-missing',
          style: `left:${px(frame.offsetX)};top:${px(frame.offsetY)};`
               + `width:${px(frame.width)};height:${px(frame.height)}`,
          'data-tip': frame.note || '此帧未解码',
        });
      }
      return el('img', {
        class: 'gc-frame',
        src: `/api/repair/genchoice/frame/${frame.id}`,
        alt: `${set.path}/${frame.name}`,
        style: `left:${px(frame.offsetX)};top:${px(frame.offsetY)};width:${px(frame.width)}`,
        loading: 'lazy',
      });
    });

    const box = el('div', {
      class: 'gc-anim',
      style: `width:${px(set.width)};height:${px(set.height)}`,
    }, ...frames);

    if (frames.length > 1) {
      let index = 0; let timer = null; let stopped = false;
      const show = () => {
        frames.forEach((node, i) => { node.style.visibility = i === index ? 'visible' : 'hidden'; });
        const delay = Math.max(set.frames[index].delay || 100, 20);
        index = (index + 1) % frames.length;
        if (!stopped) timer = setTimeout(show, delay);
      };
      show();
      this.players.push(() => { stopped = true; clearTimeout(timer); });
    }

    const formats = [...new Set(set.frames.map((frame) => frame.format))].join('/');
    const leaf = set.path.split('/').slice(-2).join('/');
    return el('figure', { class: 'gc-set' },
      box,
      el('figcaption', {
        class: 'gc-caption',
        'data-tip': set.path,
      },
        el('span', { class: 'gc-caption-name', text: leaf }),
        el('span', {
          text: `${set.frames.length} 帧 · ${set.width}×${set.height} · 格式 ${formats} · `
              + `${set.totalMs} ms${set.truncated ? ` · ${set.note}` : ''}`,
        })));
  }

  reportNotes() {
    return el('div', { class: 'gc-card gc-note' },
      el('h3', { text: '此选择所依据的内容' }),
      ...(this.report.notes ?? []).map((note) => el('p', { text: note })),
      el('p', {
        text: `选择之外：始终包含 ${this.report.restorable} 次干净恢复；无供体持有的 `
            + `${this.report.unrestorable} 个链接会被报告并保持原样；所有画布格式修复都会应用。`,
      }));
  }

  /* ---- the result ------------------------------------------------------ */

  resultCard() {
    const r = this.result;
    const restore = r.restore ?? {};
    const format = r.format;
    return el('div', { class: 'gc-card gc-result' },
      el('h3', { text: '已构建 — 已在保存并重新打开的存档上验证，未安装到任何位置' }),
      el('div', { class: 'gc-result-grid' },
        this.stat('已接受的技能', `${r.acceptedSkillIds?.length ?? 0}`),
        this.stat('已拒绝/未决定', `${r.rejectedSkillIds?.length ?? 0}`),
        this.stat('已恢复的链接', `${restore.written ?? 0}（保持身份 ${restore.identityHeld ?? 0}）`),
        this.stat('悬空', `${restore.danglingBefore ?? 0} → ${restore.danglingAfter ?? 0}`),
        this.stat('静默画布', `${fmt.format(restore.danglingCanvasesBefore ?? 0)} → `
                                   + `${fmt.format(restore.danglingCanvasesAfter ?? 0)}`),
        this.stat('格式修复', format ? `${format.repaired}（已解码 ${format.decoded}）` : '未执行'),
        this.stat('额外解码', `${fmt.format((restore.bystandersDecoded ?? 0) + (format?.bystandersDecoded ?? 0))}`
                                      + `，失败 ${(restore.bystandersFailed ?? 0) + (format?.bystandersFailed ?? 0)}`),
        this.stat('字节', `${fmt.format(restore.sourceBytes ?? 0)} → ${fmt.format(r.finalBytes ?? 0)}`)),
      el('p', { class: 'gc-sub', text: `最终存档：${r.finalOutput || '(未写入任何内容)'}` }),
      r.installCommand ? el('div', { class: 'gc-install' },
        el('p', { class: 'gc-sub', text: '安装方式——先备份，再复制。请自行运行；此工具不会代劳。' }),
        el('code', { text: r.installCommand }),
        el('button', {
          class: 'btn',
          onclick: () => navigator.clipboard.writeText(r.installCommand)
            .then(() => toast('已复制。', 'info'))
            .catch(() => toast('无法访问剪贴板——请改为手动选择文本。', 'warn')),
        }, icon('copy', { size: 14 }), '复制')) : null,
      (restore.stillDangling?.length ?? 0) > 0 ? el('details', { class: 'gc-still' },
        el('summary', { text: `${restore.stillDangling.length} 个链接仍悬空——已拒绝、未决定或`
                            + '无法恢复。仅报告，绝不删除。' }),
        ...restore.stillDangling.slice(0, 100).map((c) => el('p', { class: 'gc-mono', text: c.link }))) : null,
      (restore.failures?.length ?? 0) + (format?.failures?.length ?? 0) > 0
        ? el('div', { class: 'gc-failures' },
            el('h4', { text: '失败' }),
            ...[...(restore.failures ?? []), ...(format?.failures ?? [])].map((f) => el('p', { text: f })))
        : null,
      el('details', {},
        el('summary', { text: '完整记录——两轮写入的全部注释' }),
        ...(r.notes ?? []).map((note) => el('p', { class: 'gc-sub', text: note })),
        ...(restore.notes ?? []).map((note) => el('p', { class: 'gc-sub', text: note })),
        ...((format?.notes) ?? []).map((note) => el('p', { class: 'gc-sub', text: note }))));
  }

  stat(label, value) {
    return el('div', { class: 'gc-stat' },
      el('span', { class: 'gc-stat-label', text: label }),
      el('span', { class: 'gc-stat-value', text: value }));
  }
}
