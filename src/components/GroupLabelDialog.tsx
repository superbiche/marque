import { useEffect, useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Set group" or "Rename group". */
  title: string;
  /** Prefill: the folder's current label, or the group's label for a rename. */
  initialLabel: string;
  /** Existing labels offered through a native datalist. */
  suggestions: string[];
  /** Called with the raw (untrimmed) typed value; the backend owns the trim/clear semantics. */
  onSubmit: (label: string) => void;
}

export function GroupLabelDialog({
  open,
  onOpenChange,
  title,
  initialLabel,
  suggestions,
  onSubmit,
}: Props) {
  const [value, setValue] = useState(initialLabel);

  useEffect(() => {
    if (open) setValue(initialLabel);
  }, [open, initialLabel]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            onOpenChange(false);
            onSubmit(value);
          }}
        >
          <Input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            list="group-label-suggestions"
            aria-label="Group label"
            placeholder="No group (repository grouping)"
          />
          <datalist id="group-label-suggestions">
            {suggestions.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
