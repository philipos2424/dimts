import { View } from 'react-native';
import { radius, space, useTheme } from '../theme';
import { Txt } from './Txt';

// A fixed example, shown before the first call so a new owner can see what
// they will get. Nothing here is stored or sent anywhere.
const EXAMPLE = {
  who: 'Alex Morgan · Outgoing · 3 min',
  summary: 'Alex accepted the $2,400 quote, materials and labour included. Work starts next Monday. You promised to email the written quote by Friday; Alex pays the deposit once it is signed.',
  agreed: [['Price', '$2,400, materials and labour'], ['Start', 'next Monday']],
  promises: ['You: email the written quote by Friday', 'Alex: pay the deposit after signing'],
};

export function ExampleNotes() {
  const { c } = useTheme();
  return <View accessibilityLabel="Example notes from a call" style={{ gap: space.sm, padding: space.md,
    borderRadius: radius.md, borderWidth: 1, borderColor: c.line, backgroundColor: c.card }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.sm, flexWrap: 'wrap' }}>
      <Txt weight="bold">{EXAMPLE.who}</Txt>
      <Txt size="caption" weight="bold" tone="gold" style={{ letterSpacing: 1, textTransform: 'uppercase' }}>Example</Txt>
    </View>
    <Txt>{EXAMPLE.summary}</Txt>
    <View style={{ gap: 2 }}>
      {EXAMPLE.agreed.map(([kind, value]) => <Txt key={kind} size="caption" tone="muted">{kind}: {value}</Txt>)}
    </View>
    <View style={{ gap: 2 }}>
      <Txt size="caption" weight="bold">Promises</Txt>
      {EXAMPLE.promises.map(item => <Txt key={item} size="caption" tone="muted">• {item}</Txt>)}
    </View>
  </View>;
}
