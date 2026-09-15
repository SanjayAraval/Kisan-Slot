'use strict';

const V = require('../public/validation');

describe('normalizeMobile / validateMobile', () => {
  test('accepts a plain 10-digit number', () => {
    expect(V.validateMobile('9876543210')).toBeNull();
  });

  test('strips +91, bare 91, a leading 0, spaces and hyphens before testing', () => {
    expect(V.normalizeMobile('+91 98765-43210')).toBe('9876543210');
    expect(V.normalizeMobile('919876543210')).toBe('9876543210');
    expect(V.normalizeMobile('09876543210')).toBe('9876543210');
    expect(V.normalizeMobile('98765 43210')).toBe('9876543210');
    expect(V.validateMobile('+91 98765-43210')).toBeNull();
  });

  test('rejects a number not starting with 6-9', () => {
    expect(V.validateMobile('5876543210')).toMatch(/6, 7, 8 or 9/);
  });

  test('rejects a number that is not 10 digits after normalizing', () => {
    expect(V.validateMobile('987654321')).toMatch(/10-digit/);
    expect(V.validateMobile('98765432100')).toMatch(/10-digit/);
  });

  test('rejects all-identical digits', () => {
    expect(V.validateMobile('6666666666')).toMatch(/same digit/);
  });
});

describe('validateAadhaar (Verhoeff checksum)', () => {
  // 234567890124 and 912345678905 have a genuine Verhoeff check digit as
  // their last digit (computed and self-verified independently of the
  // production code, the same way a real Aadhaar number would be).
  test('accepts a 12-digit number with a valid Verhoeff checksum', () => {
    expect(V.validateAadhaar('234567890124')).toBeNull();
    expect(V.validateAadhaar('912345678905')).toBeNull();
  });

  test('rejects a number that is not exactly 12 digits', () => {
    expect(V.validateAadhaar('23456789012')).toMatch(/12 digits/);
    expect(V.validateAadhaar('2345678901245')).toMatch(/12 digits/);
    expect(V.validateAadhaar('')).toMatch(/12 digits/);
  });

  test('rejects a number starting with 0 or 1', () => {
    expect(V.validateAadhaar('012345678905')).toMatch(/cannot start/);
    expect(V.validateAadhaar('134567890128')).toMatch(/cannot start/);
  });

  test('rejects a number that fails the checksum', () => {
    // Same digits as a valid number above, with the check digit flipped.
    expect(V.validateAadhaar('234567890123')).toMatch(/checksum failed/);
  });
});

describe('validateName', () => {
  test('accepts a plain name', () => {
    expect(V.validateName('Ravi Kumar')).toBeNull();
    expect(V.validateName("O'Brien-Singh")).toBeNull();
  });

  test('rejects too short or too long', () => {
    expect(V.validateName('R')).toMatch(/2-60/);
    expect(V.validateName('a'.repeat(61))).toMatch(/2-60/);
  });

  test('rejects digits or symbols outside letters/space/apostrophe/hyphen', () => {
    expect(V.validateName('Ravi123')).toMatch(/letters, spaces/);
    expect(V.validateName('Ravi@Kumar')).toMatch(/letters, spaces/);
  });

  test('rejects a name with no vowels', () => {
    expect(V.validateName('Krtvv')).toMatch(/vowel/);
  });

  test('rejects 4+ identical consecutive characters', () => {
    expect(V.validateName('Raaaavi')).toMatch(/repeat/);
  });
});

describe('validatePlaceName (village/district)', () => {
  test('accepts letters and spaces', () => {
    expect(V.validatePlaceName('Kondapur', 'Village')).toBeNull();
    expect(V.validatePlaceName('East Godavari', 'District')).toBeNull();
  });

  test('rejects digits', () => {
    expect(V.validatePlaceName('Sector 5', 'Village')).toMatch(/letters and spaces/);
  });

  test('rejects out-of-range length', () => {
    expect(V.validatePlaceName('A', 'Village')).toMatch(/2-50/);
  });
});

describe('validateKhasra', () => {
  test('accepts alphanumeric with / and -', () => {
    expect(V.validateKhasra('KH-1024/A')).toBeNull();
  });

  test('rejects too short', () => {
    expect(V.validateKhasra('K1')).toMatch(/3-30/);
  });

  test('rejects disallowed characters', () => {
    expect(V.validateKhasra('KH 1024')).toMatch(/letters, numbers/);
  });
});

