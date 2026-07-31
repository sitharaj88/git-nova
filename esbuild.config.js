const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const isWatch = process.argv.includes('--watch');
// Minify and drop sourcemaps for production packaging (smaller .vsix, faster startup).
const isProduction = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
// --analyze writes out/meta.json for bundle inspection (esbuild-visualizer etc.)
const isAnalyze = process.argv.includes('--analyze');

const buildExtension = async () => {
  console.log('Building extension...');

  // Clean output directory
  const outDir = path.join(__dirname, 'out');
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });

  // Build extension
  const extensionContext = await esbuild.context({
    entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
    bundle: true,
    outfile: path.join(__dirname, 'out', 'extension.js'),
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !isProduction,
    minify: isProduction,
    metafile: isAnalyze,
    logLevel: 'info',
    tsconfig: path.join(__dirname, 'tsconfig.json'),
    ...(isProduction
      ? {
          // Strip debugger statements and license banners from the shipped bundle
          drop: ['debugger'],
          legalComments: 'none',
        }
      : {}),
  });

  if (isWatch) {
    await extensionContext.watch();
    console.log('Watching for changes...');
  } else {
    const result = await extensionContext.rebuild();
    if (isAnalyze && result.metafile) {
      fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(result.metafile));
      console.log('Bundle metafile written to out/meta.json');
    }
    await extensionContext.dispose();
    console.log('Extension built successfully!');
  }
};

const buildAll = async () => {
  try {
    await buildExtension();
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
};

buildAll();
