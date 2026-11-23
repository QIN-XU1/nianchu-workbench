

import { ITransportAdapter } from './base';
import { TauriTransportAdapter } from './tauri-adapter';
import { WebSocketTransportAdapter } from './websocket-adapter';
import { PeerDeviceTransportAdapter } from './peer-device-adapter';
import {
  LOCAL_SURFACE_ID,
  SurfaceChangedError,
  getActiveSurfaceScope,
  type DeviceSurfaceId,
} from '@/infrastructure/peer-device/deviceSurface';
import { isTauriRuntime } from '@/infrastructure/runtime';
export * from './base';
export * from './tauri-adapter';
export * from './websocket-adapter';
export * from './peer-device-adapter';


export function detectEnvironment(): 'tauri' | 'web' {

  if (isTauriRuntime()) {
    return 'tauri';
  }

  return 'web';
}


export function createTransportAdapter(forceEnv?: 'tauri' | 'web'): ITransportAdapter {
  const env = forceEnv || detectEnvironment();

  if (env === 'tauri') {
    return new TauriTransportAdapter();
  } else {
    /**
     * ══ WebSocket 地址：同源优先（2026-11-18）═════════════════════
     *
     * 历史问题：原来写死 `ws://localhost:8080/ws`，而宿主是独立进程。
     * 结果是用户必须手动开两个进程，且 localhost 解析成 IPv6 ::1 时连不上。
     *
     * 现在 WebSocket 宿主就挂在产品服务器同一端口上（tools/workbench/serve.mjs），
     * 所以默认走**同源**：页面是 http://127.0.0.1:47124/ 就自动连 ws://127.0.0.1:47124/ws，
     * 换端口、换机器、走局域网都不用改配置。
     *
     * 仍可用 VITE_WS_URL 覆盖（例如前端与后端分机部署）。
     */
    const sameOrigin = (() => {
      if (typeof window === 'undefined' || !window.location) return 'ws://127.0.0.1:47124/ws';
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return proto + '//' + window.location.host + '/ws';
    })();
    const wsUrl = import.meta.env.VITE_WS_URL || sameOrigin;
    return new WebSocketTransportAdapter(wsUrl);
  }
}

/**
 * Which device surface the registered transport serves.
 *
 * The global adapter is swapped on every device switch, so "the transport" is
 * only meaningful together with the surface it was bound for. Recording that
 * here is what lets work issued before a switch be recognised afterwards
 * instead of resolving into the surface that replaced it.
 */
export interface TransportSurfaceBinding {
  readonly adapter: ITransportAdapter;
  readonly surfaceId: DeviceSurfaceId;
  /** Monotonic per registration: every rebind is a new binding. */
  readonly generation: number;
  /** `deviceSurface` activation epoch current when the adapter was bound. */
  readonly surfaceEpoch: number;
}

let binding: TransportSurfaceBinding | null = null;
let bindingCounter = 0;

function surfaceIdOf(adapter: ITransportAdapter): DeviceSurfaceId {
  return adapter instanceof PeerDeviceTransportAdapter
    ? adapter.surfaceId
    : LOCAL_SURFACE_ID;
}

function bind(adapter: ITransportAdapter, surfaceId: DeviceSurfaceId): TransportSurfaceBinding {
  const previous = binding;
  binding = {
    adapter,
    surfaceId,
    generation: ++bindingCounter,
    surfaceEpoch: getActiveSurfaceScope().epoch,
  };
  if (previous && previous.adapter !== adapter) {
    // Retired peers stay attached and keep running our work; only their claim
    // on the rendered surface ends here.
    if (previous.adapter instanceof PeerDeviceTransportAdapter) {
      previous.adapter.markRenderedTransport(false);
    }
  }
  if (adapter instanceof PeerDeviceTransportAdapter) {
    // Even rebinding the same adapter is a new surface activation. This is the
    // invalidation seam used when A's hydrate is superseded before B commits.
    adapter.markRenderedTransport(true, true);
  }
  return binding;
}


export function getTransportAdapter(): ITransportAdapter {
  return getTransportSurfaceBinding().adapter;
}

/** The active binding, creating the default local transport on first use. */
export function getTransportSurfaceBinding(): TransportSurfaceBinding {
  if (!binding) {
    const adapter = createTransportAdapter();
    return bind(adapter, surfaceIdOf(adapter));
  }
  return binding;
}

export function getTransportSurfaceId(): DeviceSurfaceId {
  return getTransportSurfaceBinding().surfaceId;
}

/**
 * Throw `SurfaceChangedError` unless the rendered transport still serves
 * `surfaceId`. For callers that captured a surface before an await and would
 * otherwise write the answer into whichever device replaced it.
 */
export function assertTransportSurface(surfaceId: DeviceSurfaceId, action?: string): void {
  const current = getTransportSurfaceBinding();
  if (current.surfaceId !== surfaceId) {
    throw new SurfaceChangedError(surfaceId, current.surfaceEpoch, action);
  }
}


export async function resetTransportAdapter(): Promise<void> {
  const current = binding;
  binding = null;
  if (current) {
    if (current.adapter instanceof PeerDeviceTransportAdapter) {
      current.adapter.markRenderedTransport(false);
    }
    await current.adapter.disconnect();
  }
}

/**
 * Point product traffic at `adapter`. `surfaceId` defaults to the surface the
 * adapter itself serves, so existing single-argument callers stay correct.
 */
export function setTransportAdapter(
  adapter: ITransportAdapter,
  surfaceId: DeviceSurfaceId = surfaceIdOf(adapter),
): void {
  bind(adapter, surfaceId);
}
