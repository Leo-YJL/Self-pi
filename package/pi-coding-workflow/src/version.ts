import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { name: string; version: string };

export const PACKAGE_NAME = "pi-coding-workflow";
export const NPM_PACKAGE_NAME = packageJson.name;
export const PACKAGE_VERSION = packageJson.version;
