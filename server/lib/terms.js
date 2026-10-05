// Bumping this version requires every user to accept the terms again.
export const TERMS_VERSION = '2026-10-05';
export const hasAcceptedTerms = user => user?.terms_version === TERMS_VERSION;
