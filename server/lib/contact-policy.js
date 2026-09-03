/**
 * Whether an extracted identity may become a contact's display name.
 *
 * Kept separate from the SQL because this is the rule most likely to need
 * tuning against real calls, and it is worth being able to test it without
 * a database.
 */

/** Below this, a guessed name is worse than no name at all. */
export const MIN_NAME_CONFIDENCE = 0.7;

export function shouldAdoptName(existing, candidate) {
  if (!candidate?.name || typeof candidate.name !== 'string') return false;
  if (!(candidate.confidence >= MIN_NAME_CONFIDENCE)) return false;

  if (!existing?.display_name) return true;

  // A name the user typed is ground truth; the model does not get to argue.
  if (existing.name_source === 'user') return false;

  return candidate.confidence > (existing.name_confidence ?? 0);
}
