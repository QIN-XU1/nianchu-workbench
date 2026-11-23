import memRaw from '../data/memory.json';
import { Page, Section, StateChip, StatGrid } from '../components/ui';

interface MemEntry {
  id: string;
  key: string;
  value: string;
  source: string;
  state: 'fresh' | 'superseded' | 'expired' | 'conflicted';
  createdAt: string;
  lastSeen: string;
  touchCount: number;
  ttlSec: number | null;
  expiresAt: string | null;
  msLeft: number | null;
}

interface MemData {
  what: string;
  at: string;
  rule: string;
  totals: { total: number; fresh: number; expired: number; superseded: number; noSource: number; unresolvedConflict: number };
  audit: { ok: boolean; issues: string[] };
  entries: MemEntry[];
}

const mem = memRaw as unknown as MemData;

const STATE_LABEL: Record<MemEntry['state'], string> = {
  fresh: '有效',
  superseded: '被推翻',
  expired: '已过期',
  conflicted: '冲突',
};

/** 把「剩余毫秒」说成人话；无 TTL 说明永久 */
function ttlLabel(e: MemEntry): string {
  if (e.ttlSec === null) return '无 TTL';
  if (e.msLeft === null) return 'TTL ' + e.ttlSec + 's';
  if (e.msLeft <= 0) return '已过期 ' + Math.round(-e.msLeft / 1000) + 's';
  return '剩 ' + Math.round(e.msLeft / 1000) + 's';
}

function ageLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '刚刚';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒前';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' 分钟前';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' 小时前';
  return Math.round(h / 24) + ' 天前';
}

/**
 * 记忆 —— A7 治理视图
 *
 * 显示真实存储的状态：每条记忆的来源、有效状态、TTL 剩余。
 * 「被推翻」和「已过期」都**留着可见** —— 历史是信息，静默覆盖会让记忆变成不可信。
 */
export default function Memory() {
  const t = mem.totals;
  const live = mem.entries.filter((e) => e.state === 'fresh');
  const dead = mem.entries.filter((e) => e.state !== 'fresh');

  return (
    <Page>
      <Section
        title="记忆治理"
        desc={<>{mem.rule}</>}
        aside={<>采集于 {ageLabel(mem.at)}</>}
      >
        <StatGrid items={[
          { label: '有效', value: t.fresh, state: 'pass' },
          { label: '被推翻', value: t.superseded, hint: '历史保留' },
          { label: '已过期', value: t.expired, hint: 'history 仍可查' },
          { label: '无来源', value: t.noSource, state: t.noSource ? 'fail' : undefined, hint: '不许写入' },
          { label: '未解决冲突', value: t.unresolvedConflict, state: t.unresolvedConflict ? 'fail' : undefined },
        ]} />
        <div className={'vp-notice' + (mem.audit.ok ? ' vp-notice--ok' : '')}>
          <strong>{mem.audit.ok ? '治理达标' : '治理不达标'}</strong>
          {mem.audit.issues.length > 0 && (
            <span className="vp-dim">{mem.audit.issues.join('；')}</span>
          )}
          <span className="vp-dim">
            溯源底线：没有来源的记忆拒绝写入（凭印象的东西不许进存储）；
            同 key 更新不覆盖而是标「被推翻」，旧值永远可查。
          </span>
        </div>
      </Section>

      <Section title="有效记忆" desc={<>共 {live.length} 条，每条都带来源。</>}>
        {live.length === 0 ? (
          <div className="vp-notice vp-notice--warn"><strong>还没有有效记忆</strong></div>
        ) : (
          <div className="vp-mem">
            {live.map((e) => (
              <div className="vp-mem__row" data-state={e.state} key={e.id}>
                <div className="vp-mem__head">
                  <span className="vp-mem__key">{e.key}</span>
                  <span className="vp-mem__val">{e.value}</span>
                </div>
                <div className="vp-mem__meta">
                  <span className="vp-mem__src" title={e.source}>{e.source}</span>
                  <span className="vp-mem__tags">
                    <span className="vp-mem__ttl">{ttlLabel(e)}</span>
                    <span>{ageLabel(e.createdAt)}</span>
                    {e.touchCount > 1 && <span>确认 {e.touchCount} 次</span>}
                    <StateChip state="pass" />
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="历史（被推翻 / 已过期）"
        desc={<>这些不再参与结果，但**留着可见** —— 静默覆盖会让记忆变得不可信。</>}
      >
        {dead.length === 0 ? (
          <div className="vp-notice"><strong>没有历史条目</strong></div>
        ) : (
          <div className="vp-mem">
            {dead.map((e) => (
              <div className="vp-mem__row" data-state={e.state} key={e.id}>
                <div className="vp-mem__head">
                  <span className="vp-mem__key">{e.key}</span>
                  <span className="vp-mem__val vp-mem__val--old">{e.value}</span>
                </div>
                <div className="vp-mem__meta">
                  <span className="vp-mem__src" title={e.source}>{e.source}</span>
                  <span className="vp-mem__tags">
                    <span className="vp-mem__state" data-state={e.state}>{STATE_LABEL[e.state]}</span>
                    <span className="vp-mem__ttl">{ttlLabel(e)}</span>
                    <span>{ageLabel(e.createdAt)}</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </Page>
  );
}