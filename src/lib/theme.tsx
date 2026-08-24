import * as React from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "marque:theme";

interface Ctx {
  theme: Theme;
  resolved: "light" | "dark";
  setTheme: (t: Theme) => void;
  /**
   * Transient light override used while printing. Shiki and mermaid bake theme
   * colors into the rendered markup, so printing readable output means actually
   * re-rendering in light. Never persisted — the user's choice is untouched.
   */
  setPrintLight: (on: boolean) => void;
}

const ThemeContext = React.createContext<Ctx | null>(null);

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function resolveTheme(theme: Theme): "light" | "dark" {
  return theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
}

function applyTheme(theme: Theme): "light" | "dark" {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  return resolved;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>(() => {
    if (typeof window === "undefined") return "system";
    return (localStorage.getItem(STORAGE_KEY) as Theme) || "system";
  });
  const [printLight, setPrintLight] = React.useState(false);
  const [resolved, setResolved] = React.useState<"light" | "dark">(() => resolveTheme(theme));
  const effective: Theme = printLight ? "light" : theme;

  React.useEffect(() => {
    setResolved(applyTheme(effective));
  }, [effective]);

  React.useEffect(() => {
    if (effective !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(applyTheme("system"));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [effective]);

  const setTheme = React.useCallback((t: Theme) => {
    localStorage.setItem(STORAGE_KEY, t);
    setThemeState(t);
  }, []);

  const value = React.useMemo(
    () => ({ theme, resolved, setTheme, setPrintLight }),
    [theme, resolved, setTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Ctx {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
