import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineSplitter, parseLine } from '../src/stream.ts';

test('splitter returns whole lines and buffers the remainder', () => {
  const split = createLineSplitter();
  assert.deepEqual(split('{"a":1}\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(split('{"c":'), []);
  assert.deepEqual(split('3}\n'), ['{"c":3}']);
});

test('splitter ignores blank lines', () => {
  const split = createLineSplitter();
  assert.deepEqual(split('{"a":1}\n\n\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
});

test('parseLine returns a typed event', () => {
  const event = parseLine('{"type":"assistant","parent_tool_use_id":null}');
  assert.equal(event?.type, 'assistant');
  assert.equal(event?.parent_tool_use_id, null);
});

test('parseLine returns null for malformed JSON rather than throwing', () => {
  assert.equal(parseLine('{not json'), null);
});

test('parseLine returns null for JSON without a type field', () => {
  assert.equal(parseLine('{"hello":"world"}'), null);
});
