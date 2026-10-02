import { Children } from 'react';
import { Text, type TextProps, type TextStyle } from 'react-native';
import { font, type Tone, type, useTheme } from '../theme';

type Props = TextProps & {
  size?: keyof typeof type;
  weight?: 'regular' | 'bold';
  tone?: Tone | 'primary' | 'accent';
  serif?: boolean;
};

const ETHIOPIC = /[ሀ-᎟ⶀ-⷟]/;
const hasEthiopic = (children: React.ReactNode) =>
  Children.toArray(children).some(child => typeof child === 'string' && ETHIOPIC.test(child));

/**
 * Every string goes through here. Latin text uses Inter (Fraunces for
 * headings); any Ethiopic text switches to Noto Sans Ethiopic, which sits
 * taller, so line height is generous enough that Amharic never clips.
 */
export function Txt({ size = 'body', weight = 'regular', tone = 'ink', serif = false, style, children, ...rest }: Props) {
  const { c } = useTheme();
  const ethiopic = hasEthiopic(children);
  const family = ethiopic ? (weight === 'bold' || serif ? font.ethiopicBold : font.ethiopic)
    : serif ? font.serif : weight === 'bold' ? font.bold : font.regular;
  const colour = tone === 'primary' ? c.ink : tone === 'accent' ? c.brand : c[tone];
  const base: TextStyle = {
    fontFamily: family,
    fontSize: type[size],
    lineHeight: Math.round(type[size] * (ethiopic ? 1.55 : 1.4)),
    color: colour,
  };
  return <Text {...rest} style={[base, style]}>{children}</Text>;
}
