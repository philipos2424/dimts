import { LegalDocument } from '../src/components/LegalDocument';
import { PRIVACY_POLICY } from '../src/legal';

export default function Privacy() {
  return <LegalDocument title="Privacy policy" sections={PRIVACY_POLICY} />;
}
