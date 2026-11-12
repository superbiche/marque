import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  HIGHLIGHT_COLOURS,
  MAX_NOTE_LENGTH,
  formatExportItem,
  formatExportList,
  type ExportItem,
  type HighlightColour,
  type PanelEntry,
} from "@/lib/highlights";
import { copyText } from "@/lib/clipboard";
import { Copy, Trash2, X, Pencil, Check, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LastDeleted } from "@/lib/highlightsStore";

const FLASH_MS = 1200;

interface CopyButtonProps {
  text: string;
  successMessage?: string;
  title: string;
  iconClassName?: string;
  className?: string;
  /** When true, render the "Copy" / "Copied" label inline next to the icon. */
  withLabel?: boolean;
  /** When true, the button is inert (nothing to copy) and dimmed. */
  disabled?: boolean;
}

/**
 * Small Copy button with an inline "Copied" flash plus a toast (via
 * copyText). Used at every Copy site in the panel so feedback is uniform.
 */
function CopyButton({
  text,
  successMessage = "Copied",
  title,
  iconClassName = "h-3 w-3",
  className,
  withLabel,
  disabled,
}: CopyButtonProps) {
  const [flashing, setFlashing] = React.useState(false);
  const timerRef = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        void (async () => {
          const ok = await copyText(text, successMessage);
          if (!ok) return;
          setFlashing(true);
          if (timerRef.current !== null) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            setFlashing(false);
          }, FLASH_MS);
        })();
      }}
      className={cn(
        "flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground",
        flashing && "text-emerald-600 dark:text-emerald-400 hover:text-emerald-600",
        disabled && "pointer-events-none opacity-40 hover:bg-transparent",
        className,
      )}
    >
      {flashing ? <Check className={iconClassName} /> : <Copy className={iconClassName} />}
      {withLabel && <span>{flashing ? "Copied" : "Copy"}</span>}
    </button>
  );
}

interface Props {
  /** The document the panel lists; undefined when no file-backed tab is active. */
  filePath: string | undefined;
  /**
   * This document's rows, published by the Viewer from the very highlight
   * resolution it applies — so the panel, the copy/export actions, and the
   * DOM wrap always agree. Never re-derived from the live DOM (that used to
   * race the wrapping effect and show fresh highlights orphaned or stale).
   */
  entries: PanelEntry[];
  activeColour: HighlightColour;
  onSetActive: (c: HighlightColour) => void;
  onClose: () => void;
  onJump: (id: string) => void;
  onRemove: (id: string) => void;
  onUpdateNote: (id: string, note: string | undefined) => void;
  /** The last deletion, when it belongs to this document and the undo window is open. */
  lastDeleted: LastDeleted | null;
  onUndo: () => void;
}

interface NoteEditorProps {
  initial: string;
  onCommit: (value: string | undefined) => void;
  onCancel: () => void;
}

function NoteEditor({ initial, onCommit, onCancel }: NoteEditorProps) {
  const [value, setValue] = React.useState(initial);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="mt-1 flex flex-col gap-1">
      <textarea
        ref={ref}
        value={value}
        // F6: clamp at the shared limit and say so — an over-limit note must
        // not be silently truncated on save, and the store refuses it anyway.
        onChange={(e) => setValue(e.target.value.slice(0, MAX_NOTE_LENGTH))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onCommit(value.trim() || undefined);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        rows={2}
        placeholder="Note…"
        className="rounded-sm border bg-background px-1.5 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
      />
      {value.length >= MAX_NOTE_LENGTH && (
        <div className="text-[10px] text-muted-foreground">
          Notes are limited to {MAX_NOTE_LENGTH} characters.
        </div>
      )}
      <div className="flex justify-end gap-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-sm px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Cancel (Esc)
        </button>
        <button
          type="button"
          onClick={() => onCommit(value.trim() || undefined)}
          className="rounded-sm px-1.5 py-0.5 text-[10px] text-foreground hover:bg-accent"
        >
          <Check className="mr-1 inline-block h-3 w-3" /> Save (⌘↵)
        </button>
      </div>
    </div>
  );
}

/**
 * Right-side review panel. Lists the active document's highlights grouped
 * by colour, with per-item passage and section label taken from the
 * published resolution (post-relocation line range and normalized window —
 * never re-read from the DOM, never stored). Per-item and per-group copy,
 * and note editing. Highlights whose passage can no longer be located in
 * the document form their own group and are never dropped automatically. A
 * colour-filter pill row sits in the header; clicking one filters to that
 * colour, clicking again clears.
 */
