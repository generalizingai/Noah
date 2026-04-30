import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@assets': path.resolve(__dirname, '../../attached_assets'),
      },
    },
    base: process.env.BASE_PATH || './',
    define: {
      'import.meta.env.VITE_OPENAI_API_KEY': JSON.stringify(
        env.VITE_OPENAI_API_KEY || process.env.OPENAI_API_KEY || ''
      ),
      'import.meta.env.VITE_DEEPGRAM_API_KEY': JSON.stringify(
        env.VITE_DEEPGRAM_API_KEY || process.env.DEEPGRAM_API_KEY || ''
      ),
    },
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: { main: path.resolve(__dirname, 'index.html') },
      },
    },
    server: {
      port: parseInt(process.env.PORT || '3001'),
      host: '0.0.0.0',
      allowedHosts: true,
    },
  };
});
