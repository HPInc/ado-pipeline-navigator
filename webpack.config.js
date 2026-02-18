const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = (env, argv) => {
    const isProduction = argv.mode === 'production';

    return {
        target: 'node',
        mode: isProduction ? 'production' : 'development',
        entry: './extension.js',
        output: {
            path: path.resolve(__dirname),
            filename: 'extension-bundle.js',
            libraryTarget: 'commonjs2',
        },
        externals: {
            vscode: 'commonjs vscode',
        },
        resolve: {
            extensions: ['.js', '.mjs'],
            preferRelative: true,
            fallback: {
                fs: false,
            },
            modules: ['node_modules'],
        },
        optimization: {
            minimize: isProduction,
            minimizer: [
                new TerserPlugin({
                    terserOptions: {
                        compress: {
                            drop_console: false,
                            passes: 2,
                        },
                        mangle: true,
                        format: {
                            comments: false,
                        },
                    },
                    extractComments: false,
                }),
            ],
            usedExports: true,
            sideEffects: false,
        },
        performance: {
            hints: false,
        },
    };
};
