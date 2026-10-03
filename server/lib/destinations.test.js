import test from 'node:test';
import assert from 'node:assert/strict';
import { canCall, canSignUp, signupCountryCode } from './destinations.js';

test('launch countries can sign up', () => {
  for (const number of ['+14155552671', '+16135550123', '+447911123456', '+4915112345678', '+33612345678', '+4791234567', '+971501234567', '+966501234567']) {
    assert.equal(canSignUp(number), true, number);
  }
});

test('Ethiopia can be called but cannot sign up', () => {
  assert.equal(canSignUp('+251911234567'), false);
  assert.equal(canCall('+251911234567'), true);
});

test('countries outside the launch list are refused', () => {
  for (const number of ['+2348012345678', '+79161234567', '+8613812345678', '+5491123456789', '+88216123456']) {
    assert.equal(canSignUp(number), false, number);
    assert.equal(canCall(number), false, number);
  }
});

test('Caribbean NANP numbers are refused but US territories are not', () => {
  assert.equal(canCall('+18765551234'), false); // Jamaica
  assert.equal(canCall('+18095551234'), false); // Dominican Republic
  assert.equal(canCall('+17875551234'), true); // Puerto Rico
});

test('NANP numbers must have ten digits after the country code', () => {
  assert.equal(canCall('+1415555267'), false);
});

test('premium-rate ranges are refused in allowed countries', () => {
  for (const number of ['+19005551234', '+449098790000', '+447012345678', '+447624123456', '+4990012345678', '+33891234567']) {
    assert.equal(canCall(number), false, number);
    assert.equal(canSignUp(number), false, number);
  }
});

test('rejects anything that is not E.164', () => {
  assert.equal(canCall('4155552671'), false);
  assert.equal(canSignUp(undefined), false);
});

test('reports the calling code for send limits', () => {
  assert.equal(signupCountryCode('+447911123456'), '44');
  assert.equal(signupCountryCode('+971501234567'), '971');
  assert.equal(signupCountryCode('+251911234567'), null);
});
