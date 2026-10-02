import { LegalDocument } from '../src/components/LegalDocument';
import { TERMS } from '../src/legal';

export default function Terms() {
  return <LegalDocument title="Terms of service" sections={TERMS} />;
}
