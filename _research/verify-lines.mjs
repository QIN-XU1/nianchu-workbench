import { readText } from './asar.mjs';

function lines(file, needles) {
  const t = readText(file);
  const ls = t.split('\n');
  console.log('### ' + file.join('/') + '  (' + ls.length + ' lines)');
  for (const n of needles) {
    let hits = [];
    ls.forEach((l, i) => { if (l.includes(n)) hits.push(i + 1); });
    console.log('  "' + n + '" -> ' + (hits.length ? hits.slice(0, 6).join(', ') : 'NONE'));
  }
}

lines(['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-jobs', 'lib', 'client.js'],
  ['function apply', 'const inject = [', 'ctx.locale.register("job"', 'conversation.session.header.actions']);

lines(['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-plugin-manager', 'lib', 'client.js'],
  ['function PluginsPanelIcon', 'const PANEL_ID', 'const NS =', 'function apply', 'ctx.locale.register(NS', '"main", function*', 'yield ctx.slots.register({', 'sidebar.panellist", () => ctx.slots.register']);

lines(['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-schedule', 'lib', 'client.js'],
  ['function TaskManagerIcon', 'const PANEL_ID', 'const NS =', 'function apply', 'const t = ctx.locale.bind(MANAGER_NS)', 'ctx.slots.inject("main"', 'ctx.slots.inject("sidebar.panellist"']);

lines(['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar', 'lib', 'client.js'],
  ['function PanelRow', 'entriesOfSlot("sidebar.panellist")', 'locale.subscribe(syncPanels)', '"sidebar.panellist": {']);

lines(['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-layout', 'lib', 'client.js'],
  ['function MainPanel', 'selectPanel(panelId)', 'retainMainPanels', '"main": {']);

lines(['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js'],
  ['conversation.user.text.node", function*', 'slots.inject("main", function*']);

lines(['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'],
  ['function installIconSprite', 'ui-theme: icon sprite', 'ICON_SYMBOLS']);

lines(['dsh', 'node_modules', '@deepseek-ai', 'dsh-cordis-client-runner', 'lib', 'client.js'],
  ['var DynamicCordisStyles', 'async function evaluateClientHalf', 'name: "styles"', 'function guardedSlots']);

lines(['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-renderer', 'lib', 'client.js'],
  ['inject(key, callback)', 'SlotRegistry.prototype.register', 'entry.locale !== void 0', 'function localeSeat']);

lines(['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-locale', 'lib', 'client.js'],
  ['register(ns, localeOrDicts, dict)', 'bind(ns)', 'translate(ns, key, params)']);

lines(['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-modules', 'lib', 'index.js'],
  ['function parseDshClient', 'decl.platform !== "web"', 'function orderByModuleGraph', 'function graphRow']);
