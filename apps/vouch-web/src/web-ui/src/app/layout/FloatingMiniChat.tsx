/** Modeless host of references to Runtime-owned conversations. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowUpRight, Minus, Phone, PhoneOff, X } from 'lucide-react';
import { IconButton, LauncherButton, OverflowText, TabGroup, Button } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceId, getActiveSurfaceScope, onSurfaceActivated, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { globalEventBus } from '@/infrastructure/event-bus';
import { FLOWCHAT_FOCUS_ITEM_EVENT, type FlowChatFocusItemRequest } from '@/flow_chat/events/flowchatNavigation';
import { api } from '@/infrastructure/api';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { createControlConversation, ensureControlConversation, replayVoiceExchanges } from '@/flow_chat/services/controlConversation';
import ChatPane from '@/app/scenes/session/ChatPane';
import NianchuChat from '@/app/layout/NianchuChat';
import {
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  clampPanelWidth,
  nudgePanelWidth,
  readPanelWidth,
  widthFromDrag,
  writePanelWidth,
} from '@/app/layout/panelWidth';
import type { ChatInputRegistration } from '@/flow_chat/components/chatInputRegistration';
import { ConversationModeSurface } from '@/flow_chat/components/voice/ConversationModeSurface';
import { ControlConversation } from '@/flow_chat/components/voice/ControlConversation';
import { ConversationViewProvider } from '@/flow_chat/contexts/ConversationViewProvider';
import { useRealtimeVoiceCall } from '@/flow_chat/components/voice/RealtimeVoiceCallContext';
import type { VoiceCallTarget } from '@/flow_chat/components/voice/voiceClientContext';
import { useConversationDockStore, dockConversationKey, type DockConversation } from '../stores/conversationDockStore';
import { beginConversationTransfer, endConversationTransfer, isConversationTransfer, dropConversationInDock, returnConversationToWorkbench } from '../services/conversationDockTransfer';
import { sessionSceneWorkspaceKey } from '../services/sessionSceneTarget';
import { useMiniAppStore, MINIAPP_COMPOSER_DRAFT_EVENT, MINIAPP_COMPOSER_FOCUS_EVENT, type MiniAppDraftEventDetail, type MiniAppFocusEventDetail } from '../scenes/miniapps/miniAppStore';
import { useSceneStore } from '../stores/sceneStore';
import { isSessionSceneId } from '../components/SceneBar/types';
import { selectedScene } from '../workbench/scenePaneModel';
import { useSessionPaneLayout } from '../scenes/session/sessionPaneLayoutStore';
import { getMiniAppIdFromSceneId, getMiniAppSceneId } from '../scenes/miniapps/miniAppActivity';
import { followMiniAppConversation, openMiniAppConversation, openMiniAppFromConversation, resolveMiniAppConversation, syncMiniAppConversations } from '../scenes/miniapps/miniAppConversation';
import { requestMiniAppComposerMessage } from '../scenes/miniapps/miniAppComposerMessages';
import { pickLocalizedString } from '../scenes/miniapps/utils/pickLocalizedString';
import { resolveDisplayTitle } from '@/flow_chat/components/session-menu/useFlowChatSessions';
import MiniAppBubbleWelcome from './MiniAppBubbleWelcome';
import { createLogger } from '@/shared/utils/logger';
import { notificationService } from '@/shared/notification-system';
import './FloatingMiniChat.scss';
const log = createLogger('ConversationDock');

const subscribeSurface = (listener: () => void) => onSurfaceActivated(listener);
const subscribeSessions = (listener: () => void) => flowChatStore.subscribe(listener);
const sessionSnapshot = () => flowChatStore.getState();

/**
 * 是否渲染壳层自带的 dock 视图（头栏标签页 / ChatPane / 加载态）。
 *
 * 我们的产品恒为 false：那套视图依赖桌面端专属能力
 * （flowChatStore 预置会话、workspaceManager 的 Tauri 事件通道、
 *   ensureControlConversation），在自有 web 宿主上永远停在「正在打开助手…」，
 * 叠在 NianchuChat 下面只会显得又乱又不合理。
 *
 * 保留代码而不是删除，是因为 MiniApp 会话将来接入时还能复用；
 * 真要用时把这里改成 true 即可。
 */
