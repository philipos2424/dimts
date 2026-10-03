import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { ApiError, askQuestion, getBriefing, type AskAnswer, type Briefing } from '../../src/api';
import { useApp } from '../../src/AppContext';
import { WeekCard } from '../../src/components/WeekCard';
import { clock } from '../../src/components/Moment';
import { Txt } from '../../src/components/Txt';
import { font, radius, space, type, useTheme } from '../../src/theme';

type Turn = { question: string; reply: AskAnswer | null; error?: string };
const SUGGESTIONS = ['What should I do this week?', 'Who am I waiting on?', 'What did we agree last week?', 'Prices mentioned this month'];
const NOT_FOUND = 'I couldn’t find this in your calls.';

/**
 * Home: ask your calls. The week's briefing sits on top until the first
 * question; answers only count when they point at a real moment.
 */
export default function Ask() {
  const { c } = useTheme();
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const scroll = useRef<ScrollView>(null);
  // ?q= asks straight away (the briefing card); ?draft= only fills the box
  // (person and call pages), so the owner can finish the question.
  const { q: linked, draft: suggested } = useLocalSearchParams<{ q?: string; draft?: string }>();
  const asked = useRef<string | null>(null);
  const { userPhone } = useApp();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  useFocusEffect(useCallback(() => {
    if (userPhone) getBriefing().then(setBriefing).catch(() => {});
  }, [userPhone]));
  useEffect(() => { if (typeof suggested === 'string' && suggested) setDraft(suggested); }, [suggested]);

  async function send(question: string) {
    const q = question.trim();
    if (q.length < 3 || busy) return;
    setDraft(''); setBusy(true);
    // The last two answered turns let "and the delivery date?" follow on.
    const history = turns.filter(t => t.reply?.grounded && t.reply.answer).slice(-2)
      .map(t => ({ question: t.question, answer: t.reply!.answer! }));
    setTurns(list => [...list, { question: q, reply: null }]);
    try {
      const reply = await askQuestion(q, history);
      setTurns(list => list.map((turn, i) => (i === list.length - 1 ? { ...turn, reply } : turn)));
    } catch (err) {
      const error = err instanceof ApiError ? err.message : 'Unable to ask right now. Try again.';
      setTurns(list => list.map((turn, i) => (i === list.length - 1 ? { ...turn, error } : turn)));
    } finally {
      setBusy(false);
      setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
    }
  }

  useEffect(() => {
    if (typeof linked === 'string' && linked && asked.current !== linked) { asked.current = linked; void send(linked); }
  }, [linked]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView ref={scroll} contentContainerStyle={{ padding: space.md, gap: space.md, width: '100%', maxWidth: 720, alignSelf: 'center', flexGrow: 1 }}>
        {turns.length === 0 && (
          <View style={{ gap: space.md, paddingTop: space.lg }}>
            <WeekCard briefing={briefing} />
            <Txt size="screen" serif>Ask your calls</Txt>
            <Txt tone="muted">Who said what, which price, what is due. Every answer links to the moment it was said.</Txt>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {SUGGESTIONS.map(s => (
                <Pressable key={s} accessibilityRole="button" onPress={() => send(s)}
                  style={{ borderWidth: 1, borderColor: c.line, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.sm }}>
                  <Txt size="caption" tone="brand">{s}</Txt>
                </Pressable>
              ))}
            </View>
          </View>
        )}
        {turns.map((turn, i) => (
          <View key={i} style={{ gap: space.sm }}>
            <View style={{ alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: c.brand, borderRadius: radius.lg, borderBottomRightRadius: 4, padding: space.sm }}>
              <Txt tone="onBrand">{turn.question}</Txt>
            </View>
            <View style={{ alignSelf: 'flex-start', maxWidth: '90%', backgroundColor: c.card, borderColor: c.line, borderWidth: 1,
              borderRadius: radius.lg, borderBottomLeftRadius: 4, padding: space.sm, gap: space.sm }}>
              {turn.error ? <Txt tone="danger">{turn.error}</Txt>
                : !turn.reply ? <Txt tone="muted">Looking through your calls…</Txt>
                : !turn.reply.grounded ? <Txt tone="muted">{NOT_FOUND}</Txt>
                : <>
                  <Txt>{turn.reply.answer}</Txt>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
                    {turn.reply.citations.map(cite => (
                      <Pressable key={`${cite.call_id}-${cite.line}`} accessibilityRole="button"
                        onPress={() => router.push(cite.start != null ? `/call/${cite.call_id}?t=${Math.floor(cite.start)}` : `/call/${cite.call_id}`)}
                        style={{ backgroundColor: c.raised, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2 }}>
                        <Txt size="caption" tone="brand">
                          ▶ {cite.contact_name ?? 'Call'} · {new Date(cite.created_at).toLocaleDateString()}{cite.start != null ? ` · ${clock(cite.start)}` : ''}
                        </Txt>
                      </Pressable>
                    ))}
                  </View>
                </>}
            </View>
          </View>
        ))}
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: space.sm, padding: space.md, borderTopWidth: 1, borderTopColor: c.line, backgroundColor: c.card }}>
        <TextInput value={draft} onChangeText={setDraft} onSubmitEditing={() => send(draft)} returnKeyType="send"
          placeholder="Ask anything about your calls…" placeholderTextColor={c.faint} accessibilityLabel="Ask about your calls" maxLength={500}
          style={{ flex: 1, fontFamily: font.regular, fontSize: type.body, color: c.ink, backgroundColor: c.bg,
            borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.sm }} />
        <Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={busy || draft.trim().length < 3} onPress={() => send(draft)}
          style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: c.brand,
            opacity: busy || draft.trim().length < 3 ? 0.4 : 1 }}>
          <Txt weight="bold" tone="onBrand">↑</Txt>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
