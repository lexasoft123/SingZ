import { createHash } from 'node:crypto'
import { MAX_GRAPH_DOCUMENT_TEXT_BYTES } from '../src/gen/graph-document'
import { md5Text } from '../src/md5'

test.each([
  '',
  'a',
  'abc',
  'message digest',
  'SingZ 🎤 Привет',
  'x'.repeat(100_000),
  '\ud800',
  '\udc00',
  'left\ud800right',
  '\ud800\ud800\udc00\udc00'
])(
  'matches the canonical MD5 for UTF-8 text %#',
  (text) => {
    expect(md5Text(text)).toBe(createHash('md5').update(text).digest('hex'))
  }
)

test('matches Node at the maximum portable graph size without input-sized byte storage', () => {
  const text = 'x'.repeat(MAX_GRAPH_DOCUMENT_TEXT_BYTES)
  expect(md5Text(text)).toBe(createHash('md5').update(text).digest('hex'))
}, 30_000)
