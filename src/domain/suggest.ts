/** A valid value the caller may retry with. Suggestions are never applied automatically (D-03). */
export interface Candidate {
  readonly id: string;
  readonly label: string | null;
}

export const MAX_CANDIDATES = 5;

/** The part that carries meaning: `ym:s:lastSignUTMSource` → `lastsignutmsource`. */
const key = (id: string): string => id.slice(id.lastIndexOf(":") + 1).toLowerCase();

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** 0: same key, 1: one key contains the other, 2: small edit distance, null: not close. */
function tier(wanted: string, candidateKey: string, distance: number): number | null {
  if (candidateKey === wanted) return 0;
  if (wanted.length >= 3 && (candidateKey.includes(wanted) || wanted.includes(candidateKey))) {
    return 1;
  }
  return distance <= Math.max(2, Math.floor(wanted.length / 3)) ? 2 : null;
}

/**
 * Closest valid values for a mistyped one: same key ignoring case, then one key
 * containing the other, then small edit distance. A short list is returned whole
 * when nothing is close, because every entry is a valid choice.
 */
export function suggest(
  input: string,
  options: readonly Candidate[],
  limit = MAX_CANDIDATES,
): Candidate[] {
  const wanted = key(input);
  const scored = options.flatMap((candidate) => {
    const candidateKey = key(candidate.id);
    const distance = levenshtein(wanted, candidateKey);
    const t = tier(wanted, candidateKey, distance);
    return t === null ? [] : [{ candidate, tier: t, distance }];
  });
  if (scored.length === 0) return options.length <= limit ? [...options] : [];
  return scored
    .sort(
      (a, b) =>
        a.tier - b.tier || a.distance - b.distance || a.candidate.id.localeCompare(b.candidate.id),
    )
    .slice(0, limit)
    .map((s) => s.candidate);
}
