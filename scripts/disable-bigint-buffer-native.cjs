#!/usr/bin/env node

/**
 * bigint-buffer ships an optional native binding.
 * In this environment the native .node segfaults under Node, which breaks
 * @solana/spl-token -> @solana/buffer-layout-utils -> bigint-buffer.
 *
 * Workaround: delete/rename the native binding so bigint-buffer falls back to pure JS.
 */

const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const rel = "node_modules/bigint-buffer/build/Release/bigint_buffer.node";
const p = path.join(root, rel);

try {
  if (fs.existsSync(p)) {
    const bak = p + ".bak";
    // If already backed up, just remove the active file if it reappeared.
    try {
      fs.renameSync(p, bak);
      console.log(`[postinstall] Renamed native binding -> ${path.relative(root, bak)}`);
    } catch {
      try {
        fs.unlinkSync(p);
        console.log(`[postinstall] Deleted native binding -> ${path.relative(root, p)}`);
      } catch (e) {
        console.warn(`[postinstall] Failed to disable bigint-buffer native binding: ${e?.message || e}`);
      }
    }
  }
} catch (e) {
  console.warn(`[postinstall] bigint-buffer native binding check failed: ${e?.message || e}`);
}
