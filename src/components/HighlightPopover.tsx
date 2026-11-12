import * as React from "react";
import { HIGHLIGHT_COLOURS, MAX_NOTE_LENGTH, type HighlightColour } from "@/lib/highlights";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

const FLASH_MS = 1200;

/** True for an element the user can type into (a form field or a
 *  contenteditable region). */
function isEditableTarget(el: HTMLElement): boolean {
  const tag = el.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

export interface HighlightPopoverState {
  /** Viewport position of the bottom-centre of the selection. */
  x: number;
  y: number;
}

interface Props {
  state: HighlightPopoverState | null;
  activeColour: HighlightColour;
  /** The article to return focus to when the popover closes (a11y). */
  articleRef?: React.RefObject<HTMLElement | null>;
  /**
   * Apply a highlight in the given colour. If `note` is provided the
   * highlight is created with the annotation in one step.
   */
  onApply: (colour: HighlightColour, note?: string) => void;
  /** Copy the selected passage as an agent-ready block; resolves on success. */
  onCopyForAgent: () => Promise<boolean>;
  onDismiss: () => void;
}

/**
 * Floating popover anchored to the user's selection. Two modes:
 *   - Default: shows colour swatches, an Annotate button, and a Copy shortcut.
 *   - Annotate: swaps the row for an inline note input. Enter applies the
 *     highlight (in the active colour) with the note attached; Esc cancels.
 *
 * Number keys 1–5 apply that colour while the popover is open. Dismisses on
 * outside click or Escape.
 */
export function HighlightPopover({
  state,
  activeColour,
  articleRef,
  onApply,
  onCopyForAgent,
  onDismiss,
}: Props) {
  const ref = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [annotating, setAnnotating] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [copyFlashing, setCopyFlashing] = React.useState(false);
  const flashTimerRef = React.useRef<number | null>(null);

  const flashCopy = React.useCallback(() => {
    setCopyFlashing(true);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null;
      setCopyFlashing(false);
    }, FLASH_MS);
  }, []);

  React.useEffect(
    () => () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );

  // Reset annotate state whenever the popover closes or a new selection
  // produces a fresh one.
  React.useEffect(() => {
    if (!state) {
      setAnnotating(false);
      setNote("");
    }
  }, [state]);

  React.useEffect(() => {
    if (annotating) inputRef.current?.focus();
  }, [annotating]);

  // Move focus into the popover on open and, on a close where focus has
  // "dropped" (to body), return it to the article. The popover is non-modal —
  // focus is never trapped — and we never steal a focus the user just placed
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
      // input is inside `ref`, so it is handled as before).
      const target = e.target as HTMLElement | null;
      if (target && !ref.current?.contains(target) && isEditableTarget(target)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (annotating) {
          setAnnotating(false);
          setNote("");
        } else {
          onDismiss();
        }
      } else if (!annotating && e.key >= "1" && e.key <= "5") {
        const idx = parseInt(e.key, 10) - 1;
        const colour = HIGHLIGHT_COLOURS[idx];
        if (colour) {
          e.preventDefault();
          onApply(colour);
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
  }, [state, annotating, onApply, onDismiss]);

  if (!state) return null;

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="toolbar"
      aria-label="Highlight"
      className="fixed z-50 flex items-center gap-1 rounded-md border bg-popover p-1 shadow-md"
      style={{
        left: state.x,
        top: state.y,
        transform: "translate(-50%, 8px)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {!annotating ? (
        <>
          {HIGHLIGHT_COLOURS.map((c, i) => (
            <button
              key={c}
              type="button"
              aria-label={`Highlight ${c} (${i + 1})`}
              title={`${c} (${i + 1})`}
              onClick={() => onApply(c)}
              className={cn(
                "marque-highlight-swatch h-5 w-5 rounded-sm border border-border/60 transition",
                c === activeColour && "ring-2 ring-foreground/50",
              )}
              data-highlight-colour={c}
            />
          ))}
          <div className="mx-1 h-4 w-px bg-border" />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setAnnotating(true)}
            title="Highlight in active colour and attach a note"
          >
            Annotate
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              void (async () => {
                const ok = await onCopyForAgent();
                if (ok) flashCopy();
              })();
            }}
            className={cn(copyFlashing && "text-emerald-600 dark:text-emerald-400")}
            title="Copy this passage as an agent-ready block"
          >
            {copyFlashing ? (
              <>
                <Check className="size-3" /> Copied
              </>
            ) : (
              "Copy"
            )}
          </Button>
        </>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
          <span
            aria-hidden
            className="marque-highlight-swatch h-4 w-4 shrink-0 rounded-sm border border-border/60"
            data-highlight-colour={activeColour}
            title={`Will apply ${activeColour}`}
          />
          <input
            ref={inputRef}
            type="text"
            value={note}
            // F6: clamp at the shared limit (the store refuses longer notes).
            onChange={(e) => setNote(e.target.value.slice(0, MAX_NOTE_LENGTH))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onApply(activeColour, note.trim() || undefined);
              }
            }}
            placeholder="Note for this highlight…"
            className="h-6 w-56 rounded-sm border bg-background px-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onApply(activeColour, note.trim() || undefined)}
            title="Save annotation (Enter)"
          >
            Save
          </Button>
          </div>
          {note.length >= MAX_NOTE_LENGTH && (
            <div className="text-[10px] text-muted-foreground">
              Notes are limited to {MAX_NOTE_LENGTH} characters.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
