import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vitest/config'

/**
 * Load `.yaml` as a default-exported string, matching the esbuild
 * `loader: { '.yaml': 'text' }` used for the production bundle (the extension
 * imports its manifest as raw text). Vitest/vite has no built-in text loader.
 */
function yamlText(): Plugin {
  return {
    name: 'yaml-text',
    transform(_code, id) {
      if (!id.endsWith('.yaml') && !id.endsWith('.yml')) return null
      return {
        code: `export default ${JSON.stringify(readFileSync(id, 'utf8'))}`,
        map: null,
      }
    },
  }
}

export default defineConfig({
  plugins: [yamlText()],
  test: {
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
  },
})
