/**
 * @file registry.js
 * @description Phase 7: auto-discovers *.swing-setup.js files in this directory,
 *              validates each class, and exposes getAll() / getById().
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { BaseSwingSetup } = require('./base.swing-setup');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [SwingRegistry] [${level}] ${msg}`);
}

const _setups = [];

// Auto-discover setup files
const dir   = __dirname;
const files = fs.readdirSync(dir).filter(f =>
  f.endsWith('.swing-setup.js') && f !== 'base.swing-setup.js'
);

for (const file of files) {
  try {
    const Cls  = require(path.join(dir, file));
    const inst = new Cls();

    // Validate required interface
    if (!(inst instanceof BaseSwingSetup)) {
      log('WARN', `${file}: does not extend BaseSwingSetup — skipped`);
      continue;
    }
    if (typeof inst.id !== 'string' || !inst.id) {
      log('WARN', `${file}: missing id getter — skipped`);
      continue;
    }
    if (typeof inst.name !== 'string' || !inst.name) {
      log('WARN', `${file}: missing name getter — skipped`);
      continue;
    }
    if (typeof inst.evaluate !== 'function') {
      log('WARN', `${file}: missing evaluate() — skipped`);
      continue;
    }

    _setups.push(inst);
    log('INFO', `Registered: ${inst.name} (${inst.id})`);
  } catch (err) {
    log('ERROR', `Failed to load ${file}: ${err.message}`);
  }
}

log('INFO', `${_setups.length} swing setup(s) loaded`);

/**
 * Returns all registered setup instances.
 * @returns {BaseSwingSetup[]}
 */
function getAll() { return _setups.slice(); }

/**
 * Returns a setup by its id, or null.
 * @param {string} id
 * @returns {BaseSwingSetup|null}
 */
function getById(id) { return _setups.find(s => s.id === id) || null; }

module.exports = { getAll, getById, count: _setups.length };
