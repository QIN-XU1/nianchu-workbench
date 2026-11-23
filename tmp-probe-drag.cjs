// 探针：验证面板宽拖拽（Z.29）在 47124 运行版里是否真的工作
const http = require("http");
const targets = await new Promise((res, rej) => http.get("http://127.0.0.1:9223/json", (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
console.log("targets:", targets.map(t => `${t.type} ${t.url}`).filter(s => /47124/.test(s)));
const page = targets.find((t) => t.type === "page" && t.url.includes("47124"));
if (!page) { console.log("NO 47124 PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { ERR: r.exceptionDetails.text };
  return r.result.value;
};
await new Promise((r) => (ws.onopen = r));
await send("Runtime.enable");
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 7000));
const state = await ev(`(() => {
  const panel = document.querySelector(".openbitfun-fmc__panel");
  const resizer = document.querySelector(".openbitfun-fmc__resizer");
  return {
    panel: panel ? panel.getBoundingClientRect().width : null,
    open: panel ? panel.className : null,
    resizer: !!resizer,
    resizerRect: resizer ? (r => ({ left: r.left, width: r.width, height: r.height }))(resizer.getBoundingClientRect()) : null,
    cssVar: panel ? getComputedStyle(panel).getPropertyValue("--openbitfun-fmc-dock-width") : null,
  };
})()`);
console.log("STATE:", JSON.stringify(state));
if (!state.resizer || !state.resizerRect) { console.log("resizer 不存在 —— 运行版是旧包"); process.exit(0); }
// 拖拽：从 resizer 中线向左拖 120px
const r = state.resizerRect;
const startX = r.left + r.width / 2;
const startY = r.height > 0 ? (await ev(`(() => { const p = document.querySelector(".openbitfun-fmc__resizer"); const b = p.getBoundingClientRect(); return b.top + b.height / 2; })()`)) : 400;
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: startX, y: startY });
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: startX, y: startY, button: "left", clickCount: 1 });
for (let i = 1; i <= 6; i++) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: startX - 20 * i, y: startY, button: "left" });
  await new Promise((r2) => setTimeout(r2, 60));
}
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: startX - 120, y: startY, button: "left" });
await new Promise((r2) => setTimeout(r2, 400));
const after = await ev(`(() => {
  const panel = document.querySelector(".openbitfun-fmc__panel");
  return { width: panel ? panel.getBoundingClientRect().width : null, var: panel ? getComputedStyle(panel).getPropertyValue("--openbitfun-fmc-dock-width") : null };
})()`);
console.log("AFTER:", JSON.stringify(after));
console.log(after.width !== state.panel ? "✅ 拖拽生效" : "❌ 拖拽未生效");