export function HighlightsPanel({
  filePath,
  entries,
  activeColour,
  onSetActive,
  onClose,
  onJump,
  onRemove,
  onUpdateNote,
  lastDeleted,
  onUndo,
}: Props) {
  const [filter, setFilter] = React.useState<HighlightColour | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);

  // The colour filter and any open note editor belong to the document they
  // were set on. Switching documents resets both (item 15): a filter that
  // happened to match the previous document would otherwise silently hide
  // this one's rows, and an editor would commit a note to a highlight in the
  // document we just left.
  React.useEffect(() => {
    setFilter(null);
    setEditingId(null);
  }, [filePath]);

  // Rows in document order, exactly as the Viewer's resolution published
  // them: `passage`/`section`/`lineRange` are the resolved values (orphan
  // rows keep their original stored line range and have no passage).
  const items = React.useMemo(
    () =>
      entries.map((e) => ({
        h: e.highlight,
        passage: e.passage,
        section: e.section,
        lineRange: e.lineRange,
        orphaned: e.orphaned,
      })),
    [entries],
  );

  const visible = React.useMemo(
    () => (filter ? items.filter((e) => e.h.colour === filter) : items),
    [filter, items],
  );

  const grouped = React.useMemo(() => {
    const out = new Map<HighlightColour, typeof items>();
    for (const c of HIGHLIGHT_COLOURS) out.set(c, []);
    for (const e of visible) {
      if (!e.orphaned) out.get(e.h.colour)?.push(e);
    }
    return out;
  }, [visible]);

  const orphans = React.useMemo(() => visible.filter((e) => e.orphaned), [visible]);

  const counts = React.useMemo(() => {
    const c = new Map<HighlightColour, number>();
    for (const colour of HIGHLIGHT_COLOURS) c.set(colour, 0);
    for (const e of items) c.set(e.h.colour, (c.get(e.h.colour) ?? 0) + 1);
    return c;
  }, [items]);

  const toExportItem = React.useCallback(
    (e: (typeof items)[number]): ExportItem => ({
      highlight: e.h,
      passage: e.passage,
      section: e.section,
      lineRange: e.lineRange,
    }),
    [],
  );

  // Aggregate text for the header Copy button: per-colour lists concatenated.
  const visibleText = React.useMemo(() => {
    if (!filePath || visible.length === 0) return "";
    if (filter) return formatExportList(filePath, visible.map(toExportItem));
    const parts = HIGHLIGHT_COLOURS.map((c) =>
      formatExportList(
        filePath,
        visible.filter((e) => e.h.colour === c).map(toExportItem),
      ),
    ).filter((s) => s.length > 0);
    return parts.join("\n");
  }, [filePath, visible, filter, toExportItem]);
  const visibleCopyMessage = filter
    ? `Copied ${filter} list (${visible.length})`
    : `Copied ${visible.length} highlights`;

  return (
    <aside
      aria-label="Highlights"
      className="print-hide flex h-full w-80 shrink-0 flex-col border-l bg-card/30"
    >
      <div className="flex h-9 items-center justify-between border-b px-2">
        <div className="text-xs font-medium text-foreground">Highlights</div>
        <div className="flex items-center gap-1">
          {HIGHLIGHT_COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Set active colour to ${c}`}
              onClick={() => onSetActive(c)}
              className={cn(
                "marque-highlight-swatch h-4 w-4 rounded-sm border border-border/60 transition",
                c === activeColour && "ring-2 ring-foreground/50",
              )}
              data-highlight-colour={c}
              title={`Active colour: ${c}`}
            />
          ))}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onClose}
            aria-label="Close highlights panel"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {/* Filter pills + Copy-visible action. */}
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5 text-[10px]">
        <button
          type="button"
          onClick={() => setFilter(null)}
          className={cn(
            "rounded-full border px-2 py-0.5",
            filter === null ? "bg-foreground text-background" : "hover:bg-accent",
          )}
        >
          All ({entries.length})
        </button>
        {HIGHLIGHT_COLOURS.map((c) => {
          const n = counts.get(c) ?? 0;
          if (n === 0) return null;
          const active = filter === c;
          return (
            <button
              key={c}
              type="button"
              onClick={() => setFilter(active ? null : c)}
              className={cn(
                "flex items-center gap-1 rounded-full border px-2 py-0.5",
                active ? "bg-foreground text-background" : "hover:bg-accent",
              )}
              title={`Filter to ${c}`}
            >
              <span
                className="marque-highlight-swatch h-2.5 w-2.5 rounded-sm"
                data-highlight-colour={c}
              />
              {n}
            </button>
          );
        })}
        {entries.length > 0 && (
          <CopyButton
            text={visibleText}
            successMessage={visibleCopyMessage}
            title={filter ? `Copy ${filter} list` : "Copy visible lists"}
            withLabel={false}
            className="ml-auto"
            // A colour filter can leave the visible list empty (notably after
            // a document switch the filter no longer matches); a disabled
            // Copy beats copying nothing (item 15).
            disabled={visible.length === 0}
          />
        )}
      </div>
      <div className="flex-1 overflow-auto p-2 text-xs">
        {/* Undo row: marque's toasts are message-only, so the undo for a
            deleted highlight lives here. */}
        {lastDeleted && lastDeleted.path === filePath && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-sm border border-border/60 bg-muted/50 px-2 py-1">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden
                className="marque-highlight-swatch h-2.5 w-2.5 rounded-sm"
                data-highlight-colour={lastDeleted.highlight.colour}
              />
              Deleted {lastDeleted.highlight.colour} highlight
            </span>
            <button
              type="button"
              onClick={onUndo}
              className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-foreground hover:bg-accent"
              title="Restore the deleted highlight"
            >
              <Undo2 className="h-3 w-3" /> Undo
            </button>
          </div>
        )}
        {!filePath ? (
          <div className="px-2 py-4 text-muted-foreground">
            No file open. Highlights are stored per document.
          </div>
        ) : entries.length === 0 ? (
          <div className="px-2 py-4 text-muted-foreground">
            Select text in the document to start highlighting. Press 1–5 to
            apply a colour, click Annotate to attach a note.
          </div>
        ) : (
          <>
            {HIGHLIGHT_COLOURS.map((colour) => {
              const items = grouped.get(colour) ?? [];
              if (items.length === 0) return null;
              return (
                <section key={colour} className="mb-3">
                  <header className="mb-1 flex items-center justify-between gap-2 px-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="marque-highlight-swatch h-3 w-3 rounded-sm border border-border/60"
                        data-highlight-colour={colour}
                      />
                      <span className="text-foreground">
                        {colour} ({items.length})
                      </span>
                    </div>
                    <CopyButton
                      text={formatExportList(filePath!, items.map(toExportItem))}
                      successMessage={`Copied ${colour} list (${items.length})`}
                      title="Copy this list as an agent-ready block"
                    />
                  </header>
                  <ul className="space-y-1">
                    {items.map((e) => {
                      const h = e.h;
                      const isEditing = editingId === h.id;
                      return (
                        <li key={h.id} className="group rounded-sm border bg-card/50 p-1.5">
                          <button
                            type="button"
                            onClick={() => onJump(h.id)}
                            className="block w-full text-left text-foreground"
                          >
                            <div className="line-clamp-3 italic">"{e.passage}"</div>
                            {e.section && (
                              <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                                {e.section}
                              </div>
                            )}
                          </button>
                          {isEditing ? (
                            <NoteEditor
                              initial={h.note ?? ""}
                              onCommit={(v) => {
                                onUpdateNote(h.id, v);
                                setEditingId(null);
                              }}
                              onCancel={() => setEditingId(null)}
                            />
                          ) : h.note ? (
                            <div className="mt-1 rounded-sm bg-muted/50 px-1.5 py-1 text-foreground">
                              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                Note
                              </span>
                              <div className="whitespace-pre-wrap">{h.note}</div>
                            </div>
                          ) : null}
                          <div className="mt-1 flex justify-end gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                            {!isEditing && (
                              <button
                                type="button"
                                onClick={() => setEditingId(h.id)}
                                className="rounded-sm px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                                title={h.note ? "Edit note" : "Add note"}
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                            )}
                            <CopyButton
                              text={formatExportItem(toExportItem(e))}
                              title="Copy item"
                            />
                            <button
                              type="button"
                              onClick={() => onRemove(h.id)}
                              className="rounded-sm px-1.5 py-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              title="Delete highlight"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
            {orphans.length > 0 && (
              <section className="mb-3">
                <header className="mb-1 flex items-center justify-between gap-2 px-1">
                  <div className="text-muted-foreground">
                    Not found in the current document ({orphans.length})
                  </div>
                </header>
                <ul className="space-y-1">
                  {orphans.map((e) => {
                    const h = e.h;
                    return (
                      <li
                        key={h.id}
                        className="group rounded-sm border border-dashed bg-card/50 p-1.5"
                      >
                        <div className="flex items-center gap-1.5">
                          <span
                            aria-hidden
                            className="marque-highlight-swatch h-2.5 w-2.5 rounded-sm border border-border/60"
                            data-highlight-colour={h.colour}
                          />
                          <span className="text-muted-foreground">
                            Originally lines {e.lineRange[0] + 1}–{e.lineRange[1]}
                          </span>
                        </div>
                        {h.note ? (
                          <div className="mt-1 rounded-sm bg-muted/50 px-1.5 py-1 text-foreground">
                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                              Note
                            </span>
                            <div className="whitespace-pre-wrap">{h.note}</div>
                          </div>
                        ) : null}
                        <div className="mt-1 flex justify-end gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                          <CopyButton
                            text={formatExportItem(toExportItem(e))}
                            title="Copy item"
                          />
                          <button
                            type="button"
                            onClick={() => onRemove(h.id)}
                            className="rounded-sm px-1.5 py-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            title="Delete highlight"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
