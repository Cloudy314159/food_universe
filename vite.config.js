import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 技术路线见 TECH_DESIGN.md §3.1：
// React + Vite 打包成纯静态文件 → 无后端 → 数据存浏览器 localStorage → 部署到静态托管
export default defineConfig({
  plugins: [react()],

  /* 资源用**相对路径**（./assets/...），不用默认的绝对路径（/assets/...）。
     为什么：CloudBase 静态托管把站点放在**子路径**下（我们的地址是 .../chisha/），
     绝对路径会让浏览器去域名根目录找 /assets/... → 404 → 白屏。
     相对路径相对于当前页面解析，放根目录、放子路径都对。
     （Day 15 实测踩到：部署后页面 200 但 JS 404，就是这一条。） */
  base: './',

  server: {
    port: 5173,
    strictPort: true,

    /* ⚠️ 本地开发时的跨域问题（Day 20 加）

       背景：免费体验版**不让手动加安全域名** ——
       `tcb cors add localhost:5173` 报「当前套餐无法执行此操作」。
       所以本地 dev server 直接去调公网接口，会被浏览器跨域拦下。

       解法：**让 dev server 当中间人**（Vite 自带的 proxy）。
       浏览器只跟 localhost:5173 打交道（同源，压根不产生跨域），
       由 dev server 在**服务器侧**把 /api 转发到公网接口。
       —— 服务器和服务器之间没有"跨域"这回事，跨域是浏览器的规矩。

       ⚠️ 只在 `vite dev` 时生效，构建产物完全不受影响（生产仍直接调公网地址）。 */
    proxy: {
      '/api': {
        target: 'https://model-d5gisaem106ad6a18-1500042790.ap-shanghai.app.tcloudbase.com',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
})
