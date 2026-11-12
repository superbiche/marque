import { notifyApp } from "@/components/Notifications";

/**
 * Write text to the system clipboard and report the result as a toast.
 * Resolves `true` on success. Shared by the highlight UI; marque's
 * `notifyApp` is message-only (no actions), so callers keep their own
 * inline "Copied" flash for immediate feedback.
 */
export async function copyText(text: string, successMessage: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    notifyApp(successMessage);
    return true;
  } catch (err) {
    console.error("failed to write to clipboard", err);
    notifyApp("Could not copy to the clipboard.");
    return false;
  }
}
