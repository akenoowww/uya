import type { RunDetail, RunEvent, RunSummary } from "@ide/protocol";
import type { Bridge } from "./bridge";

const BATCH_INTERVAL_MS = 32;
const WS_WATCHDOG_MS = 900;
const POLL_INTERVAL_MS = 650;
const MAX_WS_FAILURES_BEFORE_POLL = 2;
const MAX_RECOVER_FAILURES = 8;

export function createRunStreams(
  onDetail: (detail: RunDetail) => void,
  onError: (message: string) => void,
) {
  const active = new Map<string, () => void>();

  function follow(bridge: Bridge, seed: RunSummary) {
    if (seed.status !== "running" || active.has(seed.id)) return;

    let detail: RunDetail = { run: seed, events: [] };
    let cursor = 0;
    let wsFailures = 0;
    let recoverFailures = 0;
    let receivedSocketEvent = false;
    let stopped = false;
    let recovering = false;
    let subscription = 0;
    let disposeSocket: (() => void) | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    let batchTimer: ReturnType<typeof setTimeout> | undefined;
    const pending: RunEvent[] = [];

    function closeSocket() {
      subscription += 1;
      clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
      disposeSocket?.();
      disposeSocket = undefined;
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      closeSocket();
      clearTimeout(pollTimer);
      clearTimeout(batchTimer);
      active.delete(seed.id);
    }

    function publish(next: RunDetail) {
      detail = next;
      cursor = next.events.at(-1)?.seq ?? cursor;
      onDetail(next);
      if (next.run.status !== "running") stop();
    }

    function flush() {
      clearTimeout(batchTimer);
      batchTimer = undefined;
      const last = pending.at(-1);
      if (!last || stopped) return;
      publish({
        run: last.type === "status" ? last.run : detail.run,
        events: [...detail.events, ...pending.splice(0)],
      });
    }

    function schedulePoll(delay: number, retrySocket: boolean) {
      if (stopped || pollTimer !== undefined) return;
      pollTimer = setTimeout(() => {
        pollTimer = undefined;
        void recover(retrySocket);
      }, delay);
    }

    function disconnect() {
      closeSocket();
      flush();
      if (stopped) return;
      wsFailures += 1;
      const usePollingOnly = wsFailures >= MAX_WS_FAILURES_BEFORE_POLL;
      schedulePoll(usePollingOnly ? POLL_INTERVAL_MS : 250 * wsFailures, !usePollingOnly);
    }

    function receive(event: RunEvent) {
      if (event.runId !== seed.id || event.seq <= cursor) return;
      if (event.seq !== cursor + 1) {
        disconnect();
        return;
      }
      receivedSocketEvent = true;
      wsFailures = 0;
      recoverFailures = 0;
      clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
      cursor = event.seq;
      pending.push(event);
      if (event.type === "status" || event.type === "approval_request" || event.type === "approval_resolved") flush();
      else batchTimer ??= setTimeout(flush, BATCH_INTERVAL_MS);
    }

    async function recover(reopenSocket: boolean) {
      if (stopped || recovering) return;
      recovering = true;
      try {
        const snapshot = await bridge.rpc("runs.get", { id: seed.id });
        if (stopped) return;
        recoverFailures = 0;
        const snapshotSeq = snapshot.events.at(-1)?.seq ?? 0;
        if (snapshotSeq >= cursor || snapshot.run.status !== detail.run.status) {
          pending.length = 0;
          clearTimeout(batchTimer);
          batchTimer = undefined;
          publish(snapshot);
        }
        if (stopped) return;
        if (reopenSocket && wsFailures < MAX_WS_FAILURES_BEFORE_POLL) open();
        else schedulePoll(POLL_INTERVAL_MS, false);
      } catch {
        if (stopped) return;
        if (++recoverFailures >= MAX_RECOVER_FAILURES) {
          stop();
          onError("Lost connection to the active run. Open it in Run History to reload output.");
          return;
        }
        schedulePoll(Math.min(2_500, POLL_INTERVAL_MS * recoverFailures), false);
      } finally {
        recovering = false;
      }
    }

    function open() {
      const generation = ++subscription;
      const isCurrent = () => !stopped && generation === subscription;
      receivedSocketEvent = false;
      try {
        const dispose = bridge.subscribe(seed.id, cursor, (event) => {
          if (isCurrent()) receive(event);
        }, () => {
          if (isCurrent()) disconnect();
        });
        if (isCurrent()) {
          disposeSocket = dispose;
          watchdogTimer = setTimeout(() => {
            if (isCurrent() && !receivedSocketEvent) void recover(false);
          }, WS_WATCHDOG_MS);
        } else {
          dispose();
        }
      } catch {
        if (isCurrent()) disconnect();
      }
    }

    active.set(seed.id, stop);
    open();
  }

  return {
    follow,
    stop() {
      for (const dispose of active.values()) dispose();
    },
  };
}
