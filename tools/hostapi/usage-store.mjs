/**
 * 真实用量账本（供调用统计/热力图）。
 *
 * 每次 start_dialog_turn / submit_dialog_turn 拿到真实 usage 后就 record 一条；
 * get_token_usage_statistics 从这里按时间范围聚合出 UsageStatistics 结构。
 * 落盘 <REPO>/.host-usage.json（append；单机本地，不加密）。
 * 诚实：无记录就是 0/空数组，绝不编造。
 */
import fs from 'node:fs';
import { join } from 'node:path';

export function createUsageStore(REPO) {
  const FILE = join(REPO, '.host-usage.json');
  const readAll = () => { try { const a = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } };
  const saveAll = (a) => { try { fs.writeFileSync(FILE, JSON.stringify(a, null, 2) + '\n', 'utf8'); } catch (e) { process.stderr.write('[usage] persist failed: ' + (e && e.message) + '\n'); } };
  const dayKey = (iso) => { const d = new Date(iso); return isNaN(d) ? null : d.toISOString().slice(0, 10); };

  return {
    record(entry) {
      const a = readAll();
      a.push({
        at: entry.at || new Date().toISOString(),
        model: String(entry.model || 'unknown'),
        input: Number(entry.input) || 0,
        output: Number(entry.output) || 0,
        cacheRead: Number(entry.cacheRead) || 0,
        cacheWrite: Number(entry.cacheWrite) || 0,
      });
      // 只保留近 400 天，避免文件无限增长
      const cut = Date.now() - 400 * 86400 * 1000;
      saveAll(a.filter((r) => { const t = new Date(r.at).getTime(); return !isNaN(t) && t >= cut; }));
    },

    /** 从一次对话 turn 的返回里记账（有 usage 才记；任何异常都吞掉，绝不打断对话）。 */
    recordFromTurn(result) {
      try {
        if (result && result.usage) {
          this.record({
            at: new Date().toISOString(), model: result.model,
            input: result.usage.prompt_tokens, output: result.usage.completion_tokens,
          });
        }
      } catch (e) { void e; }
    },

    statistics(req = {}) {
      const all = readAll();
      const now = new Date();
      const sod = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      let start = 0; let end = now.getTime();
      switch (req.timeRange) {
        case 'today': start = sod.getTime(); break;
        case 'last24Hours': start = now.getTime() - 86400 * 1000; break;
        case 'thisWeek': start = sod.getTime() - 6 * 86400 * 1000; break;
        case 'thisMonth': start = new Date(now.getFullYear(), now.getMonth(), 1).getTime(); break;
        case 'custom': start = req.start ? new Date(req.start).getTime() : 0; end = req.end ? new Date(req.end).getTime() : now.getTime(); break;
        case 'all':
        default: start = 0;
      }
      // 热力图 custom 请求的 end 常是「当天日期(00:00)」，会把今天稍晚的记录排除在区间外；
      // 统一把显式 end 抬到当天 23:59:59.999，保证闭区间包含当天。
      if (req.end) { const x = new Date(req.end); end = Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate(), 23, 59, 59, 999); }
      const recs = all.filter((r) => { const t = new Date(r.at).getTime(); return !isNaN(t) && t >= start && t <= end; });

      let totalInputTokens = 0, totalOutputTokens = 0, totalCachedTokens = 0, totalCacheWriteTokens = 0;
      const byModel = new Map();
      const trendMap = new Map();
      for (const r of recs) {
        totalInputTokens += r.input; totalOutputTokens += r.output;
        totalCachedTokens += r.cacheRead; totalCacheWriteTokens += r.cacheWrite;
        const m = byModel.get(r.model) || { key: r.model, name: r.model, providerName: null, attributionStatus: 'resolved', requests: 0, tokens: 0, cacheHitRate: null };
        m.requests += 1; m.tokens += r.input + r.output; byModel.set(r.model, m);
        const day = dayKey(r.at);
        if (day) {
          const b = trendMap.get(day) || { bucket: day + 'T00:00:00.000Z', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: null };
          b.inputTokens += r.input; b.outputTokens += r.output; b.cacheReadTokens += r.cacheRead; b.cacheWriteTokens += r.cacheWrite;
          trendMap.set(day, b);
        }
      }
      const trend = [...trendMap.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
      return {
        totalRequests: recs.length,
        totalTokens: totalInputTokens + totalOutputTokens,
        totalInputTokens, totalOutputTokens,
        totalCachedTokens, totalCacheWriteTokens,
        totalCacheReportedInputTokens: 0,
        byModel: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
        byGroup: [], byEndpoint: [],
        trend,
        granularity: req.granularity === 'hour' ? 'hour' : 'day',
      };
    },
  };
}
