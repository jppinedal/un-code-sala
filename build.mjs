import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: { room: 'client/room.js', landing: 'client/landing.js' },
  bundle: true,
  format: 'esm',
  splitting: true, // cada lenguaje se descarga solo cuando se usa
  outdir: 'dist',
  chunkNames: 'chunks/[name]-[hash]',
  target: 'es2020',
  minify: !watch,
  sourcemap: watch,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
