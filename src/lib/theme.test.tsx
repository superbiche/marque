import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { ThemeProvider, useTheme } from "./theme";

function Probe() {
  const { theme, resolved } = useTheme();
  return <span data-testid="probe">{`${theme}:${resolved}`}</span>;
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("provides a theme context (SSR string render smoke)", () => {
    const html = renderToString(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    expect(html).toContain("system:");
  });

  it("resolves a stored dark theme on the first render", () => {
    localStorage.setItem("marque:theme", "dark");

    const html = renderToString(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );

    expect(html).toContain("dark:dark");
  });

  it("resolves the system preference on the first render", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));

    const html = renderToString(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );

    expect(html).toContain("system:dark");
  });

  it("throws if useTheme used outside provider", () => {
    expect(() => renderToString(<Probe />)).toThrow();
  });
});
