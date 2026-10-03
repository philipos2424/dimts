import { Pressable, View } from 'react-native';
import { Txt } from './Txt';
import { radius, space, useTheme } from '../theme';

export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A quoted moment from a call; tapping plays it when timing is known. */
export function Moment({ quote, start, onPlay, label }: { quote: string; start: number | null; onPlay?: (start: number) => void; label?: string }) {
  const { c } = useTheme();
  const playable = start != null && !!onPlay;
  return (
    <Pressable accessibilityRole={playable ? 'button' : undefined} disabled={!playable} onPress={() => playable && onPlay!(start!)}
      accessibilityLabel={playable ? `Play from ${clock(start!)}` : undefined}
      style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' }}>
      <View style={{ width: 3, alignSelf: 'stretch', borderRadius: radius.sm, backgroundColor: c.gold }} />
      <View style={{ flex: 1, gap: 2 }}>
        <Txt size="caption" tone="muted" style={{ fontStyle: 'italic' }}>“{quote.replace(/^(?:User|Caller):\s*/, '')}”</Txt>
        {(label || start != null) && (
          <Txt size="caption" weight="bold" tone={playable ? 'brand' : 'faint'}>
            {playable ? `▶ ${label ? `${label} · ` : ''}${clock(start!)}` : label}
          </Txt>
        )}
      </View>
    </Pressable>
  );
}
