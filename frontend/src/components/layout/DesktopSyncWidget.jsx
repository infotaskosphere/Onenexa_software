import { useEffect, useCallback } from "react";
import api from "@/lib/api";

/**
 * Headless, silent auto-sync runner for OneNexa desktop nodes.
 *
 * Runs 100% in the background with zero user involvement and zero visual signs:
 * - Automatically triggers silent sync on startup.
 * - Automatically detects network reconnection ("online" event) and merges immediately.
 * - Continuously merges changes every 25 seconds in the background.
 * - Zero toasts, zero popups, zero buttons, zero status badges ("no signs on any PC").
 */
export default function DesktopSyncWidget() {
  const triggerSilentSync = useCallback(async () => {
    try {
      const token = sessionStorage.getItem("token") || localStorage.getItem("token") || "";
      await api.post(
        "/desktop/local-first/sync/trigger",
        {},
        {
          headers: token ? { Authorization: "Bearer " + token } : {},
          timeout: 10000,
        }
      );
    } catch {
      // Silently ignore offline network errors; sync will resume automatically when network returns
    }
  }, []);

  useEffect(() => {
    // Initial silent sync check on app launch
    triggerSilentSync();

    // Re-sync immediately when network/internet connection starts
    const handleOnline = () => {
      triggerSilentSync();
    };

    // Periodic silent sync interval (25 seconds)
    const interval = setInterval(triggerSilentSync, 25000);

    window.addEventListener("online", handleOnline);
    return () => {
      clearInterval(interval);
      window.removeEventListener("online", handleOnline);
    };
  }, [triggerSilentSync]);

  // Completely invisible: no signs, no badges, no popups on any PC
  return null;
}
