import { Redirect, useLocalSearchParams } from 'expo-router';

/** Ask is the home screen now; old /ask links keep working. */
export default function AskRedirect() {
  const { q, draft } = useLocalSearchParams<{ q?: string; draft?: string }>();
  const params = q ? { q } : draft ? { draft } : {};
  return <Redirect href={{ pathname: '/', params }} />;
}
