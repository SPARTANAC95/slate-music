import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles.css';
import App from './App';
class Boundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="fatal">
        <h1>Something interrupted Slate Music.</h1>
        <p>Your saved library is safe. Close and reopen the app.</p>
        <pre>{this.state.error}</pre>
        <button onClick={() => location.reload()}>Reload interface</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById('root')!).render(
  <Boundary>
    <App />
  </Boundary>,
);
