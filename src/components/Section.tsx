import { View } from 'react-native';
import { color, space } from '../theme';
import { Txt } from './Txt';

/** A titled block. The rule under the title separates without boxing content in. */
export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={{ gap: space.sm }}>
      <Txt size="subhead" weight="bold" tone="accent">
        {title}
      </Txt>
      <View style={{ height: 1, backgroundColor: color.line }} />
      {children}
    </View>
  );
}
