import * as React from "react";
import { renderMarkdown, slugifyHeading } from "@/lib/markdown";
import { highlightCode } from "@/lib/highlight";
import { renderMermaidBlocks } from "@/lib/mermaid";
import { createRenderCacheKey, renderCache } from "@/lib/renderCache";
import { attachCopyButtons } from "@/components/CodeCopyOverlay";
import { handleCopyAsMarkdown } from "@/lib/copyAsMarkdown";
import { classifyLink } from "@/lib/links";
import { useTheme } from "@/lib/theme";
import { usePreferences } from "@/lib/preferences";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";

interface Props {
  source: string;
  filePath?: string;
  articleRef?: React.RefObject<HTMLElement | null>;
  onRendered?: () => void;
  onOpenLink: (path: string, fragment?: string) => void;
  fragment?: string;
  onFragmentHandled?: () => void;
}

const scrollMemory = new Map<string, number>();

interface RenderState {
  key: string;
  html: string;
  isProcessed: boolean;
}

export const Viewer = React.memo(function Viewer({
  source,
  filePath,
  articleRef,
  onRendered,
  onOpenLink,
  fragment,
  onFragmentHandled,
}: Props) {
  const internalRef = React.useRef<HTMLElement>(null);
  const ref = (articleRef ?? internalRef) as React.RefObject<HTMLElement | null>;
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const { resolved } = useTheme();
  const { copyAsMarkdown, contentWidth } = usePreferences();
  const cacheKey = createRenderCacheKey(filePath, source, resolved);
  const [renderState, setRenderState] = React.useState<RenderState>({
    key: "",
    html: "",
    isProcessed: false,
  });
  const html = renderState.html;

  // Keep onRendered fresh without making it a dep — otherwise every parent
  // re-render produces a new fn ref, retriggers the highlight effect, and the
  // resulting outerHTML swap visibly flickers code blocks back to plain text.
  const onRenderedRef = React.useRef(onRendered);
  React.useEffect(() => {
    onRenderedRef.current = onRendered;
  }, [onRendered]);

  React.useEffect(() => {
    const cachedHtml = renderCache.get(cacheKey);
    setRenderState({
      key: cacheKey,
      html: cachedHtml ?? renderMarkdown(source),
      isProcessed: cachedHtml !== undefined,
    });
  }, [cacheKey, source]);

  React.useEffect(() => {
    const root = ref.current;
    if (!root || renderState.key !== cacheKey) return;
    let cancelled = false;

    (async () => {
      if (renderState.isProcessed) {
        attachCopyButtons(root as HTMLElement);
        onRenderedRef.current?.();
        return;
      }

      const codeBlocks = root.querySelectorAll<HTMLElement>("pre > code[class*='language-']");
      for (const code of Array.from(codeBlocks)) {
        const cls = code.className;
        const match = cls.match(/language-([\w+-]+)/);
        const lang = match?.[1];
        const text = code.textContent || "";
        try {
          const highlighted = await highlightCode(text, lang, resolved);
          if (cancelled) return;
          const pre = code.parentElement;
          if (!pre || !pre.isConnected) continue;
          const tpl = document.createElement("template");
          tpl.innerHTML = highlighted.trim();
          const replacement = tpl.content.firstElementChild;
          if (replacement) {
            // Preserve source map attribute through Shiki replacement.
            const sourceMap = pre.getAttribute("data-source-map");
            if (sourceMap) replacement.setAttribute("data-source-map", sourceMap);
            pre.replaceWith(replacement);
          }
        } catch {
          // leave plain on failure
        }
      }
      if (cancelled) return;
      await renderMermaidBlocks(root as HTMLElement, resolved);
      if (cancelled) return;

      // Copy buttons have listeners and cannot be serialized. Snapshot the
      // completed Shiki/Mermaid markup first, then attach buttons to this DOM.
      renderCache.set(cacheKey, root.innerHTML);
      attachCopyButtons(root as HTMLElement);
      onRenderedRef.current?.();
    })();

    return () => {
      cancelled = true;
    };
    // intentionally omit `ref` and `onRendered`: ref is stable, onRendered is read via ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, html, renderState.isProcessed, renderState.key, resolved]);

  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !filePath) return;
    const saved = scrollMemory.get(filePath) ?? 0;
    el.scrollTop = saved;
    const onScroll = () => scrollMemory.set(filePath, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [filePath, html]);

  const scrollToAnchor = React.useCallback((rawFragment: string): boolean => {
    const root = ref.current;
    const scroller = scrollerRef.current;
    if (!root || !scroller) return false;

    const id = slugifyHeading(rawFragment);
    const target = Array.from(root.querySelectorAll<HTMLElement>("[id]")).find(
      (element) => element.id === id,
    );
    if (!target) return false;

    const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTo({ top, behavior: "auto" });
    if (filePath) scrollMemory.set(filePath, top);
    return true;
  }, [filePath, ref]);

  // A link can point to a document that is already rendered in another tab.
  // Scroll after React has committed its HTML in either the new or existing tab.
  React.useEffect(() => {
    if (!fragment || !html) return;
    scrollToAnchor(fragment);
    onFragmentHandled?.();
  }, [fragment, html, onFragmentHandled, scrollToAnchor]);

  // Intercept copy events to write original markdown source to clipboard.
  React.useEffect(() => {
    const root = ref.current;
    if (!root || !copyAsMarkdown) return;

    const onCopy = (e: ClipboardEvent) => {
      handleCopyAsMarkdown(e, root as HTMLElement, source);
    };

    root.addEventListener("copy", onCopy);
    return () => root.removeEventListener("copy", onCopy);
  }, [source, copyAsMarkdown]);

  // Own all markdown-link navigation here so filesystem links never navigate
  // the webview away from the current document.
  React.useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest("a");
      if (!anchor || !root.contains(anchor)) return;

      const href = anchor.getAttribute("href");
      if (href === null) return;

      const target = classifyLink(href, filePath);
      switch (target.kind) {
        case "anchor":
          event.preventDefault();
          scrollToAnchor(target.slug);
          break;
        case "external":
          event.preventDefault();
          void openUrl(target.url).catch((error) => console.error("failed to open URL", error));
          break;
        case "markdown":
          event.preventDefault();
          onOpenLink(target.path, target.fragment);
          break;
        case "path":
          event.preventDefault();
          void openPath(target.path).catch((error) => console.error("failed to open path", error));
          break;
        case "unresolved":
          break;
      }
    };

    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [filePath, onOpenLink, ref, scrollToAnchor]);

  // Memoize the inner-html object so its reference is stable across renders.
  // If we passed a fresh { __html: html } object every render, React would
  // re-apply innerHTML on every re-render (e.g. when the parent Pane bumps
  // contentNonce after highlighting finishes), wiping the shiki spans we just
  // injected and restoring the raw markdown-it pre.
  const dangerousHtml = React.useMemo(() => ({ __html: html }), [html]);

  return (
    <div ref={scrollerRef} className="h-full w-full overflow-auto">
      <article
        ref={ref}
        className={`markdown-body markdown-width-${contentWidth}`}
        dangerouslySetInnerHTML={dangerousHtml}
      />
    </div>
  );
});
