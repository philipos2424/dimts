import { ScrollView, View } from 'react-native';
import { DRAFT_NOTE, type LegalSection } from '../legal';
import { Txt } from './Txt';
import { space } from '../theme';

export function LegalDocument({ title, sections }: { title: string; sections: LegalSection[] }) {
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, maxWidth: 720 }}>
      <Txt size="screen" weight="bold" accessibilityRole="header">{title}</Txt>
      <Txt size="caption" tone="muted">{DRAFT_NOTE}</Txt>
      {sections.map(section => (
        <View key={section.heading} style={{ gap: space.xs }}>
          <Txt size="subhead" weight="bold">{section.heading}</Txt>
          <Txt tone="muted">{section.body}</Txt>
        </View>
      ))}
    </ScrollView>
  );
}
