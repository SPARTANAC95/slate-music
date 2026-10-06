import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  // Only the app is scanned for dependencies and watched for changes. The native build folder
  // holds tens of thousands of files that change with every compile; watching it makes the
  // dev server take most of a minute to answer.
  optimizeDeps: { entries: ['index.html'] },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/output/**', '**/site/**'] },
  },
  clearScreen: false,
});
