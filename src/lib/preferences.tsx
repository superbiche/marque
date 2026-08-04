import * as React from "react";
import { tauri } from "@/lib/tauri";

export interface Preferences {
  copyAsMarkdown: boolean;
  zoom: number;
  contentZoom: number;
  contentWidth: ContentWidth;
  contentFont: ContentFont;
  sidebarLeftWidth: number;
  sidebarRightWidth: number;
  sidebarGroupByRepo: boolean;
}

export type ContentWidth = "narrow" | "wide" | "full";

export type ContentFont = "geist" | "inter" | "quattro" | "literata" | "system";

export const CONTENT_FONT_LABELS: Record<ContentFont, string> = {
  geist: "Geist",
  inter: "Inter",
  quattro: "iA Writer Quattro",
  literata: "Literata",
  system: "System",
};

const CONTENT_FONT_STACKS: Record<ContentFont, string> = {
  geist: '"Geist Variable", ui-sans-serif, system-ui, sans-serif',
  inter: '"Inter Variable", ui-sans-serif, system-ui, sans-serif',
  quattro: '"iA Writer Quattro", ui-sans-serif, system-ui, sans-serif',
  literata: '"Literata Variable", Georgia, serif',
  system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

const STORAGE_KEY = "marque:preferences";

const DEFAULTS: Preferences = {
  copyAsMarkdown: true,
  zoom: 1.0,
  contentZoom: 1.0,
  contentWidth: "narrow",
  contentFont: "geist",
  sidebarLeftWidth: 256,
  sidebarRightWidth: 224,
  sidebarGroupByRepo: true,
};

export const UI_ZOOM_MIN = 0.7;
export const UI_ZOOM_MAX = 1.6;
export const UI_ZOOM_STEP = 0.1;
export const CONTENT_ZOOM_MIN = 0.7;
export const CONTENT_ZOOM_MAX = 2.0;
export const CONTENT_ZOOM_STEP = 0.1;

export const SIDEBAR_LEFT_MIN = 180;
export const SIDEBAR_LEFT_MAX = 400;
export const SIDEBAR_LEFT_DEFAULT = 256;
export const SIDEBAR_RIGHT_MIN = 160;
export const SIDEBAR_RIGHT_MAX = 360;
export const SIDEBAR_RIGHT_DEFAULT = 224;

interface Ctx extends Preferences {
  setCopyAsMarkdown: (v: boolean) => void;
  setSidebarGroupByRepo: (v: boolean) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  contentZoomIn: () => void;
  contentZoomOut: () => void;
  contentZoomReset: () => void;
  setContentWidth: (width: ContentWidth) => void;
  setContentFont: (font: ContentFont) => void;
  setSidebarWidth: (side: "left" | "right", width: number) => void;
  resetSidebarWidth: (side: "left" | "right") => void;
}

const PreferencesContext = React.createContext<Ctx | null>(null);

function load(): Preferences {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const stored = JSON.parse(raw) as Partial<Preferences>;
    return {
      ...DEFAULTS,
      ...stored,
      contentZoom: typeof stored.contentZoom === "number"
        ? clampContentZoom(stored.contentZoom)
        : DEFAULTS.contentZoom,
      contentWidth: isContentWidth(stored.contentWidth)
        ? stored.contentWidth
        : DEFAULTS.contentWidth,
      contentFont: isContentFont(stored.contentFont)
        ? stored.contentFont
        : DEFAULTS.contentFont,
    };
  } catch {
    return DEFAULTS;
  }
}

function persist(prefs: Preferences) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

let backendTimer: ReturnType<typeof setTimeout> | null = null;
function persistToBackend(prefs: Preferences) {
  if (backendTimer) clearTimeout(backendTimer);
  backendTimer = setTimeout(() => {
    tauri.savePreferences({
      zoom: prefs.zoom,
      content_zoom: prefs.contentZoom,
      content_width: prefs.contentWidth,
      content_font: prefs.contentFont,
      sidebar_left_width: prefs.sidebarLeftWidth,
      sidebar_right_width: prefs.sidebarRightWidth,
      copy_as_markdown: prefs.copyAsMarkdown,
      sidebar_group_by_repo: prefs.sidebarGroupByRepo,
    }).catch(() => {});
  }, 300);
}

function clampZoom(z: number): number {
  return Math.round(Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, z)) * 10) / 10;
}

export function clampContentZoom(zoom: number): number {
  return Math.round(Math.min(CONTENT_ZOOM_MAX, Math.max(CONTENT_ZOOM_MIN, zoom)) * 10) / 10;
}

function isContentWidth(width: unknown): width is ContentWidth {
  return width === "narrow" || width === "wide" || width === "full";
}

