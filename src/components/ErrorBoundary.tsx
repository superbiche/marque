import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Marque render error", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
          <div className="max-w-md space-y-3 rounded-2xl border bg-card p-6 shadow-sm">
            <h1 className="text-lg font-semibold">Marque couldn’t render this view</h1>
            <p className="text-sm text-muted-foreground">Reload the app to try again.</p>
            <Button onClick={() => window.location.reload()}>Reload</Button>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}
