import { LegalDocument } from '../src/components/LegalDocument';
import { SUBPROCESSORS } from '../src/legal';

export default function Subprocessors() {
  return <LegalDocument title="Subprocessors" sections={SUBPROCESSORS} />;
}
