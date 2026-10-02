import { ScrollView, type ScrollViewProps } from 'react-native';
import { space, useTheme } from '../theme';

/** A scrolling page on the themed background, capped for wide web screens. */
export function Screen({ children, contentContainerStyle, ...rest }: ScrollViewProps & { children: React.ReactNode }) {
  const { c } = useTheme();
  return (
    <ScrollView {...rest} style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={[{ padding: space.md, gap: space.lg, width: '100%', maxWidth: 720, alignSelf: 'center' }, contentContainerStyle]}>
      {children}
    </ScrollView>
  );
}
