/**
 * 技能相关 RPC 方法（第 121 轮从 ws-host.mjs 抽出）
 *
 * ══ 为什么单独一个文件 ══════════════════════════════════════════════
 * ws-host.mjs 加完技能市场/安装后到了 33.5KB，破了仓库 32KB 单文件红线。
 * 按仓库规矩「超红线必须拆」，把技能相关的方法整体搬到这里。
 * 拆分原则：按**领域**拆，不是按行数硬切 —— 技能相关的方法自成一块，
 * 依赖也干净（只需要 loader / install / market 三个模块 + REPO 根路径）。
 *
 * ══ 提供的方法 ═══════════════════════════════════════════════════════
 *   get_skill_configs               技能清单（前端 SkillInfo 形状）
 *   miniapp_market_installed_origins 已装技能的来源聚合（原先是假数据 []）
 *   skill_market_search             市场检索（本地索引 + 技能池，不联网）
 *   skill_manage                    安装 / 卸载 / 列出已装
 *
 * ⛔ 不做越界拦截：只做文件搬运与校验，不执行技能里的命令、不联网。
 */
import { join } from 'node:path';
import { createSkillLoader } from '../skills/loader.mjs';
import { listInstalled, installSkill, uninstallSkill } from '../skills/install.mjs';
import { search as searchSkills } from '../skills/market.mjs';

/**
 * @param {string} REPO 仓库根目录
 * @returns {Record<string, Function>} 可直接并进 ws-host 的方法表
 */
export function skillMethods(REPO) {
  const TARGET = join(REPO, 'prototype/scenes');

  return {
    /**
     * 技能清单 —— 数据源：tools/skills/loader.mjs 扫 prototype/scenes。
     * 形状对齐 infrastructure/config/types/index.ts:561 SkillInfo
     * （level 只能是 user|project）。
     */
    get_skill_configs: () => {
      const loader = createSkillLoader([TARGET]).scanAll();
      return loader.list().map((s) => ({
        key: 'scene:' + s.name,
        name: s.name,
        description: s.description || '',
        path: join(TARGET, s.name),
        entryFile: 'SKILL.md',
        level: 'project',
        sourceSlot: 'project',
        dirName: s.name,
        isBuiltin: false,
      }));
    },

    /**
     * 已安装技能来源 —— 原来这里返回 `[]` 是**假数据**（永远空）。
     * 现在有真实安装清单（installed.json），按来源聚合后返回；
     * 没装过任何东西时如实返回空数组（而不是编一个）。
     */
    miniapp_market_installed_origins: () => {
      const { rows } = listInstalled(TARGET);
      const byOrigin = new Map();
      for (const r of rows) {
        const o = r.origin || 'unknown';
        if (!byOrigin.has(o)) byOrigin.set(o, []);
        byOrigin.get(o).push(r.name);
      }
      return [...byOrigin.entries()].map(([origin, names]) => ({ origin, count: names.length, skills: names }));
    },

    /**
     * 技能市场检索
     * params: { query?: string, category?: string, limit?: number }
     * 只查本地索引 + 技能池，不联网（理由见 tools/skills/market.mjs 头部注释）。
     */
    skill_market_search: (params) => {
      const p = params && typeof params === 'object' ? params : {};
      return searchSkills({
        target: TARGET,
        query: typeof p.query === 'string' ? p.query : '',
        category: typeof p.category === 'string' ? p.category : null,
        limit: Number.isFinite(p.limit) ? Math.max(1, Math.min(200, p.limit)) : 50,
      });
    },

    /**
     * 安装 / 卸载 / 列出已装
     * params: { action: 'install'|'uninstall'|'list', source?, name?, force?, dryRun?, purge? }
     * 不执行技能里的任何命令，只做文件搬运 + 校验。
     */
    skill_manage: (params) => {
      const p = params && typeof params === 'object' ? params : {};
      const action = String(p.action || '').toLowerCase();
      if (action === 'list') return listInstalled(TARGET);
      if (action === 'install') {
        return installSkill({
          source: p.source,
          name: p.name,
          target: TARGET,
          force: !!p.force,
          dryRun: !!p.dryRun,
          origin: typeof p.origin === 'string' ? p.origin : 'rpc',
        });
      }
      if (action === 'uninstall') {
        return uninstallSkill({ name: p.name, target: TARGET, dryRun: !!p.dryRun, purge: !!p.purge });
      }
      return { ok: false, code: 'bad_action', error: 'action 必须是 install / uninstall / list' };
    },
  };
}
