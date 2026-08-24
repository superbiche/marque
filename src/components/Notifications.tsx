import { memo, useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { onFolderWatchLimit, tauri } from "@/lib/tauri";

interface Notification {
  id: number;
  message: string;
}

let nextNotificationId = 0;

export const Notifications = memo(function Notifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const notify = useCallback((message: string) => {
    setNotifications((current) => [
      ...current,
      { id: nextNotificationId++, message },
    ]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setNotifications((current) => current.filter((notification) => notification.id !== id));
  }, []);

  useEffect(() => {
    let active = true;
    void tauri.getSettingsLoadStatus().then((status) => {
      if (active && status.corrupt_settings_path) {
        notify(`Settings were reset after corruption. The original was preserved at ${status.corrupt_settings_path}.`);
      }
    }).catch((error: unknown) => {
      console.error("failed to read settings load status", error);
    });
    return () => {
      active = false;
    };
  }, [notify]);

  useEffect(() => {
    const off = onFolderWatchLimit(({ folder_name, watched, limit }) => {
      notify(`Folder ${folder_name} is too large to watch fully (${watched} of ${limit} directories). Changes may not auto-refresh.`);
    });
    return () => {
      off.then((unlisten) => unlisten());
    };
  }, [notify]);

  useEffect(() => {
    const timers = notifications.map(({ id }) => window.setTimeout(() => dismiss(id), 10_000));
    return () => timers.forEach(window.clearTimeout);
  }, [dismiss, notifications]);

  if (notifications.length === 0) return null;

  return (
    <div className="print-hide pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      {notifications.map((notification) => (
        <div key={notification.id} className="pointer-events-auto flex items-start gap-3 rounded-2xl border bg-popover p-3 text-sm text-popover-foreground shadow-lg">
          <p className="min-w-0 flex-1">{notification.message}</p>
          <Button variant="ghost" size="icon-xs" className="-mr-1 -mt-1" onClick={() => dismiss(notification.id)} aria-label="Dismiss notification">
            <X />
          </Button>
        </div>
      ))}
    </div>
  );
});
