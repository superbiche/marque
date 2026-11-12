import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { PaneState, TabState } from "@/lib/workspace";
import { TabBar } from "@/components/TabBar";
import { Viewer } from "@/components/Viewer";
import { DocSearch } from "@/components/DocSearch";
import { cn } from "@/lib/utils";

interface Props {
  pane: PaneState;
  tabs: Record<string, TabState>;
  isFocused: boolean;
  onSelectTab: (paneId: string, tabId: string) => void;
  onCloseTab: (paneId: string, tabId: string) => void;
  onFocusPane: (paneId: string) => void;
  searchOpen: boolean;
  onSearchClose: () => void;
  onOpenLink: (path: string, fragment?: string) => void;
  fragment?: string;
  onFragmentHandled: () => void;
  onContentRendered?: (paneId: string) => void;
  /**
   * Report this pane's rendered article (or null when it has none) so the
   * app can target per-pane custom events such as the highlight jump.
   * Called after every render completion and when the active tab empties.
   */
  onArticleChange?: (paneId: string, el: HTMLElement | null) => void;
  onRevealFile: (filePath?: string) => void;
  onCopyContent: (source?: string) => void;
  onCopyPath: (filePath?: string) => void;
  pinnedPaths: ReadonlySet<string>;
  onPinFile: (path: string) => void;
  onUnpinFile: (path: string) => void;
}

export const Pane = memo(function Pane({
  pane,
  tabs,
  isFocused,
  onSelectTab,
  onCloseTab,
  onFocusPane,
  searchOpen,
  onSearchClose,
  onOpenLink,
  fragment,
  onFragmentHandled,
  onContentRendered,
  onArticleChange,
  onRevealFile,
  onCopyContent,
  onCopyPath,
  pinnedPaths,
  onPinFile,
  onUnpinFile,
}: Props) {
  const activeTab = pane.activeTabId ? tabs[pane.activeTabId] : undefined;
  const articleRef = useRef<HTMLElement>(null);
  const [contentNonce, setContentNonce] = useState(0);

  // Keep the callback fresh without making handleRendered re-create (same
  // reasoning as the Viewer's onRendered ref).
  const onArticleChangeRef = useRef(onArticleChange);
  useEffect(() => {
    onArticleChangeRef.current = onArticleChange;
  }, [onArticleChange]);

  const handleRendered = useCallback(() => {
    setContentNonce((nonce) => nonce + 1);
    onContentRendered?.(pane.id);
    // After every render completion (including theme flips that remount the
    // article) the registry sees this pane's current article node.
    onArticleChangeRef.current?.(pane.id, articleRef.current);
  }, [onContentRendered, pane.id]);

  // No active tab (or pane unmount): report null so the registry doesn't
  // keep pointing at a removed article.
  useEffect(() => {
    if (!activeTab) {
      onArticleChangeRef.current?.(pane.id, null);
      return;
    }
    return () => {
      onArticleChangeRef.current?.(pane.id, null);
    };
  }, [pane.id, activeTab]);

  return (
    <div
      onMouseDown={() => onFocusPane(pane.id)}
      className={cn(
        "pane-root relative flex min-h-0 min-w-0 flex-1 flex-col",
        isFocused ? "ring-1 ring-ring/30" : ""
      )}
    >
      <TabBar
        pane={pane}
        tabs={tabs}
        isFocused={isFocused}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onFocusPane={onFocusPane}
        onRevealFile={onRevealFile}
        onCopyContent={onCopyContent}
        onCopyPath={onCopyPath}
        pinnedPaths={pinnedPaths}
        onPinFile={onPinFile}
        onUnpinFile={onUnpinFile}
      />
      <div className="pane-content relative flex min-h-0 flex-1">
        {activeTab ? (
          <Viewer
            key={activeTab.id}
            source={activeTab.source}
            filePath={activeTab.filePath}
            articleRef={articleRef}
            onRendered={handleRendered}
            onOpenLink={onOpenLink}
            fragment={fragment}
            onFragmentHandled={onFragmentHandled}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Empty pane
          </div>
        )}
        <DocSearch
          open={searchOpen}
          onClose={onSearchClose}
          containerRef={articleRef}
          contentNonce={contentNonce}
        />
      </div>
    </div>
  );
});
