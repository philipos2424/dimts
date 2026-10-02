import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { useApp } from '../../src/AppContext';
import { getPromises, type Promises } from '../../src/api';
import { Banner } from '../../src/components/Banner';
import { BusinessNumber } from '../../src/components/BusinessNumber';
import { Button } from '../../src/components/Button';
import { CallCard } from '../../src/components/CallCard';
import { PromisesStrip } from '../../src/components/PromisesStrip';
import { Txt } from '../../src/components/Txt';
import { space, useTheme } from '../../src/theme';
import { useCalls } from '../../src/useCalls';

const NONE: Promises = { you_owe: [], waiting_on: [] };

/** Today: every call reported back as a short card with one next step. */
export default function Today() {
  const { c } = useTheme();
  const { t } = useApp();
  const router = useRouter();
  const { calls, loading, errorKey, refresh, clearError } = useCalls();
  const [promises, setPromises] = useState<Promises>(NONE);
  const loadPromises = useCallback(() => { getPromises().then(setPromises).catch(() => {}); }, []);
  useFocusEffect(loadPromises);

  const header = (
    <View style={{ gap: space.md }}>
      {errorKey && <Banner message={t(errorKey)} onDismiss={clearError} />}
      <PromisesStrip promises={promises} onChange={loadPromises} />
    </View>
  );

  if (!loading && calls.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg, padding: space.md, gap: space.lg }}>
        {header}
        <BusinessNumber />
        <View style={{ gap: space.sm }}>
          <Txt size="title" serif>Your calls will appear here</Txt>
          <Txt tone="muted">After each call, Dimts writes down what was agreed and drafts your next step.</Txt>
        </View>
        <Button label="Make your first call" onPress={() => router.push('/dialer')} />
      </View>
    );
  }

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={{ padding: space.md, gap: space.md, width: '100%', maxWidth: 720, alignSelf: 'center' }}
      ListHeaderComponent={header}
      data={calls}
      keyExtractor={item => item.id}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { refresh(); loadPromises(); }} tintColor={c.muted} />}
      renderItem={({ item }) => <CallCard call={item} />}
    />
  );
}
