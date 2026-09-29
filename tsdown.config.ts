import { defineConfig } from 'tsdown'

export default defineConfig(() => {
  return {
    workspace: ['vendor/*', 'packages/*/*', 'apps/cli'],
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: [],
  }
})
