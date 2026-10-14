'use strict';
// Unit tests: no Electron needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { parseArgs, validateParsed, sanitizeBase, utcStamp } = require('../bin/htmlshot.js');
const { EXIT, LIMITS, DEFAULTS } = require('../src/constants');

function parseOk(argv) {
  const p = parseArgs(argv);
  validateParsed(p);
  return p;
}

test('exit codes match spec', () => {
  assert.equal(EXIT.SUCCESS, 0);
  assert.equal(EXIT.INTERNAL, 1);
  assert.equal(EXIT.USAGE, 2);
  assert.equal(EXIT.INPUT, 3);
  assert.equal(EXIT.OUTPUT, 4);
  assert.equal(EXIT.RENDER, 5);
  assert.equal(EXIT.ENV, 6);
});

test('sanitizeBase', () => {
  assert.equal(sanitizeBase('/tmp/report.html'), 'report');
  assert.equal(sanitizeBase('/a/b/my page#1.html'), 'my_page_1');
  assert.equal(sanitizeBase('/x/.html'), 'shot');
  assert.equal(sanitizeBase('/x/a/b/c'), 'c');
  assert.match(sanitizeBase('/tmp/a b/c$d.e-f_g.html'), /^[A-Za-z0-9._-]+$/);
  const long = 'a'.repeat(100) + '.html';
  assert.equal(sanitizeBase('/tmp/' + long).length, 64);
  // preserves allowed chars
  assert.equal(sanitizeBase('/tmp/Aa0._-x.html'), 'Aa0._-x');
});

test('valid args pass', () => {
  assert.equal(parseOk(['f.html']).positionals[0], 'f.html');
  assert.equal(parseOk(['--delay', '0.5', 'f.html']).delay, '0.5');
  assert.equal(parseOk(['-d', '0', 'f.html']).delay, '0');
  assert.equal(parseOk(['--delay=3.25', 'f.html']).delay, '3.25');
  assert.equal(parseOk(['-W', '1920', 'f.html']).width, '1920');
  assert.equal(parseOk(['--width=100', '--height=100', 'f.html']).width, '100');
});

test('invalid args throw', () => {
  const bad = [
    ['--delay', '-1', 'f.html'],
    ['--delay', '601', 'f.html'],
    ['--delay', 'abc', 'f.html'],
    ['--width', '0', 'f.html'],
    ['--width', '7681', 'f.html'],
    ['--width', '1.5', 'f.html'],
    ['--width', '0x500', 'f.html'],
    ['--height', '4321', 'f.html'],
    ['--height', '-1', 'f.html'],
    ['--foo', 'f.html'],
    ['-Z', 'f.html'],
    ['a.html', 'b.html'],
    [],
    ['--delay'],
    ['-d5', 'f.html'],
  ];
  for (const argv of bad) {
    assert.throws(() => { const p = parseArgs(argv); validateParsed(p); }, /invalid argument/, `argv ${JSON.stringify(argv)} should fail`);
  }
});

test('http(s) URLs are usage errors', () => {
  for (const u of ['http://example.com/x.html', 'https://example.com/x.html', 'HTTP://x/y']) {
    assert.throws(() => parseOk([u]), /http\(s\)/i);
  }
});

test('utc stamp format', () => {
  assert.match(utcStamp(new Date('2026-10-13T14:25:01.123Z')), /^\d{8}T\d{6}Z$/);
  assert.equal(utcStamp(new Date('2026-10-13T14:25:01.123Z')), '20261013T142501Z');
});

test('file URL round-trips spaces and #', () => {
  const p = '/tmp/my page #1.html';
  const url = pathToFileURL(p).href;
  assert.ok(url.startsWith('file://'));
  assert.ok(url.includes('%20'));
  assert.ok(url.includes('%23'));
});
