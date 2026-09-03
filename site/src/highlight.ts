export type TokenKind = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'space';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

const TOKEN =
  /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}[\],:])|(\s+)/g;

export function tokenizeJson(json: string): readonly Token[] {
  const pretty = JSON.stringify(JSON.parse(json), null, 2);
  const tokens: Token[] = [];
  for (const m of pretty.matchAll(TOKEN)) {
    const [, str, colon, num, lit, punct, space] = m;
    if (str !== undefined) {
      tokens.push({ kind: colon ? 'key' : 'string', text: str });
      if (colon) tokens.push({ kind: 'punct', text: colon });
    } else if (num !== undefined) tokens.push({ kind: 'number', text: num });
    else if (lit !== undefined) tokens.push({ kind: 'literal', text: lit });
    else if (punct !== undefined) tokens.push({ kind: 'punct', text: punct });
    else if (space !== undefined) tokens.push({ kind: 'space', text: space });
  }
  return tokens;
}
