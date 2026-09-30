import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useApp } from '../../src/AppContext';
import { ApiError, type CallDetail, getCall, reprocessCall } from '../../src/api';
import { ActionList } from '../../src/components/ActionList';
import { Banner } from '../../src/components/Banner';
import { CallPlayer } from '../../src/components/CallPlayer';
import { Section } from '../../src/components/Section';
import { Txt } from '../../src/components/Txt';
import { type Key, statusKey } from '../../src/i18n';
import { color, space } from '../../src/theme';

export default function CallDetailScreen() {
  const { t } = useApp();
  const { userPhone } = useApp();
  const navigation = useNavigation();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [call, setCall] = useState<CallDetail | null>(null);
  const [errorKey, setErrorKey] = useState<Key | null>(null);

  const load = useCallback(async () => {
    if (!id || !userPhone) return;
    try {
      setCall(await getCall(id, userPhone));
      setErrorKey(null);
    } catch (err) {
      setErrorKey(err instanceof ApiError ? err.messageKey : 'errorGeneric');
    }
  }, [id, userPhone]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const title = call?.contact_name ?? call?.destination;
    if (title) navigation.setOptions({ title });
  }, [call?.contact_name, call?.destination, navigation]);

  // Keep polling while the pipeline is still running.
  useEffect(() => {
    if (!call || ['ready', 'failed', 'completed', 'missed'].includes(call.status)) return;
    const timer = setTimeout(load, 5000);
    return () => clearTimeout(timer);
  }, [call, load]);

  if (!call) {
    return (
      <View style={{ flex: 1 }}>
        {errorKey && <Banner message={t(errorKey)} onDismiss={() => setErrorKey(null)} />}
      </View>
    );
  }

  const notReady = call.status !== 'ready';

  return (
    <ScrollView contentContainerStyle={{ padding: space.md, gap: space.lg }}>
      {errorKey && <Banner message={t(errorKey)} onDismiss={() => setErrorKey(null)} />}

      {call.audio_url && <CallPlayer callId={call.id} />}

      {notReady && (
        <View style={{ gap: space.sm }}>
          <Txt size="subhead" weight="bold">
            {t(statusKey(call.status))}
          </Txt>
          <Txt tone="muted">
            {call.status === 'failed' ? call.error ?? t('errorGeneric') :
              call.status === 'completed' ? 'Recording was off for this call.' :
              call.status === 'missed' ? 'This call was not answered.' : t('processingBody')}
          </Txt>
          {call.status === 'failed' && call.recording_url && (
            <Pressable
              accessibilityRole="button"
              onPress={() => userPhone && reprocessCall(call.id, userPhone).then(load)}
              style={{ paddingVertical: space.sm }}
            >
              <Txt tone="accent" weight="bold">
                {t('retry')}
              </Txt>
            </Pressable>
          )}
        </View>
      )}

      {call.summary && (
        <Section title={t('summary')}>
          <Txt style={{ lineHeight: 26 }}>{call.summary}</Txt>
        </Section>
      )}

      {call.next_moves && call.next_moves.length > 0 && (
        <Section title={t('nextMoves')}>
          <View style={{ gap: space.xs }}>
            {call.next_moves.map((move, i) => (
              <View key={i} style={{ flexDirection: 'row', gap: space.sm }}>
                <Txt tone="accent">→</Txt>
                <Txt style={{ flex: 1 }}>{move}</Txt>
              </View>
            ))}
          </View>
        </Section>
      )}

      {call.action_items && call.action_items.length > 0 && (
        <Section title={t('actionItems')}>
          <ActionList items={call.action_items} />
        </Section>
      )}

      {call.key_points && call.key_points.length > 0 && (
        <Section title={t('keyPoints')}>
          <View style={{ gap: space.xs }}>
            {call.key_points.map((point, i) => (
              <View key={i} style={{ flexDirection: 'row', gap: space.sm }}>
                <Txt tone="faint">—</Txt>
                <Txt style={{ flex: 1 }}>{point}</Txt>
              </View>
            ))}
          </View>
        </Section>
      )}

      {call.transcript && (
        <Section title={t('transcript')}>
          <Txt tone="muted" style={{ lineHeight: 26, color: color.parchment }}>
            {call.transcript}
          </Txt>
        </Section>
      )}
    </ScrollView>
  );
}
