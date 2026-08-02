/**
 * The `notificationclick` decision, lifted out of sw.ts so it can be tested
 * without a service worker. sw.ts supplies the real clients/openWindow/store.
 *
 * Order matters and is the whole fix: the pending record is written BEFORE the
 * client list is even looked up, let alone focused or messaged. A tap on an
 * installed PWA restores the app at
 * `start_url` before this handler runs, so a client normally exists — the
 * postMessage path is taken, and if the page is still booting (its listener not
 * yet attached, or the container's buffered messages already flushed at `load`)
 * that message is lost. The record is what the page claims on mount and on
 * resume, so the tap survives the race in every launch state.
 *
 * See lib/pending-navigation.ts for why the message alone is not enough.
 */
import { extractThreadId } from "./notification-url";

/**
 * The bits of a WindowClient this uses. Structural rather than `WindowClient`
 * itself: that type only exists under the webworker lib, and this module is
 * typechecked by the app's DOM tsconfig too.
 */
interface FocusableClient {
  focus: () => Promise<unknown>;
  postMessage: (message: unknown) => void;
}

export interface NotificationClickTarget {
  /**
   * Window clients, matched with `includeUncontrolled: true`. Deliberately a
   * thunk rather than an array: `clients.matchAll()` is an await like any other
   * and resolving it in the caller put it *ahead* of the record, which is how a
   * tap could leave no trace at all when it stalls.
   */
  getClients: () => Promise<FocusableClient[]>;
  openWindow: (url: string) => Promise<unknown>;
  savePending: (threadId: string) => Promise<void>;
  origin: string;
}

export async function handleNotificationClick(
  rawUrl: string,
  target: NotificationClickTarget,
): Promise<void> {
  const threadId = extractThreadId(rawUrl);

  // Before anything else: a client that is focused but never hears the message
  // must still be able to find the thread.
  if (threadId) {
    try {
      await target.savePending(threadId);
    } catch {
      // A dead store must not cost the focus/openWindow below.
    }
  }

  let clients: FocusableClient[] = [];
  try {
    clients = await target.getClients();
  } catch {
    // Treat an unusable client list as an empty one and take the openWindow
    // path, rather than losing the tap entirely.
  }

  let messaged = false;
  for (const client of clients) {
    void client.focus();
    client.postMessage({ type: "navigate-thread", threadId });
    messaged = true;
  }
  if (messaged) return;

  await target.openWindow(new URL(rawUrl, target.origin).href);
}