describe('validateLandSize', () => {
  test('0.1-100 acres passes with no review flag', () => {
    expect(V.validateLandSize(3.5)).toEqual({ error: null, needsReview: false });
    expect(V.validateLandSize(100)).toEqual({ error: null, needsReview: false });
  });

  test('100-1000 acres passes but flags for officer review', () => {
    const result = V.validateLandSize(500);
    expect(result.error).toBeNull();
    expect(result.needsReview).toBe(true);
  });

  test('below 0.1 or above 1000 is rejected', () => {
    expect(V.validateLandSize(0.05).error).toMatch(/at least/);
    expect(V.validateLandSize(1000.01).error).toMatch(/cannot exceed/);
  });

  test('non-numeric is rejected', () => {
    expect(V.validateLandSize('abc').error).toMatch(/Enter land size/);
  });
});

describe('validateQuantity', () => {
  test('positive number under the absolute cap passes', () => {
    expect(V.validateQuantity(40)).toBeNull();
  });

  test('rejects zero, negative and non-numeric', () => {
    expect(V.validateQuantity(0)).toMatch(/positive/);
    expect(V.validateQuantity(-5)).toMatch(/positive/);
    expect(V.validateQuantity('abc')).toMatch(/number/);
  });

  test('rejects anything above the absolute 5000q cap even with no land cap given', () => {
    expect(V.validateQuantity(5001)).toMatch(/5000/);
  });

  test('rejects a quantity within the absolute cap but above the land-record cap', () => {
    expect(V.validateQuantity(200, 150)).toMatch(/permitted cap/);
  });

  test('passes a quantity within both caps', () => {
    expect(V.validateQuantity(100, 150)).toBeNull();
  });
});

describe('validateBankAccount', () => {
  test('accepts 9-18 digits', () => {
    expect(V.validateBankAccount('123456789')).toBeNull(); // 9 digits
    expect(V.validateBankAccount('123456789012345678')).toBeNull(); // 18 digits
  });

  test('rejects too short, too long, and non-digits', () => {
    expect(V.validateBankAccount('12345')).toMatch(/9-18/); // 5 digits
    expect(V.validateBankAccount('1234567890123456789')).toMatch(/9-18/); // 19 digits
    expect(V.validateBankAccount('12345abcd')).toMatch(/9-18/);
  });
});

describe('validateIfsc', () => {
  test('accepts a valid code and uppercases it', () => {
    expect(V.validateIfsc('sbin0001234')).toEqual({ error: null, value: 'SBIN0001234' });
  });

  test('rejects a malformed code', () => {
    const { error } = V.validateIfsc('SBIN1234567');
    expect(error).toMatch(/valid IFSC/);
  });
});

describe('validateBookingDate', () => {
  const TODAY = '2026-09-10';

  test('accepts today and up to 7 days ahead', () => {
    expect(V.validateBookingDate('2026-09-10', TODAY)).toBeNull();
    expect(V.validateBookingDate('2026-09-17', TODAY)).toBeNull();
  });

  test('rejects a date in the past', () => {
    expect(V.validateBookingDate('2026-09-09', TODAY)).toMatch(/past/);
  });

  test('rejects a date more than 7 days ahead', () => {
    expect(V.validateBookingDate('2026-09-18', TODAY)).toMatch(/7 days ahead/);
  });

  test('rejects a malformed date', () => {
    expect(V.validateBookingDate('10-09-2026', TODAY)).toMatch(/YYYY-MM-DD/);
    expect(V.validateBookingDate('', TODAY)).toMatch(/YYYY-MM-DD/);
  });
});

describe('validatePositiveIntegerInBounds', () => {
  test('accepts an in-bounds integer', () => {
    expect(V.validatePositiveIntegerInBounds(10, { max: 500, label: 'gangs' })).toBeNull();
  });

  test('rejects zero and negatives', () => {
    expect(V.validatePositiveIntegerInBounds(0, { max: 500, label: 'gangs' })).toMatch(/at least 1/);
    expect(V.validatePositiveIntegerInBounds(-3, { max: 500, label: 'gangs' })).toMatch(/at least 1/);
  });

  test('rejects a fractional value', () => {
    expect(V.validatePositiveIntegerInBounds(2.5, { max: 500, label: 'gangs' })).toMatch(/whole number/);
  });

  test('rejects above the given bound', () => {
    expect(V.validatePositiveIntegerInBounds(501, { max: 500, label: 'gangs' })).toMatch(/cannot exceed 500/);
  });
});
