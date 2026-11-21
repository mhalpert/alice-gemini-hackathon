export type CallLogSink = (
  room: string,
  ev: string,
  data?: Record<string, unknown>,
) => void;

export type CallRoomChangeListener = (
  newRoom: string | null,
  prevRoom: string | null,
) => void;

let currentRoom: string | null = null;
let customSink: CallLogSink | null = null;
let loadedSink: CallLogSink | null = null;
let loaderPromise: Promise<CallLogSink | null> | null = null;
const roomChangeListeners = new Set<CallRoomChangeListener>();

export function onCallRoomChange(listener: CallRoomChangeListener): () => void {
  roomChangeListeners.add(listener);
  return () => {
    roomChangeListeners.delete(listener);
  };
}

function loadDefaultSink(): Promise<CallLogSink | null> {
  if (!loaderPromise) {
    loaderPromise = import('../calllog.ts')
      .then((mod) => {
        const fn =
          typeof (mod as { calllog?: unknown })?.calllog === 'function'
            ? ((mod as { calllog: CallLogSink }).calllog)
            : null;
        loadedSink = fn;
        return fn;
      })
      .catch(() => null);
  }
  return loaderPromise;
}

export function setCallRoom(room: string | null): void {
  const prev = currentRoom;
  const next = room && room.trim() ? room.trim() : null;
  currentRoom = next;
  if (prev !== next) {
    for (const listener of roomChangeListeners) {
      try {
        listener(next, prev);
      } catch {
        // never throw
      }
    }
  }
  if (currentRoom && !customSink && !loadedSink) {
    void loadDefaultSink();
  }
}

export function getCallRoom(): string | null {
  return currentRoom;
}

export function setCallLogSink(sink: CallLogSink | null): void {
  customSink = sink;
}

export function logEvent(ev: string, data?: Record<string, unknown>): void {
  const room = currentRoom;
  if (!room) return;

  const sink = customSink ?? loadedSink;
  if (sink) {
    try {
      sink(room, ev, data);
    } catch {
      // never throw
    }
    return;
  }

  void loadDefaultSink().then((fn) => {
    if (!fn) return;
    try {
      fn(room, ev, data);
    } catch {
      // never throw
    }
  });
}
