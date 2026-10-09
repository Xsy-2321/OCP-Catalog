import { describe, expect, test } from 'bun:test';
import { canonicalBytes, canonicalJson } from './canonical';

describe('canonicalJson', () => {
  test('sorts object keys so key order does not change the output', () => {
    // Arrange: the same logical object, written in two different orders.
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };

    // Act
    const jsonA = canonicalJson(a);
    const jsonB = canonicalJson(b);

    // Assert
    expect(jsonA).toBe('{"a":2,"b":1,"c":3}');
    expect(jsonA).toBe(jsonB);
  });

  test('sorts keys at every nesting level', () => {
    // Arrange: only the nested object is out of order.
    const value = { outer: { z: 1, a: 2 }, top: 0 };

    // Act
    const json = canonicalJson(value);

    // Assert
    expect(json).toBe('{"outer":{"a":2,"z":1},"top":0}');
  });

  test('keeps array order, because array order is content', () => {
    // Arrange: two arrays with the same elements, different order.
    const ascending = { items: [1, 2, 3] };
    const descending = { items: [3, 2, 1] };

    // Act
    const jsonAscending = canonicalJson(ascending);
    const jsonDescending = canonicalJson(descending);

    // Assert: a sort-everything implementation would wrongly collapse these.
    expect(jsonAscending).toBe('{"items":[1,2,3]}');
    expect(jsonAscending).not.toBe(jsonDescending);
  });

  test('reorders keys inside objects that sit inside arrays', () => {
    // Arrange: the only difference is key order inside an array element.
    const a = { items: [{ b: 1, a: 2 }] };
    const b = { items: [{ a: 2, b: 1 }] };

    // Act
    const jsonA = canonicalJson(a);
    const jsonB = canonicalJson(b);

    // Assert
    expect(jsonA).toBe('{"items":[{"a":2,"b":1}]}');
    expect(jsonA).toBe(jsonB);
  });

  test('drops undefined properties but keeps null', () => {
    // Arrange: one dropped key, one retained null.
    const value = { kept: 1, dropped: undefined, nullable: null };

    // Act
    const json = canonicalJson(value);

    // Assert
    expect(json).toBe('{"kept":1,"nullable":null}');
  });

  test('emits no insignificant whitespace', () => {
    // Arrange
    const value = { a: [1, 2], b: { c: 3 } };

    // Act
    const json = canonicalJson(value);

    // Assert
    expect(json).not.toContain(' ');
    expect(json).toBe('{"a":[1,2],"b":{"c":3}}');
  });

  test('throws rather than returning undefined for a non-serializable root', () => {
    // Arrange: `undefined` has no JSON representation at the top level.
    const unserializable: undefined = undefined;

    // Act / Assert: a silent `undefined` would surface far from the cause.
    expect(() => canonicalJson(unserializable)).toThrow(TypeError);
  });

  test('encodes the same string to identical bytes on repeated calls', () => {
    // Arrange
    const value = { b: '拿铁', a: 2500 };

    // Act
    const first = canonicalBytes(value);
    const second = canonicalBytes(value);

    // Assert: byte-for-byte stability is what the signature depends on.
    expect(first).toBeInstanceOf(Uint8Array);
    expect(first.length).toBe(second.length);
    expect(Array.from(first)).toEqual(Array.from(second));
  });

  test('encodes non-ASCII characters as UTF-8, not as literal code units', () => {
    // Arrange: '拿' is three UTF-8 bytes but one JS string element.
    const value = { name: '拿' };

    // Act
    const bytes = canonicalBytes(value);

    // Assert: a UTF-16 or latin1 encoder would produce a different length.
    expect(bytes.length).toBe(canonicalJson(value).length + 2);
    // The three character bytes sit just before the closing `"` and `}`.
    expect(Array.from(bytes.slice(-5, -2))).toEqual([0xe6, 0x8b, 0xbf]);
  });
});
