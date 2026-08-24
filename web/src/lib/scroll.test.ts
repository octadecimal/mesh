import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAtBottom } from './scroll.ts';

test('a box scrolled to its exact bottom is at the bottom', () => {
  assert.equal(isAtBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 600 }), true);
});

test('a box short enough not to scroll is at the bottom', () => {
  assert.equal(isAtBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 600 }), true);
});

test('a box within the slack of the bottom is still at the bottom', () => {
  assert.equal(isAtBottom({ scrollTop: 370, scrollHeight: 1000, clientHeight: 600 }), true);
});

test('a fractional scrollTop a browser rounds down is still at the bottom', () => {
  assert.equal(isAtBottom({ scrollTop: 399.5, scrollHeight: 1000, clientHeight: 600 }), true);
});

test('a box scrolled well up is not at the bottom', () => {
  assert.equal(isAtBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 600 }), false);
});

test('the slack is configurable', () => {
  assert.equal(isAtBottom({ scrollTop: 370, scrollHeight: 1000, clientHeight: 600 }, 8), false);
});
