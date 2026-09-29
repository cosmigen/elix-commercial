import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

export default defineConfig({
  plugins: [
    standardDecoratorPlugin(),
    tsconfigPaths({ projects: ['./tsconfig.base.json'] }),
  ],
  test: {
    include: [
      'apps/cli/tests/**/*.spec.ts',
      'packages/*/*/tests/**/*.spec.ts',
      'vendor/*/tests/**/*.spec.ts',
    ],
    execArgv: vitestExecArgv,
  },
})
