import { Text, type TextProps, type TextStyle } from 'react-native';
import { color, font, type } from '../theme';

type Props = TextProps & {
  size?: keyof typeof type;
  weight?: 'regular' | 'bold';
  tone?: 'primary' | 'muted' | 'faint' | 'accent';
};

const tones = {
  primary: color.parchment,
  muted: color.muted,
  faint: color.faint,
  accent: color.saffron,
} as const;

/**
 * Every string in the app goes through here so both scripts share one family.
 * Ethiopic glyphs sit taller than Latin, so line-height is set generously
 * enough that Amharic never clips.
 */
export function Txt({
  size = 'body',
  weight = 'regular',
  tone = 'primary',
  style,
  ...rest
}: Props) {
  const base: TextStyle = {
    fontFamily: weight === 'bold' ? font.bold : font.regular,
    fontSize: type[size],
    lineHeight: Math.round(type[size] * 1.5),
    color: tones[tone],
  };

  return <Text {...rest} style={[base, style]} />;
}
