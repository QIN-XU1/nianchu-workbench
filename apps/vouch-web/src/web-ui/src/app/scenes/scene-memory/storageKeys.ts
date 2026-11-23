/**
 * 场景工作台的 localStorage key —— **唯一出处**
 *
 * 为什么单独一个文件：2026-11-17 发现「场景记忆面板写账本、DispatchScene 看不见」
 * 的 bug 根因之一就是 key 各自写死、没人知道谁在用同一个 key。
 * 现在全部集中在这里，健康检查面板也读同一份，避免再出现两种形状/两个来源。
 *
 * ⚠ 改这里的值会让用户已有数据「消失」（其实是读不到了）—— 非必要不要改。
 */

/** 场景记忆正文（主文件 / 项目记忆共用，按 kind 区分内容由面板决定） */
export const K_MEMORY_TEXT = 'vouch.sceneMemory.draft.v1';

/** 定位卡正文（决定指纹） */
export const K_IDENTITY_CTX = '{{SECRET_vqzcqz7a}}';

/** 身份卡正文（内含登记指纹） */
export const K_IDENTITY_ID = '{{SECRET_llk3jkyd}}';

/** 身份索引 7 列表格（IdentityIndexRow[]） */
export const K_INDEX_ROWS = '{{SECRET_rkzq4b7l}}';

/** 派单账本（DispatchItem[]，与 DispatchScene 共用） */
export const K_DISPATCH_LEDGER = '{{SECRET_fgekbho2}}';

/** 工作台画布上每张卡的位置（{id: {x,y}}）—— 位置是数据，不是布局代码 */
export const K_WORKBENCH_POS = '{{SECRET_wbpos01}}';

/**
 * 首页·神经记忆元画布上每个节点被拖到的位置({id: {x,y}})。
 * 【2026-11-18】首页拆成独立场景后单独一份 —— 与「场景」页的布局位置互不干扰。
 */
export const K_NEURON_POS = 'vouch.neuronHome.pos.v1';
