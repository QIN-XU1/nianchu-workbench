import fs from 'node:fs';
import path from 'node:path';

const APP = path.join(process.cwd(), 'apps/agent-ui');
const w = (rel, content) => {
  const p = path.join(APP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  console.log('  ✓ ' + rel);
};

// ══ 数据层：类型化的快照访问 ══
w('src/data/index.ts', `import raw from './snapshot.json';

export type FourState = 'pass' | 'warn' | 'fail' | 'unknown';

export interface Check { ok: FourState; text: string }
export interface Suite {
  id: string; name: string; file: string; state: FourState;
  pass: number; warn?: number; fail: number; unknown: number;
  exit: number; ms: number; checks: Check[];
}
export interface Snapshot {
  schemaVersion: number;
  generatedAt: string;
  generator: string;
  source: { kind: string; label: string; detail: string };
  verify: {
    suites: Suite[];
    totals: { pass: number; fail: number; unknown: number; suitesPass: number; suitesFail: number; suitesUnknown: number };
  };
  capabilities: {
    source: string;
    skills: { name: string; source: string }[];
    mcp: { name: string; source: string }[];
    tools: { name: string; source: string }[];
    patches: { files: string[]; targets: string[] };
    models: { name: string; source: string }[];
    note: string;
  };
  sessions: unknown[];
  tasks: unknown[];
  memory: unknown[];
  about: { product: string; version: string; stage: string; repo: string; node: string };
}

export const snapshot = raw as unknown as Snapshot;

/** 所有套件合并后的四态计数（界面顶部的总览用这个） */
export function fourStateTotals() {
  const t = snapshot.verify.totals;
  return { pass: t.pass, warn: 0, fail: t.fail, unknown: t.unknown };
}

export function dataSource() {
  return snapshot.source;
}

export function generatedAtLabel(): string {
  try {
    return new Date(snapshot.generatedAt).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return snapshot.generatedAt;
  }
}
`);

// ══ 通用 UI 原语 ══
w('src/components/ui.tsx', `import type { ReactNode } from 'react';
import type { FourState } from '../data';

export function Page({ children }: { children: ReactNode }) {
  return <div className="vp-page">{children}</div>;
}

export function Section({
  title, desc, aside, children,
}: { title: string; desc?: ReactNode; aside?: ReactNode; children?: ReactNode }) {
  return (
    <section className="vp-sec">
      <div className="vp-sec__head">
        <h2 className="vp-sec__h">{title}</h2>
        {aside ? <div className="vp-sec__aside">{aside}</div> : null}
      </div>
      {desc ? <p className="vp-sec__p">{desc}</p> : null}
      {children}
    </section>
  );
}

const STATE_LABEL: Record<FourState, string> = {
  pass: '通过', warn: '待补', fail: '失败', unknown: '判不了',
};

export function StateChip({ state, n }: { state: FourState; n?: number }) {
  return (
    <span className="vp-chip" data-state={state}>
      <span className="vp-chip__dot" aria-hidden="true" />
      {typeof n === 'number' ? <b>{n}</b> : null}
      {STATE_LABEL[state]}
    </span>
  );
}

export function StatGrid({ items }: { items: { label: string; value: ReactNode; hint?: string; state?: FourState }[] }) {
  return (
    <div className="vp-stats">
      {items.map((it) => (
        <div className="vp-stat" key={it.label}>
          <div className="vp-stat__value" data-state={it.state}>{it.value}</div>
          <div className="vp-stat__label">{it.label}</div>
          {it.hint ? <div className="vp-stat__hint">{it.hint}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** 未接后端 / 无数据的诚实空态 */
export function Empty({ title, detail }: { title: string; detail: ReactNode }) {
  return (
    <div className="vp-emptybox">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

export function KV({ rows }: { rows: { k: string; v: ReactNode }[] }) {
  return (
    <div className="vp-kv">
      {rows.map((r) => (
        <div className="vp-kv__row" key={r.k}>
          <span>{r.k}</span>
          <code>{r.v}</code>
        </div>
      ))}
    </div>
  );
}
`);

// ══ 验证场景：真实四态 ══
w('src/scenes/Verify.tsx', `import { snapshot, fourStateTotals } from '../data';
import { Page, Section, StateChip, StatGrid, Empty, KV } from '../components/ui';

/**
 * 验证中心 —— 数据全部来自 tools/gen-snapshot.mjs 跑出来的真实结果。
 * 四态严格分开：判不了（unknown）绝不计入通过。
 */
export default function Verify() {
  const t = fourStateTotals();
  const suites = snapshot.verify.suites;

  return (
    <Page>
      <Section
        title="总览"
        desc={<>数据来自 <code>tools/gen-snapshot.mjs</code> 跑我们自己的验收器，不是演示数据。判不了单列，不并入通过。</>}
      >
        <StatGrid items={[
          { label: '通过', value: t.pass, state: 'pass' },
          { label: '待补', value: t.warn, state: 'warn' },
          { label: '失败', value: t.fail, state: 'fail' },
          { label: '判不了', value: t.unknown, state: 'unknown' },
        ]} />
      </Section>

      <Section title="套件" desc={<>共 {suites.length} 个可执行验收器。</>}>
        <div className="vp-table">
          <div className="vp-table__head">
            <span>套件</span><span>状态</span><span>通过</span><span>失败</span><span>判不了</span><span>耗时</span>
          </div>
          {suites.map((s) => (
            <div className="vp-table__row" key={s.id}>
              <span className="vp-table__name">{s.name}<code>{s.file.replace('prototype/', '')}</code></span>
              <span><StateChip state={s.state} /></span>
              <span className="vp-num">{s.pass}</span>
              <span className="vp-num">{s.fail}</span>
              <span className="vp-num">{s.unknown}</span>
              <span className="vp-num vp-dim">{s.ms}ms</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="断言明细" desc={<>只显示脚本自己逐行输出的断言，最多 200 条。</>}>
        {suites.every((s) => s.checks.length === 0) ? (
          <Empty title="脚本没有逐行输出断言" detail="部分验收器只打印汇总；要看到逐条，需要脚本统一输出格式。" />
        ) : (
          <div className="vp-checks">
            {suites.flatMap((s) => s.checks.map((c, i) => (
              <div className="vp-check" key={s.id + i} data-state={c.ok}>
                <span className="vp-check__dot" aria-hidden="true" />
                <span className="vp-check__text">{c.text}</span>
                <code className="vp-check__suite">{s.name}</code>
              </div>
            )))}
          </div>
        )}
      </Section>

      <Section title="怎么更新这些数字">
        <KV rows={[
          { k: '生成命令', v: 'node tools/gen-snapshot.mjs' },
          { k: '快照文件', v: 'apps/agent-ui/src/data/snapshot.json' },
          { k: '生成时间', v: snapshot.generatedAt },
          { k: '数据来源', v: snapshot.source.label },
        ]} />
      </Section>
    </Page>
  );
}
`);

// ══ 能力场景：真实清单 + 诚实空态 ══
w('src/scenes/Capabilities.tsx', `import { snapshot } from '../data';
import { Page, Section, Empty, KV } from '../components/ui';

function NameList({ items, empty }: { items: { name: string; source: string }[]; empty: string }) {
  if (!items.length) return <Empty title="空" detail={empty} />;
  return (
    <div className="vp-table">
      {items.map((it) => (
        <div className="vp-table__row vp-table__row--2" key={it.name}>
          <span className="vp-table__name">{it.name}</span>
          <code className="vp-dim">{it.source}</code>
        </div>
      ))}
    </div>
  );
}

/**
 * 能力 —— 取自仓库真实目录。
 * 技能 / MCP / 模型目前确实为空，就显示空，不拿示例条目凑数。
 */
export default function Capabilities() {
  const c = snapshot.capabilities;
  const total = c.skills.length + c.mcp.length + c.tools.length + c.patches.targets.length + c.models.length;

  return (
    <Page>
      <Section
        title={'清单 · ' + total + ' 项'}
        desc={<>{c.source}。{c.note}</>}
      >
        <KV rows={[
          { k: '技能', v: c.skills.length + ' 个' },
          { k: 'MCP', v: c.mcp.length + ' 个' },
          { k: '工具', v: c.tools.length + ' 个' },
          { k: '补丁集', v: c.patches.targets.length + ' 个' },
          { k: '模型', v: c.models.length + ' 个' },
        ]} />
      </Section>

      <Section title="工具" desc={<>仓库 <code>tools/</code> 下的脚本。</>}>
        <NameList items={c.tools} empty="还没有工具脚本。" />
      </Section>

      <Section title="补丁集" desc={<>仓库 <code>hermes-patches/</code> 下的目标。</>}>
        <NameList items={c.patches.targets.map((n) => ({ name: n, source: 'hermes-patches/' }))} empty="还没有补丁集。" />
      </Section>

      <Section title="技能" desc={<>来自 <code>.claude/skills/</code>。</>}>
        <NameList items={c.skills} empty="本仓还没有技能目录。等技能接入后再列。" />
      </Section>

      <Section title="MCP" desc={<>外部工具服务器。</>}>
        <NameList items={c.mcp} empty="还没配置任何 MCP server —— 空就是空。" />
      </Section>

      <Section title="模型" desc={<>模型网关与供应商。</>}>
        <NameList items={c.models} empty="还没接模型网关 —— 空就是空。" />
      </Section>
    </Page>
  );
}
`);

// ══ 会话场景：本地可交互，明确标注未接后端 ══
w('src/scenes/Session.tsx', `import { useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { Page, Empty } from '../components/ui';

interface Msg { id: number; role: 'user' | 'system'; text: string; at: string }

/**
 * 会话 —— 目前是**本地草稿**：能输入、能发、能看见消息流，
 * 但没有后端，所以助手不会回复。页头明确标注这一点，不假装能用。
 */
export default function Session() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const seq = useRef(0);

  const send = () => {
    const v = text.trim();
    if (!v) return;
    seq.current += 1;
    setMsgs((m) => [...m, { id: seq.current, role: 'user', text: v, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) }]);
    setText('');
  };

  return (
    <div className="vp-chat">
      <div className="vp-chat__banner">
        本地草稿 · 未接后端
        <span>消息不会离开这台机器，助手也不会回复 —— 后端接入在 S3。</span>
      </div>

      <div className="vp-chat__scroll">
        {msgs.length === 0 ? (
          <Empty
            title="还没有消息"
            detail="在下面输入点什么试试：输入框、发送、消息流都是真的；只是没有后端来回复。"
          />
        ) : (
          msgs.map((m) => (
            <div className={'vp-msg vp-msg--' + m.role} key={m.id}>
              <div className="vp-msg__head">
                <span>{m.role === 'user' ? '你' : '系统'}</span>
                <code>{m.at}</code>
              </div>
              <div className="vp-msg__body">{m.text}</div>
            </div>
          ))
        )}
      </div>

      <div className="vp-composer">
        <textarea
          className="vp-composer__input"
          placeholder="说点什么（Enter 发送，Shift+Enter 换行）"
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        <div className="vp-composer__bar">
          <span className="vp-composer__hint">未接后端 · 不会真的回复</span>
          <button type="button" className="vp-send" onClick={send} disabled={!text.trim()}>
            <Send size={13} strokeWidth={2} /> 发送
          </button>
        </div>
      </div>
    </div>
  );
}
`);

// ══ 任务 / 记忆：诚实空态 ══
w('src/scenes/Tasks.tsx', `import { Page, Section, Empty } from '../components/ui';
import { snapshot } from '../data';

export default function Tasks() {
  return (
    <Page>
      <Section title="任务与派单" desc="定时任务、派单、执行记录都在后端。界面先占位，不拿假任务填充。">
        {snapshot.tasks.length === 0
          ? <Empty title="还没有任务" detail="需要接入调度器（cron + 派单台账）后才会出现条目。当前 0 条。" />
          : null}
      </Section>
      <Section title="为什么这里是空的">
        <p className="vp-sec__p">
          任务的数据源是后端调度器，不是本地快照。在接入之前，这个场景保持空态 ——
          空白是真实状态，塞几条演示任务才是假的。
        </p>
      </Section>
    </Page>
  );
}
`);

w('src/scenes/Memory.tsx', `import { Page, Section, Empty } from '../components/ui';
import { snapshot } from '../data';

export default function Memory() {
  return (
    <Page>
      <Section title="跨会话记忆" desc="记忆的写入、检索与 TTL 过期都在后端。">
        {snapshot.memory.length === 0
          ? <Empty title="还没有记忆条目" detail="需要接入记忆库后才会出现。当前 0 条。" />
          : null}
      </Section>
      <Section title="设计约束">
        <p className="vp-sec__p">
          记忆条目必须带 <code>evidenceId</code> 回指来源，可复算；过期条目要能查到「什么时候清的、为什么」。
          没有这套约束，记忆就会变成不可验证的聊天记录。
        </p>
      </Section>
    </Page>
  );
}
`);

// ══ 总览：真实仪表盘（令牌演示移到 /dev 说明里）══
w('src/scenes/Overview.tsx', `import { snapshot, fourStateTotals } from '../data';
import { Page, Section, StateChip, StatGrid, KV } from '../components/ui';
import { SCENES } from './registry';

/**
 * 总览 —— 一屏看清当前状态：验收四态、能力规模、数据来源。
 * 全部来自本地快照（tools/gen-snapshot.mjs），没有编造数字。
 */
export default function Overview() {
  const t = fourStateTotals();
  const c = snapshot.capabilities;
  const bad = snapshot.verify.suites.filter((s) => s.state === 'fail' || s.state === 'unknown');

  return (
    <Page>
      <Section title="产品" desc={<>四鉴 Vouch · {snapshot.about.version} · {snapshot.about.stage}</>}>
        <KV rows={[
          { k: '场景', v: SCENES.length + ' 个' },
          { k: '主题', v: '明 / 暗 两套（同一套令牌名）' },
          { k: '密度', v: '紧凑 / 宽松（只缩放间距）' },
          { k: '后端', v: '未接 —— 界面上如实标注' },
        ]} />
      </Section>

      <Section title="验收四态" desc={<>合计 {t.pass + t.warn + t.fail + t.unknown} 条断言，来自 {snapshot.verify.suites.length} 个真实验收器。</>}>
        <StatGrid items={[
          { label: '通过', value: t.pass, state: 'pass' },
          { label: '待补', value: t.warn, state: 'warn' },
          { label: '失败', value: t.fail, state: 'fail' },
          { label: '判不了', value: t.unknown, state: 'unknown' },
        ]} />
        {bad.length ? (
          <div className="vp-notice">
            <strong>有 {bad.length} 个套件不是全绿：</strong>
            {bad.map((s) => (
              <span className="vp-notice__item" key={s.id}>
                <StateChip state={s.state} /> {s.name}
                {s.unknown ? <code>判不了 {s.unknown}</code> : null}
              </span>
            ))}
          </div>
        ) : (
          <div className="vp-notice vp-notice--ok"><strong>全部套件通过</strong></div>
        )}
      </Section>

      <Section title="能力规模" desc={c.note}>
        <StatGrid items={[
          { label: '工具', value: c.tools.length },
          { label: '补丁集', value: c.patches.targets.length },
          { label: '技能', value: c.skills.length, hint: '未接入' },
          { label: 'MCP', value: c.mcp.length, hint: '未配置' },
          { label: '模型', value: c.models.length, hint: '未接入' },
        ]} />
      </Section>
    </Page>
  );
}
`);

// ══ 关于：诊断信息 ══
w('src/scenes/About.tsx', `import { Page, Section, KV, StateChip } from '../components/ui';
import { snapshot, generatedAtLabel } from '../data';

export default function About() {
  const a = snapshot.about;
  return (
    <Page>
      <Section title="四鉴 Vouch" desc="agent 工作台 · 四态验证优先">
        <KV rows={[
          { k: '版本', v: a.version },
          { k: '阶段', v: a.stage },
          { k: '产品', v: a.product },
          { k: '运行环境', v: 'Node ' + a.node },
        ]} />
      </Section>

      <Section title="数据来源" desc="界面上每个数字都要能追到这里。">
        <KV rows={[
          { k: '来源类型', v: snapshot.source.kind },
          { k: '来源', v: snapshot.source.label },
          { k: '生成器', v: snapshot.generator },
          { k: '生成时间', v: generatedAtLabel() },
          { k: '快照版本', v: 'schema v' + snapshot.schemaVersion },
        ]} />
        <p className="vp-sec__p">{snapshot.source.detail}。</p>
      </Section>

      <Section title="套件状态" desc="与「验证」场景同源。">
        <div className="vp-table">
          {snapshot.verify.suites.map((s) => (
            <div className="vp-table__row vp-table__row--2" key={s.id}>
              <span className="vp-table__name">{s.name}</span>
              <StateChip state={s.state} />
            </div>
          ))}
        </div>
      </Section>
    </Page>
  );
}
`);

console.log('\n  8 个场景已补全');
