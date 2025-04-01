// 使用插件方式实现HTTPS
import basicSsl from '@vitejs/plugin-basic-ssl'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import DevTools from 'vite-plugin-vue-devtools'
import { VueMcp } from '../src'

export default defineConfig({
  server: {
    port: 3456,
  },
  plugins: [
    vue(),
    VueMcp({
      appendTo: 'src/main.ts',
    }),
    DevTools(),
    // 使用basicSsl插件自动生成并配置证书
    basicSsl(),
  ],
})
