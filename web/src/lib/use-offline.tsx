import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { networkIsOnline, resolveOffline, type Reachability } from "./offline-state";

const OfflineContext = createContext(false);

/** True when the app cannot reach the server — either the last bootstrap probe
 *  failed to connect, or (with no probe evidence) the browser says we're offline. */
export function useOffline(): boolean {
  return useContext(OfflineContext);
}

export function OfflineProvider({
  reachability,
  children,
}: {
  reachability: Reachability;
  children: ReactNode;
}) {
  const [browserOnline, setBrowserOnline] = useState(networkIsOnline);

  useEffect(() => {
    const onOnline = () => setBrowserOnline(true);
    const onOffline = () => setBrowserOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const offline = resolveOffline({ browserOnline, reachability });
  return <OfflineContext.Provider value={offline}>{children}</OfflineContext.Provider>;
}
