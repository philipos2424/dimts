import { useRouter } from 'expo-router';
import { View } from 'react-native';
import type { ResolvedConflict } from '../api';
import { Card } from './Card';
import { Moment } from './Moment';
import { Txt } from './Txt';
import { space, useTheme } from '../theme';

/** Neutral side-by-side: what was said today, and what was said before. */
export function ConflictList({ conflicts, onPlay }: { conflicts: ResolvedConflict[]; onPlay: (seconds: number) => void }) {
  const { c } = useTheme();
  const router = useRouter();
  return (
    <View style={{ gap: space.sm }}>
      {conflicts.map((item, i) => (
        <Card key={i} style={{ borderColor: c.warn }}>
          <Txt weight="bold" tone="warn">⚠ {item.note}</Txt>
          <Txt size="caption" tone="muted" weight="bold">THIS CALL</Txt>
          <Moment quote={item.now.quote} start={item.now.start} onPlay={onPlay} label={item.now.value} />
          <Txt size="caption" tone="muted" weight="bold">ON {new Date(item.before.created_at).toLocaleDateString().toUpperCase()}</Txt>
          <Moment quote={item.before.quote} start={item.before.start} label={item.before.value}
            onPlay={seconds => router.push(`/call/${item.before.call_id}?t=${Math.floor(seconds)}`)} />
        </Card>
      ))}
    </View>
  );
}
