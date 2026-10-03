import { useColorScheme } from 'react-native';

/**
 * Highland: forest green and coffee-gold on warm white, with a deep
 * forest-black night mode. Every screen reads colours through useTheme() so
 * light and dark stay in step.
 */
const light = {
  bg: '#fbfaf6',
  card: '#ffffff',
  raised: '#f1f3ec',
  line: '#e3e6dc',
  ink: '#13261d',
  muted: '#5b6b62',
  faint: '#8a978f',
  brand: '#13392a',
  onBrand: '#fbfaf6',
  gold: '#c8922e',
  ok: '#2f7a4f',
  warn: '#b4690e',
  danger: '#b3261e',
} as const;

const dark: Tokens = {
  bg: '#0f1a15',
  card: '#16241d',
  raised: '#1d2e25',
  line: '#24372d',
  ink: '#eef2ec',
  muted: '#9fb0a6',
  faint: '#6f8277',
  brand: '#7fc4a0',
  onBrand: '#0f1a15',
  gold: '#d9a648',
  ok: '#7ee0a8',
  warn: '#f0b45a',
  danger: '#f2867f',
};

export type Tokens = { [K in keyof typeof light]: string };
export type Tone = 'ink' | 'muted' | 'faint' | 'brand' | 'gold' | 'ok' | 'warn' | 'danger' | 'onBrand';

export function useTheme() {
  const dark_ = useColorScheme() === 'dark';
  const c = dark_ ? dark : light;
  return { c, dark: dark_, status: statusColors(c) };
}

/** Status is encoded by the colour of each row's leading edge. */
function statusColors(c: Tokens): Record<string, string> {
  return {
    initiating: c.faint, ringing: c.gold, 'in-progress': c.ok, missed: c.danger,
    processing: c.gold, ready: c.ok, failed: c.danger,
  };
}

export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 36, xxl: 56 } as const;

export const font = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  bold: 'Inter_600SemiBold',
  serif: 'Fraunces_600SemiBold',
  ethiopic: 'NotoSansEthiopic',
  ethiopicBold: 'NotoSansEthiopic-Bold',
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

export const radius = { sm: 6, md: 12, lg: 18, pill: 999 } as const;