const USE_DOCK_VIEWS = false;

function DockConversationView({ entry, active, onCollapse, renderHeader, onVoiceViewChange }: { entry: DockConversation; active: boolean; onCollapse: () => void; renderHeader: (modeSwitch: ReactNode) => ReactNode; onVoiceViewChange: (key: string, visible: boolean) => void }) {
  const { t, i18n } = useI18n('flow-chat');
  const state = useSyncExternalStore(subscribeSessions, sessionSnapshot);
  const session = state.sessions.get(entry.sessionId);
  const claim = useMiniAppStore(s => entry.appId ? s.composerClaims[entry.appId] : undefined);
  const app = useMiniAppStore(s => s.apps.find(candidate => candidate.id === entry.appId));
  const claimValid = entry.kind !== 'miniapp' || claim?.surfaceId === entry.surfaceId && claim?.token === entry.claimToken && claim?.sessionId === entry.sessionId;
  const key = dockConversationKey(entry);
  const reportVoiceView = useCallback((visible: boolean) => onVoiceViewChange(key, visible), [key, onVoiceViewChange]);
  const newControlConversation = useCallback(async () => {
    const scope = getActiveSurfaceScope();
    if (scope.surfaceId !== entry.surfaceId) return;
    const result = await createControlConversation(entry.sessionId);
    scope.assertCurrent('open new control conversation');
    useConversationDockStore.getState().add({ ...result, surfaceId: entry.surfaceId, workspaceKey: sessionSceneWorkspaceKey(result.workspaceId), kind: 'control' });
  }, [entry.surfaceId, entry.sessionId]);
  const draft = useConversationDockStore(state => state.drafts[key]);
  const setDraft = (text: string) => useConversationDockStore.getState().setDraft(key, text);
  const appName = app ? pickLocalizedString(app, i18n.language, 'name') || app.name : entry.appId ?? '';
  const registration = useMemo<ChatInputRegistration | undefined>(() => entry.kind !== 'miniapp' ? undefined : ({
    registrationId: entry.claimToken!,
    workspacePath: session?.workspacePath || '',
    remoteConnectionId: session?.remoteConnectionId || session?.config.remoteConnectionId,
    placeholder: claim?.customization?.composer?.placeholder || claim?.placeholder || t('miniAppComposer.placeholder', { app: appName }),
    draft,
    onDraftConsumed: id => useConversationDockStore.getState().consumeDraft(key, id),
    onSubmit: async submission => {
      try {
        const live = useMiniAppStore.getState().composerClaims[entry.appId!];
        if (getActiveSurfaceId() !== entry.surfaceId || live?.surfaceId !== entry.surfaceId
          || live?.token !== entry.claimToken || live.sessionId !== entry.sessionId) throw new Error('The MiniApp no longer owns this conversation');
        await requestMiniAppComposerMessage(
          { ...submission, token: entry.claimToken!, sessionId: entry.sessionId },
          undefined,
          { resolveOnAgentRun: true },
        );
      } catch (error) {
        if (getActiveSurfaceId() === entry.surfaceId && !isSurfaceChangedError(error)) {
          const reason = error instanceof Error ? error.message : t('errors.sendFailed');
          notificationService.error(reason.startsWith('miniapp_agent_images_v1_unsupported:')
            ? t('miniAppComposer.imagesUnsupportedPeer') : reason);
        }
        throw error;
      }
    },
  }), [appName, claim, draft, entry, session, t, key]);
  const voiceTarget = useMemo<VoiceCallTarget | undefined>(() => !session ? undefined : entry.kind === 'miniapp' ? {
    kind: 'miniapp', appId: entry.appId!, appName, claimToken: entry.claimToken!, surfaceId: entry.surfaceId,
    sessionId: entry.sessionId, workspacePath: session.workspacePath,
  } : { kind: entry.kind, surfaceId: entry.surfaceId, sessionId: entry.sessionId,
    workspaceId: session.workspaceId ?? session.config.workspaceId, workspacePath: session.workspacePath || '' }, [entry, session, appName]);
  const unavailable = <div className="openbitfun-fmc__miniapp-session-pending" role="status"
    data-openbitfun-component="floating-mini-chat" data-openbitfun-part="pending">{t(
      entry.kind === 'miniapp' && claim && claim.token === entry.claimToken
        && claim.surfaceId === entry.surfaceId && !claim.sessionId ? 'dock.loading' : 'dock.unavailable',
    )}</div>;
  if (entry.kind === 'control' && session && voiceTarget) return <ConversationViewProvider
    scope={{ ...entry, viewId: key, presentation: 'compact' }}>
    <ControlConversation session={session} sessionRef={entry} voiceTarget={voiceTarget} active={active}
      renderHeader={renderHeader} onClose={onCollapse} onVoiceViewChange={reportVoiceView} onNewConversation={newControlConversation} />
  </ConversationViewProvider>;
  return <ConversationModeSurface voiceTarget={voiceTarget} voiceStartDisabled={!voiceTarget || !claimValid} onCloseVoice={onCollapse}
    renderHeader={renderHeader} onVoiceViewChange={reportVoiceView} switchTestId="hello-realtime-voice-mode-switch">
    {!session || !claimValid ? unavailable : <ChatPane sessionRef={entry} viewId={dockConversationKey(entry)} presentation="compact" width={0} isFullscreen={false}
      isSceneActive={active} workspacePath={session.workspacePath} showChatInput chatInputRegistration={registration}
      emptyState={<MiniAppBubbleWelcome
        appName={entry.kind === 'control' ? 'OpenBitFun' : entry.kind === 'miniapp' ? appName : resolveDisplayTitle(session)}
        appDescription={entry.kind === 'control' ? t('dock.welcome') : app ? pickLocalizedString(app, i18n.language, 'description') : undefined}
        appIcon={app?.icon} showIcon={entry.kind === 'miniapp'} customization={claim?.customization}
        onSuggestion={setDraft}
      />}
    />}
  </ConversationModeSurface>;
}

