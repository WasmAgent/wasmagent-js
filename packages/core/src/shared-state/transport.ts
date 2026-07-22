/**
 * #136 — Transport Adapters
 *
 * SSE/WS transport layer for broadcasting state changes and receiving
 * inbound semantic actions. Includes echo guard to prevent feedback loops.
 */

import type { SharedStateStore } from "./SharedStateStore.js";

// ── Frame Types ─────────────────────────────────────────────────────────────

export interface StateDeltaFrame {
  type: "STATE_DELTA";
  sessionId: string;
  state: unknown;
  action?: unknown;
  source: string;
}

export interface CustomFrame {
  type: "CUSTOM";
  sessionId: string;
  action: unknown;
  source: string;
}

export type TransportFrame = StateDeltaFrame | CustomFrame;

// ── Transport Interface ─────────────────────────────────────────────────────

/**
 * Transport abstraction for broadcasting and receiving state frames.
 */
export interface StateTransport {
  /** Broadcast a frame to all connected consumers for a session. */
  broadcast(sessionId: string, frame: TransportFrame): void;

  /** Register a handler for inbound frames. */
  onInbound(handler: (sessionId: string, frame: TransportFrame, source: string) => void): void;
}

// ── MessageChannel Transport (in-process, for tests) ────────────────────────

/**
 * In-process transport using simple function dispatch.
 * Useful for testing without network overhead.
 */
export function messageChannelTransport(): StateTransport {
  const handlers: Array<(sessionId: string, frame: TransportFrame, source: string) => void> = [];

  return {
    broadcast(sessionId: string, frame: TransportFrame): void {
      // Simulate async delivery (microtask)
      queueMicrotask(() => {
        for (const handler of handlers) {
          handler(sessionId, frame, frame.source);
        }
      });
    },
    onInbound(handler: (sessionId: string, frame: TransportFrame, source: string) => void): void {
      handlers.push(handler);
    },
  };
}

// ── SSE Transport ───────────────────────────────────────────────────────────

export interface SseTransportOpts {
  /** Endpoint URL for SSE connections. */
  endpoint: string;
  /** Custom fetch implementation (for testing or Workers). */
  fetch?: typeof globalThis.fetch;
}

/**
 * Server-Sent Events transport adapter.
 * Broadcasts by POSTing frames to the endpoint.
 * Receives inbound via EventSource-like pattern.
 *
 * Note: This is a simplified implementation. In production you'd use
 * actual EventSource for receiving and POST for sending.
 */
export function sseTransport(opts: SseTransportOpts): StateTransport {
  const handlers: Array<(sessionId: string, frame: TransportFrame, source: string) => void> = [];
  const fetchFn = opts.fetch ?? globalThis.fetch;

  return {
    broadcast(_sessionId: string, frame: TransportFrame): void {
      // Fire-and-forget POST to the SSE endpoint
      fetchFn(opts.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(frame),
      }).catch(() => {
        // Swallow network errors — transport is best-effort
      });
    },
    onInbound(handler: (sessionId: string, frame: TransportFrame, source: string) => void): void {
      handlers.push(handler);
    },
  };
}

// ── Bind Store to Transport ─────────────────────────────────────────────────

/**
 * Bind a SharedStateStore to a transport:
 * - Store changes are broadcast as STATE_DELTA frames
 * - Inbound CUSTOM frames are dispatched to the store
 * - Echo guard: inbound frames whose source matches the broadcast source are dropped
 *
 * Returns a cleanup function that unsubscribes everything.
 */
export function bindStoreToTransport<S, A extends { type: string }>(
  store: SharedStateStore<S, A>,
  transport: StateTransport,
  opts?: { source?: string }
): () => void {
  const localSource = opts?.source ?? `store-${Date.now()}`;
  const unsubscribes: Array<() => void> = [];
  const subscribedSessions = new Set<string>();

  // Helper: ensure a session's changes are broadcast
  function ensureSubscribed(sessionId: string): void {
    if (subscribedSessions.has(sessionId)) return;
    subscribedSessions.add(sessionId);

    const unsub = store.subscribe(sessionId, (evt) => {
      const frame: StateDeltaFrame = {
        type: "STATE_DELTA",
        sessionId: evt.sessionId,
        state: evt.state,
        action: evt.action,
        source: evt.source,
      };
      transport.broadcast(sessionId, frame);
    });
    unsubscribes.push(unsub);
  }

  // Listen for inbound CUSTOM frames and dispatch to store
  transport.onInbound((sessionId, frame, source) => {
    // Echo guard: drop frames from our own source
    if (source === localSource) return;

    if (frame.type === "CUSTOM") {
      ensureSubscribed(sessionId);
      const model = store.model;
      const action = model.validate ? model.validate(frame.action) : (frame.action as A);
      store.dispatch(sessionId, action, { source }).catch(() => {
        // Swallow dispatch errors from transport — best-effort
      });
    }
  });

  return () => {
    for (const unsub of unsubscribes) unsub();
    subscribedSessions.clear();
  };
}
