import { build } from 'esbuild';
import { mkdir, copyFile, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative } from 'node:path';

const golf = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(golf, '../dist/golf');
const repository = resolve(golf, '..');
const output = resolve(repository, 'dist');
if (relative(repository, output) !== 'dist') throw new Error('Invalid build output path.');
await rm(output, { recursive: true, force: true });
await mkdir(join(golf, 'vendor'), { recursive: true });
const bundled = await build({ stdin: { contents: "export { createClient } from '@supabase/supabase-js';", resolveDir: golf },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  metafile: true, legalComments: 'linked', outfile: join(golf, 'vendor/supabase.js') });
const packages = new Set(Object.keys(bundled.metafile.inputs).map(path =>
  path.replaceAll('\\', '/').match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean));
const licenses = [];
for (const name of [...packages].sort()) {
  const path = join(golf, 'node_modules', name);
  const files = (await readdir(path)).filter(file => /^licen[sc]e(?:\.|$)/i.test(file));
  for (const file of files) licenses.push(`${name}\n${await readFile(join(path, file), 'utf8')}`);
}
await writeFile(join(golf, 'vendor/LICENSE.txt'), licenses.join('\n\n---\n\n'));

async function copyDirectory(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyDirectory(join(source, entry.name), join(target, entry.name));
    else await copyFile(join(source, entry.name), join(target, entry.name));
  }
}
await mkdir(destination, { recursive: true });
for (const name of ['index.html', 'styles.css', 'app.js', 'config.js', 'domain.js', 'database.js',
  'supabase-config.js', 'supabase-db.js', 'course-data.js']) await copyFile(join(golf, name), join(destination, name));
for (const name of ['assets', 'data', 'vendor']) await copyDirectory(join(golf, name), join(destination, name));
await writeFile(resolve(destination, '../.nojekyll'), '');
console.log('Built dist/golf/');
