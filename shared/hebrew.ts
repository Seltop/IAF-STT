const HEBREW_DIACRITICS = /[\u0591-\u05C7]/g;
const PUNCTUATION_OR_SYMBOLS = /[^\p{L}\p{N}\s]/gu;
const MULTIPLE_SPACES = /\s+/g;
const HEBREW_PREFIXES = "ובכלמהש";

export function normalizeHebrew(value: string): string {
  return value
    .normalize("NFKD")
    .replace(HEBREW_DIACRITICS, "")
    .replace(PUNCTUATION_OR_SYMBOLS, " ")
    .replace(MULTIPLE_SPACES, " ")
    .trim()
    .toLocaleLowerCase("he-IL");
}

export function containsNormalizedPhrase(text: string, phrase: string): boolean {
  return findLastNormalizedPhraseIndex(text, phrase) !== -1;
}

export function findLastNormalizedPhraseIndex(text: string, phrase: string): number {
  const normalizedText = normalizeHebrew(text);
  const normalizedPhrase = normalizeHebrew(phrase);

  if (!normalizedPhrase) {
    return -1;
  }

  const pattern = new RegExp(
    `(^|\\s)([${HEBREW_PREFIXES}]{0,3})(${escapeRegExp(normalizedPhrase)})(?=\\s|$)`,
    "gu"
  );
  let lastIndex = -1;

  for (const match of normalizedText.matchAll(pattern)) {
    lastIndex = match.index + match[1].length + match[2].length;
  }

  return lastIndex;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
