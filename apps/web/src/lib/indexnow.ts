/**
 * IndexNow (#141) tells Bing and the other IndexNow engines which pages changed. The key only shows that
 * whoever submits controls this host, and every engine reads it from INDEXNOW_KEY_PATH, so it is public
 * by design and lives in the code, not in Secret Manager. To rotate it, change it here and redeploy.
 * Submitting is a manual step: scripts/indexnow-submit.mjs (docs/seo.md).
 */
export const INDEXNOW_KEY = "28a6ced329c3d4556e59c6097c1c8519";
export const INDEXNOW_KEY_PATH = "/indexnow-key.txt";
