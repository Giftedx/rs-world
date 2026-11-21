const fs = require("fs");
const path = require("path");
const webpack = require("webpack");
const { when, whenDev, addBeforeLoader, loaderByName } = require("@craco/craco");

const ThreadsPlugin = require("threads-plugin");
const JsonMinimizerPlugin = require("json-minimizer-webpack-plugin");

const express = require("express");

function resolveCacheRev() {
    if (process.env.REACT_APP_CACHE_REV !== undefined) {
        return process.env.REACT_APP_CACHE_REV;
    }
    try {
        const cachesPath = path.join(__dirname, "caches", "caches.json");
        const list = JSON.parse(fs.readFileSync(cachesPath, "utf8"));
        if (
            Array.isArray(list) &&
            list.length > 0 &&
            list.every(
                (entry) =>
                    entry &&
                    entry.game !== "oldschool" &&
                    typeof entry.revision === "number" &&
                    entry.revision <= 474,
            )
        ) {
            return "289";
        }
    } catch {}
    return "all";
}

module.exports = {
    webpack: {
        configure: (webpackConfig) => {
            const glslLoader = {
                test: /\.(glsl|vs|fs)$/,
                loader: "ts-shader-loader",
            };

            // Kind of a hack to get the glsl loader to work
            // https://github.com/dilanx/craco/issues/486
            for (const rule of webpackConfig.module.rules) {
                if (rule.oneOf) {
                    rule.oneOf.unshift(glslLoader);
                    break;
                }
            }

            webpackConfig.module.rules.push({
                resourceQuery: /url/,
                type: "asset/resource",
            });
            webpackConfig.module.rules.push({
                resourceQuery: /source/,
                type: "asset/source",
            });

            // addBeforeLoader(webpackConfig, loaderByName('file-loader'), glslLoader);

            webpackConfig.resolve.fallback = {
                fs: false,
            };

            webpackConfig.resolve.extensions = [".web.js", ...webpackConfig.resolve.extensions];

            webpackConfig.optimization.minimizer.push(new JsonMinimizerPlugin());

            webpackConfig.plugins.push(
                new webpack.DefinePlugin({
                    "process.env.REACT_APP_CACHE_REV": JSON.stringify(resolveCacheRev()),
                }),
            );

            return webpackConfig;
        },
        plugins: [new ThreadsPlugin()],
    },
    devServer: {
        headers: {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
        },
        client: {
            overlay: {
                errors: true,
                warnings: false,
                runtimeErrors: (error) => {
                    if (error instanceof DOMException && error.name === "AbortError") {
                        return false;
                    }
                    return true;
                },
            },
        },
        setupMiddlewares: (middlewares, devServer) => {
            if (!devServer) {
                throw new Error("webpack-dev-server is not defined");
            }

            devServer.app.use("/caches", express.static("caches"));

            return middlewares;
        },
    },
};
