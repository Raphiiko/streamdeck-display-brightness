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
      const ddcNodeDir = path.join(destDir, 'node_modules', '@raphiiko');

      // Create directories if they don't exist
      fs.mkdirSync(ddcNodeDir, { recursive: true });

      // Copy ddc-node from the forked package
      const sourceDir = path.join('node_modules', '@raphiiko', 'ddc-node');
      const destPath = path.join(ddcNodeDir, 'ddc-node');

      try {
        // Remove existing destination if it exists
        if (fs.existsSync(destPath)) {
          fs.rmSync(destPath, { recursive: true, force: true });
        }

        // Copy directory recursively
        fs.cpSync(sourceDir, destPath, { recursive: true });

        // Copy the native .node file from the @ddc-node package (which has prebuilt binaries)
        // The @raphiiko/ddc-node package looks for a local .node file first
        const nativeNodeFile = path.join(
          'node_modules',
          '@ddc-node',
          'ddc-node-win32-x64-msvc',
          'ddc-node.win32-x64-msvc.node'
        );
        const nativeNodeDest = path.join(destPath, 'ddc-node.win32-x64-msvc.node');

        if (fs.existsSync(nativeNodeFile)) {
          fs.copyFileSync(nativeNodeFile, nativeNodeDest);
          console.log(`Copied native .node file to ${nativeNodeDest}`);
        } else {
          // Try the dist folder location (might already be there from previous build)
          const distNativeFile = path.join(
            destDir,
            'node_modules',
            '@ddc-node',
            'ddc-node-win32-x64-msvc',
            'ddc-node.win32-x64-msvc.node'
          );
          if (fs.existsSync(distNativeFile)) {
            fs.copyFileSync(distNativeFile, nativeNodeDest);
            console.log(`Copied native .node file from dist to ${nativeNodeDest}`);
          } else {
            console.warn(
              `WARNING: Native .node file not found at ${nativeNodeFile} or ${distNativeFile}. ` +
                `Please run: npm install @ddc-node/ddc-node-win32-x64-msvc`
            );
          }
        }
      } catch (err) {
        // If files are locked (e.g., by running plugin), skip
        if (err.code === 'EPERM' || err.code === 'EBUSY') {
          console.log(`Skipping locked files in ddc-node (plugin may be running)`);
        } else {
          throw err;
        }
      }

      console.log(`Copied @raphiiko/ddc-node native modules to ${ddcNodeDir}`);

      // Copy koffi native module (only essential files for Windows)
      const koffiSrc = path.join('node_modules', 'koffi');
      const koffiDest = path.join(destDir, 'node_modules', 'koffi');

      try {
        if (fs.existsSync(koffiDest)) {
          fs.rmSync(koffiDest, { recursive: true, force: true });
        }

        // Create koffi directory structure
        fs.mkdirSync(koffiDest, { recursive: true });
        const koffiBuildDest = path.join(koffiDest, 'build', 'koffi', 'win32_x64');
        fs.mkdirSync(koffiBuildDest, { recursive: true });

        // Copy only essential files
        const essentialFiles = ['index.js', 'indirect.js', 'index.d.ts', 'package.json'];

        for (const file of essentialFiles) {
          fs.copyFileSync(path.join(koffiSrc, file), path.join(koffiDest, file));
        }

        // Copy only Windows x64 native module
        fs.copyFileSync(
          path.join(koffiSrc, 'build', 'koffi', 'win32_x64', 'koffi.node'),
          path.join(koffiBuildDest, 'koffi.node')
        );

        console.log(`Copied koffi essentials to ${koffiDest}`);
      } catch (err) {
        if (err.code === 'EPERM' || err.code === 'EBUSY') {
          console.log(`Skipping locked files in koffi (plugin may be running)`);
        } else {
          throw err;
        }
      }
    },
  };
}

function copyUiAssets(sdPlugin) {
  return {
    name: 'copy-ui-assets',
    writeBundle() {
      const destDir = path.join(sdPlugin, 'ui');
      fs.mkdirSync(destDir, { recursive: true });

      // Copy HTML files (no longer need string substitution, globals imported directly)
      const dialHtmlSrc = 'src/ui/brightness-dial-pi.html';
      const dialHtmlDest = path.join(destDir, 'brightness-dial-pi.html');
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
const sdPlugin = 'dist/co.raphii.streamdeck-display-brightness.sdPlugin';

/**
 * @type {import('rollup').RollupOptions[]}
 */
const configs = [
  // Main plugin
  {
    input: 'src/plugin.ts',
    external: ['@raphiiko/ddc-node', 'koffi'],
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
    input: 'src/ui/brightness-dial-pi.tsx',
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
        preferBuiltins: false,
      }),
      commonjs(),
      !isWatching && terser(),
      copyUiAssets(sdPlugin),
    ],
  },
  // UI property inspector for button action
  {
    input: 'src/ui/brightness-button-pi.tsx',
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
        preferBuiltins: false,
      }),
      commonjs(),
      !isWatching && terser(),
      copyUiAssets(sdPlugin),
    ],
  },
];

export default configs;
