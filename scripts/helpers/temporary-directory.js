'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Keep fixtures outside the checkout, and only remove directories this helper
// created in the current process. Production data and backup paths cannot enter
// this cleanup path.
const ownedDirectories = new Set();

function createTemporaryDirectory(label) {
  if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('Invalid temporary directory label');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `chill-thrill-${label}-`));
  ownedDirectories.add(path.resolve(directory));
  return directory;
}

function removeTemporaryDirectory(directory) {
  const resolved = path.resolve(directory);
  if (!ownedDirectories.has(resolved) || path.dirname(resolved) !== path.resolve(os.tmpdir())) {
    throw new Error('Refusing to remove an unowned temporary directory');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  ownedDirectories.delete(resolved);
}

module.exports = { createTemporaryDirectory, removeTemporaryDirectory };
