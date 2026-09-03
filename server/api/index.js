/**
 * Explicit Vercel Function.
 *
 * Zero-config Express detection was not firing on this project, and an
 * `api/` directory is recognised by the Node runtime regardless of framework
 * detection. vercel.json rewrites every path here.
 */
export { default } from '../index.js';
