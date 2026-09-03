/**
 * The Vercel entry point, and the only one.
 *
 * An `api/` directory is picked up by Vercel's Node runtime without any
 * framework detection, and vercel.json rewrites every path here. An Express
 * app is (req, res)-compatible, so it works directly as the handler.
 *
 * There is deliberately no root-level index.js: with one present, framework
 * detection and this function are two competing entry points, and the build
 * can satisfy one while the rewrite targets the other.
 */
import { createApp } from '../create-app.js';

export default createApp();
