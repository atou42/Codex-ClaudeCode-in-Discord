/**
 * RFC 8259 strict JSON parser with duplicate key detection at every depth,
 * null-prototype object construction, and comprehensive validation.
 *
 * Rejects:
 * - Duplicate keys in any object at any nesting level (before assignment)
 * - Trailing commas in objects and arrays
 * - BOM (U+FEFF)
 * - Lone surrogate escapes (U+D800..U+DFFF)
 * - Non-finite numbers (Infinity, -Infinity, NaN)
 * - Number overflow (exponent > 308)
 * - Excessive nesting depth (> 50)
 * - Excessive string length (> 100KB per string)
 * - Excessive object keys (> 1000 per object)
 *
 * Builds null-prototype objects to prevent prototype pollution.
 * Error messages never contain raw input bytes or attacker-controlled key names.
 */

const MAX_DEPTH = 50;
const MAX_STRING_LENGTH = 100 * 1024; // 100KB
const MAX_OBJECT_KEYS = 1000;
const MAX_NUMBER_EXPONENT = 308;

export function parseJSONStrictly(text) {
  // Reject BOM
  if (text.charCodeAt(0) === 0xfeff) {
    throw new Error('JSON parse error: BOM not allowed');
  }

  let pos = 0;
  const len = text.length;
  let depth = 0;

  function skipWhitespace() {
    while (pos < len && ' \t\n\r'.includes(text[pos])) {
      pos++;
    }
  }

  function parseValue() {
    skipWhitespace();
    if (pos >= len) {
      throw new Error('JSON parse error: unexpected end of input');
    }

    const char = text[pos];

    if (char === '"') {
      return parseString();
    } else if (char === '{') {
      return parseObject();
    } else if (char === '[') {
      return parseArray();
    } else if (char === 't') {
      if (text.substr(pos, 4) === 'true') {
        pos += 4;
        return true;
      }
      throw new Error('JSON parse error: invalid token');
    } else if (char === 'f') {
      if (text.substr(pos, 5) === 'false') {
        pos += 5;
        return false;
      }
      throw new Error('JSON parse error: invalid token');
    } else if (char === 'n') {
      if (text.substr(pos, 4) === 'null') {
        pos += 4;
        return null;
      }
      throw new Error('JSON parse error: invalid token');
    } else if (char === '-' || (char >= '0' && char <= '9')) {
      return parseNumber();
    } else {
      throw new Error('JSON parse error: unexpected character');
    }
  }

  function parseString() {
    if (text[pos] !== '"') {
      throw new Error('JSON parse error: expected string');
    }
    pos++; // skip opening quote

    let result = '';
    let escapeNext = false;

    while (pos < len) {
      const char = text[pos];

      if (escapeNext) {
        if (char === '"' || char === '\\' || char === '/' || char === 'b' || char === 'f' || char === 'n' || char === 'r' || char === 't') {
          const escapeMap = { '"': '"', '\\': '\\', '/': '/', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t' };
          result += escapeMap[char] || char;
          escapeNext = false;
          pos++;
        } else if (char === 'u') {
          // Unicode escape \uXXXX
          if (pos + 4 >= len) {
            throw new Error('JSON parse error: incomplete unicode escape');
          }
          const hex = text.substr(pos + 1, 4);
          const codePoint = parseInt(hex, 16);
          if (isNaN(codePoint)) {
            throw new Error('JSON parse error: invalid unicode escape');
          }
          // Reject lone surrogates (U+D800..U+DFFF)
          if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
            throw new Error('JSON parse error: lone surrogate escape not allowed');
          }
          result += String.fromCharCode(codePoint);
          pos += 5;
          escapeNext = false;
        } else {
          throw new Error('JSON parse error: invalid escape sequence');
        }
      } else if (char === '\\') {
        escapeNext = true;
        pos++;
      } else if (char === '"') {
        pos++; // skip closing quote
        if (result.length > MAX_STRING_LENGTH) {
          throw new Error('JSON parse error: string exceeds maximum length');
        }
        return result;
      } else if (char < ' ') {
        throw new Error('JSON parse error: unescaped control character');
      } else {
        result += char;
        pos++;
      }
    }

    throw new Error('JSON parse error: unterminated string');
  }

  function parseNumber() {
    const start = pos;

    if (text[pos] === '-') {
      pos++;
    }

    if (pos >= len || text[pos] < '0' || text[pos] > '9') {
      throw new Error('JSON parse error: invalid number');
    }

    if (text[pos] === '0') {
      pos++;
    } else {
      while (pos < len && text[pos] >= '0' && text[pos] <= '9') {
        pos++;
      }
    }

    if (pos < len && text[pos] === '.') {
      pos++;
      if (pos >= len || text[pos] < '0' || text[pos] > '9') {
        throw new Error('JSON parse error: invalid number');
      }
      while (pos < len && text[pos] >= '0' && text[pos] <= '9') {
        pos++;
      }
    }

    let exponent = 0;
    if (pos < len && (text[pos] === 'e' || text[pos] === 'E')) {
      const expStart = pos;
      pos++;
      let expSign = 1;
      if (pos < len && (text[pos] === '+' || text[pos] === '-')) {
        if (text[pos] === '-') expSign = -1;
        pos++;
      }
      if (pos >= len || text[pos] < '0' || text[pos] > '9') {
        throw new Error('JSON parse error: invalid number');
      }
      while (pos < len && text[pos] >= '0' && text[pos] <= '9') {
        pos++;
      }
      const expStr = text.slice(expStart + 1, pos);
      exponent = parseInt(expStr, 10) * expSign;
    }

    const numStr = text.slice(start, pos);
    const num = parseFloat(numStr);

    // Reject non-finite
    if (!Number.isFinite(num)) {
      throw new Error('JSON parse error: number overflow or non-finite');
    }

    // Reject excessive exponent
    if (Math.abs(exponent) > MAX_NUMBER_EXPONENT) {
      throw new Error('JSON parse error: number exponent too large');
    }

    return num;
  }

  function parseObject() {
    if (text[pos] !== '{') {
      throw new Error('JSON parse error: expected object');
    }

    depth++;
    if (depth > MAX_DEPTH) {
      throw new Error('JSON parse error: nesting depth exceeds maximum');
    }

    pos++; // skip opening brace

    // Create null-prototype object
    const obj = Object.create(null);
    const keys = new Set();
    let first = true;

    skipWhitespace();

    while (pos < len && text[pos] !== '}') {
      if (!first) {
        skipWhitespace();
        if (text[pos] !== ',') {
          throw new Error('JSON parse error: expected comma');
        }
        pos++;
        skipWhitespace();

        // Reject trailing comma: if we see '}' after comma, it's a trailing comma
        if (text[pos] === '}') {
          throw new Error('JSON parse error: trailing comma not allowed');
        }
      }
      first = false;

      // Parse key
      if (text[pos] !== '"') {
        throw new Error('JSON parse error: expected string key');
      }
      const key = parseString();

      // Check duplicate BEFORE assignment
      if (keys.has(key)) {
        // Never echo the actual key name - it might be attacker-controlled
        throw new Error('JSON parse error: duplicate key detected');
      }
      keys.add(key);

      if (keys.size > MAX_OBJECT_KEYS) {
        throw new Error('JSON parse error: object has too many keys');
      }

      skipWhitespace();
      if (text[pos] !== ':') {
        throw new Error('JSON parse error: expected colon');
      }
      pos++;

      // Parse value and assign (duplicate already checked)
      obj[key] = parseValue();

      skipWhitespace();
    }

    if (pos >= len || text[pos] !== '}') {
      throw new Error('JSON parse error: expected closing brace');
    }
    pos++; // skip closing brace

    depth--;
    return obj;
  }

  function parseArray() {
    if (text[pos] !== '[') {
      throw new Error('JSON parse error: expected array');
    }

    depth++;
    if (depth > MAX_DEPTH) {
      throw new Error('JSON parse error: nesting depth exceeds maximum');
    }

    pos++; // skip opening bracket

    const arr = [];
    let first = true;

    skipWhitespace();

    while (pos < len && text[pos] !== ']') {
      if (!first) {
        skipWhitespace();
        if (text[pos] !== ',') {
          throw new Error('JSON parse error: expected comma');
        }
        pos++;
        skipWhitespace();

        // Reject trailing comma: if we see ']' after comma, it's a trailing comma
        if (text[pos] === ']') {
          throw new Error('JSON parse error: trailing comma not allowed');
        }
      }
      first = false;

      arr.push(parseValue());

      skipWhitespace();
    }

    if (pos >= len || text[pos] !== ']') {
      throw new Error('JSON parse error: expected closing bracket');
    }
    pos++; // skip closing bracket

    depth--;
    return arr;
  }

  const result = parseValue();
  skipWhitespace();
  if (pos < len) {
    throw new Error('JSON parse error: unexpected content after JSON');
  }

  return result;
}
