import { useRouter } from 'expo-router';
import { FlatList, Pressable, View } from 'react-native';
import { useApp } from '../../src/AppContext';
import { ActionList } from '../../src/components/ActionList';
import { Banner } from '../../src/components/Banner';
import { CallPlayer } from '../../src/components/CallPlayer';
import { Empty } from '../../src/components/Empty';
import { Txt } from '../../src/components/Txt';
import { color, radius, space } from '../../src/theme';
import { formatWhen, useCalls } from '../../src/useCalls';
import { useEffect, useState } from 'react';
import { type CallDetail, getCall } from '../../src/api';

export default function Notes() {
  const { t, lang, userPhone } = useApp();
  const router = useRouter();
  const { calls, errorKey, clearError } = useCalls();
  const [details, setDetails] = useState<Record<string, CallDetail>>({});

  const ready = calls.filter((call) => call.status === 'ready');

  // Recents only carries the summary; action items need the detail record.
  useEffect(() => {
    if (!userPhone) return;
    for (const call of ready) {
      if (details[call.id]) continue;
      getCall(call.id, userPhone)
        .then((detail) => setDetails((d) => ({ ...d, [call.id]: detail })))
        .catch(() => {});
    }
  }, [ready.map((c) => c.id).join(','), userPhone]);

  if (ready.length === 0) {
    return (
      <View style={{ flex: 1 }}>
        {errorKey && <Banner message={t(errorKey)} onDismiss={clearError} />}
        <Empty title={t('noNotesTitle')} body={t('noNotesBody')} />
      </View>
    );
  }

  return (
    <FlatList
      data={ready}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ padding: space.md, gap: space.md }}
      renderItem={({ item }) => {
        const detail = details[item.id];

        return (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(`/call/${item.id}`)}
            style={{
              gap: space.md,
              padding: space.md,
              borderRadius: radius.md,
              backgroundColor: color.surface,
            }}
          >
            <View
              style={{ flexDirection: 'row', justifyContent: 'space-between' }}
            >
              <Txt size="subhead" weight="bold">
                {item.destination}
              </Txt>
              <Txt size="caption" tone="faint">
                {formatWhen(item.created_at, lang)}
              </Txt>
            </View>

            {item.summary && <Txt style={{ lineHeight: 26 }}>{item.summary}</Txt>}

            {detail?.action_items && detail.action_items.length > 0 && (
              <View style={{ gap: space.sm }}>
                <Txt size="caption" tone="accent" weight="bold">
                  {t('actionItems')}
                </Txt>
                <ActionList items={detail.action_items} />
              </View>
            )}

            <CallPlayer callId={item.id} />
          </Pressable>
        );
      }}
    />
  );
}
