import commonjs from '@rollup/plugin-commonjs';
import nodeResolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';

function copyNativeModules(destDir) {
  return {
    name: 'copy-native-modules',
    writeBundle() {
      const ddcNodeDir = path.join(destDir, 'node_modules', '@ddc-node');

      // Create directories if they don't exist
      fs.mkdirSync(ddcNodeDir, { recursive: true });

      // Copy ddc-node and platform-specific bindings
      const sourceDir = path.join('node_modules', '@ddc-node');
      const items = fs.readdirSync(sourceDir);

      for (const item of items) {
        const srcPath = path.join(sourceDir, item);
        const destPath = path.join(ddcNodeDir, item);

        try {
          // Remove existing destination if it exists
          if (fs.existsSync(destPath)) {
            fs.rmSync(destPath, { recursive: true, force: true });
          }

          // Copy directory recursively
          fs.cpSync(srcPath, destPath, { recursive: true });
        } catch (err) {
          // If files are locked (e.g., by running plugin), skip
          if (err.code === 'EPERM' || err.code === 'EBUSY') {
            console.log(`Skipping locked files in ${item} (plugin may be running)`);
            continue;
          }
          throw err;
        }
      }

      console.log(`Copied @ddc-node native modules to ${ddcNodeDir}`);
    },
  };
}

function copyUiAssets(sdPlugin) {
  return {
    name: 'copy-ui-assets',
    writeBundle() {
      const destDir = path.join(sdPlugin, 'ui');

      // Copy HTML
      const dialHtmlSrc = 'src/ui/brightness-dial-pi.html';
      const dialHtmlDest = path.join(destDir, 'brightness-dial-pi.html');
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(dialHtmlSrc, dialHtmlDest);

      const buttonHtmlSrc = 'src/ui/brightness-button-pi.html';
      const buttonHtmlDest = path.join(destDir, 'brightness-button-pi.html');
      fs.copyFileSync(buttonHtmlSrc, buttonHtmlDest);

      // Copy component CSS
      const dialCssSrc = 'src/ui/brightness-dial-pi.css';
      const dialCssDest = path.join(destDir, 'brightness-dial-pi.css');
      fs.copyFileSync(dialCssSrc, dialCssDest);

      const buttonCssSrc = 'src/ui/brightness-button-pi.css';
      const buttonCssDest = path.join(destDir, 'brightness-button-pi.css');
      fs.copyFileSync(buttonCssSrc, buttonCssDest);

      // Copy shared CSS
      const sharedCssSrc = 'src/ui/shared-pi.css';
      const sharedCssDest = path.join(destDir, 'shared-pi.css');
      fs.copyFileSync(sharedCssSrc, sharedCssDest);

      // Copy Stream Deck PI CSS
      const sdpiCssSrc = 'src/ui/sdpi.css';
      const sdpiCssDest = path.join(destDir, 'sdpi.css');
      fs.copyFileSync(sdpiCssSrc, sdpiCssDest);

      console.log('Copied UI assets');
    },
  };
}

function copyStaticAssets(sdPlugin) {
  return {
    name: 'copy-static-assets',
    writeBundle() {
      // Copy manifest
      const manifestSrc = 'assets/manifest.json';
      const manifestDest = path.join(sdPlugin, 'manifest.json');
      fs.copyFileSync(manifestSrc, manifestDest);

      // Copy images
      const imgsSrc = 'assets/imgs';
      const imgsDest = path.join(sdPlugin, 'imgs');
      fs.cpSync(imgsSrc, imgsDest, { recursive: true });

      console.log('Copied static assets (manifest, images)');
    },
  };
}

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = 'dist/com.raphiiko.sdbrightness.sdPlugin';

/**
 * @type {import('rollup').RollupOptions[]}
 */
const configs = [
  // Main plugin
  {
    input: 'src/plugin.ts',
    external: ['@ddc-node/ddc-node', '@ddc-node/ddc-node-*'],
    output: {
      file: `${sdPlugin}/bin/plugin.js`,
      sourcemap: isWatching,
      sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
        return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath))
          .href;
      },
    },
    plugins: [
      {
        name: 'watch-externals',
        buildStart: function () {
          this.addWatchFile('assets/manifest.json');
        },
      },
      typescript({
        mapRoot: isWatching ? './' : undefined,
      }),
      nodeResolve({
        browser: false,
        exportConditions: ['node'],
        preferBuiltins: true,
      }),
      commonjs(),
      !isWatching && terser(),
      {
        name: 'emit-module-package-file',
        generateBundle() {
          this.emitFile({
            fileName: 'package.json',
            source: `{ "type": "module" }`,
            type: 'asset',
          });
        },
      },
      copyNativeModules(sdPlugin),
      copyStaticAssets(sdPlugin),
    ],
  },
  // UI property inspector for dial action
  {
    input: 'src/ui/brightness-dial-pi.ts',
    output: {
      file: `${sdPlugin}/ui/brightness-dial-pi.js`,
      format: 'iife',
      sourcemap: isWatching,
    },
    plugins: [
      typescript({
        tsconfig: './tsconfig.ui.json',
      }),
      nodeResolve({
        browser: true,
      }),
      commonjs(),
      !isWatching && terser(),
      copyUiAssets(sdPlugin),
    ],
  },
  // UI property inspector for button action
  {
    input: 'src/ui/brightness-button-pi.ts',
    output: {
      file: `${sdPlugin}/ui/brightness-button-pi.js`,
      format: 'iife',
      sourcemap: isWatching,
    },
    plugins: [
      typescript({
        tsconfig: './tsconfig.ui.json',
      }),
      nodeResolve({
        browser: true,
      }),
      commonjs(),
      !isWatching && terser(),
      copyUiAssets(sdPlugin),
    ],
  },
];

export default configs;
