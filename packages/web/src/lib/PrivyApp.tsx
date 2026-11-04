import { Component, Suspense, lazy, type ReactNode } from "react";
import { PRIVY_APP_ID, PRIVY_PREVIEW } from "./config";
import { INACTIVE_PRIVY, PrivyCtx, type PrivyState } from "./privyState";

const Boundary = lazy(() => import("./PrivyBoundary"));

/** Inert Privy for screenshots (VITE_PRIVY_PREVIEW=1, no app id): shows the Privy sign-in UI, the buttons do nothing. */
const PREVIEW: PrivyState = { ...INACTIVE_PRIVY, enabled: true };

/** If Privy cannot start (a malformed VITE_PRIVY_APP_ID makes the SDK throw), fall back to wallet sign-in instead of a blank page. */
class Fallback extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(e: unknown) {
    console.error("[garuda] Privy failed to start, running on wallet sign-in only:", e instanceof Error ? e.message : e);
  }
  override render() {
    return this.state.failed ? <PrivyCtx.Provider value={INACTIVE_PRIVY}>{this.props.children}</PrivyCtx.Provider> : this.props.children;
  }
}

/** Wraps the app in Privy when VITE_PRIVY_APP_ID is set. Otherwise children render untouched on wallet sign-in only. */
export function PrivyApp({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID) return PRIVY_PREVIEW ? <PrivyCtx.Provider value={PREVIEW}>{children}</PrivyCtx.Provider> : <>{children}</>;
  return (
    <Fallback>
      <Suspense fallback={null}>
        <Boundary>{children}</Boundary>
      </Suspense>
    </Fallback>
  );
}
