import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { type ContactContext, getCallContext, getContactContext } from '../api';
import { useApp } from '../AppContext';
import { space } from '../theme';
import { Section } from './Section';
import { Txt } from './Txt';

export function CallBriefing({ callId, phone }: { callId?: string; phone?: string }) {
  const { userPhone } = useApp();
  const target = `${userPhone}:${callId ? `call:${callId}` : `phone:${phone}`}`;
  const [context, setContext] = useState<(ContactContext & { target: string }) | null>(null);
  const [error, setError] = useState(false);
  const router = useRouter();
  useEffect(() => {
    let active = true;
    setContext(null); setError(false);
    if (!callId && (!phone || !/^\+[1-9]\d{6,14}$/.test(phone))) return;
    const timer = setTimeout(() => {
      const request = callId ? getCallContext(callId) : getContactContext(phone!);
      request.then(result => { if (active) setContext({ ...result, target }); }).catch(() => { if (active) setError(true); });
    }, callId ? 0 : 400);
    return () => { active = false; clearTimeout(timer); };
  }, [callId, phone, target]);
  if (!userPhone) return null;
  if (!context || context.target !== target) return error ? <Txt tone="muted">Previous call memory is unavailable. You can still continue the call.</Txt> : null;
  const previous = context.previous_calls[0];
  if (!context.contact && !previous) return null;
  return <Section title="Before this call">
    <View style={{ gap: space.sm }}>
      {!!context.contact?.display_name && <Txt weight="bold">{context.contact.display_name}{context.contact.company ? ` · ${context.contact.company}` : ''}</Txt>}
      {!!context.contact?.notes && <Txt>{context.contact.notes}</Txt>}
      {previous ? <>
        <Txt tone="muted">Last conversation: {new Date(previous.created_at).toLocaleString()}</Txt>
        <Txt>{previous.summary}</Txt>
        {!!previous.action_items?.length && <>
          <Txt weight="bold">Previously agreed — completion not verified</Txt>
          {previous.action_items.slice(0, 4).map((item, i) => <Txt key={i}>{item.owner || 'Unknown speaker'}: {item.task}</Txt>)}
        </>}
        {!!previous.next_moves?.length && <>
          <Txt weight="bold">Suggestions saved after that call</Txt>
          {previous.next_moves.slice(0, 3).map((move, i) => <Txt key={i}>• {move}</Txt>)}
        </>}
        <Pressable accessibilityRole="button" onPress={() => router.push(`/call/${previous.id}`)}>
          <Txt tone="accent">Open the source call</Txt>
        </Pressable>
      </> : <Txt tone="muted">No previous summarized call with this number.</Txt>}
    </View>
  </Section>;
}
