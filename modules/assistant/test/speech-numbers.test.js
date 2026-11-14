import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSpeechNumbers} from '../server/speech-numbers.js';
test('Chinese speech numbers preserve magnitude, precision, signs, dates and time',()=>{
 for(const [input,expected]of [
  ['余额1.22元，消费0.08元','余额一点二二元，消费零点零八元'],
  ['价格1000000元，另有1,234.50元','价格一百万元，另有一千二百三十四点五零元'],
  ['库存100010001个','库存一亿零一万零一个'],
  ['余额CNY 15.20，USD 0.05','余额十五点二零元，零点零五美元'],
  ['今天2026-11-14，08:00，比例5–15%','今天二零二六年十一月十四日，八点整，比例百分之五到十五'],
  ['验证码001234，电话13800138000','验证码零零一二三四，电话一三八零零一三八零零零'],
  ['气温-3.5℃，上涨12.50%','气温零下三点五摄氏度，上涨百分之十二点五零'],
  ['金额１２.０５元','金额十二点零五元'],
 ])assert.equal(normalizeSpeechNumbers(input),expected,input);
});
test('local numeric preparation leaves other languages, code, addresses and model names intact',()=>{
 for(const text of ['The balance is $1.22 and 15%.','今日は2026年11月14日です','오늘 15%입니다','访问https://example.com/2026/11/14，使用Qwen3-TTS和v0.7.0，地址192.168.1.1，代码`123.45`'])assert.equal(normalizeSpeechNumbers(text),text);
});
