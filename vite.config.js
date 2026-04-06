import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'frontend',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
      '/state': 'http://localhost:3001',
      '/trades': 'http://localhost:3001',
      '/optimize': 'http://localhost:3001',
      '/optimizer': 'http://localhost:3001',
    },
  },
});
