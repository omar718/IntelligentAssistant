/// <reference types="node" />
//@ts-check

'use strict';

const path = require('path');
const webpack = require('webpack');

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  target: 'node', // VS Code extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/
	mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')

  entry: './src/extension.ts', // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
  output: {
    // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode', // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    axios: 'commonjs axios'
    // modules added here also need to be added in the .vscodeignore file
  },
  resolve: {
    // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
    ]
  },
  devtool: false,
  plugins: [
    new webpack.BannerPlugin({
      raw: true,
      footer: true,
      banner: '',
      test: /extension\.js$/,
      stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
    }),
    {
      apply(compiler) {
        compiler.hooks.compilation.tap('StripAxiosSourceMapCommentPlugin', (compilation) => {
          compilation.hooks.processAssets.tap(
            {
              name: 'StripAxiosSourceMapCommentPlugin',
              stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
            },
            (assets) => {
              const assetName = 'extension.js';
              const asset = assets[assetName];
              if (!asset) return;

              const source = asset.source().toString();
              const cleaned = source.replace(/\n\/\/# sourceMappingURL=axios\.cjs\.map\s*$/m, '');

              if (cleaned !== source) {
                compilation.updateAsset(assetName, new webpack.sources.RawSource(cleaned));
              }
            }
          );
        });
      },
    },
  ],
  infrastructureLogging: {
    level: "log", // enables logging required for problem matchers
  },
};
module.exports = [ extensionConfig ];