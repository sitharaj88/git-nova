const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const isWatch = process.argv.includes('--watch');
// Minify and drop sourcemaps for production packaging (smaller .vsix, faster startup).
const isProduction = process.argv.includes('--production') || process.env.NODE_ENV === 'production';

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
    logLevel: 'info',
    tsconfig: path.join(__dirname, 'tsconfig.json'),
  });

  if (isWatch) {
    await extensionContext.watch();
    console.log('Watching for changes...');
  } else {
    await extensionContext.rebuild();
    await extensionContext.dispose();
    console.log('Extension built successfully!');
  }
};

const buildWebview = async () => {
  console.log('Building webview...');

  const webviewOutDir = path.join(__dirname, 'out', 'webview');
  if (!fs.existsSync(webviewOutDir)) {
    fs.mkdirSync(webviewOutDir, { recursive: true });
  }

  const webviewContext = await esbuild.context({
    entryPoints: [path.join(__dirname, 'webviews', 'src', 'index.tsx')],
    bundle: true,
    outfile: path.join(__dirname, 'out', 'webview', 'index.js'),
    format: 'iife',
    target: 'es2020',
    sourcemap: !isProduction,
    minify: isProduction,
    logLevel: 'info',
    loader: {
      '.tsx': 'tsx',
      '.ts': 'ts',
    },
    jsx: 'automatic',
    inject: [path.join(__dirname, 'webviews', 'src', 'react-shim.js')],
  });

  if (isWatch) {
    await webviewContext.watch();
  } else {
    await webviewContext.rebuild();
    await webviewContext.dispose();
    console.log('Webview built successfully!');
  }
};

const buildAll = async () => {
  try {
    await Promise.all([buildExtension(), buildWebview()]);
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
};

buildAll();
