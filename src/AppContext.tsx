import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { type Key, type Lang, translate } from './i18n';

const KEYS = {
  lang: 'dimts.lang',
  phone: 'dimts.phone',
  autoRecord: 'dimts.autoRecord',
} as const;

type AppState = {
  ready: boolean;
  lang: Lang;
  userPhone: string | null;
  autoRecord: boolean;
  setLang: (lang: Lang) => void;
  setUserPhone: (phone: string | null) => void;
  setAutoRecord: (on: boolean) => void;
  t: (key: Key) => string;
};

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [lang, setLangState] = useState<Lang>('en');
  const [userPhone, setPhoneState] = useState<string | null>(null);
  const [autoRecord, setAutoRecordState] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [storedLang, storedPhone, storedAuto] =
          await AsyncStorage.multiGet([KEYS.lang, KEYS.phone, KEYS.autoRecord]);

        if (storedLang[1] === 'am' || storedLang[1] === 'en') {
          setLangState(storedLang[1]);
        }
        if (storedPhone[1]) setPhoneState(storedPhone[1]);
        if (storedAuto[1] !== null) setAutoRecordState(storedAuto[1] === 'true');
      } catch {
        // A device with unreadable storage still gets a usable app.
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    AsyncStorage.setItem(KEYS.lang, next).catch(() => {});
  }, []);

  const setUserPhone = useCallback((next: string | null) => {
    setPhoneState(next);
    (next
      ? AsyncStorage.setItem(KEYS.phone, next)
      : AsyncStorage.removeItem(KEYS.phone)
    ).catch(() => {});
  }, []);

  const setAutoRecord = useCallback((next: boolean) => {
    setAutoRecordState(next);
    AsyncStorage.setItem(KEYS.autoRecord, String(next)).catch(() => {});
  }, []);

  const value = useMemo<AppState>(
    () => ({
      ready,
      lang,
      userPhone,
      autoRecord,
      setLang,
      setUserPhone,
      setAutoRecord,
      t: (key: Key) => translate(lang, key),
    }),
    [ready, lang, userPhone, autoRecord, setLang, setUserPhone, setAutoRecord]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
