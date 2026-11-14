import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelTextFilter, cleanModelText } from '../public/model-content.js';

test('protocol filter is independent of stream boundaries and keeps ordinary text unchanged', () => {
  const call = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="web_search"><｜｜DSML｜｜ parameter name="query">private query</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
  for (const block of [call, call.replaceAll('｜｜', '|'), '<|DSML|invoke name="search">private query</|DSML|invoke>']) {
    const input = '前文🙂' + block + '后文。';
    for (let split = 0; split <= input.length; split++) {
      const filter = createModelTextFilter();
      const output = filter.push(input.slice(0, split)) + filter.push(input.slice(split)) + filter.finish();
      assert.equal(output, '前文🙂后文。'); assert.equal(filter.removed, true);
    }
  }
  for (const text of ['你好🙂', '1 < 2，3 > 2', '<div>literal HTML</div>', '最后是 <', '网址：https://example.com/?a=1&b=2', 'x<|not a protocol']) {
    const filter = createModelTextFilter();
    const result = [...text].map(char => filter.push(char)).join('') + filter.finish();
    assert.equal(result, text); assert.equal(filter.removed, false);
  }
  assert.equal(cleanModelText('<|DSML|calls>unfinished secret').content, '');
});
