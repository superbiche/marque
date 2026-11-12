import * as React from "react";
import { HIGHLIGHT_COLOURS, MAX_NOTE_LENGTH, type Highlight, type HighlightColour } from "@/lib/highlights";
import { Button } from "@/components/ui/button";
import { Trash2, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

const FLASH_MS = 1200;

/** True for an element the user can type into (a form field or a
 *  contenteditable region). */
function isEditableTarget(el: HTMLElement): boolean {
  const tag = el.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

export interface HighlightEditPopoverState {
  /** Viewport position of the bottom-centre of the highlight. */
  x: number;
  y: number;
  highlight: Highlight;
}

interface Props {
  state: HighlightEditPopoverState | null;
  /** The article to return focus to when the popover closes (a11y). */
  articleRef?: React.RefObject<HTMLElement | null>;
  onRecolour: (id: string, colour: HighlightColour) => void;
  onUpdateNote: (id: string, note: string | undefined) => void;
  /** Copy the agent-ready block for this highlight; resolves on success. */
  onCopy: (h: Highlight) => Promise<boolean>;
  onDelete: (id: string) => void;
  onDismiss: () => void;
}

/**
 * Popover anchored to an EXISTING highlight. Lets the user recolour, edit
 * the note inline, copy the agent-ready block, or delete. Dismisses on
 * outside click or Escape. Number keys 1–5 recolour. Delete/Backspace
 * removes the highlight.
 */
export function HighlightEditPopover({
  state,
  articleRef,
  onRecolour,
  onUpdateNote,
  onCopy,
  onDelete,
  onDismiss,
}: Props) {
  const ref = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const [editingNote, setEditingNote] = React.useState(false);
  const [draftNote, setDraftNote] = React.useState("");
  const [copyFlashing, setCopyFlashing] = React.useState(false);
  const copyTimerRef = React.useRef<number | null>(null);
  const [deleteFlashing, setDeleteFlashing] = React.useState(false);
  const deleteTimerRef = React.useRef<number | null>(null);

  React.useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      if (deleteTimerRef.current !== null) window.clearTimeout(deleteTimerRef.current);
    },
    [],
  );

  // Cancel a pending delayed delete. It captures the *old* highlight in its
  // closure, so it must not survive a close or a switch to a new target
  // (item 12): otherwise it would fire against a stale or gone highlight.
  const clearDeleteTimer = React.useCallback(() => {
    if (deleteTimerRef.current !== null) {
      window.clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = null;
    }
  }, []);

  // When a new highlight is targeted, reset edit state and seed the draft. A
  // close (state → null) or a new target both invalidate any pending delayed
  // delete.
  React.useEffect(() => {
    clearDeleteTimer();
    if (!state) {
      setEditingNote(false);
      setDraftNote("");
      return;
    }
    setEditingNote(false);
    setDraftNote(state.highlight.note ?? "");
  }, [state?.highlight.id, clearDeleteTimer]);

  React.useEffect(() => {
    if (editingNote) inputRef.current?.focus();
  }, [editingNote]);

  // Move focus into the popover on open and, on a close where focus has
  // "dropped" (to body), return it to the article. The popover is non-modal
  // (focus is never trapped) and we never steal a focus the user just placed
  // elsewhere by clicking out.
  const prevOpenRef = React.useRef(false);
  React.useEffect(() => {
    const open = state !== null;
    if (open) {
      ref.current?.focus();
      prevOpenRef.current = true;
    } else if (prevOpenRef.current) {
      prevOpenRef.current = false;
      const active = document.activeElement;
      const noRealFocus =
        active == null || active === document.body || active === document.documentElement;
      if (noRealFocus) articleRef?.current?.focus();
    }
  }, [state, articleRef]);

  React.useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      // A global window listener: don't steal a keystroke typed into an
      // editable control that lives *outside* this popover (the popover's own
      // note field is inside `ref`, so it is handled as before).
      const target = e.target as HTMLElement | null;
      if (target && !ref.current?.contains(target) && isEditableTarget(target)) return;
      if (editingNote) {
        // Editor swallows its own keys; only the surrounding popover handles
        // dismiss / commit on global Escape and Cmd+Enter.
        if (e.key === "Escape") {
          e.preventDefault();
          setEditingNote(false);
          setDraftNote(state.highlight.note ?? "");
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onUpdateNote(state.highlight.id, draftNote.trim() || undefined);
          setEditingNote(false);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        onDelete(state.highlight.id);
      } else if (e.key >= "1" && e.key <= "5") {
        const idx = parseInt(e.key, 10) - 1;
        const colour = HIGHLIGHT_COLOURS[idx];
        if (colour) {
          e.preventDefault();
          onRecolour(state.highlight.id, colour);
        }
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [state, editingNote, draftNote, onRecolour, onUpdateNote, onDelete, onDismiss]);

  if (!state) return null;
  const { highlight: h } = state;

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label="Edit highlight"
      className="fixed z-50 flex max-w-sm flex-col gap-2 rounded-md border bg-popover p-2 shadow-md"
      style={{
        left: state.x,
        top: state.y,
        transform: "translate(-50%, 8px)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1">
        {HIGHLIGHT_COLOURS.map((c, i) => (
          <button
            key={c}
            type="button"
            aria-label={`Recolour to ${c} (${i + 1})`}
            title={`${c} (${i + 1})`}
            onClick={() => onRecolour(h.id, c)}
            className={cn(
              "marque-highlight-swatch h-5 w-5 rounded-sm border border-border/60 transition",
              c === h.colour && "ring-2 ring-foreground/50",
            )}
            data-highlight-colour={c}
          />
        ))}
        <div className="mx-1 h-4 w-px bg-border" />
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            void (async () => {
              const ok = await onCopy(h);
              if (ok) {
                setCopyFlashing(true);
                if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
                copyTimerRef.current = window.setTimeout(() => {
                  copyTimerRef.current = null;
                  setCopyFlashing(false);
                }, FLASH_MS);
              }
            })();
          }}
          className={cn(copyFlashing && "text-emerald-600 dark:text-emerald-400")}
          title="Copy agent-ready block"
        >
          {copyFlashing ? (
            <>
              <Check className="size-3" /> Copied
            </>
          ) : (
            <>
              <Copy className="size-3" /> Copy
            </>
          )}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="xs"
          disabled={deleteFlashing}
          onClick={() => {
            // Show inline "Deleted" briefly, then call onDelete (which
            // dismisses the popover and triggers the toast).
            setDeleteFlashing(true);
            if (deleteTimerRef.current !== null) {
              window.clearTimeout(deleteTimerRef.current);
            }
            deleteTimerRef.current = window.setTimeout(() => {
              deleteTimerRef.current = null;
              onDelete(h.id);
            }, 450);
          }}
          className={cn(deleteFlashing && "text-emerald-600 dark:text-emerald-400")}
          title="Delete (Del / Backspace)"
        >
          {deleteFlashing ? (
            <>
              <Check className="size-3" /> Deleted
            </>
          ) : (
            <>
              <Trash2 className="size-3" /> Delete
            </>
          )}
        </Button>
      </div>
      {editingNote ? (
        <div className="flex flex-col gap-1">
          <textarea
            ref={inputRef}
            value={draftNote}
            // F6: clamp at the shared limit (the store refuses longer notes).
            onChange={(e) => setDraftNote(e.target.value.slice(0, MAX_NOTE_LENGTH))}
            placeholder="Note for this highlight…"
            rows={3}
            className="rounded-sm border bg-background px-1.5 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
          {draftNote.length >= MAX_NOTE_LENGTH && (
            <div className="text-[10px] text-muted-foreground">
              Notes are limited to {MAX_NOTE_LENGTH} characters.
            </div>
          )}
          <div className="flex justify-end gap-1 text-[10px]">
            <button
              type="button"
              onClick={() => {
                setEditingNote(false);
                setDraftNote(h.note ?? "");
              }}
              className="rounded-sm px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Cancel (Esc)
            </button>
            <button
              type="button"
              onClick={() => {
                onUpdateNote(h.id, draftNote.trim() || undefined);
                setEditingNote(false);
              }}
              className="rounded-sm px-1.5 py-0.5 text-foreground hover:bg-accent"
            >
              Save (⌘↵)
            </button>
          </div>
        </div>
      ) : h.note ? (
        <button
          type="button"
          onClick={() => {
            setDraftNote(h.note ?? "");
            setEditingNote(true);
          }}
          className="rounded-sm bg-muted/50 px-2 py-1 text-left text-xs hover:bg-muted"
          title="Edit note"
        >
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Note</div>
          <div className="whitespace-pre-wrap text-foreground">{h.note}</div>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraftNote("");
            setEditingNote(true);
          }}
          className="rounded-sm border border-dashed px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          + Add note
        </button>
      )}
    </div>
  );
}
