/**
 * Palette drawn from Ge'ez manuscript illumination — ink, parchment, saffron,
 * and a deep madder red — rather than the Ethiopian flag tricolour, which
 * reads as a sticker rather than an identity.
 *
 * The UI is dark because of when it gets used: the diaspora calls home across
 * a 7-10 hour gap, which puts a lot of these calls late at night.
 */
export const color = {
  ink: '#131A2B',
  surface: '#1C2437',
  raised: '#263047',
  line: '#333E58',

  parchment: '#F2EAD9',
  muted: '#8B93A7',
  faint: '#5C6684',

  saffron: '#E8A33D',
  madder: '#B03A2E',
  verdigris: '#1F8A5B',
} as const;

/** Status is encoded by the colour of each row's leading edge. */
export const statusColor: Record<string, string> = {
  initiating: color.faint,
  ringing: color.saffron,
  'in-progress': color.verdigris,
  missed: color.madder,
  processing: color.saffron,
  ready: color.verdigris,
  failed: color.madder,
};

export const space = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 36,
  xxl: 56,
} as const;

/**
 * One family across both scripts. Noto Sans Ethiopic carries Latin glyphs, so
 * Amharic and English share a single voice instead of Amharic being bolted on
 * to a Latin-first face.
 */
export const font = {
  regular: 'NotoSansEthiopic',
  bold: 'NotoSansEthiopic-Bold',
} as const;

export const type = {
  caption: 13,
  body: 15,
  subhead: 17,
  title: 21,
  screen: 28,
  display: 34,
  keypad: 30,
} as const;

export const radius = { sm: 6, md: 12, pill: 999 } as const;
