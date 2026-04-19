/**
 * Thin wrapper around the browser Notification API.
 *
 * Callers should use these helpers rather than reaching for `window.Notification`
 * directly, so environments without support (older iOS Safari, some embedded
 * WebViews) degrade gracefully instead of throwing.
 */

/** True when the Notification API is present in this runtime. */
export function notificationsSupported(): boolean {
  return typeof Notification !== 'undefined';
}

/**
 * Ask the browser for permission to send notifications, if not already
 * decided. Returns the effective permission.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return 'denied';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/** Fire a notification. No-op when unsupported or permission not granted. */
export function showNotification(title: string, options?: NotificationOptions): void {
  if (!notificationsSupported()) return;
  if (Notification.permission !== 'granted') return;
  try {
    new Notification(title, options);
  } catch {
    // Some browsers throw in embedded contexts even when permission is granted.
  }
}
