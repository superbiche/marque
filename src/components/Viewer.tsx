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
import { toAssetUrl } from "@/lib/tauri";
import { notifyApp } from "@/components/Notifications";
import { copyText } from "@/lib/clipboard";
import { useHighlights } from "@/lib/highlightsStore";
import {
  applyAllHighlights,
  highlightIdAt,
  highlightRect,
  passageText,
  scrollHighlightIntoView,
  setEditActive,
  withPreservedScroll,
} from "@/lib/highlightsApply";
import {
  HIGHLIGHT_COLOURS,
  anchorFromSelection,
  formatExportItem,
  newHighlightId,
  resolveAnchors,
  resolutionToEntries,
  sectionHeadingForRange,
  type Highlight,
  type HighlightAnchor,
  type HighlightColour,
  type PanelEntry,
  type Resolution,
} from "@/lib/highlights";
import {
  HighlightPopover,
  type HighlightPopoverState,
} from "@/components/HighlightPopover";
import {
  HighlightEditPopover,
  type HighlightEditPopoverState,
} from "@/components/HighlightEditPopover";

interface Props {
  source: string;
  filePath?: string;
  articleRef?: React.RefObject<HTMLElement | null>;
  onRendered?: () => void;
  onOpenLink: (path: string, fragment?: string) => void;
  fragment?: string;
  onFragmentHandled?: () => void;
  /**
   * Called with this document's panel projection (the rows the review panel
   * should show) whenever a highlight resolution is applied. The panel is
   * fed from these entries instead of re-deriving them from the DOM (F4).
   */
  onResolutionChange?: (path: string, entries: PanelEntry[]) => void;
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
  onResolutionChange,
}: Props) {
  const internalRef = React.useRef<HTMLElement>(null);
  const ref = (articleRef ?? internalRef) as React.RefObject<HTMLElement | null>;
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const { resolved } = useTheme();
  const { copyAsMarkdown, contentWidth } = usePreferences();
  const {
    byFile,
    activeColour,
    setActiveColour,
    addHighlight,
    updateHighlight,
    removeHighlight,
    loadFile,
    getLoadStatus,
    highlightsKey,
  } = useHighlights();
  const cacheKey = createRenderCacheKey(filePath, source, resolved);
  const [renderState, setRenderState] = React.useState<RenderState>({
    key: "",
    html: "",
    isProcessed: false,
  });
  const html = renderState.html;

  // Highlights are keyed by absolute path, so file-backed documents only:
  // the welcome document has no path and carries none.
  const fileHighlights = React.useMemo(
    () => (filePath ? byFile[filePath] ?? [] : []),
    [byFile, filePath],
  );
  // The render effect reads through this ref so a highlight added while a
  // render pass is in flight doesn't need the pass to restart; the
  // re-apply effect below (keyed on the live list) settles any mismatch.
  const fileHighlightsRef = React.useRef(fileHighlights);
  fileHighlightsRef.current = fileHighlights;

  const [popover, setPopover] = React.useState<HighlightPopoverState | null>(null);
  const [editPopover, setEditPopover] = React.useState<HighlightEditPopoverState | null>(null);
  const pendingSelection = React.useRef<{
    anchor: HighlightAnchor;
    passage: string;
  } | null>(null);

  // Lazily load this document's highlights (idempotent in the store).
  React.useEffect(() => {
    if (filePath) loadFile(filePath);
  }, [filePath, loadFile]);

  // Switching documents invalidates any open popover and pending selection.
  React.useEffect(() => {
    setPopover(null);
    setEditPopover(null);
    pendingSelection.current = null;
  }, [filePath]);

  // Keep onRendered fresh without making it a dep — otherwise every parent
  // re-render produces a new fn ref, retriggers the highlight effect, and the
  // resulting outerHTML swap visibly flickers code blocks back to plain text.
  const onRenderedRef = React.useRef(onRendered);
  React.useEffect(() => {
    onRenderedRef.current = onRendered;
  }, [onRendered]);

  const onResolutionChangeRef = React.useRef(onResolutionChange);
  React.useEffect(() => {
    onResolutionChangeRef.current = onResolutionChange;
  }, [onResolutionChange]);

  // The last panel projection applied for this document (F4). The
  // "copy existing highlight" action uses it instead of reading the
  // rendered spans, so it always matches what the panel shows.
  const lastEntriesRef = React.useRef<PanelEntry[]>([]);

  // The anchoring/relocation key, read through a ref: the effects below
  // don't restart when it arrives — the re-apply effect below reruns on the
  // state value instead (a rerun is exactly what a late key must trigger).
  const highlightsKeyRef = React.useRef<Uint8Array | null>(highlightsKey);
  highlightsKeyRef.current = highlightsKey;

  React.useEffect(() => {
    const cachedHtml = renderCache.get(cacheKey);
    setRenderState({
      key: cacheKey,
      html: cachedHtml ?? renderMarkdown(source, { documentPath: filePath, toAssetUrl }),
      isProcessed: cachedHtml !== undefined,
    });
  }, [cacheKey, source, filePath]);

  React.useEffect(() => {
    const root = ref.current;
    if (!root || renderState.key !== cacheKey) return;
    let cancelled = false;

    (async () => {
      const rootEl = root as HTMLElement;

      // F3 retry: a fresh render for a document whose read failed gets
      // another attempt (no-op when the read already landed).
      if (filePath) loadFile(filePath);

      // Anchor/relayout only once the per-installation key and this
      // document's read have both arrived (F3); the projection is empty
      // until then, so the panel never shows stale rows for a fresh render.
      const key = highlightsKeyRef.current;
      const canApply =
        key !== null &&
        filePath !== undefined &&
        getLoadStatus(filePath) === "loaded";
      const publish = (resolution: Resolution | null) => {
        if (!filePath) return; // the welcome document has no panel rows
        const entries = resolution ? resolutionToEntries(rootEl, resolution) : [];
        lastEntriesRef.current = entries;
        onResolutionChangeRef.current?.(filePath, entries);
      };

      if (renderState.isProcessed) {
        attachCopyButtons(rootEl);
        if (canApply && key) {
          const resolution = resolveAnchors(rootEl, fileHighlightsRef.current, key);
          applyAllHighlights(rootEl, resolution);
          publish(resolution);
        } else {
          publish(null);
        }
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
          const highlighted = await highlightCode(text, lang);
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
      // The snapshot deliberately carries no highlight spans — those come
      // from the live list and are (re)applied below and on every change.
      renderCache.set(cacheKey, rootEl.innerHTML);
      attachCopyButtons(rootEl);
      // Re-read the key and load status *now*: Shiki/Mermaid rendered across
      // several awaits, so the per-installation key or this document's read
      // may have arrived during the pass. The early `key`/`canApply` above are
      // only valid for the cached (isProcessed) branch, which never awaits;
      // using them here would skip the apply even though anchoring is possible.
      const keyNow = highlightsKeyRef.current;
      const canApplyNow =
        keyNow !== null && filePath !== undefined && getLoadStatus(filePath) === "loaded";
      if (canApplyNow && keyNow) {
        const resolution = resolveAnchors(rootEl, fileHighlightsRef.current, keyNow);
        applyAllHighlights(rootEl, resolution);
        publish(resolution);
      } else {
        publish(null);
      }
      onRenderedRef.current?.();
    })();

    return () => {
      cancelled = true;
    };
    // intentionally omit `ref` and `onRendered`: ref is stable, onRendered is read via ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, html, renderState.isProcessed, renderState.key, resolved]);

  // Re-apply when this document's highlight list changes (add, recolour,
  // note edit, remove, undo), when the article remounts (theme flip changes
  // renderState.key), or when the anchoring key arrives late. Scroll is
  // preserved: removing a wrapper span the browser is using as its scroll
  // anchor makes Chrome/Safari jump (often to the top) when scroll-anchoring
  // fails to find a fallback.
  React.useEffect(() => {
    const root = ref.current;
    if (!root || !filePath) return;
    const rootEl = root as HTMLElement;

    // F3 retry: re-attempt a previously failed read (no-op when loaded or
    // already in flight).
    loadFile(filePath);
    const key = highlightsKey;
    if (!key || getLoadStatus(filePath) !== "loaded") return;

    withPreservedScroll(scrollerRef.current, () => {
      const resolution = resolveAnchors(rootEl, fileHighlights, key);
      applyAllHighlights(rootEl, resolution);
      const entries = resolutionToEntries(rootEl, resolution);
      lastEntriesRef.current = entries;
      onResolutionChangeRef.current?.(filePath, entries);
    });
  }, [fileHighlights, filePath, renderState.key, highlightsKey, loadFile, getLoadStatus]);

  // Refresh the selection popover from the live selection. `anchorFromSelection`
  // is the single gate: it returns null for collapsed or out-of-article
  // selections, for selections that touch a code block (code is never
  // highlightable), and for selections that don't sit inside one source-mapped
  // block (e.g. inside a mermaid diagram) — in all of those cases no popover
  // is offered. Creation is also gated on the per-installation key and this
  // document's read having landed (F3).
  const refreshPopover = React.useCallback(() => {
    const root = ref.current;
    if (!root || !filePath) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setPopover(null);
      pendingSelection.current = null;
      return;
    }
    // A fresh selection takes priority over any open edit popover.
    setEditPopover(null);
    const range = sel.getRangeAt(0);
    const key = highlightsKeyRef.current;
    if (!key || getLoadStatus(filePath) !== "loaded") {
      setPopover(null);
      pendingSelection.current = null;
      return;
    }
    const anchor = anchorFromSelection(range, root as HTMLElement, key);
    if (!anchor) {
      setPopover(null);
      pendingSelection.current = null;
      return;
    }
    pendingSelection.current = {
      anchor,
      passage: sel.toString().trim(),
    };
    const rect = range.getBoundingClientRect();
    setPopover({ x: rect.left + rect.width / 2, y: rect.bottom });
  }, [filePath, getLoadStatus]);

  // Detect a text selection inside the article and surface the highlight
  // popover, from a mouse release or from a keyboard selection (Shift+Arrow,
  // Shift+Home/End, …). Both paths go through the same `refreshPopover` gate;
  // the selection-change path is debounced (it fires on every selection
  // mutation) and is scoped to selections that touch this article, so a
  // split pane only ever answers for its own document.
  React.useEffect(() => {
    const root = ref.current;
    if (!root || !filePath) return;
    let timer: number | null = null;
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        refreshPopover();
      }, 150);
    };
    const onMouseUp = () => refreshPopover();
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      if (root.contains(sel.anchorNode) || root.contains(sel.focusNode)) schedule();
    };
    root.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      root.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      if (timer !== null) window.clearTimeout(timer);
    };
    // `refreshPopover` is stable per filePath (its volatile inputs are the key
    // ref and the store's load-status reader); rebind on a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, renderState.key, refreshPopover]);

  // Click on an existing highlight → open the edit popover for it. Skipped
  // when a non-collapsed selection is present (the mouseup path handled it).
  React.useEffect(() => {
    const root = ref.current;
    if (!root || !filePath) return;
    const onClick = (e: MouseEvent) => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      const id = highlightIdAt(e.target as Node, root as HTMLElement);
      if (!id) return;
      const highlight = fileHighlights.find((h) => h.id === id);
      if (!highlight) return;
      const rect = highlightRect(root as HTMLElement, id);
      if (!rect) return;
      e.stopPropagation();
      setPopover(null);
      setEditPopover({
        x: rect.left + rect.width / 2,
        y: rect.bottom,
        highlight,
      });
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [fileHighlights, filePath, renderState.key]);

  // Keep the edit popover's data in sync if the underlying highlight
  // changes (recolour, note edit) and drop it if the highlight disappears.
  React.useEffect(() => {
    if (!editPopover) return;
    const items = filePath ? byFile[filePath] ?? [] : [];
    const fresh = items.find((h) => h.id === editPopover.highlight.id);
    if (!fresh) {
      setEditPopover(null);
      return;
    }
    if (fresh !== editPopover.highlight) {
      setEditPopover({ ...editPopover, highlight: fresh });
    }
  }, [byFile, filePath, editPopover]);

  // Visually mark the highlight currently being edited.
  React.useEffect(() => {
    const root = ref.current;
    if (!root) return;
    setEditActive(root as HTMLElement, editPopover?.highlight.id ?? null);
  }, [editPopover?.highlight.id, renderState.key]);

  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !filePath) return;
    const saved = scrollMemory.get(filePath) ?? 0;
    el.scrollTop = saved;
    const onScroll = () => scrollMemory.set(filePath, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [filePath, html]);

  // Delete / Backspace deletes the highlight at the current selection or
  // the edit popover's target. Ignored when focus is in a form field.
  // Undo is offered in the Highlights panel (marque's toasts carry no
  // actions).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const target = e.target as HTMLElement | null;
      if (target && /input|textarea|select/i.test(target.tagName)) return;
      const root = ref.current as HTMLElement | null;
      if (!root || !filePath) return;

      // Prefer the edit popover's target if open.
      let id: string | null = editPopover?.highlight.id ?? null;
      if (!id) {
        const sel = window.getSelection();
        const node = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).startContainer : null;
        if (node && root.contains(node)) {
          id = highlightIdAt(node, root);
        }
      }
      if (!id) return;
      const highlight = fileHighlights.find((h) => h.id === id);
      if (!highlight) return;
      e.preventDefault();
      removeHighlight(filePath, id);
      setEditPopover(null);
      notifyApp("Highlight deleted — undo in the Highlights panel");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editPopover, fileHighlights, filePath, removeHighlight]);

  // Cycle the active colour with ] / [ at any time (no popover required).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && /input|textarea|select/i.test(target.tagName)) return;
      if (e.key !== "]" && e.key !== "[") return;
      const idx = HIGHLIGHT_COLOURS.indexOf(activeColour);
      const next =
        e.key === "]"
          ? HIGHLIGHT_COLOURS[(idx + 1) % HIGHLIGHT_COLOURS.length]
          : HIGHLIGHT_COLOURS[(idx - 1 + HIGHLIGHT_COLOURS.length) % HIGHLIGHT_COLOURS.length];
      e.preventDefault();
      setActiveColour(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeColour, setActiveColour]);

  const onApply = React.useCallback(
    (colour: HighlightColour, note?: string) => {
      const pending = pendingSelection.current;
      if (!pending || !filePath) return;
      const now = new Date().toISOString();
      addHighlight(filePath, {
        id: newHighlightId(),
        colour,
        anchor: pending.anchor,
        note,
        createdAt: now,
        updatedAt: now,
      });
      setPopover(null);
      pendingSelection.current = null;
      window.getSelection()?.removeAllRanges();
    },
    [addHighlight, filePath],
  );

  const onCopyForAgent = React.useCallback(async (): Promise<boolean> => {
    const pending = pendingSelection.current;
    const root = ref.current;
    if (!pending || !root || !filePath) return false;
    const now = new Date().toISOString();
    const provisional: Highlight = {
      id: "preview",
      colour: activeColour,
      anchor: pending.anchor,
      createdAt: now,
      updatedAt: now,
    };
    const text = formatExportItem({
      highlight: provisional,
      passage: pending.passage || null,
      section: sectionHeadingForRange(
        root as HTMLElement,
        pending.anchor.startLine,
        pending.anchor.endLine,
      ),
      lineRange: [pending.anchor.startLine, pending.anchor.endLine],
    });
    return copyText(text, "Copied passage as an agent-ready block");
  }, [activeColour, filePath]);

  const onDismissPopover = React.useCallback(() => {
    setPopover(null);
    pendingSelection.current = null;
  }, []);

  const onRecolour = React.useCallback(
    (id: string, colour: HighlightColour) => {
      if (filePath) updateHighlight(filePath, id, { colour });
    },
    [filePath, updateHighlight],
  );

  const onUpdateNote = React.useCallback(
    (id: string, note: string | undefined) => {
      if (filePath) updateHighlight(filePath, id, { note });
    },
    [filePath, updateHighlight],
  );

  const onCopyExisting = React.useCallback(async (h: Highlight): Promise<boolean> => {
    const entry = lastEntriesRef.current.find((e) => e.highlight.id === h.id);
    if (entry) {
      // F8: the exported block uses the *resolved* position and passage
      // the panel shows (post-relocation lines, normalized window), never
      // the stale stored anchor.
      const text = formatExportItem({
        highlight: h,
        passage: entry.passage,
        section: entry.section,
        lineRange: entry.lineRange,
      });
      return copyText(text, "Copied highlight");
    }
    // Fallback: no published projection yet (document still loading) —
    // derive from the live DOM.
    const root = ref.current;
    if (!root) return false;
    const text = formatExportItem({
      highlight: h,
      // Read from the live DOM; null (orphaned) renders as an explicit marker.
      passage: passageText(root as HTMLElement, h.id),
      section: sectionHeadingForRange(
        root as HTMLElement,
        h.anchor.startLine,
        h.anchor.endLine,
      ),
      lineRange: [h.anchor.startLine, h.anchor.endLine],
    });
    return copyText(text, "Copied highlight");
  }, []);

  const onDeleteExisting = React.useCallback(
    (id: string) => {
      if (!filePath) return;
      const highlight = fileHighlights.find((h) => h.id === id);
      if (!highlight) return;
      removeHighlight(filePath, id);
      setEditPopover(null);
      notifyApp("Highlight deleted — undo in the Highlights panel");
    },
    [fileHighlights, filePath, removeHighlight],
  );

  const onDismissEdit = React.useCallback(() => setEditPopover(null), []);

  // The Highlights panel jumps to a highlight by dispatching this custom
  // event on the active pane's article (see App); each Viewer listens on
  // its own article, so in a split every pane answers for its own document.
  React.useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onJump = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id === "string") {
        scrollHighlightIntoView(root as HTMLElement, id);
      }
    };
    root.addEventListener("marque:scroll-to-highlight", onJump as EventListener);
    return () => root.removeEventListener("marque:scroll-to-highlight", onJump as EventListener);
    // The article remounts when renderState.key changes (theme/cache flip),
    // so the listener must re-attach to the replacement node.
  }, [renderState.key]);

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
    // renderState.key: the article remounts when the key changes, so the
    // listener must re-attach to the replacement node.
  }, [source, copyAsMarkdown, renderState.key]);

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
    // renderState.key: the article remounts when the key changes, so the
    // listener must re-attach to the replacement node.
  }, [filePath, onOpenLink, ref, scrollToAnchor, renderState.key]);

  // Memoize the inner-html object so its reference is stable across renders.
  // If we passed a fresh { __html: html } object every render, React would
  // re-apply innerHTML on every re-render (e.g. when the parent Pane bumps
  // contentNonce after highlighting finishes), wiping the shiki spans we just
  // injected and restoring the raw markdown-it pre.
  const dangerousHtml = React.useMemo(() => ({ __html: html }), [html]);

  return (
    <div ref={scrollerRef} className="viewer-scroll h-full w-full overflow-auto">
      {/* Keyed by cache key: renderMarkdown() yields the same string for both
          themes, so without a remount React would skip re-applying innerHTML
          after a theme flip and leave the previous theme's Shiki markup in the
          DOM (and cache it under the new theme's key). */}
      <article
        key={renderState.key}
        ref={ref}
        tabIndex={-1}
        className={`markdown-body markdown-width-${contentWidth}`}
        dangerouslySetInnerHTML={dangerousHtml}
      />
      <HighlightPopover
        state={popover}
        activeColour={activeColour}
        articleRef={ref}
        onApply={onApply}
        onCopyForAgent={onCopyForAgent}
        onDismiss={onDismissPopover}
      />
      <HighlightEditPopover
        state={editPopover}
        articleRef={ref}
        onRecolour={onRecolour}
        onUpdateNote={onUpdateNote}
        onCopy={onCopyExisting}
        onDelete={onDeleteExisting}
        onDismiss={onDismissEdit}
      />
    </div>
  );
});
