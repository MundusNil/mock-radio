import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    // 钉死 IPv4 环回：Vite 默认 host=localhost，Node 17+ verbatim DNS 按系统返回顺序绑定首个解析结果，
    // 部分机器 ::1 排前 → 只听 [::1]:9731，curl 等纯 IPv4 客户端拒连。不填 true，避免面板暴露到局域网。
    host: '127.0.0.1',
    port: 9731,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:9730',
      '/audio': 'http://localhost:9730',
      '/ws': { target: 'ws://localhost:9730', ws: true },
    },
  },
});
