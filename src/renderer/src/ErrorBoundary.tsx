import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Top-level error boundary. Without this, an uncaught error in render or in a
 * useEffect propagates up to the React root and unmounts the entire app —
 * which is exactly how a broken preload or a missing dependency turns into a
 * mystifying black BrowserWindow.
 */
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the terminal via Electron's renderer console.
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="h-full w-full overflow-auto bg-bg text-fg p-6">
        <h1 className="text-lg font-semibold mb-2" style={{ color: 'var(--danger)' }}>
          Renderer crashed
        </h1>
        <p className="text-sm text-muted mb-3">
          An unrecoverable error occurred in the React tree. The full stack is below
          and also in DevTools.
        </p>
        <pre className="text-xs whitespace-pre-wrap bg-surface border border-border rounded-lg p-3 overflow-auto">
          {this.state.error.stack || `${this.state.error.name}: ${this.state.error.message}`}
        </pre>
        <button className="btn-accent mt-4" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    )
  }
}
