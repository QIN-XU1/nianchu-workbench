/**
 * 联网与图像工具（A3 联网 / A4 多模态）
 *
 * ══ 为什么单独一个文件 ═════════════════════════════════════════
 * toolkit.mjs 一度长到 35.6KB，撞了单文件 32KB 红线。门禁要求「拆或加白名单」，
 * 选了拆：把不依赖闭包状态的联网/图像工具搬出来（它们只用 ctx 与动态 import），
 * toolkit 只负责把它们注册进去。这样每个文件都在红线内，职责也更清楚。
 */

/** 注册联网与图像工具到 tools 表 */
export function addNetTools(tools) {
  // ── web_search / web_fetch（A3 联网搜索与抓取）──────────────
  /**
   * 把**已有的**联网模块接进 agent 工具面。
   *
   * 【为什么现在才接】tools/net/{search,fetch}.mjs 早就存在，还有 verify-net 28 项验收、
   * 一个 Net 界面 —— 但 agent **根本拿不到**：它只有 bash/read/write/edit/glob/grep。
   * 于是 A3 在矩阵里只是"我们有个模块"，不是"念初会联网"。
   * 模块存在 ≠ 能力可用，这一条本轮补上。
   */
  tools.web_fetch = {
    name: 'web_fetch',
    readOnly: true,
    description: [
      '抓取一个 http(s) 页面并提取正文（去脚本/样式/标签，保留段落）。',
      '返回四态：PASS=拿到正文 / WARN=通了但正文很少 / FAIL=HTTP 错误 / UNKNOWN=连不上。',
      '只允许 http 与 https；file:// 等本地协议会被拒绝。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整 http(s) URL' },
        max_chars: { type: 'number', description: '正文字符上限，默认 8000' },
      },
      required: ['url'],
    },
    call: async (input) => {
      const url = String(input.url || '').trim();
      if (!url) return { ok: false, state: 'FAIL', error: 'url 必填' };
      // 安全：只放行 http(s)。这不是"越界拦截"，是工具自身的输入契约。
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, state: 'FAIL', error: '只支持 http(s) URL，拒绝：' + url.slice(0, 60) };
      }
      const cap = Math.max(500, Math.min(60000, Number(input.max_chars) || 8000));
      try {
        const { capture } = await import('../net/search.mjs');
        const r = await capture(url);
        const text = String(r.text || '');
        const truncated = text.length > cap;
        return {
          ok: r.state === 'PASS' || r.state === 'WARN',
          state: r.state,
          why: r.why || null,
          url,
          title: r.title || null,
          chars: text.length,
          truncated,
          text: truncated ? text.slice(0, cap) : text,
          note: truncated ? '正文超过 ' + cap + ' 字，已截断（可用 max_chars 调大）' : null,
        };
      } catch (e) {
        return { ok: false, state: 'UNKNOWN', error: '抓取异常：' + String(e && e.message ? e.message : e).slice(0, 200) };
      }
    },
  };

  tools.web_search = {
    name: 'web_search',
    readOnly: true,
    description: [
      '联网搜索，返回标题 + 链接 + 摘要列表。',
      '摘要不足以作为依据时，用 web_fetch 打开原页面读正文。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词' },
        limit: { type: 'number', description: '最多几条，默认 5' },
      },
      required: ['query'],
    },
    call: async (input) => {
      const q = String(input.query || '').trim();
      if (!q) return { ok: false, state: 'FAIL', error: 'query 必填' };
      const limit = Math.max(1, Math.min(20, Number(input.limit) || 5));
      try {
        const { search } = await import('../net/search.mjs');
        const r = await search(q, { limit });
        return {
          ok: r.state === 'PASS',
          state: r.state,
          why: r.why || null,
          query: q,
          count: Array.isArray(r.results) ? r.results.length : 0,
          results: (r.results || []).slice(0, limit).map((x) => ({
            title: x.title, url: x.url, snippet: x.snippet,
          })),
          note: r.state === 'PASS' ? null : '搜索没拿到结果，不代表没有答案 —— 换关键词或直接 web_fetch 已知 URL',
        };
      } catch (e) {
        return { ok: false, state: 'UNKNOWN', error: '搜索异常：' + String(e && e.message ? e.message : e).slice(0, 200) };
      }
    },
  };

  // ── apply_patch（A1 代码编辑与 diff 应用）──────────────
  /**
   * 应用一份 unified diff。
   * 与 edit 的分工：edit 适合"我知道旧串、换新串"；apply_patch 适合"我拿到了一份 patch 文件"。
   * 有变更集时会把 before/after 记进去，所以照样能回滚。
   */
  tools.apply_patch = {
    name: 'apply_patch',
    readOnly: false,
    description: [
      '把一份 unified diff 应用到文件（`--- a/x` / `+++ b/x` / `@@ ... @@`）。',
      '上下文必须逐行精确匹配：本地已漂移就整文件失败、一个字节都不改（不做模糊匹配）。',
      'dry_run=true 只报告能不能应用，不写盘。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'unified diff 全文' },
        dry_run: { type: 'boolean', description: '只检查不写盘，默认 false' },
      },
      required: ['patch'],
    },
    call: async (input, ctx) => {
      const text = String(input.patch || '');
      if (!text.trim()) return { ok: false, state: 'FAIL', reason: 'patch 为空' };
      const { applyPatch } = await import('./patch.mjs');
      const dryRun = input.dry_run === true;

      /**
       * 变更集快照：钩子形状是 { before(absPath), after(absPath) }，
       * where before() 自己读文件内容。所以必须在**写盘之前**调用 before，
       * 否则记录到的"变更前"其实已经是变更后（那就回滚不回去了）。
       */
      const { join, isAbsolute } = await import('node:path');
      const cwd = (ctx && ctx.cwd) || process.cwd();
      const paths = [];
      if (ctx && ctx.changeset && !dryRun) {
        try {
          const { parsePatch } = await import('./patch.mjs');
          for (const f of parsePatch(text)) {
            paths.push(isAbsolute(f.path) ? f.path : join(cwd, f.path));
          }
          for (const abs of paths) {
            try { ctx.changeset.before(abs); } catch { /* 快照失败不阻断应用 */ }
          }
        } catch { /* 解析失败就退化为无快照 */ }
      }

      const r = applyPatch(text, { cwd, dryRun });

      if (ctx && ctx.changeset && !dryRun) {
        const okPaths = new Set(r.files.filter((x) => x.ok).map((x) => x.path));
        for (const abs of paths) {
          const rel = abs.slice(cwd.length).replace(/^[\\/]/, '').split('\\').join('/');
          if (!okPaths.has(rel) && !okPaths.has(abs)) continue;
          try { ctx.changeset.after(abs); } catch { /* ignore */ }
        }
      }

      return {
        ok: r.state === 'PASS',
        state: r.state,
        dryRun: r.dryRun,
        reason: r.reason,
        files: r.files,
      };
    },
  };

  // ── read_image（A4 多模态输入）──────────────
  /**
   * 读一张本地图片，**真的交给模型看**，返回它的描述 + 尺寸。
   *
   * 【为什么做成工具而不是改消息管线】网关已实测支持 image_url（base64 data URL）输入，
   * 但把图片塞进主对话消息会污染上下文（一张图几百 token 起，且后续每轮都要重发）。
   * 做成工具：agent 想看哪张图就"看"一次，拿回文字描述，主对话保持轻。
   */
  tools.read_image = {
    name: 'read_image',
    readOnly: true,
    description: [
      '读取本地图片文件并让模型"看"它，返回内容描述与像素尺寸。',
      '支持 png/jpg/jpeg/webp/gif。只接受绝对路径或相对 cwd 的路径。',
      '不是图片文件会被拒绝（不是靠扩展名猜，会检查文件头）。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '图片路径' },
        question: { type: 'string', description: '可选：想问关于这张图的问题，默认让它描述内容' },
      },
      required: ['path'],
    },
    call: async (input, ctx) => {
      const p = String(input.path || '').trim();
      if (!p) return { ok: false, state: 'FAIL', error: 'path 必填' };
      const { readFileSync, existsSync, statSync } = await import('node:fs');
      const { join, isAbsolute, extname } = await import('node:path');
      const abs = isAbsolute(p) ? p : join((ctx && ctx.cwd) || process.cwd(), p);
      if (!existsSync(abs)) return { ok: false, state: 'FAIL', error: '文件不存在：' + p };
      try { if (!statSync(abs).isFile()) return { ok: false, state: 'FAIL', error: '不是普通文件' }; } catch { /* ignore */ }

      const buf = readFileSync(abs);
      // 按文件头判定，不靠扩展名
      const mime = sniffImageMime(buf);
      if (!mime) return { ok: false, state: 'FAIL', error: '不是受支持的图片（文件头不匹配 png/jpg/webp/gif）' };
      if (buf.length > 8 * 1024 * 1024) return { ok: false, state: 'FAIL', error: '图片超过 8MB，太大' };
      void extname;

      const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
      const question = String(input.question || '').trim() || '简要描述这张图片的内容；如果是纯色或图表，说明主要颜色与元素。';

      try {
        const { callModel } = await import('./runtime.mjs');
        const r = await callModel({
          messages: [{ role: 'user', content: [
            { type: 'text', text: question },
            { type: 'image_url', image_url: { url: dataUrl } },
          ] }],
          maxTokens: 400,
        });
        if (r.state !== 'PASS') {
          return { ok: false, state: r.state === 'FAIL' ? 'FAIL' : 'UNKNOWN', error: String(r.reason || r.state).slice(0, 200) };
        }
        return {
          ok: true,
          state: 'PASS',
          path: p,
          mime,
          bytes: buf.length,
          description: r.content,
        };
      } catch (e) {
        return { ok: false, state: 'UNKNOWN', error: '视觉调用异常：' + String(e && e.message ? e.message : e).slice(0, 200) };
      }
    },
  };


  return tools;
}

/** 按文件头识别图片类型；不是图片返回 null */
export function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