export function FloatingMiniChat() {
  const { t, i18n } = useI18n('flow-chat');
  const { t: tv } = useI18n('settings/voice-input');
  const surfaceId = useSyncExternalStore(subscribeSurface, getActiveSurfaceId);
  const dock = useConversationDockStore();
  const claims = useMiniAppStore(s => s.composerClaims);
  const apps = useMiniAppStore(s => s.apps);
  const activeSceneId = useSceneStore(s => s.activeTabId);
  const paneSelections = useSceneStore(s => s.paneSelections);
  const paneLayout = useSessionPaneLayout();
  const sessionVisible = (paneLayout.mode !== 'content-only' && isSessionSceneId(selectedScene(paneSelections.primary)))
    || (paneLayout.mode !== 'chat-only' && isSessionSceneId(selectedScene(paneSelections.secondary)));
  const openScenes = useSceneStore(s => s.openTabs);
  const activeMiniAppId = activeSceneId ? getMiniAppIdFromSceneId(activeSceneId) : null;
  const activeMiniAppClaim = activeMiniAppId ? claims[activeMiniAppId] : undefined;
  const flow = useSyncExternalStore(subscribeSessions, sessionSnapshot);
  const voice = useRealtimeVoiceCall();
  const panelRef = useRef<HTMLDivElement>(null);
  const [voiceViews, setVoiceViews] = useState<Record<string, boolean>>({});
  const onVoiceViewChange = useCallback((key: string, visible: boolean) => {
    setVoiceViews(previous => previous[key] === visible ? previous : { ...previous, [key]: visible });
  }, []);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [drop, setDrop] = useState(false);
  const [visited, setVisited] = useState<Set<string>>(new Set());
  const dragging = useRef<string>();
  // 面板宽度（批次 Z.29）：拖动 / 键盘 / 双击复位都落到同一个夹子函数，存本机偏好
  const [panelWidth, setPanelWidth] = useState(() => readPanelWidth(undefined, typeof window === 'undefined' ? undefined : window.innerWidth));
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;
  const [resizing, setResizing] = useState(false);
  const commitPanelWidth = useCallback((next: number) => {
    const applied = clampPanelWidth(next, typeof window === 'undefined' ? undefined : window.innerWidth);
    setPanelWidth(applied);
    writePanelWidth(applied, undefined, typeof window === 'undefined' ? undefined : window.innerWidth);
    return applied;
  }, []);
  const onResizerPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidthRef.current;
    setResizing(true);
    /*
     * 用 window 级监听而不是 pointer capture：capture 在部分 Chromium / 嵌入 WebView 里
     * 会静默失败，一失败后续 pointermove 就全落到别的元素上 —— 表现正是「拖了半天没反应」。
     * 挂到 window 上，指针移出 10px 手柄也照样收得到。
     */
    const onMove = (e: PointerEvent) => {
      setPanelWidth(widthFromDrag(startWidth, e.clientX - startX, window.innerWidth));
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      writePanelWidth(panelWidthRef.current, undefined, window.innerWidth);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };
  const onResizerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = nudgePanelWidth(panelWidthRef.current, 'left', event.shiftKey, window.innerWidth);
    else if (event.key === 'ArrowRight') next = nudgePanelWidth(panelWidthRef.current, 'right', event.shiftKey, window.innerWidth);
    else if (event.key === 'Home') next = PANEL_WIDTH_DEFAULT;
    if (next === null) return;
    event.preventDefault();
    commitPanelWidth(next);
  };
  const entries = dock.entries.filter(entry => entry.surfaceId === surfaceId)
    .sort((a, b) => Number(b.kind === 'control') - Number(a.kind === 'control'));
  const active = entries.find(entry => dockConversationKey(entry) === dock.activeBySurface[surfaceId]) ?? entries[0];
  const activeKey = active ? dockConversationKey(active) : undefined;
  const recoveryRevision = [...flow.sessions.values()].map(session => `${session.sessionId}:${session.dialogTurns.at(-1)?.status}`).join('|');
  useEffect(() => { void replayVoiceExchanges().catch(reason => { if (!isSurfaceChangedError(reason)) log.warn('Voice history recovery is pending', { reason }); }); }, [surfaceId, recoveryRevision]);
  const live = voice.phase !== 'idle';
  const liveRef = useRef(live);
  liveRef.current = live;
  const immersiveVoice = Boolean(activeKey && live && voiceViews[activeKey]);
  const callKey = voice.target ? dockConversationKey({ surfaceId: voice.target.surfaceId ?? surfaceId, sessionId: voice.target.sessionId }) : undefined;

  useEffect(() => globalEventBus.on<FlowChatFocusItemRequest>(FLOWCHAT_FOCUS_ITEM_EVENT, request => {
    if (request.embedded || request.surfaceEpoch !== undefined && request.surfaceEpoch !== getActiveSurfaceScope().epoch) return;
    const state = useConversationDockStore.getState();
    const target = state.entries.find(entry => entry.surfaceId === surfaceId && entry.sessionId === request.sessionId);
    if (!target) return;
    const key = dockConversationKey(target);
    state.select(key);
    state.setOpen(true);
    state.requestFocus(key, request);
  }), [surfaceId]);

  useEffect(() => {
    if (!dock.open) return;
    let disposed = false;
    setError('');
    if (!useConversationDockStore.getState().entries.some(entry => entry.surfaceId === surfaceId && entry.kind === 'control')) {
      useConversationDockStore.getState().add({ surfaceId, sessionId: 'openbitfun-control', workspaceKey: '', kind: 'control' }, false);
    }
    /**
     * ══ 2026-11-18 修：主 agent 在 web 上"完全不可用"的真正原因 ══
     *
     * `supportsControlConversation()`（flow_chat/services/controlConversation.ts:14）判定为：
     *     surfaceId === 'local' ? isTauriRuntime() : peer.capabilities.controlConversationV1
     * 也就是说**常驻控制会话只有 Tauri 桌面端支持**；后端也没注册
     * `ensure_control_conversation` 这个命令（全仓搜不到实现），
     * WebSocket 通道也没有它的方法映射。
     * 所以在浏览器里 ensureControlConversation() 必然 reject，
     * 面板永远显示 dock.unavailable —— 这不是样式问题，是通道不存在。
     *
     * 降级策略（浏览器 / web server）：
     *   走**普通会话** createChatSession（映射 agent/createSession，后端已注册），
     *   把它的 sessionId 放进 dock，ChatPane 就能正常渲染并对话。
     * 桌面端行为完全不变（优先控制会话）。
     */
    void ensureControlConversation().then(result => {
      if (!disposed) useConversationDockStore.getState().add({ ...result, surfaceId, workspaceKey: sessionSceneWorkspaceKey(result.workspaceId), kind: 'control' }, false);
    }).catch(async reason => {
      if (disposed || isSurfaceChangedError(reason)) return;
      // 控制会话不可用（典型：浏览器）→ 用普通会话兜底，让面板真的能用
      /**
       * ══ 2026-11-18 最终版 ════════════════════════════════════════
       *
       * 前几版都错在「直接调 api.invoke('create_session') 拿一个 sessionId」——
       * 宿主那边确实建成功了，但 **flowChatStore 里没有这条会话**，
       * ChatPane 的 `!session` 判定（本文件 L105）就永远走 unavailable 分支，
       * 界面上显示「此会话暂不可用」。
       *
       * 正确做法：走**前端正规的会话创建流程** flowChatManager.createChatSession()，
       * 它内部会：
       *   · resolveSessionWorkspace() 取/校验工作区
       *   · resolveAgentTypeForSessionCreation()：assistant 工作区 → agentType 'Claw'
       *   · 调宿主 agent/createSession
       *   · **把结果写进 flowChatStore.sessions**（这才是 ChatPane 读的地方）
       *
       * 前置条件：workspaceManager 里要有 currentWorkspace。
       * 宿主现在实现了 create_assistant_workspace / get_current_workspace，
       * 所以这里先确保助手工作区存在，再建会话。
       */
      try {
        const wm = await import('@/infrastructure/services/business/workspaceManager');
        const mgr = wm.workspaceManager;

        // ① 确保有工作区（宿主已实现这两个方法）
        let wsId = mgr.getState()?.currentWorkspace?.id;
        if (!wsId) {
          try {
            const ws = await api.invoke<{ id: string }>('create_assistant_workspace', {});
            wsId = ws?.id;
            // 让 manager 也刷新一次状态
            await mgr.initialize?.();
            wsId = mgr.getState()?.currentWorkspace?.id || wsId;
          } catch { /* 下面再判 */ }
        }

        // ② 已有会话就挂最近一条（避免每次都新建）
        try {
          const sessions = await api.invoke<Array<{ sessionId: string }>>('agent/listSessions', {});
          if (Array.isArray(sessions) && sessions.length > 0) {
            const latest = sessions[0];
            useConversationDockStore.getState().add({
              surfaceId, sessionId: latest.sessionId, workspaceKey: '', kind: 'session',
            }, false);
            return;
          }
        } catch { /* 继续走创建 */ }

        // ③ 走正规创建流程（关键：它会写进 store）
        const sid = await flowChatManager.createChatSession({ workspaceId: wsId || '' });
        if (disposed) return;
        useConversationDockStore.getState().add({
          surfaceId, sessionId: sid, workspaceKey: wsId ? sessionSceneWorkspaceKey(wsId) : '', kind: 'session',
        }, false);
      } catch (e5) {
        if (!disposed) {
          const msg = String(e5 instanceof Error ? e5.message : e5);
          setError('主 agent 会话创建失败：' + msg.slice(0, 200));
        }
      }
    });
    return () => { disposed = true; };
  }, [dock.open, surfaceId, retry]);

  useEffect(() => {
    syncMiniAppConversations(surfaceId);
  }, [claims, surfaceId]);

  useEffect(() => {
    if (activeMiniAppId) followMiniAppConversation(activeMiniAppId,
      liveRef.current || Boolean(panelRef.current?.querySelector('[contenteditable="true"]:focus, textarea:focus, input:focus')), surfaceId);
    // Selection inside the dock does not retrigger following the main scene.
  }, [activeMiniAppId, activeMiniAppClaim?.sessionId, activeMiniAppClaim?.token, surfaceId]);

  useEffect(() => {
    const target = voice.target;
    if (target?.kind === 'miniapp' && live && voice.phase !== 'ending'
      && !openScenes.some(tab => tab.id === getMiniAppSceneId(target.appId))) voice.end();
  }, [openScenes, voice, live]);

  useEffect(() => {
    if (dock.open && activeKey) setVisited(previous => previous.has(activeKey) ? previous : new Set([...previous, activeKey]));
  }, [dock.open, activeKey]);

  // Prepared MiniApp drafts also work before the first visit to that tab.
  useEffect(() => {
    const mayReveal = (appId: string) => {
      const state = useConversationDockStore.getState();
      const selected = state.entries.find(entry => dockConversationKey(entry) === state.activeBySurface[surfaceId]);
      const isSelected = selected?.kind === 'miniapp' && selected.appId === appId;
      if (live && !isSelected) return false;
      if (!isSelected && panelRef.current?.querySelector('[contenteditable="true"]:focus, textarea:focus, input:focus')) return false;
      return state.open && isSelected || useSceneStore.getState().activeTabId === getMiniAppSceneId(appId);
    };
    const focus = (event: Event) => {
      const detail = (event as CustomEvent<MiniAppFocusEventDetail>).detail;
      if (!detail) return;
      const entry = resolveMiniAppConversation(detail.appId, detail.surfaceId);
      if (entry?.claimToken === detail.token && entry.sessionId === detail.sessionId && mayReveal(detail.appId)) {
        openMiniAppConversation(detail.appId, detail.surfaceId);
      }
    };
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<MiniAppDraftEventDetail>).detail;
      const claim = Object.entries(useMiniAppStore.getState().composerClaims).find(([, value]) => value.token === detail?.token);
      if (!claim?.[1].sessionId || detail.sessionId && detail.sessionId !== claim[1].sessionId) return;
      const [appId, value] = claim;
      const entry = resolveMiniAppConversation(appId, surfaceId);
      if (!entry || entry.claimToken !== value.token) return;
      const state = useConversationDockStore.getState();
      state.setDraft(dockConversationKey(entry), detail.text);
      if (mayReveal(appId)) openMiniAppConversation(appId, surfaceId);
    };
    window.addEventListener(MINIAPP_COMPOSER_DRAFT_EVENT, listener);
    window.addEventListener(MINIAPP_COMPOSER_FOCUS_EVENT, focus);
    return () => {
      window.removeEventListener(MINIAPP_COMPOSER_DRAFT_EVENT, listener);
      window.removeEventListener(MINIAPP_COMPOSER_FOCUS_EVENT, focus);
    };
  }, [surfaceId, live]);
  const collapse = () => dock.setOpen(false);
  const label = (entry: DockConversation) => entry.kind === 'control' ? 'OpenBitFun' : entry.kind === 'miniapp'
    ? claims[entry.appId!]?.customization?.title || (() => { const app = apps.find(a => a.id === entry.appId); return app ? pickLocalizedString(app, i18n.language, 'name') : entry.appId; })() || entry.appId!
    : resolveDisplayTitle(flow.sessions.get(entry.sessionId));
  const acceptDrop = (event: React.DragEvent) => {
    if (!isConversationTransfer(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation(); setDrop(false);
    void dropConversationInDock(event.dataTransfer);
  };
  const renderHeader = (modeSwitch: ReactNode) => <>
      <div className={['openbitfun-fmc__header', active?.kind === 'control' && entries.length === 1 && 'openbitfun-fmc__header--identity'].filter(Boolean).join(' ')} data-openbitfun-component="floating-mini-chat" data-openbitfun-part="header">
        <div className="openbitfun-fmc__mode-switch">{modeSwitch}</div>
        {entries.length > 1 ? <TabGroup className="openbitfun-fmc__tabs" size="sm" value={activeKey} onValueChange={dock.select}
          aria-label={t('dock.tabs')} items={entries.map(entry => ({ value: dockConversationKey(entry), label: label(entry),
            endAction: entry.kind !== 'control' && !(live && dockConversationKey(entry) === callKey) ? <button type="button" aria-label={t(entry.kind === 'miniapp' ? 'dock.hideConversation' : 'session.close')} title={t(entry.kind === 'miniapp' ? 'dock.hideConversation' : 'session.close')} tabIndex={-1}
              onClick={event => { event.stopPropagation(); dock.hide(dockConversationKey(entry)); }}><X size={12} /></button> : undefined,
          }))} renderItem={(item, node) => {
            const entry = entries.find(value => dockConversationKey(value) === item.value)!;
            return <div draggable={entry.kind !== 'control'} onDragStart={event => {
              dragging.current = item.value;
              if (entry.kind === 'session') beginConversationTransfer(event.dataTransfer, entry);
              else event.dataTransfer.setData('application/x-openbitfun-dock-tab', item.value);
            }} onDragEnd={() => { dragging.current = undefined; endConversationTransfer(); }}
              onDragOver={event => { if (dragging.current) event.preventDefault(); }}
              onDrop={event => { if (!dragging.current) return; event.preventDefault(); event.stopPropagation(); dock.reorder(dragging.current, item.value); }}
            >{node}</div>;
          }} /> : <OverflowText className="openbitfun-fmc__title-wrapper">{active ? label(active) : 'OpenBitFun'}</OverflowText>}
        {active?.kind === 'session' && <IconButton size="sm" icon={<ArrowUpRight size={15} />} aria-label={t('dock.moveToMain')}
          onClick={() => returnConversationToWorkbench(active)} />}
        {active?.kind === 'miniapp' && <IconButton size="sm" icon={<ArrowUpRight size={15} />} aria-label={t('dock.openApp')} title={t('dock.openApp')}
          onClick={() => openMiniAppFromConversation(active)} />}
        <IconButton size="sm" icon={<Minus size={15} />} aria-label={t('dock.collapse')} onClick={collapse} />
      </div>
      {live && !(active?.kind === 'control' && activeKey === callKey) && <div className="openbitfun-fmc__call-status" data-openbitfun-component="floating-mini-chat" data-openbitfun-part="callStatus">
        <button type="button" onClick={() => {
          const target = voice.target;
          if (!target) return;
          dock.add({ ...target, surfaceId: target.surfaceId ?? surfaceId,
            workspaceKey: target.kind !== 'miniapp' && target.workspaceId ? sessionSceneWorkspaceKey(target.workspaceId) : '' });
        }}>
          <Phone size={13} /><OverflowText>{tv('voiceCall.call.title')}</OverflowText>
        </button>
        <IconButton size="sm" icon={<PhoneOff size={14} />} aria-label={tv('voiceCall.call.hangUp')} onClick={voice.end} />
      </div>}
  </>;
  return <div className={['openbitfun-fmc', dock.open && 'openbitfun-fmc--open'].filter(Boolean).join(' ')}
    data-openbitfun-component="floating-mini-chat" data-openbitfun-part="root" data-openbitfun-mode="chat" data-docked="1"
    data-openbitfun-state={dock.open ? 'open' : undefined}
    data-openbitfun-communication-mode={immersiveVoice ? 'voice' : 'chat'}
    onDragOver={event => { if (isConversationTransfer(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDrop(true); dock.setOpen(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrop(false); }} onDrop={acceptDrop}>
    {!sessionVisible && <LauncherButton className="openbitfun-fmc__button" aria-expanded={dock.open} aria-label={t('dock.open')}
      onClick={() => dock.setOpen(true)} onPointerDown={event => { if (event.button === 0) dock.setOpen(true); }}>
      {live ? <Phone size={16} /> : tv('voiceCall.call.launcherCompactLabel')}
    </LauncherButton>}
    <div ref={panelRef} role="dialog" aria-modal="false" aria-label={t('dock.open')} aria-hidden={!dock.open} data-motion="presence"
      {...(!dock.open ? { inert: '' } : {})}
      style={{ '--openbitfun-fmc-dock-width': `${panelWidth}px` } as React.CSSProperties}
      className={['openbitfun-fmc__panel', dock.open && 'openbitfun-fmc__panel--open', drop && 'openbitfun-fmc__panel--drop', resizing && 'openbitfun-fmc__panel--resizing'].filter(Boolean).join(' ')}
      data-openbitfun-component="floating-mini-chat" data-openbitfun-part="panel">
      {dock.open && <div className="openbitfun-fmc__resizer" role="separator" aria-orientation="vertical"
        aria-label="调整面板宽度（左右拖动，双击复位）" aria-valuemin={PANEL_WIDTH_MIN} aria-valuemax={PANEL_WIDTH_MAX}
        aria-valuenow={Math.round(panelWidth)} aria-valuetext={`${Math.round(panelWidth)} 像素`}
        tabIndex={0} data-openbitfun-component="floating-mini-chat" data-openbitfun-part="panelResizer"
        onPointerDown={onResizerPointerDown} onDoubleClick={() => commitPanelWidth(PANEL_WIDTH_DEFAULT)} onKeyDown={onResizerKeyDown} />}
      <div className="openbitfun-fmc__body" data-openbitfun-component="floating-mini-chat" data-openbitfun-part="body">
        {/*
          ══ 2026-11-18 主 agent 面板 ══════════════════════════════
          壳层自带的 ChatPane 依赖三条桌面端专属能力（flowChatStore 预置会话、
          workspaceManager 的 Tauri 事件通道、ensureControlConversation），
          在本项目自有 web 宿主上都不成立（见 app/layout/NianchuChat.tsx 顶部说明）。

          所以这里直接渲染我们自己的对话面板：它走 tools/agent/runtime.mjs 那条
          已经验证 12/12 + 9/9 的真实通道。
          下面的 entries 视图保留（MiniApp 等场景仍需要），但主 agent 用 NianchuChat。
        */}
        {/*
          主 agent 用我们自己的 NianchuChat（走 tools/agent/runtime.mjs 真实通道）。
          下面那套壳层自带的头栏/视图（OpenBitFun 标签页 +「正在打开助手…」）
          依赖桌面端专属能力，在自有 web 宿主上永远加载不出来，
          和 NianchuChat 叠在一起既难看又不合理 —— 所以用开关整体关掉。
          代码保留（MiniApp 场景将来若接入可打开），只是不渲染。
        */}
        {USE_DOCK_VIEWS && (<>
          {(!active || active.kind === 'control' && !flow.sessions.has(active.sessionId)) && renderHeader(null)}
          {entries.filter(entry => (visited.has(dockConversationKey(entry)) || dockConversationKey(entry) === activeKey)).map(entry => (
            <div key={dockConversationKey(entry)} hidden={dockConversationKey(entry) !== activeKey}
              className="openbitfun-fmc__view">
              <DockConversationView entry={entry} active={dock.open && dockConversationKey(entry) === activeKey} onCollapse={collapse} renderHeader={renderHeader} onVoiceViewChange={onVoiceViewChange} />
            </div>))}
          {(!active || active.kind === 'control' && !flow.sessions.has(active.sessionId)) && <div className="openbitfun-fmc__miniapp-session-pending" role="status"
            data-openbitfun-component="floating-mini-chat" data-openbitfun-part="pending">
            {error ? <><span>{t('dock.loadFailed')}</span><span>{error}</span><Button onClick={() => setRetry(value => value + 1)}>{t('dock.retry')}</Button></> : <span>{t('dock.loading')}</span>}
          </div>}
        </>)}
        {dock.open && <NianchuChat onClose={() => dock.setOpen(false)} />}
      </div>
    </div>
  </div>;
}
export default FloatingMiniChat;
