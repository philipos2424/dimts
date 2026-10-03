import { View } from 'react-native';
import type { Agreement } from '../api';
import { Moment } from './Moment';
import { Txt } from './Txt';
import { space } from '../theme';

/** What was agreed, each fact with the moment it was said. */
export function AgreementList({ agreements, onPlay, contactName }:
  { agreements: Agreement[]; onPlay: (seconds: number) => void; contactName: string }) {
  return (
    <View style={{ gap: space.md }}>
      {agreements.map((a, i) => (
        <View key={i} style={{ gap: space.xs }}>
          <Txt>{a.subject}: <Txt weight="bold">{a.value}</Txt></Txt>
          <Moment quote={a.quote} start={a.start} onPlay={onPlay}
            label={a.said_by === 'User' ? 'You' : a.said_by === 'Caller' ? contactName : undefined} />
        </View>
      ))}
    </View>
  );
}
