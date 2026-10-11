import test from 'node:test';
import assert from 'node:assert/strict';
import { canCall, canSignUp, signupCountryCode, callingCode } from './destinations.js';

// Synthetic examples: no calls are placed. Ordinary mobile and special-service
// examples for every launch country (including shared calling-code countries).
const PLANS = [
  ['US', '+12015550123', '+19005551234', '+15005551234'],
  ['CA', '+15062345678', '+16005551234', '+16139761234'],
  ['GB', '+447400123456', '+448451234567', '+447012345678'],
  ['AT', '+43664123456', '+43900123456', '+43810123456'],
  ['BE', '+32450001234', '+3290012345', '+3270212345'],
  ['BG', '+35943012345', '+35990123456', '+35970012345'],
  ['HR', '+385921234567', '+38561123456', '+38572123456'],
  ['CY', '+35796123456', '+35790012345', '+35770012345'],
  ['CZ', '+420601123456', '+420900123456', '+420840123456'],
  ['DK', '+4534412345', '+4590123456', '+4580123456'],
  ['EE', '+37251234567', '+3729001234', '+37270012345'],
  ['FI', '+358412345678', '+358600123456', '+358700123456'],
  ['FR', '+33612345678', '+33891234567', '+33810123456'],
  ['DE', '+4915123456789', '+499001123456', '+491801234567'],
  ['GR', '+306912345678', '+309011234567', '+308011234567'],
  ['HU', '+36201234567', '+3690123456', '+3680123456'],
  ['IE', '+353850123456', '+3531550123456', '+353818123456'],
  ['IT', '+393123456789', '+39899123456', '+39848123456'],
  ['LV', '+37121234567', '+37190123456', '+37181123456'],
  ['LT', '+37061234567', '+37090012345', '+37070012345'],
  ['LU', '+352628123456', '+35290012345', '+35280112345'],
  ['MT', '+35696961234', '+35650037123', '+35680062123'],
  ['NL', '+31612345678', '+319001234567', '+31851234567'],
  ['PL', '+48512345678', '+48700123456', '+48801123456'],
  ['PT', '+351912345678', '+351760123456', '+351808123456'],
  ['RO', '+40712034567', '+40900123456', '+40801123456'],
  ['SK', '+421912123456', '+421900123456', '+421850123456'],
  ['SI', '+38631234567', '+38690123456', '+38680123456'],
  ['ES', '+34612345678', '+34803123456', '+34902123456'],
  ['SE', '+46701234567', '+46900123456', '+46751123456'],
  ['IS', '+3546111234', '+3549001234', '+3548001234'],
  ['LI', '+423660234567', '+4239002255', '+4238002288'],
  ['NO', '+4740612345', '+4782012345', '+4788012345'],
  ['AE', '+971501234567', '+971900012345', '+971600123456'],
  ['SA', '+966512345678', '+966925123456', '+966920012345'],
  ['QA', '+97433123456', '+9748001234', '+97490012345'],
  ['BH', '+97336001234', '+97390123456', '+97380123456'],
  ['KW', '+96550012345', '+9651801234', '+9651811234'],
  ['OM', '+96892123456', '+96890012345', '+96880051234'],
  ['ET', '+251911234567', '+251994', '+2519001234567'],
];
for (const [country, ordinary, ...special] of PLANS) {
  test(`${country}: ordinary mobile allowed, premium/shared-cost/special services refused`, () => {
    for (const allowed of [canCall, canSignUp]) {
      assert.equal(allowed(ordinary), true, ordinary);
      for (const number of special) assert.equal(allowed(number), false, number);
    }
    for (const number of special) {
      assert.equal(callingCode(number), null);
      assert.equal(signupCountryCode(number), null);
    }
  });
}

test('ordinary geographic numbers and all US territories remain callable', () => {
  for (const number of ['+442079460018', '+4312345678', '+35312345678', '+4930123456',
    '+33123456789', '+390212345678', '+251111234567',
    '+15645551234', '+15845551234', '+17875551234', '+19395551234', '+13405551234', '+16715551234', '+16705551234', '+16845551234']) {
    assert.equal(canCall(number), true, number);
  }
});

test('NANP special services and local premium exchanges cannot bypass the country gate', () => {
  for (const npa of ['500','521','522','523','524','525','526','527','528','529','532','533',
    '538','542','543','544','545','547','549','552','553','554','556','558','566','569','577','578','588','589','600','622','633','700','710','800','822','833','844','855','866','877','888','900','976']) {
    assert.equal(canCall(`+1${npa}5551234`), false, npa);
  }
  assert.equal(canCall('+12129761234'), false);
  assert.equal(canCall('+14169001234'), false);
});

test('launch countries can sign up', () => {
  for (const number of ['+14155552671', '+16135550123', '+447911123456', '+4915112345678', '+33612345678', '+4791234567', '+971501234567', '+966501234567']) {
    assert.equal(canSignUp(number), true, number);
  }
});

test('Ethiopia can sign up and be called', () => {
  assert.equal(canSignUp('+251911234567'), true);
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
  assert.equal(signupCountryCode('+251911234567'), '251');
  assert.equal(signupCountryCode('+2348012345678'), null);
});
