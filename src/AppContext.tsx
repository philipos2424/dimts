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
import { acceptTerms as acceptTermsApi, ApiError, getMe, logout, patchLanguage, setApiSession } from './api';
import { TERMS_VERSION } from './legal';
import { readSession, storeSession } from './session';

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
  signIn: (token: string, phone: string) => Promise<void>;
  termsRequired: boolean;
  acceptTerms: () => Promise<void>;
  signedOut: () => void;
  setAutoRecord: (on: boolean) => void;
  t: (key: Key) => string;
};

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [lang, setLangState] = useState<Lang>('en');
  const [userPhone, setPhoneState] = useState<string | null>(null);
  const [autoRecord, setAutoRecordState] = useState(true);
  const [termsRequired, setTermsRequired] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [storedLang, storedPhone, storedAuto] =
          await AsyncStorage.multiGet([KEYS.lang, KEYS.phone, KEYS.autoRecord]);

        if (storedLang[1] === 'am' || storedLang[1] === 'en') {
          setLangState(storedLang[1]);
        }
        const token = await readSession();
        if (token) {
          setApiSession(token);
          try {
            const me = await getMe(); setPhoneState(me.phone); setTermsRequired(me.terms_required);
            // The server's language is the account's; the device follows it.
            if (me.language === 'am' || me.language === 'en') setLangState(me.language);
          }
          catch (err) {
            // Only an expired or revoked session signs the owner out. A slow
            // cold start or a dropped connection keeps them signed in.
            if (err instanceof ApiError && err.status === 401) { setApiSession(null); await storeSession(null); }
            else if (storedPhone[1]) setPhoneState(storedPhone[1]);
          }
        }
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
    // Notes are written in this language on the server; best-effort when signed out.
    patchLanguage(next).catch(() => {});
  }, []);

  const setUserPhone = useCallback((next: string | null) => {
    if (next) return; // Account identity may only come from verified login.
    logout().catch(() => {});
    setApiSession(null);
    storeSession(null).catch(() => {});
    setPhoneState(next);
    (next
      ? AsyncStorage.setItem(KEYS.phone, next)
      : AsyncStorage.removeItem(KEYS.phone)
    ).catch(() => {});
  }, []);

  const signIn = useCallback(async (token: string, phone: string) => {
    await storeSession(token);
    setApiSession(token);
    try {
      const me = await getMe();
      setTermsRequired(me.terms_required);
      if (me.language === 'am' || me.language === 'en') setLangState(me.language);
    } catch { setTermsRequired(true); }
    setPhoneState(phone);
    AsyncStorage.setItem(KEYS.phone, phone).catch(() => {});
  }, []);

  const acceptTerms = useCallback(async () => {
    await acceptTermsApi(TERMS_VERSION);
    setTermsRequired(false);
  }, []);

  // The server already ended the session (account deleted); clear local state only.
  const signedOut = useCallback(() => {
    setApiSession(null);
    storeSession(null).catch(() => {});
    AsyncStorage.removeItem(KEYS.phone).catch(() => {});
    setTermsRequired(false);
    setPhoneState(null);
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
      signIn,
      termsRequired,
      acceptTerms,
      signedOut,
      setAutoRecord,
      t: (key: Key) => translate(lang, key),
    }),
    [ready, lang, userPhone, autoRecord, setLang, setUserPhone, signIn, termsRequired, acceptTerms, signedOut, setAutoRecord]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
