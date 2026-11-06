import { CircleAlert } from "lucide-react";
import { Component, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface BoundaryState {
  failed: boolean;
}

// A rendering fault would otherwise leave a blank pane, which is hard to diagnose inside a chat host.
export class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error) {
    console.error("The setup view failed to render.", error);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Alert variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>The setup view hit an error</AlertTitle>
        <AlertDescription>Reload this view. The setup server keeps your progress, so restart setup only if the problem continues.</AlertDescription>
      </Alert>
    );
  }
}
