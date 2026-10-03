// Mirrors server/lib/destinations.js: calls with a Gulf number on either side
// need both people to press 1 before recording. The server decides; this only
// prepares the owner for the prompt.
const GULF = ['971', '966', '974', '973', '965', '968'];

export const needsPressOne = (...phones: (string | null | undefined)[]) =>
  phones.some(phone => !!phone && GULF.some(code => phone.startsWith(`+${code}`)));
