import { useEffect, useRef, useCallback } from 'react';
import api from '@/lib/api';

/**
 * 🚀 PRODUCTION SAFE Activity Tracker
 * Fixes:
 * - No API calls without token
 * - No tracking on login page
 * - Stops after logout
 * - Safe interval handling
 * - Prevents 403 spam
 */

export const useActivityTracker = (enabled = true) => {
  const lastActivityTime = useRef(Date.now());
  const activeSeconds = useRef(0);
  const isActive = useRef(true);
  const intervalRef = useRef(null);
  const syncInFlightRef = useRef(false);

  const IDLE_THRESHOLD = 60000; // 1 min
  const SYNC_INTERVAL = 30000;  // 30 sec

  /* ============================================================
  Activity Update
  ============================================================ */

  const updateActivity = useCallback(() => {
    if (window.__STOP_ACTIVITY__) return;

    const now = Date.now();
    const timeSinceLastActivity = now - lastActivityTime.current;

    if (timeSinceLastActivity < IDLE_THRESHOLD) {
      if (isActive.current) {
        activeSeconds.current += Math.min(timeSinceLastActivity / 1000, 30);
      }
    }

    lastActivityTime.current = now;
    isActive.current = true;
  }, []);

  const handleActivity = useCallback(() => {
    if (window.__STOP_ACTIVITY__) return;
    updateActivity();
  }, [updateActivity]);

  /* ============================================================
  Page Name Helper
  ============================================================ */

  const getPageName = (path) => {
    const pageNames = {
      '/dashboard': 'Dashboard',
      '/tasks': 'Tasks Management',
      '/clients': 'Client Management',
      '/dsc': 'DSC Register',
      '/duedates': 'Due Dates',
      '/attendance': 'Attendance',
      '/reports': 'Reports',
      '/users': 'User Management'
    };
    return pageNames[path] || 'Taskosphere';
  };

  /* ============================================================
  Sync Activity (FIXED)
  ============================================================ */

  const syncActivity = useCallback(async () => {
    const token =
      localStorage.getItem("token") ||
      sessionStorage.getItem("token");

    // 🚀 HARD STOP CONDITIONS
    if (
      !token ||
      window.__STOP_ACTIVITY__ ||
      window.location.pathname === "/login"
    ) {
      return;
    }

    if (activeSeconds.current <= 0 || syncInFlightRef.current) return;

    syncInFlightRef.current = true;
    try {
      const currentPage = window.location.pathname;
      const pageName = getPageName(currentPage);

      await api.post('/activity/log', {
        app_name: 'Taskosphere Web',
        window_title: pageName,
        url: window.location.href,
        category: 'productivity',
        duration_seconds: Math.round(activeSeconds.current)
      });

      // Reset after success
      activeSeconds.current = 0;

    } catch (error) {
      // ❌ Avoid console spam for auth errors
      if (error.response?.status !== 401 && error.response?.status !== 403) {
        console.error('Activity sync error:', error);
      }
    } finally {
      syncInFlightRef.current = false;
    }
  }, []);

  /* ============================================================
  Main Effect
  ============================================================ */

  useEffect(() => {
    // 🔴 STOP COMPLETELY if disabled
    if (!enabled) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      return;
    }

    // Track activity events
    const events = [
      'keydown',
      'keypress',
      'mousemove',
      'mousedown',
      'scroll',
      'touchstart',
      'click'
    ];

    events.forEach(event => {
      window.addEventListener(event, handleActivity, { passive: true });
    });

    // ✅ Safe interval (async protected)
    intervalRef.current = setInterval(async () => {
      try {
        await syncActivity();
      } catch {}
    }, SYNC_INTERVAL);

    // Visibility change
    const handleVisibilityChange = () => {
      if (document.hidden) {
        syncActivity();
        isActive.current = false;
      } else {
        lastActivityTime.current = Date.now();
        isActive.current = true;
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Before unload
    const handleBeforeUnload = () => {
      syncActivity();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      events.forEach(event => {
        window.removeEventListener(event, handleActivity);
      });

      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }

      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);

      // Final sync
      syncActivity();
    };

  }, [enabled, handleActivity, syncActivity]);

  /* ============================================================
  Public API
  ============================================================ */

  return {
    isTracking: enabled,
    getActiveTime: () => activeSeconds.current
  };
};

export default useActivityTracker;
