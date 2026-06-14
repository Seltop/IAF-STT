const HEBREW_DIACRITICS = /[\u0591-\u05C7]/g;
const PUNCTUATION_OR_SYMBOLS = /[^\p{L}\p{N}\s]/gu;
const MULTIPLE_SPACES = /\s+/g;

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
  const normalizedText = ` ${normalizeHebrew(text)} `;
  const normalizedPhrase = normalizeHebrew(phrase);

  if (!normalizedPhrase) {
    return false;
  }

  return normalizedText.includes(` ${normalizedPhrase} `);
}
