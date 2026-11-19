import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

export const vendor = resolve('calendar/vendor/looseleaf')
const require = createRequire(import.meta.url)
export const bundleCalendar = (root = vendor) => build({
  entryPoints: ['calendar/task-date-picker.jsx'], bundle: true, platform: 'browser', format: 'cjs',
  write: false, minify: true, metafile: true, target: 'es2020', jsx: 'transform', loader: { '.css': 'text' },
  nodePaths: [resolve('node_modules')], external: ['react', 'react-dom'], define: { 'process.env.NODE_ENV': '"production"' },
  alias: { ...Object.fromEntries(['components/ui/button', 'components/ui/icon', 'components/ui/input', 'components/ui/paper', 'components/ui/popover', 'lib/utils']
    .map(name => ['@/' + name, resolve('calendar/primitives.jsx')])),
    '@/lib/ink/react': resolve('calendar/ink-hooks.js'), '@/lib/ink/react/hooks': resolve(root, 'lib/ink/react/hooks.ts'),
    '@/lib/ink/react/cache': resolve(root, 'lib/ink/react/cache.ts'), '@/lib/ink/react/svg': resolve(root, 'lib/ink/react/svg.tsx'),
    '@/lib/ink/react/defs': resolve(root, 'lib/ink/react/defs.tsx'), '@/lib/ink/recipes/calendar-ink': resolve('calendar/calendar-ink.js'),
    '@looseleaf': root, '@': root, 'react/jsx-runtime': require.resolve('react/jsx-runtime') },
})
