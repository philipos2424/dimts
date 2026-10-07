import { useRouter } from 'expo-router';
import { dueLabel } from '../reminderTime';
import { Pressable, View } from 'react-native';
import type { Briefing } from '../api';
import { Card } from './Card';
import { Txt } from './Txt';
import { space, useTheme } from '../theme';

const who = (name: string | null) => name ?? 'Someone';

/**
 * "This week": money first. Agreed prices and amounts link to the moment they
 * were said; contradictions come next. Promises stay in the strip below, where
 * they can be marked done.
 */
export function WeekCard({ briefing }: { briefing: Briefing | null }) {
  const { c } = useTheme();
  const router = useRouter();
  if (!briefing) return null;
  const { money, conflicts, totals } = briefing;
  const open = (id: string, start: number | null) => router.push(start != null ? `/call/${id}?t=${Math.floor(start)}` : `/call/${id}`);
  const counts = [totals.you_owe && `${totals.you_owe} to keep`, totals.waiting_on && `${totals.waiting_on} to chase`].filter(Boolean).join(' · ');
  if (!briefing.calls_this_week && !money.length && !conflicts.length && !counts) return null;
  return (
    <Card style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Txt size="title" serif>This week</Txt>
        <Txt size="caption" tone="muted">{briefing.calls_this_week} calls · {briefing.minutes_this_week} min</Txt>
      </View>
      {counts ? <Txt weight="bold">{counts}</Txt> : null}
      {briefing.you_owe.filter(p => p.overdue).slice(0, 3).map(item => (
        <Pressable key={`${item.call_id}-${item.index}`} accessibilityRole="link" onPress={() => router.push(`/call/${item.call_id}`)}
          style={{ minHeight: 44, justifyContent: 'center' }}>
          <Txt tone="danger" weight="bold">Overdue · {item.task}</Txt>
          <Txt size="caption" tone="muted">{who(item.contact_name)}{item.due ? ` · was due ${dueLabel(item.due)?.replace(/^(Today|Yesterday)/, s => s.toLowerCase())}` : ''}</Txt>
        </Pressable>
      ))}
      {money.slice(0, 3).map(item => (
        <Pressable key={`${item.call_id}-${item.line}`} accessibilityRole="link" onPress={() => open(item.call_id, item.start)}
          style={{ minHeight: 44, justifyContent: 'center' }}>
          <Txt><Txt weight="bold">{item.value}</Txt> · {item.subject}</Txt>
          <Txt size="caption" tone="muted">{who(item.contact_name)}{item.start != null ? ' · play the moment' : ''}</Txt>
        </Pressable>
      ))}
      {conflicts.slice(0, 2).map(item => (
        <Pressable key={item.call_id} accessibilityRole="link" onPress={() => router.push(`/call/${item.call_id}`)}
          style={{ minHeight: 44, justifyContent: 'center' }}>
          <Txt tone="warn">⚠ {who(item.contact_name)}: {item.note}</Txt>
        </Pressable>
      ))}
      <Pressable accessibilityRole="button" onPress={() => router.push(`/?q=${encodeURIComponent('What should I do this week?')}`)}
        style={{ minHeight: 44, justifyContent: 'center' }}>
        <Txt style={{ color: c.brand }} weight="bold">What should I do this week? →</Txt>
      </Pressable>
    </Card>
  );
}
