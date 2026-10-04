import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Share, TextInput, View } from 'react-native';
import { ApiError, askQuestion, getBriefing, type AskAnswer, type AskDraft, type Briefing, type Citation } from '../../src/api';
import { useApp } from '../../src/AppContext';
import { WeekCard } from '../../src/components/WeekCard';
import { clock } from '../../src/components/Moment';
import { Txt } from '../../src/components/Txt';
import { font, radius, space, type, useTheme } from '../../src/theme';

type Turn = { question: string; reply: AskAnswer | null; error?: string };
const SUGGESTIONS = ['What should I do this week?', 'Who am I waiting on?', 'Draft a follow-up email for my last call', 'Prices mentioned this month'];
const NOT_FOUND = 'I couldn’t find this in your calls. Try a name, a product or a price.';

/** One chip per call, opening at the first moment cited from it. */
function byCall(citations: Citation[]) {
  const calls = new Map<string, Citation>();
  for (const cite of citations) {
    const seen = calls.get(cite.call_id);
    if (!seen || (cite.start != null && (seen.start == null || cite.start < seen.start))) calls.set(cite.call_id, cite);
  }
  return [...calls.values()];
}

function DraftCard({ draft }: { draft: AskDraft }) {
  const { c } = useTheme();
  const [copied, setCopied] = useState(false);
  const text = draft.subject ? `${draft.subject}\n\n${draft.body}` : draft.body;
  async function copyOrShare() {
    const clipboard = Platform.OS === 'web' && typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clipboard) { await clipboard.writeText(text).then(() => setCopied(true)).catch(() => {}); return; }
    await Share.share({ message: text, title: draft.subject || undefined }).catch(() => {});
  }
  const mail = `mailto:?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
  const action = { borderWidth: 1, borderColor: c.line, borderRadius: radius.pill, paddingHorizontal: space.md, minHeight: 36, justifyContent: 'center' as const };
  return (
    <View style={{ backgroundColor: c.bg, borderRadius: radius.md, padding: space.sm, gap: space.xs }}>
      {draft.subject ? <Txt weight="bold" selectable>{draft.subject}</Txt> : null}
      <Txt selectable>{draft.body}</Txt>
      <Txt size="caption" tone="muted">Fill in anything in [brackets] before sending.</Txt>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingTop: space.xs }}>
        {draft.subject ? (
          <Pressable accessibilityRole="button" onPress={() => Linking.openURL(mail).catch(() => {})} style={action}>
            <Txt size="caption" tone="brand">Open in Mail</Txt>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" onPress={copyOrShare} style={action}>
          <Txt size="caption" tone="brand">{Platform.OS === 'web' ? (copied ? 'Copied' : 'Copy') : 'Share'}</Txt>
        </Pressable>
      </View>
    </View>
  );
}

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
    // The last two answered turns let "and the delivery date?" or "draft an
    // email about that" follow on, from the same calls.
    const history = turns.filter(t => t.reply?.grounded && t.reply.answer).slice(-2)
      .map(t => ({ question: t.question, answer: [t.reply!.answer!, t.reply!.draft?.body].filter(Boolean).join('\n').slice(0, 1000),
        call_ids: byCall(t.reply!.citations).map(cite => cite.call_id) }));
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
      <ScrollView ref={scroll} keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space.md, gap: space.md, width: '100%', maxWidth: 720, alignSelf: 'center', flexGrow: 1 }}>
        {turns.length > 0 && (
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => setTurns([])} hitSlop={8} style={{ alignSelf: 'flex-end' }}>
            <Txt size="caption" tone="brand">New question</Txt>
          </Pressable>
        )}
        {turns.length === 0 && (
          <View style={{ gap: space.md, paddingTop: space.lg }}>
            <WeekCard briefing={briefing} />
            <Txt size="screen" serif>Ask your calls</Txt>
            <Txt tone="muted">Who said what, which price, what is due — or ask for an email or message. Every answer links to the moment it was said.</Txt>
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
                  {turn.reply.draft ? <DraftCard draft={turn.reply.draft} /> : null}
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
                    {byCall(turn.reply.citations).map(cite => (
                      <Pressable key={cite.call_id} accessibilityRole="button"
                        onPress={() => router.push(cite.start != null ? `/call/${cite.call_id}?t=${Math.floor(cite.start)}` : `/call/${cite.call_id}`)}
                        style={{ backgroundColor: c.raised, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2 }}>
                        <Txt size="caption" tone="brand">
                          ▶ {cite.contact_name ?? 'Unknown caller'} · {new Date(cite.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}{cite.start != null ? ` · at ${clock(cite.start)}` : ''}
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
          placeholder="Ask, or say “draft an email to…”" placeholderTextColor={c.faint} accessibilityLabel="Ask about your calls" maxLength={500}
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
