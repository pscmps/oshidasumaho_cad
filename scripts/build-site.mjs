// Keep the GitHub Pages build static; only a private Site needs this small Worker.
import { build } from 'vite';
import { writeFile, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await build({ base: '/', build: { outDir: 'dist/client', emptyOutDir: true } });
await build({ configFile: false, ssr: { noExternal: true }, build: { ssr: 'src/site-worker.js', outDir: 'dist/server', emptyOutDir: true, rolldownOptions: { output: { entryFileNames: 'index.js' } } } });
await writeFile('dist/server/wrangler.json', JSON.stringify({ name: 'oshida-ai-native-lab', main: 'index.js', compatibility_date: '2026-09-01', assets: { directory: '../client', binding: 'ASSETS', not_found_handling: 'single-page-application' } }, null, 2));
