import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import type { CallSummary } from '../api';
import { useApp } from '../AppContext';
import { formatDuration, formatWhen } from '../useCalls';
import { Button } from './Button';
import { Card } from './Card';
import { CapturePill } from './Pill';
import { Txt } from './Txt';
import { space, useTheme } from '../theme';

const firstSentence = (text: string | null) => text?.split(/(?<=[.!?።])\s/)[0] ?? null;

/** One call, reported back: who, what was agreed, and the one next step. */
export function CallCard({ call }: { call: CallSummary }) {
  const { c } = useTheme();
  const { t, lang } = useApp();
  const router = useRouter();
  const open = (focus?: string) => router.push(focus ? `/call/${call.id}?focus=${focus}` : `/call/${call.id}`);
  const name = call.contact_name ?? call.destination;
  const agreements = call.agreements ?? [];
  const failedWithAudio = call.capture && ['one_voice', 'no_audio', 'unknown'].includes(call.capture);

  return (
    <Card onPress={() => open()} accessibilityLabel={`Call with ${name}`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: space.sm }}>
        <Pressable accessibilityRole="link" disabled={!call.contact_id} hitSlop={6}
          onPress={() => call.contact_id && router.push(`/person/${call.contact_id}`)} style={{ flexShrink: 1 }}>
          <Txt size="subhead" serif>{name}{call.company ? <Txt tone="muted" size="body"> · {call.company}</Txt> : null}</Txt>
        </Pressable>
        <CapturePill capture={call.capture ?? 'none'} />
      </View>
      <Txt size="caption" tone="muted">
        {call.direction === 'inbound' ? t('incoming') : t('outgoing')}
        {call.duration_sec ? ` · ${formatDuration(call.duration_sec)}` : ''} · {formatWhen(call.created_at, lang)}
      </Txt>

      {agreements.length > 0 ? (
        <View style={{ gap: 2 }}>
          {agreements.map((a, i) => (
            <Txt key={i}>{a.subject}: <Txt weight="bold">{a.value}</Txt></Txt>
          ))}
        </View>
      ) : call.summary ? <Txt tone="muted">{firstSentence(call.summary)}</Txt> : null}

      {failedWithAudio && <Txt tone="warn">Recording kept. No notes made. Tap to see what happened.</Txt>}
      {!!call.conflict_count && (
        <Txt tone="warn" weight="bold">⚠ {call.conflict_count === 1 ? 'Something differs from an earlier call' : `${call.conflict_count} things differ from earlier calls`}</Txt>
      )}

      {call.next_step && (
        <View style={{ backgroundColor: c.raised, borderRadius: 12, padding: space.sm, gap: space.sm }}>
          <Txt size="caption">
            {call.next_step.kind === 'meeting' ? '📅 ' : call.next_step.kind === 'email' ? '✉️ ' : '→ '}{call.next_step.text}
          </Txt>
          {call.next_step.kind !== 'move' && <Button compact label="Review and approve" onPress={() => open('next')} />}
        </View>
      )}
    </Card>
  );
}
