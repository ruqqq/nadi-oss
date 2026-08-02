import { useEffect } from "react";
import { showAppliedUpdateToast } from "@/lib/sw-update-toast";

/**
 * Reports an update applied by the previous page load.
 *
 * Renders nothing, but must be mounted AFTER <AppToaster />: sonner drops any
 * toast fired before the Toaster subscribes, and sibling effects run in render
 * order.
 */
export function ServiceWorkerUpdateToast(): null {
  useEffect(() => {
    showAppliedUpdateToast();
  }, []);
  return null;
}
