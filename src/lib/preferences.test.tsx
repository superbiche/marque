import { beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import {
  clampContentZoom,
  PreferencesProvider,
  usePreferences,
} from "./preferences";

function Probe() {
  const { contentWidth, contentZoom, zoom } = usePreferences();
  return <span>{`${zoom}:${contentZoom}:${contentWidth}`}</span>;
}

describe("PreferencesProvider", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("clamps content zoom to its supported range", () => {
    expect(clampContentZoom(0.6)).toBe(0.7);
    expect(clampContentZoom(1.24)).toBe(1.2);
    expect(clampContentZoom(2.1)).toBe(2);
  });

  it("uses content defaults when loading legacy local preferences", () => {
    localStorage.setItem("marque:preferences", JSON.stringify({ zoom: 1.2 }));

    const html = renderToString(
      <PreferencesProvider>
        <Probe />
      </PreferencesProvider>,
    );

    expect(html).toContain("1.2:1:narrow");
  });
});
