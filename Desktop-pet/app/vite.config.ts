import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import renderer from 'vite-plugin-electron-renderer';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'node:path';
import { existsSync, copyFileSync } from 'node:fs';

// 主进程 / 预加载 / 渲染进程 三合一打包
// 主进程 → dist-electron/main.js
// 预加载 → dist-electron/preload.js
// 渲染进程 → dist/index.html + assets
export default defineConfig({
  plugins: [
    react(),
    // 给渲染进程提供 Node 内置模块的浏览器版(pixi-live2d-display 内部用了 'url'、'buffer' 等)
    nodePolyfills({
      include: ['url', 'buffer', 'path', 'stream', 'util'],
      globals: { Buffer: true, global: true, process: true },
    }),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              // get-windows 是带 prebuilt native binding 的包,必须 external
              // 否则 vite 想 bundle 它的 .node 文件会失败 / 路径错乱
              //
              // ★ playwright-core 也必须 external(2026-10-31):
              //   它带一堆可选原生依赖(kerberos / socks-proxy 等),
              //   bundle 时 rollup 会去解析它们并报「failed to resolve」。
              //   playwright-core 本来就是运行时 require 的,不该进 bundle ——
              //   打包时由 electron-builder 把它整包带进 node_modules。
              external: ['electron', 'electron-store', 'get-windows', 'playwright-core'],
            },
          },
        },
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
              output: {
                // 强制 CommonJS 输出,文件扩展名为 .cjs。
                // 否则 vite-plugin-electron 在 "type":"module" 项目下默认输出 .mjs,
                // 但内容仍是 require() 风格,导致 Electron 的 ESM 加载器报错(require 未定义)。
                format: 'cjs',
                entryFileNames: '[name].cjs',
              },
            },
          },
        },
      },
      // 渲染进程允许 require Node 模块(我们仍走 contextBridge,但留余地)
      renderer: {},
    }),
    // 把运行时需要的 .mjs 脚本拷进 dist-electron。
    //
    // ★ 为什么需要:vite 只会 bundle 它「import 到」的文件。
    //   douyin-browser-worker.mjs 是被 spawn 出去的独立进程脚本 ——
    //   代码里只有路径字符串,没有 import 它,vite 根本不知道有它。
    //   不拷的话打包版起抖音会报「找不到 worker 脚本」。
    {
      name: 'copy-runtime-scripts',
      apply: 'build',
      closeBundle() {
        const src = path.resolve(__dirname, 'electron');
        const out = path.resolve(__dirname, 'dist-electron');
        for (const file of ['douyin-browser-worker.mjs']) {
          const from = path.join(src, file);
          if (!existsSync(from)) continue;
          copyFileSync(from, path.join(out, file));
        }
      },
    },
    renderer(),
  ],
  // 强制 dedupe:pixi.js 自身内部依赖的 @pixi/* 子包,与 lipsyncpatch 直接 import 的 @pixi/* 子包,
  // 必须解析到同一个实例,否则 Container 原型链不一致(isInteractive / null.height 等报错)。
  resolve: {
    dedupe: [
      'pixi.js',
      '@pixi/core',
      '@pixi/display',
      '@pixi/utils',
      '@pixi/math',
      '@pixi/ticker',
      '@pixi/constants',
      '@pixi/settings',
      '@pixi/extensions',
      '@pixi/runner',
      '@pixi/events',
    ],
  },
  optimizeDeps: {
    include: [
      'pixi.js',
      '@pixi/core',
      '@pixi/display',
      'pixi-live2d-display-lipsyncpatch',
      'pixi-live2d-display-lipsyncpatch/cubism4',
    ],
  },
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
