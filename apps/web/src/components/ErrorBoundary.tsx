import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Button } from './ui';

interface State {
  error: Error | null;
}

/** Evita una pantalla en blanco si una vista lanza durante el render. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Error de render', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-xl p-6">
        <Alert
          title="Algo salió mal al mostrar esta pantalla"
          action={
            <Button variant="secondary" size="sm" onClick={() => this.setState({ error: null })}>
              Reintentar
            </Button>
          }
        >
          <p>Recarga la página o vuelve más tarde.</p>
        </Alert>
      </div>
    );
  }
}
