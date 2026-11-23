// ui/core/commands.js —— 命令模式
//
// 设计要点：
// 1) 所有 UI 动作都走命令：可统一记录、可撤销、可测试（不依赖 DOM 事件）。
// 2) 命令 = { id, label, run(ctx), undo?(ctx) }
// 3) 历史环形缓冲（默认 50 条），只保留可撤销的。
// 4) 支持宏：macro([...]) 把多个命令合成一个原子动作。
// 5) 执行失败不影响栈（不进历史）。

export function createCommands({ state, bus, limit = 50, onError } = {}) {
  const registry = new Map();   // id -> command
  const undoStack = [];
  const redoStack = [];
  let running = false;

  function report(err, cmd) {
    if (typeof onError === 'function') { try { onError(err, cmd); return; } catch (_) { /* fall */ } }
    if (typeof console !== 'undefined') console.error('[cmd] 执行失败:', (cmd && cmd.id), err);
  }

  function ctx(extra) {
    return Object.assign({ state, bus }, extra || {});
  }

  const api = {
    /** 注册命令；重复 id 直接覆盖（便于热更新） */
    register(cmd) {
      if (!cmd || !cmd.id) throw new TypeError('[cmd] 命令必须有 id');
      if (typeof cmd.run !== 'function') throw new TypeError('[cmd] ' + cmd.id + ' 缺少 run()');
      registry.set(cmd.id, Object.freeze(Object.assign({}, cmd)));
      return api;
    },

    registerMany(list) {
      for (const c of list) api.register(c);
      return api;
    },

    has(id) { return registry.has(id); },
    list() { return [...registry.keys()]; },
    get(id) { return registry.get(id); },

    /**
     * 执行命令。
     * @param {string} id
     * @param {object} payload  传给 run(ctx, payload)
     * @param {object} opts     { record:false 不记历史 }
     */
    run(id, payload, opts) {
      const cmd = registry.get(id);
      if (!cmd) throw new Error('[cmd] 未注册的命令: ' + id);
      const o = opts || {};
      if (running) throw new Error('[cmd] 命令不可重入（' + id + ' 正在执行中）');

      running = true;
      let result;
      try {
        result = cmd.run(ctx(), payload);
      } catch (err) {
        running = false;
        report(err, cmd);
        throw err;
      } finally {
        running = false;
      }

      // 记录历史（只有声明了 undo 的才可撤销）
      if (o.record !== false && typeof cmd.undo === 'function') {
        undoStack.push({ id: cmd.id, payload });
        if (undoStack.length > limit) undoStack.shift();
        redoStack.length = 0;
      }
      if (bus) { try { bus.emit('command:run', { id: cmd.id, payload, result }); } catch (e) { /* ignore */ } }
      return result;
    },

    canUndo() { return undoStack.length > 0; },
    canRedo() { return redoStack.length > 0; },

    undo() {
      const entry = undoStack.pop();
      if (!entry) return false;
      const cmd = registry.get(entry.id);
      if (!cmd || typeof cmd.undo !== 'function') return false;
      try {
        cmd.undo(ctx(), entry.payload);
      } catch (err) { report(err, cmd); return false; }
      redoStack.push(entry);
      if (bus) { try { bus.emit('command:undo', entry); } catch (e) { /* ignore */ } }
      return true;
    },

    redo() {
      const entry = redoStack.pop();
      if (!entry) return false;
      const cmd = registry.get(entry.id);
      if (!cmd) return false;
      try { cmd.run(ctx(), entry.payload); } catch (err) { report(err, cmd); return false; }
      undoStack.push(entry);
      if (bus) { try { bus.emit('command:run', { id: entry.id, payload: entry.payload, redo: true }); } catch (e) { /* ignore */ } }
      return true;
    },

    /** 宏：多个命令作为一次原子动作（撤销时逆序执行各自的 undo） */
    macro(label, steps) {
      const id = 'macro:' + (label || 'unnamed') + ':' + Date.now();
      api.register({
        id,
        label: label || '宏',
        run(c, payload) {
          const results = [];
          for (const s of steps) {
            const sub = registry.get(s.id);
            if (!sub) throw new Error('[cmd] 宏内未注册命令: ' + s.id);
            results.push(sub.run(c, s.payload));
          }
          return results;
        },
        undo(c, payload) {
          for (let i = steps.length - 1; i >= 0; i--) {
            const sub = registry.get(steps[i].id);
            if (sub && typeof sub.undo === 'function') sub.undo(c, steps[i].payload);
          }
        },
      });
      return api.run(id, payload);
    },

    history() {
      return { undo: undoStack.slice(), redo: redoStack.slice() };
    },
    clearHistory() { undoStack.length = 0; redoStack.length = 0; },
  };

  return api;
}

export default createCommands;