function isContentFont(font: unknown): font is ContentFont {
  return typeof font === "string" && font in CONTENT_FONT_STACKS;
}

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = React.useState<Preferences>(load);

  // On mount, reconcile with Rust backend (authoritative source).
  React.useEffect(() => {
    tauri.loadPreferences().then((backend) => {
      setPrefs((prev) => {
        const next = { ...prev };
        if (backend.zoom != null) next.zoom = backend.zoom;
        if (backend.content_zoom != null) next.contentZoom = clampContentZoom(backend.content_zoom);
        if (isContentWidth(backend.content_width)) next.contentWidth = backend.content_width;
        if (isContentFont(backend.content_font)) next.contentFont = backend.content_font;
        if (backend.sidebar_left_width != null) next.sidebarLeftWidth = backend.sidebar_left_width;
        if (backend.sidebar_right_width != null) next.sidebarRightWidth = backend.sidebar_right_width;
        if (backend.copy_as_markdown != null) next.copyAsMarkdown = backend.copy_as_markdown;
        if (backend.sidebar_group_by_repo != null) next.sidebarGroupByRepo = backend.sidebar_group_by_repo;
        persist(next);
        return next;
      });
    }).catch(() => {});
  }, []);

  // Apply zoom to root font-size so all rem-based text scales app-wide.
  React.useEffect(() => {
    document.documentElement.style.fontSize = `${16 * prefs.zoom}px`;
    return () => { document.documentElement.style.fontSize = ""; };
  }, [prefs.zoom]);

  React.useEffect(() => {
    document.documentElement.style.setProperty("--content-zoom", String(prefs.contentZoom));
    return () => { document.documentElement.style.removeProperty("--content-zoom"); };
  }, [prefs.contentZoom]);

  React.useEffect(() => {
    document.documentElement.style.setProperty("--content-font", CONTENT_FONT_STACKS[prefs.contentFont]);
    return () => { document.documentElement.style.removeProperty("--content-font"); };
  }, [prefs.contentFont]);

  const update = React.useCallback((fn: (prev: Preferences) => Preferences) => {
    setPrefs((prev) => {
      const next = fn(prev);
      persist(next);
      persistToBackend(next);
      return next;
    });
  }, []);

  const setCopyAsMarkdown = React.useCallback(
    (v: boolean) => update((p) => ({ ...p, copyAsMarkdown: v })),
    [update],
  );

  const setSidebarGroupByRepo = React.useCallback(
    (v: boolean) => update((p) => ({ ...p, sidebarGroupByRepo: v })),
    [update],
  );

  const zoomIn = React.useCallback(
    () => update((p) => ({ ...p, zoom: clampZoom(p.zoom + UI_ZOOM_STEP) })),
    [update],
  );

  const zoomOut = React.useCallback(
    () => update((p) => ({ ...p, zoom: clampZoom(p.zoom - UI_ZOOM_STEP) })),
    [update],
  );

  const zoomReset = React.useCallback(
    () => update((p) => ({ ...p, zoom: 1.0 })),
    [update],
  );

  const contentZoomIn = React.useCallback(
    () => update((p) => ({ ...p, contentZoom: clampContentZoom(p.contentZoom + CONTENT_ZOOM_STEP) })),
    [update],
  );

  const contentZoomOut = React.useCallback(
    () => update((p) => ({ ...p, contentZoom: clampContentZoom(p.contentZoom - CONTENT_ZOOM_STEP) })),
    [update],
  );

  const contentZoomReset = React.useCallback(
    () => update((p) => ({ ...p, contentZoom: 1.0 })),
    [update],
  );

  const setContentWidth = React.useCallback(
    (width: ContentWidth) => update((p) => ({ ...p, contentWidth: width })),
    [update],
  );

  const setContentFont = React.useCallback(
    (font: ContentFont) => update((p) => ({ ...p, contentFont: font })),
    [update],
  );

  const setSidebarWidth = React.useCallback(
    (side: "left" | "right", width: number) => {
      const min = side === "left" ? SIDEBAR_LEFT_MIN : SIDEBAR_RIGHT_MIN;
      const max = side === "left" ? SIDEBAR_LEFT_MAX : SIDEBAR_RIGHT_MAX;
      const clamped = Math.round(Math.min(max, Math.max(min, width)));
      const key = side === "left" ? "sidebarLeftWidth" : "sidebarRightWidth";
      update((p) => ({ ...p, [key]: clamped }));
    },
    [update],
  );

  const resetSidebarWidth = React.useCallback(
    (side: "left" | "right") => {
      const key = side === "left" ? "sidebarLeftWidth" : "sidebarRightWidth";
      const def = side === "left" ? SIDEBAR_LEFT_DEFAULT : SIDEBAR_RIGHT_DEFAULT;
      update((p) => ({ ...p, [key]: def }));
    },
    [update],
  );

  const value = React.useMemo(
    () => ({
      ...prefs,
      setCopyAsMarkdown,
      setSidebarGroupByRepo,
      zoomIn,
      zoomOut,
      zoomReset,
      contentZoomIn,
      contentZoomOut,
      contentZoomReset,
      setContentWidth,
      setContentFont,
      setSidebarWidth,
      resetSidebarWidth,
    }),
    [prefs, setCopyAsMarkdown, setSidebarGroupByRepo, zoomIn, zoomOut, zoomReset, contentZoomIn, contentZoomOut, contentZoomReset, setContentWidth, setContentFont, setSidebarWidth, resetSidebarWidth],
  );

  return (
    <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>
  );
}

export function usePreferences(): Ctx {
  const ctx = React.useContext(PreferencesContext);
  if (!ctx) throw new Error("usePreferences must be used within PreferencesProvider");
  return ctx;
}
