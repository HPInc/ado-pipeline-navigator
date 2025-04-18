const path = require('path');
const webpack = require('webpack');

module.exports = {
    target: 'node',
    entry: './extension.js',
    output: {
        path: path.resolve(__dirname, './'),
        filename: 'extension.js',
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
};
