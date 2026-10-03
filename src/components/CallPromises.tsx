import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { setPromise, type ActionItem } from '../api';
import { Txt } from './Txt';
import { space } from '../theme';

/** Commitments from this call, marked done from here. */
export function CallPromises({ callId, items, contactName }: { callId: string; items: ActionItem[]; contactName: string }) {
  const [done, setDone] = useState<Set<number>>(new Set());
  async function mark(index: number) {
    try { await setPromise(callId, index, 'done'); setDone(previous => new Set(previous).add(index)); }
    catch { /* stays open; the user can retry */ }
  }
  return (
    <View style={{ gap: space.sm }}>
      {items.map((item, index) => (
        <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, opacity: done.has(index) ? 0.45 : 1 }}>
          <Txt tone="muted" size="caption" style={{ width: 70 }}>
            {item.owner === 'User' ? 'You' : item.owner === 'Caller' ? contactName : '—'}
          </Txt>
          <Txt style={{ flex: 1, textDecorationLine: done.has(index) ? 'line-through' : 'none' }}>{item.task}</Txt>
          {item.owner && !done.has(index) && (
            <Pressable accessibilityRole="button" onPress={() => mark(index)} hitSlop={8}><Txt tone="ok" weight="bold">Done</Txt></Pressable>
          )}
        </View>
      ))}
    </View>
  );
}
