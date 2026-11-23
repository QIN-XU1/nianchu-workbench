/**
 * 给场景卡和详情加健康度可视化
 *
 * 数据：shared.health.scenes[<sceneId>] = {
 *   tasks, acked, rework, firstPass, firstPassRate, reworkRate,
 *   crossBoundary, verdict, hasEnoughSamples
 * }
 */

import fs from 'node:fs';

const P = 'D:/file/AI Temp/DeepSeek/Agent自研/plugins/memory-neuron/client.js';
let s = fs.readFileSync(P, 'utf8');

// ══════════════════════════════════════════════════════════
//  1. CSS：健康度条 / 指标组
// ══════════════════════════════════════════════════════════
const css = `
/* ── 健康度条（场景卡内）── */
.mn-hbar{display:flex;align-items:center;gap:6px;margin-top:8px;}
.mn-hbar-track{flex:1 1 auto;height:3px;border-radius:2px;
  background:var(--dsw-alias-border-l1);overflow:hidden;min-width:0;}
.mn-hbar-fill{height:100%;border-radius:2px;transition:width .3s ease;}
.mn-hbar-label{font-size:10.5px;color:var(--dsw-alias-label-tertiary);
  flex:0 0 auto;font-variant-numeric:tabular-nums;}

/* ── 详情里的健康度指标组 ── */
.mn-hmetrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));
  gap:8px;margin:4px 0 12px;}
.mn-hmetric{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;
  padding:8px 10px;background:var(--dsw-alias-bg-base);min-width:0;}
.mn-hmetric-k{color:var(--dsw-alias-label-tertiary);font-size:10.5px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mn-hmetric-v{font-size:15px;font-weight:600;line-height:1.25;
  font-variant-numeric:tabular-nums;}
.mn-hmetric-sub{color:var(--dsw-alias-label-tertiary);font-size:10px;margin-top:1px;}
`;

const anchor = '/* ── 空/错 ── */';
s = s.replace(anchor, css + '\n' + anchor);

// ══════════════════════════════════════════════════════════
//  2. 场景卡加健康度条
// ══════════════════════════════════════════════════════════
const cardAnchor = `        h('div', { key: 'tags', className: 'mn-card-tags' }, [
          tag('契约', scene.hasContract),
          tag('身份', scene.hasIdentity),
          tag('记忆', scene.hasMemory),
          tag('技能', scene.hasSkill),
          h('span', {
            key: 'p', className: 'mn-tag', style: { marginLeft: 'auto' },
          }, scene.panels + ' 面板'),
        ]),
      ]);`;

const cardNew = `        h('div', { key: 'tags', className: 'mn-card-tags' }, [
          tag('契约', scene.hasContract),
          tag('身份', scene.hasIdentity),
          tag('记忆', scene.hasMemory),
          tag('技能', scene.hasSkill),
          h('span', {
            key: 'p', className: 'mn-tag', style: { marginLeft: 'auto' },
          }, scene.panels + ' 面板'),
        ]),
        HealthBar({ key: 'hb', scene }),
      ]);`;

if (!s.includes(cardAnchor)) {
  console.log('WARN: 场景卡锚点未找到');
} else {
  s = s.replace(cardAnchor, cardNew);
  console.log('✓ 场景卡已接入健康度条');
}

