/**
 * Single bilingual dictionary. `am` is typed against `en`, so adding an
 * English string without its Amharic counterpart fails the typecheck rather
 * than shipping a half-translated screen.
 */
const en = {
  // Navigation
  dialer: 'Dialer',
  notes: 'Notes',
  settings: 'Settings',

  // Onboarding
  onboardingTitle: 'Your phone number',
  onboardingBody:
    'Dimts rings this phone first, then connects you to the person you are calling.',
  phonePlaceholder: '+12025550123',
  invalidPhone: 'Enter a number with a country code, like +12025550123.',

  // Recents

  // Status
  statusInitiating: 'Starting',
  statusRinging: 'Ringing',
  'statusIn-progress': 'On call',
  statusProcessing: 'Writing notes',
  statusReady: 'Ready',
  statusFailed: 'Failed',

  // In call
  answerYourPhone: 'Answer your phone. Dimts rings you first, then connects the other person.',
  pressOneToRecord: 'Recording with this number needs both of you to press 1 to agree.',

  // Dialer
  enterNumber: 'Enter a number',
  call: 'Call',
  delete: 'Delete',

  // In-call
  backToRecents: 'Back to recents',

  // Call detail / notes
  summary: 'Summary',
  transcript: 'Transcript',
  play: 'Play',
  pause: 'Pause',
  processingBody: 'Transcribing this call. It usually takes under a minute.',
  retry: 'Try again',

  // Settings
  language: 'Language',
  autoRecord: 'Record every call',
  autoRecordHelp: 'Turn this off to start calls without recording.',
  minutesThisMonth: 'Minutes this month',
  yourNumber: 'Your number',
  changeNumber: 'Change',

  incoming: 'Incoming',
  outgoing: 'Outgoing',
  statusMissed: 'Missed',

  // Errors
  errorNetwork: 'Could not reach the server. Check your connection.',
  errorCallFailed: 'The call could not be started.',
  errorGeneric: 'Something went wrong.',
  dismiss: 'Dismiss',
} as const;

export type Key = keyof typeof en;

const am: Record<Key, string> = {
  dialer: 'ደዋያ',
  notes: 'ማስታወሻዎች',
  settings: 'ቅንብሮች',

  onboardingTitle: 'የስልክ ቁጥርዎ',
  onboardingBody: 'ድምፅ መጀመሪያ ይህን ስልክ ይደውላል፣ ከዚያ ከሚደውሉለት ሰው ጋር ያገናኝዎታል።',
  phonePlaceholder: '+12025550123',
  invalidPhone: 'እንደ +12025550123 ያለ የአገር ኮድ ያለው ቁጥር ያስገቡ።',


  statusInitiating: 'በመጀመር ላይ',
  statusRinging: 'እየደወለ ነው',
  'statusIn-progress': 'በጥሪ ላይ',
  statusProcessing: 'ማስታወሻ በመጻፍ ላይ',
  answerYourPhone: 'ስልክዎን ያንሱ። ድምፅ መጀመሪያ እርስዎን ይደውላል፣ ከዚያ ሌላውን ሰው ያገናኛል።',
  pressOneToRecord: 'ከዚህ ቁጥር ጋር ጥሪ ለመቅዳት ሁለታችሁም ለመስማማት 1 መጫን አለባችሁ።',
  statusReady: 'ዝግጁ',
  statusFailed: 'አልተሳካም',

  enterNumber: 'ቁጥር ያስገቡ',
  call: 'ደውል',
  delete: 'ሰርዝ',

  backToRecents: 'ወደ ዜማ ተመለስ',

  summary: 'ማጠቃለያ',
  transcript: 'ንግግሩ በጽሑፍ',
  play: 'አጫውት',
  pause: 'አቁም',
  processingBody: 'ይህን ጥሪ ወደ ጽሑፍ በመቀየር ላይ። ብዙውን ጊዜ ከአንድ ደቂቃ በታች ይወስዳል።',
  retry: 'እንደገና ሞክር',

  language: 'ቋንቋ',
  autoRecord: 'እያንዳንዱን ጥሪ ቅዳ',
  autoRecordHelp: 'ጥሪዎችን ሳይቀዱ ለመጀመር ይህንን ያጥፉ።',
  minutesThisMonth: 'የዚህ ወር ደቂቃዎች',
  yourNumber: 'የእርስዎ ቁጥር',
  changeNumber: 'ቀይር',

  incoming: 'ገቢ ጥሪ',
  outgoing: 'የወጣ ጥሪ',
  statusMissed: 'ያመለጠ',

  errorNetwork: 'ሰርቨሩ ላይ መድረስ አልተቻለም። ግንኙነትዎን ያረጋግጡ።',
  errorCallFailed: 'ጥሪው ሊጀመር አልቻለም።',
  errorGeneric: 'የሆነ ስህተት ተፈጥሯል።',
  dismiss: 'ዝጋ',
};

export const dictionaries = { en, am };
export type Lang = keyof typeof dictionaries;

export function translate(lang: Lang, key: Key): string {
  return dictionaries[lang][key];
}

/** Status values from the API map onto the status* keys. */
export function statusKey(status: string): Key {
  if (status === 'completed') return 'statusReady';
  const key = `status${status.charAt(0).toUpperCase()}${status.slice(1)}`;
  return (key in dictionaries.en ? key : 'statusFailed') as Key;
}

/** Ge'ez numerals, shown under the keypad digits in Amharic. No zero exists. */
export const geezDigits: Record<string, string> = {
  '1': '፩',
  '2': '፪',
  '3': '፫',
  '4': '፬',
  '5': '፭',
  '6': '፮',
  '7': '፯',
  '8': '፰',
  '9': '፱',
};