// ══════════════════════════════════════════════════════════
//  3. 插入 HealthBar 组件（在 SceneCard 之前）
// ══════════════════════════════════════════════════════════
const healthComp = `
    // ══════════════════════════════════════════════════════
    //  健康度可视化
    //
    //  数据来源：_共享记忆/健康度.json 的 scenes[<id>]
    //    tasks / acked / rework / firstPass / firstPassRate /
    //    reworkRate / crossBoundary / verdict / hasEnoughSamples
    //
    //  设计：只用一根细条表达一次通过率，
    //        样本不足时显示"待采样"而不是画一根空条（空条会被误读为 0%）。
    // ══════════════════════════════════════════════════════
    function healthColorOf(rate) {
      if (rate === null || rate === undefined) return STATE_COLORS.none;
      if (rate >= 0.8) return STATE_COLORS.good;
      if (rate >= 0.5) return STATE_COLORS.ok;
      if (rate >= 0.3) return STATE_COLORS.warn;
      return STATE_COLORS.bad;
    }

    function HealthBar({ scene }) {
      const hdata = scene.health;
      // 无健康度数据、或样本不足 → 显示"待采样"
      const rate = hdata ? hdata.firstPassRate : null;
      const hasData = rate !== null && rate !== undefined;

      if (!hasData) {
        return h('div', { className: 'mn-hbar' }, [
          h('div', { key: 't', className: 'mn-hbar-track' }),
          h('span', { key: 'l', className: 'mn-hbar-label' },
            hdata && hdata.tasks > 0 ? '待采样' : '无记录'),
        ]);
      }

      const pct = Math.round(rate * 100);
      return h('div', { className: 'mn-hbar' }, [
        h('div', { key: 't', className: 'mn-hbar-track' }, [
          h('div', {
            key: 'f',
            className: 'mn-hbar-fill',
            style: {
              width: Math.max(3, pct) + '%',
              background: healthColorOf(rate),
            },
          }),
        ]),
        h('span', { key: 'l', className: 'mn-hbar-label' }, pct + '%'),
      ]);
    }

`;

const compAnchor = '    // ══════════════════════════════════════════════════════\n    //  子组件：场景卡';
if (s.includes(compAnchor)) {
  s = s.replace(compAnchor, healthComp + compAnchor);
  console.log('✓ HealthBar 组件已插入');
} else {
  console.log('WARN: 组件锚点未找到');
}

// ══════════════════════════════════════════════════════════
//  4. 详情里加健康度指标组
// ══════════════════════════════════════════════════════════
const detailAnchor = `        h('div', { key: 'b', className: 'mn-detail-body' }, [
          h('div', { key: 'kv', className: 'mn-kv' }, [`;

const detailNew = `        h('div', { key: 'b', className: 'mn-detail-body' }, [
          HealthMetrics({ key: 'hm', scene }),
          h('div', { key: 'kv', className: 'mn-kv' }, [`;

if (s.includes(detailAnchor)) {
  s = s.replace(detailAnchor, detailNew);
  console.log('✓ 详情已接入健康度指标组');
} else {
  console.log('WARN: 详情锚点未找到');
}

// ══════════════════════════════════════════════════════════
//  5. 插入 HealthMetrics 组件
// ══════════════════════════════════════════════════════════
const metricsComp = `
    // 详情里的健康度指标组
    function HealthMetrics({ scene }) {
      const hdata = scene.health;
      if (!hdata || !hdata.tasks) return null;

      const fmtRate = (r) => (r === null || r === undefined
        ? '—'
        : Math.round(r * 100) + '%');

      const items = [
        { k: '任务数', v: String(hdata.tasks) },
        { k: '一次通过', v: fmtRate(hdata.firstPassRate) },
        { k: '返工率', v: fmtRate(hdata.reworkRate) },
        { k: '越界', v: String(hdata.crossBoundary || 0) },
      ];

      return h('div', { className: 'mn-hmetrics' },
        items.map((it) => h('div', { key: it.k, className: 'mn-hmetric' }, [
          h('div', { key: 'k', className: 'mn-hmetric-k' }, it.k),
          h('div', { key: 'v', className: 'mn-hmetric-v' }, it.v),
        ])));
    }

`;

const metricsAnchor = '    // ══════════════════════════════════════════════════════\n    //  子组件：场景详情';
if (s.includes(metricsAnchor)) {
  s = s.replace(metricsAnchor, metricsComp + metricsAnchor);
  console.log('✓ HealthMetrics 组件已插入');
} else {
  console.log('WARN: HealthMetrics 锚点未找到');
}

fs.writeFileSync(P, s, 'utf8');
console.log();
console.log('完成，行数: ' + s.split('\n').length);
